import { z } from "zod";
import { runtimeBoardCardSchema } from "./api-contract";
import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	assertedInterWorkUnitRelationSchema,
	assertedReferenceRelationKindSpecificAttributesSchema,
} from "./inter-work-unit-asserted-relation-kind-registry-contract";
import { RELATION_ASSERTION_REVOCATION_REASONS } from "./inter-work-unit-relation-assertion-lifecycle-event-contract";
import {
	type InterWorkUnitRelationLedgerEventDraft,
	interWorkUnitRelationWorkUnitReferenceSchema,
} from "./inter-work-unit-relation-ledger-event-contract";
import { webUiUserDecisionClientCharacteristicsSchema } from "./work-unit-relation-assertion-write-api-contract";
import {
	workUnitDisplayEntrySchema,
	workUnitSelectorForRelationReadSchema,
} from "./work-unit-relation-read-api-contract";

// 草稿没有真实任务身份；读侧使用虚拟根，直到建卡落盘后才解析成限定引用。
export const referenceRelationModelingDraftSchema = z.object({
	draftId: z.string().min(1).max(100),
	replacesRelationId: z.string().nullable().default(null),
	expectedAssertedRelationStateVersion: z.number().int().positive().nullable().default(null),
	counterpartWorkUnit: interWorkUnitRelationWorkUnitReferenceSchema,
	relationKind: z.enum(ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS),
	currentTaskIsStatementSubject: z.boolean().default(true),
	relationAssertionRationaleOneSentence: z.string().trim().min(1).max(600),
	relationAssertionEvidencePointers: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
	assertedRelationKindSpecificAttributes: assertedReferenceRelationKindSpecificAttributesSchema.default({}),
});
export type ReferenceRelationModelingDraft = z.infer<typeof referenceRelationModelingDraftSchema>;
export const referenceRelationModelingRevocationSchema = z.object({
	relationId: z.string().min(1),
	expectedAssertedRelationStateVersion: z.number().int().positive(),
	relationAssertionRevocationReason: z.enum(RELATION_ASSERTION_REVOCATION_REASONS),
});
export const relationModelingPreviewRequestSchema = z.object({
	workUnit: workUnitSelectorForRelationReadSchema.nullable(),
	draftTaskTitle: z.string().max(1000).default("待创建任务"),
	relationNeighborhoodDepth: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
	referenceRelationDrafts: z.array(referenceRelationModelingDraftSchema).max(50).default([]),
	relationRevocations: z.array(referenceRelationModelingRevocationSchema).max(50).default([]),
});
export type RelationModelingPreviewRequest = z.infer<typeof relationModelingPreviewRequestSchema>;
export const relationModelingPreviewEdgeSchema = z.object({
	relationId: z.string(),
	subjectKey: z.string(),
	anchorKey: z.string(),
	relationKind: z.string(),
	relationPresentationState: z.enum(["saved", "pending_addition", "pending_revision", "pending_revocation"]),
	assertedRelation: assertedInterWorkUnitRelationSchema.nullable(),
});
export const relationModelingPreviewResponseSchema = z.object({
	rootWorkUnitKey: z.string(),
	workUnits: z.array(workUnitDisplayEntrySchema),
	relations: z.array(relationModelingPreviewEdgeSchema),
	truncated: z.boolean(),
	projectedThroughGlobalCommittedEventSequence: z.number(),
});
export type RelationModelingPreviewResponse = z.infer<typeof relationModelingPreviewResponseSchema>;
export const applyReferenceRelationModelingChangesRequestSchema = relationModelingPreviewRequestSchema
	.omit({ draftTaskTitle: true, relationNeighborhoodDepth: true })
	.extend({
		workUnit: workUnitSelectorForRelationReadSchema,
		modelingSubmissionId: z.string().min(1).max(100),
		webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
	});
export type ApplyReferenceRelationModelingChangesRequest = z.infer<
	typeof applyReferenceRelationModelingChangesRequestSchema
>;
export const applyReferenceRelationModelingChangesResponseSchema = z.object({
	modelingSubmissionId: z.string(),
	alreadyApplied: z.boolean(),
});
export type ApplyReferenceRelationModelingChangesResponse = z.infer<
	typeof applyReferenceRelationModelingChangesResponseSchema
>;

export interface ReferenceRelationModelingLedgerCommit {
	expectations: { relationId: string; assertedRelationStateVersion: number }[];
	relationsAfterChange: z.infer<typeof assertedInterWorkUnitRelationSchema>[];
	eventDraft: InterWorkUnitRelationLedgerEventDraft;
}

// a0401 的接入缝：候选只读，用户选择后才进入草稿。不可用与零候选明确区分。
export const referenceRelationModelingSuggestionsRequestSchema = relationModelingPreviewRequestSchema.extend({
	draftTaskPrompt: z.string().max(200000).optional(),
});
export type ReferenceRelationModelingSuggestionsRequest = z.infer<
	typeof referenceRelationModelingSuggestionsRequestSchema
>;
export const referenceRelationModelingSuggestionsResponseSchema = z.object({
	availability: z.enum(["unavailable", "available"]),
	unavailableReason: z.string().nullable(),
	contextAsOf: z.number().nullable(),
	contextCompleteness: z.array(z.string()),
	candidates: z.array(
		z.object({
			candidateId: z.string(),
			relationDraft: referenceRelationModelingDraftSchema,
			rationale: z.string(),
			evidencePointers: z.array(z.string()),
		}),
	),
});

export const referenceRelationModelingEditorDraftSchema = z.object({
	referenceRelationDrafts: z.array(referenceRelationModelingDraftSchema).max(50),
	relationRevocations: z.array(referenceRelationModelingRevocationSchema).max(50),
	createdTaskId: z.string().nullable(),
	createdTaskCardSnapshot: runtimeBoardCardSchema.nullable().default(null),
	modelingSubmissionId: z.string().min(1).max(100),
	creationPrompt: z.string().max(200000).default(""),
	creationTitle: z.string().max(1000).default(""),
});
export type ReferenceRelationModelingEditorDraft = z.infer<typeof referenceRelationModelingEditorDraftSchema>;
export const relationModelingEditorDraftReadRequestSchema = z.object({
	workspaceId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	draftScopeId: z.string().min(1).max(200),
});
export const relationModelingEditorDraftSaveRequestSchema = relationModelingEditorDraftReadRequestSchema.extend({
	draft: referenceRelationModelingEditorDraftSchema.nullable(),
});
