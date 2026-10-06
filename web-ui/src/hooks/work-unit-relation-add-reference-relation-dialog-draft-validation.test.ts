import { describe, expect, it } from "vitest";
import {
	type AddReferenceRelationDialogDraft,
	EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
	listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs,
	validateAddReferenceRelationDialogDraftIntoAssertionRequest,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";

const SUBJECT_WORKSPACE_ID = "workspace-current-project";
const SUBJECT_TASK_ID = "abc12";

function buildDraft(draftPatch: Partial<AddReferenceRelationDialogDraft>): AddReferenceRelationDialogDraft {
	return {
		...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
		selectedCounterpartKanbanBoardCard: {
			counterpartKanbanBoardCardWorkspaceId: "workspace-other-project",
			counterpartKanbanBoardCardTaskId: "def34",
			counterpartKanbanBoardCardTitle: "Creator card in other project",
			counterpartKanbanProjectDisplayName: "other-project",
		},
		relationAssertionRationaleOneSentenceText: "  The two tasks share a retry loop.  ",
		...draftPatch,
	};
}

function validate(draft: AddReferenceRelationDialogDraft) {
	return validateAddReferenceRelationDialogDraftIntoAssertionRequest({
		draft,
		subjectKanbanBoardCardWorkspaceId: SUBJECT_WORKSPACE_ID,
		subjectKanbanBoardCardTaskId: SUBJECT_TASK_ID,
	});
}

describe("validateAddReferenceRelationDialogDraftIntoAssertionRequest", () => {
	it("空草稿：要求选对端、选 kind、写理由", () => {
		expect(
			validateAddReferenceRelationDialogDraftIntoAssertionRequest({
				draft: EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
				subjectKanbanBoardCardWorkspaceId: SUBJECT_WORKSPACE_ID,
				subjectKanbanBoardCardTaskId: SUBJECT_TASK_ID,
			}),
		).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: [
				"Choose the other task.",
				"Choose a relation kind.",
				"Write a one-sentence rationale.",
			],
		});
	});

	it("对端是面板主体自己：拒绝自指", () => {
		const outcome = validate(
			buildDraft({
				selectedReferenceRelationKind: "reference_is_generally_related_with",
				selectedCounterpartKanbanBoardCard: {
					counterpartKanbanBoardCardWorkspaceId: SUBJECT_WORKSPACE_ID,
					counterpartKanbanBoardCardTaskId: SUBJECT_TASK_ID,
					counterpartKanbanBoardCardTitle: "Subject card",
					counterpartKanbanProjectDisplayName: "current-project",
				},
			}),
		);
		expect(outcome).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: ["A task cannot have a relation with itself; choose another task."],
		});
	});

	it("concerns：必填 aspect，nature 可选；只带该 kind 允许的属性", () => {
		expect(
			validate(buildDraft({ selectedReferenceRelationKind: "reference_concerns_behavior_or_state_of" })),
		).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: ["Fill in Concerned aspect."],
		});
		const outcome = validate(
			buildDraft({
				selectedReferenceRelationKind: "reference_concerns_behavior_or_state_of",
				concernedAspectSummaryText: " retry loop ",
				selectedConcernNature: "diagnoses_failure_of",
				// 切过别的 kind 留下的值：不属于 concerns，提交时裁掉。
				reusedOutputSummaryText: "left over from another kind",
				relationAssertionEvidencePointersOnePerLineText: "docs/a.md\n\n  commit 1234  \n",
			}),
		);
		expect(outcome).toEqual({
			isDraftReadyForSubmission: true,
			referenceRelationAssertionRequestWithoutClientCharacteristics: {
				subjectWorkUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: SUBJECT_TASK_ID,
					workspaceId: SUBJECT_WORKSPACE_ID,
				},
				relationKind: "reference_concerns_behavior_or_state_of",
				counterpartWorkUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: "def34",
					workspaceId: "workspace-other-project",
				},
				relationAssertionRationaleOneSentence: "The two tasks share a retry loop.",
				relationAssertionEvidencePointers: ["docs/a.md", "commit 1234"],
				assertedRelationKindSpecificAttributes: {
					concernedAspectSummary: "retry loop",
					concernNature: "diagnoses_failure_of",
				},
			},
		});
	});

	it("verifies：一行一个主张，结论一律 pending", () => {
		expect(validate(buildDraft({ selectedReferenceRelationKind: "reference_verifies_claims_of" }))).toMatchObject({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: ["Fill in Claims to verify."],
		});
		const outcome = validate(
			buildDraft({
				selectedReferenceRelationKind: "reference_verifies_claims_of",
				claimsUnderVerificationOnePerLineText: "cache is invalidated\n  p95 below 200ms\n",
			}),
		);
		expect(
			outcome.isDraftReadyForSubmission &&
				outcome.referenceRelationAssertionRequestWithoutClientCharacteristics
					.assertedRelationKindSpecificAttributes,
		).toEqual({
			claimsUnderVerification: [
				{ claimSummary: "cache is invalidated", verificationVerdict: "pending" },
				{ claimSummary: "p95 below 200ms", verificationVerdict: "pending" },
			],
		});
	});

	it("reuses：摘要或指针至少一个", () => {
		expect(validate(buildDraft({ selectedReferenceRelationKind: "reference_reuses_produced_outputs_of" }))).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: ["Fill in at least one of: Reused output pointers or Reused output summary."],
		});
		const onlyPointersOutcome = validate(
			buildDraft({
				selectedReferenceRelationKind: "reference_reuses_produced_outputs_of",
				reusedOutputPointersOnePerLineText: "bench/results.json",
			}),
		);
		expect(
			onlyPointersOutcome.isDraftReadyForSubmission &&
				onlyPointersOutcome.referenceRelationAssertionRequestWithoutClientCharacteristics
					.assertedRelationKindSpecificAttributes,
		).toEqual({ reusedOutputPointers: ["bench/results.json"] });
	});

	it("requirement origin 与 generally related 没有专有必填；cross-repository 必填契约指针", () => {
		expect(
			validate(buildDraft({ selectedReferenceRelationKind: "reference_requirement_originates_from" }))
				.isDraftReadyForSubmission,
		).toBe(true);
		expect(
			validate(buildDraft({ selectedReferenceRelationKind: "reference_is_generally_related_with" }))
				.isDraftReadyForSubmission,
		).toBe(true);
		expect(
			validate(buildDraft({ selectedReferenceRelationKind: "reference_is_cross_repository_counterpart_with" })),
		).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: ["Fill in Shared contract pointer."],
		});
	});

	it("理由与证据指针的长度 / 条数上限与写入契约一致", () => {
		const outcome = validate(
			buildDraft({
				selectedReferenceRelationKind: "reference_is_generally_related_with",
				relationAssertionRationaleOneSentenceText: "x".repeat(601),
				relationAssertionEvidencePointersOnePerLineText: [
					"y".repeat(1001),
					...Array.from({ length: 50 }, (_, index) => `pointer-${index}`),
				].join("\n"),
			}),
		);
		expect(outcome).toEqual({
			isDraftReadyForSubmission: false,
			draftValidationProblemMessages: [
				"The rationale is limited to 600 characters (one sentence).",
				"At most 50 evidence pointers are accepted.",
				"Each evidence pointer is limited to 1000 characters.",
			],
		});
	});

	it("对话框按 kind 显示的专有输入：注册表允许的属性，去掉自动填的泛相关理由", () => {
		expect(
			listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs(
				"reference_concerns_behavior_or_state_of",
			),
		).toEqual(["concernedAspectSummary", "concernNature"]);
		expect(
			listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs("reference_is_generally_related_with"),
		).toEqual([]);
	});
});
