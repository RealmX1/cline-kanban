import { describe, expect, it } from "vitest";

import {
	applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft,
	buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId,
	createInitialPostDeployVerificationDoneEntryClosureDialogDraft,
	type PostDeployVerificationDoneEntryClosureDialogTaskEntry,
	resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn,
	toggleTaskEntrySelectedForClosureInDialogDraft,
	updateClosureReasonDraftOfChecklistItem,
	validatePostDeployVerificationDoneEntryClosureDialogDraft,
} from "./post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";

function taskEntry(
	taskId: string,
	uncheckedChecklistItemIds: string[],
	overrides: Partial<PostDeployVerificationDoneEntryClosureDialogTaskEntry> = {},
): PostDeployVerificationDoneEntryClosureDialogTaskEntry {
	return {
		taskId,
		taskTitle: `任务 ${taskId}`,
		boardColumnIdOfTaskCardBeforeMoveIntoDone: "validation",
		uncheckedChecklistItemsRequiringClosureReason: uncheckedChecklistItemIds.map((checklistItemId) => ({
			checklistItemId,
			checklistItemLabel: `核对 ${checklistItemId}`,
			checklistItemKind: "guided_manual",
		})),
		runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel: false,
		agentResponsePreviewShownWithSkipValidationAcknowledgement: null,
		...overrides,
	};
}

describe("原因对话框草稿的校验", () => {
	it("每个未勾项都要有原因码，覆盖全了才就绪", () => {
		const entries = [taskEntry("task-a", ["item-1", "item-2"])];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft)).toEqual({
			isReadyToConfirmClosure: false,
			closureDraftProblemsForDisplay: ["还有 2 个未勾项没有选择原因。"],
		});
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-1", {
			closureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			false,
		);
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-2", {
			closureReasonCode: "assertion_already_covered_by_other_verification_evidence",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
	});

	it("自定义原因必须填非空文本；其他原因码的文本可选", () => {
		const entries = [taskEntry("task-a", ["item-1"])];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-1", {
			closureReasonCode: "custom_reason_described_in_reason_text",
			closureReasonText: "   ",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft)).toEqual({
			isReadyToConfirmClosure: false,
			closureDraftProblemsForDisplay: ["有 1 个「自定义原因」没有填写原因文本。"],
		});
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-1", { closureReasonText: "上游已回滚" });
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
	});

	it("「应用到全部未勾项」填满所有任务的所有未勾项，之后仍可逐项改", () => {
		const entries = [taskEntry("task-a", ["item-1"]), taskEntry("task-b", ["item-2", "item-3"])];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		draft = applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft(draft, entries, {
			closureReasonCode: "trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
			closureReasonText: "",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-b", "item-3", {
			closureReasonCode: "custom_reason_described_in_reason_text",
			closureReasonText: "",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			false,
		);
	});

	it("服务端说有本地看不到的未勾项时，必须用「应用到全部」给出原因", () => {
		const entries = [
			taskEntry("task-a", [], { runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel: true }),
		];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			false,
		);
		draft = applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft(draft, entries, {
			closureReasonCode: "assertion_obsolete_because_verified_behavior_changed_or_removed",
			closureReasonText: "",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
	});

	it("有 In Progress 任务时要显式确认会话可能仍在运行", () => {
		const entries = [taskEntry("task-a", [], { boardColumnIdOfTaskCardBeforeMoveIntoDone: "in_progress" })];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			false,
		);
		draft = { ...draft, inProgressAgentSessionMayStillBeRunningAcknowledged: true };
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
	});

	it("批量模式：未选中的任务不要求原因，至少选一个", () => {
		const entries = [taskEntry("task-a", ["item-1"]), taskEntry("task-b", ["item-2"])];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: false,
		});
		expect(
			validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).closureDraftProblemsForDisplay,
		).toEqual(["至少选择一个任务。"]);
		draft = toggleTaskEntrySelectedForClosureInDialogDraft(draft, "task-b", true);
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-b", "item-2", {
			closureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
		});
		expect(validatePostDeployVerificationDoneEntryClosureDialogDraft(entries, draft).isReadyToConfirmClosure).toBe(
			true,
		);
		expect(Object.keys(buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(entries, draft))).toEqual([
			"task-b",
		]);
	});
});

describe("草稿 → moveIntoDone 的结案请求", () => {
	it("逐项原因 + 可选文本（去空白、空则省略）+ 按来源列的确认项", () => {
		const entries = [
			taskEntry("task-a", ["item-1", "item-2"], { boardColumnIdOfTaskCardBeforeMoveIntoDone: "review" }),
		];
		let draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-1", {
			closureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
			closureReasonText: "  要三台机器  ",
		});
		draft = updateClosureReasonDraftOfChecklistItem(draft, "task-a", "item-2", {
			closureReasonCode: "trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
		});
		expect(buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(entries, draft)).toEqual({
			"task-a": {
				uncheckedChecklistItemClosureReasons: [
					{
						checklistItemId: "item-1",
						uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
						uncheckedChecklistItemClosureReasonText: "要三台机器",
					},
					{
						checklistItemId: "item-2",
						uncheckedChecklistItemClosureReasonCode:
							"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
					},
				],
				confirmedAcknowledgements: ["skip_validation"],
			},
		});
	});

	it("用过「应用到全部」时额外作为 closureReasonAppliedToRemaining 发出，覆盖本地看不到的未勾项", () => {
		const entries = [taskEntry("task-a", ["item-1"])];
		const draft = applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft(
			createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
				selectEveryTaskEntryInitially: true,
			}),
			entries,
			{ closureReasonCode: "custom_reason_described_in_reason_text", closureReasonText: "整体重做" },
		);
		expect(buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(entries, draft)["task-a"]).toEqual({
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "item-1",
					uncheckedChecklistItemClosureReasonCode: "custom_reason_described_in_reason_text",
					uncheckedChecklistItemClosureReasonText: "整体重做",
				},
			],
			closureReasonAppliedToRemainingUncheckedChecklistItems: {
				uncheckedChecklistItemClosureReasonCode: "custom_reason_described_in_reason_text",
				uncheckedChecklistItemClosureReasonText: "整体重做",
			},
		});
	});

	it("全勾的任务只带确认项（服务端按通过结案）", () => {
		const entries = [taskEntry("task-a", [], { boardColumnIdOfTaskCardBeforeMoveIntoDone: "in_progress" })];
		const draft = createInitialPostDeployVerificationDoneEntryClosureDialogDraft(entries, {
			selectEveryTaskEntryInitially: true,
		});
		expect(buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(entries, draft)).toEqual({
			"task-a": { confirmedAcknowledgements: ["skip_validation", "in_progress_active"] },
		});
	});

	it("确认项按来源列：validation / backlog 无，review 跳过 Validation，in_progress 另加会话仍在跑", () => {
		expect(resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn("validation")).toEqual(
			[],
		);
		expect(resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn("backlog")).toEqual(
			[],
		);
		expect(resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn("review")).toEqual([
			"skip_validation",
		]);
		expect(
			resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn("in_progress"),
		).toEqual(["skip_validation", "in_progress_active"]);
	});
});
