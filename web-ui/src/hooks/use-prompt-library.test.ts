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
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";

function emptyState(): PromptLibraryState {
	return { global: [], byProject: {}, byTask: {} };
}

describe("prompt library reducers", () => {
	it("adds new prompts as task-scoped by default", () => {
		const state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		expect(state.global).toEqual([]);
		expect(state.byTask[TASK_A]).toEqual([{ id: "p1", text: "", scope: "task", createdAt: 100, updatedAt: 100 }]);
	});

	it("updates prompt text and bumps updatedAt regardless of scope", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = updatePromptTextInLibrary(state, TASK_A, PROJECT_A, "p1", "hello", 200);
		expect(state.byTask[TASK_A] ?? []).toEqual([
			{ id: "p1", text: "hello", scope: "task", createdAt: 100, updatedAt: 200 },
		]);
	});

	it("removes a prompt by id", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = addTaskPrompt(state, TASK_A, "p2", 110);
		state = removePromptFromLibrary(state, TASK_A, PROJECT_A, "p1");
		expect((state.byTask[TASK_A] ?? []).map((p) => p.id)).toEqual(["p2"]);
	});

	it("moves a prompt between task and global stores when scope changes", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = setPromptScopeInLibrary(state, TASK_A, PROJECT_A, "p1", "global", 300);
		expect(state.byTask[TASK_A]).toEqual([]);
		expect(state.global).toEqual([{ id: "p1", text: "", scope: "global", createdAt: 100, updatedAt: 300 }]);

		state = setPromptScopeInLibrary(state, TASK_A, PROJECT_A, "p1", "task", 400);
		expect(state.global).toEqual([]);
		expect(state.byTask[TASK_A]).toEqual([{ id: "p1", text: "", scope: "task", createdAt: 100, updatedAt: 400 }]);
	});

	it("moves a prompt through repo scope for the current project", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "p1", 100);
		state = setPromptScopeInLibrary(state, TASK_A, PROJECT_A, "p1", "repo", 200);

		expect(state.byTask[TASK_A]).toEqual([]);
		expect(state.byProject[PROJECT_A]).toEqual([
			{ id: "p1", text: "", scope: "repo", createdAt: 100, updatedAt: 200 },
		]);

		state = updatePromptTextInLibrary(state, TASK_A, PROJECT_A, "p1", "repo prompt", 250);
		expect(state.byProject[PROJECT_A]?.[0]).toEqual({
			id: "p1",
			text: "repo prompt",
			scope: "repo",
			createdAt: 100,
			updatedAt: 250,
		});
	});

	it("shows global prompts first, then repo prompts, then the current task's prompts", () => {
		let state = addTaskPrompt(emptyState(), TASK_A, "a1", 100);
		state = setPromptScopeInLibrary(state, TASK_A, PROJECT_A, "a1", "global", 110);
		state = addTaskPrompt(state, TASK_A, "a2", 120);
		state = addTaskPrompt(state, TASK_B, "b1", 130);
		state = addTaskPrompt(state, TASK_A, "a3", 140);
		state = setPromptScopeInLibrary(state, TASK_A, PROJECT_A, "a3", "repo", 150);

		expect(resolveVisiblePrompts(state, TASK_A, PROJECT_A).map((p) => p.id)).toEqual(["a1", "a3", "a2"]);
		expect(resolveVisiblePrompts(state, TASK_B, PROJECT_A).map((p) => p.id)).toEqual(["a1", "a3", "b1"]);
		expect(resolveVisiblePrompts(state, TASK_B, PROJECT_B).map((p) => p.id)).toEqual(["a1", "b1"]);
	});
});
