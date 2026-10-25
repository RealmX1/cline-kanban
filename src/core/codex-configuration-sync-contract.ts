import { z } from "zod";

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
	createdAt: z.number(),
});
export type CodexConfigurationWriterBinding = z.infer<typeof codexConfigurationWriterBindingSchema>;

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

export const codexConfigurationChangeSchema = z.object({
	changeId: z.string(),
	version: z.number().int().positive(),
	sourceWriterId: z.string(),
	sourceConversationSessionId: z.string(),
	sourceWorkspaceId: z.string(),
	fieldLabel: z.string(),
	previousValueSummary: z.string(),
	valueSummary: z.string(),
	observedAt: z.number(),
	mergeStatus: z.enum([
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
export const codexConfigurationSyncStateSchema = z.object({
	revision: z.number().int().nonnegative(),
	changes: z.array(codexConfigurationChangeSchema),
	observationProblem: z.string().nullable(),
});
export type CodexConfigurationSyncState = z.infer<typeof codexConfigurationSyncStateSchema>;
export type CodexConfigurationChange = z.infer<typeof codexConfigurationChangeSchema>;

export const codexConfigurationChangeMutationRequestSchema = z.object({
	changeId: z.string().min(1),
	expectedVersion: z.number().int().positive(),
	idempotencyKey: z.string().min(1).max(200),
});
export const codexConfigurationSynchronizeRequestSchema = codexConfigurationChangeMutationRequestSchema.extend({
	synchronizeExistingSessions: z.boolean().default(false),
});
export type CodexConfigurationSynchronizeRequest = z.infer<typeof codexConfigurationSynchronizeRequestSchema>;
export const codexConfigurationResolveConflictRequestSchema = codexConfigurationChangeMutationRequestSchema.extend({
	resolution: z.enum(["use_session_value", "keep_shared_value"]),
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
	getState: () => Promise<CodexConfigurationSyncState>;
	synchronize: (input: CodexConfigurationSynchronizeRequest) => Promise<CodexConfigurationSyncState>;
	resolveConflict: (input: CodexConfigurationResolveConflictRequest) => Promise<CodexConfigurationSyncState>;
	resolveTargetConflict: (
		input: CodexConfigurationResolveTargetConflictRequest,
	) => Promise<CodexConfigurationSyncState>;
	acknowledge: (
		input: z.infer<typeof codexConfigurationChangeMutationRequestSchema>,
	) => Promise<CodexConfigurationSyncState>;
}
