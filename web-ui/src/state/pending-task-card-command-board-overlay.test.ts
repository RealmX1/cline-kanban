import { describe, expect, it } from "vitest";

import {
	applyPendingTaskCardCommandBoardOverlay,
	isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard,
	type PendingTaskCardCommandBoardOverlayEntry,
} from "@/state/pending-task-card-command-board-overlay";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 卡片动作在途时叠在渲染层的 overlay：不持久化，服务端回灌满足期望后退场。

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function board(cardsByColumn: Partial<Record<BoardColumnId, BoardCard[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return { columns: columnIds.map((id) => ({ id, title: id, cards: cardsByColumn[id] ?? [] })) };
}

function columnTaskIds(target: BoardData, columnId: BoardColumnId): string[] {
	return target.columns.find((column) => column.id === columnId)?.cards.map((entry) => entry.id) ?? [];
}

const moveToDone: PendingTaskCardCommandBoardOverlayEntry = {
	pendingTaskCardCommandOverlayEntryId: "command-1",
	taskId: "a",
	expectedBoardEffect: {
		pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
		targetBoardColumnId: "trash",
	},
};

describe("applyPendingTaskCardCommandBoardOverlay", () => {
	it("没有条目时原样返回同一引用", () => {
		const source = board({ review: [card("a")] });
		expect(applyPendingTaskCardCommandBoardOverlay(source, [])).toBe(source);
	});

	it("移列：默认放到目标列顶部，给了落点就放到落点", () => {
		const source = board({ review: [card("a")], trash: [card("x"), card("y")] });
		expect(columnTaskIds(applyPendingTaskCardCommandBoardOverlay(source, [moveToDone]), "trash")).toEqual([
			"a",
			"x",
			"y",
		]);
		const withDropIndex: PendingTaskCardCommandBoardOverlayEntry = {
			...moveToDone,
			expectedBoardEffect: {
				...moveToDone.expectedBoardEffect,
				insertAtIndex: 1,
			} as PendingTaskCardCommandBoardOverlayEntry["expectedBoardEffect"],
		};
		expect(columnTaskIds(applyPendingTaskCardCommandBoardOverlay(source, [withDropIndex]), "trash")).toEqual([
			"x",
			"a",
			"y",
		]);
	});

	it("改字段与删除；卡已不在时 overlay 不凭空造卡", () => {
		const source = board({ review: [card("a"), card("b")] });
		const renamed = applyPendingTaskCardCommandBoardOverlay(source, [
			{
				pendingTaskCardCommandOverlayEntryId: "command-2",
				taskId: "a",
				expectedBoardEffect: {
					pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
					taskCardFieldPatch: { title: "renamed" },
				},
			},
			{
				pendingTaskCardCommandOverlayEntryId: "command-3",
				taskId: "b",
				expectedBoardEffect: { pendingTaskCardCommandExpectedBoardEffectKind: "task_card_removed_from_board" },
			},
		]);
		expect(renamed.columns.find((column) => column.id === "review")?.cards.map((entry) => entry.title)).toEqual([
			"renamed",
		]);
		expect(applyPendingTaskCardCommandBoardOverlay(board({}), [moveToDone])).toEqual(board({}));
	});
});

describe("isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard", () => {
	it("不带落点的移列只认列成员、不认落点", () => {
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(board({ review: [card("a")] }), moveToDone),
		).toBe(false);
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ trash: [card("x"), card("a")] }),
				moveToDone,
			),
		).toBe(true);
	});

	it("同列重排：命令发出前那份未变化的 board 不得满足，落到期望落点才满足", () => {
		const reorderWithinInProgress: PendingTaskCardCommandBoardOverlayEntry = {
			pendingTaskCardCommandOverlayEntryId: "command-6",
			taskId: "a",
			expectedBoardEffect: {
				pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
				targetBoardColumnId: "in_progress",
				insertAtIndex: 2,
			},
		};
		const boardBeforeCommand = board({ in_progress: [card("a"), card("b"), card("c")] });
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(boardBeforeCommand, reorderWithinInProgress),
		).toBe(false);
		const boardWithOverlayApplied = applyPendingTaskCardCommandBoardOverlay(boardBeforeCommand, [
			reorderWithinInProgress,
		]);
		expect(columnTaskIds(boardWithOverlayApplied, "in_progress")).toEqual(["b", "c", "a"]);
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(boardWithOverlayApplied, reorderWithinInProgress),
		).toBe(true);
	});

	it("落点越界时按移除自身后的列长夹取，与 apply 同一语义", () => {
		const reorderPastColumnEnd: PendingTaskCardCommandBoardOverlayEntry = {
			pendingTaskCardCommandOverlayEntryId: "command-7",
			taskId: "a",
			expectedBoardEffect: {
				pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
				targetBoardColumnId: "in_progress",
				insertAtIndex: 99,
			},
		};
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ in_progress: [card("b"), card("c"), card("a")] }),
				reorderPastColumnEnd,
			),
		).toBe(true);
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ in_progress: [card("a"), card("b"), card("c")] }),
				reorderPastColumnEnd,
			),
		).toBe(false);
	});

	it("带落点的跨列移动既要进目标列、也要落在落点上", () => {
		const moveIntoValidationAtDropIndex: PendingTaskCardCommandBoardOverlayEntry = {
			pendingTaskCardCommandOverlayEntryId: "command-8",
			taskId: "a",
			expectedBoardEffect: {
				pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
				targetBoardColumnId: "validation",
				insertAtIndex: 1,
			},
		};
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ review: [card("a")], validation: [card("x"), card("y")] }),
				moveIntoValidationAtDropIndex,
			),
		).toBe(false);
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ validation: [card("x"), card("a"), card("y")] }),
				moveIntoValidationAtDropIndex,
			),
		).toBe(true);
	});

	it("改字段按值比较；删除以卡不在为满足", () => {
		const renameEntry: PendingTaskCardCommandBoardOverlayEntry = {
			pendingTaskCardCommandOverlayEntryId: "command-4",
			taskId: "a",
			expectedBoardEffect: {
				pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
				taskCardFieldPatch: { title: "renamed", autoReviewEnabled: false },
			},
		};
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ review: [card("a", { title: "renamed" })] }),
				renameEntry,
			),
		).toBe(false);
		expect(
			isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
				board({ review: [card("a", { title: "renamed", autoReviewEnabled: false })] }),
				renameEntry,
			),
		).toBe(true);
		const removeEntry: PendingTaskCardCommandBoardOverlayEntry = {
			pendingTaskCardCommandOverlayEntryId: "command-5",
			taskId: "a",
			expectedBoardEffect: { pendingTaskCardCommandExpectedBoardEffectKind: "task_card_removed_from_board" },
		};
		expect(isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(board({}), removeEntry)).toBe(true);
	});
});
