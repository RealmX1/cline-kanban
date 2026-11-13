import { readFile } from "node:fs/promises";
import type { TRPCClient } from "@trpc/client";
import type { Command } from "commander";
import { runtimeBindTaskExternalWorkflowRunRequestSchema } from "../core/api-contract";
import type { RuntimeAppRouter } from "../trpc/app-router";

interface ExternalWorkflowCommandDependencies {
	resolveWorkspace(projectPath: string | undefined): Promise<string>;
	createClient(workspaceId: string): TRPCClient<RuntimeAppRouter>;
	run(handler: () => Promise<Record<string, unknown>>): Promise<void>;
}

export function registerTaskExternalWorkflowCommands(task: Command, deps: ExternalWorkflowCommandDependencies): void {
	const workflow = task.command("external-workflow").description("显式绑定外部工作流 Run 或只读查询原引用。");
	workflow
		.command("bind")
		.requiredOption("--request-file <path>", "含精确任务代次、Run 引用及可选观察的 JSON。")
		.option("--project-path <path>", "项目主仓库路径。")
		.action(async (options: { requestFile: string; projectPath?: string }) => {
			await deps.run(async () => {
				const request = runtimeBindTaskExternalWorkflowRunRequestSchema.parse(
					JSON.parse(await readFile(options.requestFile, "utf8")),
				);
				const workspaceId = await deps.resolveWorkspace(options.projectPath);
				const response = await deps.createClient(workspaceId).taskCardAction.updateTaskCardFieldValues.mutate({
					taskId: request.taskId,
					expectedTaskIncarnationCreatedAtEpochMs: request.expectedTaskIncarnationCreatedAtEpochMs,
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
						taskCardFieldValuePatch: {
							externalWorkflowRunBinding: {
								...request.externalWorkflowRunBinding,
								owningWorkspaceId: workspaceId,
								owningTaskId: request.taskId,
								owningTaskIncarnationCreatedAtEpochMs: request.expectedTaskIncarnationCreatedAtEpochMs,
							},
						},
					},
				});
				return {
					ok: true,
					workspaceId,
					taskId: request.taskId,
					externalWorkflowRunBinding: response.taskCardSnapshotAfterAction.taskCard.externalWorkflowRunBinding,
				};
			});
		});
	workflow
		.command("get")
		.requiredOption("--task-id <id>", "精确任务 ID。")
		.option("--project-path <path>", "项目主仓库路径。")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await deps.run(async () => {
				const workspaceId = await deps.resolveWorkspace(options.projectPath);
				const state = await deps.createClient(workspaceId).workspace.getState.query();
				const card = state.board.columns
					.flatMap((column) => column.cards)
					.find((candidate) => candidate.id === options.taskId);
				if (!card) throw new Error("任务不存在，未创建或启动任何流程。");
				const binding = card.externalWorkflowRunBinding;
				const belongsToCurrentTask =
					binding?.owningWorkspaceId === workspaceId &&
					binding.owningTaskId === card.id &&
					binding.owningTaskIncarnationCreatedAtEpochMs === card.createdAt;
				return {
					ok: true,
					workspaceId,
					taskId: card.id,
					taskIncarnationCreatedAtEpochMs: card.createdAt,
					bindingAvailability: !binding ? "unbound" : belongsToCurrentTask ? "bound" : "ownership_mismatch",
					externalWorkflowRunBinding: binding ?? null,
				};
			});
		});
}
