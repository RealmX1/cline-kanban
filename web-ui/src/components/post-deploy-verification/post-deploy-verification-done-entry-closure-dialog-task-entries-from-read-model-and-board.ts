import type { PostDeployVerificationDoneEntryClosureDialogTaskEntry } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import { listUncheckedChecklistItemsRequiringClosureReason } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import type { RuntimePostDeployVerificationDeploymentGroup } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

// PDV 读模型里没有任务标题：标题一律从看板现取；卡已被删时退回任务 id。
export function resolveTaskTitleForPostDeployVerificationPanel(board: BoardData, taskId: string): string {
	const selection = findCardSelection(board, taskId);
	return selection?.card.title || truncateTaskPromptLabel(selection?.card.prompt ?? "") || `任务 ${taskId}`;
}

// 由「部署组读模型 + 看板」现算对话框条目：对话框开着时读模型被 30s 轮询 / 拒绝后的立即刷新换掉，
// 条目跟着更新（新冒出来的未勾项会出现在对话框里）。卡已不在看板、或已在 Done 的任务不出条目——移入 Done 无从谈起。
export function buildPostDeployVerificationDoneEntryClosureDialogTaskEntriesFromReadModelAndBoard(input: {
	taskIds: readonly string[];
	deploymentGroupContainingTasks: RuntimePostDeployVerificationDeploymentGroup | null;
	board: BoardData;
	// 服务端已拒绝过（PRECONDITION_FAILED）的任务：本地若一个未勾项都看不到，标为「未勾项对本地不可见」。
	taskIdsRejectedByRuntimeForMissingClosureReasons?: ReadonlySet<string>;
	agentResponsePreviewByTaskId?: Readonly<Record<string, string | null | undefined>>;
}): PostDeployVerificationDoneEntryClosureDialogTaskEntry[] {
	const taskEntries: PostDeployVerificationDoneEntryClosureDialogTaskEntry[] = [];
	for (const taskId of input.taskIds) {
		const selection = findCardSelection(input.board, taskId);
		if (!selection || selection.column.id === "trash") {
			continue;
		}
		const postDeployVerificationTask =
			input.deploymentGroupContainingTasks?.tasks.find((task) => task.taskId === taskId) ?? null;
		const uncheckedChecklistItemsRequiringClosureReason = postDeployVerificationTask
			? listUncheckedChecklistItemsRequiringClosureReason(postDeployVerificationTask)
			: [];
		taskEntries.push({
			taskId,
			taskTitle: resolveTaskTitleForPostDeployVerificationPanel(input.board, taskId),
			boardColumnIdOfTaskCardBeforeMoveIntoDone: selection.column.id,
			uncheckedChecklistItemsRequiringClosureReason,
			runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel:
				(input.taskIdsRejectedByRuntimeForMissingClosureReasons?.has(taskId) ?? false) &&
				uncheckedChecklistItemsRequiringClosureReason.length === 0,
			agentResponsePreviewShownWithSkipValidationAcknowledgement:
				input.agentResponsePreviewByTaskId?.[taskId] ?? null,
		});
	}
	return taskEntries;
}
