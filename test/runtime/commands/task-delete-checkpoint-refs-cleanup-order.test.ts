import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerTaskCommand } from "../../../src/commands/task";

// 回归锚点：deleteTaskCommand 的 turn checkpoint refs 批删必须排在会话停止与 worktree 清理**之后**。
// hooks-api 的 to_review checkpoint 捕获是 runtime 侧不 await 的后台任务；若先批删，枚举完成后
// 在途捕获仍可能 update-ref，给已删除任务留下再无清理方的孤儿 ref（竞态详见 task.ts 批删处注释）。
const harness = vi.hoisted(() => {
	const callOrder: string[] = [];
	const deletedInProgressTaskCard = {
		id: "task-1",
		title: "任务一",
		prompt: "prompt",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 2,
	};
	return { callOrder, deletedInProgressTaskCard };
});

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: {
			add: {
				mutate: async () => ({ ok: true, project: { id: "workspace-1" } }),
			},
		},
		workspace: {
			// dd2db 1a.2b：删卡本身经 runtime procedure 落盘，它必须排在整条收尾链之前。
			applyKanbanCliTaskBoardMutation: {
				mutate: async (request: { kanbanCliTaskBoardMutationKind: string }) => {
					harness.callOrder.push(`applyKanbanCliTaskBoardMutation:${request.kanbanCliTaskBoardMutationKind}`);
					return {
						kanbanCliTaskBoardMutationKind: "permanently_delete_task_cards",
						permanentlyDeletedTaskCards: [
							{
								deletedTaskCard: harness.deletedInProgressTaskCard,
								deletedTaskCardBoardColumnIdBeforeDeletion: "in_progress",
								deletedTaskCardSessionSummaryPersistedOnDisk: null,
							},
						],
					};
				},
			},
			notifyStateUpdated: {
				mutate: async () => ({}),
			},
			deleteWorktree: {
				mutate: async () => {
					harness.callOrder.push("deleteWorktree");
					return { ok: true, removed: true };
				},
			},
		},
		runtime: {
			stopTaskSession: {
				mutate: async () => {
					harness.callOrder.push("stopTaskSession");
					return {};
				},
			},
		},
	}),
	httpBatchLink: () => ({}),
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	detectGitRepositoryInfo: vi.fn(),
	getTaskWorktreesHomePath: vi.fn(),
	loadWorkspaceBoardById: vi.fn(),
	loadWorkspaceContext: async () => ({ repoPath: "/fake/repo" }),
	// CLI 进程不得再直接写盘（fail closed 到 runtime procedure）；被调用即说明回退路径复活了。
	mutateWorkspaceState: async () => {
		throw new Error("task delete must not write board.json from the CLI process");
	},
	resolveWorkspacePath: vi.fn(),
}));

vi.mock("../../../src/state/discard-task-edit-drafts-for-tasks-removed-from-board.js", () => ({
	discardTaskEditDraftsForDeletedTasks: async () => {},
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	deleteAllTaskTurnCheckpointRefs: async (input: { cwd: string; taskId: string }) => {
		harness.callOrder.push(`deleteAllTaskTurnCheckpointRefs:${input.cwd}:${input.taskId}`);
	},
}));

describe("task delete 的 checkpoint refs 批删顺序", () => {
	afterEach(() => {
		harness.callOrder.length = 0;
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("refs 批删排在会话停止与 worktree 清理之后，批删入参用 workspace 主仓路径", async () => {
		process.exitCode = undefined;
		const stdoutChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});

		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "delete", "--task-id", "task-1"]);

		expect(process.exitCode).not.toBe(1);
		expect(stdoutChunks.join("")).toContain('"ok": true');
		// 批删必须是整条收尾链的最后一步——给 runtime 侧在途捕获最大收敛窗口。
		expect(harness.callOrder).toEqual([
			"applyKanbanCliTaskBoardMutation:permanently_delete_task_cards",
			"stopTaskSession",
			"deleteWorktree",
			"deleteAllTaskTurnCheckpointRefs:/fake/repo:task-1",
		]);
	});
});
