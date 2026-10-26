import { z } from "zod";
import { existingCloseoutGoalCompletionReconciliationSchema } from "./task-rvf-history-closeout-observation-contract";
// 仅解析历史观察；不提供阶段资格或执行命令。未知字段原样保留。
export const historicalRvfCloseoutExecutionResultSchema = z.looseObject({
	outcome: z.enum(["completed", "blocked", "failed"]),
	commitSha: z.string().optional(),
	baseRef: z.string().optional(),
	reason: z.string().optional(),
	reportedAt: z.number().optional(),
	verificationBasis: z.string().optional(),
	supplementalLandCompletionEvidence: z.unknown().optional(),
	supplementalLandCompletionVerification: z.unknown().optional(),
});

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
	historicalCloseoutRecord: z.record(z.string(), z.unknown()).nullable().optional(),
	historicalRunSummary: z.record(z.string(), z.unknown()).nullable().optional(),
	landExecutionResult: historicalRvfCloseoutExecutionResultSchema.nullable(),
	baseBranchSyncExecutionResult: historicalRvfCloseoutExecutionResultSchema.nullable(),
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
