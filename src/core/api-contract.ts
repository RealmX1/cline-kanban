import { z } from "zod";

export {
	type PostDeployVerificationEntryReference,
	type RuntimePostDeployVerificationEntryNavigationTarget,
	type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequest,
	type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse,
	runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequestSchema,
	runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponseSchema,
} from "./post-deploy-verification-entry-navigation-contract";

import {
	taskVisualizationArtifactsUpdatedMessageSchema,
	taskVisualizationBrowserContextMessageSchema,
	taskVisualizationPreviewAcknowledgmentMessageSchema,
	taskVisualizationPreviewRequestedMessageSchema,
} from "./task-visualization-artifact-contract";

export * from "./task-visualization-artifact-contract";

import { codexNativeSessionControlEndpointSchema } from "./codex-native-session-control-endpoint-contract";
import { independentTaskCreationProvenanceSchema } from "./independent-task-creation-contract.js";

export * from "./independent-task-creation-contract.js";

import { projectVisualIdentitySchema } from "./project-visual-identity.js";

export type {
	ProjectPresetIconId,
	ProjectVisualColorId,
	ProjectVisualIdentity,
	SetProjectVisualIdentityRequest,
} from "./project-visual-identity.js";
export {
	projectVisualIdentitySchema,
	readProjectIconImageRequestSchema,
	readProjectIconImageResponseSchema,
	resetProjectVisualIdentityRequestSchema,
	setProjectVisualIdentityRequestSchema,
} from "./project-visual-identity.js";

// Stage 4 全写侧反转：facet 为写时主真相源，`state` 降为 projectLegacyState(facets) 派生投影。
// bundle-safe：session-activity 是零 Node 依赖的纯函数模块，其对 api-contract 仅 type-only import
// （编译期擦除），故二者无运行时循环；本处取值 import 不会把任何 Node 依赖拖进浏览器 bundle。
import { isKanbanCursorAgentModelId } from "./cursor-agent-models.js";
import {
	webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema,
	webUiBoardMutationInitiatorSchema,
} from "./kanban-web-ui-page-load-request-origin-nonce.js";
import { notificationSpeechAnnouncementScriptSchema } from "./notification-lifecycle-contract.js";
import {
	runtimePostDeployVerificationAcknowledgementSchema,
	runtimePostDeployVerificationClosureOutcomeSchema,
	runtimePostDeployVerificationDoneEntryClosureRequestSchema,
	runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema,
} from "./post-deploy-verification-done-entry-closure-contract.js";
import { projectLegacyState } from "./session-activity.js";
import { taskMainSessionHandoverRecordSchema } from "./task-main-session-handover-contract";
import { resolveTaskTitle } from "./task-title.js";

export type { NotificationSpeechAnnouncementScript } from "./notification-lifecycle-contract.js";
export * from "./permanently-deleted-task-history-contract.js";
// Post-Deploy Verification「移入 Done 结案」的请求侧契约（确认项、原因码、结案请求、门禁拒绝前缀）住在独立文件里
// （原因见该文件顶部），这里原样转出，调用方照旧从 api-contract 取。
export * from "./post-deploy-verification-done-entry-closure-contract.js";
export * from "./rvf-automatic-closeout-contract.js";
export * from "./rvf-automatic-closeout-recovery-contract.js";
export type {
	TaskMainSessionHandoverAgentId,
	TaskMainSessionHandoverMaterial,
	TaskMainSessionHandoverPrepareResponse,
	TaskMainSessionHandoverRecord,
	TaskMainSessionHandoverRecoverWithNewAgentSessionRequest,
	TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
	TaskMainSessionHandoverRequest,
	TaskMainSessionHandoverStatusResponse,
} from "./task-main-session-handover-contract";
export { taskMainSessionHandoverRecordSchema } from "./task-main-session-handover-contract";
export * from "./task-rvf-history-contract.js";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
	// 服务端因文件过大而未回传全文时置 true：oldText/newText 被省略为 null，additions/deletions 仍有效。
	// 前端据此渲染"文件过大，未内联显示"占位，避免大 payload/主线程 Prism+DOM 把整个 app 拖垮。
	contentOmittedForSize: z.boolean().optional(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeTaskWorktreeModeSchema = z.enum(["branch", "inplace"]);
export type RuntimeTaskWorktreeMode = z.infer<typeof runtimeTaskWorktreeModeSchema>;

// 每个任务的放权档位，跨全部 harness 共用。这条轴与 `startInPlanMode` **正交**：
// plan 起步只决定「开局先只读规划」，不得剥夺此处选定的权限档（例如 Claude Code 在
// plan 起步时改用 --allow-dangerously-skip-permissions 预授权后续升档）。
// 各档位到每个 agent 的具体旗标映射见 src/core/task-agent-permission-mode.ts。
export const runtimeTaskAgentPermissionModeSchema = z.enum([
	"ask_for_every_tool_use",
	"auto_approve_file_edits_only",
	"bypass_all_permission_prompts",
]);
export type RuntimeTaskAgentPermissionMode = z.infer<typeof runtimeTaskAgentPermissionModeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

const runtimeTrimmedNonEmptyStringSchema = z
	.string()
	.transform((value) => value.trim())
	.pipe(z.string().min(1));

export const runtimeAgentIdSchema = z.enum([
	"claude",
	"codex",
	"gemini",
	"opencode",
	"droid",
	"kiro",
	"cline",
	"cursor",
	"kimi",
	// oh-my-pi（CLI 名 omp）。它不是 PTY 终端 agent：Kanban 通过 ACP（Agent Client Protocol,
	// JSON-RPC over stdio）与 `omp acp` 通话，会话状态由结构化 SessionUpdate 驱动而非刮 TUI。
	// 见 src/acp-client-session/。
	"omp",
]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;
// 哪些 terminal agent 有「模型选择器」这条通道：Kanban 能探测出它的模型目录、并在启动时把选中的
// model id 传给 CLI。
export const runtimeTerminalAgentModelSelectionAgentIdSchema = z.enum(["claude", "codex", "cursor", "kimi"]);
export type RuntimeTerminalAgentModelSelectionAgentId = z.infer<typeof runtimeTerminalAgentModelSelectionAgentIdSchema>;
// 哪些 terminal agent 的历史会话能被按 session id 索引并续接/分叉。
//
// 这与「有没有模型选择器」是两件互不蕴含的事，曾经共用一个枚举，导致「给某个 agent 加模型选择器」会
// 顺带开放历史会话播种。Kimi / OMP 的本任务按 ID 恢复由独立契约声明，不进入此历史选择枚举。
export const runtimeResumableAgentSessionSourceAgentIdSchema = z.enum(["claude", "codex", "cursor"]);
export type RuntimeResumableAgentSessionSourceAgentId = z.infer<typeof runtimeResumableAgentSessionSourceAgentIdSchema>;
export const runtimeTaskAgentSessionInitializationReuseModeSchema = z.enum([
	"resume_existing_session",
	"fork_existing_session",
]);
export type RuntimeTaskAgentSessionInitializationReuseMode = z.infer<
	typeof runtimeTaskAgentSessionInitializationReuseModeSchema
>;
// 本任务重启寻址与历史播种分开：Kimi / OMP 支持前者，不因此开放历史选择器。
export const runtimeObservedAgentNativeConversationSessionResumeAddressingSchema = z.object({
	sourceAgentId: z.enum(["claude", "codex", "cursor", "kimi", "omp"]),
	sourceSessionId: z
		.string()
		.trim()
		.min(1)
		.refine(
			(id) =>
				!id.startsWith("-") &&
				Array.from(id).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
		),
	sourceSessionReuseMode: z.literal("resume_existing_session"),
});
export type RuntimeObservedAgentNativeConversationSessionResumeAddressing = z.infer<
	typeof runtimeObservedAgentNativeConversationSessionResumeAddressingSchema
>;

export const runtimeTaskAgentSessionInitializationSchema = z
	.object({
		sourceAgentId: runtimeResumableAgentSessionSourceAgentIdSchema,
		sourceSessionId: z.string().trim().uuid(),
		sourceSessionReuseMode: runtimeTaskAgentSessionInitializationReuseModeSchema,
		sourceSessionWorkingDirectoryPath: z.string().trim().min(1).optional(),
		codexConversationStorageHomeDirectoryPath: z.string().trim().min(1).optional(),
	})
	.superRefine((initialization, ctx) => {
		if (
			initialization.sourceAgentId === "cursor" &&
			initialization.sourceSessionReuseMode === "fork_existing_session"
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["sourceSessionReuseMode"],
				message: "Cursor Agent does not support forking existing sessions.",
			});
		}
	});
export type RuntimeTaskAgentSessionInitialization = z.infer<typeof runtimeTaskAgentSessionInitializationSchema>;
export const runtimeTaskTerminalAgentModelOverrideSettingsSchema = z
	.object({
		agentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
		modelId: runtimeTrimmedNonEmptyStringSchema,
	})
	.superRefine((settings, ctx) => {
		if (settings.agentId === "cursor" && !isKanbanCursorAgentModelId(settings.modelId)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["modelId"],
				message: "Cursor agent model overrides must use auto, a composer model, or a grok model.",
			});
		}
	});
export type RuntimeTaskTerminalAgentModelOverrideSettings = z.infer<
	typeof runtimeTaskTerminalAgentModelOverrideSettingsSchema
>;

const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "validation", "trash"]);
export const runtimeBoardColumnIdSchema = z.preprocess(
	(val) => (val === "done" ? "trash" : val),
	runtimeBoardColumnIdEnum,
);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdEnum>;

const runtimeTaskAutoReviewModeEnum = z.enum(["commit", "pr"]);
export const runtimeTaskAutoReviewModeSchema = z.preprocess(
	(val) => (val === "move_to_trash" || val === "move_to_done" ? "commit" : val),
	runtimeTaskAutoReviewModeEnum,
);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeEnum>;

export const runtimeClineReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type RuntimeClineReasoningEffort = z.infer<typeof runtimeClineReasoningEffortSchema>;
export const runtimeTaskClineSettingsSchema = z.object({
	providerId: z.string().optional(),
	modelId: z.string().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.optional(),
});
export type RuntimeTaskClineSettings = z.infer<typeof runtimeTaskClineSettingsSchema>;
export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;
export const runtimeAgentPromptImageAttachmentReferenceSchema = z.object({
	imageAttachmentId: z.string().regex(/^[a-f0-9]{64}$/u),
	imageFilePath: z.string(),
	imageMimeType: z.string(),
	imageDisplayName: z.string(),
});
export const runtimeSaveAgentPromptImageAttachmentsRequestSchema = z.object({
	images: z.array(runtimeTaskImageSchema),
});
export const runtimeReadAgentPromptImageAttachmentsRequestSchema = z.object({
	imageAttachmentIds: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
});
export const runtimeTaskCommentEntrySchema = z.object({
	taskCommentEntryId: z.string(),
	commentText: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeTaskCommentEntry = z.infer<typeof runtimeTaskCommentEntrySchema>;

const runtimeLegacyTaskClineReasoningEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh"]);

function normalizeRuntimeTaskClineSettings(input: {
	clineSettings?: RuntimeTaskClineSettings;
	clineProviderId?: string;
	clineModelId?: string;
	clineReasoningEffort?: z.infer<typeof runtimeLegacyTaskClineReasoningEffortSchema>;
}): RuntimeTaskClineSettings | undefined {
	if (input.clineSettings !== undefined) {
		return input.clineSettings;
	}
	const providerId = input.clineProviderId?.trim();
	const modelId = input.clineModelId?.trim();
	if (!providerId && !modelId && input.clineReasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(input.clineReasoningEffort && input.clineReasoningEffort !== "default"
			? { reasoningEffort: input.clineReasoningEffort }
			: {}),
	};
}

function normalizeRuntimeTaskCommentEntries(
	entries?: RuntimeTaskCommentEntry[],
): RuntimeTaskCommentEntry[] | undefined {
	if (!entries || entries.length === 0) {
		return undefined;
	}
	const normalizedEntries = entries
		.map((entry) => {
			const taskCommentEntryId = entry.taskCommentEntryId.trim();
			const commentText = entry.commentText.trim();
			if (!taskCommentEntryId || !commentText) {
				return null;
			}
			return {
				taskCommentEntryId,
				commentText,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			};
		})
		.filter((entry): entry is RuntimeTaskCommentEntry => entry !== null);
	return normalizedEntries.length > 0 ? normalizedEntries : undefined;
}

// Kanban 与一个 agent 通话的方式（PTY / 进程内 Cline SDK / ACP 子进程）。canonical zod 源放在
// api-contract（契约叶子模块），src/core/agent-catalog.ts 由此派生 TS 类型并挂到 catalog 条目上，
// 避免 api-contract → agent-catalog 的反向依赖。
// 定义位置必须留在 runtimeBoardCardSchema **之前**：卡片的 ompAgentSessionTransport 字段在模块求值
// 时就要引用它，挪到下面会踩 const 的 TDZ。
export const runtimeAgentSessionTransportSchema = z.enum([
	// PTY 里跑一个 CLI，靠刮 TUI 输出 + agent 侧 hook 回调 `kanban hooks` 判状态。
	"pty_terminal",
	// 在 Kanban 服务进程内直接实例化 @clinebot/core，订阅结构化事件。
	"in_process_cline_sdk",
	// spawn 一个子进程，用 ACP（JSON-RPC over stdio）通话，状态由 SessionUpdate 驱动。
	"acp_stdio_subprocess",
]);
export type RuntimeAgentSessionTransport = z.infer<typeof runtimeAgentSessionTransportSchema>;

// Exploratory vs Operational 会话模式（探索/研究型 vs 执行/操作型）。
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §A.1。
// 定义位置必须留在 runtimeBoardCardSchema **之前**：卡片的 taskConversationMode 字段在模块求值
// 时就要引用它（同上方 runtimeAgentSessionTransportSchema 的 TDZ 约束）。
export const runtimeTaskConversationModeSchema = z.enum([
	// 执行/操作型任务（缺省）：一切如常，不注入探索礼仪指令、不跑 thread graph 维护作业。
	"operational",
	// 探索/研究型任务：会话产出的结构与结论本身是资产——启动时注入 exploratory 指令文件
	// （探索礼仪 + findings 建议工作流），并作为 exploration thread graph 维护作业的开关
	// （作业由 agent-conversation-exploration-thread-graph 包执行，Kanban 只做宿主胶水）。
	"exploratory",
]);
export type RuntimeTaskConversationMode = z.infer<typeof runtimeTaskConversationModeSchema>;

export const runtimeBoardCardSchema = z
	.object({
		id: z.string(),
		// 运行时维护的当前主会话绑定；缺省兼容旧卡片（会话 ID 等于卡片 ID）。
		mainTaskConversationSessionId: z.string().min(1).optional(),
		taskMainSessionHandover: taskMainSessionHandoverRecordSchema.optional(),
		independentTaskCreationProvenance: independentTaskCreationProvenanceSchema.optional(),
		title: z.string().optional(),
		prompt: z.string(),
		startInPlanMode: z.boolean(),
		// 老卡片没有这个字段；读时不在这里补默认值，而是在启动任务处按当时的全局
		// agentAutonomousModeEnabled 推导（见 resolveTaskAgentPermissionModeFromLegacyAutonomousFlag），
		// 因为 schema 层看不到 runtime config。
		taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.optional(),
		autoReviewEnabled: z.boolean().optional(),
		autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		taskCommentEntries: z.array(runtimeTaskCommentEntrySchema).optional(),
		// Task Pinboard（置顶板）：**字段存在即已置顶**，值同时就是置顶板内的排序键（倒序，最近置顶的在前）。
		// 与本文件里另外两处 "pin" 语义（模型 pinned_version、建卡固化会话通道）无关，也与 Focus View 的
		// sticky 卡头几何无关——那些都不落盘。置顶态跟着卡片走，卡片被永久删除时字段一并消失，无孤儿可清。
		pinnedToTaskPinboardAt: z.number().optional(),
		// 用户在置顶时填的一句「我为什么盯着它」，可留空（留空时字段不写）。
		taskPinboardPinReason: z.string().optional(),
		agentId: runtimeAgentIdSchema.optional(),
		// omp 这张卡「下次启动该用哪条通道」。与 startInPlanMode / taskAgentPermissionMode 同为
		// **建卡时固化**的快照：建卡那一刻把全局默认写死在卡上，之后改全局默认不追溯已有卡片。
		// 只在 spawn 那一刻被消费；活会话实际用的通道读 summary.sessionTransport，不读这里。
		// 老卡片没有这个字段 ⇒ 回退到当时的全局默认（即 TUI），这会把现存 omp 卡片从 ACP 翻到 TUI，
		// 是本次有意为之的默认切换（ACP 会话纯内存不落盘，无数据损失）。
		// 注意：本字段落在**卡**上，隐含「一张 omp 卡只有一条 agent 会话」。omp 一旦获得 By the way
		// 支持（一个 task 会有多条会话），必须改成按会话 id 的映射。
		ompAgentSessionTransport: runtimeAgentSessionTransportSchema.optional(),
		// 这张卡的会话模式声明（探索/操作，蓝图 §A.1）：用户建卡/编辑卡片时声明；缺省 =
		// operational，legacy 卡片零迁移。与 ompAgentSessionTransport 同为**建卡时固化**的快照——
		// 活会话读 summary.taskConversationMode 投影，卡片改模式只影响下一次启动（v1 不做模式
		// 热切换，避免 map 生命周期歧义）。
		taskConversationMode: runtimeTaskConversationModeSchema.optional(),
		// runtime 观测值，不是用户意图：本卡片最近一次**真正启动成功**的会话用的是哪个 agent。
		//
		// 为什么不复用上面的 `agentId`：那个字段的语义是「用户为这张卡做的 per-task 覆盖」，缺失即
		// 「跟随项目默认档」。把解析出来的默认档物化进去，等于把「跟随默认」静默钉成一个用户从未选过的
		// 永久覆盖，agent 选择器还会显示成用户主动选过——与 task-board-mutations.ts 里
		// `taskAgentPermissionMode` 那段注释禁止的是同一类错误。
		//
		// 为什么需要它：sessions.json 只在 graceful shutdown 与客户端 saveState 落盘，硬中断（系统重启 /
		// 本地 redeploy）会让「这个 task 用的是哪个 agent」在盘上彻底消失；而走默认档的卡片上又没有
		// `agentId` 可回填，重启后该 task 就只剩一条 agentId 为 null 的空壳 summary——TUI 全白、
		// 「重启终端会话」灰掉。本字段是这条链路上唯一在**启动那一刻**就 durable 的真相源。
		//
		// 只由 runtime 在会话启动成功后写入，故**不出现在** RuntimeUpdateTaskInput 里；它靠 updateTask
		// 的 `...card` 展开穿过用户编辑。
		mostRecentlyLaunchedAgentSessionAgentId: runtimeAgentIdSchema.optional(),
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
		terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
		taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.optional(),
		clineProviderId: z.string().optional(),
		clineModelId: z.string().optional(),
		clineReasoningEffort: runtimeLegacyTaskClineReasoningEffortSchema.optional(),
		baseRef: z.string(),
		parentSessionId: z.string().optional(),
		worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
		prepFilePath: z.string().optional(),
		createdAt: z.number(),
		updatedAt: z.number(),
		// Description（prompt 文本 + 附图）最后一次**内容真正变化**的时间，Backlog 列按它倒序排序、卡片上显示。
		// 与 updatedAt 刻意分开：后者任何用户可见修改都推进（改标题 / agent / baseRef / 移列 / 评论……），
		// 本字段只在建卡与 Description 内容变化时推进。老卡片没有该字段 ⇒ optional，读处经
		// resolveTaskDescriptionLastUpdatedAt 回落到 updatedAt（见 backlog-task-description-last-updated-ordering.ts）。
		// 必须声明在这里：z.object 默认剥掉未知键，不声明就会在服务端解析时被丢掉。
		taskDescriptionLastUpdatedAt: z.number().optional(),
	})
	.transform(
		({
			clineProviderId: _legacyProviderId,
			clineModelId: _legacyModelId,
			clineReasoningEffort: _legacyReasoningEffort,
			taskCommentEntries: rawTaskCommentEntries,
			...card
		}) => {
			const clineSettings = normalizeRuntimeTaskClineSettings({
				clineSettings: card.clineSettings,
				clineProviderId: _legacyProviderId,
				clineModelId: _legacyModelId,
				clineReasoningEffort: _legacyReasoningEffort,
			});
			const taskCommentEntries = normalizeRuntimeTaskCommentEntries(rawTaskCommentEntries);
			const legacyTaskAgentSessionInitialization = card.parentSessionId
				? runtimeTaskAgentSessionInitializationSchema.safeParse({
						sourceAgentId: "codex",
						sourceSessionId: card.parentSessionId,
						sourceSessionReuseMode: "fork_existing_session",
					})
				: null;
			const taskAgentSessionInitialization =
				card.taskAgentSessionInitialization ??
				(legacyTaskAgentSessionInitialization?.success ? legacyTaskAgentSessionInitialization.data : undefined);
			return {
				...card,
				...(clineSettings !== undefined ? { clineSettings } : {}),
				...(taskCommentEntries !== undefined ? { taskCommentEntries } : {}),
				...(taskAgentSessionInitialization !== undefined ? { taskAgentSessionInitialization } : {}),
				title: resolveTaskTitle(card.title, card.prompt),
			};
		},
	);
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

// 旧版 board.json 带的 `dependencies` 键（已退役的任务连线 / 完成后自动启动机制）：本 schema 非 strict，
// 读入时被 zod 静默剥离、不抛错，下次写盘即消失。
export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

export const runtimeGitBranchSchema = z.object({
	name: z.string(),
	lastCommitDate: z.string().optional(),
});
export type RuntimeGitBranch = z.infer<typeof runtimeGitBranchSchema>;

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(runtimeGitBranchSchema),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	// manual_review：用户经卡片悬浮按钮把一个停在 agent 回合（多为卡死/空闲）的会话手动翻入「等人审查」
	// 回合（区别于 agent 自然完成的 hook/exit/completion），自解释、利于排查与 UI 区分。
	// idle_stall：终端 agent 完工却不退出、turnOwner 卡在 agent、liveness=live（光标重绘让 lastOutputAt
	// 一直刷新到「现在」），既无进程退出、也无 turnOwner=user 持稳可触发客户端搬列，于是永久滞留 In Progress。
	// scanForStalls 观测到「agent 回合 + 停在交互提示符 + lastSubstantiveOutputAt 超保守阈值」时主动翻入审查
	// 回合自愈（区别于 manual_review 的人工触发、区别于 hook 的 agent 自然 Stop——保留诊断可分性）。
	.enum(["attention", "exit", "error", "interrupted", "hook", "completion", "manual_review", "idle_stall"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

// ── 双轴会话状态 facet（加性、可选）──────────────────────────────────────────────
// 把一维 `state` 过载的 `running` / `awaiting_review` 拆成三条正交 facet。Stage 1 起与 legacy
// `state` 并写（dual-write）、保持投影可逆；Stage 2 起翻转为权威、`state` 降为 `projectLegacyState`
// 派生投影。派生求值/护栏在纯函数真相源 `src/core/session-activity.ts`。
//
// 「谁的回合」turnOwner：agent=该 agent 推进；user=等人；null=无会话/无回合。
export const runtimeTaskSessionTurnOwnerSchema = z.enum(["agent", "user"]).nullable();
export type RuntimeTaskSessionTurnOwner = z.infer<typeof runtimeTaskSessionTurnOwnerSchema>;

// 「执行活性」liveness（存储基值，事件驱动）：不含派生的 computing/quiet——那是随时间漂移的
// 派生叠加，绝不落盘/推送（summary 无周期 tick，一写即 stale）。
//   none=无会话/无回合；starting=spawn 后首条 PTY 输出前；live=活跃存活；
//   retrying=连接重试（仅由 connectionRetry 投影，不另存）；exited=进程已退仍等人；
//   failed=spawn 失败；interrupted=被中断。
export const runtimeTaskSessionLivenessSchema = z.enum([
	"none",
	"starting",
	"live",
	"retrying",
	"exited",
	"failed",
	"interrupted",
]);
export type RuntimeTaskSessionLiveness = z.infer<typeof runtimeTaskSessionLivenessSchema>;

// 「人轴」userTurnKind：仅 turnOwner==="user" 有意义（agent/null 回合恒为 null）；事件置位、
// 可存储/广播。review=完成待审；question=澄清提问；plan_review=计划待批；permission=权限请求；
// error=运行错；interrupted=被中断；needs_input=兜底待输入。
export const runtimeTaskSessionUserTurnKindSchema = z
	.enum(["review", "question", "plan_review", "permission", "error", "interrupted", "needs_input"])
	.nullable();
export type RuntimeTaskSessionUserTurnKind = z.infer<typeof runtimeTaskSessionUserTurnKindSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

// 侧会话不能借主卡片的下次启动配置恢复：两者可能使用不同 agent、模型和通道。
export const runtimeTaskConversationSessionLaunchSettingsSchema = z.object({
	taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema,
	startInPlanMode: z.boolean().optional(),
	sessionTransport: runtimeAgentSessionTransportSchema,
	terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
});

export const runtimeTaskConversationSessionMetadataSchema = z.object({
	workspaceTaskId: z.string(),
	// 无论是否继承上下文，都记录侧会话诞生时的来源边界；不能拿重启后的 startedAt 反推。
	sideSessionCreatedAt: z.number().optional(),
	sideSessionOriginMainSessionId: z.string().optional(),
	sideSessionOriginMainNativeSessionId: z.string().optional(),
	sideSessionOriginMainTranscriptPath: z.string().optional(),
	sideSessionOriginMainAgentId: z.string().optional(),
	taskConversationSessionRole: z.enum(["main", "by_the_way", "task_collaborator"]),
	// 当前角色按主会话绑定派生；创建角色与上下文来源不随交接改写。
	taskConversationSessionRoleAtCreation: z.enum(["main", "by_the_way", "task_collaborator"]).optional(),
	// 持久历史事实：被提升过的协作会话在再次切主后仍是前主会话。
	taskConversationSessionHasHeldMainResponsibility: z.boolean().optional(),
	taskAutomationSuspendedForMainSessionHandover: z.boolean().optional(),
	taskConversationSessionContextSource: z.enum(["main", "started_from_scratch", "forked_from_main_current_turn"]),
	parentTaskConversationSessionId: z.string().nullable(),
	mainSessionOriginTurnNumber: z.number().int().nonnegative().nullable(),
	mainSessionOriginUserMessagePreview: z.string().nullable(),
	latestUserMessagePreview: z.string().nullable(),
	taskConversationSessionLaunchSettings: runtimeTaskConversationSessionLaunchSettingsSchema.optional(),
});
export type RuntimeTaskConversationSessionMetadata = z.infer<typeof runtimeTaskConversationSessionMetadataSchema>;

// 终端（PTY）agent 的**原生会话身份**（N0a）：harness 自己的 session id 与 transcript 路径。
// 来源 = hook stdin（Claude Code / Codex 的 hooks 载荷都带 session_id + transcript_path），由
// `kanban hooks` CLI 抽出、经 hooks.ingest 落到 summary 的加性 sidecar。它是 exploration thread graph
// 维护作业（`claude -p --resume <nativeSessionId> --fork-session`）与 transcript 投影的唯一身份来源——
// 不再从 ~/.claude/projects 目录扫描猜测。纯运行期事实，不参与 facet 与 superRefine。
//
// Cursor 例外：cursor-agent 没有可供 kanban 安装的会话级 hook（只有全局 / 工作区内的 hooks.json，且续跑时
// sessionStart 不触发），所以 Cursor 的身份由 kanban 在**启动前**自己分配（`--resume <新 UUID>` 开局即以该 id
// 建 chat），而不是事后观测。来源记在 identityEstablishmentMethod 上，审计时一眼可分。
export const runtimeAgentNativeConversationSessionIdentityEstablishmentMethodSchema = z.enum([
	// agent 自己报告的 id（hook stdin / 托管扩展 / ACP 握手）。旧盘数据缺这个字段时按此解读。
	"observed_from_agent_hook_extension_or_acp_handshake",
	// kanban 在 spawn 前分配、落盘，再用 `--resume <id>` 开局（Cursor）。
	"kanban_assigned_before_agent_launch",
	// 建卡播种：源对话已复制进本会话的执行工作目录，本会话从此按该 id 续跑。
	"task_agent_session_initialization_seed_materialized_into_working_directory",
	// 存量回填的窄例外：会话从未记录过 id，而其工作目录的 chat 桶里**恰好只有一段**已建立的对话、且无同 agent
	// 竞争会话——与今天 `--continue` 会选中的那一段等价，只是把它钉住。有歧义一律不回填。
	"unique_established_chat_in_working_directory_bucket_backfill",
	// 续跑前沿 Claude 转录末尾的 `continued-in` 记录走到对话最新所在的 id（对话曾被 `/background` 搬进
	// Claude 后台会话，而那个后台会话的 hook 没把新 id 报回本任务）。
	"followed_claude_code_transcript_continued_in_record_to_conversation_continuation",
]);
export type RuntimeAgentNativeConversationSessionIdentityEstablishmentMethod = z.infer<
	typeof runtimeAgentNativeConversationSessionIdentityEstablishmentMethodSchema
>;

export const runtimeAgentNativeConversationSessionIdentitySchema = z.object({
	// hook 载荷推断出的 harness 来源（claude / codex / …），与 latestHookActivity.source 同一口径。
	sourceAgentId: z.string(),
	nativeSessionId: z.string(),
	transcriptPath: z.string().nullable(),
	observedAt: z.number(),
	// 加性可选：缺省 = observed_from_agent_hook_extension_or_acp_handshake（hook / ACP 两条既有生产者不写它）。
	identityEstablishmentMethod: runtimeAgentNativeConversationSessionIdentityEstablishmentMethodSchema.optional(),
});
export type RuntimeAgentNativeConversationSessionIdentity = z.infer<
	typeof runtimeAgentNativeConversationSessionIdentitySchema
>;

// 「这段对话有没有真的落进 agent 自己的会话存储」的观测（目前只有 Cursor 产出）。
//
// 存在理由：Cursor 会话可能**从未建立对话**——典型成因是停在 cursor-agent 的 Workspace Trust 对话框上，prompt
// 根本没提交，chat 目录一直不存在。旧版要等 PTY 死掉、续跑撞上 `No previous chats found.` 连撞 5 次熔断才露馅，
// 而熔断文案让人「手动刷新」，刷新又是同一条注定失败的续跑。本 sidecar 让这件事**在当时**就被标出来，并让续跑
// 前的预检据此拒绝，而不是 spawn 一个注定秒退的进程。
//
// 只写 sidecar，不碰 facet 三元组；null / 缺省 = 没有需要提示的情况。
export const runtimeAgentNativeConversationPersistenceStatusSchema = z.enum([
	// 活会话：kanban 分配的 chat id 在启动窗口内仍未在 chat store 里出现 ⇒ prompt 没有被提交。
	"first_prompt_not_persisted_within_startup_window",
	// 首轮已在 agent 的会话存储里建立（hasConversation=true），之后可按 id 续跑。
	"conversation_established_in_agent_native_store",
	// 进程已退出 / 运行时重启后核对：这段对话从未建立，按 id 或 `--continue` 续跑都接不上任何东西。
	"conversation_never_established_in_agent_native_store",
]);
export type RuntimeAgentNativeConversationPersistenceStatus = z.infer<
	typeof runtimeAgentNativeConversationPersistenceStatusSchema
>;

export const runtimeAgentNativeConversationPersistenceObservationSchema = z.object({
	persistenceStatus: runtimeAgentNativeConversationPersistenceStatusSchema,
	// kanban 分配 / 记录的那个原生 id；从未记录过 id 的旧会话为 null。
	nativeSessionId: z.string().nullable(),
	workingDirectoryPath: z.string(),
	// 可识别的阻塞成因（终端输出里匹配到的）；判不出就是 null，绝不猜。
	suspectedBlockingCause: z.enum(["agent_workspace_trust_prompt_awaiting_answer"]).nullable(),
	observedAt: z.number(),
});
export type RuntimeAgentNativeConversationPersistenceObservation = z.infer<
	typeof runtimeAgentNativeConversationPersistenceObservationSchema
>;

// 「按 id 要续跑的对话正被 harness 自己的后台会话守护进程占着、而且不能安全收回」的观测（目前只有 Claude Code：
// 终端里 `/background` 之后对话在 Claude 守护进程里）。能安全收回的情形 kanban 直接 `claude stop` 后续跑，不留观测。
// 判据与处置见 src/terminal/claude-code-background-session-ownership-preflight-before-resume.ts。
export const runtimeHarnessBackgroundSessionReclaimBlockedReasonSchema = z.enum([
	// Claude 自报 busy：请求在途或工具在跑。
	"background_session_generating_response_mid_turn",
	// Claude 自报 waiting：对话框 / 权限请求 / elicitation 等着人回答。
	"background_session_waiting_for_user_decision",
	// Claude 自报 idle，但读屏发现输入框里有没提交的内容，或输入框被外部编辑器（Ctrl+G）等盖住、读不到。
	"background_session_input_box_has_unsent_text_or_is_hidden",
	// Claude 报了一个不认识的 status。
	"background_session_activity_status_unrecognized",
	// `claude stop` 失败，或报成功后它仍占着这段对话。
	"background_session_did_not_release_after_stop",
]);
export type RuntimeHarnessBackgroundSessionReclaimBlockedReason = z.infer<
	typeof runtimeHarnessBackgroundSessionReclaimBlockedReasonSchema
>;

export const runtimeAgentNativeConversationHeldByHarnessBackgroundSessionObservationSchema = z.object({
	// `claude attach / stop / logs` 认的短 id。
	harnessBackgroundSessionShortId: z.string(),
	nativeSessionId: z.string(),
	reclaimBlockedReason: runtimeHarnessBackgroundSessionReclaimBlockedReasonSchema,
	// kanban 是否还在盯着它、等它能安全收回时自动接回。盯梢有时限，运行时重启后也不会自动恢复
	// （下次打开这张卡触发续跑时会重新武装）。
	automaticReclaimWatchActive: z.boolean(),
	observedAt: z.number(),
});
export type RuntimeAgentNativeConversationHeldByHarnessBackgroundSessionObservation = z.infer<
	typeof runtimeAgentNativeConversationHeldByHarnessBackgroundSessionObservationSchema
>;

// 终端 agent 启动时真正传出去的、与 fork 重放相关的 argv 三项（见
// terminal/agent-session-fork-replay-launch-arguments-capture.ts 的完整理由，含「逐字一致才命中 prompt
// cache」那条原立论被实测证伪的经过）。exploration thread graph 的维护作业 fork 主会话时逐字复用它们；
// 重算而非快照，拿到的是「当前代码算出来的值」而不是「这个会话实际在跑的值」。model 存的是 argv 字面值
// （通常是浮动别名 `default`），不是解析后的模型 id。
export const runtimeAgentSessionForkReplayLaunchArgumentsSchema = z.object({
	sourceAgentId: z.string(),
	modelArgumentLiteral: z.string().nullable(),
	appendSystemPromptText: z.string().nullable(),
	settingsFilePath: z.string().nullable(),
	capturedAt: z.number(),
});
export type RuntimeAgentSessionForkReplayLaunchArguments = z.infer<
	typeof runtimeAgentSessionForkReplayLaunchArgumentsSchema
>;

// 终端 agent 因瞬时连接错误（VPN 抖动等）停在空闲提示符时，
// 自动续跑框架（src/terminal/output-reactions）进入「连接重试」状态：
// 记录已尝试的续跑次数、首次出错时刻、最近一次注入时刻，以及下一次计划注入的时刻。
// 该状态在 agent 真正向前推进后被清除（字段回到 null）。
export const runtimeTaskConnectionRetrySchema = z.object({
	status: z.literal("retrying"),
	retryCount: z.number().int().nonnegative(),
	firstErrorAt: z.number(),
	lastAttemptAt: z.number().nullable(),
	nextAttemptAt: z.number().nullable(),
});
export type RuntimeTaskConnectionRetry = z.infer<typeof runtimeTaskConnectionRetrySchema>;

// 恢复一个落盘会话只负责重建上下文，绝不等价于开始新一轮生成。PTY agent 恢复期间用这条
// 加性 sidecar 把「恢复历史」与「用户显式继续」分开：只有 UserPromptSubmit / BeforeAgent 这类
// 货真价实的用户提交才能解除守卫。旧 sessions.json 缺字段时按 inactive 处理。
export const runtimeTaskSessionRestorationContinuationGuardStateSchema = z.enum([
	"inactive",
	"restoring_agent_conversation_without_starting_new_turn",
	"restored_agent_conversation_waiting_for_explicit_user_input",
]);
export type RuntimeTaskSessionRestorationContinuationGuardState = z.infer<
	typeof runtimeTaskSessionRestorationContinuationGuardStateSchema
>;

// 程序化投递（RVF followup / task-chat 发送）与人类抢同一个终端输入框时的**挂起可见性** sidecar。
//
// 存在的理由就是 2026-08-08 那 49 分钟：投递在等，而屏幕上什么都不说。让路本身是对的——绝不能把
// paste 插进人类打了一半的那一行——但「在等」必须看得见，否则等待与静默故障对用户完全同形。
//
// **派生 + 节流，绝不把输入框内容本身推上这条热广播链路**：只在真的有投递挂起时才计算并写入
// （最快也就投递重探的节拍，1.5s 一次），值不变则不写 —— 输入框每次击键都在变，把原始框状态推上
// 会话广播会把最热的那条链路直接压垮。
export const runtimeTaskTerminalDeliveryContentionSchema = z.object({
	// 此刻挂在这个会话上、正等输入框腾出来的程序化投递条数。单飞槽决定了它只会是 1（无投递挂起时
	// 整个 sidecar 为 null，而不是这里写 0）。保留计数形态是给「有几条在等」留位置，也让 UI 文案
	// 不必依赖「sidecar 存在即恰好一条」这个当前实现细节。
	pendingProgrammaticDeliveryCount: z.number().int().nonnegative(),
	// 挂起的原因：输入框里有人类尚未提交的内容（含「屏上有字但一个字节都没经过本运行时」那种存疑占用）。
	inputBoxHasUncommittedText: z.boolean(),
	// 这次挂起是否**不会**被自动抢占放行（人在场 / 策略关掉了自动抢占 / 框里有还原不了的粘贴）。
	// UI 据此决定措辞与是否摆出「暂存我的输入并放行」：为 true 时，用户不动手就真的只会等到预算耗尽、
	// 以 delivery_failed{human_terminal_contention_timeout} 收尾。
	waitingForHumanBecauseAutomaticPreemptionIsUnavailable: z.boolean(),
});
export type RuntimeTaskTerminalDeliveryContention = z.infer<typeof runtimeTaskTerminalDeliveryContentionSchema>;

// 主 agent 以「非 native」方式 dispatch 了一个后台任务（例：把 reviewer 计划作为独立 Kanban 任务发出），
// 并结束自己这一轮去等它完成时，由外部编排（RVF / 自研 Kanban）置上的「已 park、正在等待已派发后台工作」
// sidecar。present = parked：此刻主 agent 停在空闲提示符，但它**不是**在等用户审查，而是在等自己派发的后台
// 工作回灌结果、会被外部编排自行恢复（submitTaskChatInputWhenReady followup → UserPromptSubmit）。
//   - 仅内存态（与 connectionRetry 同，sessions.json 仅在 shutdown 落盘）：A 无 watcher、resume 在外部，
//     park 的唯一作用是让「主 agent 结束本轮那一刻同步读到的内存 summary」带上此标记，从而在单一 to_review
//     转换闸前置抑制误发的 ready-for-review 通知。崩溃前无进程即无 Stop，故无需崩溃持久化。
//   - 真相判据见 src/core/session-activity.ts 的 isParkedAwaitingDispatchedBackgroundWork（gate / UI / RVF /
//     session-manager 共用的唯一谓词）；置 / 清标经 TerminalSessionManager 的 park / unpark 走 updateSummary
//     metadata-only 漏斗，不携带 facet / state，故 {turnOwner:"agent", liveness:"live", userTurnKind:null} 三元组
//     与下方 superRefine 护栏从不被触碰（parked 主 agent 的真相就是普通 running 三元组）。
export const runtimeTaskAwaitingDispatchedBackgroundWorkSchema = z.object({
	// park 起始时刻（epoch ms）。用于 UI 展示与（自研 Kanban 继承时）潜在的 park 超时兜底。
	sinceMs: z.number(),
	// 可选的人类可读标签（例：被派发的子任务 id / 简述），仅用于 UI 与诊断。
	label: z.string().optional(),
	// park 兜底期限（epoch ms 绝对时刻）：到此刻仍未被 unpark ⇒ 走可审计的 park_abandoned 回收。
	// null = 调用方显式声明「无期限」（`kanban task park --no-expiry`，用于合法的超长后台工作）；
	// undefined = 未声明 ⇒ 由回收调度器套用默认上限。存绝对时刻而非时长，故 Kanban / OS 停机期间
	// 流逝的墙钟时间自然计入（与 agentSessionRuntimeReclamationEligibleAt 同口径）。
	maxRetentionUntilMs: z.number().nullable().optional(),
	// 最近一次 `kanban task park --renew` 心跳续期时刻（epoch ms）。仅用于 UI 与诊断，
	// 真正决定是否到期的是上面已被续期推进过的 maxRetentionUntilMs。
	lastRenewedAtMs: z.number().optional(),
});
export type RuntimeTaskAwaitingDispatchedBackgroundWork = z.infer<
	typeof runtimeTaskAwaitingDispatchedBackgroundWorkSchema
>;

// ── 会话「停止生成响应后固定宽限期」回收（加性 sidecar，与 connectionRetry / park 同侧）────────
// 设计与核验见 .plan/docs/cross-harness-agent-session-inactivity-grace-period-reclamation-and-
// pending-user-decision-carry-forward-implementation-plan.md。
//
// 铁律：以下字段全部是 metadata-only sidecar——不参与三 facet、不进 superRefine、不影响
// projectLegacyState。写入一律经两个 updateSummary 漏斗（cline-sdk/cline-session-state.ts、
// terminal/session-manager.ts），绝不手写 `state:`，也绝不裸写单个 facet 字段。

// 「agent 停止生成响应」这一**离散状态转移**的信号来源（置信度降序）。
// 刻意不从 lastOutputAt / lastSubstantiveOutputAt / updatedAt 任何既有时间戳反推——它们分别被
// spinner 重绘、实质分类器节流、任意元数据写推进，都不表达「这一轮已经结束」。
export const runtimeAgentResponseGenerationStopSignalConfidenceSchema = z.enum([
	// harness 明确宣告本轮结束：Claude `Stop` / Codex `agent-turn-complete`+rollout `task_complete` /
	// Gemini `AfterAgent` / droid·kiro `TaskComplete` / ACP `session/prompt` resolve / Cline SDK 回合结束。
	"harness_turn_complete",
	// facet 转移到 turnOwner==="user"（review / question / plan_review / permission / error /
	// interrupted / needs_input 皆算）——结构化的「球在人这边」，等价于 agent 不再生成。
	"structured_user_turn",
	// 会话已就绪但从未收到过任何用户提交（turnSequence === 0）⇒ 锚点 = 就绪时刻。
	// 这一条精确覆盖「空闲侧栏项目会话」，且不伪造任何「曾经输出过」的语义。
	"session_ready_never_prompted",
	// 最低置信度兜底：scanForStalls 的 idle_stall 自愈（停在交互提示符 + 实质静默 5 分钟）翻入
	// 人回合时顺带产生。harness 漏发 hook 时靠它兜底。
	"prompt_ready_fallback",
]);
export type RuntimeAgentResponseGenerationStopSignalConfidence = z.infer<
	typeof runtimeAgentResponseGenerationStopSignalConfidenceSchema
>;

export const runtimeAgentResponseGenerationStoppedSchema = z.object({
	// 进入非生成态的时刻（epoch ms）。宽限期从这里起算。
	stoppedAt: z.number(),
	signalConfidence: runtimeAgentResponseGenerationStopSignalConfidenceSchema,
	// 产生该停止事件时的回合序号快照。与 runtimeSessionIncarnationId 一起构成「陈旧定时器」防护的
	// 双重判据：回收触发时若二者与当前 summary 不一致，说明会话已经继续跑过，绝不回收。
	turnSequence: z.number().int().nonnegative(),
});
export type RuntimeAgentResponseGenerationStopped = z.infer<typeof runtimeAgentResponseGenerationStoppedSchema>;

// 「本轮 agent 回合何时开始生成」——runtimeAgentResponseGenerationStoppedSchema 的对偶边沿事件。
// 只在 facet 由非 agent 回合翻入 agent 回合（回合序号 +1）的那一次写入盖章；agent 回合内的元数据写
// （lastOutputAt bump、hook activity、connectionRetry 等）一律不动它。跨项目切换面板 Running 区
// 按它升序排（先进入的在前、后进入的在后），不读每秒被 spinner 推进的 lastOutputAt。
export const runtimeAgentResponseGenerationTurnStartedSchema = z.object({
	// 翻入 agent 回合的时刻（epoch ms，= 该次合并的 updatedAt）。
	startedAt: z.number(),
	// 盖章时的回合序号（即 +1 之后的新值），用于和 agentResponseGenerationStopped.turnSequence 对照。
	turnSequence: z.number().int().nonnegative(),
});
export type RuntimeAgentResponseGenerationTurnStarted = z.infer<typeof runtimeAgentResponseGenerationTurnStartedSchema>;

// 旧版「对话推进」字段只兼容读取；可信来源迁入统一活动，TUI 猜测不升级。
// 新写入只使用 runtimeLastEffectiveAgentConversationActivityObservationSchema。
export const runtimeLastConversationProgressEvidenceKindSchema = z.enum([
	// 最高置信：agent 自己落盘的转录里最后一条 agent 产出（Claude/Codex/Cursor 的 JSONL、Cline 消息账本）。
	// 唯一跨进程重启、跨会话重开仍成立的来源，故也是唯一被授权做 rebaseline 的证据。
	"persisted_agent_transcript",
	// 高置信：agent 自报的生命周期语义事件（Claude Stop / PostToolUse 等经 `kanban hooks` 投递）。
	// 低延迟但会丢投（见 ~/.cline/kanban/agent-hook-delivery-failures/），故只前进、不做权威纠偏。
	"agent_lifecycle_hook_event",
	// 高置信：结构化会话事件（Cline SDK assistant 消息 / ACP agent_message_chunk），无需刮 TUI。
	"structured_agent_session_event",
	// 低置信兜底：TUI 输出实质分类器（agent-output-substance.ts）。无转录、无 hook 的 agent 才落到这里；
	// 它正是历史上被会话重开重播骗到的那条路径，故 UI 以 `~` 标注。
	"terminal_output_heuristic_classification",
]);
export type RuntimeLastConversationProgressEvidenceKind = z.infer<
	typeof runtimeLastConversationProgressEvidenceKindSchema
>;

export const runtimeLastConversationProgressObservationSchema = z.object({
	// 对话上次推进的时刻（epoch ms）。
	observedAtMs: z.number(),
	evidenceKind: runtimeLastConversationProgressEvidenceKindSchema,
});
export type RuntimeLastConversationProgressObservation = z.infer<
	typeof runtimeLastConversationProgressObservationSchema
>;

// 旧请求代理证据枚举保留用于持久数据兼容和缓存专用投影。
// 前置提交 hook 不证明 harness 已接受，也不升级为统一活动。
export const runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema = z.enum([
	// 用户（或 harness 的任务通知）提交了一轮输入且未被恢复守卫拦截——harness 随即发首个请求。
	"user_prompt_submit_hook_event_accepted",
	// 主对话的工具调用执行完毕——harness 随即把工具结果发回模型。
	"post_tool_use_hook_event",
	"post_tool_use_failure_hook_event",
	// Gemini 的等价事件（BeforeAgent ≈ UserPromptSubmit，AfterTool ≈ PostToolUse）。
	"before_agent_hook_event",
	"after_tool_hook_event",
	// 用户回合里手动 /compact 完成（PostCompact，trigger=manual）。压缩请求读的是被替换前的旧对话前缀
	// （5 分钟档）、写入为 0；对话层随即被摘要替换，下一条请求不论早晚都要重写摘要部分（实测 86k–103k）。
	// Cache warm 估算对它的取舍见 resolveMainAgentConversationPromptCacheWarmthAnchor。
	"manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request",
	// agent 回合中自动压缩完成（PostCompact，trigger=auto）：续写请求紧随其后，与普通发请求同等对待。
	"automatic_context_compaction_completed_continuation_model_request_follows_immediately",
]);
export type RuntimeMainAgentConversationModelRequestDispatchEvidenceKind = z.infer<
	typeof runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema
>;

export const runtimeLastMainAgentConversationModelRequestDispatchObservationSchema = z.object({
	// 发出请求的时刻（epoch ms，取 hook ingest 时刻）。
	observedAtMs: z.number(),
	evidenceKind: runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema,
	// 仅手动压缩完成、且 harness 自己报了压缩后上下文大小时携带（目前只有 Kimi PostCompact 的
	// estimatedTokenCount）。Cache warm 行据此显示「回复需重写约 N k」。Claude / Codex 的 PostCompact 不报大小，
	// 而按摘要长度或 transcript 内容估算与实测重写量相差 3–10 倍（2026-10-05 实测），故宁缺不估。
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness: z.number().int().nonnegative().optional(),
});
export type RuntimeLastMainAgentConversationModelRequestDispatchObservation = z.infer<
	typeof runtimeLastMainAgentConversationModelRequestDispatchObservationSchema
>;

// 有效活动记录的是原始事件发生时间与语义证据；进程重开和 PTY 重绘不能产生新活动。
export const runtimeEffectiveAgentConversationActivityEvidenceKindSchema = z.enum([
	"persisted_agent_transcript",
	"agent_lifecycle_hook_event",
	"structured_agent_session_event",
	"terminal_output_heuristic_classification",
	"native_user_prompt_acceptance",
]);
export type RuntimeEffectiveAgentConversationActivityEvidenceKind = z.infer<
	typeof runtimeEffectiveAgentConversationActivityEvidenceKindSchema
>;
export const runtimeEffectiveAgentConversationActivityKindSchema = z.enum([
	"accepted_user_input",
	"agent_output",
	"tool_activity",
	"context_compaction",
	"model_request_dispatch",
	"agent_turn_boundary",
]);
export type RuntimeEffectiveAgentConversationActivityKind = z.infer<
	typeof runtimeEffectiveAgentConversationActivityKindSchema
>;
export const runtimeLastEffectiveAgentConversationActivityObservationSchema = z.object({
	observedAtMs: z.number(),
	evidenceKind: runtimeEffectiveAgentConversationActivityEvidenceKindSchema,
	activityKind: runtimeEffectiveAgentConversationActivityKindSchema,
	eventId: z.string().min(1).optional(),
	nativeSessionId: z.string().min(1).optional(),
});
export type RuntimeLastEffectiveAgentConversationActivityObservation = z.infer<
	typeof runtimeLastEffectiveAgentConversationActivityObservationSchema
>;

// 历史交棒跨 incarnation 保留；启动就绪和恢复进程不是交棒。
export const runtimeLastAgentConversationUserHandoffObservationSchema = z.object({
	observedAtMs: z.number(),
	signalConfidence: z.enum(["harness_turn_complete", "structured_user_turn", "prompt_ready_fallback"]),
	turnSequence: z.number().int().nonnegative(),
});
export type RuntimeLastAgentConversationUserHandoffObservation = z.infer<
	typeof runtimeLastAgentConversationUserHandoffObservationSchema
>;

// 当前进程的待命期限锚点沿用旧停止事件形状；它与用户看到的历史交棒完全独立。
export const runtimeCurrentAgentProcessUserTurnIdleRetentionStartedSchema = runtimeAgentResponseGenerationStoppedSchema;
export type RuntimeCurrentAgentProcessUserTurnIdleRetentionStarted = z.infer<
	typeof runtimeCurrentAgentProcessUserTurnIdleRetentionStartedSchema
>;
export const runtimeLastAgentConversationPromptCacheReferenceObservationSchema =
	runtimeLastMainAgentConversationModelRequestDispatchObservationSchema.extend({
		evidenceKind: z.union([
			runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema,
			z.literal("cursor_agent_output_cache_reference_estimate"),
			// 已有真实主 Agent 处理/响应，时间仍是请求的代理估计，不声称 provider 创建了缓存。
			z.literal("main_agent_conversation_request_processing_cache_reference_estimate"),
		]),
	});
export type RuntimeLastAgentConversationPromptCacheReferenceObservation = z.infer<
	typeof runtimeLastAgentConversationPromptCacheReferenceObservationSchema
>;

// pending/unconfirmed 只表达投递核验进度，不能代替 harness 已接受这一事实。
export const runtimeAgentConversationPromptSubmissionAcceptanceSchema = z.object({
	status: z.enum(["pending", "unconfirmed", "accepted"]),
	attemptedAtMs: z.number(),
	confirmedAtMs: z.number().optional(),
	eventId: z.string().min(1).optional(),
	nativeSessionId: z.string().min(1).optional(),
	runtimeSessionIncarnationId: z.string().min(1),
});
export type RuntimeAgentConversationPromptSubmissionAcceptance = z.infer<
	typeof runtimeAgentConversationPromptSubmissionAcceptanceSchema
>;

export const runtimeTaskConversationSessionActivityObservationSchema = z.object({
	sessionId: z.string(),
	role: z.enum(["main", "task_collaborator", "by_the_way", "former_main"]),
	agentId: runtimeAgentIdSchema.nullable(),
	lastEffectiveAgentConversationActivityObservation:
		runtimeLastEffectiveAgentConversationActivityObservationSchema.nullable(),
});
export type RuntimeTaskConversationSessionActivityObservation = z.infer<
	typeof runtimeTaskConversationSessionActivityObservationSchema
>;

// 一次回收尝试的**可审计**结果。三种 transport 共用同一形状，故「回收到底做成了没有」在 UI /
// 日志 / 测试里是同一套判据，而不是各 transport 各说各话。
export const runtimeAgentSessionReclamationOutcomeSchema = z.object({
	runtimeSessionIncarnationId: z.string(),
	sessionTransport: runtimeAgentSessionTransportSchema,
	// 触发本次回收的原因：宽限期到期 vs park 兜底期到期。二者的用户可见措辞不同。
	reclamationTrigger: z.enum(["response_generation_grace_period_expired", "park_abandoned"]),
	attemptedAt: z.number(),
	completedAt: z.number().nullable(),
	// pty_terminal / acp_stdio_subprocess：根进程确实已退出（kill(pid,0) 报 ESRCH）。
	// in_process_cline_sdk 无 OS 进程，语义收窄为「SDK 会话已 stop 且 task MCP bundle 已释放」，
	// 故读这个字段时**必须**同时读 sessionTransport，勿把它当成「有个进程死了」。
	rootProcessExitConfirmed: z.boolean(),
	descendantProcessesExitConfirmed: z.boolean(),
	// 回收后复核仍存活的后代 pid（仅用于存活性判定与诊断，**绝不**据此对 RSS 求和——
	// 现场观测到过 6.7 GiB 的临时 ugrep 子进程，求和口径会把它算成「会话内存」）。
	survivingDescendantPids: z.array(z.number().int()),
	usedForcefulEscalation: z.boolean(),
	// 已释放的资源标签（"pty" / "terminal_state_mirror" / "cline_mcp_tool_bundle" / "acp_connection" …）。
	releasedResources: z.array(z.string()),
	failureReason: z.string().nullable(),
	nextRetryAt: z.number().nullable(),
});
export type RuntimeAgentSessionReclamationOutcome = z.infer<typeof runtimeAgentSessionReclamationOutcomeSchema>;

// 阶段目标独立于整个 Task 名称；原生候选与显式声明分开，clear 后可回退原生候选。
export const runtimeAgentCurrentWorkPhaseGoalSchema = z.object({
	goalText: z.string().trim().min(1).max(160),
	source: z.enum(["agent_explicit_declaration", "claude_native_task_list", "acp_structured_plan"]),
	updatedAt: z.number(),
	owningKanbanTaskConversationSessionId: z.string().min(1),
	owningNativeConversationSessionId: z.string().min(1).nullable(),
	owningRuntimeSessionIncarnationId: z.string().nullable().optional(),
});
export type RuntimeAgentCurrentWorkPhaseGoal = z.infer<typeof runtimeAgentCurrentWorkPhaseGoalSchema>;
export const runtimeSetCurrentWorkPhaseGoalRequestSchema = z
	.object({ goal: z.string().trim().min(1).max(160).nullable() })
	.strict();
export type RuntimeSetCurrentWorkPhaseGoalRequest = z.infer<typeof runtimeSetCurrentWorkPhaseGoalRequestSchema>;

const runtimeTaskSessionSummaryObjectSchema = z.object({
	lastEffectiveAgentConversationActivityObservation: runtimeLastEffectiveAgentConversationActivityObservationSchema
		.nullable()
		.optional(),
	lastAgentConversationUserHandoffObservation: runtimeLastAgentConversationUserHandoffObservationSchema
		.nullable()
		.optional(),
	currentAgentProcessUserTurnIdleRetentionStarted: runtimeCurrentAgentProcessUserTurnIdleRetentionStartedSchema
		.nullable()
		.optional(),
	lastAgentConversationPromptCacheReferenceObservation:
		runtimeLastAgentConversationPromptCacheReferenceObservationSchema.nullable().optional(),
	agentConversationPromptSubmissionAcceptance: runtimeAgentConversationPromptSubmissionAcceptanceSchema
		.nullable()
		.optional(),

	taskId: z.string(),
	// Stage 4 全写侧反转：`state` 降为派生投影 → 输入可选（facet-only 写不带 state）；末位 .transform
	// 从 facet 投影回 state，使输出型 state 仍为 required（消费者类型不破，见下方 transform）。
	state: runtimeTaskSessionStateSchema.optional(),
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	// 旧字段只兼容读取；它们不能用来判定新的有效活动。
	lastSubstantiveOutputAt: z.number().nullable().optional(),
	lastConversationProgressObservation: runtimeLastConversationProgressObservationSchema.nullable().optional(),
	agentCurrentWorkPhaseGoal: runtimeAgentCurrentWorkPhaseGoalSchema.nullable().optional(),
	agentNativeCurrentWorkPhaseGoal: runtimeAgentCurrentWorkPhaseGoalSchema.nullable().optional(),
	agentCurrentWorkPhaseGoalInvalidatedAt: z.number().optional(),
	// 旧请求代理仅兼容读；新缓存投影使用 lastAgentConversationPromptCacheReferenceObservation。
	lastMainAgentConversationModelRequestDispatchObservation:
		runtimeLastMainAgentConversationModelRequestDispatchObservationSchema.nullable().optional(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	connectionRetry: runtimeTaskConnectionRetrySchema.nullable().optional(),
	restorationContinuationGuardState: runtimeTaskSessionRestorationContinuationGuardStateSchema.optional(),
	// 程序化投递被人类输入框占用而挂起时的可见性 sidecar（加性、nullable + optional，仅内存态）。
	// present = 此刻确实有投递在等这个终端的输入框；null = 没有任何投递在等（绝大多数时刻）。
	terminalDeliveryContention: runtimeTaskTerminalDeliveryContentionSchema.nullable().optional(),
	// 「已 park、正在等待已派发后台工作」sidecar（加性、nullable + optional，仅内存态、随 connectionRetry 同侧）。
	// present = parked；判据 / 时序见 runtimeTaskAwaitingDispatchedBackgroundWorkSchema 与 session-activity.ts
	// 的 isParkedAwaitingDispatchedBackgroundWork。不参与 facet / superRefine（与 connectionRetry-only 写同形）。
	awaitingDispatchedBackgroundWork: runtimeTaskAwaitingDispatchedBackgroundWorkSchema.nullable().optional(),
	// 「停止生成后固定宽限期」回收的四个加性 sidecar（不参与 facet / superRefine，见上方 schema 注释）。
	// 每次真实 spawn / ACP 连接 / SDK 会话创建生成一个新 id：它是「这一条 summary 说的还是同一个活体」的
	// 唯一判据，防止陈旧回收定时器杀掉重启后的新会话。
	runtimeSessionIncarnationId: z.string().nullable().optional(),
	// 每次用户提交 / 新 agent 回合单调 +1。与 incarnationId 正交：同一活体内多轮对话靠它区分，
	// 于是「宽限期跑到一半用户又发了一句」也能被回收侧检出并放弃。
	agentResponseGenerationTurnSequence: z.number().int().nonnegative().optional(),
	// 旧停止字段只兼容读为进程待命锚点；不能直接升级为历史真实交棒。
	agentResponseGenerationStopped: runtimeAgentResponseGenerationStoppedSchema.nullable().optional(),
	// 最近一次「翻入 agent 回合」的边沿事件（与上一字段对偶，语义见其 schema 注释）。离开 agent 回合后
	// 保留原值不清空；加性可选：旧盘数据 / 从未进过 agent 回合的会话缺它 ⇒ Running 排序回落到 startedAt。
	agentResponseGenerationTurnStarted: runtimeAgentResponseGenerationTurnStartedSchema.nullable().optional(),
	// 可回收时刻（epoch ms 绝对时刻，= stoppedAt + 宽限期）。存绝对时刻而非剩余时长，故停机期间
	// 流逝的墙钟时间自然计入，重启后按同一口径判定。
	agentSessionRuntimeReclamationEligibleAt: z.number().nullable().optional(),
	// 最近一次回收尝试的可审计结果（成功 / 失败皆记）。UI 的「会话已被回收」标注读它——用户重进
	// 任务时必须看到明确说明，而不是一个空终端让人误以为只是加载慢。
	agentSessionRuntimeReclamationOutcome: runtimeAgentSessionReclamationOutcomeSchema.nullable().optional(),
	taskConversationSessionMetadata: runtimeTaskConversationSessionMetadataSchema.optional(),
	// 终端 agent 的原生会话身份（N0a，见 runtimeAgentNativeConversationSessionIdentitySchema 注释）。
	// 加性可选：Cline / ACP 会话与旧盘数据缺它 ⇒ undefined；同一活体内 harness 换了 session id
	// （--fork-session / 续接）时整体替换，只保留最新观测。
	agentNativeConversationSessionIdentity: runtimeAgentNativeConversationSessionIdentitySchema.nullable().optional(),
	// 会话进程的存储归属；缺省的旧记录按原生转录路径回填，不能按新增会话的默认值解释。
	codexConversationStorageHomeDirectoryPath: z.string().trim().min(1).optional(),
	// 「对话有没有真的落进 agent 自己的会话存储」观测（见 runtimeAgentNativeConversationPersistenceObservationSchema）。
	// 每次真实 spawn 清为 null，由看门狗 / 退出核对 / 续跑预检 / hydrate 回填写入。
	agentNativeConversationPersistenceObservation: runtimeAgentNativeConversationPersistenceObservationSchema
		.nullable()
		.optional(),
	// 「要续跑的对话正被 harness 后台会话占着、不能安全收回」观测（见同名 schema 注释）。续跑被拒时写入，
	// 每次真实 spawn 清为 null。
	agentNativeConversationHeldByHarnessBackgroundSessionObservation:
		runtimeAgentNativeConversationHeldByHarnessBackgroundSessionObservationSchema.nullable().optional(),
	// 本次启动 argv 的 fork 重放快照（见 runtimeAgentSessionForkReplayLaunchArgumentsSchema 注释）。
	// 加性可选：只有已接入的终端 agent（v1 = claude）在建会话时盖章，其余会话与旧盘数据缺它 ⇒ undefined。
	// 每次新起活体整体替换（同一任务换 agent / 换模型后，旧快照对新会话无意义）。
	agentSessionForkReplayLaunchArguments: runtimeAgentSessionForkReplayLaunchArgumentsSchema.nullable().optional(),
	// 本代 Codex TUI 独享的原生活动分支控制面；随 summary/adoption record 持久化，换代整体替换。
	codexNativeSessionControlEndpoint: codexNativeSessionControlEndpointSchema.nullable().optional(),
	// 这条**活会话**实际用的通话方式。agent-catalog 的 `sessionTransport` 只是该 agent 的**默认**通道；
	// omp 可在 TUI（pty_terminal）与 ACP（acp_stdio_subprocess）之间随时切换，切换后 agentId 不变，
	// 于是「渲染 xterm 还是会话面板」「stop / 输入 / 消息走哪条通路」一律以本字段为准，不得再从 agentId 静态派生。
	// 由三条通道各自在建会话时盖章（terminal / cline-sdk / acp），是纯运行期事实、不参与 facet 与 superRefine。
	// 加性可选：旧盘数据 / web-ui 手构造 summary 缺它 ⇒ 回退按 agentId 派生（见 agent-catalog 的
	// resolveRuntimeAgentSessionTransportFromSummary，读点一律走它而非直接读本字段）。
	sessionTransport: runtimeAgentSessionTransportSchema.optional(),
	// 这条**活会话**启动时从卡片快照下来的会话模式（探索/操作，蓝图 §A.1 挂载点 2）。纯运行期事实、
	// 不参与 facet 与 superRefine，免费搭乘 task_sessions_updated 广播。漂移：活会话不热切换——会话
	// 存续期卡片改模式不回写本投影，UI 对「卡片新模式 ≠ 会话投影」只显示不强刷。
	// 加性可选：旧盘数据缺它 ⇒ 按 operational 呈现。
	taskConversationMode: runtimeTaskConversationModeSchema.optional(),
	// 双轴 facet（加性、可选）+ per-session schema 版本。三 facet 共生（要么全置、要么全缺）：
	// 全缺=未迁移的旧盘数据（Stage 2 读时回填）；全置=经 applySessionFacets 漏斗写入、组合受
	// 下方 superRefine 护栏约束。schemaVersion 为 per-session 可选字段（不引入文件级包裹、无 flag day）。
	turnOwner: runtimeTaskSessionTurnOwnerSchema.optional(),
	liveness: runtimeTaskSessionLivenessSchema.optional(),
	userTurnKind: runtimeTaskSessionUserTurnKindSchema.optional(),
	schemaVersion: z.number().int().nonnegative().optional(),
});

// 不变量护栏：facet 一旦出现即必须三者共生且组合合法（projectLegacyState 才能全函数、可逆）。
// 旧盘数据（三 facet 全 undefined）直接放行，留给 Stage 2 读时回填。这是双轴「合法组合不由类型
// 强制」的运行时补偿——与 applySessionFacets 单一构造、projectLegacyState 唯一 reducer 共同收敛。
// 护栏直接挂在 canonical schema 上，故持久化加载 / 保存请求 / 广播 / tRPC 响应所有校验边界自动硬化。
const LIVENESS_FOR_AGENT_TURN: readonly RuntimeTaskSessionLiveness[] = ["starting", "live", "retrying"];
const LIVENESS_FOR_USER_TURN: readonly RuntimeTaskSessionLiveness[] = ["live", "exited", "failed", "interrupted"];
export const runtimeTaskSessionSummarySchema = runtimeTaskSessionSummaryObjectSchema
	.superRefine((summary, ctx) => {
		const allFacetsPresent =
			summary.turnOwner !== undefined && summary.liveness !== undefined && summary.userTurnKind !== undefined;
		// Stage 4 反转护栏：`state` 缺失（facet-only 写）时三 facet 必须全置——否则末位 transform 无从
		// 投影出 legacy state。旧盘数据恒带 state、新写恒带完整 facet，故二者皆放行；唯「既无 state、
		// facet 又不全」的畸形 summary 被拒。
		if (summary.state === undefined && !allFacetsPresent) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "state 缺失（facet 写时主真相源）时 turnOwner + liveness + userTurnKind 必须三者全置",
			});
			return;
		}
		const anyFacetPresent =
			summary.turnOwner !== undefined || summary.liveness !== undefined || summary.userTurnKind !== undefined;
		if (!anyFacetPresent) {
			return; // 未迁移旧盘数据：无 facet，跳过组合校验
		}
		if (summary.turnOwner === undefined || summary.liveness === undefined || summary.userTurnKind === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "会话 facet 必须三者共生（turnOwner + liveness + userTurnKind 要么全置、要么全缺）",
			});
			return;
		}
		if (summary.turnOwner === null) {
			if (summary.liveness !== "none") {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: "turnOwner=null（无回合）时 liveness 必须为 none" });
			}
			if (summary.userTurnKind !== null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "turnOwner=null（无回合）时 userTurnKind 必须为 null",
				});
			}
			return;
		}
		if (summary.turnOwner === "agent") {
			if (summary.userTurnKind !== null) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "turnOwner=agent（agent 回合）时 userTurnKind 必须为 null",
				});
			}
			if (!LIVENESS_FOR_AGENT_TURN.includes(summary.liveness)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `turnOwner=agent 的 liveness 必须 ∈ {${LIVENESS_FOR_AGENT_TURN.join(", ")}}`,
				});
			}
			return;
		}
		// turnOwner === "user"
		if (summary.userTurnKind === null) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "turnOwner=user（等人）时 userTurnKind 不可为 null" });
		}
		if (!LIVENESS_FOR_USER_TURN.includes(summary.liveness)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `turnOwner=user 的 liveness 必须 ∈ {${LIVENESS_FOR_USER_TURN.join(", ")}}`,
			});
		}
	})
	.transform((summary) => {
		// state 缺（facet 写时主真相源、facet-only 写）→ 从三 facet 投影回 legacy state；已带 state
		// （旧盘数据 / state 权威写）→ 原样保留。恒返回 state 恒赋值的单一对象字面量（勿条件 spread），
		// 故 z.infer 输出型 `state` 仍为 required——消费者类型不破。
		const state =
			summary.state ??
			projectLegacyState({
				turnOwner: summary.turnOwner ?? null,
				liveness: summary.liveness ?? "none",
				userTurnKind: summary.userTurnKind ?? null,
			});
		return { ...summary, state };
	});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
	// dd2db Y-EVENT-8：本次整板保存里每张卡每个变更的发起方（用户手势 / 浏览器端自动流转）。只进关系账本，不落 board。
	boardMutationInitiatorAnnotationsForTaskMutationEventCapture: z
		.array(webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema)
		.optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

// Targeted "append one backlog task to this workspace" request. The client is already
// scoped to the destination workspace (via the x-kanban-workspace-id header), so the
// server resolves baseRef itself and only needs the task's user-facing fields. Reuses
// the same core mutation pipeline as `kanban task create` (mutateWorkspaceState +
// addTaskToColumn). Used by the bug-report FAB to file a bug straight onto the
// cline-kanban developer board.
export const runtimeAddBacklogTaskRequestSchema = z.object({
	prompt: z.string(),
	title: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
});
export type RuntimeAddBacklogTaskRequest = z.infer<typeof runtimeAddBacklogTaskRequestSchema>;

// 建卡时按任务描述起名。请求只带描述：起名不需要工作区上下文，也刻意不带图片
// （官方另有支持图像输入的型号，本条链路不走那条）。
export const runtimeTaskNameSuggestionRequestSchema = z.object({
	taskDescription: z.string(),
});
export type RuntimeTaskNameSuggestionRequest = z.infer<typeof runtimeTaskNameSuggestionRequestSchema>;

// 「拿不到名字」是**正常返回**而不是错误：这条能力天生可缺席（没配密钥的机器上就是没有），
// 把它做成 TRPC 错误会逼前端在 catch 里区分「真故障」与「本来就没配」。
export const runtimeTaskNameSuggestionUnavailableReasonSchema = z.enum([
	"api_key_not_configured",
	"task_description_empty",
	"request_failed",
]);
export type RuntimeTaskNameSuggestionUnavailableReason = z.infer<
	typeof runtimeTaskNameSuggestionUnavailableReasonSchema
>;

export const runtimeTaskNameSuggestionResponseSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("suggested"),
		suggestedTaskNames: z.array(z.string()).min(1).max(5),
	}),
	z.object({
		status: z.literal("unavailable"),
		unavailableReason: runtimeTaskNameSuggestionUnavailableReasonSchema,
		// 供界面直接显示的一句话（HTTP 状态码、超时之类）。没有额外可说的就省略。
		unavailableDetail: z.string().optional(),
	}),
]);
export type RuntimeTaskNameSuggestionResponse = z.infer<typeof runtimeTaskNameSuggestionResponseSchema>;

export const runtimeAddBacklogTaskResponseSchema = z.object({
	taskId: z.string(),
});
export type RuntimeAddBacklogTaskResponse = z.infer<typeof runtimeAddBacklogTaskResponseSchema>;

// cf427：Web UI 建卡后立刻让 runtime 在 board 锁内把新卡写进**最新**盘上 board（不走整板 CAS），
// 浏览器拿到确认后才放行 agent 启动。此前新卡只活在浏览器内存里等 120ms 防抖的整板保存，期间任何
// revision 变化引起的整板重水合都会把它抹掉，而照常启动的 agent 就成了没有卡片的孤儿会话。
// 卡片由浏览器组好（id 来自 runtime 预取的分配池）；同 id 的卡已在盘上时幂等跳过，供重试与「整板保存先到」两种情况。
export const runtimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequestSchema = z.object({
	// 按浏览器本地 backlog 列里自上而下的顺序；runtime 把其中尚未落盘的卡整块插到 backlog 顶部。
	newBacklogTaskCardsCreatedFromWebUi: z.array(runtimeBoardCardSchema).min(1),
	boardMutationInitiatorOfNewBacklogTaskCards: webUiBoardMutationInitiatorSchema,
});
export type RuntimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequest = z.infer<
	typeof runtimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequestSchema
>;

// ---------------------------------------------------------------------------------------------
// dd2db 1a.2b：`kanban task create` 经 `workspace.applyKanbanCliTaskBoardMutation` 这一条 runtime procedure 落盘
// （§R3 Y-EVENT-1/2/7）。为什么：工作单元间关系账本只由 runtime 写；CLI 进程直接写盘的变更只能在事后按
// board diff 检出，行动者恒为未解析。改走 runtime 后，每次写入都带「意图 + 按 CLI 行动者声明头解析出的行动者」
// 进入持久化漏斗。runtime 不可达时 CLI 直接失败（fail closed），绝不回退到直接写盘。
// update / start / done / delete 已收编进 `taskCardAction.*`（见下一节），这里只剩建卡一种。
// ---------------------------------------------------------------------------------------------

// CLI 已在本进程解析完 effective settings（含 --expect-resolved-settings-fingerprint 校验）之后的建卡字段。
// task id 由 runtime 在 board 锁内分配。
export const runtimeKanbanCliBacklogTaskCardFieldValuesResolvedByKanbanCliSchema = z.object({
	title: z.string().optional(),
	prompt: z.string(),
	startInPlanMode: z.boolean(),
	taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema,
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	agentId: runtimeAgentIdSchema.optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
	taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.optional(),
	baseRef: z.string(),
	parentSessionId: z.string().optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
	prepFilePath: z.string().optional(),
	// 建卡时固化会话通道的两个判据值，取自 CLI 本进程加载的 runtime config（与 effective settings 同一份），
	// 保证预览指纹与真实建卡看到的是同一组默认值。
	ompAgentSessionTransportForNewTasks: runtimeAgentSessionTransportSchema,
	workspaceDefaultAgentIdForNewTasks: runtimeAgentIdSchema,
});
export type RuntimeKanbanCliBacklogTaskCardFieldValuesResolvedByKanbanCli = z.infer<
	typeof runtimeKanbanCliBacklogTaskCardFieldValuesResolvedByKanbanCliSchema
>;

// 仍保留判别联合的外形（哪怕只剩一种）：CLI 请求体与响应体的 JSON 形状不变。
export const runtimeKanbanCliTaskBoardMutationRequestSchema = z.discriminatedUnion("kanbanCliTaskBoardMutationKind", [
	z.object({
		kanbanCliTaskBoardMutationKind: z.literal("create_backlog_task_card"),
		backlogTaskCardFieldValuesResolvedByKanbanCli:
			runtimeKanbanCliBacklogTaskCardFieldValuesResolvedByKanbanCliSchema,
	}),
]);
export type RuntimeKanbanCliTaskBoardMutationRequest = z.infer<typeof runtimeKanbanCliTaskBoardMutationRequestSchema>;
export type RuntimeKanbanCliTaskBoardMutationKind =
	RuntimeKanbanCliTaskBoardMutationRequest["kanbanCliTaskBoardMutationKind"];

export const runtimeKanbanCliTaskBoardMutationResponseSchema = z.discriminatedUnion("kanbanCliTaskBoardMutationKind", [
	z.object({
		kanbanCliTaskBoardMutationKind: z.literal("create_backlog_task_card"),
		createdBacklogTaskCard: runtimeBoardCardSchema,
	}),
]);
export type RuntimeKanbanCliTaskBoardMutationResponse = z.infer<typeof runtimeKanbanCliTaskBoardMutationResponseSchema>;

// ---------------------------------------------------------------------------------------------
// `taskCardAction.*`：看板卡片 per-card 动作的**唯一**服务端实现（实现在 src/trpc/task-card-action-api.ts）。
// 主看板、Focus View、跨项目切换面板与 kanban CLI 都调这里——浏览器不再「改内存 board → 整板 saveState」，
// CLI 也不再在自己进程里编排停会话 / 删 worktree / 清草稿。所有 procedure 都是 workspace-scoped：
// 作用于 `x-kanban-workspace-id` 指向的**任意**已注册项目，这是「跨项目执行动作而不切换当前项目」的基础。
//
// 错误语义（全部 procedure 一致）：
//   - 卡片不在该项目 board 上 → TRPCError NOT_FOUND，文案 `Task "<id>" was not found in workspace <path>.`
//     （与迁移前 CLI 逐字一致，脚本可能在匹配它）；只读的 readTaskCardWithBoardColumn 例外，回传「不存在」结果；
//   - 卡片当前所在列不允许该动作 → TRPCError PRECONDITION_FAILED（卡片在请求途中被别处挪走时也是它）；
//   - 输入组合非法（空 prompt、切 agent 却不给会话 id 等）→ TRPCError BAD_REQUEST；
//   - 会话 / worktree 这类**执行期**失败不抛错，回传在响应的 outcome 字段里，并带上动作之后卡片的真实位置。
// ---------------------------------------------------------------------------------------------

// 浏览器声明的这次动作的发起方（用户手势 / PDV 面板完成 / 浏览器端自动流转…，词表同 saveState 的逐卡标注）。
// 只在请求带已校验的页面 nonce 时被采信：runtime 把它合成为该卡全部 board 变更的发起方标注，账本据此记成
// 「用户手势」或「浏览器端自动流转」而不是「缺标注」。带 CLI 声明头的请求一律忽略它（CLI 永远不记为用户）。
// 不传 = 说不清，账本如实记缺标注。
const runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema = webUiBoardMutationInitiatorSchema.optional();

// 浏览器按终端面板几何估出的 agent PTY 尺寸（与 runtimeTaskSessionStartRequestSchema 的 cols / rows 同义）。
export const runtimeAgentTerminalGeometryForTaskSessionSpawnSchema = z.object({
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
});
export type RuntimeAgentTerminalGeometryForTaskSessionSpawn = z.infer<
	typeof runtimeAgentTerminalGeometryForTaskSessionSpawnSchema
>;

// 动作之后（或只读查询那一刻）卡片的完整快照：卡片本体、所在列、两份会话摘要。
// 两份摘要分开给：盘上那份是 board 锁内读到的 sessions.json（CLI 的 JSON 输出一直用它）；活的那份是 runtime 内存里
// 三种 transport 合并后的当前摘要（未加载过该项目的终端管理器时为 null）。浏览器取「活的 ?? 盘上的」。
export const runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema = z.object({
	workspaceId: z.string().optional(),
	taskCard: runtimeBoardCardSchema,
	boardColumnIdContainingTaskCard: runtimeBoardColumnIdSchema,
	taskSessionSummaryLiveInRuntimeProcessMemory: runtimeTaskSessionSummarySchema.nullable(),
	taskSessionSummaryPersistedInWorkspaceSessionsFile: runtimeTaskSessionSummarySchema.nullable(),
});
export type RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries = z.infer<
	typeof runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema
>;

export const runtimeTaskWorktreeDeletionResultOfTaskCardActionSchema = z.object({
	taskWorktreeWasRemoved: z.boolean(),
	// 删 worktree 失败不让动作失败（卡片已经移成 / 删成），如实带回原因。
	taskWorktreeDeletionErrorMessage: z.string().nullable(),
});
export type RuntimeTaskWorktreeDeletionResultOfTaskCardAction = z.infer<
	typeof runtimeTaskWorktreeDeletionResultOfTaskCardActionSchema
>;

export const runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema = z.object({
	operationId: z.string().uuid(),
	taskId: z.string().min(1),
	taskIncarnationCreatedAtEpochMs: z.number(),
	targetWorkspaceId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
	targetBaseRef: z.string().min(1),
});
export const runtimeTaskCardActionTransferBacklogTaskToProjectResponseSchema = z.object({
	operationId: z.string().uuid(),
	workspaceId: z.string(),
	taskId: z.string(),
});

// --- readTaskCardWithBoardColumn（query，只读）---
// 供浏览器在**非当前项目**上打开编辑器、看原始 prompt、展开跨项目行。
export const runtimeTaskCardActionReadTaskCardWithBoardColumnRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
});
export type RuntimeTaskCardActionReadTaskCardWithBoardColumnRequest = z.infer<
	typeof runtimeTaskCardActionReadTaskCardWithBoardColumnRequestSchema
>;
export const runtimeTaskCardActionReadTaskCardWithBoardColumnResponseSchema = z.discriminatedUnion(
	"taskCardLookupOutcome",
	[
		z.object({
			taskCardLookupOutcome: z.literal("task_card_found_on_workspace_board"),
			taskCardSnapshot: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
		}),
		z.object({
			taskCardLookupOutcome: z.literal("task_card_not_found_on_workspace_board"),
			lookedUpTaskId: z.string(),
		}),
	],
);
export type RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse = z.infer<
	typeof runtimeTaskCardActionReadTaskCardWithBoardColumnResponseSchema
>;

// --- startTaskCardAgentSessionMovingItIntoInProgress ---
// 只允许 backlog / in_progress 的卡。先移列到 in_progress、再 ensure worktree、再启动会话（与浏览器一致，也守住
// 「backlog 单向」：启动失败后卡留在 in_progress，让会话状态与错误保持可见）。会话已在 agent 回合时不重复启动。
export const runtimeTaskCardActionStartAgentSessionRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
	agentTerminalGeometryForTaskSessionSpawn: runtimeAgentTerminalGeometryForTaskSessionSpawnSchema.optional(),
	// 拖放进 in_progress 的落点；缺省 = 列顶。卡片本来就在 in_progress 时忽略。
	insertAtIndexWithinInProgressBoardColumn: z.number().int().nonnegative().optional(),
});
export type RuntimeTaskCardActionStartAgentSessionRequest = z.infer<
	typeof runtimeTaskCardActionStartAgentSessionRequestSchema
>;
export const runtimeTaskCardAgentSessionStartOutcomeSchema = z.enum([
	"agent_session_started",
	// 会话已在 agent 回合（turnOwner === "agent"）：不重复启动，视为成功。
	"agent_session_already_in_agent_turn_so_start_was_skipped",
	// 下面两种失败时卡片**留在** in_progress（不回滚到 backlog），失败原文在 agentSessionStartFailureMessage。
	"task_worktree_ensure_failed",
	"agent_session_start_failed",
]);
export type RuntimeTaskCardAgentSessionStartOutcome = z.infer<typeof runtimeTaskCardAgentSessionStartOutcomeSchema>;
export const runtimeTaskCardActionStartAgentSessionResponseSchema = z.object({
	boardColumnIdOfTaskCardBeforeAction: runtimeBoardColumnIdSchema,
	// false = 卡片本来就在 in_progress，这次没有移列。
	taskCardWasMovedIntoInProgressColumnByThisAction: z.boolean(),
	agentSessionStartOutcome: runtimeTaskCardAgentSessionStartOutcomeSchema,
	agentSessionStartFailureMessage: z.string().nullable(),
	// ensureWorktree 成功但带提示（例如 ignored path 同步不完整）时的原文；浏览器照旧弹 warning toast。
	ensuredTaskWorktreeWarningMessage: z.string().nullable(),
	startedAgentSessionSummary: runtimeTaskSessionSummarySchema.nullable(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionStartAgentSessionResponse = z.infer<
	typeof runtimeTaskCardActionStartAgentSessionResponseSchema
>;

// --- moveTaskCardIntoReviewByHandingTurnToUser ---
// 只允许 in_progress 的卡。先把会话回合翻给用户（runtime.transitionTaskToReview），成功后**显式**移列到 review——
// 跨项目时没有浏览器在跑列自动流转（Rule A），不能指望它把卡挪过去。翻回合失败则不移列。
export const runtimeTaskCardActionMoveIntoReviewRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
});
export type RuntimeTaskCardActionMoveIntoReviewRequest = z.infer<
	typeof runtimeTaskCardActionMoveIntoReviewRequestSchema
>;
export const runtimeTaskCardAgentTurnHandoffToUserOutcomeSchema = z.enum([
	"agent_turn_handed_to_user",
	// 例如会话不是终端 agent（Cline / ACP 自报完成，不经此入口）或会话已不存在。卡片不移列。
	"agent_turn_handoff_to_user_failed",
]);
export const runtimeTaskCardActionMoveIntoReviewResponseSchema = z.object({
	agentTurnHandoffToUserOutcome: runtimeTaskCardAgentTurnHandoffToUserOutcomeSchema,
	agentTurnHandoffToUserFailureMessage: z.string().nullable(),
	// false = 翻回合失败没有移列，或卡片在翻回合期间已被别处（例如浏览器的列自动流转）挪进 review。
	taskCardWasMovedIntoReviewColumnByThisAction: z.boolean(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionMoveIntoReviewResponse = z.infer<
	typeof runtimeTaskCardActionMoveIntoReviewResponseSchema
>;

// --- moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects ---
// 纯看板重新归类（进出 validation、in_progress 列内重排）。准入判据见
// src/core/task-card-action-board-column-transitions.ts；有会话副作用的移列必须走各自的 procedure。
export const runtimeTaskCardActionMoveBetweenNonTrashColumnsRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	targetBoardColumnId: runtimeBoardColumnIdSchema,
	// 拖放落点（目标列里插入后的下标）；缺省 = 列顶。同列重排时必填，否则视为原位不动。
	insertAtIndexWithinTargetBoardColumn: z.number().int().nonnegative().optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
});
export type RuntimeTaskCardActionMoveBetweenNonTrashColumnsRequest = z.infer<
	typeof runtimeTaskCardActionMoveBetweenNonTrashColumnsRequestSchema
>;
export const runtimeTaskCardActionMoveBetweenNonTrashColumnsResponseSchema = z.object({
	boardColumnIdOfTaskCardBeforeAction: runtimeBoardColumnIdSchema,
	// false = 卡片已在目标位置，这次没有写盘。
	taskCardPlacementWasChangedByThisAction: z.boolean(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse = z.infer<
	typeof runtimeTaskCardActionMoveBetweenNonTrashColumnsResponseSchema
>;

// --- moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree ---
// 移入 Done（trash 列）→ 停 agent 会话与详情 shell 终端会话 → 删 worktree（按卡片的 worktreeMode）。
// 卡片本来就在 Done 时什么副作用都不做（会话中断自动流转进 Done 的卡刻意保留 worktree 供恢复）。
export const runtimeTaskCardActionMoveIntoDoneRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	// 评论与移列在同一次保存里生效；稳定 ID 供网络重试去重，时间由服务端填写。
	taskCommentToAppendWhenMovingIntoDone: z
		.object({
			taskCommentEntryId: z.string().min(1),
			commentText: z.string().trim().min(1),
		})
		.optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
	// 拖放进 Done 的落点；缺省 = 列顶（CLI / 程序化移入不传）。卡片本来就在 Done 时忽略。
	insertAtIndexWithinDoneBoardColumn: z.number().int().nonnegative().optional(),
	// 卡片受 Post-Deploy Verification 门禁（在活跃部署组里、未结案、有未勾项）时必须带上，覆盖全部未勾项的原因；
	// 否则服务端以 PRECONDITION_FAILED 拒绝（message 前缀见 POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_...）。
	postDeployVerificationDoneEntryClosure: runtimePostDeployVerificationDoneEntryClosureRequestSchema.optional(),
});
export type RuntimeTaskCardActionMoveIntoDoneRequest = z.infer<typeof runtimeTaskCardActionMoveIntoDoneRequestSchema>;
export const runtimeTaskCardActionMoveIntoDoneResponseSchema = z.object({
	// 本次移入 Done 时 Post-Deploy Verification 结案的结果；任务不受门禁时为 null。
	postDeployVerificationClosureOutcome: runtimePostDeployVerificationClosureOutcomeSchema.nullable().optional(),
	boardColumnIdOfTaskCardBeforeAction: runtimeBoardColumnIdSchema,
	taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: z.boolean(),
	// 卡片移入前所在列可能挂着活 agent 会话（in_progress / review / validation）时才发 stop；详情 shell 终端总是停。
	taskAgentSessionStopWasRequested: z.boolean(),
	// 已在 Done 时为 null（没有尝试删）。
	taskWorktreeDeletionResult: runtimeTaskWorktreeDeletionResultOfTaskCardActionSchema.nullable(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionMoveIntoDoneResponse = z.infer<typeof runtimeTaskCardActionMoveIntoDoneResponseSchema>;

// --- restoreTaskCardFromDoneIntoReviewResumingAgentSession ---
// 只允许 Done 里的卡。移回 review → ensure worktree → 以 resumeFromTrash 续跑会话；任一步失败都把卡移回 Done
// 并如实回传失败。成功后关掉卡片的自动 review 动作（与浏览器一致：恢复出来的卡不该被自动提交再次带走）。
export const runtimeTaskCardActionRestoreFromDoneRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
	agentTerminalGeometryForTaskSessionSpawn: runtimeAgentTerminalGeometryForTaskSessionSpawnSchema.optional(),
	// 从 Done 拖回 review 的落点；缺省 = 列顶。恢复失败移回 Done 时不用它（回到 Done 列顶）。
	insertAtIndexWithinReviewBoardColumn: z.number().int().nonnegative().optional(),
});
export type RuntimeTaskCardActionRestoreFromDoneRequest = z.infer<
	typeof runtimeTaskCardActionRestoreFromDoneRequestSchema
>;
export const runtimeTaskCardRestoreFromDoneOutcomeSchema = z.enum([
	"agent_session_resumed_and_task_card_kept_in_review",
	"task_worktree_ensure_failed_so_task_card_was_moved_back_into_done",
	"agent_session_resume_failed_so_task_card_was_moved_back_into_done",
]);
export type RuntimeTaskCardRestoreFromDoneOutcome = z.infer<typeof runtimeTaskCardRestoreFromDoneOutcomeSchema>;
export const runtimeTaskCardActionRestoreFromDoneResponseSchema = z.object({
	taskCardRestoreFromDoneOutcome: runtimeTaskCardRestoreFromDoneOutcomeSchema,
	taskCardRestoreFromDoneFailureMessage: z.string().nullable(),
	ensuredTaskWorktreeWarningMessage: z.string().nullable(),
	resumedAgentSessionSummary: runtimeTaskSessionSummarySchema.nullable(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionRestoreFromDoneResponse = z.infer<
	typeof runtimeTaskCardActionRestoreFromDoneResponseSchema
>;

// --- permanentlyDeleteTaskCardsWithFullResourceCleanup ---
export const runtimePermanentlyDeletedTaskCardSelectionSchema = z.discriminatedUnion(
	"permanentlyDeletedTaskCardSelectionKind",
	[
		z.object({
			permanentlyDeletedTaskCardSelectionKind: z.literal("task_cards_selected_by_task_id"),
			selectedTaskIds: z.array(z.string()).min(1),
		}),
		z.object({
			permanentlyDeletedTaskCardSelectionKind: z.literal("every_task_card_in_board_column"),
			selectedBoardColumnId: runtimeBoardColumnIdSchema,
		}),
	],
);
export type RuntimePermanentlyDeletedTaskCardSelection = z.infer<
	typeof runtimePermanentlyDeletedTaskCardSelectionSchema
>;
// 收尾链顺序固定：board 删卡 → 清编辑草稿 → 清排队 prompt（并通知出队引擎重读）→ 停会话 → 删 worktree →
// **最后**批删 turn checkpoint ref。按 task id 选中而有一张不在 board 上时整批 NOT_FOUND、什么都不删。
export const runtimeTaskCardActionPermanentlyDeleteRequestSchema = z.object({
	expectedTaskIncarnationCreatedAtEpochMsByTaskId: z.record(z.string(), z.number().finite()).optional(),
	permanentlyDeletedTaskCardSelection: runtimePermanentlyDeletedTaskCardSelectionSchema,
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
});
export type RuntimeTaskCardActionPermanentlyDeleteRequest = z.infer<
	typeof runtimeTaskCardActionPermanentlyDeleteRequestSchema
>;
export const runtimeTaskCardActionPermanentlyDeleteResponseSchema = z.object({
	permanentlyDeletedTaskCards: z.array(
		z.object({
			deletedTaskCard: runtimeBoardCardSchema,
			boardColumnIdOfDeletedTaskCardBeforeDeletion: runtimeBoardColumnIdSchema,
			taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion: runtimeTaskSessionSummarySchema.nullable(),
			taskWorktreeDeletionResult: runtimeTaskWorktreeDeletionResultOfTaskCardActionSchema,
		}),
	),
});
export type RuntimeTaskCardActionPermanentlyDeleteResponse = z.infer<
	typeof runtimeTaskCardActionPermanentlyDeleteResponseSchema
>;

// --- updateTaskCardFieldValues ---
// `kanban task update` 的原始输入（尚未与卡片现值合并）。三态字段：缺省 = 保留卡片现值，null = 清除，
// 具体值 = 改成该值。clineReasoningEffort 的 "default" = 显式回落默认推理档（保留空覆盖）。
export const runtimeKanbanCliTaskCardFieldUpdateRawInputSchema = z.object({
	title: z.string().optional(),
	prompt: z.string().optional(),
	baseRef: z.string().optional(),
	startInPlanMode: z.boolean().optional(),
	taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.optional(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	agentId: runtimeAgentIdSchema.nullable().optional(),
	clineProviderId: z.string().nullable().optional(),
	clineModelId: z.string().nullable().optional(),
	clineReasoningEffort: z
		.union([runtimeClineReasoningEffortSchema, z.literal("default")])
		.nullable()
		.optional(),
	taskAgentSessionInitializationId: z.string().nullable().optional(),
	taskAgentSessionInitializationMode: runtimeTaskAgentSessionInitializationReuseModeSchema.optional(),
	parentSessionId: z.string().nullable().optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.nullable().optional(),
	prepFilePath: z.string().nullable().optional(),
});
export type RuntimeKanbanCliTaskCardFieldUpdateRawInput = z.infer<
	typeof runtimeKanbanCliTaskCardFieldUpdateRawInputSchema
>;

// 编辑器整卡保存 / 行内改名 / 取消自动动作用的字段 patch。每个字段三态：键缺省 = 保留卡片**最新**现值；
// null = 清除（回落到默认 / 由 prompt 派生 / 跟随全局）；具体值 = 改成该值。合并在 runtime 的 board 锁内对最新
// 卡片进行，所以「只改标题」不会抹掉别人刚改的 prompt。taskAgentPermissionMode 的 null = 复位到默认档位。
// taskAgentSessionInitialization 出现在 patch 里（含 null）而 parentSessionId 缺省时，parentSessionId 一并清除——
// 否则卡片 schema 会从遗留 parentSessionId 重新派生出刚被清掉的初始化（与浏览器 updateTask 同语义）。
export const runtimeTaskCardFieldValuePatchSchema = z.object({
	title: z.string().nullable().optional(),
	prompt: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).nullable().optional(),
	startInPlanMode: z.boolean().optional(),
	taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.nullable().optional(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	taskCommentEntries: z.array(runtimeTaskCommentEntrySchema).nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable().optional(),
	ompAgentSessionTransport: runtimeAgentSessionTransportSchema.nullable().optional(),
	taskConversationMode: runtimeTaskConversationModeSchema.nullable().optional(),
	clineSettings: runtimeTaskClineSettingsSchema.nullable().optional(),
	terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.nullable().optional(),
	taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.nullable().optional(),
	baseRef: z.string().optional(),
	parentSessionId: z.string().nullable().optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.nullable().optional(),
	prepFilePath: z.string().nullable().optional(),
});
export type RuntimeTaskCardFieldValuePatch = z.infer<typeof runtimeTaskCardFieldValuePatchSchema>;

export const runtimeTaskCardFieldUpdateSchema = z.discriminatedUnion("taskCardFieldUpdateInputKind", [
	z.object({
		taskCardFieldUpdateInputKind: z.literal("kanban_cli_task_update_command_raw_arguments"),
		kanbanCliTaskCardFieldUpdateRawInput: runtimeKanbanCliTaskCardFieldUpdateRawInputSchema,
	}),
	z.object({
		taskCardFieldUpdateInputKind: z.literal("three_state_task_card_field_value_patch"),
		taskCardFieldValuePatch: runtimeTaskCardFieldValuePatchSchema,
	}),
]);
export type RuntimeTaskCardFieldUpdate = z.infer<typeof runtimeTaskCardFieldUpdateSchema>;

export const runtimeTaskCardActionUpdateFieldValuesRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
	taskCardFieldUpdate: runtimeTaskCardFieldUpdateSchema,
	// 异步 AI 回填锁内检查，防止顶掉并发名称或描述编辑。
	expectedTaskTitleAndPromptForAiNameBackfill: z.object({ title: z.string(), prompt: z.string() }).optional(),
	boardMutationInitiator: runtimeTaskCardActionBoardMutationInitiatorDeclaredByWebUiSchema,
});
export type RuntimeTaskCardActionUpdateFieldValuesRequest = z.infer<
	typeof runtimeTaskCardActionUpdateFieldValuesRequestSchema
>;
export const runtimeTaskCardActionUpdateFieldValuesResponseSchema = z.object({
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionUpdateFieldValuesResponse = z.infer<
	typeof runtimeTaskCardActionUpdateFieldValuesResponseSchema
>;

export const runtimeRenameCurrentTaskRequestSchema = z
	.object({
		title: z
			.string()
			.transform((value) => value.trim().replace(/\s+/gu, " "))
			.pipe(z.string().min(1).max(80)),
		reason: z.string().trim().min(1).max(500),
	})
	.strict();
export type RuntimeRenameCurrentTaskRequest = z.infer<typeof runtimeRenameCurrentTaskRequestSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	validation: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectUnavailableReasonSchema = z.enum([
	"project_path_missing",
	"project_path_not_directory",
	"project_path_access_could_not_be_verified",
	"git_work_tree_unavailable",
]);
export type RuntimeProjectUnavailableReason = z.infer<typeof runtimeProjectUnavailableReasonSchema>;

export const runtimeProjectAvailabilitySchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("available") }),
	z.object({
		status: z.literal("unavailable"),
		reason: runtimeProjectUnavailableReasonSchema,
	}),
]);
export type RuntimeProjectAvailability = z.infer<typeof runtimeProjectAvailabilitySchema>;

// in_progress 列单个 task 的精简明细投影。现只供顶栏项目切换器的 live 计数（project-switcher-session-activity-counts 的
// deriveLiveAgentTaskCount）；跨项目切换面板的条目是它的超集（下方 runtimeCrossProjectTaskSwitcherEntrySchema）。
// 原消费者 Stage-First Overview 已退役（docs/context-board-scope-all-projects-and-single-project-scope.md）。
export const runtimeInProgressTaskDetailSchema = z.object({
	lastEffectiveAgentConversationActivityObservation: runtimeLastEffectiveAgentConversationActivityObservationSchema
		.nullable()
		.optional(),
	lastAgentConversationUserHandoffObservation: runtimeLastAgentConversationUserHandoffObservationSchema
		.nullable()
		.optional(),
	currentAgentProcessUserTurnIdleRetentionStarted: runtimeCurrentAgentProcessUserTurnIdleRetentionStartedSchema
		.nullable()
		.optional(),
	lastAgentConversationPromptCacheReferenceObservation:
		runtimeLastAgentConversationPromptCacheReferenceObservationSchema.nullable().optional(),
	agentConversationPromptSubmissionAcceptance: runtimeAgentConversationPromptSubmissionAcceptanceSchema
		.nullable()
		.optional(),

	taskId: z.string(),
	title: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	// 任务卡创建时刻（epoch ms）；跨项目切换面板的行（经下方条目 schema 继承）据此显示「自创建至今」时长药丸
	// （同主看板卡片头部）。
	createdAt: z.number(),
	// 距最近一次 PTY 输出（含 spinner 重绘）；null=从未产出/无会话。前端据此判 agent 回合里的任务是否还在跑
	// （切换面板 Running 区与顶栏 live 计数）。
	lastOutputAt: z.number().nullable(),
	// 距最近一次「实质」产出（不含 spinner/footer/计时器等装饰性重绘）；null=无实质戳/无会话。切换面板 Cache warm
	// 倒计时在没有模型请求派发观测时以它为锚（section-assignment 的 last_substantive_agent_terminal_output）；
	// 不读 lastOutputAt，免得终端 agent 仅 spinner 重绘就把锚点推到「刚响应」。时长药丸不读它（见下）。
	lastSubstantiveOutputAt: z.number().nullable(),
	// 旧字段供旧持久数据读取；新卡片只读取历史交棒与统一活动。
	agentResponseGenerationStopped: runtimeAgentResponseGenerationStoppedSchema.nullable().optional(),
	lastConversationProgressObservation: runtimeLastConversationProgressObservationSchema.nullable().optional(),
	// 本轮 agent 回合的开始时刻（见 runtimeAgentResponseGenerationTurnStartedSchema）。跨项目切换面板 Running 区
	// 按它升序排，顺序只在回合边沿变化，不随 spinner 重绘抖动。加性 optional。
	agentResponseGenerationTurnStarted: runtimeAgentResponseGenerationTurnStartedSchema.nullable().optional(),
	turnOwner: runtimeTaskSessionTurnOwnerSchema,
	liveness: runtimeTaskSessionLivenessSchema,
});
export type RuntimeInProgressTaskDetail = z.infer<typeof runtimeInProgressTaskDetailSchema>;

// 跨项目「最近活跃任务」切换面板（Focus View 左栏的 All projects 模式，见
// docs/context-cross-project-recently-active-task-switcher.md）的 per-task 条目。
//
// 是上面 in_progress 明细的超集，且由同一个 per-card 构造函数产出（src/server/in-progress-task-detail-projection.ts），
// 不是第二份实现。与它的区别只在**取景**：不按列取，而是取「非 Done 列、且近期被碰过 / 已置顶 / agent 正持有回合」
// 的卡（取景判据见 isTaskCardWithinCrossProjectTaskSwitcherBroadcastScope）。区归属（Running / 缓存倒计时 /
// 剩余）在前端按 now 现算，见 src/core/cross-project-recently-active-task-switcher-section-assignment.ts。
export const runtimeCrossProjectTaskSwitcherEntrySchema = runtimeInProgressTaskDetailSchema.extend({
	taskConversationSessionActivityObservations: z
		.array(runtimeTaskConversationSessionActivityObservationSchema)
		.optional(),
	// 卡片当前所在的 board 列。面板的区归属**不读**它（只用来排除 Done 与显示 stage 标签）——
	// 列自动流转只在打开着该项目的浏览器里跑，没人看的项目列会滞后。
	columnId: runtimeBoardColumnIdSchema,
	// 第三个 facet。缓存倒计时区的判据 isNotifiableUserTurn 要用完整三元组。
	userTurnKind: runtimeTaskSessionUserTurnKindSchema,
	// 主 agent 已 park、在等自己派发的后台工作（isParkedAwaitingDispatchedBackgroundWork）。归 Running 区。
	isParkedAwaitingDispatchedBackgroundWork: z.boolean(),
	// Description 最后一次内容变化的时刻（老卡回落 updatedAt，同 Backlog 排序）。
	taskDescriptionLastUpdatedAt: z.number(),
	// 用户最近一次在任一浏览器里打开这个任务的时刻（服务端记录，见 task-last-opened-by-user-record-store.ts）。
	lastOpenedByUserAt: z.number().nullable(),
	// Task Pinboard 置顶态（字段存在即已置顶，同 board 卡片）。
	pinnedToTaskPinboardAt: z.number().nullable(),
	taskPinboardPinReason: z.string().nullable(),
	// Cache warm 倒计时的两个输入（见 estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn）：
	// 主对话最后一次发请求的时刻，以及当前 agent 进程的启动时刻（summary.startedAt）——后者用来判定
	// 「缓存只活在同一进程里」的 agent（Codex / Kimi）在恢复成新进程后旧缓存已失效。加性 optional。
	lastMainAgentConversationModelRequestDispatchObservation:
		runtimeLastMainAgentConversationModelRequestDispatchObservationSchema.nullable().optional(),
	agentProcessStartedAt: z.number().nullable().optional(),
	// 行上 git 元数据（ahead/behind、未提交改动）旁要显示的两个卡片静态字段：tooltip 里的 base 分支名，
	// 以及 worktree / inplace 图标。几乎不变，不会让广播指纹抖动。加性 optional。
	baseRef: z.string().optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeCrossProjectTaskSwitcherEntry = z.infer<typeof runtimeCrossProjectTaskSwitcherEntrySchema>;

export const runtimeAllProjectsTaskGroupQueryRequestSchema = z.object({
	recentDays: z.union([z.literal(7), z.literal(30)]).default(7),
});
export type RuntimeAllProjectsTaskGroupQueryRequest = z.infer<typeof runtimeAllProjectsTaskGroupQueryRequestSchema>;

const allProjectsTaskGroupQueryProjectIdentitySchema = z.object({
	workspaceId: z.string(),
	projectName: z.string(),
	projectPath: z.string(),
});

// 监控的空结果必须带完整读取证明；旧服务或失败回退不得默认成 complete。
export const runtimeAllProjectsTaskGroupQuerySnapshotSchema = z.object({
	observedAtMs: z.number(),
	recentDays: z.union([z.literal(7), z.literal(30)]),
	projects: z.array(
		z.discriminatedUnion("taskEntriesReadStatus", [
			allProjectsTaskGroupQueryProjectIdentitySchema.extend({
				taskEntriesReadStatus: z.literal("complete"),
				crossProjectTaskSwitcherEntries: z.array(runtimeCrossProjectTaskSwitcherEntrySchema),
			}),
			allProjectsTaskGroupQueryProjectIdentitySchema.extend({
				taskEntriesReadStatus: z.literal("unavailable"),
				unavailableReason: z.string().min(1),
				crossProjectTaskSwitcherEntries: z.array(runtimeCrossProjectTaskSwitcherEntrySchema).max(0),
			}),
		]),
	),
});
export type RuntimeAllProjectsTaskGroupQuerySnapshot = z.infer<typeof runtimeAllProjectsTaskGroupQuerySnapshotSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	// 旧 runtime/测试 fixture 无此字段时，浏览器按名称与 workspace ID 派生默认标识。
	visualIdentity: projectVisualIdentitySchema.optional(),
	taskCounts: runtimeProjectTaskCountsSchema,
	// 旧 runtime payload 未携带 availability；缺省仅用于网络兼容。新服务端始终显式检查并发送结果。
	availability: runtimeProjectAvailabilitySchema.default({ status: "available" }),
	// board 列归属的原始计数（未套主看板的 live-session overlay）。原供已退役的 Stage-First Overview 做 stage 计数
	// （ADR-0001，已 Superseded），现已没有前端消费者；为兼容旧 bundle 暂留，后续可删。
	// optional：projects.add 快路径可省略，下一次 projects_updated/snapshot 广播补齐。
	rawColumnTaskCounts: runtimeProjectTaskCountsSchema.optional(),
	// 该 project in_progress 列全部 task 的明细，供顶栏项目切换器数 live agent（deriveLiveAgentTaskCount）。
	// default([])：旧广播/快照无此字段时安全回退。
	inProgressTaskDetails: z.array(runtimeInProgressTaskDetailSchema).default([]),
	// 跨项目切换面板的条目（取景见 runtimeCrossProjectTaskSwitcherEntrySchema）。default([])：旧广播无此字段时安全回退。
	crossProjectTaskSwitcherEntries: z.array(runtimeCrossProjectTaskSwitcherEntrySchema).default([]),
	// The project's git `remote.origin.url` (raw, unnormalized), or null when the repo
	// has no origin remote / the read failed. Consumed by the bug-report FAB to detect
	// the cline-kanban developer project by matching its GitHub owner/repo slug.
	gitRemoteOriginUrl: z.string().nullable().optional(),
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskCommitIntegrationTrackingStatusSchema = z.enum([
	"complete",
	// 真正缺 provenance 的旧 task（功能上线前创建、且首次可追踪时 ahead=0）。
	"legacy_history_unavailable",
	// 有 provenance 锚点，但现存证据不足以证明 task commit 归属（例如非纯 fast-forward 的历史）。
	"task_commit_ownership_history_incomplete",
	"inplace_task_commit_ownership_unavailable",
	"git_probe_unavailable",
]);
export type RuntimeTaskCommitIntegrationTrackingStatus = z.infer<
	typeof runtimeTaskCommitIntegrationTrackingStatusSchema
>;

export const runtimeTaskWorkspaceGitStatusObservationSourceSchema = z.enum([
	"live_worktree",
	"persisted_final_snapshot",
	"unavailable",
]);
export type RuntimeTaskWorkspaceGitStatusObservationSource = z.infer<
	typeof runtimeTaskWorkspaceGitStatusObservationSourceSchema
>;

/**
 * 一个 task 与其本地 baseRef 的统一 Git 状态投影。
 *
 * ahead / behind 是此刻的拓扑分歧；taskCommitsIntegratedIntoBaseRef 则来自持久 task commit
 * provenance，不能用当前 merge-base 反推。null 一律表示没有足够证据，绝不等价于 0。
 */
export const runtimeTaskWorkspaceGitStatusSchema = z.object({
	baseRef: z.string(),
	commitsAheadOfBaseRef: z.number().int().nonnegative().nullable(),
	commitsBehindBaseRef: z.number().int().nonnegative().nullable(),
	taskCommitsIntegratedIntoBaseRef: z.number().int().nonnegative().nullable(),
	taskCommitIntegrationTrackingStatus: runtimeTaskCommitIntegrationTrackingStatusSchema,
	observationSource: runtimeTaskWorkspaceGitStatusObservationSourceSchema,
	observedAt: z.number().nullable(),
});
export type RuntimeTaskWorkspaceGitStatus = z.infer<typeof runtimeTaskWorkspaceGitStatusSchema>;

export const runtimeTaskWorkspaceGitStatusesResponseSchema = z.object({
	taskWorkspaceGitStatuses: z.record(z.string(), runtimeTaskWorkspaceGitStatusSchema),
});
export type RuntimeTaskWorkspaceGitStatusesResponse = z.infer<typeof runtimeTaskWorkspaceGitStatusesResponseSchema>;

export const runtimeTaskRetainedCommittedLineChangeCommitSchema = z.object({
	commitSha: z.string(),
	subject: z.string(),
	committedAtMs: z.number(),
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
});
export type RuntimeTaskRetainedCommittedLineChangeCommit = z.infer<
	typeof runtimeTaskRetainedCommittedLineChangeCommitSchema
>;

export const runtimeTaskRetainedCommittedLineChangeSummarySchema = z.object({
	status: z.enum(["complete", "unavailable"]),
	commitCount: z.number().int().nonnegative().nullable(),
	additions: z.number().int().nonnegative().nullable(),
	deletions: z.number().int().nonnegative().nullable(),
	historyVersion: z.string(),
	unavailableReason: z.string().nullable(),
});
export type RuntimeTaskRetainedCommittedLineChangeSummary = z.infer<
	typeof runtimeTaskRetainedCommittedLineChangeSummarySchema
>;

export const runtimeTaskRetainedCommittedLineChangeHistorySchema = z.object({
	summary: runtimeTaskRetainedCommittedLineChangeSummarySchema,
	commits: z.array(runtimeTaskRetainedCommittedLineChangeCommitSchema),
});
export type RuntimeTaskRetainedCommittedLineChangeHistory = z.infer<
	typeof runtimeTaskRetainedCommittedLineChangeHistorySchema
>;

// 当前部署版本的提交覆盖是独立投影，不代表任务完成或部署后验证通过。
export const runtimeTaskCommitCoverageInCurrentDeploymentSchema = z.object({
	coverageStatus: z.enum([
		"no_known_task_commits",
		"no_known_task_commits_in_current_deployment",
		"some_known_task_commits_in_current_deployment",
		"all_known_task_commits_in_current_deployment",
		"unknown",
	]),
	knownTaskCommitCount: z.number().int().nonnegative().nullable(),
	matchedTaskCommitCountInCurrentDeployment: z.number().int().nonnegative().nullable(),
	currentDeploymentId: z.string().nullable(),
	currentDeployedSourceCommit: z.string().nullable(),
	currentDeploymentRecordedAtIso: z.string().nullable(),
	unavailableReason: z.string().nullable(),
	// 内容寻址，轮询时间不参与，未变化的卡片无需重渲。
	coverageVersion: z.string(),
});
export type RuntimeTaskCommitCoverageInCurrentDeployment = z.infer<
	typeof runtimeTaskCommitCoverageInCurrentDeploymentSchema
>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	// 任务从 base 分叉时的提交（fork-point，git merge-base HEAD <baseRef>）。
	// 稳定不随 base 分支推进而变；未探测 / 计算失败 / inplace 无分叉等情形为 null。
	// 注意它会随 base-branch-sync 吸收 base 而前移，故**不是**「任务最初创建自哪个 commit」。
	baseCommit: z.string().nullable(),
	// 与 base 分支的双向分歧，一次 `git rev-list --left-right --count <baseRef>...HEAD` 同时得出。
	// ahead = HEAD 独有的提交数（任务开工后落在当前 worktree 上的提交，含吸收 base 时产生的 merge commit）；
	// 与旧的 fork-point..HEAD 计数是同一个集合，仅命名更对称。
	commitsAheadOfBaseRef: z.number().int().nonnegative().nullable(),
	// behind = base 分支独有、任务尚未吸收的提交数。base 分支推进时增长，任务吸收（base-branch-sync）后归零。
	commitsBehindBaseRef: z.number().int().nonnegative().nullable(),
	workspaceGitStatus: runtimeTaskWorkspaceGitStatusSchema,
	// 可选仅为兼容旧 runtime；新探针始终给出完整统计或明确的未知原因。
	taskRetainedCommittedLineChangeSummary: runtimeTaskRetainedCommittedLineChangeSummarySchema.optional(),
	taskCommitCoverageInCurrentDeployment: runtimeTaskCommitCoverageInCurrentDeploymentSchema.optional(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeClineMcpServerAuthStatusSchema = z.object({
	serverName: z.string(),
	oauthSupported: z.boolean(),
	oauthConfigured: z.boolean(),
	lastError: z.string().nullable(),
	lastAuthenticatedAt: z.number().nullable(),
});
export type RuntimeClineMcpServerAuthStatus = z.infer<typeof runtimeClineMcpServerAuthStatusSchema>;

// 应用内通知中心的「已派生」feed 条目：后端在发送时把最小持久化条目补齐成前端可直接渲染的形态。
// taskTitle/repoName/isDone 一律后端派生——跨 repo 聚合下客户端只加载活跃 repo 的 board，拿不到
// 其它 repo 的 board 自行解析。id = `${taskId}:${triggeredAt}`（append 幂等键）。
export const runtimeNotificationFeedEntrySchema = z.object({
	candidateId: z.string().optional(),
	summaryText: z.string().optional(),
	id: z.string(),
	workspaceId: z.string(),
	taskId: z.string(),
	repoName: z.string(),
	taskTitle: z.string(),
	userTurnKind: runtimeTaskSessionUserTurnKindSchema,
	triggeredAt: z.number(),
	visitedAt: z.number().nullable(),
	isDone: z.boolean(),
});
export type RuntimeNotificationFeedEntry = z.infer<typeof runtimeNotificationFeedEntrySchema>;

// 通知中心的两个跨 repo mutation：workspaceId 显式入参（点 repo B 的通知时正看 repo A，
// 不能用连接绑定的 scope）。mark = 把该 taskId 组所有未读置为已访问；clear = 清空该 workspace 日志。
export const runtimeNotificationMarkVisitedRequestSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
});
export type RuntimeNotificationMarkVisitedRequest = z.infer<typeof runtimeNotificationMarkVisitedRequestSchema>;

export const runtimeNotificationClearRequestSchema = z.object({
	workspaceId: z.string(),
});
export type RuntimeNotificationClearRequest = z.infer<typeof runtimeNotificationClearRequestSchema>;

export const runtimeNotificationMutationResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeNotificationMutationResponse = z.infer<typeof runtimeNotificationMutationResponseSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
	clineSessionContextVersion: z.number().int().nonnegative(),
	// 跨全部 workspace 聚合的通知 feed（铃铛/日志用），随首帧快照下发；空时为 []。
	notificationLog: z.array(runtimeNotificationFeedEntrySchema),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	archiveIncomplete: z.boolean().optional(),
	candidateId: z.string().optional(),
	summaryText: z.string().optional(),
	summaryLanguage: z.enum(["zh-CN", "en-US"]).optional(),
	taskTitleSnapshot: z.string().optional(),
	// 浏览器系统语音据此分两段念（先导 → 停顿 → 正文）；第三方 TTS 由服务端合成同一份脚本。
	notificationSpeechAnnouncementScript: notificationSpeechAnnouncementScriptSchema.optional(),
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
	// 「人轴」种类随一次性 ready 事件 payload 内联下发（广播时由服务端从 summary facet 解析）。
	// 前端通知标题据此措辞，不再回读延迟 150ms 批处理的 task_sessions_updated summary 流——
	// 杜绝上次 ③(b) 命中的「事件先到、summary 后到 → 标题读 stale userTurnKind」竞态。
	// 可选：旧服务端/缓存旧构建可能不带该字段，缺省时前端按 review 措辞兜底（加性 schema 纪律）。
	userTurnKind: runtimeTaskSessionUserTurnKindSchema.optional(),
	// 触发它的 agent 事件是 runtime 缺席期间存下、很久之后才送到的（热重启 P3）：照常弹通知，但不朗读。
	notificationSpeechSuppressedBecauseAgentEventWasDeliveredLate: z.boolean().optional(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamTaskChatMessageSchema = z.object({
	type: z.literal("task_chat_message"),
	workspaceId: z.string(),
	taskId: z.string(),
	message: z.lazy(() => runtimeTaskChatMessageSchema),
});
export type RuntimeStateStreamTaskChatMessage = z.infer<typeof runtimeStateStreamTaskChatMessageSchema>;

export const runtimeStateStreamTaskChatClearedMessageSchema = z.object({
	type: z.literal("task_chat_cleared"),
	workspaceId: z.string(),
	taskId: z.string(),
});
export type RuntimeStateStreamTaskChatClearedMessage = z.infer<typeof runtimeStateStreamTaskChatClearedMessageSchema>;

export const runtimeStateStreamMcpAuthUpdatedMessageSchema = z.object({
	type: z.literal("mcp_auth_updated"),
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeStateStreamMcpAuthUpdatedMessage = z.infer<typeof runtimeStateStreamMcpAuthUpdatedMessageSchema>;

export const runtimeStateStreamClineSessionContextUpdatedMessageSchema = z.object({
	type: z.literal("cline_session_context_updated"),
	version: z.number().int().nonnegative(),
});
export type RuntimeStateStreamClineSessionContextUpdatedMessage = z.infer<
	typeof runtimeStateStreamClineSessionContextUpdatedMessageSchema
>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

// 单个 workspace 的通知 feed 增量：新事件落库、mark-visited、clear、board 变更（isDone 刷新）后，
// 后端把该 workspace 的整段派生 feed 全局广播给所有连接客户端（铃铛是跨 repo 聚合的）。
export const runtimeStateStreamNotificationLogUpdatedMessageSchema = z.object({
	type: z.literal("notification_log_updated"),
	workspaceId: z.string(),
	entries: z.array(runtimeNotificationFeedEntrySchema),
});
export type RuntimeStateStreamNotificationLogUpdatedMessage = z.infer<
	typeof runtimeStateStreamNotificationLogUpdatedMessageSchema
>;

// ---- Exploratory findings canonical schema（蓝图 §D.1）----
// TDZ 约束：exploratory_findings_updated 广播消息引用 runtimeExploratoryFindingEntrySchema，
// union 在模块求值时就要拿到它，故本块必须
// 留在 runtimeStateStreamMessageSchema 之前。

export const runtimeExploratoryFindingProvenanceLinkSchema = z
	.object({
		// 解法定调 3：每条 finding 至少一个 provenance 链接；turn_anchor 必须三元齐全
		// （turnCheckpointCommit 允许 null = 仅时间锚，语义同 §B.1 锚点）。
		// user_authored_freeform 用于「纯人工笔记」这类无锚 finding——provenance 强制但允许
		// 显式声明「无锚」而不是伪造锚。
		linkKind: z.enum(["turn_anchor", "session_level", "user_authored_freeform"]),
		conversationSessionTaskId: z.string(),
		turnNumber: z.number().int().positive().nullable(),
		turnCheckpointCommit: z.string().nullable(),
	})
	.superRefine((link, ctx) => {
		// linkKind ↔ 字段组合约束在 schema 层强制（不再只靠注释约定——裸形状下 agent 可以
		// 交出 turn_anchor+无 turnNumber 的伪锚，或给 session_level 链接挂上未校验的
		// turnNumber/checkpoint 混过校验原样落库）：
		// turn_anchor 必须锚到具体轮次（turnNumber 非 null；checkpoint 允许 null = 仅时间锚，
		// 可解析性降级是 ingest handler 的职责，不在本层）；session_level 与
		// user_authored_freeform 是显式「无轮次锚」声明，两个锚字段必须全 null。
		if (link.linkKind === "turn_anchor" && link.turnNumber === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["turnNumber"],
				message: "turn_anchor links must anchor a concrete turn: turnNumber must be non-null.",
			});
		}
		if (link.linkKind !== "turn_anchor" && link.turnNumber !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["turnNumber"],
				message: `${link.linkKind} links declare no turn anchor: turnNumber must be null.`,
			});
		}
		if (link.linkKind !== "turn_anchor" && link.turnCheckpointCommit !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["turnCheckpointCommit"],
				message: `${link.linkKind} links declare no turn anchor: turnCheckpointCommit must be null.`,
			});
		}
	});
export type RuntimeExploratoryFindingProvenanceLink = z.infer<typeof runtimeExploratoryFindingProvenanceLinkSchema>;

export const runtimeExploratoryFindingStatusSchema = z.enum([
	"suggested_pending_confirmation", // agent 建议、待人确认（v1 抽取的唯一自动档）
	"active",
	"superseded", // 被更新的 finding 取代（supersededByFindingId 互链，审计保留）
	"archived", // 软删：不进默认列表，可恢复
]);
export type RuntimeExploratoryFindingStatus = z.infer<typeof runtimeExploratoryFindingStatusSchema>;

export const runtimeExploratoryFindingGenerationSourceSchema = z.enum([
	"user_saved", // UI「存为 finding」按钮人工保存
	"agent_suggested", // agent 经 ingestFindingCandidate 通道建议
	// 扩展位：agent_auto_extracted（无人工在环的自动抽取）——v1 刻意不做，见蓝图 §D.2.3。
]);
export type RuntimeExploratoryFindingGenerationSource = z.infer<typeof runtimeExploratoryFindingGenerationSourceSchema>;

export const runtimeExploratoryFindingEntrySchema = z.object({
	// 稳定 dedup 键：用户保存 = UI 生成 uuid；agent 建议 = 服务端派生的 agent-<clientProposalId>
	// ——同一建议重发不落成两条。
	findingId: z.string(),
	findingTitle: z.string().max(120),
	findingBodyMarkdown: z.string().max(4000),
	findingStatus: runtimeExploratoryFindingStatusSchema,
	supersededByFindingId: z.string().nullable(),
	findingGenerationSource: runtimeExploratoryFindingGenerationSourceSchema,
	provenanceLinks: z.array(runtimeExploratoryFindingProvenanceLinkSchema).min(1),
	originConversationSessionTaskId: z.string().nullable(),
	// ── KB 预留扩展位（v1 恒缺省，蓝图 §D.1）──
	findingTags: z.array(z.string().max(40)).max(8).optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeExploratoryFindingEntry = z.infer<typeof runtimeExploratoryFindingEntrySchema>;

// findings 集合变更广播（蓝图 §D.3）：save/confirm/reject/archive/ingest 落盘成功后，
// 把该 workspace 的完整 finding 集合（恒小，上限 500）全量替换推送给在场客户端。
// 不搭车 summary 广播——findings 变更不必然 bump summary。
export const runtimeStateStreamExploratoryFindingsUpdatedMessageSchema = z.object({
	type: z.literal("exploratory_findings_updated"),
	workspaceId: z.string(),
	findings: z.array(runtimeExploratoryFindingEntrySchema),
});
export type RuntimeStateStreamExploratoryFindingsUpdatedMessage = z.infer<
	typeof runtimeStateStreamExploratoryFindingsUpdatedMessageSchema
>;

// ─── exploration thread graph 投影整值（B.2）───
//
// 领域真相在独立包 agent-conversation-exploration-thread-graph，本仓库只做宿主胶水：图由核心包
// 建模与落盘，服务端把它合成 projection 整值后整份下发。下面这批 schema 是**边界镜像**，不是第二
// 份定义——它们存在的唯一理由是 web-ui 不能 import 核心包（`/core` 静态导出依赖 node `fs` 的 store，
// 打进浏览器 bundle 会炸），因此契约层必须自带一份可被 `@runtime-contract` 解析的形状。
// 与核心包类型的一致性由 src/exploration-thread-graph/exploration-thread-graph-contract-parity.ts
// 做编译期双向对账：核心包换 SHA 后形状若漂移，根 typecheck 立刻红。
//
// lane 布局**在服务端算好**随行下发（核心包的 projection 每行自带 laneLayout），前端只负责画。
export const runtimeExplorationThreadGraphTurnRefSchema = z.object({
	conversationSessionId: z.string(),
	turnNumber: z.number(),
	turnCheckpointCommit: z.string().nullable(),
});
export type RuntimeExplorationThreadGraphTurnRef = z.infer<typeof runtimeExplorationThreadGraphTurnRefSchema>;

const runtimeExplorationThreadGraphGenerationSourceSchema = z.enum(["work_branch_maintenance_job", "user_manual_edit"]);

export const runtimeExplorationThreadGraphLaneLayoutRowSchema = z.object({
	id: z.string(),
	rowLane: z.number(),
	laneWaitingForIds: z.array(z.string()),
	mergeFromLanes: z.array(z.number()),
	splitFromLane: z.number().nullable(),
	rowStartsLane: z.boolean(),
	isFirstRow: z.boolean(),
});

export const runtimeExplorationThreadGraphTopicSchema = z.object({
	topicId: z.string(),
	topicTitle: z.string(),
	topicAliases: z.array(z.string()),
	topicSummaryMarkdown: z.string().nullable(),
	supersededByTopicId: z.string().nullable(),
	generationSource: runtimeExplorationThreadGraphGenerationSourceSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
});

export const runtimeExplorationThreadSchema = z.object({
	threadId: z.string(),
	threadTitle: z.string(),
	parentThreadId: z.string().nullable(),
	forkedFromTurnRef: runtimeExplorationThreadGraphTurnRefSchema.nullable(),
	primaryTopicId: z.string(),
	threadLifecycleStatus: z.enum(["active", "concluded", "parked", "abandoned"]),
	concludedAtTurnRef: runtimeExplorationThreadGraphTurnRefSchema.nullable(),
	generationSource: runtimeExplorationThreadGraphGenerationSourceSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
});

// 作业用量。cacheReadInputTokens 恒要回报——它是判断 fork 有没有吃到 prompt cache 的唯一依据
// （当前受上游 bug #77306 影响恒为 0，见 docs/exploratory-mode-host-integration.md §3b）。
export const runtimeExplorationThreadGraphMaintenanceJobUsageSchema = z.object({
	inputTokens: z.number(),
	cacheReadInputTokens: z.number(),
	outputTokens: z.number(),
	costUsd: z.number().nullable(),
});

export const runtimeExplorationThreadGraphProjectionViewTurnRowSchema = z.object({
	turnRowId: z.string(),
	turnRef: runtimeExplorationThreadGraphTurnRefSchema,
	userPromptExcerpt: z.string(),
	assistantResponseExcerpt: z.string(),
	startedAt: z.string(),
	endedAt: z.string(),
	toolCallCount: z.number(),
	// 尚未归位的 turn 这里是 null：图上仍要显示它，只是还没有 lane 身份。
	threadId: z.string().nullable(),
	placementConfidence: z.enum(["high", "low"]).nullable(),
	deviationRationale: z.string().nullable(),
	turnSubjectTags: z.array(z.string()),
	eventMarks: z.array(
		z.object({
			mark: z.enum(["milestone", "decision_point", "open_question", "finding_candidate"]),
			note: z.string().nullable(),
			externalReferenceId: z.string().nullable(),
		}),
	),
	parentTurnRowIds: z.array(z.string()),
	laneLayout: runtimeExplorationThreadGraphLaneLayoutRowSchema,
});
export type RuntimeExplorationThreadGraphProjectionViewTurnRow = z.infer<
	typeof runtimeExplorationThreadGraphProjectionViewTurnRowSchema
>;

export const runtimeExplorationThreadGraphProjectionViewSchema = z.object({
	schemaVersion: z.number(),
	explorationId: z.string(),
	// **新→旧**（与 `git log` 一致）；lane 布局就是按这个序算的，前端不得重排。
	turnRows: z.array(runtimeExplorationThreadGraphProjectionViewTurnRowSchema),
	threads: z.array(
		z.object({
			thread: runtimeExplorationThreadSchema,
			primaryTopic: runtimeExplorationThreadGraphTopicSchema.nullable(),
			turnCount: z.number(),
		}),
	),
	laneCount: z.number(),
	staleReason: z.enum(["new_turns_not_yet_placed", "turn_source_signature_changed"]).nullable(),
	unplacedTurnCountBySession: z.record(z.string(), z.number()),
	lastMaintenanceJobCompletedAt: z.number().nullable(),
	lastMaintenanceJobUsage: runtimeExplorationThreadGraphMaintenanceJobUsageSchema.nullable(),
	anyTurnSourceIsTranscriptReconstructed: z.boolean(),
});
export type RuntimeExplorationThreadGraphProjectionView = z.infer<
	typeof runtimeExplorationThreadGraphProjectionViewSchema
>;

// 单个 exploration 的整张图变更广播（全量替换）。与 findings 同款：作业落盘成功后才发，
// 断连窗口不补发，客户端重连后靠 getExplorationThreadGraph 重查对齐。
export const runtimeStateStreamExplorationThreadGraphUpdatedMessageSchema = z.object({
	type: z.literal("exploration_thread_graph_updated"),
	workspaceId: z.string(),
	explorationId: z.string(),
	view: runtimeExplorationThreadGraphProjectionViewSchema,
});
export type RuntimeStateStreamExplorationThreadGraphUpdatedMessage = z.infer<
	typeof runtimeStateStreamExplorationThreadGraphUpdatedMessageSchema
>;

// 程序化投递的诚实回执。取值集合与语义由跨仓契约固定（terminal-delivery-interface-contract.md），
// 唯一真相在 src/core/task-message-injection-ledger.ts —— 这里只是把 runtime 的**即时**判定带回 CLI，
// 让 CLI 能立刻落一个不撒谎的初始状态；终态由 runtime 事后就地改写账本。
// 定义在排队投递一节之前（而不是挨着 runtimeTaskChatSendResponseSchema）：排队条目要内嵌这份回执，
// 而 zod schema 是模块求值期的值，后定义先引用会撞 TDZ。
export const terminalDeliveryStatusSchema = z.enum([
	"delivered_and_submit_confirmed",
	"delivered_queued_behind_active_agent_turn",
	"accepted_pending_submit_confirmation",
	"delivery_failed",
]);
export type TerminalDeliveryStatus = z.infer<typeof terminalDeliveryStatusSchema>;

export const terminalDeliveryFailureReasonSchema = z.enum([
	"no_active_terminal_session",
	"terminal_prompt_readiness_timeout",
	"submit_confirmation_budget_exhausted",
	"codex_native_prompt_delivery_unconfirmed",
	"human_terminal_contention_timeout",
	// 框被占着但人不在场、且机器拿不下这个框。语义与「可否重投」见
	// task-message-injection-ledger.ts 的同名条目（那里是唯一真相）。
	"terminal_input_box_contended_but_unstashable",
	"agent_awaiting_user_decision_timeout",
	"superseded_by_later_delivery",
	"session_ended_before_delivery",
	"cancelled_before_delivery",
	"runtime_restarted_before_confirmation",
	"native_independent_user_turn_capability_unavailable",
	"native_independent_user_turn_session_replaced",
]);
export type TerminalDeliveryFailureReason = z.infer<typeof terminalDeliveryFailureReasonSchema>;

export const codexNativePromptDeliveryEvidenceSchema = z.object({
	clientUserMessageId: z.string(),
	nativeSessionId: z.string(),
	nativeTurnId: z.string(),
	nativeUserMessageId: z.string(),
});
export type CodexNativePromptDeliveryEvidence = z.infer<typeof codexNativePromptDeliveryEvidenceSchema>;

export const codexNativePromptAcceptanceHistoryQueryProgressSchema = z.object({
	nextCursor: z.string().nullable(),
	queriedCursorSha256s: z.array(z.string().length(64)),
	lastQueryStatus: z.enum(["pending", "history_exhausted", "cursor_read_failed", "cursor_cycle_detected"]),
});
export type CodexNativePromptAcceptanceHistoryQueryProgress = z.infer<
	typeof codexNativePromptAcceptanceHistoryQueryProgressSchema
>;

export const codexNativePromptDeliveryOperationSchema = z.object({
	requestOriginRuntimeProcessInstanceId: z.string().optional(),
	lastAcceptanceReconciliationRuntimeProcessInstanceId: z.string().optional(),
	clientUserMessageId: z.string().min(1),
	workspaceId: z.string().min(1),
	conversationSessionId: z.string().min(1),
	nativeSessionId: z.string().min(1),
	workingDirectoryPath: z.string().min(1),
	promptSha256: z.string().min(1),
	sendPhase: z.enum(["registered", "request_intent_persisted", "request_invoked", "native_accepted"]),
	actualSendAttemptCount: z.number().int().nonnegative().max(3),
	previousTurnId: z.string().nullable(),
	returnedTurnId: z.string().nullable(),
	acceptanceHistoryQueryProgress: codexNativePromptAcceptanceHistoryQueryProgressSchema.optional(),
	historicalAcceptanceEvidence: codexNativePromptDeliveryEvidenceSchema.optional(),
	lastAcceptanceReconciliationAtIso: z.string().optional(),
	lastAcceptanceReconciliationStatus: z.enum(["confirmed", "unknown"]).optional(),
	currentExecutionQualification: z
		.enum([
			"current_native_conversation_matches",
			"current_native_conversation_changed",
			"current_native_control_unavailable",
		])
		.optional(),
	updatedAtIso: z.string(),
});
export type CodexNativePromptDeliveryOperation = z.infer<typeof codexNativePromptDeliveryOperationSchema>;

export const terminalDeliveryReceiptSchema = z.object({
	status: terminalDeliveryStatusSchema,
	reason: terminalDeliveryFailureReasonSchema.nullable(),
	failureNote: z.string().optional(),
	codexNativePromptDeliveryEvidence: codexNativePromptDeliveryEvidenceSchema.optional(),
});
export type TerminalDeliveryReceipt = z.infer<typeof terminalDeliveryReceiptSchema>;

// 注入账本（跨仓契约）里能出现的失败原因全集 = 终端投递回执能报的那些 + agent 空闲门（排队层）自己判的两个。
// 后两个**永远不会**由终端投递产生——终端门不认识「agent 有没有空闲」——所以不进上面那个 transport 枚举，
// 免得 session-manager 的回执类型凭空多出两个它不可能产生的取值。唯一真相仍是 task-message-injection-ledger.ts。
export const injectionLedgerTerminalDeliveryFailureReasonSchema = z.enum([
	...terminalDeliveryFailureReasonSchema.options,
	// 带 --deliver-when-agent-idle 的投递到调用方给的等待上限为止 agent 一直没空闲，一次都没交给终端投递。
	"agent_never_became_idle_before_queued_delivery_deadline",
	// 带 --deliver-when-agent-idle 的投递入队即被拒：排队容量（per-task / per-workspace 非终态条目上限）用尽。
	"agent_idle_gated_delivery_queue_capacity_exhausted",
]);
export type InjectionLedgerTerminalDeliveryFailureReason = z.infer<
	typeof injectionLedgerTerminalDeliveryFailureReasonSchema
>;

export const injectionLedgerTerminalDeliveryReceiptSchema = z.object({
	status: terminalDeliveryStatusSchema,
	reason: injectionLedgerTerminalDeliveryFailureReasonSchema.nullable(),
	failureNote: z.string().optional(),
	codexNativePromptDeliveryEvidence: codexNativePromptDeliveryEvidenceSchema.optional(),
});
export type InjectionLedgerTerminalDeliveryReceipt = z.infer<typeof injectionLedgerTerminalDeliveryReceiptSchema>;

// ── 排队 Prompt 投递（Queued Task Prompt Delivery，服务端持久化）───────────────
//
// 「agent 正在干活时我就想好了下一步要它做什么」这件事今天没有落点：Prompt Library 只能
// Fill into input（写进输入框、不提交），于是用户要么现在打断 agent，要么自己盯着等它停下来再手动发。
// 本节把这条意图变成 durable 记录：入队 → agent 这一轮停下 → 经既有 sendTaskChatMessage 出口发出。
//
// 落点与并发语义见 src/state/queued-task-prompt-delivery-store.ts；出队时机与门控见
// src/core/queued-task-prompt-delivery-dispatch-eligibility.ts。这里只定义线上契约。
//
// **v1 明确不支持**（写在契约里而不是只写在计划里，免得后来者假设它静默支持）：
//   - images：入队的是纯文本快照，附件不进队列；
//   - mode 透传（Cline SDK 的 plan / act）：投递时按会话当下的 mode 走，不冻结入队那一刻的 mode。
//
// **加字段规约**：v1 之后新增的每一个字段都必须是 optional。存储层是逐条 safeParse、坏条目直接丢，
// 于是「新版加了个必填字段」会让所有旧条目在下一次读取时集体消失——那是用户排好的队被静默清空。

export const queuedTaskPromptDeliveryStateSchema = z.enum([
	// 等下一个「agent 停止生成」边沿。绝大多数时刻的状态。
	"queued",
	// dispatcher 已在文件锁内认领，尚未写出任何字节。崩溃后可安全释放回 queued。
	"claimed_for_dispatch",
	// 已交给 sendTaskChatMessage，回执未回。崩溃后语义暧昧（可能已经发出去了），绝不自动重投。
	"handed_to_transport",
	"settled_delivered",
	"settled_failed",
	"cancelled",
	// 超过 expiresAt 仍未发出。**不是失败**：它从未被尝试过，只是意图放太久已经不可信了。
	"expired",
]);
export type QueuedTaskPromptDeliveryState = z.infer<typeof queuedTaskPromptDeliveryStateSchema>;

// 出队被什么挡住。服务端给枚举值、前端只做措辞映射——判据全在运行时侧（会话 facet、恢复守卫、
// PTY 单飞槽），前端复算必然漂移。
export const queuedTaskPromptDispatchBlockReasonSchema = z.enum([
	"awaiting_native_independent_user_turn_query_retry",
	// kanban 重启跨过来的条目，人还没在重启后看见过它。**唯一一条不会自行解除**的阻塞。
	"awaiting_human_reconfirmation_after_runtime_restart",
	"agent_still_generating",
	// 已 park、正在等待已派发的后台工作。必须单列：submitTaskChatInputWhenReady 一进门就 unpark，
	// 不拦就等于队列会把 RVF 派发的后台等待直接 unpark 掉。
	"session_parked_awaiting_dispatched_background_work",
	// agent 在问问题 / 等计划评审 / 等授权 / 等补充输入。**不含 review**——review 恰是本特性的目标态。
	"agent_awaiting_modal_user_decision",
	// 会话不在跑（含 runtime 重启后水合出来的历史会话）。保持 queued 不判失败：用户要的是「下一轮」，
	// 死会话没有下一轮，但它随时可能被续跑起来。
	"session_not_live",
	// PTY 恢复守卫武装中（`--continue` 恢复对话本身不等于开始新一轮）。
	"session_restoring_conversation",
	"task_main_session_handover_awaiting_user",
	// PTY 单飞槽被另一条程序化投递（例：RVF followup）占着。
	"another_programmatic_delivery_in_flight",
	// 这条由**另一个此刻活着的** kanban runtime 实例托管（同机多实例共享 workspaces 根）。只有托管者会发它；
	// 托管者一旦不在心跳里，本实例会盖 restart-crossing 章并接管，转成上面那条「等人确认」。
	"queued_under_another_live_kanban_runtime_instance",
	// 跨过重启、人也确认过了，但 agent 在确认之后还没停下过一次。用户要的是「确认后在**下一次** stop hook
	// 注入」——确认那一刻 agent 已经闲着，不等于「下一次 stop」已经到了。
	"awaiting_first_agent_turn_end_after_restart_reconfirmation",
]);
export type QueuedTaskPromptDispatchBlockReason = z.infer<typeof queuedTaskPromptDispatchBlockReasonSchema>;

export const managedTaskPromptDeliveryMessageTypeSchema = z.enum([
	"human_message",
	"prompt_library",
	"programmatic_injection",
	"task_action",
	"session_startup",
	"user_decision_answer",
	"system_continuation",
]);
export type ManagedTaskPromptDeliveryMessageType = z.infer<typeof managedTaskPromptDeliveryMessageTypeSchema>;

// 显示来源与 source 的后台让位语义独立，人工消息的标签不改变投递权限。
export const managedTaskPromptDeliveryOriginSchema = z.object({
	messageType: managedTaskPromptDeliveryMessageTypeSchema,
	sourceLabel: z.string().optional(),
});
export type ManagedTaskPromptDeliveryOrigin = z.infer<typeof managedTaskPromptDeliveryOriginSchema>;

export const managedTaskPromptDeliveryMetadataSchema = z.object({
	messageType: managedTaskPromptDeliveryMessageTypeSchema,
	deliveryStrategy: z.enum(["immediate", "after_agent_turn", "session_startup"]),
	sourceLabel: z.string().nullable(),
	imageAttachmentCount: z.number().int().nonnegative(),
	// 仅保存按附件顺序计算的内容摘要；旧记录缺省，缺失时不能宣称有图请求相同。
	imageAttachmentContentsSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.optional(),
	cancellationSupported: z.boolean().optional(),
	terminalDeliveryReceipt: injectionLedgerTerminalDeliveryReceiptSchema.nullable(),
	targetRuntimeSessionIncarnationId: z.string().nullable().optional(),
	targetNativeSessionId: z.string().nullable().optional(),
	injectionLedgerReference: z.object({ taskId: z.string(), idempotencyKey: z.string() }).optional(),
	recoveredTerminalReceiptAtEpochMs: z.number().optional(),
	previousUnconfirmedTerminalDeliveryReceipt: injectionLedgerTerminalDeliveryReceiptSchema.nullable().optional(),
	previousUnconfirmedDeliveryFailureNote: z.string().nullable().optional(),
});
export type ManagedTaskPromptDeliveryMetadata = z.infer<typeof managedTaskPromptDeliveryMetadataSchema>;

const nativeIndependentUserTurnQueryRecoverySchema = z.object({
	consecutiveQueryFailureCount: z.number().int().positive(),
	waitingStartedAtEpochMs: z.number(),
	lastQueryFailureAtEpochMs: z.number(),
	lastQueryFailureReason: z.string(),
	nextQueryRetryAtEpochMs: z.number().nullable(),
	recoveredAtEpochMs: z.number().nullable(),
});

export const queuedTaskPromptDeliveryEntrySchema = z.object({
	// 旧条目缺省是等待队列，即时及启动消息不进入 idle 调度。
	managedDelivery: managedTaskPromptDeliveryMetadataSchema.optional(),
	// 新字段可选；旧 handed_to_transport 条目缺少零写入证明时，仍按未知处理。
	nativeIndependentUserTurnSubmissionProgress: z
		.object({
			predecessorNativeTurnId: z.string().min(1),
			submissionMayHaveStartedAtEpochMs: z.number().nullable(),
		})
		.optional(),
	nativeIndependentUserTurnBeforeSubmissionQueryRecovery: nativeIndependentUserTurnQueryRecoverySchema.optional(),
	// 只恢复尚未认领、未写入 transport 的查询；可选字段保证旧队列继续可读。
	nativeIndependentUserTurnPreflightQueryRecovery: nativeIndependentUserTurnQueryRecoverySchema.optional(),
	// 取消 / 重排 / 合并的唯一句柄。由构造 mutation 的一侧生成（randomUUID），于是同一条意图重发天然幂等。
	queueEntryId: z.string(),
	// **会话 id**，不是看板卡片 id：by-the-way 子会话有自己独立的队列。
	taskId: z.string(),
	// 正文快照，**入队即冻结**。
	//
	// 为什么不只存 promptLibraryEntryId 到出队时再解析：prompt library 条目是可变的用户资产——面板
	// textarea 每次击键都去抖落盘，还能被删、被换 scope、被另一个标签页改写。出队时才解析 = 用户排的是
	// A、agent 收到 B，而没有任何一处会告诉他。
	text: z.string(),
	// 为 true 时本条与**下一条**在同一次投递里拼接发出（相邻可链成一串）。默认 false ⇒ 串长恒为 1
	// ⇒ 就是「一轮一条」。合并是用户显式打开的开关，运行时绝不自作主张合并。
	deliverTogetherWithNextQueuedEntry: z.boolean(),
	// 溯源用。命中时 UI 显示来源徽标；sha 与库里那条此刻的正文不符时标「library prompt has changed since」。
	// 只是**诚实提示**，不改变投递内容——投的永远是上面那份冻结快照。
	sourcePromptLibraryEntryId: z.string().nullable(),
	sourcePromptLibraryEntryTextSha256: z.string().nullable(),
	deliveryState: queuedTaskPromptDeliveryStateSchema,
	deliveryAttemptCount: z.number().int().nonnegative(),
	lastAttemptedAt: z.number().nullable(),
	settledAt: z.number().nullable(),
	// 本次在途尝试的 key，取消时喂给既有 cancelTaskChatDelivery。每次重试换新的。
	dispatchIdempotencyKey: z.string().nullable(),
	// 认领那一刻的会话身份双判据快照。真正 send 之前重读 summary 比对，任一不符即释放认领、放弃本次
	// （不计一次尝试）。口径与 isReclamationDeadlineStillCurrentForSession 同源。
	claimedForSessionIncarnationId: z.string().nullable(),
	claimedAtTurnSequence: z.number().int().nonnegative().nullable(),
	enqueuedAt: z.number(),
	// enqueuedAt + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS。存绝对时刻而非剩余时长，故停机期间流逝的
	// 墙钟时间自然计入——系统关机三天再开机，条目已过期，不会突然发射。
	expiresAt: z.number(),
	// 人类可读，前端直接显示。
	lastDeliveryFailureNote: z.string().nullable(),
	// null = 本条没有跨过任何一次 runtime 重启；非 null = 启动清扫判定它的托管实例已经不在了（它确实跨过了
	// 一次重启），于是盖上这个章。判据是 custodianRuntimeProcessInstanceId 指向的实例此刻不在心跳里，
	// 而不是「本进程刚起来」——一台机器上会同时跑多个 runtime（dev:full / dogfood / 集成测试），按进程判
	// 会让第二个实例一启动就把常驻实例的队列全标一遍。
	survivedRuntimeRestartAtEpochMs: z.number().nullable(),
	// 人在重启后确实看见过它的时刻。上一字段非 null 且这一字段为 null ⇒ 门控硬阻塞。
	humanReconfirmedAfterRuntimeRestartAtEpochMs: z.number().nullable(),
	// **此刻托管这条队列条目的** runtime 进程实例 id（见 src/state/runtime-process-instance-heartbeat-registry.ts）。
	//
	// 存在的唯一理由是让启动清扫能分辨「上一次生命周期留下的残骸」与「另一个此刻正活着的实例正在用的
	// 东西」——一台机器上会同时跑常驻实例 / dev:full / dogfood / 集成测试，它们共享同一个 workspaces 根。
	// 判据因此是「托管者此刻不活着」，而不是「条目比本进程老」。
	//
	// **是托管权，不是出身**，两者的区别是这个字段能不能用对的关键：托管权会**转移**。入队时归入队的
	// 那个实例；此后每当一次清扫判定「托管者已死、这条确实跨过了重启」并盖章，托管权就交给做这次清扫的
	// 实例。不转移的话，条目会永久指向那个最初排队、后来死掉的实例，于是**任何**一个启动时刻晚于上次
	// 盖章的并存实例都会再判一次「托管者不活跃」、重新盖章并清空用户刚做的确认——正是这个字段被引入来
	// 消除的多实例误标，只是换了个触发条件卷土重来。字段名不叫 enqueuedBy… 就是为了不让人照出身去读它。
	//
	// optional（遵守本节开头那条加字段规约）：升级前存下的条目没有这个字段，清扫对它们退回按年龄判的
	// 保守口径——多盖一次章、多让人确认一次，绝不漏盖；盖完同样接管托管权，于是只会退化这一次。
	custodianRuntimeProcessInstanceId: z.string().nullable().optional(),
	// 该会话所属的**看板任务** id。主会话等于 taskId；by-the-way 子会话是它的主任务。存它是为了主任务离开看板时
	// 把子会话的队列一并丢弃——删除路径（浏览器整份 PUT 的差集 / CLI delete）手上只有看板任务 id。
	// optional（加字段规约）：旧条目缺它时只按 taskId 精确匹配。
	workspaceTaskId: z.string().nullable().optional(),
	// 非 null = 这条是**程序化投递**（`kanban task message --deliver-when-agent-idle`，例：RVF 决策点边界标记），
	// 在注入账本（task-message-injections.json，跨仓契约）里有一条同 key 的四态回执记录。null / 缺省 = 人排的。
	// 语义与人排的条目有三处刻意不同（详见 .plan/docs/queued-task-prompt-delivery-semantics.md 的程序化一节）：
	//   - 一次定终身：交给终端投递之后的回执就是终态，**绝不**回队首等下一轮（调用方有自己的重试与 key）；
	//   - 不跨重启：托管实例死了就落 settled_failed，不盖「等人确认」的章（那是给人看的）；
	//   - 永不合并：正文要逐字发出，合并开关在它两侧都不生效。
	// expiresAt 对它而言就是调用方给的「最多等 agent 空闲多久」的截止时刻。
	requiredNativeIndependentUserTurnSessionId: z.string().min(1).optional(),
	requiredNativeIndependentUserTurnSessionIncarnationId: z.string().min(1).optional(),
	programmaticInjectionLedgerReceiptLink: z
		.object({
			// 账本记录的 idempotency key（= 调用方传的 --idempotency-key）。交给终端投递时也用它，
			// 于是交出之后的取消 / 回执与不带 flag 的 `kanban task message` 逐字相同。
			injectionLedgerIdempotencyKey: z.string(),
			// 调用方的宿主 Task ID；旧条目缺省时仍等于条目的真实 session ID。
			injectionLedgerTaskId: z.string().optional(),
			// 调用方的 --source。交给终端投递时原样带上。
			injectionSource: z.string(),
			// 条目落终态那一刻要镜像进账本的回执。只有出队引擎拿到真实终端回执时才写；其余落定路径
			// （取消 / 过期 / 重启 / 撂下）的回执由落定后的 deliveryState 推出来，见
			// src/core/queued-programmatic-injection-ledger-receipt-mirroring.ts。
			settledTerminalDeliveryReceipt: injectionLedgerTerminalDeliveryReceiptSchema.nullable(),
		})
		.nullable()
		.optional(),
});
export type QueuedTaskPromptDeliveryEntry = z.infer<typeof queuedTaskPromptDeliveryEntrySchema>;
export type QueuedTaskPromptDeliveryProgrammaticInjectionLedgerReceiptLink = NonNullable<
	QueuedTaskPromptDeliveryEntry["programmaticInjectionLedgerReceiptLink"]
>;

// 一个 workspace 下全部任务的队列。顺序即投递顺序（数组下标就是排位），不另存 order 字段——
// 存序号会产生「序号重复 / 有洞 / 与数组顺序打架」三种必须再写代码去调和的坏状态。
export const workspaceQueuedTaskPromptDeliverySnapshotSchema = z.object({
	entriesByTaskId: z.record(z.string(), z.array(queuedTaskPromptDeliveryEntrySchema)),
});
export type WorkspaceQueuedTaskPromptDeliverySnapshot = z.infer<typeof workspaceQueuedTaskPromptDeliverySnapshotSchema>;

// 写操作是**意图**而不是整份 PUT，理由同 prompt library：多个标签页 + 运行时自己（dispatcher）会并发写
// 同一份队列，整份 PUT 的 last-write-wins 会静默抹掉别人的写。服务端在文件锁内读-改-写。
export const queuedTaskPromptDeliveryMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("enqueue_prompt_for_delivery_after_current_turn"),
		taskId: z.string(),
		queueEntryId: z.string(),
		text: z.string(),
		sourcePromptLibraryEntryId: z.string().nullable().optional(),
		sourcePromptLibraryEntryTextSha256: z.string().nullable().optional(),
		// 见条目的同名字段。缺省按 taskId（主会话）。
		workspaceTaskId: z.string().nullable().optional(),
	}),
	z.object({
		kind: z.literal("cancel_queued_prompt_delivery"),
		taskId: z.string(),
		queueEntryId: z.string(),
	}),
	// 携**完整有序 id 列表**而不是「把 X 移到位置 N」：后者在并发下会算到别人刚改过的列表上，
	// 得到一个谁也没要过的顺序。服务端在锁内按「取交集 + 未知 id 追加到尾」调和。
	z.object({
		kind: z.literal("reorder_queued_prompt_deliveries"),
		taskId: z.string(),
		orderedQueueEntryIds: z.array(z.string()),
	}),
	z.object({
		kind: z.literal("set_queued_prompt_delivery_merge_with_next"),
		taskId: z.string(),
		queueEntryId: z.string(),
		deliverTogetherWithNextQueuedEntry: z.boolean(),
	}),
	z.object({
		kind: z.literal("dismiss_settled_queued_prompt_delivery"),
		taskId: z.string(),
		queueEntryId: z.string(),
	}),
	// 重排到队尾，换新 queueEntryId + 新 idempotency key。**由人发起，永不自动**：
	// settled_failed 里那几种失败（尤其 submit_confirmation_budget_exhausted）的语义是「可能已经送到了」，
	// 自动重投 = 把同一段话送两次。
	z.object({
		kind: z.literal("retry_settled_failed_queued_prompt_delivery"),
		taskId: z.string(),
		queueEntryId: z.string(),
		replacementQueueEntryId: z.string(),
	}),
	// 「人在 kanban 重启后确实看见了这些条目」。幂等，只写 humanReconfirmedAfterRuntimeRestartAtEpochMs。
	z.object({
		kind: z.literal("reconfirm_queued_prompt_deliveries_after_runtime_restart"),
		taskId: z.string(),
		queueEntryIds: z.array(z.string()),
	}),
]);
export type QueuedTaskPromptDeliveryMutation = z.infer<typeof queuedTaskPromptDeliveryMutationSchema>;

// 推流投影：**不是**全量条目。正文是易膨胀数据，与 board.json 的裁定同理，绝不上热广播链路——
// 用 textPreview + textLength 替代 text，全文按需经 read procedure 拉。也因此它不进 snapshot 消息。
export const QUEUED_TASK_PROMPT_DELIVERY_TEXT_PREVIEW_MAX_LENGTH = 200;

export const runtimeQueuedTaskPromptDeliveryProjectionSchema = z.object({
	deliveryId: z.string().optional(),
	managedDelivery: managedTaskPromptDeliveryMetadataSchema.optional(),
	nativeIndependentUserTurnSubmissionProgress:
		queuedTaskPromptDeliveryEntrySchema.shape.nativeIndependentUserTurnSubmissionProgress,
	nativeIndependentUserTurnBeforeSubmissionQueryRecovery:
		queuedTaskPromptDeliveryEntrySchema.shape.nativeIndependentUserTurnBeforeSubmissionQueryRecovery,
	nativeIndependentUserTurnPreflightQueryRecovery:
		queuedTaskPromptDeliveryEntrySchema.shape.nativeIndependentUserTurnPreflightQueryRecovery,
	queueEntryId: z.string(),
	taskId: z.string(),
	deliveryState: queuedTaskPromptDeliveryStateSchema,
	textPreview: z.string(),
	textLength: z.number().int().nonnegative(),
	deliverTogetherWithNextQueuedEntry: z.boolean(),
	// 仅对 queued 条目有意义：此刻是什么挡着它。null = 此刻可以出队（下一个边沿就发）。
	dispatchBlockReason: queuedTaskPromptDispatchBlockReasonSchema.nullable(),
	// 前端靠它决定要不要播 5s 高亮、要不要发确认 mutation。
	awaitsHumanReconfirmationAfterRuntimeRestart: z.boolean(),
	deliveryAttemptCount: z.number().int().nonnegative(),
	// 真正交给 transport 时的开始时间；旧 runtime 投影缺省时保留未知，不冒充结束时间。
	lastAttemptedAt: z.number().nullable().optional(),
	lastDeliveryFailureNote: z.string().nullable(),
	sourcePromptLibraryEntryId: z.string().nullable(),
	// true = 库里那条的正文在入队之后被改过；null = 没有来源条目，或来源条目已被删。
	// 由服务端比对 sha 算好——前端手上没有库条目的 sha，让它自己算等于让它撒谎。
	sourcePromptLibraryEntryTextChangedSinceEnqueue: z.boolean().nullable(),
	enqueuedAt: z.number(),
	expiresAt: z.number(),
	settledAt: z.number().nullable(),
	// 非 null = 程序化投递（例：RVF），值是调用方的 --source。前端据此挂来源徽标、关掉它两侧的合并开关。
	programmaticInjectionSource: z.string().nullable().optional(),
});
export type RuntimeQueuedTaskPromptDeliveryProjection = z.infer<typeof runtimeQueuedTaskPromptDeliveryProjectionSchema>;

// 按 taskId 分组的投影。推流消息与读写响应共用这一个形状，前端只维护一份合并逻辑。
export const runtimeQueuedTaskPromptDeliveryProjectionsByTaskIdSchema = z.record(
	z.string(),
	z.array(runtimeQueuedTaskPromptDeliveryProjectionSchema),
);
export type RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId = z.infer<
	typeof runtimeQueuedTaskPromptDeliveryProjectionsByTaskIdSchema
>;

export const runtimeTaskPromptDeliveryQueueReadRequestSchema = z.object({});
export type RuntimeTaskPromptDeliveryQueueReadRequest = z.infer<typeof runtimeTaskPromptDeliveryQueueReadRequestSchema>;

// 读响应同时给全量快照（带正文，按需展开全文用）与投影（带阻塞原因，列表渲染用）。
// 阻塞原因只有运行时算得出来（会话 facet / 恢复守卫 / PTY 单飞槽），首屏拉取不带它的话，
// 面板在第一条推流到达之前只能显示一个撒谎的「马上就发」。
export const runtimeTaskPromptDeliveryQueueResponseSchema = z.object({
	ok: z.boolean(),
	queue: workspaceQueuedTaskPromptDeliverySnapshotSchema.nullable(),
	projectedEntriesByTaskId: runtimeQueuedTaskPromptDeliveryProjectionsByTaskIdSchema.nullable(),
	// 按需读取时提供真实实例路径；旧 runtime 缺省时前端仍可复制已知标识。
	queuedTaskPromptDeliveryDebugReferenceContext: z
		.object({
			workspaceId: z.string(),
			workspaceProjectPath: z.string(),
			queuedTaskPromptDeliveriesFilePath: z.string(),
			taskMessageInjectionLedgerFilePath: z.string(),
		})
		.nullable()
		.optional(),
	error: z.string().optional(),
});
export type RuntimeTaskPromptDeliveryQueueResponse = z.infer<typeof runtimeTaskPromptDeliveryQueueResponseSchema>;

export const runtimeTaskPromptDeliveryQueueMutateRequestSchema = z.object({
	mutation: queuedTaskPromptDeliveryMutationSchema,
});
export type RuntimeTaskPromptDeliveryQueueMutateRequest = z.infer<
	typeof runtimeTaskPromptDeliveryQueueMutateRequestSchema
>;

// 取消一条**已经交给 transport** 的条目时，既有 cancelTaskChatDelivery 的三种回执原样带回。
// already_delivered 必须让用户看见（「来不及了，已经发出去」）——把它吞成 ok 等于对用户撒谎。
export const queuedTaskPromptInFlightDeliveryCancelResultSchema = z.enum([
	"cancelled_before_delivery",
	"already_delivered",
	"no_pending_delivery",
]);
export type QueuedTaskPromptInFlightDeliveryCancelResult = z.infer<
	typeof queuedTaskPromptInFlightDeliveryCancelResultSchema
>;

export const runtimeTaskPromptDeliveryQueueMutateResponseSchema = runtimeTaskPromptDeliveryQueueResponseSchema.extend({
	// 入队 / 重排被拒是因为队列容量用尽（该任务或整个 workspace 的非终态条目达到上限）。被拒在快照上表现为
	// 「原样返回」，与幂等重发不可区分——必须单独说出来，否则用户会以为排上了。
	enqueueRefusedBecauseQueueCapacityIsExhausted: z.boolean().optional(),
	// 仅当取消的目标已经 handed_to_transport 时才有值。
	inFlightDeliveryCancelResult: queuedTaskPromptInFlightDeliveryCancelResultSchema.nullable().optional(),
});
export type RuntimeTaskPromptDeliveryQueueMutateResponse = z.infer<
	typeof runtimeTaskPromptDeliveryQueueMutateResponseSchema
>;

// 程序化入队（`kanban task message --deliver-when-agent-idle`）。由 runtime **一次调用里**先落账本 pending 记录、
// 再入队——不让 CLI 先写账本：CLI 在两步之间被杀，就会留下一条没有队列条目、却也没人来收敛的 pending。
// 收敛有界性：pending 必然在 agentIdleWaitDeadline + 终端投递最坏预算之内落终态。
export const runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	source: z.string(),
	idempotencyKey: z.string(),
	promptSha256: z.string(),
	// 显式目标会话，必须属于 taskId 指定的卡片；省略时固定受理时的当前主会话。
	attemptId: z.string().optional(),
	// 最多等 agent 空闲多久。上限（24h）在 runtime 侧校验，契约这里只要求正整数。
	maxWaitForAgentIdleMs: z.number().int().positive(),
	requiredNativeIndependentUserTurnSessionId: z.string().min(1).optional(),
});
export type RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest = z.infer<
	typeof runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequestSchema
>;

export const runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponseSchema = z.object({
	ok: z.boolean(),
	// 账本里这条记录是本次新建的，还是同 key 早已存在（幂等重发）。仅 ok 时有。
	injectionLedgerRecordDisposition: z.enum(["created", "already_existed"]).optional(),
	// 同 key 已存在但正文 hash 不同。与 `kanban task message` 的幂等冲突同义，CLI 据此报同一句错。
	idempotencyConflict: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse = z.infer<
	typeof runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponseSchema
>;

// 队列投影变更推流。**不进** snapshot 消息（正文与状态都以机器节拍变化，且首屏由读 procedure 拉）。
// 按 workspace 整份替换而不是按条增量：一次认领 / 落定会同时改好几条的状态与阻塞原因，增量补丁
// 在断连重连之间极易错位，而投影恒小（per-task 上限 20、per-workspace 上限 200、正文已截断）。
export const runtimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessageSchema = z.object({
	type: z.literal("queued_task_prompt_deliveries_updated"),
	workspaceId: z.string(),
	projectedEntriesByTaskId: runtimeQueuedTaskPromptDeliveryProjectionsByTaskIdSchema,
});
export type RuntimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessage = z.infer<
	typeof runtimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessageSchema
>;

// 按卡片聚合的实时资源占用快照（按 task 归因的资源占用采集，S4）。由运行时的进程树采样器每 15 秒产出，
// 只在内存里、不进 session summary（否则会随 summary 落 sessions.json、触发观察器与项目广播）。
// RSS 求和是上界（共享页重复计数），footprint 才是整机真实代价（低频采样，可能为 null）。
export const runtimeLiveTaskResourceUsageSnapshotSchema = z.object({
	workspaceId: z.string(),
	// null = workspace 级会话（home agent、首页终端）。
	attributedTaskCardId: z.string().nullable(),
	sampledAtEpochMs: z.number(),
	attributedProcessCount: z.number().int().nonnegative(),
	residentSetSizeKibibytesSumUpperBound: z.number().nonnegative(),
	// 以「单核 = 100%」计；没有可比的上一读数时为 null。
	cpuPercentOfOneCoreOverLastSampleInterval: z.number().nonnegative().nullable(),
	// 会话根进程已退出、仍在跑的残留进程（孤儿）。
	survivedSessionRootExitProcessCount: z.number().int().nonnegative(),
	survivedSessionRootExitResidentSetSizeKibibytesSum: z.number().nonnegative(),
	agentHarnessRootPhysicalFootprintBytes: z.number().nonnegative().nullable(),
	processCountByProcessClassification: z.record(z.string(), z.number()),
	residentSetSizeKibibytesSumUpperBoundByProcessClassification: z.record(z.string(), z.number()),
	mcpServerInstances: z.array(
		z.object({
			mcpServerInstanceLabel: z.string(),
			processCount: z.number().int().nonnegative(),
			residentSetSizeKibibytesSum: z.number().nonnegative(),
		}),
	),
	// 该卡各终端 agent 会话（Claude Code / Codex）的累计模型 token，由 token 用量监视器每 5 分钟刷新；
	// 进程内 Cline SDK / ACP 的用量只进 journal，不在这里。还没读到过时为 null。
	modelTokenUsageAcrossTaskSessions: z
		.object({
			sessionCount: z.number().int().nonnegative(),
			cumulativeInputTokens: z.number().nonnegative(),
			cumulativeCacheCreationInputTokens: z.number().nonnegative(),
			cumulativeCacheReadInputTokens: z.number().nonnegative(),
			cumulativeOutputTokens: z.number().nonnegative(),
		})
		.nullable()
		.optional(),
	// 该卡 worktree 最近一次测得的实体磁盘体积（不跟随符号链接），每 24 小时最多量一次。
	latestWorktreeDiskUsageBytes: z.number().nonnegative().nullable().optional(),
});
export type RuntimeLiveTaskResourceUsageSnapshot = z.infer<typeof runtimeLiveTaskResourceUsageSnapshotSchema>;

// 某 workspace 全部卡片的实时资源快照（全量替换）。每个采样 tick 发一次；hub 缓存最近一份，
// 新客户端连上后立即补发，所以首屏不必等下一个 tick。
export const runtimeStateStreamTaskResourceUsageSnapshotsUpdatedMessageSchema = z.object({
	type: z.literal("task_resource_usage_snapshots_updated"),
	workspaceId: z.string(),
	snapshots: z.array(runtimeLiveTaskResourceUsageSnapshotSchema),
});
export type RuntimeStateStreamTaskResourceUsageSnapshotsUpdatedMessage = z.infer<
	typeof runtimeStateStreamTaskResourceUsageSnapshotsUpdatedMessageSchema
>;

export const runtimeStateStreamPromptLibraryUpdatedMessageSchema = z.object({
	type: z.literal("prompt_library_updated"),
	// null 表示全局条目变化，全部项目都需失效；正文始终按需读取。
	workspaceId: z.string().nullable(),
});

export const runtimeStateStreamDailyWorkProgressStatisticsUpdatedMessageSchema = z.object({
	type: z.literal("daily_work_progress_statistics_updated"),
	revision: z.number().int().nonnegative(),
});
export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamDailyWorkProgressStatisticsUpdatedMessageSchema,
	taskVisualizationArtifactsUpdatedMessageSchema,
	taskVisualizationPreviewRequestedMessageSchema,
	z.object({
		type: z.literal("task_lookup_conversation_updated"),
		conversationId: z.string().uuid(),
		revision: z.number().int(),
	}),
	runtimeStateStreamPromptLibraryUpdatedMessageSchema,
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamTaskChatMessageSchema,
	runtimeStateStreamTaskChatClearedMessageSchema,
	runtimeStateStreamMcpAuthUpdatedMessageSchema,
	runtimeStateStreamClineSessionContextUpdatedMessageSchema,
	runtimeStateStreamNotificationLogUpdatedMessageSchema,
	runtimeStateStreamExploratoryFindingsUpdatedMessageSchema,
	runtimeStateStreamExplorationThreadGraphUpdatedMessageSchema,
	runtimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessageSchema,
	runtimeStateStreamTaskResourceUsageSnapshotsUpdatedMessageSchema,
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

// 状态流的每个连接声明「这个连接需要哪些任务 worktree 的 git 元数据」。All projects（Board Scope）下屏幕上只有焦点
// 任务要逐卡 git 状态，跨项目打开任务时只探它，不必等整个项目每张卡的 git 跑完（大项目约 7 秒）。
// 不声明（旧客户端）按整个项目处理。连接时经 WS URL 参数（JSON，参数名与组装规则见
// runtime-state-stream-workspace-metadata-probe-scope-declaration.ts）给出初值，之后经客户端→服务端消息
// declare_workspace_metadata_probe_scope 更新。同一项目多个连接取并集。
export const runtimeWorkspaceMetadataProbeScopeDeclaredByStreamClientSchema = z.discriminatedUnion(
	"workspaceMetadataProbeScopeKind",
	[
		z.object({ workspaceMetadataProbeScopeKind: z.literal("all_tracked_task_worktrees_of_workspace") }),
		z.object({
			// 服务端自动并上 Review 列里开了 auto-review 的卡：自动提交 / 自动 PR 要看它们有没有未提交改动。
			workspaceMetadataProbeScopeKind: z.literal("focused_task_worktrees_plus_auto_review_tasks_in_review_column"),
			focusedTaskIds: z.array(z.string()).max(50),
		}),
	],
);
export type RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient = z.infer<
	typeof runtimeWorkspaceMetadataProbeScopeDeclaredByStreamClientSchema
>;

export const runtimeStateStreamClientDeclareWorkspaceMetadataProbeScopeMessageSchema = z.object({
	type: z.literal("declare_workspace_metadata_probe_scope"),
	workspaceMetadataProbeScope: runtimeWorkspaceMetadataProbeScopeDeclaredByStreamClientSchema,
});
// 浏览器 → 服务端的状态流消息（其余消息都是服务端 → 浏览器）。
export const runtimeStateStreamClientMessageSchema = z.discriminatedUnion("type", [
	taskVisualizationBrowserContextMessageSchema,
	taskVisualizationPreviewAcknowledgmentMessageSchema,
	runtimeStateStreamClientDeclareWorkspaceMetadataProbeScopeMessageSchema,
]);
export type RuntimeStateStreamClientMessage = z.infer<typeof runtimeStateStreamClientMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

// 跨全部注册项目的任务搜索索引（Spotlight 全局搜索「包含其它项目」时按需拉取）。携带「匹配所需字段」
// （taskId + title + prompt + columnId）、「结果行排序/展示所需的卡片级持久事实」（createdAt / updatedAt /
// 两个 agent 归属字段），以及唯一一个来自会话摘要的量：对话上次推进时刻。
// 后者能进快照，是因为它是**历史事实**而非此刻的电平：稳态只前进（`mergeLastConversationProgressObservation`
// 只在持久转录回纠低置信猜测时往回走），快照拉取后最多是「略旧」。刻意**仍然**不含 liveness / 会话状态 /
// 本轮生成状态与工作区 git 元数据：那些是此刻的电平，只对当前项目可得（由 runtime-state-hub 推流），
// 塞进这个按需拉取的快照只会得到一份立刻过期的假值。
// 本端点是按需拉取（弹层开 + All projects 打开）而非高频广播，因此这几个定长字段的体积可以接受。
export const runtimeAllProjectsTaskSearchIndexTaskEntrySchema = z.object({
	taskId: z.string(),
	title: z.string(),
	prompt: z.string(),
	columnId: runtimeBoardColumnIdSchema,
	// 卡片创建时刻（epoch ms）。
	createdAt: z.number(),
	// 用户可见的「上次修改时间」（建卡 / 跨列移动 / 用户编辑才 bump；后台观测刻意不写它，
	// 见 task-board-mutations.ts 的注释）。**不是** agent 活跃时间，排序档命名不得混淆二者。
	updatedAt: z.number(),
	// 用户为这张卡做的 per-task agent 覆盖；null = 跟随该项目的默认 agent（跨项目不可知，故结果行不臆测）。
	agentId: runtimeAgentIdSchema.nullable(),
	// runtime 观测值：本卡最近一次**真正启动成功**的会话用的是哪个 agent。跨项目行拿不到 live session，
	// 它是「这个任务实际在用哪个 agent」唯一可得的事实。
	mostRecentlyLaunchedAgentSessionAgentId: runtimeAgentIdSchema.nullable(),
	// 会话摘要 `lastConversationProgressObservation.observedAtMs`（epoch ms）：这个任务的对话上次真正往前走的时刻。
	// 已加载项目以内存摘要为准（内存无该任务摘要或只是未启动空壳时回落盘上值），其余项目取盘上 sessions.json；
	// 从没推进过 / 摘要已被清掉为 null。
	// 与 `updatedAt` 是两个量，消费方只能分段使用、绝不可混排（见 web-ui task-search-result-ordering）。
	agentConversationProgressObservedAt: z.number().nullable(),
});
export type RuntimeAllProjectsTaskSearchIndexTaskEntry = z.infer<
	typeof runtimeAllProjectsTaskSearchIndexTaskEntrySchema
>;

export const runtimeAllProjectsTaskSearchIndexProjectEntrySchema = z.object({
	projectId: z.string(),
	projectName: z.string(),
	tasks: z.array(runtimeAllProjectsTaskSearchIndexTaskEntrySchema),
});
export type RuntimeAllProjectsTaskSearchIndexProjectEntry = z.infer<
	typeof runtimeAllProjectsTaskSearchIndexProjectEntrySchema
>;

export const runtimeAllProjectsTaskSearchIndexResponseSchema = z.object({
	projects: z.array(runtimeAllProjectsTaskSearchIndexProjectEntrySchema),
});
export type RuntimeAllProjectsTaskSearchIndexResponse = z.infer<typeof runtimeAllProjectsTaskSearchIndexResponseSchema>;

// 跨项目切换面板：前端选中任务时记一笔「我最后打开」（服务端账本，跨浏览器 origin 共享）。
// 非 workspace-scoped：按 input.workspaceId 写，与 markTaskNotificationsVisited 同口径。
export const runtimeRecordTaskOpenedByUserRequestSchema = z.object({
	workspaceId: z.string().min(1),
	taskId: z.string().min(1),
});
export type RuntimeRecordTaskOpenedByUserRequest = z.infer<typeof runtimeRecordTaskOpenedByUserRequestSchema>;
export const runtimeRecordTaskOpenedByUserResponseSchema = z.object({
	recorded: z.boolean(),
});
export type RuntimeRecordTaskOpenedByUserResponse = z.infer<typeof runtimeRecordTaskOpenedByUserResponseSchema>;

// 跨项目切换面板「显示更早」：按放宽后的时间窗现算全部项目的条目（不进 projects_updated 广播）。
export const runtimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponseSchema = z.object({
	activityHorizonMs: z.number(),
	projects: z.array(
		z.object({
			workspaceId: z.string(),
			crossProjectTaskSwitcherEntries: z.array(runtimeCrossProjectTaskSwitcherEntrySchema),
		}),
	),
});
export type RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse = z.infer<
	typeof runtimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponseSchema
>;

// 跨项目切换面板：其他项目任务 worktree 的 git 元数据（相对 base 的 ahead/behind、已集成提交、未提交改动），
// 浏览器在面板可见时按需轮询。当前项目的行不走这里，读既有的 workspace_metadata_updated 推流 store。
// 不并入 projects_updated：未提交改动在 agent 写文件时几秒一变，会让 100 KB 级的整份广播变频繁。
export const CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT = 100;
export const runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema = z.object({
	tasks: z
		.array(z.object({ workspaceId: z.string().min(1), taskId: z.string().min(1) }))
		.max(CROSS_PROJECT_TASK_WORKTREE_GIT_METADATA_REQUEST_MAXIMUM_TASK_COUNT),
});
export type RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest = z.infer<
	typeof runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema
>;
export const runtimeCrossProjectTaskWorktreeGitMetadataUnavailableReasonSchema = z.enum([
	"project_not_registered",
	"task_card_not_found",
	// Backlog 卡还没有 worktree，与 workspace-metadata-monitor 的取景一致。
	"task_card_in_backlog_has_no_worktree",
	"git_metadata_probe_failed",
]);
export const runtimeCrossProjectTaskWorktreeGitMetadataSchema = z.discriminatedUnion("availability", [
	z.object({
		workspaceId: z.string(),
		taskId: z.string(),
		availability: z.literal("available"),
		// 与当前项目推流里的同名结构完全一致（同一个探针算出），浏览器用同一套展示规则。
		taskWorkspaceMetadata: runtimeTaskWorkspaceMetadataSchema,
	}),
	z.object({
		workspaceId: z.string(),
		taskId: z.string(),
		availability: z.literal("unavailable"),
		unavailableReason: runtimeCrossProjectTaskWorktreeGitMetadataUnavailableReasonSchema,
	}),
]);
export type RuntimeCrossProjectTaskWorktreeGitMetadata = z.infer<
	typeof runtimeCrossProjectTaskWorktreeGitMetadataSchema
>;
export const runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponseSchema = z.object({
	tasks: z.array(runtimeCrossProjectTaskWorktreeGitMetadataSchema),
});
export type RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse = z.infer<
	typeof runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponseSchema
>;

// 置顶 / 取消置顶 / 改置顶原因，统一经 taskCardAction 在连接 scope 的项目 board 锁内执行。
// 浏览器声明发起方（置顶恒为用户手势，应传 web_ui_user_gesture）；卡片不存在时抛 NOT_FOUND。
export const runtimeTaskCardActionSetTaskPinboardPinStateRequestSchema = z.discriminatedUnion("taskPinboardPinAction", [
	z.object({
		taskPinboardPinAction: z.literal("pin_task_card_or_update_pin_reason"),
		taskId: z.string().min(1),
		expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
		taskPinboardPinReason: z.string().nullable(),
		boardMutationInitiator: webUiBoardMutationInitiatorSchema.optional(),
	}),
	z.object({
		taskPinboardPinAction: z.literal("unpin_task_card"),
		taskId: z.string().min(1),
		expectedTaskIncarnationCreatedAtEpochMs: z.number().finite().optional(),
		boardMutationInitiator: webUiBoardMutationInitiatorSchema.optional(),
	}),
]);
export type RuntimeTaskCardActionSetTaskPinboardPinStateRequest = z.infer<
	typeof runtimeTaskCardActionSetTaskPinboardPinStateRequestSchema
>;
export const runtimeTaskCardActionSetTaskPinboardPinStateResponseSchema = z.object({
	// false = 置顶态本来就是请求的样子，这次没有写盘。
	boardWasSaved: z.boolean(),
	taskCardSnapshotAfterAction: runtimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummariesSchema,
});
export type RuntimeTaskCardActionSetTaskPinboardPinStateResponse = z.infer<
	typeof runtimeTaskCardActionSetTaskPinboardPinStateResponseSchema
>;

export const runtimeProjectAddRequestSchema = z
	.object({
		path: z.string().optional(),
		gitUrl: z.string().optional(),
		initializeGit: z.boolean().optional(),
	})
	.refine((data) => data.path || data.gitUrl, { message: "Either path or gitUrl is required" });
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeDirectoryListEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	isGitRepository: z.boolean(),
});
export type RuntimeDirectoryListEntry = z.infer<typeof runtimeDirectoryListEntrySchema>;

export const runtimeDirectoryListRequestSchema = z.object({
	path: z.string().optional(),
});
export type RuntimeDirectoryListRequest = z.infer<typeof runtimeDirectoryListRequestSchema>;

export const runtimeDirectoryListResponseSchema = z.object({
	ok: z.boolean(),
	currentPath: z.string(),
	parentPath: z.string().nullable(),
	rootPath: z.string(),
	entries: z.array(runtimeDirectoryListEntrySchema),
	error: z.string().optional(),
});
export type RuntimeDirectoryListResponse = z.infer<typeof runtimeDirectoryListResponseSchema>;

export const runtimeProjectPermanentDeletionPreviewRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectPermanentDeletionPreviewRequest = z.infer<
	typeof runtimeProjectPermanentDeletionPreviewRequestSchema
>;

export const runtimeProjectPermanentDeletionBlockingReasonSchema = z.enum([
	"confirmation_project_name_could_not_be_derived",
	"workspace_state_directory_path_is_unsafe",
	"workspace_state_could_not_be_verified",
	"runtime_sessions_could_not_be_verified",
	"managed_worktrees_could_not_be_verified",
]);
export type RuntimeProjectPermanentDeletionBlockingReason = z.infer<
	typeof runtimeProjectPermanentDeletionBlockingReasonSchema
>;

export const runtimeProjectPermanentDeletionPreviewSchema = z.object({
	projectId: z.string(),
	projectName: z.string(),
	projectPath: z.string(),
	workspaceStateRevision: z.number().int().nonnegative().nullable(),
	totalTaskCount: z.number().int().nonnegative(),
	activeSessionCount: z.number().int().nonnegative(),
	managedWorktreeCount: z.number().int().nonnegative(),
	workspaceStateDirectoryPath: z.string(),
	deletionAllowed: z.boolean(),
	blockingReasons: z.array(runtimeProjectPermanentDeletionBlockingReasonSchema),
	requiredConfirmationProjectName: z.string(),
});
export type RuntimeProjectPermanentDeletionPreview = z.infer<typeof runtimeProjectPermanentDeletionPreviewSchema>;

export const runtimeProjectPermanentDeletionPreviewResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		preview: runtimeProjectPermanentDeletionPreviewSchema,
	}),
	z.object({
		ok: z.literal(false),
		preview: z.null(),
		error: z.string(),
	}),
]);
export type RuntimeProjectPermanentDeletionPreviewResponse = z.infer<
	typeof runtimeProjectPermanentDeletionPreviewResponseSchema
>;

export const runtimeProjectPermanentDeletionRequestSchema = z.object({
	projectId: z.string(),
	expectedWorkspaceStateRevision: z.number().int().nonnegative(),
	confirmationProjectName: z.string(),
});
export type RuntimeProjectPermanentDeletionRequest = z.infer<typeof runtimeProjectPermanentDeletionRequestSchema>;

export const runtimeProjectPermanentDeletionResultStatusSchema = z.enum([
	"completed",
	"aborted_before_project_data_deletion",
	"completed_with_retained_staging_directory",
]);
export type RuntimeProjectPermanentDeletionResultStatus = z.infer<
	typeof runtimeProjectPermanentDeletionResultStatusSchema
>;

export const runtimeProjectPermanentDeletionFailureCodeSchema = z.enum([
	"project_not_registered",
	"deletion_not_allowed",
	"confirmation_project_name_mismatch",
	"preview_stale",
	"workspace_state_changed_after_managed_worktree_deletion",
	"workspace_state_directory_path_is_unsafe",
	"runtime_session_stop_or_persistence_failed",
	"managed_worktree_deletion_failed",
	"workspace_state_staging_failed",
	"workspace_index_deletion_failed",
	"workspace_state_staging_rollback_failed",
	"workspace_runtime_disposal_failed",
	"fallback_project_selection_failed",
	"projects_broadcast_failed",
	"staging_directory_removal_failed",
]);
export type RuntimeProjectPermanentDeletionFailureCode = z.infer<
	typeof runtimeProjectPermanentDeletionFailureCodeSchema
>;

export const runtimeProjectPermanentDeletionFailureSchema = z.object({
	code: runtimeProjectPermanentDeletionFailureCodeSchema,
	message: z.string(),
	path: z.string().optional(),
	taskId: z.string().optional(),
});
export type RuntimeProjectPermanentDeletionFailure = z.infer<typeof runtimeProjectPermanentDeletionFailureSchema>;

export const runtimeProjectManagedWorktreeDeletionResultSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	ok: z.boolean(),
	removed: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectManagedWorktreeDeletionResult = z.infer<
	typeof runtimeProjectManagedWorktreeDeletionResultSchema
>;

export const runtimeProjectPermanentDeletionResultSchema = z.object({
	status: runtimeProjectPermanentDeletionResultStatusSchema,
	failureCode: runtimeProjectPermanentDeletionFailureCodeSchema.optional(),
	projectId: z.string(),
	stoppedSessionCount: z.number().int().nonnegative(),
	worktreeDeletionResults: z.array(runtimeProjectManagedWorktreeDeletionResultSchema),
	projectIndexDeleted: z.boolean(),
	workspaceStateDirectoryDeleted: z.boolean(),
	failures: z.array(runtimeProjectPermanentDeletionFailureSchema),
	retainedPaths: z.array(z.string()),
	newCurrentProjectId: z.string().nullable(),
});
export type RuntimeProjectPermanentDeletionResult = z.infer<typeof runtimeProjectPermanentDeletionResultSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		warning: z.string().optional(),
		error: z.string().optional(),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

export const runtimeClineOauthProviderSchema = z.enum(["cline", "oca", "openai-codex"]);
export type RuntimeClineOauthProvider = z.infer<typeof runtimeClineOauthProviderSchema>;

export const runtimeClineProviderSettingsSchema = z.object({
	providerId: z.string().nullable(),
	modelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	apiKeyConfigured: z.boolean(),
	oauthProvider: runtimeClineOauthProviderSchema.nullable(),
	oauthAccessTokenConfigured: z.boolean(),
	oauthRefreshTokenConfigured: z.boolean(),
	oauthAccountId: z.string().nullable(),
	oauthExpiresAt: z.number().int().positive().nullable(),
});
export type RuntimeClineProviderSettings = z.infer<typeof runtimeClineProviderSettingsSchema>;

export const runtimeClineAccountProfileSchema = z.object({
	accountId: z.string().nullable(),
	email: z.string().nullable(),
	displayName: z.string().nullable(),
});
export type RuntimeClineAccountProfile = z.infer<typeof runtimeClineAccountProfileSchema>;

export const runtimeClineAccountProfileResponseSchema = z.object({
	profile: runtimeClineAccountProfileSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountProfileResponse = z.infer<typeof runtimeClineAccountProfileResponseSchema>;

export const runtimeClineKanbanAccessResponseSchema = z.object({
	enabled: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineKanbanAccessResponse = z.infer<typeof runtimeClineKanbanAccessResponseSchema>;

export const runtimeClineAccountOrganizationSchema = z.object({
	organizationId: z.string(),
	name: z.string(),
	active: z.boolean(),
	roles: z.array(z.string()),
});
export type RuntimeClineAccountOrganization = z.infer<typeof runtimeClineAccountOrganizationSchema>;

export const runtimeClineAccountOrganizationsResponseSchema = z.object({
	organizations: z.array(runtimeClineAccountOrganizationSchema),
	error: z.string().optional(),
});
export type RuntimeClineAccountOrganizationsResponse = z.infer<typeof runtimeClineAccountOrganizationsResponseSchema>;

export const runtimeClineAccountBalanceResponseSchema = z.object({
	balance: z.number().nullable(),
	activeAccountLabel: z.string().nullable(),
	activeOrganizationId: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountBalanceResponse = z.infer<typeof runtimeClineAccountBalanceResponseSchema>;

export const runtimeClineAccountSwitchRequestSchema = z.object({
	organizationId: z.string().nullable(),
});
export type RuntimeClineAccountSwitchRequest = z.infer<typeof runtimeClineAccountSwitchRequestSchema>;

export const runtimeClineAccountSwitchResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineAccountSwitchResponse = z.infer<typeof runtimeClineAccountSwitchResponseSchema>;

export const runtimeFeaturebaseTokenResponseSchema = z.object({
	featurebaseJwt: z.string(),
});
export type RuntimeFeaturebaseTokenResponse = z.infer<typeof runtimeFeaturebaseTokenResponseSchema>;

export const runtimeClineProviderCatalogItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	oauthSupported: z.boolean(),
	enabled: z.boolean(),
	defaultModelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	supportsBaseUrl: z.boolean(),
	env: z.array(z.string()).optional(),
});
export type RuntimeClineProviderCatalogItem = z.infer<typeof runtimeClineProviderCatalogItemSchema>;

export const runtimeClineProviderCatalogResponseSchema = z.object({
	providers: z.array(runtimeClineProviderCatalogItemSchema),
});
export type RuntimeClineProviderCatalogResponse = z.infer<typeof runtimeClineProviderCatalogResponseSchema>;

export const runtimeClineProviderModelsRequestSchema = z.object({
	providerId: z.string(),
});
export type RuntimeClineProviderModelsRequest = z.infer<typeof runtimeClineProviderModelsRequestSchema>;

export const runtimeClineProviderModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	supportsVision: z.boolean().optional(),
	supportsAttachments: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
});
export type RuntimeClineProviderModel = z.infer<typeof runtimeClineProviderModelSchema>;

export const runtimeClineProviderModelsResponseSchema = z.object({
	providerId: z.string(),
	models: z.array(runtimeClineProviderModelSchema),
});
export type RuntimeClineProviderModelsResponse = z.infer<typeof runtimeClineProviderModelsResponseSchema>;

export const runtimeClineProviderCapabilitySchema = z.enum([
	"streaming",
	"tools",
	"reasoning",
	"vision",
	"prompt-cache",
]);
export type RuntimeClineProviderCapability = z.infer<typeof runtimeClineProviderCapabilitySchema>;

export const runtimeClineAddProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string(),
	baseUrl: z.string(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
	models: z.array(z.string()),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineAddProviderRequest = z.infer<typeof runtimeClineAddProviderRequestSchema>;

export const runtimeClineAddProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineAddProviderResponse = z.infer<typeof runtimeClineAddProviderResponseSchema>;

export const runtimeClineUpdateProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).nullable().optional(),
	timeoutMs: z.number().int().positive().nullable().optional(),
	models: z.array(z.string()).optional(),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineUpdateProviderRequest = z.infer<typeof runtimeClineUpdateProviderRequestSchema>;

export const runtimeClineUpdateProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineUpdateProviderResponse = z.infer<typeof runtimeClineUpdateProviderResponseSchema>;

export const runtimeClineOauthLoginRequestSchema = z.object({
	provider: runtimeClineOauthProviderSchema,
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineOauthLoginRequest = z.infer<typeof runtimeClineOauthLoginRequestSchema>;

export const runtimeClineOauthLoginResponseSchema = z.object({
	ok: z.boolean(),
	provider: runtimeClineOauthProviderSchema,
	settings: runtimeClineProviderSettingsSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeClineOauthLoginResponse = z.infer<typeof runtimeClineOauthLoginResponseSchema>;

export const runtimeClineDeviceAuthStartResponseSchema = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUrl: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
});
export type RuntimeClineDeviceAuthStartResponse = z.infer<typeof runtimeClineDeviceAuthStartResponseSchema>;

export const runtimeClineDeviceAuthCompleteRequestSchema = z.object({
	deviceCode: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineDeviceAuthCompleteRequest = z.infer<typeof runtimeClineDeviceAuthCompleteRequestSchema>;

export const runtimeClineDeviceAuthCompleteResponseSchema = runtimeClineOauthLoginResponseSchema;
export type RuntimeClineDeviceAuthCompleteResponse = z.infer<typeof runtimeClineDeviceAuthCompleteResponseSchema>;

export const runtimeClineProviderSettingsSaveRequestSchema = z.object({
	providerId: z.string(),
	modelId: z.string().nullable().optional(),
	apiKey: z.string().nullable().optional(),
	baseUrl: z.string().nullable().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	region: z.string().nullable().optional(),
	aws: z
		.object({
			accessKey: z.string().nullable().optional(),
			secretKey: z.string().nullable().optional(),
			sessionToken: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
			profile: z.string().nullable().optional(),
			authentication: z.enum(["iam", "api-key", "profile"]).nullable().optional(),
			endpoint: z.string().nullable().optional(),
		})
		.optional(),
	gcp: z
		.object({
			projectId: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
		})
		.optional(),
});
export type RuntimeClineProviderSettingsSaveRequest = z.infer<typeof runtimeClineProviderSettingsSaveRequestSchema>;

export const runtimeClineProviderSettingsSaveResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineProviderSettingsSaveResponse = z.infer<typeof runtimeClineProviderSettingsSaveResponseSchema>;

const runtimeClineMcpServerBaseSchema = z.object({
	name: z.string(),
	disabled: z.boolean(),
});

export const runtimeClineMcpServerSchema = z.discriminatedUnion("type", [
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("stdio"),
		command: z.string(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("sse"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("streamableHttp"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);
export type RuntimeClineMcpServer = z.infer<typeof runtimeClineMcpServerSchema>;

export const runtimeClineMcpSettingsResponseSchema = z.object({
	path: z.string(),
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsResponse = z.infer<typeof runtimeClineMcpSettingsResponseSchema>;

export const runtimeClineMcpSettingsSaveRequestSchema = z.object({
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsSaveRequest = z.infer<typeof runtimeClineMcpSettingsSaveRequestSchema>;

export const runtimeClineMcpSettingsSaveResponseSchema = runtimeClineMcpSettingsResponseSchema;
export type RuntimeClineMcpSettingsSaveResponse = z.infer<typeof runtimeClineMcpSettingsSaveResponseSchema>;

export const runtimeClineMcpAuthStatusResponseSchema = z.object({
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeClineMcpAuthStatusResponse = z.infer<typeof runtimeClineMcpAuthStatusResponseSchema>;

export const runtimeClineMcpOAuthRequestSchema = z.object({
	serverName: z.string(),
});
export type RuntimeClineMcpOAuthRequest = z.infer<typeof runtimeClineMcpOAuthRequestSchema>;

export const runtimeClineMcpOAuthResponseSchema = z.object({
	serverName: z.string(),
	authorized: z.literal(true),
	message: z.string(),
});
export type RuntimeClineMcpOAuthResponse = z.infer<typeof runtimeClineMcpOAuthResponseSchema>;

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeUpdateStatusResponseSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	updateTiming: z.enum(["startup", "shutdown"]).nullable(),
	installCommand: z.string().nullable(),
});
export type RuntimeUpdateStatusResponse = z.infer<typeof runtimeUpdateStatusResponseSchema>;

export const runtimeRunUpdateResponseSchema = z.object({
	status: z.enum([
		"updated",
		"already_up_to_date",
		"cache_refreshed",
		"unsupported_installation",
		"check_failed",
		"update_failed",
	]),
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	message: z.string(),
});
export type RuntimeRunUpdateResponse = z.infer<typeof runtimeRunUpdateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeTaskCreateDialogPrimaryStartActionSchema = z.enum(["start", "start_and_open"]);
export type RuntimeTaskCreateDialogPrimaryStartAction = z.infer<typeof runtimeTaskCreateDialogPrimaryStartActionSchema>;

// 跨浏览器 origin 共享的界面偏好。
//
// 这些偏好原先各自躺在浏览器 localStorage 里，而 localStorage 是 **per-origin** 的：`npm run web:dev`
// 固定在 4173、`npm run dev:full` 每次挑一个空闲端口，换个端口就是全新的一份——这比「换浏览器」频繁
// 得多，是现实中最主要的分叉轴。落到 config.json 后它们天然跟着用户走，与从哪个 origin 打开无关。
//
// ## 为什么每个标量都可为 null，而 null **不等于**默认值
//
// null 表示「服务端从来没有过这个偏好」，与「服务端存的恰好是默认值」是两件事。合并迁移正是靠这个
// 区分决定该采纳本地值还是保留服务端值：若把 null 折叠成默认值，第一个迁移的 origin 就无法把自己
// 攒下的选择播种到服务端，用户升级后会看到偏好被重置。默认值由各消费方在读到 null 时自行套用。
//
// ## 两个字典字段为什么不可为 null
//
// 字典的「整体是否存在」这个维度用不上：空字典即可表达「一条都没有」，而删掉最后一条与「从没设过」
// 对消费方是同一件事——没有哪个消费方需要靠 null 区分这两者，多一个状态只会多一条要各处照顾的分支。
//
// ## 字典的两种写入意图（**同一份数据，两条语义截然相反的写入路径**）
//
//   - 普通部分更新（`runtimeConfigSaveRequestSchema.userInterfacePreferencesSharedAcrossBrowserOrigins`）
//     按**整份替换**。必须如此：用户解除某个槽位绑定、或裁剪掉失效项目，前端表达删除的唯一方式就是
//     写回一份少了那个键的整份字典；若在这条路径上逐键求并，删除就永远生效不了。
//   - 迁移采纳（`runtimeConfigSaveRequestSchema.userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage`）
//     按**键**并入：服务端已有的键胜出、服务端没有的键被采纳，不丢任何一侧的条目。
//
// 两条路径分开的理由是并发：迁移载荷是某个 origin 基于「它读到的那份服务端快照」算出来的，两个 origin
// 首次几乎同时迁移时，各自都基于空快照算出自己那半份；若迁移也走整份替换，后到的那次会在服务端锁内
// 把前一次的条目整份覆盖掉，用户凭空少一半编组。把「并入」放到服务端锁内算，结果才与到达顺序无关。
export const runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema = z.object({
	// 每次只提交变化的设置键，服务端在配置锁内逐键合并。
	taskEditorSettingPresentationBySettingKey: z
		.record(z.string().max(100), z.enum(["expanded", "collapsed_in_group", "hidden"]))
		.optional(),
	newTaskAutoReviewEnabled: z.boolean().nullable(),
	newTaskAutoReviewMode: runtimeTaskAutoReviewModeSchema.nullable(),
	taskCreateDialogPrimaryStartAction: runtimeTaskCreateDialogPrimaryStartActionSchema.nullable(),
	// 键是 JSON.stringify([projectId ?? "global", terminalAgentId])，值是该组合上次选定的 modelId。
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: z.record(z.string(), z.string()),
	// 「在…中打开」的默认应用（OpenTargetId）。可选集合随平台变化，故这里只存字符串、由前端校验。
	workspaceOpenTargetPreferredApplicationId: z.string().nullable(),
	// 顶栏项目快速切换器的《红警》式编组：槽位号（"1"–"9"）→ projectId。
	projectNumericSlotGroupAssignmentsBySlotNumber: z.record(z.string(), z.string()),
	// 键是 projectId（= 服务端 workspaceId），值是该项目上次**成功建卡**所用的 base ref。
	// 只在建卡成功时写，不在下拉框每次 change 时写：点开对话框又放弃的误选不该变成项目默认值。
	mostRecentlyUsedTaskCreateBaseRefByProjectId: z.record(z.string(), z.string()),
	// 建卡描述区「插入伪 HTML 块」用过的**自定义**块名（内置预设不进这份记忆），最近使用在前。
	// 与上面几个字典同理不可空：空数组已经表达「一条都没有」，再用 null 表达「尚未设定」是多余的第三态。
	taskPromptPseudoHtmlBlockRecentlyUsedCustomNames: z.array(z.string()),
});
export type RuntimeUserInterfacePreferencesSharedAcrossBrowserOrigins = z.infer<
	typeof runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema
>;

// 迁移采纳意图的载荷：从浏览器 localStorage 里读出来、希望服务端**逐键并入**的那些字典条目。
//
// 只列两个字典字段：4 个标量没有「逐键」这一层，它们的迁移播种由普通部分更新表达（服务端为 null 才写，
// 那个判据在客户端算是安全的——标量播种撞车时两个 origin 写的是各自本地那份，谁赢都不会丢掉另一份数据，
// 只会让落选的那份进冲突提示；字典则不然，整份覆盖是**真的少一半条目**）。
//
// 值语义与偏好本体一致（键 → 字符串值），但这里的每个字段都是可选的：只带这次真正要采纳的那部分。
export const runtimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorageSchema = z.object({
	taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: z.record(z.string(), z.string()).optional(),
	projectNumericSlotGroupAssignmentsBySlotNumber: z.record(z.string(), z.string()).optional(),
	mostRecentlyUsedTaskCreateBaseRefByProjectId: z.record(z.string(), z.string()).optional(),
});
export type RuntimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage = z.infer<
	typeof runtimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorageSchema
>;

// runtime 所在主机的身份，供浏览器在其他设备上拼 Remote-SSH 深链（`ssh-remote+<user>@<host>`）查看这台主机上的文件。
// 将来多机联邦时，每台机器的项目各带自己这一份。
export const runtimeHostRemoteEditorAccessIdentitySchema = z.object({
	// runtime 进程所属的操作系统账号，即 SSH 登录名。没有 passwd 记录的容器里 `os.userInfo()` 会抛错，此时为 null，
	// 浏览器省掉 `<user>@`，交给 SSH 客户端的默认用户 / ssh_config。
	operatingSystemAccountUsername: z.string().nullable(),
	// 仅供展示与诊断；深链的主机名取浏览器能连上的那个名字（页面主机名），不用它。
	operatingSystemHostname: z.string(),
});
export type RuntimeHostRemoteEditorAccessIdentity = z.infer<typeof runtimeHostRemoteEditorAccessIdentitySchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	newTaskStartInPlanModeByDefault: z.boolean(),
	// omp 新任务的默认通道（严格的「新任务默认值」：建卡时固化到卡上，改它不追溯已有卡片）。
	ompAgentSessionTransportForNewTasks: runtimeAgentSessionTransportSchema,
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	notificationSoundEnabled: z.boolean(),
	autoContinueOnConnectionDropEnabled: z.boolean(),
	// 程序化投递与人类抢输入框时，人不在场是否允许自动暂存抢占（false = 恒定只挂起可见）。
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: z.boolean(),
	// Post-Deploy Verification 「一键强制完成（跳过 token 两步确认）」的全局总闸；配合 CLI `--force` 才生效（plan Grilling #9）。
	postDeployVerificationForceCompleteEnabled: z.boolean(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	clineProviderSettings: runtimeClineProviderSettingsSchema,
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	userInterfacePreferencesSharedAcrossBrowserOrigins: runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema,
	runtimeHostRemoteEditorAccessIdentity: runtimeHostRemoteEditorAccessIdentitySchema,
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	newTaskStartInPlanModeByDefault: z.boolean().optional(),
	ompAgentSessionTransportForNewTasks: runtimeAgentSessionTransportSchema.optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	notificationSoundEnabled: z.boolean().optional(),
	autoContinueOnConnectionDropEnabled: z.boolean().optional(),
	programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: z.boolean().optional(),
	postDeployVerificationForceCompleteEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	// 逐字段可选，于是三种状态可分：字段缺席 = 不动它、null = 显式清回「服务端无值」、有值 = 设定。
	// 两个字典字段在这条路径上按**整份替换**（与既有的 `shortcuts` 一致）：删除只能靠「写回一份少了某个
	// 键的整份字典」表达，这里逐键求并就等于永远删不掉。并发写因此是 last-write-wins，但这条路径上的写
	// 都是用户当下的一次显式操作（绑槽位 / 解绑 / 选模型），最后一次点击胜出正是用户预期。
	userInterfacePreferencesSharedAcrossBrowserOrigins: runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema
		.partial()
		.optional(),
	// 迁移采纳意图：这些条目由服务端在锁内**逐键并入**（服务端已有的键胜出），而不是整份替换。
	// 与上面那个字段是两条独立路径，可同时出现在一次请求里——迁移一次性上传「标量播种 + 字典采纳」。
	// 为什么不复用上面那条：迁移载荷算自客户端读到的服务端快照，整份替换会让两个 origin 首次同时迁移时
	// 后到的那次覆盖掉前一次的条目（见 runtimeUserInterfacePreferencesSharedAcrossBrowserOriginsSchema 上方）。
	userInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorage:
		runtimeUserInterfacePreferenceDictionaryEntriesMigratedFromBrowserLocalStorageSchema.optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

// 客户端可声明的会话启动来源。刻意只收口成一个**子集**：服务端自己判定的那几个来源
// （refresh_task_terminal / auto_restart_after_pty_exit / durable_record_rebuilt_resume 等）
// 不在其中，否则任何客户端都能把自己的自动创建伪装成别的来源，归因通道随即失去证据价值。
//
// 为什么非要客户端声明不可：服务端收到的请求形状完全相同——「用户手点 Restart」与「前端发现会话已
// 陈旧、自动续跑」打到的是同一个 refreshTaskTerminal，而 refresh_task_terminal 实测占 pty 创建量的
// 68%，不加声明就永远分不出这 68% 里有多少是人点的。
export const runtimeTaskSessionStartOriginDeclaredByClientSchema = z.enum([
	"external_entry_point",
	"stale_session_client_auto_resume",
	"home_agent_panel_auto_start",
]);
export type RuntimeTaskSessionStartOriginDeclaredByClient = z.infer<
	typeof runtimeTaskSessionStartOriginDeclaredByClientSchema
>;

export const runtimeTaskSessionStartRequestSchema = z
	.object({
		taskId: z.string(),
		// 省略时 taskId 按任务入口跟随当前主绑定；显式传入时按会话寻址。
		// 前主会话的 taskId 等于宿主卡片 ID，仍用 workspaceTaskId 显式区分恢复目标。
		workspaceTaskId: z.string().optional(),
		taskConversationSessionMetadata: runtimeTaskConversationSessionMetadataSchema.optional(),
		prompt: z.string(),
		/** Display title from the Kanban task card. Propagated to SDK session metadata as a convenience copy. */
		taskTitle: z.string().optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		startInPlanMode: z.boolean().optional(),
		// 省略时由服务端按全局 agentAutonomousModeEnabled 推导（老卡片兼容路径）。
		taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.optional(),
		mode: runtimeTaskSessionModeSchema.optional(),
		resumeFromTrash: z.boolean().optional(),
		baseRef: z.string(),
		cols: z.number().int().positive().optional(),
		rows: z.number().int().positive().optional(),
		agentId: runtimeAgentIdSchema.optional(),
		// 本次启动要走哪条通道。省略时服务端按「卡片固化值 → 全局默认 → catalog 默认」解析
		// （见 core/agent-session-transport-selection.ts）；切换 procedure 会显式传它。
		requestedAgentSessionTransport: runtimeAgentSessionTransportSchema.optional(),
		// 卡片声明的会话模式快照（蓝图 §A.1）：与 startInPlanMode 同款「客户端从卡片带进启动请求」
		// 语义，服务端在建会话时盖章进 summary.taskConversationMode。省略 = operational（老客户端/
		// 老卡片零迁移）。
		taskConversationMode: runtimeTaskConversationModeSchema.optional(),
		// 「续跑既有对话、不重投 prompt」。切换通道后重开会话走它：用户已在对话中途，
		// 重投一次原始 prompt 等于凭空多一轮。与 resumeFromTrash 的区别是后者还带回收/垃圾桶语义。
		resumePriorAgentConversationWithoutResendingPrompt: z.boolean().optional(),
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
		terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
		taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.optional(),
		parentSessionId: z.string().optional(),
		worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
		prepFilePath: z.string().optional(),
		// 纯归因，不参与任何业务判定。省略时服务端按 external_entry_point 记账，故老客户端行为不变。
		taskSessionStartOriginDeclaredByClient: runtimeTaskSessionStartOriginDeclaredByClientSchema.optional(),
	})
	.superRefine((request, ctx) => {
		if (
			request.taskAgentSessionInitialization &&
			request.agentId &&
			request.taskAgentSessionInitialization.sourceAgentId !== request.agentId
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["taskAgentSessionInitialization", "sourceAgentId"],
				message: "Task session initialization agent must match the selected task agent.",
			});
		}
	});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTerminalAgentModelSelectionOptionsRequestSchema = z.object({
	agentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
});
export type RuntimeTerminalAgentModelSelectionOptionsRequest = z.infer<
	typeof runtimeTerminalAgentModelSelectionOptionsRequestSchema
>;

/**
 * 一个 terminal agent 模型选项属于哪一档：
 * - `latest_tracking_alias`：别名，语义是「该家族的最新模型」，由 CLI 在启动时解析到当时的具体版本
 *   （如 `--model opus`）。label 不含版本号，因此永远不会因上游发布新模型而错标。
 * - `pinned_version`：钉死到某个具体版本的完整模型名（如 `claude-opus-4-8`），label 带版本号。
 *
 * 运行时不变量：后端产出的每个 option 都带分档（`terminal-agent-model-selection.ts` 的
 * `deduplicateModelOptions` 对 codex / cursor 这类不区分档位的解析结果缺省补 `latest_tracking_alias`）。
 * 字段仍保持 optional，只是为了容纳本字段引入**之前**写入的 localStorage 缓存；前端正是靠
 * 「有 option 却无一条带分档」这条跨 agent 通用判据识别那批旧缓存并当作 cache miss 丢弃，
 * 否则升级用户首屏会重新渲染出旧的错标标签（如 `opus` 标成 "Opus 4.8"）。
 * 读取侧解析时未标注一律按 `latest_tracking_alias` 处理。
 */
export const runtimeTerminalAgentModelSelectionGroupSchema = z.enum(["latest_tracking_alias", "pinned_version"]);
export type RuntimeTerminalAgentModelSelectionGroup = z.infer<typeof runtimeTerminalAgentModelSelectionGroupSchema>;

export const runtimeTerminalAgentModelSelectionOptionSchema = z.object({
	modelId: z.string(),
	label: z.string(),
	description: z.string().optional(),
	isCurrent: z.boolean().optional(),
	modelSelectionGroup: runtimeTerminalAgentModelSelectionGroupSchema.optional(),
});
export type RuntimeTerminalAgentModelSelectionOption = z.infer<typeof runtimeTerminalAgentModelSelectionOptionSchema>;

export const runtimeTerminalAgentModelSelectionOptionsResponseSchema = z.object({
	agentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
	defaultModelId: z.string().nullable(),
	defaultLabel: z.string(),
	options: z.array(runtimeTerminalAgentModelSelectionOptionSchema),
	warning: z.string().optional(),
});
export type RuntimeTerminalAgentModelSelectionOptionsResponse = z.infer<
	typeof runtimeTerminalAgentModelSelectionOptionsResponseSchema
>;

export const runtimeAvailableAgentSessionSearchScopeSchema = z.enum(["current_repository", "all_local_sessions"]);
export type RuntimeAvailableAgentSessionSearchScope = z.infer<typeof runtimeAvailableAgentSessionSearchScopeSchema>;

export const runtimeAvailableAgentSessionPreviewTurnSchema = z.object({
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	timestamp: z.string().nullable(),
});
export type RuntimeAvailableAgentSessionPreviewTurn = z.infer<typeof runtimeAvailableAgentSessionPreviewTurnSchema>;

export const runtimeAvailableAgentSessionSummarySchema = z.object({
	sourceAgentId: runtimeResumableAgentSessionSourceAgentIdSchema,
	sourceSessionId: z.string().uuid(),
	codexConversationStorageHomeDirectoryPath: z.string().trim().min(1).optional(),
	sessionTitle: z.string(),
	sessionWorkingDirectoryPath: z.string().nullable(),
	gitBranchName: z.string().nullable(),
	modelId: z.string().nullable(),
	lastUpdatedAt: z.string(),
	previewConversationTurns: z.array(runtimeAvailableAgentSessionPreviewTurnSchema).max(3),
});
export type RuntimeAvailableAgentSessionSummary = z.infer<typeof runtimeAvailableAgentSessionSummarySchema>;
export type {
	RuntimeCodexConversationStorageOperationRequest,
	RuntimeCodexConversationStorageOperationResponse,
} from "./codex-conversation-storage-api-contract";
export {
	runtimeCodexConversationStorageOperationRequestSchema,
	runtimeCodexConversationStorageOperationResponseSchema,
} from "./codex-conversation-storage-api-contract";

export const runtimeAvailableAgentSessionsRequestSchema = z.object({
	agentId: runtimeResumableAgentSessionSourceAgentIdSchema,
	searchScope: runtimeAvailableAgentSessionSearchScopeSchema.default("current_repository"),
	query: z.string().trim().max(2048).default(""),
	pageCursor: z.number().int().nonnegative().default(0),
	pageSize: z.number().int().min(1).max(100).default(50),
	forceRefresh: z.boolean().default(false),
});
export type RuntimeAvailableAgentSessionsRequest = z.infer<typeof runtimeAvailableAgentSessionsRequestSchema>;

export const runtimeAvailableAgentSessionsResponseSchema = z.object({
	sessions: z.array(runtimeAvailableAgentSessionSummarySchema),
	nextPageCursor: z.number().int().nonnegative().nullable(),
	totalMatchingSessions: z.number().int().nonnegative(),
	scanWarnings: z.array(z.string()),
});
export type RuntimeAvailableAgentSessionsResponse = z.infer<typeof runtimeAvailableAgentSessionsResponseSchema>;

// 启动被 runtime 有意拒绝时的机器可读原因（error 仍是给人看的文案）。
export const runtimeTaskSessionStartRejectionReasonSchema = z.enum([
	// cf427：卡片会话（主会话 / By the way 侧问）的宿主卡还不在盘上 board 里。放行的话 agent 照常跑，
	// 卡片却可能永远落不了盘（浏览器整板重水合把它抹掉），会话就成了搜不到、进不了 Focus 的孤儿。
	"task_card_not_yet_persisted_on_workspace_board",
]);
export type RuntimeTaskSessionStartRejectionReason = z.infer<typeof runtimeTaskSessionStartRejectionReasonSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
	taskSessionStartRejectionReason: runtimeTaskSessionStartRejectionReasonSchema.optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

// 把一条**已存在的** agent 会话从当前通话通道切到另一条（目前只有 omp 有第二条通道）。
// 语义是「停掉当前会话 → 立刻用另一条通道续跑同一段对话」，服务端一次做完：放前端做
// stop→save→start 三连的话，中途任何一步失败都会留下半切状态（卡片字段已改、会话还在旧通道上）。
//
// taskId 是**会话 id**（详情页传的是当前选中的那条 agent 会话），不是看板卡 id ——
// 两者在主会话上恰好相同，By the way 会话上不同。omp 目前没有 By the way 支持，
// 一旦有了，通道字段就不能再落在卡上（见 runtimeBoardCardSchema.ompAgentSessionTransport）。
export const runtimeAgentSessionTransportSwitchRequestSchema = z.object({
	taskId: z.string(),
	targetSessionTransport: runtimeAgentSessionTransportSchema,
});
export type RuntimeAgentSessionTransportSwitchRequest = z.infer<typeof runtimeAgentSessionTransportSwitchRequestSchema>;

export const runtimeAgentSessionTransportSwitchResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	// 失败时会话**停在已停止**（不自动回滚、不降级到旧通道）；卡片的下次启动通道仍是你选的那条，
	// 修好问题后点 Start 就能起来。这个字段告诉前端「旧会话确实已经停了」，好把提示写准。
	priorAgentSessionStopped: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeAgentSessionTransportSwitchResponse = z.infer<
	typeof runtimeAgentSessionTransportSwitchResponseSchema
>;

// 用户经卡片右上角「移至 Review」悬浮按钮把一个停在 agent 回合的终端 agent 任务手动翻入「等人审查」回合
// （reviewReason=manual_review）。区别于 stopTaskSession（中断/收尾），此处只翻回合、不杀进程：用于卡死/空闲
// 会话（Stop hook 未触发、进程未退、无兜底转移）无法被拖入 Review 列、被反复打回 In Progress 的场景。
export const runtimeTaskSessionTransitionToReviewRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionTransitionToReviewRequest = z.infer<
	typeof runtimeTaskSessionTransitionToReviewRequestSchema
>;

export const runtimeTaskSessionTransitionToReviewResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionTransitionToReviewResponse = z.infer<
	typeof runtimeTaskSessionTransitionToReviewResponseSchema
>;

// 外部编排（RVF / 自研 Kanban）对一个终端 agent 任务「置 park」：标记它正在等待自己以非 native 方式派发的
// 后台工作完成、会被外部恢复，从而在主 agent 结束本轮发出裸 Stop 时结构性抑制误发的 ready-for-review 通知。
// label 可选，仅用于 UI 与诊断（例：被派发的子任务 id）。编排层须 await 本调用 OK 再让 agent 结束这一轮。
export const runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema = z.object({
	taskId: z.string(),
	label: z.string().optional(),
});
export type RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest = z.infer<
	typeof runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema
>;

export const runtimeTaskParkAwaitingDispatchedBackgroundWorkResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskParkAwaitingDispatchedBackgroundWorkResponse = z.infer<
	typeof runtimeTaskParkAwaitingDispatchedBackgroundWorkResponseSchema
>;

// 显式清 park（兜底）：用于编排层不走 followup 的恢复路径手动 unpark。幂等：未 parked 即 no-op success。
export const runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest = z.infer<
	typeof runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema
>;

export const runtimeTaskUnparkAwaitingDispatchedBackgroundWorkResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkResponse = z.infer<
	typeof runtimeTaskUnparkAwaitingDispatchedBackgroundWorkResponseSchema
>;

// 查询某任务当前是否 parked（源自内存 getSummary 的 sidecar）。RVF stop-hook 先查 Kanban、查询出错才回落
// 旧文件启发式，Kanban 在分歧时权威。parked=false 时 label / sinceMs 为 null。
export const runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest = z.infer<
	typeof runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema
>;

export const runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema = z.object({
	ok: z.boolean(),
	parked: z.boolean(),
	label: z.string().nullable(),
	sinceMs: z.number().nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse = z.infer<
	typeof runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema
>;

// 手动触发：对一组正处于「连接重试」状态的终端 agent 立即注入一次续跑指令
// （不等待退避计时器）。单任务「立即续跑」传单元素数组；「全部立即续跑」传当前
// workspace 的整张重试列表（web-ui 已按 workspace 派生）。
export const runtimeContinueConnectionRetrySessionsRequestSchema = z.object({
	taskIds: z.array(z.string()).min(1),
});
export type RuntimeContinueConnectionRetrySessionsRequest = z.infer<
	typeof runtimeContinueConnectionRetrySessionsRequestSchema
>;

export const runtimeContinueConnectionRetrySessionsResponseSchema = z.object({
	ok: z.boolean(),
	// 实际被触发续跑的任务 id 列表（命中且仍在重试列表里的）。
	triggeredTaskIds: z.array(z.string()),
	error: z.string().optional(),
});
export type RuntimeContinueConnectionRetrySessionsResponse = z.infer<
	typeof runtimeContinueConnectionRetrySessionsResponseSchema
>;

// 手动「移出列表 / 停止重试」：把指定任务从自动续跑重试列表里移出，结束其当前重连 episode、
// 不再注入续跑（软移除——之后若再检测到新的瞬时连接错误仍会重新进入）。单任务传单元素数组；
// 「全部移出」传当前 workspace 的整张重试列表（web-ui 已按 workspace 派生）。
export const runtimeDismissConnectionRetrySessionsRequestSchema = z.object({
	taskIds: z.array(z.string()).min(1),
});
export type RuntimeDismissConnectionRetrySessionsRequest = z.infer<
	typeof runtimeDismissConnectionRetrySessionsRequestSchema
>;

export const runtimeDismissConnectionRetrySessionsResponseSchema = z.object({
	ok: z.boolean(),
	// 实际被移出的任务 id 列表（命中且仍在重试列表里的）。
	dismissedTaskIds: z.array(z.string()),
	error: z.string().optional(),
});
export type RuntimeDismissConnectionRetrySessionsResponse = z.infer<
	typeof runtimeDismissConnectionRetrySessionsResponseSchema
>;

export const runtimeTaskTerminalRefreshRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	// 纯归因，不参与任何业务判定。省略时服务端按 refresh_task_terminal 记账（即「人点的刷新」），
	// 故老客户端行为不变；前端的自动续跑路径必须显式声明 stale_session_client_auto_resume。
	taskSessionStartOriginDeclaredByClient: runtimeTaskSessionStartOriginDeclaredByClientSchema.optional(),
	// 「从既有 agent 对话迁入」：先把这段对话复制进本会话的执行工作目录、钉成本会话的原生身份，再按 id 续跑
	// （不重投 prompt）。给「对话从未建立」的会话一条用户自己拍板的出路——例如把同 prompt 的另一张卡留下的
	// 孤儿对话接过来。只对原生 id 由 kanban 分配的 agent（Cursor）开放，且源对话必须属于同一个 agent。
	adoptExistingAgentConversationAsTaskSessionIdentity: runtimeTaskAgentSessionInitializationSchema.optional(),
	// 「停止后台会话并在这里续跑」：对话正被 harness 后台会话（Claude `/background`）占着、又不能安全收回时，
	// 用户在终端面板上显式确认接管——不再看是否安全，`claude stop` 后按 id 续跑（在途回合 / 未提交的输入随之丢弃）。
	forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser: z.boolean().optional(),
});
export type RuntimeTaskTerminalRefreshRequest = z.infer<typeof runtimeTaskTerminalRefreshRequestSchema>;

export const runtimeTaskTerminalRefreshResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	mode: z.enum(["resume", "fresh"]).optional(),
	error: z.string().optional(),
});
export type RuntimeTaskTerminalRefreshResponse = z.infer<typeof runtimeTaskTerminalRefreshResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeTaskAgentUserDecisionOptionSchema = z.object({
	optionId: z.string(),
	label: z.string(),
	// ACP 的 PermissionOptionKind：allow_once | allow_always | reject_once | reject_always。
	// 用 string 而非枚举，好让未来新增的选项类型不至于让整条消息解析失败。
	kind: z.string(),
});
export type RuntimeTaskAgentUserDecisionOption = z.infer<typeof runtimeTaskAgentUserDecisionOptionSchema>;

export const runtimeTaskAgentUserDecisionKindSchema = z.enum(["tool_permission", "elicitation_form"]);
export type RuntimeTaskAgentUserDecisionKind = z.infer<typeof runtimeTaskAgentUserDecisionKindSchema>;

export const runtimeTaskAgentUserDecisionOutcomeSchema = z.enum(["selected", "cancelled", "declined"]);
export type RuntimeTaskAgentUserDecisionOutcome = z.infer<typeof runtimeTaskAgentUserDecisionOutcomeSchema>;

export const runtimeTaskAgentUserDecisionSchema = z.object({
	decisionId: z.string(),
	kind: runtimeTaskAgentUserDecisionKindSchema,
	options: z.array(runtimeTaskAgentUserDecisionOptionSchema),
	// 未决时为 null；决出后写回，用于让前端把按钮换成「已选 X」。
	resolvedOutcome: runtimeTaskAgentUserDecisionOutcomeSchema.nullable(),
	resolvedOptionId: z.string().nullable(),
});
export type RuntimeTaskAgentUserDecision = z.infer<typeof runtimeTaskAgentUserDecisionSchema>;

export const runtimeTaskAgentUserDecisionResolveRequestSchema = z.object({
	taskId: z.string(),
	decisionId: z.string(),
	outcome: runtimeTaskAgentUserDecisionOutcomeSchema,
	optionId: z.string().optional(),
});
export type RuntimeTaskAgentUserDecisionResolveRequest = z.infer<
	typeof runtimeTaskAgentUserDecisionResolveRequestSchema
>;

export const runtimeTaskAgentUserDecisionResolveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeTaskAgentUserDecisionResolveResponse = z.infer<
	typeof runtimeTaskAgentUserDecisionResolveResponseSchema
>;

export const runtimeTaskChatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system", "tool", "reasoning", "status"]),
	content: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	createdAt: z.number(),
	meta: z
		.object({
			toolName: z.string().nullable().optional(),
			hookEventName: z.string().nullable().optional(),
			toolCallId: z.string().nullable().optional(),
			streamType: z.string().nullable().optional(),
			messageKind: z.string().nullable().optional(),
			displayRole: z.string().nullable().optional(),
			reason: z.string().nullable().optional(),
			source: z.string().nullable().optional(),
			idempotencyKey: z.string().nullable().optional(),
			promptSha256: z.string().nullable().optional(),
			// ACP 会话专用：工具调用的语义类别与状态，用于聊天面板给工具消息选图标/配色。
			// 其余富信息（diff、文件位置、plan 条目）直接渲染进 content 的 markdown，
			// 以复用既有的 markdown 渲染器，避免为每种结构再造一套 schema 与渲染分支。
			toolKind: z.string().nullable().optional(),
			toolCallStatus: z.string().nullable().optional(),
			// 等待用户拍板的决策（ACP 的 session/request_permission 与 form 型 elicitation）。
			// 挂在消息上而不是另开一条 UI 通道：决策天然属于会话流的一部分，且刷新/重连后
			// 能随消息历史一起恢复，不会丢。
			userDecision: runtimeTaskAgentUserDecisionSchema.nullable().optional(),
		})
		.nullable()
		.optional(),
});
export type RuntimeTaskChatMessage = z.infer<typeof runtimeTaskChatMessageSchema>;

export const runtimeTaskChatMessagesRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatMessagesRequest = z.infer<typeof runtimeTaskChatMessagesRequestSchema>;

export const runtimeTaskChatMessagesResponseSchema = z.object({
	ok: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskChatMessagesResponse = z.infer<typeof runtimeTaskChatMessagesResponseSchema>;

// 任务工作台的只读历史，与会启动或恢复 agent 的聊天操作分开。
export const runtimeTaskConversationHistoryPageRequestSchema = z.object({
	workspaceTaskId: z.string().min(1),
	taskConversationSessionId: z.string().min(1),
	cursor: z.string().max(4096).nullish(),
});
export type RuntimeTaskConversationHistoryPageRequest = z.infer<typeof runtimeTaskConversationHistoryPageRequestSchema>;
export const runtimeTaskConversationHistoryPageResponseSchema = z.object({
	availability: z.enum(["available", "partially_available", "unavailable"]),
	messages: z.array(runtimeTaskChatMessageSchema),
	nextCursor: z.string().nullable(),
	notice: z.string().nullable(),
});
export type RuntimeTaskConversationHistoryPageResponse = z.infer<
	typeof runtimeTaskConversationHistoryPageResponseSchema
>;

export const runtimeTaskChatSendRequestSchema = z.object({
	deliveryRequestId: z.string().min(1).optional(),
	deliveryOrigin: managedTaskPromptDeliveryOriginSchema.optional(),
	taskId: z.string(),
	// 显式会话选择（含前主会话）；省略且 taskId 是卡片 ID 时投给当前主会话。
	targetTaskConversationSessionId: z.string().optional(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	source: z.string().optional(),
	idempotencyKey: z.string().optional(),
	promptSha256: z.string().optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

// 恢复期被暂存的 harness 通知：列出（只读，供 UI 决定要不要渲染一键放行入口）与放行（消费账本 →
// 组装成一条 prompt → 经既有 sendTaskChatMessage 出口投递 → 解除恢复守卫）。
// promptTextPreview 是截断过的预览：正文可能极长（子 agent 的完整 result 会整段塞在里面），列表接口
// 不需要也不该把它整份搬进浏览器；放行时走的是账本里的完整正文，不是这份预览。
export const runtimeDeferredRestorationHarnessNotificationSchema = z.object({
	sourceHarness: z.string(),
	receivedAt: z.number(),
	promptTextPreview: z.string(),
});
export type RuntimeDeferredRestorationHarnessNotification = z.infer<
	typeof runtimeDeferredRestorationHarnessNotificationSchema
>;

export const runtimeDeferredRestorationHarnessNotificationsRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeDeferredRestorationHarnessNotificationsRequest = z.infer<
	typeof runtimeDeferredRestorationHarnessNotificationsRequestSchema
>;

export const runtimeDeferredRestorationHarnessNotificationsResponseSchema = z.object({
	ok: z.boolean(),
	notifications: z.array(runtimeDeferredRestorationHarnessNotificationSchema),
	error: z.string().optional(),
});
export type RuntimeDeferredRestorationHarnessNotificationsResponse = z.infer<
	typeof runtimeDeferredRestorationHarnessNotificationsResponseSchema
>;

export const runtimeReleaseDeferredRestorationHarnessNotificationsResponseSchema = z.object({
	ok: z.boolean(),
	releasedNotificationCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeReleaseDeferredRestorationHarnessNotificationsResponse = z.infer<
	typeof runtimeReleaseDeferredRestorationHarnessNotificationsResponseSchema
>;

export const runtimeTaskChatSendResponseSchema = z.object({
	deliveryId: z.string().optional(),
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
	// 仅程序化投递（请求带 idempotencyKey）才有；人类聊天不写账本，故为 null。
	terminalDelivery: terminalDeliveryReceiptSchema.nullable().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

export const runtimeTaskChatDeliveryCancelRequestSchema = z.object({
	taskId: z.string(),
	idempotencyKey: z.string(),
});
export type RuntimeTaskChatDeliveryCancelRequest = z.infer<typeof runtimeTaskChatDeliveryCancelRequestSchema>;

export const runtimeTaskChatDeliveryCancelResponseSchema = z.object({
	ok: z.boolean(),
	// cancelled_before_delivery：确实拦下了，文本没有进入终端。
	// already_delivered：取消晚到，在途投递已落定（真实终态在账本里）。
	// no_pending_delivery：runtime 内存里没有这条在途投递（可能从未到达 runtime，或已被取代）。
	cancelResult: z.enum(["cancelled_before_delivery", "already_delivered", "no_pending_delivery"]),
	error: z.string().optional(),
});
export type RuntimeTaskChatDeliveryCancelResponse = z.infer<typeof runtimeTaskChatDeliveryCancelResponseSchema>;

// ── Prompt Library（服务端持久化）──────────────────────────────────────────────
//
// 落点与并发语义见 src/state/prompt-library-store.ts。这里只定义线上契约。

export const promptLibraryScopeSchema = z.enum(["global", "repo", "task"]);
export type PromptLibraryScope = z.infer<typeof promptLibraryScopeSchema>;

// 条目从哪来。旧数据没有这个字段，读取时按 manual 处理，故是 optional 而**不是**带默认值的必填——
// 加默认值会让「读出来再写回去」把所有历史条目都标记成手写，抹掉将来区分暂存来源的能力。
export const promptLibraryEntryOriginSchema = z.enum([
	// 用户在面板里手写的模板。
	"manual",
	// 用户自己在终端里按了 Ctrl+S，把打了一半的输入存进库。
	"terminal_stash_by_user",
	// W1 争用抢占：程序化投递需要输入框，运行时先把人类的未提交内容无损存进库再放行。
	"terminal_stash_preempted_by_programmatic_delivery",
]);
export type PromptLibraryEntryOrigin = z.infer<typeof promptLibraryEntryOriginSchema>;

// 这次暂存的保真度。全部如实上报，不做「看起来干净」的合并——用户有权知道存进去的这段文字
// 哪里是推断出来的、哪里还原不了。
export const terminalInputBoxStashFidelitySchema = z.object({
	// 读屏时按宽度判据接回上一逻辑行的次数。**不是**错误计数：一条正常长行就会产生若干次。
	softWrapJoinCount: z.number(),
	foldedPastePlaceholderCount: z.number(),
	backfilledPlaceholderCount: z.number(),
	// 占位符配到了账本条目、但那条只剩计量没有正文。
	placeholdersLeftUnbackfilledBecausePayloadWasDropped: z.number(),
	// 占位符在账本里找不到计量对得上的条目（经 tmux / 原生终端粘进同一 PTY 等）。
	placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: z.number(),
	// 整框占位符的自洽性校验没过（`+M lines` 的 M < 3 折不出来，或 `#N` 不是严格递增）：框里混着
	// 用户手打的同形字面量、或粘贴不是按框内顺序发生的。分不清哪处是真的，于是整框放弃回填，
	// 占位符全部原样保留并计在这里。
	placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: z.number(),
	// 本次组合里载荷被丢弃（超留存上限）的粘贴条数，来自输入侧账本本身。
	unrecoverablePasteCount: z.number(),
});
export type TerminalInputBoxStashFidelity = z.infer<typeof terminalInputBoxStashFidelitySchema>;

export const promptLibraryUserPromptMatchEvidenceSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	sourceAgentId: z.string(),
	nativeSessionId: z.string().nullable(),
	userPromptMessageId: z.string(),
	userPromptSubmittedAtEpochMs: z.number().nullable(),
	matchKind: z.enum(["normalized_exact", "exact_substring", "approximate_substring"]),
});
export type PromptLibraryUserPromptMatchEvidence = z.infer<typeof promptLibraryUserPromptMatchEvidenceSchema>;

export const storedPromptLibraryEntrySchema = z.object({
	id: z.string(),
	text: z.string(),
	scope: promptLibraryScopeSchema,
	origin: promptLibraryEntryOriginSchema.optional(),
	// 这段正文当初从终端输入框读出来时的保真度。**必须落库**，不能只在 stash 当下弹一次 toast：
	// ① 抢占来源的条目是在用户不在场时写进来的，那条 toast 根本没有任何人看见；
	// ② 即便用户在场，第二天翻面板时「有 N 段粘贴还原不了」这句话已经不存在了，他会把一份缺了几段
	//    的正文当成完好的拿去用。
	// 缺字段 ≠ 保真：手写条目与升级前存的条目本来就没有这个概念，面板据此不显示任何保真度标记。
	terminalInputBoxStashFidelity: terminalInputBoxStashFidelitySchema.optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	entryKind: z.enum(["draft_prompt", "reusable_command"]).optional(),
	// 旧条目回退 updatedAt；换范围与状态标记不应改变正文编辑排序。
	textLastEditedAtEpochMs: z.number().optional(),
	draftUsage: z
		.object({
			markedUsedAtEpochMs: z.number().nullable(),
			ignoreUserPromptsSubmittedAtOrBeforeEpochMs: z.number().optional(),
			matchEvidence: promptLibraryUserPromptMatchEvidenceSchema.optional(),
		})
		.optional(),
});
export type StoredPromptLibraryEntry = z.infer<typeof storedPromptLibraryEntrySchema>;

// 一个 workspace 视角下能看到的全部条目。global 桶来自 kanban 根目录的共用文件，
// 另两个桶来自该 workspace 自己的文件（project.id 即 workspaceId）。
export const workspacePromptLibrarySnapshotSchema = z.object({
	globalScopedPrompts: z.array(storedPromptLibraryEntrySchema),
	repoScopedPrompts: z.array(storedPromptLibraryEntrySchema),
	taskScopedPromptsByTaskId: z.record(z.string(), z.array(storedPromptLibraryEntrySchema)),
});
export type WorkspacePromptLibrarySnapshot = z.infer<typeof workspacePromptLibrarySnapshotSchema>;

// scope 为 task 却漏传 taskId **不是**「分类不整洁」，而是可见性事故：本该只对某个任务可见的文字，
// 会因为调用方漏一个参数而变成整个仓库的所有任务都能看见。存储层无从知道用户原本想给哪个任务看，
// 所以这条只能在契约边界报错，不能留给存储层去猜一个桶。空串同样拒绝——它不是任何真实任务的 id。
function isTaskScopedPromptMutationCarryingItsTaskId(value: {
	scope: PromptLibraryScope;
	taskId?: string | null;
}): boolean {
	return value.scope !== "task" || (typeof value.taskId === "string" && value.taskId.length > 0);
}

const TASK_SCOPED_PROMPT_MUTATION_MISSING_TASK_ID_MESSAGE =
	"scope 为 task 的 prompt library 意图必须带上非空 taskId，否则该条目会对整个仓库可见";

// 写操作是**意图**而不是整份 PUT：多个标签页 + 运行时自己会并发写同一个库，整份 PUT 会让
// 「另一个标签页刚加的条目」被静默抹掉。服务端在文件锁内读-改-写，于是并发写自然合并。
export const workspacePromptLibraryMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("set_prompt_usage_status"),
		promptId: z.string(),
		isUsed: z.boolean(),
	}),
	z.object({
		kind: z.literal("mark_prompt_used_from_user_prompt_match"),
		promptId: z.string(),
		expectedPromptTextSha256: z.string(),
		expectedIgnoreUserPromptsSubmittedAtOrBeforeEpochMs: z.number().nullable(),
		evidence: promptLibraryUserPromptMatchEvidenceSchema,
	}),
	z.object({
		kind: z.literal("convert_prompt_to_reusable_command"),
		promptId: z.string(),
		scope: z.enum(["repo", "global"]),
	}),
	z
		.object({
			// 同一条意图兼管「新建」与「改正文」：id 不存在即新建，存在即只改正文（**不**动它所在的桶）。
			kind: z.literal("upsert_prompt"),
			promptId: z.string(),
			text: z.string(),
			// 仅新建时生效；已存在的条目换桶请用 set_prompt_scope。
			scope: promptLibraryScopeSchema,
			// scope 为 task 时必填（由下面的 refine 强制），其余忽略。
			taskId: z.string().nullable().optional(),
			origin: promptLibraryEntryOriginSchema.optional(),
			// 仅新建时随条目落库（与 origin 同理）：它描述的是「这段正文当初是怎么读出来的」，
			// 而后续在面板里改文是用户自己打的字，那时的保真度概念已经不适用。
			terminalInputBoxStashFidelity: terminalInputBoxStashFidelitySchema.optional(),
		})
		.refine(isTaskScopedPromptMutationCarryingItsTaskId, {
			message: TASK_SCOPED_PROMPT_MUTATION_MISSING_TASK_ID_MESSAGE,
			path: ["taskId"],
		}),
	z.object({
		kind: z.literal("remove_prompt"),
		promptId: z.string(),
	}),
	z
		.object({
			kind: z.literal("set_prompt_scope"),
			promptId: z.string(),
			scope: promptLibraryScopeSchema,
			// 搬进 task scope 时必填（由下面的 refine 强制）：搬去「哪个任务」正是这条意图的内容。
			taskId: z.string().nullable().optional(),
		})
		.refine(isTaskScopedPromptMutationCarryingItsTaskId, {
			message: TASK_SCOPED_PROMPT_MUTATION_MISSING_TASK_ID_MESSAGE,
			path: ["taskId"],
		}),
	// 把某个浏览器 localStorage 里攒下的整份库合并进来。**不是** upsert_prompt 的批量版：
	//   - 去重键是「同一个桶里的同一段正文」，不是 id。各 origin 的 id 是各自 randomUUID 生成的，
	//     同一条模板在两个 origin 里 id 必然不同，按 id 去重等于一条都去不掉、库里堆满重复；
	//   - 时间戳由**载荷**带来而不是服务端盖章：迁移搬的是历史数据，盖上「现在」会让所有模板的
	//     创建时间变成升级那一刻，用户再也分不清哪条是三个月前写的。
	// 幂等：第二次跑同一份载荷时每条正文都已存在，于是只做时间戳收敛、不新增条目。
	z.object({
		kind: z.literal("merge_prompts_migrated_from_browser_local_storage"),
		prompts: z.array(
			z
				.object({
					id: z.string(),
					text: z.string(),
					scope: promptLibraryScopeSchema,
					taskId: z.string().nullable().optional(),
					origin: promptLibraryEntryOriginSchema.optional(),
					createdAt: z.number(),
					updatedAt: z.number(),
				})
				.refine(isTaskScopedPromptMutationCarryingItsTaskId, {
					message: TASK_SCOPED_PROMPT_MUTATION_MISSING_TASK_ID_MESSAGE,
					path: ["taskId"],
				}),
		),
	}),
]);
export type WorkspacePromptLibraryMutation = z.infer<typeof workspacePromptLibraryMutationSchema>;

export const runtimePromptLibraryReadRequestSchema = z.object({});
export type RuntimePromptLibraryReadRequest = z.infer<typeof runtimePromptLibraryReadRequestSchema>;

export const runtimePromptLibraryResponseSchema = z.object({
	ok: z.boolean(),
	library: workspacePromptLibrarySnapshotSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimePromptLibraryResponse = z.infer<typeof runtimePromptLibraryResponseSchema>;

export const runtimePromptLibraryMutateRequestSchema = z.object({
	mutation: workspacePromptLibraryMutationSchema,
});
export type RuntimePromptLibraryMutateRequest = z.infer<typeof runtimePromptLibraryMutateRequestSchema>;

// ── 排队 Prompt 投递 ──
// 契约块已上移到 runtimeStateStreamMessageSchema 之前（TDZ：queued_task_prompt_deliveries_updated 推流消息
// 引用本节的投影 schema，union 在模块求值时就要拿到它）。

// ── 任务编辑草稿（服务端持久化）──────────────────────────────────────────────
//
// 用户在编辑任务对话框里打了字但还没保存的那一份。它是**无法重建的原创内容**（正文 + 内联 base64
// 图片 + 整套 agent/权限/worktree 设置），原先只活在浏览器 localStorage 里，换 origin 就看不见了。
//
// 落点是每个 workspace 一份独立文件（~/.cline/kanban/workspaces/<id>/task-edit-drafts.json），
// **不进 board.json**：草稿带内联 base64 图片，而 board.json 是每次看板改动都整体读写 + 广播的最热
// 路径，把易膨胀数据塞进去等于把膨胀直接打在那条链上。
export const runtimeTaskEditDraftSchema = z.object({
	taskTitleOverride: z.string().optional(),
	taskId: z.string(),
	prompt: z.string(),
	images: z.array(runtimeTaskImageSchema),
	taskConversationMode: runtimeTaskConversationModeSchema.optional(),
	startInPlanMode: z.boolean(),
	taskAgentPermissionMode: runtimeTaskAgentPermissionModeSchema.optional(),
	autoReviewEnabled: z.boolean(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema,
	branchRef: z.string(),
	agentId: runtimeAgentIdSchema.optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
	terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
	taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
	savedAt: z.number(),
});
export type RuntimeTaskEditDraft = z.infer<typeof runtimeTaskEditDraftSchema>;

// 合并时按 savedAt 落败的那一份。**绝不静默丢弃**：草稿是原创内容，判错一次就再也拿不回来了。
export const runtimeSupersededTaskEditDraftCopySchema = z.object({
	draft: runtimeTaskEditDraftSchema,
	// 它是在哪一次合并里落选的（epoch ms），用于在界面上说明「这份是什么时候被顶下来的」。
	supersededAt: z.number(),
	// 顶掉它的那一份的 savedAt，让用户一眼看出两份差了多久。
	supersededBySavedAt: z.number(),
});
export type RuntimeSupersededTaskEditDraftCopy = z.infer<typeof runtimeSupersededTaskEditDraftCopySchema>;

export const workspaceTaskEditDraftsSnapshotSchema = z.object({
	draftsByTaskId: z.record(z.string(), runtimeTaskEditDraftSchema),
	supersededDraftCopies: z.array(runtimeSupersededTaskEditDraftCopySchema),
});
export type WorkspaceTaskEditDraftsSnapshot = z.infer<typeof workspaceTaskEditDraftsSnapshotSchema>;

// 与 prompt library 同理：写的是意图而不是整份 PUT，多标签页并发写才能在服务端的文件锁内自然合并。
export const workspaceTaskEditDraftMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("save_task_edit_draft"),
		draft: runtimeTaskEditDraftSchema,
	}),
	z.object({
		kind: z.literal("clear_task_edit_draft"),
		taskId: z.string(),
	}),
	// 一次清掉某个任务的草稿**及其**全部落败副本。任务被删除时用——任务都没了，它的草稿留着只会
	// 变成永远无法认领的孤儿。这与「用户保存/放弃了编辑」是两件事，故是独立意图。
	z.object({
		kind: z.literal("discard_all_task_edit_drafts_for_deleted_task"),
		taskId: z.string(),
	}),
	z.object({
		// 用户在编辑对话框的通知栏里显式丢弃某一份落败副本。**这是副本唯一的删除路径**：副本绝不因为
		// 超时、因为任务被编辑过、因为它「看起来旧」而自动过期——那是原创内容，判错一次就再也拿不回来。
		// （唯一的例外仍是 discard_all_task_edit_drafts_for_deleted_task：任务本体都没了。）
		kind: z.literal("discard_superseded_task_edit_draft_copy"),
		taskId: z.string(),
		// 定位这一份副本用的是**它自己的 savedAt**，而不是 supersededAt / supersededBySavedAt。
		// 唯一性直接来自留存时的去重规则（同 taskId + 同 savedAt 视为同一次编辑，只留一份），所以
		// (taskId, savedAt) 天然是主键，不必再引入 copyId。反过来用 (supersededAt, supersededBySavedAt)
		// 则**没有**任何不变量保证唯一：同一次迁移里两份 savedAt 不同的草稿被同一份胜出草稿顶掉时，
		// 它俩的这两个字段完全相同。
		supersededDraftSavedAt: z.number(),
	}),
	// 把某一份落败副本升回「当前草稿」，被顶下来的那份当前草稿按同一规则转存为副本。
	//
	// 必须是**一条**意图：拆成「先清当前、再存副本」两次请求就有中间态，而中间态一旦被另一个标签页
	// 的写入撞上就会丢字。「用这份替换当前」也**不是**丢弃——被换下来的那份不进副本，这个按钮自己
	// 就成了新的静默丢字点。
	z.object({
		kind: z.literal("promote_superseded_task_edit_draft_copy_to_current_draft"),
		taskId: z.string(),
		supersededDraftSavedAt: z.number(),
	}),
	z.object({
		kind: z.literal("merge_task_edit_drafts_migrated_from_browser_local_storage"),
		drafts: z.array(runtimeTaskEditDraftSchema),
	}),
]);
export type WorkspaceTaskEditDraftMutation = z.infer<typeof workspaceTaskEditDraftMutationSchema>;

export const runtimeTaskEditDraftsReadRequestSchema = z.object({});
export type RuntimeTaskEditDraftsReadRequest = z.infer<typeof runtimeTaskEditDraftsReadRequestSchema>;

export const runtimeTaskEditDraftsResponseSchema = z.object({
	ok: z.boolean(),
	drafts: workspaceTaskEditDraftsSnapshotSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskEditDraftsResponse = z.infer<typeof runtimeTaskEditDraftsResponseSchema>;

export const runtimeTaskEditDraftsMutateRequestSchema = z.object({
	mutation: workspaceTaskEditDraftMutationSchema,
});
export type RuntimeTaskEditDraftsMutateRequest = z.infer<typeof runtimeTaskEditDraftsMutateRequestSchema>;

// ── 终端输入框暂存进 Prompt Library（W2 Ctrl+S）──────────────────────────────────
//
// 一次请求就是一整条原子链路：读框 → 回填被折叠的粘贴 → 写库 → 转发 Ctrl+S 字节清框。
// 前端只负责拦下按键，不碰内容——同一份易随版本漂移的 TUI 画法知识只在服务端存一份。

export const terminalInputBoxStashOutcomeSchema = z.enum([
	// 正文已入库，Ctrl+S 已转发（框被 agent 自己清掉）。
	"stashed_into_prompt_library",
	// 正文**已经**入库（stashedPromptId 有效），但清框那一步没做成：写库跨文件锁与落盘期间，读框时
	// 的那条 PTY 已经退出、或被 refresh 换成了新 incarnation。此时绝不能把 Ctrl+S 打到新会话上——那会
	// 清掉一段与本次暂存毫无关系的输入。剩下的真实状态就是「库里有了、框里也还在」，如实报出来即可：
	// 报纯成功会让用户以为框被清是理所当然，随后发现内容还在反而怀疑是不是没存进去。
	"stashed_into_prompt_library_but_input_box_not_cleared",
	// 同一个 task 上已经有一次暂存在进行中（连按 Ctrl+S / 多标签页同时触发）。这一次按键**没有**做任何
	// 事：没入库、也没转发 Ctrl+S，框里内容一个字都没少。刻意不排队复用前一次的结果——排队者醒来时框
	// 已被清空，只能报「框是空的」，那是个语义已经错位的回执。静默吞掉更不行：用户按了键，就得知道
	// 这一次为什么没生效。
	"another_terminal_input_box_stash_attempt_already_in_flight_for_this_task",
	// 两路判据都说框是空的：没有可暂存的东西。Ctrl+S 照常转发（对空框是无操作）。
	"input_box_empty_nothing_to_stash",
	// 有内容迹象却读不出可用正文（该 agent 的输入框语法尚未建模 / 当前屏定位不到框）。
	// Ctrl+S 仍然转发：那是 agent 自己的原生 stash，内容进它自己的暂存区，不比「Kanban 完全不介入」更差。
	// **仅出现在用户亲手按键那条路径上**——转发的正当性全部来自「这个键是他按的」。
	"input_box_content_unreadable_forwarded_to_agent_native_stash",
	// 同一个捕获结果（输入侧确知框里有未提交内容、读屏拿不到正文），但这次暂存是 W1 争用抢占发起的：
	// **什么都没做**，没入库也没转发 Ctrl+S，框里那半句话一个字没少。
	//
	// 为什么两条路径在这里的正确行为恰好相反：抢占路径上根本没有人按键，转发就不再是「替用户把他按的
	// 键送到 agent」，而是凭空拿走人类打了一半的内容——正文被 agent 自己的暂存区吞掉、Kanban 侧一无所有，
	// 而抢占方还会如实返回失败、这次投递也不会发生。也就是说：**内容没了，却连一次投递都没换到**。
	"input_box_content_unreadable_and_left_untouched",
	// 屏上确实有文字，但它一个字节都没经过本运行时的 writeInput，因此无从区分「用户敲的内容」与
	// 「agent 自己渲染的空框占位提示」（Claude 偶发的 `Try "..."`）。不入库——把 agent 的 UI 文案
	// 当成用户资产存进去，比暂时存不了更糟。同样转发 Ctrl+S 交给 agent 原生暂存兜底。
	"input_box_screen_text_not_corroborated_by_keystroke_tracking",
	// 这个任务此刻没有可信的 PTY 会话。两种情形共用这一条：压根没有 active，或者读框到清框之间那条
	// 会话退出/被换代了（此时既没入库也没清框，什么都没发生，与前者对用户等价）。
	"no_active_terminal_session",
	// 写库失败。**不**转发 Ctrl+S——正文原样留在框里，用户看得见也能重试；转发只会把它藏进
	// agent 的暂存区，而 Kanban 这边什么都没有。
	"prompt_library_write_failed",
]);
export type TerminalInputBoxStashOutcome = z.infer<typeof terminalInputBoxStashOutcomeSchema>;

export const runtimeTerminalInputBoxStashRequestSchema = z.object({
	taskId: z.string(),
	// 省略即 task scope，与面板里「新建 prompt」的默认一致。
	scope: promptLibraryScopeSchema.optional(),
});
export type RuntimeTerminalInputBoxStashRequest = z.infer<typeof runtimeTerminalInputBoxStashRequestSchema>;

export const runtimeTerminalInputBoxStashResponseSchema = z.object({
	ok: z.boolean(),
	outcome: terminalInputBoxStashOutcomeSchema,
	stashedPromptId: z.string().nullable(),
	// 只回字符数不回正文：正文最大可达粘贴留存上限（1 MiB），而调用方要的只是一句「存进去多少」。
	// 同理**不**捎带整库快照（`workspacePromptLibrarySnapshotSchema` 里每一条都带完整正文，条目数还随
	// 使用无上限增长）——那会把上面这条取舍原样抵消掉：每按一次 Ctrl+S 都要序列化「刚存进去的那段正文
	// + 一整个库」。要读库请单独走 getWorkspacePromptLibrary，那条 procedure 的存在意义就是它。
	stashedTextCharacterCount: z.number(),
	fidelity: terminalInputBoxStashFidelitySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTerminalInputBoxStashResponse = z.infer<typeof runtimeTerminalInputBoxStashResponseSchema>;

export const runtimeTaskChatReloadRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatReloadRequest = z.infer<typeof runtimeTaskChatReloadRequestSchema>;

export const runtimeTaskChatReloadResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatReloadResponse = z.infer<typeof runtimeTaskChatReloadResponseSchema>;

export const runtimeTaskChatAbortRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatAbortRequest = z.infer<typeof runtimeTaskChatAbortRequestSchema>;

export const runtimeTaskChatAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatAbortResponse = z.infer<typeof runtimeTaskChatAbortResponseSchema>;

export const runtimeTaskChatCancelRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatCancelRequest = z.infer<typeof runtimeTaskChatCancelRequestSchema>;

export const runtimeTaskChatCancelResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatCancelResponse = z.infer<typeof runtimeTaskChatCancelResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

// Sent when a viewer returns from a hidden browser tab. While hidden it discarded
// live output instead of rendering it (to avoid a "time-lapse" backlog replay), so it
// asks the server to re-send a fresh snapshot to jump straight to the latest screen.
export const runtimeTerminalWsRequestRestoreMessageSchema = z.object({
	type: z.literal("request_restore"),
});
export type RuntimeTerminalWsRequestRestoreMessage = z.infer<typeof runtimeTerminalWsRequestRestoreMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
	runtimeTerminalWsRequestRestoreMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitChangedFileMetadataSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
});
export type RuntimeGitCommitChangedFileMetadata = z.infer<typeof runtimeGitCommitChangedFileMetadataSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitCommitChangedFileMetadataRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitChangedFileMetadataRequest = z.infer<
	typeof runtimeGitCommitChangedFileMetadataRequestSchema
>;

export const runtimeGitCommitChangedFileMetadataResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitChangedFileMetadataSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitChangedFileMetadataResponse = z.infer<
	typeof runtimeGitCommitChangedFileMetadataResponseSchema
>;

export const runtimeGitCommitFileDiffPatchRequestSchema = z.object({
	commitHash: z.string(),
	path: z.string(),
	previousPath: z.string().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitFileDiffPatchRequest = z.infer<typeof runtimeGitCommitFileDiffPatchRequestSchema>;

export const runtimeGitCommitFileDiffPatchResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	path: z.string(),
	previousPath: z.string().optional(),
	patch: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCommitFileDiffPatchResponse = z.infer<typeof runtimeGitCommitFileDiffPatchResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum([
	"to_review",
	"to_in_progress",
	"activity",
	"agent_conversation_session_identity_observed",
	"main_agent_conversation_context_compaction_started",
	// harness 的 PostCompact（Claude / Codex / Kimi）：主对话上下文压缩已完成。专用事件、不复用 activity：
	// 它只推进 Cache warm 起点，不该顺带推进「对话推进」药丸、刷新活动行或进入通知捕获。
	"main_agent_conversation_context_compaction_completed",
]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

// 压缩的触发方式（三家 harness 的 PostCompact 载荷都叫 `trigger: "manual" | "auto"`）。
export const runtimeMainAgentConversationContextCompactionTriggerSchema = z.enum([
	// 用户在终端里敲了 /compact（发生在用户回合，压缩完不会紧跟续写请求）。
	"manual_compact_command",
	// 上下文窗口接近上限时 harness 在 agent 回合中自动压缩，续写请求紧随其后。
	"automatic_context_window_compaction",
]);
export type RuntimeMainAgentConversationContextCompactionTrigger = z.infer<
	typeof runtimeMainAgentConversationContextCompactionTriggerSchema
>;

// Canonical schema source:
//   workflow-plugin-design-system/schemas/report-validation-contract.schema.json
// Mirror enum strings verbatim; do not invent synonyms or import the upstream
// package (it is not a cline-kanban dependency). RuntimeReportEvent is the
// report lifecycle (report_filed / report_validated / ...) and is semantically
// orthogonal to RuntimeHookEvent above (agent runtime activity).
export const runtimeReportEventSchema = z.enum([
	"report_filed",
	"report_validated",
	"report_rejected",
	"report_evidence_attached",
]);
export type RuntimeReportEvent = z.infer<typeof runtimeReportEventSchema>;

export const runtimeReportEventMetadataSchema = z.object({
	reportId: z.string(),
	reportSource: z.enum(["in_app_kanban", "agent_self_report", "rvf_review_agent"]),
	subClaimTarget: z
		.enum(["issue_exists", "behavior_matches_report", "cause_attribution", "reporter_supplied", "synthesis_pending"])
		.nullable()
		.default(null),
	severity: z.enum(["critical", "high", "medium", "low", "unknown"]).nullable().default(null),
	userImpactLevel: z.enum(["blocking", "degraded", "annoyance", "cosmetic", "unknown"]).nullable().default(null),
	evidenceArtifactPath: z.string().nullable().default(null),
	reasonCode: z.string().nullable().default(null),
});
export type RuntimeReportEventMetadata = z.infer<typeof runtimeReportEventMetadataSchema>;

// agent 发起的「等你拍板」决策 payload。**白名单字段**，由 `kanban hooks ingest` 从已解析的
// stdin JSON 里挑出来——刻意不把整个 hook payload 透传给 daemon（既是隐私边界，也避免把 harness
// 的私有形状固化成 Kanban 契约）。
//
// 为什么需要它：会话在宽限期到期后会被回收，进程一死，那个「agent 刚问了你一个问题」的 TUI 画面
// 就没了。有了结构化 payload，Kanban 才能在用户下次进入任务时**独立于会话进程**重现问题与选项。
export const runtimeAgentRaisedDecisionOptionSchema = z.object({
	optionId: z.string(),
	label: z.string(),
	description: z.string().optional(),
	// AskUserQuestion 单选题可给每个选项附一段 preview（常见为等宽对比矩阵）。原样保留换行与空白，
	// UI 以等宽块渲染；它与 description 是两段不同内容，不能拼进同一行。
	previewText: z.string().optional(),
});
export type RuntimeAgentRaisedDecisionOption = z.infer<typeof runtimeAgentRaisedDecisionOptionSchema>;

export const runtimeAgentRaisedDecisionQuestionSchema = z.object({
	decisionQuestionId: z.string(),
	headerMarkdown: z.string().nullable(),
	questionMarkdown: z.string(),
	selectionMode: z.enum(["single", "multiple"]),
	options: z.array(runtimeAgentRaisedDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
});
export type RuntimeAgentRaisedDecisionQuestion = z.infer<typeof runtimeAgentRaisedDecisionQuestionSchema>;

export const runtimeAgentRaisedUserQuestionPayloadSchema = z.object({
	nativeConversationSessionId: z.string().optional(),
	// harness 提供的稳定标识（Claude 的 tool_use_id），用于跨重发去重。
	decisionSourceId: z.string(),
	questionMarkdown: z.string(),
	options: z.array(runtimeAgentRaisedDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
	multiSelect: z.boolean(),
	orderedQuestions: z.array(runtimeAgentRaisedDecisionQuestionSchema),
});
export type RuntimeAgentRaisedUserQuestionPayload = z.infer<typeof runtimeAgentRaisedUserQuestionPayloadSchema>;

// 工具授权请求：只带工具名与参数**摘要**，绝不带参数正文——避免把命令行 / 路径 / 密钥落进盘。
export const runtimeAgentRaisedToolPermissionPayloadSchema = z.object({
	decisionSourceId: z.string(),
	toolName: z.string(),
	toolInputSummary: z.string().nullable(),
});
export type RuntimeAgentRaisedToolPermissionPayload = z.infer<typeof runtimeAgentRaisedToolPermissionPayloadSchema>;

// 用户**直接在 agent 终端里**对 Claude AskUserQuestion 或 Codex request_user_input 作答后，PostToolUse / PostToolUseFailure
// 带回的结局。没有它，durable 账本就永远不知道这个问题已经在终端里了结，面板会一直挂着「尚未回答」；
// 有了它，终端里的作答（含每问备注）也能进入 Kanban 的问答记录——那些备注在 TUI 里是看不清的。
export const runtimeAgentRaisedUserQuestionAgentTerminalAnswerForQuestionSchema = z.object({
	questionText: z.string(),
	// harness 回传的原始答案文本：单选为选项标签，多选为逗号拼接的标签，「其他」为用户手打的文字。
	answerText: z.string().nullable(),
	notesText: z.string().nullable(),
});
export type RuntimeAgentRaisedUserQuestionAgentTerminalAnswerForQuestion = z.infer<
	typeof runtimeAgentRaisedUserQuestionAgentTerminalAnswerForQuestionSchema
>;

export const runtimeAgentRaisedUserQuestionResolvedInAgentTerminalPayloadSchema = z.object({
	sourceAgentId: z.literal("codex").optional(),
	nativeConversationSessionId: z.string().optional(),
	// 与 PreToolUse 同源：Claude 使用 tool_use_id；Codex 使用 nativeSessionId:call_id，且禁止正文回落匹配。
	decisionSourceId: z.string().nullable(),
	resolutionKind: z.enum([
		"answered_in_agent_terminal",
		"declined_in_agent_terminal",
		"interrupted_without_answer",
		"failed_without_answer",
	]),
	answersForQuestions: z.array(runtimeAgentRaisedUserQuestionAgentTerminalAnswerForQuestionSchema),
});
export type RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload = z.infer<
	typeof runtimeAgentRaisedUserQuestionResolvedInAgentTerminalPayloadSchema
>;

// 一次工具调用的执行结果（按 task 归因的资源占用采集，S2）。由 `kanban hooks` 从 PreToolUse /
// PostToolUse / PostToolUseFailure 的 stdin 提取，**不进** metadata：metadata 会经 applyHookActivity 写进
// session summary（进而进 sessions.json 与广播），而这些是只给 journal 的逐调用记录。
// 命令文本在 hooks CLI 进程内就已截断 + 脱敏，服务端与 journal 永远拿不到原文。
export const runtimeAgentToolCallExecutionOutcomeSchema = z.object({
	toolCallLifecyclePhase: z.enum(["tool_call_started", "tool_call_succeeded", "tool_call_failed"]),
	toolName: z.string(),
	toolUseId: z.string().nullable(),
	// hook 自报的工具本体执行时长（不含权限等待）；只有 Claude 的 Post 事件保证提供，其余 harness 为 null。
	toolExecutionDurationMs: z.number().nonnegative().nullable(),
	toolCallWasInterrupted: z.boolean().nullable(),
	commandLineTextForJournal: z.string().nullable(),
	originalCommandLineCharacterCount: z.number().int().nonnegative().nullable(),
	commandLineTextWasTruncated: z.boolean().nullable(),
	mcpServerName: z.string().nullable(),
	mcpToolName: z.string().nullable(),
});
export type RuntimeAgentToolCallExecutionOutcome = z.infer<typeof runtimeAgentToolCallExecutionOutcomeSchema>;

// `kanban hooks` CLI 进程自身的开销，在每次发送 ingest 前取值（Claude 每次工具调用会起两个这样的
// node 进程，现场实测同时存活过 21 个、RSS 合计约 3.5 GiB）。测不到发送之后那一小段。
export const runtimeHookCliProcessResourceUsageSchema = z.object({
	lifetimeMaximumResidentSetSizeKibibytes: z.number().nonnegative(),
	cumulativeUserCpuTimeSeconds: z.number().nonnegative(),
	cumulativeSystemCpuTimeSeconds: z.number().nonnegative(),
	hookCliProcessUptimeMs: z.number().nonnegative(),
	hookIngestDeliveryAttempt: z.number().int().positive(),
});
export type RuntimeHookCliProcessResourceUsage = z.infer<typeof runtimeHookCliProcessResourceUsageSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	notificationCandidateId: z.string().uuid().optional(),
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
	// 仅在 agent 确实发起了「等你拍板」的决策时携带（AskUserQuestion / PermissionRequest）。
	// 两者互斥：一次 hook 只可能是其中一种。
	agentRaisedUserQuestion: runtimeAgentRaisedUserQuestionPayloadSchema.optional(),
	agentRaisedToolPermission: runtimeAgentRaisedToolPermissionPayloadSchema.optional(),
	// 仅 PostToolUse / PostToolUseFailure(AskUserQuestion) 携带：问题已在终端里了结。
	agentRaisedUserQuestionResolvedInAgentTerminal:
		runtimeAgentRaisedUserQuestionResolvedInAgentTerminalPayloadSchema.optional(),
	// UserPromptSubmit 的 prompt 只在同步 hook 请求内短暂流转，用于区分真人输入与 harness 在恢复时
	// 自动塞入的任务通知；普通诊断日志与 session summary 均不得记录它。
	submittedPromptText: z.string().optional(),
	claudeNativeTaskListIdForPhaseGoalProjection: z.string().min(1).max(200).nullable().optional(),
	// hook 是否从子代理内部触发（`kanban hooks` 从 hook stdin 的 `agent_id` 派生；Claude Code 只在子代理
	// 内的事件上带它，主线程一律不带）。子代理的请求走自己的缓存前缀，不刷新主对话的 Cache warm 起点。
	// 只传布尔、不传 id 本身：服务端唯一用途就是这道排除。
	hookEventFiredInsideSubagentContext: z.boolean().optional(),
	// 仅 main_agent_conversation_context_compaction_completed 携带：harness 报告的压缩触发方式（从 hook stdin 的
	// `trigger` 派生）。缺失时服务端按当时的回合归属判定。
	mainAgentConversationContextCompactionTriggerReportedByHarness:
		runtimeMainAgentConversationContextCompactionTriggerSchema.optional(),
	// Codex 压缩阶段的原生回合与启动代际；仅用于关联待确认投递，不能作为接受证明。
	mainAgentConversationContextCompactionNativeTurnId: z.string().min(1).max(200).optional(),
	hookRuntimeSessionIncarnationId: z.string().uuid().optional(),
	// 仅压缩完成事件、且 harness 报了压缩后上下文大小时携带（Kimi 的 estimatedTokenCount）。
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness: z.number().int().nonnegative().optional(),
	// 终端 agent 原生会话身份（N0a）：`kanban hooks` 从 hook stdin 的 session_id / transcript_path 抽出，
	// 每个事件都带（幂等），服务端只在值变化时写 summary sidecar。
	agentNativeConversationSessionIdentity: runtimeAgentNativeConversationSessionIdentitySchema.optional(),
	// 资源占用采集：仅工具类 hook 事件携带 / 每次发送都携带。服务端只写 journal，不进 summary。
	agentToolCallExecutionOutcome: runtimeAgentToolCallExecutionOutcomeSchema.optional(),
	hookCliProcessResourceUsage: runtimeHookCliProcessResourceUsageSchema.optional(),
	// hooks CLI 进程启动那一刻的墙钟（热重启 P3）。runtime 缺席时事件先进 agent session PTY host 的 spool，
	// 晚几秒到几小时才送达；停止 / 开始 / 对话推进 / 提问这些领域时刻按它记账，而不是按送达时刻。
	// 缺失（旧 CLI）时服务端按送达时刻处理；晚于送达时刻的值按送达时刻截断（不信任跑到未来的时钟）。
	hookEventCapturedAtEpochMs: z.number().int().nonnegative().optional(),
	// 每次 hooks CLI 调用生成一个，传输重试与 spool 重放复用同一个：同一事件只应用一次。
	// 旧 runtime 已应用、但没来得及回响应就崩溃的事件，CLI 会把它 spool 起来，新 runtime 靠它识别出来。
	hookEventDeliveryIdempotencyKey: z.string().min(1).max(128).optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHarnessUserPromptProcessingDirectiveSchema = z.object({
	processingDecision: z.enum(["allow", "block_and_defer_until_explicit_user_input"]),
	userVisibleReason: z.string().optional(),
	additionalContextMarkdown: z.string().optional(),
});
export type RuntimeHarnessUserPromptProcessingDirective = z.infer<
	typeof runtimeHarnessUserPromptProcessingDirectiveSchema
>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
	harnessUserPromptProcessingDirective: runtimeHarnessUserPromptProcessingDirectiveSchema.optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;

// ── 待答用户决策的读写契约（会话被回收后仍能重现并作答）─────────────────────────────────
// decisionKind 刻意只有两种、**没有 plan_review**：计划审批不做 carry-forward。
export const runtimePendingUserDecisionQuestionAnswerDraftSchema = z.object({
	decisionQuestionId: z.string(),
	selectedOptionIds: z.array(z.string()),
	freeformText: z.string().nullable(),
});
export type RuntimePendingUserDecisionQuestionAnswerDraft = z.infer<
	typeof runtimePendingUserDecisionQuestionAnswerDraftSchema
>;

export const runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema = z.object({
	orderedQuestionAnswers: z.array(runtimePendingUserDecisionQuestionAnswerDraftSchema),
	savedAt: z.number(),
	// 浏览器编辑时产生的递增版本；旧草稿无此字段，不能让旧备份覆盖已确认的新版本。
	answerDraftEditVersion: z.number().int().nonnegative().optional(),
});
export type RuntimeAgentRaisedPendingUserDecisionAnswerDraft = z.infer<
	typeof runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema
>;

export const runtimeAgentRaisedPendingUserDecisionSchema = z.object({
	nativeToolCallOutcome: z.enum(["interrupted_without_answer", "failed_without_answer"]).optional(),
	decisionId: z.string(),
	taskId: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	decisionKind: z.enum(["ordinary_user_question", "tool_permission_request"]),
	questionMarkdown: z.string(),
	options: z.array(runtimeAgentRaisedDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
	orderedQuestions: z.array(runtimeAgentRaisedDecisionQuestionSchema),
	askedAt: z.number(),
	// 会话已被回收的时刻；null = 提问它的那个会话还活着，可以直接答给它。
	reclaimedAt: z.number().nullable(),
	answerDeliveryState: z.enum([
		"not_answered",
		"answer_recorded",
		"delivery_in_progress",
		"delivered",
		"delivery_failed",
	]),
	lastAnswerDeliveryFailureReason: z.string().nullable(),
	// 提问它的那个会话活体。与当前会话 summary 的 runtimeSessionIncarnationId 相同且会话仍在跑，
	// 即说明 agent 此刻正停在终端里的交互式选择器上——UI 据此默认折叠、引导去终端作答；
	// 不同（会话已被回收 / 重启 / resume）或为 null（来源不明，如转录补录）则选择器早已不在，UI 主动展开。
	originRuntimeSessionIncarnationId: z.string().nullable(),
	// 尚未提交的面板编辑，与已记录答案分开；旧版本无此字段。
	pendingAnswerDraft: runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema.nullable().optional(),
	// 已记下但尚未确认送达的答案；让 UI 在「已保存、未送达」时如实回显用户答了什么，而不是一张空表单。
	recordedAnswerQuestionAnswers: z
		.array(
			z.object({
				decisionQuestionId: z.string(),
				selectedOptionIds: z.array(z.string()),
				freeformText: z.string().nullable(),
			}),
		)
		.nullable(),
});
export type RuntimeAgentRaisedPendingUserDecision = z.infer<typeof runtimeAgentRaisedPendingUserDecisionSchema>;

// ── 问答记录：已了结的 agent 提问与用户的答案（含终端里作答时写下的备注）────────────────────
// 存在意义：答案与备注在 TUI 里要么被折叠成 [Pasted text #N]、要么和选项混在一起看不清结构；
// 这里把「问了什么、选了什么、补充了什么、在哪答的、有没有送达」结构化地摆出来。
export const runtimeAgentRaisedUserDecisionHistoryResolutionSchema = z.enum([
	"interrupted_without_answer",
	"failed_without_answer",
	"answered_in_kanban_panel",
	"answered_in_agent_terminal",
	"declined_in_agent_terminal",
	"dismissed_in_kanban_panel",
	// 用户切换了该 task 的 agent 会话通道（transport），仍在等答的问题被 Kanban 自动取消回给 agent——
	// 用户没有在面板或终端里对它做过任何动作。
	"cancelled_by_agent_session_transport_switch",
	// 同一 task 上 agent 接着问了新问题，旧问题从未得到回答。
	"superseded_by_later_question_without_answer",
]);
export type RuntimeAgentRaisedUserDecisionHistoryResolution = z.infer<
	typeof runtimeAgentRaisedUserDecisionHistoryResolutionSchema
>;

export const runtimeAgentRaisedUserDecisionHistoryQuestionAnswerSchema = z.object({
	decisionQuestionId: z.string(),
	selectedOptionLabels: z.array(z.string()),
	// 不对应任何选项的自由回答（面板里的「其他回答」或终端里的「Other」）。
	freeformAnswerText: z.string().nullable(),
	// 终端作答时写下的每问备注；面板作答没有独立备注字段，为 null。
	notesText: z.string().nullable(),
});
export type RuntimeAgentRaisedUserDecisionHistoryQuestionAnswer = z.infer<
	typeof runtimeAgentRaisedUserDecisionHistoryQuestionAnswerSchema
>;

export const runtimeAgentRaisedUserDecisionHistoryEntrySchema = z.object({
	historyEntryId: z.string(),
	taskId: z.string(),
	// 记录来源：Kanban 决策账本，或从 agent 转录回填（早于本功能、或账本已裁剪的旧问答）。
	recordSource: z.enum(["kanban_decision_ledger", "agent_conversation_transcript"]),
	decisionKind: z.enum(["ordinary_user_question", "tool_permission_request"]),
	askedAt: z.number(),
	resolvedAt: z.number().nullable(),
	resolution: runtimeAgentRaisedUserDecisionHistoryResolutionSchema,
	orderedQuestions: z.array(runtimeAgentRaisedDecisionQuestionSchema),
	questionAnswers: z.array(runtimeAgentRaisedUserDecisionHistoryQuestionAnswerSchema),
	// 面板作答才有投递状态；终端作答天然已送达、转录回填无此概念，均为 null。
	answerDeliveryState: z
		.enum(["not_answered", "answer_recorded", "delivery_in_progress", "delivered", "delivery_failed"])
		.nullable(),
});
export type RuntimeAgentRaisedUserDecisionHistoryEntry = z.infer<
	typeof runtimeAgentRaisedUserDecisionHistoryEntrySchema
>;

export const runtimeListAgentRaisedUserDecisionHistoryForTaskRequestSchema = z.object({
	taskId: z.string().trim().min(1),
});
export type RuntimeListAgentRaisedUserDecisionHistoryForTaskRequest = z.infer<
	typeof runtimeListAgentRaisedUserDecisionHistoryForTaskRequestSchema
>;

export const runtimeListAgentRaisedUserDecisionHistoryForTaskResponseSchema = z.object({
	transcriptRecoveryNotice: z.string().nullable().optional(),
	// 按提问时间倒序（最近的在前）。
	historyEntries: z.array(runtimeAgentRaisedUserDecisionHistoryEntrySchema),
});
export type RuntimeListAgentRaisedUserDecisionHistoryForTaskResponse = z.infer<
	typeof runtimeListAgentRaisedUserDecisionHistoryForTaskResponseSchema
>;

export const runtimeListAgentRaisedPendingUserDecisionsResponseSchema = z.object({
	transcriptRecoveryNotice: z.string().nullable().optional(),
	decisions: z.array(runtimeAgentRaisedPendingUserDecisionSchema),
});
export type RuntimeListAgentRaisedPendingUserDecisionsResponse = z.infer<
	typeof runtimeListAgentRaisedPendingUserDecisionsResponseSchema
>;

export const runtimeListAgentRaisedPendingUserDecisionsRequestSchema = z.object({
	taskId: z.string().trim().min(1).optional(),
});
export type RuntimeListAgentRaisedPendingUserDecisionsRequest = z.infer<
	typeof runtimeListAgentRaisedPendingUserDecisionsRequestSchema
>;

export const runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequestSchema = z.object({
	taskId: z.string().min(1),
	decisionId: z.string().min(1),
	orderedQuestionAnswers: z.array(runtimePendingUserDecisionQuestionAnswerDraftSchema),
	answerDraftEditVersion: z.number().int().nonnegative().optional(),
});
export type RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest = z.infer<
	typeof runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequestSchema
>;

export const runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponseSchema = z.object({
	ok: z.boolean(),
	pendingAnswerDraft: runtimeAgentRaisedPendingUserDecisionAnswerDraftSchema.nullable(),
	decisionIsNoLongerPending: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse = z.infer<
	typeof runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponseSchema
>;

export const runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema = z.object({
	decisionId: z.string(),
	selectedOptionIds: z.array(z.string()),
	freeformText: z.string().nullable(),
	orderedQuestionAnswers: z
		.array(
			z.object({
				decisionQuestionId: z.string(),
				selectedOptionIds: z.array(z.string()),
				freeformText: z.string().nullable(),
			}),
		)
		.optional(),
});
export type RuntimeAnswerAgentRaisedPendingUserDecisionRequest = z.infer<
	typeof runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema
>;

export const runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema = z.object({
	ok: z.boolean(),
	// 答案是否已经真正送进（恢复出来的）agent 会话。false 且 ok=true = 已 durable 记下，
	// 但会话还没起来，稍后由重试送达——绝不会重复送。
	delivered: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeAnswerAgentRaisedPendingUserDecisionResponse = z.infer<
	typeof runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema
>;

export const runtimeDismissAgentRaisedPendingUserDecisionRequestSchema = z.object({
	decisionId: z.string(),
});
export type RuntimeDismissAgentRaisedPendingUserDecisionRequest = z.infer<
	typeof runtimeDismissAgentRaisedPendingUserDecisionRequestSchema
>;

export const runtimeDismissAgentRaisedPendingUserDecisionResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeDismissAgentRaisedPendingUserDecisionResponse = z.infer<
	typeof runtimeDismissAgentRaisedPendingUserDecisionResponseSchema
>;

// ==========================================================================
// Deployment / Post-Deploy Verification（plan「Post-Deploy Verification Spike」1a / 1c /
// tRPC 契约 / Grilling #8–#9）
//
// 领域术语（plan「领域术语」）：
//   Deployment          = 一次成功 local deploy（运行中的 build 从 OLD → NEW 源 commit）
//   Post-Deploy Verification = 部署后针对「本次 deploy 新纳入的任务提交」的核对流程（面板 + checklist）
//   Verified            = 某任务针对某次 Deployment 的 checklist 全部勾选（verifiedAt，非 fullyValidatedAt）
// 定位键统一 (deploymentId, taskId)：同一 taskId 可同时存在于多个 Deployment 组。
// ==========================================================================

// ~/.cline/kanban/last-deployed-source-commit.json（plan 1a）。
// deploymentId 由 `kanban deployment record` 生成的 uuid，是 post-deploy-verification-state
// 组键的同源冗余互存——同 commit 重部署（OLD === NEW）时 SHA 不变、deploymentId 变，
// 前端「新 deploy」检测必须以 deploymentId 为准。
export const runtimeDeploymentMarkerSchema = z.object({
	deploymentId: z.string().uuid(),
	deployedSourceCommit: z.string(),
	deployedAtIso: z.string(),
	sourceCheckoutPath: z.string(),
	packageVersion: z.string(),
	// delta 另一端，便于 UI 展示 old → new；首次部署无前驱时省略。
	previousDeployedSourceCommit: z.string().optional(),
});
export type RuntimeDeploymentMarker = z.infer<typeof runtimeDeploymentMarkerSchema>;

// 任务纳入某 Deployment 组的原因（plan「任务纳入规则」）：
//   validation_column   = validation 列任务始终纳入当前组，无需 commit 关联
//   commit_correlation  = review / in_progress 列任务，其 work 提交与 deploy delta（hash / patch-id）关联
export const runtimePostDeployVerificationInclusionReasonSchema = z.enum(["validation_column", "commit_correlation"]);
export type RuntimePostDeployVerificationInclusionReason = z.infer<
	typeof runtimePostDeployVerificationInclusionReasonSchema
>;

// checklist 项来源：commit = 由关联到的 deploy commit 生成；custom = 用户在面板手动增补；
// authored = agent 在 RVF 阶段通过 `kanban verification register` 注册的部署后验证定义 materialize 而来。
export const runtimePostDeployVerificationChecklistItemSourceSchema = z.enum(["commit", "custom", "authored"]);
export type RuntimePostDeployVerificationChecklistItemSource = z.infer<
	typeof runtimePostDeployVerificationChecklistItemSourceSchema
>;

// 悬挂任务 reconcile 标记（plan「任务纳入规则」双向 reconcile）：
//   task_deleted        = 任务已从看板删除
//   moved_out_manually  = 未经 Post-Deploy Verification 被手动移出（拖入 trash / 移回 backlog）
export const runtimePostDeployVerificationDroppedReasonSchema = z.enum(["task_deleted", "moved_out_manually"]);
export type RuntimePostDeployVerificationDroppedReason = z.infer<
	typeof runtimePostDeployVerificationDroppedReasonSchema
>;

// 验证项的两种 kind（plan Stage 1）：
//   guided_manual    = 引导人工型：只能人眼/人手观察的断言，触发时把用户带到操作位置并分步指引（见 guidance）。
//   automated_script = 自动脚本型：可程序化外部观察的断言，server 端 spawn 脚本执行，通过即自动勾选（见 script/run）。
// 旧数据（无 kind 字段）解析为 guided_manual + guidance=null ⇒ 面板仍渲染成纯 checkbox（零行为变化）。
export const runtimePostDeployVerificationItemKindSchema = z.enum(["guided_manual", "automated_script"]);
export type RuntimePostDeployVerificationItemKind = z.infer<typeof runtimePostDeployVerificationItemKindSchema>;

// 自动脚本型的脚本描述：entrypoint 为资产目录内的相对入口文件（runner 执行前有 realpath 越界护栏，绝对路径/越界拒绝执行）；interpreter 决定 spawn 方式；timeoutMs 到时 kill。
export const runtimePostDeployVerificationScriptInterpreterSchema = z.enum(["bash", "node"]);
export type RuntimePostDeployVerificationScriptInterpreter = z.infer<
	typeof runtimePostDeployVerificationScriptInterpreterSchema
>;
export const runtimePostDeployVerificationScriptSchema = z.object({
	entrypoint: z.string(),
	interpreter: runtimePostDeployVerificationScriptInterpreterSchema.default("bash"),
	timeoutMs: z.number().int().positive().default(60000),
});
export type RuntimePostDeployVerificationScript = z.infer<typeof runtimePostDeployVerificationScriptSchema>;

// 自动脚本一次运行的结果快照（仅承载展示信息；勾选真源仍是 item.checked，由 pass/fail 驱动）。
export const runtimePostDeployVerificationRunStatusSchema = z.enum([
	"not_run",
	"running",
	"passed",
	"failed",
	"errored",
	"timed_out",
]);
export type RuntimePostDeployVerificationRunStatus = z.infer<typeof runtimePostDeployVerificationRunStatusSchema>;
export const runtimePostDeployVerificationRunSchema = z.object({
	status: runtimePostDeployVerificationRunStatusSchema,
	exitCode: z.number().nullable(),
	startedAtIso: z.string().nullable(),
	finishedAtIso: z.string().nullable(),
	outputExcerpt: z.string(),
});
export type RuntimePostDeployVerificationRun = z.infer<typeof runtimePostDeployVerificationRunSchema>;

// 引导人工型的定位锚点：view 指目标视图；anchorKey 指该视图内某个 data-verification-anchor 元素（缺省则仅导航+聚焦面板）。
export const runtimePostDeployVerificationGuidanceAnchorViewSchema = z.enum(["board", "task_detail"]);
export type RuntimePostDeployVerificationGuidanceAnchorView = z.infer<
	typeof runtimePostDeployVerificationGuidanceAnchorViewSchema
>;
export const runtimePostDeployVerificationGuidanceAnchorSchema = z.object({
	view: runtimePostDeployVerificationGuidanceAnchorViewSchema,
	anchorKey: z.string().optional(),
});
export type RuntimePostDeployVerificationGuidanceAnchor = z.infer<
	typeof runtimePostDeployVerificationGuidanceAnchorSchema
>;
// 引导人工型的分步指引：steps 现场指导（打开 X→点 Y→应看到 Z），expectedObservation 判定通过的观察，failureSignature 失败特征。
export const runtimePostDeployVerificationGuidanceSchema = z.object({
	steps: z.array(z.string()),
	expectedObservation: z.string(),
	failureSignature: z.string().optional(),
	anchor: runtimePostDeployVerificationGuidanceAnchorSchema.nullable().default(null),
});
export type RuntimePostDeployVerificationGuidance = z.infer<typeof runtimePostDeployVerificationGuidanceSchema>;

// per-verification 清理规格（plan Stage 5）：
//   automatic = 整任务核对完成时自动删 assetsDir + 注销 authored 定义；
//   manual    = 保留资产，面板展示 manualSteps（含 repo instrumentation 的验证强制此模式）；
//   retain    = 刻意保留，不删不提示。
export const runtimePostDeployVerificationCleanupModeSchema = z.enum(["automatic", "manual", "retain"]);
export type RuntimePostDeployVerificationCleanupMode = z.infer<typeof runtimePostDeployVerificationCleanupModeSchema>;
export const runtimePostDeployVerificationCleanupSchema = z.object({
	mode: runtimePostDeployVerificationCleanupModeSchema,
	assetsDir: z.string().nullable(),
	manualSteps: z.array(z.string()),
});
export type RuntimePostDeployVerificationCleanup = z.infer<typeof runtimePostDeployVerificationCleanupSchema>;

// 验证项：kind 是判别信息，其余 kind 专属字段可空默认。旧 item（仅 id/label/checked/source）解析后：
// kind=guided_manual、guidance/script/run/cleanup 全 null ⇒ 面板渲染成纯 checkbox，与全量重命名前零行为差异。
export const runtimePostDeployVerificationChecklistItemSchema = z.object({
	id: z.string(),
	label: z.string(),
	checked: z.boolean(),
	source: runtimePostDeployVerificationChecklistItemSourceSchema,
	kind: runtimePostDeployVerificationItemKindSchema.default("guided_manual"),
	guidance: runtimePostDeployVerificationGuidanceSchema.nullable().default(null),
	script: runtimePostDeployVerificationScriptSchema.nullable().default(null),
	run: runtimePostDeployVerificationRunSchema.nullable().default(null),
	cleanup: runtimePostDeployVerificationCleanupSchema.nullable().default(null),
});
export type RuntimePostDeployVerificationChecklistItem = z.infer<
	typeof runtimePostDeployVerificationChecklistItemSchema
>;

// ---- 按部署归属（2026-10-11 用户需求：只突出「最新一次 deploy 专门对应」的任务）----
// 归属依据是任务持久化的提交来历（src/workspace/task-commit-integration-provenance.ts，sha + stable patch-id，
// worktree 删掉后仍在）与部署区间 previousDeployedSourceCommit..deployedSourceCommit 的一对一匹配。
// 持久化约束：本节与下方结案一节只给任务条目**新增可选字段**、不给已有枚举加值——旧 binary（回滚时）解析新文件
// 只会丢掉新字段，不会把整个文件判成损坏而隔离。
//   task_commits_included_in_this_deployment_delta                       = 任务提交随本次部署上线（面板置顶展开）
//   task_commits_deployed_only_in_earlier_deployments_awaiting_verification = 早先部署已上线、至今未结案（积压，折叠）
//   task_commits_not_yet_deployed_or_task_unattributable                 = 提交还不在已部署 commit 里，或无从归属（折叠）
export const runtimePostDeployVerificationTaskDeploymentAttributionZoneSchema = z.enum([
	"task_commits_included_in_this_deployment_delta",
	"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
	"task_commits_not_yet_deployed_or_task_unattributable",
]);
export type RuntimePostDeployVerificationTaskDeploymentAttributionZone = z.infer<
	typeof runtimePostDeployVerificationTaskDeploymentAttributionZoneSchema
>;

// 第三区里「无从归属」的原因；提交还没进已部署 commit 时为 task_commits_not_contained_in_deployed_source_commit。
export const runtimePostDeployVerificationTaskDeploymentUnattributableReasonSchema = z.enum([
	"no_task_commit_integration_provenance_entry",
	"task_commit_integration_provenance_has_no_observed_task_commits",
	"task_commits_not_contained_in_deployed_source_commit",
	"git_inspection_failed",
]);
export type RuntimePostDeployVerificationTaskDeploymentUnattributableReason = z.infer<
	typeof runtimePostDeployVerificationTaskDeploymentUnattributableReasonSchema
>;

export const runtimePostDeployVerificationMatchedDeployedCommitSchema = z.object({
	taskCommitSha: z.string(),
	// 部署区间里被消费掉的那个提交：exact 时与 taskCommitSha 相同，patch-id 等价时是 cherry-pick / rebase 后的新 SHA。
	deployedCommitSha: z.string(),
	taskCommitMatchKind: z.enum(["exact_commit_sha", "stable_patch_id_equivalent"]),
});
export type RuntimePostDeployVerificationMatchedDeployedCommit = z.infer<
	typeof runtimePostDeployVerificationMatchedDeployedCommitSchema
>;

export const runtimePostDeployVerificationTaskDeploymentAttributionSchema = z.object({
	taskDeploymentAttributionZone: runtimePostDeployVerificationTaskDeploymentAttributionZoneSchema,
	matchedDeployedCommitsInThisDeploymentDelta: z.array(runtimePostDeployVerificationMatchedDeployedCommitSchema),
	taskDeploymentUnattributableReason: runtimePostDeployVerificationTaskDeploymentUnattributableReasonSchema.nullable(),
	attributionComputedAtIso: z.string(),
});
export type RuntimePostDeployVerificationTaskDeploymentAttribution = z.infer<
	typeof runtimePostDeployVerificationTaskDeploymentAttributionSchema
>;

// ---- 未全勾也能结案进 Done，但每个未勾项必须带原因（2026-10-11 用户需求）----
// 原因码、确认项、结案请求等请求侧 schema 见 post-deploy-verification-done-entry-closure-contract.ts（顶部 re-export）。

// 结案走的是哪条入口（进关系账本的完成证据；也是 recording 模块的类型来源）。前三个值是历史值，逐字保留。
export const runtimePostDeployVerificationCompletionPathSchema = z.enum([
	"web_ui_post_deploy_verification_panel_atomic_confirmation",
	"kanban_cli_post_deploy_verification_completion_verb",
	"kanban_runtime_reconciliation_finalizing_kanban_cli_completion_authorized_but_left_in_flight",
	// 任何入口（看板按钮 / 拖拽 / Focus View / PDV 面板 / CLI `kanban task done`）经 taskCardAction 移入 Done 时，
	// 服务端门禁授权并在移列后结案。
	"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
	// 门禁已授权、卡已进 Done，结案写盘却没完成（进程在两步之间退出）：runtime 对账按在途授权补完。
	"kanban_runtime_reconciliation_finalizing_done_entry_closure_authorized_but_left_in_flight",
]);
export type RuntimePostDeployVerificationCompletionPath = z.infer<
	typeof runtimePostDeployVerificationCompletionPathSchema
>;

// 任务的结案记录。verifiedAt 只在 all_checklist_items_checked 时写——带原因结案绝不冒充「PDV 通过」。
// completion path 存为字符串（而非枚举）：将来新增入口时，旧 binary 解析文件不会因未知枚举值把整个文件判成损坏。
export const runtimePostDeployVerificationClosureSchema = z.object({
	postDeployVerificationClosureOutcome: runtimePostDeployVerificationClosureOutcomeSchema,
	closedAtIso: z.string(),
	postDeployVerificationCompletionPath: z.string(),
	uncheckedChecklistItemClosureReasons: z.array(
		runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema,
	),
	confirmedAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema),
	taskDeploymentAttributionZoneAtClosure: runtimePostDeployVerificationTaskDeploymentAttributionZoneSchema.nullable(),
	deferredNaturalUsageObservationRecordIds: z.array(z.string()),
});
export type RuntimePostDeployVerificationClosure = z.infer<typeof runtimePostDeployVerificationClosureSchema>;

// 门禁授权后、移列前写下的在途授权：移列成功而结案写盘失败时，runtime 对账据此补完（不再要求重新给原因）；
// 移列没成功就过期清除。结案时按**当时的** checklist 重新核验结局，anticipated... 只是授权那一刻的预期。
export const runtimePostDeployVerificationDoneEntryClosureAuthorizationInFlightSchema = z.object({
	authorizedAtIso: z.string(),
	expiresAtIso: z.string(),
	anticipatedPostDeployVerificationClosureOutcome: runtimePostDeployVerificationClosureOutcomeSchema,
	uncheckedChecklistItemClosureReasons: z.array(
		runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema,
	),
	confirmedAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema),
	// 移列由 CLI 完成动词发起时（授权那一刻任务带着 CLI 在途完成记录）为 kanban_cli_post_deploy_verification_completion_verb，
	// 由服务端据记录推导、不信客户端自报；下一个字段同理取自该记录。缺省 = 没有用 `--force`。
	postDeployVerificationCompletionPath: z.string(),
	confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: z.boolean().optional(),
});
export type RuntimePostDeployVerificationDoneEntryClosureAuthorizationInFlight = z.infer<
	typeof runtimePostDeployVerificationDoneEntryClosureAuthorizationInFlightSchema
>;

// CLI 两步确认跨进程，token 必须持久化于 task 条目而非内存（plan 1c / Grilling #8）。
// columnIdAtIssuance 绑定发放时所在列——confirm 时任务列已变（如自动流转）则 token 失效重发。
export const runtimePostDeployVerificationPendingConfirmationSchema = z.object({
	token: z.string(),
	expiresAtIso: z.string(),
	requiredAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema),
	columnIdAtIssuance: runtimeBoardColumnIdSchema,
	// 只有 CLI 完成动词在移入 Done 之前写的「在途完成记录」才带：完成已在 CLI 侧授权（token / --ack / --force 都已核对），
	// 只差 runtime 写 verifiedAt。普通的待确认 token（用户还没确认）没有它。带它的记录不受过期回收，
	// runtime 下次为该项目加载 PDV 状态时（getPostDeployVerificationState，如 Web UI 面板轮询），在卡已入 Done 后跨该项目全部
	// 部署组（含已被新部署折叠的组）补写 verifiedAt——CLI 两次调用之间 runtime 不可达时，核对不再随 15 分钟过期丢失。
	kanbanCliCompletionAuthorizedBeforeMoveIntoDone: z
		.object({
			authorizedAtIso: z.string(),
			// 历史字段名与行为不符：`--force` 从来只跳过 token 握手、不跳过勾选。读取以下一个字段为准、缺失时回退本字段。
			// 2026-10-11 之前的 schema 把本字段定为**必填**：过渡期新写入必须两个都写（同值），否则回滚到旧 binary 时
			// 整个状态文件解析失败、被隔离成 .corrupt-*。
			forcedCompletionWithoutAllVerificationsPassed: z.boolean().optional(),
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: z.boolean().optional(),
			// CLI 带原因结案（`--reason-for-all-unchecked` 等）时解析好的逐项原因；全勾结案为空。
			uncheckedChecklistItemClosureReasons: z
				.array(runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema)
				.optional(),
		})
		.optional(),
});
export type RuntimePostDeployVerificationPendingConfirmation = z.infer<
	typeof runtimePostDeployVerificationPendingConfirmationSchema
>;

export const runtimePostDeployVerificationTaskSchema = z.object({
	taskId: z.string(),
	// 纳入本组时的列快照，仅作展示；入 Done 确认流按任务「当前列」分支，不看此快照（plan 1d）。
	columnIdAtMatch: runtimeBoardColumnIdSchema,
	matchedCommits: z.array(z.string()),
	inclusionReason: runtimePostDeployVerificationInclusionReasonSchema,
	checklist: z.array(runtimePostDeployVerificationChecklistItemSchema),
	// 只在全勾结案时写（「PDV 通过」）；带原因结案见 postDeployVerificationClosure。
	verifiedAt: z.string().nullable(),
	boardMovedToDoneAt: z.string().nullable(),
	pendingConfirmation: runtimePostDeployVerificationPendingConfirmationSchema.nullable(),
	droppedReason: runtimePostDeployVerificationDroppedReasonSchema.nullable(),
	// ---- 以下均为 2026-10-11 起新增的可选字段（旧数据解析为默认值）----
	// 本组部署的归属；null = 尚未计算（旧组 / record 时 git 不可用），由 runtime 对账补算。
	taskDeploymentAttribution: runtimePostDeployVerificationTaskDeploymentAttributionSchema.nullable().default(null),
	// 任务提交首次随哪次部署上线（跨部署延续）。null 且 ...PredatesRetained... 为 false = 还没上线或无从得知。
	firstDeployedInDeploymentId: z.string().nullable().default(null),
	firstDeployedAtIso: z.string().nullable().default(null),
	// 提交已在已部署 commit 里，但保留的部署组都找不到它首次上线的那一次（早于保留记录）。
	firstDeploymentPredatesRetainedDeploymentRecords: z.boolean().default(false),
	// 任务未结案期间经历过的部署（含本组）；长度即「已历经部署数」，与历史组裁剪解耦。
	deploymentIdsRecordedWhileTaskAwaitingVerification: z.array(z.string()).default([]),
	// 本组被新部署折叠时，这个未结案任务连同勾选进度被延续到了哪一组（历史组据此显示「已延续」而非「未核对」）。
	carriedForwardIntoDeploymentId: z.string().nullable().default(null),
	// 记录部署时任务已经在 Done：只作「本次部署还包含」的只读展示，不受门禁、不计待核对。
	includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: z.boolean().default(false),
	doneEntryClosureAuthorizationInFlight: runtimePostDeployVerificationDoneEntryClosureAuthorizationInFlightSchema
		.nullable()
		.default(null),
	postDeployVerificationClosure: runtimePostDeployVerificationClosureSchema.nullable().default(null),
});
export type RuntimePostDeployVerificationTask = z.infer<typeof runtimePostDeployVerificationTaskSchema>;

// 组键 = deploymentId（record 生成的 uuid，与 marker 同源）；勿用 deployedSourceCommit（同 commit 重部署冲突）。
// workspaceId 必需：taskId 仅在 workspace 内唯一。foldedAtIso 非 null 即该组已折叠进历史。
export const runtimePostDeployVerificationDeploymentGroupSchema = z.object({
	deploymentId: z.string().uuid(),
	workspaceId: z.string(),
	deployedSourceCommit: z.string(),
	previousDeployedSourceCommit: z.string().nullable(),
	deployedAtIso: z.string(),
	foldedAtIso: z.string().nullable(),
	tasks: z.array(runtimePostDeployVerificationTaskSchema),
});
export type RuntimePostDeployVerificationDeploymentGroup = z.infer<
	typeof runtimePostDeployVerificationDeploymentGroupSchema
>;

// ~/.cline/kanban/post-deploy-verification-state.json 全量（plan 1c）：跨 workspace 的单一全局文件。
export const runtimePostDeployVerificationStateSchema = z.object({
	deploymentGroups: z.array(runtimePostDeployVerificationDeploymentGroupSchema),
});
export type RuntimePostDeployVerificationState = z.infer<typeof runtimePostDeployVerificationStateSchema>;

// ---- Authored 验证定义（plan Stage 2）----
// Agent 在 RVF 阶段用 `kanban verification register` 注册的部署后验证定义，落在独立的 pending 存储
// ~/.cline/kanban/authored-verification-definitions.json；record 建组 / reconcile 新增任务时按 (workspaceId, taskId)
// materialize 成 checklist item（id=`authored:<verificationId>`，source="authored"）并入部署组。
// 与部署组分离存储的原因：定义在「部署前」注册（此时尚无部署组），且需跨多次部署 seed 到各新组的新副本。
export const runtimeAuthoredVerificationDefinitionSchema = z.object({
	verificationId: z.string().uuid(),
	workspaceId: z.string(),
	taskId: z.string(),
	kind: runtimePostDeployVerificationItemKindSchema,
	label: z.string(),
	guidance: runtimePostDeployVerificationGuidanceSchema.nullable().default(null),
	script: runtimePostDeployVerificationScriptSchema.nullable().default(null),
	cleanup: runtimePostDeployVerificationCleanupSchema,
	createdAtIso: z.string(),
});
export type RuntimeAuthoredVerificationDefinition = z.infer<typeof runtimeAuthoredVerificationDefinitionSchema>;

// ~/.cline/kanban/authored-verification-definitions.json 全量：跨 workspace 的单一 pending 存储。
export const runtimeAuthoredVerificationDefinitionsFileSchema = z.object({
	definitions: z.array(runtimeAuthoredVerificationDefinitionSchema),
});
export type RuntimeAuthoredVerificationDefinitionsFile = z.infer<
	typeof runtimeAuthoredVerificationDefinitionsFileSchema
>;

// Agent 写给 `kanban verification register` 的 definition JSON 形态：workspaceId/taskId/createdAtIso 由 register 赋值，
// verificationId 缺省则分配（提供则用于 rvf-reopen 幂等重注册）。文件可为单个对象或对象数组。
export const runtimeAuthoredVerificationDefinitionInputSchema = z.object({
	verificationId: z.string().uuid().optional(),
	kind: runtimePostDeployVerificationItemKindSchema,
	label: z.string().min(1),
	guidance: runtimePostDeployVerificationGuidanceSchema.nullable().default(null),
	script: runtimePostDeployVerificationScriptSchema.nullable().default(null),
	cleanup: runtimePostDeployVerificationCleanupSchema,
});
export type RuntimeAuthoredVerificationDefinitionInput = z.infer<
	typeof runtimeAuthoredVerificationDefinitionInputSchema
>;
export const runtimeAuthoredVerificationDefinitionInputFileSchema = z.union([
	runtimeAuthoredVerificationDefinitionInputSchema,
	z.array(runtimeAuthoredVerificationDefinitionInputSchema),
]);
export type RuntimeAuthoredVerificationDefinitionInputFile = z.infer<
	typeof runtimeAuthoredVerificationDefinitionInputFileSchema
>;

// ---- tRPC procedure I/O（plan「tRPC / API 契约」，全部 workspace-scoped）----

// deployment.getPostDeployVerificationState（query）：workspaceId 来自 workspaceProcedure 中间件。
export const runtimeGetPostDeployVerificationStateRequestSchema = z.object({
	// 仅取当前 active 组（foldedAtIso === null 的最新组），省略/为 false 则含折叠历史。
	activeOnly: z.boolean().optional(),
});
export type RuntimeGetPostDeployVerificationStateRequest = z.infer<
	typeof runtimeGetPostDeployVerificationStateRequestSchema
>;

export const runtimeGetPostDeployVerificationStateResponseSchema = z.object({
	// 已按当前 workspaceId 过滤；activeOnly 时仅含 active 组。
	deploymentGroups: z.array(runtimePostDeployVerificationDeploymentGroupSchema),
	// active 组 = 该 workspace 中 foldedAtIso === null 的最新组；无则 null。
	activeDeploymentId: z.string().nullable(),
});
export type RuntimeGetPostDeployVerificationStateResponse = z.infer<
	typeof runtimeGetPostDeployVerificationStateResponseSchema
>;

// deployment.listWorkspacesHavingPostDeployVerificationDeploymentGroups（query，**不带 workspace scope**）：
// All projects 视图的 PDV 面板不跟随当前项目，要先知道哪些 workspace 有部署组，再挑一个绑定。纯读全局 state 文件。
export const runtimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummarySchema = z.object({
	workspaceId: z.string(),
	// 该 workspace 全部部署组（含已折叠进历史的）里最新的 deployedAtIso：用来挑「最近部署过」的 workspace。
	latestDeploymentGroupDeployedAtIso: z.string(),
});
export type RuntimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummary = z.infer<
	typeof runtimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummarySchema
>;

export const runtimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponseSchema = z.object({
	// 按 latestDeploymentGroupDeployedAtIso 新→旧排序；没有任何部署组时为空数组。
	workspacesHavingPostDeployVerificationDeploymentGroups: z.array(
		runtimeWorkspaceHavingPostDeployVerificationDeploymentGroupsSummarySchema,
	),
});
export type RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse = z.infer<
	typeof runtimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponseSchema
>;

// deployment.updateVerificationChecklist（mutation）：勾选 / 增删自定义项，operation 判别联合。
export const runtimeUpdateVerificationChecklistRequestSchema = z.discriminatedUnion("operation", [
	z.object({
		operation: z.literal("toggle_checklist_item"),
		deploymentId: z.string(),
		taskId: z.string(),
		itemId: z.string(),
		checked: z.boolean(),
	}),
	z.object({
		operation: z.literal("add_custom_checklist_item"),
		deploymentId: z.string(),
		taskId: z.string(),
		label: z.string(),
	}),
	z.object({
		operation: z.literal("remove_custom_checklist_item"),
		deploymentId: z.string(),
		taskId: z.string(),
		itemId: z.string(),
	}),
]);
export type RuntimeUpdateVerificationChecklistRequest = z.infer<typeof runtimeUpdateVerificationChecklistRequestSchema>;

export const runtimeUpdateVerificationChecklistResponseSchema = z.object({
	ok: z.boolean(),
	task: runtimePostDeployVerificationTaskSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeUpdateVerificationChecklistResponse = z.infer<
	typeof runtimeUpdateVerificationChecklistResponseSchema
>;

// deployment.runPostDeployVerificationItem（mutation，plan Stage 3）：运行一个自动脚本型验证项。
// server 端置 running → spawn 脚本 → await 完成（≤timeout）→ 写 run 结果 + pass 置 checked=true → 返回更新后的 task。
export const runtimeRunPostDeployVerificationItemRequestSchema = z.object({
	deploymentId: z.string(),
	taskId: z.string(),
	itemId: z.string(),
});
export type RuntimeRunPostDeployVerificationItemRequest = z.infer<
	typeof runtimeRunPostDeployVerificationItemRequestSchema
>;
export const runtimeRunPostDeployVerificationItemResponseSchema = z.object({
	ok: z.boolean(),
	task: runtimePostDeployVerificationTaskSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeRunPostDeployVerificationItemResponse = z.infer<
	typeof runtimeRunPostDeployVerificationItemResponseSchema
>;

// deployment.requestVerificationComplete（mutation）：checklist 全勾后提议入 Done。
// validation 列免 token（needsConfirmation=false）；review/in_progress 返回 token + agent response 预览 + 需确认项。
export const runtimeRequestVerificationCompleteRequestSchema = z.object({
	deploymentId: z.string(),
	taskId: z.string(),
});
export type RuntimeRequestVerificationCompleteRequest = z.infer<typeof runtimeRequestVerificationCompleteRequestSchema>;

export const runtimeRequestVerificationCompleteResponseSchema = z.object({
	needsConfirmation: z.boolean(),
	// needsConfirmation=true 时提供：一次性、短期过期，持久化于 task.pendingConfirmation。
	confirmationToken: z.string().optional(),
	// 确认框展示的 agent 最近回复（按 agent 类型分源，统一截断；plan Grilling #5）。
	agentResponsePreview: z.string().optional(),
	// 按任务「当前列」重算；含 "in_progress_active" 即前端需追加第二次确认（plan Grilling #6）。
	requiredAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema).optional(),
	error: z.string().optional(),
});
export type RuntimeRequestVerificationCompleteResponse = z.infer<
	typeof runtimeRequestVerificationCompleteResponseSchema
>;

// deployment.confirmVerificationComplete（mutation）：
// **此过程只更新 verification state**（校验并消费 token、置 verifiedAt/boardMovedToDoneAt、清 pendingConfirmation），
// **绝不移列**。移列职责：Web = completePostDeployVerificationMoveToDone、CLI = taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree（plan 1d）。
// Web 时序为「先移列后 confirm」，故 confirm 校验任务已在 trash、checklist 仍全勾、token 有效。
export const runtimeConfirmVerificationCompleteRequestSchema = z.object({
	deploymentId: z.string(),
	taskId: z.string(),
	token: z.string(),
	acks: z.array(runtimePostDeployVerificationAcknowledgementSchema),
});
export type RuntimeConfirmVerificationCompleteRequest = z.infer<typeof runtimeConfirmVerificationCompleteRequestSchema>;

// CLI `kanban deployment` 完成动词在 CLI 进程里做完核对与移列后，由 runtime 写 verifiedAt（dd2db Y-EVENT-14：
// PDV 完成走 runtime procedure，「PDV 通过」事件只能由 runtime 记账）。forced 与确认项随请求带上，原样进事件。
// 移入 Done 已经过 runtime 门禁结案时，本 procedure 幂等返回已结案的 task（不再重复记账）。
export const runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequestSchema = z.object({
	deploymentId: z.string(),
	taskId: z.string(),
	// 历史字段（名不副实，见 kanbanCliCompletionAuthorizedBeforeMoveIntoDone）；旧 CLI 只发这个。旧 runtime 把它定为必填，
	// 过渡期新 CLI 两个都发（同值），免得刚构建完、还没重启的旧 runtime 拒收补记请求。
	forcedCompletionWithoutAllVerificationsPassed: z.boolean().optional(),
	confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: z.boolean().optional(),
	confirmedAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema),
	uncheckedChecklistItemClosureReasons: z
		.array(runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema)
		.optional(),
});
export type RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequest = z.infer<
	typeof runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequestSchema
>;

export const runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponseSchema = z.object({
	ok: z.boolean(),
	task: runtimePostDeployVerificationTaskSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponse = z.infer<
	typeof runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponseSchema
>;

export const runtimeConfirmVerificationCompleteResponseSchema = z.object({
	ok: z.boolean(),
	// 标记后的 task（含已置的 verifiedAt/boardMovedToDoneAt、已清的 pendingConfirmation）；失败为 null。
	task: runtimePostDeployVerificationTaskSchema.nullable(),
	// 任务当前列 ≠ columnIdAtIssuance 时 token 失效——返回新 token + 新需确认项，要求重走 requestVerificationComplete（plan Grilling #8）。
	reissuedConfirmationToken: z.string().optional(),
	requiredAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema).optional(),
	error: z.string().optional(),
});
export type RuntimeConfirmVerificationCompleteResponse = z.infer<
	typeof runtimeConfirmVerificationCompleteResponseSchema
>;

// ---- 待在自然使用中观察的记录（2026-10-11）----
// 未勾项以「触发时机随机 / 罕见，转为在自然使用中观察」结案时生成，独立文件
// ~/.cline/kanban/post-deploy-verification-deferred-natural-usage-observation-records.json，不随部署组裁剪。
// 它是将来「在合适时机程序化捕捉情境 → 多模态 agent 判定 → 归档」pipeline 的输入；本期只生成与只读列出，
// 状态只有 awaiting_natural_usage_observation，枚举留给 pipeline 扩展（设计见
// docs/post-deploy-verification-natural-usage-observation-pipeline-design.md）。
export const runtimePostDeployVerificationNaturalUsageObservationStatusSchema = z.enum([
	"awaiting_natural_usage_observation",
]);
export type RuntimePostDeployVerificationNaturalUsageObservationStatus = z.infer<
	typeof runtimePostDeployVerificationNaturalUsageObservationStatusSchema
>;

export const runtimePostDeployVerificationDeferredNaturalUsageObservationRecordSchema = z.object({
	// (workspaceId, taskId, 结案时刻, checklistItemId) 的哈希：同一次结案重复写入幂等。
	deferredNaturalUsageObservationRecordId: z.string(),
	workspaceId: z.string(),
	taskId: z.string(),
	sourceDeploymentId: z.string(),
	sourceDeployedSourceCommit: z.string(),
	sourceChecklistItemId: z.string(),
	// authored 项才有；commit / custom 项为 null。
	sourceAuthoredVerificationId: z.string().nullable(),
	assertionLabel: z.string(),
	checklistItemKind: runtimePostDeployVerificationItemKindSchema,
	guidanceSnapshot: runtimePostDeployVerificationGuidanceSchema.nullable(),
	automatedScriptSnapshot: runtimePostDeployVerificationScriptSchema.nullable(),
	// 结案时刻意保留不清理的资产目录（automated 脚本、fixture）；没有资产为 null。
	retainedVerificationAssetsDirectory: z.string().nullable(),
	deferralReasonText: z.string().nullable(),
	deferredAtIso: z.string(),
	naturalUsageObservationStatus: runtimePostDeployVerificationNaturalUsageObservationStatusSchema,
});
export type RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord = z.infer<
	typeof runtimePostDeployVerificationDeferredNaturalUsageObservationRecordSchema
>;

export const runtimePostDeployVerificationDeferredNaturalUsageObservationRecordsFileSchema = z.object({
	deferredNaturalUsageObservationRecords: z.array(
		runtimePostDeployVerificationDeferredNaturalUsageObservationRecordSchema,
	),
});
export type RuntimePostDeployVerificationDeferredNaturalUsageObservationRecordsFile = z.infer<
	typeof runtimePostDeployVerificationDeferredNaturalUsageObservationRecordsFileSchema
>;

// deployment.listDeferredNaturalUsageObservationRecords（query）：当前 workspace 的待观察记录。
export const runtimeListDeferredNaturalUsageObservationRecordsResponseSchema = z.object({
	deferredNaturalUsageObservationRecords: z.array(
		runtimePostDeployVerificationDeferredNaturalUsageObservationRecordSchema,
	),
});
export type RuntimeListDeferredNaturalUsageObservationRecordsResponse = z.infer<
	typeof runtimeListDeferredNaturalUsageObservationRecordsResponseSchema
>;

// ══════════════════════════════════════════════════════════════════════════════
// Exploratory Mode（findings）与 harness-neutral turn 投影层契约。
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md（findings §D；其 session map
// 部分已退役——结构建模改由独立包 agent-conversation-exploration-thread-graph 承担，宿主胶水见
// docs/exploratory-mode-host-integration.md）及姊妹蓝图
// .plan/docs/conversation-tree-unified-fan-out-interface-deferred-asset.md（§2）。
// 全部加性：不触碰 summary facet superRefine 护栏；findings 持久化在 per-workspace
// exploratory-findings.json（src/state/exploratory-findings-store.ts），不进 sessions.json。
// ══════════════════════════════════════════════════════════════════════════════

// ---- Harness-neutral turn 投影层（姊妹蓝图 §2.2）----
// 投影层是只读派生层（无持久化真相、仅缓存），为 findings 出处锚 / 会话树供给统一 turn 序列。
// turn 编号权威在服务端投影（与 checkpoint 序数对齐）；web-ui 的消息切段只做滚动定位映射。

export const runtimeConversationTurnProjectionHarnessSourceSchema = z.enum([
	// Cline SDK：从结构化 ClineTaskMessage[] 派生，turn 边界分类与 checkpoint 捕获时机同源单测。
	"exact_structured",
	// 终端 agent：事后从 CLI transcript JSONL 全量重建（best-effort，随 CLI 版本漂移）。
	"transcript_reconstructed",
	// 运行中 PTY 会话只有 scrollback、无结构化消息——UI 按 session 粒度降级。
	"unavailable_live_terminal_pty",
]);
export type RuntimeConversationTurnProjectionHarnessSource = z.infer<
	typeof runtimeConversationTurnProjectionHarnessSourceSchema
>;

export const runtimeConversationTurnCheckpointAlignmentConfidenceSchema = z.enum([
	// 投影最新 turn 号 == 最新 checkpoint 序数：两侧同源单调递增，全序列置信对齐。
	"exact_ordinal_match",
	// 该 turn 的 ref 存在，但最新序数对不上（如 self-injection 轮次使 checkpoint 计数超前
	// 于消息派生序——姊妹蓝图风险 1 的已知偏移源），逐 ref 对齐、序列级不置信。
	"best_effort_ordinal_match",
	// 该 turn 的 checkpoint ref 已不可解析（轮换删除 / 从未捕获）——仅时间锚。
	"unaligned",
]);
export type RuntimeConversationTurnCheckpointAlignmentConfidence = z.infer<
	typeof runtimeConversationTurnCheckpointAlignmentConfidenceSchema
>;

export const runtimeConversationTurnProjectionEntrySchema = z.object({
	turnNumber: z.number().int().positive(),
	turnStartedAt: z.number(),
	turnUserMessageExcerpt: z.string().max(400).nullable(),
	turnAssistantResponseExcerpt: z.string().max(400).nullable(),
	turnMessageCount: z.number().int().nonnegative(),
	turnCheckpointCommit: z.string().nullable(),
	turnCheckpointAlignmentConfidence: runtimeConversationTurnCheckpointAlignmentConfidenceSchema,
	// 运行中会话的末尾 turn（agent 回合未完结）； transcript 重建源同理。
	turnIsInProgress: z.boolean(),
	// 该 turn 是否被会话树 fan-out 锚中。M0 恒 false——by-the-way 锚 join 属姊妹蓝图树装配
	// 步骤（其 §5.3），且不参与投影签名（锚是独立数据源，避免签名语义混杂）。
	turnHasConversationTreeForkAnchor: z.boolean(),
});
export type RuntimeConversationTurnProjectionEntry = z.infer<typeof runtimeConversationTurnProjectionEntrySchema>;

export const runtimeConversationSessionTurnProjectionRequestSchema = z.object({
	conversationSessionTaskId: z.string(),
	// 增量重拉：只返回 turnNumber > 该值的条目（签名恒按全量投影计算，见响应注释）。
	sinceTurnNumber: z.number().int().positive().optional(),
	maxTurnEntries: z.number().int().positive().max(500).optional(),
});
export type RuntimeConversationSessionTurnProjectionRequest = z.infer<
	typeof runtimeConversationSessionTurnProjectionRequestSchema
>;

export const runtimeConversationSessionTurnProjectionResponseSchema = z.object({
	harnessSource: runtimeConversationTurnProjectionHarnessSourceSchema,
	turnProjectionEntries: z.array(runtimeConversationTurnProjectionEntrySchema),
	// 全量投影签名（Cline 源 = {messageCount}:{lastMessageId}:{lastMessageContentLength}，
	// 末项必须是末条消息 content 长度——流式期间 assistant chunk 同 id 原位追加，只有它能
	// 感知追加）。签名兼作 map / 归组资产的 apply 乐观并发对账键，故不受 since/max 切片影响。
	turnProjectionSignature: z.string(),
	// 响应被 since/max 切片截断时为 true；投影源本身不可用时 entries 为空、此位为 false。
	turnProjectionIsIncomplete: z.boolean(),
});
export type RuntimeConversationSessionTurnProjectionResponse = z.infer<
	typeof runtimeConversationSessionTurnProjectionResponseSchema
>;

// ---- Exploratory findings（蓝图 §D）----
// D.1 的 canonical schema（provenanceLink / status / generationSource / entry）与
// exploratory_findings_updated 广播消息已上移到 runtimeStateStreamMessageSchema 之前（TDZ）。
// 本节是 findings 的 procedure I/O（M2）：人工保存主路径（§D.2.1，用户动作 zod 校验即够、
// 无需作业漏斗）+ agent 建议通道（§D.2.2，provenance 可解析性校验在 handler 完成）。
// 持久化在 per-workspace exploratory-findings.json（src/state/exploratory-findings-store.ts）。

// exploratory.getFindings（query）：workspace 级全量读取（集合恒小，上限 500）。
export const runtimeGetExploratoryFindingsRequestSchema = z.object({});
export type RuntimeGetExploratoryFindingsRequest = z.infer<typeof runtimeGetExploratoryFindingsRequestSchema>;

export const runtimeGetExploratoryFindingsResponseSchema = z.object({
	findings: z.array(runtimeExploratoryFindingEntrySchema),
});
export type RuntimeGetExploratoryFindingsResponse = z.infer<typeof runtimeGetExploratoryFindingsResponseSchema>;

// exploratory.saveFinding（mutation，蓝图 §D.2.1 人工保存主路径）：落库即 active + user_saved。
// findingId 由 UI 生成 uuid，作稳定 dedup 键——同 findingId 已存在 → 幂等返回现状条目，不重复落地。
export const runtimeSaveExploratoryFindingRequestSchema = z.object({
	findingId: z.string().min(1).max(200),
	findingTitle: z.string().min(1).max(120),
	findingBodyMarkdown: z.string().min(1).max(4000),
	// 上限对齐 findingTags（max 8）：链接数无界会放大持久化体积、串行校验成本与
	// exploratory_findings_updated 全量广播负载。
	provenanceLinks: z.array(runtimeExploratoryFindingProvenanceLinkSchema).min(1).max(8),
	originConversationSessionTaskId: z.string().nullable(),
});
export type RuntimeSaveExploratoryFindingRequest = z.infer<typeof runtimeSaveExploratoryFindingRequestSchema>;

export const runtimeSaveExploratoryFindingResponseSchema = z.object({
	finding: runtimeExploratoryFindingEntrySchema,
});
export type RuntimeSaveExploratoryFindingResponse = z.infer<typeof runtimeSaveExploratoryFindingResponseSchema>;

// exploratory.confirmFinding（mutation，蓝图 §D.2.2）：suggested_pending_confirmation → active。
// 不存在的 findingId → finding: null（UI 幂等）；对非 pending 条目调用 = 状态机违规，报错。
export const runtimeConfirmExploratoryFindingRequestSchema = z.object({
	findingId: z.string(),
});
export type RuntimeConfirmExploratoryFindingRequest = z.infer<typeof runtimeConfirmExploratoryFindingRequestSchema>;

export const runtimeConfirmExploratoryFindingResponseSchema = z.object({
	finding: runtimeExploratoryFindingEntrySchema.nullable(),
});
export type RuntimeConfirmExploratoryFindingResponse = z.infer<typeof runtimeConfirmExploratoryFindingResponseSchema>;

// exploratory.rejectFinding（mutation，蓝图 §D.2.2）：物理删除 pending 建议（尚未成为资产）。
// 不存在的 findingId → removed: false（UI 幂等）；对非 pending 条目调用 = 状态机违规，报错。
export const runtimeRejectExploratoryFindingRequestSchema = z.object({
	findingId: z.string(),
});
export type RuntimeRejectExploratoryFindingRequest = z.infer<typeof runtimeRejectExploratoryFindingRequestSchema>;

export const runtimeRejectExploratoryFindingResponseSchema = z.object({
	removed: z.boolean(),
});
export type RuntimeRejectExploratoryFindingResponse = z.infer<typeof runtimeRejectExploratoryFindingResponseSchema>;

// exploratory.archiveFinding（mutation）：active ↔ archived 软删/恢复（已处目标态 = 幂等空转）。
// pending 条目不可 archive（尚未成为资产，该走 reject）——状态机违规报错；不存在的 findingId → null。
export const runtimeArchiveExploratoryFindingRequestSchema = z.object({
	findingId: z.string(),
	archived: z.boolean(),
});
export type RuntimeArchiveExploratoryFindingRequest = z.infer<typeof runtimeArchiveExploratoryFindingRequestSchema>;

export const runtimeArchiveExploratoryFindingResponseSchema = z.object({
	finding: runtimeExploratoryFindingEntrySchema.nullable(),
});
export type RuntimeArchiveExploratoryFindingResponse = z.infer<typeof runtimeArchiveExploratoryFindingResponseSchema>;

// exploratory.ingestFindingCandidate（mutation，蓝图 §D.2.2 agent 建议通道）：落库即
// suggested_pending_confirmation + agent_suggested，待人确认。findingId 由服务端派生 =
// agent-<clientProposalId>（dedup：同 clientProposalId 重发不落成两条，幂等 ack 回现状条目）。

// ingest 拒绝原因（schema 级拒绝在 tRPC input 校验阶段就抛错，不进本枚举）。
export const runtimeExploratoryFindingIngestRejectionReasonSchema = z.enum([
	// 投影可加载时 turnNumber > 该会话投影最新 turn（语义同 map 闸 2b，整份拒绝）。
	"anchor_turn_number_unresolvable",
	// link 声明的 conversationSessionTaskId 投影完全加载不出来（会话不存在）。
	// 注意与「投影源不可用（PTY 会话）」区分：后者接受并降级 checkpoint 为 null（能力矩阵
	// best-effort 锚），前者整份拒绝。
	"provenance_conversation_session_unresolvable",
	// findings 总量达 per-workspace 上限且被 pending 建议占满：pending 永不静默裁 ⇒ cap
	// 无可裁候选，store 显式拒绝（ExploratoryFindingsCapOverflowError，不落盘）。
	// 处置 = 请用户先确认/拒绝既有 pending 建议腾位后再提。
	"findings_cap_overflow",
]);
export type RuntimeExploratoryFindingIngestRejectionReason = z.infer<
	typeof runtimeExploratoryFindingIngestRejectionReasonSchema
>;

export const runtimeIngestExploratoryFindingCandidateRequestSchema = z.object({
	// 提交方所在会话（落为 originConversationSessionTaskId）；provenance link 可指向其它会话。
	conversationSessionTaskId: z.string(),
	// dedup 键：重试同 id 幂等 ack、不重复落地。
	clientProposalId: z.string().min(1).max(120),
	findingTitle: z.string().min(1).max(120),
	findingBodyMarkdown: z.string().min(1).max(4000),
	// 上限对齐 findingTags（max 8），同 saveFinding；ingest 每条 turn_anchor 链接还要串行
	// 加载投影做可解析性校验，无界数组会放大这一成本。
	provenanceLinks: z.array(runtimeExploratoryFindingProvenanceLinkSchema).min(1).max(8),
});
export type RuntimeIngestExploratoryFindingCandidateRequest = z.infer<
	typeof runtimeIngestExploratoryFindingCandidateRequestSchema
>;

export const runtimeIngestExploratoryFindingCandidateResponseSchema = z.object({
	// true = 已 durable 落盘（durable-write-before-ack）或 dedup 幂等 ack；false = 拒绝，见 rejectionReason。
	ingested: z.boolean(),
	rejectionReason: runtimeExploratoryFindingIngestRejectionReasonSchema.nullable(),
	// 落库/现状条目（dedup ack 时为未变更的现状）；拒绝时为 null。
	finding: runtimeExploratoryFindingEntrySchema.nullable(),
});
export type RuntimeIngestExploratoryFindingCandidateResponse = z.infer<
	typeof runtimeIngestExploratoryFindingCandidateResponseSchema
>;

// exploratory.getExplorationThreadGraph（query）：读一张图的投影整值。
// 只读路径，不触发任何 fork——看图是免费的，判图才花钱。
export const runtimeGetExplorationThreadGraphRequestSchema = z.object({
	// = 主任务卡片 id（by-the-way 会话经 taskConversationSessionMetadata.workspaceTaskId 归到它名下）。
	explorationId: z.string().min(1).max(200),
});
export type RuntimeGetExplorationThreadGraphRequest = z.infer<typeof runtimeGetExplorationThreadGraphRequestSchema>;

export const runtimeGetExplorationThreadGraphResponseSchema = z.object({
	// 恒有值：还没有任何 turn 归位时是一张空图，不是 null——「图是空的」与「读不到图」必须可区分。
	view: runtimeExplorationThreadGraphProjectionViewSchema,
	// 转录暂时读不出来的会话原生 id（文件被删 / 格式漂移）。这些会话的 turn 行缺席，其余照常。
	turnSourceUnavailableSessionIds: z.array(z.string()),
});
export type RuntimeGetExplorationThreadGraphResponse = z.infer<typeof runtimeGetExplorationThreadGraphResponseSchema>;

// exploratory.requestExplorationThreadGraphMaintenance（mutation）：面板上的「立即维护一次」。
// 跳过防抖与节流，但**不跳过单飞闸**——同一 exploration 在途恒只有一个作业。
export const runtimeRequestExplorationThreadGraphMaintenanceRequestSchema = z.object({
	explorationId: z.string().min(1).max(200),
});
export type RuntimeRequestExplorationThreadGraphMaintenanceRequest = z.infer<
	typeof runtimeRequestExplorationThreadGraphMaintenanceRequestSchema
>;

export const runtimeRequestExplorationThreadGraphMaintenanceResponseSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("completed"),
		// 核心包作业的四种归宿。只有 accepted 意味着图真的变了（也只有它会触发广播）。
		jobOutcome: z.enum(["accepted", "rejected", "skipped", "fork_failed"]),
		// accepted 时：落盘后 collection 里 placement 的**总数**（不是本次新增数），以及还剩多少
		// 待判（超出单次 batchSize 时由调用方安排续跑）。其余归宿为 null。
		placedTurnCount: z.number().nullable(),
		remainingTurnCount: z.number().nullable(),
		// 被拒 / 跳过 / fork 失败的具体原因，原样透传核心包的判词，供面板显示。
		detail: z.string().nullable(),
	}),
	z.object({
		kind: z.literal("not_started"),
		reason: z.enum([
			"not_exploratory_mode",
			"no_usable_sessions",
			"already_in_flight",
			"throttled",
			"no_completed_turns",
		]),
	}),
	z.object({ kind: z.literal("failed"), message: z.string() }),
]);
export type RuntimeRequestExplorationThreadGraphMaintenanceResponse = z.infer<
	typeof runtimeRequestExplorationThreadGraphMaintenanceResponseSchema
>;

// 今日进展是运行时的只读统计投影；Done 数量不表示部署后验证通过。
export const runtimeDailyWorkProgressMetricSchema = z.enum(["entered_validation", "entered_done", "human_prompt"]);
export type RuntimeDailyWorkProgressMetric = z.infer<typeof runtimeDailyWorkProgressMetricSchema>;
export const runtimeDailyWorkProgressRequestSchema = z.object({
	workspaceId: z.string().min(1).nullable(),
	dateKey: z.iso.date(),
	timeZone: z
		.string()
		.max(100)
		.refine((value) => {
			try {
				new Intl.DateTimeFormat("en", { timeZone: value });
				return true;
			} catch {
				return false;
			}
		}, "需要有效的 IANA 时区"),
});
export type RuntimeDailyWorkProgressRequest = z.infer<typeof runtimeDailyWorkProgressRequestSchema>;
export const runtimeDailyWorkProgressAchievementSchema = z.object({
	achievementId: z.string(),
	metric: runtimeDailyWorkProgressMetricSchema,
	kind: z.enum(["daily_threshold", "personal_daily_record", "above_seven_day_average"]),
	value: z.number().nonnegative(),
	comparisonValue: z.number().nonnegative().nullable(),
	threshold: z.number().positive().nullable(),
});
export type RuntimeDailyWorkProgressAchievement = z.infer<typeof runtimeDailyWorkProgressAchievementSchema>;
export const runtimeDailyWorkProgressSummarySchema = z.object({
	revision: z.number().int().nonnegative(),
	dateKey: z.string(),
	timeZone: z.string(),
	workspaceId: z.string().nullable(),
	projects: z.array(z.object({ workspaceId: z.string(), projectName: z.string() })),
	metrics: z.array(
		z.object({
			metric: runtimeDailyWorkProgressMetricSchema,
			value: z.number().int().nonnegative(),
			nextMilestoneValue: z.number().positive().nullable(),
			historicalDailyRecord: z.number().nonnegative().nullable(),
			sevenDayAverage: z.number().nonnegative().nullable(),
			historyStartDate: z.string().nullable(),
		}),
	),
	achievements: z.array(runtimeDailyWorkProgressAchievementSchema),
	celebrationEligibleAchievementIds: z.array(z.string()),
	recentAccomplishments: z.array(
		z.object({
			workspaceId: z.string(),
			taskId: z.string(),
			taskTitle: z.string(),
			metric: z.enum(["entered_validation", "entered_done"]),
			occurredAtEpochMs: z.number(),
		}),
	),
	coverage: z.object({ status: z.enum(["loading", "partial", "complete"]), warnings: z.array(z.string()) }),
});
export type RuntimeDailyWorkProgressSummary = z.infer<typeof runtimeDailyWorkProgressSummarySchema>;
export const runtimeClaimDailyWorkProgressCelebrationsRequestSchema = runtimeDailyWorkProgressRequestSchema.extend({
	achievementIds: z.array(z.string().max(1024)).max(100),
});
export type RuntimeClaimDailyWorkProgressCelebrationsRequest = z.infer<
	typeof runtimeClaimDailyWorkProgressCelebrationsRequestSchema
>;
export const runtimeClaimDailyWorkProgressCelebrationsResponseSchema = z.object({
	achievements: z.array(runtimeDailyWorkProgressAchievementSchema),
});
export type RuntimeClaimDailyWorkProgressCelebrationsResponse = z.infer<
	typeof runtimeClaimDailyWorkProgressCelebrationsResponseSchema
>;
