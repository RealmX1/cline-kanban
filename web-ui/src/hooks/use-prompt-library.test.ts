import { describe, expect, it } from "vitest";

import {
	addTaskPrompt,
	type PromptLibraryState,
	removePromptFromLibrary,
	resolveVisiblePrompts,
	setPromptScopeInLibrary,
	updatePromptTextInLibrary,
} from "@/hooks/use-prompt-library";

const TASK_A = "task-a";
const TASK_B = "task-b";

function emptyState(): PromptLibraryState {
	return { global: [], byTask: {} };
}

describe("prompt library reducers", () => {
	it("adds new prompts as task-scoped by default", () => {
		const state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		expect(state.global).toEqual([]);
		expect(state.byTask[TASK_A]).toEqual([{ id: "p1", text: "", scope: "task", updatedAt: 100 }]);
	});

	it("updates prompt text and bumps updatedAt regardless of scope", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = updatePromptTextInLibrary(state, TASK_A, "p1", "hello", 200);
		expect(state.byTask[TASK_A] ?? []).toEqual([{ id: "p1", text: "hello", scope: "task", updatedAt: 200 }]);
	});

	it("removes a prompt by id", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = addTaskPrompt(state, TASK_A, "p2", 110);
		state = removePromptFromLibrary(state, TASK_A, "p1");
		expect((state.byTask[TASK_A] ?? []).map((p) => p.id)).toEqual(["p2"]);
	});

	it("moves a prompt between task and global stores when scope changes", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = setPromptScopeInLibrary(state, TASK_A, "p1", "global", 300);
		expect(state.byTask[TASK_A]).toEqual([]);
		expect(state.global).toEqual([{ id: "p1", text: "", scope: "global", updatedAt: 300 }]);

		state = setPromptScopeInLibrary(state, TASK_A, "p1", "task", 400);
		expect(state.global).toEqual([]);
		expect(state.byTask[TASK_A]).toEqual([{ id: "p1", text: "", scope: "task", updatedAt: 400 }]);
	});

	it("shows global prompts first, then the current task's prompts; other tasks are hidden", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "a1", 100);
		state = setPromptScopeInLibrary(state, TASK_A, "a1", "global", 110);
		state = addTaskPrompt(state, TASK_A, "a2", 120);
		state = addTaskPrompt(state, TASK_B, "b1", 130);

		expect(resolveVisiblePrompts(state, TASK_A).map((p) => p.id)).toEqual(["a1", "a2"]);
		expect(resolveVisiblePrompts(state, TASK_B).map((p) => p.id)).toEqual(["a1", "b1"]);
	});
});
