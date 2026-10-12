import type { RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse } from "@/runtime/types";

/**
 * 跨项目切换面板（docs/context-cross-project-recently-active-task-switcher.md）的临时视图状态的进程内记忆。
 *
 * 存在理由：一次跨项目打开里，面板会在「Focus View 左栏 → 过渡外壳 → 新任务的 Focus View 左栏」之间重挂载两次
 * （三处是不同的组件树）。只放组件 state 的话，每次重挂载都把滚动位置、「展开全部置顶」、「显示更早」已拉回的
 * 旧任务一起丢掉——用户眼里就是左栏在切换中整个跳回顶部、收起。同一时刻只会挂着一个面板实例，所以不需要订阅，
 * 挂载时读、变化时写即可。
 *
 * 刻意不落 localStorage：这是同一次浏览会话内的导航连续性，不是需要跨会话保留的偏好（那些已经各有 key）。
 */
export interface CrossProjectTaskSwitcherPanelViewContinuityRecord {
	panelScrollTopPx: number;
	showsAllPinnedEntries: boolean;
	// 「显示更早」拉回的快照；null = 没展开（默认 7 天窗）。
	entriesWithinExtendedActivityHorizon: RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse | null;
	// 用户点了「Keep expanded in list」、在列表里原地换成完整卡片的行（buildCrossProjectTaskSwitcherEntryKey 复合键）。
	// 同一个任务在 Pinned 与下方区各有一行，按任务记而不是按行记：一处固定展开，两处一起换。
	// 只存在进程内（按标签页隔离、刷新即清），不进 localStorage。
	crossProjectTaskSwitcherEntryKeysKeptExpandedInListAsFullTaskCardByUser: readonly string[];
}

const INITIAL_CROSS_PROJECT_TASK_SWITCHER_PANEL_VIEW_CONTINUITY_RECORD: CrossProjectTaskSwitcherPanelViewContinuityRecord =
	{
		panelScrollTopPx: 0,
		showsAllPinnedEntries: false,
		entriesWithinExtendedActivityHorizon: null,
		crossProjectTaskSwitcherEntryKeysKeptExpandedInListAsFullTaskCardByUser: [],
	};

let crossProjectTaskSwitcherPanelViewContinuityRecord =
	INITIAL_CROSS_PROJECT_TASK_SWITCHER_PANEL_VIEW_CONTINUITY_RECORD;

export function readCrossProjectTaskSwitcherPanelViewContinuity(): CrossProjectTaskSwitcherPanelViewContinuityRecord {
	return crossProjectTaskSwitcherPanelViewContinuityRecord;
}

export function writeCrossProjectTaskSwitcherPanelViewContinuity(
	patch: Partial<CrossProjectTaskSwitcherPanelViewContinuityRecord>,
): void {
	// 损坏的滚动值一旦入记忆，重挂载时会被原样还原回 DOM，直接拒写。
	if (
		patch.panelScrollTopPx !== undefined &&
		(!Number.isFinite(patch.panelScrollTopPx) || patch.panelScrollTopPx < 0)
	) {
		return;
	}
	crossProjectTaskSwitcherPanelViewContinuityRecord = {
		...crossProjectTaskSwitcherPanelViewContinuityRecord,
		...patch,
	};
}

/** 测试用：回到初始记忆。 */
export function resetCrossProjectTaskSwitcherPanelViewContinuity(): void {
	crossProjectTaskSwitcherPanelViewContinuityRecord = INITIAL_CROSS_PROJECT_TASK_SWITCHER_PANEL_VIEW_CONTINUITY_RECORD;
}
