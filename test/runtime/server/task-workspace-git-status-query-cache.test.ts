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

	it("探针回写后的状态不留在预镜像版本键上，文件回到旧字节时重新核验", async () => {
		let version = "preimage";
		const produced: CachedTaskWorkspaceMetadata[] = [];
		probes.provenanceVersions.mockImplementation(async () => new Map([["task-2", version]]));
		probes.load.mockImplementation(async () => {
			version = "post-write";
			const value = metadata();
			value.boundTaskCommitIntegrationProvenanceVersion = "post-write";
			value.data.workspaceGitStatus.taskCommitsIntegratedIntoBaseRef = produced.length === 0 ? 4 : 0;
			value.data.workspaceGitStatus.observedAt = produced.length === 0 ? 40 : 1;
			produced.push(value);
			return value;
		});
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		await read(scope, { taskIds: ["task-2"] });
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[0]?.[3]).toBeNull();
		expect(probes.load.mock.calls[1]?.[3]).toBe(produced[0]);
		version = "preimage";
		await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[2]?.[3]).toBeNull();
	});

	it("可复用状态只绑定探针声明的版本，探针返回后的外部历史会重新核验", async () => {
		let version = "before-probe";
		const produced = metadata();
		produced.boundTaskCommitIntegrationProvenanceVersion = "probe-owned-write";
		produced.data.workspaceGitStatus.taskCommitsIntegratedIntoBaseRef = 4;
		produced.data.workspaceGitStatus.observedAt = 40;
		const restored = metadata();
		probes.provenanceVersions.mockImplementation(async () => new Map([["task-2", version]]));
		let probesStarted = 0;
		probes.load.mockImplementation(async (_workspaceId, _workspacePath, _target, current) => {
			if (current !== null) return current;
			probesStarted += 1;
			if (probesStarted === 1) {
				version = "external-history-restoration";
				return produced;
			}
			return restored;
		});
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => boardWithTasks() });
		expect(
			(await read(scope, { taskIds: ["task-2"] })).taskWorkspaceGitStatuses["task-2"]
				?.taskCommitsIntegratedIntoBaseRef,
		).toBe(4);
		const next = await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[1]?.[3]).toBeNull();
		expect(next.taskWorkspaceGitStatuses["task-2"]?.taskCommitsIntegratedIntoBaseRef).toBe(0);
		expect(next.taskWorkspaceGitStatuses["task-2"]?.observedAt).toBe(1);
		version = "probe-owned-write";
		const replay = await read(scope, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[2]?.[3]).toBe(produced);
		expect(replay.taskWorkspaceGitStatuses["task-2"]?.taskCommitsIntegratedIntoBaseRef).toBe(4);
	});

	it("provenance版本读失败不拒绝整批查询，失效本工作区成功缓存，其他工作区仍可复用", async () => {
		const board = boardWithTasks();
		board.columns[2].cards[0].worktreeMode = "inplace";
		const cached = metadata();
		probes.load.mockResolvedValue(cached);
		probes.provenanceVersions.mockResolvedValue(new Map([["task-2", "known-version"]]));
		const read = createTaskWorkspaceGitStatusQueryCache({ loadWorkspaceBoardById: async () => board });
		const other = { workspaceId: "other-project", workspacePath: "/repos/other-project" };
		await read(other, { taskIds: ["task-2"] });
		await read(scope, { taskIds: ["task-2"] });
		probes.provenanceVersions.mockRejectedValueOnce(
			Object.assign(new Error("provenance unreadable"), { code: "EACCES" }),
		);
		const result = await read(scope, { taskIds: ["task-2"] });
		expect(result.taskWorkspaceGitStatuses["task-2"]?.taskCommitIntegrationTrackingStatus).toBe("complete");
		expect(probes.load.mock.calls[2]?.[3]).toBeNull();
		expect(probes.load.mock.calls[2]?.[2]).toMatchObject({ taskId: "task-2", worktreeMode: "inplace" });
		await read(other, { taskIds: ["task-2"] });
		expect(probes.load.mock.calls[3]?.[3]).toBe(cached);
	});

	it("超过容量的重叠查询保留活动单飞，同一键只探测一次，同时执行的探针不超过容量", async () => {
		for (const taskCount of [2_048, 2_049]) {
			const board: RuntimeBoardData = {
				columns: [
					{
						id: "review",
						title: "review",
						cards: Array.from({ length: taskCount }, (_, index) => ({
							id: `task-${index}`,
							title: `task-${index}`,
							prompt: "",
							baseRef: "main",
							startInPlanMode: false,
							createdAt: 1,
							updatedAt: 1,
						})),
					},
				],
			};
			const pending: Array<() => void> = [];
			probes.load.mockImplementation(
				() =>
					new Promise<null>((resolve) => {
						pending.push(() => resolve(null));
					}),
			);
			let openings = 0;
			const openers: Array<() => void> = [];
			const read = createTaskWorkspaceGitStatusQueryCache({
				loadWorkspaceBoardById: () => {
					openings += 1;
					if (openings <= 2) return new Promise((resolve) => openers.push(() => resolve(board)));
					return Promise.resolve(board);
				},
			});
			const first = read(scope);
			const second = read(scope);
			await vi.waitFor(() => expect(openers).toHaveLength(2));
			openers[0]?.();
			openers[1]?.();
			const admittedProbeCount = Math.min(taskCount, 2_048);
			await vi.waitFor(() => expect(probes.load.mock.calls).toHaveLength(admittedProbeCount));
			expect(new Set(probes.load.mock.calls.map((call) => call[2].taskId)).size).toBe(admittedProbeCount);
			if (taskCount > admittedProbeCount) {
				pending[0]?.();
				await vi.waitFor(() => expect(probes.load.mock.calls).toHaveLength(taskCount));
			}
			expect(new Set(probes.load.mock.calls.map((call) => call[2].taskId)).size).toBe(probes.load.mock.calls.length);
			for (let guard = 0; pending.length > 0 && guard < taskCount + 2; guard += 1) {
				for (const resolve of pending.splice(0, pending.length)) resolve();
				await Promise.resolve();
			}
			await Promise.all([first, second]);
			expect(probes.load.mock.calls).toHaveLength(taskCount);
			expect(new Set(probes.load.mock.calls.map((call) => call[2].taskId)).size).toBe(taskCount);
			probes.load.mockReset();
		}
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
