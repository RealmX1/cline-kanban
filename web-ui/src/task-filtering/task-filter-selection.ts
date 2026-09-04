import {
	isAwaitingUserReviewTurn,
	isParkedAwaitingDispatchedBackgroundWork,
	resolveSessionFacets,
} from "@runtime-session-activity";

import { isCardCreditLimitError } from "@/components/board-card-session-activity";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

/**
 * 「按多个分类维度过滤任务」的选择状态 —— **与界面无关**：它不知道自己是被 Spotlight 弹层、看板顶栏
 * 还是别的什么面板消费的，也不含任何 React 依赖。想把同一套过滤搬到主看板时，搬的是 selection +
 * apply-task-filter-selection + task-filter-controls 这三件，而不是再抄一遍判据。
 *
 * ⚠️ 全维度统一约定：**空集合 = 该维度不设约束**（不是「什么都不匹配」）。
 * 五个维度共用同一条约定，才不会出现「stage 空集是全选、agent 空集是全不选」这种记不住的分歧。
 * 顺带的一处既有行为变化：从前 Spotlight 的 stage chips 默认 5 个全亮、全部取消勾选等于「不显示任何结果」；
 * 现在默认 5 个全不亮（= 不按 stage 收窄），取消勾选到空集也等于「不按 stage 收窄」。
 * 「一个结果都不要」不是有用的状态，不值得为它保留一条相反的约定。
 */
export interface TaskFilterSelection {
	/** 空 = 不按 stage 收窄。 */
	selectedStageColumnIds: ReadonlySet<BoardColumnId>;
	/** 空 = 不按项目收窄。跨项目搜索关闭时这一维度只有当前项目一个可选值，控件应自行隐藏。 */
	selectedProjectIds: ReadonlySet<string>;
	/** 空 = 不按 agent 收窄。agent 未知（null）的任务在本维度启用后一律落选——它匹配不上任何被选中的 agent。 */
	selectedAgentIds: ReadonlySet<RuntimeAgentId>;
	/** 空 = 不按会话状态收窄。**只对当前项目可判**，见 applyTaskFilterSelection 的说明。 */
	selectedSessionActivityCategories: ReadonlySet<TaskSessionActivityFilterCategory>;
	/** 「上次修改」时间窗；`any` = 不按时间收窄。 */
	lastModifiedWindow: TaskLastModifiedFilterWindow;
}

// ── 会话状态维度 ──────────────────────────────────────────────────────────────────────────
// 分类刻意与卡片上那颗状态点讲的是同一件事（board-card-session-activity 的派生），只是粗到「可以拿来过滤」
// 的粒度：用户想找的是「哪些任务在等我」「哪些还在跑」，不是逐条工具调用文案。
export const TASK_SESSION_ACTIVITY_FILTER_CATEGORIES = [
	"agent_running",
	"awaiting_your_input",
	"awaiting_your_review",
	"parked_awaiting_dispatched_background_work",
	"errored_or_out_of_credits",
	"no_live_session",
] as const;

export type TaskSessionActivityFilterCategory = (typeof TASK_SESSION_ACTIVITY_FILTER_CATEGORIES)[number];

export const TASK_SESSION_ACTIVITY_FILTER_CATEGORY_LABELS: Readonly<Record<TaskSessionActivityFilterCategory, string>> =
	{
		agent_running: "Agent running",
		awaiting_your_input: "Needs your input",
		awaiting_your_review: "Awaiting review",
		parked_awaiting_dispatched_background_work: "Parked",
		errored_or_out_of_credits: "Error / out of credits",
		no_live_session: "No session",
	};

/**
 * 把一条会话摘要归到一个过滤分类。判定次序即优先级，且刻意与卡片状态点的派生同序：
 * 额度/错误 > park > 等人（再按 userTurnKind 二分「等你动手」还是「等你审」）> agent 在跑 > 无会话。
 *
 * `summary` 为 null/undefined 或是一条「从未启动过」的占位摘要 ⇒ `no_live_session`。
 */
export function deriveTaskSessionActivityFilterCategory(
	summary: RuntimeTaskSessionSummary | null | undefined,
): TaskSessionActivityFilterCategory {
	if (!summary) {
		return "no_live_session";
	}
	if (isCardCreditLimitError(summary)) {
		return "errored_or_out_of_credits";
	}
	if (isParkedAwaitingDispatchedBackgroundWork(summary)) {
		return "parked_awaiting_dispatched_background_work";
	}
	const facets = resolveSessionFacets(summary);
	if (facets.turnOwner === "user" && facets.liveness === "failed") {
		return "errored_or_out_of_credits";
	}
	if (isAwaitingUserReviewTurn(facets)) {
		if (facets.userTurnKind === "error") {
			return "errored_or_out_of_credits";
		}
		// review = agent 自然完工、被动等人看一眼；其余（needs_input / question / plan_review / permission）
		// 都是「卡住了，非你动手不可」——这正是用户过滤时最想先捞出来的一类，不能与被动待审混为一谈。
		return facets.userTurnKind === "review" ? "awaiting_your_review" : "awaiting_your_input";
	}
	if (facets.turnOwner === "agent") {
		return "agent_running";
	}
	return "no_live_session";
}

// ── 「上次修改」时间窗维度 ────────────────────────────────────────────────────────────────
// 作用于卡片的 updatedAt（建卡 / 跨列移动 / 用户编辑），**不是** agent 活跃时间。
export const TASK_LAST_MODIFIED_FILTER_WINDOWS = ["any", "past_24_hours", "past_7_days", "past_30_days"] as const;

export type TaskLastModifiedFilterWindow = (typeof TASK_LAST_MODIFIED_FILTER_WINDOWS)[number];

export const TASK_LAST_MODIFIED_FILTER_WINDOW_LABELS: Readonly<Record<TaskLastModifiedFilterWindow, string>> = {
	any: "Any time",
	past_24_hours: "24h",
	past_7_days: "7d",
	past_30_days: "30d",
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function resolveTaskLastModifiedFilterWindowDurationMs(window: TaskLastModifiedFilterWindow): number | null {
	switch (window) {
		case "past_24_hours":
			return DAY_MS;
		case "past_7_days":
			return 7 * DAY_MS;
		case "past_30_days":
			return 30 * DAY_MS;
		default:
			return null;
	}
}

// ── 默认值与归一 ─────────────────────────────────────────────────────────────────────────

const EMPTY_STAGE_COLUMN_IDS: ReadonlySet<BoardColumnId> = new Set<BoardColumnId>();
const EMPTY_PROJECT_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_AGENT_IDS: ReadonlySet<RuntimeAgentId> = new Set<RuntimeAgentId>();
const EMPTY_SESSION_ACTIVITY_CATEGORIES: ReadonlySet<TaskSessionActivityFilterCategory> =
	new Set<TaskSessionActivityFilterCategory>();

/** 全维度都不设约束。 */
export const EMPTY_TASK_FILTER_SELECTION: TaskFilterSelection = {
	selectedStageColumnIds: EMPTY_STAGE_COLUMN_IDS,
	selectedProjectIds: EMPTY_PROJECT_IDS,
	selectedAgentIds: EMPTY_AGENT_IDS,
	selectedSessionActivityCategories: EMPTY_SESSION_ACTIVITY_CATEGORIES,
	lastModifiedWindow: "any",
};

export function isEmptyTaskFilterSelection(selection: TaskFilterSelection): boolean {
	return (
		selection.selectedStageColumnIds.size === 0 &&
		selection.selectedProjectIds.size === 0 &&
		selection.selectedAgentIds.size === 0 &&
		selection.selectedSessionActivityCategories.size === 0 &&
		selection.lastModifiedWindow === "any"
	);
}

export function countActiveTaskFilterDimensions(selection: TaskFilterSelection): number {
	let activeDimensionCount = 0;
	if (selection.selectedStageColumnIds.size > 0) {
		activeDimensionCount += 1;
	}
	if (selection.selectedProjectIds.size > 0) {
		activeDimensionCount += 1;
	}
	if (selection.selectedAgentIds.size > 0) {
		activeDimensionCount += 1;
	}
	if (selection.selectedSessionActivityCategories.size > 0) {
		activeDimensionCount += 1;
	}
	if (selection.lastModifiedWindow !== "any") {
		activeDimensionCount += 1;
	}
	return activeDimensionCount;
}

/** 四个集合维度的字段名。时间窗维度不在其中——它是单选枚举，不参与「切换成员」。 */
export type TaskFilterSetDimensionKey =
	| "selectedStageColumnIds"
	| "selectedProjectIds"
	| "selectedAgentIds"
	| "selectedSessionActivityCategories";

/** 在一个集合维度上切换某个取值（不可变返回新 selection）。 */
export function toggleTaskFilterSelectionSetMember(
	selection: TaskFilterSelection,
	dimension: TaskFilterSetDimensionKey,
	member: string,
): TaskFilterSelection {
	const currentMembers = selection[dimension] as ReadonlySet<string>;
	const nextMembers = new Set(currentMembers);
	if (nextMembers.has(member)) {
		nextMembers.delete(member);
	} else {
		nextMembers.add(member);
	}
	return { ...selection, [dimension]: nextMembers };
}

// ── 「已选中但当前可选集里已经没有它了」──────────────────────────────────────────────────────
// 集合维度的可选集是从当前这批数据派生的，会常规地缩小（关掉「包含其它项目」、某个 agent 不再出现在任何
// 任务上……）。selection 不跟着缩——约束依旧生效。若控件只渲染可选集里的取值，就会出现
// 「角标说有 1 个维度在生效、浮层里却找不到任何可点掉的 chip」，用户只能靠 Clear all filters 盲解。
// 因此控件渲染集合维度时不直接遍历可选集，而是遍历下面这个合并结果：可选集 + 追加在末尾的「已选中但
// 当前不可得」成员（弱化显示、照样可点掉）。选择保留而非剪掉，是因为剪掉等于静默改写用户设过的过滤，
// 且来回切「包含其它项目」会反复丢设置；渲染一个筛不出东西的 chip 是把真实状态摆出来，更诚实。

/** 控件渲染一个集合维度时实际要摆出的一项。 */
export interface TaskFilterDimensionRenderableOption<TValue extends string> {
	value: TValue;
	/** 当前可选集里有它时用可选集给的 label；已不可得时只剩取值本身可用（label 随数据一起没了）。 */
	label: string;
	/** true = 约束仍在生效，但当前这批数据里已经没有这个取值，它此刻筛不出任何东西。 */
	isSelectedButNoLongerAvailable: boolean;
}

/**
 * 把一个集合维度的「当前可选集」与「已选中但当前不可得的成员」合并成控件要渲染的选项列表。
 * 纯函数，可选集内部原有顺序保留，不可得成员按 selection 的迭代序追加在末尾。
 */
export function resolveTaskFilterDimensionRenderableOptions<TValue extends string>(
	availableOptions: ReadonlyArray<{ value: TValue; label: string }>,
	selectedMembers: ReadonlySet<TValue>,
): TaskFilterDimensionRenderableOption<TValue>[] {
	const renderableOptions = availableOptions.map((option) => ({
		value: option.value,
		label: option.label,
		isSelectedButNoLongerAvailable: false,
	}));
	if (selectedMembers.size === 0) {
		return renderableOptions;
	}
	const availableOptionValues = new Set(availableOptions.map((option) => option.value));
	for (const selectedMember of selectedMembers) {
		if (!availableOptionValues.has(selectedMember)) {
			renderableOptions.push({
				value: selectedMember,
				label: selectedMember,
				isSelectedButNoLongerAvailable: true,
			});
		}
	}
	return renderableOptions;
}
