import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import type { PostDeployVerificationMoveIntoDoneCompletionResult } from "@/hooks/use-board-interactions";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import type { RuntimePostDeployVerificationDoneEntryClosureRequest } from "@/runtime/types";
import { moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import type { BoardColumnId } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";

const POST_DEPLOY_VERIFICATION_PANEL_COMPLETION_BOARD_MUTATION_INITIATOR: WebUiBoardMutationInitiator =
	"web_ui_user_gesture_post_deploy_verification_panel_completion";

function describeReadFailure(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * PDV 面板「完成核对 / 带原因移入 Done」在 PDV workspace 的 board **不在浏览器里**时的移列（All projects 视图下面板
 * 绑定的不是当前项目，或跨项目打开的过渡窗口里）。与当前项目那条（useBoardInteractions.completePostDeployVerificationMoveToDone）
 * 调同一个 taskCardAction 命令、同样的发起方标注，差别：
 *   - 移列前先在服务端复检卡片所在列：面板手里的 board 是最多旧 30s 的快照，controller 的本地复检不够——
 *     token 按发放时的列算确认项，卡已漂移到别的列就不能拿旧确认项推进 Done；
 *   - 不带 overlay（那份 board 不在浏览器里），结果由调用方重读快照与 PDV 读模型回来。
 * 结果映射与当前项目那条一致：门禁拒绝原样返回（controller 自己提示）；其他失败弹错；同卡另有命令在途时报失败。
 */
export async function completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser(input: {
	workspaceId: string;
	taskId: string;
	boardColumnIdObservedInBoardSnapshot: BoardColumnId;
	postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest;
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
}): Promise<PostDeployVerificationMoveIntoDoneCompletionResult> {
	let taskCardLookup: Awaited<ReturnType<typeof readTaskCardWithBoardColumnInWorkspace>>;
	try {
		taskCardLookup = await readTaskCardWithBoardColumnInWorkspace(input.workspaceId, input.taskId);
	} catch (error) {
		return { ok: false, moveIntoDoneFailureMessage: `读取任务所在列失败：${describeReadFailure(error)}` };
	}
	if (taskCardLookup.taskCardLookupOutcome !== "task_card_found_on_workspace_board") {
		return { ok: false, moveIntoDoneFailureMessage: "任务已不在看板" };
	}
	if (taskCardLookup.taskCardSnapshot.boardColumnIdContainingTaskCard !== input.boardColumnIdObservedInBoardSnapshot) {
		return { ok: false, moveIntoDoneFailureMessage: "任务所在列已变化，请重新点击完成核对" };
	}

	const result = await moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime({
		workspaceId: input.workspaceId,
		taskId: input.taskId,
		boardMutationInitiator: POST_DEPLOY_VERIFICATION_PANEL_COMPLETION_BOARD_MUTATION_INITIATOR,
		...(input.taskCommentToAppendWhenMovingIntoDone
			? { taskCommentToAppendWhenMovingIntoDone: input.taskCommentToAppendWhenMovingIntoDone }
			: {}),
		...(input.postDeployVerificationDoneEntryClosure
			? { postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure }
			: {}),
	});
	if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
		if (!isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(result.commandFailureMessage)) {
			notifyError(`Could not move the task to Done: ${result.commandFailureMessage}`);
		}
		return { ok: false, moveIntoDoneFailureMessage: result.commandFailureMessage };
	}
	if (result.taskCardActionCommandExecutionOutcome === "rejected_because_another_command_is_in_flight_for_task_card") {
		return { ok: false, moveIntoDoneFailureMessage: "该任务的移入 Done 已在进行中" };
	}
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
	return { ok: true };
}
