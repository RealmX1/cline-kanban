import { readFile } from "node:fs/promises";
import type { TRPCClient } from "@trpc/client";
import type { Command } from "commander";
import {
	runtimeTaskConversationSessionCreateRequestSchema,
	runtimeTaskConversationSessionRenameRequestSchema,
	runtimeTaskConversationSessionReportRequestSchema,
} from "../core/api-contract";
import { assertCreationPlanModeWasExplicitlySelected } from "../core/creation-startup-settings";
import type { RuntimeAppRouter } from "../trpc/app-router";

interface TaskConversationSessionCommandDependencies {
	resolveWorkspace(projectPath: string | undefined): Promise<string>;
	createClient(workspaceId: string): TRPCClient<RuntimeAppRouter>;
	run(handler: () => Promise<Record<string, unknown>>): Promise<void>;
}

interface TaskConversationSessionCommandOptions {
	taskId?: string;
	projectPath?: string;
	sessionId?: string;
	idempotencyKey?: string;
	role?: string;
	contextSource?: string;
	agent?: string;
	message?: string;
	messageFile?: string;
	reason?: string;
	targetSession?: string;
	cursor?: string;
	startInPlanMode?: boolean | string;
	taskAgentPermissionMode?: string;
	model?: string;
	profile?: string;
	transport?: string;
	name?: string;
	preview?: boolean;
	taskIncarnation?: string;
	nameVersion?: string;
}

async function readMessage(options: TaskConversationSessionCommandOptions): Promise<string> {
	if (options.message !== undefined && options.messageFile !== undefined)
		throw new Error("--message 与 --message-file 不能同时使用。");
	return options.messageFile ? readFile(options.messageFile, "utf8") : (options.message ?? "");
}

export function registerTaskConversationSessionCommands(
	task: Command,
	deps: TaskConversationSessionCommandDependencies,
): void {
	const sessions = task.command("conversation-session").description("创建、查询同任务侧会话，或发送可选 Agent 回报。");
	const scoped = (command: Command) =>
		command
			.option("--task-id <id>", "宿主任务 ID，默认调用会话所属任务。", process.env.KANBAN_TASK_ID)
			.option("--project-path <path>", "项目主仓库路径。");
	scoped(sessions.command("create").description("后台创建侧会话；创建者继续工作，无需等待结果。"))
		.requiredOption("--role <role>", "by_the_way（只读）或 task_collaborator（可写）。")
		.option("--context-source <source>", "creator、current_main 或 fresh。", "creator")
		.option("--agent <id>", "默认沿用创建者 Agent；跨 Agent 请使用 fresh。")
		.option("--start-in-plan-mode [value]", "必须显式选择 true 或 false；单独旗标表示 true。")
		.option("--task-agent-permission-mode <mode>", "单次权限档位，缺省全部允许。")
		.option("--model <id>", "单次模型选择；缺省使用所选 Agent 当前默认配置。")
		.option("--profile <id>", "Codex profile；显式选择沿用其完整权限。")
		.option("--transport <transport>", "pty_terminal 或 acp_stdio_subprocess。")
		.option("--name <text>", "会话主题名，缺省异步命名。")
		.option("--preview", "只预览启动设置，不创建会话。")
		.option("--message <text>", "首条消息，可留空。")
		.option("--message-file <path>", "从 UTF-8 文件读取首条消息。")
		.requiredOption("--reason <text>", "分出话题或协作分工的原因。")
		.requiredOption("--idempotency-key <key>", "同一创建请求的稳定幂等键。")
		.action((options: TaskConversationSessionCommandOptions) =>
			deps.run(async () => {
				const planMode = options.startInPlanMode;
				if (planMode !== undefined && ![true, "true", "false"].includes(planMode))
					throw new Error("--start-in-plan-mode 只接受 true 或 false。");
				const startInPlanMode = planMode === undefined ? undefined : planMode !== "false";
				assertCreationPlanModeWasExplicitlySelected(startInPlanMode);
				const request = runtimeTaskConversationSessionCreateRequestSchema.parse({
					taskId: options.taskId,
					sessionRole: options.role,
					contextSource: options.contextSource,
					agentId: options.agent,
					startInPlanMode,
					taskAgentPermissionMode: options.taskAgentPermissionMode,
					modelId: options.model,
					codexConfigurationProfileId: options.profile,
					codexConfigurationPermissionSelectionSource: options.taskAgentPermissionMode
						? "task_local"
						: options.profile
							? "profile"
							: undefined,
					requestedAgentSessionTransport: options.transport,
					conversationSessionName: options.name,
					initialMessage: await readMessage(options),
					creationReason: options.reason,
					idempotencyKey: options.idempotencyKey,
				});
				const client = deps.createClient(await deps.resolveWorkspace(options.projectPath));
				return {
					...(options.preview
						? await client.runtime.previewTaskConversationSession.query(request)
						: await client.runtime.createTaskConversationSession.mutate(request)),
				};
			}),
		);
	scoped(sessions.command("list").description("查询会话及持久创建进度，不启动 Agent。")).action(
		(options: TaskConversationSessionCommandOptions) =>
			deps.run(async () => {
				if (!options.taskId) throw new Error("需要 --task-id 或 KANBAN_TASK_ID。");
				return {
					ok: true,
					...(await deps
						.createClient(await deps.resolveWorkspace(options.projectPath))
						.runtime.listTaskConversationSessions.query({ taskId: options.taskId })),
				};
			}),
	);
	scoped(sessions.command("get").description("查询精确会话状态、创建进度与一页历史。"))
		.requiredOption("--session-id <id>", "同一任务内的精确会话 ID。")
		.option("--cursor <cursor>", "上一页返回的 nextCursor。")
		.action((options: TaskConversationSessionCommandOptions) =>
			deps.run(async () => {
				if (!options.taskId || !options.sessionId) throw new Error("需要任务与会话 ID。");
				return {
					ok: true,
					...(await deps
						.createClient(await deps.resolveWorkspace(options.projectPath))
						.runtime.getTaskConversationSession.query({
							taskId: options.taskId,
							taskConversationSessionId: options.sessionId,
							cursor: options.cursor,
						})),
				};
			}),
		);
	scoped(sessions.command("rename").description("按完整宿主身份和名称版本修改会话主题名。"))
		.requiredOption("--session-id <id>", "精确会话 ID。")
		.requiredOption("--task-incarnation <number>", "宿主任务 createdAt。")
		.requiredOption("--name-version <number>", "当前名称版本，未命名为 0。")
		.requiredOption("--name <text>", "新的会话主题名。")
		.action((options: TaskConversationSessionCommandOptions) =>
			deps.run(async () => ({
				...(await deps
					.createClient(await deps.resolveWorkspace(options.projectPath))
					.runtime.renameTaskConversationSession.mutate(
						runtimeTaskConversationSessionRenameRequestSchema.parse({
							taskId: options.taskId,
							taskConversationSessionId: options.sessionId,
							expectedTaskIncarnationCreatedAtEpochMs: Number(options.taskIncarnation),
							expectedNameVersion: Number(options.nameVersion),
							conversationSessionName: options.name,
						}),
					)),
			})),
		);
	scoped(sessions.command("report").description("自愿回报，默认发给创建者；程序化回报不构成真人批准。"))
		.option("--target-session <id>", "同 Task 的会话 ID；current_main 表示受理时的当前主会话。")
		.option("--message <text>", "回报正文。")
		.option("--message-file <path>", "从 UTF-8 文件读取回报正文。")
		.requiredOption("--idempotency-key <key>", "本条回报的稳定幂等键。")
		.action((options: TaskConversationSessionCommandOptions) =>
			deps.run(async () => ({
				...(await deps
					.createClient(await deps.resolveWorkspace(options.projectPath))
					.runtime.reportTaskConversationSession.mutate(
						runtimeTaskConversationSessionReportRequestSchema.parse({
							taskId: options.taskId,
							text: await readMessage(options),
							targetTaskConversationSessionId: options.targetSession,
							idempotencyKey: options.idempotencyKey,
						}),
					)),
			})),
		);
}
