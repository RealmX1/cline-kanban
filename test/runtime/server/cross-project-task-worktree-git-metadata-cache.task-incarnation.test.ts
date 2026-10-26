import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData, RuntimeTaskWorkspaceMetadata } from "../../../src/core/api-contract";
import { createCrossProjectTaskWorktreeGitMetadataCache } from "../../../src/server/cross-project-task-worktree-git-metadata-cache";

const loadTaskWorkspaceMetadata = vi.hoisted(() => vi.fn());
vi.mock("../../../src/workspace/task-worktree-git-metadata-probe", () => ({
	loadTaskWorkspaceMetadata,
	createBaseRefTipResolver: () => vi.fn(),
}));
vi.mock("../../../src/deployment/task-commit-coverage-in-current-deployment", () => ({
	attachTaskCommitCoverageInCurrentDeploymentToMetadata: async ({
		taskMetadata,
	}: {
		taskMetadata: RuntimeTaskWorkspaceMetadata[];
	}) => taskMetadata,
}));

function makeBoard(createdAt: number): RuntimeBoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "same-id",
						title: "关联任务",
						prompt: "卡片内容",
						startInPlanMode: false,
						baseRef: "main",
						createdAt,
						updatedAt: createdAt,
					},
				],
			},
		],
	};
}

function probeResult(ahead = 97) {
	return {
		data: {
			taskId: "same-id",
			path: "/isolated/task-worktree",
			exists: true,
			baseRef: "main",
			baseCommit: null,
			commitsAheadOfBaseRef: ahead,
			commitsBehindBaseRef: 0,
			workspaceGitStatus: {
				baseRef: "main",
				commitsAheadOfBaseRef: ahead,
				commitsBehindBaseRef: 0,
				taskCommitsIntegratedIntoBaseRef: 0,
				taskCommitIntegrationTrackingStatus: "complete" as const,
				observationSource: "live_worktree" as const,
				observedAt: 5_000,
			},
			branch: null,
			isDetached: true,
			headCommit: "abc",
			changedFiles: 1,
			additions: 2,
			deletions: 0,
			stateVersion: 1,
		},
		stateToken: "token",
		cheapChangeToken: "cheap",
		baseRefTipCommit: "base",
		lastFullRefreshAtMs: 5_000,
		lastObservedTaskWorktreeGitChangeAtMs: null,
	};
}

function createCache() {
	let board = makeBoard(1_000);
	const loadWorkspaceBoardById = vi.fn(async () => board);
	return {
		cache: createCrossProjectTaskWorktreeGitMetadataCache({
			listRegisteredWorkspacePathsById: async () => new Map([["project-a", "/isolated/repository"]]),
			loadWorkspaceBoardById,
		}),
		loadWorkspaceBoardById,
		recreateTask: () => {
			board = makeBoard(2_000);
		},
	};
}
const request = { tasks: [{ workspaceId: "project-a", taskId: "same-id" }] };

afterEach(() => loadTaskWorkspaceMetadata.mockReset());

describe("跨项目 Git 元数据响应的任务一世证据", () => {
	it("响应携带探针前后复核一致的创建时间", async () => {
		loadTaskWorkspaceMetadata.mockResolvedValue(probeResult());
		const { cache } = createCache();
		const [result] = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		expect(result).toMatchObject({ availability: "available", taskIncarnationCreatedAtEpochMs: 1_000 });
	});

	it("同 ID 重建之后不复用上一世缓存", async () => {
		loadTaskWorkspaceMetadata.mockResolvedValue(probeResult());
		const { cache, recreateTask } = createCache();
		await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		recreateTask();
		const [result] = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		expect(loadTaskWorkspaceMetadata.mock.calls[1]?.[3]).toBeNull();
		expect(result).toMatchObject({ availability: "available", taskIncarnationCreatedAtEpochMs: 2_000 });
	});

	it("未绑定创建时间的历史快照仍服务原切换器，但不签发预览身份", async () => {
		const historicalProbeResult = probeResult();
		historicalProbeResult.data.exists = false;
		loadTaskWorkspaceMetadata.mockResolvedValue(historicalProbeResult);
		const { cache } = createCache();
		const [result] = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		expect(result).toMatchObject({ availability: "available", taskWorkspaceMetadata: historicalProbeResult.data });
		expect(result).not.toHaveProperty("taskIncarnationCreatedAtEpochMs");
	});

	it("探针期间重建时不共用单飞，也不给旧请求绑定新一世结果", async () => {
		let finishOldProbe: (value: ReturnType<typeof probeResult>) => void = () => {};
		loadTaskWorkspaceMetadata
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldProbe = resolve;
					}),
			)
			.mockResolvedValue(probeResult(23));
		const { cache, recreateTask } = createCache();
		const oldRead = cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		await vi.waitFor(() => expect(loadTaskWorkspaceMetadata).toHaveBeenCalledTimes(1));
		recreateTask();
		const newRead = cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		await vi.waitFor(() => expect(loadTaskWorkspaceMetadata).toHaveBeenCalledTimes(2));
		finishOldProbe(probeResult());
		const [[oldResult], [newResult]] = await Promise.all([oldRead, newRead]);
		expect(oldResult?.availability).toBe("unavailable");
		expect(newResult).toMatchObject({ availability: "available", taskIncarnationCreatedAtEpochMs: 2_000 });
	});

	it("探针后看板复核失败时保留身份未知", async () => {
		loadTaskWorkspaceMetadata.mockResolvedValue(probeResult());
		const { cache, loadWorkspaceBoardById } = createCache();
		loadWorkspaceBoardById.mockResolvedValueOnce(makeBoard(1_000)).mockRejectedValueOnce(new Error("看板读取失败"));
		const [result] = await cache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(request);
		expect(result?.availability).toBe("unavailable");
	});
});
