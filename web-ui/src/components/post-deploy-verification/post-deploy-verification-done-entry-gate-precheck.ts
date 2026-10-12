import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import { POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX } from "@runtime-post-deploy-verification-done-entry-closure-contract";

import {
	isPostDeployVerificationTaskClosed,
	isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn,
} from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationItemKind,
	RuntimePostDeployVerificationTask,
} from "@/runtime/types";

// 「移入 Done」门禁的**客户端预检**。唯一判据在服务端（taskCardAction.moveIntoDone 缺原因时抛 PRECONDITION_FAILED）；
// 这里只用 PDV 读模型提前判断，好在发请求前就打开原因对话框，而不是让用户先看到一次失败。读模型最多滞后 30s，
// 预检说「不受门禁」而服务端拒绝时，由调用方按下方的拒绝处理策略兜底。

export interface PostDeployVerificationUncheckedChecklistItemRequiringClosureReason {
	checklistItemId: string;
	checklistItemLabel: string;
	checklistItemKind: RuntimePostDeployVerificationItemKind;
}

export type PostDeployVerificationDoneEntryGatePrecheckResult =
	| {
			postDeployVerificationDoneEntryGatePrecheckOutcome: "task_not_subject_to_post_deploy_verification_done_entry_gate";
	  }
	| {
			postDeployVerificationDoneEntryGatePrecheckOutcome: "all_checklist_items_checked_so_runtime_closes_as_passed";
			deploymentId: string;
			postDeployVerificationTask: RuntimePostDeployVerificationTask;
	  }
	| {
			postDeployVerificationDoneEntryGatePrecheckOutcome: "unchecked_checklist_items_require_per_item_closure_reasons";
			deploymentId: string;
			postDeployVerificationTask: RuntimePostDeployVerificationTask;
			uncheckedChecklistItemsRequiringClosureReason: PostDeployVerificationUncheckedChecklistItemRequiringClosureReason[];
	  };

export function listUncheckedChecklistItemsRequiringClosureReason(
	task: RuntimePostDeployVerificationTask,
): PostDeployVerificationUncheckedChecklistItemRequiringClosureReason[] {
	return task.checklist
		.filter((item) => !item.checked)
		.map((item) => ({ checklistItemId: item.id, checklistItemLabel: item.label, checklistItemKind: item.kind }));
}

// 与服务端判据同形：任务在**当前项目的活跃部署组**里、未结案、未移除、不是只读展示项、没有在途结案授权。
// 再按有无未勾项分两种结果。活跃组只属于当前项目（usePostDeployVerification 按 workspace 取数），判据键因此
// 天然带 workspaceId。
export function evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(
	activeDeploymentGroupOfCurrentProject: RuntimePostDeployVerificationDeploymentGroup | null,
	taskId: string,
): PostDeployVerificationDoneEntryGatePrecheckResult {
	const notSubjectToGate = {
		postDeployVerificationDoneEntryGatePrecheckOutcome:
			"task_not_subject_to_post_deploy_verification_done_entry_gate",
	} as const;
	if (!activeDeploymentGroupOfCurrentProject) {
		return notSubjectToGate;
	}
	const task = activeDeploymentGroupOfCurrentProject.tasks.find((entry) => entry.taskId === taskId);
	if (
		!task ||
		isPostDeployVerificationTaskClosed(task) ||
		task.droppedReason !== null ||
		isPostDeployVerificationTaskIncludedAsReadOnlyBecauseAlreadyInDoneColumn(task) ||
		// 结案授权在途：上一次移入 Done 已经带齐原因、正在落盘，交给服务端对账补完，不再弹框要原因。
		(task.doneEntryClosureAuthorizationInFlight ?? null) !== null
	) {
		return notSubjectToGate;
	}
	const uncheckedChecklistItemsRequiringClosureReason = listUncheckedChecklistItemsRequiringClosureReason(task);
	if (uncheckedChecklistItemsRequiringClosureReason.length === 0) {
		return {
			postDeployVerificationDoneEntryGatePrecheckOutcome: "all_checklist_items_checked_so_runtime_closes_as_passed",
			deploymentId: activeDeploymentGroupOfCurrentProject.deploymentId,
			postDeployVerificationTask: task,
		};
	}
	return {
		postDeployVerificationDoneEntryGatePrecheckOutcome: "unchecked_checklist_items_require_per_item_closure_reasons",
		deploymentId: activeDeploymentGroupOfCurrentProject.deploymentId,
		postDeployVerificationTask: task,
		uncheckedChecklistItemsRequiringClosureReason,
	};
}

export function doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask(
	activeDeploymentGroupOfCurrentProject: RuntimePostDeployVerificationDeploymentGroup | null,
	taskId: string,
): boolean {
	return (
		evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(activeDeploymentGroupOfCurrentProject, taskId)
			.postDeployVerificationDoneEntryGatePrecheckOutcome ===
		"unchecked_checklist_items_require_per_item_closure_reasons"
	);
}

// ---- 服务端拒绝（PRECONDITION_FAILED）的识别与处理 ----

// tRPC 客户端把服务端 TRPCError 的 message 原样带回（见 task-card-action-command-execution.ts 的 commandFailureMessage）；
// 前缀是机读约定，见 src/core/post-deploy-verification-done-entry-closure-contract.ts。
export function isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(
	moveIntoDoneFailureMessage: string,
): boolean {
	return moveIntoDoneFailureMessage.startsWith(
		POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX,
	);
}

// 给人看的拒绝说明：去掉机读前缀；前缀后没有说明时给一句通用中文。
export function describePostDeployVerificationDoneEntryGateRejectionForHumans(
	moveIntoDoneFailureMessage: string,
): string {
	const humanReadablePart = isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(
		moveIntoDoneFailureMessage,
	)
		? moveIntoDoneFailureMessage
				.slice(
					POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX.length,
				)
				.trim()
		: moveIntoDoneFailureMessage.trim();
	return humanReadablePart.length > 0
		? humanReadablePart
		: "该任务还有未勾选的 Post-Deploy Verification 核对项，移入 Done 前需要逐项给出原因。";
}

const WEB_UI_BOARD_MUTATION_INITIATORS_OF_CLIENT_AUTOMATION: ReadonlySet<WebUiBoardMutationInitiator> = new Set([
	"web_ui_client_automation_session_facet_driven_column_autoflow",
	"web_ui_client_automation_interrupted_session_autoflow_into_done_column",
	"web_ui_client_automation_auto_review_commit_mode_completion",
	"web_ui_client_automation_auto_review_pull_request_mode_completion",
]);

export function isWebUiBoardMutationInitiatorClientAutomation(
	boardMutationInitiator: WebUiBoardMutationInitiator | null | undefined,
): boolean {
	return (
		boardMutationInitiator != null &&
		WEB_UI_BOARD_MUTATION_INITIATORS_OF_CLIENT_AUTOMATION.has(boardMutationInitiator)
	);
}

//   rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow = 调用方已经给过原因（数据过期才被拒）
//       或调用方是 PDV 面板自己的完成流：失败原样抛给它，由它提示 / 重开自己的对话框，不再另弹一层；
//   show_one_time_notice_because_move_was_automation_initiated = 浏览器端自动化（自动 review 完成、会话中断流转）
//       发起的移入：没人在场填原因，只提示一次，不弹框、不重试；
//   open_board_level_closure_reason_dialog_for_user_gesture = 用户手势（按钮 / 拖拽）：打开看板级原因对话框。
export type PostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone =
	| "rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow"
	| "show_one_time_notice_because_move_was_automation_initiated"
	| "open_board_level_closure_reason_dialog_for_user_gesture";

export function resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone(input: {
	postDeployVerificationDoneEntryClosureWasSupplied: boolean;
	boardMutationInitiator: WebUiBoardMutationInitiator | null | undefined;
}): PostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone {
	if (
		input.postDeployVerificationDoneEntryClosureWasSupplied ||
		input.boardMutationInitiator === "web_ui_user_gesture_post_deploy_verification_panel_completion"
	) {
		return "rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow";
	}
	if (isWebUiBoardMutationInitiatorClientAutomation(input.boardMutationInitiator)) {
		return "show_one_time_notice_because_move_was_automation_initiated";
	}
	return "open_board_level_closure_reason_dialog_for_user_gesture";
}
