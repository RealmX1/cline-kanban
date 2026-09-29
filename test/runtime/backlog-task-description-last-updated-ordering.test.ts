import { describe, expect, it } from "vitest";

import { type RuntimeBoardCard, type RuntimeBoardData, runtimeBoardCardSchema } from "../../src/core/api-contract";
import {
	hasTaskDescriptionContentChanged,
	resolveTaskDescriptionLastUpdatedAt,
	sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending,
} from "../../src/core/backlog-task-description-last-updated-ordering";

function createCard(
	id: string,
	timestamps: { createdAt?: number; updatedAt: number; taskDescriptionLastUpdatedAt?: number },
): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `Prompt ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: timestamps.createdAt ?? 1,
		updatedAt: timestamps.updatedAt,
		...(timestamps.taskDescriptionLastUpdatedAt !== undefined
			? { taskDescriptionLastUpdatedAt: timestamps.taskDescriptionLastUpdatedAt }
			: {}),
	};
}

function createBoard(backlogCards: RuntimeBoardCard[], inProgressCards: RuntimeBoardCard[] = []): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: inProgressCards },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("resolveTaskDescriptionLastUpdatedAt", () => {
	it("returns the stored description timestamp when present", () => {
		expect(resolveTaskDescriptionLastUpdatedAt({ taskDescriptionLastUpdatedAt: 10, updatedAt: 99 })).toBe(10);
	});

	it("falls back to updatedAt for legacy cards without the field", () => {
		expect(resolveTaskDescriptionLastUpdatedAt({ updatedAt: 99 })).toBe(99);
	});
});

describe("hasTaskDescriptionContentChanged", () => {
	it("detects prompt text changes", () => {
		expect(
			hasTaskDescriptionContentChanged({
				previousPrompt: "old",
				previousImages: undefined,
				nextPrompt: "new",
				nextImages: undefined,
			}),
		).toBe(true);
	});

	it("treats undefined and empty image lists as identical", () => {
		expect(
			hasTaskDescriptionContentChanged({
				previousPrompt: "same",
				previousImages: undefined,
				nextPrompt: "same",
				nextImages: [],
			}),
		).toBe(false);
	});

	it("compares images by id sequence", () => {
		const base = { previousPrompt: "same", nextPrompt: "same" };
		expect(
			hasTaskDescriptionContentChanged({ ...base, previousImages: [{ id: "a" }], nextImages: [{ id: "a" }] }),
		).toBe(false);
		expect(
			hasTaskDescriptionContentChanged({ ...base, previousImages: [{ id: "a" }], nextImages: [{ id: "b" }] }),
		).toBe(true);
		expect(
			hasTaskDescriptionContentChanged({
				...base,
				previousImages: [{ id: "a" }],
				nextImages: [{ id: "a" }, { id: "b" }],
			}),
		).toBe(true);
		expect(
			hasTaskDescriptionContentChanged({
				...base,
				previousImages: [{ id: "a" }, { id: "b" }],
				nextImages: [{ id: "b" }, { id: "a" }],
			}),
		).toBe(true);
	});
});

describe("sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending", () => {
	it("orders backlog cards by description timestamp, most recent first", () => {
		const board = createBoard([
			createCard("old", { updatedAt: 50, taskDescriptionLastUpdatedAt: 10 }),
			createCard("newest", { updatedAt: 30, taskDescriptionLastUpdatedAt: 30 }),
			createCard("middle", { updatedAt: 90, taskDescriptionLastUpdatedAt: 20 }),
		]);
		const sorted = sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(board);
		expect(sorted.columns[0]?.cards.map((card) => card.id)).toEqual(["newest", "middle", "old"]);
	});

	it("uses the updatedAt fallback for legacy cards", () => {
		const board = createBoard([
			createCard("tracked", { updatedAt: 5, taskDescriptionLastUpdatedAt: 5 }),
			createCard("legacy", { updatedAt: 40 }),
		]);
		const sorted = sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(board);
		expect(sorted.columns[0]?.cards.map((card) => card.id)).toEqual(["legacy", "tracked"]);
	});

	it("keeps the existing order for equal timestamps (stable sort)", () => {
		const board = createBoard([
			createCard("first", { updatedAt: 1, taskDescriptionLastUpdatedAt: 7 }),
			createCard("lower", { updatedAt: 1, taskDescriptionLastUpdatedAt: 3 }),
			createCard("second", { updatedAt: 1, taskDescriptionLastUpdatedAt: 7 }),
		]);
		const sorted = sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(board);
		expect(sorted.columns[0]?.cards.map((card) => card.id)).toEqual(["first", "second", "lower"]);
	});

	it("only reorders the backlog column", () => {
		const inProgressCards = [
			createCard("in-progress-old", { updatedAt: 1, taskDescriptionLastUpdatedAt: 1 }),
			createCard("in-progress-new", { updatedAt: 9, taskDescriptionLastUpdatedAt: 9 }),
		];
		const board = createBoard(
			[
				createCard("backlog-old", { updatedAt: 1, taskDescriptionLastUpdatedAt: 1 }),
				createCard("backlog-new", { updatedAt: 9, taskDescriptionLastUpdatedAt: 9 }),
			],
			inProgressCards,
		);
		const sorted = sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(board);
		expect(sorted.columns[0]?.cards.map((card) => card.id)).toEqual(["backlog-new", "backlog-old"]);
		expect(sorted.columns[1]?.cards).toBe(inProgressCards);
	});

	it("returns the same board reference when the backlog is already sorted", () => {
		const board = createBoard([
			createCard("new", { updatedAt: 9, taskDescriptionLastUpdatedAt: 9 }),
			createCard("old", { updatedAt: 1, taskDescriptionLastUpdatedAt: 1 }),
		]);
		expect(sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(board)).toBe(board);
	});
});

describe("runtimeBoardCardSchema taskDescriptionLastUpdatedAt", () => {
	const legacyCard = {
		id: "legacy",
		prompt: "Legacy prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 2,
	};

	it("parses legacy cards that predate the field", () => {
		const parsed = runtimeBoardCardSchema.parse(legacyCard);
		expect(parsed.taskDescriptionLastUpdatedAt).toBeUndefined();
	});

	it("keeps the field instead of stripping it as an unknown key", () => {
		const parsed = runtimeBoardCardSchema.parse({ ...legacyCard, taskDescriptionLastUpdatedAt: 3 });
		expect(parsed.taskDescriptionLastUpdatedAt).toBe(3);
	});
});
