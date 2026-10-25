import { describe, expect, it } from "vitest";
import { workUnitSelectorForRelationReadSchema } from "../../../src/core/work-unit-relation-read-api-contract";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	type KanbanBoardCardIdentityProjection,
} from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { createEmptyRecordedInterWorkUnitRelationProjectionState } from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import { resolveWorkUnitSelectorAgainstRecordedRelationProjection } from "../../../src/trpc/work-unit-relation-read-api";

describe("Relations 前台视图按完整一世读取", () => {
	const state = createEmptyRecordedInterWorkUnitRelationProjectionState();
	for (const [workspaceId, incarnation, removed] of [
		["project-a", 1, true],
		["project-a", 2, false],
		["project-b", 1, false],
	] as const) {
		const projection: KanbanBoardCardIdentityProjection = {
			kanbanBoardCard: {
				workUnitType: "kanban_board_card",
				workspaceId,
				taskId: "same-id",
				taskIncarnationCreatedAtEpochMs: incarnation,
			},
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture",
			firstObservedAt: incarnation,
			creationActor: null,
			creationOnBehalfOfInitiatingWorkUnit: null,
			currentFieldValueSha256ByFieldName: {},
			lastKnownBoardColumnId: removed ? null : "in_progress",
			movedToTrashColumnAt: null,
			permanentlyRemovedFromBoardAt: removed ? 10 : null,
		};
		const key = buildInterWorkUnitRelationWorkUnitKey(projection.kanbanBoardCard);
		state.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.set(key, projection);
		const keys =
			state.kanbanBoardCardIdentityProjectionState.kanbanBoardCardWorkUnitKeysByBareTaskId.get("same-id") ?? [];
		keys.push(key);
		state.kanbanBoardCardIdentityProjectionState.kanbanBoardCardWorkUnitKeysByBareTaskId.set("same-id", keys);
	}
	it("旧链接读旧一世墓碑，不能被当前同 ID 或其他 workspace 替换", () => {
		const reference = {
			workUnitType: "kanban_board_card" as const,
			workspaceId: "project-a",
			taskId: "same-id",
			taskIncarnationCreatedAtEpochMs: 1,
		};
		const selector = workUnitSelectorForRelationReadSchema.parse({
			workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
			kanbanBoardCard: reference,
		});
		expect(resolveWorkUnitSelectorAgainstRecordedRelationProjection(state, selector)).toEqual(reference);
	});
	it("未知一世明确失败，不降级到裸 ID", () => {
		expect(() =>
			resolveWorkUnitSelectorAgainstRecordedRelationProjection(state, {
				workUnitSelectorKind: "kanban_board_card_by_qualified_reference",
				kanbanBoardCard: {
					workUnitType: "kanban_board_card",
					workspaceId: "project-a",
					taskId: "same-id",
					taskIncarnationCreatedAtEpochMs: 99,
				},
			}),
		).toThrow("没有这一世任务");
	});
	it("既有裸 ID 调用继续选择 workspace 中的当前一世", () => {
		expect(
			resolveWorkUnitSelectorAgainstRecordedRelationProjection(state, {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				workspaceId: "project-a",
				bareTaskId: "same-id",
			}),
		).toMatchObject({ taskIncarnationCreatedAtEpochMs: 2 });
	});
});
