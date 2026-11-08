import { describe, expect, it } from "vitest";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import { referenceRelationModelingDraftSchema } from "../../../src/core/work-unit-relation-modeling-api-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { createEmptyRecordedInterWorkUnitRelationProjectionState } from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import { planReferenceRelationModelingChanges } from "../../../src/inter-work-unit-relation-ledger/reference-relation-modeling-change-planning";
import { collectBoundedRelationModelingNeighborhood } from "../../../src/inter-work-unit-relation-ledger/relation-modeling-multi-hop-preview";
import { buildRelationModelingPreview } from "../../../src/trpc/work-unit-relation-modeling-preview";

describe("关系建模的有界多跳预览", () => {
	const relations = [
		{ relationId: "ab", subjectKey: "a", anchorKey: "b" },
		{ relationId: "bc", subjectKey: "b", anchorKey: "c" },
		{ relationId: "cd", subjectKey: "c", anchorKey: "d" },
		{ relationId: "ca", subjectKey: "c", anchorKey: "a" },
	];
	it("双向遍历混合关系，循环不重复，深度按最短路径计算", () => {
		const result = collectBoundedRelationModelingNeighborhood("a", relations, 2);
		expect(result.workUnitKeys).toEqual(["a", "b", "c", "d"]);
		expect(result.relationIds).toEqual(["ab", "bc", "ca", "cd"]);
		expect(result.truncated).toBe(false);
	});
	it("两跳不包含第三跳，展开到三跳后出现", () => {
		const chain = relations.slice(0, 3);
		expect(collectBoundedRelationModelingNeighborhood("a", chain, 2).workUnitKeys).toEqual(["a", "b", "c"]);
		expect(collectBoundedRelationModelingNeighborhood("a", chain, 3).workUnitKeys).toEqual(["a", "b", "c", "d"]);
	});
	it("节点与关系上限可见，任何返回关系的两个端点均已返回", () => {
		const result = collectBoundedRelationModelingNeighborhood("a", relations, 3, {
			maximumNodes: 2,
			maximumRelations: 1,
		});
		expect(result.workUnitKeys).toEqual(["a", "b"]);
		expect(result.relationIds).toEqual(["ab"]);
		expect(result.truncated).toBe(true);
	});
	it.each([1, 2, 3] as const)("%s 跳图已满时仍返回全部草稿对端的当前归属，且不扩张图预算", async (depth) => {
		const projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
		const root: KanbanBoardCardWorkUnitQualifiedReference = {
			workUnitType: "kanban_board_card",
			workspaceId: "project-a",
			taskId: "root",
			taskIncarnationCreatedAtEpochMs: 1,
		};
		for (let index = 0; index < 149; index++) {
			const draft = referenceRelationModelingDraftSchema.parse({
				draftId: `saved-${index}`,
				counterpartWorkUnit: { ...root, taskId: `neighbor-${index}` },
			});
			const relation = planReferenceRelationModelingChanges(root, [draft], [], [], 1).relationsAfterChange[0];
			projectionState.assertedInterWorkUnitRelationProjectionState.assertedRelationsByRelationId.set(
				relation.relationId,
				relation,
			);
		}
		const counterpart = { ...root, taskId: "pending" };
		projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.set(
			buildInterWorkUnitRelationWorkUnitKey(counterpart),
			{
				kanbanBoardCard: counterpart,
				currentWorkspaceId: "project-b",
				kanbanBoardCardFirstObservationRoute: "board_state_baseline_at_live_capture_activation",
				firstObservedAt: 1,
				creationActor: null,
				creationOnBehalfOfInitiatingWorkUnit: null,
				currentFieldValueSha256ByFieldName: {},
				lastKnownBoardColumnId: "backlog",
				movedToTrashColumnAt: null,
				permanentlyRemovedFromBoardAt: null,
			},
		);
		const draft = referenceRelationModelingDraftSchema.parse({
			draftId: "pending",
			counterpartWorkUnit: counterpart,
			relationKind: "reference_is_cross_repository_counterpart_with",
		});
		const preview = await buildRelationModelingPreview(
			{
				projectionState,
				readRetainedTaskCardFieldValuesBySha256: async () => new Map<string, unknown>(),
				findRetainedTaskCardFieldKeywordMatchesBySha256: async () => new Map<string, number[]>(),
			},
			root,
			{
				workUnit: null,
				draftTaskTitle: "本任务",
				relationNeighborhoodDepth: depth,
				referenceRelationDrafts: [draft, { ...draft, draftId: "same-counterpart" }],
				relationRevocations: [],
			},
			(workspaceId) => `/repo/${workspaceId}`,
		);
		expect(preview.truncated).toBe(true);
		expect(preview.relations).toHaveLength(149);
		expect(new Set(preview.relations.flatMap((relation) => [relation.subjectKey, relation.anchorKey])).size).toBe(
			150,
		);
		const counterpartEntries = preview.workUnits.filter(
			(entry) => entry.workUnitKey === buildInterWorkUnitRelationWorkUnitKey(counterpart),
		);
		expect(counterpartEntries).toHaveLength(1);
		expect(counterpartEntries[0]?.kanbanBoardCardIdentity?.kanbanBoardCard.workspaceId).toBe("project-b");
		expect(counterpartEntries[0]?.workUnit).toEqual(counterpart);
	});
});
