import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitSyncMocks = vi.hoisted(() => ({
	getGitSyncSummary: vi.fn(),
	probeGitWorkspaceState: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	getTaskWorkspacePathInfo: vi.fn(),
}));

const gitUtilsMocks = vi.hoisted(() => ({
	runGit: vi.fn(),
}));

vi.mock("../../src/workspace/git-sync.js", () => ({
	getGitSyncSummary: gitSyncMocks.getGitSyncSummary,
	probeGitWorkspaceState: gitSyncMocks.probeGitWorkspaceState,
}));

vi.mock("../../src/workspace/task-worktree.js", () => ({
	getTaskWorkspacePathInfo: taskWorktreeMocks.getTaskWorkspacePathInfo,
}));

vi.mock("../../src/workspace/git-utils.js", () => ({
	runGit: gitUtilsMocks.runGit,
}));

// fork-point（git merge-base HEAD <baseRef>）的确定性返回；非 merge-base 调用退化为失败。
const FORK_POINT_COMMIT = "f00ba4c0ffee1234";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskWorktreeMode } from "../../src/core/api-contract";
import {
	createWorkspaceMetadataMonitor,
	type WorkspaceMetadataMonitor,
} from "../../src/server/workspace-metadata-monitor";

const WORKSPACE_PATH = "/repo/project";
const BRANCH_TASK_WORKTREE_PATH = "/repo/.cline/worktrees/abc/task-branch";

interface TaskWorkspacePathInfoOptions {
	cwd: string;
	taskId: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

function createBoardCard(id: string, worktreeMode?: RuntimeTaskWorktreeMode): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		...(worktreeMode ? { worktreeMode } : {}),
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createBoardCard("task-backlog", "inplace")] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: [createBoardCard("task-branch"), createBoardCard("task-inplace", "inplace")],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [createBoardCard("task-trash", "inplace")] },
		],
		dependencies: [],
	};
}

describe("createWorkspaceMetadataMonitor", () => {
	let monitor: WorkspaceMetadataMonitor;
	const onMetadataUpdated = vi.fn();

	beforeEach(() => {
		onMetadataUpdated.mockReset();
		gitSyncMocks.getGitSyncSummary.mockReset();
		gitSyncMocks.probeGitWorkspaceState.mockReset();
		taskWorktreeMocks.getTaskWorkspacePathInfo.mockReset();
		gitUtilsMocks.runGit.mockReset();
		gitUtilsMocks.runGit.mockImplementation(async (_cwd: string, args: string[]) => {
			if (args[0] === "merge-base") {
				return {
					ok: true,
					stdout: FORK_POINT_COMMIT,
					stderr: "",
					output: FORK_POINT_COMMIT,
					error: null,
					exitCode: 0,
				};
			}
			if (args[0] === "rev-list" && args[1] === "--count") {
				return { ok: true, stdout: "3", stderr: "", output: "3", error: null, exitCode: 0 };
			}
			return { ok: false, stdout: "", stderr: "", output: "", error: "unexpected git call", exitCode: 1 };
		});

		taskWorktreeMocks.getTaskWorkspacePathInfo.mockImplementation(async (options: TaskWorkspacePathInfoOptions) =>
			options.worktreeMode === "inplace"
				? {
						taskId: options.taskId,
						path: options.cwd,
						exists: true,
						baseRef: options.baseRef,
					}
				: {
						taskId: options.taskId,
						path: BRANCH_TASK_WORKTREE_PATH,
						exists: false,
						baseRef: options.baseRef,
					},
		);
		gitSyncMocks.probeGitWorkspaceState.mockImplementation(async (cwd: string) => ({
			repoRoot: cwd,
			headCommit: "abcdef1234567890",
			currentBranch: "main",
			upstreamBranch: null,
			aheadCount: 0,
			behindCount: 0,
			changedFiles: 2,
			untrackedPaths: [],
			stateToken: `token:${cwd}`,
		}));
		gitSyncMocks.getGitSyncSummary.mockImplementation(async () => ({
			currentBranch: "main",
			upstreamBranch: null,
			changedFiles: 2,
			additions: 5,
			deletions: 1,
			aheadCount: 0,
			behindCount: 0,
		}));

		monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated });
	});

	afterEach(() => {
		monitor.close();
	});

	it("forwards each tracked card's worktreeMode to getTaskWorkspacePathInfo", async () => {
		await monitor.connectWorkspace({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const callsByTaskId = new Map(
			taskWorktreeMocks.getTaskWorkspacePathInfo.mock.calls.map((call) => {
				const options = call[0] as TaskWorkspacePathInfoOptions;
				return [options.taskId, options];
			}),
		);

		expect(callsByTaskId.get("task-inplace")).toMatchObject({
			cwd: WORKSPACE_PATH,
			baseRef: "main",
			worktreeMode: "inplace",
		});
		expect(callsByTaskId.get("task-branch")).toMatchObject({
			cwd: WORKSPACE_PATH,
			baseRef: "main",
		});
		expect(callsByTaskId.get("task-branch")).not.toHaveProperty("worktreeMode");
	});

	it("reports the repo root as an existing workspace for inplace tasks", async () => {
		const metadata = await monitor.connectWorkspace({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const inplaceTask = metadata.taskWorkspaces.find((task) => task.taskId === "task-inplace");
		expect(inplaceTask).toMatchObject({
			path: WORKSPACE_PATH,
			exists: true,
			branch: "main",
			// fork-point（git merge-base HEAD <baseRef>）现算并随 metadata 暴露。
			baseCommit: FORK_POINT_COMMIT,
			commitsSinceFork: 3,
			changedFiles: 2,
			additions: 5,
			deletions: 1,
		});
		expect(gitUtilsMocks.runGit).toHaveBeenCalledWith(WORKSPACE_PATH, ["merge-base", "HEAD", "main"]);
		expect(gitUtilsMocks.runGit).toHaveBeenCalledWith(WORKSPACE_PATH, [
			"rev-list",
			"--count",
			`${FORK_POINT_COMMIT}..HEAD`,
		]);

		const branchTask = metadata.taskWorkspaces.find((task) => task.taskId === "task-branch");
		expect(branchTask).toMatchObject({
			path: BRANCH_TASK_WORKTREE_PATH,
			exists: false,
			branch: null,
			// 未落地的 worktree（exists:false）不探测分叉点 → baseCommit 为 null。
			baseCommit: null,
			commitsSinceFork: null,
			changedFiles: null,
		});
	});

	it("does not track backlog or trash cards", async () => {
		const metadata = await monitor.connectWorkspace({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});

		const trackedTaskIds = metadata.taskWorkspaces.map((task) => task.taskId);
		expect(trackedTaskIds).toEqual(["task-branch", "task-inplace"]);
	});
});
