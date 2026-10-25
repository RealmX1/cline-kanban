import { z } from "zod";
import { reviewStartBoundaryCaptureDiagnosticSchema } from "../rvf-automatic-closeout/review-start-boundary-capture-diagnostic";

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
	// 原生自动回退凭据的文件身份签名；普通 RVF 使用独立的候选内容快照。
	candidate_filesystem_state_sha256: z.string().optional(),
	worktree_head_commit_sha: z.string(),
	checkpoint_commit: z.string(),
	checkpoint_tree: z.string(),
	comparison_base_tip: z.string().nullable(),
	comparison_base_ref: z.string().nullable(),
	comparison_base_ref_tip: z.string().nullable(),
	source: z.enum(["rvf_automatic_decision_message", "explicit_user_command"]),
	kanban_task_id: z.string(),
	idempotency_key: z.string(),
});
export type RvfIndependentUserTurnBoundaryReceipt = z.infer<typeof rvfIndependentUserTurnBoundaryReceiptSchema>;
export const rvfReviewStartBoundaryResponseSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("captured"), receipt: rvfIndependentUserTurnBoundaryReceiptSchema }),
	reviewStartBoundaryCaptureDiagnosticSchema,
]);
export const rvfAutomaticCloseoutRunBindingActivationRequestSchema = rvfReviewStartBoundaryRequestSchema;
export const rvfAutomaticCloseoutRunBindingActivationResponseSchema = z.object({
	receipt: rvfIndependentUserTurnBoundaryReceiptSchema,
	automaticCloseoutActivationStatus: z.enum(["skipped_no_completed_pre_review_conversation_prefix"]).optional(),
});
export const rvfAutomaticCloseoutWaitingReasonCodeSchema = z.enum([
	"automatic_closeout_precondition_not_ready",
	"main_conversation_session_summary_unavailable",
	"main_conversation_workspace_unavailable",
	"native_session_identity_not_yet_observed",
	"main_session_handover_in_progress",
	"agent_turn_not_ready_for_closeout",
	"pending_user_decision",
	"queued_programmatic_message",
	"terminal_input_box_not_confirmed_empty",
	"closeout_delivery_confirmation_pending",
]);
export type RvfAutomaticCloseoutWaitingReasonCode = z.infer<typeof rvfAutomaticCloseoutWaitingReasonCodeSchema>;
export const rvfAutomaticCloseoutExecutionStageResultSchema = z.object({
	outcome: z.enum(["completed", "blocked", "failed"]),
	commitSha: z
		.string()
		.regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
		.optional(),
	baseRef: z.string().min(1).optional(),
	reason: z.string().trim().min(1).optional(),
	blockedReasonKind: z
		.enum(["user_restriction", "machine_precondition", "evidence_conflict", "agent_assessed_not_ready_for_base_sync"])
		.optional(),
	baseBranchSyncReassessmentCondition: z.string().trim().min(1).optional(),
	reportedAt: z.number(),
});
export const rvfAutomaticCloseoutExecutionResultReportRequestSchema = rvfReviewStartBoundaryRequestSchema
	.extend({
		runId: z.string().min(1),
		handoffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
		stage: z.enum(["land", "base_branch_sync"]),
	})
	.extend(rvfAutomaticCloseoutExecutionStageResultSchema.omit({ reportedAt: true }).shape)
	.superRefine((value, context) => {
		if (
			value.blockedReasonKind === "agent_assessed_not_ready_for_base_sync" &&
			(value.stage !== "base_branch_sync" ||
				value.outcome !== "blocked" ||
				!value.baseBranchSyncReassessmentCondition)
		) {
			context.addIssue({
				code: "custom",
				message: "Agent 暂缓仅用于 base 同步的 blocked 结果，且必须提供重新评估条件。",
			});
		}
		if (value.outcome === "completed" && (!value.commitSha || (value.stage === "base_branch_sync" && !value.baseRef)))
			context.addIssue({ code: "custom", message: "完成结果必须提供真实提交；base 同步还须提供本地 base ref。" });
		if (value.outcome !== "completed" && !value.reason)
			context.addIssue({ code: "custom", message: "受阻或失败必须提供具体原因。" });
	});
export type RvfAutomaticCloseoutExecutionResultReportRequest = z.infer<
	typeof rvfAutomaticCloseoutExecutionResultReportRequestSchema
>;
export const rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema = rvfReviewStartBoundaryRequestSchema.extend({
	runId: z.string().min(1),
	handoffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	dryRun: z.boolean().default(false),
});
export const rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema = z.object({
	schema: z.literal("rvf-late-native-closeout-prompt-acceptance-recovery/v1"),
	workspaceId: z.string(),
	taskId: z.string(),
	conversationSessionId: z.string(),
	decisionToken: z.string(),
	runId: z.string(),
	handoffSha256: z.string(),
	promptDeliveryIdempotencyKey: z.string(),
	nativeSessionId: z.string(),
	nativeTurnId: z.string(),
	nativeUserMessageId: z.string(),
	nativeTurnStartedAt: z.string().datetime(),
	nativeUserMessageRecordedAt: z.string().datetime(),
	transcriptPath: z.string(),
	transcriptSha256: z.string(),
	transcriptByteLength: z.number().int().nonnegative(),
	promptSha256: z.string(),
	runtimeSessionIncarnationId: z.string(),
	observedAt: z.number(),
	previousPauseReason: z.string(),
	previousPauseUpdatedAt: z.number(),
	originalDeliveryFailure: z.object({
		taskId: z.string(),
		attemptId: z.string().optional(),
		source: z.literal("rvf_automatic_closeout"),
		idempotencyKey: z.string(),
		promptSha256: z.string(),
		messageId: z.string(),
		status: z.literal("delivery_failed"),
		failureReason: z.literal("submit_confirmation_budget_exhausted"),
		createdAt: z.string().datetime(),
		statusUpdatedAt: z.string().datetime(),
	}),
});
export type RvfLateNativeCloseoutPromptAcceptanceRecoveryReceipt = z.infer<
	typeof rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema
>;
export const rvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCodeSchema = z.enum([
	"native_prompt_acceptance_verified",
	"binding_mismatch",
	"pause_reason_not_eligible",
	"explicit_stop",
	"session_binding_changed",
	"completion_evidence_unavailable",
	"delivery_failure_not_eligible",
	"native_control_unavailable",
	"native_prompt_acceptance_not_proven",
	"native_message_not_on_active_branch",
	"record_operation_busy",
	"record_changed",
]);
export type RvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCode = z.infer<
	typeof rvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCodeSchema
>;
export const rvfAutomaticCloseoutRecordSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	conversationSessionId: z.string(),
	receipt: rvfIndependentUserTurnBoundaryReceiptSchema,
	preReviewTurnIds: z.array(z.string()),
	automaticCloseoutIneligibleReason: z.literal("no_completed_pre_review_conversation_prefix").optional(),
	status: z.enum([
		"captured_review_start_boundary",
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
	explicitStopRequestedAt: z.number().optional(),
	waitingReasonCode: rvfAutomaticCloseoutWaitingReasonCodeSchema.nullable().optional(),
	waitingReason: z.string().nullable().optional(),
	waitingSince: z.number().nullable().optional(),
	waitingNotificationSentAt: z.number().nullable().optional(),
	landExecutionResult: rvfAutomaticCloseoutExecutionStageResultSchema.optional(),
	baseBranchSyncExecutionResult: rvfAutomaticCloseoutExecutionStageResultSchema.optional(),
	executionResultReportHistory: z
		.array(rvfAutomaticCloseoutExecutionStageResultSchema.extend({ stage: z.enum(["land", "base_branch_sync"]) }))
		.optional(),
	lateNativePromptAcceptanceRecoveryReceipt: rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema.optional(),
	promptDeliveryIdempotencyKey: z.string(),
});
export type RvfAutomaticCloseoutRecord = z.infer<typeof rvfAutomaticCloseoutRecordSchema>;
export const rvfLateNativeCloseoutPromptAcceptanceRecoveryResponseSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.enum(["eligible", "recovered", "already_recovered"]),
		reasonCode: z.literal("native_prompt_acceptance_verified"),
		record: rvfAutomaticCloseoutRecordSchema,
		receipt: rvfLateNativeCloseoutPromptAcceptanceRecoveryReceiptSchema,
	}),
	z.object({
		status: z.enum(["unknown", "blocked"]),
		reasonCode: rvfLateNativeCloseoutPromptAcceptanceRecoveryReasonCodeSchema,
		reason: z.string(),
	}),
]);
export type RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse = z.infer<
	typeof rvfLateNativeCloseoutPromptAcceptanceRecoveryResponseSchema
>;
export const rvfAutomaticCloseoutExecutionResultReportResponseSchema = z.object({
	record: rvfAutomaticCloseoutRecordSchema,
});
export const rvfAutomaticCloseoutStatusRequestSchema = z.object({ taskId: z.string().min(1) });
export const rvfAutomaticCloseoutStatusResponseSchema = z.object({
	records: z.array(rvfAutomaticCloseoutRecordSchema),
});

export const rvfReviewStartBoundaryObservationRequestSchema = z.object({
	taskId: z.string().min(1),
	idempotencyKey: z.string().regex(/^rvf-decision-point-[a-f0-9]{16}$/u),
	requestNonce: z.string().min(1).max(256),
});
export const rvfReviewStartBoundaryObservationResponseSchema = z.object({
	independent_user_turn_boundary_receipt: rvfIndependentUserTurnBoundaryReceiptSchema.optional(),
	review_start_boundary_active_branch_observation: z
		.object({
			request_nonce: z.string(),
			kanban_task_id: z.string(),
			idempotency_key: z.string(),
			session_id: z.string(),
			native_active_branch_user_message_ids: z.array(z.string()),
			native_active_branch_user_turn_id: z.string(),
		})
		.optional(),
	review_start_boundary_pending_reason: z.string().optional(),
	reason_code: reviewStartBoundaryCaptureDiagnosticSchema.shape.reason_code.optional(),
	recovery_action: reviewStartBoundaryCaptureDiagnosticSchema.shape.recovery_action.optional(),
});
