import { z } from "zod";
import { runtimeTaskImageSchema } from "./api-contract";
import { kanbanBoardCardWorkUnitQualifiedReferenceSchema } from "./inter-work-unit-relation-ledger-event-contract";
import {
	taskAssistanceModelProviderAttemptSchema,
	taskAssistanceModelProviderRoutingSettingsSchema,
} from "./task-assistance-model-provider-routing-contract";
import { taskIndexingSupportExecutorSettingsSchema } from "./task-indexing-support-contract";

export const taskLookupExecutionPhaseSchema = z.enum([
	"collecting_materials",
	"preparing_context",
	"recalling_candidates",
	"explaining_candidates",
	"validating_candidates",
	"saving_result",
	"finished",
]);
export const taskLookupExecutionActivitySchema = z.object({
	occurredAtEpochMs: z.number(),
	phase: taskLookupExecutionPhaseSchema,
	eventKind: z.enum([
		"phase_started",
		"agent_process_started",
		"api_request_started",
		"agent_response_received",
		"agent_execution_completed",
		"diagnostic_warning",
		"query_completed",
		"query_failed",
		"query_cancelled",
		"query_interrupted",
	]),
	message: z.string().max(1000),
});
export const taskLookupExecutionFailureDiagnosticSchema = z.object({
	reasonCode: z.string(),
	failedPhase: taskLookupExecutionPhaseSchema,
	detail: z.string().max(4000),
	exitCode: z.number().nullable(),
	signal: z.string().nullable(),
	stderrTail: z.string().max(4000).nullable(),
});
export type TaskLookupExecutionPhase = z.infer<typeof taskLookupExecutionPhaseSchema>;
export type TaskLookupExecutionActivity = z.infer<typeof taskLookupExecutionActivitySchema>;

export const taskLookupScopeSchema = z.object({
	projectIds: z.array(z.string().min(1)).default([]),
	columnIds: z.array(z.string().min(1)).default([]),
});
export const taskLookupCandidateSchema = z.object({
	taskReference: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	matchingReason: z.string().trim().min(1).max(4000),
	evidence: z.array(z.string().max(4000)).max(20),
	limitations: z.array(z.string().max(2000)).max(20),
});
export const taskLookupModelAnswerSchema = z.object({
	answerText: z.string().trim().min(1).max(20000),
	candidates: z.array(taskLookupCandidateSchema).max(30),
});
export const taskLookupResultSchema = taskLookupModelAnswerSchema.extend({
	candidates: z.array(
		taskLookupCandidateSchema.extend({
			projectName: z.string(),
			title: z.string(),
			columnId: z.string(),
		}),
	),
	contextAsOf: z.number(),
	contextCompleteness: z.array(z.string()),
});
export const taskLookupTurnSchema = z.object({
	turnId: z.string(),
	requestId: z.string(),
	questionText: z.string(),
	questionImages: z.array(runtimeTaskImageSchema).optional(),
	executionOwnerRuntimeProcessInstanceId: z.string().uuid().nullable().optional(),
	executionRecoveryMessage: z.string().optional(),
	scope: taskLookupScopeSchema,
	status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
	phase: taskLookupExecutionPhaseSchema,
	owningRuntimeProcessInstanceId: z.string().optional(),
	executionOwnershipWarning: z.string().optional(),
	phaseStartedAt: z.number().optional(),
	lastExecutionActivityAt: z.number().optional(),
	executionActivityTimeline: z.array(taskLookupExecutionActivitySchema).max(200).optional(),
	omittedExecutionActivityCount: z.number().int().nonnegative().optional(),
	executorSettings: taskIndexingSupportExecutorSettingsSchema.optional(),
	providerRoutingSettings: taskAssistanceModelProviderRoutingSettingsSchema.optional(),
	providerAttempts: z.array(taskAssistanceModelProviderAttemptSchema).optional(),
	inputByteCount: z.number().optional(),
	modelExecutionTimeoutMs: z.number().optional(),
	executionFailureDiagnostic: taskLookupExecutionFailureDiagnosticSchema.optional(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
	result: taskLookupResultSchema.nullable(),
	errorMessage: z.string().nullable(),
	executions: z.array(
		z.object({
			phase: z.enum(["recall", "answer"]),
			elapsedMs: z.number(),
			inputTokens: z.number().optional(),
			outputTokens: z.number().optional(),
			cacheReadTokens: z.number().optional(),
			stablePromptPrefixSha256: z.string(),
			resolvedModelId: z.string().nullable(),
			requestedModelId: z.string().nullable().optional(),
			modelProviderId: z.string().optional(),
			cacheWriteTokens: z.number().optional(),
		}),
	),
});
export const taskLookupConversationSchema = z.object({
	schemaVersion: z.literal(1),
	conversationId: z.string().uuid(),
	contextWorkspaceId: z.string().min(1),
	title: z.string(),
	scope: taskLookupScopeSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
	revision: z.number().int(),
	turns: z.array(taskLookupTurnSchema),
});
export const createTaskLookupConversationRequestSchema = z.object({
	contextWorkspaceId: z.string().min(1),
	scope: taskLookupScopeSchema,
});
export const submitTaskLookupTurnRequestSchema = z.object({
	conversationId: z.string().uuid(),
	requestId: z.string().min(1).max(200),
	questionText: z.string().trim().min(1).max(100000),
	questionImages: z.array(runtimeTaskImageSchema).default([]),
	explicitlyRecoveredUnownedTurnId: z.string().optional(),
	scope: taskLookupScopeSchema.optional(),
});
export const taskLookupConversationIdentitySchema = z.object({ conversationId: z.string().uuid() });
export const taskLookupCandidatePreviewRequestSchema = taskLookupConversationIdentitySchema.extend({
	taskReference: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
});
export const taskLookupCandidatePreviewSchema = z.object({
	taskReference: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	projectName: z.string(),
	title: z.string(),
	prompt: z.string(),
	columnId: z.string(),
});
export type TaskLookupConversation = z.infer<typeof taskLookupConversationSchema>;
export type TaskLookupTurn = z.infer<typeof taskLookupTurnSchema>;
export type TaskLookupCandidate = z.infer<typeof taskLookupResultSchema>["candidates"][number];
export type TaskLookupScope = z.infer<typeof taskLookupScopeSchema>;
export type SubmitTaskLookupTurnRequest = z.input<typeof submitTaskLookupTurnRequestSchema>;
