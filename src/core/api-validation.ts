import { z } from "zod";

import {
	type RuntimeAgentSessionTransportSwitchRequest,
	type RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
	type RuntimeAuthoredVerificationDefinitionInputFile,
	type RuntimeAuthoredVerificationDefinitionsFile,
	type RuntimeCommandRunRequest,
	type RuntimeConfigSaveRequest,
	type RuntimeContinueConnectionRetrySessionsRequest,
	type RuntimeDeploymentMarker,
	type RuntimeDirectoryListRequest,
	type RuntimeDismissConnectionRetrySessionsRequest,
	type RuntimeGitCheckoutRequest,
	type RuntimeHookIngestRequest,
	type RuntimePostDeployVerificationState,
	type RuntimeProjectAddRequest,
	type RuntimeProjectPermanentDeletionPreviewRequest,
	type RuntimeProjectPermanentDeletionRequest,
	type RuntimeShellSessionStartRequest,
	type RuntimeTaskAgentUserDecisionResolveRequest,
	type RuntimeTaskChatAbortRequest,
	type RuntimeTaskChatCancelRequest,
	type RuntimeTaskChatMessagesRequest,
	type RuntimeTaskChatSendRequest,
	type RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	type RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest,
	type RuntimeTaskSessionInputRequest,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStopRequest,
	type RuntimeTaskSessionTransitionToReviewRequest,
	type RuntimeTaskTerminalRefreshRequest,
	type RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest,
	type RuntimeTaskWorkspaceInfoRequest,
	type RuntimeTerminalAgentModelSelectionOptionsRequest,
	type RuntimeTerminalWsClientMessage,
	type RuntimeWorkspaceChangesRequest,
	type RuntimeWorkspaceFileSearchRequest,
	type RuntimeWorkspaceStateSaveRequest,
	type RuntimeWorktreeDeleteRequest,
	type RuntimeWorktreeEnsureRequest,
	runtimeAgentSessionTransportSwitchRequestSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema,
	runtimeAuthoredVerificationDefinitionInputFileSchema,
	runtimeAuthoredVerificationDefinitionsFileSchema,
	runtimeCommandRunRequestSchema,
	runtimeConfigSaveRequestSchema,
	runtimeContinueConnectionRetrySessionsRequestSchema,
	runtimeDeploymentMarkerSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDismissConnectionRetrySessionsRequestSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeHookIngestRequestSchema,
	runtimePostDeployVerificationStateSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectPermanentDeletionPreviewRequestSchema,
	runtimeProjectPermanentDeletionRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeTaskAgentUserDecisionResolveRequestSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionTransitionToReviewRequestSchema,
	runtimeTaskTerminalRefreshRequestSchema,
	runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTerminalAgentModelSelectionOptionsRequestSchema,
	runtimeTerminalWsClientMessageSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeEnsureRequestSchema,
} from "./api-contract";

const trimmedStringSchema = z.string().transform((value) => value.trim());
const positiveIntegerFromQuerySchema = z.coerce.number().int().positive();

const requiredTrimmedStringSchema = (message: string) => trimmedStringSchema.pipe(z.string().min(1, message));

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Invalid request payload.");
	}
	return parsed.data;
}

export function parseWorkspaceChangesRequest(query: URLSearchParams): RuntimeWorkspaceChangesRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeWorkspaceChangesRequestSchema, { taskId, baseRef });
}

export function parseTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeTaskWorkspaceInfoRequestSchema, { taskId, baseRef });
}

export function parseOptionalTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest | null {
	if (!query.has("taskId")) {
		if (query.has("baseRef")) {
			throw new Error("baseRef query parameter requires taskId.");
		}
		return null;
	}
	return parseTaskWorkspaceInfoRequest(query);
}

export function parseWorkspaceFileSearchRequest(query: URLSearchParams): RuntimeWorkspaceFileSearchRequest {
	const normalizedQuery = parseWithSchema(trimmedStringSchema, query.get("q") ?? "");
	if (!normalizedQuery) {
		return { query: "" };
	}

	const rawLimit = query.get("limit");
	if (rawLimit == null || rawLimit.trim() === "") {
		return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
			query: normalizedQuery,
		});
	}
	const parsedLimit = positiveIntegerFromQuerySchema.safeParse(rawLimit);
	if (!parsedLimit.success) {
		throw new Error("Invalid file search limit parameter.");
	}
	return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
		query: normalizedQuery,
		limit: parsedLimit.data,
	});
}

export function parseGitCheckoutRequest(value: unknown): RuntimeGitCheckoutRequest {
	const parsed = parseWithSchema(runtimeGitCheckoutRequestSchema, value);
	const branch = parsed.branch.trim();
	if (!branch) {
		throw new Error("Branch cannot be empty.");
	}
	return {
		branch,
	};
}

export function parseWorktreeEnsureRequest(value: unknown): RuntimeWorktreeEnsureRequest {
	const parsed = parseWithSchema(runtimeWorktreeEnsureRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree ensure payload.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Invalid worktree ensure payload.");
	}
	return {
		taskId,
		baseRef,
		...(parsed.worktreeMode ? { worktreeMode: parsed.worktreeMode } : {}),
	};
}

export function parseWorktreeDeleteRequest(value: unknown): RuntimeWorktreeDeleteRequest {
	const parsed = parseWithSchema(runtimeWorktreeDeleteRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree delete payload.");
	}
	return {
		taskId,
		...(parsed.taskClosureArchiveCleanupCredential
			? { taskClosureArchiveCleanupCredential: parsed.taskClosureArchiveCleanupCredential }
			: {}),
		...(parsed.worktreeMode ? { worktreeMode: parsed.worktreeMode } : {}),
	};
}

export function parseWorkspaceStateSaveRequest(value: unknown): RuntimeWorkspaceStateSaveRequest {
	return parseWithSchema(runtimeWorkspaceStateSaveRequestSchema, value);
}

export function parseProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
	const parsed = parseWithSchema(runtimeProjectAddRequestSchema, value);
	const path = parsed.path?.trim() || undefined;
	const gitUrl = parsed.gitUrl?.trim() || undefined;
	if (!path && !gitUrl) {
		throw new Error("Either path or gitUrl is required.");
	}
	return {
		path,
		gitUrl,
		initializeGit: parsed.initializeGit,
	};
}

export function parseProjectPermanentDeletionPreviewRequest(
	value: unknown,
): RuntimeProjectPermanentDeletionPreviewRequest {
	const parsed = parseWithSchema(runtimeProjectPermanentDeletionPreviewRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
	};
}

export function parseProjectPermanentDeletionRequest(value: unknown): RuntimeProjectPermanentDeletionRequest {
	const parsed = parseWithSchema(runtimeProjectPermanentDeletionRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
		expectedWorkspaceStateRevision: parsed.expectedWorkspaceStateRevision,
		confirmationProjectName: parsed.confirmationProjectName,
	};
}

export function parseRuntimeConfigSaveRequest(value: unknown): RuntimeConfigSaveRequest {
	return parseWithSchema(runtimeConfigSaveRequestSchema, value);
}

export function parseCommandRunRequest(value: unknown): RuntimeCommandRunRequest {
	const parsed = parseWithSchema(runtimeCommandRunRequestSchema, value);
	const command = parsed.command.trim();
	if (!command) {
		throw new Error("Command cannot be empty.");
	}
	return {
		command,
	};
}

export function parseTaskSessionStartRequest(value: unknown): RuntimeTaskSessionStartRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task session baseRef cannot be empty.");
	}
	const workspaceTaskId = parsed.workspaceTaskId?.trim() || undefined;
	if (
		parsed.taskConversationSessionMetadata &&
		workspaceTaskId &&
		parsed.taskConversationSessionMetadata.workspaceTaskId !== workspaceTaskId
	) {
		throw new Error("Task conversation session workspaceTaskId values must match.");
	}
	return {
		...parsed,
		taskId,
		workspaceTaskId,
		baseRef,
	};
}

export function parseTerminalAgentModelSelectionOptionsRequest(
	value: unknown,
): RuntimeTerminalAgentModelSelectionOptionsRequest {
	return parseWithSchema(runtimeTerminalAgentModelSelectionOptionsRequestSchema, value);
}

export function parseAgentSessionTransportSwitchRequest(value: unknown): RuntimeAgentSessionTransportSwitchRequest {
	const parsed = parseWithSchema(runtimeAgentSessionTransportSwitchRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid agent session transport switch payload.");
	}
	return { ...parsed, taskId };
}

export function parseTaskSessionStopRequest(value: unknown): RuntimeTaskSessionStopRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStopRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session stop payload.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseAnswerAgentRaisedPendingUserDecisionRequest(
	value: unknown,
): RuntimeAnswerAgentRaisedPendingUserDecisionRequest {
	const parsed = parseWithSchema(runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema, value);
	const decisionId = parsed.decisionId.trim();
	if (!decisionId) {
		throw new Error("Invalid answer-agent-raised-pending-user-decision payload.");
	}
	const freeformText = parsed.freeformText?.trim() ?? null;
	return {
		decisionId,
		selectedOptionIds: parsed.selectedOptionIds
			.map((optionId) => optionId.trim())
			.filter((optionId) => optionId !== ""),
		freeformText: freeformText === "" ? null : freeformText,
		...(parsed.orderedQuestionAnswers
			? {
					orderedQuestionAnswers: parsed.orderedQuestionAnswers.map((answer) => ({
						decisionQuestionId: answer.decisionQuestionId.trim(),
						selectedOptionIds: answer.selectedOptionIds
							.map((optionId) => optionId.trim())
							.filter((optionId) => optionId !== ""),
						freeformText: answer.freeformText?.trim() || null,
					})),
				}
			: {}),
	};
}

export function parseTaskSessionTransitionToReviewRequest(value: unknown): RuntimeTaskSessionTransitionToReviewRequest {
	const parsed = parseWithSchema(runtimeTaskSessionTransitionToReviewRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session transition-to-review payload.");
	}
	return {
		taskId,
	};
}

export function parseContinueConnectionRetrySessionsRequest(
	value: unknown,
): RuntimeContinueConnectionRetrySessionsRequest {
	const parsed = parseWithSchema(runtimeContinueConnectionRetrySessionsRequestSchema, value);
	const taskIds = parsed.taskIds.map((taskId) => taskId.trim()).filter((taskId) => taskId.length > 0);
	if (taskIds.length === 0) {
		throw new Error("Invalid connection-retry continuation payload: no task ids.");
	}
	return {
		taskIds,
	};
}

export function parseDismissConnectionRetrySessionsRequest(
	value: unknown,
): RuntimeDismissConnectionRetrySessionsRequest {
	const parsed = parseWithSchema(runtimeDismissConnectionRetrySessionsRequestSchema, value);
	const taskIds = parsed.taskIds.map((taskId) => taskId.trim()).filter((taskId) => taskId.length > 0);
	if (taskIds.length === 0) {
		throw new Error("Invalid connection-retry dismissal payload: no task ids.");
	}
	return {
		taskIds,
	};
}

export function parseTaskParkAwaitingDispatchedBackgroundWorkRequest(
	value: unknown,
): RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest {
	const parsed = parseWithSchema(runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task park payload: missing task id.");
	}
	const label = parsed.label?.trim();
	return {
		taskId,
		...(label ? { label } : {}),
	};
}

export function parseTaskUnparkAwaitingDispatchedBackgroundWorkRequest(
	value: unknown,
): RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest {
	const parsed = parseWithSchema(runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task unpark payload: missing task id.");
	}
	return {
		taskId,
	};
}

export function parseTaskIsParkedAwaitingDispatchedBackgroundWorkRequest(
	value: unknown,
): RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest {
	const parsed = parseWithSchema(runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task is-parked payload: missing task id.");
	}
	return {
		taskId,
	};
}

export function parseTaskTerminalRefreshRequest(value: unknown): RuntimeTaskTerminalRefreshRequest {
	const parsed = parseWithSchema(runtimeTaskTerminalRefreshRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task terminal refresh payload.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseTaskSessionInputRequest(value: unknown): RuntimeTaskSessionInputRequest {
	const parsed = parseWithSchema(runtimeTaskSessionInputRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseTaskChatMessagesRequest(value: unknown): RuntimeTaskChatMessagesRequest {
	const parsed = parseWithSchema(runtimeTaskChatMessagesRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatSendRequest(value: unknown): RuntimeTaskChatSendRequest {
	const parsed = parseWithSchema(runtimeTaskChatSendRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	const text = parsed.text.trim();
	const hasImages = Boolean(parsed.images && parsed.images.length > 0);
	if (!text && !hasImages) {
		throw new Error("Task chat text or images are required.");
	}
	return {
		...parsed,
		taskId,
		text,
		source: parsed.source?.trim() || undefined,
		idempotencyKey: parsed.idempotencyKey?.trim() || undefined,
		promptSha256: parsed.promptSha256?.trim() || undefined,
	};
}

export function parseTaskChatAbortRequest(value: unknown): RuntimeTaskChatAbortRequest {
	const parsed = parseWithSchema(runtimeTaskChatAbortRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskAgentUserDecisionResolveRequest(value: unknown): RuntimeTaskAgentUserDecisionResolveRequest {
	const parsed = parseWithSchema(runtimeTaskAgentUserDecisionResolveRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task agent user decision taskId cannot be empty.");
	}
	const decisionId = parsed.decisionId.trim();
	if (!decisionId) {
		throw new Error("Task agent user decision decisionId cannot be empty.");
	}
	if (parsed.outcome === "selected" && !parsed.optionId?.trim()) {
		throw new Error("Selecting a task agent user decision option requires an optionId.");
	}
	return { ...parsed, taskId, decisionId };
}

export function parseTaskChatCancelRequest(value: unknown): RuntimeTaskChatCancelRequest {
	const parsed = parseWithSchema(runtimeTaskChatCancelRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseShellSessionStartRequest(value: unknown): RuntimeShellSessionStartRequest {
	const parsed = parseWithSchema(runtimeShellSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Shell session taskId cannot be empty.");
	}
	if (parsed.workspaceTaskId !== undefined && !parsed.workspaceTaskId.trim()) {
		throw new Error("Invalid shell session workspaceTaskId.");
	}
	const workspaceTaskId = parsed.workspaceTaskId?.trim() || undefined;
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Shell session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		workspaceTaskId,
		baseRef,
	};
}

export function parseHookIngestRequest(value: unknown): RuntimeHookIngestRequest {
	const parsed = parseWithSchema(runtimeHookIngestRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const workspaceId = parsed.workspaceId.trim();
	if (!taskId) {
		throw new Error("Missing taskId");
	}
	if (!workspaceId) {
		throw new Error("Missing workspaceId");
	}
	const metadata = parsed.metadata
		? {
				activityText: parsed.metadata.activityText?.trim(),
				toolName: parsed.metadata.toolName?.trim(),
				finalMessage: parsed.metadata.finalMessage?.trim(),
				hookEventName: parsed.metadata.hookEventName?.trim(),
				notificationType: parsed.metadata.notificationType?.trim(),
				source: parsed.metadata.source?.trim(),
			}
		: undefined;
	return {
		...parsed,
		taskId,
		workspaceId,
		metadata,
	};
}

export function parseTerminalWsClientMessage(value: unknown): RuntimeTerminalWsClientMessage | null {
	const parsed = runtimeTerminalWsClientMessageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

export function parseDirectoryListRequest(value: unknown): RuntimeDirectoryListRequest {
	return parseWithSchema(runtimeDirectoryListRequestSchema, value);
}

// 读盘校验 last-deployed-source-commit.json（plan 1a）。校验失败即 throw；
// 「文件缺失 / JSON 损坏隔离降级」由 deployment modules 阶段 try/catch 包裹调用。
export function parseDeploymentMarker(value: unknown): RuntimeDeploymentMarker {
	return parseWithSchema(runtimeDeploymentMarkerSchema, value);
}

// 读盘校验 post-deploy-verification-state.json（plan 1c）。校验失败即 throw；
// 损坏文件改名隔离并降级为空 deploymentGroups 由 modules 阶段处理，不在此静默吞错。
export function parsePostDeployVerificationState(value: unknown): RuntimePostDeployVerificationState {
	return parseWithSchema(runtimePostDeployVerificationStateSchema, value);
}

// 读盘校验 authored-verification-definitions.json（plan Stage 2）。校验失败即 throw；
// 损坏降级为空 definitions 由 modules 阶段处理。
export function parseAuthoredVerificationDefinitionsFile(value: unknown): RuntimeAuthoredVerificationDefinitionsFile {
	return parseWithSchema(runtimeAuthoredVerificationDefinitionsFileSchema, value);
}

// 校验 agent 提供的 definition JSON（单个或数组）。校验失败即 throw，供 register CLI 报错。
export function parseAuthoredVerificationDefinitionInputFile(
	value: unknown,
): RuntimeAuthoredVerificationDefinitionInputFile {
	return parseWithSchema(runtimeAuthoredVerificationDefinitionInputFileSchema, value);
}
