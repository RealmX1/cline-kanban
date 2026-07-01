import { z } from "zod";
// Stage 4 全写侧反转：facet 为写时主真相源，`state` 降为 projectLegacyState(facets) 派生投影。
// bundle-safe：session-activity 是零 Node 依赖的纯函数模块，其对 api-contract 仅 type-only import
// （编译期擦除），故二者无运行时循环；本处取值 import 不会把任何 Node 依赖拖进浏览器 bundle。
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
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeTaskWorktreeModeSchema = z.enum(["branch", "inplace"]);
export type RuntimeTaskWorktreeMode = z.infer<typeof runtimeTaskWorktreeModeSchema>;

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

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "gemini", "opencode", "droid", "kiro", "cline"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

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
		autoReviewEnabled: z.boolean().optional(),
		autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		taskCommentEntries: z.array(runtimeTaskCommentEntrySchema).optional(),
		agentId: runtimeAgentIdSchema.optional(),
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
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
			return {
				...card,
				...(clineSettings !== undefined ? { clineSettings } : {}),
				...(taskCommentEntries !== undefined ? { taskCommentEntries } : {}),
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
	.enum(["attention", "exit", "error", "interrupted", "hook", "completion", "manual_review"])
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
});
export type RuntimeTaskAwaitingDispatchedBackgroundWork = z.infer<
	typeof runtimeTaskAwaitingDispatchedBackgroundWorkSchema
>;

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

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
	// The project's git `remote.origin.url` (raw, unnormalized), or null when the repo
	// has no origin remote / the read failed. Consumed by the bug-report FAB to detect
	// the cline-kanban developer project by matching its GitHub owner/repo slug.
	gitRemoteOriginUrl: z.string().nullable().optional(),
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	// 任务从 base 分叉时的提交（fork-point，git merge-base HEAD <baseRef>）。
	// 稳定不随 base 分支推进而变；未探测 / 计算失败 / inplace 无分叉等情形为 null。
	baseCommit: z.string().nullable(),
	// fork-point..HEAD 的 commit 数（任务开工后落在当前 worktree 上的提交数）。
	commitsSinceFork: z.number().int().nonnegative().nullable(),
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

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
	clineSessionContextVersion: z.number().int().nonnegative(),
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
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

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

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

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

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	notificationSoundEnabled: z.boolean(),
	autoContinueOnConnectionDropEnabled: z.boolean(),
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
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	notificationSoundEnabled: z.boolean().optional(),
	autoContinueOnConnectionDropEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	/** Display title from the Kanban task card. Propagated to SDK session metadata as a convenience copy. */
	taskTitle: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeFromTrash: z.boolean().optional(),
	baseRef: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	agentId: runtimeAgentIdSchema.optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
	parentSessionId: z.string().optional(),
	worktreeMode: runtimeTaskWorktreeModeSchema.optional(),
	prepFilePath: z.string().optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

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

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
