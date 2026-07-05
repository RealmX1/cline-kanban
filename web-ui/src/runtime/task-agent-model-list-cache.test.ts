import { afterEach, describe, expect, it } from "vitest";

import { readTaskAgentModelListCache, writeTaskAgentModelListCache } from "@/runtime/task-agent-model-list-cache";

afterEach(() => {
	window.localStorage.clear();
});

describe("task-agent-model-list-cache", () => {
	it("round-trips a written value under a namespaced key", () => {
		const value = [{ modelId: "opus", label: "Opus 4.8" }];
		writeTaskAgentModelListCache("terminal:claude", value);

		expect(readTaskAgentModelListCache<typeof value>("terminal:claude")).toEqual(value);
		// Key is namespaced so it can't collide with unrelated localStorage entries.
		expect(window.localStorage.getItem("kanban:task-agent-model-cache:terminal:claude")).not.toBeNull();
	});

	it("returns null on a cache miss", () => {
		expect(readTaskAgentModelListCache("cline-catalog:missing")).toBeNull();
	});

	it("returns null when the stored value is corrupt JSON", () => {
		window.localStorage.setItem("kanban:task-agent-model-cache:terminal:claude", "{not json");
		expect(readTaskAgentModelListCache("terminal:claude")).toBeNull();
	});
});
