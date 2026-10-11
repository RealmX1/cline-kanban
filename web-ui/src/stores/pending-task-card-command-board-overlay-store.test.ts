import { afterEach, describe, expect, it } from "vitest";

import {
	addPendingTaskCardCommandBoardOverlayEntries,
	hasPendingTaskCardCommandBoardOverlayEntryForTaskCard,
	prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard,
	readPendingTaskCardCommandBoardOverlayEntries,
	resetPendingTaskCardCommandBoardOverlayStore,
} from "@/stores/pending-task-card-command-board-overlay-store";
import type { BoardData } from "@/types";

// overlay 条目按 workspace 分存；回灌的 board 体现了期望就退场。

function boardWithTaskInColumn(taskId: string, columnId: "review" | "trash"): BoardData {
	const card = {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	};
	return {
		columns: [
			{ id: "review", title: "Review", cards: columnId === "review" ? [card] : [] },
			{ id: "trash", title: "Done", cards: columnId === "trash" ? [card] : [] },
		],
	};
}

afterEach(() => {
	resetPendingTaskCardCommandBoardOverlayStore();
});

describe("pending task card command board overlay store", () => {
	it("按 workspace 分存：别的项目的同号卡不受影响", () => {
		addPendingTaskCardCommandBoardOverlayEntries("ws-1", [
			{
				pendingTaskCardCommandOverlayEntryId: "entry-1",
				taskId: "task-1",
				expectedBoardEffect: {
					pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
					targetBoardColumnId: "trash",
				},
			},
		]);
		expect(hasPendingTaskCardCommandBoardOverlayEntryForTaskCard("ws-1", "task-1")).toBe(true);
		expect(hasPendingTaskCardCommandBoardOverlayEntryForTaskCard("ws-2", "task-1")).toBe(false);
	});

	it("回灌的 board 体现了期望才退场", () => {
		addPendingTaskCardCommandBoardOverlayEntries("ws-1", [
			{
				pendingTaskCardCommandOverlayEntryId: "entry-1",
				taskId: "task-1",
				expectedBoardEffect: {
					pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
					targetBoardColumnId: "trash",
				},
			},
		]);
		prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard("ws-1", boardWithTaskInColumn("task-1", "review"));
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toHaveLength(1);
		prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard("ws-1", boardWithTaskInColumn("task-1", "trash"));
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toEqual([]);
	});
});
