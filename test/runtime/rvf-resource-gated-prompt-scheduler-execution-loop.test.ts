import type * as FileSystemPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type * as OperatingSystem from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TRPCRequestOptions } from "@trpc/client";
import type { LockOptions } from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { runRvfPromptScheduler } from "../../scripts/dispatch-review-validate-fix-prompts-when-host-resources-allow";
import { retryCliRuntimeRequestWhileKanbanRuntimeRestarts } from "../../src/commands/cli-runtime-request-retry-while-kanban-runtime-restarts";
import type { RuntimeTaskChatSendRequest } from "../../src/core/api-contract";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";

const schedulerHarness = vi.hoisted(() => ({
	nowMs: 0,
	startedAtMs: 0,
	fixtureDirectory: "",
	mainProjectPath: "",
	transcriptPath: "",
	stateDirectory: "",
	taskWorktreePaths: [] as string[],
	sentRequests: [] as RuntimeTaskChatSendRequest[],
	sentAtMs: [] as number[],
	exclusiveLockCompromiseCallbacks: [] as Array<NonNullable<LockOptions["onCompromised"]>>,
	currentExclusiveLockHolderIndex: null as number | null,
	beforeTargetSessionQueryReturns: null as (() => Promise<void>) | null,
	beforeSchedulerArtifactWriteReturns: null as ((path: string, content: string) => Promise<void>) | null,
	beforeSendResponseReturns: null as ((signal?: AbortSignal) => Promise<void>) | null,
	beforeProjectListQueryReturns: null as (() => Promise<void>) | null,
	resourceSamplingTimerCallbacks: new Map<number, () => unknown>(),
	resourceSamplingTimerId: 0,
	runningTaskCountOverride: null as number | null,
	memoryPressureLevel: 1,
	cpuBusyPercent: 50,
	previousCpuTickReadAtMs: 0,
	accumulatedBusyCpuTicks: 0,
	accumulatedIdleCpuTicks: 0,
	runtimeSendRecoveryWaitMs: null as number | null,
	runtimeSendRpcInvocationCount: 0,
	runtimeSendTransportAttemptCount: 0,
	runtimeRequestDeadlineControllers: [] as Array<{ expiresAtMs: number; controller: AbortController }>,
}));

vi.mock("proper-lockfile", () => ({
	lock: async (_path: string, options: LockOptions) => {
		if (schedulerHarness.currentExclusiveLockHolderIndex !== null)
			throw Object.assign(new Error("隔离调度器锁已被占用。"), { code: "ELOCKED" });
		if (!options.onCompromised) throw new Error("隔离锁必须具有失锁通知回调。");
		const holderIndex = schedulerHarness.exclusiveLockCompromiseCallbacks.length;
		schedulerHarness.exclusiveLockCompromiseCallbacks.push(options.onCompromised);
		schedulerHarness.currentExclusiveLockHolderIndex = holderIndex;
		return async () => {
			if (schedulerHarness.currentExclusiveLockHolderIndex === holderIndex)
				schedulerHarness.currentExclusiveLockHolderIndex = null;
		};
	},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof FileSystemPromises>();
	return {
		...original,
		writeFile: async (...args: Parameters<typeof original.writeFile>) => {
			await original.writeFile(...args);
			if (typeof args[0] === "string" && typeof args[1] === "string")
				await schedulerHarness.beforeSchedulerArtifactWriteReturns?.(args[0], args[1]);
		},
	};
});

vi.mock("node:child_process", () => ({
	execFile: Object.assign(
		() => {
			throw new Error("隔离测试只允许 Promise 形式的命令读取。");
		},
		{
			[Symbol.for("nodejs.util.promisify.custom")]: async (file: string) => {
				if (file === "git") return { stdout: `${schedulerHarness.mainProjectPath}/.git\n`, stderr: "" };
				if (file === "/usr/sbin/sysctl") return { stdout: `${schedulerHarness.memoryPressureLevel}\n`, stderr: "" };
				throw new Error(`隔离测试不允许执行子进程：${file}`);
			},
		},
	),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof OperatingSystem>();
	return {
		...original,
		cpus: () => {
			const elapsedMs = schedulerHarness.nowMs - schedulerHarness.previousCpuTickReadAtMs;
			schedulerHarness.accumulatedBusyCpuTicks += elapsedMs * schedulerHarness.cpuBusyPercent;
			schedulerHarness.accumulatedIdleCpuTicks += elapsedMs * (100 - schedulerHarness.cpuBusyPercent);
			schedulerHarness.previousCpuTickReadAtMs = schedulerHarness.nowMs;
			return [
				{
					model: "isolated-cpu",
					speed: 1,
					times: {
						user: schedulerHarness.accumulatedBusyCpuTicks,
						idle: schedulerHarness.accumulatedIdleCpuTicks,
						nice: 0,
						sys: 0,
						irq: 0,
					},
				},
			];
		},
		loadavg: () => [20, 20, 20],
	};
});

vi.mock("../../src/commands/task", () => ({
	createRuntimeTrpcClient: () => ({
		projects: {
			list: {
				query: async () => {
					await schedulerHarness.beforeProjectListQueryReturns?.();
					return {
						projects: [
							{
								id: "isolated-project",
								path: schedulerHarness.mainProjectPath,
								crossProjectTaskSwitcherEntries: Array.from(
									{
										length:
											schedulerHarness.runningTaskCountOverride ??
											(schedulerHarness.nowMs - schedulerHarness.startedAtMs < 600_000 ? 8 : 7),
									},
									() => ({
										turnOwner: "agent",
										liveness: "live",
										isParkedAwaitingDispatchedBackgroundWork: false,
									}),
								),
							},
						],
					};
				},
			},
		},
		workspace: {
			getState: {
				query: async () => {
					await schedulerHarness.beforeTargetSessionQueryReturns?.();
					return {
						board: {
							columns: [
								{
									id: "review",
									cards: [
										{ id: "first-target", mainTaskConversationSessionId: "selected-main-conversation" },
										{ id: "second-target" },
									],
								},
							],
						},
						sessions: {
							"selected-main-conversation": createIsolatedTargetMainConversationSummary(0),
							"second-target": createIsolatedTargetMainConversationSummary(1),
						},
					};
				},
			},
		},
		runtime: {
			sendTaskChatMessage: {
				mutate: async (request: RuntimeTaskChatSendRequest, requestOptions?: TRPCRequestOptions) => {
					schedulerHarness.runtimeSendRpcInvocationCount += 1;
					const recoveryWaitMs = schedulerHarness.runtimeSendRecoveryWaitMs;
					if (recoveryWaitMs !== null) {
						await retryCliRuntimeRequestWhileKanbanRuntimeRestarts(
							async () => {
								// 模拟 fetch：已中止的信号不得再建立一次发送连接。
								requestOptions?.signal?.throwIfAborted();
								schedulerHarness.runtimeSendTransportAttemptCount += 1;
								if (schedulerHarness.runtimeSendTransportAttemptCount === 1)
									throw Object.assign(new Error("隔离模拟运行时连接拒绝。"), { code: "ECONNREFUSED" });
							},
							{
								readNowEpochMs: () => schedulerHarness.nowMs,
								sleep: async () => {
									await advanceSchedulerClockWhileIndependentResourceSamplingRuns(recoveryWaitMs);
								},
								writeStderr: () => {},
								readKanbanRuntimeRestartInProgressEvidence: async () => "隔离模拟运行时正在恢复。",
							},
						);
					}
					const targetIndex = schedulerHarness.taskWorktreePaths.indexOf(
						join(schedulerHarness.fixtureDirectory, "worktrees", request.taskId, "repo"),
					);
					if (targetIndex < 0) throw new Error("隔离测试收到未配置目标的发送请求。");
					const selectedSession = createIsolatedTargetMainConversationSummary(targetIndex);
					const selectedNativeIdentity = selectedSession.agentNativeConversationSessionIdentity;
					if (!selectedNativeIdentity?.transcriptPath) throw new Error("隔离主会话缺少转录路径。");
					expect(request.targetTaskConversationSessionId).toBe(selectedSession.taskId);
					const persisted = JSON.parse(
						await readFile(join(schedulerHarness.stateDirectory, "rvf-prompt-dispatch-state.json"), "utf8"),
					);
					expect(persisted.targets[targetIndex].status).toBe("send_intent_recorded");
					schedulerHarness.sentRequests.push(request);
					schedulerHarness.sentAtMs.push(schedulerHarness.nowMs);
					const rvfHome = join(schedulerHarness.fixtureDirectory, "isolated-rvf-home");
					const runDirectory = join(
						rvfHome,
						targetIndex === 0 ? "isolated-review-run" : "isolated-second-target-review-run",
					);
					const decisionToken = targetIndex === 0 ? "0123456789abcdef" : "fedcba9876543210";
					const reviewerDirectory = join(runDirectory, "artifacts/reviewers/isolated-reviewer");
					for (const directory of ["agentic-initiation-decision-tokens", "agentic-initiation-scope-adjustments"])
						await mkdir(join(rvfHome, directory), { recursive: true });
					await mkdir(reviewerDirectory, { recursive: true });
					await writeFile(
						selectedNativeIdentity.transcriptPath,
						`${JSON.stringify({ timestamp: new Date(schedulerHarness.nowMs).toISOString(), type: "event_msg", payload: { type: "user_message", message: request.text } })}\n`,
					);
					await writeFile(
						join(rvfHome, "agentic-initiation-decision-tokens", `${decisionToken}.json`),
						JSON.stringify({
							token: decisionToken,
							worktree: schedulerHarness.taskWorktreePaths[targetIndex],
							session_id: selectedNativeIdentity.nativeSessionId,
							created_at: new Date(schedulerHarness.nowMs).toISOString(),
							state: "dispatched",
							initiated_by_explicit_user_request: true,
						}),
					);
					await writeFile(
						join(rvfHome, "agentic-initiation-scope-adjustments", `${decisionToken}.json`),
						JSON.stringify({ run_dir: runDirectory }),
					);
					await writeFile(
						join(runDirectory, "summary.json"),
						JSON.stringify({ repo: schedulerHarness.taskWorktreePaths[targetIndex] }),
					);
					await writeFile(
						join(runDirectory, "artifacts/reviewers/reviewer-plan.json"),
						JSON.stringify({ reviewers: [{ reviewer_id: "isolated-reviewer" }] }),
					);
					await writeFile(join(reviewerDirectory, "reviewer.stdout.txt"), '{"type":"system","subtype":"init"}\n');
					await schedulerHarness.beforeSendResponseReturns?.(requestOptions?.signal);
					return { ok: true };
				},
			},
		},
	}),
}));

function createIsolatedTargetMainConversationSummary(targetIndex: number) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: targetIndex === 0 ? "selected-main-conversation" : "second-target",
		state: "awaiting_review",
		agentId: "codex",
		workspacePath: schedulerHarness.taskWorktreePaths[targetIndex],
		pid: 123 + targetIndex,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		lastHookAt: 1,
		reviewReason: "attention",
		exitCode: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "needs_input",
		runtimeSessionIncarnationId: targetIndex === 0 ? "isolated-incarnation" : "isolated-second-target-incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: targetIndex === 0 ? "isolated-native-session" : "isolated-second-target-native-session",
			transcriptPath:
				targetIndex === 0
					? schedulerHarness.transcriptPath
					: join(schedulerHarness.fixtureDirectory, "second-target-native-conversation.jsonl"),
			observedAt: 1,
		},
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	if (schedulerHarness.fixtureDirectory) await rm(schedulerHarness.fixtureDirectory, { recursive: true, force: true });
});

async function createSchedulerExecutionLoopFixture() {
	schedulerHarness.fixtureDirectory = await realpath(
		await mkdtemp(join(tmpdir(), "kanban-rvf-scheduler-execution-loop-")),
	);
	schedulerHarness.mainProjectPath = join(schedulerHarness.fixtureDirectory, "main-repository");
	schedulerHarness.transcriptPath = join(schedulerHarness.fixtureDirectory, "native-conversation.jsonl");
	schedulerHarness.stateDirectory = join(schedulerHarness.fixtureDirectory, "persistent-scheduler-state");
	schedulerHarness.taskWorktreePaths = ["first-target", "second-target"].map((taskId) =>
		join(schedulerHarness.fixtureDirectory, "worktrees", taskId, "repo"),
	);
	await Promise.all(schedulerHarness.taskWorktreePaths.map((path) => mkdir(path, { recursive: true })));
	await writeFile(schedulerHarness.transcriptPath, "");
	await writeFile(join(schedulerHarness.fixtureDirectory, "second-target-native-conversation.jsonl"), "");
	schedulerHarness.startedAtMs = Date.now() - 3_600_000;
	schedulerHarness.nowMs = schedulerHarness.startedAtMs;
	schedulerHarness.sentRequests = [];
	schedulerHarness.sentAtMs = [];
	schedulerHarness.exclusiveLockCompromiseCallbacks = [];
	schedulerHarness.currentExclusiveLockHolderIndex = null;
	schedulerHarness.beforeTargetSessionQueryReturns = null;
	schedulerHarness.beforeSchedulerArtifactWriteReturns = null;
	schedulerHarness.beforeSendResponseReturns = null;
	schedulerHarness.beforeProjectListQueryReturns = null;
	schedulerHarness.resourceSamplingTimerCallbacks.clear();
	schedulerHarness.resourceSamplingTimerId = 0;
	schedulerHarness.runningTaskCountOverride = null;
	schedulerHarness.memoryPressureLevel = 1;
	schedulerHarness.cpuBusyPercent = 50;
	schedulerHarness.previousCpuTickReadAtMs = schedulerHarness.nowMs;
	schedulerHarness.accumulatedBusyCpuTicks = 0;
	schedulerHarness.accumulatedIdleCpuTicks = 0;
	schedulerHarness.runtimeSendRecoveryWaitMs = null;
	schedulerHarness.runtimeSendRpcInvocationCount = 0;
	schedulerHarness.runtimeSendTransportAttemptCount = 0;
	schedulerHarness.runtimeRequestDeadlineControllers = [];
	vi.stubEnv("RVF_HOME", join(schedulerHarness.fixtureDirectory, "isolated-rvf-home"));
	vi.spyOn(Date, "now").mockImplementation(() => schedulerHarness.nowMs);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		const controller = new AbortController();
		schedulerHarness.runtimeRequestDeadlineControllers.push({
			expiresAtMs: schedulerHarness.nowMs + milliseconds,
			controller,
		});
		return controller.signal;
	});
	const originalSetTimeout = setTimeout;
	vi.stubGlobal("setInterval", (callback: () => unknown, milliseconds: number) => {
		expect(milliseconds).toBe(10_000);
		const timerId = ++schedulerHarness.resourceSamplingTimerId;
		schedulerHarness.resourceSamplingTimerCallbacks.set(timerId, callback);
		return timerId;
	});
	vi.stubGlobal("clearInterval", (timerId: number) => {
		schedulerHarness.resourceSamplingTimerCallbacks.delete(timerId);
	});
	vi.stubGlobal("setTimeout", (callback: () => void, milliseconds: number) => {
		if (milliseconds === 10_000) {
			void advanceSchedulerClockWhileIndependentResourceSamplingRuns(milliseconds).then(callback);
			return originalSetTimeout(() => {}, 0);
		}
		return originalSetTimeout(callback, milliseconds);
	});
	return {
		mode: "pilot" as const,
		taskWorktreePaths: schedulerHarness.taskWorktreePaths,
		stateDirectory: schedulerHarness.stateDirectory,
		cpuAverageLimitPercent: 80,
	};
}

async function advanceSchedulerClockWhileIndependentResourceSamplingRuns(durationMs: number) {
	for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += 10_000) {
		schedulerHarness.nowMs += 10_000;
		for (const deadline of schedulerHarness.runtimeRequestDeadlineControllers)
			if (schedulerHarness.nowMs >= deadline.expiresAtMs)
				deadline.controller.abort(new DOMException("隔离发送 RPC 的资源证据截止已到。", "TimeoutError"));
		for (const callback of schedulerHarness.resourceSamplingTimerCallbacks.values()) await callback();
	}
}

async function readSchedulerExecutionEvents() {
	return (
		await readFile(join(schedulerHarness.stateDirectory, "host-resources-and-rvf-dispatch-events.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

it("运行真实调度循环：首个五分钟 Running=8 跳过，下个五分钟只发首个，读盘续跑不重发", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	await runRvfPromptScheduler(options);
	expect(schedulerHarness.sentRequests).toEqual([
		{
			taskId: "first-target",
			targetTaskConversationSessionId: "selected-main-conversation",
			text: "$review-validate-fix",
		},
	]);
	expect(schedulerHarness.sentAtMs).toEqual([schedulerHarness.startedAtMs + 600_000]);
	const persisted = JSON.parse(
		await readFile(join(schedulerHarness.stateDirectory, "rvf-prompt-dispatch-state.json"), "utf8"),
	);
	expect(persisted.targets[0].stopReason).toBeNull();
	expect(persisted.targets.map((target: { status: string }) => target.status)).toEqual([
		"reviewers_started",
		"not_sent",
	]);
	const events = (
		await readFile(join(schedulerHarness.stateDirectory, "host-resources-and-rvf-dispatch-events.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(
		events.filter((event) => event.kind === "dispatch_gate_checked").map((event) => event.detail.allowed),
	).toEqual([false, true]);
	await runRvfPromptScheduler(options);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
});

it.each(["initial_state_write", "target_session_query", "send_intent_write", "send_response"])(
	"%s 异步等待期间失锁后，新实例接管只发送一次，旧实例不覆盖任何共享记录",
	async (compromiseBoundary) => {
		const options = await createSchedulerExecutionLoopFixture();
		let signalOldLockHolderReachedBoundary = () => {};
		const oldLockHolderReachedBoundary = new Promise<void>((resolve) => {
			signalOldLockHolderReachedBoundary = resolve;
		});
		let resumeOldLockHolder = () => {};
		const oldLockHolderMayResume = new Promise<void>((resolve) => {
			resumeOldLockHolder = resolve;
		});
		const pauseOldLockHolder = async () => {
			signalOldLockHolderReachedBoundary();
			await oldLockHolderMayResume;
		};
		if (compromiseBoundary === "target_session_query")
			schedulerHarness.beforeTargetSessionQueryReturns = pauseOldLockHolder;
		else if (compromiseBoundary === "send_response") schedulerHarness.beforeSendResponseReturns = pauseOldLockHolder;
		else
			schedulerHarness.beforeSchedulerArtifactWriteReturns = async (path, content) => {
				const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
				if (!path.startsWith(`${statePath}.`)) return;
				const expectedStatus = compromiseBoundary === "initial_state_write" ? "not_sent" : "send_intent_recorded";
				if (JSON.parse(content).targets[0].status === expectedStatus) await pauseOldLockHolder();
			};
		const oldSchedulerResult = runRvfPromptScheduler(options).then(
			() => null,
			(error: unknown) => error,
		);
		try {
			await oldLockHolderReachedBoundary;
			schedulerHarness.currentExclusiveLockHolderIndex = null;
			schedulerHarness.exclusiveLockCompromiseCallbacks[0](new Error("隔离注入：独占锁已被新实例接管。"));
			schedulerHarness.beforeTargetSessionQueryReturns = null;
			schedulerHarness.beforeSchedulerArtifactWriteReturns = null;
			schedulerHarness.beforeSendResponseReturns = null;
			await runRvfPromptScheduler(options);
			const artifactPaths = [
				"rvf-prompt-dispatch-state.json",
				"host-resources-and-rvf-dispatch-events.jsonl",
				"rvf-prompt-trigger-observation-report.md",
			].map((name) => join(options.stateDirectory, name));
			const newHolderArtifactContents = await Promise.all(artifactPaths.map((path) => readFile(path, "utf8")));
			expect(JSON.parse(newHolderArtifactContents[0]).targets[0].status).toBe("reviewers_started");
			expect(schedulerHarness.sentRequests).toHaveLength(1);
			resumeOldLockHolder();
			const oldSchedulerError = await oldSchedulerResult;
			expect(schedulerHarness.sentRequests).toHaveLength(1);
			expect(await Promise.all(artifactPaths.map((path) => readFile(path, "utf8")))).toEqual(
				newHolderArtifactContents,
			);
			expect(oldSchedulerError).toEqual(expect.objectContaining({ message: expect.stringContaining("独占锁") }));
		} finally {
			resumeOldLockHolder();
			await oldSchedulerResult;
		}
	},
);

it.each(["target_session_query", "send_intent_write"])(
	"%s 延迟六十秒后不会依据旧快照发送",
	async (preparationBoundary) => {
		const options = await createSchedulerExecutionLoopFixture();
		const delayPreparationAndStopAfterThisOpportunity = async () => {
			await advanceSchedulerClockWhileIndependentResourceSamplingRuns(60_000);
			process.emit("SIGTERM");
		};
		if (preparationBoundary === "target_session_query")
			schedulerHarness.beforeTargetSessionQueryReturns = delayPreparationAndStopAfterThisOpportunity;
		else
			schedulerHarness.beforeSchedulerArtifactWriteReturns = async (path, content) => {
				if (
					path.startsWith(`${join(options.stateDirectory, "rvf-prompt-dispatch-state.json")}.`) &&
					JSON.parse(content).targets[0].status === "send_intent_recorded"
				)
					await delayPreparationAndStopAfterThisOpportunity();
			};
		await runRvfPromptScheduler(options);
		expect(schedulerHarness.sentRequests).toHaveLength(0);
		const persisted = JSON.parse(
			await readFile(join(options.stateDirectory, "rvf-prompt-dispatch-state.json"), "utf8"),
		);
		expect(persisted.targets[0].status).toBe("not_sent");
		expect(persisted.targets[0].sendRequestedAtMs).toBeNull();
		expect(
			(await readSchedulerExecutionEvents()).find((event) => event.kind === "prepared_dispatch_gate_rejected")
				?.detail.reason,
		).toContain("过期");
	},
);

it.each(["running_task_count", "memory_pressure", "cpu_average"])(
	"准备期间 %s 恶化后重新检查并阻止发送",
	async (resourceBoundary) => {
		const options = await createSchedulerExecutionLoopFixture();
		if (resourceBoundary === "cpu_average") schedulerHarness.cpuBusyPercent = 80;
		schedulerHarness.beforeTargetSessionQueryReturns = async () => {
			if (resourceBoundary === "running_task_count") schedulerHarness.runningTaskCountOverride = 8;
			if (resourceBoundary === "memory_pressure") schedulerHarness.memoryPressureLevel = 2;
			if (resourceBoundary === "cpu_average") schedulerHarness.cpuBusyPercent = 100;
			await advanceSchedulerClockWhileIndependentResourceSamplingRuns(10_000);
			process.emit("SIGTERM");
		};
		await runRvfPromptScheduler(options);
		expect(schedulerHarness.sentRequests).toHaveLength(0);
		const expectedReason =
			resourceBoundary === "running_task_count"
				? "Running"
				: resourceBoundary === "memory_pressure"
					? "pressure"
					: "CPU";
		expect(
			(await readSchedulerExecutionEvents()).find((event) => event.kind === "prepared_dispatch_gate_rejected")
				?.detail.reason,
		).toContain(expectedReason);
	},
);

it("观察会话与转录等待六十秒时，资源采样仍每十秒推进且不会生成超长采样", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	let slowObservationStartedAtMs = 0;
	schedulerHarness.beforeTargetSessionQueryReturns = async () => {
		if (!schedulerHarness.sentRequests.length) return;
		slowObservationStartedAtMs = schedulerHarness.nowMs;
		await advanceSchedulerClockWhileIndependentResourceSamplingRuns(60_000);
	};
	await runRvfPromptScheduler(options);
	const samples = (await readSchedulerExecutionEvents())
		.filter((event) => event.kind === "resource_sample")
		.map((event) => event.detail);
	expect(samples.filter((sample) => sample.startedAtMs >= slowObservationStartedAtMs)).toHaveLength(6);
	expect(samples.every((sample) => sample.endedAtMs - sample.startedAtMs === 10_000)).toBe(true);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
	expect(schedulerHarness.resourceSamplingTimerCallbacks.size).toBe(0);
});

it("准备过期后跳过本轮，只在下一个五分钟机会发送，不增加高频补发", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	let preparationAttemptCount = 0;
	schedulerHarness.beforeTargetSessionQueryReturns = async () => {
		if (schedulerHarness.sentRequests.length) return;
		preparationAttemptCount += 1;
		if (preparationAttemptCount === 1) await advanceSchedulerClockWhileIndependentResourceSamplingRuns(60_000);
	};
	await runRvfPromptScheduler(options);
	expect(preparationAttemptCount).toBe(2);
	expect(schedulerHarness.sentAtMs).toEqual([schedulerHarness.startedAtMs + 900_000]);
	expect(
		(await readSchedulerExecutionEvents()).filter((event) => event.kind === "dispatch_gate_checked"),
	).toHaveLength(3);
});

it("发送前 Running 重验本身等待六十秒时拒绝发送，采样仍连续", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	let targetPreparationWasObserved = false;
	schedulerHarness.beforeTargetSessionQueryReturns = async () => {
		targetPreparationWasObserved = true;
	};
	schedulerHarness.beforeProjectListQueryReturns = async () => {
		if (!targetPreparationWasObserved) return;
		await advanceSchedulerClockWhileIndependentResourceSamplingRuns(60_000);
		process.emit("SIGTERM");
	};
	await runRvfPromptScheduler(options);
	expect(schedulerHarness.sentRequests).toHaveLength(0);
	const events = await readSchedulerExecutionEvents();
	expect(events.find((event) => event.kind === "prepared_dispatch_gate_rejected")?.detail.reason).toContain("过期");
	expect(
		events
			.filter((event) => event.kind === "resource_sample")
			.every((event) => event.detail.endedAtMs - event.detail.startedAtMs === 10_000),
	).toBe(true);
});

it("pilot 已完成且目录被清理后，幂等重启保持原状态且不会重新发送", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	await runRvfPromptScheduler(options);
	const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
	const completedPilotState = await readFile(statePath, "utf8");
	await rm(options.taskWorktreePaths[0], { recursive: true });
	await runRvfPromptScheduler(options);
	expect(await readFile(statePath, "utf8")).toBe(completedPilotState);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
});

it("pilot 目录清理后 remaining 仍只发送剩余目标，全部完成并清理后也能幂等重启", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	await runRvfPromptScheduler(options);
	await rm(options.taskWorktreePaths[0], { recursive: true });
	await runRvfPromptScheduler({ ...options, mode: "remaining" });
	expect(schedulerHarness.sentRequests.map((request) => request.taskId)).toEqual(["first-target", "second-target"]);
	const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
	const completedState = await readFile(statePath, "utf8");
	expect(JSON.parse(completedState).targets.map((target: { status: string }) => target.status)).toEqual([
		"reviewers_started",
		"reviewers_started",
	]);
	await rm(options.taskWorktreePaths[1], { recursive: true });
	await runRvfPromptScheduler({ ...options, mode: "remaining" });
	expect(await readFile(statePath, "utf8")).toBe(completedState);
	expect(schedulerHarness.sentRequests).toHaveLength(2);
});

it("未完成目标目录缺失时仍拒绝 remaining，且不改持久发送记录", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	await runRvfPromptScheduler(options);
	const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
	const pilotState = await readFile(statePath, "utf8");
	await rm(options.taskWorktreePaths[1], { recursive: true });
	await expect(runRvfPromptScheduler({ ...options, mode: "remaining" })).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(statePath, "utf8")).toBe(pilotState);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
});

it.each(["target_order", "target_count", "cpu_limit"])(
	"恢复时 %s 改动仍被拒绝，且不重投或覆写记录",
	async (configurationChange) => {
		const options = await createSchedulerExecutionLoopFixture();
		await runRvfPromptScheduler(options);
		const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
		const pilotState = await readFile(statePath, "utf8");
		const changedOptions = { ...options, mode: "remaining" as const };
		if (configurationChange === "target_order")
			changedOptions.taskWorktreePaths = [...options.taskWorktreePaths].reverse();
		if (configurationChange === "target_count") changedOptions.taskWorktreePaths = options.taskWorktreePaths.slice(1);
		if (configurationChange === "cpu_limit") changedOptions.cpuAverageLimitPercent = 75;
		await expect(runRvfPromptScheduler(changedOptions)).rejects.toThrow("目标顺序或 CPU 门槛");
		expect(await readFile(statePath, "utf8")).toBe(pilotState);
		expect(schedulerHarness.sentRequests).toHaveLength(1);
	},
);

it.each([
	{ preparationDelayMs: 0, recoveryWaitMs: 60_000, remainingEvidenceMs: 15_000 },
	{ preparationDelayMs: 10_000, recoveryWaitMs: 10_000, remainingEvidenceMs: 5_000 },
])(
	"RPC 内部恢复等待 $recoveryWaitMs 毫秒时受剩余 $remainingEvidenceMs 毫秒约束，不晚发且保留未知",
	async ({ preparationDelayMs, recoveryWaitMs, remainingEvidenceMs }) => {
		const options = await createSchedulerExecutionLoopFixture();
		schedulerHarness.runtimeSendRecoveryWaitMs = recoveryWaitMs;
		if (preparationDelayMs)
			schedulerHarness.beforeTargetSessionQueryReturns = async () => {
				await advanceSchedulerClockWhileIndependentResourceSamplingRuns(preparationDelayMs);
			};
		const schedulerResult = await runRvfPromptScheduler(options).then(
			() => null,
			(error: unknown) => error,
		);
		expect(schedulerHarness.runtimeSendRpcInvocationCount).toBe(1);
		expect(schedulerHarness.sentRequests).toHaveLength(0);
		expect(schedulerHarness.runtimeSendTransportAttemptCount).toBe(1);
		expect(AbortSignal.timeout).toHaveBeenCalledWith(remainingEvidenceMs);
		const statePath = join(options.stateDirectory, "rvf-prompt-dispatch-state.json");
		const persisted = JSON.parse(await readFile(statePath, "utf8"));
		expect(persisted.targets[0].status).toBe("outcome_unknown");
		expect(persisted.targets[0].sendRequestedAtMs).not.toBeNull();
		expect(schedulerResult).toEqual(expect.objectContaining({ message: expect.stringContaining("不会自动重投") }));
		await expect(runRvfPromptScheduler(options)).rejects.toThrow("不会自动重投");
		expect(schedulerHarness.runtimeSendRpcInvocationCount).toBe(1);
	},
);

it("RPC 已发送后响应等待越过资源证据截止，保留未知且重启不重投", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	schedulerHarness.beforeSendResponseReturns = async (signal) => {
		await advanceSchedulerClockWhileIndependentResourceSamplingRuns(60_000);
		signal?.throwIfAborted();
	};
	const schedulerResult = await runRvfPromptScheduler(options).then(
		() => null,
		(error: unknown) => error,
	);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
	const persisted = JSON.parse(await readFile(join(options.stateDirectory, "rvf-prompt-dispatch-state.json"), "utf8"));
	expect(persisted.targets[0].status).toBe("outcome_unknown");
	expect(schedulerResult).toEqual(expect.objectContaining({ message: expect.stringContaining("不会自动重投") }));
	await expect(runRvfPromptScheduler(options)).rejects.toThrow("不会自动重投");
	expect(schedulerHarness.sentRequests).toHaveLength(1);
});

it("RPC 内部恢复在证据截止前完成时允许唯一发送", async () => {
	const options = await createSchedulerExecutionLoopFixture();
	schedulerHarness.runtimeSendRecoveryWaitMs = 10_000;
	await runRvfPromptScheduler(options);
	expect(schedulerHarness.runtimeSendTransportAttemptCount).toBe(2);
	expect(schedulerHarness.sentAtMs).toEqual([schedulerHarness.startedAtMs + 610_000]);
	expect(schedulerHarness.sentRequests).toHaveLength(1);
});
