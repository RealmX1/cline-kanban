import { z } from "zod";
export const codexConfigurationPermissionSelectionSourceSchema = z.enum(["profile", "task_local"]);
export type CodexConfigurationPermissionSelectionSource = z.infer<
	typeof codexConfigurationPermissionSelectionSourceSchema
>;

const codexNativePluginInstallationCapabilityEvidenceSchema = z.object({
	nativeBinaryVersion: z.string().min(1).nullable(),
	nativeExecutableRealPath: z.string().min(1),
	nativeExecutableIdentityDigest: z.string().min(1),
	observedAtMs: z.number(),
	probeProtocolRevision: z.number().int().positive().optional(),
	evidencePath: z.string().min(1).optional(),
});
export const codexSourceSharedPluginInstallationDirectoriesBindingSchema = z.object({
	layoutVersion: z.literal(1),
	pluginsDirectoryCanonicalPath: z.string().min(1),
	pluginsDirectoryIdentity: z.string().min(1),
	marketplaceInstallationDirectoryCanonicalPath: z.string().min(1),
	marketplaceInstallationDirectoryIdentity: z.string().min(1),
	nativeCapabilityEvidence: codexNativePluginInstallationCapabilityEvidenceSchema,
});
export type CodexSourceSharedPluginInstallationDirectoriesBinding = z.infer<
	typeof codexSourceSharedPluginInstallationDirectoriesBindingSchema
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
	sourceSharedPluginInstallationDirectoriesBinding:
		codexSourceSharedPluginInstallationDirectoriesBindingSchema.optional(),
	sourceSharedPluginInstallationDirectoriesCompatibilityObservation: z
		.object({
			status: z.enum(["unverified_native_capability", "unsupported_native_capability"]),
			nativeBinaryVersion: z.string().nullable(),
			nativeExecutableRealPath: z.string().nullable(),
			automaticRecheckCondition: z.literal("next_native_process_generation"),
			reason: z.string().optional(),
		})
		.optional(),
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
	fieldVersions: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export interface CodexConfigurationProfile {
	profileId: string;
	name: string;
	sourceIdentity: string;
	version: number;
	fieldVersions?: Record<string, number>;
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
		stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
	}),
	z.object({
		action: z.literal("update"),
		profileId: z.string().min(1),
		expectedVersion: z.number().int().nonnegative(),
		expectedFieldVersions: z.record(z.string(), z.number().int().nonnegative().nullable()).optional(),
		name: z.string().trim().min(1).max(100).optional(),
		fields: z
			.array(
				z
					.object({ fieldKey: z.string().min(1), value: z.unknown().optional(), delete: z.boolean().optional() })
					.refine((edit) => edit.delete === true || edit.value !== undefined, "必须提供设置值或明确删除。"),
			)
			.max(200)
			.optional(),
		idempotencyKey: z.string().min(1).max(200),
		stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
	}),
	z.object({
		action: z.literal("set_default"),
		profileId: z.string().min(1),
		idempotencyKey: z.string().min(1).max(200),
		stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
	}),
	z.object({
		action: z.literal("bind_session"),
		profileId: z.string().min(1),
		workspaceId: z.string().min(1),
		conversationSessionId: z.string().min(1),
		expectedRuntimeSessionIncarnationId: z.string().uuid(),
		idempotencyKey: z.string().min(1).max(200),
		stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
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
	readConfigurationSafetyFingerprint?: (launchSelection?: {
		sessionModelId?: string;
		sessionReasoningEffortOverride?: string;
		sessionPermissionMode?: string;
		sessionPermissionSelectionSource?: "profile" | "task_local";
	}) => Promise<string | null>;
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
	previousMatchesSharedCurrent: z.boolean().optional(),
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
	includePropagationHistory: z.boolean().optional(),
});
export type CodexConfigurationChangeDetailsRequest = z.infer<typeof codexConfigurationChangeDetailsRequestSchema>;
export const codexConfigurationChangeDetailsSchema = codexConfigurationChangeComparisonSchema.extend({
	profileEditFields: z
		.array(z.object({ fieldKey: z.string(), value: z.unknown().optional(), delete: z.boolean().optional() }))
		.optional(),
	propagationTargets: z.array(codexConfigurationPropagationTargetSchema).optional(),
	changeId: z.string(),
	version: z.number(),
	fieldLabel: z.string(),
	sourceEvidence: codexConfigurationSourceEvidenceSchema,
	hookExplanation: z.string().nullable(),
});
export type CodexConfigurationChangeDetails = z.infer<typeof codexConfigurationChangeDetailsSchema>;

export const codexConfigurationChangeSharingScopeSchema = z.enum(["session_only", "profile"]);
export const codexConfigurationChangeSharingScopeStateSchema = z.object({
	currentScope: codexConfigurationChangeSharingScopeSchema,
	requestedScope: codexConfigurationChangeSharingScopeSchema,
	withdrawalStatus: z.enum(["not_requested", "pending", "completed", "protected_conflicts"]),
	compensationChangeIds: z.array(z.string()),
	conflicts: z.array(
		z.object({
			writerId: z.string().optional(),
			fieldKey: z.string(),
			reason: z.string(),
			recoveryCondition: z.string().nullable(),
		}),
	),
});
export const codexConfigurationChangeSchema = z.object({
	changeSharingScope: codexConfigurationChangeSharingScopeStateSchema.optional(),
	noticePresentedAtMs: z.number().optional(),
	compensationForChangeId: z.string().optional(),
	candidateFieldGroupKey: z.string().optional(),
	completeCandidateValueDigest: z.string().optional(),
	settingsIsolationArchivedAtMs: z.number().optional(),
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
	propagationTargetTotalCount: z.number().int().nonnegative().optional(),
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
export const codexConfigurationSessionAdoptionStatusSchema = z.enum([
	"adopted",
	"local_selection",
	"saved",
	"pending",
	"conflict",
	"unverified",
]);
export const codexConfigurationSessionAdoptionCountsSchema = z.object({
	profileId: z.string(),
	total: z.number().int().nonnegative(),
	adopted: z.number().int().nonnegative(),
	local_selection: z.number().int().nonnegative(),
	saved: z.number().int().nonnegative(),
	pending: z.number().int().nonnegative(),
	conflict: z.number().int().nonnegative(),
	unverified: z.number().int().nonnegative(),
});
export type CodexConfigurationSessionAdoptionCounts = z.infer<typeof codexConfigurationSessionAdoptionCountsSchema>;
export const codexConfigurationSessionAdoptionProgressRequestSchema = z.object({
	profileId: z.string().min(1).optional(),
	workspaceId: z.string().min(1).optional(),
	conversationSessionId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).default(50),
	cursor: z.string().min(1).max(4096).optional(),
});
export type CodexConfigurationSessionAdoptionProgressRequest = z.infer<
	typeof codexConfigurationSessionAdoptionProgressRequestSchema
>;
export const codexConfigurationSessionAdoptionProgressPageSchema = z.object({
	entries: z.array(
		z.object({
			workspaceId: z.string(),
			conversationSessionId: z.string(),
			runtimeSessionIncarnationId: z.string(),
			writerId: z.string().nullable(),
			profileId: z.string(),
			status: codexConfigurationSessionAdoptionStatusSchema,
			localExceptionGroups: z.array(z.string()),
			recoveryCondition: z.string().nullable(),
		}),
	),
	totalCount: z.number().int().nonnegative(),
	nextCursor: z.string().nullable(),
	storageIdentity: z.string(),
});
export type CodexConfigurationSessionAdoptionProgressPage = z.infer<
	typeof codexConfigurationSessionAdoptionProgressPageSchema
>;
export const codexConfigurationObservationHealthSchema = z.object({
	status: z.enum(["healthy", "recovering", "limited", "unverified"]),
	impact: z.string(),
	checkedAtMs: z.number().nullable(),
	recoveryCondition: z.string().nullable(),
});
export type CodexConfigurationObservationHealth = z.infer<typeof codexConfigurationObservationHealthSchema>;
const codexConfigurationSyncStateObjectSchema = z.object({
	adoptionCounts: z.array(codexConfigurationSessionAdoptionCountsSchema).optional(),
	observationHealth: codexConfigurationObservationHealthSchema.optional(),
	stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
	storageIdentity: z.string().optional(),
	storageGeneration: z.number().int().nonnegative().optional(),
	historyTotalCount: z.number().int().nonnegative().optional(),
	historyMaximumSequence: z.number().int().nonnegative().optional(),
	historyProjectionGeneration: z.number().int().nonnegative().optional(),
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
			lastCheckedAtMs: z.number().nullable().optional(),
			automaticRecoveryPending: z.boolean().optional(),
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
	adoptionCounts?: CodexConfigurationSessionAdoptionCounts[];
	observationHealth?: CodexConfigurationObservationHealth;
	stateResponseScope?: "full" | "active" | "overview";
	storageIdentity?: string;
	storageGeneration?: number;
	historyTotalCount?: number;
	historyMaximumSequence?: number;
	historyProjectionGeneration?: number;
	revision: number;
	changes: CodexConfigurationChange[];
	sourceObservations: CodexConfigurationSourceObservation[];
	observationProblem: string | null;
	profiles?: CodexConfigurationProfile[];
	defaultCodexConfigurationProfileId?: string | null;
	sessionProfileBindings?: CodexConfigurationSessionProfileBinding[];
	diagnosticCoverage?: {
		lastCheckedAtMs?: number | null;
		automaticRecoveryPending?: boolean;
		fileObservation: "starting" | "active";
		targetCount: number;
		coverageGapCount: number;
		systemWriterEvidence: "not_collected_by_runtime";
	};
}
export const codexConfigurationSyncHistoryRequestSchema = z.object({
	category: z.enum(["all", "settings", "sources"]).default("all"),
	search: z.string().max(1000).default(""),
	limit: z.number().int().min(1).max(100).default(50),
	cursor: z.string().min(1).max(4096).optional(),
});
export type CodexConfigurationSyncHistoryRequest = z.infer<typeof codexConfigurationSyncHistoryRequestSchema>;
export const codexConfigurationSyncHistoryPageSchema = z.object({
	changes: z.array(codexConfigurationChangeSchema),
	sourceObservations: z.array(codexConfigurationSourceObservationSchema),
	totalCount: z.number().int().nonnegative(),
	nextCursor: z.string().nullable(),
	storageIdentity: z.string(),
	storageGeneration: z.number().int().nonnegative(),
	historyMaximumSequence: z.number().int().nonnegative(),
	historyProjectionGeneration: z.number().int().nonnegative(),
});
export type CodexConfigurationSyncHistoryPage = z.infer<typeof codexConfigurationSyncHistoryPageSchema>;
export const codexConfigurationSyncActiveStateSchema = codexConfigurationSyncStateObjectSchema.extend({
	stateResponseScope: z.literal("active"),
	storageIdentity: z.string(),
	storageGeneration: z.number().int().nonnegative(),
	historyTotalCount: z.number().int().nonnegative(),
	historyMaximumSequence: z.number().int().nonnegative(),
	historyProjectionGeneration: z.number().int().nonnegative(),
});
export type CodexConfigurationSyncActiveState = z.infer<typeof codexConfigurationSyncActiveStateSchema>;
export const codexConfigurationSyncOverviewSchema = codexConfigurationSyncStateObjectSchema.extend({
	stateResponseScope: z.literal("overview"),
	adoptionCounts: z.array(codexConfigurationSessionAdoptionCountsSchema),
	observationHealth: codexConfigurationObservationHealthSchema,
});
export type CodexConfigurationSyncOverview = z.infer<typeof codexConfigurationSyncOverviewSchema>;
export const codexConfigurationSourceObservationRequestSchema = z.object({ observationId: z.string().min(1) });
export const codexConfigurationMutationReceiptSchema = z
	.object({ requestDigest: z.string(), changeId: z.string() })
	.nullable();
export const codexConfigurationSyncStateSchema: z.ZodType<CodexConfigurationSyncState> =
	codexConfigurationSyncStateObjectSchema;
export type CodexConfigurationChange = z.infer<typeof codexConfigurationChangeSchema>;

export const codexConfigurationChangeMutationRequestSchema = z.object({
	changeId: z.string().min(1),
	expectedVersion: z.number().int().positive(),
	idempotencyKey: z.string().min(1).max(200),
	stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
});
export const codexConfigurationBatchActionRequestSchema = z.object({
	action: z.enum(["approve", "reject", "defer", "confirm_source"]),
	stateResponseScope: z.enum(["full", "active", "overview"]).optional(),
	items: z
		.array(
			codexConfigurationChangeMutationRequestSchema.omit({ stateResponseScope: true }).extend({
				entryKind: z.enum(["settings_proposal", "source_observation"]),
				expectedSharedValueDigest: z.string().min(1).optional(),
			}),
		)
		.min(1)
		.max(200),
});
export const codexConfigurationMutationReceiptRequestSchema = z.object({
	idempotencyKey: z.string().min(1).max(200),
	expectedAction: z.enum(["confirm_source", "defer", "approve", "reject"]).optional(),
	expectedEntry: codexConfigurationBatchActionRequestSchema.shape.items.element.optional(),
	expectedProfileMutation: codexConfigurationProfileMutationRequestSchema.optional(),
	expectedSharingScopeMutation: codexConfigurationChangeMutationRequestSchema
		.extend({ targetScope: codexConfigurationChangeSharingScopeSchema })
		.optional(),
});
export type CodexConfigurationMutationReceiptRequest = z.infer<typeof codexConfigurationMutationReceiptRequestSchema>;
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
export const codexConfigurationSetChangeSharingScopeRequestSchema =
	codexConfigurationChangeMutationRequestSchema.extend({ targetScope: codexConfigurationChangeSharingScopeSchema });
export type CodexConfigurationSetChangeSharingScopeRequest = z.infer<
	typeof codexConfigurationSetChangeSharingScopeRequestSchema
>;
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
	setChangeSharingScope: (
		input: CodexConfigurationSetChangeSharingScopeRequest,
	) => Promise<CodexConfigurationSyncState>;
	getOverview: () => Promise<CodexConfigurationSyncOverview>;
	listSessionAdoptionProgress: (
		input: CodexConfigurationSessionAdoptionProgressRequest,
	) => Promise<CodexConfigurationSessionAdoptionProgressPage>;
	getActiveState: () => Promise<CodexConfigurationSyncActiveState>;
	listHistory: (input: CodexConfigurationSyncHistoryRequest) => Promise<CodexConfigurationSyncHistoryPage>;
	getSourceObservation: (input: { observationId: string }) => Promise<CodexConfigurationSourceObservation | null>;
	getMutationReceipt: (
		input: CodexConfigurationMutationReceiptRequest,
	) => Promise<{ requestDigest: string; changeId: string } | null>;

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
