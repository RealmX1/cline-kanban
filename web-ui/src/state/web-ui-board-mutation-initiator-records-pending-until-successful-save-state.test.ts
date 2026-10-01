import { afterEach, describe, expect, it } from "vitest";

import { moveTaskToColumn, updateTaskTitle } from "@/state/board-state";
import {
	buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload,
	deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary,
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	discardWebUiBoardMutationInitiatorRecordsCoveredBySuccessfulSaveState,
	readPendingWebUiBoardMutationInitiatorForTaskCardAspect,
	recordWebUiBoardMutationInitiatorForTaskCardAspect,
	recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards,
	withWebUiBoardMutationInitiatorRecordedForChangedTaskCards,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

function createTask(taskId: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(cardsByColumnId: Partial<Record<BoardColumnId, BoardCard[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((columnId) => ({ id: columnId, title: columnId, cards: cardsByColumnId[columnId] ?? [] })),
	};
}

// 顺序只取决于 board 的列序，与语义无关：按 (taskId, 种类) 排序后再比。
function sortByTaskIdThenAnnotatedKind<T extends { taskId: string; annotatedBoardMutationKind: string }>(
	entries: T[],
): T[] {
	return [...entries].sort((left, right) =>
		`${left.taskId}\u0000${left.annotatedBoardMutationKind}`.localeCompare(
			`${right.taskId}\u0000${right.annotatedBoardMutationKind}`,
		),
	);
}

function moveOrThrow(board: BoardData, taskId: string, targetColumnId: BoardColumnId): BoardData {
	const moved = moveTaskToColumn(board, taskId, targetColumnId);
	if (!moved.moved) {
		throw new Error(`Expected ${taskId} to move to ${targetColumnId}.`);
	}
	return moved.board;
}

afterEach(() => {
	discardAllPendingWebUiBoardMutationInitiatorRecords();
});

describe("deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary", () => {
	it("uses the runtime board diff vocabulary for creation, removal, field edits and every column transition", () => {
		const before = createBoard({
			backlog: [createTask("a")],
			in_progress: [createTask("b")],
			review: [createTask("c")],
			trash: [createTask("d"), createTask("e")],
		});
		const after = createBoard({
			in_progress: [createTask("a")],
			review: [createTask("b", { prompt: "Edited prompt", title: "Edited title", updatedAt: 99 })],
			trash: [createTask("c"), createTask("x")],
			validation: [createTask("d")],
		});

		expect(
			sortByTaskIdThenAnnotatedKind(deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary(before, after)),
		).toEqual(
			sortByTaskIdThenAnnotatedKind([
				{ taskId: "e", annotatedBoardMutationKind: "task_card_permanently_removed_from_board" },
				{
					taskId: "a",
					annotatedBoardMutationKind: "task_card_moved_between_non_trash_board_columns",
					fromColumnId: "backlog",
					toColumnId: "in_progress",
				},
				{
					taskId: "b",
					annotatedBoardMutationKind: "task_card_field_value_changed",
					changedCardFieldNames: ["prompt", "title"],
				},
				{
					taskId: "b",
					annotatedBoardMutationKind: "task_card_moved_between_non_trash_board_columns",
					fromColumnId: "in_progress",
					toColumnId: "review",
				},
				{
					taskId: "c",
					annotatedBoardMutationKind: "task_card_moved_to_trash_column",
					fromColumnId: "review",
					toColumnId: "trash",
				},
				{ taskId: "x", annotatedBoardMutationKind: "task_card_created_on_board" },
				{
					taskId: "d",
					annotatedBoardMutationKind: "task_card_restored_from_trash_column",
					fromColumnId: "trash",
					toColumnId: "validation",
				},
			]),
		);
	});

	it("ignores fields the runtime excludes from its field diff and treats undefined keys as absent", () => {
		const before = createBoard({ backlog: [createTask("a", { images: undefined })] });
		const after = createBoard({
			backlog: [createTask("a", { updatedAt: 50, taskDescriptionLastUpdatedAt: 50 })],
		});

		expect(deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary(before, after)).toEqual([]);
	});
});

describe("pending board mutation initiator records → saveState annotations", () => {
	it("annotates exactly the occurrences the save carries, with precise columns and field names", () => {
		const persisted = createBoard({ in_progress: [createTask("a")], review: [createTask("b")] });
		const afterUserTitleEdit = updateTaskTitle(persisted, "b", "Renamed by user").board;
		recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
			boardBeforeMutation: persisted,
			boardAfterMutation: afterUserTitleEdit,
			boardMutationInitiator: "web_ui_user_gesture",
		});
		const afterAutoflow = moveOrThrow(afterUserTitleEdit, "a", "review");
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "a",
			boardMutationAspectOfTaskCard: "task_card_column_placement",
			boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
		});

		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: persisted,
			boardAboutToBeSaved: afterAutoflow,
		});

		expect(sortByTaskIdThenAnnotatedKind(built.boardMutationInitiatorAnnotationsForTaskMutationEventCapture)).toEqual(
			[
				{
					taskId: "a",
					annotatedBoardMutationKind: "task_card_moved_between_non_trash_board_columns",
					fromColumnId: "in_progress",
					toColumnId: "review",
					boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
				},
				{
					taskId: "b",
					annotatedBoardMutationKind: "task_card_field_value_changed",
					changedCardFieldNames: ["title"],
					boardMutationInitiator: "web_ui_user_gesture",
				},
			],
		);
	});

	it("collapses a chain of moves inside one save window into the net transition, attributed to the latest mover", () => {
		const persisted = createBoard({ in_progress: [createTask("a")] });
		const afterUserMove = moveOrThrow(persisted, "a", "validation");
		recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
			boardBeforeMutation: persisted,
			boardAfterMutation: afterUserMove,
			boardMutationInitiator: "web_ui_user_gesture",
		});
		const afterInterruptedAutoflow = moveOrThrow(afterUserMove, "a", "trash");
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "a",
			boardMutationAspectOfTaskCard: "task_card_column_placement",
			boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
		});

		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: persisted,
			boardAboutToBeSaved: afterInterruptedAutoflow,
		});

		expect(built.boardMutationInitiatorAnnotationsForTaskMutationEventCapture).toEqual([
			{
				taskId: "a",
				annotatedBoardMutationKind: "task_card_moved_to_trash_column",
				fromColumnId: "in_progress",
				toColumnId: "trash",
				boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
			},
		]);
	});

	it("leaves occurrences without a known initiator unannotated (null record, or no record at all)", () => {
		const persisted = createBoard({ backlog: [createTask("a"), createTask("b")] });
		const afterBackfill = updateTaskTitle(persisted, "a", "AI suggested title").board;
		recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
			boardBeforeMutation: persisted,
			boardAfterMutation: afterBackfill,
			boardMutationInitiator: null,
		});
		const afterUnrecordedMove = moveOrThrow(afterBackfill, "b", "in_progress");

		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: persisted,
			boardAboutToBeSaved: afterUnrecordedMove,
		});

		expect(built.boardMutationInitiatorAnnotationsForTaskMutationEventCapture).toEqual([]);
	});

	it("does not annotate a record whose mutation never reached the board (no-op entry point)", () => {
		const persisted = createBoard({ review: [createTask("a")] });
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "a",
			boardMutationAspectOfTaskCard: "task_card_column_placement",
			boardMutationInitiator: "web_ui_user_gesture",
		});

		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: persisted,
			boardAboutToBeSaved: persisted,
		});

		expect(built.boardMutationInitiatorAnnotationsForTaskMutationEventCapture).toEqual([]);
	});

	it("emits nothing before the runtime's persisted board is known (not yet hydrated)", () => {
		const board = createBoard({ backlog: [createTask("a")] });
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "a",
			boardMutationAspectOfTaskCard: "task_card_creation",
			boardMutationInitiator: "web_ui_user_gesture",
		});

		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: null,
			boardAboutToBeSaved: board,
		});

		expect(built.boardMutationInitiatorAnnotationsForTaskMutationEventCapture).toEqual([]);
	});

	it("drops only the records covered by a successful save and keeps later ones", () => {
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "a",
			boardMutationAspectOfTaskCard: "task_card_column_placement",
			boardMutationInitiator: "web_ui_user_gesture",
		});
		const built = buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload({
			boardLastConfirmedPersistedByRuntime: createBoard({}),
			boardAboutToBeSaved: createBoard({}),
		});
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: "b",
			boardMutationAspectOfTaskCard: "task_card_field_values",
			boardMutationInitiator: "web_ui_user_gesture",
		});

		discardWebUiBoardMutationInitiatorRecordsCoveredBySuccessfulSaveState(
			built.pendingInitiatorRecordSequenceCoveredBySaveStatePayload,
		);

		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("a", "task_card_column_placement"),
		).toBeUndefined();
		expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect("b", "task_card_field_values")).toBe(
			"web_ui_user_gesture",
		);
	});

	it("records through a setBoard updater only when the updater actually changed the board", () => {
		const board = createBoard({ review: [createTask("a")] });
		const noOpUpdater = withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(
			"web_ui_user_gesture",
			(currentBoard) => currentBoard,
		);
		expect(noOpUpdater(board)).toBe(board);
		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("a", "task_card_column_placement"),
		).toBeUndefined();

		const movingUpdater = withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(
			"web_ui_user_gesture_post_deploy_verification_panel_completion",
			(currentBoard) => moveOrThrow(currentBoard, "a", "trash"),
		);
		movingUpdater(board);
		expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect("a", "task_card_column_placement")).toBe(
			"web_ui_user_gesture_post_deploy_verification_panel_completion",
		);
	});
});
