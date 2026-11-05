import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import { moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

export interface BoundFloatingFormTaskClosureCompletionReceipt {
	moveCompleted: boolean;
	moveSubmissionAttempted?: boolean;
	taskCommentToAppendWhenMovingIntoDoneForRetry?: TaskCommentToAppendWhenMovingIntoDone;
	postDeployVerificationDoneEntryClosureForRetry?: RuntimePostDeployVerificationDoneEntryClosureRequest;
	verificationConfirmation?: {
		deploymentId: string;
		taskId: string;
		token: string;
		acks: NonNullable<RuntimePostDeployVerificationDoneEntryClosureRequest["confirmedAcknowledgements"]>;
	};
}

/** 窗口只重用既有结案命令和 PDV token 协议；重试确认不会再次执行已完成的移列。 */
export async function completeTaskClosureFromBoundFloatingForm(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs: number;
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	insertAtIndexWithinDoneBoardColumn?: number;
	postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest;
	verification: UsePostDeployVerificationResult;
	completionDeploymentId?: string;
	receipt: BoundFloatingFormTaskClosureCompletionReceipt;
}) {
	const { receipt, verification } = input;
	receipt.taskCommentToAppendWhenMovingIntoDoneForRetry =
		input.taskCommentToAppendWhenMovingIntoDone ?? receipt.taskCommentToAppendWhenMovingIntoDoneForRetry;
	receipt.postDeployVerificationDoneEntryClosureForRetry =
		input.postDeployVerificationDoneEntryClosure ?? receipt.postDeployVerificationDoneEntryClosureForRetry;
	if (!receipt.moveCompleted) {
		if (input.completionDeploymentId && !receipt.verificationConfirmation) {
			const response = await verification.requestComplete({
				deploymentId: input.completionDeploymentId,
				taskId: input.taskId,
			});
			if (!response?.confirmationToken || response.error)
				throw new Error(response?.error ?? "未取得核对确认凭据，填写内容已保留。");
			const acks = response.requiredAcknowledgements ?? [];
			if (
				acks.some((ack) => !input.postDeployVerificationDoneEntryClosure?.confirmedAcknowledgements?.includes(ack))
			)
				throw new Error("任务的确认要求已变化，请返回核对后重试。");
			receipt.verificationConfirmation = {
				deploymentId: input.completionDeploymentId,
				taskId: input.taskId,
				token: response.confirmationToken,
				acks,
			};
		}
		receipt.moveSubmissionAttempted = true;
		const result = await moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime({
			...input,
			taskCommentToAppendWhenMovingIntoDone: receipt.taskCommentToAppendWhenMovingIntoDoneForRetry,
			postDeployVerificationDoneEntryClosure: receipt.postDeployVerificationDoneEntryClosureForRetry,
			boardMutationInitiator: input.completionDeploymentId
				? "web_ui_user_gesture_post_deploy_verification_panel_completion"
				: "web_ui_user_gesture",
		});
		if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime")
			throw new Error(
				result.taskCardActionCommandExecutionOutcome === "command_failed"
					? result.commandFailureMessage
					: "该任务另有操作在执行，填写内容已保留，请稍后重试。",
			);
		receipt.moveCompleted = true;
	}
	if (receipt.verificationConfirmation) {
		const result = await verification.confirmComplete(receipt.verificationConfirmation);
		if (!result?.ok) throw new Error(result?.error ?? "任务已结案，核对状态尚未确认；重试仅补充确认。");
	}
}
