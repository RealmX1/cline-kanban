import { type ComponentProps, useRef, useState } from "react";
import { buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import { PostDeployVerificationReviewBeforeMoveIntoDoneDialog } from "@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import { PostDeployVerificationUncheckedItemsClosureReasonDialog } from "@/components/post-deploy-verification/post-deploy-verification-unchecked-items-closure-reason-dialog";
import { TaskCommentBeforeMoveIntoDoneDialogForm } from "@/components/task-comment-before-move-into-done-dialog";
import { usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import {
	type BoundFloatingFormTaskClosureCompletionReceipt,
	completeTaskClosureFromBoundFloatingForm,
} from "@/state/complete-task-closure-from-bound-floating-form";
import type { BoardData } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

/** 结案 controller 与窗口绑定，背景看板的重置不能改变提交目标或吞掉表单。 */
export function RetainedTaskClosureFormSession(props: ComponentProps<typeof TaskCommentBeforeMoveIntoDoneDialogForm>) {
	const request = props.controller.request;
	const verification = usePostDeployVerification(request?.workspaceId ?? null, {
		pollingEnabled: false,
		showDeploymentNotifications: false,
	});
	const [review, setReview] = useState<{
		board: BoardData;
		comment: TaskCommentToAppendWhenMovingIntoDone;
		hasVerification: boolean;
	} | null>(null);
	const completionReceipt = useRef<BoundFloatingFormTaskClosureCompletionReceipt>({ moveCompleted: false });
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!request) return null;
	const readBoundTaskBoard = async (): Promise<BoardData> => {
		const found = await readTaskCardWithBoardColumnInWorkspace(
			request.workspaceId,
			request.taskId,
			request.expectedTaskIncarnationCreatedAtEpochMs,
		);
		if (
			found.taskCardLookupOutcome !== "task_card_found_on_workspace_board" ||
			found.taskCardSnapshot.taskCard.createdAt !== request.expectedTaskIncarnationCreatedAtEpochMs
		)
			throw new Error("原任务身份已失效，填写内容已保留，未提交结案。");
		return {
			columns: [
				{
					id: found.taskCardSnapshot.boardColumnIdContainingTaskCard,
					title: "任务",
					cards: [found.taskCardSnapshot.taskCard],
				},
			],
		};
	};
	const complete = async (
		comment: TaskCommentToAppendWhenMovingIntoDone,
		closure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
	) => {
		setSubmitting(true);
		setError(null);
		try {
			await completeTaskClosureFromBoundFloatingForm({
				workspaceId: request.workspaceId,
				taskId: request.taskId,
				expectedTaskIncarnationCreatedAtEpochMs: request.expectedTaskIncarnationCreatedAtEpochMs,
				taskCommentToAppendWhenMovingIntoDone: comment,
				insertAtIndexWithinDoneBoardColumn: request.insertAtIndexWithinDoneBoardColumn,
				postDeployVerificationDoneEntryClosure: closure,
				verification,
				completionDeploymentId: props.postDeployVerificationCompletionDeploymentId,
				receipt: completionReceipt.current,
			});
			props.controller.cancel();
		} finally {
			setSubmitting(false);
		}
	};
	const confirmReview = (requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
		if (!review || submitting) return;
		void complete(review.comment, requests[request.taskId]).catch((failure: unknown) =>
			setError(failure instanceof Error ? failure.message : String(failure)),
		);
	};
	return (
		<>
			<TaskCommentBeforeMoveIntoDoneDialogForm
				{...props}
				controller={{
					...props.controller,
					request: { ...request, phase: review ? "awaiting_confirmation" : "editing" },
				}}
				onSubmit={async (commentText, closure) => {
					if (props.prepareClosurePayloadOnly) {
						await props.onSubmit(commentText, closure);
						props.controller.cancel();
						return;
					}
					const board = await readBoundTaskBoard();
					const group = await verification.refreshAndReadActiveGroup();
					const comment = {
						taskCommentEntryId: request.taskCommentEntryId,
						commentText: commentText.trim() || closure?.details.reason || "记录任务结案结果",
						closure,
					};
					const hasVerification = group?.tasks.some((entry) => entry.taskId === request.taskId) === true;
					if (hasVerification || board.columns[0]?.id !== "validation")
						setReview({ board, comment, hasVerification });
					else await complete(comment);
				}}
			/>
			{review && (
				<>
					{error && (
						<p
							role="alert"
							className="fixed bottom-4 left-4 z-50 rounded bg-surface-2 p-3 text-sm text-status-red"
						>
							{error}
						</p>
					)}
					{review.hasVerification ? (
						<PostDeployVerificationReviewBeforeMoveIntoDoneDialog
							workspaceId={request.workspaceId}
							taskId={request.taskId}
							board={review.board}
							verification={verification}
							refreshAndReadBoardBeforeCompletion={readBoundTaskBoard}
							continueConfirmationAfterMove={
								completionReceipt.current.moveCompleted ||
								completionReceipt.current.moveSubmissionAttempted === true
							}
							realTaskCardRenderingInputs={null}
							isSubmittingClosure={submitting}
							onCancel={() => setReview(null)}
							onConfirmClosureRequestsBySelectedTaskId={confirmReview}
						/>
					) : (
						<PostDeployVerificationUncheckedItemsClosureReasonDialog
							dialogTitle="确认任务结案"
							taskEntries={buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard({
								taskIds: [request.taskId],
								board: review.board,
								deploymentGroupContainingTasks: null,
							})}
							taskEntrySelectionMode="single_task_entry_always_included"
							isSubmittingClosure={submitting}
							onCancel={() => setReview(null)}
							onConfirmClosureRequestsBySelectedTaskId={confirmReview}
						/>
					)}
				</>
			)}
		</>
	);
}
