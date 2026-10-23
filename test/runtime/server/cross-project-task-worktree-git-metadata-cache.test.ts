import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/deployment/task-commit-coverage-in-current-deployment", () => ({
	attachTaskCommitCoverageInCurrentDeploymentToMetadata: async ({
		taskMetadata,
	}: {
		taskMetadata: RuntimeTaskWorkspaceMetadata[];
	}) => taskMetadata,
}));

const probeMocks = vi.hoisted(() => ({
	loadTaskWorkspaceMetadata: vi.fn(),
	createBaseRefTipResolver: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree-git-metadata-probe", () => ({
	loadTaskWorkspaceMetadata: probeMocks.loadTaskWorkspaceMetadata,
	createBaseRefTipResolver: probeMocks.createBaseRefTipResolver,
}));

import {
	CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeTaskWorkspaceMetadata,
	runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema,
} from "../../../src/core/api-contract";
import { createCrossProjectTaskWorktreeGitMetadataCache } from "../../../src/server/cross-project-task-worktree-git-metadata-cache";

// 跨项目切换面板「其他项目」行的 git 元数据缓存。探针本身（fs-stat 门控、git 命令）由 workspace-metadata-monitor
// 的测试覆盖；这里只测缓存层：取数目标来自服务端 board、按键单飞、按请求复用 base tip 解析器、5 分钟淘汰。

const NOW_MS = 1_800_000_000_000;

function makeBoard(cardsByColumn: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((id) => ({
			id,
			title: id,
			cards: (cardsByColumn[id] ?? []).map((taskId) => ({
				id: taskId,
				title: taskId,
				prompt: taskId,
				startInPlanMode: false,
				baseRef: `base-of-${taskId}`,
				...(taskId.startsWith("inplace") ? { worktreeMode: "inplace" as const } : {}),
				createdAt: 0,
				updatedAt: 0,
			})),
		})),
	};
}

function makeTaskWorkspaceMetadata(taskId: string, changedFiles: number): RuntimeTaskWorkspaceMetadata {
	return {
		taskId,
		path: `/worktrees/${taskId}`,
		exists: true,
		baseRef: `base-of-${taskId}`,
		baseCommit: null,
		commitsAheadOfBaseRef: 2,
		commitsBehindBaseRef: 1,
		workspaceGitStatus: {
			baseRef: `base-of-${taskId}`,
			commitsAheadOfBaseRef: 2,
			commitsBehindBaseRef: 1,
			taskCommitsIntegratedIntoBaseRef: 0,
			taskCommitIntegrationTrackingStatus: "complete",
			observationSource: "live_worktree",
			observedAt: NOW_MS,
		},
		branch: null,
		isDetached: true,
		headCommit: "abc",
		changedFiles,
		additions: 3,
		deletions: 1,
		stateVersion: 1,
	};
}

function probeResultFor(taskId: string, changedFiles = 1) {
	return {
		data: makeTaskWorkspaceMetadata(taskId, changedFiles),
		stateToken: "token",
		cheapChangeToken: "cheap",
		baseRefTipCommit: "tip",
		lastFullRefreshAtMs: NOW_MS,
		lastObservedTaskWorktreeGitChangeAtMs: null,
	};
}

function createCache(options: { nowMs?: () => number; boards?: Record<string, RuntimeBoardData> } = {}) {
	const boards = options.boards ?? {
		"ws-a": makeBoard({ in_progress: ["a1", "inplace-a2"], backlog: ["a-backlog"] }),
		"ws-b": makeBoard({ review: ["b1"] }),
	};
	const loadWorkspaceBoardById = vi.fn(async (workspaceId: string) => {
		const board = boards[workspaceId];
		if (!board) {
			throw new Error(`no board for ${workspaceId}`);
		}
		return board;
	});
	const cache = createCrossProjectTaskWorktreeGitMetadataCache({
		listRegisteredWorkspacePathsById: async () =>
			new Map([
				["ws-a", "/repos/a"],
				["ws-b", "/repos/b"],
			]),
		loadWorkspaceBoardById,
		now: options.nowMs ?? (() => NOW_MS),
	});
	return { cache, loadWorkspaceBoardById };
}

afterEach(() => {
	probeMocks.loadTaskWorkspaceMetadata.mockReset();
	probeMocks.createBaseRefTipResolver.mockReset();
});

describe("createCrossProjectTaskWorktreeGitMetadataCache", () => {
	it("探针目标（baseRef / worktreeMode / 所在列 / auto-review）取自服务端 board；同一请求里每个项目只建一个 base tip 解析器", async () => {
		probeMocks.createBaseRefTipResolver.mockImplementation((workspacePath: string) => `resolver:${workspacePath}`);
		probeMocks.loadTaskWorkspaceMetadata.mockImplementation(async (_workspaceId, _path, task) =>
			probeResultFor(task.taskId),
		);
		const { cache } = createCache();

		const results = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries({
			tasks: [
				{ workspaceId: "ws-a", taskId: "a1" },
				{ workspaceId: "ws-a", taskId: "inplace-a2" },
				{ workspaceId: "ws-b", taskId: "b1" },
			],
		});

		expect(results.map((result) => [result.workspaceId, result.taskId, result.availability])).toEqual([
			["ws-a", "a1", "available"],
			["ws-a", "inplace-a2", "available"],
			["ws-b", "b1", "available"],
		]);
		expect(probeMocks.createBaseRefTipResolver.mock.calls).toEqual([["/repos/a"], ["/repos/b"]]);
		expect(probeMocks.loadTaskWorkspaceMetadata).toHaveBeenCalledWith(
			"ws-a",
			"/repos/a",
			{
				taskId: "inplace-a2",
				baseRef: "base-of-inplace-a2",
				worktreeMode: "inplace",
				taskCardBoardColumnId: "in_progress",
				taskCardAutoReviewEnabled: false,
			},
			null,
			"resolver:/repos/a",
		);
		expect(probeMocks.loadTaskWorkspaceMetadata).toHaveBeenCalledWith(
			"ws-b",
			"/repos/b",
			{ taskId: "b1", baseRef: "base-of-b1", taskCardBoardColumnId: "review", taskCardAutoReviewEnabled: false },
			null,
			"resolver:/repos/b",
		);
	});

	it("第二次请求把上一次的探针结果作为 current 传入（让探针的 fs-stat 门控生效）", async () => {
		probeMocks.createBaseRefTipResolver.mockReturnValue(vi.fn());
		const firstProbeResult = probeResultFor("a1");
		probeMocks.loadTaskWorkspaceMetadata
			.mockResolvedValueOnce(firstProbeResult)
			.mockResolvedValueOnce(firstProbeResult);
		const { cache } = createCache();
		const request = { tasks: [{ workspaceId: "ws-a", taskId: "a1" }] };

		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);

		expect(probeMocks.loadTaskWorkspaceMetadata.mock.calls[0]?.[3]).toBeNull();
		expect(probeMocks.loadTaskWorkspaceMetadata.mock.calls[1]?.[3]).toBe(firstProbeResult);
	});

	it("同一个键的并发请求共用一次探针（单飞），同一请求里的重复键也只算一次", async () => {
		probeMocks.createBaseRefTipResolver.mockReturnValue(vi.fn());
		let resolveProbe: (value: ReturnType<typeof probeResultFor>) => void = () => {};
		probeMocks.loadTaskWorkspaceMetadata.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const { cache } = createCache();
		const request = {
			tasks: [
				{ workspaceId: "ws-a", taskId: "a1" },
				{ workspaceId: "ws-a", taskId: "a1" },
			],
		};

		const first = cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		const second = cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		await vi.waitFor(() => expect(probeMocks.loadTaskWorkspaceMetadata).toHaveBeenCalledTimes(1));
		resolveProbe(probeResultFor("a1", 7));

		const [firstResults, secondResults] = await Promise.all([first, second]);
		expect(firstResults).toHaveLength(1);
		expect(secondResults).toHaveLength(1);
		expect(probeMocks.loadTaskWorkspaceMetadata).toHaveBeenCalledTimes(1);
		const [firstResult] = firstResults;
		expect(firstResult?.availability === "available" && firstResult.taskWorkspaceMetadata.changedFiles).toBe(7);
	});

	it("不可用的四种情形：未注册项目、卡不存在、Backlog 卡、探针失败", async () => {
		probeMocks.createBaseRefTipResolver.mockReturnValue(vi.fn());
		probeMocks.loadTaskWorkspaceMetadata.mockRejectedValueOnce(new Error("git exploded"));
		const { cache } = createCache();

		const results = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries({
			tasks: [
				{ workspaceId: "ws-unknown", taskId: "x" },
				{ workspaceId: "ws-a", taskId: "missing" },
				{ workspaceId: "ws-a", taskId: "a-backlog" },
				{ workspaceId: "ws-b", taskId: "b1" },
			],
		});

		expect(
			results.map((result) => [
				result.taskId,
				result.availability === "unavailable" ? result.unavailableReason : null,
			]),
		).toEqual([
			["x", "project_not_registered"],
			["missing", "task_card_not_found"],
			["a-backlog", "task_card_in_backlog_has_no_worktree"],
			["b1", "git_metadata_probe_failed"],
		]);
	});

	it("5 分钟没被请求的键被淘汰：之后再请求从头探针（current 为 null）", async () => {
		probeMocks.createBaseRefTipResolver.mockReturnValue(vi.fn());
		probeMocks.loadTaskWorkspaceMetadata.mockResolvedValue(probeResultFor("a1"));
		let nowMs = NOW_MS;
		const { cache } = createCache({ nowMs: () => nowMs });

		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries({
			tasks: [{ workspaceId: "ws-a", taskId: "a1" }],
		});
		nowMs += 5 * 60_000;
		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries({
			tasks: [{ workspaceId: "ws-b", taskId: "b1" }],
		});
		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries({
			tasks: [{ workspaceId: "ws-a", taskId: "a1" }],
		});

		const a1Calls = probeMocks.loadTaskWorkspaceMetadata.mock.calls.filter((call) => call[2]?.taskId === "a1");
		expect(a1Calls).toHaveLength(2);
		expect(a1Calls[1]?.[3]).toBeNull();
	});

	it("请求 schema 限制每次最多 100 个任务", () => {
		const tasks = Array.from(
			{ length: CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT + 1 },
			(_, i) => ({
				workspaceId: "ws-a",
				taskId: `t${i}`,
			}),
		);
		expect(
			runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema.safeParse({ tasks }).success,
		).toBe(false);
		expect(
			runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema.safeParse({
				tasks: tasks.slice(1),
			}).success,
		).toBe(true);
	});
});
