import { z } from "zod";

export const taskMainSessionHandoverDestinationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("new_codex_session"),
		contextInheritanceMode: z
			.enum(["fresh_context_with_handover_material", "fork_complete_native_conversation"])
			.optional(),
	}),
	z.object({ kind: z.literal("existing_codex_session"), taskConversationSessionId: z.string().min(1) }),
]);

export const taskMainSessionHandoverMaterialSchema = z.object({
	taskTitle: z.string(),
	taskPrompt: z.string(),
	sourceTaskConversationSessionId: z.string(),
	sourceAgentId: z.string(),
	sourceNativeConversationSessionId: z.string().nullable(),
	workspacePath: z.string(),
	currentWorkPhaseGoal: z.string().nullable(),
	planReferences: z.array(
		z.object({
			absolutePath: z.string(),
			approvalStatus: z.enum(["approved", "unconfirmed"]),
			evidenceDescription: z.string(),
		}),
	),
	embeddedPlanReferences: z
		.array(
			z.object({
				text: z.string(),
				sourceReference: z.string(),
				approvalStatus: z.literal("unconfirmed"),
			}),
		)
		.optional(),
	transcriptReferences: z.array(z.string()),
	lastAgentMessage: z.object({ text: z.string(), sourceReference: z.string() }).nullable(),
	workspaceGitStatus: z.string().nullable(),
	workspaceHeadCommit: z.string().nullable(),
	missingMaterialDescriptions: z.array(z.string()),
	userContextNotes: z.string(),
});
export type TaskMainSessionHandoverMaterial = z.infer<typeof taskMainSessionHandoverMaterialSchema>;

export const taskMainSessionHandoverRecoveryReceiptReferenceSchema = z.object({
	requestId: z.string().uuid(),
	replacedTargetTaskConversationSessionId: z.string().min(1),
	replacementTargetTaskConversationSessionId: z.string().min(1),
	previousReportDeliveryAttempt: z.number().int().nonnegative(),
	receiptFilePath: z.string().min(1),
	createdAt: z.number(),
});

export const taskMainSessionHandoverReportAcceptanceProbeSchema = z.object({
	nativeSessionId: z.string(),
	workingDirectoryPath: z.string(),
	transcriptPath: z.string().nullable(),
	codexConversationStorageHomeDirectoryPath: z.string(),
	nativeHistoryCursor: z.string().nullable(),
	transcriptHistoryCursor: z.string().nullable(),
	seenNativeHistoryCursors: z.array(z.string()),
	historicalAcceptanceEvidence: z
		.object({
			sourceReference: z.string(),
			observedAt: z.number(),
		})
		.nullable(),
});
export type TaskMainSessionHandoverReportAcceptanceProbe = z.infer<
	typeof taskMainSessionHandoverReportAcceptanceProbeSchema
>;

export const taskMainSessionHandoverAutomaticRecoverySchema = z.object({
	classification: z.enum(["waiting_for_machine_evidence", "execution_prohibited", "human_decision_required"]),
	stage: z.enum(["preparing_target_session", "confirming_report_acceptance"]),
	reason: z.string(),
	evidenceFingerprint: z.string(),
	attemptCount: z.number().int().nonnegative(),
	lastAttemptAt: z.number(),
	nextAttemptAt: z.number().nullable(),
	recheckCondition: z.string(),
});

// 正文写持久交接目录；卡片只保存小型控制记录，以免热路径反复广播整份 transcript。
export const taskMainSessionHandoverRecordSchema = z.object({
	handoverId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	targetTaskConversationSessionId: z.string(),
	destination: taskMainSessionHandoverDestinationSchema,
	status: z.enum([
		"waiting_for_sessions_to_stop",
		"report_delivery_pending",
		"awaiting_user_message",
		"failed",
		"cancelled",
		"completed",
	]),
	createdAt: z.number(),
	updatedAt: z.number(),
	userContextNotes: z.string(),
	additionalPlanReferencePaths: z.array(z.string()),
	materialDirectoryPath: z.string().nullable(),
	errorMessage: z.string().nullable(),
	// 在产生任何投递副作用之前持久化；崩溃后的不确定投递不自动重放。
	reportDeliveryStartedAt: z.number().nullable(),
	reportDeliveryAttempt: z.number().int().nonnegative().default(0),
	targetSessionStartupCompletedAt: z.number().optional(),
	recoveryReceipts: z.array(taskMainSessionHandoverRecoveryReceiptReferenceSchema).optional(),
	nativeForkPreparationReceiptPath: z.string().optional(),
	automaticRecovery: taskMainSessionHandoverAutomaticRecoverySchema.optional(),
	reportAcceptanceProbe: taskMainSessionHandoverReportAcceptanceProbeSchema.optional(),
	reportNativeIdentityCaptureBinding: z
		.object({
			runtimeSessionIncarnationId: z.string(),
			workingDirectoryPath: z.string(),
			codexConversationStorageHomeDirectoryPath: z.string(),
			preparedAt: z.number(),
		})
		.optional(),
	failureHistory: z.array(z.object({ occurredAt: z.number(), message: z.string() })).optional(),
});
export type TaskMainSessionHandoverRecord = z.infer<typeof taskMainSessionHandoverRecordSchema>;

export const taskMainSessionHandoverPrepareRequestSchema = z.object({ taskId: z.string().min(1) });
export const taskMainSessionHandoverRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedMainTaskConversationSessionId: z.string().min(1),
	requestId: z.string().uuid(),
	destination: taskMainSessionHandoverDestinationSchema,
	userContextNotes: z.string().default(""),
	additionalPlanReferencePaths: z.array(z.string().min(1)).default([]),
});
export type TaskMainSessionHandoverRequest = z.infer<typeof taskMainSessionHandoverRequestSchema>;

export const taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedHandoverId: z.string().min(1),
	expectedReportDeliveryAttempt: z.number().int().nonnegative(),
	requestId: z.string().uuid(),
	acknowledgePossibleDuplicateReport: z.literal(true),
});
export type TaskMainSessionHandoverRecoverWithNewCodexSessionRequest = z.infer<
	typeof taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema
>;

export const taskMainSessionHandoverRecoveryReceiptSchema =
	taskMainSessionHandoverRecoveryReceiptReferenceSchema.extend({
		taskId: z.string().min(1),
		previousHandoverRecord: taskMainSessionHandoverRecordSchema,
	});

export const taskMainSessionHandoverPrepareResponseSchema = z.object({
	material: taskMainSessionHandoverMaterialSchema,
	mainTaskConversationSessionId: z.string(),
	codexPeerTaskConversationSessionIds: z.array(z.string()),
	busyTaskConversationSessionIds: z.array(z.string()),
	completeNativeConversationForkAvailability: z
		.object({
			available: z.boolean(),
			unavailableReason: z.string().nullable(),
		})
		.optional(),
});
export type TaskMainSessionHandoverPrepareResponse = z.infer<typeof taskMainSessionHandoverPrepareResponseSchema>;

export const taskMainSessionHandoverStatusResponseSchema = z.object({
	record: taskMainSessionHandoverRecordSchema.nullable(),
	recoveryAvailability: z
		.object({
			canRetryUndeliveredReport: z.boolean(),
			canRecreateCodexSession: z.boolean(),
			terminalDeliveryFailureReason: z.string().nullable(),
			blockReason: z.string().nullable(),
		})
		.optional(),
});
export type TaskMainSessionHandoverStatusResponse = z.infer<typeof taskMainSessionHandoverStatusResponseSchema>;

export function isTaskMainSessionHandoverSuspendingAutomaticActions(card: {
	taskMainSessionHandover?: TaskMainSessionHandoverRecord;
}): boolean {
	const status = card.taskMainSessionHandover?.status;
	return (
		status === "waiting_for_sessions_to_stop" ||
		status === "report_delivery_pending" ||
		status === "awaiting_user_message" ||
		status === "failed"
	);
}
