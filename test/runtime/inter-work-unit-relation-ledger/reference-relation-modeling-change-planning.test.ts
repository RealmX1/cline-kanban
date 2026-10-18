import { describe, expect, it } from "vitest";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import type { ReferenceRelationModelingDraft } from "../../../src/core/work-unit-relation-modeling-api-contract";
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
