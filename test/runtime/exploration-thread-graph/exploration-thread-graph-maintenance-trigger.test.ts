import { createHash, randomUUID } from "node:crypto";
import fsPromises, { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
	ExplorationThreadGraphMaintenanceProposal,
	ForkedWorkBranchResult,
	RunExplorationThreadGraphMaintenanceJobInput,
	RunExplorationThreadGraphMaintenanceJobResult,
} from "agent-conversation-exploration-thread-graph/core";
import {
	createEmptyExplorationThreadGraphCollection,
	mutateExplorationThreadGraph,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
	resolveExplorationThreadGraphCollectionPath,
	resolveExplorationTopicRegistryPath,
	runExplorationThreadGraphMaintenanceJob,
} from "agent-conversation-exploration-thread-graph/core";
import type * as nativeProcesses from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimeTaskSessionSummary,
	runtimeExplorationThreadGraphProjectionViewSchema,
} from "../../../src/core/api-contract";
import { createExplorationThreadGraphMaintenanceTrigger } from "../../../src/exploration-thread-graph/exploration-thread-graph-maintenance-trigger";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import {
	createSessionOwnedBackgroundAgentExecutor,
	hasSessionOwnedBackgroundAgentExecutionRequiringRetention,
	requestSessionOwnedBackgroundAgentExecutionCancellation,
} from "../../../src/state/session-owned-background-agent-executions";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

// 核心作业与 store 使用真实安装产物；这里只隔离原生进程查询，单测不启动或清理宿主进程。
vi.mock("agent-conversation-exploration-thread-graph/harness-claude-code", async (importOriginal) => ({
	...(await importOriginal<typeof nativeProcesses>()),
	readNativeSystemBootIdentity: async () => "isolated-boot-generation",
	readNativeProcessOwnershipSnapshot: async () =>
		new Map([
			[
				process.pid,
				{
					processPid: process.pid,
					parentProcessPid: 1,
					processGroupId: 1,
					startIdentity: `${process.pid} Thu Oct 29 00:00:00 2026`,
				},
			],
		]),
	observeExecutionOwnedProcesses: async () => ({ ownedStartIdentities: new Map(), hasUnprovenOrphanOwnership: false }),
}));

let isolatedHome: ReturnType<typeof createTempDir>;
beforeEach(() => {
	isolatedHome = createTempDir("exploration-maintenance-cancellation-home-");
	vi.stubEnv("HOME", isolatedHome.path);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	isolatedHome.cleanup();
});

// 四道闸各挡一次钱：模式闸 / 防抖闸 / 单飞闸 / 节流闸。任何一道漏掉，重型会话上就是每 turn ≈ $4.5。
// 四道闸使用注入的 turn 源与 runner；取消回归使用真实核心作业和隔离文件 store。
// 全部 HOME 隔离，不启动原生进程；真实安装导出另由无 mock 套件核验。

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "exploration-1",
		state: "idle",
		agentId: "claude",
		workspacePath: "/repo",
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		taskConversationMode: "exploratory",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId: "native-session-1",
			transcriptPath: "/transcripts/native-session-1.jsonl",
			observedAt: 1_000,
		},
		agentSessionForkReplayLaunchArguments: {
			sourceAgentId: "claude",
			modelArgumentLiteral: "default",
			appendSystemPromptText: "exploratory",
			settingsFilePath: "/settings.json",
			capturedAt: 900,
		},
		...overrides,
	};
}

function makeTurnSource(turnNumbers: readonly number[]): CompletedTurnSequenceSource {
	return {
		readCompletedTurnSequence: async (
			sessionRef: ConversationSessionRef,
		): Promise<CompletedTurnSequenceSnapshot> => ({
			conversationSessionId: sessionRef.nativeSessionId,
			sourceKind: "claude_code_transcript",
			turns: turnNumbers.map((turnNumber) => ({
				turnNumber,
				userPromptExcerpt: `prompt ${turnNumber}`,
				assistantResponseExcerpt: `response ${turnNumber}`,
				startedAt: new Date(turnNumber * 1_000).toISOString(),
				endedAt: new Date(turnNumber * 1_000 + 500).toISOString(),
				userMessageOrigin: "human_typed",
				toolCallCount: 0,
			})),
			sourceSignature: `signature-${turnNumbers.length}`,
			projectionConfidence: "transcript_reconstructed",
			inProgressTurnNumber: null,
		}),
	};
}

const ACCEPTED_JOB_RESULT: RunExplorationThreadGraphMaintenanceJobResult = {
	outcome: "accepted",
	placedTurnCount: 3,
	remainingTurnCount: 0,
	usage: null,
};

function createDeferredBarrier() {
	let release: () => void = () => {};
	const reached = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { reached, release };
}

const maintenanceProposal: ExplorationThreadGraphMaintenanceProposal = {
	placements: [
		{
			turnRef: { conversationSessionId: "native-session-1", turnNumber: 1, turnCheckpointCommit: null },
			threadId: "proposed-thread",
			placementConfidence: "high",
			deviationRationale: null,
		},
	],
	newThreads: [
		{
			temporaryThreadId: "proposed-thread",
			threadTitle: "消费兼容",
			parentThreadId: null,
			forkedFromTurnRef: null,
			primaryTopicId: "proposed-topic",
		},
	],
	topicProposals: [
		{
			temporaryTopicId: "proposed-topic",
			topicTitle: "消费兼容",
			topicAliases: [],
			topicSummaryMarkdown: null,
		},
	],
	threadRevisions: [],
	edges: [],
	eventMarks: [],
	subjectTaggings: [],
};

async function createRealMaintenanceJobHarness(
	options: { pauseAtTurnReadNumber?: 2 | 3; changedApplySignature?: boolean } = {},
) {
	const workspaceId = "maintenance-cancellation-workspace";
	const explorationId = "exploration-1";
	const storeRoot = join(isolatedHome.path, "graph-store");
	await mutateExplorationThreadGraph(storeRoot, explorationId, async (snapshot) => snapshot, 1_000);
	const forkReturned = createDeferredBarrier();
	const blockedTurnReadReached = createDeferredBarrier();
	const releaseBlockedTurnRead = createDeferredBarrier();
	let turnReads = 0;
	let jobSignal: AbortSignal | undefined;
	const turnSource: CompletedTurnSequenceSource = {
		readCompletedTurnSequence: async (sessionRef) => {
			turnReads += 1;
			// 前两次分别是宿主廉价投影和核心作业入场；第三次已在真实 store 写锁内。
			if (turnReads === options.pauseAtTurnReadNumber) {
				blockedTurnReadReached.release();
				await releaseBlockedTurnRead.reached;
			}
			const snapshot = await makeTurnSource([1]).readCompletedTurnSequence(sessionRef);
			return options.changedApplySignature && turnReads === 3
				? { ...snapshot, sourceSignature: "changed-before-apply" }
				: snapshot;
		},
	};
	const onUpdated = vi.fn();
	const relayFindingCandidates = vi.fn();
	const trigger = createExplorationThreadGraphMaintenanceTrigger({
		listWorkspaceSessionSummaries: () => [makeSummary()],
		onExplorationThreadGraphUpdated: onUpdated,
		relayFindingCandidates,
		resolveStoreRoot: () => storeRoot,
		createStopEdgeTurnSource: () => turnSource,
		createInProgressSafeTurnSource: () => turnSource,
		createForkedWorkBranchExecutor: () => ({
			start: async (input) => {
				await input.beforeProcessSpawn?.();
				return { stopReason: "completed", outputText: "真实核心消费的受控提案", structured: maintenanceProposal };
			},
		}),
		runMaintenanceJob: async (input) => {
			jobSignal = input.signal;
			return await runExplorationThreadGraphMaintenanceJob({
				...input,
				executor: {
					start: async (request): Promise<ForkedWorkBranchResult> => {
						const result = await input.executor.start(request);
						forkReturned.release();
						return result;
					},
				},
			});
		},
	});
	const readGraphAndTopicBytes = async () =>
		await Promise.all([
			readFile(resolveExplorationThreadGraphCollectionPath(storeRoot, explorationId), "utf8"),
			readFile(resolveExplorationTopicRegistryPath(storeRoot), "utf8"),
		]);
	return {
		workspaceId,
		explorationId,
		storeRoot,
		trigger,
		onUpdated,
		relayFindingCandidates,
		forkReturned,
		blockedTurnReadReached,
		releaseBlockedTurnRead,
		readGraphAndTopicBytes,
		jobSignal: () => jobSignal,
		start: async () => await trigger.requestImmediateMaintenance({ workspaceId, explorationId }),
	};
}

async function createTriggerHarness(
	options: {
		summaries?: RuntimeTaskSessionSummary[];
		completedTurnNumbers?: readonly number[];
		jobResult?: RunExplorationThreadGraphMaintenanceJobResult;
		// 预置一份「已经维护过」的 collection。节流闸只有在 lastMaintenanceJobCompletedAt 非 null 时
		// 才拦得住人（首次 backfill 不受阈值约束），所以「未攒够阈值」这个状态必须先落盘才造得出来。
		alreadyMaintainedWithLastPlacedTurnNumberBySession?: Record<string, number>;
	} = {},
) {
	const storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-trigger-"));
	const graphStoreRoot = join(storeRoot, "graph");
	if (options.alreadyMaintainedWithLastPlacedTurnNumberBySession) {
		const collectionPath = resolveExplorationThreadGraphCollectionPath(graphStoreRoot, "exploration-1");
		await mkdir(dirname(collectionPath), { recursive: true });
		await writeFile(
			collectionPath,
			JSON.stringify({
				...createEmptyExplorationThreadGraphCollection("exploration-1", 1_000),
				lastPlacedTurnNumberBySession: options.alreadyMaintainedWithLastPlacedTurnNumberBySession,
				lastMaintenanceJobCompletedAt: 1_000,
			}),
			"utf8",
		);
	}
	const runMaintenanceJob = vi.fn(
		async (
			_input: RunExplorationThreadGraphMaintenanceJobInput,
		): Promise<RunExplorationThreadGraphMaintenanceJobResult> => options.jobResult ?? ACCEPTED_JOB_RESULT,
	);
	const onExplorationThreadGraphUpdated = vi.fn();
	const scheduledDebounceCallbacks: (() => void)[] = [];
	// 读 turn 序列是「廉价判定」的最后一步，紧挨着节流判定：自动触发被拦下时它照样被调用过一次，
	// 所以它是「这一轮判定确实跑到了闸前」的可观测锚点（否则负向断言会在异步跑起来之前就通过）。
	const readCompletedTurnSequence = vi.fn(
		makeTurnSource(options.completedTurnNumbers ?? [1, 2, 3]).readCompletedTurnSequence,
	);
	const turnSource: CompletedTurnSequenceSource = { readCompletedTurnSequence };

	const trigger = createExplorationThreadGraphMaintenanceTrigger({
		listWorkspaceSessionSummaries: () => options.summaries ?? [makeSummary()],
		onExplorationThreadGraphUpdated,
		resolveStoreRoot: () => graphStoreRoot,
		runMaintenanceJob,
		createStopEdgeTurnSource: () => turnSource,
		createInProgressSafeTurnSource: () => turnSource,
		createForkedWorkBranchExecutor: () => ({
			start: async () => {
				throw new Error("单测绝不真的 fork");
			},
		}),
		scheduleDebounced: (callback) => {
			scheduledDebounceCallbacks.push(callback);
			return { cancel: () => {} };
		},
	});

	return {
		trigger,
		runMaintenanceJob,
		onExplorationThreadGraphUpdated,
		scheduledDebounceCallbacks,
		readCompletedTurnSequence,
	};
}

describe("createExplorationThreadGraphMaintenanceTrigger", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("真实核心作业在未取消时写入 graph/topic 并广播", async () => {
		const harness = await createRealMaintenanceJobHarness();
		expect(await harness.start()).toMatchObject({
			kind: "completed",
			result: { outcome: "accepted", placedTurnCount: 1 },
		});
		expect(
			(await readExplorationThreadGraphCollection(harness.storeRoot, harness.explorationId)).turnThreadPlacements,
		).toHaveLength(1);
		expect((await readExplorationTopicRegistry(harness.storeRoot)).topics).toHaveLength(1);
		expect(harness.onUpdated).toHaveBeenCalledTimes(1);
		expect(
			runtimeExplorationThreadGraphProjectionViewSchema.safeParse(harness.onUpdated.mock.calls[0]?.[2]).success,
		).toBe(true);
	});

	it("核心作业入场读转录期间 Stop，尚未调用 executor 也不能继续派发或落盘", async () => {
		const harness = await createRealMaintenanceJobHarness({ pauseAtTurnReadNumber: 2 });
		const originalBytes = await harness.readGraphAndTopicBytes();
		const pending = harness.start();
		try {
			await harness.blockedTurnReadReached.reached;
			const cancellation = await requestSessionOwnedBackgroundAgentExecutionCancellation({
				workspaceId: harness.workspaceId,
				taskId: harness.explorationId,
			});
			expect(harness.jobSignal()?.aborted).toBe(true);
			harness.releaseBlockedTurnRead.release();
			expect(await pending).toMatchObject({
				kind: "completed",
				result: { outcome: "fork_failed", stopReason: "cancelled" },
			});
			await cancellation.processCancellationConfirmationCompleted;
			expect(await harness.readGraphAndTopicBytes()).toEqual(originalBytes);
			const directory = join(
				getWorkspaceDirectoryPath(harness.workspaceId),
				"session-owned-background-agent-executions",
			);
			const filename = (await readdir(directory)).find((name) => name.endsWith(".execution.json"));
			expect(JSON.parse(await readFile(join(directory, filename ?? "missing"), "utf8"))).toMatchObject({
				launchState: "not_started",
				status: "finished",
			});
		} finally {
			harness.releaseBlockedTurnRead.release();
			await pending;
			harness.trigger.dispose();
		}
	});

	it("fork 已返回后等真实 store 锁，显式 Stop 仍立即取消且不写 graph/topic", async () => {
		const harness = await createRealMaintenanceJobHarness();
		const originalBytes = await harness.readGraphAndTopicBytes();
		const lockEntered = createDeferredBarrier();
		const releaseLock = createDeferredBarrier();
		const heldLock = mutateExplorationThreadGraph(harness.storeRoot, harness.explorationId, async () => {
			lockEntered.release();
			await releaseLock.reached;
			return null;
		});
		await lockEntered.reached;
		const pending = harness.start();
		try {
			await harness.forkReturned.reached;
			const directory = join(
				getWorkspaceDirectoryPath(harness.workspaceId),
				"session-owned-background-agent-executions",
			);
			const filename = (await readdir(directory)).find((name) => name.endsWith(".execution.json"));
			expect(JSON.parse(await readFile(join(directory, filename ?? "missing"), "utf8"))).toMatchObject({
				status: "running",
				finishedAtEpochMs: null,
				waitingReason: "background_operation_completion_pending",
			});
			expect(
				await hasSessionOwnedBackgroundAgentExecutionRequiringRetention({
					workspaceId: harness.workspaceId,
					taskId: harness.explorationId,
				}),
			).toBe(true);
			const duplicateFork = vi.fn(async () => ({ stopReason: "completed" as const, outputText: "不应重复派发" }));
			await expect(
				createSessionOwnedBackgroundAgentExecutor({
					workspaceId: harness.workspaceId,
					taskId: harness.explorationId,
					runtimeSessionIncarnationId: null,
					purpose: "exploration_thread_graph_maintenance",
					executor: { start: duplicateFork },
				}).start({
					parentSession: {
						harnessKind: "claude_code",
						nativeSessionId: "native-session-1",
						transcriptPath: "/transcripts/native-session-1.jsonl",
						workingDirectory: "/repo",
						launchArgvTemplate: {
							model: "default",
							appendSystemPrompt: "exploratory",
							settingsPath: "/settings.json",
							extraArgs: [],
						},
					},
					promptText: "重复请求",
					outputSchema: { type: "object", properties: {} },
				}),
			).rejects.toThrow("活跃或退出未知");
			expect(duplicateFork).not.toHaveBeenCalled();
			const cancellation = await requestSessionOwnedBackgroundAgentExecutionCancellation({
				workspaceId: harness.workspaceId,
				taskId: harness.explorationId,
			});
			expect(harness.jobSignal()?.aborted).toBe(true);
			releaseLock.release();
			await heldLock;
			expect(await pending).toMatchObject({
				kind: "completed",
				result: { outcome: "fork_failed", stopReason: "cancelled" },
			});
			await cancellation.processCancellationConfirmationCompleted;
			expect(await harness.readGraphAndTopicBytes()).toEqual(originalBytes);
			expect(harness.onUpdated).not.toHaveBeenCalled();
			expect(harness.relayFindingCandidates).not.toHaveBeenCalled();
			// 历史 Stop 不封锁后续新操作。
			expect(await harness.start()).toMatchObject({ kind: "completed", result: { outcome: "accepted" } });
		} finally {
			releaseLock.release();
			await heldLock;
			await pending;
			harness.trigger.dispose();
		}
	});

	it.each([false, true])(
		"锁内重读期间跨进程 Stop，不靠轮询且不写 graph/topic/stale（签名变化=%s）",
		async (changedApplySignature) => {
			// 暂停周期观察，证明落盘前的同步补证能独立关闭短取消窗口。
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const harness = await createRealMaintenanceJobHarness({ pauseAtTurnReadNumber: 3, changedApplySignature });
			const originalBytes = await harness.readGraphAndTopicBytes();
			const pending = harness.start();
			try {
				await harness.blockedTurnReadReached.reached;
				const directory = join(
					getWorkspaceDirectoryPath(harness.workspaceId),
					"session-owned-background-agent-executions",
				);
				// 与其他 runtime 写入相同的持久 UUID，不经过本进程的即时通知。
				const taskIdentityDigest = createHash("sha256").update(harness.explorationId).digest("hex");
				const cancellationPath = join(
					directory,
					`task-${taskIdentityDigest}.admission-cancellation-generation.json`,
				);
				await writeFile(
					cancellationPath,
					JSON.stringify({ taskId: harness.explorationId, cancellationGeneration: randomUUID() }),
				);
				expect(harness.jobSignal()?.aborted).toBe(false);
				harness.releaseBlockedTurnRead.release();
				expect(await pending).toMatchObject({
					kind: "completed",
					result: { outcome: "fork_failed", stopReason: "cancelled" },
				});
				expect(harness.jobSignal()?.aborted).toBe(true);
				expect(await harness.readGraphAndTopicBytes()).toEqual(originalBytes);
				expect(harness.onUpdated).not.toHaveBeenCalled();
				expect(harness.relayFindingCandidates).not.toHaveBeenCalled();
			} finally {
				harness.releaseBlockedTurnRead.release();
				await pending;
				harness.trigger.dispose();
			}
		},
	);

	it.each([false, true])(
		"真实 store 提交已取得资格时，Stop 不能在 graph/topic/stale 写入前返回（stale=%s）",
		async (changedApplySignature) => {
			const harness = await createRealMaintenanceJobHarness({ changedApplySignature });
			const originalBytes = await harness.readGraphAndTopicBytes();
			const writeReached = createDeferredBarrier();
			const releaseWrite = createDeferredBarrier();
			const stopLockAttempted = createDeferredBarrier();
			const originalMkdir = fsPromises.mkdir;
			const graphDirectory = dirname(
				resolveExplorationThreadGraphCollectionPath(harness.storeRoot, harness.explorationId),
			);
			let armed = true;
			const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (path, options) => {
				if (armed && String(path) === graphDirectory) {
					armed = false;
					writeReached.release();
					await releaseWrite.reached;
				}
				return await originalMkdir(path, options);
			});
			syncBuiltinESMExports();
			const originalWithLock = lockedFileSystem.withLock.bind(lockedFileSystem);
			let stopping = false;
			const lockSpy = vi.spyOn(lockedFileSystem, "withLock").mockImplementation(async (request, operation) => {
				if (stopping && request.type === "directory") stopLockAttempted.release();
				return await originalWithLock(request, operation);
			});
			const pending = harness.start();
			let cancellationConfirmation: Promise<PromiseSettledResult<void>[]> | undefined;
			try {
				await writeReached.reached;
				expect(await harness.readGraphAndTopicBytes()).toEqual(originalBytes);
				stopping = true;
				cancellationConfirmation = requestSessionOwnedBackgroundAgentExecutionCancellation({
					workspaceId: harness.workspaceId,
					taskId: harness.explorationId,
				}).then((cancellation) => cancellation.processCancellationConfirmationCompleted);
				await stopLockAttempted.reached;
				const directory = join(
					getWorkspaceDirectoryPath(harness.workspaceId),
					"session-owned-background-agent-executions",
				);
				expect(
					(await readdir(directory)).some((name) => name.endsWith(".admission-cancellation-generation.json")),
				).toBe(false);
				expect(harness.jobSignal()?.aborted).toBe(false);
				releaseWrite.release();
				expect(await pending).toMatchObject({
					kind: "completed",
					result: { outcome: changedApplySignature ? "rejected" : "accepted" },
				});
				await cancellationConfirmation;
				const bytesAfterStop = await harness.readGraphAndTopicBytes();
				expect(bytesAfterStop).not.toEqual(originalBytes);
				expect(await harness.readGraphAndTopicBytes()).toEqual(bytesAfterStop);
				expect(harness.onUpdated).toHaveBeenCalledTimes(changedApplySignature ? 0 : 1);
			} finally {
				releaseWrite.release();
				await pending;
				await cancellationConfirmation;
				mkdirSpy.mockRestore();
				syncBuiltinESMExports();
				lockSpy.mockRestore();
				harness.trigger.dispose();
			}
		},
	);

	it("模式闸：非 exploratory 卡片一律不判——切模式本身就是唯一的开启动作", async () => {
		const harness = await createTriggerHarness({
			summaries: [makeSummary({ taskConversationMode: "operational" })],
		});

		const outcome = await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({ kind: "not_started", reason: "not_exploratory_mode" });
		expect(harness.runMaintenanceJob).not.toHaveBeenCalled();
	});

	it("会话不可用（缺 sidecar）时不判，且不把它当失败", async () => {
		const harness = await createTriggerHarness({
			summaries: [makeSummary({ agentNativeConversationSessionIdentity: null })],
		});

		const outcome = await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({ kind: "not_started", reason: "no_usable_sessions" });
		expect(harness.runMaintenanceJob).not.toHaveBeenCalled();
	});

	it("防抖闸：连续 Stop 只排一次判定，窗口到点才真的跑", async () => {
		const harness = await createTriggerHarness();

		harness.trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });
		harness.trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });
		harness.trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });

		// 三次 Stop 之前一次都没跑——防抖窗口还没到点。
		expect(harness.runMaintenanceJob).not.toHaveBeenCalled();

		// 最后一次排定的回调才是有效的那个（前两次已被 cancel）。
		harness.scheduledDebounceCallbacks.at(-1)?.();
		await vi.waitFor(() => expect(harness.runMaintenanceJob).toHaveBeenCalledTimes(1));
	});

	it("Stop 边沿用的 turn 源必须把末 turn 当已完成——否则每次都少判一个 turn", async () => {
		const createStopEdgeTurnSource = vi.fn(() => makeTurnSource([1, 2, 3]));
		const createInProgressSafeTurnSource = vi.fn(() => makeTurnSource([1, 2, 3]));
		const storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-trigger-"));
		const trigger = createExplorationThreadGraphMaintenanceTrigger({
			listWorkspaceSessionSummaries: () => [makeSummary()],
			onExplorationThreadGraphUpdated: vi.fn(),
			resolveStoreRoot: () => join(storeRoot, "graph"),
			runMaintenanceJob: vi.fn(async () => ACCEPTED_JOB_RESULT),
			createStopEdgeTurnSource,
			createInProgressSafeTurnSource,
			createForkedWorkBranchExecutor: () => ({ start: async () => ({}) as never }),
			scheduleDebounced: (callback) => {
				callback();
				return { cancel: () => {} };
			},
		});

		// 两个 turn 源在构造期各建一次：Stop 边沿那个带 treatFinalTurnAsCompleted，手动那个不带。
		expect(createStopEdgeTurnSource).toHaveBeenCalledTimes(1);
		expect(createInProgressSafeTurnSource).toHaveBeenCalledTimes(1);
		trigger.dispose();
	});

	it("节流闸：维护过之后未攒够阈值的自动触发不跑", async () => {
		const harness = await createTriggerHarness({ completedTurnNumbers: [1, 2] });

		harness.trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });
		harness.scheduledDebounceCallbacks.at(-1)?.();

		// 空 storeRoot ⇒ 从未维护过 ⇒ 首次 backfill 不受阈值约束，照跑。
		await vi.waitFor(() => expect(harness.runMaintenanceJob).toHaveBeenCalledTimes(1));
		expect(harness.runMaintenanceJob.mock.calls[0]?.[0]?.mode).toBe("initial_backfill");
	});

	it("节流闸只拦自动触发：已维护过且未攒够阈值时，Stop 边沿不跑", async () => {
		const harness = await createTriggerHarness({
			completedTurnNumbers: [1, 2, 3],
			alreadyMaintainedWithLastPlacedTurnNumberBySession: { "native-session-1": 1 },
		});

		harness.trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });
		harness.scheduledDebounceCallbacks.at(-1)?.();

		// 等这一轮判定真的跑到闸前（turn 序列已读），再断言它被拦下了。
		await vi.waitFor(() => expect(harness.readCompletedTurnSequence).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.runMaintenanceJob).not.toHaveBeenCalled();
	});

	it("手动触发跳过节流闸：未攒够阈值也照跑（契约上只有单飞闸拦得住它）", async () => {
		const harness = await createTriggerHarness({
			completedTurnNumbers: [1, 2, 3],
			alreadyMaintainedWithLastPlacedTurnNumberBySession: { "native-session-1": 1 },
		});

		const outcome = await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({ kind: "completed", result: ACCEPTED_JOB_RESULT });
		expect(harness.runMaintenanceJob).toHaveBeenCalledTimes(1);
		// 节流判定的「拦下」分支不带 mode；手动放行按增量语义补 incremental（此前必定维护过）。
		expect(harness.runMaintenanceJob.mock.calls[0]?.[0]?.mode).toBe("incremental");
	});

	it("没有任何已完成 turn 时不跑", async () => {
		const harness = await createTriggerHarness({ completedTurnNumbers: [] });

		const outcome = await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({ kind: "not_started", reason: "no_completed_turns" });
		expect(harness.runMaintenanceJob).not.toHaveBeenCalled();
	});

	it("单飞闸：同一 exploration 在途只有一个作业——store 的写锁挡不住并发 fork", async () => {
		const storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-trigger-"));
		// 恒为函数（而不是 `| null`）：在 Promise executor 里赋值时控制流分析看不到这次写入，
		// 声明成可空会让后面的调用点被窄化成 never。
		let releaseFirstJob: () => void = () => {};
		const firstJobBlocker = new Promise<void>((resolve) => {
			releaseFirstJob = resolve;
		});
		const runMaintenanceJob = vi.fn(async (): Promise<RunExplorationThreadGraphMaintenanceJobResult> => {
			await firstJobBlocker;
			return ACCEPTED_JOB_RESULT;
		});
		const trigger = createExplorationThreadGraphMaintenanceTrigger({
			listWorkspaceSessionSummaries: () => [makeSummary()],
			onExplorationThreadGraphUpdated: vi.fn(),
			resolveStoreRoot: () => join(storeRoot, "graph"),
			runMaintenanceJob,
			createStopEdgeTurnSource: () => makeTurnSource([1, 2, 3]),
			createInProgressSafeTurnSource: () => makeTurnSource([1, 2, 3]),
			createForkedWorkBranchExecutor: () => ({ start: async () => ({}) as never }),
			scheduleDebounced: (callback) => {
				callback();
				return { cancel: () => {} };
			},
		});

		const firstRun = trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});
		await vi.waitFor(() => expect(runMaintenanceJob).toHaveBeenCalledTimes(1));

		const secondOutcome = await trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});
		expect(secondOutcome).toEqual({ kind: "not_started", reason: "already_in_flight" });
		expect(runMaintenanceJob).toHaveBeenCalledTimes(1);

		releaseFirstJob();
		await firstRun;
		trigger.dispose();
	});

	it("单飞账本按 workspace + exploration 联合计账——跨 project 撞号绝不互相吞掉触发", async () => {
		const storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-trigger-"));
		let releaseJobs: () => void = () => {};
		const blockUntilReleased = new Promise<void>((resolve) => {
			releaseJobs = resolve;
		});
		const runMaintenanceJob = vi.fn(async (): Promise<RunExplorationThreadGraphMaintenanceJobResult> => {
			await blockUntilReleased;
			return ACCEPTED_JOB_RESULT;
		});
		const trigger = createExplorationThreadGraphMaintenanceTrigger({
			listWorkspaceSessionSummaries: () => [makeSummary()],
			onExplorationThreadGraphUpdated: vi.fn(),
			resolveStoreRoot: () => join(storeRoot, "graph"),
			runMaintenanceJob,
			createStopEdgeTurnSource: () => makeTurnSource([1, 2, 3]),
			createInProgressSafeTurnSource: () => makeTurnSource([1, 2, 3]),
			createForkedWorkBranchExecutor: () => ({ start: async () => ({}) as never }),
			scheduleDebounced: (callback) => {
				callback();
				return { cancel: () => {} };
			},
		});

		// 同一个 board-local taskId，在两个不同 workspace 下——必须各跑各的。
		const firstRun = trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});
		const secondRun = trigger.requestImmediateMaintenance({
			workspaceId: "workspace-2",
			explorationId: "exploration-1",
		});
		await vi.waitFor(() => expect(runMaintenanceJob).toHaveBeenCalledTimes(2));

		releaseJobs();
		await Promise.all([firstRun, secondRun]);
		trigger.dispose();
	});

	it("只有 accepted 才广播——被拒或 fork 失败时图没变，重发一次相同值只是噪音", async () => {
		const rejectedHarness = await createTriggerHarness({
			jobResult: { outcome: "rejected", rejectionReason: "edge_target_not_in_past", usage: null },
		});

		const outcome = await rejectedHarness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({
			kind: "completed",
			result: { outcome: "rejected", rejectionReason: "edge_target_not_in_past", usage: null },
		});
		expect(rejectedHarness.onExplorationThreadGraphUpdated).not.toHaveBeenCalled();
	});

	it("accepted 后重算投影并广播", async () => {
		const harness = await createTriggerHarness();

		await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(harness.onExplorationThreadGraphUpdated).toHaveBeenCalledTimes(1);
		const [workspaceId, explorationId, view] = harness.onExplorationThreadGraphUpdated.mock.calls[0] ?? [];
		expect(workspaceId).toBe("workspace-1");
		expect(explorationId).toBe("exploration-1");
		expect(view).toMatchObject({ explorationId: "exploration-1" });
	});

	it("作业抛错被收敛成 failed，不外溢到 hook 响应路径", async () => {
		const harness = await createTriggerHarness();
		harness.runMaintenanceJob.mockRejectedValueOnce(new Error("fork 进程起不来"));

		const outcome = await harness.trigger.requestImmediateMaintenance({
			workspaceId: "workspace-1",
			explorationId: "exploration-1",
		});

		expect(outcome).toEqual({ kind: "failed", message: "fork 进程起不来" });
	});

	it("dispose 取消全部待触发的防抖窗口", async () => {
		const cancel = vi.fn();
		const storeRoot = await mkdtemp(join(tmpdir(), "exploration-thread-graph-trigger-"));
		const trigger = createExplorationThreadGraphMaintenanceTrigger({
			listWorkspaceSessionSummaries: () => [makeSummary()],
			onExplorationThreadGraphUpdated: vi.fn(),
			resolveStoreRoot: () => join(storeRoot, "graph"),
			runMaintenanceJob: vi.fn(async () => ACCEPTED_JOB_RESULT),
			createStopEdgeTurnSource: () => makeTurnSource([1]),
			createInProgressSafeTurnSource: () => makeTurnSource([1]),
			createForkedWorkBranchExecutor: () => ({ start: async () => ({}) as never }),
			scheduleDebounced: () => ({ cancel }),
		});

		trigger.notifyAgentTurnStopped({ workspaceId: "workspace-1", explorationId: "exploration-1" });
		trigger.dispose();

		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
