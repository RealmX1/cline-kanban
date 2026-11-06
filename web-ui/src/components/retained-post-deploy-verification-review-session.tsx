import { type ComponentProps, useRef, useState } from "react";
import { PostDeployVerificationReviewBeforeMoveIntoDoneDialog } from "@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import { usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	type BoundFloatingFormTaskClosureCompletionReceipt,
	completeTaskClosureFromBoundFloatingForm,
} from "@/state/complete-task-closure-from-bound-floating-form";
import { requestPostDeployVerificationTaskClosureForm } from "@/state/post-deploy-verification-task-closure-form-request";
import type { BoardData } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

type BoundReviewProps = Omit<
	ComponentProps<typeof PostDeployVerificationReviewBeforeMoveIntoDoneDialog>,
	"verification"
> & {
	verification?: ComponentProps<typeof PostDeployVerificationReviewBeforeMoveIntoDoneDialog>["verification"];
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	insertAtIndexWithinDoneBoardColumn?: number;
	onOpenTaskInProject?: (workspaceId: string, taskId: string) => void;
};

export function RetainedPostDeployVerificationReviewSession(props: BoundReviewProps) {
	const verification = usePostDeployVerification(props.workspaceId, {
		pollingEnabled: false,
		showDeploymentNotifications: false,
	});
	const [board, setBoard] = useState(props.board);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [taskComment, setTaskComment] = useState(props.taskCommentToAppendWhenMovingIntoDone);
	const [requestingComment, setRequestingComment] = useState(false);
	const receipt = useRef<BoundFloatingFormTaskClosureCompletionReceipt>({ moveCompleted: false });
	const incarnation = findCardSelection(props.board, props.taskId)?.card.createdAt;
	const refreshBoundBoard = async (): Promise<BoardData> => {
		if (incarnation === undefined) throw new Error("原任务身份尚未确认，核对内容已保留。");
		const found = await readTaskCardWithBoardColumnInWorkspace(props.workspaceId, props.taskId, incarnation);
		if (
			found.taskCardLookupOutcome !== "task_card_found_on_workspace_board" ||
			found.taskCardSnapshot.taskCard.createdAt !== incarnation
		)
			throw new Error("原任务身份已失效，核对内容已保留。");
		const next: BoardData = {
			columns: [
				{
					id: found.taskCardSnapshot.boardColumnIdContainingTaskCard,
					title: "任务",
					cards: [found.taskCardSnapshot.taskCard],
				},
			],
		};
		setBoard(next);
		return next;
	};
	const complete = async (requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
		if (submitting || incarnation === undefined) return;
		setSubmitting(true);
		setError(null);
		try {
			let comment = taskComment;
			if (props.postDeployVerificationCompletionDeploymentId && !comment?.closure) {
				const selected = await requestPostDeployVerificationTaskClosureForm(
					props.workspaceId,
					props.taskId,
					incarnation,
				);
				if (selected === null) return;
				if (!selected?.closure) throw new Error("尚未取得结案内容，原核对与输入已保留。");
				comment = selected;
				setTaskComment(selected);
			}
			await completeTaskClosureFromBoundFloatingForm({
				workspaceId: props.workspaceId,
				taskId: props.taskId,
				expectedTaskIncarnationCreatedAtEpochMs: incarnation,
				taskCommentToAppendWhenMovingIntoDone: comment,
				insertAtIndexWithinDoneBoardColumn: props.insertAtIndexWithinDoneBoardColumn,
				postDeployVerificationDoneEntryClosure: requests[props.taskId],
				verification,
				completionDeploymentId: props.postDeployVerificationCompletionDeploymentId,
				receipt: receipt.current,
			});
			props.onBeforeHostedClose?.("completed");
			props.onCancel();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSubmitting(false);
		}
	};
	const source = props.realTaskCardRenderingInputs;
	return (
		<>
			<PostDeployVerificationReviewBeforeMoveIntoDoneDialog
				{...props}
				board={board}
				verification={verification}
				refreshAndReadBoardBeforeCompletion={refreshBoundBoard}
				isSubmittingClosure={submitting || requestingComment}
				continueConfirmationAfterMove={
					receipt.current.moveCompleted || receipt.current.moveSubmissionAttempted === true
				}
				onSelectTask={() => {
					if (props.onOpenTaskInProject) props.onOpenTaskInProject(props.workspaceId, props.taskId);
					else props.onSelectTask?.();
				}}
				onCancel={() => {
					props.onBeforeHostedClose?.("dismissed");
					props.onCancel();
				}}
				onNavigateToBoard={() => props.onNavigateToProjectBoard?.(props.workspaceId)}
				onRequestTaskCommentBeforeMovingIntoDone={() => {
					if (requestingComment || incarnation === undefined) return;
					setRequestingComment(true);
					setError(null);
					void requestPostDeployVerificationTaskClosureForm(props.workspaceId, props.taskId, incarnation)
						.then((comment) => {
							if (comment) setTaskComment(comment);
						})
						.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
						.finally(() => setRequestingComment(false));
				}}
				realTaskCardRenderingInputs={
					source
						? {
								realTaskCardRenderingInputsBoardSourceKind:
									"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
								workspaceIdOwningRuntimeBoardSnapshot: props.workspaceId,
								taskSessionsFromRuntimeBoardSnapshot:
									source.realTaskCardRenderingInputsBoardSourceKind ===
									"current_project_board_hydrated_in_browser"
										? source.currentProjectTaskSessions
										: source.taskSessionsFromRuntimeBoardSnapshot,
								workspacePathOwningRuntimeBoardSnapshot:
									source.realTaskCardRenderingInputsBoardSourceKind ===
									"current_project_board_hydrated_in_browser"
										? source.currentProjectWorkspacePath
										: source.workspacePathOwningRuntimeBoardSnapshot,
								onActivateTaskCardOpeningTaskInItsProject: (card) =>
									props.onOpenTaskInProject?.(props.workspaceId, card.id),
								defaultAgentId: source.defaultAgentId,
							}
						: null
				}
				onConfirmClosureRequestsBySelectedTaskId={(requests) => {
					void complete(requests);
				}}
			/>
			{error && (
				<div role="alert" className="fixed bottom-4 left-4 z-50 rounded bg-surface-2 p-3 text-sm text-status-red">
					{error}
				</div>
			)}
		</>
	);
}
