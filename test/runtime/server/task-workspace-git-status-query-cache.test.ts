import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { createTaskWorkspaceGitStatusQueryCache } from "../../../src/server/task-workspace-git-status-query-cache";
import type { CachedTaskWorkspaceMetadata } from "../../../src/workspace/task-worktree-git-metadata-probe";

const probes = vi.hoisted(() => ({ load: vi.fn(), baseTip: vi.fn(), provenanceVersions: vi.fn() }));
vi.mock("../../../src/workspace/task-commit-integration-provenance", () => ({
	readTaskCommitIntegrationProvenanceVersionsByTaskId: probes.provenanceVersions,
}));
vi.mock("../../../src/workspace/task-worktree-git-metadata-probe", () => ({
	loadTaskWorkspaceMetadata: probes.load,
	createBaseRefTipResolver: probes.baseTip,
}));

function boardWithTasks(): RuntimeBoardData {
	return {
		columns: ["backlog", "in_progress", "review", "validation", "trash"].map((id, index) => ({
			id: id as RuntimeBoardData["columns"][number]["id"],
			title: id,
			cards: [
				{
					id: `task-${index}`,
					title: id,
					prompt: "",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				},
			],
		})),
	};
}

function metadata(): CachedTaskWorkspaceMetadata {
	return {
		data: {
			taskId: "task-2",
			path: "/repos/project/task-2",
			exists: true,
			baseRef: "main",
			baseCommit: "base",
			commitsAheadOfBaseRef: 1,
			commitsBehindBaseRef: 2,
			branch: null,
			isDetached: true,
			headCommit: "head",
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			stateVersion: 1,
			workspaceGitStatus: {
				baseRef: "main",
				commitsAheadOfBaseRef: 1,
				commitsBehindBaseRef: 2,
				taskCommitsIntegratedIntoBaseRef: 0,
				taskCommitIntegrationTrackingStatus: "complete",
				observationSource: "live_worktree",
				observedAt: 1,
			},
		},
		stateToken: "state",
		cheapChangeToken: "cheap",
		baseRefTipCommit: "base",
		lastFullRefreshAtMs: 1,
		lastObservedTaskWorktreeGitChangeAtMs: null,
	};
}

const scope = { workspaceId: "project", workspacePath: "/repos/project" };

beforeEach(() => probes.provenanceVersions.mockResolvedValue(new Map()));

afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe("任务列表 Git 查询缓存", () => {
	it("曾成功的探针后来抛错时也清除复用资格，下次读取不能跳过恢复核验", async () => {
		probes.load
			.mockResolvedValueOnce(metadata())
			.mockRejectedValueOnce(new Error("任务路径暂时不可读"))
			.mockResolvedValueOnce(metadata());
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		await read(scope, { taskIds: ["task-2"] });
		expect(
			(await read(scope, { taskIds: ["task-2"] })).taskWorkspaceGitStatuses["task-2"]
				.taskCommitIntegrationTrackingStatus,
		).toBe("git_probe_unavailable");
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[2]?.[3]).toBeNull();
	});

	it("Git未变但持久归属被修复或删除时，旧缓存立即失效", async () => {
		probes.load.mockResolvedValue(metadata());
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		probes.provenanceVersions.mockResolvedValue(new Map([["task-2", "before-repair"]]));
		await read(scope, { taskIds: ["task-2"] });
		probes.provenanceVersions.mockResolvedValue(new Map([["task-2", "after-repair"]]));
		await read(scope, { taskIds: ["task-2"] });
		probes.provenanceVersions.mockResolvedValue(new Map());
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls.every((call) => call[3] === null)).toBe(true);
	});
	it("只探测服务器看板中被请求的任务，空范围不创建Git解析器；旧无参请求仍覆盖全板", async () => {
		const board = boardWithTasks();
		probes.load.mockResolvedValue(metadata());
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => board });
		expect(await read(scope, { taskIds: [] })).toEqual({ taskWorkspaceGitStatuses: {} });
		expect(probes.baseTip).not.toHaveBeenCalled();
		const result = await read(scope, { taskIds: ["task-2", "task-2", "unknown"] });
		expect(Object.keys(result.taskWorkspaceGitStatuses)).toEqual(["task-2"]);
		expect(probes.load).toHaveBeenCalledTimes(1);
		expect(probes.load.mock.calls[0]?.[2]).toMatchObject({
			taskId: "task-2",
			baseRef: "main",
			taskCardBoardColumnId: "review",
		});
		await read(scope);
		expect(probes.load).toHaveBeenCalledTimes(6);
	});

	it("重叠请求共享探针，后续请求把缓存交给共享变更门控复核", async () => {
		let finish: (value: CachedTaskWorkspaceMetadata) => void = () => {};
		probes.load.mockImplementationOnce(
			() =>
				new Promise<CachedTaskWorkspaceMetadata>((resolve) => {
					finish = resolve;
				}),
		);
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		const first = read(scope, { taskIds: ["task-2"] });
		const second = read(scope, { taskIds: ["task-2"] });
		await vi.waitFor(() => expect(probes.load).toHaveBeenCalledTimes(1));
		const value = metadata();
		finish(value);
		expect(await first).toEqual(await second);
		probes.load.mockResolvedValue(value);
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[1]?.[3]).toBe(value);
	});

	it.each(["null", "rejection", "unavailable"])("%s 失败释放单飞，下一请求重新核验", async (failure) => {
		const unavailable = metadata();
		unavailable.data.workspaceGitStatus.taskCommitIntegrationTrackingStatus = "git_probe_unavailable";
		if (failure === "rejection") probes.load.mockRejectedValueOnce(new Error("Git超时或取消"));
		else probes.load.mockResolvedValueOnce(failure === "null" ? null : unavailable);
		probes.load.mockResolvedValueOnce(metadata());
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		const failed = await read(scope, { taskIds: ["task-2"] });
		expect(failed.taskWorkspaceGitStatuses["task-2"]?.taskCommitIntegrationTrackingStatus).toBe(
			"git_probe_unavailable",
		);
		const recovered = await read(scope, { taskIds: ["task-2"] });
		expect(recovered.taskWorkspaceGitStatuses["task-2"]?.taskCommitIntegrationTrackingStatus).toBe("complete");
		expect(probes.load.mock.calls[1]?.[3]).toBeNull();
	});

	it("同 ID 重建、换baseRef、换项目路径或模式均不复用旧缓存，迟到旧世结果不绑定新世", async () => {
		const board = boardWithTasks();
		const card = board.columns[2].cards[0];
		probes.load.mockResolvedValue(metadata());
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => board });
		await read(scope, { taskIds: [card.id] });
		card.createdAt = 2;
		await read(scope, { taskIds: [card.id] });
		card.baseRef = "other-base";
		await read(scope, { taskIds: [card.id] });
		card.worktreeMode = "inplace";
		await read(scope, { taskIds: [card.id] });
		await read({ ...scope, workspacePath: "/repos/moved-project" }, { taskIds: [card.id] });
		expect(probes.load.mock.calls.every((call) => call[3] === null)).toBe(true);
		probes.load.mockImplementationOnce(async () => {
			card.createdAt = 3;
			return metadata();
		});
		expect(await read(scope, { taskIds: [card.id] })).toEqual({ taskWorkspaceGitStatuses: {} });
	});

	it("五分钟无人请求及缓存容量上限均淘汰，重建服务冷启动不恢复旧单飞", async () => {
		vi.useFakeTimers();
		const board = boardWithTasks();
		probes.load.mockResolvedValue(metadata());
		const deps = { loadWorkspaceBoardById: async () => board };
		const read = createTaskWorkspaceGitStatusQueryCache(deps);
		await read(scope, { taskIds: ["task-2"] });
		vi.advanceTimersByTime(5 * 60_000);
		await read(scope, { taskIds: ["task-2"] });
		await createTaskWorkspaceGitStatusQueryCache(deps)(scope, { taskIds: ["task-2"] });
		for (let index = 0; index < 2_049; index += 1) {
			board.columns[2].cards[0].createdAt = index + 10;
			await read(scope, { taskIds: ["task-2"] });
		}
		board.columns[2].cards[0].createdAt = 1;
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls.every((call) => call[3] === null)).toBe(true);
	});
});
