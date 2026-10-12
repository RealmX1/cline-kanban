import { useMemo } from "react";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardData } from "@/types";

/**
 * All projects 首页分区列看板里，当前项目的行展开成完整卡片时用的数据与动作：与主看板（KanbanBoard）同一份
 * 带 overlay 的 board、推流的 session 与同一组 handler，和 Focus View 左栏的 ColumnContextPanel 同构。
 * 这样当前项目的卡走浏览器既有链路（带 overlay），不经 runtime 命令改写本页持有的 board。
 *
 * board 还不是当前项目的数据（切项目途中）时给 null：当前项目的行改读服务端，免得拿上一个项目的 board 找卡。
 */
export function useCurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansionOnBoardScopeHomePage({
	isDisplayedBoardHydratedForCurrentProject,
	currentProjectDisplayedBoard,
	currentProjectTaskSessions,
	currentProjectWorkspacePath,
	resolveTaskWorkspaceAbsoluteDirectoryPath,
	onStartTask,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onSaveTitle,
	onEditTask,
	onRequestPinToTaskPinboard,
	onUnpinFromTaskPinboard,
	onCancelAutomaticTaskAction,
	moveToTrashLoadingById,
}: {
	isDisplayedBoardHydratedForCurrentProject: boolean;
	currentProjectDisplayedBoard: BoardData;
	currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectWorkspacePath: string | null;
} & Pick<
	TaskCardActionHandlerBundle,
	| "resolveTaskWorkspaceAbsoluteDirectoryPath"
	| "onStartTask"
	| "onMoveToTrashTask"
	| "onMoveToValidationTask"
	| "onMoveToReviewTask"
	| "onRestoreFromTrashTask"
	| "onDeleteTask"
	| "onSaveTitle"
	| "onEditTask"
	| "onRequestPinToTaskPinboard"
	| "onUnpinFromTaskPinboard"
	| "onCancelAutomaticTaskAction"
	| "moveToTrashLoadingById"
>): CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null {
	return useMemo(
		() =>
			isDisplayedBoardHydratedForCurrentProject
				? {
						currentProjectDisplayedBoard,
						currentProjectTaskSessions,
						currentProjectWorkspacePath,
						currentProjectTaskCardActionHandlers: {
							resolveTaskWorkspaceAbsoluteDirectoryPath,
							onStartTask,
							onMoveToTrashTask,
							onMoveToValidationTask,
							onMoveToReviewTask,
							onRestoreFromTrashTask,
							onDeleteTask,
							onSaveTitle,
							onEditTask,
							onRequestPinToTaskPinboard,
							onUnpinFromTaskPinboard,
							onCancelAutomaticTaskAction,
							moveToTrashLoadingById,
						},
					}
				: null,
		[
			currentProjectDisplayedBoard,
			currentProjectTaskSessions,
			currentProjectWorkspacePath,
			isDisplayedBoardHydratedForCurrentProject,
			moveToTrashLoadingById,
			onCancelAutomaticTaskAction,
			onDeleteTask,
			onEditTask,
			onMoveToReviewTask,
			onMoveToTrashTask,
			onMoveToValidationTask,
			onRequestPinToTaskPinboard,
			onRestoreFromTrashTask,
			onSaveTitle,
			onStartTask,
			onUnpinFromTaskPinboard,
			resolveTaskWorkspaceAbsoluteDirectoryPath,
		],
	);
}
