import { z } from "zod";

import { interWorkUnitRelationWorkUnitReferenceSchema } from "./inter-work-unit-relation-ledger-event-contract";

// dd2db 阶段 1b：记录型关系（来源轴 3 个 kind + 交互轴 4 个 kind）的投影契约。
// 权威设计：d-vocab §2.3（关系信封）、§3.1（来源轴）、§3.2 与 §5（交互轴与逐字段白名单）、§10（注册表展示字段），
// 以及 §R3 Y-EVENT-10（系统组件代行）、Y-EVENT-18（卡对卡采纳）、Y-PHASE-12（创建时主来源）。
// 记录型关系不落盘：它是「事件日志 × 投影表版本」的纯函数，由 runtime 读时从账本事件推导（见
// src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events.ts）。
// 本文件同时被 web-ui 引用，只放 schema 与纯数据，不放 node 依赖。

export const RECORDED_INTER_WORK_UNIT_RELATION_KINDS = [
	"provenance_created_by",
	"provenance_resumed_and_adopted_conversation_session_of",
	"provenance_forked_conversation_session_of",
	"interaction_agent_session_dispatched_or_controlled_by",
	"interaction_requirements_amended_by",
	"interaction_execution_configuration_changed_by",
	"interaction_board_lifecycle_transitioned_by",
] as const;
export type RecordedInterWorkUnitRelationKind = (typeof RECORDED_INTER_WORK_UNIT_RELATION_KINDS)[number];

export type RecordedInterWorkUnitRelationAxis = "provenance" | "interaction";

export interface RecordedInterWorkUnitRelationKindRegistryEntry {
	relationAxis: RecordedInterWorkUnitRelationAxis;
	// 方向的规范来源（d-vocab §1.1）：S = 关系陈述的主语（回头指向对方的一方），A = 锚点。读法由单测锁定。
	forwardReadingPhraseFromSubject: string;
	inverseReadingPhraseFromAnchor: string;
	// d-vocab §10 的邻域摘要分区顺序：数字越小越靠前。
	neighborhoodSummarySectionPriority: number;
	// false = 默认折叠、只给计数（派发控制、配置、生命周期）。
	defaultVisibleInNeighborhoodSummary: boolean;
}

export const RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY: Record<
	RecordedInterWorkUnitRelationKind,
	RecordedInterWorkUnitRelationKindRegistryEntry
> = {
	provenance_created_by: {
		relationAxis: "provenance",
		forwardReadingPhraseFromSubject: "was created by",
		inverseReadingPhraseFromAnchor: "created",
		neighborhoodSummarySectionPriority: 6,
		defaultVisibleInNeighborhoodSummary: true,
	},
	provenance_resumed_and_adopted_conversation_session_of: {
		relationAxis: "provenance",
		forwardReadingPhraseFromSubject: "resumed and adopted the conversation session of",
		inverseReadingPhraseFromAnchor: "had its conversation session resumed and adopted by",
		neighborhoodSummarySectionPriority: 6,
		defaultVisibleInNeighborhoodSummary: true,
	},
	provenance_forked_conversation_session_of: {
		relationAxis: "provenance",
		forwardReadingPhraseFromSubject: "forked the conversation session of",
		inverseReadingPhraseFromAnchor: "had its conversation session forked into",
		neighborhoodSummarySectionPriority: 6,
		defaultVisibleInNeighborhoodSummary: true,
	},
	interaction_requirements_amended_by: {
		relationAxis: "interaction",
		forwardReadingPhraseFromSubject: "had its requirements amended by",
		inverseReadingPhraseFromAnchor: "amended the requirements of",
		neighborhoodSummarySectionPriority: 7,
		defaultVisibleInNeighborhoodSummary: true,
	},
	interaction_agent_session_dispatched_or_controlled_by: {
		relationAxis: "interaction",
		forwardReadingPhraseFromSubject: "had its agent session dispatched or controlled by",
		inverseReadingPhraseFromAnchor: "dispatched or controlled the agent session of",
		neighborhoodSummarySectionPriority: 9,
		defaultVisibleInNeighborhoodSummary: false,
	},
	interaction_execution_configuration_changed_by: {
		relationAxis: "interaction",
		forwardReadingPhraseFromSubject: "had its execution configuration changed by",
		inverseReadingPhraseFromAnchor: "changed the execution configuration of",
		neighborhoodSummarySectionPriority: 9,
		defaultVisibleInNeighborhoodSummary: false,
	},
	interaction_board_lifecycle_transitioned_by: {
		relationAxis: "interaction",
		forwardReadingPhraseFromSubject: "had its board lifecycle transitioned by",
		inverseReadingPhraseFromAnchor: "transitioned the board lifecycle of",
		neighborhoodSummarySectionPriority: 9,
		defaultVisibleInNeighborhoodSummary: false,
	},
};

export function isRecordedInterWorkUnitRelationKind(
	relationKind: string,
): relationKind is RecordedInterWorkUnitRelationKind {
	return (RECORDED_INTER_WORK_UNIT_RELATION_KINDS as readonly string[]).includes(relationKind);
}

// d-vocab §5 投影表：卡片字段 → 交互 kind 的逐字段白名单。未登记的字段（置顶、runtime 维护的派生字段……）只进日志、不投影。
export const TASK_CARD_FIELD_NAMES_PROJECTED_AS_REQUIREMENTS_AMENDMENT = [
	"prompt",
	"title",
	"images",
	"taskCommentEntries",
	"prepFilePath",
] as const;
export const TASK_CARD_FIELD_NAMES_PROJECTED_AS_EXECUTION_CONFIGURATION_CHANGE = [
	"taskAgentSessionInitialization",
	"parentSessionId",
	"agentId",
	"clineSettings",
	"clineProviderId",
	"clineModelId",
	"clineReasoningEffort",
	"terminalAgentModelOverrideSettings",
	"baseRef",
	"startInPlanMode",
	"taskAgentPermissionMode",
	"autoReviewEnabled",
	"autoReviewMode",
	"worktreeMode",
	"ompAgentSessionTransport",
	"taskConversationMode",
] as const;

// ---------------------------------------------------------------------------------------------
// 关系信封（d-vocab §2.3，记录型部分）。读侧 schema 一律 passthrough：投影表版本演进时多出的字段原样带回。
// ---------------------------------------------------------------------------------------------

export const recordedInterWorkUnitRelationSchema = z
	.object({
		relationId: z.string(),
		relationKind: z.string(),
		relationStatementSubjectWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationStatementAnchorWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationFirstEstablishedAt: z.number(),
		relationLastUpdatedAt: z.number(),
		// 只保留最近 N 条；完整列表由事件日志按端点索引给出。
		mostRecentProjectedFromEventIds: z.array(z.string()),
		captureChannelsOfDerivingEvents: z.array(z.string()),
		// 交互轴按事件种类计数；来源轴为空对象。
		occurrenceCountByTaskMutationEventKind: z.record(z.string(), z.number()),
		// 各 kind 的专有属性（d-vocab §3.1 / §3.2 表的「专有必填属性」列）。
		recordedRelationKindSpecificAttributes: z.record(z.string(), z.unknown()),
		// Y-PHASE-12：仅来源轴可能为 true；同一张卡至多一条。
		isCreationTimePrimaryProvenanceOfSubjectCard: z.boolean(),
		// 静音只影响展示（邻域摘要、会话启动注入不再列出它），关系本身照常存在。null = 未静音。
		mutedInPresentationAt: z.number().nullable(),
		mutedInPresentationByActorKind: z.string().nullable(),
	})
	.passthrough();

export const RELATION_PRESENTATION_PREFERENCE_EVENT_KINDS = [
	"recorded_relation_muted_in_presentation_by_user",
	"recorded_relation_unmuted_in_presentation_by_user",
] as const;
export type RecordedInterWorkUnitRelation = z.infer<typeof recordedInterWorkUnitRelationSchema>;
