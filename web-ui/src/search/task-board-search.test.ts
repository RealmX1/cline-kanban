import { describe, expect, it } from "vitest";

import {
	buildTaskBoardSearchDocuments,
	findFuzzyTaskBoardSearchResults,
	mergeTaskBoardSearchResults,
	orderMatchSources,
	type TaskBoardSearchMatchSource,
	type TaskBoardSearchProjectContext,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
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
		dependencies: [],
	};
}

function createManualResult(
	document: TaskBoardSearchResult["document"],
	overrides: Partial<TaskBoardSearchResult>,
): TaskBoardSearchResult {
	return {
		document,
		score: 1,
		matchSources: ["title"],
		titleMatchCharacterPositions: new Set<number>(),
		promptMatchCharacterPositions: new Set<number>(),
		...overrides,
	};
}

describe("task board search", () => {
	it("builds one combined search subject per task, carrying project identity and lowercase fields", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);

		expect(documents).toHaveLength(3);
		expect(documents[0]?.taskSearchSubjectText).toBe("Billing API cleanup\nRefactor endpoint handlers");
		expect(documents[0]?.projectId).toBe("proj-a");
		expect(documents[0]?.projectName).toBe("Project A");
		expect(documents[0]?.titleLowerCase).toBe("billing api cleanup");
		expect(documents[0]?.promptLowerCase).toBe("refactor endpoint handlers");
	});

	it("marks title matches with the title source and maps highlight positions into the title field", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findFuzzyTaskBoardSearchResults(documents, "billing");

		expect(results[0]?.document.taskId).toBe("task-title");
		expect(results[0]?.matchSources).toEqual(["title"]);
		expect(results[0]?.titleMatchCharacterPositions.size).toBeGreaterThan(0);
		expect(results[0]?.promptMatchCharacterPositions.size).toBe(0);
		const titleLength = documents[0]?.title.length ?? 0;
		expect([...(results[0]?.titleMatchCharacterPositions ?? [])].every((position) => position < titleLength)).toBe(
			true,
		);
	});

	it("marks prompt matches with the prompt source and maps positions into the prompt field", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findFuzzyTaskBoardSearchResults(documents, "database migration");
		const promptResult = results.find((result) => result.document.taskId === "task-prompt");

		expect(promptResult?.matchSources).toEqual(["prompt"]);
		expect(promptResult?.titleMatchCharacterPositions.size ?? 0).toBe(0);
		expect(promptResult?.promptMatchCharacterPositions.size ?? 0).toBeGreaterThan(0);
	});

	it("can mark both fields when query terms land across title and prompt", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const results = findFuzzyTaskBoardSearchResults(documents, "api logs");
		const crossFieldResult = results.find((result) => result.document.taskId === "task-cross-field");

		expect(crossFieldResult?.matchSources).toEqual(["title", "prompt"]);
	});

	it("matches only inside the title when the scope is title only, with positions local to the title", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const titleOnlyResults = findFuzzyTaskBoardSearchResults(documents, "billing", "title_only");
		const titleResult = titleOnlyResults.find((result) => result.document.taskId === "task-title");

		expect(titleResult?.matchSources).toEqual(["title"]);
		expect(titleResult?.promptMatchCharacterPositions.size).toBe(0);
		const titleLength = titleResult?.document.title.length ?? 0;
		expect([...(titleResult?.titleMatchCharacterPositions ?? [])].every((position) => position < titleLength)).toBe(
			true,
		);
		expect(
			findFuzzyTaskBoardSearchResults(documents, "database migration", "title_only").some(
				(result) => result.document.taskId === "task-prompt",
			),
		).toBe(false);
	});

	it("matches only inside the prompt when the scope is prompt only, with positions local to the prompt", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const promptResult = findFuzzyTaskBoardSearchResults(documents, "database migration", "prompt_only").find(
			(result) => result.document.taskId === "task-prompt",
		);

		expect(promptResult?.matchSources).toEqual(["prompt"]);
		expect(promptResult?.titleMatchCharacterPositions.size).toBe(0);
		// 单字段主体下 positions 就是 prompt 内的局部下标：首个命中字符必须真的是 prompt 里的 "d"。
		const earliestPromptPosition = Math.min(...(promptResult?.promptMatchCharacterPositions ?? []));
		expect(promptResult?.document.prompt[earliestPromptPosition]?.toLowerCase()).toBe("d");
		expect(
			findFuzzyTaskBoardSearchResults(documents, "billing", "prompt_only").some(
				(result) => result.document.taskId === "task-title",
			),
		).toBe(false);
	});

	it("does not let a narrowed scope keep a subsequence that only exists across the title/prompt boundary", () => {
		// "api logs" 在合并主体上横跨 title 与 prompt 才凑得齐；只看标题时它根本不成立，
		// 所以收窄范围必须换匹配主体，不能在合并主体上匹配后再按字段筛位置。
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);

		expect(
			findFuzzyTaskBoardSearchResults(documents, "api logs", "title_only").some(
				(result) => result.document.taskId === "task-cross-field",
			),
		).toBe(false);
	});

	it("merges fuzzy and semantic results by document reference, unioning sources and positions", () => {
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const targetDocument = documents[0];
		if (!targetDocument) {
			throw new Error("expected a document");
		}
		const merged = mergeTaskBoardSearchResults(
			[
				createManualResult(targetDocument, {
					score: 10,
					matchSources: ["title"],
					titleMatchCharacterPositions: new Set([0, 1]),
				}),
			],
			[
				createManualResult(targetDocument, {
					score: 7,
					matchSources: ["prompt"],
					promptMatchCharacterPositions: new Set([3]),
				}),
			],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.document).toBe(targetDocument);
		expect(merged[0]?.score).toBe(10);
		expect(merged[0]?.matchSources).toEqual(["title", "prompt"]);
		expect([...(merged[0]?.titleMatchCharacterPositions ?? [])]).toEqual([0, 1]);
		expect([...(merged[0]?.promptMatchCharacterPositions ?? [])]).toEqual([3]);
	});

	it("does not collide across two projects that share a taskId", () => {
		const documentsA = buildTaskBoardSearchDocuments(createBoard(), { projectId: "proj-a", projectName: "A" });
		const documentsB = buildTaskBoardSearchDocuments(createBoard(), { projectId: "proj-b", projectName: "B" });
		const documentA = documentsA[0];
		const documentB = documentsB[0];
		if (!documentA || !documentB) {
			throw new Error("expected documents");
		}
		expect(documentA.taskId).toBe(documentB.taskId);

		const merged = mergeTaskBoardSearchResults(
			[createManualResult(documentA, {})],
			[createManualResult(documentB, {})],
		);

		expect(merged).toHaveLength(2);
		expect(merged.map((result) => result.document.projectId).sort()).toEqual(["proj-a", "proj-b"]);
	});
});

describe("taskId match source", () => {
	it("orders taskId ahead of title and prompt", () => {
		const sources = new Set<TaskBoardSearchMatchSource>(["prompt", "title", "taskId"]);

		expect(orderMatchSources(sources)).toEqual(["taskId", "title", "prompt"]);
	});

	it("keeps the taskId source when merging a task-id hit with a text hit", () => {
		// merge 的合并分支会过 orderMatchSources，漏了 taskId 分支就会在这里静默丢来源。
		const documents = buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
		const targetDocument = documents[0];
		if (!targetDocument) {
			throw new Error("expected document");
		}

		const merged = mergeTaskBoardSearchResults(
			[createManualResult(targetDocument, { matchSources: ["taskId"] })],
			[
				createManualResult(targetDocument, {
					matchSources: ["title"],
					titleMatchCharacterPositions: new Set([0]),
				}),
			],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.matchSources).toEqual(["taskId", "title"]);
	});
});
