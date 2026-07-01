import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("task comment entries", () => {
	it("persists task comments when creating, updating, and moving tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with comment",
				baseRef: "main",
				taskCommentEntries: [
					{
						taskCommentEntryId: "comment-1",
						commentText: "Remember to validate the migration path.",
						createdAt: 100,
						updatedAt: 100,
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.taskCommentEntries).toEqual([
			{
				taskCommentEntryId: "comment-1",
				commentText: "Remember to validate the migration path.",
				createdAt: 100,
				updatedAt: 100,
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with comment",
			baseRef: "main",
			taskCommentEntries: [
				{
					taskCommentEntryId: "comment-1",
					commentText: "Updated task-level note.",
					createdAt: 100,
					updatedAt: 140,
				},
				{
					taskCommentEntryId: "comment-2",
					commentText: "Second note.",
					createdAt: 150,
					updatedAt: 150,
				},
			],
		});

		expect(updated.task?.taskCommentEntries?.map((entry) => entry.commentText)).toEqual([
			"Updated task-level note.",
			"Second note.",
		]);

		const moved = moveTaskToColumn(updated.board, created.task.id, "review");

		expect(moved.task?.taskCommentEntries?.map((entry) => entry.taskCommentEntryId)).toEqual([
			"comment-1",
			"comment-2",
		]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("dispatch / fork-flow fields", () => {
	it("defaults worktreeMode to 'branch' when omitted on create", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Plain task", baseRef: "main" },
			() => "aaaaa111",
		);
		expect(created.task.worktreeMode).toBe("branch");
		expect(created.task.parentSessionId).toBeUndefined();
		expect(created.task.prepFilePath).toBeUndefined();
	});

	it("persists parentSessionId / worktreeMode / prepFilePath on create", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Forked task",
				baseRef: "main",
				parentSessionId: "11111111-2222-3333-4444-555555555555",
				worktreeMode: "inplace",
				prepFilePath: "/tmp/rvf-prep/abc.json",
			},
			() => "aaaaa111",
		);
		expect(created.task.parentSessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(created.task.worktreeMode).toBe("inplace");
		expect(created.task.prepFilePath).toBe("/tmp/rvf-prep/abc.json");
	});

	it("preserves dispatch fields on update when not specified", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Forked task",
				baseRef: "main",
				parentSessionId: "11111111-2222-3333-4444-555555555555",
				worktreeMode: "inplace",
				prepFilePath: "/tmp/rvf-prep/abc.json",
			},
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, {
			prompt: "Forked task v2",
			baseRef: "main",
		});
		expect(updated.task?.parentSessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(updated.task?.worktreeMode).toBe("inplace");
		expect(updated.task?.prepFilePath).toBe("/tmp/rvf-prep/abc.json");
	});

	it("clears dispatch fields when update sets them to null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Forked task",
				baseRef: "main",
				parentSessionId: "11111111-2222-3333-4444-555555555555",
				worktreeMode: "inplace",
				prepFilePath: "/tmp/rvf-prep/abc.json",
			},
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, {
			prompt: "Forked task v2",
			baseRef: "main",
			parentSessionId: null,
			worktreeMode: null,
			prepFilePath: null,
		});
		expect(updated.task?.parentSessionId).toBeUndefined();
		// worktreeMode falls back to the create-path default ("branch") so that
		// every persisted card carries a concrete mode regardless of update path.
		expect(updated.task?.worktreeMode).toBe("branch");
		expect(updated.task?.prepFilePath).toBeUndefined();
	});
});
