import { z } from "zod";
// Stage 4 全写侧反转：facet 为写时主真相源，`state` 降为 projectLegacyState(facets) 派生投影。
// bundle-safe：session-activity 是零 Node 依赖的纯函数模块，其对 api-contract 仅 type-only import
// （编译期擦除），故二者无运行时循环；本处取值 import 不会把任何 Node 依赖拖进浏览器 bundle。
import { isKanbanCursorAgentModelId } from "./cursor-agent-models.js";
import { projectLegacyState } from "./session-activity.js";
import { resolveTaskTitle } from "./task-title.js";

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
export const runtimeTerminalAgentModelSelectionAgentIdSchema = z.enum(["claude", "codex", "cursor"]);
export type RuntimeTerminalAgentModelSelectionAgentId = z.infer<typeof runtimeTerminalAgentModelSelectionAgentIdSchema>;
export const runtimeTaskAgentSessionInitializationReuseModeSchema = z.enum([
	"resume_existing_session",
	"fork_existing_session",
]);
export type RuntimeTaskAgentSessionInitializationReuseMode = z.infer<
	typeof runtimeTaskAgentSessionInitializationReuseModeSchema
>;
export const runtimeTaskAgentSessionInitializationSchema = z
	.object({
		sourceAgentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
		sourceSessionId: z.string().trim().uuid(),
		sourceSessionReuseMode: runtimeTaskAgentSessionInitializationReuseModeSchema,
		sourceSessionWorkingDirectoryPath: z.string().trim().min(1).optional(),
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
				message: "Cursor agent model overrides must use auto, composer, or composer-* models.",
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

export const runtimeBoardCardSchema = z
	.object({
		id: z.string(),
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
		agentId: runtimeAgentIdSchema.optional(),
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

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
	dependencies: z.array(runtimeBoardDependencySchema).default([]),
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

export const runtimeTaskConversationSessionMetadataSchema = z.object({
	workspaceTaskId: z.string(),
	taskConversationSessionRole: z.enum(["main", "by_the_way"]),
	taskConversationSessionContextSource: z.enum(["main", "started_from_scratch", "forked_from_main_current_turn"]),
	parentTaskConversationSessionId: z.string().nullable(),
	mainSessionOriginTurnNumber: z.number().int().nonnegative().nullable(),
	mainSessionOriginUserMessagePreview: z.string().nullable(),
	latestUserMessagePreview: z.string().nullable(),
});
export type RuntimeTaskConversationSessionMetadata = z.infer<typeof runtimeTaskConversationSessionMetadataSchema>;

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

// ── 「对话上次推进」观测（加性 sidecar；卡片时长药丸 B 的唯一真相源）──────────────────────────
// 回答的问题是：**这个任务的对话，上一次真正往前走，是什么时候？**
//
// 它与另外两个极易混淆的量刻意分开命名、互不推断（三者都必须存在，谁也替代不了谁）：
//   ① lastSubstantiveOutputAt   ——「此刻 agent 有没有在吐东西」。刮 TUI 猜出来的新鲜度，秒级粒度，
//      服务 Validation 列 5s 自动打回与 idle-stall 5min 自愈。**会话重开必然被重播刷新，这是正确的**。
//   ② agentResponseGenerationStopped ——「本次 incarnation 何时进入非生成态」。会话重开时刷新同样正确
//      （新活体新一轮），驱动 2h 回收与药丸 A。
//   ③ 本字段                    ——「对话上次推进」。**跨 incarnation 的历史事实**：进程重启、会话
//      重开、旧对话被重播进新 TUI，它都不该动。
// 历史上卡片拿 ① 冒充 ③，于是「今天重开一个七天前的会话」会把卡片时间刷成 now——26% 的 claude 任务
// 因此显示错误（偏差中位数 26.8 小时）。修法不是继续给 ① 打补丁，而是给 ③ 一个自己的真相源。
//
// evidenceKind 记录「这一次前进是靠什么看出来的」，用途有二：UI 对低置信来源加 `~` 前缀降级展示；
// 合并 reducer 据此决定会话重开时能否 rebaseline（见 src/core/last-conversation-progress-observation.ts）。
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

// Kanban 与一个 agent 通话的方式（PTY / 进程内 Cline SDK / ACP 子进程）。canonical zod 源放在
// api-contract（契约叶子模块），src/core/agent-catalog.ts 由此派生 TS 类型并挂到 catalog 条目上，
// 避免 api-contract → agent-catalog 的反向依赖。
export const runtimeAgentSessionTransportSchema = z.enum([
	// PTY 里跑一个 CLI，靠刮 TUI 输出 + agent 侧 hook 回调 `kanban hooks` 判状态。
	"pty_terminal",
	// 在 Kanban 服务进程内直接实例化 @clinebot/core，订阅结构化事件。
	"in_process_cline_sdk",
	// spawn 一个子进程，用 ACP（JSON-RPC over stdio）通话，状态由 SessionUpdate 驱动。
	"acp_stdio_subprocess",
]);
export type RuntimeAgentSessionTransport = z.infer<typeof runtimeAgentSessionTransportSchema>;

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

const runtimeTaskSessionSummaryObjectSchema = z.object({
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
	// 「最近一次**实质**输出」时刻：仅当 agent 产出新的正文 / 工具内容时推进，过滤 TUI 装饰性重绘
	// （spinner / footer / 计时器），与每段 PTY 字节都刷新的 lastOutputAt 区分。Validation 列自动打回
	// 判据（isAgentActivelyProducingOutput）读它；其余 4 个 lastOutputAt 读点（自动续跑静默门控、卡顿
	// 探针、卡片 computing 展示、终端面板基线）仍读 lastOutputAt（spinner 期应计为活动）。加性可选：
	// 旧盘数据 / web-ui 手构造 summary 缺它 → undefined ⇒ 判据回退「不在产出」（见判据注释）。
	lastSubstantiveOutputAt: z.number().nullable().optional(),
	// 「对话上次推进」观测（跨 incarnation 的历史事实，卡片药丸 B 读它）。语义、与上面两个时间戳的
	// 分工、以及为什么必须是独立字段，见 runtimeLastConversationProgressObservationSchema 的注释。
	// 合并只经 src/core/last-conversation-progress-observation.ts 的唯一 reducer（稳态单调前进、
	// 仅持久转录在 incarnation 边界或「非 agent 回合 + 已存值低置信」时可 rebaseline）。加性可选：
	// 旧盘数据 / 手构造 summary 缺它 ⇒
	// 药丸 B 隐藏（而非退回读 lastSubstantiveOutputAt——那正是本 bug 的成因）。
	lastConversationProgressObservation: runtimeLastConversationProgressObservationSchema.nullable().optional(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	connectionRetry: runtimeTaskConnectionRetrySchema.nullable().optional(),
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
	// 当前这次「进入非生成态」的离散事件；agent 回合 / park 期间为 null。
	agentResponseGenerationStopped: runtimeAgentResponseGenerationStoppedSchema.nullable().optional(),
	// 可回收时刻（epoch ms 绝对时刻，= stoppedAt + 宽限期）。存绝对时刻而非剩余时长，故停机期间
	// 流逝的墙钟时间自然计入，重启后按同一口径判定。
	agentSessionRuntimeReclamationEligibleAt: z.number().nullable().optional(),
	// 最近一次回收尝试的可审计结果（成功 / 失败皆记）。UI 的「会话已被回收」标注读它——用户重进
	// 任务时必须看到明确说明，而不是一个空终端让人误以为只是加载慢。
	agentSessionRuntimeReclamationOutcome: runtimeAgentSessionReclamationOutcomeSchema.nullable().optional(),
	taskConversationSessionMetadata: runtimeTaskConversationSessionMetadataSchema.optional(),
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

export const runtimeAddBacklogTaskResponseSchema = z.object({
	taskId: z.string(),
});
export type RuntimeAddBacklogTaskResponse = z.infer<typeof runtimeAddBacklogTaskResponseSchema>;

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

// Cross-Repository Stage-First Overview（跨-repo 概览，见 CONTEXT.md）用：in_progress 列单个 task
// 的精简明细投影。前端据 turnOwner + lastOutputAt 把它二分为 Active / Stale
// （见 session-activity.ts 的 RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS）。
export const runtimeInProgressTaskDetailSchema = z.object({
	taskId: z.string(),
	title: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	// 任务卡创建时刻（epoch ms）；概览行据此显示「自创建至今」时长药丸（同主看板卡片头部）。
	createdAt: z.number(),
	// 距最近一次 PTY 输出（含 spinner 重绘）；null=从未产出/无会话。前端据此判「近期活跃」（Active/Stale 二分）。
	lastOutputAt: z.number().nullable(),
	// 距最近一次「实质」产出（不含 spinner/footer/计时器等装饰性重绘）；null=无实质戳/无会话。概览行的
	// 「agent 上次响应至今」药丸读它——与主看板卡片头部同源（task-card-body 的 lastAgentResponseAt），
	// 避免终端 agent 仅 spinner 重绘时显示虚假「刚响应」。
	lastSubstantiveOutputAt: z.number().nullable(),
	// 概览行的两颗时长药丸（与主看板卡片头部同源、同语义）：
	//   Stopped   —— 本次 incarnation 何时进入非生成态；agent 回合 / park 期间为 null。
	//   Progress  —— 这个任务的对话上次真正往前走到哪一刻（跨 incarnation 的历史事实）。
	// 二者为什么必须分开、以及为什么都不能用 lastSubstantiveOutputAt 冒充，见
	// runtimeLastConversationProgressObservationSchema 的注释。
	// 加性 optional：旧 runtime payload 不带 ⇒ 该颗药丸隐藏，绝不回退读上面那个实质戳。
	agentResponseGenerationStopped: runtimeAgentResponseGenerationStoppedSchema.nullable().optional(),
	lastConversationProgressObservation: runtimeLastConversationProgressObservationSchema.nullable().optional(),
	turnOwner: runtimeTaskSessionTurnOwnerSchema,
	liveness: runtimeTaskSessionLivenessSchema,
});
export type RuntimeInProgressTaskDetail = z.infer<typeof runtimeInProgressTaskDetailSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
	// 旧 runtime payload 未携带 availability；缺省仅用于网络兼容。新服务端始终显式检查并发送结果。
	availability: runtimeProjectAvailabilitySchema.default({ status: "available" }),
	// board 列归属的原始计数（未套主看板的 live-session overlay）。Stage-First Overview 用它做
	// Review/Validation/Done 的 stage 计数，与 overlay 后的 taskCounts 并存不冲突（见 ADR-0001）。
	// optional：projects.add 快路径可省略，下一次 projects_updated/snapshot 广播补齐。
	rawColumnTaskCounts: runtimeProjectTaskCountsSchema.optional(),
	// 该 project in_progress 列全部 task 的明细，供 Stage-First Overview 展开 In-Progress 阶段
	// （前端据活跃度二分 Active/Stale）。default([])：旧广播/快照无此字段时安全回退。
	inProgressTaskDetails: z.array(runtimeInProgressTaskDetailSchema).default([]),
	// The project's git `remote.origin.url` (raw, unnormalized), or null when the repo
	// has no origin remote / the read failed. Consumed by the bug-report FAB to detect
	// the cline-kanban developer project by matching its GitHub owner/repo slug.
	gitRemoteOriginUrl: z.string().nullable().optional(),
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskCommitIntegrationTrackingStatusSchema = z.enum([
	"complete",
	"legacy_history_unavailable",
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
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
	// 「人轴」种类随一次性 ready 事件 payload 内联下发（广播时由服务端从 summary facet 解析）。
	// 前端通知标题据此措辞，不再回读延迟 150ms 批处理的 task_sessions_updated summary 流——
	// 杜绝上次 ③(b) 命中的「事件先到、summary 后到 → 标题读 stale userTurnKind」竞态。
	// 可选：旧服务端/缓存旧构建可能不带该字段，缺省时前端按 review 措辞兜底（加性 schema 纪律）。
	userTurnKind: runtimeTaskSessionUserTurnKindSchema.optional(),
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

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
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
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

// 跨全部注册项目的任务搜索索引（Spotlight 全局搜索「包含其它项目」时按需拉取）。仅携带搜索所需的最小字段
// （taskId + title + prompt + columnId），不含 session / 工作区元数据，避免放进高频广播的 projects payload。
export const runtimeAllProjectsTaskSearchIndexTaskEntrySchema = z.object({
	taskId: z.string(),
	title: z.string(),
	prompt: z.string(),
	columnId: runtimeBoardColumnIdSchema,
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
	removeTaskCommitIntegrationProvenanceAfterWorktreeDeletion: z.boolean().optional(),
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

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	newTaskStartInPlanModeByDefault: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	notificationSoundEnabled: z.boolean(),
	autoContinueOnConnectionDropEnabled: z.boolean(),
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
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	newTaskStartInPlanModeByDefault: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	notificationSoundEnabled: z.boolean().optional(),
	autoContinueOnConnectionDropEnabled: z.boolean().optional(),
	postDeployVerificationForceCompleteEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z
	.object({
		taskId: z.string(),
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
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
		terminalAgentModelOverrideSettings: runtimeTaskTerminalAgentModelOverrideSettingsSchema.optional(),
		taskAgentSessionInitialization: runtimeTaskAgentSessionInitializationSchema.optional(),
		parentSessionId: z.string().optional(),
		worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
		prepFilePath: z.string().optional(),
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
	sourceAgentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
	sourceSessionId: z.string().uuid(),
	sessionTitle: z.string(),
	sessionWorkingDirectoryPath: z.string().nullable(),
	gitBranchName: z.string().nullable(),
	modelId: z.string().nullable(),
	lastUpdatedAt: z.string(),
	previewConversationTurns: z.array(runtimeAvailableAgentSessionPreviewTurnSchema).max(3),
});
export type RuntimeAvailableAgentSessionSummary = z.infer<typeof runtimeAvailableAgentSessionSummarySchema>;

export const runtimeAvailableAgentSessionsRequestSchema = z.object({
	agentId: runtimeTerminalAgentModelSelectionAgentIdSchema,
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

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
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

export const runtimeTaskChatSendRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	source: z.string().optional(),
	idempotencyKey: z.string().optional(),
	promptSha256: z.string().optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

export const runtimeTaskChatSendResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

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

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

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
});
export type RuntimeAgentRaisedDecisionOption = z.infer<typeof runtimeAgentRaisedDecisionOptionSchema>;

export const runtimeAgentRaisedUserQuestionPayloadSchema = z.object({
	// harness 提供的稳定标识（Claude 的 tool_use_id），用于跨重发去重。
	decisionSourceId: z.string(),
	questionMarkdown: z.string(),
	options: z.array(runtimeAgentRaisedDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
	multiSelect: z.boolean(),
});
export type RuntimeAgentRaisedUserQuestionPayload = z.infer<typeof runtimeAgentRaisedUserQuestionPayloadSchema>;

// 工具授权请求：只带工具名与参数**摘要**，绝不带参数正文——避免把命令行 / 路径 / 密钥落进盘。
export const runtimeAgentRaisedToolPermissionPayloadSchema = z.object({
	decisionSourceId: z.string(),
	toolName: z.string(),
	toolInputSummary: z.string().nullable(),
});
export type RuntimeAgentRaisedToolPermissionPayload = z.infer<typeof runtimeAgentRaisedToolPermissionPayloadSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
	// 仅在 agent 确实发起了「等你拍板」的决策时携带（AskUserQuestion / PermissionRequest）。
	// 两者互斥：一次 hook 只可能是其中一种。
	agentRaisedUserQuestion: runtimeAgentRaisedUserQuestionPayloadSchema.optional(),
	agentRaisedToolPermission: runtimeAgentRaisedToolPermissionPayloadSchema.optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;

// ── 待答用户决策的读写契约（会话被回收后仍能重现并作答）─────────────────────────────────
// decisionKind 刻意只有两种、**没有 plan_review**：计划审批不做 carry-forward。
export const runtimeAgentRaisedPendingUserDecisionSchema = z.object({
	decisionId: z.string(),
	taskId: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	decisionKind: z.enum(["ordinary_user_question", "tool_permission_request"]),
	questionMarkdown: z.string(),
	options: z.array(runtimeAgentRaisedDecisionOptionSchema),
	allowsFreeformAnswer: z.boolean(),
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
});
export type RuntimeAgentRaisedPendingUserDecision = z.infer<typeof runtimeAgentRaisedPendingUserDecisionSchema>;

export const runtimeListAgentRaisedPendingUserDecisionsResponseSchema = z.object({
	decisions: z.array(runtimeAgentRaisedPendingUserDecisionSchema),
});
export type RuntimeListAgentRaisedPendingUserDecisionsResponse = z.infer<
	typeof runtimeListAgentRaisedPendingUserDecisionsResponseSchema
>;

export const runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema = z.object({
	decisionId: z.string(),
	selectedOptionIds: z.array(z.string()),
	freeformText: z.string().nullable(),
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

// 入 Done 前需显式确认的项（plan Grilling #6 / #8）：
//   skip_validation     = review/in_progress 跳过 validation 列直接入 Done
//   in_progress_active  = 任务仍处于 in_progress（session 可能仍在跑）
// CLI 单次 `verification-confirm --ack a,b`；UI in_progress 拆成两次顺序对话框。
export const runtimePostDeployVerificationAcknowledgementSchema = z.enum(["skip_validation", "in_progress_active"]);
export type RuntimePostDeployVerificationAcknowledgement = z.infer<
	typeof runtimePostDeployVerificationAcknowledgementSchema
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

// CLI 两步确认跨进程，token 必须持久化于 task 条目而非内存（plan 1c / Grilling #8）。
// columnIdAtIssuance 绑定发放时所在列——confirm 时任务列已变（如自动流转）则 token 失效重发。
export const runtimePostDeployVerificationPendingConfirmationSchema = z.object({
	token: z.string(),
	expiresAtIso: z.string(),
	requiredAcknowledgements: z.array(runtimePostDeployVerificationAcknowledgementSchema),
	columnIdAtIssuance: runtimeBoardColumnIdSchema,
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
	verifiedAt: z.string().nullable(),
	boardMovedToDoneAt: z.string().nullable(),
	pendingConfirmation: runtimePostDeployVerificationPendingConfirmationSchema.nullable(),
	droppedReason: runtimePostDeployVerificationDroppedReasonSchema.nullable(),
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
// **绝不移列**。移列职责：Web = completePostDeployVerificationMoveToDone、CLI = trashTaskById 链（plan 1d）。
// Web 时序为「先移列后 confirm」，故 confirm 校验任务已在 trash、checklist 仍全勾、token 有效。
export const runtimeConfirmVerificationCompleteRequestSchema = z.object({
	deploymentId: z.string(),
	taskId: z.string(),
	token: z.string(),
	acks: z.array(runtimePostDeployVerificationAcknowledgementSchema),
});
export type RuntimeConfirmVerificationCompleteRequest = z.infer<typeof runtimeConfirmVerificationCompleteRequestSchema>;

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
