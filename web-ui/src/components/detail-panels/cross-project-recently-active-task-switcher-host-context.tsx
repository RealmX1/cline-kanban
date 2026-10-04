import { createContext, useContext } from "react";
import type { RuntimeNotificationFeedEntry, RuntimeProjectSummary } from "@/runtime/types";

/**
 * 跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）从 App 组合根拿的东西。
 *
 * 用 context 而不是沿 `CardDetailView → ColumnContextPanel` 逐层透传：面板只依赖全局数据（projects 广播、
 * 通知日志）与几个跨项目动作，和详情页本身的几十个 props 无关；而且跨项目跳转在途时它还要在详情页之外
 * 渲染（见 FocusViewCrossProjectTaskOpenInTransitShell），两处宿主读同一份。
 */
export interface CrossProjectRecentlyActiveTaskSwitcherHostContextValue {
	projects: RuntimeProjectSummary[];
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	currentProjectId: string | null;
	// 顶栏项目切换器选中了 Board Scope（All projects）：Focus View 左栏显示本面板而不是当前项目的 stage 列表。
	// 范围只有一份状态，由 App 持有（use-selected-board-or-single-project-scope）。
	isBoardScopeAllProjectsSelected: boolean;
	// Focus View 此刻对准的任务：当前项目里选中的卡，或跨项目跳转在途的目标。行高亮据此判断。
	focusedTaskInProject: { workspaceId: string; taskId: string } | null;
	// 同项目直接选中；跨项目先切 workspace，目标 board 加载出该任务后再打开（App 的 pendingCrossProjectTaskOpen）。
	onOpenTaskInProject: (workspaceId: string, taskId: string) => void;
	// 当前项目的卡沿用浏览器既有链路（打开置顶原因对话框 → setBoard → saveState）；其他项目的卡由面板自己走
	// runtime 的 setTaskPinboardPinStateOfTaskCard。两条路改写的是同一组纯函数（src/core/task-pinboard-pinning.ts）。
	onRequestPinCurrentProjectTaskToTaskPinboard: (taskId: string) => void;
	onUnpinCurrentProjectTaskFromTaskPinboard: (taskId: string) => void;
	onEditCurrentProjectTaskPinboardPinReason: (taskId: string) => void;
}

const CrossProjectRecentlyActiveTaskSwitcherHostContext =
	createContext<CrossProjectRecentlyActiveTaskSwitcherHostContextValue | null>(null);

export const CrossProjectRecentlyActiveTaskSwitcherHostContextProvider =
	CrossProjectRecentlyActiveTaskSwitcherHostContext.Provider;

// null = 没有宿主（单测 / 独立挂载的 ColumnContextPanel）：左栏只有当前项目的 stage 列表。
export function useCrossProjectRecentlyActiveTaskSwitcherHostContext(): CrossProjectRecentlyActiveTaskSwitcherHostContextValue | null {
	return useContext(CrossProjectRecentlyActiveTaskSwitcherHostContext);
}
