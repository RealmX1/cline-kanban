import { z } from "zod";

import { recordedInterWorkUnitRelationSchema } from "./inter-work-unit-recorded-relation-projection-contract";
import {
	agentConversationSessionIdentityKeySchema,
	interWorkUnitRelationWorkUnitReferenceSchema,
	kanbanBoardCardWorkUnitQualifiedReferenceSchema,
} from "./inter-work-unit-relation-ledger-event-contract";

// dd2db 1b 读侧的 tRPC 契约（`workUnit.*`）：CLI 读动词、Web UI Relations 面板、会话启动注入共用。
// 关系账本只在 runtime 内打开，所以跨 project 解析与邻域查询一律经 runtime；runtime 离线或账本不可用时如实报错，
// 绝不返回空邻域冒充「没有关系」。

// 输入面接受裸 id（Y-EVENT-12）：runtime 解析到唯一一世；候选不唯一时 fail closed，要求带 workspaceId 消歧。
export const workUnitSelectorForRelationReadSchema = z.discriminatedUnion("workUnitSelectorKind", [
	z.object({
		workUnitSelectorKind: z.literal("kanban_board_card_by_bare_task_id"),
		bareTaskId: z.string().trim().min(1),
		workspaceId: z.string().trim().min(1).optional(),
	}),
	z.object({
		workUnitSelectorKind: z.literal("kanban_unmanaged_standalone_agent_conversation_session"),
		conversationSessionHostKanbanAgentId: z.string().trim().min(1),
		nativeConversationSessionId: z.string().trim().min(1),
	}),
]);
export type WorkUnitSelectorForRelationRead = z.infer<typeof workUnitSelectorForRelationReadSchema>;

// 一世卡片的身份投影（全局 task 身份登记簿的读侧）。永久删除的卡也在，permanentlyRemovedFromBoardAt 非空即墓碑。
export const kanbanBoardCardIdentityResolutionCandidateSchema = z.object({
	kanbanBoardCard: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	workspaceRepositoryPath: z.string().nullable(),
	currentTitle: z.string().nullable(),
	promptFirstParagraph: z.string().nullable(),
	lastKnownBoardColumnId: z.string().nullable(),
	movedToTrashColumnAt: z.number().nullable(),
	permanentlyRemovedFromBoardAt: z.number().nullable(),
	creationActorKind: z.string().nullable(),
	kanbanBoardCardFirstObservationRoute: z.string(),
});
export type KanbanBoardCardIdentityResolutionCandidate = z.infer<
	typeof kanbanBoardCardIdentityResolutionCandidateSchema
>;

export const resolveKanbanBoardCardIdentityByBareTaskIdRequestSchema = z.object({
	bareTaskId: z.string().trim().min(1),
});
export type ResolveKanbanBoardCardIdentityByBareTaskIdRequest = z.infer<
	typeof resolveKanbanBoardCardIdentityByBareTaskIdRequestSchema
>;
export const resolveKanbanBoardCardIdentityByBareTaskIdResponseSchema = z.object({
	// 仍在 board 上的排前面；激活之前就删掉的卡不在其中（2b 回填重建）。
	kanbanBoardCardIdentityCandidates: z.array(kanbanBoardCardIdentityResolutionCandidateSchema),
});
export type ResolveKanbanBoardCardIdentityByBareTaskIdResponse = z.infer<
	typeof resolveKanbanBoardCardIdentityByBareTaskIdResponseSchema
>;

export const workUnitDisplayEntrySchema = z.object({
	workUnitKey: z.string(),
	workUnit: interWorkUnitRelationWorkUnitReferenceSchema,
	workUnitDisplayLabel: z.string(),
	// 卡片才有；独立会话为 null。
	kanbanBoardCardIdentity: kanbanBoardCardIdentityResolutionCandidateSchema.nullable(),
});
export type WorkUnitDisplayEntry = z.infer<typeof workUnitDisplayEntrySchema>;

export const conversationSessionOwnershipConflictDiagnosticForReadSchema = z.object({
	conversationSessionIdentityKey: agentConversationSessionIdentityKeySchema,
	currentOwningWorkUnit: interWorkUnitRelationWorkUnitReferenceSchema,
	previouslyOwningKanbanBoardCardObservedAgain: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	conflictObservedAt: z.number(),
	conflictObservedInEventId: z.string(),
});

// 1 = 一度邻域；2 = 再加上一度邻居各自的关系（只出文本与结构，图视图在 2c）。
export const RELATION_NEIGHBORHOOD_DEPTHS = [1, 2] as const;
export const getRelationNeighborhoodSummaryRequestSchema = z.object({
	workUnit: workUnitSelectorForRelationReadSchema,
	relationNeighborhoodDepth: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type GetRelationNeighborhoodSummaryRequest = z.infer<typeof getRelationNeighborhoodSummaryRequestSchema>;
export const getRelationNeighborhoodSummaryResponseSchema = z.object({
	subjectWorkUnit: workUnitDisplayEntrySchema,
	// 一度邻域：以主体为 S 或 A 的全部记录型关系（断言型关系阶段 2 起加入）。被静音的也在，带 mutedAt。
	recordedRelations: z.array(recordedInterWorkUnitRelationSchema),
	neighborWorkUnits: z.array(workUnitDisplayEntrySchema),
	// 只在 relationNeighborhoodDepth = 2 时非空：一度邻居各自的、不触及主体的关系，以及由此多出的二度邻居。
	secondHopRecordedRelations: z.array(recordedInterWorkUnitRelationSchema),
	secondHopNeighborWorkUnits: z.array(workUnitDisplayEntrySchema),
	conversationSessionOwnershipConflictDiagnostics: z.array(
		conversationSessionOwnershipConflictDiagnosticForReadSchema,
	),
	// 给 agent 读的文本（CLI 默认输出与会话启动注入共用同一份渲染）。
	renderedNeighborhoodSummaryText: z.string(),
	hasAnyRelationVisibleByDefault: z.boolean(),
	recordedInterWorkUnitRelationProjectionTableVersion: z.number(),
	projectedThroughGlobalCommittedEventSequence: z.number(),
});
export type GetRelationNeighborhoodSummaryResponse = z.infer<typeof getRelationNeighborhoodSummaryResponseSchema>;

export const conversationSessionOwnershipPeriodForReadSchema = z.object({
	conversationSessionIdentityKey: agentConversationSessionIdentityKeySchema,
	owningWorkUnit: interWorkUnitRelationWorkUnitReferenceSchema,
	ownershipPeriodStartedAt: z.number().nullable(),
	ownershipPeriodEndedAt: z.number().nullable(),
	ownershipPeriodEstablishmentRoute: z.string(),
	observedInKanbanTaskConversationSessionIds: z.array(z.string()),
});
export type ConversationSessionOwnershipPeriodForRead = z.infer<typeof conversationSessionOwnershipPeriodForReadSchema>;

export const listConversationSessionOwnershipPeriodsRequestSchema = z.object({
	workUnit: workUnitSelectorForRelationReadSchema,
});
export type ListConversationSessionOwnershipPeriodsRequest = z.infer<
	typeof listConversationSessionOwnershipPeriodsRequestSchema
>;
export const listConversationSessionOwnershipPeriodsResponseSchema = z.object({
	subjectWorkUnit: workUnitDisplayEntrySchema,
	conversationSessionOwnershipPeriods: z.array(conversationSessionOwnershipPeriodForReadSchema),
});
export type ListConversationSessionOwnershipPeriodsResponse = z.infer<
	typeof listConversationSessionOwnershipPeriodsResponseSchema
>;

// 工作单元上下文提供端口（R2.4、Y-PHASE-4）。1b 只有 global_recap，且只有 cline-kanban 内的 L1 兜底提供方；
// L2 完整意图卷宗、L3 transcript 节选在阶段 2。提供方返回「不可用」是合法结果。
export const WORK_UNIT_CONTEXT_LEVELS = ["global_recap"] as const;
export const getWorkUnitContextRequestSchema = z.object({
	workUnit: workUnitSelectorForRelationReadSchema,
	workUnitContextLevel: z.enum(WORK_UNIT_CONTEXT_LEVELS),
});
export type GetWorkUnitContextRequest = z.infer<typeof getWorkUnitContextRequestSchema>;
export const getWorkUnitContextResponseSchema = z.object({
	subjectWorkUnit: workUnitDisplayEntrySchema,
	workUnitContextLevel: z.enum(WORK_UNIT_CONTEXT_LEVELS),
	workUnitContextProviderName: z.string(),
	workUnitContextProviderAvailability: z.enum(["available", "unavailable"]),
	workUnitContextUnavailableReason: z.string().nullable(),
	workUnitContextAsOf: z.number(),
	// 这份上下文由哪些部件拼成；缺的部件如实列出，消费方据此判断能不能当完整 recap 用。
	workUnitContextCompleteness: z.object({
		includedContextParts: z.array(z.string()),
		missingContextParts: z.array(z.string()),
	}),
	globalRecapText: z.string().nullable(),
});
export type GetWorkUnitContextResponse = z.infer<typeof getWorkUnitContextResponseSchema>;

// 记录型关系的静音（d-vocab §2.3、R3.4）：只隐藏展示，不改事实。只在 Web UI、没有 CLI；必须带已校验的页面 nonce。
// 写族 7 `relation_presentation_preference_event`，按确定性 relationId 挂载，投影重放后不丢。
export const setRecordedRelationPresentationMutePreferenceRequestSchema = z.object({
	relationId: z.string().trim().min(1),
	recordedRelationMutedInPresentation: z.boolean(),
});
export type SetRecordedRelationPresentationMutePreferenceRequest = z.infer<
	typeof setRecordedRelationPresentationMutePreferenceRequestSchema
>;
export const setRecordedRelationPresentationMutePreferenceResponseSchema = z.object({
	relationId: z.string(),
	recordedRelationMutedInPresentation: z.boolean(),
	// 已经是目标状态时不重复记事件。
	relationPresentationPreferenceEventRecorded: z.boolean(),
});
export type SetRecordedRelationPresentationMutePreferenceResponse = z.infer<
	typeof setRecordedRelationPresentationMutePreferenceResponseSchema
>;
