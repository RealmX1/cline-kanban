import { type ReactElement, useCallback, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { DeleteTaskDialog } from "@/components/delete-task-dialog";
import {
	describePostDeployVerificationDoneEntryGateRejectionForHumans,
	isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import { SkipValidationConfirmDialog } from "@/components/skip-validation-confirm-dialog";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { TaskCommentBeforeMoveIntoDoneDialog } from "@/components/task-comment-before-move-into-done-dialog";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { fetchTaskWorkspaceInfoForWorkspace } from "@/runtime/workspace-state-query";
import type { TaskCardActionCommandExecutionResult } from "@/state/task-card-action-command-execution";
import {
	moveTaskCardBetweenNonTrashColumnsThroughRuntime,
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime,
	moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime,
	permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime,
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime,
	startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime,
	updateTaskCardFieldValuesThroughRuntime,
} from "@/state/task-card-action-commands-for-any-workspace";
import type { TaskCardActionCommandKind } from "@/stores/task-card-action-commands-in-flight-store";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import type { BoardCard, BoardColumnId } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

/**
 * All projects 面板里**其他项目**的卡片动作。与当前项目（use-board-interactions）调的是同一组 `taskCardAction.*`
 * 命令、同样的确认框，差别只有两处：
 *   - 不带 overlay：那个项目的 board 不在浏览器里，结果随 projects_updated 广播与展开行重读回来，期间显示在途 spinner；
 *   - 没有只属于当前项目的手势副作用（选中下一张卡、程序化移列动画、清本地会话摘要）。
 * 失败一律 toast，不切项目。
 */

function reportTaskCardActionCommandFailure(
	failedActionDescription: string,
	result: TaskCardActionCommandExecutionResult<unknown>,
): void {
	if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
		notifyError(`Could not ${failedActionDescription}: ${result.commandFailureMessage}`);
	}
}

interface PendingOtherProjectTaskCardConfirmation {
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	workspaceId: string;
	taskCard: BoardCard;
}

export interface TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher {
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard: (input: {
		workspaceId: string;
		taskCard: BoardCard;
		boardColumnIdContainingTaskCard: BoardColumnId;
		taskCardActionCommandKindInFlight: TaskCardActionCommandKind | null;
	}) => TaskCardActionHandlerBundle;
	otherProjectTaskCardActionConfirmationDialogs: ReactElement;
}

export function useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
	onRequestPinTaskCardInOtherProjectToTaskPinboard,
	onUnpinTaskCardInOtherProjectFromTaskPinboard,
	onRequestEditBacklogTaskCardInOtherProject,
}: {
	onRequestPinTaskCardInOtherProjectToTaskPinboard: (workspaceId: string, taskCard: BoardCard) => void;
	onUnpinTaskCardInOtherProjectFromTaskPinboard: (workspaceId: string, taskId: string) => void;
	onRequestEditBacklogTaskCardInOtherProject?: (workspaceId: string, taskCard: BoardCard) => void;
}): TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher {
	const taskCommentBeforeMoveIntoDone = useTaskCommentBeforeMoveIntoDone();
	const {
		open: openTaskComment,
		complete: completeTaskComment,
		returnToEditing: returnToEditingTaskComment,
		suspendForConfirmation: suspendTaskComment,
		prepareSubmission: prepareTaskComment,
	} = taskCommentBeforeMoveIntoDone;
	const [pendingDeleteConfirmation, setPendingDeleteConfirmation] =
		useState<PendingOtherProjectTaskCardConfirmation | null>(null);
	// 从 Review / In Progress 直接进 Done 会跳过人工 Validation，与当前项目一样先确认。
	const [pendingSkipValidationConfirmation, setPendingSkipValidationConfirmation] =
		useState<PendingOtherProjectTaskCardConfirmation | null>(null);

	const moveTaskCardInOtherProjectIntoDone = useCallback(
		(
			workspaceId: string,
			taskId: string,
			taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
		) => {
			void moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime({
				workspaceId,
				taskId,
				taskCommentToAppendWhenMovingIntoDone,
			}).then((result) => {
				// 其他项目的 PDV 读模型不在这个页面里，没法在这里列出未勾项问原因：受门禁时给一句可读提示，
				// 让用户切到那个项目里带原因移入 Done（当前项目的卡走 use-board-interactions，会直接打开原因对话框）。
				if (
					result.taskCardActionCommandExecutionOutcome === "command_failed" &&
					isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(result.commandFailureMessage)
				) {
					if (taskCommentToAppendWhenMovingIntoDone)
						returnToEditingTaskComment(
							taskId,
							`${describePostDeployVerificationDoneEntryGateRejectionForHumans(result.commandFailureMessage)}——请在该项目里带原因移入 Done。`,
						);
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `${describePostDeployVerificationDoneEntryGateRejectionForHumans(result.commandFailureMessage)}——请在该项目里带原因移入 Done。`,
						timeout: 8000,
					});
					return;
				}
				reportTaskCardActionCommandFailure("move the task to Done", result);
				if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime") {
					if (taskCommentToAppendWhenMovingIntoDone)
						returnToEditingTaskComment(
							taskId,
							result.taskCardActionCommandExecutionOutcome === "command_failed"
								? result.commandFailureMessage
								: "任务另有操作正在进行，请稍后重试。",
						);
					return;
				}
				if (taskCommentToAppendWhenMovingIntoDone)
					completeTaskComment(taskId, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
				const worktreeDeletionErrorMessage =
					result.response.taskWorktreeDeletionResult?.taskWorktreeDeletionErrorMessage ?? null;
				if (worktreeDeletionErrorMessage) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: `Moved to Done, but the task worktree could not be removed: ${worktreeDeletionErrorMessage}`,
						timeout: 7000,
					});
				}
			});
		},
		[completeTaskComment, returnToEditingTaskComment],
	);

	const buildTaskCardActionHandlerBundleForOtherProjectTaskCard = useCallback(
		({
			workspaceId,
			taskCard,
			boardColumnIdContainingTaskCard,
			taskCardActionCommandKindInFlight,
		}: {
			workspaceId: string;
			taskCard: BoardCard;
			boardColumnIdContainingTaskCard: BoardColumnId;
			taskCardActionCommandKindInFlight: TaskCardActionCommandKind | null;
		}): TaskCardActionHandlerBundle => ({
			resolveTaskWorkspaceAbsoluteDirectoryPath: async (card) =>
				(
					await fetchTaskWorkspaceInfoForWorkspace(workspaceId, {
						taskId: card.id,
						baseRef: card.baseRef,
						worktreeMode: card.worktreeMode,
					})
				).path,
			onStartTask: (taskId) => {
				void startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
					workspaceId,
					taskId,
					agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(taskId),
				}).then((result) => reportTaskCardActionCommandFailure("start the task", result));
			},
			onMoveToTrashTask: (taskId, options) => {
				if (options?.requestTaskCommentBeforeMovingIntoDone) {
					openTaskComment(workspaceId, taskCard);
					return;
				}
				if (boardColumnIdContainingTaskCard === "review" || boardColumnIdContainingTaskCard === "in_progress") {
					setPendingSkipValidationConfirmation({ workspaceId, taskCard });
					return;
				}
				moveTaskCardInOtherProjectIntoDone(workspaceId, taskId);
			},
			onMoveToValidationTask: (taskId) => {
				void moveTaskCardBetweenNonTrashColumnsThroughRuntime({
					workspaceId,
					taskId,
					targetBoardColumnId: "validation",
				}).then((result) => reportTaskCardActionCommandFailure("move the task to Validation", result));
			},
			onMoveToReviewTask: (taskId) => {
				void moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime({ workspaceId, taskId }).then((result) =>
					reportTaskCardActionCommandFailure("move the task to Review", result),
				);
			},
			onRestoreFromTrashTask: (taskId) => {
				void restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime({
					workspaceId,
					taskId,
					agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(taskId),
				}).then((result) => reportTaskCardActionCommandFailure("restore the task from Done", result));
			},
			onDeleteTask: () => setPendingDeleteConfirmation({ workspaceId, taskCard }),
			onCancelAutomaticTaskAction: (taskId) => {
				void updateTaskCardFieldValuesThroughRuntime({
					workspaceId,
					taskId,
					taskCardFieldValuePatch: { autoReviewEnabled: false },
				}).then((result) => reportTaskCardActionCommandFailure("cancel the automatic action", result));
			},
			onSaveTitle: (taskId, title) => {
				void updateTaskCardFieldValuesThroughRuntime({
					workspaceId,
					taskId,
					taskCardFieldValuePatch: { title: title.trim() === "" ? null : title },
				}).then((result) => reportTaskCardActionCommandFailure("rename the task", result));
			},
			onEditTask: onRequestEditBacklogTaskCardInOtherProject
				? (card) => onRequestEditBacklogTaskCardInOtherProject(workspaceId, card)
				: undefined,
			onRequestPinToTaskPinboard: () => onRequestPinTaskCardInOtherProjectToTaskPinboard(workspaceId, taskCard),
			onUnpinFromTaskPinboard: (taskId) => onUnpinTaskCardInOtherProjectFromTaskPinboard(workspaceId, taskId),
			moveToTrashLoadingById: {
				[taskCard.id]:
					taskCardActionCommandKindInFlight === "move_task_card_into_done_stopping_sessions_and_deleting_worktree",
			},
			moveToValidationLoadingById: {
				[taskCard.id]:
					taskCardActionCommandKindInFlight ===
					"move_task_card_between_non_trash_columns_without_session_side_effects",
			},
			moveToReviewLoadingById: {
				[taskCard.id]: taskCardActionCommandKindInFlight === "move_task_card_into_review_by_handing_turn_to_user",
			},
		}),
		[
			openTaskComment,
			moveTaskCardInOtherProjectIntoDone,
			onRequestEditBacklogTaskCardInOtherProject,
			onRequestPinTaskCardInOtherProjectToTaskPinboard,
			onUnpinTaskCardInOtherProjectFromTaskPinboard,
		],
	);

	const otherProjectTaskCardActionConfirmationDialogs = (
		<>
			<TaskCommentBeforeMoveIntoDoneDialog
				controller={taskCommentBeforeMoveIntoDone}
				onSubmit={(text) => {
					const request = taskCommentBeforeMoveIntoDone.request;
					if (!request) return;
					const comment = prepareTaskComment(text);
					if (!comment) return;
					void readTaskCardWithBoardColumnInWorkspace(request.workspaceId, request.taskId)
						.then((snapshot) => {
							if (snapshot.taskCardLookupOutcome !== "task_card_found_on_workspace_board") {
								returnToEditingTaskComment(request.taskId, "任务已移动或已删除，未提交评论。");
								return;
							}
							if (snapshot.taskCardSnapshot.boardColumnIdContainingTaskCard === "trash") {
								// 读回已保存的同一条评论后结算，避免响应丢失时重跑 Done 或补加新评论。
								if (
									snapshot.taskCardSnapshot.taskCard.taskCommentEntries?.some(
										(entry) =>
											entry.taskCommentEntryId === comment.taskCommentEntryId &&
											entry.commentText === comment.commentText,
									)
								)
									completeTaskComment(request.taskId, comment.taskCommentEntryId);
								else
									returnToEditingTaskComment(
										request.taskId,
										"任务已移动或评论已变化，未提交评论。",
										comment.taskCommentEntryId,
									);
								return;
							}
							if (
								snapshot.taskCardSnapshot.boardColumnIdContainingTaskCard === "review" ||
								snapshot.taskCardSnapshot.boardColumnIdContainingTaskCard === "in_progress"
							) {
								suspendTaskComment(request.taskId);
								setPendingSkipValidationConfirmation({
									workspaceId: request.workspaceId,
									taskCard: snapshot.taskCardSnapshot.taskCard,
									taskCommentToAppendWhenMovingIntoDone: comment,
								});
								return;
							}
							moveTaskCardInOtherProjectIntoDone(request.workspaceId, request.taskId, comment);
						})
						.catch((error: unknown) =>
							returnToEditingTaskComment(request.taskId, error instanceof Error ? error.message : String(error)),
						);
				}}
			/>
			<DeleteTaskDialog
				task={pendingDeleteConfirmation?.taskCard ?? null}
				onCancel={() => setPendingDeleteConfirmation(null)}
				onConfirm={() => {
					const confirmation = pendingDeleteConfirmation;
					setPendingDeleteConfirmation(null);
					if (!confirmation) {
						return;
					}
					void permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime({
						workspaceId: confirmation.workspaceId,
						permanentlyDeletedTaskCardSelection: {
							permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
							selectedTaskIds: [confirmation.taskCard.id],
						},
						taskIdsExpectedToBeDeleted: [confirmation.taskCard.id],
					}).then((result) => reportTaskCardActionCommandFailure("delete the task", result));
				}}
			/>
			<SkipValidationConfirmDialog
				open={pendingSkipValidationConfirmation !== null}
				onCancel={() => {
					if (pendingSkipValidationConfirmation?.taskCommentToAppendWhenMovingIntoDone)
						returnToEditingTaskComment(pendingSkipValidationConfirmation.taskCard.id);
					setPendingSkipValidationConfirmation(null);
				}}
				onConfirm={() => {
					const confirmation = pendingSkipValidationConfirmation;
					setPendingSkipValidationConfirmation(null);
					if (confirmation) {
						moveTaskCardInOtherProjectIntoDone(
							confirmation.workspaceId,
							confirmation.taskCard.id,
							confirmation.taskCommentToAppendWhenMovingIntoDone,
						);
					}
				}}
			/>
		</>
	);

	return { buildTaskCardActionHandlerBundleForOtherProjectTaskCard, otherProjectTaskCardActionConfirmationDialogs };
}
