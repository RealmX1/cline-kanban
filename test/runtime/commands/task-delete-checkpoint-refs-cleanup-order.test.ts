import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerTaskCommand } from "../../../src/commands/task";

// 回归锚点：deleteTaskCommand 的 turn checkpoint refs 批删必须排在会话停止与 worktree 清理**之后**。
// hooks-api 的 to_review checkpoint 捕获是 runtime 侧不 await 的后台任务；若先批删，枚举完成后
// 在途捕获仍可能 update-ref，给已删除任务留下再无清理方的孤儿 ref（竞态详见 task.ts 批删处注释）。
const harness = vi.hoisted(() => {
	const callOrder: string[] = [];
	const fakeState = {
		board: {
			columns: [
				{
					id: "in_progress",
					cards: [{ id: "task-1", title: "任务一", prompt: "prompt", createdAt: 1, updatedAt: 2 }],
				},
			],
			dependencies: [],
		},
		sessions: {},
	};
	return { callOrder, fakeState };
});

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: () => ({
		projects: {
			add: {
				mutate: async () => ({ ok: true, project: { id: "workspace-1" } }),
			},
		},
		workspace: {
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
	mutateWorkspaceState: async (
		_workspaceRepoPath: string,
		mutate: (state: unknown) => { board: unknown; value: unknown; save?: boolean },
	) => {
		const result = mutate(harness.fakeState);
		return { saved: result.save !== false, value: result.value };
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
			"stopTaskSession",
			"deleteWorktree",
			"deleteAllTaskTurnCheckpointRefs:/fake/repo:task-1",
		]);
	});
});
