import { z } from "zod";

export const rvfReviewStartBoundaryRequestSchema = z.object({
	taskId: z.string().min(1),
	decisionToken: z.string().regex(/^[a-f0-9]{16}$/u),
});
export const rvfIndependentUserTurnBoundaryReceiptSchema = z.object({
	schema: z.literal("rvf-independent-user-turn-boundary/v1"),
	decision_token: z.string(),
	session_id: z.string(),
	worktree: z.string(),
	native_user_message_id: z.string(),
	native_turn_id: z.string(),
	transcript_path: z.string(),
	boundary_message_sha256: z.string(),
	candidate_fingerprint: z.string(),
	worktree_head_commit_sha: z.string(),
	checkpoint_commit: z.string(),
	checkpoint_tree: z.string(),
	comparison_base_tip: z.string().nullable(),
	comparison_base_ref: z.string().nullable(),
	comparison_base_ref_tip: z.string().nullable(),
	source: z.literal("rvf_automatic_decision_message"),
	kanban_task_id: z.string(),
	idempotency_key: z.string(),
});
export type RvfIndependentUserTurnBoundaryReceipt = z.infer<typeof rvfIndependentUserTurnBoundaryReceiptSchema>;
export const rvfReviewStartBoundaryResponseSchema = z.object({ receipt: rvfIndependentUserTurnBoundaryReceiptSchema });
export const rvfAutomaticCloseoutRecordSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	conversationSessionId: z.string(),
	receipt: rvfIndependentUserTurnBoundaryReceiptSchema,
	preReviewTurnIds: z.array(z.string()).min(1),
	status: z.enum([
		"awaiting_rvf_completion",
		"restoring_pre_review_conversation",
		"restored_pre_review_conversation",
		"submitting_closeout_prompt",
		"closeout_prompt_submitted",
		"completed",
		"paused",
	]),
	createdAt: z.number(),
	updatedAt: z.number(),
	runId: z.string().nullable(),
	runDirectory: z.string().nullable(),
	handoffPath: z.string().nullable(),
	handoffSha256: z.string().nullable(),
	restoredNativeSessionId: z.string().nullable(),
	restoredTranscriptPath: z.string().nullable(),
	restoreWorkspaceStateSha256: z.string().nullable(),
	nativeIdentitySwitchStartedAt: z.number().nullable(),
	nativeForkAttemptStartedAt: z.number().nullable(),
	activeCoordinatorOperationClaimId: z.string().nullable().optional(),
	pauseReason: z.string().nullable(),
	promptDeliveryIdempotencyKey: z.string(),
});
export type RvfAutomaticCloseoutRecord = z.infer<typeof rvfAutomaticCloseoutRecordSchema>;
export const rvfAutomaticCloseoutStatusRequestSchema = z.object({ taskId: z.string().min(1) });
export const rvfAutomaticCloseoutStatusResponseSchema = z.object({
	records: z.array(rvfAutomaticCloseoutRecordSchema),
});
