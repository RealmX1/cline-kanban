import { readFile } from "node:fs/promises";
import type { TRPCClient } from "@trpc/client";
import type { Command } from "commander";
import {
	AGENT_WORK_DELEGATION_SELECTION_CAVEAT,
	SAME_TASK_COLLABORATION_SESSION_CREATION_GUIDANCE,
} from "../core/agent-work-delegation-selection-guidance";
import {
	type RuntimeTaskConversationSessionGetResponse,
	type RuntimeWorkspaceStateResponse,
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
	requestFile?: string;
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
	creatorSessionId?: string;
	expectedNativeSessionId?: string;
	nameVersion?: string;
}

async function readMessage(options: TaskConversationSessionCommandOptions): Promise<string> {
	if (options.message !== undefined && options.messageFile !== undefined)
		throw new Error("--message 与 --message-file 不能同时使用。");
	return options.messageFile ? readFile(options.messageFile, "utf8") : (options.message ?? "");
}

function parseTaskIncarnation(value: string | undefined): number {
	const incarnation = value === undefined || !value.trim() ? Number.NaN : Number(value);
	if (!Number.isSafeInteger(incarnation) || incarnation < 0)
		throw new Error("--task-incarnation 必须是非负安全整数。");
	return incarnation;
}

async function readCreationRequest(
	options: TaskConversationSessionCommandOptions,
	taskIdWasExplicitlySelected: boolean,
) {
	if (options.requestFile) {
		const creationOptionNames = [
			"role",
			"contextSource",
			"agent",
			"message",
			"messageFile",
			"reason",
			"idempotencyKey",
			"startInPlanMode",
			"taskAgentPermissionMode",
			"model",
			"profile",
			"transport",
			"name",
			"taskIncarnation",
			"creatorSessionId",
		] as const;
		if (creationOptionNames.some((name) => options[name] !== undefined))
			throw new Error("--request-file 不能与另一份创建正文或启动设置混用。");
		const request = runtimeTaskConversationSessionCreateRequestSchema
			.strict()
			.parse(JSON.parse(await readFile(options.requestFile, "utf8")));
		if (taskIdWasExplicitlySelected && options.taskId && options.taskId !== request.taskId)
			throw new Error("请求文件与 --task-id 的宿主任务不一致。");
		assertCreationPlanModeWasExplicitlySelected(request.startInPlanMode);
		return request;
	}
	const planMode = options.startInPlanMode;
	if (planMode !== undefined && ![true, "true", "false"].includes(planMode))
		throw new Error("--start-in-plan-mode 只接受 true 或 false。");
	const startInPlanMode = planMode === undefined ? undefined : planMode !== "false";
	assertCreationPlanModeWasExplicitlySelected(startInPlanMode);
	return runtimeTaskConversationSessionCreateRequestSchema.parse({
		taskId: options.taskId,
		expectedTaskIncarnationCreatedAtEpochMs:
			options.taskIncarnation === undefined ? undefined : parseTaskIncarnation(options.taskIncarnation),
		creatorTaskConversationSessionId: options.creatorSessionId,
		sessionRole: options.role,
		contextSource: options.contextSource ?? "creator",
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
}

function validateLifecycleSessionIdentity(
	state: RuntimeWorkspaceStateResponse,
	detail: RuntimeTaskConversationSessionGetResponse,
	taskId: string,
	taskIncarnation: number,
	sessionId: string,
	expectedNativeSessionId?: string,
	allowsReservedSessionWithoutSummary = false,
): { status: "identity_unknown" | "identity_mismatch" | "unsupported"; error: string } | null {
	const card = state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
	if (!card || card.createdAt !== taskIncarnation)
		return { status: "identity_mismatch", error: "宿主任务不存在或已换代。" };
	if (sessionId === taskId || (card.mainTaskConversationSessionId ?? taskId) === sessionId)
		return { status: "unsupported", error: "本入口只处理独立侧会话，不能停止或接续宿主主会话。" };
	const creation = detail.creation;
	if (!creation) return { status: "identity_unknown", error: "缺少原会话创建记录，不能证明执行归属。" };
	if (
		creation.taskId !== taskId ||
		creation.taskIncarnationCreatedAt !== taskIncarnation ||
		creation.taskConversationSessionId !== sessionId
	)
		return { status: "identity_mismatch", error: "原创建记录与宿主代次或会话不匹配。" };
	const summary = state.sessions[sessionId];
	if (!summary || (!detail.summary && !allowsReservedSessionWithoutSummary))
		return allowsReservedSessionWithoutSummary && !summary && !detail.summary && !expectedNativeSessionId
			? null
			: { status: "identity_unknown", error: "缺少精确会话摘要，等待原创建补证。" };
	if (summary.taskId !== sessionId || summary.taskConversationSessionMetadata?.workspaceTaskId !== taskId)
		return { status: "identity_mismatch", error: "会话摘要与宿主归属不匹配。" };
	if (
		expectedNativeSessionId &&
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== expectedNativeSessionId
	)
		return summary.agentNativeConversationSessionIdentity
			? { status: "identity_mismatch", error: "原生会话身份已变化，不能接续或停止另一个执行。" }
			: { status: "identity_unknown", error: "原生会话身份尚未证明。" };
	return null;
}

async function performConversationSessionLifecycle(
	operation: "resume" | "stop",
	options: TaskConversationSessionCommandOptions,
	deps: TaskConversationSessionCommandDependencies,
): Promise<Record<string, unknown>> {
	if (!options.taskId || !options.sessionId) throw new Error("需要精确宿主任务与侧会话 ID。");
	const taskIncarnation = parseTaskIncarnation(options.taskIncarnation);
	const client = deps.createClient(await deps.resolveWorkspace(options.projectPath));
	const binding = {
		operation,
		taskId: options.taskId,
		taskIncarnationCreatedAtEpochMs: taskIncarnation,
		taskConversationSessionId: options.sessionId,
		serverSideAtomicIdentityCheck: false,
	};
	let executionMayHaveOccurred = false;
	try {
		const originalState = await client.workspace.getState.query();
		const detail = await client.runtime.getTaskConversationSession.query({
			taskId: options.taskId,
			taskConversationSessionId: options.sessionId,
		});
		const initialProblem = validateLifecycleSessionIdentity(
			originalState,
			detail,
			options.taskId,
			taskIncarnation,
			options.sessionId,
			options.expectedNativeSessionId,
			operation === "stop",
		);
		if (initialProblem) return { ...binding, ok: false, summary: detail.summary, ...initialProblem };
		const originalSummary = originalState.sessions[options.sessionId];
		const nativeSessionId = originalSummary?.agentNativeConversationSessionIdentity?.nativeSessionId;
		if (operation === "resume" && !nativeSessionId)
			return {
				...binding,
				ok: false,
				status: "identity_unknown",
				summary: originalSummary,
				error: "原生身份缺证，不能以新建执行冒充接续。",
			};
		const card = originalState.board.columns
			.flatMap((column) => column.cards)
			.find((candidate) => candidate.id === options.taskId);
		if (!card) throw new Error("宿主任务已变化。");
		if (operation === "resume") {
			const context = await client.workspace.getTaskContext.query({
				taskId: options.taskId,
				baseRef: card.baseRef,
				worktreeMode: card.worktreeMode,
			});
			if (!context.exists || !originalSummary.workspacePath || context.path !== originalSummary.workspacePath)
				return {
					...binding,
					ok: false,
					status: "identity_mismatch",
					summary: originalSummary,
					error: "原会话与宿主真实工作树不一致。",
				};
		}
		const beforeMutation = await client.workspace.getState.query();
		const beforeProblem = validateLifecycleSessionIdentity(
			beforeMutation,
			detail,
			options.taskId,
			taskIncarnation,
			options.sessionId,
			nativeSessionId,
			operation === "stop",
		);
		if (beforeProblem)
			return {
				...binding,
				ok: false,
				summary: beforeMutation.sessions[options.sessionId] ?? null,
				...beforeProblem,
			};
		// shortcut: 公共生命周期 RPC 尚无原子身份 CAS；前后核验保留未知，待 RPC 支持后把门禁移到服务端。
		executionMayHaveOccurred = true;
		const result =
			operation === "stop"
				? await client.runtime.stopTaskSession.mutate({ taskId: options.sessionId, confirmProcessExit: true })
				: await client.runtime.resumeTaskConversationSession.mutate({
						taskId: options.taskId,
						expectedTaskIncarnationCreatedAtEpochMs: taskIncarnation,
						taskConversationSessionId: options.sessionId,
						expectedNativeConversationSessionId: nativeSessionId ?? "",
					});
		const afterMutation = await client.workspace.getState.query();
		const afterDetail =
			operation === "stop"
				? await client.runtime.getTaskConversationSession.query({
						taskId: options.taskId,
						taskConversationSessionId: options.sessionId,
					})
				: detail;
		const afterProblem = validateLifecycleSessionIdentity(
			afterMutation,
			afterDetail,
			options.taskId,
			taskIncarnation,
			options.sessionId,
			nativeSessionId,
			operation === "stop",
		);
		if (afterProblem)
			return { ...binding, ok: false, summary: result.summary, executionMayHaveOccurred: true, ...afterProblem };
		if (operation === "stop") {
			if (
				originalSummary?.runtimeSessionIncarnationId &&
				afterMutation.sessions[options.sessionId]?.runtimeSessionIncarnationId !==
					originalSummary.runtimeSessionIncarnationId
			)
				return {
					...binding,
					ok: false,
					status: "identity_mismatch",
					summary: afterMutation.sessions[options.sessionId] ?? null,
					executionMayHaveOccurred: true,
					error: "停止期间运行代际已变化，不能把原代退出当作新代已停止。",
				};
			const explicitStopRecorded = "explicitStopRecorded" in result ? result.explicitStopRecorded : undefined;
			const processExitConfirmed = "processExitConfirmed" in result ? result.processExitConfirmed : undefined;
			const stopped =
				explicitStopRecorded === true &&
				afterDetail.taskConversationSessionExplicitlyStopped === true &&
				processExitConfirmed === true;
			return {
				...binding,
				...result,
				ok: stopped,
				status: stopped ? "stopped" : "awaiting_stop_evidence",
				explicitStopRecorded,
				processExitConfirmed,
			};
		}
		return {
			...binding,
			...result,
			status: "status" in result ? result.status : result.ok ? "stopped" : "execution_failed",
		};
	} catch (error) {
		return {
			...binding,
			ok: false,
			status: "identity_unknown",
			summary: null,
			executionMayHaveOccurred,
			error: error instanceof Error ? error.message : String(error),
		};
	}
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
	for (const operation of ["create", "preview", "lookup"] as const) {
		scoped(
			sessions
				.command(operation)
				.description(
					operation === "create"
						? "后台创建同 Task 侧会话。"
						: operation === "preview"
							? "预览冻结会话创建请求，不启动 Agent。"
							: "只读查询同一冻结创建请求，不启动 Agent。",
				),
		)
			.addHelpText(
				"after",
				`\n${SAME_TASK_COLLABORATION_SESSION_CREATION_GUIDANCE}
当前会话内部由其调度并整合结果的分工通常用 Subagent；需要独立目标和生命周期的工作可用 task create。
共享工作目录没有文件写入隔离，创建前明确工作范围与文件责任。
${AGENT_WORK_DELEGATION_SELECTION_CAVEAT}`,
			)
			.option("--request-file <path>", "完整冻结创建请求 JSON；不能与正文或启动设置混用。")
			.option("--task-incarnation <number>", "宿主任务 createdAt，lookup 必须指定。")
			.option("--creator-session-id <id>", "冻结的创建者会话身份，由运行时核对真实调用环境。")
			.option("--role <role>", "by_the_way（只读）或 task_collaborator（可写）。")
			.option("--context-source <source>", "creator、current_main 或 fresh。")
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
			.option("--reason <text>", "分出话题或协作分工的原因。")
			.option("--idempotency-key <key>", "同一创建请求的稳定幂等键。")
			.action((options: TaskConversationSessionCommandOptions, command: Command) =>
				deps.run(async () => {
					const request = await readCreationRequest(options, command.getOptionValueSource("taskId") !== "default");
					if (operation === "lookup" && request.expectedTaskIncarnationCreatedAtEpochMs === undefined)
						throw new Error("lookup 必须绑定 --task-incarnation 或冻结请求中的宿主代次。");
					const client = deps.createClient(await deps.resolveWorkspace(options.projectPath));
					if (operation === "lookup") {
						const found = await client.runtime.lookupTaskConversationSessionCreation.query(request);
						return found ? { found: true, ...found } : { ok: true, found: false, creation: null, summary: null };
					}
					return {
						...(options.preview || operation === "preview"
							? await client.runtime.previewTaskConversationSession.query(request)
							: await client.runtime.createTaskConversationSession.mutate(request)),
					};
				}),
			);
	}
	for (const operation of ["resume", "stop"] as const) {
		scoped(
			sessions
				.command(operation)
				.description(
					operation === "resume"
						? "按原生身份接续精确侧会话，不重发首条消息。"
						: "停止精确侧会话，不停止宿主或兄弟会话。",
				),
		)
			.requiredOption("--task-incarnation <number>", "宿主任务 createdAt。")
			.requiredOption("--session-id <id>", "精确侧会话 ID。")
			.option("--expected-native-session-id <id>", "已知原生会话身份；缺证或不匹配时拒绝执行。")
			.action((options: TaskConversationSessionCommandOptions) =>
				deps.run(() => performConversationSessionLifecycle(operation, options, deps)),
			);
	}
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
