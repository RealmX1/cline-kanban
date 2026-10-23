import {
	resolveLastAgentConversationPromptCacheReferenceObservation,
	resolveLastAgentConversationUserHandoffObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "../core/agent-conversation-activity-observation";
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
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";

// 跨项目视图（in_progress 明细、跨项目切换面板的条目）需要的**会话事实最小子集**。
//
// 为什么不直接传整条 summary：未加载项目的会话只能读 sessions.json，本机 28 个项目合计约 31 MB（单个最大
// 2.8 MB），每 150ms 一次的 projects_updated 广播不可能每次重新解析；workspace-registry 按文件 mtime 缓存，
// 缓存里只留这几个字段（见 persisted-task-session-facts-cache-for-unloaded-projects.ts）。
export interface TaskSessionFactsForCrossProjectTaskViews {
	agentConversationPromptSubmissionAcceptance?: RuntimeTaskSessionSummary["agentConversationPromptSubmissionAcceptance"];
	taskConversationSessionMetadata?: RuntimeTaskSessionSummary["taskConversationSessionMetadata"];
	lastEffectiveAgentConversationActivityObservation?: RuntimeTaskSessionSummary["lastEffectiveAgentConversationActivityObservation"];
	lastAgentConversationUserHandoffObservation?: RuntimeTaskSessionSummary["lastAgentConversationUserHandoffObservation"];
	lastAgentConversationPromptCacheReferenceObservation?: RuntimeTaskSessionSummary["lastAgentConversationPromptCacheReferenceObservation"];
	agentId: RuntimeAgentId | null;
	lastOutputAt: number | null;
	lastSubstantiveOutputAt: number | null;
	agentResponseGenerationStopped: RuntimeAgentResponseGenerationStopped | null;
	lastConversationProgressObservation: RuntimeLastConversationProgressObservation | null;
	// 切换面板 Running 区的排序键（本轮 agent 回合的开始时刻）。
	agentResponseGenerationTurnStarted: RuntimeAgentResponseGenerationTurnStarted | null;
	// 缓存估算读取新的专用参考；旧请求字段只为兼容读保留，进程起点用于缓存作用域检查。
	lastMainAgentConversationModelRequestDispatchObservation: RuntimeLastMainAgentConversationModelRequestDispatchObservation | null;
	agentProcessStartedAt: number | null;
	turnOwner: RuntimeTaskSessionTurnOwner;
	liveness: RuntimeTaskSessionLiveness;
	userTurnKind: RuntimeTaskSessionUserTurnKind;
	isParkedAwaitingDispatchedBackgroundWork: boolean;
}

/**
 * 旧契约仍携带 I/O 时间，按 15 秒向下取整以减少广播内容抖动。
 * Running、活动圆点和自动移列均已改读可信状态／活动，不再以它判定是否工作。
 * 新活动、交棒和缓存投影保留精确观测时间，不参与此取整。
 */
// EXPERIMENT_NODE: 跨项目视图 lastOutputAt 的取整粒度（15 秒）
export const LAST_OUTPUT_AT_ROUNDING_GRANULARITY_FOR_CROSS_PROJECT_TASK_VIEWS_MS = 15_000;

function roundLastOutputAtDownForCrossProjectTaskViews(lastOutputAt: number | null): number | null {
	if (lastOutputAt === null) {
		return null;
	}
	return (
		Math.floor(lastOutputAt / LAST_OUTPUT_AT_ROUNDING_GRANULARITY_FOR_CROSS_PROJECT_TASK_VIEWS_MS) *
		LAST_OUTPUT_AT_ROUNDING_GRANULARITY_FOR_CROSS_PROJECT_TASK_VIEWS_MS
	);
}

// facet 经真相源 resolveSessionFacets 解析，绝不读 summary.state。
export function extractTaskSessionFactsForCrossProjectTaskViews(
	summary: RuntimeTaskSessionSummary,
): TaskSessionFactsForCrossProjectTaskViews {
	const facets = resolveSessionFacets(summary);
	return {
		...(summary.taskConversationSessionMetadata
			? { taskConversationSessionMetadata: summary.taskConversationSessionMetadata }
			: {}),
		lastEffectiveAgentConversationActivityObservation:
			resolveLastEffectiveAgentConversationActivityObservation(summary),
		lastAgentConversationUserHandoffObservation: resolveLastAgentConversationUserHandoffObservation(summary),
		lastAgentConversationPromptCacheReferenceObservation:
			resolveLastAgentConversationPromptCacheReferenceObservation(summary),
		agentConversationPromptSubmissionAcceptance: summary.agentConversationPromptSubmissionAcceptance ?? null,
		agentId: summary.agentId,
		lastOutputAt: roundLastOutputAtDownForCrossProjectTaskViews(summary.lastOutputAt),
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

/** 显式声明owner必须匹配；缺metadata仅兼容原card.id，不为新主绑定猜归属。 */
export function doesTaskConversationSessionBelongToCardByDeclaredOwnership(
	cardId: string,
	conversationSessionId: string,
	declaredWorkspaceTaskId: string | null | undefined,
): boolean {
	return declaredWorkspaceTaskId === undefined ? conversationSessionId === cardId : declaredWorkspaceTaskId === cardId;
}

/** 仅原卡历史会话允许缺归属；交接后的主会话必须明确属于这张卡。 */
export function resolveCurrentMainConversationTaskSessionFactsWithVerifiedCardOwnership(
	card: RuntimeBoardCard,
	sessionFactsByConversationSessionId: ReadonlyMap<string, TaskSessionFactsForCrossProjectTaskViews>,
): TaskSessionFactsForCrossProjectTaskViews | undefined {
	const mainConversationSessionId = resolveMainTaskConversationSessionId(card);
	const facts = sessionFactsByConversationSessionId.get(mainConversationSessionId);
	if (!facts) return undefined;
	const metadata = facts.taskConversationSessionMetadata;
	return doesTaskConversationSessionBelongToCardByDeclaredOwnership(
		card.id,
		mainConversationSessionId,
		metadata?.workspaceTaskId,
	)
		? facts
		: undefined;
}

// 单张卡的活动明细。in_progress 明细与跨项目切换面板的条目都从这里出（后者是前者的超集），
// 是同一份代码而不是两份实现。agentId 优先取运行时 session、回退卡片声明；无 session 的卡回退
// turnOwner=null / liveness=none。
export function buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(
	card: RuntimeBoardCard,
	sessionFacts: TaskSessionFactsForCrossProjectTaskViews | undefined,
): RuntimeInProgressTaskDetail {
	return {
		taskId: card.id,
		title: card.title,
		...(sessionFacts?.lastEffectiveAgentConversationActivityObservation !== undefined
			? {
					lastEffectiveAgentConversationActivityObservation:
						sessionFacts.lastEffectiveAgentConversationActivityObservation,
				}
			: {}),
		...(sessionFacts?.lastAgentConversationUserHandoffObservation !== undefined
			? { lastAgentConversationUserHandoffObservation: sessionFacts.lastAgentConversationUserHandoffObservation }
			: {}),
		...(sessionFacts?.lastAgentConversationPromptCacheReferenceObservation !== undefined
			? {
					lastAgentConversationPromptCacheReferenceObservation:
						sessionFacts.lastAgentConversationPromptCacheReferenceObservation,
				}
			: {}),
		...(sessionFacts?.agentConversationPromptSubmissionAcceptance !== undefined
			? { agentConversationPromptSubmissionAcceptance: sessionFacts.agentConversationPromptSubmissionAcceptance }
			: {}),
		agentId: sessionFacts?.agentId ?? card.agentId ?? null,
		createdAt: card.createdAt,
		lastOutputAt: sessionFacts?.lastOutputAt ?? null,
		lastSubstantiveOutputAt: sessionFacts?.lastSubstantiveOutputAt ?? null,
		// 下列旧字段仅供兼容读取；新消费者优先读取上面的统一活动与历史交棒。
		// 新字段显式 null 表示已清空，必须保留，不能通过省略字段重新启用旧值回退。
		agentResponseGenerationStopped: sessionFacts?.agentResponseGenerationStopped ?? null,
		lastConversationProgressObservation: sessionFacts?.lastConversationProgressObservation ?? null,
		agentResponseGenerationTurnStarted: sessionFacts?.agentResponseGenerationTurnStarted ?? null,
		turnOwner: sessionFacts?.turnOwner ?? null,
		liveness: sessionFacts?.liveness ?? "none",
	};
}

// 把 board `in_progress` 列的全部 task 投影为精简明细（现供顶栏项目切换器数 live agent）。按「列归属」判定成员——
// in_progress 列有几张卡就出几条，awaiting_review / interrupted 的卡也一并保留（**不**套用主看板的 live-session
// overlay）。原消费者 Stage-First Overview 已退役（ADR-0001，已 Superseded）。
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
		buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(
			card,
			resolveCurrentMainConversationTaskSessionFactsWithVerifiedCardOwnership(card, sessionFactsByTaskId),
		),
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
