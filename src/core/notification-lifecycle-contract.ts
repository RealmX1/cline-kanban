import { z } from "zod";

export const notificationPanelVisibilitySchema = z.enum(["pending_decision", "visible", "cleared", "excluded"]);
// 第三方 TTS 与浏览器系统语音共用的播报脚本：先导（项目 + 任务）与正文分开合成，中间插入停顿。
export const notificationSpeechAnnouncementScriptSchema = z.object({
	leadInText: z.string(),
	bodyText: z.string(),
});
export type NotificationSpeechAnnouncementScript = z.infer<typeof notificationSpeechAnnouncementScriptSchema>;
export const notificationCandidateSchema = z.object({
	candidateId: z.string(),
	sequence: z.number(),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
	userTurnKind: z.string(),
	sourceKind: z.string(),
	notificationPanelVisibility: notificationPanelVisibilitySchema,
	notificationPanelVisibilityChangedAt: z.number(),
	notificationVisitedAt: z.number().nullable(),
	notificationProcessingStatus: z.string(),
	deferredNotificationFallbackDeadlineAt: z.number().nullable(),
	summaryText: z.string(),
	summaryLanguage: z.enum(["zh-CN", "en-US"]),
	// AI 评估按朗读要求另写的摘要（无路径/哈希/符号）；旧记录与未走 AI 的记录没有此字段。
	spokenSummaryTextForNotificationSpeech: z.string().nullable().optional(),
	// 发布时定稿的播报脚本，留档记录实际念了什么；旧记录缺省时合成前现场组装。
	notificationSpeechAnnouncementScript: notificationSpeechAnnouncementScriptSchema.nullable().optional(),
	taskTitleSnapshot: z.string(),
	repositoryNameSnapshot: z.string(),
	supersededByCandidateId: z.string().nullable(),
	runtimeSessionIncarnationId: z.string().nullable(),
	agentResponseGenerationTurnSequence: z.number().nullable(),
	rawPayload: z.unknown().optional(),
	evidence: z.record(z.string(), z.unknown()).optional(),
	audioSha256: z.string().nullable(),
	deliveryClaimedBy: z.string().nullable(),
});
export type NotificationCandidate = z.infer<typeof notificationCandidateSchema>;
export const notificationLifecycleEventSchema = z.object({
	sequence: z.number(),
	candidateId: z.string(),
	occurredAt: z.number(),
	eventType: z.string(),
	details: z.unknown(),
});
export const notificationArchiveListRequestSchema = z.object({
	workspaceId: z.string().optional(),
	taskId: z.string().optional(),
	panelOnly: z.boolean().optional(),
	processingStatus: z.string().optional(),
	triggeredAtOrAfter: z.number().nonnegative().optional(),
	triggeredAtOrBefore: z.number().nonnegative().optional(),
	beforeSequence: z.number().int().positive().optional(),
	limit: z.number().int().min(1).max(100).default(50),
});
export const notificationArchiveListResponseSchema = z.object({
	entries: z.array(notificationCandidateSchema),
	totalCount: z.number(),
	unreadTaskCount: z.number(),
	nextBeforeSequence: z.number().nullable(),
	revision: z.number(),
});
export const notificationCandidateLifecycleSchema = z.object({
	candidate: notificationCandidateSchema,
	events: z.array(notificationLifecycleEventSchema),
});
export type NotificationArchiveListRequest = z.input<typeof notificationArchiveListRequestSchema>;
