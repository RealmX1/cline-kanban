import { z } from "zod";
import { runtimeAgentIdSchema, runtimeTaskCommentEntrySchema } from "./api-contract";
import { kanbanBoardCardWorkUnitQualifiedReferenceSchema } from "./inter-work-unit-relation-ledger-event-contract";

export const appendTaskCommentRequestSchema = z.object({
	taskId: z.string().min(1),
	taskCommentEntryId: z.string().min(1).max(200).optional(),
	commentText: z.string().trim().min(1).max(500000),
	taskIncarnationCreatedAtEpochMs: z.number().optional(),
});
export type AppendTaskCommentRequest = z.infer<typeof appendTaskCommentRequestSchema>;
export const appendTaskCommentResponseSchema = z.object({
	appended: z.boolean(),
	comment: runtimeTaskCommentEntrySchema,
});
export type AppendTaskCommentResponse = z.infer<typeof appendTaskCommentResponseSchema>;

export const taskIndexingSupportExecutorSettingsSchema = z.object({
	agentId: z.enum(["claude", "codex"]).default("codex"),
	modelId: z.string().trim().min(1).max(200).nullable().default(null),
});
export type TaskIndexingSupportExecutorSettings = z.infer<typeof taskIndexingSupportExecutorSettingsSchema>;

export const taskIndexingMaterialSchema = z.object({
	taskReference: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	projectName: z.string(),
	title: z.string(),
	prompt: z.string(),
	columnId: z.string(),
	latestNotificationSummaryText: z.string().nullable(),
	latestHookFinalMessage: z.string().nullable(),
	claudeAwaySummary: z.string().nullable(),
	missingContextParts: z.array(z.string()),
});
export type TaskIndexingMaterial = z.infer<typeof taskIndexingMaterialSchema>;

export const sharedTaskIndexingContextSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	levelOneBoardTaskIndexText: z.string(),
	levelTwoProjectTaskRecapsText: z.string(),
	levelThreeAppendedChangesText: z.string(),
	snapshotFingerprint: z.string(),
	contextCompleteness: z.array(z.string()),
	asOf: z.number(),
	rebuildReason: z
		.enum([
			"initial_snapshot",
			"invalid_snapshot",
			"instruction_version_changed",
			"cache_retention_lower_bound_exceeded",
			"new_process_cache_reuse_unproven",
			"appended_changes_exceed_snapshot_fraction",
			"retired_entries_exceed_snapshot_fraction",
		])
		.nullable(),
});
export type SharedTaskIndexingContext = z.infer<typeof sharedTaskIndexingContextSchema>;

export const incomingWorkItemSchema = z.object({
	schema_version: z.literal(1),
	work_item_key: z.string().trim().min(1).max(500),
	title: z.string().trim().min(1).max(1000),
	prompt: z.string().trim().min(1).max(200000),
	origin: z.enum(["rvf_validated_out_of_scope_finding", "other"]).default("other"),
	evidence: z.array(z.string().max(10000)).max(50).default([]),
	source_task: kanbanBoardCardWorkUnitQualifiedReferenceSchema.optional(),
	existing_finding_task: kanbanBoardCardWorkUnitQualifiedReferenceSchema.optional(),
	creation_settings: z
		.object({
			agent_id: runtimeAgentIdSchema.optional(),
			base_ref: z.string().min(1).optional(),
			start_in_plan_mode: z.boolean().optional(),
		})
		.default({}),
});
export type IncomingWorkItem = z.infer<typeof incomingWorkItemSchema>;

export const incomingWorkItemRelationCandidateSchema = z.object({
	task_reference: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	relation_kind: z.enum(["reference_concerns_behavior_or_state_of", "reference_is_generally_related_with"]),
	confidence: z.enum(["high", "medium", "low"]),
	coverage: z.enum(["fully_covers_incoming_work", "partial_overlap", "generally_related"]),
	rationale: z.string().trim().min(1).max(2000),
	evidence: z.array(z.string().max(2000)).max(20),
	cross_project: z.boolean(),
});
export type IncomingWorkItemRelationCandidate = z.infer<typeof incomingWorkItemRelationCandidateSchema>;

export const incomingWorkItemRelationAnalysisSchema = z.object({
	relation_candidates: z.array(incomingWorkItemRelationCandidateSchema).max(30),
});
export type IncomingWorkItemRelationAnalysis = z.infer<typeof incomingWorkItemRelationAnalysisSchema>;

export const incomingWorkItemTriageResponseSchema = incomingWorkItemRelationAnalysisSchema.extend({
	decision: z.enum([
		"linked_to_existing_task",
		"created_task_with_possible_relations",
		"created_task_without_relations",
	]),
	created_task_id: z.string().optional(),
	linked_task_id: z.string().optional(),
	as_of: z.number(),
	operation_id: z.string(),
	existing_finding_task_preserved: z.boolean().optional(),
});
export type IncomingWorkItemTriageResponse = z.infer<typeof incomingWorkItemTriageResponseSchema>;

export const incomingWorkItemTriageOperationFailureSchema = z.object({
	operation_id: z.string(),
	completed_steps: z.array(z.string()),
	started_steps: z.array(z.string()),
});
export class IncomingWorkItemTriageOperationError extends Error {
	constructor(
		message: string,
		readonly operationFailure: z.infer<typeof incomingWorkItemTriageOperationFailureSchema>,
		cause: unknown,
	) {
		super(message, { cause });
		this.name = "IncomingWorkItemTriageOperationError";
	}
}
