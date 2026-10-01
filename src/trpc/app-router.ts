// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
	RuntimeAddBacklogTaskRequest,
	RuntimeAddBacklogTaskResponse,
	RuntimeAgentSessionTransportSwitchRequest,
	RuntimeAgentSessionTransportSwitchResponse,
	RuntimeAllProjectsTaskSearchIndexResponse,
	RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
	RuntimeAnswerAgentRaisedPendingUserDecisionResponse,
	RuntimeArchiveExploratoryFindingRequest,
	RuntimeArchiveExploratoryFindingResponse,
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
	RuntimeConfirmExploratoryFindingRequest,
	RuntimeConfirmExploratoryFindingResponse,
	// Post-Deploy Verification / deployment tRPC I/O 类型（本阶段新增，供 RuntimeTrpcContext.deploymentApi 使用）
	RuntimeConfirmVerificationCompleteRequest,
	RuntimeConfirmVerificationCompleteResponse,
	RuntimeContinueConnectionRetrySessionsRequest,
	RuntimeContinueConnectionRetrySessionsResponse,
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeDeferredRestorationHarnessNotificationsRequest,
	RuntimeDeferredRestorationHarnessNotificationsResponse,
	RuntimeDirectoryListRequest,
	RuntimeDirectoryListResponse,
	RuntimeDismissAgentRaisedPendingUserDecisionRequest,
	RuntimeDismissAgentRaisedPendingUserDecisionResponse,
	RuntimeDismissConnectionRetrySessionsRequest,
	RuntimeDismissConnectionRetrySessionsResponse,
	RuntimeFeaturebaseTokenResponse,
	RuntimeGetExplorationThreadGraphRequest,
	RuntimeGetExplorationThreadGraphResponse,
	RuntimeGetExploratoryFindingsRequest,
	RuntimeGetExploratoryFindingsResponse,
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
	RuntimeIngestExploratoryFindingCandidateRequest,
	RuntimeIngestExploratoryFindingCandidateResponse,
	RuntimeKanbanCliTaskBoardMutationRequest,
	RuntimeKanbanCliTaskBoardMutationResponse,
	RuntimeListAgentRaisedPendingUserDecisionsRequest,
	RuntimeListAgentRaisedPendingUserDecisionsResponse,
	RuntimeListAgentRaisedUserDecisionHistoryForTaskRequest,
	RuntimeListAgentRaisedUserDecisionHistoryForTaskResponse,
	RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequest,
	RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponse,
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
	RuntimeRejectExploratoryFindingRequest,
	RuntimeRejectExploratoryFindingResponse,
	RuntimeReleaseDeferredRestorationHarnessNotificationsResponse,
	RuntimeRequestExplorationThreadGraphMaintenanceRequest,
	RuntimeRequestExplorationThreadGraphMaintenanceResponse,
	RuntimeRequestVerificationCompleteRequest,
	RuntimeRequestVerificationCompleteResponse,
	RuntimeRunPostDeployVerificationItemRequest,
	RuntimeRunPostDeployVerificationItemResponse,
	RuntimeRunUpdateResponse,
	RuntimeSaveExploratoryFindingRequest,
	RuntimeSaveExploratoryFindingResponse,
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
	RuntimeTaskEditDraftsMutateRequest,
	RuntimeTaskEditDraftsReadRequest,
	RuntimeTaskEditDraftsResponse,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskNameSuggestionRequest,
	RuntimeTaskNameSuggestionResponse,
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
	RuntimeTaskWorkspaceGitStatusesResponse,
	RuntimeTaskWorkspaceInfoRequest,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTerminalAgentModelSelectionOptionsRequest,
	RuntimeTerminalAgentModelSelectionOptionsResponse,
	RuntimeTerminalInputBoxStashRequest,
	RuntimeTerminalInputBoxStashResponse,
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
	runtimeAgentSessionTransportSwitchRequestSchema,
	runtimeAgentSessionTransportSwitchResponseSchema,
	runtimeAllProjectsTaskSearchIndexResponseSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema,
	runtimeArchiveExploratoryFindingRequestSchema,
	runtimeArchiveExploratoryFindingResponseSchema,
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
	runtimeConfirmExploratoryFindingRequestSchema,
	runtimeConfirmExploratoryFindingResponseSchema,
	// Post-Deploy Verification / deployment tRPC I/O schemas（本阶段新增，供 deployment router 校验）
	runtimeConfirmVerificationCompleteRequestSchema,
	runtimeConfirmVerificationCompleteResponseSchema,
	runtimeContinueConnectionRetrySessionsRequestSchema,
	runtimeContinueConnectionRetrySessionsResponseSchema,
	runtimeConversationSessionTurnProjectionRequestSchema,
	runtimeConversationSessionTurnProjectionResponseSchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDeferredRestorationHarnessNotificationsRequestSchema,
	runtimeDeferredRestorationHarnessNotificationsResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeDismissAgentRaisedPendingUserDecisionRequestSchema,
	runtimeDismissAgentRaisedPendingUserDecisionResponseSchema,
	runtimeDismissConnectionRetrySessionsRequestSchema,
	runtimeDismissConnectionRetrySessionsResponseSchema,
	runtimeFeaturebaseTokenResponseSchema,
	runtimeGetExplorationThreadGraphRequestSchema,
	runtimeGetExplorationThreadGraphResponseSchema,
	runtimeGetExploratoryFindingsRequestSchema,
	runtimeGetExploratoryFindingsResponseSchema,
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
	runtimeIngestExploratoryFindingCandidateRequestSchema,
	runtimeIngestExploratoryFindingCandidateResponseSchema,
	runtimeKanbanCliTaskBoardMutationRequestSchema,
	runtimeKanbanCliTaskBoardMutationResponseSchema,
	runtimeListAgentRaisedPendingUserDecisionsRequestSchema,
	runtimeListAgentRaisedPendingUserDecisionsResponseSchema,
	runtimeListAgentRaisedUserDecisionHistoryForTaskRequestSchema,
	runtimeListAgentRaisedUserDecisionHistoryForTaskResponseSchema,
	runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequestSchema,
	runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponseSchema,
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
	runtimeRejectExploratoryFindingRequestSchema,
	runtimeRejectExploratoryFindingResponseSchema,
	runtimeReleaseDeferredRestorationHarnessNotificationsResponseSchema,
	runtimeRequestExplorationThreadGraphMaintenanceRequestSchema,
	runtimeRequestExplorationThreadGraphMaintenanceResponseSchema,
	runtimeRequestVerificationCompleteRequestSchema,
	runtimeRequestVerificationCompleteResponseSchema,
	runtimeRunPostDeployVerificationItemRequestSchema,
	runtimeRunPostDeployVerificationItemResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeSaveExploratoryFindingRequestSchema,
	runtimeSaveExploratoryFindingResponseSchema,
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
	runtimeTaskEditDraftsMutateRequestSchema,
	runtimeTaskEditDraftsReadRequestSchema,
	runtimeTaskEditDraftsResponseSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskNameSuggestionRequestSchema,
	runtimeTaskNameSuggestionResponseSchema,
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
	runtimeTaskWorkspaceGitStatusesResponseSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTaskWorkspaceInfoResponseSchema,
	runtimeTerminalAgentModelSelectionOptionsRequestSchema,
	runtimeTerminalAgentModelSelectionOptionsResponseSchema,
	runtimeTerminalInputBoxStashRequestSchema,
	runtimeTerminalInputBoxStashResponseSchema,
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
import {
	KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
	kanbanWebUiPageLoadRequestOriginNonceIssueResponseSchema,
	runtimeTaskIdAllocationForNewWebUiTaskCardResponseSchema,
} from "../core/kanban-web-ui-page-load-request-origin-nonce";
import {
	notificationIntelligenceSettingsResponseSchema,
	notificationIntelligenceSettingsSchema,
	saveKanbanModelProviderProfileRequestSchema,
} from "../core/notification-intelligence-settings-contract";
import {
	notificationArchiveListRequestSchema,
	notificationArchiveListResponseSchema,
	notificationCandidateLifecycleSchema,
} from "../core/notification-lifecycle-contract";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { issueKanbanWebUiPageLoadRequestOriginNonce } from "../inter-work-unit-relation-ledger/kanban-web-ui-page-load-request-origin-nonce-registry";
import {
	getNotificationIntelligenceSettings,
	saveKanbanModelProviderProfile,
	saveNotificationIntelligenceSettings,
} from "../model-provider-access/kanban-model-provider-settings";
import { getNotificationLifecycleArchive } from "../notifications/notification-lifecycle-archive";
import { redactNotificationEvidence } from "../notifications/notification-signal-capture";
import { NOTIFICATION_SPEECH_MODEL_CATALOG } from "../notifications/notification-speech-provider-catalog";
import {
	previewNotificationSpeech,
	readArchivedNotificationAudio,
	synthesizeNotificationSpeech,
} from "../notifications/notification-speech-synthesis";
import { allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	// 请求发起方的行动者证据（dd2db 1a）：CLI 调用环境声明头；1a.3 起再加页面加载 nonce。
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
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
		suggestTaskNamesFromTaskDescription: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeTaskNameSuggestionRequest,
		) => Promise<RuntimeTaskNameSuggestionResponse>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
		) => Promise<RuntimeTaskSessionStartResponse>;
		stopTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStopRequest,
		) => Promise<RuntimeTaskSessionStopResponse>;
		switchAgentSessionTransport: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAgentSessionTransportSwitchRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeAgentSessionTransportSwitchResponse>;
		transitionTaskToReview: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionTransitionToReviewRequest,
		) => Promise<RuntimeTaskSessionTransitionToReviewResponse>;
		listAgentRaisedPendingUserDecisions: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeListAgentRaisedPendingUserDecisionsRequest,
		) => Promise<RuntimeListAgentRaisedPendingUserDecisionsResponse>;
		listAgentRaisedUserDecisionHistoryForTask: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeListAgentRaisedUserDecisionHistoryForTaskRequest,
		) => Promise<RuntimeListAgentRaisedUserDecisionHistoryForTaskResponse>;
		answerAgentRaisedPendingUserDecision: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
		) => Promise<RuntimeAnswerAgentRaisedPendingUserDecisionResponse>;
		dismissAgentRaisedPendingUserDecision: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDismissAgentRaisedPendingUserDecisionRequest,
		) => Promise<RuntimeDismissAgentRaisedPendingUserDecisionResponse>;
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
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskChatSendResponse>;
		getDeferredRestorationHarnessNotifications: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDeferredRestorationHarnessNotificationsRequest,
		) => Promise<RuntimeDeferredRestorationHarnessNotificationsResponse>;
		releaseDeferredRestorationHarnessNotificationsIntoTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeDeferredRestorationHarnessNotificationsRequest,
		) => Promise<RuntimeReleaseDeferredRestorationHarnessNotificationsResponse>;
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
		getWorkspaceTaskEditDrafts: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskEditDraftsReadRequest,
		) => Promise<RuntimeTaskEditDraftsResponse>;
		mutateWorkspaceTaskEditDrafts: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskEditDraftsMutateRequest,
		) => Promise<RuntimeTaskEditDraftsResponse>;
		stashTerminalInputBoxToPromptLibrary: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTerminalInputBoxStashRequest,
		) => Promise<RuntimeTerminalInputBoxStashResponse>;
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
		broadcastNotificationArchiveChanged?: () => Promise<void>;
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
		loadTaskWorkspaceGitStatuses: (
			scope: RuntimeTrpcWorkspaceScope,
		) => Promise<RuntimeTaskWorkspaceGitStatusesResponse>;
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
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeWorkspaceStateResponse>;
		addBacklogTask: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAddBacklogTaskRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeAddBacklogTaskResponse>;
		// dd2db 1a.2b：`kanban task` 的 board 写动词统一入口（见 api-contract 的 runtimeKanbanCliTaskBoardMutationRequestSchema）。
		applyKanbanCliTaskBoardMutation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeKanbanCliTaskBoardMutationRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeKanbanCliTaskBoardMutationResponse>;
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
		markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequest,
		) => Promise<RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponse>;
	};
	conversationTreeApi: {
		getConversationSessionTurnProjection: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConversationSessionTurnProjectionRequest,
		) => Promise<RuntimeConversationSessionTurnProjectionResponse>;
	};
	exploratoryApi: {
		getFindings: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetExploratoryFindingsRequest,
		) => Promise<RuntimeGetExploratoryFindingsResponse>;
		saveFinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSaveExploratoryFindingRequest,
		) => Promise<RuntimeSaveExploratoryFindingResponse>;
		confirmFinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConfirmExploratoryFindingRequest,
		) => Promise<RuntimeConfirmExploratoryFindingResponse>;
		rejectFinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRejectExploratoryFindingRequest,
		) => Promise<RuntimeRejectExploratoryFindingResponse>;
		archiveFinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeArchiveExploratoryFindingRequest,
		) => Promise<RuntimeArchiveExploratoryFindingResponse>;
		ingestFindingCandidate: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeIngestExploratoryFindingCandidateRequest,
		) => Promise<RuntimeIngestExploratoryFindingCandidateResponse>;
		getExplorationThreadGraph: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetExplorationThreadGraphRequest,
		) => Promise<RuntimeGetExplorationThreadGraphResponse>;
		requestExplorationThreadGraphMaintenance: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRequestExplorationThreadGraphMaintenanceRequest,
		) => Promise<RuntimeRequestExplorationThreadGraphMaintenanceResponse>;
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

// 带了 runtime 不认识的页面加载 nonce 的请求一律拒绝（可重试，Y-EVENT-9）：继续执行就会把一个页面请求记成
// 裸 tRPC 调用方，而 live 事件写入后不能改写。签发 nonce 的 procedure 本身不过这道闸（它就是重取的入口）。
const procedureRejectingUnknownWebUiPageLoadRequestOriginNonce = t.procedure.use(({ ctx, next }) => {
	if (ctx.kanbanRequestOriginActorEvidence.webUiPageLoadRequestOriginNonceVerificationStatus === "unknown") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
		});
	}
	return next();
});

const workspaceProcedure = procedureRejectingUnknownWebUiPageLoadRequestOriginNonce.use(({ ctx, next }) => {
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
	notificationIntelligence: t.router({
		getSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(notificationIntelligenceSettingsResponseSchema)
			.query(() => getNotificationIntelligenceSettings()),
		saveSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(notificationIntelligenceSettingsSchema)
			.mutation(async ({ input }) => {
				await saveNotificationIntelligenceSettings(input);
				return { ok: true };
			}),
		saveProvider: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(saveKanbanModelProviderProfileRequestSchema)
			.mutation(async ({ input }) => {
				await saveKanbanModelProviderProfile(input);
				return { ok: true };
			}),
		speechModels: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce.query(
			() => NOTIFICATION_SPEECH_MODEL_CATALOG,
		),
		markAllArchivedNotificationsVisited: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ includeCompletedTasks: z.boolean() }))
			.mutation(async ({ input, ctx }) => {
				const changedCount = await getNotificationLifecycleArchive().markAllVisited(input.includeCompletedTasks);
				await ctx.runtimeApi.broadcastNotificationArchiveChanged?.();
				return { changedCount };
			}),
		clearAllNotificationPanels: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce.mutation(async ({ ctx }) => {
			const changedCount = await getNotificationLifecycleArchive().clearAllPanels();
			await ctx.runtimeApi.broadcastNotificationArchiveChanged?.();
			return { changedCount };
		}),
		listPanelTaskGroups: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(notificationArchiveListRequestSchema)
			.output(notificationArchiveListResponseSchema)
			.query(({ input }) => getNotificationLifecycleArchive().panelGroups(input)),
		listArchive: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(notificationArchiveListRequestSchema)
			.output(notificationArchiveListResponseSchema)
			.query(({ input }) => getNotificationLifecycleArchive().list(input)),
		getLifecycle: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ candidateId: z.string() }))
			.output(notificationCandidateLifecycleSchema.nullable())
			.query(({ input }) => getNotificationLifecycleArchive().get(input.candidateId)),
		claimDelivery: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ candidateId: z.string(), clientId: z.string().max(100) }))
			.mutation(async ({ input }) => ({
				claimed: await getNotificationLifecycleArchive().claimDelivery(input.candidateId, input.clientId),
			})),
		recordClientFilter: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(
				z.object({
					candidateId: z.string(),
					clientId: z.string().max(100),
					reason: z.enum([
						"notifications_disabled",
						"foreground_visible",
						"visible_peer_tab",
						"eligible",
						"stale",
					]),
				}),
			)
			.mutation(async ({ input }) => {
				await getNotificationLifecycleArchive().update(
					input.candidateId,
					{},
					"client_notification_policy_decided",
					input,
				);
				return { ok: true };
			}),
		recordClientObservation: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(
				z.object({
					candidateId: z.string(),
					clientId: z.string().max(100),
					observation: z.enum([
						"desktop_accepted",
						"desktop_blocked",
						"speech_started",
						"sound_disabled",
						"chime_requested",
						"speech_chime_fallback_requested",
						"speech_ended",
						"speech_failed",
						"speech_stale_skipped",
						"browser_speech_has_no_audio_export",
					]),
					detail: z.string().max(1000).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const archive = getNotificationLifecycleArchive();
				if ((await archive.get(input.candidateId))?.candidate.deliveryClaimedBy !== input.clientId)
					throw new TRPCError({ code: "FORBIDDEN" });
				await archive.update(
					input.candidateId,
					{},
					`client_${input.observation}`,
					redactNotificationEvidence(input),
				);
				return { ok: true };
			}),
		synthesizeSpeech: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ candidateId: z.string(), clientId: z.string().max(100), retry: z.boolean().optional() }))
			.mutation(({ input }) => synthesizeNotificationSpeech(input)),
		retryArchivedSpeech: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ candidateId: z.string() }))
			.mutation(({ input }) =>
				synthesizeNotificationSpeech({ candidateId: input.candidateId, preview: true, retry: true }),
			),
		previewSpeech: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce.mutation(() =>
			previewNotificationSpeech(),
		),
		archivedAudio: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(z.object({ candidateId: z.string() }))
			.query(({ input }) => readArchivedNotificationAudio(input.candidateId)),
	}),
	runtime: t.router({
		// Web UI 在 runtime-state-stream 每次连上 / 重连时调用；带着失效 nonce 也能调（它就是重取入口）。
		issueKanbanWebUiPageLoadRequestOriginNonce: t.procedure
			.output(kanbanWebUiPageLoadRequestOriginNonceIssueResponseSchema)
			.mutation(() => ({
				kanbanWebUiPageLoadIssuedRequestOriginNonce: issueKanbanWebUiPageLoadRequestOriginNonce(),
			})),
		getConfig: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeConfigResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.loadConfig(ctx.workspaceScope);
			}),
		saveConfig: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeConfigSaveRequestSchema)
			.output(runtimeConfigResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveConfig(ctx.workspaceScope, input);
			}),
		saveClineProviderSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineProviderSettingsSaveRequestSchema)
			.output(runtimeClineProviderSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineProviderSettings(ctx.workspaceScope, input);
			}),
		addClineProvider: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineAddProviderRequestSchema)
			.output(runtimeClineAddProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.addClineProvider(ctx.workspaceScope, input);
			}),
		updateClineProvider: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineUpdateProviderRequestSchema)
			.output(runtimeClineUpdateProviderResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.updateClineProvider(ctx.workspaceScope, input);
			}),
		// mutation 而非 query：每次点「起名」都要真发一次外部请求拿一组**新**候选，被查询缓存去重掉
		// 就实现不了「再按一次再给三个」。
		suggestTaskNamesFromTaskDescription: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeTaskNameSuggestionRequestSchema)
			.output(runtimeTaskNameSuggestionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.suggestTaskNamesFromTaskDescription(ctx.workspaceScope, input);
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
		// 停掉当前 agent 会话并立刻用另一条通话通道续跑同一段对话（目前只有 omp 有第二条通道）。
		// 失败时会话停在已停止、如实报错，不回滚也不降级——见响应 schema 的注释。
		switchAgentSessionTransport: workspaceProcedure
			.input(runtimeAgentSessionTransportSwitchRequestSchema)
			.output(runtimeAgentSessionTransportSwitchResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.switchAgentSessionTransport(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
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
			.input(runtimeListAgentRaisedPendingUserDecisionsRequestSchema)
			.output(runtimeListAgentRaisedPendingUserDecisionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.listAgentRaisedPendingUserDecisions(ctx.workspaceScope, input);
			}),
		// 问答记录：已了结的提问与答案（面板作答 / 终端作答含备注 / 放弃 / 被新问题取代）。
		listAgentRaisedUserDecisionHistoryForTask: workspaceProcedure
			.input(runtimeListAgentRaisedUserDecisionHistoryForTaskRequestSchema)
			.output(runtimeListAgentRaisedUserDecisionHistoryForTaskResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.listAgentRaisedUserDecisionHistoryForTask(ctx.workspaceScope, input);
			}),
		answerAgentRaisedPendingUserDecision: workspaceProcedure
			.input(runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema)
			.output(runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.answerAgentRaisedPendingUserDecision(ctx.workspaceScope, input);
			}),
		dismissAgentRaisedPendingUserDecision: workspaceProcedure
			.input(runtimeDismissAgentRaisedPendingUserDecisionRequestSchema)
			.output(runtimeDismissAgentRaisedPendingUserDecisionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.dismissAgentRaisedPendingUserDecision(ctx.workspaceScope, input);
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
		getClineSlashCommands: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeSlashCommandsResponseSchema)
			.query(async ({ ctx }) => {
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
				return await ctx.runtimeApi.sendTaskChatMessage(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		getDeferredRestorationHarnessNotifications: workspaceProcedure
			.input(runtimeDeferredRestorationHarnessNotificationsRequestSchema)
			.output(runtimeDeferredRestorationHarnessNotificationsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getDeferredRestorationHarnessNotifications(ctx.workspaceScope, input);
			}),
		releaseDeferredRestorationHarnessNotificationsIntoTaskSession: workspaceProcedure
			.input(runtimeDeferredRestorationHarnessNotificationsRequestSchema)
			.output(runtimeReleaseDeferredRestorationHarnessNotificationsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.releaseDeferredRestorationHarnessNotificationsIntoTaskSession(
					ctx.workspaceScope,
					input,
				);
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
		getWorkspaceTaskEditDrafts: workspaceProcedure
			.input(runtimeTaskEditDraftsReadRequestSchema)
			.output(runtimeTaskEditDraftsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getWorkspaceTaskEditDrafts(ctx.workspaceScope, input);
			}),
		mutateWorkspaceTaskEditDrafts: workspaceProcedure
			.input(runtimeTaskEditDraftsMutateRequestSchema)
			.output(runtimeTaskEditDraftsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.mutateWorkspaceTaskEditDrafts(ctx.workspaceScope, input);
			}),
		// 读框 → 回填折叠粘贴 → 写库 → 转发 Ctrl+S 清框，一次请求走完整条链。
		// 前端只拦按键、不碰内容：同一份易随 agent 版本漂移的 TUI 画法知识只在服务端存一份。
		stashTerminalInputBoxToPromptLibrary: workspaceProcedure
			.input(runtimeTerminalInputBoxStashRequestSchema)
			.output(runtimeTerminalInputBoxStashResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.stashTerminalInputBoxToPromptLibrary(ctx.workspaceScope, input);
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
		getClineProviderCatalog: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineProviderCatalogResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineProviderCatalog(ctx.workspaceScope);
			}),
		getClineAccountProfile: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineAccountProfileResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineAccountProfile(ctx.workspaceScope);
			}),
		getClineKanbanAccess: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineKanbanAccessResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineKanbanAccess(ctx.workspaceScope);
			}),
		getFeaturebaseToken: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeFeaturebaseTokenResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getFeaturebaseToken(ctx.workspaceScope);
			}),
		getClineAccountBalance: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineAccountBalanceResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineAccountBalance(ctx.workspaceScope);
			}),
		getClineAccountOrganizations: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineAccountOrganizationsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineAccountOrganizations(ctx.workspaceScope);
			}),
		switchClineAccount: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineAccountSwitchRequestSchema)
			.output(runtimeClineAccountSwitchResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.switchClineAccount(ctx.workspaceScope, input);
			}),
		getClineProviderModels: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineProviderModelsRequestSchema)
			.output(runtimeClineProviderModelsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getClineProviderModels(ctx.workspaceScope, input);
			}),
		getTerminalAgentModelSelectionOptions: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeTerminalAgentModelSelectionOptionsRequestSchema)
			.output(runtimeTerminalAgentModelSelectionOptionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTerminalAgentModelSelectionOptions(ctx.workspaceScope, input);
			}),
		getAvailableAgentSessions: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeAvailableAgentSessionsRequestSchema)
			.output(runtimeAvailableAgentSessionsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getAvailableAgentSessions(ctx.workspaceScope, input);
			}),
		getClineMcpAuthStatuses: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineMcpAuthStatusResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineMcpAuthStatuses(ctx.workspaceScope);
			}),
		runClineMcpServerOAuth: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineMcpOAuthRequestSchema)
			.output(runtimeClineMcpOAuthResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineMcpServerOAuth(ctx.workspaceScope, input);
			}),
		getClineMcpSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineMcpSettingsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getClineMcpSettings(ctx.workspaceScope);
			}),
		saveClineMcpSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineMcpSettingsSaveRequestSchema)
			.output(runtimeClineMcpSettingsSaveResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveClineMcpSettings(ctx.workspaceScope, input);
			}),
		runClineProviderOAuthLogin: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeClineOauthLoginRequestSchema)
			.output(runtimeClineOauthLoginResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.runClineProviderOAuthLogin(ctx.workspaceScope, input);
			}),
		startClineDeviceAuth: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeClineDeviceAuthStartResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.runtimeApi.startClineDeviceAuth(ctx.workspaceScope);
			}),
		completeClineDeviceAuth: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
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
		resetAllState: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeDebugResetAllStateResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.runtimeApi.resetAllState(ctx.workspaceScope);
			}),
		openFile: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeOpenFileRequestSchema)
			.output(runtimeOpenFileResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.openFile(input);
			}),
		getUpdateStatus: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeUpdateStatusResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.runtimeApi.getUpdateStatus(ctx.workspaceScope);
			}),
		runUpdateNow: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeRunUpdateResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.runtimeApi.runUpdateNow(ctx.workspaceScope);
			}),
		// 通知中心 mutation：跨 repo，用 input.workspaceId（非连接 scope）。procedureRejectingUnknownWebUiPageLoadRequestOriginNonce 不强制 workspace scope。
		markTaskNotificationsVisited: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeNotificationMarkVisitedRequestSchema)
			.output(runtimeNotificationMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.markTaskNotificationsVisited(ctx.workspaceScope, input);
			}),
		clearNotificationLog: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeNotificationClearRequestSchema)
			.output(runtimeNotificationMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.clearNotificationLog(ctx.workspaceScope, input);
			}),
	}),
	workspace: t.router({
		allocateTaskIdForNewWebUiTaskCard: workspaceProcedure
			.output(runtimeTaskIdAllocationForNewWebUiTaskCardResponseSchema)
			.mutation(async ({ ctx }) => ({
				allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry:
					await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
						requestingWorkspaceId: ctx.workspaceScope.workspaceId,
					}),
			})),
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
		getTaskWorkspaceGitStatuses: workspaceProcedure
			.output(runtimeTaskWorkspaceGitStatusesResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.workspaceApi.loadTaskWorkspaceGitStatuses(ctx.workspaceScope);
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
				return await ctx.workspaceApi.saveState(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence);
			}),
		addBacklogTask: workspaceProcedure
			.input(runtimeAddBacklogTaskRequestSchema)
			.output(runtimeAddBacklogTaskResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.addBacklogTask(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		// CLI 的 board 写动词（create / update / start 移列 / trash / delete）只经这里落盘：runtime 按请求头的
		// CLI 行动者声明解析行动者后进入持久化漏斗。runtime 离线时 CLI 直接报错，不回退直接写盘（dd2db 1a.2b）。
		applyKanbanCliTaskBoardMutation: workspaceProcedure
			.input(runtimeKanbanCliTaskBoardMutationRequestSchema)
			.output(runtimeKanbanCliTaskBoardMutationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.applyKanbanCliTaskBoardMutation(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
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
		list: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeProjectsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.projectsApi.listProjects(ctx.requestedWorkspaceId);
			}),
		add: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeProjectAddRequestSchema)
			.output(runtimeProjectAddResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input);
			}),
		getPermanentDeletionPreview: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeProjectPermanentDeletionPreviewRequestSchema)
			.output(runtimeProjectPermanentDeletionPreviewResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.getPermanentDeletionPreview(ctx.requestedWorkspaceId, input);
			}),
		permanentlyDeleteProjectData: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeProjectPermanentDeletionRequestSchema)
			.output(runtimeProjectPermanentDeletionResultSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.permanentlyDeleteProjectData(ctx.requestedWorkspaceId, input);
			}),
		pickDirectory: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeProjectDirectoryPickerResponseSchema)
			.mutation(async ({ ctx }) => {
				return await ctx.projectsApi.pickProjectDirectory(ctx.requestedWorkspaceId);
			}),
		listDirectoryContents: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeDirectoryListRequestSchema)
			.output(runtimeDirectoryListResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.projectsApi.listDirectoryContents(ctx.requestedWorkspaceId, input);
			}),
		// 跨全部注册项目的任务搜索索引：非 workspace-scoped（procedureRejectingUnknownWebUiPageLoadRequestOriginNonce，忽略连接 scope），供 Spotlight
		// 「包含其它项目」按需拉取。
		getAllProjectsTaskSearchIndex: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(runtimeAllProjectsTaskSearchIndexResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.projectsApi.getAllProjectsTaskSearchIndex();
			}),
	}),
	hooks: t.router({
		ingest: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
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
		markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone: workspaceProcedure
			.input(runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequestSchema)
			.output(runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.deploymentApi.markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone(
					ctx.workspaceScope,
					input,
				);
			}),
	}),
	conversationTree: t.router({
		// 会话 turn 投影（只读派生层，姊妹蓝图 §2.2）：findings 出处锚与（远期）会话树共享同一
		// 数据源。M0 只接 Cline SDK 源，其余 transport 按 session 粒度降级。
		getConversationSessionTurnProjection: workspaceProcedure
			.input(runtimeConversationSessionTurnProjectionRequestSchema)
			.output(runtimeConversationSessionTurnProjectionResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.conversationTreeApi.getConversationSessionTurnProjection(ctx.workspaceScope, input);
			}),
	}),
	exploratory: t.router({
		// workspace 级 findings 全量读取（集合恒小，上限 500；蓝图 §D.3）。
		getFindings: workspaceProcedure
			.input(runtimeGetExploratoryFindingsRequestSchema)
			.output(runtimeGetExploratoryFindingsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.getFindings(ctx.workspaceScope, input);
			}),
		// 人工保存主路径（蓝图 §D.2.1）：落库即 active + user_saved；同 findingId 幂等。
		saveFinding: workspaceProcedure
			.input(runtimeSaveExploratoryFindingRequestSchema)
			.output(runtimeSaveExploratoryFindingResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.saveFinding(ctx.workspaceScope, input);
			}),
		// pending 建议确认 → active（蓝图 §D.2.2）；状态机违规报错，不存在 id 幂等回 null。
		confirmFinding: workspaceProcedure
			.input(runtimeConfirmExploratoryFindingRequestSchema)
			.output(runtimeConfirmExploratoryFindingResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.confirmFinding(ctx.workspaceScope, input);
			}),
		// pending 建议拒绝 → 物理删除（尚未成为资产，蓝图 §D.2.2）。
		rejectFinding: workspaceProcedure
			.input(runtimeRejectExploratoryFindingRequestSchema)
			.output(runtimeRejectExploratoryFindingResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.rejectFinding(ctx.workspaceScope, input);
			}),
		// active ↔ archived 软删/恢复；pending/superseded 不可 archive（状态机违规报错）。
		archiveFinding: workspaceProcedure
			.input(runtimeArchiveExploratoryFindingRequestSchema)
			.output(runtimeArchiveExploratoryFindingResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.archiveFinding(ctx.workspaceScope, input);
			}),
		// agent 建议通道（蓝图 §D.2.2）：落库即 suggested_pending_confirmation + agent_suggested，
		// provenance 可解析性校验在 handler 完成；durable 落盘后广播 exploratory_findings_updated。
		ingestFindingCandidate: workspaceProcedure
			.input(runtimeIngestExploratoryFindingCandidateRequestSchema)
			.output(runtimeIngestExploratoryFindingCandidateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.ingestFindingCandidate(ctx.workspaceScope, input);
			}),
		// exploration thread graph（B.2）：读图是 query（免费），维护是 mutation（会 fork，花钱）。
		getExplorationThreadGraph: workspaceProcedure
			.input(runtimeGetExplorationThreadGraphRequestSchema)
			.output(runtimeGetExplorationThreadGraphResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.getExplorationThreadGraph(ctx.workspaceScope, input);
			}),
		requestExplorationThreadGraphMaintenance: workspaceProcedure
			.input(runtimeRequestExplorationThreadGraphMaintenanceRequestSchema)
			.output(runtimeRequestExplorationThreadGraphMaintenanceResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.exploratoryApi.requestExplorationThreadGraphMaintenance(ctx.workspaceScope, input);
			}),
	}),
});

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
