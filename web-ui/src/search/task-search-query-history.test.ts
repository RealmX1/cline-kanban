import { describe, expect, it } from "vitest";

import {
	appendTaskSearchQueryToHistory,
	normalizeTaskSearchQueryHistory,
	removeTaskSearchQueryFromHistory,
	TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES,
} from "@/search/task-search-query-history";

describe("appendTaskSearchQueryToHistory", () => {
	it("puts the most recently used query first", () => {
		expect(appendTaskSearchQueryToHistory(["beta"], "alpha")).toEqual(["alpha", "beta"]);
	});

	it("drops empty and whitespace-only queries without touching the history reference", () => {
		const history = ["alpha"];
		expect(appendTaskSearchQueryToHistory(history, "")).toBe(history);
		expect(appendTaskSearchQueryToHistory(history, "   ")).toBe(history);
	});

	it("returns the same reference when the query is already on top", () => {
		// 调用方据此跳过一次 localStorage 写入——关弹层这种高频路径不该每次都写盘。
		const history = ["alpha", "beta"];
		expect(appendTaskSearchQueryToHistory(history, "alpha")).toBe(history);
	});

	it("moves an existing entry to the front instead of duplicating it, case-insensitively", () => {
		expect(appendTaskSearchQueryToHistory(["Alpha", "beta"], "ALPHA")).toEqual(["ALPHA", "beta"]);
	});

	it("trims the stored query", () => {
		expect(appendTaskSearchQueryToHistory([], "  中文查询  ")).toEqual(["中文查询"]);
	});

	it("caps the history length", () => {
		const overflowingHistory = Array.from({ length: TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES }, (_, i) => `q${i}`);
		const next = appendTaskSearchQueryToHistory(overflowingHistory, "newest");
		expect(next).toHaveLength(TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES);
		expect(next[0]).toBe("newest");
		expect(next).not.toContain(`q${TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES - 1}`);
	});
});

describe("normalizeTaskSearchQueryHistory", () => {
	it("degrades anything that is not a string array to an empty history", () => {
		// localStorage 可能被手改、被旧版本写坏、被别的标签页写脏——渲染 chips 时不该因此炸掉。
		expect(normalizeTaskSearchQueryHistory(null)).toEqual([]);
		expect(normalizeTaskSearchQueryHistory("alpha")).toEqual([]);
		expect(normalizeTaskSearchQueryHistory({ 0: "alpha" })).toEqual([]);
	});

	it("keeps only non-empty strings and de-duplicates case-insensitively", () => {
		expect(normalizeTaskSearchQueryHistory(["alpha", 42, "", "  ", "ALPHA", "beta"])).toEqual(["alpha", "beta"]);
	});

	it("caps a bloated stored history", () => {
		const stored = Array.from({ length: TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES + 5 }, (_, i) => `q${i}`);
		expect(normalizeTaskSearchQueryHistory(stored)).toHaveLength(TASK_SEARCH_QUERY_HISTORY_MAX_ENTRIES);
	});
});

describe("removeTaskSearchQueryFromHistory", () => {
	it("removes the matching entry", () => {
		expect(removeTaskSearchQueryFromHistory(["alpha", "beta"], "alpha")).toEqual(["beta"]);
	});

	it("returns the same reference when nothing matched", () => {
		const history = ["alpha"];
		expect(removeTaskSearchQueryFromHistory(history, "missing")).toBe(history);
	});
});
