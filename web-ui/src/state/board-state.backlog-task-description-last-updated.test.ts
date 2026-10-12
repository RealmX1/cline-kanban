import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDragResult, normalizeBoardData, updateTask } from "@/state/board-state";
import type { BoardData } from "@/types";

function createRawCard(
	id: string,
	timestamps: { createdAt: number; updatedAt: number; taskDescriptionLastUpdatedAt?: number },
) {
	return {
		id,
		prompt: `Prompt ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		...timestamps,
	};
}

function normalizeBacklog(rawBacklogCards: unknown[]): BoardData {
	const normalized = normalizeBoardData({
		columns: [
			{ id: "backlog", cards: rawBacklogCards },
			{ id: "in_progress", cards: [] },
			{ id: "review", cards: [] },
			{ id: "validation", cards: [] },
			{ id: "trash", cards: [] },
		],
	});
	if (!normalized) {
		throw new Error("expected normalized board");
	}
	return normalized;
}

function backlogCards(board: BoardData) {
	return board.columns.find((column) => column.id === "backlog")?.cards ?? [];
}

afterEach(() => {
	vi.useRealTimers();
});

describe("normalizeBoardData taskDescriptionLastUpdatedAt", () => {
	it("keeps the persisted field through the normalizeCard whitelist", () => {
		const board = normalizeBacklog([
			createRawCard("tracked", { createdAt: 1, updatedAt: 50, taskDescriptionLastUpdatedAt: 20 }),
		]);
		expect(backlogCards(board)[0]?.taskDescriptionLastUpdatedAt).toBe(20);
	});

	it("materializes the updatedAt fallback for legacy cards instead of now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const board = normalizeBacklog([createRawCard("legacy", { createdAt: 1, updatedAt: 40 })]);
		expect(backlogCards(board)[0]?.taskDescriptionLastUpdatedAt).toBe(40);
	});

	it("sorts legacy manual backlog order by description timestamp on hydration", () => {
		const board = normalizeBacklog([
			createRawCard("old", { createdAt: 1, updatedAt: 90, taskDescriptionLastUpdatedAt: 10 }),
			createRawCard("legacy-newest", { createdAt: 1, updatedAt: 60 }),
			createRawCard("middle", { createdAt: 1, updatedAt: 30, taskDescriptionLastUpdatedAt: 30 }),
		]);
		expect(backlogCards(board).map((card) => card.id)).toEqual(["legacy-newest", "middle", "old"]);
	});
});

describe("updateTask taskDescriptionLastUpdatedAt", () => {
	function createTwoCardBacklog(): BoardData {
		return normalizeBacklog([
			createRawCard("newer", { createdAt: 200, updatedAt: 200, taskDescriptionLastUpdatedAt: 200 }),
			createRawCard("older", { createdAt: 100, updatedAt: 100, taskDescriptionLastUpdatedAt: 100 }),
		]);
	}

	it("advances and moves the card to the top when the description changes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(300);
		const result = updateTask(createTwoCardBacklog(), "older", { prompt: "Rewritten description", baseRef: "main" });

		expect(result.updated).toBe(true);
		expect(backlogCards(result.board).map((card) => card.id)).toEqual(["older", "newer"]);
		expect(backlogCards(result.board)[0]?.taskDescriptionLastUpdatedAt).toBe(300);
	});

	it("advances when only the attached images change", () => {
		vi.useFakeTimers();
		vi.setSystemTime(300);
		const result = updateTask(createTwoCardBacklog(), "older", {
			prompt: "Prompt older",
			baseRef: "main",
			images: [{ id: "img-1", data: "abc", mimeType: "image/png" }],
		});
		expect(backlogCards(result.board).find((card) => card.id === "older")?.taskDescriptionLastUpdatedAt).toBe(300);
	});

	it("keeps the timestamp and order when only non-description fields change", () => {
		vi.useFakeTimers();
		vi.setSystemTime(300);
		const result = updateTask(createTwoCardBacklog(), "older", {
			title: "Renamed",
			prompt: "Prompt older",
			baseRef: "develop",
			agentId: "codex",
			startInPlanMode: true,
		});

		const olderCard = backlogCards(result.board).find((card) => card.id === "older");
		expect(olderCard?.updatedAt).toBe(300);
		expect(olderCard?.taskDescriptionLastUpdatedAt).toBe(100);
		expect(backlogCards(result.board).map((card) => card.id)).toEqual(["newer", "older"]);
	});
});

describe("applyDragResult backlog reorder", () => {
	it("ignores same-column drops inside the backlog", () => {
		const board = normalizeBacklog([
			createRawCard("newer", { createdAt: 200, updatedAt: 200, taskDescriptionLastUpdatedAt: 200 }),
			createRawCard("older", { createdAt: 100, updatedAt: 100, taskDescriptionLastUpdatedAt: 100 }),
		]);
		const result = applyDragResult(board, {
			draggableId: "older",
			type: "CARD",
			source: { droppableId: "backlog", index: 1 },
			destination: { droppableId: "backlog", index: 0 },
			mode: "FLUID",
			reason: "DROP",
			combine: null,
		});
		expect(result.board).toBe(board);
		expect(result.moveEvent).toBeUndefined();
	});
});
