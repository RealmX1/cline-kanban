import { afterEach, describe, expect, it, vi } from "vitest";
import { queryTaskRvfHistoryForCli } from "../../../src/commands/task-rvf-history";
import { taskRvfHistoryResponseSchema } from "../../../src/core/task-rvf-history-contract";

const mocked = vi.hoisted(() => ({ workspace: vi.fn(), offlineQuery: vi.fn(), offlineFactory: vi.fn() }));
vi.mock("../../../src/state/workspace-state", () => ({ loadWorkspaceContext: mocked.workspace }));
vi.mock("../../../src/rvf-task-review-history/task-rvf-history-query-service", () => ({
	createTaskRvfHistoryQueryService: (options: unknown) => {
		mocked.offlineFactory(options);
		return mocked.offlineQuery;
	},
}));
afterEach(() => vi.clearAllMocks());

function response() {
	return taskRvfHistoryResponseSchema.parse({
		schemaVersion: "kanban-task-rvf-history/v1",
		workspaceId: "project",
		taskId: "task",
		queriedAt: 1,
		querySource: "runtime",
		discoveryStatus: "complete",
		hasVerifiedCompletedRvf: false,
		mostRecentVerifiedCompletedRun: null,
		currentCandidateReviewCoverage: { status: "not_covered", reasonCode: "no_verified_completed_rvf" },
		recentRuns: [],
		nextCursor: null,
		issues: [],
	});
}

describe("Task RVF 历史 CLI 身份与离线回落", () => {
	it("调用环境不足时不按 cwd 猜 Task 或注册项目", async () => {
		await expect(queryTaskRvfHistoryForCli({ environment: {}, queryRuntime: vi.fn() })).rejects.toThrow(
			"不会从 cwd 推测",
		);
		expect(mocked.workspace).not.toHaveBeenCalled();
	});
	it("默认使用环境身份，显式参数覆盖且只读解析已注册 workspace", async () => {
		mocked.workspace.mockResolvedValue({ workspaceId: "project", repoPath: "/registered/main" });
		const runtime = vi.fn().mockResolvedValue(response());
		await queryTaskRvfHistoryForCli({
			environment: { KANBAN_TASK_ID: "task", KANBAN_PROJECT_PATH: "/registered/main" },
			queryRuntime: runtime,
		});
		expect(mocked.workspace).toHaveBeenCalledWith("/registered/main", { autoCreateIfMissing: false });
		expect(runtime).toHaveBeenCalledWith("project", { taskId: "task", limit: 10 }, 20_000);
		await queryTaskRvfHistoryForCli({
			taskId: "explicit-task",
			projectPath: "/explicit/main",
			limit: "3",
			environment: { KANBAN_TASK_ID: "task", KANBAN_PROJECT_PATH: "/registered/main" },
			queryRuntime: runtime,
		});
		expect(runtime).toHaveBeenLastCalledWith("project", { taskId: "explicit-task", limit: 3 }, 20_000);
	});
	it("运行时不可用时自动复用同一查询服务，不启动会话", async () => {
		mocked.workspace.mockResolvedValue({ workspaceId: "project", repoPath: "/registered/main" });
		mocked.offlineQuery.mockResolvedValue(response());
		const result = await queryTaskRvfHistoryForCli({
			taskId: "task",
			projectPath: "/registered/main",
			environment: {},
			queryRuntime: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
		});
		expect(result.querySource).toBe("durable_filesystem_fallback");
		expect(mocked.offlineQuery).toHaveBeenCalledWith(
			{ workspaceId: "project", workspacePath: "/registered/main" },
			{ taskId: "task", limit: 10 },
		);
	});
});
