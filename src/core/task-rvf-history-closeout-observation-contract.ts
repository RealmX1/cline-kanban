import { z } from "zod";

// 历史观察只做结构读取；嵌套扩展事实随原记录返回，不重新解释执行资格。

const fullGitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const rvfCloseoutGoalCompletionEvidenceReferenceSchema = z.looseObject({
	sourcePath: z.string(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	snapshotPath: z.string(),
});
export const rvfCloseoutGoalCompletedStageSchema = z.looseObject({
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
export const existingCloseoutGoalCompletionReconciliationSchema = z.looseObject({
	schema: z.literal("kanban-existing-closeout-goal-completion/v1"),
	binding: z.looseObject({
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
		z.looseObject({
			reasonCode: z.string(),
			reason: z.string(),
			recoveryCondition: z.string(),
			evidenceSourcePath: z.string().optional(),
		}),
	),
	observedAt: z.number(),
	observationSnapshot: z.looseObject({ path: z.string(), sha256: z.string() }).optional(),
	recovery: z.looseObject({
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
