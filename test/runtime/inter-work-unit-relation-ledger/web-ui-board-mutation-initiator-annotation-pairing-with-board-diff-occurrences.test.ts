import { describe, expect, it } from "vitest";

import type { KanbanActor } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import { resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations } from "../../../src/inter-work-unit-relation-ledger/web-ui-board-mutation-initiator-annotation-pairing-with-board-diff-occurrences";
import type { BoardDerivedTaskMutationOccurrence } from "../../../src/inter-work-unit-relation-ledger/workspace-board-task-mutation-occurrence-diff";

const WEB_UI_REQUEST_WITHOUT_ANNOTATION: KanbanActor = {
	kanbanActorKind: "kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
};

const MOVED_TO_TRASH: BoardDerivedTaskMutationOccurrence = {
	eventKind: "task_card_moved_to_trash_column",
	taskId: "t0001",
	taskIncarnationCreatedAtEpochMs: 1_000,
	eventPayloadSpecificToEventKind: { fromBoardColumnId: "review", toBoardColumnId: "trash" },
};

const PROMPT_EDITED: BoardDerivedTaskMutationOccurrence = {
	eventKind: "task_card_field_value_changed",
	taskId: "t0002",
	taskIncarnationCreatedAtEpochMs: 2_000,
	eventPayloadSpecificToEventKind: { changedTaskCardFieldName: "prompt" },
};

describe("web ui board mutation initiator annotation pairing", () => {
	it("pairs each occurrence of one whole-board save with its own initiator", () => {
		const annotations = [
			{
				taskId: "t0001",
				annotatedBoardMutationKind: "task_card_moved_to_trash_column" as const,
				toColumnId: "trash",
				boardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion" as const,
			},
			{
				taskId: "t0002",
				annotatedBoardMutationKind: "task_card_field_value_changed" as const,
				changedCardFieldNames: ["prompt", "title"],
				boardMutationInitiator: "web_ui_user_gesture" as const,
			},
		];
		expect(
			resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations({
				requestLevelResolvedKanbanActor: WEB_UI_REQUEST_WITHOUT_ANNOTATION,
				occurrence: MOVED_TO_TRASH,
				webUiBoardMutationInitiatorAnnotations: annotations,
			}),
		).toEqual({
			actor: {
				kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
				boardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion",
			},
			pairedWebUiBoardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion",
		});
		expect(
			resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations({
				requestLevelResolvedKanbanActor: WEB_UI_REQUEST_WITHOUT_ANNOTATION,
				occurrence: PROMPT_EDITED,
				webUiBoardMutationInitiatorAnnotations: annotations,
			}).actor,
		).toEqual({ kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" });
	});

	it("keeps the missing-annotation actor when no annotation matches the occurrence's column or field", () => {
		const resolved = resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations({
			requestLevelResolvedKanbanActor: WEB_UI_REQUEST_WITHOUT_ANNOTATION,
			occurrence: MOVED_TO_TRASH,
			webUiBoardMutationInitiatorAnnotations: [
				{
					taskId: "t0001",
					annotatedBoardMutationKind: "task_card_moved_to_trash_column",
					fromColumnId: "in_progress",
					boardMutationInitiator: "web_ui_user_gesture",
				},
			],
		});
		expect(resolved).toEqual({ actor: WEB_UI_REQUEST_WITHOUT_ANNOTATION, pairedWebUiBoardMutationInitiator: null });
	});

	it("never lets annotations override a request that was not verified as coming from a Kanban page", () => {
		const cliCardActor: KanbanActor = {
			kanbanActorKind: "kanban_board_card_work_unit",
			actingKanbanBoardCardWorkUnit: {
				workUnitType: "kanban_board_card",
				workspaceId: "w",
				taskId: "a1b2c",
				taskIncarnationCreatedAtEpochMs: 1,
			},
		};
		expect(
			resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations({
				requestLevelResolvedKanbanActor: cliCardActor,
				occurrence: MOVED_TO_TRASH,
				webUiBoardMutationInitiatorAnnotations: [
					{
						taskId: "t0001",
						annotatedBoardMutationKind: "task_card_moved_to_trash_column",
						boardMutationInitiator: "web_ui_user_gesture",
					},
				],
			}).actor,
		).toBe(cliCardActor);
	});
});
