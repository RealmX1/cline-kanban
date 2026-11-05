import { type ComponentProps, useRef, useState } from "react";
import { PostDeployVerificationUncheckedItemsClosureReasonDialogForm } from "@/components/post-deploy-verification/post-deploy-verification-unchecked-items-closure-reason-dialog";
import { usePostDeployVerification } from "@/hooks/use-post-deploy-verification";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	type BoundFloatingFormTaskClosureCompletionReceipt,
	completeTaskClosureFromBoundFloatingForm,
} from "@/state/complete-task-closure-from-bound-floating-form";

export function RetainedPostDeployVerificationClosureReasonsSession(
	props: ComponentProps<typeof PostDeployVerificationUncheckedItemsClosureReasonDialogForm>,
) {
	const context = props.hostedCompletionContext;
	const verification = usePostDeployVerification(context?.workspaceId ?? null, {
		pollingEnabled: false,
		showDeploymentNotifications: false,
	});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const receipts = useRef(new Map<string, BoundFloatingFormTaskClosureCompletionReceipt>());
	const complete = async (requests: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
		if (!context || submitting) return;
		setSubmitting(true);
		setError(null);
		const failures: string[] = [];
		for (const [taskId, closure] of Object.entries(requests)) {
			const card = findCardSelection(context.board, taskId)?.card;
			const expectedColumn = props.taskEntries.find(
				(entry) => entry.taskId === taskId,
			)?.boardColumnIdOfTaskCardBeforeMoveIntoDone;
			const receipt = receipts.current.get(taskId) ?? { moveCompleted: false };
			receipts.current.set(taskId, receipt);
			try {
				if (!card) throw new Error("原任务身份未确认，未提交结案。");
				if (!receipt.moveCompleted) {
					const found = await readTaskCardWithBoardColumnInWorkspace(context.workspaceId, taskId, card.createdAt);
					if (
						found.taskCardLookupOutcome !== "task_card_found_on_workspace_board" ||
						found.taskCardSnapshot.taskCard.createdAt !== card.createdAt ||
						found.taskCardSnapshot.boardColumnIdContainingTaskCard !== expectedColumn
					)
						throw new Error("原任务身份或所在列已变化，未提交结案。");
				}
				await completeTaskClosureFromBoundFloatingForm({
					workspaceId: context.workspaceId,
					taskId,
					expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
					completionDeploymentId: context.deploymentId,
					taskCommentToAppendWhenMovingIntoDone: context.taskCommentToAppendWhenMovingIntoDone,
					postDeployVerificationDoneEntryClosure: closure,
					verification,
					receipt,
				});
			} catch (failure) {
				failures.push(`${card?.title ?? taskId}：${failure instanceof Error ? failure.message : String(failure)}`);
			}
		}
		setSubmitting(false);
		if (failures.length) setError(failures.join("\n"));
		else props.onCancel();
	};
	return (
		<PostDeployVerificationUncheckedItemsClosureReasonDialogForm
			{...props}
			isSubmittingClosure={submitting}
			submissionErrorMessage={error}
			onConfirmClosureRequestsBySelectedTaskId={(requests) => {
				void complete(requests);
			}}
		/>
	);
}
