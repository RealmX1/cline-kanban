import type { TaskBoardSearchDocument, TaskBoardSearchResult } from "@/search/task-board-search";

/**
 * 结果排序档。四档的可比性刻意不同，档名与展示文案都按「这个数到底是什么」来定，不写成笼统的「最近」：
 *
 * - `relevance`                        —— 各搜索模式自己的排序（direct 位置规则 / fzf 分数 / 语义分数），跨模式不可比。
 * - `task_last_modified_at_desc`       —— 卡片的 `updatedAt`：建卡 / 跨列移动 / 用户编辑才 bump。**不是** agent 活跃时间。
 * - `task_created_at_desc`             —— 卡片的 `createdAt`。
 * - `agent_conversation_progress_desc` —— 「这个任务的对话上次真正往前走」的观测时刻，只对**当前项目**可得
 *                                         （由 runtime-state-hub 推流的 session summary 携带），跨项目行结构性无值。
 */
export const TASK_SEARCH_RESULT_SORT_ORDERS = [
	"relevance",
	"task_last_modified_at_desc",
	"task_created_at_desc",
	"agent_conversation_progress_desc",
] as const;

export type TaskSearchResultSortOrder = (typeof TASK_SEARCH_RESULT_SORT_ORDERS)[number];

export const DEFAULT_TASK_SEARCH_RESULT_SORT_ORDER: TaskSearchResultSortOrder = "relevance";

/** 空查询浏览态下 `relevance` 没有意义（没有查询串就没有相关度），回落到这一档。 */
export const TASK_SEARCH_RESULT_SORT_ORDER_WHEN_BROWSING_WITHOUT_QUERY: TaskSearchResultSortOrder =
	"task_last_modified_at_desc";

export interface TaskSearchResultSortOrderOption {
	sortOrder: TaskSearchResultSortOrder;
	/** 分段控件上的短标签。 */
	label: string;
	/** 悬停说明：点破这个数究竟是什么，别让用户把「修改」当成「活跃」。 */
	description: string;
}

export const TASK_SEARCH_RESULT_SORT_ORDER_OPTIONS: readonly TaskSearchResultSortOrderOption[] = [
	{
		sortOrder: "relevance",
		label: "Relevance",
		description: "Ranked by the active search mode; browsing with an empty query falls back to Last modified",
	},
	{
		sortOrder: "task_last_modified_at_desc",
		label: "Last modified",
		description: "When the task was created, moved between stages, or edited by you — not agent activity",
	},
	{
		sortOrder: "task_created_at_desc",
		label: "Created",
		description: "When the task was created",
	},
	{
		sortOrder: "agent_conversation_progress_desc",
		label: "Agent activity",
		description: "When the task's conversation last advanced; only known for the current project",
	},
];

export function normalizeTaskSearchResultSortOrder(rawValue: string): TaskSearchResultSortOrder | null {
	return (TASK_SEARCH_RESULT_SORT_ORDERS as readonly string[]).includes(rawValue)
		? (rawValue as TaskSearchResultSortOrder)
		: null;
}

/**
 * 把用户选定的档换算成「这一刻真正生效的档」：空查询浏览时 `relevance` 无从计算，回落到 Last modified。
 * 刻意收在本模块而不是散在组件里——排序与展示两侧都要按同一个「生效档」做判断（例如分段控件要
 * 把回落后的那一档标出来），两处各写一遍必然漂移。
 */
export function resolveEffectiveTaskSearchResultSortOrder(
	selectedSortOrder: TaskSearchResultSortOrder,
	{ isBrowsingWithoutQuery }: { isBrowsingWithoutQuery: boolean },
): TaskSearchResultSortOrder {
	if (isBrowsingWithoutQuery && selectedSortOrder === "relevance") {
		return TASK_SEARCH_RESULT_SORT_ORDER_WHEN_BROWSING_WITHOUT_QUERY;
	}
	return selectedSortOrder;
}

/** 从一篇文档取出该档要比较的时刻；null = 这篇文档在这一档上没有值（只可能出现在 agent 活跃档）。 */
function resolveSortKeyEpochMs(
	document: TaskBoardSearchDocument,
	sortOrder: Exclude<TaskSearchResultSortOrder, "relevance">,
	resolveAgentConversationProgressAtEpochMs: (document: TaskBoardSearchDocument) => number | null,
): number | null {
	if (sortOrder === "task_last_modified_at_desc") {
		return document.taskLastModifiedAtEpochMs;
	}
	if (sortOrder === "task_created_at_desc") {
		return document.taskCreatedAtEpochMs;
	}
	return resolveAgentConversationProgressAtEpochMs(document);
}

/**
 * 按选定档给结果排序。叠在各模式排序**之后**、task id 置顶层**之前**：
 * 粘贴一个 task id（或敲出它的前几位）回车直达的行为不受排序档影响。
 *
 * 三条约束：
 * 1. `relevance` 档**原样返回入参同一引用**（不是浅拷贝）。controller 的 `useEffect([results]) → setActiveIndex(0)`
 *    以引用相等为判据，无谓换引用会让 ↑↓ 导航被反复钉回第 0 行（同 task-id-match-search.ts 的告警）。
 * 2. **无值的行排在最后**，绝不混进有值段——把「没有时间戳」摆进 recency 序列会让它看起来像「很久以前活跃过」，
 *    那是假信息（同 project-switcher-row-ordering.ts 已确立的约定）。
 * 3. 同一时刻的行按**传入顺序**决定先后：传入顺序本身有意义（当前项目在前 → 列顺序 → 卡序，或该模式的相关度序），
 *    靠 Array#sort 的稳定性保证（ES2019 起为规范要求）。
 */
export function sortTaskSearchResults({
	results,
	sortOrder,
	resolveAgentConversationProgressAtEpochMs,
}: {
	results: TaskBoardSearchResult[];
	sortOrder: TaskSearchResultSortOrder;
	resolveAgentConversationProgressAtEpochMs: (document: TaskBoardSearchDocument) => number | null;
}): TaskBoardSearchResult[] {
	if (sortOrder === "relevance") {
		return results;
	}
	// 先一次性取出排序键：agent 活跃档的取值要查会话表，放进比较器会被调用 O(n log n) 次。
	const sortKeyByResult = new Map<TaskBoardSearchResult, number | null>();
	for (const result of results) {
		sortKeyByResult.set(
			result,
			resolveSortKeyEpochMs(result.document, sortOrder, resolveAgentConversationProgressAtEpochMs),
		);
	}
	return [...results].sort((first, second) => {
		const firstSortKey = sortKeyByResult.get(first) ?? null;
		const secondSortKey = sortKeyByResult.get(second) ?? null;
		if (firstSortKey === null && secondSortKey === null) {
			return 0;
		}
		if (firstSortKey === null) {
			return 1;
		}
		if (secondSortKey === null) {
			return -1;
		}
		return secondSortKey - firstSortKey;
	});
}
