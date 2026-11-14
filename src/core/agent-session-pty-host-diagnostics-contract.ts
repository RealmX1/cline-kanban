import { z } from "zod";

export const agentSessionPtyHostStartupDecisionSchema = z.object({
	agentSessionPtyHostModeEnabled: z.boolean(),
	canAdoptExistingHostedSessions: z.boolean(),
	disabledReason: z
		.enum([
			"persistent_preference_disabled",
			"environment_override_disabled",
			"invalid_environment_override",
			"runtime_port_auto_selected",
			"remote_host_mode",
			"unsupported_platform_win32",
			"electron_desktop_shell",
		])
		.nullable(),
	enablementPreferenceSource: z.enum(["environment_override", "persistent_preference", "default_enabled"]),
	effectiveStartupIntent: z.enum(["enabled", "disabled"]),
	persistentPreference: z.enum(["enabled", "disabled"]).nullable(),
	environmentOverride: z.string().nullable(),
});

export const agentSessionPtyHostReadOnlyHostStatusSchema = z.object({
	hostProcessId: z.number().int().positive(),
	hostStartedAtEpochMs: z.number().nonnegative(),
	hostProcessInstanceId: z.string().nullable(),
	hostBuildIdentity: z.string(),
	hostLifecycleState: z.enum([
		"serving",
		"retiring_when_drained",
		"offline_termination_reserved_awaiting_acknowledgement_flush",
		"terminating_all_hosted_sessions",
	]),
	controllerProcessId: z.number().int().positive().nullable(),
	hostedSessions: z.array(
		z.object({
			hostedSessionKey: z.string(),
			workspaceId: z.string(),
			conversationSessionId: z.string(),
			hostedSessionKind: z.enum(["task_agent_session", "shell_session"]),
			processId: z.number().int().positive(),
			processStartedAtEpochMs: z.number().nonnegative(),
			exited: z.boolean(),
			adoptionRecordPresent: z.boolean(),
			outputEndByteOffset: z.number().nonnegative(),
		}),
	),
});
export type AgentSessionPtyHostReadOnlyHostStatus = z.infer<typeof agentSessionPtyHostReadOnlyHostStatusSchema>;

export const agentSessionPtyHostRecoveryProgressSchema = z.object({
	schemaVersion: z.literal(1),
	recoveryEvidenceFingerprint: z.string(),
	attemptsStarted: z.number().int().nonnegative(),
	retryBudgetStartedAtEpochMs: z.number().nonnegative(),
	retryBudgetExpiresAtEpochMs: z.number().nonnegative(),
	nextCheckAtEpochMs: z.number().nullable(),
	recoveryCondition: z.enum(["retry_budget_remaining", "host_response_or_evidence_change", "ready"]),
	lastFailureMessage: z.string().nullable(),
	lastFailureMayHideHostedSessions: z.boolean(),
});
export type AgentSessionPtyHostRecoveryProgress = z.infer<typeof agentSessionPtyHostRecoveryProgressSchema>;

export const runtimePtySessionProcessOwnershipSchema = z.object({
	workspaceId: z.string(),
	conversationSessionId: z.string(),
	runtimeSessionIncarnationId: z.string().nullable(),
	nativeConversationSessionId: z.string().nullable(),
	mostRecentPromptSubmissionId: z.string().nullable().default(null),
	mostRecentNativePromptAcceptedAtEpochMs: z.number().nullable().default(null),
	currentRuntimeDeliveredHostedOutputEndByteOffset: z.number().nonnegative().nullable().default(null),
	processId: z.number().int().positive(),
	processStartedAtEpochMs: z.number().nullable(),
	ownership: z.enum(["independent_host", "runtime_process", "ownership_unknown"]),
	hostSocketPath: z.string().nullable(),
	hostedSessionKey: z.string().nullable(),
});
export type RuntimePtySessionProcessOwnership = z.infer<typeof runtimePtySessionProcessOwnershipSchema>;

const agentSessionPtyHostDiagnosticsStructureSchema = z.object({
	reportGeneratedAtEpochMs: z.number(),
	runtimeIdentity: z.object({ runtimeHomeDirectoryPath: z.string(), runtimePort: z.number().int().positive() }),
	runtimeProcessId: z.number().int().positive().nullable(),
	runtimeProcessStartTimeText: z.string().nullable(),
	runtimeLoadedEntrypointSha256: z.string().nullable().optional(),
	runtimeProcessStatus: z.enum(["running", "offline", "unknown"]),
	startupDecision: agentSessionPtyHostStartupDecisionSchema.nullable(),
	configurationReadError: z.string().nullable(),
	configuredPersistentPreference: z.enum(["enabled", "disabled"]).nullable(),
	configuredPreferenceSource: z.enum(["persistent_preference", "default_enabled", "configuration_read_error"]),
	newSessionHostingMode: z.enum([
		"independent_host",
		"in_process_pty",
		"disabled",
		"unsupported",
		"ownership_unknown",
		"runtime_offline",
	]),
	currentGenerationSocketPath: z.string().nullable(),
	nextReadOnlyHostProbeAtEpochMs: z.number().nullable().default(null),
	recoveryProgress: agentSessionPtyHostRecoveryProgressSchema.nullable(),
	generations: z.array(
		z.object({
			socketPath: z.string(),
			observationSource: z.enum(["readonly_host_query", "own_controller_connection", "unavailable"]),
			readiness: z.enum(["ready", "not_listening", "unknown"]),
			failureMessage: z.string().nullable(),
			hostStatus: agentSessionPtyHostReadOnlyHostStatusSchema.nullable(),
		}),
	),
	runtimePtySessions: z.array(runtimePtySessionProcessOwnershipSchema),
	nonPtyAgentSessionsPreventingContinuity: z.array(
		z.object({
			workspaceId: z.string(),
			conversationSessionId: z.string(),
			processId: z.number().nullable(),
			sessionTransport: z.enum(["acp_stdio_subprocess", "in_process_cline_sdk"]),
		}),
	),
	pendingHostedSessionSpawnOwnership: z.array(
		z.object({
			hostedSessionKey: z.string(),
			workspaceId: z.string(),
			conversationSessionId: z.string(),
			socketPath: z.string(),
			attemptedAtEpochMs: z.number(),
			originalHostProcessId: z.number().int().positive().optional(),
			originalHostProcessStartTimeText: z.string().nullable().optional(),
			originalHostStartedAtEpochMs: z.number().optional(),
		}),
	),
});
export interface AgentSessionPtyHostDiagnostics extends z.infer<typeof agentSessionPtyHostDiagnosticsStructureSchema> {}
export const agentSessionPtyHostDiagnosticsSchema: z.ZodType<AgentSessionPtyHostDiagnostics> =
	agentSessionPtyHostDiagnosticsStructureSchema;
