// 维护作业的节流判定（B.2 宿主胶水）——**宿主侧唯一的成本闸**。
//
// 为什么这是成本闸而不是性能调参：核心包的作业每跑一次，就从主会话 fork 一个分身。Pass A 实测
// （见 docs/exploratory-mode-host-integration.md §3b）表明 Claude Code 的 `--fork-session` 在重型
// 会话上**拿不到主会话的 prompt cache**（上游 open bug anthropics/claude-code#77306，无 ETA），
// 一次 220k 上下文的 opus fork ≈ $2.2。每个 turn 都跑就是每个 turn 两块多美金。
//
// 核心包侧没有替宿主实现节流（它只管「被调用时判哪些 turn」），所以闸门必须在这里。判据取
// 「**已完成但尚未归位**的 turn 数」而不是「距上次维护过了多久」：时间与花销无关，turn 数才是。
//
// 判定本身很便宜——只读 collection（本地 JSON）与 turn 快照（transcript 尾部增量读），不 fork。
// 昂贵的只有 fork 本身，所以「先廉价判定、够了再 fork」这个顺序是整条链路的关键。

import type {
	CompletedTurnSequenceSnapshot,
	ExplorationThreadGraphCollection,
	ExplorationThreadGraphMaintenanceJobMode,
} from "agent-conversation-exploration-thread-graph/core";

// 距上次归位至少要攒够多少个新 turn 才值得再 fork 一次。
//
// 取 5 的理由是成本：按实测单价，重型会话上每 5 个 turn 判一次 ≈ 每 turn 摊 $0.44，而每 turn 判
// 一次是 $2.2。再大的间隔会让图明显落后于对话（探索场次里 5 个 turn 通常已经够走出一条岔路），
// 再小则单价陡升。这个值是宿主策略、不是核心包语义，改它不影响任何契约。
export const DEFAULT_MINIMUM_TURNS_BETWEEN_MAINTENANCE_RUNS = 5;

export type ExplorationThreadGraphMaintenanceThrottleDecision =
	| {
			shouldRun: true;
			// 首次维护要把既有 turn 全部归位（可能分批），之后只判增量 + 修订窗口。
			mode: ExplorationThreadGraphMaintenanceJobMode;
			unplacedCompletedTurnCount: number;
	  }
	| {
			shouldRun: false;
			reason: "no_completed_turns" | "not_enough_newly_completed_turns";
			unplacedCompletedTurnCount: number;
	  };

/**
 * 数一数：这些会话里有多少个**已完成**的 turn 还没被归位到某条 thread 上。
 *
 * 「已完成」由 turn 快照负责——进行中的末 turn 不在 `turns[]` 里（核心包的漏斗也会拒绝任何指向
 * 它的 turnRef），所以这里不必也不该自己判断闭合与否。
 */
export function countUnplacedCompletedTurns(
	collection: ExplorationThreadGraphCollection,
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>,
): number {
	let unplacedCompletedTurnCount = 0;
	for (const [conversationSessionId, snapshot] of turnSnapshotsBySession) {
		const lastPlacedTurnNumber = collection.lastPlacedTurnNumberBySession[conversationSessionId] ?? 0;
		for (const turn of snapshot.turns) {
			if (turn.turnNumber > lastPlacedTurnNumber) {
				unplacedCompletedTurnCount += 1;
			}
		}
	}
	return unplacedCompletedTurnCount;
}

/**
 * 该不该现在跑一次维护作业。
 *
 * 首次维护（`lastMaintenanceJobCompletedAt === null`）只要有任何一个已完成 turn 就放行，**不受
 * 间隔约束**：图从空到有的那一次是用户唯一能看到「这东西确实在工作」的时刻，为省一次 fork 把它
 * 推迟到第 5 个 turn，换来的是一张长时间空着的面板。
 */
export function decideExplorationThreadGraphMaintenanceThrottle(input: {
	collection: ExplorationThreadGraphCollection;
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>;
	minimumTurnsBetweenMaintenanceRuns?: number;
}): ExplorationThreadGraphMaintenanceThrottleDecision {
	const unplacedCompletedTurnCount = countUnplacedCompletedTurns(input.collection, input.turnSnapshotsBySession);
	if (unplacedCompletedTurnCount === 0) {
		return { shouldRun: false, reason: "no_completed_turns", unplacedCompletedTurnCount };
	}

	if (input.collection.lastMaintenanceJobCompletedAt === null) {
		return { shouldRun: true, mode: "initial_backfill", unplacedCompletedTurnCount };
	}

	const minimumTurnsBetweenMaintenanceRuns =
		input.minimumTurnsBetweenMaintenanceRuns ?? DEFAULT_MINIMUM_TURNS_BETWEEN_MAINTENANCE_RUNS;
	if (unplacedCompletedTurnCount < minimumTurnsBetweenMaintenanceRuns) {
		return { shouldRun: false, reason: "not_enough_newly_completed_turns", unplacedCompletedTurnCount };
	}
	return { shouldRun: true, mode: "incremental", unplacedCompletedTurnCount };
}
