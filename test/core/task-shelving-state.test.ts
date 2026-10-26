import { describe, expect, it } from "vitest";
import { type RuntimeBoardData, runtimeBoardCardSchema } from "../../src/core/api-contract";
import { moveTaskToColumn } from "../../src/core/task-board-mutations";
import {
	isTaskCardShelved,
	preservePersistedTaskShelvingAgainstIncomingBoardSnapshot,
	setTaskCardShelvingState,
} from "../../src/core/task-shelving-state";

const stages = ["backlog", "in_progress", "review", "validation", "trash"] as const;
function createBoard(): RuntimeBoardData {
	return {
		columns: stages.map((id) => ({
			id,
			title: id,
			cards: [
				{
					id,
					prompt: id,
					title: id,
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		})),
	};
}

describe("独立任务搁置状态", () => {
	it("旧数据默认未搁置", () => {
		const card = runtimeBoardCardSchema.parse(createBoard().columns[0]?.cards[0]);
		expect(card.taskShelvingState).toBeUndefined();
		expect(isTaskCardShelved(card)).toBe(false);
	});
	it.each(stages)("%s 的搁置往返保持 Stage，重复请求不刷新时间", (stage) => {
		const original = createBoard();
		const shelved = setTaskCardShelvingState(original, stage, true, 100);
		expect(shelved.updated).toBe(true);
		expect(shelved.board.columns.find((column) => column.id === stage)?.cards[0]?.taskShelvingState).toEqual({
			isShelved: true,
			lastChangedAt: 100,
		});
		expect(setTaskCardShelvingState(shelved.board, stage, true, 200).board).toBe(shelved.board);
		expect(moveTaskToColumn(shelved.board, stage, stage === "review" ? "in_progress" : "review").moved).toBe(false);
		const unshelved = setTaskCardShelvingState(shelved.board, stage, false, 300);
		expect(unshelved.board.columns.find((column) => column.id === stage)?.cards[0]?.taskShelvingState).toEqual({
			isShelved: false,
			lastChangedAt: 300,
		});
		expect(setTaskCardShelvingState(unshelved.board, stage, false, 400).updated).toBe(false);
	});
	it("解除搁置后的旧快照也不能重放搁置期间的移列", () => {
		const original = createBoard();
		const shelved = setTaskCardShelvingState(original, "review", true, 100).board;
		const unshelved = setTaskCardShelvingState(shelved, "review", false, 200).board;
		const staleMoved = moveTaskToColumn(original, "review", "in_progress").board;
		const protectedBoard = preservePersistedTaskShelvingAgainstIncomingBoardSnapshot(unshelved, staleMoved);
		expect(protectedBoard.columns.find((column) => column.id === "review")?.cards[0]?.taskShelvingState).toEqual({
			isShelved: false,
			lastChangedAt: 200,
		});
	});
	it("陈旧整板不能丢失搁置卡、覆盖搁置状态或更改原 Stage", () => {
		const original = createBoard();
		const persisted = setTaskCardShelvingState(original, "review", true, 100).board;
		const moved = moveTaskToColumn(original, "review", "in_progress").board;
		const restored = preservePersistedTaskShelvingAgainstIncomingBoardSnapshot(persisted, moved);
		expect(restored.columns.find((column) => column.id === "review")?.cards[0]?.taskShelvingState?.isShelved).toBe(
			true,
		);
		expect(restored.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(1);
		const missing = { columns: original.columns.map((column) => ({ ...column, cards: [] })) };
		expect(
			preservePersistedTaskShelvingAgainstIncomingBoardSnapshot(persisted, missing).columns.find(
				(column) => column.id === "review",
			)?.cards,
		).toHaveLength(1);
	});
});
