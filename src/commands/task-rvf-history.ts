import { TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import {
	type TaskRvfHistoryRequest,
	type TaskRvfHistoryResponse,
	taskRvfHistoryRequestSchema,
} from "../core/task-rvf-history-contract";
import { resolveProjectInputPath } from "../projects/project-path";
import { createTaskRvfHistoryQueryService } from "../rvf-task-review-history/task-rvf-history-query-service";
import { loadWorkspaceContext } from "../state/workspace-state";

type RuntimeHistoryQuery = (
	workspaceId: string,
	input: TaskRvfHistoryRequest,
	timeoutMs: number,
) => Promise<TaskRvfHistoryResponse>;

export async function queryTaskRvfHistoryForCli(input: {
	taskId?: string;
	projectPath?: string;
	limit?: string;
	cursor?: string;
	queryRuntime: RuntimeHistoryQuery;
	environment?: NodeJS.ProcessEnv;
}): Promise<TaskRvfHistoryResponse> {
	const environment = input.environment ?? process.env;
	const taskId = input.taskId?.trim() || environment.KANBAN_TASK_ID?.trim();
	const projectPath = input.projectPath?.trim() || environment.KANBAN_PROJECT_PATH?.trim();
	if (!taskId || !projectPath)
		throw new Error(
			"缺少 Task 身份：请指定 --task-id / --project-path，或在含 KANBAN_TASK_ID / KANBAN_PROJECT_PATH 的任务会话中调用；不会从 cwd 推测。",
		);
	const request = taskRvfHistoryRequestSchema.parse({
		taskId,
		limit: Number(input.limit ?? 10),
		cursor: input.cursor,
	});
	const workspace = await loadWorkspaceContext(resolveProjectInputPath(projectPath, process.cwd()), {
		autoCreateIfMissing: false,
	});
	const started = Date.now();
	try {
		return await input.queryRuntime(workspace.workspaceId, request, 20_000);
	} catch (error) {
		// 权限拒绝与输入错误不走离线回落，避免把真正的门禁错误伪装成网络故障。
		if (error instanceof TRPCClientError && ["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"].includes(error.data?.code))
			throw error;
		const query = createTaskRvfHistoryQueryService({ budgetMs: Math.max(0, 20_000 - (Date.now() - started)) });
		const response = await query({ workspaceId: workspace.workspaceId, workspacePath: workspace.repoPath }, request);
		return { ...response, querySource: "durable_filesystem_fallback" };
	}
}

export function registerTaskRvfHistoryCommand(
	task: Command,
	dependencies: {
		queryRuntime: RuntimeHistoryQuery;
		runTaskCommand: (operation: () => Promise<TaskRvfHistoryResponse>) => Promise<void>;
	},
): void {
	task
		.command("rvf-history")
		.description("只读查询本 Task 近期 RVF、完整完成事实及当前候选覆盖；运行时不可用时读取持久状态。")
		.option("--task-id <id>", "Task ID；默认 KANBAN_TASK_ID。")
		.option("--project-path <path>", "main checkout 路径；默认 KANBAN_PROJECT_PATH。")
		.option("--limit <count>", "每页条数（1–50）；不限制全历史完成核验。", "10")
		.option("--cursor <cursor>", "上一页返回的 nextCursor。")
		.action(async (options: { taskId?: string; projectPath?: string; limit: string; cursor?: string }) => {
			await dependencies.runTaskCommand(() =>
				queryTaskRvfHistoryForCli({ ...options, queryRuntime: dependencies.queryRuntime }),
			);
		});
}
