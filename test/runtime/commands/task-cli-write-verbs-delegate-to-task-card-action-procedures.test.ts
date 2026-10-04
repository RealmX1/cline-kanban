import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerTaskCommand } from "../../../src/commands/task";

// `kanban task start / done / delete / update` 收编进 runtime 的 taskCardAction.* 之后，CLI 只做参数解析与输出
// 格式化：每个动词恰好调一次对应 procedure，CLI 进程里不再有停会话 / 删 worktree / 清草稿 / 清 checkpoint ref 的
// 本地编排；JSON 输出形状与迁移前逐键一致（外部脚本依赖它）。
// 删除收尾链的顺序断言（checkpoint ref 最后批删）随实现迁到了 test/runtime/trpc/task-card-action-api.test.ts。

const harness = vi.hoisted(() => {
	const taskCardActionRequests: Array<{ procedureName: string; input: unknown }> = [];
	const deletedInProgressTaskCard = {
		id: "task-1",
		title: "任务一",
		prompt: "prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 2,
	};
	const responsesByProcedureName: Record<string, unknown> = {};
	const recordTaskCardActionMutation = (procedureName: string) => ({
		mutate: async (input: unknown) => {
			taskCardActionRequests.push({ procedureName, input });
			const response = responsesByProcedureName[procedureName];
			if (response instanceof Error) {
				throw response;
			}
			return typeof response === "function" ? (response as (input: unknown) => unknown)(input) : response;
		},
	});
	return {
		taskCardActionRequests,
		deletedInProgressTaskCard,
		responsesByProcedureName,
		recordTaskCardActionMutation,
		boardStateForColumnSelection: { board: { columns: [] as unknown[] }, sessions: {} },
	};
});

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: {
			add: { mutate: async () => ({ ok: true, project: { id: "workspace-1" } }) },
		},
		workspace: {
			getState: { query: async () => harness.boardStateForColumnSelection },
		},
		taskCardAction: {
			startTaskCardAgentSessionMovingItIntoInProgress: harness.recordTaskCardActionMutation(
				"startTaskCardAgentSessionMovingItIntoInProgress",
			),
			moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree: harness.recordTaskCardActionMutation(
				"moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree",
			),
			permanentlyDeleteTaskCardsWithFullResourceCleanup: harness.recordTaskCardActionMutation(
				"permanentlyDeleteTaskCardsWithFullResourceCleanup",
			),
			updateTaskCardFieldValues: harness.recordTaskCardActionMutation("updateTaskCardFieldValues"),
		},
	}),
	httpBatchLink: () => ({}),
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	detectGitRepositoryInfo: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceBoardById: vi.fn(),
	loadWorkspaceContext: async () => ({ repoPath: "/fake/repo", workspaceId: "workspace-1" }),
	// CLI 进程不得再直接写盘（fail closed 到 runtime procedure）；被调用即说明回退路径复活了。
	mutateWorkspaceState: async () => {
		throw new Error("task commands must not write board.json from the CLI process");
	},
	resolveWorkspacePath: vi.fn(),
}));

// 收尾清理只在 runtime 里做；CLI 进程里被调用即说明本地编排复活了。
vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	deleteAllTaskTurnCheckpointRefs: async () => {
		throw new Error("turn checkpoint refs must be deleted by the runtime, not the CLI process");
	},
}));

function createTaskCardSnapshot(boardColumnIdContainingTaskCard: string, taskCard = harness.deletedInProgressTaskCard) {
	return {
		taskCard,
		boardColumnIdContainingTaskCard,
		taskSessionSummaryLiveInRuntimeProcessMemory: null,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
	};
}

// 与迁移前 formatTaskRecordWithSessionSummary 逐键一致的卡片记录。
function expectedFormattedTaskRecord(column: string) {
	return {
		id: "task-1",
		title: "任务一",
		prompt: "prompt",
		column,
		baseRef: "main",
		startInPlanMode: false,
		taskAgentPermissionMode: "bypass_all_permission_prompts",
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		taskCommentEntries: [],
		createdAt: 1,
		updatedAt: 2,
		taskDescriptionLastUpdatedAt: 2,
		workspaceGitStatus: null,
		session: null,
	};
}

async function runKanbanTaskCommand(commandArguments: string[]): Promise<{ exitCode: unknown; output: unknown }> {
	const stdoutChunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(String(chunk));
		return true;
	});
	const program = new Command();
	registerTaskCommand(program);
	await program.parseAsync(["node", "kanban", "task", ...commandArguments]);
	return { exitCode: process.exitCode, output: JSON.parse(stdoutChunks.join("")) };
}

describe("kanban task 写动词只调 taskCardAction.* 一次", () => {
	beforeEach(() => {
		process.exitCode = undefined;
		harness.taskCardActionRequests.length = 0;
		for (const procedureName of Object.keys(harness.responsesByProcedureName)) {
			delete harness.responsesByProcedureName[procedureName];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("task delete：一次 permanentlyDeleteTaskCardsWithFullResourceCleanup，输出形状不变", async () => {
		harness.responsesByProcedureName.permanentlyDeleteTaskCardsWithFullResourceCleanup = {
			permanentlyDeletedTaskCards: [
				{
					deletedTaskCard: harness.deletedInProgressTaskCard,
					boardColumnIdOfDeletedTaskCardBeforeDeletion: "in_progress",
					taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion: null,
					taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
				},
			],
		};

		const { exitCode, output } = await runKanbanTaskCommand(["delete", "--task-id", "task-1"]);

		expect(exitCode).not.toBe(1);
		expect(harness.taskCardActionRequests).toEqual([
			{
				procedureName: "permanentlyDeleteTaskCardsWithFullResourceCleanup",
				input: {
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: ["task-1"],
					},
				},
			},
		]);
		expect(output).toEqual({
			ok: true,
			workspacePath: "/fake/repo",
			column: null,
			deletedTasks: [expectedFormattedTaskRecord("in_progress")],
			count: 1,
			worktreeCleanup: [{ taskId: "task-1", removed: true }],
		});
	});

	it("task delete --column：没有可删的卡时输出不带 worktreeCleanup（与迁移前一致）", async () => {
		harness.responsesByProcedureName.permanentlyDeleteTaskCardsWithFullResourceCleanup = {
			permanentlyDeletedTaskCards: [],
		};

		const { output } = await runKanbanTaskCommand(["delete", "--column", "done"]);

		expect(harness.taskCardActionRequests[0]?.input).toEqual({
			permanentlyDeletedTaskCardSelection: {
				permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
				selectedBoardColumnId: "trash",
			},
		});
		expect(output).toEqual({ ok: true, workspacePath: "/fake/repo", column: "trash", deletedTasks: [], count: 0 });
	});

	it("task done：一次 moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree，删 worktree 的失败原因照旧透出", async () => {
		harness.responsesByProcedureName.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree = {
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
			taskAgentSessionStopWasRequested: true,
			taskWorktreeDeletionResult: { taskWorktreeWasRemoved: false, taskWorktreeDeletionErrorMessage: "locked" },
			taskCardSnapshotAfterAction: createTaskCardSnapshot("trash"),
		};

		const { output } = await runKanbanTaskCommand(["done", "--task-id", "task-1"]);

		expect(harness.taskCardActionRequests).toEqual([
			{ procedureName: "moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree", input: { taskId: "task-1" } },
		]);
		expect(output).toEqual({
			ok: true,
			task: expectedFormattedTaskRecord("trash"),
			workspacePath: "/fake/repo",
			worktreeDeleted: false,
			worktreeDeleteError: "locked",
		});
	});

	it("task done --column：逐卡调用，已在 Done 的卡归入 alreadyTrashedTasks", async () => {
		harness.boardStateForColumnSelection.board = {
			columns: [
				{
					id: "review",
					title: "Review",
					cards: [harness.deletedInProgressTaskCard, { ...harness.deletedInProgressTaskCard, id: "task-2" }],
				},
			],
		};
		harness.responsesByProcedureName.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree = (input: unknown) => {
			const taskId = (input as { taskId: string }).taskId;
			return {
				boardColumnIdOfTaskCardBeforeAction: taskId === "task-1" ? "review" : "trash",
				taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: taskId !== "task-1",
				taskAgentSessionStopWasRequested: taskId === "task-1",
				taskWorktreeDeletionResult:
					taskId === "task-1" ? { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null } : null,
				taskCardSnapshotAfterAction: createTaskCardSnapshot("trash", {
					...harness.deletedInProgressTaskCard,
					id: taskId,
				}),
			};
		};

		const { output } = await runKanbanTaskCommand(["done", "--column", "review"]);

		expect(harness.taskCardActionRequests.map((request) => request.input)).toEqual([
			{ taskId: "task-1" },
			{ taskId: "task-2" },
		]);
		expect(output).toMatchObject({
			ok: true,
			column: "review",
			trashedTasks: [{ id: "task-1", column: "trash" }],
			alreadyTrashedTasks: [{ id: "task-2", column: "trash" }],
			worktreeCleanup: [{ taskId: "task-1", removed: true }],
			count: 1,
		});
	});

	it("task start：成功时输出不变；执行期失败以 exit 1 报出 runtime 给的原因", async () => {
		harness.responsesByProcedureName.startTaskCardAgentSessionMovingItIntoInProgress = {
			boardColumnIdOfTaskCardBeforeAction: "backlog",
			taskCardWasMovedIntoInProgressColumnByThisAction: true,
			agentSessionStartOutcome: "agent_session_started",
			agentSessionStartFailureMessage: null,
			ensuredTaskWorktreeWarningMessage: null,
			startedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: createTaskCardSnapshot("in_progress"),
		};
		const started = await runKanbanTaskCommand(["start", "--task-id", "task-1"]);
		expect(harness.taskCardActionRequests).toEqual([
			{ procedureName: "startTaskCardAgentSessionMovingItIntoInProgress", input: { taskId: "task-1" } },
		]);
		expect(started.output).toEqual({
			ok: true,
			task: { id: "task-1", prompt: "prompt", column: "in_progress", workspacePath: "/fake/repo" },
		});
		vi.restoreAllMocks();

		harness.responsesByProcedureName.startTaskCardAgentSessionMovingItIntoInProgress = {
			boardColumnIdOfTaskCardBeforeAction: "in_progress",
			taskCardWasMovedIntoInProgressColumnByThisAction: false,
			agentSessionStartOutcome: "agent_session_start_failed",
			agentSessionStartFailureMessage: "spawn exploded",
			ensuredTaskWorktreeWarningMessage: null,
			startedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: createTaskCardSnapshot("in_progress"),
		};
		const failed = await runKanbanTaskCommand(["start", "--task-id", "task-1"]);
		expect(failed.exitCode).toBe(1);
		expect(failed.output).toMatchObject({ ok: false, error: expect.stringContaining("spawn exploded") });
	});

	it("task update：把原始参数原样交给 runtime 在锁内合并，输出用盘上会话摘要", async () => {
		harness.responsesByProcedureName.updateTaskCardFieldValues = {
			taskCardSnapshotAfterAction: createTaskCardSnapshot("review"),
		};

		const { output } = await runKanbanTaskCommand([
			"update",
			"--task-id",
			"task-1",
			"--title",
			"renamed",
			"--cline-reasoning-effort",
			"default",
		]);

		expect(harness.taskCardActionRequests).toEqual([
			{
				procedureName: "updateTaskCardFieldValues",
				input: {
					taskId: "task-1",
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
						kanbanCliTaskCardFieldUpdateRawInput: expect.objectContaining({
							title: "renamed",
							clineReasoningEffort: "default",
						}),
					},
				},
			},
		]);
		expect(output).toEqual({ ok: true, task: expectedFormattedTaskRecord("review"), workspacePath: "/fake/repo" });
	});
});
