import { z } from "zod";

export const taskMainSessionHandoverAgentIdSchema = z.enum([
	"claude",
	"codex",
	"cursor",
	"droid",
	"kiro",
	"kimi",
	"omp",
]);
export type TaskMainSessionHandoverAgentId = z.infer<typeof taskMainSessionHandoverAgentIdSchema>;
export const taskMainSessionHandoverExistingPeerAgentIdSchema = z.enum(["claude", "codex", "cursor", "kimi", "omp"]);
const contextInheritanceModeSchema = z.enum([
	"fresh_context_with_handover_material",
	"fork_complete_native_conversation",
]);

export const taskMainSessionHandoverDestinationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("new_agent_session"),
		agentId: taskMainSessionHandoverAgentIdSchema,
		contextInheritanceMode: contextInheritanceModeSchema.optional(),
	}),
	z.object({
		kind: z.literal("new_codex_session"),
		contextInheritanceMode: z
			.enum(["fresh_context_with_handover_material", "fork_complete_native_conversation"])
			.optional(),
	}),
	z.object({ kind: z.literal("existing_codex_session"), taskConversationSessionId: z.string().min(1) }),
	z.object({
		kind: z.literal("existing_agent_session"),
		agentId: taskMainSessionHandoverExistingPeerAgentIdSchema,
		taskConversationSessionId: z.string().min(1),
	}),
]);

export type TaskMainSessionHandoverDestination = z.infer<typeof taskMainSessionHandoverDestinationSchema>;
export function resolveTaskMainSessionHandoverTargetAgentId(
	destination: TaskMainSessionHandoverDestination,
): TaskMainSessionHandoverAgentId {
	return destination.kind === "new_agent_session" || destination.kind === "existing_agent_session"
		? destination.agentId
		: "codex";
}
export function isTaskMainSessionHandoverExistingTarget(
	destination: TaskMainSessionHandoverDestination,
): destination is Extract<TaskMainSessionHandoverDestination, { taskConversationSessionId: string }> {
	return destination.kind === "existing_codex_session" || destination.kind === "existing_agent_session";
}
export function isTaskMainSessionHandoverNativeForkRequested(destination: TaskMainSessionHandoverDestination): boolean {
	return (
		!isTaskMainSessionHandoverExistingTarget(destination) &&
		destination.contextInheritanceMode === "fork_complete_native_conversation"
	);
}

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
	userIntentContext: z
		.object({
			providerName: z.string(),
			providerAvailability: z.enum(["available", "unavailable"]),
			asOf: z.number(),
			workUnitReference: z.object({
				workspaceId: z.string(),
				taskId: z.string(),
				taskIncarnationCreatedAtEpochMs: z.number(),
			}),
			conversationSessionReferences: z.array(
				z.object({
					taskConversationSessionId: z.string(),
					agentId: z.string().nullable(),
					nativeConversationSessionId: z.string().nullable(),
				}),
			),
			userIntentContextText: z.string().nullable(),
			sourceReferences: z.array(z.string()),
			missingContextParts: z.array(z.string()),
		})
		.optional(),
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
	targetAgentId: taskMainSessionHandoverAgentIdSchema.optional(),
	nativeSessionId: z.string(),
	workingDirectoryPath: z.string(),
	transcriptPath: z.string().nullable(),
	codexConversationStorageHomeDirectoryPath: z.string().optional(),
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

export const taskMainSessionHandoverExistingTargetBindingSchema = z.object({
	workspaceId: z.string().min(1),
	workspaceTaskId: z.string().min(1),
	taskConversationSessionId: z.string().min(1),
	agentId: taskMainSessionHandoverExistingPeerAgentIdSchema,
	nativeSessionId: z.string().min(1),
	workingDirectoryPath: z.string().min(1),
	sessionTransport: z.enum(["pty_terminal", "acp_stdio_subprocess"]),
	// 加性可选，兼容尚未冻结会话模式的旧绑定；新绑定显式保存缺省 operational。
	taskConversationMode: z.enum(["operational", "exploratory"]).optional(),
	// 保存完整 JSON 快照，避免与 api-contract 的启动设置 schema 形成运行时循环依赖。
	launchSettingsSnapshot: z.record(z.string(), z.unknown()).nullable(),
	codexConversationStorageHomeDirectoryPath: z.string().optional(),
});
export type TaskMainSessionHandoverExistingTargetBinding = z.infer<
	typeof taskMainSessionHandoverExistingTargetBindingSchema
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
	reportAcceptanceScanPendingContinuation: z.boolean().optional(),
	reportAcceptanceScanVisitedCursorPairs: z.array(z.string()).optional(),
});

// 正文写持久交接目录；卡片只保存小型控制记录，以免热路径反复广播整份 transcript。
export const taskMainSessionHandoverRecordSchema = z.object({
	handoverId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	targetTaskConversationSessionId: z.string(),
	destination: taskMainSessionHandoverDestinationSchema,
	existingTargetSessionBinding: taskMainSessionHandoverExistingTargetBindingSchema.optional(),
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
	inputAwaitingCorrelatedProcessingHook: z
		.object({
			promptSha256: z.string(),
			inputKind: z.enum(["handover_report", "human_followup"]),
			runtimeSessionIncarnationId: z.string(),
			submittedAt: z.number(),
			submittedHookEventId: z.string(),
		})
		.optional(),
	reportCorrelatedProcessingAcceptanceEvidence: z
		.object({
			promptSha256: z.string(),
			runtimeSessionIncarnationId: z.string(),
			submittedHookEventId: z.string(),
			processingHookEventId: z.string(),
			observedAt: z.number(),
		})
		.optional(),
	reportNativeIdentityCaptureBinding: z
		.object({
			targetAgentId: taskMainSessionHandoverAgentIdSchema.optional(),
			runtimeSessionIncarnationId: z.string(),
			workingDirectoryPath: z.string(),
			codexConversationStorageHomeDirectoryPath: z.string().optional(),
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

export const taskMainSessionHandoverRecoverWithNewAgentSessionRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedHandoverId: z.string().min(1),
	expectedReportDeliveryAttempt: z.number().int().nonnegative(),
	requestId: z.string().uuid(),
	acknowledgePossibleDuplicateReport: z.literal(true),
});
export type TaskMainSessionHandoverRecoverWithNewAgentSessionRequest = z.infer<
	typeof taskMainSessionHandoverRecoverWithNewAgentSessionRequestSchema
>;
export const taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema =
	taskMainSessionHandoverRecoverWithNewAgentSessionRequestSchema;
export type TaskMainSessionHandoverRecoverWithNewCodexSessionRequest =
	TaskMainSessionHandoverRecoverWithNewAgentSessionRequest;

export const taskMainSessionHandoverRecoveryReceiptSchema =
	taskMainSessionHandoverRecoveryReceiptReferenceSchema.extend({
		taskId: z.string().min(1),
		previousHandoverRecord: taskMainSessionHandoverRecordSchema,
	});

export const taskMainSessionHandoverPrepareResponseSchema = z.object({
	material: taskMainSessionHandoverMaterialSchema,
	mainTaskConversationSessionId: z.string(),
	codexPeerTaskConversationSessionIds: z.array(z.string()),
	existingPeerCandidates: z
		.array(
			z.object({
				taskConversationSessionId: z.string(),
				agentId: taskMainSessionHandoverExistingPeerAgentIdSchema,
				displayName: z.string(),
				available: z.boolean(),
				unavailableReason: z.string().nullable(),
			}),
		)
		.optional(),
	busyTaskConversationSessionIds: z.array(z.string()),
	targetAgentCapabilities: z
		.array(
			z.object({
				agentId: taskMainSessionHandoverAgentIdSchema,
				label: z.string(),
				installationStatus: z.enum(["installed", "not_installed", "unknown"]),
				completeNativeConversationForkAvailability: z.object({
					available: z.boolean(),
					unavailableReason: z.string().nullable(),
				}),
			}),
		)
		.optional(),
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
			canRecreateAgentSession: z.boolean().optional(),
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
