import {
	isPinnedToTaskPinboard,
	pinTaskToTaskPinboard,
	setTaskPinboardPinReason,
	unpinTaskFromTaskPinboard,
} from "@runtime-task-pinboard-pinning";
import { describe, expect, it } from "vitest";
import { collectTasksPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import type { BoardCard, BoardData } from "@/types";

function createCard(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Prompt ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1_000,
		updatedAt: 2_000,
		...overrides,
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createCard("backlog-task")] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("in-progress-task")] },
			{ id: "review", title: "Review", cards: [createCard("review-task")] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [createCard("done-task")] },
		],
	};
}

describe("task pinboard pinning", () => {
	it("pins a task with a reason and reports it as pinned", () => {
		const { board, updated } = pinTaskToTaskPinboard(createBoard(), "review-task", {
			pinReason: "  blocked on review feedback  ",
			pinnedAt: 5_000,
		});

		expect(updated).toBe(true);
		const pinnedCard = board.columns[2]?.cards[0];
		expect(pinnedCard?.pinnedToTaskPinboardAt).toBe(5_000);
		// 原因两端裁空白后存，避免「看着有原因、实际是空格」。
		expect(pinnedCard?.taskPinboardPinReason).toBe("blocked on review feedback");
		expect(pinnedCard && isPinnedToTaskPinboard(pinnedCard)).toBe(true);
	});

	it("omits the reason field entirely when the reason is left blank", () => {
		const { board } = pinTaskToTaskPinboard(createBoard(), "review-task", { pinReason: "   ", pinnedAt: 5_000 });

		const pinnedCard = board.columns[2]?.cards[0];
		expect(pinnedCard?.pinnedToTaskPinboardAt).toBe(5_000);
		expect(pinnedCard).not.toHaveProperty("taskPinboardPinReason");
	});

	// 置顶表达的是「我要盯着它」，不是任务内容被改动。bump updatedAt 会污染以「最近更新的卡」
	// 为默认目标的逻辑（例如 Focus View 折叠 Done 列时挑哪张卡还原）。
	it("does not bump updatedAt when pinning, editing the reason, or unpinning", () => {
		const pinned = pinTaskToTaskPinboard(createBoard(), "review-task", { pinnedAt: 5_000 });
		expect(pinned.board.columns[2]?.cards[0]?.updatedAt).toBe(2_000);

		const reasonEdited = setTaskPinboardPinReason(pinned.board, "review-task", "still waiting");
		expect(reasonEdited.board.columns[2]?.cards[0]?.updatedAt).toBe(2_000);

		const unpinned = unpinTaskFromTaskPinboard(reasonEdited.board, "review-task");
		expect(unpinned.board.columns[2]?.cards[0]?.updatedAt).toBe(2_000);
	});

	// 「编辑原因」不该顺带把卡片顶到置顶板最前——位置是用户对「我什么时候盯上它的」的记忆锚点。
	it("keeps the original pin timestamp when pinning an already-pinned task again", () => {
		const firstPin = pinTaskToTaskPinboard(createBoard(), "review-task", { pinReason: "first", pinnedAt: 5_000 });
		const secondPin = pinTaskToTaskPinboard(firstPin.board, "review-task", { pinReason: "second", pinnedAt: 9_000 });

		const pinnedCard = secondPin.board.columns[2]?.cards[0];
		expect(pinnedCard?.pinnedToTaskPinboardAt).toBe(5_000);
		expect(pinnedCard?.taskPinboardPinReason).toBe("second");
	});

	it("clears both the pin timestamp and the reason when unpinning", () => {
		const pinned = pinTaskToTaskPinboard(createBoard(), "review-task", { pinReason: "why", pinnedAt: 5_000 });
		const { board, updated } = unpinTaskFromTaskPinboard(pinned.board, "review-task");

		expect(updated).toBe(true);
		const unpinnedCard = board.columns[2]?.cards[0];
		expect(unpinnedCard).not.toHaveProperty("pinnedToTaskPinboardAt");
		expect(unpinnedCard).not.toHaveProperty("taskPinboardPinReason");
	});

	it("reports no update when the task id is unknown or already in the requested state", () => {
		const board = createBoard();
		expect(pinTaskToTaskPinboard(board, "no-such-task").updated).toBe(false);
		expect(unpinTaskFromTaskPinboard(board, "review-task").updated).toBe(false);
		// 未置顶的卡不接受原因，避免出现「有原因却没置顶」的孤立态。
		expect(setTaskPinboardPinReason(board, "review-task", "why").updated).toBe(false);
	});

	it("returns the same board reference when nothing changed", () => {
		const board = createBoard();
		expect(unpinTaskFromTaskPinboard(board, "review-task").board).toBe(board);
	});

	// 置顶板扁平列出、按置顶时间倒序：stage 已由分身上的标签表达，再分组会让「最近盯上的那个」下沉。
	it("collects pinned tasks across stages sorted by most recently pinned first", () => {
		let board = createBoard();
		board = pinTaskToTaskPinboard(board, "backlog-task", { pinnedAt: 1_000 }).board;
		board = pinTaskToTaskPinboard(board, "done-task", { pinnedAt: 3_000 }).board;
		board = pinTaskToTaskPinboard(board, "review-task", { pinnedAt: 2_000 }).board;

		const pinnedTasks = collectTasksPinnedToTaskPinboard(board);

		expect(pinnedTasks.map((pinnedTask) => pinnedTask.card.id)).toEqual(["done-task", "review-task", "backlog-task"]);
		// 分身上的 stage 标签直接用列自己的 title，所以 trash 列显示为 "Done"。
		expect(pinnedTasks[0]?.columnId).toBe("trash");
		expect(pinnedTasks[0]?.columnTitle).toBe("Done");
		expect(pinnedTasks[2]?.columnId).toBe("backlog");
	});

	it("breaks ties on the pin timestamp by task id so the render order stays stable", () => {
		let board = createBoard();
		board = pinTaskToTaskPinboard(board, "review-task", { pinnedAt: 7_000 }).board;
		board = pinTaskToTaskPinboard(board, "backlog-task", { pinnedAt: 7_000 }).board;

		expect(collectTasksPinnedToTaskPinboard(board).map((pinnedTask) => pinnedTask.card.id)).toEqual([
			"backlog-task",
			"review-task",
		]);
	});

	it("collects nothing on a board with no pinned tasks", () => {
		expect(collectTasksPinnedToTaskPinboard(createBoard())).toEqual([]);
	});
});
