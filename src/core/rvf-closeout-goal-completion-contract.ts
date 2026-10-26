import { z } from "zod";

const fullGitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const rvfCloseoutGoalCompletionEvidenceReferenceSchema = z.object({
	sourcePath: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	snapshotPath: z.string(),
});
export const rvfCloseoutGoalCompletedStageSchema = z.object({
	stage: z.enum(["land", "base_branch_sync"]),
	commitSha: fullGitObjectIdSchema,
	treeSha: fullGitObjectIdSchema.optional(),
	parentCommitShas: z.array(fullGitObjectIdSchema).optional(),
	baseRef: z.string().optional(),
	landCommitSha: fullGitObjectIdSchema.optional(),
	source: z.enum([
		"server_accepted_stage_result",
		"immutable_execution_result",
		"verified_supplemental_completion",
		"historical_manual_execution",
		"independent_backup_route",
		"observed_local_base_ancestry",
	]),
	evidenceSha256s: z.array(z.string()),
	observedAt: z.number(),
});
export const existingCloseoutGoalCompletionReconciliationSchema = z.object({
	schema: z.literal("kanban-existing-closeout-goal-completion/v1"),
	binding: z.object({
		workspaceId: z.string(),
		taskId: z.string(),
		decisionToken: z.string(),
		runId: z.string(),
		runDirectory: z.string(),
		handoffSha256: z.string(),
		receiptSha256: z.string(),
		worktreeRealpath: z.string().optional(),
		gitCommonDirectoryRealpath: z.string().optional(),
	}),
	verdict: z.enum(["completed", "partially_completed", "externally_consumed", "machine_waiting", "evidence_conflict"]),
	verifiedStages: z.array(rvfCloseoutGoalCompletedStageSchema),
	externalConsumption: z
		.object({ operationId: z.string(), evidenceSha256: z.string(), observedAt: z.number() })
		.optional(),
	evidenceReferences: z.array(rvfCloseoutGoalCompletionEvidenceReferenceSchema),
	verificationGaps: z.array(
		z.object({
			reasonCode: z.string(),
			reason: z.string(),
			recoveryCondition: z.string(),
			evidenceSourcePath: z.string().optional(),
		}),
	),
	observedAt: z.number(),
	observationSnapshot: z.object({ path: z.string(), sha256: z.string() }).optional(),
	recovery: z.object({
		fingerprint: z.string(),
		verificationAttemptCount: z.number().int().min(0).max(3),
		nextVerificationAtMs: z.number(),
		nextCapabilityProbeAtMs: z.number(),
		discoveryAfterPath: z.string().nullable(),
		discoveryComplete: z.boolean(),
		discoveredTargetCommitShas: z.array(fullGitObjectIdSchema).optional(),
		evidenceDependencyPaths: z.array(z.string()).optional(),
	}),
});
export type ExistingCloseoutGoalCompletionReconciliation = z.infer<
	typeof existingCloseoutGoalCompletionReconciliationSchema
>;
export type RvfCloseoutGoalCompletedStage = z.infer<typeof rvfCloseoutGoalCompletedStageSchema>;
export const rvfCloseoutSuppressedDeliveryReconciliationSchema = z.object({
	entries: z.array(
		z.object({
			conversationSessionId: z.string(),
			idempotencyKey: z.string(),
			outcome: z.enum(["cancelled", "already_terminal", "transport_started_or_unknown", "retry_pending"]),
			reason: z.string().optional(),
			attemptCount: z.number().int().nonnegative(),
			nextAttemptAtMs: z.number(),
			observedAt: z.number(),
		}),
	),
});
