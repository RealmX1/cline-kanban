import { z } from "zod";

export const rvfCloseoutExecutionStageSchema = z.enum(["land", "base_branch_sync"]);
export const rvfCloseoutBlockedReasonKindSchema = z.enum([
	"user_restriction",
	"machine_precondition",
	"evidence_conflict",
	"agent_assessed_not_ready_for_base_sync",
]);
export const rvfCloseoutSkillEvidenceReferenceSchema = z.object({
	schema: z.literal("rvf-closeout-skill-attachment-evidence/v1"),
	snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	phase: z.enum(["expected_installation", "accepted_native_expansion", "historical_installation"]),
	promptDeliveryIdempotencyKey: z.string(),
	capturedAt: z.number(),
});
export type RvfCloseoutSkillEvidenceReference = z.infer<typeof rvfCloseoutSkillEvidenceReferenceSchema>;
export const rvfCloseoutSkillSnapshotSchema = z.object({
	schema: z.literal("rvf-closeout-skill-attachment-snapshot/v1"),
	workspaceId: z.string(),
	taskId: z.string(),
	decisionToken: z.string(),
	runId: z.string(),
	handoffSha256: z.string(),
	promptDeliveryIdempotencyKey: z.string(),
	promptSha256: z.string(),
	phase: rvfCloseoutSkillEvidenceReferenceSchema.shape.phase,
	capturedAt: z.number(),
	nativeSessionId: z.string().optional(),
	nativeTurnId: z.string().optional(),
	nativeMessageId: z.string().optional(),
	nativeMessageRecordedAt: z.string().optional(),
	transcriptSha256: z.string().optional(),
	transcriptByteLength: z.number().optional(),
	skills: z.array(
		z.object({
			referenceName: z.string(),
			referencePath: z.string(),
			canonicalName: z.string(),
			canonicalPath: z.string(),
			realPath: z.string(),
			instructionText: z.string(),
			expansionText: z.string().optional(),
		}),
	),
});
export type RvfCloseoutSkillSnapshot = z.infer<typeof rvfCloseoutSkillSnapshotSchema>;
export const rvfCloseoutDeliveryAttemptSchema = z.object({
	deliveryAttemptId: z.string(),
	idempotencyKey: z.string(),
	promptSha256: z.string(),
	promptText: z.string(),
	purpose: z.enum(["inspect_existing_state", "execute_remaining_stages"]),
	executionRequiresReadOnlyInspection: z.boolean().optional(),
	sourcePromptDeliveryIdempotencyKey: z.string(),
	nativeSessionId: z.string(),
	conversationSessionId: z.string(),
	createdAt: z.number(),
	status: z.enum(["prepared", "enqueued", "confirmed", "failed"]),
	observationBudget: z
		.object({ fingerprint: z.string(), count: z.number().int().min(0).max(3), nextAttemptAtMs: z.number() })
		.optional(),
});
export type RvfCloseoutDeliveryAttempt = z.infer<typeof rvfCloseoutDeliveryAttemptSchema>;
export const rvfCloseoutRecoveryProgressSchema = z.object({
	kind: z.enum(["machine_waiting", "explicitly_stopped", "human_decision_pending", "settled"]),
	reasonCode: z.string(),
	nextAutomaticAction: z.enum([
		"verify_existing_execution",
		"collect_native_acceptance_evidence",
		"restore_same_native_session",
		"enqueue_reconciliation_attempt",
		"await_changed_evidence",
		"none",
	]),
	evidenceFingerprint: z.string(),
	verificationAttemptCount: z.number().int().min(0).max(3),
	nextVerificationAtMs: z.number(),
	// 原接受核验结论独立于输入框等临时门禁的展示原因，避免等待覆盖恢复资格。
	nativePromptAcceptanceVerificationReasonCode: z.string().optional(),
	nativeSessionRestoreAttempted: z.boolean().optional(),
	nativeSessionRestoreAttemptCount: z.number().int().min(0).max(3).optional(),
	nextNativeSessionRestoreAttemptAtMs: z.number().optional(),
	continuationPreparationEvidenceFingerprint: z.string().optional(),
	continuationPreparationObservationBudget: z
		.object({ fingerprint: z.string(), count: z.number().int().min(0).max(3), nextAttemptAtMs: z.number() })
		.optional(),
});
export const rvfCloseoutStageExecutionClaimSchema = z.object({
	stageExecutionClaimId: z.string(),
	stage: rvfCloseoutExecutionStageSchema,
	deliveryAttemptId: z.string(),
	nativeSessionId: z.string(),
	runtimeSessionIncarnationId: z.string(),
	claimedAt: z.number(),
	status: z.enum(["claimed", "completed", "released"]),
});
export const rvfCloseoutStageClaimRequestSchema = z.object({
	taskId: z.string().min(1),
	decisionToken: z.string().regex(/^[a-f0-9]{16}$/u),
	runId: z.string().min(1),
	handoffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	stage: rvfCloseoutExecutionStageSchema,
	deliveryAttemptId: z.string().optional(),
});
export const rvfCloseoutStageClaimResponseSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("claimed"), claim: rvfCloseoutStageExecutionClaimSchema }),
	z.object({ status: z.literal("already_completed"), commitSha: z.string() }),
	z.object({ status: z.enum(["waiting", "blocked"]), reason: z.string() }),
]);

export const rvfCloseoutSkillInstallationVersionReferenceSchema = z.object({
	runId: z.string(),
	handoffSha256: z.string(),
	promptDeliveryIdempotencyKey: z.string(),
	promptSha256: z.string(),
	referenceName: z.string(),
	referencePath: z.string(),
	canonicalName: z.string(),
	canonicalPath: z.string(),
	realPath: z.string(),
	instructionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	capturedAt: z.number(),
	gitVersion: z
		.object({
			repositoryPath: z.string(),
			commitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
			relativePath: z.string(),
		})
		.optional(),
});
export type RvfCloseoutSkillInstallationVersionReference = z.infer<
	typeof rvfCloseoutSkillInstallationVersionReferenceSchema
>;
