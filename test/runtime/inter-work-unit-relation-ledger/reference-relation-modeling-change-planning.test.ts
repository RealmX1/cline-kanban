import { describe, expect, it } from "vitest";
import { ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS } from "../../../src/core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	type ReferenceRelationModelingDraft,
	referenceRelationModelingDraftSchema,
	referenceRelationModelingEditorDraftSchema,
	relationModelingEditorDraftSaveRequestSchema,
} from "../../../src/core/work-unit-relation-modeling-api-contract";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	createEmptyKanbanBoardCardIdentityProjectionState,
} from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { planReferenceRelationModelingChanges } from "../../../src/inter-work-unit-relation-ledger/reference-relation-modeling-change-planning";

const root: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "project",
	taskId: "root",
	taskIncarnationCreatedAtEpochMs: 1,
};
const draft: ReferenceRelationModelingDraft = {
	draftId: "draft",
	replacesRelationId: null,
	expectedAssertedRelationStateVersion: null,
	counterpartWorkUnit: { ...root, taskId: "other" },
	relationKind: "reference_is_generally_related_with",
	currentTaskIsStatementSubject: true,
	relationAssertionRationaleOneSentence: "共享目标",
	relationAssertionEvidencePointers: ["old.md"],
	assertedRelationKindSpecificAttributes: {},
};

describe("用户参照关系修改规划", () => {
	it.each(["reference_fixes_defects_in_produced_outputs_of", "reference_diagnoses_agent_execution_trajectory_of"])(
		"新关系 %s 保留正反向与空专有属性，不产生完成证明",
		(relationKind) => {
			for (const currentTaskIsStatementSubject of [true, false]) {
				const parsed = referenceRelationModelingDraftSchema.parse({
					...draft,
					relationKind,
					currentTaskIsStatementSubject,
				});
				const relation = planReferenceRelationModelingChanges(root, [parsed], [], [], 10).relationsAfterChange[0];
				expect(relation.relationKind).toBe(relationKind);
				expect(relation.relationStatementSubjectWorkUnitRef).toEqual(
					currentTaskIsStatementSubject ? root : draft.counterpartWorkUnit,
				);
				expect(relation.relationStatementAnchorWorkUnitRef).toEqual(
					currentTaskIsStatementSubject ? draft.counterpartWorkUnit : root,
				);
				expect(relation.assertedRelationKindSpecificAttributes).toEqual({});
			}
		},
	);
	it("跨 project 资格使用当前位置，关系身份与去重仍使用 canonical identity", () => {
		const identities = createEmptyKanbanBoardCardIdentityProjectionState();
		const counterpart = { ...root, taskId: "other" };
		for (const ref of [root, counterpart]) {
			identities.projectionsByKanbanBoardCardWorkUnitKey.set(buildInterWorkUnitRelationWorkUnitKey(ref), {
				kanbanBoardCard: ref,
				currentWorkspaceId: ref === root ? "project" : "transferred-project",
				kanbanBoardCardFirstObservationRoute: "board_state_baseline_at_live_capture_activation",
				firstObservedAt: 1,
				creationActor: null,
				creationOnBehalfOfInitiatingWorkUnit: null,
				currentFieldValueSha256ByFieldName: {},
				lastKnownBoardColumnId: "backlog",
				movedToTrashColumnAt: null,
				permanentlyRemovedFromBoardAt: null,
			});
		}
		const crossProjectDraft = {
			...draft,
			counterpartWorkUnit: counterpart,
			relationKind: "reference_is_cross_repository_counterpart_with" as const,
		};
		const first = planReferenceRelationModelingChanges(root, [crossProjectDraft], [], [], 10, identities)
			.relationsAfterChange[0];
		expect(first.relationStatementAnchorWorkUnitRef).toEqual(counterpart);
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[{ ...crossProjectDraft, currentTaskIsStatementSubject: false }],
				[],
				[first],
				11,
				identities,
			),
		).toThrow(/相同类型/);
		const counterpartIdentity = identities.projectionsByKanbanBoardCardWorkUnitKey.get(
			buildInterWorkUnitRelationWorkUnitKey(counterpart),
		);
		if (!counterpartIdentity) throw new Error("缺少隔离身份");
		counterpartIdentity.currentWorkspaceId = "project";
		expect(() => planReferenceRelationModelingChanges(root, [crossProjectDraft], [], [], 12, identities)).toThrow(
			/仅限不同 project/,
		);
	});
	it("草稿保存与恢复保留无效详情原文，账本写入的证据长度校验保持严格", () => {
		const invalidEvidence = "x".repeat(1001);
		const saved = relationModelingEditorDraftSaveRequestSchema.parse({
			workspaceId: "project",
			draftScopeId: "task:browser-tab",
			draft: {
				referenceRelationDrafts: [draft],
				relationRevocations: [],
				createdTaskId: null,
				modelingSubmissionId: "submission",
				invalidReferenceRelationDetailsFormsByDraftId: {
					[draft.draftId]: {
						selectedReferenceRelationKind: "",
						currentTaskIsStatementSubject: false,
						relationAssertionRationaleOneSentenceText: "",
						relationAssertionEvidencePointersOnePerLineText: invalidEvidence,
						concernedAspectSummaryText: "",
						selectedConcernNature: "",
						claimsUnderVerificationOnePerLineText: "",
						reusedOutputSummaryText: "",
						reusedOutputPointersOnePerLineText: "",
						originatedRequirementPortionSummaryText: "",
						sharedCrossRepositoryContractPointerText: "",
					},
				},
			},
		});
		const restored = referenceRelationModelingEditorDraftSchema.parse(JSON.parse(JSON.stringify(saved.draft)));
		expect(restored.invalidReferenceRelationDetailsFormsByDraftId?.[draft.draftId]).toMatchObject({
			currentTaskIsStatementSubject: false,
			relationAssertionEvidencePointersOnePerLineText: invalidEvidence,
		});
		expect(
			referenceRelationModelingDraftSchema.safeParse({
				...draft,
				relationAssertionEvidencePointers: [invalidEvidence],
			}).success,
		).toBe(false);
	});
	it("仅选择任务时规范化为普通关联，理由、证据与属性保持空值", () => {
		const minimalDraft = referenceRelationModelingDraftSchema.parse({
			draftId: "minimal",
			counterpartWorkUnit: draft.counterpartWorkUnit,
		});
		const relation = planReferenceRelationModelingChanges(root, [minimalDraft], [], [], 10).relationsAfterChange[0];
		expect(relation).toMatchObject({
			relationKind: "reference_is_generally_related_with",
			relationAssertionRationaleOneSentence: "",
			relationAssertionEvidencePointers: [],
			assertedRelationKindSpecificAttributes: {},
		});
	});
	it.each(ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS)("人工 %s 可省略全部详情，仍可反向", (relationKind) => {
		const minimalDraft = referenceRelationModelingDraftSchema.parse({
			draftId: "minimal",
			counterpartWorkUnit: { ...draft.counterpartWorkUnit, workspaceId: "other-project" },
			relationKind,
			currentTaskIsStatementSubject: false,
		});
		const relation = planReferenceRelationModelingChanges(root, [minimalDraft], [], [], 10).relationsAfterChange[0];
		expect(relation.relationStatementAnchorWorkUnitRef).toEqual(root);
		expect(relation.assertedRelationKindSpecificAttributes).toEqual({});
	});
	it("可选详情仍校验字段格式、类型归属和跨仓限制", () => {
		expect(referenceRelationModelingDraftSchema.safeParse({ ...draft, relationKind: "unknown" }).success).toBe(false);
		expect(
			referenceRelationModelingDraftSchema.safeParse({
				...draft,
				relationAssertionRationaleOneSentence: "x".repeat(601),
			}).success,
		).toBe(false);
		expect(
			referenceRelationModelingDraftSchema.safeParse({
				...draft,
				assertedRelationKindSpecificAttributes: { concernNature: "unknown" },
			}).success,
		).toBe(false);
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[{ ...draft, assertedRelationKindSpecificAttributes: { reusedOutputSummary: "错误类型的属性" } }],
				[],
				[],
				10,
			),
		).toThrow(/does not take/);
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[{ ...draft, relationKind: "reference_is_cross_repository_counterpart_with" }],
				[],
				[],
				10,
			),
		).toThrow(/仅限不同 project/);
	});
	it("替代旧断言保留历史，移除证据而不是取并集", () => {
		const first = planReferenceRelationModelingChanges(root, [draft], [], [], 10).relationsAfterChange[0];
		const edit = {
			...draft,
			replacesRelationId: first.relationId,
			expectedAssertedRelationStateVersion: 1,
			relationAssertionEvidencePointers: ["new.md"],
		};
		const result = planReferenceRelationModelingChanges(root, [edit], [], [first], 20);
		expect(result.relationsAfterChange[0]).toMatchObject({
			relationId: first.relationId,
			assertionEffectivenessState: "revoked",
			relationAssertionRevocationReason: "superseded_by_user_revision",
		});
		expect(result.relationsAfterChange[1].relationAssertionEvidencePointers).toEqual(["new.md"]);
		expect(result.relationsAfterChange[1].relationId).not.toBe(first.relationId);
	});
	it("拒绝过期版本、自指以及对称关系反向重复", () => {
		const first = planReferenceRelationModelingChanges(root, [draft], [], [], 10).relationsAfterChange[0];
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[{ ...draft, replacesRelationId: first.relationId, expectedAssertedRelationStateVersion: 2 }],
				[],
				[first],
				20,
			),
		).toThrow(/已变化/);
		expect(() =>
			planReferenceRelationModelingChanges(root, [{ ...draft, counterpartWorkUnit: root }], [], [], 20),
		).toThrow();
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[{ ...draft, currentTaskIsStatementSubject: false }],
				[],
				[first],
				20,
			),
		).toThrow(/已存在/);
	});
	it("不能修改不触及当前任务的关系", () => {
		const first = planReferenceRelationModelingChanges({ ...root, taskId: "third" }, [draft], [], [], 10)
			.relationsAfterChange[0];
		expect(() =>
			planReferenceRelationModelingChanges(
				root,
				[],
				[
					{
						relationId: first.relationId,
						expectedAssertedRelationStateVersion: 1,
						relationAssertionRevocationReason: "relation_was_incorrect",
					},
				],
				[first],
				20,
			),
		).toThrow(/当前任务/);
	});
});
