// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type {
	RuntimeAddBacklogTaskRequest,
	RuntimeAddBacklogTaskResponse,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse,
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
	RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse,
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
	RuntimeListDeferredNaturalUsageObservationRecordsResponse,
	RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse,
	RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequest,
	RuntimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponse,
	RuntimeNotificationClearRequest,
	RuntimeNotificationMarkVisitedRequest,
	RuntimeNotificationMutationResponse,
	RuntimeOpenFileRequest,
	RuntimeOpenFileResponse,
	RuntimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequest,
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
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
	RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse,
	RuntimeRecordTaskOpenedByUserRequest,
	RuntimeRecordTaskOpenedByUserResponse,
	RuntimeRejectExploratoryFindingRequest,
	RuntimeRejectExploratoryFindingResponse,
	RuntimeReleaseDeferredRestorationHarnessNotificationsResponse,
	RuntimeRenameCurrentTaskRequest,
	RuntimeRequestExplorationThreadGraphMaintenanceRequest,
	RuntimeRequestExplorationThreadGraphMaintenanceResponse,
	RuntimeRequestVerificationCompleteRequest,
	RuntimeRequestVerificationCompleteResponse,
	RuntimeRunPostDeployVerificationItemRequest,
	RuntimeRunPostDeployVerificationItemResponse,
	RuntimeRunUpdateResponse,
	RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest,
	RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse,
	RuntimeSaveExploratoryFindingRequest,
	RuntimeSaveExploratoryFindingResponse,
	RuntimeSetCurrentWorkPhaseGoalRequest,
	RuntimeShellSessionStartRequest,
	RuntimeShellSessionStartResponse,
	RuntimeSlashCommandsResponse,
	RuntimeTaskAgentUserDecisionResolveRequest,
	RuntimeTaskAgentUserDecisionResolveResponse,
	RuntimeTaskCardActionMoveBetweenNonTrashColumnsRequest,
	RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse,
	RuntimeTaskCardActionMoveIntoDoneRequest,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskCardActionMoveIntoReviewRequest,
	RuntimeTaskCardActionMoveIntoReviewResponse,
	RuntimeTaskCardActionPermanentlyDeleteRequest,
	RuntimeTaskCardActionPermanentlyDeleteResponse,
	RuntimeTaskCardActionReadTaskCardWithBoardColumnRequest,
	RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse,
	RuntimeTaskCardActionRestoreFromDoneRequest,
	RuntimeTaskCardActionRestoreFromDoneResponse,
	RuntimeTaskCardActionSetTaskPinboardPinStateRequest,
	RuntimeTaskCardActionSetTaskPinboardPinStateResponse,
	RuntimeTaskCardActionStartAgentSessionRequest,
	RuntimeTaskCardActionStartAgentSessionResponse,
	RuntimeTaskCardActionUpdateFieldValuesRequest,
	RuntimeTaskCardActionUpdateFieldValuesResponse,
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
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskEditDraftsMutateRequest,
	RuntimeTaskEditDraftsReadRequest,
	RuntimeTaskEditDraftsResponse,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskNameSuggestionRequest,
	RuntimeTaskNameSuggestionResponse,
	RuntimeTaskParkAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskParkAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskPromptDeliveryQueueMutateRequest,
	RuntimeTaskPromptDeliveryQueueMutateResponse,
	RuntimeTaskPromptDeliveryQueueReadRequest,
	RuntimeTaskPromptDeliveryQueueResponse,
	RuntimeTaskRetainedCommittedLineChangeHistory,
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
	runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequestSchema,
	runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponseSchema,
	runtimeAgentPromptImageAttachmentReferenceSchema,
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
	runtimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponseSchema,
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
	runtimeListDeferredNaturalUsageObservationRecordsResponseSchema,
	runtimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponseSchema,
	runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneRequestSchema,
	runtimeMarkPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDoneResponseSchema,
	runtimeNotificationClearRequestSchema,
	runtimeNotificationMarkVisitedRequestSchema,
	runtimeNotificationMutationResponseSchema,
	runtimeOpenFileRequestSchema,
	runtimeOpenFileResponseSchema,
	runtimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequestSchema,
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
	runtimeReadAgentPromptImageAttachmentsRequestSchema,
	runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema,
	runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponseSchema,
	runtimeRecordTaskOpenedByUserRequestSchema,
	runtimeRecordTaskOpenedByUserResponseSchema,
	runtimeRejectExploratoryFindingRequestSchema,
	runtimeRejectExploratoryFindingResponseSchema,
	runtimeReleaseDeferredRestorationHarnessNotificationsResponseSchema,
	runtimeRenameCurrentTaskRequestSchema,
	runtimeRequestExplorationThreadGraphMaintenanceRequestSchema,
	runtimeRequestExplorationThreadGraphMaintenanceResponseSchema,
	runtimeRequestVerificationCompleteRequestSchema,
	runtimeRequestVerificationCompleteResponseSchema,
	runtimeRunPostDeployVerificationItemRequestSchema,
	runtimeRunPostDeployVerificationItemResponseSchema,
	runtimeRunUpdateResponseSchema,
	runtimeSaveAgentPromptImageAttachmentsRequestSchema,
	runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequestSchema,
	runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponseSchema,
	runtimeSaveExploratoryFindingRequestSchema,
	runtimeSaveExploratoryFindingResponseSchema,
	runtimeSetCurrentWorkPhaseGoalRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeSlashCommandsResponseSchema,
	runtimeTaskAgentUserDecisionResolveRequestSchema,
	runtimeTaskAgentUserDecisionResolveResponseSchema,
	runtimeTaskCardActionMoveBetweenNonTrashColumnsRequestSchema,
	runtimeTaskCardActionMoveBetweenNonTrashColumnsResponseSchema,
	runtimeTaskCardActionMoveIntoDoneRequestSchema,
	runtimeTaskCardActionMoveIntoDoneResponseSchema,
	runtimeTaskCardActionMoveIntoReviewRequestSchema,
	runtimeTaskCardActionMoveIntoReviewResponseSchema,
	runtimeTaskCardActionPermanentlyDeleteRequestSchema,
	runtimeTaskCardActionPermanentlyDeleteResponseSchema,
	runtimeTaskCardActionReadTaskCardWithBoardColumnRequestSchema,
	runtimeTaskCardActionReadTaskCardWithBoardColumnResponseSchema,
	runtimeTaskCardActionRestoreFromDoneRequestSchema,
	runtimeTaskCardActionRestoreFromDoneResponseSchema,
	runtimeTaskCardActionSetTaskPinboardPinStateRequestSchema,
	runtimeTaskCardActionSetTaskPinboardPinStateResponseSchema,
	runtimeTaskCardActionStartAgentSessionRequestSchema,
	runtimeTaskCardActionStartAgentSessionResponseSchema,
	runtimeTaskCardActionUpdateFieldValuesRequestSchema,
	runtimeTaskCardActionUpdateFieldValuesResponseSchema,
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
	runtimeTaskConversationHistoryPageRequestSchema,
	runtimeTaskConversationHistoryPageResponseSchema,
	runtimeTaskEditDraftsMutateRequestSchema,
	runtimeTaskEditDraftsReadRequestSchema,
	runtimeTaskEditDraftsResponseSchema,
	runtimeTaskImageSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskNameSuggestionRequestSchema,
	runtimeTaskNameSuggestionResponseSchema,
	runtimeTaskParkAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskParkAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskPromptDeliveryQueueMutateRequestSchema,
	runtimeTaskPromptDeliveryQueueMutateResponseSchema,
	runtimeTaskPromptDeliveryQueueReadRequestSchema,
	runtimeTaskPromptDeliveryQueueResponseSchema,
	runtimeTaskRetainedCommittedLineChangeHistorySchema,
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
	rvfAutomaticCloseoutExecutionResultReportRequestSchema,
	rvfAutomaticCloseoutExecutionResultReportResponseSchema,
	rvfAutomaticCloseoutRunBindingActivationRequestSchema,
	rvfAutomaticCloseoutRunBindingActivationResponseSchema,
	rvfAutomaticCloseoutStatusRequestSchema,
	rvfAutomaticCloseoutStatusResponseSchema,
	rvfReviewStartBoundaryObservationRequestSchema,
	rvfReviewStartBoundaryObservationResponseSchema,
	rvfReviewStartBoundaryRequestSchema,
	rvfReviewStartBoundaryResponseSchema,
} from "../core/api-contract";
import {
	independentTaskCreationDraftEditSchema,
	independentTaskCreationDraftRequestSchema,
	independentTaskCreationDraftSchema,
	independentTaskCreationListRequestSchema,
	independentTaskCreationListResponseSchema,
} from "../core/independent-task-creation-contract";
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
import {
	type ListPermanentlyDeletedTaskCardsRequest,
	type ListPermanentlyDeletedTaskCardsResponse,
	listPermanentlyDeletedTaskCardsRequestSchema,
	listPermanentlyDeletedTaskCardsResponseSchema,
	type PermanentlyDeletedTaskPromptVersionsRequest,
	type PermanentlyDeletedTaskPromptVersionsResponse,
	permanentlyDeletedTaskPromptVersionsRequestSchema,
	permanentlyDeletedTaskPromptVersionsResponseSchema,
} from "../core/permanently-deleted-task-history-contract";
import {
	type ProjectVisualIdentity,
	projectVisualIdentitySchema,
	readProjectIconImageRequestSchema,
	readProjectIconImageResponseSchema,
	resetProjectVisualIdentityRequestSchema,
	type SetProjectVisualIdentityRequest,
	setProjectVisualIdentityRequestSchema,
} from "../core/project-visual-identity";
import {
	appendTaskCommentRequestSchema,
	appendTaskCommentResponseSchema,
	IncomingWorkItemTriageOperationError,
	incomingWorkItemSchema,
	incomingWorkItemTriageResponseSchema,
	sharedTaskIndexingContextSchema,
	taskIndexingSupportExecutorSettingsSchema,
} from "../core/task-indexing-support-contract";
import {
	createTaskLookupConversationRequestSchema,
	submitTaskLookupTurnRequestSchema,
	taskLookupCandidatePreviewRequestSchema,
	taskLookupCandidatePreviewSchema,
	taskLookupConversationIdentitySchema,
	taskLookupConversationSchema,
} from "../core/task-lookup-conversation-contract";
import type {
	TaskMainSessionHandoverPrepareResponse,
	TaskMainSessionHandoverRecord,
	TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
	TaskMainSessionHandoverRequest,
	TaskMainSessionHandoverStatusResponse,
} from "../core/task-main-session-handover-contract";
import {
	taskMainSessionHandoverPrepareRequestSchema,
	taskMainSessionHandoverPrepareResponseSchema,
	taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema,
	taskMainSessionHandoverRequestSchema,
	taskMainSessionHandoverStatusResponseSchema,
} from "../core/task-main-session-handover-contract";
import {
	type AssertReferenceRelationAsActingWorkUnitRequest,
	type AssertReferenceRelationDirectlyAsWebUiUserRequest,
	assertReferenceRelationAsActingWorkUnitRequestSchema,
	assertReferenceRelationDirectlyAsWebUiUserRequestSchema,
	type InterWorkUnitRelationAssertionWriteResponse,
	interWorkUnitRelationAssertionWriteResponseSchema,
	type RevokeEffectiveRelationAssertionAsActingWorkUnitRequest,
	type RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest,
	revokeEffectiveRelationAssertionAsActingWorkUnitRequestSchema,
	revokeEffectiveRelationAssertionDirectlyAsWebUiUserRequestSchema,
} from "../core/work-unit-relation-assertion-write-api-contract";
import {
	type ApplyReferenceRelationModelingChangesRequest,
	type ApplyReferenceRelationModelingChangesResponse,
	applyReferenceRelationModelingChangesRequestSchema,
	applyReferenceRelationModelingChangesResponseSchema,
	type ReferenceRelationModelingEditorDraft,
	type ReferenceRelationModelingSuggestionsRequest,
	type RelationModelingPreviewRequest,
	type RelationModelingPreviewResponse,
	referenceRelationModelingEditorDraftSchema,
	referenceRelationModelingSuggestionsRequestSchema,
	referenceRelationModelingSuggestionsResponseSchema,
	relationModelingEditorDraftReadRequestSchema,
	relationModelingEditorDraftSaveRequestSchema,
	relationModelingPreviewRequestSchema,
	relationModelingPreviewResponseSchema,
} from "../core/work-unit-relation-modeling-api-contract";
import {
	type GetRelationNeighborhoodSummaryRequest,
	type GetRelationNeighborhoodSummaryResponse,
	type GetWorkUnitContextRequest,
	type GetWorkUnitContextResponse,
	getRelationNeighborhoodSummaryRequestSchema,
	getRelationNeighborhoodSummaryResponseSchema,
	getWorkUnitContextRequestSchema,
	getWorkUnitContextResponseSchema,
	type ListConversationSessionOwnershipPeriodsRequest,
	type ListConversationSessionOwnershipPeriodsResponse,
	listConversationSessionOwnershipPeriodsRequestSchema,
	listConversationSessionOwnershipPeriodsResponseSchema,
	type ResolveKanbanBoardCardIdentityByBareTaskIdRequest,
	type ResolveKanbanBoardCardIdentityByBareTaskIdResponse,
	resolveKanbanBoardCardIdentityByBareTaskIdRequestSchema,
	resolveKanbanBoardCardIdentityByBareTaskIdResponseSchema,
	type SetRecordedRelationPresentationMutePreferenceRequest,
	type SetRecordedRelationPresentationMutePreferenceResponse,
	setRecordedRelationPresentationMutePreferenceRequestSchema,
	setRecordedRelationPresentationMutePreferenceResponseSchema,
} from "../core/work-unit-relation-read-api-contract";
import type { IndependentTaskCreationService } from "../independent-task-creation/independent-task-creation-service";
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
import { RvfAutomaticCloseoutExecutionResultDeliveryPendingError } from "../rvf-automatic-closeout/validate-rvf-automatic-closeout-execution-result";
import {
	readPersistentAgentPromptImageAttachments,
	savePersistentAgentPromptImageAttachments,
} from "../state/persistent-agent-prompt-image-attachments";
import { allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import type { TaskIndexingSupportRuntimeService } from "../task-indexing-support/task-indexing-support-runtime-service";
import type { TaskLookupConversationService } from "../task-indexing-support/task-lookup-conversation-service";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	taskLookupConversationApi?: TaskLookupConversationService;
	taskIndexingSupportApi?: TaskIndexingSupportRuntimeService;
	independentTaskCreationApi?: IndependentTaskCreationService;
	taskMainSessionHandoverApi?: {
		prepare: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string },
		) => Promise<TaskMainSessionHandoverPrepareResponse>;
		request: (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRequest,
			evidence?: KanbanRequestOriginActorEvidence,
		) => Promise<{ record: TaskMainSessionHandoverRecord | null }>;
		getStatus: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string },
		) => Promise<TaskMainSessionHandoverStatusResponse>;
		recoverWithNewCodexSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
			evidence?: KanbanRequestOriginActorEvidence,
		) => Promise<TaskMainSessionHandoverStatusResponse>;
		cancel: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string },
		) => Promise<{ record: TaskMainSessionHandoverRecord | null }>;
		retry: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string },
		) => Promise<{ record: TaskMainSessionHandoverRecord | null }>;
	};
	rvfAutomaticCloseoutApi?: {
		reportExecutionResult?: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfAutomaticCloseoutExecutionResultReportRequestSchema>,
		) => Promise<z.infer<typeof rvfAutomaticCloseoutExecutionResultReportResponseSchema>>;
		observeBoundary?: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfReviewStartBoundaryObservationRequestSchema>,
		) => Promise<z.infer<typeof rvfReviewStartBoundaryObservationResponseSchema>>;
		activateAfterRunBinding: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfAutomaticCloseoutRunBindingActivationRequestSchema>,
		) => Promise<z.infer<typeof rvfAutomaticCloseoutRunBindingActivationResponseSchema>>;
		capture: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfReviewStartBoundaryRequestSchema>,
		) => Promise<z.infer<typeof rvfReviewStartBoundaryResponseSchema>>;
		status: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfAutomaticCloseoutStatusRequestSchema>,
		) => Promise<z.infer<typeof rvfAutomaticCloseoutStatusResponseSchema>>;
	};
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
		setCurrentWorkPhaseGoal: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSetCurrentWorkPhaseGoalRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskSessionInputResponse>;

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
		saveAgentRaisedPendingUserDecisionAnswerDraft: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest,
		) => Promise<RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse>;
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
		getTaskConversationHistoryPage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationHistoryPageRequest,
		) => Promise<RuntimeTaskConversationHistoryPageResponse>;
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
		// 排队 prompt 投递（见 src/state/queued-task-prompt-delivery-store.ts）。读是 workspace 级整份快照 + 投影；
		// 写是意图式 mutation，与 prompt library 同形。
		getTaskPromptDeliveryQueue: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPromptDeliveryQueueReadRequest,
		) => Promise<RuntimeTaskPromptDeliveryQueueResponse>;
		mutateTaskPromptDeliveryQueue: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskPromptDeliveryQueueMutateRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskPromptDeliveryQueueMutateResponse>;
		// `kanban task message --deliver-when-agent-idle`：落注入账本 pending 记录 + 排进队列，一次调用完成
		// （见 src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue.ts）。只给 CLI 用，浏览器不调。
		enqueueAgentIdleGatedProgrammaticTaskChatMessage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse>;
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
		loadTaskRetainedCommittedLineChangeHistory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskWorkspaceInfoRequest,
		) => Promise<RuntimeTaskRetainedCommittedLineChangeHistory>;
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
		// cf427：Web UI 新建的卡在启动 agent 前先经此落盘（board 锁内对最新 board 插卡，不走整板 CAS）。
		persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeWorkspaceStateResponse>;
		// dd2db 1a.2b：`kanban task create` 的落盘入口（见 api-contract 的 runtimeKanbanCliTaskBoardMutationRequestSchema）。
		// 其余 CLI 写动词已收编进 taskCardActionApi。
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
	// 看板卡片 per-card 动作的唯一服务端实现（src/trpc/task-card-action-api.ts）。浏览器与 CLI 都调它。
	taskCardActionApi: {
		readTaskCardWithBoardColumn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionReadTaskCardWithBoardColumnRequest,
		) => Promise<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse>;
		startTaskCardAgentSessionMovingItIntoInProgress: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionStartAgentSessionRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionStartAgentSessionResponse>;
		moveTaskCardIntoReviewByHandingTurnToUser: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionMoveIntoReviewRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionMoveIntoReviewResponse>;
		moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionMoveBetweenNonTrashColumnsRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse>;
		moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionMoveIntoDoneRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionMoveIntoDoneResponse>;
		restoreTaskCardFromDoneIntoReviewResumingAgentSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionRestoreFromDoneRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionRestoreFromDoneResponse>;
		permanentlyDeleteTaskCardsWithFullResourceCleanup: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionPermanentlyDeleteRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionPermanentlyDeleteResponse>;
		renameCurrentTask: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRenameCurrentTaskRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionUpdateFieldValuesResponse>;

		updateTaskCardFieldValues: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionUpdateFieldValuesRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionUpdateFieldValuesResponse>;
		setTaskPinboardPinStateOfTaskCard: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionSetTaskPinboardPinStateRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionSetTaskPinboardPinStateResponse>;
	};
	projectsApi: {
		setProjectVisualIdentity: (input: SetProjectVisualIdentityRequest) => Promise<ProjectVisualIdentity>;
		resetProjectVisualIdentityToDefault: (input: { workspaceId: string }) => Promise<ProjectVisualIdentity>;
		readProjectIconImage: (input: {
			workspaceId: string;
			imageAssetId: string;
		}) => Promise<{ mediaType: "image/png"; base64Content: string }>;
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
		recordTaskOpenedByUser: (
			input: RuntimeRecordTaskOpenedByUserRequest,
		) => Promise<RuntimeRecordTaskOpenedByUserResponse>;
		listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon: () => Promise<RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse>;
		readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: (
			input: RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequest,
		) => Promise<RuntimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponse>;
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
		// 以「转为在自然使用中观察」结案的未勾项（只读；将来的自然使用观察 pipeline 消费它们）。
		listDeferredNaturalUsageObservationRecords: (
			scope: RuntimeTrpcWorkspaceScope,
		) => Promise<RuntimeListDeferredNaturalUsageObservationRecordsResponse>;
		// 跨 workspace、只读：All projects 视图据此挑 PDV 面板绑定的 workspace（不带 scope）。
		listWorkspacesHavingPostDeployVerificationDeploymentGroups: () => Promise<RuntimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponse>;
	};
	// dd2db 1b 读侧：跨 project、只读；关系账本只在 runtime 内打开，所以 CLI 读动词也经这里。
	workUnitRelationReadApi: {
		listPermanentlyDeletedTaskCards: (
			input: ListPermanentlyDeletedTaskCardsRequest,
		) => Promise<ListPermanentlyDeletedTaskCardsResponse>;
		getPermanentlyDeletedTaskPromptVersions: (
			input: PermanentlyDeletedTaskPromptVersionsRequest,
		) => Promise<PermanentlyDeletedTaskPromptVersionsResponse>;
		readRelationModelingEditorDraft: (input: {
			workspaceId: string;
			draftScopeId: string;
		}) => Promise<ReferenceRelationModelingEditorDraft | null>;
		saveRelationModelingEditorDraft: (input: {
			workspaceId: string;
			draftScopeId: string;
			draft: ReferenceRelationModelingEditorDraft | null;
		}) => Promise<{ saved: boolean }>;
		getRelationModelingPreview: (input: RelationModelingPreviewRequest) => Promise<RelationModelingPreviewResponse>;
		suggestReferenceRelationsForTaskModeling: (
			input: ReferenceRelationModelingSuggestionsRequest,
		) => Promise<z.infer<typeof referenceRelationModelingSuggestionsResponseSchema>>;
		resolveKanbanBoardCardIdentityByBareTaskId: (
			input: ResolveKanbanBoardCardIdentityByBareTaskIdRequest,
		) => Promise<ResolveKanbanBoardCardIdentityByBareTaskIdResponse>;
		getRelationNeighborhoodSummary: (
			input: GetRelationNeighborhoodSummaryRequest,
		) => Promise<GetRelationNeighborhoodSummaryResponse>;
		listConversationSessionOwnershipPeriods: (
			input: ListConversationSessionOwnershipPeriodsRequest,
		) => Promise<ListConversationSessionOwnershipPeriodsResponse>;
		getWorkUnitContext: (input: GetWorkUnitContextRequest) => Promise<GetWorkUnitContextResponse>;
	};
	// dd2db 1b：记录型关系的展示偏好（静音）。只在 Web UI、要求已校验的页面 nonce。
	workUnitRelationPresentationPreferenceApi: {
		setRecordedRelationPresentationMutePreference: (
			input: SetRecordedRelationPresentationMutePreferenceRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<SetRecordedRelationPresentationMutePreferenceResponse>;
	};
	// dd2db 2.1：断言型关系的写入面。agent 经 CLI（主语 = 请求方工作单元，走确认矩阵）；Web UI 用户带 nonce 直接断言 / 撤销。
	workUnitRelationAssertionWriteApi: {
		applyReferenceRelationModelingChangesDirectlyAsWebUiUser: (
			input: ApplyReferenceRelationModelingChangesRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<ApplyReferenceRelationModelingChangesResponse>;
		assertReferenceRelationAsActingWorkUnit: (
			input: AssertReferenceRelationAsActingWorkUnitRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<InterWorkUnitRelationAssertionWriteResponse>;
		revokeEffectiveRelationAssertionAsActingWorkUnit: (
			input: RevokeEffectiveRelationAssertionAsActingWorkUnitRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<InterWorkUnitRelationAssertionWriteResponse>;
		assertReferenceRelationDirectlyAsWebUiUser: (
			input: AssertReferenceRelationDirectlyAsWebUiUserRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<InterWorkUnitRelationAssertionWriteResponse>;
		revokeEffectiveRelationAssertionDirectlyAsWebUiUser: (
			input: RevokeEffectiveRelationAssertionDirectlyAsWebUiUserRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<InterWorkUnitRelationAssertionWriteResponse>;
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
				...(error.cause instanceof IncomingWorkItemTriageOperationError
					? { incomingWorkItemTriageOperationFailure: error.cause.operationFailure }
					: {}),
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
	support: t.router({
		saveAgentPromptImageAttachments: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeSaveAgentPromptImageAttachmentsRequestSchema)
			.output(z.array(runtimeAgentPromptImageAttachmentReferenceSchema))
			.mutation(({ input }) => savePersistentAgentPromptImageAttachments(input.images)),
		readAgentPromptImageAttachments: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeReadAgentPromptImageAttachmentsRequestSchema)
			.output(z.array(runtimeTaskImageSchema))
			.query(({ input }) => readPersistentAgentPromptImageAttachments(input.imageAttachmentIds)),
		createTaskLookupConversation: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(createTaskLookupConversationRequestSchema)
			.output(taskLookupConversationSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.createConversation(input);
			}),
		listTaskLookupConversations: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.output(z.array(taskLookupConversationSchema))
			.query(({ ctx }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.listConversations();
			}),
		getTaskLookupConversation: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(taskLookupConversationIdentitySchema)
			.output(taskLookupConversationSchema)
			.query(({ ctx, input }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.getConversation(input.conversationId);
			}),
		submitTaskLookupTurn: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(submitTaskLookupTurnRequestSchema)
			.output(taskLookupConversationSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.submitTurn(input);
			}),
		cancelTaskLookupTurn: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(taskLookupConversationIdentitySchema)
			.output(taskLookupConversationSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.cancelTurn(input.conversationId);
			}),
		readTaskLookupCandidatePreview: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(taskLookupCandidatePreviewRequestSchema)
			.output(taskLookupCandidatePreviewSchema)
			.query(({ ctx, input }) => {
				if (!ctx.taskLookupConversationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskLookupConversationApi.readCandidatePreview(input.conversationId, input.taskReference);
			}),
		getTaskIndexingContext: workspaceProcedure.output(sharedTaskIndexingContextSchema).query(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.getTaskIndexingContext(ctx.workspaceScope);
		}),
		triageIncomingWorkItem: workspaceProcedure
			.input(incomingWorkItemSchema)
			.output(incomingWorkItemTriageResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskIndexingSupportApi.triageIncomingWorkItem(ctx.workspaceScope, input);
			}),
		getExecutorSettings: workspaceProcedure.output(taskIndexingSupportExecutorSettingsSchema).query(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.getExecutorSettings(ctx.workspaceScope);
		}),
		setExecutorSettings: workspaceProcedure
			.input(taskIndexingSupportExecutorSettingsSchema)
			.output(taskIndexingSupportExecutorSettingsSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskIndexingSupportApi.setExecutorSettings(ctx.workspaceScope, input);
			}),
		scheduleRvfFindingsBackfill: workspaceProcedure.mutation(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.scheduleBackfill(ctx.workspaceScope);
		}),
		getRvfFindingsBackfillStatus: workspaceProcedure.query(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.readBackfillStatus(ctx.workspaceScope);
		}),
	}),
	independentTaskCreation: t.router({
		read: workspaceProcedure
			.input(z.object({ requestId: z.string().uuid() }))
			.output(independentTaskCreationDraftSchema)
			.query(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.read(ctx.workspaceScope, input);
			}),
		latestDraft: workspaceProcedure
			.input(z.object({ sourceTaskId: z.string(), sourceTaskConversationSessionId: z.string() }))
			.output(independentTaskCreationDraftSchema.nullable())
			.query(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.latestDraft(ctx.workspaceScope, input);
			}),
		prepare: workspaceProcedure
			.input(independentTaskCreationDraftRequestSchema)
			.output(independentTaskCreationDraftSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.prepare(ctx.workspaceScope, input);
			}),
		saveDraft: workspaceProcedure
			.input(independentTaskCreationDraftEditSchema)
			.output(independentTaskCreationDraftSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.saveDraft(ctx.workspaceScope, input);
			}),
		generate: workspaceProcedure
			.input(z.object({ requestId: z.string().uuid(), allowIncompleteContext: z.boolean().optional() }))
			.output(independentTaskCreationDraftSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.generate(ctx.workspaceScope, input);
			}),
		create: workspaceProcedure
			.input(z.object({ requestId: z.string().uuid() }))
			.output(independentTaskCreationDraftSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.create(
					ctx.workspaceScope,
					input,
					ctx,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		list: workspaceProcedure
			.input(independentTaskCreationListRequestSchema)
			.output(independentTaskCreationListResponseSchema)
			.query(({ ctx, input }) => {
				if (!ctx.independentTaskCreationApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.independentTaskCreationApi.list(ctx.workspaceScope, input);
			}),
	}),
	runtime: t.router({
		prepareTaskMainSessionHandover: workspaceProcedure
			.input(taskMainSessionHandoverPrepareRequestSchema)
			.output(taskMainSessionHandoverPrepareResponseSchema)
			.query(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.prepare(ctx.workspaceScope, input);
			}),
		requestTaskMainSessionHandover: workspaceProcedure
			.input(taskMainSessionHandoverRequestSchema)
			.output(taskMainSessionHandoverStatusResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.request(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		getTaskMainSessionHandoverStatus: workspaceProcedure
			.input(taskMainSessionHandoverPrepareRequestSchema)
			.output(taskMainSessionHandoverStatusResponseSchema)
			.query(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.getStatus(ctx.workspaceScope, input);
			}),
		cancelTaskMainSessionHandover: workspaceProcedure
			.input(taskMainSessionHandoverPrepareRequestSchema)
			.output(taskMainSessionHandoverStatusResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.cancel(ctx.workspaceScope, input);
			}),
		retryTaskMainSessionHandover: workspaceProcedure
			.input(taskMainSessionHandoverPrepareRequestSchema)
			.output(taskMainSessionHandoverStatusResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.retry(ctx.workspaceScope, input);
			}),
		recoverTaskMainSessionHandoverWithNewCodexSession: workspaceProcedure
			.input(taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema)
			.output(taskMainSessionHandoverStatusResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskMainSessionHandoverApi.recoverWithNewCodexSession(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		observeRvfReviewStartBoundary: workspaceProcedure
			.input(rvfReviewStartBoundaryObservationRequestSchema)
			.output(rvfReviewStartBoundaryObservationResponseSchema)
			.query(async ({ ctx, input }) => {
				if (!ctx.rvfAutomaticCloseoutApi?.observeBoundary)
					return { review_start_boundary_pending_reason: "宿主尚未提供实时活动分支观测。" };
				return ctx.rvfAutomaticCloseoutApi.observeBoundary(ctx.workspaceScope, input);
			}),
		captureRvfReviewStartBoundary: workspaceProcedure
			.input(rvfReviewStartBoundaryRequestSchema)
			.output(rvfReviewStartBoundaryResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.rvfAutomaticCloseoutApi)
					throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "自动 RVF 收尾服务未启用。" });
				return ctx.rvfAutomaticCloseoutApi.capture(ctx.workspaceScope, input);
			}),
		activateRvfAutomaticCloseoutAfterRunBinding: workspaceProcedure
			.input(rvfAutomaticCloseoutRunBindingActivationRequestSchema)
			.output(rvfAutomaticCloseoutRunBindingActivationResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.rvfAutomaticCloseoutApi)
					throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "自动 RVF 收尾服务未启用。" });
				return ctx.rvfAutomaticCloseoutApi.activateAfterRunBinding(ctx.workspaceScope, input);
			}),
		rvfAutomaticCloseoutStatus: workspaceProcedure
			.input(rvfAutomaticCloseoutStatusRequestSchema)
			.output(rvfAutomaticCloseoutStatusResponseSchema)
			.query(async ({ ctx, input }) => {
				if (!ctx.rvfAutomaticCloseoutApi)
					throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "自动 RVF 收尾服务未启用。" });
				return ctx.rvfAutomaticCloseoutApi.status(ctx.workspaceScope, input);
			}),
		reportRvfAutomaticCloseoutExecutionResult: workspaceProcedure
			.input(rvfAutomaticCloseoutExecutionResultReportRequestSchema)
			.output(rvfAutomaticCloseoutExecutionResultReportResponseSchema)
			.mutation(async ({ ctx, input }) => {
				if (!ctx.rvfAutomaticCloseoutApi?.reportExecutionResult)
					throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "自动收尾执行结果登记服务未启用。" });
				try {
					return await ctx.rvfAutomaticCloseoutApi.reportExecutionResult(ctx.workspaceScope, input);
				} catch (error) {
					if (error instanceof RvfAutomaticCloseoutExecutionResultDeliveryPendingError)
						throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
					throw error;
				}
			}),
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
		setCurrentWorkPhaseGoal: workspaceProcedure
			.input(runtimeSetCurrentWorkPhaseGoalRequestSchema)
			.output(runtimeTaskSessionInputResponseSchema)
			.mutation(
				async ({ ctx, input }) =>
					await ctx.runtimeApi.setCurrentWorkPhaseGoal(
						ctx.workspaceScope,
						input,
						ctx.kanbanRequestOriginActorEvidence,
					),
			),

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
		saveAgentRaisedPendingUserDecisionAnswerDraft: workspaceProcedure
			.input(runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequestSchema)
			.output(runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.saveAgentRaisedPendingUserDecisionAnswerDraft(ctx.workspaceScope, input);
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
		getTaskConversationHistoryPage: workspaceProcedure
			.input(runtimeTaskConversationHistoryPageRequestSchema)
			.output(runtimeTaskConversationHistoryPageResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskConversationHistoryPage(ctx.workspaceScope, input);
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
		getTaskPromptDeliveryQueue: workspaceProcedure
			.input(runtimeTaskPromptDeliveryQueueReadRequestSchema)
			.output(runtimeTaskPromptDeliveryQueueResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.runtimeApi.getTaskPromptDeliveryQueue(ctx.workspaceScope, input);
			}),
		mutateTaskPromptDeliveryQueue: workspaceProcedure
			.input(runtimeTaskPromptDeliveryQueueMutateRequestSchema)
			.output(runtimeTaskPromptDeliveryQueueMutateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.mutateTaskPromptDeliveryQueue(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		enqueueAgentIdleGatedProgrammaticTaskChatMessage: workspaceProcedure
			.input(runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequestSchema)
			.output(runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
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
		getTaskRetainedCommittedLineChangeHistory: workspaceProcedure
			.input(runtimeTaskWorkspaceInfoRequestSchema)
			.output(runtimeTaskRetainedCommittedLineChangeHistorySchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workspaceApi.loadTaskRetainedCommittedLineChangeHistory(ctx.workspaceScope, input);
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
		// 浏览器建卡后、放行 agent 启动前调用：卡片落盘不再依赖 120ms 防抖的整板保存赢下 revision 竞争（cf427）。
		persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart: workspaceProcedure
			.input(runtimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequestSchema)
			.output(runtimeWorkspaceStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workspaceApi.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		// `kanban task create` 只经这里落盘：runtime 按请求头的 CLI 行动者声明解析行动者后进入持久化漏斗。
		// runtime 离线时 CLI 直接报错，不回退直接写盘（dd2db 1a.2b）。其余 CLI 写动词走 taskCardAction.*。
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
	// 看板卡片 per-card 动作（契约与错误语义见 api-contract 的 taskCardAction 一节）。全部 workspace-scoped：
	// 作用于 x-kanban-workspace-id 指向的任意已注册项目，跨项目执行动作不需要切换浏览器当前项目。
	taskCardAction: t.router({
		appendTaskComment: workspaceProcedure
			.input(appendTaskCommentRequestSchema)
			.output(appendTaskCommentResponseSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskIndexingSupportApi.appendTaskComment(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		readTaskCardWithBoardColumn: workspaceProcedure
			.input(runtimeTaskCardActionReadTaskCardWithBoardColumnRequestSchema)
			.output(runtimeTaskCardActionReadTaskCardWithBoardColumnResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.readTaskCardWithBoardColumn(ctx.workspaceScope, input);
			}),
		startTaskCardAgentSessionMovingItIntoInProgress: workspaceProcedure
			.input(runtimeTaskCardActionStartAgentSessionRequestSchema)
			.output(runtimeTaskCardActionStartAgentSessionResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.startTaskCardAgentSessionMovingItIntoInProgress(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		moveTaskCardIntoReviewByHandingTurnToUser: workspaceProcedure
			.input(runtimeTaskCardActionMoveIntoReviewRequestSchema)
			.output(runtimeTaskCardActionMoveIntoReviewResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.moveTaskCardIntoReviewByHandingTurnToUser(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects: workspaceProcedure
			.input(runtimeTaskCardActionMoveBetweenNonTrashColumnsRequestSchema)
			.output(runtimeTaskCardActionMoveBetweenNonTrashColumnsResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree: workspaceProcedure
			.input(runtimeTaskCardActionMoveIntoDoneRequestSchema)
			.output(runtimeTaskCardActionMoveIntoDoneResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		restoreTaskCardFromDoneIntoReviewResumingAgentSession: workspaceProcedure
			.input(runtimeTaskCardActionRestoreFromDoneRequestSchema)
			.output(runtimeTaskCardActionRestoreFromDoneResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		permanentlyDeleteTaskCardsWithFullResourceCleanup: workspaceProcedure
			.input(runtimeTaskCardActionPermanentlyDeleteRequestSchema)
			.output(runtimeTaskCardActionPermanentlyDeleteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.permanentlyDeleteTaskCardsWithFullResourceCleanup(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		renameCurrentTask: workspaceProcedure
			.input(runtimeRenameCurrentTaskRequestSchema)
			.output(runtimeTaskCardActionUpdateFieldValuesResponseSchema)
			.mutation(
				async ({ ctx, input }) =>
					await ctx.taskCardActionApi.renameCurrentTask(
						ctx.workspaceScope,
						input,
						ctx.kanbanRequestOriginActorEvidence,
					),
			),

		updateTaskCardFieldValues: workspaceProcedure
			.input(runtimeTaskCardActionUpdateFieldValuesRequestSchema)
			.output(runtimeTaskCardActionUpdateFieldValuesResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.updateTaskCardFieldValues(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		setTaskPinboardPinStateOfTaskCard: workspaceProcedure
			.input(runtimeTaskCardActionSetTaskPinboardPinStateRequestSchema)
			.output(runtimeTaskCardActionSetTaskPinboardPinStateResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.taskCardActionApi.setTaskPinboardPinStateOfTaskCard(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
	}),
	projects: t.router({
		setProjectVisualIdentity: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(setProjectVisualIdentityRequestSchema)
			.output(projectVisualIdentitySchema)
			.mutation(({ ctx, input }) => ctx.projectsApi.setProjectVisualIdentity(input)),
		resetProjectVisualIdentityToDefault: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(resetProjectVisualIdentityRequestSchema)
			.output(projectVisualIdentitySchema)
			.mutation(({ ctx, input }) => ctx.projectsApi.resetProjectVisualIdentityToDefault(input)),
		readProjectIconImage: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(readProjectIconImageRequestSchema)
			.output(readProjectIconImageResponseSchema)
			.query(({ ctx, input }) => ctx.projectsApi.readProjectIconImage(input)),
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
		// 跨项目切换面板（docs/context-cross-project-recently-active-task-switcher.md）：选中任务时记「我最后打开」。
		// 非 workspace-scoped，按 input.workspaceId 写（同 markTaskNotificationsVisited）。
		recordTaskOpenedByUser: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(runtimeRecordTaskOpenedByUserRequestSchema)
			.output(runtimeRecordTaskOpenedByUserResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.projectsApi.recordTaskOpenedByUser(input);
			}),
		// 跨项目切换面板「显示更早」：按放宽后的时间窗现算全部项目的条目（不进广播）。
		listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon:
			procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
				.output(runtimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponseSchema)
				.query(async ({ ctx }) => {
					return await ctx.projectsApi.listCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon();
				}),
		// 跨项目切换面板：其他项目任务 worktree 的 git 元数据（ahead/behind、未提交改动），面板可见时按需轮询。
		// 非 workspace-scoped：按 input 里每条的 workspaceId 读；服务端按键缓存并用 fs-stat 门控。
		readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries:
			procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
				.input(runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema)
				.output(runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponseSchema)
				.query(async ({ ctx, input }) => {
					return await ctx.projectsApi.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(input);
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
		listDeferredNaturalUsageObservationRecords: workspaceProcedure
			.output(runtimeListDeferredNaturalUsageObservationRecordsResponseSchema)
			.query(async ({ ctx }) => {
				return await ctx.deploymentApi.listDeferredNaturalUsageObservationRecords(ctx.workspaceScope);
			}),
		listWorkspacesHavingPostDeployVerificationDeploymentGroups:
			procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
				.output(runtimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponseSchema)
				.query(async ({ ctx }) => {
					return await ctx.deploymentApi.listWorkspacesHavingPostDeployVerificationDeploymentGroups();
				}),
	}),
	// dd2db 1b：工作单元间关系的读侧（记录型邻域、跨 project 身份解析、会话归属、上下文端口）。全是只读 query。
	workUnit: t.router({
		listPermanentlyDeletedTaskCards: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(listPermanentlyDeletedTaskCardsRequestSchema)
			.output(listPermanentlyDeletedTaskCardsResponseSchema)
			.query(({ ctx, input }) => ctx.workUnitRelationReadApi.listPermanentlyDeletedTaskCards(input)),
		getPermanentlyDeletedTaskPromptVersions: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(permanentlyDeletedTaskPromptVersionsRequestSchema)
			.output(permanentlyDeletedTaskPromptVersionsResponseSchema)
			.query(({ ctx, input }) => ctx.workUnitRelationReadApi.getPermanentlyDeletedTaskPromptVersions(input)),
		resolveKanbanBoardCardIdentityByBareTaskId: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(resolveKanbanBoardCardIdentityByBareTaskIdRequestSchema)
			.output(resolveKanbanBoardCardIdentityByBareTaskIdResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workUnitRelationReadApi.resolveKanbanBoardCardIdentityByBareTaskId(input);
			}),
		getRelationNeighborhoodSummary: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(getRelationNeighborhoodSummaryRequestSchema)
			.output(getRelationNeighborhoodSummaryResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workUnitRelationReadApi.getRelationNeighborhoodSummary(input);
			}),
		listConversationSessionOwnershipPeriods: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(listConversationSessionOwnershipPeriodsRequestSchema)
			.output(listConversationSessionOwnershipPeriodsResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workUnitRelationReadApi.listConversationSessionOwnershipPeriods(input);
			}),
		getWorkUnitContext: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(getWorkUnitContextRequestSchema)
			.output(getWorkUnitContextResponseSchema)
			.query(async ({ ctx, input }) => {
				return await ctx.workUnitRelationReadApi.getWorkUnitContext(input);
			}),
		setRecordedRelationPresentationMutePreference: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(setRecordedRelationPresentationMutePreferenceRequestSchema)
			.output(setRecordedRelationPresentationMutePreferenceResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workUnitRelationPresentationPreferenceApi.setRecordedRelationPresentationMutePreference(
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		// dd2db 2.1 断言型关系写入（R3.4 `assert-reference-relation` / `revoke-effective-relation-assertion`）。
		readRelationModelingEditorDraft: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(relationModelingEditorDraftReadRequestSchema)
			.output(referenceRelationModelingEditorDraftSchema.nullable())
			.query(({ ctx, input }) => ctx.workUnitRelationReadApi.readRelationModelingEditorDraft(input)),
		saveRelationModelingEditorDraft: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(relationModelingEditorDraftSaveRequestSchema)
			.output(z.object({ saved: z.boolean() }))
			.mutation(({ ctx, input }) => ctx.workUnitRelationReadApi.saveRelationModelingEditorDraft(input)),
		getRelationModelingPreview: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(relationModelingPreviewRequestSchema)
			.output(relationModelingPreviewResponseSchema)
			.query(({ ctx, input }) => ctx.workUnitRelationReadApi.getRelationModelingPreview(input)),
		suggestReferenceRelationsForTaskModeling: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(referenceRelationModelingSuggestionsRequestSchema)
			.output(referenceRelationModelingSuggestionsResponseSchema)
			.mutation(({ ctx, input }) => ctx.workUnitRelationReadApi.suggestReferenceRelationsForTaskModeling(input)),
		applyReferenceRelationModelingChangesDirectlyAsWebUiUser: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(applyReferenceRelationModelingChangesRequestSchema)
			.output(applyReferenceRelationModelingChangesResponseSchema)
			.mutation(({ ctx, input }) =>
				ctx.workUnitRelationAssertionWriteApi.applyReferenceRelationModelingChangesDirectlyAsWebUiUser(
					input,
					ctx.kanbanRequestOriginActorEvidence,
				),
			),

		assertReferenceRelationAsActingWorkUnit: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(assertReferenceRelationAsActingWorkUnitRequestSchema)
			.output(interWorkUnitRelationAssertionWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workUnitRelationAssertionWriteApi.assertReferenceRelationAsActingWorkUnit(
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		revokeEffectiveRelationAssertionAsActingWorkUnit: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(revokeEffectiveRelationAssertionAsActingWorkUnitRequestSchema)
			.output(interWorkUnitRelationAssertionWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workUnitRelationAssertionWriteApi.revokeEffectiveRelationAssertionAsActingWorkUnit(
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		// 决策类：只在 Web UI、只由显式用户手势触发；runtime 校验 nonce、拒绝 CLI 头与不可信的合成 DOM 事件。
		assertReferenceRelationDirectlyAsWebUiUser: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(assertReferenceRelationDirectlyAsWebUiUserRequestSchema)
			.output(interWorkUnitRelationAssertionWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workUnitRelationAssertionWriteApi.assertReferenceRelationDirectlyAsWebUiUser(
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		revokeEffectiveRelationAssertionDirectlyAsWebUiUser: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
			.input(revokeEffectiveRelationAssertionDirectlyAsWebUiUserRequestSchema)
			.output(interWorkUnitRelationAssertionWriteResponseSchema)
			.mutation(async ({ ctx, input }) => {
				return await ctx.workUnitRelationAssertionWriteApi.revokeEffectiveRelationAssertionDirectlyAsWebUiUser(
					input,
					ctx.kanbanRequestOriginActorEvidence,
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
