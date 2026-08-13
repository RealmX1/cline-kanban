// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import type {
	RuntimeAddBacklogTaskRequest,
	RuntimeAddBacklogTaskResponse,
	RuntimeAllProjectsTaskSearchIndexResponse,
	RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
	RuntimeAnswerAgentRaisedPendingUserDecisionResponse,
	RuntimeAvailableAgentSessionsRequest,
	RuntimeAvailableAgentSessionsResponse,
	RuntimeClineAccountBalanceResponse,
	RuntimeClineAccountOrganizationsResponse,
	RuntimeClineAccountProfileResponse,
	RuntimeClineAccountSwitchRequest,
	RuntimeClineAccountSwitchResponse,
	RuntimeClineAddProviderRequest,
	RuntimeClineAddProviderResponse,
	RuntimeClineDeviceAuthCompleteRequest,
	RuntimeClineDeviceAuthCompleteResponse,
	RuntimeClineDeviceAuthStartResponse,
	RuntimeClineKanbanAccessResponse,
	RuntimeClineMcpAuthStatusResponse,
	RuntimeClineMcpOAuthRequest,
	RuntimeClineMcpOAuthResponse,
	RuntimeClineMcpSettingsResponse,
	RuntimeClineMcpSettingsSaveRequest,
	RuntimeClineMcpSettingsSaveResponse,
	RuntimeClineOauthLoginRequest,
	RuntimeClineOauthLoginResponse,
	RuntimeClineProviderCatalogResponse,
	RuntimeClineProviderModelsRequest,
	RuntimeClineProviderModelsResponse,
	RuntimeClineProviderSettingsSaveRequest,
	RuntimeClineProviderSettingsSaveResponse,
	RuntimeClineUpdateProviderRequest,
	RuntimeClineUpdateProviderResponse,
	RuntimeCommandRunRequest,
	RuntimeCommandRunResponse,
	RuntimeConfigResponse,
	RuntimeConfigSaveRequest,
	// Post-Deploy Verification / deployment tRPC I/O 类型（本阶段新增，供 RuntimeTrpcContext.deploymentApi 使用）
	RuntimeConfirmVerificationCompleteRequest,
	RuntimeConfirmVerificationCompleteResponse,
	RuntimeContinueConnectionRetrySessionsRequest,
	RuntimeContinueConnectionRetrySessionsResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeDismissConnectionRetrySessionsRequest,
	RuntimeDismissConnectionRetrySessionsResponse,
	RuntimeFeaturebaseTokenResponse,
	RuntimeGetPostDeployVerificationStateRequest,
	RuntimeGetPostDeployVerificationStateResponse,
	RuntimeGitCheckoutRequest,
	RuntimeGitCheckoutResponse,
	RuntimeGitCommitChangedFileMetadataRequest,
	RuntimeGitCommitChangedFileMetadataResponse,
	RuntimeGitCommitDiffRequest,
	RuntimeGitCommitDiffResponse,
	RuntimeGitCommitFileDiffPatchRequest,
	RuntimeGitCommitFileDiffPatchResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitLogRequest,
	RuntimeGitLogResponse,
	RuntimeGitRefsResponse,
	RuntimeGitSummaryResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeListAgentRaisedPendingUserDecisionsResponse,
	RuntimeNotificationClearRequest,
	RuntimeNotificationMarkVisitedRequest,
	RuntimeNotificationMutationResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimeProjectAddRequest,
	RuntimeProjectAddResponse,
	RuntimeProjectDirectoryPickerResponse,
	RuntimeProjectPermanentDeletionPreviewRequest,
	RuntimeProjectPermanentDeletionPreviewResponse,
	RuntimeProjectPermanentDeletionRequest,
	RuntimeProjectPermanentDeletionResult,
	RuntimeProjectsResponse,
	RuntimePromptLibraryMutateRequest,
	RuntimePromptLibraryReadRequest,
	RuntimePromptLibraryResponse,
	RuntimeRequestVerificationCompleteRequest,
	RuntimeRequestVerificationCompleteResponse,
	RuntimeRunPostDeployVerificationItemRequest,
	RuntimeRunPostDeployVerificationItemResponse,
	RuntimeRunUpdateResponse,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeSlashCommandsResponse,
	RuntimeTaskAgentUserDecisionResolveRequest,
	RuntimeTaskAgentUserDecisionResolveResponse,
	RuntimeTaskChatAbortRequest,
	RuntimeTaskChatAbortResponse,
	RuntimeTaskChatCancelRequest,
	RuntimeTaskChatCancelResponse,
	RuntimeTaskChatDeliveryCancelRequest,
	RuntimeTaskChatDeliveryCancelResponse,
	RuntimeTaskChatMessagesRequest,
	RuntimeTaskChatMessagesResponse,
	RuntimeTaskChatReloadRequest,
	RuntimeTaskChatReloadResponse,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskParkAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskSessionInputRequest,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopRequest,
	RuntimeTaskSessionStopResponse,
	RuntimeTaskSessionTransitionToReviewRequest,
	RuntimeTaskSessionTransitionToReviewResponse,
	RuntimeTaskTerminalRefreshRequest,
	RuntimeTaskTerminalRefreshResponse,
	RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTerminalAgentModelSelectionOptionsRequest,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
	RuntimeUpdateStatusResponse,
	RuntimeUpdateVerificationChecklistRequest,
	RuntimeUpdateVerificationChecklistResponse,
	RuntimeWorkspaceChangesRequest,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileSearchRequest,
	RuntimeWorkspaceFileSearchResponse,
	RuntimeWorkspaceStateNotifyResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
	RuntimeWorktreeDeleteRequest,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureRequest,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import {
	runtimeAddBacklogTaskRequestSchema,
	runtimeAddBacklogTaskResponseSchema,
	runtimeAllProjectsTaskSearchIndexResponseSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema,
	runtimeAvailableAgentSessionsRequestSchema,
	runtimeAvailableAgentSessionsResponseSchema,
	runtimeClineAccountBalanceResponseSchema,
	runtimeClineAccountOrganizationsResponseSchema,
	runtimeClineAccountProfileResponseSchema,
	runtimeClineAccountSwitchRequestSchema,
	runtimeClineAccountSwitchResponseSchema,
	runtimeClineAddProviderRequestSchema,
	runtimeClineAddProviderResponseSchema,
	runtimeClineDeviceAuthCompleteRequestSchema,
	runtimeClineDeviceAuthCompleteResponseSchema,
	runtimeClineDeviceAuthStartResponseSchema,
	runtimeClineKanbanAccessResponseSchema,
	runtimeClineMcpAuthStatusResponseSchema,
	runtimeClineMcpOAuthRequestSchema,
	runtimeClineMcpOAuthResponseSchema,
	runtimeClineMcpSettingsResponseSchema,
	runtimeClineMcpSettingsSaveRequestSchema,
	runtimeClineMcpSettingsSaveResponseSchema,
	runtimeClineOauthLoginRequestSchema,
	runtimeClineOauthLoginResponseSchema,
	runtimeClineProviderCatalogResponseSchema,
	runtimeClineProviderModelsRequestSchema,
	runtimeClineProviderModelsResponseSchema,
	runtimeClineProviderSettingsSaveRequestSchema,
	runtimeClineProviderSettingsSaveResponseSchema,
	runtimeClineUpdateProviderRequestSchema,
	runtimeClineUpdateProviderResponseSchema,
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	// Post-Deploy Verification / deployment tRPC I/O schemas（本阶段新增，供 deployment router 校验）
	runtimeConfirmVerificationCompleteRequestSchema,
	runtimeConfirmVerificationCompleteResponseSchema,
	runtimeContinueConnectionRetrySessionsRequestSchema,
	runtimeContinueConnectionRetrySessionsResponseSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeDismissConnectionRetrySessionsRequestSchema,
	runtimeDismissConnectionRetrySessionsResponseSchema,
	runtimeFeaturebaseTokenResponseSchema,
	runtimeGetPostDeployVerificationStateRequestSchema,
	runtimeGetPostDeployVerificationStateResponseSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeGitCheckoutResponseSchema,
	runtimeGitCommitChangedFileMetadataRequestSchema,
	runtimeGitCommitChangedFileMetadataResponseSchema,
	runtimeGitCommitDiffRequestSchema,
	runtimeGitCommitDiffResponseSchema,
	runtimeGitCommitFileDiffPatchRequestSchema,
	runtimeGitCommitFileDiffPatchResponseSchema,
	runtimeGitDiscardResponseSchema,
	runtimeGitLogRequestSchema,
	runtimeGitLogResponseSchema,
	runtimeGitRefsResponseSchema,
	runtimeGitSummaryResponseSchema,
	runtimeGitSyncActionSchema,
	runtimeGitSyncResponseSchema,
	runtimeHookIngestRequestSchema,
	runtimeHookIngestResponseSchema,
	runtimeListAgentRaisedPendingUserDecisionsResponseSchema,
	runtimeNotificationClearRequestSchema,
	runtimeNotificationMarkVisitedRequestSchema,
	runtimeNotificationMutationResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectAddResponseSchema,
	runtimeProjectDirectoryPickerResponseSchema,
	runtimeProjectPermanentDeletionPreviewRequestSchema,
	runtimeProjectPermanentDeletionPreviewResponseSchema,
	runtimeProjectPermanentDeletionRequestSchema,
	runtimeProjectPermanentDeletionResultSchema,
	runtimeProjectsResponseSchema,
	runtimePromptLibraryMutateRequestSchema,
	runtimePromptLibraryReadRequestSchema,
	runtimePromptLibraryResponseSchema,
	runtimeRequestVerificationCompleteRequestSchema,
	runtimeRequestVerificationCompleteResponseSchema,
	runtimeRunPostDeployVerificationItemRequestSchema,
	runtimeRunPostDeployVerificationItemResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeSlashCommandsResponseSchema,
	runtimeTaskAgentUserDecisionResolveRequestSchema,
	runtimeTaskAgentUserDecisionResolveResponseSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatAbortResponseSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatCancelResponseSchema,
	runtimeTaskChatDeliveryCancelRequestSchema,
	runtimeTaskChatDeliveryCancelResponseSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatMessagesResponseSchema,
	runtimeTaskChatReloadRequestSchema,
	runtimeTaskChatReloadResponseSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskChatSendResponseSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskParkAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionInputResponseSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStartResponseSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskSessionStopResponseSchema,
	runtimeTaskSessionTransitionToReviewRequestSchema,
	runtimeTaskSessionTransitionToReviewResponseSchema,
	runtimeTaskTerminalRefreshRequestSchema,
	runtimeTaskTerminalRefreshResponseSchema,
	runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskUnparkAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeTerminalAgentModelSelectionOptionsRequestSchema,
	runtimeTerminalAgentModelSelectionOptionsResponseSchema,
	runtimeUpdateStatusResponseSchema,
	runtimeUpdateVerificationChecklistRequestSchema,
	runtimeUpdateVerificationChecklistResponseSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceChangesResponseSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceFileSearchResponseSchema,
	runtimeWorkspaceStateNotifyResponseSchema,
	runtimeWorkspaceStateResponseSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeDeleteResponseSchema,
	runtimeWorktreeEnsureRequestSchema,
	runtimeWorktreeEnsureResponseSchema,
} from "../core/api-contract";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	runtimeApi: {
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		saveClineProviderSettings: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineProviderSettingsSaveRequest,
		) => Promise<RuntimeClineProviderSettingsSaveResponse>;
		addClineProvider: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineAddProviderRequest,
		) => Promise<RuntimeClineAddProviderResponse>;
		updateClineProvider: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineUpdateProviderRequest,
		) => Promise<RuntimeClineUpdateProviderResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		transitionTaskToReview: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionTransitionToReviewRequest,
		) => Promise<RuntimeTaskSessionTransitionToReviewResponse>;
		listAgentRaisedPendingUserDecisions: (
			scope: RuntimeTrpcWorkspaceScope,
		) => Promise<RuntimeListAgentRaisedPendingUserDecisionsResponse>;
		answerAgentRaisedPendingUserDecision: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
		) => Promise<RuntimeAnswerAgentRaisedPendingUserDecisionResponse>;
		continueConnectionRetrySessions: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeContinueConnectionRetrySessionsRequest,
		) => Promise<RuntimeContinueConnectionRetrySessionsResponse>;
		dismissConnectionRetrySessions: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDismissConnectionRetrySessionsRequest,
		) => Promise<RuntimeDismissConnectionRetrySessionsResponse>;
		parkTaskAwaitingDispatchedBackgroundWork: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest,
		) => Promise<RuntimeTaskParkAwaitingDispatchedBackgroundWorkResponse>;
		unparkTaskAwaitingDispatchedBackgroundWork: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest,
		) => Promise<RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkResponse>;
		isTaskParkedAwaitingDispatchedBackgroundWork: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
		) => Promise<RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse>;
		refreshTaskTerminal: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskTerminalRefreshRequest,
		) => Promise<RuntimeTaskTerminalRefreshResponse>;
		sendTaskSessionInput: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionInputRequest,
		) => Promise<RuntimeTaskSessionInputResponse>;
		getTaskChatMessages: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatMessagesRequest,
		) => Promise<RuntimeTaskChatMessagesResponse>;
		getClineSlashCommands: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeSlashCommandsResponse>;
		sendTaskChatMessage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatSendRequest,
		) => Promise<RuntimeTaskChatSendResponse>;
		cancelTaskChatDelivery: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatDeliveryCancelRequest,
		) => Promise<RuntimeTaskChatDeliveryCancelResponse>;
		getWorkspacePromptLibrary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePromptLibraryReadRequest,
		) => Promise<RuntimePromptLibraryResponse>;
		mutateWorkspacePromptLibrary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePromptLibraryMutateRequest,
		) => Promise<RuntimePromptLibraryResponse>;
		reloadTaskChatSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatReloadRequest,
		) => Promise<RuntimeTaskChatReloadResponse>;
		abortTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatAbortRequest,
		) => Promise<RuntimeTaskChatAbortResponse>;
		cancelTaskChatTurn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatCancelRequest,
		) => Promise<RuntimeTaskChatCancelResponse>;
		resolveTaskAgentUserDecision: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskAgentUserDecisionResolveRequest,
		) => Promise<RuntimeTaskAgentUserDecisionResolveResponse>;
		getClineProviderCatalog: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeClineProviderCatalogResponse>;
		getClineAccountProfile: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineAccountProfileResponse>;
		getClineKanbanAccess: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineKanbanAccessResponse>;
		getFeaturebaseToken: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeFeaturebaseTokenResponse>;
		getClineAccountBalance: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineAccountBalanceResponse>;
		getClineAccountOrganizations: (
			scope: RuntimeTrpcWorkspaceScope | null,
		) => Promise<RuntimeClineAccountOrganizationsResponse>;
		switchClineAccount: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineAccountSwitchRequest,
		) => Promise<RuntimeClineAccountSwitchResponse>;
		getClineProviderModels: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineProviderModelsRequest,
		) => Promise<RuntimeClineProviderModelsResponse>;
		getTerminalAgentModelSelectionOptions: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeTerminalAgentModelSelectionOptionsRequest,
		) => Promise<RuntimeTerminalAgentModelSelectionOptionsResponse>;
		getAvailableAgentSessions: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeAvailableAgentSessionsRequest,
		) => Promise<RuntimeAvailableAgentSessionsResponse>;
		runClineProviderOAuthLogin: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineOauthLoginRequest,
		) => Promise<RuntimeClineOauthLoginResponse>;
		startClineDeviceAuth: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineDeviceAuthStartResponse>;
		completeClineDeviceAuth: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineDeviceAuthCompleteRequest,
		) => Promise<RuntimeClineDeviceAuthCompleteResponse>;
		getClineMcpAuthStatuses: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineMcpAuthStatusResponse>;
		runClineMcpServerOAuth: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineMcpOAuthRequest,
		) => Promise<RuntimeClineMcpOAuthResponse>;
		getClineMcpSettings: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeClineMcpSettingsResponse>;
		saveClineMcpSettings: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeClineMcpSettingsSaveRequest,
		) => Promise<RuntimeClineMcpSettingsSaveResponse>;
		startShellSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeShellSessionStartRequest,
		) => Promise<RuntimeShellSessionStartResponse>;
		runCommand: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCommandRunRequest,
		) => Promise<RuntimeCommandRunResponse>;
		resetAllState: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeDebugResetAllStateResponse>;
		openFile: (input: RuntimeOpenFileRequest) => Promise<RuntimeOpenFileResponse>;
		getUpdateStatus: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeUpdateStatusResponse>;
		runUpdateNow: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeRunUpdateResponse>;
		markTaskNotificationsVisited: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeNotificationMarkVisitedRequest,
		) => Promise<RuntimeNotificationMutationResponse>;
		clearNotificationLog: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeNotificationClearRequest,
		) => Promise<RuntimeNotificationMutationResponse>;
	};
	workspaceApi: {
		loadGitSummary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitSummaryResponse>;
		runGitSyncAction: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { action: RuntimeGitSyncAction },
		) => Promise<RuntimeGitSyncResponse>;
		checkoutGitBranch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCheckoutRequest,
		) => Promise<RuntimeGitCheckoutResponse>;
		discardGitChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitDiscardResponse>;
		loadChanges: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceChangesRequest,
		) => Promise<RuntimeWorkspaceChangesResponse>;
		ensureWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeEnsureRequest,
		) => Promise<RuntimeWorktreeEnsureResponse>;
		deleteWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorktreeDeleteRequest,
		) => Promise<RuntimeWorktreeDeleteResponse>;
		loadTaskContext: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskWorkspaceInfoResponse>;
		searchFiles: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceFileSearchRequest,
		) => Promise<RuntimeWorkspaceFileSearchResponse>;
		loadState: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateResponse>;
		notifyStateUpdated: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceStateNotifyResponse>;
		saveState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeWorkspaceStateSaveRequest,
		) => Promise<RuntimeWorkspaceStateResponse>;
		addBacklogTask: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAddBacklogTaskRequest,
		) => Promise<RuntimeAddBacklogTaskResponse>;
		loadWorkspaceChanges: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeWorkspaceChangesResponse>;
		loadGitLog: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeGitLogRequest) => Promise<RuntimeGitLogResponse>;
		loadGitRefs: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest | null,
		) => Promise<RuntimeGitRefsResponse>;
		loadCommitDiff: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitDiffRequest,
		) => Promise<RuntimeGitCommitDiffResponse>;
		loadCommitChangedFileMetadata: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitChangedFileMetadataRequest,
		) => Promise<RuntimeGitCommitChangedFileMetadataResponse>;
		loadCommitFileDiffPatch: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGitCommitFileDiffPatchRequest,
		) => Promise<RuntimeGitCommitFileDiffPatchResponse>;
	};
	projectsApi: {
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
		) => Promise<RuntimeProjectAddResponse>;
		getPermanentDeletionPreview: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectPermanentDeletionPreviewRequest,
		) => Promise<RuntimeProjectPermanentDeletionPreviewResponse>;
		permanentlyDeleteProjectData: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectPermanentDeletionRequest,
		) => Promise<RuntimeProjectPermanentDeletionResult>;
		pickProjectDirectory: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectDirectoryPickerResponse>;
		listDirectoryContents: (
			preferredWorkspaceId: string | null,
			input: RuntimeDirectoryListRequest,
		) => Promise<RuntimeDirectoryListResponse>;
		getAllProjectsTaskSearchIndex: () => Promise<RuntimeAllProjectsTaskSearchIndexResponse>;
	};
	hooksApi: {
		ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>;
	};
	deploymentApi: {
		getPostDeployVerificationState: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetPostDeployVerificationStateRequest,
		) => Promise<RuntimeGetPostDeployVerificationStateResponse>;
		updateVerificationChecklist: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeUpdateVerificationChecklistRequest,
		) => Promise<RuntimeUpdateVerificationChecklistResponse>;
		runPostDeployVerificationItem: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRunPostDeployVerificationItemRequest,
		) => Promise<RuntimeRunPostDeployVerificationItemResponse>;
		requestVerificationComplete: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRequestVerificationCompleteRequest,
		) => Promise<RuntimeRequestVerificationCompleteResponse>;
		confirmVerificationComplete: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConfirmVerificationCompleteRequest,
		) => Promise<RuntimeConfirmVerificationCompleteResponse>;
	};
}

interface RuntimeTrpcContextWithWorkspaceScope extends RuntimeTrpcContext {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

function readConflictRevision(cause: unknown): number | null {
	if (!cause || typeof cause !== "object" || !("currentRevision" in cause)) {
		return null;
	}
	const revision = (cause as { currentRevision?: unknown }).currentRevision;
	if (typeof revision !== "number") {
		return null;
	}
	return Number.isFinite(revision) ? revision : null;
}

const t = initTRPC.context<RuntimeTrpcContext>().create({
	errorFormatter({ shape, error }) {
		const conflictRevision = error.code === "CONFLICT" ? readConflictRevision(error.cause) : null;
		return {
			...shape,
			data: {
				...shape.data,
				conflictRevision,
			},
		};
	},
});

const workspaceProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.requestedWorkspaceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Missing workspace scope. Include x-kanban-workspace-id header or workspaceId query parameter.",
		});
	}
	if (!ctx.workspaceScope) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Unknown workspace ID: ${ctx.requestedWorkspaceId}`,
		});
	}
	return next({
		ctx: {
			...ctx,
			workspaceScope: ctx.workspaceScope,
		} satisfies RuntimeTrpcContextWithWorkspaceScope,
	});
});

const optionalTaskWorkspaceInfoRequestSchema = runtimeTaskWorkspaceInfoRequestSchema.nullable().optional();
const gitSyncActionInputSchema = z.object({
	action: runtimeGitSyncActionSchema,
});

export const runtimeAppRouter = t.router({
	runtime: t.router({
		getConfig: t.procedure.output(runtimeConfigResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
		}),
		saveConfig: t.procedure
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		saveClineProviderSettings: t.procedure
			.input(runtimeClineProviderSettingsSaveRequestSchema)
			.output(runtimeClineProviderSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineProviderSettings(ctx.workspaceScope, input);
			}),
		addClineProvider: t.procedure
			.input(runtimeClineAddProviderRequestSchema)
			.output(runtimeClineAddProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.addClineProvider(ctx.workspaceScope, input);
			}),
		updateClineProvider: t.procedure
			.input(runtimeClineUpdateProviderRequestSchema)
			.output(runtimeClineUpdateProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.updateClineProvider(ctx.workspaceScope, input);
			}),
		startTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStartRequestSchema)
			.output(runtimeTaskSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startTaskSession(ctx.workspaceScope, input);
			}),
		stopTaskSession: workspaceProcedure
			.input(runtimeTaskSessionStopRequestSchema)
			.output(runtimeTaskSessionStopResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stopTaskSession(ctx.workspaceScope, input);
			}),
		transitionTaskToReview: workspaceProcedure
			.input(runtimeTaskSessionTransitionToReviewRequestSchema)
			.output(runtimeTaskSessionTransitionToReviewResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.transitionTaskToReview(ctx.workspaceScope, input);
			}),
		// 「agent 问了你一个问题、但那个会话可能已经被回收」——列出仍需你拍板 / 仍待送达的决策。
		// 数据源是 durable 账本，与会话进程是否还活着完全无关。
		listAgentRaisedPendingUserDecisions: workspaceProcedure
			.output(runtimeListAgentRaisedPendingUserDecisionsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.listAgentRaisedPendingUserDecisions(ctx.workspaceScope);
			}),
		answerAgentRaisedPendingUserDecision: workspaceProcedure
			.input(runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema)
			.output(runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.answerAgentRaisedPendingUserDecision(ctx.workspaceScope, input);
			}),
		continueConnectionRetrySessions: workspaceProcedure
			.input(runtimeContinueConnectionRetrySessionsRequestSchema)
			.output(runtimeContinueConnectionRetrySessionsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.continueConnectionRetrySessions(ctx.workspaceScope, input);
			}),
		dismissConnectionRetrySessions: workspaceProcedure
			.input(runtimeDismissConnectionRetrySessionsRequestSchema)
			.output(runtimeDismissConnectionRetrySessionsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.dismissConnectionRetrySessions(ctx.workspaceScope, input);
			}),
		parkTaskAwaitingDispatchedBackgroundWork: workspaceProcedure
			.input(runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema)
			.output(runtimeTaskParkAwaitingDispatchedBackgroundWorkResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.parkTaskAwaitingDispatchedBackgroundWork(ctx.workspaceScope, input);
			}),
		unparkTaskAwaitingDispatchedBackgroundWork: workspaceProcedure
			.input(runtimeTaskUnparkAwaitingDispatchedBackgroundWorkRequestSchema)
			.output(runtimeTaskUnparkAwaitingDispatchedBackgroundWorkResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.unparkTaskAwaitingDispatchedBackgroundWork(ctx.workspaceScope, input);
			}),
		isTaskParkedAwaitingDispatchedBackgroundWork: workspaceProcedure
			.input(runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema)
			.output(runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.isTaskParkedAwaitingDispatchedBackgroundWork(ctx.workspaceScope, input);
			}),
		refreshTaskTerminal: workspaceProcedure
			.input(runtimeTaskTerminalRefreshRequestSchema)
			.output(runtimeTaskTerminalRefreshResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.refreshTaskTerminal(ctx.workspaceScope, input);
			}),
		sendTaskSessionInput: workspaceProcedure
			.input(runtimeTaskSessionInputRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
			}),
		getTaskChatMessages: workspaceProcedure
			.input(runtimeTaskChatMessagesRequestSchema)
			.output(runtimeTaskChatMessagesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskChatMessages(ctx.workspaceScope, input);
			}),
		getClineSlashCommands: t.procedure.output(runtimeSlashCommandsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineSlashCommands(ctx.workspaceScope);
		}),
		reloadTaskChatSession: workspaceProcedure
			.input(runtimeTaskChatReloadRequestSchema)
			.output(runtimeTaskChatReloadResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.reloadTaskChatSession(ctx.workspaceScope, input);
			}),
		sendTaskChatMessage: workspaceProcedure
			.input(runtimeTaskChatSendRequestSchema)
			.output(runtimeTaskChatSendResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.sendTaskChatMessage(ctx.workspaceScope, input);
			}),
		cancelTaskChatDelivery: workspaceProcedure
			.input(runtimeTaskChatDeliveryCancelRequestSchema)
			.output(runtimeTaskChatDeliveryCancelResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.cancelTaskChatDelivery(ctx.workspaceScope, input);
			}),
		getWorkspacePromptLibrary: workspaceProcedure
			.input(runtimePromptLibraryReadRequestSchema)
			.output(runtimePromptLibraryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getWorkspacePromptLibrary(ctx.workspaceScope, input);
			}),
		mutateWorkspacePromptLibrary: workspaceProcedure
			.input(runtimePromptLibraryMutateRequestSchema)
			.output(runtimePromptLibraryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.mutateWorkspacePromptLibrary(ctx.workspaceScope, input);
			}),
		abortTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatAbortRequestSchema)
			.output(runtimeTaskChatAbortResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.abortTaskChatTurn(ctx.workspaceScope, input);
			}),
		cancelTaskChatTurn: workspaceProcedure
			.input(runtimeTaskChatCancelRequestSchema)
			.output(runtimeTaskChatCancelResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.cancelTaskChatTurn(ctx.workspaceScope, input);
			}),
		resolveTaskAgentUserDecision: workspaceProcedure
			.input(runtimeTaskAgentUserDecisionResolveRequestSchema)
			.output(runtimeTaskAgentUserDecisionResolveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.resolveTaskAgentUserDecision(ctx.workspaceScope, input);
			}),
		getClineProviderCatalog: t.procedure.output(runtimeClineProviderCatalogResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineProviderCatalog(ctx.workspaceScope);
		}),
		getClineAccountProfile: t.procedure.output(runtimeClineAccountProfileResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineAccountProfile(ctx.workspaceScope);
		}),
		getClineKanbanAccess: t.procedure.output(runtimeClineKanbanAccessResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineKanbanAccess(ctx.workspaceScope);
		}),
		getFeaturebaseToken: t.procedure.output(runtimeFeaturebaseTokenResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getFeaturebaseToken(ctx.workspaceScope);
		}),
		getClineAccountBalance: t.procedure.output(runtimeClineAccountBalanceResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineAccountBalance(ctx.workspaceScope);
		}),
		getClineAccountOrganizations: t.procedure
			.output(runtimeClineAccountOrganizationsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineAccountOrganizations(ctx.workspaceScope);
			}),
		switchClineAccount: t.procedure
			.input(runtimeClineAccountSwitchRequestSchema)
			.output(runtimeClineAccountSwitchResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.switchClineAccount(ctx.workspaceScope, input);
			}),
		getClineProviderModels: t.procedure
			.input(runtimeClineProviderModelsRequestSchema)
			.output(runtimeClineProviderModelsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getClineProviderModels(ctx.workspaceScope, input);
			}),
		getTerminalAgentModelSelectionOptions: t.procedure
			.input(runtimeTerminalAgentModelSelectionOptionsRequestSchema)
			.output(runtimeTerminalAgentModelSelectionOptionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTerminalAgentModelSelectionOptions(ctx.workspaceScope, input);
			}),
		getAvailableAgentSessions: t.procedure
			.input(runtimeAvailableAgentSessionsRequestSchema)
			.output(runtimeAvailableAgentSessionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getAvailableAgentSessions(ctx.workspaceScope, input);
			}),
		getClineMcpAuthStatuses: t.procedure.output(runtimeClineMcpAuthStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineMcpAuthStatuses(ctx.workspaceScope);
		}),
		runClineMcpServerOAuth: t.procedure
			.input(runtimeClineMcpOAuthRequestSchema)
			.output(runtimeClineMcpOAuthResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineMcpServerOAuth(ctx.workspaceScope, input);
			}),
		getClineMcpSettings: t.procedure.output(runtimeClineMcpSettingsResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getClineMcpSettings(ctx.workspaceScope);
		}),
		saveClineMcpSettings: t.procedure
			.input(runtimeClineMcpSettingsSaveRequestSchema)
			.output(runtimeClineMcpSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineMcpSettings(ctx.workspaceScope, input);
			}),
		runClineProviderOAuthLogin: t.procedure
			.input(runtimeClineOauthLoginRequestSchema)
			.output(runtimeClineOauthLoginResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineProviderOAuthLogin(ctx.workspaceScope, input);
			}),
		startClineDeviceAuth: t.procedure.output(runtimeClineDeviceAuthStartResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.startClineDeviceAuth(ctx.workspaceScope);
		}),
		completeClineDeviceAuth: t.procedure
			.input(runtimeClineDeviceAuthCompleteRequestSchema)
			.output(runtimeClineDeviceAuthCompleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.completeClineDeviceAuth(ctx.workspaceScope, input);
			}),
		startShellSession: workspaceProcedure
			.input(runtimeShellSessionStartRequestSchema)
			.output(runtimeShellSessionStartResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.startShellSession(ctx.workspaceScope, input);
			}),
		runCommand: workspaceProcedure
			.input(runtimeCommandRunRequestSchema)
			.output(runtimeCommandRunResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runCommand(ctx.workspaceScope, input);
			}),
		resetAllState: t.procedure.output(runtimeDebugResetAllStateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
		}),
		openFile: t.procedure
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		getUpdateStatus: t.procedure.output(runtimeUpdateStatusResponseSchema).query(async ({ ctx }) => {
			return await ctx.runtimeApi.getUpdateStatus(ctx.workspaceScope);
		}),
		runUpdateNow: t.procedure.output(runtimeRunUpdateResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.runUpdateNow(ctx.workspaceScope);
		}),
		// 通知中心 mutation：跨 repo，用 input.workspaceId（非连接 scope）。t.procedure 不强制 workspace scope。
		markTaskNotificationsVisited: t.procedure
			.input(runtimeNotificationMarkVisitedRequestSchema)
			.output(runtimeNotificationMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.markTaskNotificationsVisited(ctx.workspaceScope, input);
			}),
		clearNotificationLog: t.procedure
			.input(runtimeNotificationClearRequestSchema)
			.output(runtimeNotificationMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.clearNotificationLog(ctx.workspaceScope, input);
			}),
	}),
	workspace: t.router({
		getGitSummary: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitSummary(ctx.workspaceScope, input ?? null);
			}),
		runGitSyncAction: workspaceProcedure
			.input(gitSyncActionInputSchema)
			.output(runtimeGitSyncResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.runGitSyncAction(ctx.workspaceScope, input);
			}),
		checkoutGitBranch: workspaceProcedure
			.input(runtimeGitCheckoutRequestSchema)
			.output(runtimeGitCheckoutResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.checkoutGitBranch(ctx.workspaceScope, input);
			}),
		discardGitChanges: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitDiscardResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.discardGitChanges(ctx.workspaceScope, input ?? null);
			}),
		getChanges: workspaceProcedure
			.input(runtimeWorkspaceChangesRequestSchema)
			.output(runtimeWorkspaceChangesResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input);
			}),
		ensureWorktree: workspaceProcedure
			.input(runtimeWorktreeEnsureRequestSchema)
			.output(runtimeWorktreeEnsureResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.ensureWorktree(ctx.workspaceScope, input);
			}),
		deleteWorktree: workspaceProcedure
			.input(runtimeWorktreeDeleteRequestSchema)
			.output(runtimeWorktreeDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.deleteWorktree(ctx.workspaceScope, input);
			}),
		getTaskContext: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskWorkspaceInfoResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskContext(ctx.workspaceScope, input);
			}),
		searchFiles: workspaceProcedure
			.input(runtimeWorkspaceFileSearchRequestSchema)
			.output(runtimeWorkspaceFileSearchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.searchFiles(ctx.workspaceScope, input);
			}),
		getState: workspaceProcedure.output(runtimeWorkspaceStateResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadState(ctx.workspaceScope);
		}),
		notifyStateUpdated: workspaceProcedure
			.output(runtimeWorkspaceStateNotifyResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.workspaceApi.notifyStateUpdated(ctx.workspaceScope);
			}),
		saveState: workspaceProcedure
			.input(runtimeWorkspaceStateSaveRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input);
			}),
		addBacklogTask: workspaceProcedure
			.input(runtimeAddBacklogTaskRequestSchema)
			.output(runtimeAddBacklogTaskResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.addBacklogTask(ctx.workspaceScope, input);
			}),
		getWorkspaceChanges: workspaceProcedure.output(runtimeWorkspaceChangesResponseSchema).query(async ({ ctx }) => {
			return await ctx.workspaceApi.loadWorkspaceChanges(ctx.workspaceScope);
		}),
		getGitLog: workspaceProcedure
			.input(runtimeGitLogRequestSchema)
			.output(runtimeGitLogResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitLog(ctx.workspaceScope, input);
			}),
		getGitRefs: workspaceProcedure
			.input(optionalTaskWorkspaceInfoRequestSchema)
			.output(runtimeGitRefsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadGitRefs(ctx.workspaceScope, input ?? null);
			}),
		getCommitDiff: workspaceProcedure
			.input(runtimeGitCommitDiffRequestSchema)
			.output(runtimeGitCommitDiffResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitDiff(ctx.workspaceScope, input);
			}),
		getCommitChangedFileMetadata: workspaceProcedure
			.input(runtimeGitCommitChangedFileMetadataRequestSchema)
			.output(runtimeGitCommitChangedFileMetadataResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitChangedFileMetadata(ctx.workspaceScope, input);
			}),
		getCommitFileDiffPatch: workspaceProcedure
			.input(runtimeGitCommitFileDiffPatchRequestSchema)
			.output(runtimeGitCommitFileDiffPatchResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadCommitFileDiffPatch(ctx.workspaceScope, input);
			}),
	}),
	projects: t.router({
		list: t.procedure.output(runtimeProjectsResponseSchema).query(async ({ ctx }) => {
			return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
		}),
		add: t.procedure
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		getPermanentDeletionPreview: t.procedure
			.input(runtimeProjectPermanentDeletionPreviewRequestSchema)
			.output(runtimeProjectPermanentDeletionPreviewResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.getPermanentDeletionPreview(ctx.requestedWorkspaceId, input);
			}),
		permanentlyDeleteProjectData: t.procedure
			.input(runtimeProjectPermanentDeletionRequestSchema)
			.output(runtimeProjectPermanentDeletionResultSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.permanentlyDeleteProjectData(ctx.requestedWorkspaceId, input);
			}),
		pickDirectory: t.procedure.output(runtimeProjectDirectoryPickerResponseSchema).mutation(async ({ ctx }) => {
			return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
		}),
		listDirectoryContents: t.procedure
			.input(runtimeDirectoryListRequestSchema)
			.output(runtimeDirectoryListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.listDirectoryContents(ctx.requestedWorkspaceId, input);
			}),
		// 跨全部注册项目的任务搜索索引：非 workspace-scoped（t.procedure，忽略连接 scope），供 Spotlight
		// 「包含其它项目」按需拉取。
		getAllProjectsTaskSearchIndex: t.procedure
			.output(runtimeAllProjectsTaskSearchIndexResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.projectsApi.getAllProjectsTaskSearchIndex();
			}),
	}),
	hooks: t.router({
		ingest: t.procedure
			.input(runtimeHookIngestRequestSchema)
			.output(runtimeHookIngestResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.hooksApi.ingest(input);
			}),
	}),
	deployment: t.router({
		getPostDeployVerificationState: workspaceProcedure
			.input(runtimeGetPostDeployVerificationStateRequestSchema)
			.output(runtimeGetPostDeployVerificationStateResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.deploymentApi.getPostDeployVerificationState(ctx.workspaceScope, input);
			}),
		updateVerificationChecklist: workspaceProcedure
			.input(runtimeUpdateVerificationChecklistRequestSchema)
			.output(runtimeUpdateVerificationChecklistResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.deploymentApi.updateVerificationChecklist(ctx.workspaceScope, input);
			}),
		runPostDeployVerificationItem: workspaceProcedure
			.input(runtimeRunPostDeployVerificationItemRequestSchema)
			.output(runtimeRunPostDeployVerificationItemResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.deploymentApi.runPostDeployVerificationItem(ctx.workspaceScope, input);
			}),
		requestVerificationComplete: workspaceProcedure
			.input(runtimeRequestVerificationCompleteRequestSchema)
			.output(runtimeRequestVerificationCompleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.deploymentApi.requestVerificationComplete(ctx.workspaceScope, input);
			}),
		confirmVerificationComplete: workspaceProcedure
			.input(runtimeConfirmVerificationCompleteRequestSchema)
			.output(runtimeConfirmVerificationCompleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.deploymentApi.confirmVerificationComplete(ctx.workspaceScope, input);
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
