import { POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX } from "@runtime-post-deploy-verification-done-entry-closure-contract";
import { describe, expect, it } from "vitest";

import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import {
	describePostDeployVerificationDoneEntryGateRejectionForHumans,
	evaluatePostDeployVerificationDoneEntryGatePrecheckForTask,
	isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate,
	resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone,
} from "./post-deploy-verification-done-entry-gate-precheck";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

function checklistItem(id: string, checked: boolean): RuntimePostDeployVerificationTask["checklist"][number] {
	return {
		id,
		label: `核对 ${id}`,
		checked,
		source: "authored",
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: null,
	};
}

function activeGroupWith(tasks: RuntimePostDeployVerificationTask[]): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId: "deployment-active",
		workspaceId: "workspace-1",
		deployedSourceCommit: "abcdef1234567",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-11T00:00:00.000Z",
		foldedAtIso: null,
		tasks,
	};
}

describe("PDV 移入 Done 门禁的客户端预检", () => {
	it("活跃组里未结案、有未勾项的任务：要逐项原因，并列出未勾项", () => {
		const group = activeGroupWith([
			createPostDeployVerificationTaskReadModelTestFixture({
				taskId: "gated",
				checklist: [checklistItem("checked", true), checklistItem("unchecked", false)],
			}),
		]);
		const result = evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(group, "gated");
		expect(result.postDeployVerificationDoneEntryGatePrecheckOutcome).toBe(
			"unchecked_checklist_items_require_per_item_closure_reasons",
		);
		if (
			result.postDeployVerificationDoneEntryGatePrecheckOutcome !==
			"unchecked_checklist_items_require_per_item_closure_reasons"
		) {
			return;
		}
		expect(result.deploymentId).toBe("deployment-active");
		expect(result.uncheckedChecklistItemsRequiringClosureReason).toEqual([
			{ checklistItemId: "unchecked", checklistItemLabel: "核对 unchecked", checklistItemKind: "guided_manual" },
		]);
	});

	it("全勾的任务由服务端按「通过」结案，不需要原因", () => {
		const group = activeGroupWith([
			createPostDeployVerificationTaskReadModelTestFixture({
				taskId: "all-checked",
				checklist: [checklistItem("a", true)],
			}),
		]);
		expect(
			evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(group, "all-checked")
				.postDeployVerificationDoneEntryGatePrecheckOutcome,
		).toBe("all_checklist_items_checked_so_runtime_closes_as_passed");
	});

	it.each<[string, Partial<RuntimePostDeployVerificationTask>]>([
		["已全勾通过", { verifiedAt: "2026-10-11T01:00:00.000Z" }],
		["已移除", { droppedReason: "task_deleted" }],
		[
			"记录部署时已在 Done 的只读展示项",
			{ includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true },
		],
		[
			"结案授权在途",
			{
				doneEntryClosureAuthorizationInFlight: {
					authorizedAtIso: "2026-10-11T01:00:00.000Z",
					expiresAtIso: "2026-10-11T01:15:00.000Z",
					anticipatedPostDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
					uncheckedChecklistItemClosureReasons: [],
					confirmedAcknowledgements: [],
					postDeployVerificationCompletionPath: "x",
				},
			},
		],
	])("%s：不受门禁", (_name, overrides) => {
		const group = activeGroupWith([
			createPostDeployVerificationTaskReadModelTestFixture({
				taskId: "task",
				checklist: [checklistItem("unchecked", false)],
				...overrides,
			}),
		]);
		expect(
			evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(group, "task")
				.postDeployVerificationDoneEntryGatePrecheckOutcome,
		).toBe("task_not_subject_to_post_deploy_verification_done_entry_gate");
	});

	it("没有活跃组、或任务不在活跃组：不受门禁", () => {
		expect(
			evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(null, "task")
				.postDeployVerificationDoneEntryGatePrecheckOutcome,
		).toBe("task_not_subject_to_post_deploy_verification_done_entry_gate");
		expect(
			evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(activeGroupWith([]), "task")
				.postDeployVerificationDoneEntryGatePrecheckOutcome,
		).toBe("task_not_subject_to_post_deploy_verification_done_entry_gate");
	});
});

describe("服务端门禁拒绝（PRECONDITION_FAILED）的识别与分流", () => {
	const rejectionMessage = `${POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX} 还有 2 项未勾`;

	it("只认机读前缀；给人看的说明去掉前缀", () => {
		expect(isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(rejectionMessage)).toBe(true);
		expect(isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate("worktree busy")).toBe(false);
		expect(describePostDeployVerificationDoneEntryGateRejectionForHumans(rejectionMessage)).toBe("还有 2 项未勾");
		expect(
			describePostDeployVerificationDoneEntryGateRejectionForHumans(
				POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX,
			),
		).toContain("逐项给出原因");
	});

	it("用户手势 → 看板级原因对话框；自动化 → 只提示一次；已带原因或 PDV 面板完成流 → 抛给调用方", () => {
		expect(
			resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
				postDeployVerificationDoneEntryClosureWasSupplied: false,
				boardMutationInitiator: "web_ui_user_gesture",
			}),
		).toBe("open_board_level_closure_reason_dialog_for_user_gesture");
		expect(
			resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
				postDeployVerificationDoneEntryClosureWasSupplied: false,
				boardMutationInitiator: undefined,
			}),
		).toBe("open_board_level_closure_reason_dialog_for_user_gesture");
		expect(
			resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
				postDeployVerificationDoneEntryClosureWasSupplied: false,
				boardMutationInitiator: "web_ui_client_automation_auto_review_commit_mode_completion",
			}),
		).toBe("show_one_time_notice_because_move_was_automation_initiated");
		expect(
			resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
				postDeployVerificationDoneEntryClosureWasSupplied: true,
				boardMutationInitiator: "web_ui_user_gesture",
			}),
		).toBe("rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow");
		expect(
			resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
				postDeployVerificationDoneEntryClosureWasSupplied: false,
				boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
			}),
		).toBe("rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow");
	});
});
