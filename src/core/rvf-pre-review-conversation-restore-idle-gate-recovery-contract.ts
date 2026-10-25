import { z } from "zod";

export const rvfPreReviewConversationRestoreIdleGateBlockerSchema = z.enum([
	"process_liveness_not_ready",
	"turn_owner_not_user",
	"user_turn_kind_not_review",
	"current_process_prompt_acceptance_unconfirmed",
	"background_work_parked",
	"programmatic_delivery_in_flight",
]);
export type RvfPreReviewConversationRestoreIdleGateBlocker = z.infer<
	typeof rvfPreReviewConversationRestoreIdleGateBlockerSchema
>;

// 恢复资格与原始接受账本相互独立；重复补证不产生新的活动或回合。
export const rvfPreReviewConversationRestoreIdleGateRecoverySchema = z.object({
	status: z.enum([
		"waiting_for_runtime_conditions",
		"querying_native_evidence",
		"waiting_for_retry",
		"waiting_for_evidence_change",
		"qualified",
	]),
	blockingConditions: z.array(rvfPreReviewConversationRestoreIdleGateBlockerSchema),
	evidenceFingerprint: z.string(),
	identity: z.object({
		workspaceId: z.string(),
		conversationSessionId: z.string(),
		runtimeSessionIncarnationId: z.string().nullable(),
		nativeSessionId: z.string(),
		controlSocketPath: z.string().nullable(),
	}),
	evidenceSources: z.array(z.enum(["runtime_summary", "native_control_host", "native_transcript", "delivery_ledger"])),
	attemptCount: z.number().int().min(0).max(3),
	lastAttemptAtMs: z.number().nullable(),
	nextProbeAtMs: z.number().nullable(),
	lastNativeHealthFingerprint: z.string().nullable(),
	lastFailureCode: z.string().nullable(),
	failedNativeConversationTurnHistoryPageRead: z
		.object({
			cursor: z.string().nullable(),
			failedAtMs: z.number(),
			lastCapabilityProbeAtMs: z.number().nullable(),
			lastCapabilityProbeStatus: z.enum(["unavailable", "ready"]).nullable(),
		})
		.nullable()
		.optional(),
	resumeCondition: z.enum([
		"runtime_guards_clear",
		"retry_deadline",
		"identity_submission_transcript_or_endpoint_changes",
	]),
	qualification: z
		.object({
			observedAtMs: z.number(),
			nativeCompletedTurnId: z.string(),
			acceptedNativeUserMessageId: z.string(),
			acceptedNativeTurnId: z.string(),
			acceptedPromptSha256: z.string(),
			acceptedMessageRecordedAtMs: z.number(),
			transcriptSha256: z.string(),
		})
		.nullable(),
});
export type RvfPreReviewConversationRestoreIdleGateRecovery = z.infer<
	typeof rvfPreReviewConversationRestoreIdleGateRecoverySchema
>;
