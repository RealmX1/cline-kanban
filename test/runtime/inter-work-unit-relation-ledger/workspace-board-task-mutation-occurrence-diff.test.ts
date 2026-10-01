import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";
import {
	buildWorkspaceBoardSnapshotWithRetainedFieldContents,
	diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences,
} from "../../../src/inter-work-unit-relation-ledger/workspace-board-task-mutation-occurrence-diff";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "t0001",
		title: "requirement",
		prompt: "requirement",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

function boardWith(columnId: "backlog" | "review" | "trash", cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: columnId === "backlog" ? cards : [] },
			{ id: "review", title: "Review", cards: columnId === "review" ? cards : [] },
			{ id: "trash", title: "Done", cards: columnId === "trash" ? cards : [] },
		],
		dependencies: [],
	};
}

function diff(previous: RuntimeBoardData, next: RuntimeBoardData) {
	return diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences(
		buildWorkspaceBoardSnapshotWithRetainedFieldContents(previous).snapshot,
		buildWorkspaceBoardSnapshotWithRetainedFieldContents(next).snapshot,
	).map((occurrence) => ({
		eventKind: occurrence.eventKind,
		changedTaskCardFieldName: occurrence.eventPayloadSpecificToEventKind.changedTaskCardFieldName ?? null,
	}));
}

describe("workspace board task mutation occurrence diff", () => {
	it("ignores derived timestamps, including a materialized taskDescriptionLastUpdatedAt on a legacy card", () => {
		expect(
			diff(
				boardWith("backlog", [createCard()]),
				boardWith("backlog", [createCard({ updatedAt: 2_000, taskDescriptionLastUpdatedAt: 1_000 })]),
			),
		).toEqual([]);
	});

	it("records a prompt edit as a field value change of the prompt (and its derived title)", () => {
		expect(
			diff(
				boardWith("backlog", [createCard()]),
				boardWith("backlog", [
					createCard({ prompt: "amended", title: "amended", taskDescriptionLastUpdatedAt: 3_000 }),
				]),
			),
		).toEqual([
			{ eventKind: "task_card_field_value_changed", changedTaskCardFieldName: "prompt" },
			{ eventKind: "task_card_field_value_changed", changedTaskCardFieldName: "title" },
		]);
	});

	it("distinguishes trash, restore and plain column moves", () => {
		expect(diff(boardWith("review", [createCard()]), boardWith("trash", [createCard()]))).toEqual([
			{ eventKind: "task_card_moved_to_trash_column", changedTaskCardFieldName: null },
		]);
		expect(diff(boardWith("trash", [createCard()]), boardWith("backlog", [createCard()]))).toEqual([
			{ eventKind: "task_card_restored_from_trash_column", changedTaskCardFieldName: null },
		]);
		expect(diff(boardWith("backlog", [createCard()]), boardWith("review", [createCard()]))).toEqual([
			{ eventKind: "task_card_moved_between_non_trash_board_columns", changedTaskCardFieldName: null },
		]);
	});

	it("treats a reused task id with a new incarnation as removal of the old card plus creation of a new one", () => {
		expect(
			diff(boardWith("backlog", [createCard()]), boardWith("backlog", [createCard({ createdAt: 9_000 })])),
		).toEqual([
			{ eventKind: "task_card_permanently_removed_from_board", changedTaskCardFieldName: null },
			{ eventKind: "task_card_created_on_board", changedTaskCardFieldName: null },
		]);
	});
});
