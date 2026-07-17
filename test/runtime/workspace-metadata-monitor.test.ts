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

const gitChangeTokenMocks = vi.hoisted(() => ({
	computeWorktreeGitChangeToken: vi.fn(),
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

vi.mock("../../src/workspace/git-change-token.js", () => ({
	computeWorktreeGitChangeToken: gitChangeTokenMocks.computeWorktreeGitChangeToken,
}));

// fork-point（git merge-base HEAD <baseRef>）的确定性返回；非 merge-base 调用退化为失败。
const FORK_POINT_COMMIT = "f00ba4c0ffee1234";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskWorktreeMode } from "../../src/core/api-contract";
import {
	createWorkspaceMetadataMonitor,
	type WorkspaceMetadataMonitor,
	workspaceMetadataGitSpawnConcurrencyLimiter,
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
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockReset();
		// 默认：廉价 token 恒定 → 首刷后同状态复用缓存、跳过真探针。
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");

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

	it("廉价 token 未变且在兜底窗口内时，二次刷新跳过 probe（不再 spawn git）", async () => {
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");

		await monitor.connectWorkspace({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;
		expect(probeCallsAfterFirstRefresh).toBeGreaterThan(0);

		// 二次刷新：token 不变、窗口内 → 不应再调 probe（真探针被门控短路）。
		await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBe(probeCallsAfterFirstRefresh);
	});

	it("廉价 token 变化时，二次刷新重新跑 probe", async () => {
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("token-v1");
		await monitor.connectWorkspace({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

		// 廉价 token 改变（HEAD/index/工作树发生变化）→ 门控放行 → 重新探针。
		gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("token-v2");
		await monitor.updateWorkspaceState({
			workspaceId: "workspace-1",
			workspacePath: WORKSPACE_PATH,
			board: createBoard(),
		});
		expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBeGreaterThan(probeCallsAfterFirstRefresh);
	});

	it("即使廉价 token 未变，超过兜底窗口后仍强制跑一次 probe（补上就地未暂存编辑）", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date(0));
			gitChangeTokenMocks.computeWorktreeGitChangeToken.mockResolvedValue("stable-token");

			await monitor.connectWorkspace({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			const probeCallsAfterFirstRefresh = gitSyncMocks.probeGitWorkspaceState.mock.calls.length;

			// 推进系统时间越过兜底窗口（10s）。token 仍不变，但窗口过期 → 应强制重新探针。
			vi.setSystemTime(new Date(11_000));
			await monitor.updateWorkspaceState({
				workspaceId: "workspace-1",
				workspacePath: WORKSPACE_PATH,
				board: createBoard(),
			});
			expect(gitSyncMocks.probeGitWorkspaceState.mock.calls.length).toBeGreaterThan(probeCallsAfterFirstRefresh);
		} finally {
			vi.useRealTimers();
		}
	});

	it("单次刷新内所有 task 的真探针被钳到共享并发上限（不随 task 数线性爆发）", async () => {
		const concurrencyLimit = workspaceMetadataGitSpawnConcurrencyLimiter.concurrency;
		// 注入远多于并发上限的 tracked task，逼出「所有 task 同一 poll tick 内并发探针」这一热路径。
		const trackedTaskCount = concurrencyLimit * 4;

		let activeProbeCount = 0;
		let peakProbeConcurrency = 0;
		// mock probe：进入时 +1、记录峰值，await 一个可控延迟后 -1。延迟期间占住限流器的槽位，
		// 使「同时在飞的真探针数」= 限流器实际放行的并发数，从而观测到真实并发峰值。
		gitSyncMocks.probeGitWorkspaceState.mockImplementation(async (cwd: string) => {
			activeProbeCount += 1;
			peakProbeConcurrency = Math.max(peakProbeConcurrency, activeProbeCount);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeProbeCount -= 1;
			return {
				repoRoot: cwd,
				headCommit: "abcdef1234567890",
				currentBranch: "main",
				upstreamBranch: null,
				aheadCount: 0,
				behindCount: 0,
				changedFiles: 2,
				untrackedPaths: [],
				stateToken: `token:${cwd}`,
			};
		});

		const manyInplaceCardsBoard: RuntimeBoardData = {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: Array.from({ length: trackedTaskCount }, (_unused, index) =>
						createBoardCard(`task-${index}`, "inplace"),
					),
				},
			],
			dependencies: [],
		};

		const metadata = await monitor.connectWorkspace({
			workspaceId: "workspace-concurrency",
			workspacePath: WORKSPACE_PATH,
			board: manyInplaceCardsBoard,
		});

		// 前置校验：确实触发了远多于上限的 task 探针（否则并发断言不成立）。
		expect(metadata.taskWorkspaces).toHaveLength(trackedTaskCount);
		expect(peakProbeConcurrency).toBeGreaterThan(1);
		// 核心断言：观测到的并发峰值被钳在共享上限内，不随 task 数线性增长。
		expect(peakProbeConcurrency).toBeLessThanOrEqual(concurrencyLimit);
	});
});
