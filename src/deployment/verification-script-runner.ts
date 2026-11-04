import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationRun,
} from "../core/api-contract";
import { getKanbanRuntimeHost, getKanbanRuntimePort } from "../core/runtime-endpoint";
import { launchOwnedCommandSupervisor } from "../task-command-execution/task-command-execution-supervisor";
import { getVerificationAssetsDir } from "./verification-assets";
import { waitWithinVerificationExecutionAbsoluteRpcDeadline } from "./verification-execution-absolute-rpc-deadline";
import {
	allocateVerificationExecutionAttempt,
	mutateVerificationExecutionAttempt,
	readVerificationExecutionAttempt,
	type VerificationExecutionAttempt,
	verificationExecutionAttemptCancellationPath,
	verificationExecutionAttemptDirectory,
} from "./verification-execution-attempt-store";

// 脚本输出摘录上限（尾部截断）：面板展示 + 落盘 run.outputExcerpt，避免大输出撑爆 state 文件。
const OUTPUT_EXCERPT_MAX_CHARS = 4000;

// 运行期输出缓冲上限：stdout/stderr 累积时即裁剪保留尾部（约 2× 摘录上限），
// 防止高输出或卡到 timeout 的脚本在 live server 进程内无界占用内存；最终摘录仍由 tailExcerpt 截到摘录上限。
const RUNNING_OUTPUT_BUFFER_MAX_CHARS = OUTPUT_EXCERPT_MAX_CHARS * 2;

function tailExcerpt(text: string): string {
	if (text.length <= OUTPUT_EXCERPT_MAX_CHARS) {
		return text;
	}
	return `…（已截断，保留尾部 ${OUTPUT_EXCERPT_MAX_CHARS} 字符）\n${text.slice(text.length - OUTPUT_EXCERPT_MAX_CHARS)}`;
}

// 执行侧路径护栏（与 cleanupVerificationAssets 的删除侧 realpath 护栏对称）：
// entrypoint 必须是相对路径，且 realpath(join(assetsDir, entrypoint)) 严格位于资产目录之下（symlink 逃逸同样拒绝）。
// 校验失败时不 spawn，由调用方以 errored 结束。
async function resolveEntrypointPathInsideAssetsDir(
	assetsDir: string,
	entrypoint: string,
): Promise<{ ok: true; resolvedEntrypointPath: string } | { ok: false; reason: string }> {
	if (isAbsolute(entrypoint)) {
		return { ok: false, reason: `entrypoint 必须是资产目录内的相对路径，不允许绝对路径：${entrypoint}` };
	}
	let resolvedAssetsDir: string;
	try {
		resolvedAssetsDir = await realpath(assetsDir);
	} catch (error) {
		return {
			ok: false,
			reason: `资产目录不可用：${assetsDir}（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
	let resolvedEntrypointPath: string;
	try {
		resolvedEntrypointPath = await realpath(join(assetsDir, entrypoint));
	} catch (error) {
		return {
			ok: false,
			reason: `entrypoint 无法解析：${entrypoint}（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
	const relFromAssetsDir = relative(resolvedAssetsDir, resolvedEntrypointPath);
	if (relFromAssetsDir === "" || relFromAssetsDir.startsWith("..") || isAbsolute(relFromAssetsDir)) {
		return {
			ok: false,
			reason: `entrypoint 解析后越界（不在资产目录 ${resolvedAssetsDir} 之下）：${entrypoint} → ${resolvedEntrypointPath}`,
		};
	}
	return { ok: true, resolvedEntrypointPath };
}

// 未确认退出仍使用公共 running 状态；恢复原因明确展示，不把超时意图冒充退出事实。
export type VerificationScriptRunOutcome = Omit<RuntimePostDeployVerificationRun, "status"> & {
	status: "running" | "passed" | "failed" | "errored" | "timed_out";
};

export const verificationSupervisorProgressSchema = z.object({
	launchNonce: z.string(),
	status: z.enum(["dispatch_committed", "running", "cancelling", "exited", "cancelled"]),
	ownedProcesses: z.array(
		z.object({
			pid: z.number().int().positive(),
			startAndCommand: z.string(),
			nativeProcessGenerationIdentity: z.string().optional(),
		}),
	),
	updatedAtEpochMs: z.number(),
	outputTail: z.string().optional(),
	timedOut: z.boolean().optional(),
	nativeOwnershipUnproven: z.boolean().optional(),
	kernelChildExitObservation: z.number().nullable().optional(),
	linuxKernelContainmentVerified: z.boolean().optional(),
	linuxKernelContainmentContinuityLost: z.boolean().optional(),
	postScriptOwnershipRecoveryBudget: z
		.object({
			evidenceFingerprint: z.string(),
			unchangedEvidenceProbeCount: z.number().int().min(0).max(3),
			nextActiveProbeAtEpochMs: z.number(),
		})
		.optional(),
	unprovenOwnershipProcesses: z
		.array(
			z.object({
				pid: z.number().int().positive(),
				parentProcessPid: z.number().optional(),
				processStartIdentity: z.string(),
				nativeProcessGenerationIdentity: z.string().optional(),
				originalParentProcessGenerationIdentity: z.string().optional(),
				reason: z.string(),
			}),
		)
		.optional(),
	returncode: z.number().nullable().optional(),
	signal: z.string().nullable().optional(),
	error: z.string().optional(),
});

export function buildVerificationExecutionRunSnapshot(
	attempt: VerificationExecutionAttempt,
	run: Pick<RuntimePostDeployVerificationRun, "status" | "exitCode" | "finishedAtIso" | "outputExcerpt">,
): RuntimePostDeployVerificationRun {
	return {
		...run,
		startedAtIso: attempt.startedAtIso,
		verificationExecutionAttemptId: attempt.verificationExecutionAttemptId,
		postDeployVerificationTaskInstanceId: attempt.postDeployVerificationTaskInstanceId,
		...(attempt.taskIncarnationCreatedAtEpochMs === null
			? {}
			: { taskIncarnationCreatedAtEpochMs: attempt.taskIncarnationCreatedAtEpochMs }),
		verificationDefinitionFingerprint: attempt.verificationDefinitionFingerprint,
	};
}

export async function readVerificationSupervisorProgress(attempt: VerificationExecutionAttempt) {
	try {
		const progress = verificationSupervisorProgressSchema.parse(
			JSON.parse(
				await readFile(
					join(
						verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId),
						`supervisor-progress-${attempt.verificationExecutionAttemptId}.json`,
					),
					"utf8",
				),
			),
		);
		return progress.launchNonce === attempt.verificationExecutionAttemptId ? progress : null;
	} catch {
		return null;
	}
}

export async function readVerificationExecutionTerminalRun(
	attempt: VerificationExecutionAttempt,
	finishedAtIsoProvider = () => new Date().toISOString(),
): Promise<RuntimePostDeployVerificationRun | null> {
	if (attempt.terminalRun) return attempt.terminalRun;
	let progress = await readVerificationSupervisorProgress(attempt);
	if (!progress) {
		try {
			const aborted = z
				.object({ launchNonce: z.string(), phase: z.literal("supervisor_spawn_not_invoked"), reason: z.string() })
				.parse(
					JSON.parse(
						await readFile(
							join(
								verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId),
								`supervisor-launch-aborted-${attempt.verificationExecutionAttemptId}.json`,
							),
							"utf8",
						),
					),
				);
			if (aborted.launchNonce === attempt.verificationExecutionAttemptId)
				progress = {
					launchNonce: aborted.launchNonce,
					status: "cancelled",
					ownedProcesses: [],
					updatedAtEpochMs: Date.now(),
					timedOut: Date.now() >= attempt.deadlineAtEpochMs,
					error: `监督进程未派发：${aborted.reason}`,
				};
		} catch {
			/* 缺少明确的未派发原件时仍保留未知。 */
		}
	}
	if (!progress || (progress.status !== "exited" && progress.status !== "cancelled")) return null;
	const terminalProgress = progress;
	return mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
		if (current.terminalRun) return current.terminalRun;
		const timedOut = terminalProgress.timedOut || current.cancellationIntent?.reason === "deadline_elapsed";
		const run = buildVerificationExecutionRunSnapshot(current, {
			status: timedOut
				? "timed_out"
				: current.cancellationIntent || terminalProgress.status === "cancelled" || terminalProgress.error
					? "errored"
					: terminalProgress.returncode === 0
						? "passed"
						: "failed",
			exitCode: terminalProgress.returncode ?? null,
			finishedAtIso: finishedAtIsoProvider(),
			outputExcerpt: tailExcerpt(
				`${terminalProgress.outputTail ?? ""}${terminalProgress.error ? `\n进程错误：${terminalProgress.error}` : ""}`,
			),
		});
		current.launchStage = "terminal";
		current.terminalRun = run;
		return run;
	});
}

export async function runVerificationScript(input: {
	verificationId: string;
	script: NonNullable<RuntimePostDeployVerificationChecklistItem["script"]>;
	startedAtIso: string;
	finishedAtIsoProvider: () => string;
	executionAttempt?: VerificationExecutionAttempt;
	validateBeforeDispatch?: () => Promise<void>;
}): Promise<VerificationScriptRunOutcome> {
	const { verificationId, script } = input;
	const attempt =
		input.executionAttempt ??
		(await allocateVerificationExecutionAttempt({
			workspaceId: "standalone-verification",
			deploymentId: "standalone-verification",
			taskId: verificationId,
			postDeployVerificationTaskInstanceId: randomUUID(),
			itemId: verificationId,
			verificationId,
			verificationDefinitionFingerprint: "standalone-verification",
			script,
			startedAtIso: input.startedAtIso,
		}));
	const recoverySnapshot = buildVerificationExecutionRecoveryRunSnapshot(attempt);
	return waitWithinVerificationExecutionAbsoluteRpcDeadline({
		deadlineAtEpochMs: attempt.deadlineAtEpochMs,
		operation: launchAndObserveVerificationScript(input, attempt, (progress) => {
			recoverySnapshot.outputExcerpt = tailExcerpt(progress.outputTail ?? "");
			if (progress.unprovenOwnershipProcesses?.length && recoverySnapshot.recoveryObservation)
				recoverySnapshot.recoveryObservation = {
					...recoverySnapshot.recoveryObservation,
					message: `正在核验退出：原生归属未证 PID ${progress.unprovenOwnershipProcesses
						.slice(0, 5)
						.map((entry) => entry.pid)
						.join("、")}；身份、终结原件或开机代际变化后自动补证`,
					unprovenProcessIdentities: progress.unprovenOwnershipProcesses
						.slice(0, 10)
						.map(({ pid, ...identity }) => ({ processPid: pid, ...identity })),
					recoveryTriggers: [
						"terminal_receipt_changed",
						"owned_or_unproven_process_generation_changed",
						"system_boot_identity_changed",
					],
				};
		}),
		recoverySnapshot: () => recoverySnapshot,
	});
}

export function buildVerificationExecutionRecoveryRunSnapshot(
	attempt: VerificationExecutionAttempt,
): VerificationScriptRunOutcome {
	return {
		...buildVerificationExecutionRunSnapshot(attempt, {
			status: "running",
			exitCode: null,
			finishedAtIso: null,
			outputExcerpt: "",
		}),
		status: "running",
		recoveryObservation: {
			reason: "awaiting_exit_confirmation",
			message: `正在核验退出：attempt ${attempt.verificationExecutionAttemptId} 尚未取得终结原件，确认前禁止重跑`,
			unchangedEvidenceProbeCount: attempt.recoveryBudget.unchangedEvidenceProbeCount,
			nextActiveProbeAtEpochMs: attempt.recoveryBudget.nextActiveProbeAtEpochMs,
		},
	};
}

async function launchAndObserveVerificationScript(
	input: Parameters<typeof runVerificationScript>[0],
	attempt: VerificationExecutionAttempt,
	observeOutputTail: (progress: z.infer<typeof verificationSupervisorProgressSchema>) => void,
): Promise<VerificationScriptRunOutcome> {
	const { verificationId, script } = input;
	const assetsDir = getVerificationAssetsDir(verificationId);
	const entrypointCheck = await resolveEntrypointPathInsideAssetsDir(assetsDir, script.entrypoint);
	if (!entrypointCheck.ok) {
		return mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
			const run = buildVerificationExecutionRunSnapshot(current, {
				status: "errored",
				exitCode: null,
				outputExcerpt: `entrypoint 校验失败：${entrypointCheck.reason}`,
				finishedAtIso: input.finishedAtIsoProvider(),
			});
			current.launchStage = "terminal";
			current.terminalRun = run;
			return run as VerificationScriptRunOutcome;
		});
	}
	let launchError = "";
	try {
		await launchOwnedCommandSupervisor(
			{
				workspaceId: attempt.workspaceId,
				executionId: attempt.verificationExecutionAttemptId,
				launchNonce: attempt.verificationExecutionAttemptId,
				launchAttemptCount: 1,
				revocationFile: verificationExecutionAttemptCancellationPath(attempt.verificationExecutionAttemptId),
				specification: {
					command: [
						script.interpreter === "node" ? process.execPath : "bash",
						entrypointCheck.resolvedEntrypointPath,
					],
					resumeCommand: [],
					workingDirectory: assetsDir,
				},
			},
			async () => {
				await input.validateBeforeDispatch?.();
				await mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
					if (
						current.cancellationIntent ||
						current.launchStage === "terminal" ||
						Date.now() >= current.deadlineAtEpochMs
					)
						throw new Error("执行已取消或结束");
					current.launchStage = "launch_committed";
				});
			},
			{
				artifactDirectory: verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId),
				deadlineAtEpochMs: attempt.deadlineAtEpochMs,
				preventRedispatch: true,
				superviseProcessGroup: true,
				outputTailMaxChars: RUNNING_OUTPUT_BUFFER_MAX_CHARS,
				environment: {
					KANBAN_RUNTIME_HOST: getKanbanRuntimeHost(),
					KANBAN_RUNTIME_PORT: String(getKanbanRuntimePort()),
					KANBAN_VERIFICATION_ID: verificationId,
					KANBAN_VERIFICATION_EXECUTION_ATTEMPT_ID: attempt.verificationExecutionAttemptId,
				},
			},
		);
	} catch (error) {
		launchError = error instanceof Error ? error.message : String(error);
	}
	// RPC 只观察原回执，清理预算耗尽后交回 running；监督者及 deadline 不依赖这个等待者。
	while (Date.now() < attempt.deadlineAtEpochMs + 5_000) {
		const observedProgress = await readVerificationSupervisorProgress(attempt);
		if (observedProgress) observeOutputTail(observedProgress);
		const run = await readVerificationExecutionTerminalRun(
			await readVerificationExecutionAttempt(attempt.verificationExecutionAttemptId),
			input.finishedAtIsoProvider,
		);
		if (run) return run as VerificationScriptRunOutcome;
		if (launchError) break;
		await delay(Math.min(100, Math.max(1, attempt.deadlineAtEpochMs + 5_000 - Date.now())));
	}
	const progress = await readVerificationSupervisorProgress(attempt);
	return {
		...buildVerificationExecutionRunSnapshot(attempt, {
			status: "running",
			exitCode: null,
			finishedAtIso: null,
			outputExcerpt: tailExcerpt(progress?.outputTail ?? ""),
		}),
		status: "running",
		recoveryObservation: {
			reason: "awaiting_exit_confirmation",
			message: `正在核验退出${launchError ? `：${launchError}` : "，确认前禁止重跑"}`,
			unchangedEvidenceProbeCount: attempt.recoveryBudget.unchangedEvidenceProbeCount,
			nextActiveProbeAtEpochMs: attempt.recoveryBudget.nextActiveProbeAtEpochMs,
		},
	};
}

export function toRunSnapshot(outcome: VerificationScriptRunOutcome): RuntimePostDeployVerificationRun {
	return { ...outcome };
}
