// 维护作业的触发编排（B.2 宿主胶水的核心）。
//
// 「什么时候 fork 一个分身去判定话题归属」完全是宿主的职责——核心包只管「被调用时判哪些 turn」。
// 本模块就是那个决定者，四道闸依次收窄，**每一道都在把钱挡在门外**（重型会话 fork 一次 ≈ $2.2，
// 成因见 docs/exploratory-mode-host-integration.md §3b）：
//
//   ① 模式闸：只有 `taskConversationMode === "exploratory"` 的卡片才维护。用户把任务切成探索模式
//      这个动作本身就是开启自动维护的意思（这是拍板结论，不再要第二次确认）。
//   ② 防抖闸：Stop 边沿到达后等一个窗口再动手。连续几个 turn 快速结束时只会合并成一次判定。
//   ③ 单飞闸：同一个 exploration 在途恒只有一个作业。**store 的跨进程写锁挡不住这件事**——它只
//      覆盖落盘那一小段，不覆盖前面那次昂贵的 fork，两个并发作业会各 fork 一次再争锁。
//   ④ 节流闸：攒够 N 个未归位的 turn 才值得再判一次（见 maintenance-throttle）。
//
// 账本一律按 **workspace + exploration 联合计账**，绝不只用 explorationId：taskId 是 board-local 短 id，
// 跨 project 撞号是常态（persisted-agent-transcript-conversation-progress-observer 为此吃过亏——
// 撞号的代价不是多跑一次而是**少跑一次**，先到的那个会把另一个 project 同号任务的触发静默吞掉）。
//
// turn 来源持有两个实例而不是一个：`treatFinalTurnAsCompleted` 是构造参数，而 Stop 边沿必须传 true
// （刚结束的正是末 turn，传 false 等于每次都少判一个 turn，且漏斗会拒绝指向它的 turnRef），手动触发
// 却可能发生在 agent 正在生成的中途，必须保持 false。两个实例各自维护增量读偏移，代价是这两条路径
// 都被用到时 transcript 读两遍——正确性优先于那点 IO。

import type {
	CompletedTurnSequenceSource,
	ExplorationThreadGraphProjectionView,
	ForkedWorkBranchExecutor,
	RunExplorationThreadGraphMaintenanceJobResult,
} from "agent-conversation-exploration-thread-graph/core";
import { runExplorationThreadGraphMaintenanceJob } from "agent-conversation-exploration-thread-graph/core";
import {
	ClaudeCodeForkedSessionWorkBranchExecutor,
	ClaudeCodeTranscriptCompletedTurnSource,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import type { RuntimeIngestExploratoryFindingCandidateRequest, RuntimeTaskSessionSummary } from "../core/api-contract";
import { collectExplorationThreadGraphFindingCandidateRequests } from "./exploration-thread-graph-finding-candidate-relay";
import { decideExplorationThreadGraphMaintenanceThrottle } from "./exploration-thread-graph-maintenance-throttle";
import { loadExplorationThreadGraphProjection } from "./exploration-thread-graph-projection-loader";
import { assembleExplorationThreadGraphSessionRefs } from "./exploration-thread-graph-session-refs";
import { resolveWorkspaceExplorationThreadGraphStoreRoot } from "./exploration-thread-graph-store-location";

// Stop 边沿后的合并窗口。取 45s 的理由：探索场次里用户读完回答再敲下一句，间隔通常远大于这个数，
// 所以它基本不会推迟单次判定；而它能把「agent 连着结束几个短 turn」合并成一次 fork。
export const EXPLORATION_THREAD_GRAPH_MAINTENANCE_DEBOUNCE_MS = 45_000;

// 单次作业的墙钟上限。核心包默认 300s；这里不放宽——超时的分身照样计费，拖久了只是多烧钱。
export const EXPLORATION_THREAD_GRAPH_MAINTENANCE_TIMEOUT_MS = 300_000;

export type ExplorationThreadGraphMaintenanceOutcome =
	| { kind: "completed"; result: RunExplorationThreadGraphMaintenanceJobResult }
	| {
			kind: "not_started";
			reason:
				| "not_exploratory_mode"
				| "no_usable_sessions"
				| "already_in_flight"
				| "throttled"
				| "no_completed_turns";
	  }
	| { kind: "failed"; message: string };

export interface ExplorationThreadGraphMaintenanceTriggerDependencies {
	// 该 workspace 当前全部会话 summary。允许返回 Promise：宿主取终端管理器本身是异步的
	// （workspace 可能还没被 track 过），同步返回也合法。
	listWorkspaceSessionSummaries: (
		workspaceId: string,
	) => Promise<readonly RuntimeTaskSessionSummary[]> | readonly RuntimeTaskSessionSummary[];
	// 作业落盘并算出新投影后的广播出口（runtime-server 注入 runtime-state-hub）。
	onExplorationThreadGraphUpdated: (
		workspaceId: string,
		explorationId: string,
		view: ExplorationThreadGraphProjectionView,
	) => void;
	// 以下全部可注入，单测据此在不 spawn 任何进程的前提下覆盖四道闸。
	resolveStoreRoot?: (workspaceId: string) => string;
	runMaintenanceJob?: typeof runExplorationThreadGraphMaintenanceJob;
	createStopEdgeTurnSource?: () => CompletedTurnSequenceSource;
	createInProgressSafeTurnSource?: () => CompletedTurnSequenceSource;
	createForkedWorkBranchExecutor?: () => ForkedWorkBranchExecutor;
	// 作业标注的 finding_candidate 转投 findings 建议通道（B.2）。可选：未接线时标注只留在图上。
	// 去重靠请求里确定性派生的 clientProposalId，本触发器不维护「转投过哪些」的账本。
	relayFindingCandidates?: (
		workspaceId: string,
		requests: RuntimeIngestExploratoryFindingCandidateRequest[],
	) => Promise<void> | void;
	minimumTurnsBetweenMaintenanceRuns?: number;
	debounceMs?: number;
	scheduleDebounced?: (callback: () => void, delayMs: number) => { cancel: () => void };
}

export interface ExplorationThreadGraphMaintenanceTrigger {
	// 终端 Stop 边沿：合并进防抖窗口，窗口到点后才走后面三道闸。
	notifyAgentTurnStopped(input: { workspaceId: string; explorationId: string }): void;
	// 面板上的「立即维护一次」：跳过防抖与节流，但**不跳过单飞闸**。
	requestImmediateMaintenance(input: {
		workspaceId: string;
		explorationId: string;
	}): Promise<ExplorationThreadGraphMaintenanceOutcome>;
	// 运行时关停：取消全部待触发的防抖窗口（在途作业不打断，它自己会结束）。
	dispose(): void;
}

// 账本键：workspace + exploration 联合，绝不只用 explorationId（board-local 短 id 跨 project 撞号）。
function buildWorkspaceScopedExplorationKey(workspaceId: string, explorationId: string): string {
	return `${workspaceId}\u0000${explorationId}`;
}

function isExplorationCardInExploratoryMode(
	sessionSummaries: readonly RuntimeTaskSessionSummary[],
	explorationId: string,
): boolean {
	const mainSummary = sessionSummaries.find((summary) => summary.taskId === explorationId);
	return mainSummary?.taskConversationMode === "exploratory";
}

export function createExplorationThreadGraphMaintenanceTrigger(
	deps: ExplorationThreadGraphMaintenanceTriggerDependencies,
): ExplorationThreadGraphMaintenanceTrigger {
	const resolveStoreRoot = deps.resolveStoreRoot ?? resolveWorkspaceExplorationThreadGraphStoreRoot;
	const runMaintenanceJob = deps.runMaintenanceJob ?? runExplorationThreadGraphMaintenanceJob;
	const debounceMs = deps.debounceMs ?? EXPLORATION_THREAD_GRAPH_MAINTENANCE_DEBOUNCE_MS;
	const scheduleDebounced =
		deps.scheduleDebounced ??
		((callback: () => void, delayMs: number) => {
			const timer = setTimeout(callback, delayMs);
			// 防抖定时器绝不该拖住运行时退出：它等的是一次可以不做的判定。
			timer.unref?.();
			return { cancel: () => clearTimeout(timer) };
		});

	// Stop 边沿触发：末 turn 已经结束，必须算已完成（交接文档点名的最易静默踩空处）。
	const stopEdgeTurnSource =
		deps.createStopEdgeTurnSource?.() ??
		new ClaudeCodeTranscriptCompletedTurnSource({ treatFinalTurnAsCompleted: true });
	// 手动触发：agent 可能正在生成，末 turn 保持「进行中」不参与判定。
	const inProgressSafeTurnSource =
		deps.createInProgressSafeTurnSource?.() ?? new ClaudeCodeTranscriptCompletedTurnSource();
	const createForkedWorkBranchExecutor =
		deps.createForkedWorkBranchExecutor ?? (() => new ClaudeCodeForkedSessionWorkBranchExecutor());

	const pendingDebounceByExplorationKey = new Map<string, { cancel: () => void }>();
	const inFlightExplorationKeys = new Set<string>();

	// 一次判定的完整闸序。`enforceThrottle` 为 false 时（手动触发）只跳过节流闸，其余照走。
	const runMaintenanceOnce = async (input: {
		workspaceId: string;
		explorationId: string;
		enforceThrottle: boolean;
		turnSource: CompletedTurnSequenceSource;
	}): Promise<ExplorationThreadGraphMaintenanceOutcome> => {
		const explorationKey = buildWorkspaceScopedExplorationKey(input.workspaceId, input.explorationId);
		const sessionSummaries = await deps.listWorkspaceSessionSummaries(input.workspaceId);

		// ① 模式闸。
		if (!isExplorationCardInExploratoryMode(sessionSummaries, input.explorationId)) {
			return { kind: "not_started", reason: "not_exploratory_mode" };
		}

		// ③ 单飞闸（放在昂贵动作之前；手动触发同样受它约束）。
		if (inFlightExplorationKeys.has(explorationKey)) {
			return { kind: "not_started", reason: "already_in_flight" };
		}

		const sessionRefAssembly = assembleExplorationThreadGraphSessionRefs({
			explorationId: input.explorationId,
			sessionSummaries,
		});
		const sessionRefs = sessionRefAssembly.sessionRefs;
		if (sessionRefs.length === 0) {
			return { kind: "not_started", reason: "no_usable_sessions" };
		}

		inFlightExplorationKeys.add(explorationKey);
		try {
			const storeRoot = resolveStoreRoot(input.workspaceId);
			// 廉价判定先行：读 collection 与 transcript 增量都不花钱，fork 才花钱。
			const projection = await loadExplorationThreadGraphProjection({
				explorationId: input.explorationId,
				storeRoot,
				sessionRefs,
				turnSource: input.turnSource,
			});
			const throttleDecision = decideExplorationThreadGraphMaintenanceThrottle({
				collection: projection.collection,
				turnSnapshotsBySession: projection.turnSnapshotsBySession,
				minimumTurnsBetweenMaintenanceRuns: deps.minimumTurnsBetweenMaintenanceRuns,
			});
			// ④ 节流闸。手动触发（enforceThrottle=false）允许在未攒够阈值时也跑——这是契约
			// （api-contract 的「跳过防抖与节流，但不跳过单飞闸」）；但「一个已完成 turn 都没有」
			// 两条路径都拒绝：没有可判的 turn，放行只会白 fork 一次（≈ $2.2）。
			if (!throttleDecision.shouldRun) {
				if (throttleDecision.reason === "no_completed_turns") {
					return { kind: "not_started", reason: "no_completed_turns" };
				}
				if (input.enforceThrottle) {
					return { kind: "not_started", reason: "throttled" };
				}
			}
			// shouldRun 为 false 的分支不带 mode（节流判定没算到那一步）。能落到这里只可能是「手动放行
			// 未攒够阈值」，而未攒够阈值蕴含此前已经维护过（首次 backfill 不受阈值约束、恒 shouldRun），
			// 所以增量语义下的 mode 就是 incremental。
			const maintenanceJobMode = throttleDecision.shouldRun ? throttleDecision.mode : "incremental";

			const result = await runMaintenanceJob({
				explorationId: input.explorationId,
				sessions: sessionRefs,
				turnSource: input.turnSource,
				executor: createForkedWorkBranchExecutor(),
				storeRoot,
				mode: maintenanceJobMode,
				timeoutMs: EXPLORATION_THREAD_GRAPH_MAINTENANCE_TIMEOUT_MS,
			});

			// 只有真正落盘了才重算并广播——被拒 / 跳过 / fork 失败时图没变，广播一次相同的值只是噪音。
			if (result.outcome === "accepted") {
				const refreshed = await loadExplorationThreadGraphProjection({
					explorationId: input.explorationId,
					storeRoot,
					sessionRefs,
					turnSource: input.turnSource,
				});
				deps.onExplorationThreadGraphUpdated(input.workspaceId, input.explorationId, refreshed.view);

				// 分身标注的 finding_candidate 转投 findings 的建议通道。**best-effort**：转投失败绝不
				// 回滚已经落盘的图——那是两笔独立的事实，而且下一次作业跑完会用同样的确定性 id 再试一次
				// （ingest 侧对同 clientProposalId 幂等，重试无害）。
				const findingCandidateRequests = collectExplorationThreadGraphFindingCandidateRequests({
					explorationId: input.explorationId,
					collection: refreshed.collection,
					turnSnapshotsBySession: refreshed.turnSnapshotsBySession,
					hostTaskIdByNativeSessionId: sessionRefAssembly.hostTaskIdByNativeSessionId,
				});
				if (findingCandidateRequests.length > 0) {
					try {
						await deps.relayFindingCandidates?.(input.workspaceId, findingCandidateRequests);
					} catch {
						// 见上：图已落盘，转投是附加动作。
					}
				}
			}
			return { kind: "completed", result };
		} catch (error) {
			return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
		} finally {
			inFlightExplorationKeys.delete(explorationKey);
		}
	};

	return {
		notifyAgentTurnStopped: (input) => {
			const explorationKey = buildWorkspaceScopedExplorationKey(input.workspaceId, input.explorationId);
			// 防抖窗口内又来一次 Stop：重置窗口，合并成一次判定。
			pendingDebounceByExplorationKey.get(explorationKey)?.cancel();
			const scheduled = scheduleDebounced(() => {
				pendingDebounceByExplorationKey.delete(explorationKey);
				void runMaintenanceOnce({
					workspaceId: input.workspaceId,
					explorationId: input.explorationId,
					enforceThrottle: true,
					turnSource: stopEdgeTurnSource,
				});
			}, debounceMs);
			pendingDebounceByExplorationKey.set(explorationKey, scheduled);
		},

		requestImmediateMaintenance: async (input) => {
			// 手动触发抢在防抖窗口前面：既然人已经点了，等窗口到点没有意义。
			const explorationKey = buildWorkspaceScopedExplorationKey(input.workspaceId, input.explorationId);
			pendingDebounceByExplorationKey.get(explorationKey)?.cancel();
			pendingDebounceByExplorationKey.delete(explorationKey);
			return await runMaintenanceOnce({
				workspaceId: input.workspaceId,
				explorationId: input.explorationId,
				enforceThrottle: false,
				turnSource: inProgressSafeTurnSource,
			});
		},

		dispose: () => {
			for (const scheduled of pendingDebounceByExplorationKey.values()) {
				scheduled.cancel();
			}
			pendingDebounceByExplorationKey.clear();
		},
	};
}
