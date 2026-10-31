import { z } from "zod";
export const codexConfigurationPermissionSelectionSourceSchema = z.enum(["profile", "task_local"]);
export type CodexConfigurationPermissionSelectionSource = z.infer<
	typeof codexConfigurationPermissionSelectionSourceSchema
>;

export const codexConfigurationWriterBindingSchema = z.object({
	schemaVersion: z.literal(1),
	writerId: z.string().uuid(),
	purpose: z.enum(["native_session", "auxiliary_process"]),
	workspaceId: z.string().nullable(),
	conversationSessionId: z.string().nullable(),
	runtimeSessionIncarnationId: z.string().uuid(),
	configurationHomeDirectoryPath: z.string().min(1),
	conversationStorageHomeDirectoryPath: z.string().min(1),
	sqliteHomeDirectoryPath: z.string().min(1),
	sourceHomeDirectoryPath: z.string().min(1),
	sourceIdentity: z.string().min(1),
	storageDirectoryIdentity: z.string().min(1),
	sqliteDirectoryIdentity: z.string().min(1),
	launchConfigurationDigest: z.string().min(1),
	launchSharedVersion: z.number().int().nonnegative(),
	codexConfigurationProfileId: z.string().min(1).optional(),
	createdAt: z.number(),
});
export type CodexConfigurationWriterBinding = z.infer<typeof codexConfigurationWriterBindingSchema>;

export const codexConfigurationProfileFieldSchema = z.object({
	fieldKey: z.string().min(1),
	fieldLabel: z.string(),
	value: z.unknown().optional(),
	valueSummary: z.string(),
	version: z.number().int().nonnegative(),
	exceptionGroup: z.enum(["model", "reasoning_effort", "permissions"]).nullable(),
});
export const codexConfigurationProfileSchema = z.object({
	profileId: z.string().min(1),
	name: z.string().trim().min(1).max(100),
	sourceIdentity: z.string(),
	version: z.number().int().nonnegative(),
	fields: z.array(codexConfigurationProfileFieldSchema),
});
export interface CodexConfigurationProfile {
	profileId: string;
	name: string;
	sourceIdentity: string;
	version: number;
	fields: Array<{
		fieldKey: string;
		fieldLabel: string;
		value?: unknown;
		valueSummary: string;
		version: number;
		exceptionGroup: "model" | "reasoning_effort" | "permissions" | null;
	}>;
}
const codexConfigurationProfileMutationRequestObjectSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		name: z.string().trim().min(1).max(100),
		copyFromProfileId: z.string().min(1),
		idempotencyKey: z.string().min(1).max(200),
	}),
	z.object({
		action: z.literal("update"),
		profileId: z.string().min(1),
		expectedVersion: z.number().int().nonnegative(),
		name: z.string().trim().min(1).max(100).optional(),
		fields: z
			.array(z.object({ fieldKey: z.string().min(1), value: z.unknown(), delete: z.boolean().optional() }))
			.max(200)
			.optional(),
		idempotencyKey: z.string().min(1).max(200),
	}),
	z.object({
		action: z.literal("set_default"),
		profileId: z.string().min(1),
		idempotencyKey: z.string().min(1).max(200),
	}),
	z.object({
		action: z.literal("bind_session"),
		profileId: z.string().min(1),
		workspaceId: z.string().min(1),
		conversationSessionId: z.string().min(1),
		expectedRuntimeSessionIncarnationId: z.string().uuid(),
		idempotencyKey: z.string().min(1).max(200),
	}),
]);
export type CodexConfigurationProfileMutationRequest = z.infer<
	typeof codexConfigurationProfileMutationRequestObjectSchema
>;
export const codexConfigurationProfileMutationRequestSchema: z.ZodType<
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationProfileMutationRequest
> = codexConfigurationProfileMutationRequestObjectSchema;

// 只供运行时内部接线，浏览器不能伪造安全续接的持久提交回执。
export interface CodexConfigurationProfileAutomaticAdoptionGuard {
	profileId: string;
	expectedRuntimeSessionIncarnationId: string;
	expectedNativeSessionId: string;
	readTaskExecutionEligibilityFingerprint?: () => Promise<string | null>;
	pendingProcessReplacementRetainedInputRecordPath?: string;
	onBeforeProcessReplacement: (evidenceFingerprint: string) => Promise<boolean>;
}

export const codexConfigurationPropagationTargetSchema = z.object({
	writerId: z.string(),
	conversationSessionId: z.string(),
	workspaceId: z.string(),
	status: z.enum(["accepted", "applied", "pending_reload", "pending_next_start", "conflict", "not_applicable"]),
	reason: z.string(),
	attemptCount: z.number().int().nonnegative(),
	acceptedAt: z.number(),
	diskSavedAt: z.number().nullable(),
	ownerReloadedAt: z.number().nullable(),
	recoveryCondition: z.string().nullable(),
	appliedAtStartupByWriterId: z.string().optional(),
	appliedAtStartupAt: z.number().optional(),
	conflictingTargetValueDigest: z.string().optional(),
});
export type CodexConfigurationPropagationTarget = z.infer<typeof codexConfigurationPropagationTargetSchema>;

export const codexConfigurationTaskSourceSnapshotSchema = z.object({
	workspaceId: z.string(),
	projectPath: z.string(),
	taskId: z.string(),
	taskTitle: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	conversationSessionId: z.string(),
	runtimeSessionIncarnationId: z.string(),
});
export type CodexConfigurationTaskSourceSnapshot = z.infer<typeof codexConfigurationTaskSourceSnapshotSchema>;
export const codexConfigurationSourceEvidenceSchema = z.object({
	initiator: z.object({ status: z.enum(["confirmed", "unknown"]), description: z.string() }),
	detectedOwner: z.object({
		writerId: z.string(),
		workspaceId: z.string(),
		conversationSessionId: z.string(),
		description: z.string(),
		task: codexConfigurationTaskSourceSnapshotSchema.optional(),
		currentTaskLink: z
			.object({ workspaceId: z.string(), taskId: z.string(), taskIncarnationCreatedAtEpochMs: z.number() })
			.optional(),
		unavailableReason: z.string().optional(),
	}),
	recoveryCondition: z.string().nullable(),
});
export type CodexConfigurationSourceEvidence = z.infer<typeof codexConfigurationSourceEvidenceSchema>;
const codexConfigurationComparedValueSchema = z.object({
	state: z.enum(["present", "absent", "unknown"]),
	text: z.string(),
});
const codexConfigurationValueOriginSchema = z.object({
	description: z.string(),
	changeId: z.string().optional(),
	fieldVersion: z.number().optional(),
	sourceEvidence: codexConfigurationSourceEvidenceSchema.optional(),
});
export type CodexConfigurationValueOrigin = z.infer<typeof codexConfigurationValueOriginSchema>;
export const codexConfigurationComparisonRowSchema = z.object({
	fieldKey: z.string(),
	label: z.string(),
	changeKind: z.enum(["added", "modified", "deleted", "unchanged", "unknown"]),
	previous: codexConfigurationComparedValueSchema,
	detected: codexConfigurationComparedValueSchema,
	sharedAtConflict: codexConfigurationComparedValueSchema.optional(),
	sharedCurrent: codexConfigurationComparedValueSchema.optional(),
	sharedOrigin: codexConfigurationValueOriginSchema.optional(),
	sharedAtConflictOrigin: codexConfigurationValueOriginSchema.optional(),
	target: codexConfigurationComparedValueSchema.optional(),
});
export const codexConfigurationChangeComparisonSchema = z.object({
	rows: z.array(codexConfigurationComparisonRowSchema),
	expectedSharedValueDigest: z.string(),
	targetWriterId: z.string().optional(),
	expectedTargetValueDigest: z.string().optional(),
	targetSourceEvidence: codexConfigurationSourceEvidenceSchema.optional(),
});
export const codexConfigurationChangeDetailsRequestSchema = z.object({
	changeId: z.string().min(1),
	expectedVersion: z.number().int().positive(),
	targetWriterId: z.string().min(1).optional(),
});
export type CodexConfigurationChangeDetailsRequest = z.infer<typeof codexConfigurationChangeDetailsRequestSchema>;
export const codexConfigurationChangeDetailsSchema = codexConfigurationChangeComparisonSchema.extend({
	changeId: z.string(),
	version: z.number(),
	fieldLabel: z.string(),
	sourceEvidence: codexConfigurationSourceEvidenceSchema,
	hookExplanation: z.string().nullable(),
});
export type CodexConfigurationChangeDetails = z.infer<typeof codexConfigurationChangeDetailsSchema>;

export const codexConfigurationChangeSchema = z.object({
	changeId: z.string(),
	version: z.number().int().positive(),
	sourceWriterId: z.string(),
	sourceConversationSessionId: z.string(),
	sourceWorkspaceId: z.string(),
	fieldKey: z.string().optional(),
	sourceEvidence: codexConfigurationSourceEvidenceSchema.optional(),
	comparison: codexConfigurationChangeComparisonSchema.optional(),
	targetComparisons: z.record(z.string(), codexConfigurationChangeComparisonSchema).optional(),
	hookExplanation: z.string().nullable().optional(),
	fieldLabel: z.string(),
	previousValueSummary: z.string(),
	valueSummary: z.string(),
	observedAt: z.number(),
	recordKind: z.enum(["settings_proposal", "source_observation", "historical_record"]),
	approvalStatus: z.enum(["pending", "approved", "rejected", "historical", "not_required", "expired"]),
	codexConfigurationProfileId: z.string().optional(),
	profileName: z.string().optional(),
	feedbackExpiresAtMs: z.number().optional(),
	exceptionGroup: z.enum(["model", "reasoning_effort", "permissions"]).optional(),
	sharingScope: z.enum(["profile", "all_profiles_hook_trust"]).optional(),
	decidedAt: z.number().nullable(),
	settingDifferences: z.array(z.object({ label: z.string(), previous: z.string(), current: z.string() })),
	mergeStatus: z.enum([
		"pending_approval",
		"shared_default_updated",
		"conflict",
		"kept_shared_value",
		"target_conflict_source_change_selected",
		"target_conflict_target_value_kept",
		"superseded",
	]),
	acknowledgedAt: z.number().nullable(),
	eligibleTargetCount: z.number().int().nonnegative(),
	targets: z.array(codexConfigurationPropagationTargetSchema),
});
export const codexConfigurationSourceObservationSchema = z.object({
	changeIds: z.array(z.string()).optional(),
	observationId: z.string(),
	version: z.number().int().positive(),
	sourceLabel: z.string(),
	firstObservedAt: z.number(),
	observedAt: z.number(),
	observationCount: z.number().int().positive(),
	detectedLocationCount: z.number().int().positive(),
	acknowledgedAt: z.number().nullable(),
	reminderDisposition: z.enum(["unread", "confirmed", "deferred"]),
	detectedLocations: z.array(z.object({ workspaceId: z.string(), conversationSessionId: z.string() })).optional(),
});
export type CodexConfigurationSourceObservation = z.infer<typeof codexConfigurationSourceObservationSchema>;
const codexConfigurationSyncStateObjectSchema = z.object({
	revision: z.number().int().nonnegative(),
	changes: z.array(codexConfigurationChangeSchema),
	sourceObservations: z.array(codexConfigurationSourceObservationSchema),
	observationProblem: z.string().nullable(),
	profiles: z.array(codexConfigurationProfileSchema).optional(),
	defaultCodexConfigurationProfileId: z.string().nullable().optional(),
	sessionProfileBindings: z
		.array(
			z.object({
				workspaceId: z.string(),
				conversationSessionId: z.string(),
				codexConfigurationProfileId: z.string(),
				localExceptionGroups: z.array(z.string()),
				adoptionReason: z.string().optional(),
				runtimeSessionIncarnationId: z.string().optional(),
			}),
		)
		.optional(),
	diagnosticCoverage: z
		.object({
			fileObservation: z.enum(["starting", "active"]),
			targetCount: z.number(),
			coverageGapCount: z.number(),
			systemWriterEvidence: z.literal("not_collected_by_runtime"),
		})
		.optional(),
});
export interface CodexConfigurationSessionProfileBinding {
	workspaceId: string;
	conversationSessionId: string;
	codexConfigurationProfileId: string;
	localExceptionGroups: string[];
	adoptionReason?: string;
	runtimeSessionIncarnationId?: string;
}
export interface CodexConfigurationSyncState {
	revision: number;
	changes: CodexConfigurationChange[];
	sourceObservations: CodexConfigurationSourceObservation[];
	observationProblem: string | null;
	profiles?: CodexConfigurationProfile[];
	defaultCodexConfigurationProfileId?: string | null;
	sessionProfileBindings?: CodexConfigurationSessionProfileBinding[];
	diagnosticCoverage?: {
		fileObservation: "starting" | "active";
		targetCount: number;
		coverageGapCount: number;
		systemWriterEvidence: "not_collected_by_runtime";
	};
}
export const codexConfigurationSyncStateSchema: z.ZodType<CodexConfigurationSyncState> =
	codexConfigurationSyncStateObjectSchema;
export type CodexConfigurationChange = z.infer<typeof codexConfigurationChangeSchema>;

export const codexConfigurationChangeMutationRequestSchema = z.object({
	changeId: z.string().min(1),
	expectedVersion: z.number().int().positive(),
	idempotencyKey: z.string().min(1).max(200),
});
export const codexConfigurationBatchActionRequestSchema = z.object({
	action: z.enum(["approve", "reject", "defer", "confirm_source"]),
	items: z
		.array(
			codexConfigurationChangeMutationRequestSchema.extend({
				entryKind: z.enum(["settings_proposal", "source_observation"]),
			}),
		)
		.min(1)
		.max(200),
});
export type CodexConfigurationBatchActionRequest = z.infer<typeof codexConfigurationBatchActionRequestSchema>;
export const codexConfigurationBatchActionResultSchema = z.object({
	results: z.array(
		z.object({
			changeId: z.string(),
			status: z.enum([
				"applied",
				"replayed",
				"stale_version",
				"conflict",
				"source_unverifiable",
				"not_found",
				"not_approvable",
				"idempotency_conflict",
			]),
			message: z.string(),
		}),
	),
	state: codexConfigurationSyncStateSchema,
});
export type CodexConfigurationBatchActionResult = z.infer<typeof codexConfigurationBatchActionResultSchema>;
export const codexConfigurationSynchronizeRequestSchema = codexConfigurationChangeMutationRequestSchema.extend({
	synchronizeExistingSessions: z.boolean().default(false),
});
export type CodexConfigurationSynchronizeRequest = z.infer<typeof codexConfigurationSynchronizeRequestSchema>;
export const codexConfigurationResolveConflictRequestSchema = codexConfigurationChangeMutationRequestSchema.extend({
	resolution: z.enum(["use_session_value", "keep_shared_value"]),
	expectedSharedValueDigest: z.string().min(1).optional(),
});
export type CodexConfigurationResolveConflictRequest = z.infer<typeof codexConfigurationResolveConflictRequestSchema>;
export const codexConfigurationResolveTargetConflictRequestSchema =
	codexConfigurationChangeMutationRequestSchema.extend({
		targetWriterId: z.string().min(1),
		expectedTargetValueDigest: z.string().min(1),
		resolution: z.enum(["use_source_change", "keep_target_value"]),
	});
export type CodexConfigurationResolveTargetConflictRequest = z.infer<
	typeof codexConfigurationResolveTargetConflictRequestSchema
>;

// procedure 只依赖浏览器安全的端口类型，避免把文件系统与原生进程实现带进前端类型图。
export interface CodexConfigurationSyncApi {
	getChangeDetails: (input: CodexConfigurationChangeDetailsRequest) => Promise<CodexConfigurationChangeDetails>;
	mutateProfile: (input: CodexConfigurationProfileMutationRequest) => Promise<CodexConfigurationSyncState>;
	getState: () => Promise<CodexConfigurationSyncState>;
	batchAction: (input: CodexConfigurationBatchActionRequest) => Promise<CodexConfigurationBatchActionResult>;
	synchronize: (input: CodexConfigurationSynchronizeRequest) => Promise<CodexConfigurationSyncState>;
	resolveConflict: (input: CodexConfigurationResolveConflictRequest) => Promise<CodexConfigurationSyncState>;
	resolveTargetConflict: (
		input: CodexConfigurationResolveTargetConflictRequest,
	) => Promise<CodexConfigurationSyncState>;
	acknowledge: (
		input: z.infer<typeof codexConfigurationChangeMutationRequestSchema>,
	) => Promise<CodexConfigurationSyncState>;
}
