import { TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import { taskVisualizationPublicationRejectionCodeSchema } from "../core/task-visualization-artifact-contract";
import { loadWorkspaceContext } from "../state/workspace-state";
import { stageTaskVisualizationPublication } from "../task-visualization-artifacts/stage-task-visualization-publication";
import { TaskVisualizationArtifactStore } from "../task-visualization-artifacts/task-visualization-artifact-store";
import { createRuntimeTrpcClient, printJson } from "./task";

interface TaskVisualizationCommandOptions {
	taskId?: string;
	projectPath?: string;
	sourceHtmlFile?: string;
	sourceRootDirectory?: string;
	title?: string;
	visualizationArtifactKey?: string;
	visualizationArtifactId?: string;
	resourceMapping?: string[];
	requestPreview?: boolean;
	preview?: boolean;
}

export function registerTaskVisualizationCommand(taskCommand: Command): void {
	const visualization = taskCommand.command("visualization").description("发布和查看任务的持久 HTML 可视化。");
	const addScopeOptions = (command: Command) =>
		command
			.option("--task-id <id>", "任务 ID，默认使用当前任务环境。")
			.option("--project-path <path>", "已注册的主仓库路径，默认使用当前任务环境。");
	const run = async (
		options: TaskVisualizationCommandOptions,
		action: (workspace: { workspaceId: string; repoPath: string }, taskId: string) => Promise<unknown>,
	) => {
		try {
			const taskId = options.taskId ?? process.env.KANBAN_TASK_ID;
			if (!taskId) throw new Error("需要 --task-id 或 KANBAN_TASK_ID。");
			const projectPath = options.projectPath ?? process.env.KANBAN_PROJECT_PATH ?? process.cwd();
			const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
			if (!workspace) throw new Error("主仓库尚未注册到 Kanban。");
			printJson(await action(workspace, taskId));
		} catch (error) {
			printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
			process.exitCode = 1;
		}
	};
	addScopeOptions(
		visualization
			.command("publish")
			.description("固化 HTML 和声明资源，提交到运行时；运行时离线时保留待接受发布包。"),
	)
		.requiredOption("--source-html-file <path>", "本机 HTML 入口文件。")
		.option("--source-root-directory <path>", "入口相对目录的根，默认是 HTML 所在目录。")
		.requiredOption("--title <title>", "可视化标题。")
		.option("--visualization-artifact-key <key>", "稳定的产物身份，默认使用入口绝对路径。")
		.option(
			"--resource-mapping <bundle-path=source-path>",
			"显式声明附属文件或目录，可重复。",
			(value: string, previous: string[]) => [...previous, value],
			[],
		)
		.option("--request-preview", "此次发布也请求当前浏览器预览；默认仅首次发布请求。")
		.option("--no-preview", "此次发布不请求自动预览。")
		.action(async (options: TaskVisualizationCommandOptions) =>
			run(options, async (workspace, taskId) => {
				if (!options.sourceHtmlFile || !options.title) throw new Error("缺少 HTML 入口或标题。");
				const resourceMappings = (options.resourceMapping ?? []).map((mapping) => {
					const separator = mapping.indexOf("=");
					if (separator <= 0 || separator === mapping.length - 1)
						throw new Error("资源映射格式应为 包内相对路径=本机路径。");
					return { bundleRelativePath: mapping.slice(0, separator), sourcePath: mapping.slice(separator + 1) };
				});
				const pending = await stageTaskVisualizationPublication({
					workspaceId: workspace.workspaceId,
					workspaceRepositoryPath: workspace.repoPath,
					taskId,
					title: options.title,
					sourceHtmlFilePath: options.sourceHtmlFile,
					sourceRootDirectoryPath: options.sourceRootDirectory,
					visualizationArtifactKey: options.visualizationArtifactKey,
					resourceMappings,
					sourceConversationSessionId: process.env.KANBAN_HOOK_TASK_ID ?? taskId,
					previewRequestMode:
						options.preview === false ? "never" : options.requestPreview ? "always" : "on_first_publication",
				});
				try {
					const published = await createRuntimeTrpcClient(workspace.workspaceId, {
						retryWhileKanbanRuntimeRestarts: false,
						requestTimeoutMs: 5000,
					}).taskVisualizationArtifacts.publish.mutate({
						taskId,
						publicationRequestId: pending.publicationRequestId,
					});
					return {
						ok: true,
						status: published.wasSupersededByNewerPublication ? "superseded_by_newer_publication" : "published",
						publicationRequestId: pending.publicationRequestId,
						...published,
					};
				} catch (error) {
					// 只终止服务端明确的参数、归属与只读拒绝；内部异常和响应丢失仍需恢复。
					const rejectionCode =
						error instanceof TRPCClientError
							? taskVisualizationPublicationRejectionCodeSchema.safeParse(error.data?.code)
							: null;
					if (rejectionCode?.success) {
						await new TaskVisualizationArtifactStore().recordPublicationRejection(pending.publicationRequestId, {
							failureCode: rejectionCode.data,
							failure: error instanceof Error ? error.message : String(error),
						});
						process.exitCode = 1;
						return {
							ok: false,
							status: "runtime_acceptance_rejected",
							publicationRequestId: pending.publicationRequestId,
							pendingPublicationDirectoryPath: pending.pendingPublicationDirectoryPath,
							error: error instanceof Error ? error.message : String(error),
						};
					}
					return {
						ok: true,
						status: "awaiting_runtime_acceptance",
						publicationRequestId: pending.publicationRequestId,
						pendingPublicationDirectoryPath: pending.pendingPublicationDirectoryPath,
						lastRuntimeAcceptanceError: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
	addScopeOptions(visualization.command("list").description("列出当前任务的已发布可视化。")).action(
		async (options: TaskVisualizationCommandOptions) =>
			run(options, async (workspace, taskId) => ({
				ok: true,
				...(await createRuntimeTrpcClient(workspace.workspaceId).taskVisualizationArtifacts.list.query({ taskId })),
			})),
	);
	addScopeOptions(visualization.command("request-preview").description("请求最近操作的前台任务页面预览指定可视化。"))
		.requiredOption("--visualization-artifact-id <id>", "list 返回的产物 ID。")
		.action(async (options: TaskVisualizationCommandOptions) =>
			run(options, async (workspace, taskId) => {
				if (!options.visualizationArtifactId) throw new Error("缺少可视化产物 ID。");
				return {
					ok: true,
					...(await createRuntimeTrpcClient(
						workspace.workspaceId,
					).taskVisualizationArtifacts.requestPreview.mutate({
						taskId,
						visualizationArtifactId: options.visualizationArtifactId,
					})),
				};
			}),
		);
}
