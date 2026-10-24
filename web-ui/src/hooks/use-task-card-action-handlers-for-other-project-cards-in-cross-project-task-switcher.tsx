import { type ReactElement, useCallback, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { DeleteTaskDialog } from "@/components/delete-task-dialog";
import {
	doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask,
	isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import { PostDeployVerificationReviewBeforeMoveIntoDoneWithWorkspaceReadModel } from "@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import { SkipValidationConfirmDialog } from "@/components/skip-validation-confirm-dialog";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { TaskCommentBeforeMoveIntoDoneDialog } from "@/components/task-comment-before-move-into-done-dialog";
import { useTaskCommentBeforeMoveIntoDone } from "@/hooks/use-task-comment-before-move-into-done";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";
import { fetchTaskWorkspaceInfoForWorkspace, fetchWorkspaceState } from "@/runtime/workspace-state-query";
import { findCardSelection, normalizeBoardData } from "@/state/board-state";
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

interface OtherProjectMoveIntoDoneFlowIdentity {
	workspaceId: string;
	taskId: string;
	flowGeneration: number;
}

interface PendingOtherProjectTaskCardConfirmation {
	doneEntryFlowIdentity?: OtherProjectMoveIntoDoneFlowIdentity;
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
	onOpenTaskInProject,
	onNavigateToProjectBoard,
}: {
	onRequestPinTaskCardInOtherProjectToTaskPinboard?: (workspaceId: string, taskCard: BoardCard) => void;
	onUnpinTaskCardInOtherProjectFromTaskPinboard?: (workspaceId: string, taskId: string) => void;
	onRequestEditBacklogTaskCardInOtherProject?: (workspaceId: string, taskCard: BoardCard) => void;
	onOpenTaskInProject?: (workspaceId: string, taskId: string) => void;
	onNavigateToProjectBoard?: (workspaceId: string) => Promise<void>;
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

	const doneEntryFlowGenerationRef = useRef(0);
	const activeDoneEntryFlowIdentityRef = useRef<OtherProjectMoveIntoDoneFlowIdentity | null>(null);
	const [pendingVerificationReview, setPendingVerificationReview] = useState<{
		doneEntryFlowIdentity: OtherProjectMoveIntoDoneFlowIdentity;
		workspaceId: string;
		taskId: string;
		workspaceState: RuntimeWorkspaceStateResponse;
		taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
		runtimeRejectionRevision: number;
	} | null>(null);
	const [isVerificationClosureSubmitting, setIsVerificationClosureSubmitting] = useState(false);
	const reviewPrecheckInFlightRef = useRef(false);
	const openVerificationReview = useCallback(
		async (
			doneEntryFlowIdentity: OtherProjectMoveIntoDoneFlowIdentity,
			comment?: TaskCommentToAppendWhenMovingIntoDone,
		) => {
			const { workspaceId, taskId } = doneEntryFlowIdentity;
			if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
			const workspaceState = await fetchWorkspaceState(workspaceId);
			if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
			const board = normalizeBoardData(workspaceState.board);
			const selection = board ? findCardSelection(board, taskId) : null;
			if (!selection || selection.column.id === "trash") throw new Error("任务已不在待结案的看板列，请刷新后重试");
			if (comment) suspendTaskComment(taskId, comment.taskCommentEntryId);
			setPendingVerificationReview((previous) => ({
				doneEntryFlowIdentity,
				workspaceId,
				taskId,
				workspaceState,
				taskCommentToAppendWhenMovingIntoDone: comment,
				runtimeRejectionRevision:
					(previous?.workspaceId === workspaceId && previous.taskId === taskId
						? previous.runtimeRejectionRevision
						: 0) + 1,
			}));
		},
		[suspendTaskComment],
	);

	const moveTaskCardInOtherProjectIntoDone = useCallback(
		(
			doneEntryFlowIdentity: OtherProjectMoveIntoDoneFlowIdentity,
			taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
			postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
		) => {
			const { workspaceId, taskId } = doneEntryFlowIdentity;
			if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
			void moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime({
				workspaceId,
				taskId,
				taskCommentToAppendWhenMovingIntoDone,
				postDeployVerificationDoneEntryClosure,
			})
				.then(async (result) => {
					if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
					if (
						result.taskCardActionCommandExecutionOutcome === "command_failed" &&
						isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(
							result.commandFailureMessage,
						)
					) {
						await openVerificationReview(doneEntryFlowIdentity, taskCommentToAppendWhenMovingIntoDone);
						return;
					}
					reportTaskCardActionCommandFailure("move the task to Done", result);
					if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime") {
						if (taskCommentToAppendWhenMovingIntoDone)
							setPendingVerificationReview((current) =>
								current?.doneEntryFlowIdentity === doneEntryFlowIdentity ? null : current,
							);
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
					setPendingVerificationReview((current) =>
						current?.doneEntryFlowIdentity === doneEntryFlowIdentity ? null : current,
					);
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
				})
				.catch((error: unknown) => {
					if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
					const message = error instanceof Error ? error.message : String(error);
					showAppToast({ intent: "danger", message });
					if (taskCommentToAppendWhenMovingIntoDone)
						setPendingVerificationReview((current) =>
							current?.doneEntryFlowIdentity === doneEntryFlowIdentity ? null : current,
						);
					if (taskCommentToAppendWhenMovingIntoDone)
						returnToEditingTaskComment(taskId, message, taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId);
				})
				.finally(() => {
					if (activeDoneEntryFlowIdentityRef.current === doneEntryFlowIdentity)
						setIsVerificationClosureSubmitting(false);
				});
		},
		[completeTaskComment, returnToEditingTaskComment, openVerificationReview],
	);

	const requestOtherProjectDoneWithVerificationPrecheck = useCallback(
		async (
			workspaceId: string,
			taskCard: BoardCard,
			columnId: BoardColumnId,
			comment?: TaskCommentToAppendWhenMovingIntoDone,
		) => {
			if (reviewPrecheckInFlightRef.current) return;
			reviewPrecheckInFlightRef.current = true;
			const doneEntryFlowIdentity: OtherProjectMoveIntoDoneFlowIdentity = {
				workspaceId,
				taskId: taskCard.id,
				flowGeneration: ++doneEntryFlowGenerationRef.current,
			};
			activeDoneEntryFlowIdentityRef.current = doneEntryFlowIdentity;
			setPendingVerificationReview(null);
			setIsVerificationClosureSubmitting(false);
			try {
				const state = await getRuntimeTrpcClient(workspaceId).deployment.getPostDeployVerificationState.query({});
				if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
				const activeGroup =
					state.deploymentGroups.find(
						(group) => group.workspaceId === workspaceId && group.deploymentId === state.activeDeploymentId,
					) ?? null;
				if (doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask(activeGroup, taskCard.id)) {
					await openVerificationReview(doneEntryFlowIdentity, comment);
				} else if (columnId === "review" || columnId === "in_progress") {
					if (comment) suspendTaskComment(taskCard.id, comment.taskCommentEntryId);
					setPendingSkipValidationConfirmation({
						doneEntryFlowIdentity,
						workspaceId,
						taskCard,
						taskCommentToAppendWhenMovingIntoDone: comment,
					});
				} else {
					moveTaskCardInOtherProjectIntoDone(doneEntryFlowIdentity, comment);
				}
			} catch (error) {
				if (activeDoneEntryFlowIdentityRef.current !== doneEntryFlowIdentity) return;
				const message = error instanceof Error ? error.message : "加载核对状态失败，请重试";
				showAppToast({ intent: "danger", message });
				if (comment) returnToEditingTaskComment(taskCard.id, message, comment.taskCommentEntryId);
			} finally {
				reviewPrecheckInFlightRef.current = false;
			}
		},
		[moveTaskCardInOtherProjectIntoDone, openVerificationReview, returnToEditingTaskComment, suspendTaskComment],
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
			onMoveToTrashTask: (_taskId, options) => {
				if (options?.requestTaskCommentBeforeMovingIntoDone) {
					openTaskComment(workspaceId, taskCard);
					return;
				}
				void requestOtherProjectDoneWithVerificationPrecheck(
					workspaceId,
					taskCard,
					boardColumnIdContainingTaskCard,
				);
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
			onRequestPinToTaskPinboard: () => onRequestPinTaskCardInOtherProjectToTaskPinboard?.(workspaceId, taskCard),
			onUnpinFromTaskPinboard: (taskId) => onUnpinTaskCardInOtherProjectFromTaskPinboard?.(workspaceId, taskId),
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
			requestOtherProjectDoneWithVerificationPrecheck,
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
							void requestOtherProjectDoneWithVerificationPrecheck(
								request.workspaceId,
								snapshot.taskCardSnapshot.taskCard,
								snapshot.taskCardSnapshot.boardColumnIdContainingTaskCard,
								comment,
							);
						})
						.catch((error: unknown) =>
							returnToEditingTaskComment(request.taskId, error instanceof Error ? error.message : String(error)),
						);
				}}
			/>
			{pendingVerificationReview && normalizeBoardData(pendingVerificationReview.workspaceState.board) ? (
				<PostDeployVerificationReviewBeforeMoveIntoDoneWithWorkspaceReadModel
					key={`${pendingVerificationReview.workspaceId}:${pendingVerificationReview.taskId}:${pendingVerificationReview.doneEntryFlowIdentity.flowGeneration}`}
					workspaceId={pendingVerificationReview.workspaceId}
					taskId={pendingVerificationReview.taskId}
					board={normalizeBoardData(pendingVerificationReview.workspaceState.board)!}
					runtimeRejectionRevision={pendingVerificationReview.runtimeRejectionRevision}
					refreshAndReadBoardBeforeCompletion={async () => {
						const workspaceState = await fetchWorkspaceState(pendingVerificationReview.workspaceId);
						const board = normalizeBoardData(workspaceState.board);
						if (!board) throw new Error("读取所属项目看板失败，请重新核对");
						setPendingVerificationReview((current) =>
							current === pendingVerificationReview ? { ...current, workspaceState } : current,
						);
						return board;
					}}
					realTaskCardRenderingInputs={{
						realTaskCardRenderingInputsBoardSourceKind:
							"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
						workspaceIdOwningRuntimeBoardSnapshot: pendingVerificationReview.workspaceId,
						taskSessionsFromRuntimeBoardSnapshot: pendingVerificationReview.workspaceState.sessions,
						workspacePathOwningRuntimeBoardSnapshot: pendingVerificationReview.workspaceState.repoPath,
						onActivateTaskCardOpeningTaskInItsProject: (card) =>
							onOpenTaskInProject?.(pendingVerificationReview.workspaceId, card.id),
						defaultAgentId: null,
						defaultClineModelId: null,
					}}
					isSubmittingClosure={isVerificationClosureSubmitting}
					onCancel={() => {
						if (activeDoneEntryFlowIdentityRef.current === pendingVerificationReview.doneEntryFlowIdentity)
							activeDoneEntryFlowIdentityRef.current = null;
						if (pendingVerificationReview.taskCommentToAppendWhenMovingIntoDone)
							returnToEditingTaskComment(pendingVerificationReview.taskId);
						setPendingVerificationReview(null);
					}}
					onConfirmClosureRequestsBySelectedTaskId={(requests) => {
						const closure = requests[pendingVerificationReview.taskId];
						if (!closure || isVerificationClosureSubmitting) return;
						setIsVerificationClosureSubmitting(true);
						moveTaskCardInOtherProjectIntoDone(
							pendingVerificationReview.doneEntryFlowIdentity,
							pendingVerificationReview.taskCommentToAppendWhenMovingIntoDone,
							closure,
						);
					}}
					onRequestTaskCommentBeforeMovingIntoDone={() => {
						if (activeDoneEntryFlowIdentityRef.current === pendingVerificationReview.doneEntryFlowIdentity)
							activeDoneEntryFlowIdentityRef.current = null;
						const selection = findCardSelection(
							normalizeBoardData(pendingVerificationReview.workspaceState.board)!,
							pendingVerificationReview.taskId,
						);
						const comment = pendingVerificationReview.taskCommentToAppendWhenMovingIntoDone;
						if (
							comment &&
							taskCommentBeforeMoveIntoDone.request?.workspaceId === pendingVerificationReview.workspaceId
						)
							returnToEditingTaskComment(pendingVerificationReview.taskId, null, comment.taskCommentEntryId);
						else if (selection) openTaskComment(pendingVerificationReview.workspaceId, selection.card);
						setPendingVerificationReview(null);
					}}
					onNavigateToBoard={async () => {
						if (!onNavigateToProjectBoard) throw new Error("当前宿主无法导航到所属项目看板，请从项目看板重试");
						await onNavigateToProjectBoard(pendingVerificationReview.workspaceId);
					}}
					onSelectTask={() =>
						onOpenTaskInProject?.(pendingVerificationReview.workspaceId, pendingVerificationReview.taskId)
					}
				/>
			) : null}

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
					if (confirmation?.doneEntryFlowIdentity) {
						moveTaskCardInOtherProjectIntoDone(
							confirmation.doneEntryFlowIdentity,
							confirmation.taskCommentToAppendWhenMovingIntoDone,
						);
					}
				}}
			/>
		</>
	);

	return { buildTaskCardActionHandlerBundleForOtherProjectTaskCard, otherProjectTaskCardActionConfirmationDialogs };
}
