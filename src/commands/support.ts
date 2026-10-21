import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import {
	incomingWorkItemSchema,
	incomingWorkItemTriageOperationFailureSchema,
	taskIndexingSupportExecutorSettingsSchema,
} from "../core/task-indexing-support-contract";
import { loadWorkspaceContext } from "../state/workspace-state";
import { createRuntimeTrpcClient } from "./task";

async function printSupportCommandJsonAfterOutputFlushed(payload: unknown): Promise<void> {
	await new Promise<void>((resolveOutput, rejectOutput) => {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`, (error) =>
			error ? rejectOutput(error) : resolveOutput(),
		);
	});
}

async function withSupportRuntime(
	projectPath: string,
	run: (client: ReturnType<typeof createRuntimeTrpcClient>) => Promise<unknown>,
): Promise<void> {
	try {
		const workspace = await loadWorkspaceContext(resolve(projectPath), { autoCreateIfMissing: false });
		const result = await run(createRuntimeTrpcClient(workspace.workspaceId));
		await printSupportCommandJsonAfterOutputFlushed(result);
	} catch (error) {
		const failure = incomingWorkItemTriageOperationFailureSchema.safeParse(
			error instanceof TRPCClientError ? error.data?.incomingWorkItemTriageOperationFailure : null,
		);
		await printSupportCommandJsonAfterOutputFlushed({
			ok: false,
			error: {
				code: "task_indexing_support_command_failed",
				message: error instanceof Error ? error.message : String(error),
				...(failure.success ? failure.data : {}),
			},
		});
		process.exitCode = 1;
	}
}

export function registerSupportCommand(program: Command): void {
	const support = program.command("support").description("共享任务索引、无状态 Agent 与新工作项关系分诊。");
	support
		.command("get-task-indexing-context")
		.description("读取共享 L1–L3 Context，不调用模型、不修改任务。")
		.requiredOption("--project-path <path>", "已注册项目的主仓路径。")
		.action(
			async (options: { projectPath: string }) =>
				await withSupportRuntime(options.projectPath, (client) => client.support.getTaskIndexingContext.query()),
		);
	support
		.command("triage-incoming-work-item")
		.description("分诊新工作项，按证据关联已有任务或创建 backlog 卡；同键可安全重试。")
		.requiredOption("--project-path <path>", "已注册项目的主仓路径。")
		.requiredOption("--work-item-file <path>", "schema_version=1 的工作项 JSON 文件。")
		.action(
			async (options: { projectPath: string; workItemFile: string }) =>
				await withSupportRuntime(options.projectPath, async (client) =>
					client.support.triageIncomingWorkItem.mutate(
						incomingWorkItemSchema.parse(JSON.parse(await readFile(resolve(options.workItemFile), "utf8"))),
					),
				),
		);
	support
		.command("get-executor-settings")
		.requiredOption("--project-path <path>", "项目主仓路径。")
		.action(
			async (options: { projectPath: string }) =>
				await withSupportRuntime(options.projectPath, (client) => client.support.getExecutorSettings.query()),
		);
	support
		.command("configure-executor")
		.description("设置 support 执行器，与新任务默认 agent 分开保存。")
		.requiredOption("--project-path <path>", "项目主仓路径。")
		.requiredOption("--agent-id <id>", "claude 或 codex。")
		.option("--model-id <id>", "模型名；省略时使用该 harness 的默认模型。")
		.action(
			async (options: { projectPath: string; agentId: string; modelId?: string }) =>
				await withSupportRuntime(options.projectPath, (client) =>
					client.support.setExecutorSettings.mutate(
						taskIndexingSupportExecutorSettingsSchema.parse({
							agentId: options.agentId,
							modelId: options.modelId ?? null,
						}),
					),
				),
		);
	support
		.command("backfill-untriaged-rvf-findings")
		.description("异步串行补查 not_triaged 卡；用 get-backfill-status 查看持久结果。")
		.requiredOption("--project-path <path>", "项目主仓路径。")
		.action(
			async (options: { projectPath: string }) =>
				await withSupportRuntime(options.projectPath, (client) =>
					client.support.scheduleRvfFindingsBackfill.mutate(),
				),
		);
	support
		.command("get-backfill-status")
		.requiredOption("--project-path <path>", "项目主仓路径。")
		.action(
			async (options: { projectPath: string }) =>
				await withSupportRuntime(options.projectPath, (client) =>
					client.support.getRvfFindingsBackfillStatus.query(),
				),
		);
	const task = program.commands.find((command) => command.name() === "task");
	if (!task) throw new Error("应先注册 task 命令，再注册 support 与追加备注命令。");
	task
		.command("append-comment")
		.description("原子追加独立备注，不替换原始要求或已有备注。")
		.requiredOption("--project-path <path>", "项目主仓路径。")
		.requiredOption("--task-id <id>", "目标任务 id。")
		.requiredOption("--comment-file <path>", "UTF-8 备注正文文件。")
		.option("--comment-id <id>", "可重复提交的幂等备注 id。")
		.action(
			async (options: { projectPath: string; taskId: string; commentFile: string; commentId?: string }) =>
				await withSupportRuntime(options.projectPath, async (client) =>
					client.taskCardAction.appendTaskComment.mutate({
						taskId: options.taskId,
						taskCommentEntryId: options.commentId,
						commentText: await readFile(resolve(options.commentFile), "utf8"),
					}),
				),
		);
}
