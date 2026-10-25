import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, renameSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { z } from "zod";
import { createRuntimeTrpcClient } from "../src/commands/task";
import type { RuntimeTaskChatSendRequest, RuntimeTaskSessionSummary } from "../src/core/api-contract";
import { isCrossProjectTaskSwitcherEntryRunning } from "../src/core/cross-project-recently-active-task-switcher-section-assignment";
import { createGitProcessEnv } from "../src/core/git-process-env";
import { resolveSessionFacets } from "../src/core/session-activity";
import { lockedFileSystem } from "../src/fs/locked-file-system";

export const RVF_PROMPT_TEXT = "$review-validate-fix";
export const RESOURCE_OBSERVATION_WINDOW_MS = 300_000;
export const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;
const MAXIMUM_DISPATCH_RESOURCE_AND_RUNNING_SNAPSHOT_AGE_MS = 15_000;
const RVF_START_OBSERVATION_TIMEOUT_MS = 1_200_000;
const executeFile = promisify(execFile);

export interface HostResourceIntervalObservation {
	startedAtMs: number;
	endedAtMs: number;
	cpuBusyPercent: number;
	memoryPressureLevel: number | null;
}

export function evaluateHostResourcesBeforeRvfPromptDispatch(
	observations: readonly HostResourceIntervalObservation[],
	nowMs: number,
	runningTaskCount: number | null,
	cpuAverageLimitPercent = 80,
): { allowed: boolean; reason: string; averageCpuBusyPercent: number | null } {
	const windowStartedAtMs = nowMs - RESOURCE_OBSERVATION_WINDOW_MS;
	const window = observations.filter((sample) => sample.endedAtMs > windowStartedAtMs);
	const denied = (reason: string, averageCpuBusyPercent: number | null = null) => ({
		allowed: false,
		reason,
		averageCpuBusyPercent,
	});
	if (
		!window.length ||
		window[0].startedAtMs > windowStartedAtMs ||
		window.at(-1)!.endedAtMs < nowMs - MAXIMUM_DISPATCH_RESOURCE_AND_RUNNING_SNAPSHOT_AGE_MS
	)
		return denied("资源观测尚未覆盖最近完整五分钟");
	let coveredUntilMs = windowStartedAtMs;
	let weightedCpuBusyPercent = 0;
	let coveredDurationMs = 0;
	for (const sample of window) {
		if (
			!Number.isFinite(sample.cpuBusyPercent) ||
			sample.cpuBusyPercent < 0 ||
			sample.cpuBusyPercent > 100 ||
			sample.startedAtMs > coveredUntilMs ||
			(coveredDurationMs > 0 && sample.startedAtMs !== coveredUntilMs) ||
			sample.endedAtMs <= sample.startedAtMs ||
			sample.endedAtMs - sample.startedAtMs > 30_000 ||
			sample.endedAtMs > nowMs
		)
			return denied("资源采样有缺口或无效读数");
		if (sample.memoryPressureLevel !== 1) return denied("最近五分钟内存 pressure 非 normal 或未知");
		const durationMs = sample.endedAtMs - Math.max(windowStartedAtMs, sample.startedAtMs);
		weightedCpuBusyPercent += sample.cpuBusyPercent * durationMs;
		coveredDurationMs += durationMs;
		coveredUntilMs = sample.endedAtMs;
	}
	const averageCpuBusyPercent = weightedCpuBusyPercent / coveredDurationMs;
	if (averageCpuBusyPercent > cpuAverageLimitPercent) return denied("五分钟平均 CPU 超过门槛", averageCpuBusyPercent);
	if (runningTaskCount === null || !Number.isInteger(runningTaskCount) || runningTaskCount < 0)
		return denied("All Projects Running 数量未知", averageCpuBusyPercent);
	if (runningTaskCount >= 8) return denied("All Projects Running 数量不少于 8", averageCpuBusyPercent);
	return { allowed: true, reason: "资源与 Running 门槛均满足", averageCpuBusyPercent };
}

const targetIdentitySchema = z.object({
	taskWorktreePath: z.string(),
	mainProjectPath: z.string(),
	workspaceId: z.string(),
	taskId: z.string(),
});
export const scheduledRvfTargetSchema = targetIdentitySchema.extend({
	status: z.enum([
		"not_sent",
		"send_intent_recorded",
		"accepted_by_runtime",
		"reviewers_started",
		"blocked",
		"outcome_unknown",
	]),
	sendRequestedAtMs: z.number().nullable(),
	conversationSessionId: z.string().nullable(),
	nativeSessionId: z.string().nullable(),
	runtimeSessionIncarnationId: z.string().nullable(),
	transcriptPath: z.string().nullable(),
	transcriptByteOffset: z.number(),
	transcriptUserMessageObserved: z.boolean(),
	nativeUserMessageText: z.string().nullable().default(null),
	structuredSkillReferenceObserved: z.boolean(),
	skillExpansionObserved: z.boolean().default(false),
	hookRecognized: z.boolean(),
	decisionToken: z.string().nullable(),
	runDirectory: z.string().nullable(),
	reviewerOutputEvidencePaths: z.array(z.string()),
	lastAgentCompletion: z.string().nullable(),
	stopReason: z.string().nullable(),
});
export type ScheduledRvfTarget = z.infer<typeof scheduledRvfTargetSchema>;

const schedulerStateSchema = z.object({
	schemaVersion: z.literal(1),
	promptText: z.literal(RVF_PROMPT_TEXT),
	cpuAverageLimitPercent: z.number().min(1).max(100),
	targets: z.array(scheduledRvfTargetSchema).min(1),
});
type SchedulerState = z.infer<typeof schedulerStateSchema>;

export function createUnsentRvfTarget(identity: z.infer<typeof targetIdentitySchema>): ScheduledRvfTarget {
	return {
		...identity,
		status: "not_sent",
		sendRequestedAtMs: null,
		conversationSessionId: null,
		nativeSessionId: null,
		runtimeSessionIncarnationId: null,
		transcriptPath: null,
		transcriptByteOffset: 0,
		transcriptUserMessageObserved: false,
		nativeUserMessageText: null,
		structuredSkillReferenceObserved: false,
		skillExpansionObserved: false,
		hookRecognized: false,
		decisionToken: null,
		runDirectory: null,
		reviewerOutputEvidencePaths: [],
		lastAgentCompletion: null,
		stopReason: null,
	};
}

export function selectNextRvfTarget(state: SchedulerState, mode: "pilot" | "remaining"): ScheduledRvfTarget | null {
	if (mode === "remaining" && state.targets[0].status !== "reviewers_started")
		throw new Error("首轮尚未证实 reviewer 启动，不能运行 remaining 模式。");
	const targets = mode === "pilot" ? state.targets.slice(0, 1) : state.targets.slice(1);
	const next = targets.find((target) => target.status !== "reviewers_started");
	if (next?.status === "blocked" || next?.status === "outcome_unknown")
		throw new Error(`任务 ${next.taskId} 已停止：${next.stopReason}；不会自动重投。`);
	return next ?? null;
}

export function buildUserRequestedRvfPromptRequest(target: ScheduledRvfTarget): RuntimeTaskChatSendRequest {
	if (!target.conversationSessionId) throw new Error("发送前必须绑定目标主会话。");
	// 用户已明确选择用户发送通道；来源由 CLI actor claims 与本任务发送记录保存，不借用后台 source 特例。
	return {
		taskId: target.taskId,
		targetTaskConversationSessionId: target.conversationSessionId,
		text: RVF_PROMPT_TEXT,
	};
}

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function observeCodexTranscriptRecord(target: ScheduledRvfTarget, value: unknown): void {
	const record = objectRecord(value);
	const payload = objectRecord(record?.payload);
	if (
		!record ||
		!payload ||
		typeof record.timestamp !== "string" ||
		!Number.isFinite(Date.parse(record.timestamp)) ||
		Date.parse(record.timestamp) < (target.sendRequestedAtMs ?? Infinity)
	)
		return;
	const isRvfCommand = (text: unknown): text is string =>
		typeof text === "string" && /^\$(?:[^\s:$]+:)?review-validate-fix$/.test(text.trim());
	if (record.type === "event_msg" && payload.type === "user_message" && isRvfCommand(payload.message)) {
		target.transcriptUserMessageObserved = true;
		target.nativeUserMessageText = payload.message;
		const elements = Array.isArray(payload.text_elements) ? payload.text_elements : [];
		target.structuredSkillReferenceObserved ||= elements.some((element) => {
			const placeholder = objectRecord(element)?.placeholder;
			return typeof placeholder === "string" && /^\$(?:[^\s:$]+:)?review-validate-fix$/.test(placeholder);
		});
	}
	if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
		const content = Array.isArray(payload.content) ? payload.content : [];
		const text = content.map((item) => objectRecord(item)?.text ?? "").join("");
		if (isRvfCommand(text)) {
			target.transcriptUserMessageObserved = true;
			target.nativeUserMessageText = text;
		}
		if (
			target.transcriptUserMessageObserved &&
			/^<skill>\s*<name>(?:[^\s:<]+:)?review-validate-fix<\/name>/.test(text)
		)
			target.skillExpansionObserved = true;
	}
	if (
		record.type === "event_msg" &&
		payload.type === "task_complete" &&
		typeof payload.last_agent_message === "string"
	)
		target.lastAgentCompletion = payload.last_agent_message;
}

export function reconcileTargetNativeTranscriptLocation(
	target: ScheduledRvfTarget,
	session: RuntimeTaskSessionSummary,
): boolean {
	const identity = session.agentNativeConversationSessionIdentity;
	if (
		session.taskId !== target.conversationSessionId ||
		identity?.nativeSessionId !== target.nativeSessionId ||
		(session.runtimeSessionIncarnationId ?? null) !== target.runtimeSessionIncarnationId
	)
		throw new Error("目标主会话或原生进程代次已变化，停止归因。");
	if (!identity?.transcriptPath) throw new Error("当前原生会话缺少已核验转录路径。");
	if (identity.transcriptPath === target.transcriptPath) return false;
	// 同一原生会话续接后可能换物理文件；只跟随运行时明确记录的路径，旧消息仍按发送时刻过滤。
	target.transcriptPath = identity.transcriptPath;
	target.transcriptByteOffset = 0;
	return true;
}

export async function readNewTranscriptRecords(target: ScheduledRvfTarget): Promise<void> {
	if (!target.transcriptPath) throw new Error("当前主会话缺少可信原生转录路径。");
	const handle = await open(target.transcriptPath, "r");
	try {
		const metadata = await handle.stat();
		if (metadata.size < target.transcriptByteOffset) throw new Error("原生转录发生截断，停止归因。");
		const buffer = Buffer.alloc(Math.min(metadata.size - target.transcriptByteOffset, 8 * 1024 * 1024));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, target.transcriptByteOffset);
		const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
		if (lastNewline < 0) return;
		// 仅按 LF 分帧，合法 JSON 字符串中的 U+2028/U+2029 不是记录分界。
		for (const line of buffer
			.subarray(0, lastNewline + 1)
			.toString("utf8")
			.split("\n")) {
			if (line.trim()) observeCodexTranscriptRecord(target, JSON.parse(line));
		}
		target.transcriptByteOffset += lastNewline + 1;
	} finally {
		await handle.close();
	}
}

async function readJsonObjectIfPresent(path: string): Promise<Record<string, unknown> | null> {
	try {
		return objectRecord(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function arePathsVerifiedAsSameExistingDirectory(firstPath: unknown, secondPath: string): Promise<boolean> {
	if (typeof firstPath !== "string" || !isAbsolute(firstPath) || !isAbsolute(secondPath)) return false;
	try {
		const [firstDirectoryMetadata, secondDirectoryMetadata] = await Promise.all([
			stat(firstPath, { bigint: true }),
			stat(secondPath, { bigint: true }),
		]);
		// stat 跟随符号链接；设备号与 inode 共同核验真实目录身份，读取失败不构成匹配证据。
		return (
			firstDirectoryMetadata.isDirectory() &&
			secondDirectoryMetadata.isDirectory() &&
			firstDirectoryMetadata.ino > 0n &&
			firstDirectoryMetadata.dev === secondDirectoryMetadata.dev &&
			firstDirectoryMetadata.ino === secondDirectoryMetadata.ino
		);
	} catch {
		return false;
	}
}

export async function rvfDecisionTokenBelongsToDispatch(
	target: ScheduledRvfTarget,
	token: Record<string, unknown>,
): Promise<boolean> {
	return (
		target.transcriptUserMessageObserved &&
		token.session_id === target.nativeSessionId &&
		typeof token.created_at === "string" &&
		Date.parse(token.created_at) >= (target.sendRequestedAtMs ?? Infinity) &&
		(await arePathsVerifiedAsSameExistingDirectory(token.worktree, target.taskWorktreePath))
	);
}

export async function observeRvfRunArtifacts(target: ScheduledRvfTarget, rvfHome: string): Promise<void> {
	if (!target.transcriptUserMessageObserved) return;
	const tokenDirectory = join(rvfHome, "agentic-initiation-decision-tokens");
	let names: string[];
	try {
		names = target.decisionToken
			? [`${target.decisionToken}.json`]
			: (await readdir(tokenDirectory)).filter((name) => /^[a-f0-9]{16}\.json$/.test(name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		const path = join(tokenDirectory, name);
		if (!target.decisionToken && (await stat(path)).mtimeMs < (target.sendRequestedAtMs ?? Infinity)) continue;
		const token = await readJsonObjectIfPresent(path);
		if (!token || !(await rvfDecisionTokenBelongsToDispatch(target, token))) continue;
		target.decisionToken = String(token.token);
		target.hookRecognized = token.initiated_by_explicit_user_request === true;
		if (token.state === "declined" || token.state === "withdrawn") {
			target.status = "blocked";
			target.stopReason = `RVF token ${token.state}：${token.decline_reason ?? token.withdrawal_reason ?? "原因见原生会话"}`;
			return;
		}
		const overlay = await readJsonObjectIfPresent(join(rvfHome, "agentic-initiation-scope-adjustments", name));
		const runDirectory = overlay?.run_dir ?? token.run_anchor_dir;
		if (typeof runDirectory === "string") target.runDirectory = runDirectory;
		if (!target.runDirectory) continue;
		const summary = await readJsonObjectIfPresent(join(target.runDirectory, "summary.json"));
		if (!(await arePathsVerifiedAsSameExistingDirectory(summary?.repo, target.taskWorktreePath))) continue;
		const reviewersDirectory = join(target.runDirectory, "artifacts", "reviewers");
		const plan = await readJsonObjectIfPresent(join(reviewersDirectory, "reviewer-plan.json"));
		const reviewers = Array.isArray(plan?.reviewers) ? plan.reviewers : [];
		const reviewerIds = new Set(reviewers.map((reviewer) => objectRecord(reviewer)?.reviewer_id));
		// runner 可能在执行结束后才写计划；已绑定 run 下的 reviewer stdout 仍是独立的真实启动证据。
		try {
			for (const entry of await readdir(reviewersDirectory, { withFileTypes: true }))
				if (entry.isDirectory()) reviewerIds.add(entry.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const reviewerId of reviewerIds) {
			if (typeof reviewerId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(reviewerId)) continue;
			const reviewerDirectory = join(reviewersDirectory, reviewerId);
			let artifacts: string[];
			try {
				artifacts = await readdir(reviewerDirectory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const artifact of artifacts.filter((name) => /^reviewer\.stdout.*\.txt$/.test(name))) {
				const evidencePath = join(reviewerDirectory, artifact);
				if ((await stat(evidencePath)).size > 0 && !target.reviewerOutputEvidencePaths.includes(evidencePath))
					target.reviewerOutputEvidencePaths.push(evidencePath);
			}
		}
		if (target.reviewerOutputEvidencePaths.length > 0) target.status = "reviewers_started";
	}
}

export interface RvfDispatchDependencies {
	now: () => number;
	saveState: () => Promise<void>;
	resolveTargetSession: (target: ScheduledRvfTarget) => Promise<RuntimeTaskSessionSummary>;
	sendUserMessage: (
		target: ScheduledRvfTarget,
		request: RuntimeTaskChatSendRequest,
	) => Promise<{ ok: boolean; error?: string }>;
}

class HostResourceGateRejectedBeforeRvfRuntimeSendError extends Error {}

export async function dispatchUnsentRvfPromptOnce(
	target: ScheduledRvfTarget,
	deps: RvfDispatchDependencies,
): Promise<void> {
	if (target.status !== "not_sent") throw new Error("目标已有发送意图，禁止再次发送。");
	const session = await deps.resolveTargetSession(target);
	const facets = resolveSessionFacets(session);
	if (session.agentId !== "codex" || facets.liveness !== "live" || facets.turnOwner !== "user")
		throw new Error("目标必须是存活且已交给用户的 Codex 主会话。");
	const identity = session.agentNativeConversationSessionIdentity;
	if (!identity?.transcriptPath) throw new Error("目标缺少可信原生会话身份或转录。");
	target.conversationSessionId = session.taskId;
	target.nativeSessionId = identity.nativeSessionId;
	target.runtimeSessionIncarnationId = session.runtimeSessionIncarnationId ?? null;
	target.transcriptPath = identity.transcriptPath;
	target.transcriptByteOffset = (await stat(identity.transcriptPath)).size;
	target.sendRequestedAtMs = deps.now();
	target.status = "send_intent_recorded";
	await deps.saveState();
	try {
		const response = await deps.sendUserMessage(target, buildUserRequestedRvfPromptRequest(target));
		target.status = response.ok ? "accepted_by_runtime" : "blocked";
		if (!response.ok) target.stopReason = response.error ?? "运行时拒绝发送";
	} catch (error) {
		if (error instanceof HostResourceGateRejectedBeforeRvfRuntimeSendError) {
			// 此类错误只在调用运行时发送 API 前产生；明确未发送，等待下一个五分钟机会。
			target.status = "not_sent";
			target.sendRequestedAtMs = null;
		} else {
			target.status = "outcome_unknown";
			target.stopReason = `发送结果未知，不自动重投：${error instanceof Error ? error.message : String(error)}`;
		}
	}
	await deps.saveState();
}

function readCpuTicks(): { total: number; idle: number } {
	return cpus().reduce(
		(sum, cpu) => ({
			total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
			idle: sum.idle + cpu.times.idle,
		}),
		{ total: 0, idle: 0 },
	);
}

async function resolveTargetSession(target: ScheduledRvfTarget): Promise<RuntimeTaskSessionSummary> {
	const state = await createRuntimeTrpcClient(target.workspaceId).workspace.getState.query();
	const card = state.board.columns.flatMap((column) => column.cards).find((card) => card.id === target.taskId);
	if (!card) throw new Error(`任务 ${target.workspaceId}/${target.taskId} 不存在。`);
	const summary = state.sessions[card.mainTaskConversationSessionId ?? card.id];
	if (!summary) throw new Error("目标主会话不存在。");
	return summary;
}

async function resolveTargetWorktrees(paths: string[]): Promise<ScheduledRvfTarget[]> {
	if (!paths.length) return [];
	const projects = await createRuntimeTrpcClient(null).projects.list.query();
	const targets: ScheduledRvfTarget[] = [];
	for (const path of paths) {
		const taskWorktreePath = await realpath(resolve(path));
		const commonDirectory = (
			await executeFile("git", ["-C", taskWorktreePath, "rev-parse", "--git-common-dir"], {
				timeout: 10_000,
				env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }),
			})
		).stdout.trim();
		const mainProjectPath = dirname(resolve(taskWorktreePath, commonDirectory));
		const project = projects.projects.find((project) => project.path === mainProjectPath);
		if (!project) throw new Error(`主仓库未注册：${mainProjectPath}`);
		if (dirname(dirname(taskWorktreePath)).split("/").at(-1) !== "worktrees")
			throw new Error(`不是明确的 task worktree 路径：${taskWorktreePath}`);
		const taskId = dirname(taskWorktreePath).split("/").at(-1)!;
		if (targets.some((target) => target.workspaceId === project.id && target.taskId === taskId))
			throw new Error(`目标重复：${project.id}/${taskId}`);
		targets.push(createUnsentRvfTarget({ taskWorktreePath, mainProjectPath, workspaceId: project.id, taskId }));
	}
	return targets;
}

export async function runRvfPromptScheduler(options: {
	mode: "pilot" | "remaining";
	taskWorktreePaths: string[];
	stateDirectory: string;
	cpuAverageLimitPercent: number;
}): Promise<void> {
	await mkdir(options.stateDirectory, { recursive: true });
	let exclusiveSchedulerLockCompromiseError: Error | null = null;
	const assertExclusiveSchedulerLockIsStillHeld = () => {
		if (exclusiveSchedulerLockCompromiseError) throw exclusiveSchedulerLockCompromiseError;
	};
	const exclusiveSchedulerDirectoryLock = {
		type: "directory" as const,
		path: options.stateDirectory,
		retries: 0,
		onCompromised: (error: Error) => {
			exclusiveSchedulerLockCompromiseError ??= new Error("调度器独占锁已失效，停止写入共享记录与发送。", {
				cause: error,
			});
		},
	};
	await lockedFileSystem.withLock(exclusiveSchedulerDirectoryLock, async () => {
		assertExclusiveSchedulerLockIsStillHeld();
		const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
		const journalPath = join(options.stateDirectory, "host-resources-and-rvf-dispatch-events.jsonl");
		const stateExists = await readJsonObjectIfPresent(statePath);
		const persistedState = stateExists ? schedulerStateSchema.parse(stateExists) : null;
		if (
			persistedState &&
			(persistedState.cpuAverageLimitPercent !== options.cpuAverageLimitPercent ||
				persistedState.targets.length !== options.taskWorktreePaths.length)
		)
			throw new Error("目标顺序或 CPU 门槛与持久配置不同；拒绝覆盖已有发送记录。");
		const requestedTaskWorktreePaths = await Promise.all(
			options.taskWorktreePaths.map(async (path, index) => {
				const requestedPath = resolve(path);
				const persistedTarget = persistedState?.targets[index];
				// 已完成目录可能已被清理；原位置的持久规范路径足以核对配置，不重新推导其历史身份。
				if (persistedTarget?.status === "reviewers_started" && requestedPath === persistedTarget.taskWorktreePath)
					return requestedPath;
				return await realpath(requestedPath);
			}),
		);
		if (
			persistedState &&
			requestedTaskWorktreePaths.some((path, index) => path !== persistedState.targets[index].taskWorktreePath)
		)
			throw new Error("目标顺序或 CPU 门槛与持久配置不同；拒绝覆盖已有发送记录。");
		const requestedTargets = await resolveTargetWorktrees(
			requestedTaskWorktreePaths.filter(
				(_path, index) => persistedState?.targets[index].status !== "reviewers_started",
			),
		);
		const state =
			persistedState ??
			schedulerStateSchema.parse({
				schemaVersion: 1,
				promptText: RVF_PROMPT_TEXT,
				cpuAverageLimitPercent: options.cpuAverageLimitPercent,
				targets: requestedTargets,
			});
		// 恢复未结案观察时重读当前原生文件，兼容转录补写与观察器升级；时间过滤和发送意图保持不变。
		for (const target of state.targets)
			if (target.status === "accepted_by_runtime" || target.status === "send_intent_recorded")
				target.transcriptByteOffset = 0;
		const writeSchedulerArtifactAtomicallyWhileExclusiveLockIsHeld = async (path: string, content: string) => {
			assertExclusiveSchedulerLockIsStillHeld();
			const uncommittedSchedulerArtifactPath = `${path}.uncommitted-scheduler-write.${process.pid}.${randomUUID()}`;
			try {
				await writeFile(uncommittedSchedulerArtifactPath, content, { encoding: "utf8", flag: "wx" });
				// 共享文件的提交不能隔着 await；失锁期间完成的独占暂存写不得覆盖新持有者。
				assertExclusiveSchedulerLockIsStillHeld();
				renameSync(uncommittedSchedulerArtifactPath, path);
			} finally {
				// 只清理本次 UUID 所属的暂存文件，失锁后也不会触碰新持有者的记录。
				await rm(uncommittedSchedulerArtifactPath, { force: true });
			}
			assertExclusiveSchedulerLockIsStillHeld();
		};
		const saveState = async () => {
			await writeSchedulerArtifactAtomicallyWhileExclusiveLockIsHeld(
				statePath,
				`${JSON.stringify(state, null, 2)}\n`,
			);
			// 发出请求前把意图刷到持久介质；进程退出或机器重启后以它阻止重复发送。
			for (const path of [statePath, options.stateDirectory]) {
				assertExclusiveSchedulerLockIsStillHeld();
				const handle = await open(path, "r");
				try {
					assertExclusiveSchedulerLockIsStillHeld();
					await handle.sync();
				} finally {
					await handle.close();
				}
			}
			assertExclusiveSchedulerLockIsStillHeld();
		};
		const journal = async (kind: string, detail: unknown) => {
			const line = `${JSON.stringify({ at: new Date().toISOString(), kind, detail })}\n`;
			// 该独立脚本每十秒追加一条短记录，检查与追加放在同一同步片段，避免失锁后续写。
			assertExclusiveSchedulerLockIsStillHeld();
			appendFileSync(journalPath, line);
			if (kind !== "resource_sample") process.stdout.write(line);
		};
		const writeReport = async () => {
			const report = [
				"# RVF prompt 发送与触发报告",
				"",
				`模式：${options.mode}；prompt：\`${RVF_PROMPT_TEXT}\`。`,
				"",
				...state.targets.map(
					(target) =>
						`- ${target.workspaceId}/${target.taskId}：${target.status}；原生消息=${target.transcriptUserMessageObserved}；结构化 skill 引用=${target.structuredSkillReferenceObserved}；原生 skill 展开=${target.skillExpansionObserved}；hook=${target.hookRecognized}；run=${target.runDirectory ?? "尚未观测"}；reviewer 输出证据=${target.reviewerOutputEvidencePaths.length}${target.stopReason ? `；${target.stopReason}` : ""}`,
				),
				"",
				"reviewers_started 只证明关联 reviewer 已产生真实输出，不代表审查通过、提交、部署或 Done。",
				"",
			];
			await writeSchedulerArtifactAtomicallyWhileExclusiveLockIsHeld(
				join(options.stateDirectory, "rvf-prompt-trigger-observation-report.md"),
				report.join("\n"),
			);
		};
		await saveState();
		let stopping = false;
		const stop = () => {
			stopping = true;
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		let previousTicks = readCpuTicks();
		let previousSampleAtMs = Date.now();
		let nextDispatchOpportunityAtMs = previousSampleAtMs + RESOURCE_OBSERVATION_WINDOW_MS;
		const observations: HostResourceIntervalObservation[] = [];
		const rvfHome = process.env.RVF_HOME || join(homedir(), ".rvf");
		let resourceSampleInFlight: Promise<void> | null = null;
		let resourceSamplingFailure: Error | null = null;
		const sampleHostResourcesIndependentlyOfTaskObservation = async () => {
			assertExclusiveSchedulerLockIsStillHeld();
			let memoryPressureLevel: number | null = null;
			try {
				const pressure = (
					await executeFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 3_000 })
				).stdout.trim();
				if (/^[124]$/.test(pressure)) memoryPressureLevel = Number(pressure);
			} catch {
				/* 读取失败保留 unknown，本窗口禁止发送。 */
			}
			if (stopping) return;
			assertExclusiveSchedulerLockIsStillHeld();
			const nowMs = Date.now();
			const ticks = readCpuTicks();
			const sample = {
				startedAtMs: previousSampleAtMs,
				endedAtMs: nowMs,
				cpuBusyPercent: 100 * (1 - (ticks.idle - previousTicks.idle) / (ticks.total - previousTicks.total)),
				memoryPressureLevel,
			};
			previousTicks = ticks;
			previousSampleAtMs = nowMs;
			observations.push(sample);
			while (observations.length && observations[0].endedAtMs <= nowMs - RESOURCE_OBSERVATION_WINDOW_MS)
				observations.shift();
			await journal("resource_sample", { ...sample, loadAverage: loadavg() });
		};
		// 观察、会话查询和 fsync 不占用采样时钟；采样本身只允许一个在途操作。
		const resourceSamplingInterval = setInterval(() => {
			if (stopping || resourceSampleInFlight || resourceSamplingFailure) return;
			resourceSampleInFlight = sampleHostResourcesIndependentlyOfTaskObservation()
				.catch((error: unknown) => {
					resourceSamplingFailure = error instanceof Error ? error : new Error(String(error));
				})
				.finally(() => {
					resourceSampleInFlight = null;
				});
			return resourceSampleInFlight;
		}, RESOURCE_SAMPLE_INTERVAL_MS);
		try {
			await journal("scheduler_started", {
				mode: options.mode,
				cpuAverageLimitPercent: state.cpuAverageLimitPercent,
				promptSha256: createHash("sha256").update(RVF_PROMPT_TEXT).digest("hex"),
				authorizationSource: "task 66679 用户请求、通道选择及已批准计划；调用者身份保留 CLI actor claims",
			});
			while (!stopping) {
				assertExclusiveSchedulerLockIsStillHeld();
				if (resourceSamplingFailure) throw resourceSamplingFailure;
				const target = selectNextRvfTarget(state, options.mode);
				if (!target) break;
				if (target.status !== "not_sent") {
					try {
						const session = await resolveTargetSession(target);
						if (reconcileTargetNativeTranscriptLocation(target, session))
							await journal("native_transcript_location_rebound", {
								taskId: target.taskId,
								transcriptPath: target.transcriptPath,
							});
						await readNewTranscriptRecords(target);
						await observeRvfRunArtifacts(target, rvfHome);
						if (
							target.status !== "reviewers_started" &&
							target.status !== "blocked" &&
							Date.now() - target.sendRequestedAtMs! >= RVF_START_OBSERVATION_TIMEOUT_MS
						) {
							target.status = "outcome_unknown";
							target.stopReason = "发送后 20 分钟内尚未证实 reviewer 启动；不自动重投。";
						}
						if (
							target.lastAgentCompletion &&
							/RVF/i.test(target.lastAgentCompletion) &&
							/受阻|阻断|无法|未能.*派发/.test(target.lastAgentCompletion) &&
							target.status !== "reviewers_started"
						) {
							target.status = "blocked";
							target.stopReason = target.lastAgentCompletion;
						}
					} catch (error) {
						target.status = "outcome_unknown";
						target.stopReason = error instanceof Error ? error.message : String(error);
					}
					await saveState();
					await writeReport();
					await journal("rvf_start_observation", target);
					if (["reviewers_started", "blocked", "outcome_unknown"].includes(target.status)) {
						if (target.status !== "reviewers_started" || options.mode === "pilot") break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, RESOURCE_SAMPLE_INTERVAL_MS));
				assertExclusiveSchedulerLockIsStillHeld();
				if (stopping) break;
				if (resourceSamplingFailure) throw resourceSamplingFailure;
				const nowMs = Date.now();
				if (nowMs < nextDispatchOpportunityAtMs || target.status !== "not_sent") continue;
				nextDispatchOpportunityAtMs = nowMs + RESOURCE_OBSERVATION_WINDOW_MS;
				const dispatchOpportunityEvidenceExpiresAtMs =
					nowMs + MAXIMUM_DISPATCH_RESOURCE_AND_RUNNING_SNAPSHOT_AGE_MS;
				try {
					const projects = await createRuntimeTrpcClient(null).projects.list.query();
					const runningTaskCount = projects.projects
						.flatMap((project) => project.crossProjectTaskSwitcherEntries)
						.filter((entry) => isCrossProjectTaskSwitcherEntryRunning(entry, Date.now())).length;
					const gate = evaluateHostResourcesBeforeRvfPromptDispatch(
						observations,
						Date.now(),
						runningTaskCount,
						state.cpuAverageLimitPercent,
					);
					await journal("dispatch_gate_checked", { ...gate, runningTaskCount, taskId: target.taskId });
					if (!gate.allowed) continue;
					await dispatchUnsentRvfPromptOnce(target, {
						now: Date.now,
						saveState,
						resolveTargetSession,
						sendUserMessage: async (target, request) => {
							assertExclusiveSchedulerLockIsStillHeld();
							const rejectBeforeRuntimeSend = async (reason: string): Promise<never> => {
								await journal("prepared_dispatch_gate_rejected", { taskId: target.taskId, reason });
								throw new HostResourceGateRejectedBeforeRvfRuntimeSendError(reason);
							};
							if (Date.now() > dispatchOpportunityEvidenceExpiresAtMs)
								return await rejectBeforeRuntimeSend(
									"准备或刷盘等待导致本次发送机会的资源快照过期，跳过本次机会。",
								);
							let refreshedRunningTaskCount: number;
							try {
								const refreshedProjects = await createRuntimeTrpcClient(null).projects.list.query();
								refreshedRunningTaskCount = refreshedProjects.projects
									.flatMap((project) => project.crossProjectTaskSwitcherEntries)
									.filter((entry) => isCrossProjectTaskSwitcherEntryRunning(entry, Date.now())).length;
							} catch (error) {
								assertExclusiveSchedulerLockIsStillHeld();
								return await rejectBeforeRuntimeSend(
									`发送前无法重验 Running：${error instanceof Error ? error.message : String(error)}`,
								);
							}
							assertExclusiveSchedulerLockIsStillHeld();
							const preparedDispatchAtMs = Date.now();
							if (resourceSamplingFailure || preparedDispatchAtMs > dispatchOpportunityEvidenceExpiresAtMs)
								return await rejectBeforeRuntimeSend(
									"发送前资源或 Running 快照已过期或采样失败，跳过本次机会。",
								);
							const preparedGate = evaluateHostResourcesBeforeRvfPromptDispatch(
								observations,
								preparedDispatchAtMs,
								refreshedRunningTaskCount,
								state.cpuAverageLimitPercent,
							);
							if (!preparedGate.allowed) return await rejectBeforeRuntimeSend(preparedGate.reason);
							// 从实际请求时刻重新计算间隔，异步准备不能缩短两次发送之间的五分钟。
							nextDispatchOpportunityAtMs = preparedDispatchAtMs + RESOURCE_OBSERVATION_WINDOW_MS;
							const remainingResourceEvidenceValidityMs = dispatchOpportunityEvidenceExpiresAtMs - Date.now();
							if (remainingResourceEvidenceValidityMs <= 0)
								return await rejectBeforeRuntimeSend("发送 RPC 前资源证据已过期，跳过本次机会。");
							// RPC 内部可能等待 runtime 重启；使用本轮剩余时限，超时继续保留发送意图与未知结果。
							const response = await createRuntimeTrpcClient(
								target.workspaceId,
							).runtime.sendTaskChatMessage.mutate(request, {
								signal: AbortSignal.timeout(remainingResourceEvidenceValidityMs),
							});
							assertExclusiveSchedulerLockIsStillHeld();
							return response;
						},
					});
					await writeReport();
					await journal("user_requested_prompt_send_result", target);
				} catch (error) {
					await journal("dispatch_check_failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} finally {
			stopping = true;
			clearInterval(resourceSamplingInterval);
			await resourceSampleInFlight;
			process.removeListener("SIGTERM", stop);
			process.removeListener("SIGINT", stop);
			if (!exclusiveSchedulerLockCompromiseError) {
				await saveState();
				await writeReport();
				await journal("scheduler_stopped", { mode: options.mode });
			}
			assertExclusiveSchedulerLockIsStillHeld();
		}
	});
}

async function main(): Promise<void> {
	const command = new Command()
		.description("按整机资源余量逐个发送用户授权的 RVF prompt，并观察真实启动证据。")
		.requiredOption(
			"--task-worktree-path <path>",
			"目标 task worktree；按发送顺序重复传入",
			(path, paths: string[]) => [...paths, path],
			[],
		)
		.option("--mode <mode>", "pilot：只试首个；remaining：首轮成功后续跑", "pilot")
		.option(
			"--state-directory <path>",
			"持久状态、采样和报告目录",
			join(homedir(), ".cline/kanban/cross-task-handoff-artifacts/task-66679-rvf-resource-gated-dispatch"),
		)
		.option("--cpu-average-limit-percent <number>", "五分钟平均 CPU 上限", "80");
	command.parse();
	const args = command.opts<{
		taskWorktreePath: string[];
		mode: string;
		stateDirectory: string;
		cpuAverageLimitPercent: string;
	}>();
	const mode = z.enum(["pilot", "remaining"]).parse(args.mode);
	const cpuAverageLimitPercent = z.coerce.number().min(1).max(100).parse(args.cpuAverageLimitPercent);
	if (process.platform !== "darwin") throw new Error("本脚本的内存 pressure 采样当前仅支持 macOS。");
	await runRvfPromptScheduler({
		mode,
		taskWorktreePaths: args.taskWorktreePath,
		stateDirectory: resolve(args.stateDirectory),
		cpuAverageLimitPercent,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
