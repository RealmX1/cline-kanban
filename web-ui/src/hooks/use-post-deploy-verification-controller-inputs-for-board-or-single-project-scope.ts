import { useCallback, useMemo } from "react";

import type { RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries } from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type { PostDeployVerificationMoveIntoDoneCompletionResult } from "@/hooks/use-board-interactions";
import type { UsePostDeployVerificationForBoardOrSingleProjectScopeResult } from "@/hooks/use-post-deploy-verification-for-board-or-single-project-scope";
import type { SelectedBoardOrSingleProjectScope } from "@/hooks/use-selected-board-or-single-project-scope";
import type {
	RuntimeAgentId,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeProjectSummary,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser } from "@/state/post-deploy-verification-panel-completion-move-into-done-for-workspace-board-not-hydrated-in-browser";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

type CompletePostDeployVerificationMoveToDone = (
	taskId: string,
	fromColumnId: BoardColumnId,
	postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
) => Promise<PostDeployVerificationMoveIntoDoneCompletionResult>;

export interface PostDeployVerificationControllerInputsForBoardOrSingleProjectScope {
	// null = 面板该读的 board 还没有（快照尚未读到 / 没有 PDV workspace）：此时不挂 controller，免得条目全显示「已从看板删除」。
	boardShownInPostDeployVerificationPanel: BoardData | null;
	completePostDeployVerificationMoveToDone: CompletePostDeployVerificationMoveToDone;
	onSelectTaskInPostDeployVerificationPanel: (taskId: string) => void;
	realTaskCardRenderingInputsForPostDeployVerificationPanelEntries: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	// 只在 All projects 下给：面板内容不跟随当前项目，标题栏得说明看的是哪个项目。
	postDeployVerificationWorkspaceProjectNameShownInPanelHeader: string | null;
}

/**
 * PDV 面板 controller 的各项输入，按面板的 board 来源分两路：
 *   - 浏览器里当前项目的 board：与改动前一样——displayedBoard、useBoardInteractions 的移列、主看板同一组卡片动作；
 *   - runtime 快照：快照 board、经服务端复检列的移列（完成后重读快照）、只读展示的卡体（Done 按钮走条目自己的完成核对，
 *     点卡在它所属的项目里打开）。
 * 单项目范围点条目仍是 setSelectedTaskId；All projects 下一律经「在某个项目里打开某个任务」的统一入口。
 */
export function usePostDeployVerificationControllerInputsForBoardOrSingleProjectScope(input: {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	postDeployVerificationForBoardOrSingleProjectScope: UsePostDeployVerificationForBoardOrSingleProjectScopeResult;
	projects: readonly RuntimeProjectSummary[];
	currentProjectDisplayedBoard: BoardData;
	currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectWorkspacePath: string | null;
	completeCurrentProjectPostDeployVerificationMoveToDone: CompletePostDeployVerificationMoveToDone;
	setSelectedTaskId: (taskId: string | null) => void;
	handleCardSelect: (taskId: string) => void;
	handleOpenTaskInProject: (repoId: string, taskId: string) => void;
	defaultAgentIdOfCurrentProject: RuntimeAgentId | null;
	defaultClineModelIdOfCurrentProject: string | null;
	// 主看板同一组 handler（参照 Focus View column-context-panel），条目上的「移入 Done」因此同样过门禁。
	resolveTaskWorkspaceAbsoluteDirectoryPath: TaskCardActionHandlerBundle["resolveTaskWorkspaceAbsoluteDirectoryPath"];
	onStartTask: (taskId: string) => void;
	onMoveToTrashTask: (taskId: string) => void;
	onMoveToValidationTask: (taskId: string) => void;
	onMoveToReviewTask: (taskId: string) => void;
	onRestoreFromTrashTask: (taskId: string) => void;
	onDeleteTask: (taskId: string) => void;
	onCancelAutomaticTaskAction: (taskId: string) => void;
	onSaveTitle: (taskId: string, title: string) => void;
	onEditTask: (card: BoardCard) => void;
	onRequestPinToTaskPinboard: (taskId: string) => void;
	onUnpinFromTaskPinboard: (taskId: string) => void;
	moveToTrashLoadingById: Record<string, boolean>;
	moveToReviewLoadingById: Record<string, boolean>;
}): PostDeployVerificationControllerInputsForBoardOrSingleProjectScope {
	const {
		selectedBoardOrSingleProjectScope,
		postDeployVerificationForBoardOrSingleProjectScope,
		currentProjectDisplayedBoard,
		currentProjectTaskSessions,
		currentProjectWorkspacePath,
		completeCurrentProjectPostDeployVerificationMoveToDone,
		setSelectedTaskId,
		handleCardSelect,
		handleOpenTaskInProject,
		defaultAgentIdOfCurrentProject,
		defaultClineModelIdOfCurrentProject,
		resolveTaskWorkspaceAbsoluteDirectoryPath,
		onStartTask,
		onMoveToTrashTask,
		onMoveToValidationTask,
		onMoveToReviewTask,
		onRestoreFromTrashTask,
		onDeleteTask,
		onCancelAutomaticTaskAction,
		onSaveTitle,
		onEditTask,
		onRequestPinToTaskPinboard,
		onUnpinFromTaskPinboard,
		moveToTrashLoadingById,
		moveToReviewLoadingById,
	} = input;
	const {
		postDeployVerificationWorkspaceId,
		postDeployVerificationPanelTaskCardBoardSource,
		runtimeBoardSnapshotOfPostDeployVerificationWorkspace,
		refetchRuntimeBoardSnapshotOfPostDeployVerificationWorkspace,
	} = postDeployVerificationForBoardOrSingleProjectScope;
	const isBoardScopeAllProjectsSelected = selectedBoardOrSingleProjectScope === "board_scope_all_projects";
	const boardSourceKind =
		postDeployVerificationPanelTaskCardBoardSource.postDeployVerificationPanelTaskCardBoardSourceKind;

	const openTaskOfPostDeployVerificationWorkspaceInItsProject = useCallback(
		(taskId: string) => {
			if (postDeployVerificationWorkspaceId !== null) {
				handleOpenTaskInProject(postDeployVerificationWorkspaceId, taskId);
			}
		},
		[handleOpenTaskInProject, postDeployVerificationWorkspaceId],
	);

	const completeRuntimeBoardSnapshotPostDeployVerificationMoveToDone =
		useCallback<CompletePostDeployVerificationMoveToDone>(
			async (
				taskId,
				fromColumnId,
				postDeployVerificationDoneEntryClosure,
				taskCommentToAppendWhenMovingIntoDone,
			) => {
				if (postDeployVerificationWorkspaceId === null) {
					return { ok: false, moveIntoDoneFailureMessage: "没有可核对的项目" };
				}
				const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
					workspaceId: postDeployVerificationWorkspaceId,
					taskId,
					boardColumnIdObservedInBoardSnapshot: fromColumnId,
					...(taskCommentToAppendWhenMovingIntoDone ? { taskCommentToAppendWhenMovingIntoDone } : {}),
					...(postDeployVerificationDoneEntryClosure ? { postDeployVerificationDoneEntryClosure } : {}),
				});
				// 不论成败都重读：失败多半是列已变化，面板要显示新列。
				refetchRuntimeBoardSnapshotOfPostDeployVerificationWorkspace();
				return result;
			},
			[postDeployVerificationWorkspaceId, refetchRuntimeBoardSnapshotOfPostDeployVerificationWorkspace],
		);

	const realTaskCardRenderingInputsForPostDeployVerificationPanelEntries =
		useMemo((): RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null => {
			if (boardSourceKind === "runtime_board_snapshot_of_workspace_not_hydrated_in_browser") {
				if (!runtimeBoardSnapshotOfPostDeployVerificationWorkspace) {
					return null;
				}
				return {
					realTaskCardRenderingInputsBoardSourceKind:
						"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
					workspaceIdOwningRuntimeBoardSnapshot:
						runtimeBoardSnapshotOfPostDeployVerificationWorkspace.workspaceIdOwningRuntimeBoardSnapshot,
					taskSessionsFromRuntimeBoardSnapshot:
						runtimeBoardSnapshotOfPostDeployVerificationWorkspace.taskSessionsReadFromRuntime,
					workspacePathOwningRuntimeBoardSnapshot:
						runtimeBoardSnapshotOfPostDeployVerificationWorkspace.workspacePathReadFromRuntime,
					onActivateTaskCardOpeningTaskInItsProject: (card) =>
						openTaskOfPostDeployVerificationWorkspaceInItsProject(card.id),
					// All projects 首页的跨项目卡也用当前项目的默认值（其他项目的设置不在浏览器里）。
					defaultAgentId: defaultAgentIdOfCurrentProject,
					defaultClineModelId: defaultClineModelIdOfCurrentProject,
				};
			}
			return {
				realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser",
				currentProjectTaskSessions,
				currentProjectTaskCardActionHandlers: {
					resolveTaskWorkspaceAbsoluteDirectoryPath,
					onStartTask,
					onMoveToTrashTask,
					onMoveToValidationTask,
					onMoveToReviewTask,
					onRestoreFromTrashTask,
					onDeleteTask,
					onCancelAutomaticTaskAction,
					onSaveTitle,
					onEditTask,
					onRequestPinToTaskPinboard,
					onUnpinFromTaskPinboard,
					moveToTrashLoadingById,
					moveToReviewLoadingById,
				},
				currentProjectWorkspacePath,
				onActivateTaskCardOpeningTaskDetail: (card) => handleCardSelect(card.id),
				defaultAgentId: defaultAgentIdOfCurrentProject,
				defaultClineModelId: defaultClineModelIdOfCurrentProject,
			};
		}, [
			boardSourceKind,
			currentProjectTaskSessions,
			currentProjectWorkspacePath,
			defaultAgentIdOfCurrentProject,
			defaultClineModelIdOfCurrentProject,
			handleCardSelect,
			moveToReviewLoadingById,
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
			openTaskOfPostDeployVerificationWorkspaceInItsProject,
			resolveTaskWorkspaceAbsoluteDirectoryPath,
			runtimeBoardSnapshotOfPostDeployVerificationWorkspace,
		]);

	const isReadingRuntimeBoardSnapshot =
		boardSourceKind === "runtime_board_snapshot_of_workspace_not_hydrated_in_browser";
	return {
		boardShownInPostDeployVerificationPanel:
			boardSourceKind === "no_post_deploy_verification_workspace"
				? null
				: isReadingRuntimeBoardSnapshot
					? (runtimeBoardSnapshotOfPostDeployVerificationWorkspace?.boardReadFromRuntime ?? null)
					: currentProjectDisplayedBoard,
		completePostDeployVerificationMoveToDone: isReadingRuntimeBoardSnapshot
			? completeRuntimeBoardSnapshotPostDeployVerificationMoveToDone
			: completeCurrentProjectPostDeployVerificationMoveToDone,
		onSelectTaskInPostDeployVerificationPanel: isBoardScopeAllProjectsSelected
			? openTaskOfPostDeployVerificationWorkspaceInItsProject
			: setSelectedTaskId,
		realTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
		postDeployVerificationWorkspaceProjectNameShownInPanelHeader: isBoardScopeAllProjectsSelected
			? (input.projects.find((project) => project.id === postDeployVerificationWorkspaceId)?.name ?? null)
			: null,
	};
}
