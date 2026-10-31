import { z } from "zod";

const commandArgumentsSchema = z.array(z.string().refine((value) => !value.includes("\0"))).nonempty();
export const taskCommandExecutionSpecificationSchema = z
	.object({
		command: commandArgumentsSchema,
		resumeCommand: commandArgumentsSchema,
		resumeCommandPreservesBusinessSingleFlight: z.boolean().default(false),
		cancelCommand: commandArgumentsSchema.optional(),
		workingDirectory: z.string().min(1),
		resultFile: z.string().min(1),
		materialSha256: z.string().regex(/^[a-f0-9]{64}$/),
		label: z.string().min(1),
		recoveryEvidencePaths: z.array(z.string()).default([]),
		readOnlyRecoveryEvidenceObservationCommand: commandArgumentsSchema.optional(),
	})
	.strict();
export type TaskCommandExecutionSpecification = z.infer<typeof taskCommandExecutionSpecificationSchema>;
export const taskCommandExecutionStartRequestSchema = z.object({
	taskId: z.string().min(1),
	idempotencyKey: z.string().min(1),
	specification: taskCommandExecutionSpecificationSchema,
});
export const taskCommandExecutionIdentityRequestSchema = z.object({
	taskId: z.string().min(1),
	executionId: z.string().uuid(),
});
export type TaskCommandExecutionStartRequest = z.input<typeof taskCommandExecutionStartRequestSchema>;
export type TaskCommandExecutionIdentityRequest = z.infer<typeof taskCommandExecutionIdentityRequestSchema>;

export const taskCommandExecutionRecordSchema = z.object({
	executionId: z.string().uuid(),
	workspaceId: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	originatingConversationSessionId: z.string(),
	originatingNativeSessionId: z.string(),
	originatingRuntimeSessionIncarnationId: z.string().nullable(),
	worktreeIdentity: z.object({
		realPath: z.string(),
		device: z.number(),
		inode: z.number(),
		createdAtEpochMs: z.number(),
	}),
	idempotencyKey: z.string(),
	materialSha256: z.string(),
	specification: taskCommandExecutionSpecificationSchema,
	custodianRuntimeProcessInstanceId: z.string(),
	createdAtEpochMs: z.number(),
	updatedAtEpochMs: z.number(),
	launchState: z.enum(["registered", "launching", "running", "exited", "unknown"]),
	launchAttemptCount: z.number(),
	launchNonce: z.string().uuid(),
	previousLaunchNonces: z.array(z.string().uuid()).default([]),
	unprovenSupervisorRecoveryObservation: z
		.object({
			launchNonce: z.string().uuid(),
			missingEvidence: z.literal("supervisor_or_owned_process_exit"),
			equivalentEvidenceSources: z.array(z.string()),
			recoveryAction: z.enum(["resume_registered_business_single_flight", "await_process_or_native_evidence"]),
			unprovenSingleFlightResumeAttemptCount: z.number().int().nonnegative(),
			maximumUnprovenSingleFlightResumeAttempts: z.literal(1),
		})
		.nullable()
		.default(null),
	revocationFile: z.string(),
	revokedAtEpochMs: z.number().nullable(),
	revokedLaunchAttemptCount: z.number().nullable(),
	revokedResultWriteAttemptCount: z.number().nullable(),
	businessDisposition: z
		.enum(["agent_review_ready", "agent_judgment_required", "machine_evidence_pending", "cancelled"])
		.nullable(),
	progress: z.record(z.string(), z.unknown()).nullable(),
	recovery: z.record(z.string(), z.unknown()).nullable(),
	lastRecoveryEvidenceSha256: z.string().nullable(),
	unchangedRecoveryAttemptCount: z.number(),
	nextRecoveryAtEpochMs: z.number().nullable(),
	parkOwned: z.boolean(),
	logicalResultCount: z.number(),
	resultDelivery: z
		.object({
			resultId: z.string(),
			text: z.string(),
			textSha256: z.string(),
			state: z.enum(["known_not_submitted", "submission_unknown", "native_accepted"]),
			attemptCount: z.number(),
			attemptId: z.string().nullable(),
			awaitingTransportReceipt: z.boolean(),
			lastPreflightFailureEvidenceSha256: z.string().nullable(),
			unchangedPreflightRetryCount: z.number(),
			retryPreflightNotBeforeEpochMs: z.number().nullable(),
			reconciliationAttemptCount: z.number(),
			lastReconciliationEvidenceSha256: z.string().nullable(),
			nextReconciliationAtEpochMs: z.number().nullable(),
			nativeReceipt: z.record(z.string(), z.unknown()).nullable(),
		})
		.nullable(),
	cancellationObservation: z.record(z.string(), z.unknown()).nullable(),
});
export type TaskCommandExecutionRecord = z.infer<typeof taskCommandExecutionRecordSchema>;
export interface TaskCommandExecutionResponse {
	ok: true;
	execution: TaskCommandExecutionRecord;
}
// 用具名输出类型限制大型 router 的声明展开，保留完整响应契约与运行时校验。
export const taskCommandExecutionResponseSchema: z.ZodType<TaskCommandExecutionResponse> = z.object({
	ok: z.literal(true),
	execution: taskCommandExecutionRecordSchema,
});
