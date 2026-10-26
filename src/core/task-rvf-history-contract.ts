import { z } from "zod";
import { rvfAutomaticCloseoutExecutionStageResultSchema } from "./rvf-automatic-closeout-contract";
import { existingCloseoutGoalCompletionReconciliationSchema } from "./rvf-closeout-goal-completion-contract";

export const taskRvfHistoryRequestSchema = z.object({
	taskId: z.string().trim().min(1),
	limit: z.number().int().min(1).max(50).default(10),
	cursor: z.string().max(8192).nullable().optional(),
});
export const taskRvfHistoryIssueSchema = z.object({
	reasonCode: z.string(),
	reason: z.string(),
	recoveryCondition: z.string(),
	occurrenceCount: z.number().int().positive().optional(),
});
export const taskRvfCurrentCandidateCoverageSchema = z.object({
	status: z.enum(["covered", "not_covered", "unknown"]),
	reasonCode: z.string(),
	verifiedByRunId: z.string().nullable().default(null),
	currentCandidateContentManifestSha256: z.string().nullable().default(null),
	recoveryCondition: z.string().nullable().default(null),
});
export const taskRvfHistoryRunSchema = z.object({
	runId: z.string().nullable(),
	runDirectory: z.string(),
	decisionToken: z.string().nullable(),
	sessionId: z.string().nullable(),
	startedAt: z.number().nullable(),
	completedAt: z.number().nullable(),
	completionStatus: z.enum(["completed", "advisory", "in_progress", "failed", "cancelled", "unknown"]),
	completionEvidenceSource: z.string().nullable(),
	recordedFinalizationKind: z.string().nullable(),
	handoffPath: z.string().nullable(),
	handoffSha256: z.string().nullable(),
	reviewedCandidateContentManifestSha256: z.string().nullable(),
	reasonCode: z.string(),
	reason: z.string().nullable(),
	recoveryCondition: z.string().nullable(),
	currentCandidateReviewCoverage: taskRvfCurrentCandidateCoverageSchema,
	automaticCloseoutStatus: z.string().nullable(),
	landExecutionResult: rvfAutomaticCloseoutExecutionStageResultSchema.nullable(),
	baseBranchSyncExecutionResult: rvfAutomaticCloseoutExecutionStageResultSchema.nullable(),
	existingCloseoutGoalCompletionReconciliation: existingCloseoutGoalCompletionReconciliationSchema.optional(),
});
export const taskRvfHistoryResponseSchema = z.object({
	schemaVersion: z.literal("kanban-task-rvf-history/v1"),
	workspaceId: z.string(),
	taskId: z.string(),
	queriedAt: z.number(),
	querySource: z.enum(["runtime", "durable_filesystem_fallback"]),
	discoveryStatus: z.enum(["complete", "partial"]),
	hasVerifiedCompletedRvf: z.boolean().nullable(),
	mostRecentVerifiedCompletedRun: taskRvfHistoryRunSchema.nullable(),
	currentCandidateReviewCoverage: taskRvfCurrentCandidateCoverageSchema,
	recentRuns: z.array(taskRvfHistoryRunSchema),
	nextCursor: z.string().nullable(),
	issues: z.array(taskRvfHistoryIssueSchema),
});
export type TaskRvfHistoryRequest = z.input<typeof taskRvfHistoryRequestSchema>;
export type TaskRvfHistoryResponse = z.infer<typeof taskRvfHistoryResponseSchema>;
export type TaskRvfHistoryRun = z.infer<typeof taskRvfHistoryRunSchema>;
export type TaskRvfHistoryIssue = z.infer<typeof taskRvfHistoryIssueSchema>;
