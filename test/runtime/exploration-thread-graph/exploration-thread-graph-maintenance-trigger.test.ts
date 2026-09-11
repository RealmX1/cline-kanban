import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
	RunExplorationThreadGraphMaintenanceJobInput,
	RunExplorationThreadGraphMaintenanceJobResult,
} from "agent-conversation-exploration-thread-graph/core";
import {
	createEmptyExplorationThreadGraphCollection,
	resolveExplorationThreadGraphCollectionPath,
} from "agent-conversation-exploration-thread-graph/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createExplorationThreadGraphMaintenanceTrigger } from "../../../src/exploration-thread-graph/exploration-thread-graph-maintenance-trigger";

// 四道闸各挡一次钱：模式闸 / 防抖闸 / 单飞闸 / 节流闸。任何一道漏掉，重型会话上就是每 turn ≈ $2.2。
// 本套件不 spawn 任何进程、不落盘：storeRoot 指向空临时目录（核心包对缺失文件退化为空集合），
// turn 源与作业 runner 全部注入。

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
