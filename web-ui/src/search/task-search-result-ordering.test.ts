import { describe, expect, it } from "vitest";

import {
	buildTaskBoardSearchDocument,
	EMPTY_MATCH_CHARACTER_POSITIONS,
	type TaskBoardSearchDocument,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import {
	DEFAULT_TASK_SEARCH_RESULT_SORT_ORDER,
	normalizeTaskSearchResultSortOrder,
	resolveEffectiveTaskSearchResultSortOrder,
	sortTaskSearchResults,
} from "@/search/task-search-result-ordering";

function createResult(overrides: {
	taskId: string;
	projectId?: string;
	taskCreatedAtEpochMs?: number;
	taskLastModifiedAtEpochMs?: number;
}): TaskBoardSearchResult {
	const document = buildTaskBoardSearchDocument({
		projectId: overrides.projectId ?? "proj-a",
		projectName: "Project A",
		taskId: overrides.taskId,
		columnId: "backlog",
		title: overrides.taskId,
		prompt: "",
		taskCreatedAtEpochMs: overrides.taskCreatedAtEpochMs ?? 0,
		taskLastModifiedAtEpochMs: overrides.taskLastModifiedAtEpochMs ?? 0,
		taskAgentOverrideAgentId: null,
		mostRecentlyLaunchedAgentSessionAgentId: null,
	});
	return {
		document,
		score: 0,
		matchSources: [],
		titleMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
		promptMatchCharacterPositions: EMPTY_MATCH_CHARACTER_POSITIONS,
	};
}

const NO_AGENT_CONVERSATION_PROGRESS = (): number | null => null;

function orderedTaskIds(results: readonly TaskBoardSearchResult[]): string[] {
	return results.map((result) => result.document.taskId);
}

describe("normalizeTaskSearchResultSortOrder", () => {
	it("accepts every declared order and rejects anything else", () => {
		expect(normalizeTaskSearchResultSortOrder("task_created_at_desc")).toBe("task_created_at_desc");
		expect(normalizeTaskSearchResultSortOrder("relevance")).toBe("relevance");
		expect(normalizeTaskSearchResultSortOrder("updated_desc")).toBeNull();
		expect(normalizeTaskSearchResultSortOrder("")).toBeNull();
	});
});

describe("resolveEffectiveTaskSearchResultSortOrder", () => {
	it("falls back off relevance while browsing without a query", () => {
		// 没有查询串就没有相关度可言，relevance 档在浏览态下必须回落到一个真有值的档。
		expect(resolveEffectiveTaskSearchResultSortOrder("relevance", { isBrowsingWithoutQuery: true })).toBe(
			"task_last_modified_at_desc",
		);
	});

	it("leaves every other combination untouched", () => {
		expect(resolveEffectiveTaskSearchResultSortOrder("relevance", { isBrowsingWithoutQuery: false })).toBe(
			"relevance",
		);
		expect(resolveEffectiveTaskSearchResultSortOrder("task_created_at_desc", { isBrowsingWithoutQuery: true })).toBe(
			"task_created_at_desc",
		);
	});
});

describe("sortTaskSearchResults", () => {
	it("returns the very same array reference on the relevance order", () => {
		// 引用稳定性不是优化而是正确性：controller 的 useEffect([results]) 会把 activeIndex 收敛回去，
		// 无谓换引用能让 ↑↓ 导航被反复钉死在第 0 行（见 task-id-match-search.ts 的告警）。
		const results = [createResult({ taskId: "a" }), createResult({ taskId: "b" })];

		expect(
			sortTaskSearchResults({
				results,
				sortOrder: DEFAULT_TASK_SEARCH_RESULT_SORT_ORDER,
				resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
			}),
		).toBe(results);
	});

	it("sorts by last modified and by created independently", () => {
		const results = [
			createResult({ taskId: "old-edit-new-card", taskCreatedAtEpochMs: 300, taskLastModifiedAtEpochMs: 100 }),
			createResult({ taskId: "new-edit-old-card", taskCreatedAtEpochMs: 100, taskLastModifiedAtEpochMs: 300 }),
			createResult({ taskId: "middle", taskCreatedAtEpochMs: 200, taskLastModifiedAtEpochMs: 200 }),
		];

		expect(
			orderedTaskIds(
				sortTaskSearchResults({
					results,
					sortOrder: "task_last_modified_at_desc",
					resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
				}),
			),
		).toEqual(["new-edit-old-card", "middle", "old-edit-new-card"]);

		expect(
			orderedTaskIds(
				sortTaskSearchResults({
					results,
					sortOrder: "task_created_at_desc",
					resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
				}),
			),
		).toEqual(["old-edit-new-card", "middle", "new-edit-old-card"]);
	});

	it("keeps rows without an agent activity timestamp at the very end", () => {
		// 把「没有时间戳」混进 recency 段会让它表现得像「很久以前活跃过」——那是假信息。
		const results = [
			createResult({ taskId: "unknown-a" }),
			createResult({ taskId: "recent" }),
			createResult({ taskId: "unknown-b" }),
			createResult({ taskId: "stale" }),
		];
		const progressByTaskId: Record<string, number> = { recent: 500, stale: 100 };

		expect(
			orderedTaskIds(
				sortTaskSearchResults({
					results,
					sortOrder: "agent_conversation_progress_desc",
					resolveAgentConversationProgressAtEpochMs: (document: TaskBoardSearchDocument) =>
						progressByTaskId[document.taskId] ?? null,
				}),
			),
		).toEqual(["recent", "stale", "unknown-a", "unknown-b"]);
	});

	it("breaks ties by input order", () => {
		// 传入顺序本身有意义（当前项目在前 → 列顺序 → 卡序），同一时刻的行不该被重新洗牌。
		const results = [
			createResult({ taskId: "first", taskLastModifiedAtEpochMs: 100 }),
			createResult({ taskId: "second", taskLastModifiedAtEpochMs: 100 }),
			createResult({ taskId: "third", taskLastModifiedAtEpochMs: 100 }),
		];

		expect(
			orderedTaskIds(
				sortTaskSearchResults({
					results,
					sortOrder: "task_last_modified_at_desc",
					resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
				}),
			),
		).toEqual(["first", "second", "third"]);
	});

	it("does not mutate the input array", () => {
		const results = [
			createResult({ taskId: "a", taskLastModifiedAtEpochMs: 1 }),
			createResult({ taskId: "b", taskLastModifiedAtEpochMs: 2 }),
		];

		sortTaskSearchResults({
			results,
			sortOrder: "task_last_modified_at_desc",
			resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
		});

		expect(orderedTaskIds(results)).toEqual(["a", "b"]);
	});
});
