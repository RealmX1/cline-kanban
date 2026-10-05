import type { DropResult } from "@hello-pangea/dnd";
import { describe, expect, it } from "vitest";

import {
	placeTaskCardIntoBoardColumnAtIndexByTaskId,
	resolveTaskCardDropFromDragResultByTaskId,
} from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 拖放落点按 taskId 解出：看板显示的是叠了 overlay 的 displayedBoard，source.index 与会被保存的 board 下标可能不一致。

function card(taskId: string): BoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	};
}

function board(cardsByColumn: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((id) => ({ id, title: id, cards: (cardsByColumn[id] ?? []).map(card) })),
	};
}

function drop(taskId: string, from: [BoardColumnId, number], to: [BoardColumnId, number]): DropResult {
	return {
		draggableId: taskId,
		type: "CARD",
		source: { droppableId: from[0], index: from[1] },
		destination: { droppableId: to[0], index: to[1] },
		reason: "DROP",
		mode: "FLUID",
		combine: null,
	};
}

describe("resolveTaskCardDropFromDragResultByTaskId", () => {
	it("按 taskId 定位源列，不信任 source.index（显示层下标与内存 board 不一致时也不会取错卡）", () => {
		// 显示层里 review 列第 0 张是 overlay 挪进来的别的卡；内存 board 里 task-b 在第 1 位。
		const resolved = resolveTaskCardDropFromDragResultByTaskId(
			board({ review: ["task-a", "task-b"] }),
			drop("task-b", ["review", 0], ["validation", 0]),
		);
		expect(resolved).toEqual({
			taskCardDropKind: "task_card_moved_between_board_columns",
			taskId: "task-b",
			fromColumnId: "review",
			toColumnId: "validation",
			destinationIndex: 0,
		});
	});

	it("drag-rules 不允许的跨列、backlog 列内重排、落回原位都不算有效落点", () => {
		const current = board({ backlog: ["task-1", "task-2"], review: ["task-r"] });
		expect(
			resolveTaskCardDropFromDragResultByTaskId(current, drop("task-r", ["review", 0], ["backlog", 0]))
				.taskCardDropKind,
		).toBe("no_effective_task_card_drop");
		expect(
			resolveTaskCardDropFromDragResultByTaskId(current, drop("task-1", ["backlog", 0], ["backlog", 1]))
				.taskCardDropKind,
		).toBe("no_effective_task_card_drop");
		expect(
			resolveTaskCardDropFromDragResultByTaskId(current, drop("task-r", ["review", 0], ["review", 0]))
				.taskCardDropKind,
		).toBe("no_effective_task_card_drop");
	});

	it("in_progress 列内重排给出目标下标；程序化移动要求插到列顶时落点为 0", () => {
		expect(
			resolveTaskCardDropFromDragResultByTaskId(
				board({ in_progress: ["task-1", "task-2"] }),
				drop("task-1", ["in_progress", 0], ["in_progress", 1]),
			),
		).toEqual({
			taskCardDropKind: "task_card_reordered_within_board_column",
			taskId: "task-1",
			boardColumnId: "in_progress",
			destinationIndex: 1,
		});
		expect(
			resolveTaskCardDropFromDragResultByTaskId(
				board({ backlog: ["task-1"], in_progress: ["task-x", "task-y"] }),
				drop("task-1", ["backlog", 0], ["in_progress", 2]),
				{
					programmaticCardMoveInFlight: {
						taskId: "task-1",
						fromColumnId: "backlog",
						toColumnId: "in_progress",
						insertAtTop: true,
					},
				},
			),
		).toMatchObject({ destinationIndex: 0 });
	});
});

describe("placeTaskCardIntoBoardColumnAtIndexByTaskId", () => {
	it("按 taskId 放到目标列的下标（夹取到列长）；跨列推 updatedAt，列内重排不推", () => {
		const current = board({ in_progress: ["task-1", "task-2", "task-3"], review: ["task-r"] });
		const reordered = placeTaskCardIntoBoardColumnAtIndexByTaskId(current, "task-1", "in_progress", 99);
		expect(reordered.board.columns[1]?.cards.map((entry) => entry.id)).toEqual(["task-2", "task-3", "task-1"]);
		expect(reordered.board.columns[1]?.cards[2]?.updatedAt).toBe(0);

		const moved = placeTaskCardIntoBoardColumnAtIndexByTaskId(current, "task-r", "in_progress", 0);
		expect(moved.board.columns[1]?.cards.map((entry) => entry.id)).toEqual(["task-r", "task-1", "task-2", "task-3"]);
		expect(moved.board.columns[2]?.cards).toEqual([]);
		expect(moved.board.columns[1]?.cards[0]?.updatedAt).toBeGreaterThan(0);
	});
});
