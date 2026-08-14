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

describe("task plan mode defaults", () => {
	it("starts newly-created tasks in plan mode when no explicit value is provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.startInPlanMode).toBe(true);
	});

	it("allows callers to explicitly create a task outside plan mode", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main", startInPlanMode: false },
			() => "aaaaa111",
		);

		expect(created.task.startInPlanMode).toBe(false);
	});
});

describe("task stage monotonicity", () => {
	it("never moves an already-started task back into backlog", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const started = moveTaskToColumn(created.board, created.task.id, "in_progress");
		const attemptedBacklogMove = moveTaskToColumn(started.board, created.task.id, "backlog");

		expect(started.moved).toBe(true);
		expect(attemptedBacklogMove.moved).toBe(false);
		expect(attemptedBacklogMove.board).toBe(started.board);
		expect(attemptedBacklogMove.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
			created.task.id,
		);
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

describe("omp session transport pinned at task creation", () => {
	// 这一组钉的是「建卡时固化、改全局默认不追溯已有卡片」这条契约里最容易漏的那一半：
	// 卡片上的 agentId 是 **override**，用户用工作区默认 agent 建卡时它本来就是空的。
	// 固化判据必须看「这张卡实际会跑哪个 agent」，否则「工作区默认是 omp」建出来的卡不落固化值，
	// 之后在设置页改全局默认就会反向改变这些已存在卡片的启动通道。
	it("pins the transport when the card has no agent override but the workspace default agent is switchable", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				workspaceDefaultAgentIdForNewTasks: "omp",
				ompAgentSessionTransportForNewTasks: "acp_stdio_subprocess",
			},
			() => "aaaaa111",
		);

		// 卡片仍然不写 agentId：不选 agent 的卡片跟随工作区默认 agent，那份语义没有被改动。
		expect(created.task.agentId).toBeUndefined();
		expect(created.task.ompAgentSessionTransport).toBe("acp_stdio_subprocess");
	});

	it("pins from the card's own agent override instead of the workspace default", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "omp",
				workspaceDefaultAgentIdForNewTasks: "claude",
				ompAgentSessionTransportForNewTasks: "acp_stdio_subprocess",
			},
			() => "aaaaa111",
		);

		expect(created.task.ompAgentSessionTransport).toBe("acp_stdio_subprocess");
	});

	it("keeps the field absent when the card's agent override is not switchable", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				workspaceDefaultAgentIdForNewTasks: "omp",
				ompAgentSessionTransportForNewTasks: "acp_stdio_subprocess",
			},
			() => "aaaaa111",
		);

		expect(created.task.ompAgentSessionTransport).toBeUndefined();
	});

	it("keeps the field absent when neither the override nor the workspace default is switchable", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				workspaceDefaultAgentIdForNewTasks: "claude",
				ompAgentSessionTransportForNewTasks: "acp_stdio_subprocess",
			},
			() => "aaaaa111",
		);

		expect(created.task.ompAgentSessionTransport).toBeUndefined();
	});

	// 老调用点（还没接工作区默认 agent 的建卡入口）仍然是「不知道会跑哪个 agent」，
	// 此时不落值是唯一诚实的行为——不能凭空猜一个通道钉上去。
	it("keeps the field absent when the caller supplies neither an override nor a workspace default", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", ompAgentSessionTransportForNewTasks: "acp_stdio_subprocess" },
			() => "aaaaa111",
		);

		expect(created.task.ompAgentSessionTransport).toBeUndefined();
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

	it("persists and clears generalized task agent session initialization", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Resume Claude task",
				baseRef: "main",
				agentId: "claude",
				taskAgentSessionInitialization: {
					sourceAgentId: "claude",
					sourceSessionId: "11111111-2222-3333-8444-555555555555",
					sourceSessionReuseMode: "resume_existing_session",
				},
			},
			() => "aaaaa111",
		);
		expect(created.task.taskAgentSessionInitialization).toEqual({
			sourceAgentId: "claude",
			sourceSessionId: "11111111-2222-3333-8444-555555555555",
			sourceSessionReuseMode: "resume_existing_session",
		});

		const cleared = updateTask(created.board, created.task.id, {
			prompt: created.task.prompt,
			baseRef: created.task.baseRef,
			taskAgentSessionInitialization: null,
		});
		expect(cleared.task?.taskAgentSessionInitialization).toBeUndefined();
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

describe("updateTask taskAgentPermissionMode", () => {
	// 回归：老卡片没有该字段时，「缺失」是有意义的第三态——它让 runtime-api 按当时的全局
	// agentAutonomousModeEnabled 推导档位（关闭时为 ask）。若 update 把 undefined 物化成默认档
	// （= bypass），则在关闭了全局 bypass 的工作区里，一次普通的 task update 就会把老任务
	// 永久钉成「全部工具自动放行」，且 UI 不会打降级星标——这正是禁止的静默放宽权限。
	it("keeps the field absent on a legacy card when the update omits it", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		const legacyBoard: RuntimeBoardData = {
			...created.board,
			columns: created.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => {
					const { taskAgentPermissionMode: _dropped, ...legacyCard } = card;
					return legacyCard;
				}),
			})),
		};

		const updated = updateTask(legacyBoard, created.task.id, { prompt: "Renamed", baseRef: "main" });

		expect(updated.updated).toBe(true);
		expect(updated.task?.taskAgentPermissionMode).toBeUndefined();
	});

	it("preserves an explicitly chosen stricter tier when the update omits it", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", taskAgentPermissionMode: "ask_for_every_tool_use" },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, { prompt: "Renamed", baseRef: "main" });

		expect(updated.task?.taskAgentPermissionMode).toBe("ask_for_every_tool_use");
	});

	it("resets to the default tier when the update passes null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", taskAgentPermissionMode: "ask_for_every_tool_use" },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Renamed",
			baseRef: "main",
			taskAgentPermissionMode: null,
		});

		expect(updated.task?.taskAgentPermissionMode).toBe("bypass_all_permission_prompts");
	});
});
