import { describe, expect, it } from "vitest";

import {
	buildTaskBoardSearchDocuments,
	createTaskBoardSearchState,
	findFuzzyTaskBoardSearchResults,
	mergeTaskBoardSearchResults,
} from "@/search/task-board-search";
import type { BoardData } from "@/types";

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-title",
						title: "Billing API cleanup",
						prompt: "Refactor endpoint handlers",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "task-prompt",
						title: "Improve task display",
						prompt: "Add database migration notes to the original prompt viewer",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-cross-field",
						title: "API observability",
						prompt: "Include structured logs in the runtime task session",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [
			{ id: "visible-dependency", fromTaskId: "task-title", toTaskId: "task-cross-field", createdAt: 1 },
			{ id: "hidden-dependency", fromTaskId: "task-title", toTaskId: "task-prompt", createdAt: 1 },
		],
	};
}

describe("task board search", () => {
	it("builds one combined search subject per task from title and prompt", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard());

		expect(documents).toHaveLength(3);
		expect(documents[0]?.taskSearchSubjectText).toBe("Billing API cleanup\nRefactor endpoint handlers");
	});

	it("marks title matches with the title source", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard());
		const results = findFuzzyTaskBoardSearchResults(documents, "billing");

		expect(results[0]?.taskId).toBe("task-title");
		expect(results[0]?.matchSources).toEqual(["title"]);
	});

	it("marks prompt matches with the prompt source", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard());
		const results = findFuzzyTaskBoardSearchResults(documents, "database migration");

		expect(results[0]?.taskId).toBe("task-prompt");
		expect(results[0]?.matchSources).toEqual(["prompt"]);
	});

	it("can mark both fields when query terms land across title and prompt", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard());
		const results = findFuzzyTaskBoardSearchResults(documents, "api logs");
		const crossFieldResult = results.find((result) => result.taskId === "task-cross-field");

		expect(crossFieldResult?.matchSources).toEqual(["title", "prompt"]);
	});

	it("keeps search active with an empty board when no result matches", () => {
		const board = createBoard();
		const state = createTaskBoardSearchState(board, [], true);

		expect(state.isSearchActive).toBe(true);
		expect(state.visibleTaskCount).toBe(0);
		expect(state.filteredBoard.columns.flatMap((column) => column.cards)).toHaveLength(0);
	});

	it("filters dependencies to visible search results only", () => {
		const board = createBoard();
		const state = createTaskBoardSearchState(
			board,
			[
				{ taskId: "task-title", score: 1, matchSources: ["title"] },
				{ taskId: "task-cross-field", score: 1, matchSources: ["prompt"] },
			],
			true,
		);

		expect(state.filteredDependencies.map((dependency) => dependency.id)).toEqual(["visible-dependency"]);
	});

	it("merges fuzzy and semantic sources per task", () => {
		const results = mergeTaskBoardSearchResults(
			[{ taskId: "task-1", score: 10, matchSources: ["title"] }],
			[{ taskId: "task-1", score: 7, matchSources: ["prompt"] }],
		);

		expect(results).toEqual([{ taskId: "task-1", score: 10, matchSources: ["title", "prompt"] }]);
	});
});
