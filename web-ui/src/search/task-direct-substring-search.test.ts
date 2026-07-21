import { describe, expect, it } from "vitest";

import { buildTaskBoardSearchDocuments, type TaskBoardSearchProjectContext } from "@/search/task-board-search";
import {
	collectAllSubstringMatchPositions,
	findDirectSubstringTaskBoardSearchResults,
} from "@/search/task-direct-substring-search";
import type { BoardData } from "@/types";

const PROJECT_CONTEXT: TaskBoardSearchProjectContext = { projectId: "proj-a", projectName: "Project A" };

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-cross",
						title: "API observability",
						prompt: "Include structured logs in the runtime task session",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "task-billing",
						title: "Billing API cleanup",
						prompt: "Refactor endpoint handlers",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "task-display",
						title: "Improve task display",
						prompt: "Add database migration notes to the original prompt viewer",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "task-prompt-only",
						title: "Zeta rollout",
						prompt: "call the api endpoint",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("collectAllSubstringMatchPositions", () => {
	it("returns an empty set for an empty needle", () => {
		expect(collectAllSubstringMatchPositions("anything", "")).toEqual(new Set<number>());
	});

	it("collects every non-overlapping occurrence", () => {
		expect(collectAllSubstringMatchPositions("axaxa", "a")).toEqual(new Set([0, 2, 4]));
	});

	it("collects overlapping occurrences so every covered character is highlighted", () => {
		expect(collectAllSubstringMatchPositions("aaaa", "aa")).toEqual(new Set([0, 1, 2, 3]));
	});
});

describe("findDirectSubstringTaskBoardSearchResults", () => {
	it("returns nothing for an empty query", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		expect(findDirectSubstringTaskBoardSearchResults(documents, "   ")).toEqual([]);
	});

	it("matches a single word against the title and highlights every covered character", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findDirectSubstringTaskBoardSearchResults(documents, "billing");

		expect(results).toHaveLength(1);
		expect(results[0]?.document.taskId).toBe("task-billing");
		expect(results[0]?.matchSources).toEqual(["title"]);
		// "Billing" 覆盖 title 下标 0..6
		expect([...(results[0]?.titleMatchCharacterPositions ?? [])].sort((a, b) => a - b)).toEqual([
			0, 1, 2, 3, 4, 5, 6,
		]);
	});

	it("is case-insensitive", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findDirectSubstringTaskBoardSearchResults(documents, "BILLING");

		expect(results.map((result) => result.document.taskId)).toEqual(["task-billing"]);
	});

	it("requires every whitespace-separated token to match (AND across title or prompt)", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		// "api" 命中 task-billing 的 title、"handlers" 命中其 prompt → 两词都中，入选且双字段来源。
		const results = findDirectSubstringTaskBoardSearchResults(documents, "api handlers");

		expect(results.map((result) => result.document.taskId)).toEqual(["task-billing"]);
		expect(results[0]?.matchSources).toEqual(["title", "prompt"]);
	});

	it("excludes tasks where not every token matches somewhere", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		// "billing" 仅在 task-billing、"migration" 仅在 task-display —— 无单卡同时含两词。
		const results = findDirectSubstringTaskBoardSearchResults(documents, "billing migration");

		expect(results).toEqual([]);
	});

	it("ranks title hits before prompt-only hits, then by earliest title match position", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findDirectSubstringTaskBoardSearchResults(documents, "api");

		// task-cross: title "API..." @0；task-billing: title "...API..." @8；task-prompt-only: 仅 prompt 命中 → 最后。
		expect(results.map((result) => result.document.taskId)).toEqual([
			"task-cross",
			"task-billing",
			"task-prompt-only",
		]);
		expect(results[2]?.matchSources).toEqual(["prompt"]);
	});
});
