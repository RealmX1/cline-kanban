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
		// 只有从 Focus View 发起、且详情页因切项目已关掉时才渲染过渡外壳。
		isFocusViewCrossProjectTaskOpenInTransit:
			selectedCardTaskId === null && pendingCrossProjectTaskOpen?.originatedFromFocusView === true,
		crossProjectTaskOpenInTransitTarget,
	};
}
