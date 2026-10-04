import { useMemo } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import type { PendingCrossProjectTaskOpen } from "@/hooks/use-cross-project-task-open-in-project";
import type { RuntimeNotificationFeedEntry, RuntimeProjectSummary } from "@/runtime/types";

/**
 * 组装跨项目「最近活跃任务」切换面板的宿主值（docs/context-cross-project-recently-active-task-switcher.md），
 * 并给出「跨项目跳转在途、要不要渲染 Focus View 过渡外壳」及外壳上显示的目标。
 */
export function useCrossProjectRecentlyActiveTaskSwitcherHost({
	projects,
	notificationLogByWorkspaceId,
	currentProjectId,
	isBoardScopeAllProjectsSelected,
	selectedCardTaskId,
	pendingCrossProjectTaskOpen,
	onOpenTaskInProject,
	onRequestPinCurrentProjectTaskToTaskPinboard,
	onUnpinCurrentProjectTaskFromTaskPinboard,
	onEditCurrentProjectTaskPinboardPinReason,
}: {
	projects: RuntimeProjectSummary[];
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	currentProjectId: string | null;
	isBoardScopeAllProjectsSelected: boolean;
	selectedCardTaskId: string | null;
	pendingCrossProjectTaskOpen: PendingCrossProjectTaskOpen | null;
	onOpenTaskInProject: (workspaceId: string, taskId: string) => void;
	onRequestPinCurrentProjectTaskToTaskPinboard: (taskId: string) => void;
	onUnpinCurrentProjectTaskFromTaskPinboard: (taskId: string) => void;
	onEditCurrentProjectTaskPinboardPinReason: (taskId: string) => void;
}): {
	crossProjectRecentlyActiveTaskSwitcherHost: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	isFocusViewCrossProjectTaskOpenInTransit: boolean;
	crossProjectTaskOpenInTransitTarget: { projectName: string | null; taskTitle: string | null } | null;
} {
	const crossProjectRecentlyActiveTaskSwitcherHost = useMemo<CrossProjectRecentlyActiveTaskSwitcherHostContextValue>(
		() => ({
			projects,
			notificationLogByWorkspaceId,
			currentProjectId,
			isBoardScopeAllProjectsSelected,
			focusedTaskInProject: pendingCrossProjectTaskOpen
				? { workspaceId: pendingCrossProjectTaskOpen.repoId, taskId: pendingCrossProjectTaskOpen.taskId }
				: currentProjectId && selectedCardTaskId
					? { workspaceId: currentProjectId, taskId: selectedCardTaskId }
					: null,
			onOpenTaskInProject,
			onRequestPinCurrentProjectTaskToTaskPinboard,
			onUnpinCurrentProjectTaskFromTaskPinboard,
			onEditCurrentProjectTaskPinboardPinReason,
		}),
		[
			currentProjectId,
			isBoardScopeAllProjectsSelected,
			notificationLogByWorkspaceId,
			onEditCurrentProjectTaskPinboardPinReason,
			onOpenTaskInProject,
			onRequestPinCurrentProjectTaskToTaskPinboard,
			onUnpinCurrentProjectTaskFromTaskPinboard,
			pendingCrossProjectTaskOpen,
			projects,
			selectedCardTaskId,
		],
	);
	const crossProjectTaskOpenInTransitTarget = useMemo(() => {
		if (!pendingCrossProjectTaskOpen) {
			return null;
		}
		const targetProject = projects.find((project) => project.id === pendingCrossProjectTaskOpen.repoId) ?? null;
		const targetEntry =
			targetProject?.crossProjectTaskSwitcherEntries.find(
				(entry) => entry.taskId === pendingCrossProjectTaskOpen.taskId,
			) ?? null;
		return { projectName: targetProject?.name ?? null, taskTitle: targetEntry?.title ?? null };
	}, [pendingCrossProjectTaskOpen, projects]);
	return {
		crossProjectRecentlyActiveTaskSwitcherHost,
		// 从 Focus View 发起的跨项目打开，在途全程都渲染过渡外壳、不渲染详情页。不能等详情页因切项目关掉再出现：
		// 切项目开始时 board 不清空，详情页会撑过整个 WS 重连、一点点掉内容，快照到达那一帧还会拿上一个
		// 项目的卡配新项目的 workspaceId 去挂终端。
		isFocusViewCrossProjectTaskOpenInTransit: pendingCrossProjectTaskOpen?.originatedFromFocusView === true,
		crossProjectTaskOpenInTransitTarget,
	};
}
