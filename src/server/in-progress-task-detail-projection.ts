import type {
	RuntimeAgentId,
	RuntimeAgentResponseGenerationStopped,
	RuntimeAgentResponseGenerationTurnStarted,
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeInProgressTaskDetail,
	RuntimeLastConversationProgressObservation,
	RuntimeLastMainAgentConversationModelRequestDispatchObservation,
	RuntimeTaskSessionLiveness,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionTurnOwner,
	RuntimeTaskSessionUserTurnKind,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";

// 跨项目视图（Board Overview 的 in_progress 明细、跨项目切换面板的条目）需要的**会话事实最小子集**。
//
// 为什么不直接传整条 summary：未加载项目的会话只能读 sessions.json，本机 28 个项目合计约 31 MB（单个最大
// 2.8 MB），每 150ms 一次的 projects_updated 广播不可能每次重新解析；workspace-registry 按文件 mtime 缓存，
// 缓存里只留这几个字段（见 persisted-task-session-facts-cache-for-unloaded-projects.ts）。
export interface TaskSessionFactsForCrossProjectTaskViews {
	agentId: RuntimeAgentId | null;
	lastOutputAt: number | null;
	lastSubstantiveOutputAt: number | null;
	agentResponseGenerationStopped: RuntimeAgentResponseGenerationStopped | null;
	lastConversationProgressObservation: RuntimeLastConversationProgressObservation | null;
	// 概览 Active 组与切换面板 Running 区的排序键（本轮 agent 回合的开始时刻）。
	agentResponseGenerationTurnStarted: RuntimeAgentResponseGenerationTurnStarted | null;
	// 只有跨项目切换面板的 Cache warm 估算要读这两个（Board Overview 明细不投影它们）。
	lastMainAgentConversationModelRequestDispatchObservation: RuntimeLastMainAgentConversationModelRequestDispatchObservation | null;
	agentProcessStartedAt: number | null;
	turnOwner: RuntimeTaskSessionTurnOwner;
	liveness: RuntimeTaskSessionLiveness;
	userTurnKind: RuntimeTaskSessionUserTurnKind;
	isParkedAwaitingDispatchedBackgroundWork: boolean;
}

// facet 经真相源 resolveSessionFacets 解析，绝不读 summary.state。
export function extractTaskSessionFactsForCrossProjectTaskViews(
	summary: RuntimeTaskSessionSummary,
): TaskSessionFactsForCrossProjectTaskViews {
	const facets = resolveSessionFacets(summary);
	return {
		agentId: summary.agentId,
		lastOutputAt: summary.lastOutputAt,
		lastSubstantiveOutputAt: summary.lastSubstantiveOutputAt ?? null,
		agentResponseGenerationStopped: summary.agentResponseGenerationStopped ?? null,
		lastConversationProgressObservation: summary.lastConversationProgressObservation ?? null,
		agentResponseGenerationTurnStarted: summary.agentResponseGenerationTurnStarted ?? null,
		lastMainAgentConversationModelRequestDispatchObservation:
			summary.lastMainAgentConversationModelRequestDispatchObservation ?? null,
		agentProcessStartedAt: summary.startedAt,
		turnOwner: facets.turnOwner,
		liveness: facets.liveness,
		userTurnKind: facets.userTurnKind,
		isParkedAwaitingDispatchedBackgroundWork: isParkedAwaitingDispatchedBackgroundWork(summary),
	};
}

export function extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(
	summaries: Iterable<RuntimeTaskSessionSummary>,
): Map<string, TaskSessionFactsForCrossProjectTaskViews> {
	const factsByTaskId = new Map<string, TaskSessionFactsForCrossProjectTaskViews>();
	for (const summary of summaries) {
		factsByTaskId.set(summary.taskId, extractTaskSessionFactsForCrossProjectTaskViews(summary));
	}
	return factsByTaskId;
}

// 单张卡的活动明细。Board Overview 的 in_progress 明细与跨项目切换面板的条目都从这里出（后者是前者的超集），
// 是同一份代码而不是两份实现。agentId 优先取运行时 session、回退卡片声明；无 session 的卡回退
// turnOwner=null / liveness=none。
export function buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(
	card: RuntimeBoardCard,
	sessionFacts: TaskSessionFactsForCrossProjectTaskViews | undefined,
): RuntimeInProgressTaskDetail {
	return {
		taskId: card.id,
		title: card.title,
		agentId: sessionFacts?.agentId ?? card.agentId ?? null,
		createdAt: card.createdAt,
		lastOutputAt: sessionFacts?.lastOutputAt ?? null,
		lastSubstantiveOutputAt: sessionFacts?.lastSubstantiveOutputAt ?? null,
		// 概览行与主看板卡片头部显示同样的两颗时长药丸，故两个量都要投影过来。
		// 只投影、不在此合并或推断——合并是 mergeSummaryWithFacets 里那个唯一 reducer 的事。
		agentResponseGenerationStopped: sessionFacts?.agentResponseGenerationStopped ?? null,
		lastConversationProgressObservation: sessionFacts?.lastConversationProgressObservation ?? null,
		agentResponseGenerationTurnStarted: sessionFacts?.agentResponseGenerationTurnStarted ?? null,
		turnOwner: sessionFacts?.turnOwner ?? null,
		liveness: sessionFacts?.liveness ?? "none",
	};
}

// 把 board `in_progress` 列的全部 task 投影为 Cross-Repository Stage-First Overview（见 docs/context-stage-first-overview.md）
// 所需的精简明细。按「列归属」判定成员——in_progress 列有几张卡就出几条，awaiting_review / interrupted
// 的卡也一并保留（**不**套用主看板的 live-session overlay，见 ADR-0001）；前端据 turnOwner + lastOutputAt
// 把它们二分为 Active / Stale。
//
// 纯函数：无 I/O、无闭包状态，可独立单测（见 in-progress-task-detail-projection.test.ts）。
export function collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts(
	board: RuntimeBoardData,
	sessionFactsByTaskId: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>,
): RuntimeInProgressTaskDetail[] {
	const inProgressColumn = board.columns.find((column) => column.id === "in_progress");
	if (!inProgressColumn) {
		return [];
	}
	return inProgressColumn.cards.map((card) =>
		buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(card, sessionFactsByTaskId.get(card.id)),
	);
}

export function collectInProgressTaskDetailsFromBoard(
	board: RuntimeBoardData,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): RuntimeInProgressTaskDetail[] {
	return collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts(
		board,
		extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(Object.values(sessions)),
	);
}
