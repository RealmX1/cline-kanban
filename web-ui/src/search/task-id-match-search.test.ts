import { describe, expect, it } from "vitest";

import {
	buildTaskBoardSearchDocument,
	type TaskBoardSearchDocument,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import {
	findTaskIdPartialOrExactMatchedSearchResults,
	hoistTaskIdMatchedResultsToTopByMatchTier,
} from "@/search/task-id-match-search";

function createDocument(overrides: {
	taskId: string;
	projectId?: string;
	title?: string;
	prompt?: string;
}): TaskBoardSearchDocument {
	return buildTaskBoardSearchDocument({
		projectId: overrides.projectId ?? "proj-a",
		projectName: overrides.projectId === "proj-b" ? "Project B" : "Project A",
		taskId: overrides.taskId,
		columnId: "backlog",
		title: overrides.title ?? "",
		prompt: overrides.prompt ?? "",
		taskCreatedAtEpochMs: 0,
		taskLastModifiedAtEpochMs: 0,
		taskAgentOverrideAgentId: null,
		mostRecentlyLaunchedAgentSessionAgentId: null,
	});
}

function createTextResult(
	document: TaskBoardSearchDocument,
	overrides: Partial<TaskBoardSearchResult> = {},
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

function listTaskIds(results: readonly TaskBoardSearchResult[]): string[] {
	return results.map((result) => result.document.taskId);
}

function listTaskIdMatchCharacterPositions(result: TaskBoardSearchResult | undefined): number[] {
	return [...(result?.taskIdMatchCharacterPositions ?? [])].sort((first, second) => first - second);
}

describe("findTaskIdPartialOrExactMatchedSearchResults", () => {
	const documents = [
		createDocument({ taskId: "a3f21", title: "Alpha rollout" }),
		createDocument({ taskId: "94c87", title: "Search bar work" }),
	];

	it("returns nothing for an empty query", () => {
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "   ")).toEqual([]);
	});

	it("returns nothing when the query is shorter than the minimum partial length", () => {
		// 1–2 位的偶然命中率太高，会把无关任务顶到最前。
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a3")).toEqual([]);
	});

	it("returns nothing when the query is not task-id shaped", () => {
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a3f210")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a3f-1")).toEqual([]);
	});

	it("returns nothing for a multi-token query even when one token is a task id", () => {
		// 「同时按 id 和文本过滤」是明确的非目标：归一化只压空白，范式正则不含空格。
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a3f21 fix")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "a3f fix")).toEqual([]);
	});

	it("returns nothing when a shape-valid query matches no task id", () => {
		// "fixed" 是个正好 5 位的普通英文词，会过范式闸门，但没有任何 taskId 与之相等、包含或只差一位。
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "fixed")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "zzz")).toEqual([]);
	});

	it("matches a complete task id with every id character highlighted and no text positions", () => {
		const results = findTaskIdPartialOrExactMatchedSearchResults(documents, "a3f21");

		expect(results).toHaveLength(1);
		expect(results[0]?.document).toBe(documents[0]);
		expect(results[0]?.matchSources).toEqual(["taskId"]);
		expect(results[0]?.titleMatchCharacterPositions.size).toBe(0);
		expect(results[0]?.promptMatchCharacterPositions.size).toBe(0);
		expect(listTaskIdMatchCharacterPositions(results[0])).toEqual([0, 1, 2, 3, 4]);
	});

	it("matches an uppercase pasted id against the lowercase generated id", () => {
		expect(listTaskIds(findTaskIdPartialOrExactMatchedSearchResults(documents, "A3F21"))).toEqual(["a3f21"]);
		expect(listTaskIds(findTaskIdPartialOrExactMatchedSearchResults(documents, "A3F"))).toEqual(["a3f21"]);
	});

	it("matches a task id prefix before the full id is typed", () => {
		const threeCharacterResults = findTaskIdPartialOrExactMatchedSearchResults(documents, "94c");
		const fourCharacterResults = findTaskIdPartialOrExactMatchedSearchResults(documents, "94c8");

		expect(listTaskIds(threeCharacterResults)).toEqual(["94c87"]);
		expect(listTaskIdMatchCharacterPositions(threeCharacterResults[0])).toEqual([0, 1, 2]);
		expect(listTaskIds(fourCharacterResults)).toEqual(["94c87"]);
		expect(listTaskIdMatchCharacterPositions(fourCharacterResults[0])).toEqual([0, 1, 2, 3]);
	});

	it("matches a substring that does not start the task id", () => {
		const results = findTaskIdPartialOrExactMatchedSearchResults(documents, "c87");

		expect(listTaskIds(results)).toEqual(["94c87"]);
		expect(listTaskIdMatchCharacterPositions(results[0])).toEqual([2, 3, 4]);
	});

	it("tolerates a single substituted character in a complete-length query", () => {
		const results = findTaskIdPartialOrExactMatchedSearchResults(documents, "94c97");

		expect(listTaskIds(results)).toEqual(["94c87"]);
		// 只高亮对得上的那几位，缺口正好指出错在哪一位。
		expect(listTaskIdMatchCharacterPositions(results[0])).toEqual([0, 1, 2, 4]);
	});

	it("tolerates a single adjacent transposition in a complete-length query", () => {
		const results = findTaskIdPartialOrExactMatchedSearchResults(documents, "9c487");

		expect(listTaskIds(results)).toEqual(["94c87"]);
		expect(listTaskIdMatchCharacterPositions(results[0])).toEqual([0, 3, 4]);
	});

	it("does not tolerate two mistakes, nor typos in a partial-length query", () => {
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "95c97")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "9c48")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(documents, "94c9")).toEqual([]);
	});

	it("orders tiers exact > prefix > substring > single-character typo regardless of input order", () => {
		const tieredDocuments = [
			createDocument({ taskId: "abc1f" }), // typo of "abc12"
			createDocument({ taskId: "9abc1" }), // substring "abc1"
			createDocument({ taskId: "abc12" }), // exact
			createDocument({ taskId: "abc1e" }), // typo of "abc12" too
		];

		expect(listTaskIds(findTaskIdPartialOrExactMatchedSearchResults(tieredDocuments, "abc12"))).toEqual([
			"abc12",
			"abc1f",
			"abc1e",
		]);
		expect(listTaskIds(findTaskIdPartialOrExactMatchedSearchResults(tieredDocuments, "abc1"))).toEqual([
			"abc1f",
			"abc12",
			"abc1e",
			"9abc1",
		]);
	});

	it("never matches a custom task id that is not generator-shaped", () => {
		// 可读的自定义 id（explicitTaskId）会让普通单词按子串命中，噪声估算也不再成立。
		const customIdDocuments = [createDocument({ taskId: "task-beta", title: "Beta cleanup" })];

		expect(findTaskIdPartialOrExactMatchedSearchResults(customIdDocuments, "beta")).toEqual([]);
		expect(findTaskIdPartialOrExactMatchedSearchResults(customIdDocuments, "task")).toEqual([]);
	});

	it("returns both documents when two projects share a task id, preserving input order", () => {
		const collidingDocuments = [
			createDocument({ taskId: "a3f21", projectId: "proj-a" }),
			createDocument({ taskId: "a3f21", projectId: "proj-b" }),
		];

		const results = findTaskIdPartialOrExactMatchedSearchResults(collidingDocuments, "a3f");

		expect(results.map((result) => result.document.projectId)).toEqual(["proj-a", "proj-b"]);
	});
});

describe("hoistTaskIdMatchedResultsToTopByMatchTier", () => {
	it("returns the very same array reference when nothing matches by id", () => {
		// 引用稳定性是硬约束：orderedResults 换引用会让 controller 的 useEffect([results]) 把 activeIndex 钉回 0。
		const documents = [createDocument({ taskId: "a3f21", title: "Alpha" })];
		const baseOrderedResults = [createTextResult(documents[0] as TaskBoardSearchDocument)];

		expect(hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "alpha")).toBe(
			baseOrderedResults,
		);
		expect(hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "")).toBe(baseOrderedResults);
	});

	it("adds a matched document that the base results never contained", () => {
		const idOnlyDocument = createDocument({ taskId: "a3f21", title: "Nothing textual here" });
		const textDocument = createDocument({ taskId: "94c87", title: "Alpha rollout" });
		const documents = [idOnlyDocument, textDocument];
		const baseOrderedResults = [createTextResult(textDocument)];

		const hoisted = hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "a3f21");

		expect(hoisted).toHaveLength(2);
		expect(hoisted[0]?.document).toBe(idOnlyDocument);
		expect(hoisted[0]?.matchSources).toEqual(["taskId"]);
		expect(hoisted[1]).toBe(baseOrderedResults[0]);
	});

	it("merges instead of replacing when the matched document is already in the base results", () => {
		// prompt 里互相引用 task id 很常见（「接着 a3f21 的改动继续…」），提上去之后原有高亮不能消失。
		const matchedDocument = createDocument({ taskId: "a3f21", title: "Alpha rollout", prompt: "follows a3f21" });
		const otherDocument = createDocument({ taskId: "94c87", title: "Other" });
		const documents = [otherDocument, matchedDocument];
		const baseOrderedResults = [
			createTextResult(otherDocument),
			createTextResult(matchedDocument, {
				score: 9,
				matchSources: ["title", "prompt"],
				titleMatchCharacterPositions: new Set([0, 1]),
				promptMatchCharacterPositions: new Set([8]),
			}),
		];

		const hoisted = hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "a3f21");

		expect(hoisted).toHaveLength(2);
		expect(hoisted[0]?.document).toBe(matchedDocument);
		expect(hoisted[0]?.matchSources).toEqual(["taskId", "title", "prompt"]);
		expect(hoisted[0]?.score).toBe(9);
		expect([...(hoisted[0]?.titleMatchCharacterPositions ?? [])]).toEqual([0, 1]);
		expect([...(hoisted[0]?.promptMatchCharacterPositions ?? [])]).toEqual([8]);
		expect(listTaskIdMatchCharacterPositions(hoisted[0])).toEqual([0, 1, 2, 3, 4]);
		expect(hoisted[1]?.document).toBe(otherDocument);
	});

	it("keeps every matched document exactly once", () => {
		const matchedDocument = createDocument({ taskId: "a3f21", title: "Alpha" });
		const documents = [matchedDocument];
		const baseOrderedResults = [createTextResult(matchedDocument)];

		const hoisted = hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "a3f21");

		expect(hoisted).toHaveLength(1);
		expect(hoisted.filter((result) => result.document === matchedDocument)).toHaveLength(1);
	});

	it("hoists both cross-project collisions with the current project first", () => {
		const currentProjectDocument = createDocument({ taskId: "a3f21", projectId: "proj-a" });
		const otherProjectDocument = createDocument({ taskId: "a3f21", projectId: "proj-b" });
		const unrelatedDocument = createDocument({ taskId: "94c87", title: "Unrelated" });
		// controller 把当前项目文档拼在前面，hoist 保持入参顺序，因此当前项目那条天然在前。
		const documents = [currentProjectDocument, unrelatedDocument, otherProjectDocument];
		const baseOrderedResults = [createTextResult(unrelatedDocument)];

		const hoisted = hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "a3f21");

		expect(hoisted.map((result) => result.document.projectId)).toEqual(["proj-a", "proj-b", "proj-a"]);
		expect(hoisted[0]?.document).toBe(currentProjectDocument);
		expect(hoisted[1]?.document).toBe(otherProjectDocument);
		expect(hoisted[2]?.document).toBe(unrelatedDocument);
	});

	it("hoists partial id matches above text results while typing", () => {
		const idPrefixDocument = createDocument({ taskId: "94c87", title: "Nothing textual here" });
		const textDocument = createDocument({ taskId: "a3f21", title: "mentions 94c" });
		const documents = [textDocument, idPrefixDocument];
		const baseOrderedResults = [createTextResult(textDocument)];

		const hoisted = hoistTaskIdMatchedResultsToTopByMatchTier(baseOrderedResults, documents, "94c");

		expect(hoisted.map((result) => result.document)).toEqual([idPrefixDocument, textDocument]);
		expect(listTaskIdMatchCharacterPositions(hoisted[0])).toEqual([0, 1, 2]);
		expect(hoisted[1]).toBe(baseOrderedResults[0]);
	});
});
