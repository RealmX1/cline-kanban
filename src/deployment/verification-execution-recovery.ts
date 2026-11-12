import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RuntimePostDeployVerificationRun } from "../core/api-contract";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import {
	cancelOwnedCommandProcesses,
	hasSameProcessGeneration,
	inspectOwnedCommandSupervisor,
	type OwnedProcessIdentity,
	observeOwnedProcessGenerations,
	readSystemBootIdentity,
} from "../task-command-execution/task-command-execution-supervisor";
import { cleanupAuthoredVerificationDefinitionAndAssets } from "./authored-verification-definitions";
import {
	applyVerificationRunResultWithinStateLock,
	findPostDeployVerificationTaskFollowingCarriedForwardChain,
	mutatePostDeployVerificationState,
	readPostDeployVerificationStateCorruptionTolerant,
	reconcileVerificationTaskIncarnationWithinStateLock,
} from "./post-deploy-verification-state";
import {
	cancelVerificationExecutionAttempt,
	listVerificationExecutionAttempts,
	mutateVerificationExecutionAttempt,
	readVerificationExecutionAttempt,
	type VerificationExecutionAttempt,
	verificationExecutionAttemptCancellationPath,
	verificationExecutionAttemptDirectory,
} from "./verification-execution-attempt-store";
import { verificationExecutionDefinitionFingerprint } from "./verification-execution-definition-fingerprint";
import {
	buildVerificationExecutionRunSnapshot,
	readVerificationExecutionTerminalRun,
	readVerificationSupervisorProgress,
	verificationSupervisorProgressSchema,
} from "./verification-script-runner";

const RECOVERY_OBSERVATION_INTERVAL_MS = 15_000;
const MAX_UNCHANGED_EVIDENCE_ACTIVE_PROBES = 3;

async function readSupervisorIdentity(attempt: VerificationExecutionAttempt): Promise<OwnedProcessIdentity | null> {
	try {
		const value = JSON.parse(
			await readFile(
				join(
					verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId),
					`supervisor-identity-${attempt.verificationExecutionAttemptId}.json`,
				),
				"utf8",
			),
		) as OwnedProcessIdentity & { launchNonce?: string };
		return value.launchNonce === attempt.verificationExecutionAttemptId &&
			Number.isInteger(value.pid) &&
			typeof value.startAndCommand === "string"
			? value
			: null;
	} catch {
		return null;
	}
}

async function finalizeConfirmedInterruptedVerificationExecution(
	attempt: VerificationExecutionAttempt,
	nowIso: string,
	reason: string,
) {
	// 首读和 owner 退出核验之间，监督者可能已经持久化最后一份成功回执。
	const latestTerminalRun = await readVerificationExecutionTerminalRun(
		await readVerificationExecutionAttempt(attempt.verificationExecutionAttemptId),
		() => nowIso,
	);
	if (latestTerminalRun) return latestTerminalRun;
	return mutateVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, (current) => {
		if (current.terminalRun) return current.terminalRun;
		current.launchStage = "terminal";
		current.terminalRun = buildVerificationExecutionRunSnapshot(current, {
			status: current.cancellationIntent?.reason === "deadline_elapsed" ? "timed_out" : "errored",
			exitCode: null,
			finishedAtIso: nowIso,
			outputExcerpt: reason,
		});
		return current.terminalRun;
	});
}

export async function observeVerificationExecutionAttempt(
	attemptId: string,
	nowEpochMs = Date.now(),
	systemBootIdentity?: string | null,
): Promise<RuntimePostDeployVerificationRun> {
	let attempt = await readVerificationExecutionAttempt(attemptId);
	const terminal = await readVerificationExecutionTerminalRun(attempt);
	if (terminal) return terminal;
	const nowIso = new Date(nowEpochMs).toISOString();
	const currentBoot = systemBootIdentity === undefined ? await readSystemBootIdentity() : systemBootIdentity;
	const trustedBootBaseline = attempt.systemBootIdentity ?? attempt.firstTrustedObservedSystemBootIdentity;
	if (currentBoot && trustedBootBaseline && currentBoot !== trustedBootBaseline) {
		return finalizeConfirmedInterruptedVerificationExecution(
			attempt,
			nowIso,
			"真实开机代际已变化，旧执行及后代已退出",
		);
	}
	if (currentBoot && !trustedBootBaseline) {
		await mutateVerificationExecutionAttempt(attemptId, (current) => {
			current.firstTrustedObservedSystemBootIdentity ??= currentBoot;
		});
	}
	if (nowEpochMs >= attempt.deadlineAtEpochMs && attempt.launchStage !== "legacy_unowned") {
		await cancelVerificationExecutionAttempt(attemptId, "deadline_elapsed", nowIso);
		attempt = await readVerificationExecutionAttempt(attemptId);
	}
	const progress = await readVerificationSupervisorProgress(attempt);
	const owner = await readSupervisorIdentity(attempt);
	let nativeProbePath: string | null | undefined;
	try {
		nativeProbePath = (
			JSON.parse(
				await readFile(
					join(verificationExecutionAttemptDirectory(attemptId), `launch-materials-${attemptId}.json`),
					"utf8",
				),
			) as { darwinOriginalParentGenerationProbePath?: string | null }
		).darwinOriginalParentGenerationProbePath;
	} catch {
		/* 缺少原件保持未知。 */
	}

	let supplementalOwnedProcesses: OwnedProcessIdentity[] = [];
	try {
		const supplemental = JSON.parse(
			await readFile(
				join(
					verificationExecutionAttemptDirectory(attemptId),
					`supplemental-owned-process-identities-${attemptId}.json`,
				),
				"utf8",
			),
		) as { launchNonce?: string; ownedProcesses?: unknown };
		if (supplemental.launchNonce === attemptId)
			supplementalOwnedProcesses = verificationSupervisorProgressSchema.shape.ownedProcesses.parse(
				supplemental.ownedProcesses,
			);
	} catch {
		/* 缺少补证原件不推断退出。 */
	}
	const processObservations = await observeOwnedProcessGenerations(
		[
			...(owner ? [owner] : []),
			...(progress?.ownedProcesses ?? []),
			...(progress?.unprovenOwnershipProcesses ?? []).map((entry) => ({
				pid: entry.pid,
				startAndCommand: entry.processStartIdentity,
				nativeProcessGenerationIdentity: entry.nativeProcessGenerationIdentity,
			})),
			...supplementalOwnedProcesses,
		],
		nativeProbePath,
	);
	const ownerObservation = processObservations.find((entry) => entry.expected.pid === owner?.pid);
	const ownerStillAlive =
		ownerObservation?.current !== "unreadable" &&
		owner?.nativeProcessGenerationIdentity !== undefined &&
		hasSameProcessGeneration(ownerObservation?.current, owner);
	let launchMaterialsObservation: string;
	try {
		const info = await stat(
			join(verificationExecutionAttemptDirectory(attemptId), `launch-materials-${attemptId}.json`),
		);
		launchMaterialsObservation = `${info.size}:${info.mtimeMs}`;
	} catch (error) {
		launchMaterialsObservation = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
	const processGenerationEvidence = (identity: OwnedProcessIdentity | null) =>
		identity
			? {
					pid: identity.pid,
					generation:
						identity.nativeProcessGenerationIdentity ??
						identity.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0] ??
						"unreadable",
				}
			: null;
	const evidenceFingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				currentBoot,
				progress: progress
					? {
							status: progress.status,
							ownedProcesses: progress.ownedProcesses.map(processGenerationEvidence),
							timedOut: progress.timedOut,
							returncode: progress.returncode,
							signal: progress.signal,
							nativeOwnershipUnproven: progress.nativeOwnershipUnproven,
							kernelChildExitObservation: progress.kernelChildExitObservation,
							linuxKernelContainmentContinuityLost: progress.linuxKernelContainmentContinuityLost,
							error: progress.error,
							unprovenOwnershipProcesses: progress.unprovenOwnershipProcesses,
						}
					: null,
				owner: processGenerationEvidence(owner),
				processObservations: processObservations.map((entry) => ({
					expected: processGenerationEvidence(entry.expected),
					current: entry.current === "unreadable" ? "unreadable" : processGenerationEvidence(entry.current),
				})),
				launchMaterialsObservation,
				cancellationIntent: attempt.cancellationIntent,
			}),
		)
		.digest("hex");
	const activeProbeReserved = await mutateVerificationExecutionAttempt(attemptId, (current) => {
		if (current.terminalRun) return false;
		const budget = current.recoveryBudget;
		if (budget.evidenceFingerprint !== evidenceFingerprint) {
			budget.evidenceFingerprint = evidenceFingerprint;
			budget.unchangedEvidenceProbeCount = 0;
			budget.nextActiveProbeAtEpochMs = 0;
		}
		if (
			budget.unchangedEvidenceProbeCount >= MAX_UNCHANGED_EVIDENCE_ACTIVE_PROBES ||
			nowEpochMs < budget.nextActiveProbeAtEpochMs
		)
			return false;
		budget.unchangedEvidenceProbeCount++;
		budget.nextActiveProbeAtEpochMs = nowEpochMs + RECOVERY_OBSERVATION_INTERVAL_MS;
		return true;
	});
	if (activeProbeReserved && attempt.launchStage !== "legacy_unowned") {
		const reference = { workspaceId: attempt.workspaceId, executionId: attemptId, launchNonce: attemptId };
		const options = {
			artifactDirectory: verificationExecutionAttemptDirectory(attemptId),
			superviseProcessGroup: true,
		};
		const inspection = await inspectOwnedCommandSupervisor(reference, options);
		if (inspection === "exited")
			return finalizeConfirmedInterruptedVerificationExecution(
				attempt,
				nowIso,
				"归属执行已退出，未取得可接受的脚本结果",
			);
		if (inspection === "not_started" && attempt.cancellationIntent) {
			return finalizeConfirmedInterruptedVerificationExecution(
				attempt,
				nowIso,
				"取消原件已持久化，派发屏障尚未写入；确认脚本未启动",
			);
		}
		if (attempt.cancellationIntent && !ownerStillAlive) {
			await cancelOwnedCommandProcesses(
				{
					...reference,
					previousLaunchNonces: [],
					revocationFile: verificationExecutionAttemptCancellationPath(attemptId),
					specification: { workingDirectory: verificationExecutionAttemptDirectory(attemptId) },
				},
				options,
			);
		}
	}
	attempt = await readVerificationExecutionAttempt(attemptId);
	if (attempt.terminalRun) return attempt.terminalRun;
	const waitingForExit =
		attempt.cancellationIntent !== null ||
		attempt.launchStage === "legacy_unowned" ||
		owner === null ||
		!ownerStillAlive ||
		progress?.returncode !== undefined ||
		progress?.signal !== undefined ||
		progress?.nativeOwnershipUnproven === true;
	const unchangedEvidenceProbeCount = Math.max(
		attempt.recoveryBudget.unchangedEvidenceProbeCount,
		progress?.postScriptOwnershipRecoveryBudget?.unchangedEvidenceProbeCount ?? 0,
	);
	const budgetExhausted = unchangedEvidenceProbeCount >= MAX_UNCHANGED_EVIDENCE_ACTIVE_PROBES;
	const unprovenProcessIdentities = (progress?.unprovenOwnershipProcesses ?? [])
		.slice(0, 10)
		.map(({ pid, ...identity }) => ({ processPid: pid, ...identity }));
	const specificRecoveryMessage = unprovenProcessIdentities.length
		? `正在核验退出：原生归属未证 PID ${unprovenProcessIdentities
				.slice(0, 5)
				.map((entry) => entry.processPid)
				.join("、")}；身份、终结原件或开机代际变化后自动补证`
		: `正在核验退出：attempt ${attemptId} 尚未取得可信终结原件，确认前禁止重跑`;
	return {
		...buildVerificationExecutionRunSnapshot(attempt, {
			status: "running",
			exitCode: null,
			finishedAtIso: null,
			outputExcerpt: (progress?.outputTail ?? "").slice(-4000),
		}),
		...(waitingForExit
			? {
					recoveryObservation: {
						reason: budgetExhausted
							? ("unchanged_evidence_budget_exhausted" as const)
							: attempt.launchStage === "legacy_unowned"
								? ("legacy_execution_ownership_unknown" as const)
								: ("awaiting_exit_confirmation" as const),
						message: budgetExhausted
							? `${specificRecoveryMessage}；相同证据已补查 3 次，等待回执、进程身份或真实开机代际变化后自动续查`
							: specificRecoveryMessage,
						unchangedEvidenceProbeCount,
						nextActiveProbeAtEpochMs:
							progress?.postScriptOwnershipRecoveryBudget?.nextActiveProbeAtEpochMs ??
							attempt.recoveryBudget.nextActiveProbeAtEpochMs,
						unprovenProcessIdentities,
						recoveryTriggers: [
							"terminal_receipt_changed",
							"owned_or_unproven_process_generation_changed",
							"system_boot_identity_changed",
						],
					},
				}
			: {}),
	};
}

export interface VerificationExecutionRecoveryDependencies {
	readCurrentTaskIncarnationCreatedAtEpochMs?: (workspaceId: string, taskId: string) => Promise<number | null>;
}

export async function reconcileVerificationExecutionAttempts(
	workspaceId?: string,
	deps: VerificationExecutionRecoveryDependencies = {},
): Promise<void> {
	const nowIso = new Date().toISOString();
	let snapshot = await readPostDeployVerificationStateCorruptionTolerant(nowIso);
	if (
		snapshot.deploymentGroups.some((group) =>
			group.tasks.some((task) =>
				task.checklist.some((item) => item.run?.status === "running" && !item.run.verificationExecutionAttemptId),
			),
		)
	) {
		await mutatePostDeployVerificationState(nowIso, () => undefined);
		snapshot = await readPostDeployVerificationStateCorruptionTolerant(nowIso);
	}
	const publicRunningAttempts = new Map<string, RuntimePostDeployVerificationRun>();
	for (const group of snapshot.deploymentGroups)
		for (const task of group.tasks) {
			if (
				task.verifiedAt !== null ||
				task.postDeployVerificationClosure !== null ||
				task.droppedReason !== null ||
				task.carriedForwardIntoDeploymentId !== null
			)
				continue;
			for (const item of task.checklist)
				if (item.run?.status === "running" && item.run.verificationExecutionAttemptId)
					publicRunningAttempts.set(item.run.verificationExecutionAttemptId, item.run);
		}
	const attemptsToObserve = (await listVerificationExecutionAttempts()).filter(
		(attempt) =>
			(!workspaceId || workspaceId === attempt.workspaceId) &&
			(attempt.launchStage !== "terminal" ||
				attempt.assetsCleanupPending ||
				publicRunningAttempts.has(attempt.verificationExecutionAttemptId)),
	);
	if (attemptsToObserve.length === 0) return;
	const boot = await readSystemBootIdentity();
	const applications: {
		attempt: VerificationExecutionAttempt;
		run: RuntimePostDeployVerificationRun;
		currentTaskIncarnationCreatedAtEpochMs?: number | null;
	}[] = [];
	const pendingCleanupAttempts: VerificationExecutionAttempt[] = [];
	const currentIncarnationsByWorkspaceAndTask = new Map<string, number | null>();
	for (const attempt of attemptsToObserve) {
		try {
			const run = await observeVerificationExecutionAttempt(
				attempt.verificationExecutionAttemptId,
				Date.now(),
				boot,
			);
			if (publicRunningAttempts.has(attempt.verificationExecutionAttemptId)) {
				const key = JSON.stringify([attempt.workspaceId, attempt.taskId]);
				if (deps.readCurrentTaskIncarnationCreatedAtEpochMs && !currentIncarnationsByWorkspaceAndTask.has(key))
					currentIncarnationsByWorkspaceAndTask.set(
						key,
						await deps.readCurrentTaskIncarnationCreatedAtEpochMs(attempt.workspaceId, attempt.taskId),
					);
				const currentTaskIncarnationCreatedAtEpochMs = currentIncarnationsByWorkspaceAndTask.get(key);
				if (!isDeepStrictEqual(run, publicRunningAttempts.get(attempt.verificationExecutionAttemptId)))
					applications.push({ attempt, run, currentTaskIncarnationCreatedAtEpochMs });
			}
			const latest = await readVerificationExecutionAttempt(attempt.verificationExecutionAttemptId);
			if (latest.launchStage === "terminal" && latest.assetsCleanupPending) pendingCleanupAttempts.push(latest);
		} catch (error) {
			logDeploymentDiagnosticWarning(
				`[verification-execution-recovery] attempt=${attempt.verificationExecutionAttemptId} 补证暂不可用，下轮自动重验：${String(error)}`,
			);
		}
	}
	// 每轮只有一份公共快照和至多一次批量写入；已应用的 terminal 历史不再重读/解析全局文件。
	if (applications.length > 0)
		await mutatePostDeployVerificationState(nowIso, async (state) => {
			for (const {
				attempt,
				run,
				currentTaskIncarnationCreatedAtEpochMs: previouslyObservedIncarnation,
			} of applications) {
				const currentTaskIncarnationCreatedAtEpochMs = deps.readCurrentTaskIncarnationCreatedAtEpochMs
					? await deps.readCurrentTaskIncarnationCreatedAtEpochMs(attempt.workspaceId, attempt.taskId)
					: previouslyObservedIncarnation;
				const found = findPostDeployVerificationTaskFollowingCarriedForwardChain(
					state,
					attempt.deploymentId,
					attempt.taskId,
				);
				const item = found?.task.checklist.find((entry) => entry.id === attempt.itemId);
				if (
					found &&
					currentTaskIncarnationCreatedAtEpochMs !== null &&
					currentTaskIncarnationCreatedAtEpochMs !== undefined
				)
					reconcileVerificationTaskIncarnationWithinStateLock(found.task, currentTaskIncarnationCreatedAtEpochMs);
				if (!found || !item || item.run?.verificationExecutionAttemptId !== attempt.verificationExecutionAttemptId)
					continue;
				if (
					currentTaskIncarnationCreatedAtEpochMs === null &&
					!found.task.postDeployVerificationClosure &&
					found.task.verifiedAt === null
				) {
					found.task.droppedReason = "task_deleted";
					continue;
				}
				if (
					run.status !== "running" &&
					(verificationExecutionDefinitionFingerprint(item) !== attempt.verificationDefinitionFingerprint ||
						(attempt.cancellationIntent !== null && run.status === "passed"))
				) {
					if (
						found.task.verifiedAt === null &&
						found.task.postDeployVerificationClosure === null &&
						found.task.postDeployVerificationTaskInstanceId === attempt.postDeployVerificationTaskInstanceId
					) {
						item.run = null;
						item.checked = false;
					}
				} else
					await applyVerificationRunResultWithinStateLock(state, {
						deploymentId: attempt.deploymentId,
						taskId: attempt.taskId,
						itemId: attempt.itemId,
						run,
						currentTaskIncarnationCreatedAtEpochMs,
					});
			}
		});
	for (const attempt of pendingCleanupAttempts)
		await cleanupAuthoredVerificationDefinitionAndAssets(attempt.verificationId, nowIso, {
			expectedPendingCleanupAttemptId: attempt.verificationExecutionAttemptId,
		});
}

// runtime 负责接线：启动立即一次、之后按持久预算补证；stop 只停止观察，不撤销已获准的独立执行。
export function startVerificationExecutionRecoveryLifecycle(deps: VerificationExecutionRecoveryDependencies = {}) {
	let stopped = false;
	let inFlight: Promise<void> | null = null;
	const reconcileNow = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (inFlight) return inFlight;
		inFlight = reconcileVerificationExecutionAttempts(undefined, deps)
			.catch((error) => {
				logDeploymentDiagnosticWarning(
					`[verification-execution-recovery] 恢复扫描失败，将自动重试：${String(error)}`,
				);
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};
	const timer = setInterval(() => {
		void reconcileNow();
	}, RECOVERY_OBSERVATION_INTERVAL_MS);
	timer.unref();
	void reconcileNow();
	return {
		reconcileNow,
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(timer);
			await inFlight;
		},
	};
}
