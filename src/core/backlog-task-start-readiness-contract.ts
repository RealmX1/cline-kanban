import { z } from "zod";

export const backlogTaskCreationRepositoryBaselineSchema = z.object({
	workspaceId: z.string().min(1),
	repositoryPath: z.string().min(1),
	gitCommonDirectoryPath: z.string().nullable(),
	baseRef: z.string().min(1),
	commit: z
		.string()
		.regex(/^[0-9a-f]{40,64}$/)
		.nullable(),
	capturedAtEpochMs: z.number(),
	unavailableReason: z.string().nullable(),
});
export type BacklogTaskCreationRepositoryBaseline = z.infer<typeof backlogTaskCreationRepositoryBaselineSchema>;

export const backlogTaskStartReadinessConclusionSchema = z.enum([
	"ready",
	"revise_remaining_work",
	"conditions_not_met",
	"no_remaining_work",
	"human_decision_required",
	"waiting_for_evidence",
]);
export const backlogTaskStartReadinessReviewSchema = z.object({
	operationId: z.string().uuid(),
	phase: z.enum([
		"reviewing",
		"waiting_for_evidence",
		"conditions_not_met",
		"no_remaining_work",
		"human_decision_required",
		"ready",
		"launching",
		"started",
		"start_failed",
		"stopped",
		"invalidated",
	]),
	summary: z.string(),
	updatedAtEpochMs: z.number(),
});
export type BacklogTaskStartReadinessReview = z.infer<typeof backlogTaskStartReadinessReviewSchema>;

export const backlogTaskStartReadinessAssessmentRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().optional(),
});

export const backlogTaskStartReadinessDecisionSchema = z.object({
	conclusion: backlogTaskStartReadinessConclusionSchema,
	summary: z.string().min(1).max(4000),
	evidenceReferences: z.array(z.string().min(1)).max(40),
	remainingWorkRevision: z
		.object({
			title: z.string().min(1).max(80).optional(),
			taskDescription: z.string().max(4000).optional(),
			currentExecutionInstructions: z.string().min(1).max(16000),
		})
		.nullable(),
	readOnlyEvidenceRequests: z
		.array(
			z.object({
				kind: z.enum(["read_repository_file", "search_repository", "read_task", "read_task_git_changes"]),
				reference: z.string().min(1).max(500),
			}),
		)
		.max(6)
		.default([]),
});
export type BacklogTaskStartReadinessDecision = z.infer<typeof backlogTaskStartReadinessDecisionSchema>;

export const backlogTaskStartReadinessReportSchema = z.object({
	operationId: z.string().uuid(),
	workspaceId: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	assessedAtEpochMs: z.number(),
	taskFingerprint: z.string(),
	repositoryFingerprint: z.string(),
	evidence: z.record(z.string(), z.unknown()),
	decision: backlogTaskStartReadinessDecisionSchema,
	previousTaskContent: z.object({
		title: z.string().optional(),
		taskDescription: z.string().optional(),
		prompt: z.string(),
	}),
});
export type BacklogTaskStartReadinessReport = z.infer<typeof backlogTaskStartReadinessReportSchema>;
export const backlogTaskStartReadinessAssessmentResponseSchema = z.object({
	review: backlogTaskStartReadinessReviewSchema,
	report: backlogTaskStartReadinessReportSchema.nullable(),
});
