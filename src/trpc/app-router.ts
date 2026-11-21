// Defines the typed TRPC boundary between the browser and the local runtime.
// Keep request and response contracts plus workspace-scoped procedures here,
// and delegate domain behavior to runtime-api.ts and lower-level services.
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { queryCurrentRuntimeAgentSessionPtyHostDiagnostics } from "../agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-diagnostics";
import { agentSessionPtyHostDiagnosticsSchema } from "../core/agent-session-pty-host-diagnostics-contract";
import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeAddBacklogTaskRequest,
	RuntimeAddBacklogTaskResponse,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse,
	RuntimeAgentSessionTransportSwitchRequest,
	RuntimeAgentSessionTransportSwitchResponse,
	RuntimeAllProjectsTaskGroupQueryRequest,
	RuntimeAllProjectsTaskGroupQuerySnapshot,
	RuntimeAllProjectsTaskSearchIndexResponse,
	RuntimeAnswerAgentRaisedPendingUserDecisionRequest,
	RuntimeAnswerAgentRaisedPendingUserDecisionResponse,
	RuntimeArchiveExploratoryFindingRequest,
	RuntimeArchiveExploratoryFindingResponse,
	RuntimeAvailableAgentSessionsRequest,
	RuntimeAvailableAgentSessionsResponse,
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
	RuntimeExitCodexTaskConversationSessionPlanModeRequest,
	RuntimeExitCodexTaskConversationSessionPlanModeResponse,
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
	RuntimePlannedHandoverRestartRequest,
	RuntimePlannedHandoverRestartResponse,
	RuntimeProjectAddPreviewRequest,
	RuntimeProjectAddPreviewResponse,
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
	RuntimeRecordCurrentTaskProgressRequest,
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
	RuntimeStopTerminatingHostedAgentSessionsResponse,
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
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskDirectoryRequest,
	RuntimeTaskDirectoryResponse,
	RuntimeTaskEditDraftsMutateRequest,
	RuntimeTaskEditDraftsReadRequest,
	RuntimeTaskEditDraftsResponse,
	RuntimeTaskFileDownloadRequest,
	RuntimeTaskFileIdentityRequest,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskMainSessionPlanResponse,
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
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionTransitionToReviewRequest,
	RuntimeTaskSessionTransitionToReviewResponse,
	RuntimeTaskTerminalRefreshRequest,
	RuntimeTaskTerminalRefreshResponse,
	RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkRequest,
	RuntimeTaskUnparkAwaitingDispatchedBackgroundWorkResponse,
	RuntimeTaskWorkspaceGitStatusesRequest,
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
	type RuntimeAutomaticAgentFailureContinuationActionRequest,
	type RuntimeGetPostDeployVerificationDeploymentGroupRequest,
	type RuntimeGetPostDeployVerificationDeploymentGroupResponse,
	type RuntimePostDeployVerificationWorkspaceOverview,
	type RuntimeTaskCardActionSetShelvingStateRequest,
	type RuntimeTaskCardActionSetShelvingStateResponse,
	type RuntimeTaskConversationSessionCreateRequest,
	type RuntimeTaskConversationSessionCreateResponse,
	type RuntimeTaskConversationSessionGetRequest,
	type RuntimeTaskConversationSessionGetResponse,
	type RuntimeTaskConversationSessionListResponse,
	type RuntimeTaskConversationSessionReportRequest,
	type RuntimeTaskConversationSessionReportResponse,
	type RuntimeTaskConversationSessionResumeRequest,
	type RuntimeTaskConversationSessionResumeResponse,
	runtimeAddBacklogTaskRequestSchema,
	runtimeAddBacklogTaskResponseSchema,
	runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequestSchema,
	runtimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponseSchema,
	runtimeAgentPromptFileAttachmentReferenceSchema,
	runtimeAgentPromptImageAttachmentReferenceSchema,
	runtimeAgentSessionTransportSwitchRequestSchema,
	runtimeAgentSessionTransportSwitchResponseSchema,
	runtimeAllProjectsTaskGroupQueryRequestSchema,
	runtimeAllProjectsTaskGroupQuerySnapshotSchema,
	runtimeAllProjectsTaskSearchIndexResponseSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionRequestSchema,
	runtimeAnswerAgentRaisedPendingUserDecisionResponseSchema,
	runtimeArchiveExploratoryFindingRequestSchema,
	runtimeArchiveExploratoryFindingResponseSchema,
	runtimeAutomaticAgentFailureContinuationActionRequestSchema,
	runtimeAutomaticAgentFailureContinuationActionResponseSchema,
	runtimeAutomaticTaskNameBackfillRequestSchema,
	runtimeAvailableAgentSessionsRequestSchema,
	runtimeAvailableAgentSessionsResponseSchema,
	runtimeClaimDailyWorkProgressCelebrationsRequestSchema,
	runtimeClaimDailyWorkProgressCelebrationsResponseSchema,
	runtimeCommandRunRequestSchema,
	runtimeCommandRunResponseSchema,
	runtimeConditionalWorkspaceChangesRequestSchema,
	runtimeConditionalWorkspaceChangesResponseSchema,
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
	runtimeDailyWorkProgressRequestSchema,
	runtimeDailyWorkProgressSummarySchema,
	runtimeDebugResetAllStateResponseSchema,
	runtimeDeferredRestorationHarnessNotificationsRequestSchema,
	runtimeDeferredRestorationHarnessNotificationsResponseSchema,
	runtimeDirectoryListRequestSchema,
	runtimeDirectoryListResponseSchema,
	runtimeDismissAgentRaisedPendingUserDecisionRequestSchema,
	runtimeDismissAgentRaisedPendingUserDecisionResponseSchema,
	runtimeDismissConnectionRetrySessionsRequestSchema,
	runtimeDismissConnectionRetrySessionsResponseSchema,
	runtimeExitCodexTaskConversationSessionPlanModeRequestSchema,
	runtimeExitCodexTaskConversationSessionPlanModeResponseSchema,
	runtimeGetExplorationThreadGraphRequestSchema,
	runtimeGetExplorationThreadGraphResponseSchema,
	runtimeGetExploratoryFindingsRequestSchema,
	runtimeGetExploratoryFindingsResponseSchema,
	runtimeGetPostDeployVerificationDeploymentGroupRequestSchema,
	runtimeGetPostDeployVerificationDeploymentGroupResponseSchema,
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
	runtimePlannedHandoverRestartRequestSchema,
	runtimePlannedHandoverRestartResponseSchema,
	runtimePostDeployVerificationWorkspaceOverviewSchema,
	runtimeProjectAddPreviewRequestSchema,
	runtimeProjectAddPreviewResponseSchema,
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
	runtimeReadTaskCardsForPostDeployVerificationRequestSchema,
	runtimeReadTaskCardsForPostDeployVerificationResponseSchema,
	runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesRequestSchema,
	runtimeReadTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntriesResponseSchema,
	runtimeRecordCurrentTaskProgressRequestSchema,
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
	runtimeSaveAgentPromptFileAttachmentRequestSchema,
	runtimeSaveAgentPromptImageAttachmentsRequestSchema,
	runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequestSchema,
	runtimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponseSchema,
	runtimeSaveExploratoryFindingRequestSchema,
	runtimeSaveExploratoryFindingResponseSchema,
	runtimeSetCurrentWorkPhaseGoalRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeShellSessionStartResponseSchema,
	runtimeStopTerminatingHostedAgentSessionsResponseSchema,
	runtimeTaskAgentUserDecisionResolveRequestSchema,
	runtimeTaskAgentUserDecisionResolveResponseSchema,
	runtimeTaskCardActionApplyTaskStickerEntryMutationRequestSchema,
	runtimeTaskCardActionApplyTaskStickerEntryMutationResponseSchema,
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
	runtimeTaskCardActionSetShelvingStateRequestSchema,
	runtimeTaskCardActionSetShelvingStateResponseSchema,
	runtimeTaskCardActionSetTaskPinboardPinStateRequestSchema,
	runtimeTaskCardActionSetTaskPinboardPinStateResponseSchema,
	runtimeTaskCardActionStartAgentSessionRequestSchema,
	runtimeTaskCardActionStartAgentSessionResponseSchema,
	runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema,
	runtimeTaskCardActionTransferBacklogTaskToProjectResponseSchema,
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
	runtimeTaskChatSendRequestSchema,
	runtimeTaskChatSendResponseSchema,
	runtimeTaskConversationHistoryPageRequestSchema,
	runtimeTaskConversationHistoryPageResponseSchema,
	runtimeTaskConversationSessionCreateRequestSchema,
	runtimeTaskConversationSessionCreateResponseSchema,
	runtimeTaskConversationSessionGetRequestSchema,
	runtimeTaskConversationSessionGetResponseSchema,
	runtimeTaskConversationSessionListRequestSchema,
	runtimeTaskConversationSessionListResponseSchema,
	runtimeTaskConversationSessionPreviewResponseSchema,
	runtimeTaskConversationSessionRenameRequestSchema,
	runtimeTaskConversationSessionReportRequestSchema,
	runtimeTaskConversationSessionReportResponseSchema,
	runtimeTaskConversationSessionResumeRequestSchema,
	runtimeTaskConversationSessionResumeResponseSchema,
	runtimeTaskDirectoryRequestSchema,
	runtimeTaskDirectoryResponseSchema,
	runtimeTaskEditDraftsMutateRequestSchema,
	runtimeTaskEditDraftsReadRequestSchema,
	runtimeTaskEditDraftsResponseSchema,
	runtimeTaskFileIdentityRequestSchema,
	runtimeTaskImageSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkRequestSchema,
	runtimeTaskIsParkedAwaitingDispatchedBackgroundWorkResponseSchema,
	runtimeTaskMainSessionPlanResponseSchema,
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
	runtimeTaskWorkspaceGitStatusesRequestSchema,
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
	backlogTaskStartReadinessAssessmentRequestSchema,
	backlogTaskStartReadinessAssessmentResponseSchema,
} from "../core/backlog-task-start-readiness-contract";
import { projectWorkspaceStateForBrowser } from "../core/browser-task-session-summary-projection";

import {
	type RuntimeCodexConversationStorageOperationRequest,
	type RuntimeCodexConversationStorageOperationResponse,
	runtimeCodexConversationStorageOperationRequestSchema,
	runtimeCodexConversationStorageOperationResponseSchema,
} from "../core/codex-conversation-storage-api-contract";
import {
	duplicateProjectConsolidationPreviewRequestSchema,
	duplicateProjectConsolidationPreviewSchema,
	duplicateProjectConsolidationRequestSchema,
	duplicateProjectConsolidationResultSchema,
} from "../core/duplicate-project-consolidation-contract";
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
	type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequest,
	type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse,
	runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequestSchema,
	runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponseSchema,
} from "../core/post-deploy-verification-entry-navigation-contract";
import {
	type ProjectVisualIdentity,
	projectVisualIdentitySchema,
	readProjectIconImageRequestSchema,
	readProjectIconImageResponseSchema,
	resetProjectVisualIdentityRequestSchema,
	type SetProjectVisualIdentityRequest,
	setProjectVisualIdentityRequestSchema,
} from "../core/project-visual-identity";
import { taskAssistanceModelProviderRoutingSettingsSchema } from "../core/task-assistance-model-provider-routing-contract";
import {
	taskClosureHistoryRequestSchema,
	taskClosureHistoryResponseSchema,
	taskClosureOutcomeCorrectionRequestSchema,
	taskClosureRecordSchema,
} from "../core/task-closure-contract";
import {
	taskCommandExecutionAdoptExistingSupervisorRequestSchema,
	taskCommandExecutionIdentityRequestSchema,
	taskCommandExecutionRecoveryObservationRegistrationRequestSchema,
	taskCommandExecutionResponseSchema,
	taskCommandExecutionStartRequestSchema,
} from "../core/task-command-execution-contract";
import {
	taskEditorCreationSubmissionLookupSchema,
	taskEditorCreationSubmissionRequestSchema,
	taskEditorCreationSubmissionRetryRequestSchema,
	taskEditorCreationSubmissionStatusSchema,
	taskEditorCreationSubmissionsForTaskRequestSchema,
} from "../core/task-editor-creation-submission-contract";
import {
	appendTaskCommentRequestSchema,
	appendTaskCommentResponseSchema,
	IncomingWorkItemTriageOperationError,
	incomingWorkItemSchema,
	incomingWorkItemTriageResponseSchema,
	sharedTaskIndexingContextSchema,
	taskIndexingSupportExecutorSettingsSchema,
	taskProjectAssignmentAnalysisRequestSchema,
	taskProjectAssignmentAnalysisResponseSchema,
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
	taskMainSessionHandoverRecoverWithNewAgentSessionRequestSchema,
	taskMainSessionHandoverRecoverWithNewCodexSessionRequestSchema,
	taskMainSessionHandoverRequestSchema,
	taskMainSessionHandoverStatusResponseSchema,
} from "../core/task-main-session-handover-contract";
import { taskRvfHistoryRequestSchema, taskRvfHistoryResponseSchema } from "../core/task-rvf-history-contract";
import {
	taskVisualizationListRequestSchema,
	taskVisualizationListResponseSchema,
	taskVisualizationPreparePreviewResponseSchema,
	taskVisualizationPublishRequestSchema,
	taskVisualizationPublishResponseSchema,
	taskVisualizationRequestPreviewResponseSchema,
	taskVisualizationSelectArtifactRequestSchema,
} from "../core/task-visualization-artifact-contract";
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
	type GetDirectlyRelatedTaskPreviewPageRequest,
	type GetDirectlyRelatedTaskPreviewPageResponse,
	type GetRelationNeighborhoodSummaryRequest,
	type GetRelationNeighborhoodSummaryResponse,
	type GetWorkUnitContextRequest,
	type GetWorkUnitContextResponse,
	getDirectlyRelatedTaskPreviewPageRequestSchema,
	getDirectlyRelatedTaskPreviewPageResponseSchema,
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
import type { DailyWorkProgressStatisticsService } from "../daily-work-progress-statistics/daily-work-progress-statistics-service";
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
import { getTaskRvfHistory } from "../rvf-task-review-history/task-rvf-history-query-service";
import { buildConditionalWorkspaceChangesResponse } from "../server/conditional-workspace-changes";
import { assertWorkspaceHasNotBeenConsolidated } from "../state/duplicate-project-consolidation-status";
import { savePersistentAgentPromptFileAttachment } from "../state/persistent-agent-prompt-file-attachments";
import {
	readPersistentAgentPromptImageAttachments,
	savePersistentAgentPromptImageAttachments,
} from "../state/persistent-agent-prompt-image-attachments";
import { allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import type { TaskCommandExecutionService } from "../task-command-execution/task-command-execution-service";
import type { TaskEditorCreationSubmissionService } from "../task-editor-creation/task-editor-creation-submission-service";
import type { TaskFileDownloadContents } from "../task-file-downloads/task-file-download-service";
import type { TaskIndexingSupportRuntimeService } from "../task-indexing-support/task-indexing-support-runtime-service";
import type { TaskLookupConversationService } from "../task-indexing-support/task-lookup-conversation-service";
import type { TaskVisualizationArtifactService } from "../task-visualization-artifacts/task-visualization-artifact-service";

export interface RuntimeTrpcWorkspaceScope {
	workspaceId: string;
	workspacePath: string;
}

export interface RuntimeTrpcContext {
	taskEditorCreationSubmissionApi?: TaskEditorCreationSubmissionService;
	taskCommandExecutionApi?: TaskCommandExecutionService;
	dailyWorkProgressStatisticsApi?: Pick<DailyWorkProgressStatisticsService, "getSummary" | "claimCelebrations">;
	taskVisualizationArtifactApi?: TaskVisualizationArtifactService;
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
		recoverWithNewAgentSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
			evidence?: KanbanRequestOriginActorEvidence,
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
	requestedWorkspaceId: string | null;
	workspaceScope: RuntimeTrpcWorkspaceScope | null;
	// 请求发起方的行动者证据（dd2db 1a）：CLI 调用环境声明头；1a.3 起再加页面加载 nonce。
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
	runtimeApi: {
		listTaskDirectory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskDirectoryRequest,
		) => Promise<RuntimeTaskDirectoryResponse>;
		getTaskMainSessionPlan: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskFileIdentityRequest,
		) => Promise<RuntimeTaskMainSessionPlanResponse>;
		openTaskFileDownload: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskFileDownloadRequest,
		) => Promise<TaskFileDownloadContents>;
		operateCodexConversationStorage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeCodexConversationStorageOperationRequest,
		) => Promise<RuntimeCodexConversationStorageOperationResponse>;
		loadConfig: (scope: RuntimeTrpcWorkspaceScope | null) => Promise<RuntimeConfigResponse>;
		saveConfig: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeConfigSaveRequest,
		) => Promise<RuntimeConfigResponse>;
		setCurrentWorkPhaseGoal: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeSetCurrentWorkPhaseGoalRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskSessionInputResponse>;
		recordCurrentTaskProgress: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeRecordCurrentTaskProgressRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskSessionInputResponse & { taskMetadataReviewReminder: string }>;

		requestAutomaticTaskNameBackfill: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof runtimeAutomaticTaskNameBackfillRequestSchema>,
		) => Promise<{ ok: boolean }>;
		suggestTaskNamesFromTaskDescription: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeTaskNameSuggestionRequest,
			abortSignal?: AbortSignal,
		) => Promise<RuntimeTaskNameSuggestionResponse>;
		lookupTaskConversationSessionCreation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
		) => Promise<RuntimeTaskConversationSessionCreateResponse | null>;
		previewTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof runtimeTaskConversationSessionPreviewResponseSchema>>;
		renameTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof runtimeTaskConversationSessionRenameRequestSchema>,
		) => Promise<RuntimeTaskSessionInputResponse>;
		createTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionCreateRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskConversationSessionCreateResponse>;
		listTaskConversationSessions: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string },
		) => Promise<RuntimeTaskConversationSessionListResponse>;
		getTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionGetRequest,
		) => Promise<RuntimeTaskConversationSessionGetResponse>;
		resumeTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionResumeRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskConversationSessionResumeResponse>;
		reportTaskConversationSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationSessionReportRequest,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskConversationSessionReportResponse>;
		reconcileTaskConversationSessionOperations: () => Promise<void>;
		closeTaskConversationSessionOperations: () => Promise<void>;
		isTaskConversationSessionReportExecutionAllowed: (
			scope: RuntimeTrpcWorkspaceScope,
			origin: NonNullable<QueuedTaskPromptDeliveryEntry["taskConversationSessionReportOrigin"]>,
		) => Promise<boolean>;
		recordExplicitTaskConversationSessionStart: (
			scope: RuntimeTrpcWorkspaceScope,
			sessionId: string,
		) => Promise<void>;
		startTaskSession: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskSessionStartRequest,
			beforeAgentProcessLaunch?: (launchingSummary: RuntimeTaskSessionSummary) => Promise<void>,
			backlogTaskStartReadinessOperationId?: string,
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
		actOnAutomaticFailureContinuation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeAutomaticAgentFailureContinuationActionRequest,
		) => Promise<{ ok: boolean }>;
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
		exitCodexTaskConversationSessionPlanMode: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeExitCodexTaskConversationSessionPlanModeRequest,
		) => Promise<RuntimeExitCodexTaskConversationSessionPlanModeResponse>;
		getTaskChatMessages: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskChatMessagesRequest,
		) => Promise<RuntimeTaskChatMessagesResponse>;
		getTaskConversationHistoryPage: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskConversationHistoryPageRequest,
		) => Promise<RuntimeTaskConversationHistoryPageResponse>;
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
		getTerminalInputBoxStashOperationStatus: (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string; operationId: string },
		) => Promise<RuntimeTerminalInputBoxStashResponse>;
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
		getTerminalAgentModelSelectionOptions: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeTerminalAgentModelSelectionOptionsRequest,
		) => Promise<RuntimeTerminalAgentModelSelectionOptionsResponse>;
		getAvailableAgentSessions: (
			scope: RuntimeTrpcWorkspaceScope | null,
			input: RuntimeAvailableAgentSessionsRequest,
		) => Promise<RuntimeAvailableAgentSessionsResponse>;
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
		requestPlannedHandoverRestartPreservingHostedAgentSessions: (
			input: RuntimePlannedHandoverRestartRequest,
		) => Promise<RuntimePlannedHandoverRestartResponse>;
		requestRuntimeStopTerminatingHostedAgentSessions: () => Promise<RuntimeStopTerminatingHostedAgentSessionsResponse>;
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
			input?: RuntimeTaskWorkspaceGitStatusesRequest,
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
		readTaskClosureHistory: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof taskClosureHistoryRequestSchema>,
		) => Promise<z.infer<typeof taskClosureHistoryResponseSchema>>;
		correctTaskClosureOutcome: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof taskClosureOutcomeCorrectionRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof taskClosureRecordSchema>>;
		cancelTaskClosureOperation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof taskClosureHistoryRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof taskClosureHistoryResponseSchema>>;

		applyTaskStickerEntryMutation: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof runtimeTaskCardActionApplyTaskStickerEntryMutationRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof runtimeTaskCardActionApplyTaskStickerEntryMutationResponseSchema>>;
		transferNeverStartedBacklogTaskToProject?: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<{ operationId: string; workspaceId: string; taskId: string }>;
		readTaskCardWithBoardColumn: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionReadTaskCardWithBoardColumnRequest,
		) => Promise<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse>;
		startTaskCardAgentSessionMovingItIntoInProgress: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionStartAgentSessionRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
			beforeAgentProcessLaunch?: () => Promise<void>,
		) => Promise<RuntimeTaskCardActionStartAgentSessionResponse>;
		assessBacklogTaskStartReadiness: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof backlogTaskStartReadinessAssessmentRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof backlogTaskStartReadinessAssessmentResponseSchema>>;
		readBacklogTaskStartReadinessReport: (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof backlogTaskStartReadinessAssessmentRequestSchema>,
		) => Promise<z.infer<typeof backlogTaskStartReadinessAssessmentResponseSchema>>;
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
		setTaskCardShelvingStateWithoutSessionSideEffects: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionSetShelvingStateRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionSetShelvingStateResponse>;
		setTaskPinboardPinStateOfTaskCard: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeTaskCardActionSetTaskPinboardPinStateRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		) => Promise<RuntimeTaskCardActionSetTaskPinboardPinStateResponse>;
	};
	projectsApi: {
		getAllProjectsTaskGroupQuerySnapshot: (
			input: RuntimeAllProjectsTaskGroupQueryRequest,
		) => Promise<RuntimeAllProjectsTaskGroupQuerySnapshot>;
		setProjectVisualIdentity: (input: SetProjectVisualIdentityRequest) => Promise<ProjectVisualIdentity>;
		resetProjectVisualIdentityToDefault: (input: { workspaceId: string }) => Promise<ProjectVisualIdentity>;
		readProjectIconImage: (input: {
			workspaceId: string;
			imageAssetId: string;
		}) => Promise<{ mediaType: "image/png"; base64Content: string }>;
		listProjects: (preferredWorkspaceId: string | null) => Promise<RuntimeProjectsResponse>;
		previewDuplicateProjectConsolidation: (
			input: z.infer<typeof duplicateProjectConsolidationPreviewRequestSchema>,
		) => Promise<z.infer<typeof duplicateProjectConsolidationPreviewSchema>>;
		consolidateDuplicateProject: (
			input: z.infer<typeof duplicateProjectConsolidationRequestSchema>,
			evidence: KanbanRequestOriginActorEvidence,
		) => Promise<z.infer<typeof duplicateProjectConsolidationResultSchema>>;
		previewProjectAdd: (input: RuntimeProjectAddPreviewRequest) => Promise<RuntimeProjectAddPreviewResponse>;
		addProject: (
			preferredWorkspaceId: string | null,
			input: RuntimeProjectAddRequest,
			evidence: KanbanRequestOriginActorEvidence,
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
		getPostDeployVerificationWorkspaceOverview: (
			scope: RuntimeTrpcWorkspaceScope,
		) => Promise<RuntimePostDeployVerificationWorkspaceOverview>;
		getPostDeployVerificationDeploymentGroup: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeGetPostDeployVerificationDeploymentGroupRequest,
		) => Promise<RuntimeGetPostDeployVerificationDeploymentGroupResponse>;
		resolveTaskPostDeployVerificationEntryNavigationTargets: (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequest,
			readRelationNeighborhood: RuntimeTrpcContext["workUnitRelationReadApi"]["getRelationNeighborhoodSummary"],
		) => Promise<RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse>;
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
		getDirectlyRelatedTaskPreviewPage: (
			input: GetDirectlyRelatedTaskPreviewPageRequest,
		) => Promise<GetDirectlyRelatedTaskPreviewPageResponse>;
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
const procedureRejectingUnknownWebUiPageLoadRequestOriginNonce = t.procedure.use(async ({ ctx, next, type }) => {
	if (ctx.kanbanRequestOriginActorEvidence.webUiPageLoadRequestOriginNonceVerificationStatus === "unknown") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
		});
	}
	if (ctx.requestedWorkspaceId) {
		if (ctx.workspaceScope && ctx.workspaceScope.workspaceId !== ctx.requestedWorkspaceId && type === "mutation")
			throw new TRPCError({ code: "PRECONDITION_FAILED", message: "项目归属已变化，请刷新后在目标项目执行。" });
		if (ctx.workspaceScope?.workspaceId === ctx.requestedWorkspaceId)
			await assertWorkspaceHasNotBeenConsolidated(ctx.requestedWorkspaceId);
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

function buildTaskEditorCreationRouter() {
	return t.router({
		recoverLegacyDraft: workspaceProcedure
			.input(referenceRelationModelingEditorDraftSchema)
			.output(referenceRelationModelingEditorDraftSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskEditorCreationSubmissionApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskEditorCreationSubmissionApi.migrateLegacyDraft(ctx.workspaceScope.workspaceId, input);
			}),
		submit: workspaceProcedure
			.input(taskEditorCreationSubmissionRequestSchema)
			.output(taskEditorCreationSubmissionStatusSchema)
			.mutation(({ ctx, input }) => {
				if (!ctx.taskEditorCreationSubmissionApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskEditorCreationSubmissionApi.submit(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
		getStatus: workspaceProcedure
			.input(taskEditorCreationSubmissionLookupSchema)
			.output(taskEditorCreationSubmissionStatusSchema.nullable())
			.query(({ ctx, input }) => {
				if (!ctx.taskEditorCreationSubmissionApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskEditorCreationSubmissionApi.getStatus(ctx.workspaceScope, input);
			}),
		listForTask: workspaceProcedure
			.input(taskEditorCreationSubmissionsForTaskRequestSchema)
			.output(z.array(taskEditorCreationSubmissionStatusSchema))
			.query(({ ctx, input }) => {
				if (!ctx.taskEditorCreationSubmissionApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskEditorCreationSubmissionApi.listForTask(ctx.workspaceScope, input);
			}),
		retry: workspaceProcedure
			.input(taskEditorCreationSubmissionRetryRequestSchema)
			.output(taskEditorCreationSubmissionStatusSchema.nullable())
			.mutation(({ ctx, input }) => {
				if (!ctx.taskEditorCreationSubmissionApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
				return ctx.taskEditorCreationSubmissionApi.retry(
					ctx.workspaceScope,
					input,
					ctx.kanbanRequestOriginActorEvidence,
				);
			}),
	});
}
export interface TaskEditorCreationRouter extends ReturnType<typeof buildTaskEditorCreationRouter> {}
const taskEditorCreationRouter: TaskEditorCreationRouter = buildTaskEditorCreationRouter();

const runtimeApplicationTaskCommandExecutionProcedureRouter = t.router({
	adoptExistingSupervisor: workspaceProcedure
		.input(taskCommandExecutionAdoptExistingSupervisorRequestSchema)
		.output(taskCommandExecutionResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.taskCommandExecutionApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "所属命令执行服务尚未就绪" });
			return {
				ok: true as const,
				execution: await ctx.taskCommandExecutionApi.adoptExistingSupervisor(ctx.workspaceScope.workspaceId, input),
			};
		}),
	registerRecoveryEvidenceObservation: workspaceProcedure
		.input(taskCommandExecutionRecoveryObservationRegistrationRequestSchema)
		.output(taskCommandExecutionResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.taskCommandExecutionApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "所属命令执行服务尚未就绪" });
			return {
				ok: true as const,
				execution: await ctx.taskCommandExecutionApi.registerRecoveryEvidenceObservation(
					ctx.workspaceScope.workspaceId,
					input,
				),
			};
		}),
	start: workspaceProcedure
		.input(taskCommandExecutionStartRequestSchema)
		.output(taskCommandExecutionResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.taskCommandExecutionApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "所属命令执行服务尚未就绪" });
			return {
				ok: true as const,
				execution: await ctx.taskCommandExecutionApi.start(ctx.workspaceScope.workspaceId, input),
			};
		}),
	inspect: workspaceProcedure
		.input(taskCommandExecutionIdentityRequestSchema)
		.output(taskCommandExecutionResponseSchema)
		.query(async ({ ctx, input }) => {
			if (!ctx.taskCommandExecutionApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "所属命令执行服务尚未就绪" });
			return {
				ok: true as const,
				execution: await ctx.taskCommandExecutionApi.inspect(ctx.workspaceScope.workspaceId, input),
			};
		}),
	cancel: workspaceProcedure
		.input(taskCommandExecutionIdentityRequestSchema)
		.output(taskCommandExecutionResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.taskCommandExecutionApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "所属命令执行服务尚未就绪" });
			return {
				ok: true as const,
				execution: await ctx.taskCommandExecutionApi.cancel(ctx.workspaceScope.workspaceId, input),
			};
		}),
});

const runtimeApplicationDailyWorkProgressStatisticsProcedureRouter = t.router({
	getSummary: t.procedure
		.input(runtimeDailyWorkProgressRequestSchema)
		.output(runtimeDailyWorkProgressSummarySchema)
		.query(({ ctx, input }) => {
			if (!ctx.dailyWorkProgressStatisticsApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "今日进展统计尚未就绪" });
			return ctx.dailyWorkProgressStatisticsApi.getSummary(input);
		}),
	claimCelebrations: t.procedure
		.input(runtimeClaimDailyWorkProgressCelebrationsRequestSchema)
		.output(runtimeClaimDailyWorkProgressCelebrationsResponseSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.dailyWorkProgressStatisticsApi)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "今日进展统计尚未就绪" });
			return ctx.dailyWorkProgressStatisticsApi.claimCelebrations(input);
		}),
});

const runtimeApplicationNotificationIntelligenceProcedureRouter = t.router({
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
				reason: z.enum(["notifications_disabled", "foreground_visible", "visible_peer_tab", "eligible", "stale"]),
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
			await archive.update(input.candidateId, {}, `client_${input.observation}`, redactNotificationEvidence(input));
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
	previewSpeech: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce.mutation(() => previewNotificationSpeech()),
	archivedAudio: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(z.object({ candidateId: z.string() }))
		.query(({ input }) => readArchivedNotificationAudio(input.candidateId)),
});

const runtimeApplicationSupportProcedureRouter = t.router({
	saveAgentPromptFileAttachment: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeSaveAgentPromptFileAttachmentRequestSchema)
		.output(runtimeAgentPromptFileAttachmentReferenceSchema)
		.mutation(({ input }) => savePersistentAgentPromptFileAttachment(input)),
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
	getTaskAssistanceModelProviderRoutingSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.output(taskAssistanceModelProviderRoutingSettingsSchema)
		.query(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.getTaskAssistanceModelProviderRoutingSettings();
		}),
	setTaskAssistanceModelProviderRoutingSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(taskAssistanceModelProviderRoutingSettingsSchema)
		.output(taskAssistanceModelProviderRoutingSettingsSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.setTaskAssistanceModelProviderRoutingSettings(input);
		}),
	getGlobalExecutorSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.output(taskIndexingSupportExecutorSettingsSchema)
		.query(({ ctx }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.getGlobalExecutorSettings();
		}),
	setGlobalExecutorSettings: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(taskIndexingSupportExecutorSettingsSchema)
		.output(taskIndexingSupportExecutorSettingsSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.setGlobalExecutorSettings(input);
		}),
	analyzeTaskProjectAssignment: workspaceProcedure
		.input(taskProjectAssignmentAnalysisRequestSchema)
		.output(taskProjectAssignmentAnalysisResponseSchema)
		.mutation(({ ctx, input, signal }) => {
			if (!ctx.taskIndexingSupportApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskIndexingSupportApi.analyzeTaskProjectAssignment(ctx.workspaceScope, input, signal);
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
});

const runtimeApplicationIndependentTaskCreationProcedureRouter = t.router({
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
});

const runtimeApplicationRuntimeProcedureRouter = t.router({
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
			return ctx.taskMainSessionHandoverApi.request(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence);
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
	recoverTaskMainSessionHandoverWithNewAgentSession: workspaceProcedure
		.input(taskMainSessionHandoverRecoverWithNewAgentSessionRequestSchema)
		.output(taskMainSessionHandoverStatusResponseSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskMainSessionHandoverApi) throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskMainSessionHandoverApi.recoverWithNewAgentSession(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			);
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
	getTaskRvfHistory: workspaceProcedure
		.input(taskRvfHistoryRequestSchema)
		.output(taskRvfHistoryResponseSchema)
		.query(({ ctx, input }) => getTaskRvfHistory(ctx.workspaceScope, input)),
	// Web UI 在 runtime-state-stream 每次连上 / 重连时调用；带着失效 nonce 也能调（它就是重取入口）。
	issueKanbanWebUiPageLoadRequestOriginNonce: t.procedure
		.output(kanbanWebUiPageLoadRequestOriginNonceIssueResponseSchema)
		.mutation(() => ({
			kanbanWebUiPageLoadIssuedRequestOriginNonce: issueKanbanWebUiPageLoadRequestOriginNonce(),
		})),
	getAgentSessionPtyHostDiagnostics: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.output(agentSessionPtyHostDiagnosticsSchema)
		.query(() => queryCurrentRuntimeAgentSessionPtyHostDiagnostics()),
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

	recordCurrentTaskProgress: workspaceProcedure
		.input(runtimeRecordCurrentTaskProgressRequestSchema)
		.output(runtimeTaskSessionInputResponseSchema.extend({ taskMetadataReviewReminder: z.string() }))
		.mutation(({ ctx, input }) =>
			ctx.runtimeApi.recordCurrentTaskProgress(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence),
		),
	requestAutomaticTaskNameBackfill: workspaceProcedure
		.input(runtimeAutomaticTaskNameBackfillRequestSchema)
		.output(z.object({ ok: z.boolean() }))
		.mutation(({ ctx, input }) => ctx.runtimeApi.requestAutomaticTaskNameBackfill(ctx.workspaceScope, input)),
	suggestTaskNamesFromTaskDescription: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeTaskNameSuggestionRequestSchema)
		.output(runtimeTaskNameSuggestionResponseSchema)
		.mutation(async ({ ctx, input, signal }) => {
			return await ctx.runtimeApi.suggestTaskNamesFromTaskDescription(ctx.workspaceScope, input, signal);
		}),
	lookupTaskConversationSessionCreation: workspaceProcedure
		.input(runtimeTaskConversationSessionCreateRequestSchema)
		.output(runtimeTaskConversationSessionCreateResponseSchema.nullable())
		.query(({ ctx, input }) => ctx.runtimeApi.lookupTaskConversationSessionCreation(ctx.workspaceScope, input)),
	previewTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionCreateRequestSchema)
		.output(runtimeTaskConversationSessionPreviewResponseSchema)
		.query(({ ctx, input }) =>
			ctx.runtimeApi.previewTaskConversationSession(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence),
		),
	renameTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionRenameRequestSchema)
		.output(runtimeTaskSessionInputResponseSchema)
		.mutation(({ ctx, input }) => ctx.runtimeApi.renameTaskConversationSession(ctx.workspaceScope, input)),
	createTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionCreateRequestSchema)
		.output(runtimeTaskConversationSessionCreateResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.runtimeApi.createTaskConversationSession(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence),
		),
	listTaskConversationSessions: workspaceProcedure
		.input(runtimeTaskConversationSessionListRequestSchema)
		.output(runtimeTaskConversationSessionListResponseSchema)
		.query(({ ctx, input }) => ctx.runtimeApi.listTaskConversationSessions(ctx.workspaceScope, input)),
	getTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionGetRequestSchema)
		.output(runtimeTaskConversationSessionGetResponseSchema)
		.query(({ ctx, input }) => ctx.runtimeApi.getTaskConversationSession(ctx.workspaceScope, input)),
	resumeTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionResumeRequestSchema)
		.output(runtimeTaskConversationSessionResumeResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.runtimeApi.resumeTaskConversationSession(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence),
		),
	reportTaskConversationSession: workspaceProcedure
		.input(runtimeTaskConversationSessionReportRequestSchema)
		.output(runtimeTaskConversationSessionReportResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.runtimeApi.reportTaskConversationSession(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence),
		),
	startTaskSession: workspaceProcedure
		.input(runtimeTaskSessionStartRequestSchema)
		.output(runtimeTaskSessionStartResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (
				!input.taskSessionStartOriginDeclaredByClient ||
				input.taskSessionStartOriginDeclaredByClient === "external_entry_point"
			)
				await ctx.runtimeApi.recordExplicitTaskConversationSessionStart(ctx.workspaceScope, input.taskId);
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
	actOnAutomaticFailureContinuation: workspaceProcedure
		.input(runtimeAutomaticAgentFailureContinuationActionRequestSchema)
		.output(runtimeAutomaticAgentFailureContinuationActionResponseSchema)
		.mutation(async ({ ctx, input }) => ctx.runtimeApi.actOnAutomaticFailureContinuation(ctx.workspaceScope, input)),
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
			if (
				!input.taskSessionStartOriginDeclaredByClient ||
				input.taskSessionStartOriginDeclaredByClient === "external_entry_point"
			)
				await ctx.runtimeApi.recordExplicitTaskConversationSessionStart(ctx.workspaceScope, input.taskId);
			return await ctx.runtimeApi.refreshTaskTerminal(ctx.workspaceScope, input);
		}),
	sendTaskSessionInput: workspaceProcedure
		.input(runtimeTaskSessionInputRequestSchema)
		.output(runtimeTaskSessionInputResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.sendTaskSessionInput(ctx.workspaceScope, input);
		}),
	exitCodexTaskConversationSessionPlanMode: workspaceProcedure
		.input(runtimeExitCodexTaskConversationSessionPlanModeRequestSchema)
		.output(runtimeExitCodexTaskConversationSessionPlanModeResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.exitCodexTaskConversationSessionPlanMode(ctx.workspaceScope, input);
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
	listTaskDirectory: workspaceProcedure
		.input(runtimeTaskDirectoryRequestSchema)
		.output(runtimeTaskDirectoryResponseSchema)
		.query(({ ctx, input }) => ctx.runtimeApi.listTaskDirectory(ctx.workspaceScope, input)),
	getTaskMainSessionPlan: workspaceProcedure
		.input(runtimeTaskFileIdentityRequestSchema)
		.output(runtimeTaskMainSessionPlanResponseSchema)
		.query(({ ctx, input }) => ctx.runtimeApi.getTaskMainSessionPlan(ctx.workspaceScope, input)),
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
	getTerminalInputBoxStashOperationStatus: workspaceProcedure
		.input(
			runtimeTerminalInputBoxStashRequestSchema
				.required({ operationId: true })
				.pick({ taskId: true, operationId: true }),
		)
		.output(runtimeTerminalInputBoxStashResponseSchema)
		.query(async ({ ctx, input }) =>
			ctx.runtimeApi.getTerminalInputBoxStashOperationStatus(ctx.workspaceScope, input),
		),
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
	operateCodexConversationStorage: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeCodexConversationStorageOperationRequestSchema)
		.output(runtimeCodexConversationStorageOperationResponseSchema)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.workspaceScope) throw new TRPCError({ code: "BAD_REQUEST", message: "请先选择工作区。" });
			return ctx.runtimeApi.operateCodexConversationStorage(ctx.workspaceScope, input);
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
	// `kanban runtime handover-restart`：热重启，agent session PTY host 里的会话留给下一个 runtime 接管。
	// 输入从首版起冻结（新 CLI 会对旧 runtime 发它）。回完响应才开始 handover。
	requestPlannedHandoverRestartPreservingHostedAgentSessions: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimePlannedHandoverRestartRequestSchema)
		.output(runtimePlannedHandoverRestartResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.runtimeApi.requestPlannedHandoverRestartPreservingHostedAgentSessions(input);
		}),
	// `kanban runtime stop --terminate-hosted-agent-sessions`：停 runtime 并终止全部 hosted 会话（含未接管的）。
	requestRuntimeStopTerminatingHostedAgentSessions: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.output(runtimeStopTerminatingHostedAgentSessionsResponseSchema)
		.mutation(async ({ ctx }) => {
			return await ctx.runtimeApi.requestRuntimeStopTerminatingHostedAgentSessions();
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
});

const runtimeApplicationWorkspaceProcedureRouter = t.router({
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
	getChangesConditional: workspaceProcedure
		.input(runtimeConditionalWorkspaceChangesRequestSchema)
		.output(runtimeConditionalWorkspaceChangesResponseSchema)
		.query(async ({ ctx, input }) =>
			buildConditionalWorkspaceChangesResponse(
				await ctx.workspaceApi.loadChanges(ctx.workspaceScope, input),
				input.knownContentVersion,
			),
		),
	readTaskCardsForPostDeployVerification: workspaceProcedure
		.input(runtimeReadTaskCardsForPostDeployVerificationRequestSchema)
		.output(runtimeReadTaskCardsForPostDeployVerificationResponseSchema)
		.query(async ({ ctx, input }) => {
			const state = await ctx.workspaceApi.loadState(ctx.workspaceScope);
			const taskIds = new Set(input.taskIds);
			const board = {
				columns: state.board.columns.map((column) => ({
					...column,
					cards: column.cards.filter((card) => taskIds.has(card.id)),
				})),
			};
			const sessions = Object.fromEntries(
				Object.entries(state.sessions).filter(
					([id, summary]) =>
						taskIds.has(id) || taskIds.has(summary.taskConversationSessionMetadata?.workspaceTaskId ?? ""),
				),
			);
			const projection = projectWorkspaceStateForBrowser({ ...state, board, sessions });
			return { repoPath: projection.repoPath, board: projection.board, sessions: projection.sessions };
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
		.input(runtimeTaskWorkspaceGitStatusesRequestSchema.optional())
		.output(runtimeTaskWorkspaceGitStatusesResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.workspaceApi.loadTaskWorkspaceGitStatuses(ctx.workspaceScope, input);
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
		const state = await ctx.workspaceApi.loadState(ctx.workspaceScope);
		return ctx.kanbanRequestOriginActorEvidence.webUiPageLoadRequestOriginNonceVerificationStatus === "verified"
			? projectWorkspaceStateForBrowser(state)
			: state;
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
			const state = await ctx.workspaceApi.saveState(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			);
			return ctx.kanbanRequestOriginActorEvidence.webUiPageLoadRequestOriginNonceVerificationStatus === "verified"
				? projectWorkspaceStateForBrowser(state)
				: state;
		}),
	addBacklogTask: workspaceProcedure
		.input(runtimeAddBacklogTaskRequestSchema)
		.output(runtimeAddBacklogTaskResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.workspaceApi.addBacklogTask(ctx.workspaceScope, input, ctx.kanbanRequestOriginActorEvidence);
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
});

const runtimeApplicationTaskCardActionProcedureRouter = t.router({
	readTaskClosureHistory: workspaceProcedure
		.input(taskClosureHistoryRequestSchema)
		.output(taskClosureHistoryResponseSchema)
		.query(({ ctx, input }) => ctx.taskCardActionApi.readTaskClosureHistory(ctx.workspaceScope, input)),
	correctTaskClosureOutcome: workspaceProcedure
		.input(taskClosureOutcomeCorrectionRequestSchema)
		.output(taskClosureRecordSchema)
		.mutation(({ ctx, input }) =>
			ctx.taskCardActionApi.correctTaskClosureOutcome(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			),
		),
	cancelTaskClosureOperation: workspaceProcedure
		.input(taskClosureHistoryRequestSchema)
		.output(taskClosureHistoryResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.taskCardActionApi.cancelTaskClosureOperation(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			),
		),

	applyTaskStickerEntryMutation: workspaceProcedure
		.input(runtimeTaskCardActionApplyTaskStickerEntryMutationRequestSchema)
		.output(runtimeTaskCardActionApplyTaskStickerEntryMutationResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.taskCardActionApi.applyTaskStickerEntryMutation(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			),
		),
	transferNeverStartedBacklogTaskToProject: workspaceProcedure
		.input(runtimeTaskCardActionTransferBacklogTaskToProjectRequestSchema)
		.output(runtimeTaskCardActionTransferBacklogTaskToProjectResponseSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskCardActionApi.transferNeverStartedBacklogTaskToProject)
				throw new TRPCError({ code: "NOT_IMPLEMENTED" });
			return ctx.taskCardActionApi.transferNeverStartedBacklogTaskToProject(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			);
		}),
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
	assessBacklogTaskStartReadiness: workspaceProcedure
		.input(backlogTaskStartReadinessAssessmentRequestSchema)
		.output(backlogTaskStartReadinessAssessmentResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.taskCardActionApi.assessBacklogTaskStartReadiness(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			),
		),
	readBacklogTaskStartReadinessReport: workspaceProcedure
		.input(backlogTaskStartReadinessAssessmentRequestSchema)
		.output(backlogTaskStartReadinessAssessmentResponseSchema)
		.query(({ ctx, input }) => ctx.taskCardActionApi.readBacklogTaskStartReadinessReport(ctx.workspaceScope, input)),
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
	setTaskCardShelvingStateWithoutSessionSideEffects: workspaceProcedure
		.input(runtimeTaskCardActionSetShelvingStateRequestSchema)
		.output(runtimeTaskCardActionSetShelvingStateResponseSchema)
		.mutation(({ ctx, input }) =>
			ctx.taskCardActionApi.setTaskCardShelvingStateWithoutSessionSideEffects(
				ctx.workspaceScope,
				input,
				ctx.kanbanRequestOriginActorEvidence,
			),
		),
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
});

const runtimeApplicationProjectsProcedureRouter = t.router({
	previewDuplicateConsolidation: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(duplicateProjectConsolidationPreviewRequestSchema)
		.output(duplicateProjectConsolidationPreviewSchema)
		.query(({ ctx, input }) => ctx.projectsApi.previewDuplicateProjectConsolidation(input)),
	consolidateDuplicate: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(duplicateProjectConsolidationRequestSchema)
		.output(duplicateProjectConsolidationResultSchema)
		.mutation(({ ctx, input }) =>
			ctx.projectsApi.consolidateDuplicateProject(input, ctx.kanbanRequestOriginActorEvidence),
		),
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
	getAllProjectsTaskGroupQuerySnapshot: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeAllProjectsTaskGroupQueryRequestSchema)
		.output(runtimeAllProjectsTaskGroupQuerySnapshotSchema)
		.query(({ ctx, input }) => ctx.projectsApi.getAllProjectsTaskGroupQuerySnapshot(input)),
	previewAdd: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeProjectAddPreviewRequestSchema)
		.output(runtimeProjectAddPreviewResponseSchema)
		.query(({ ctx, input }) => ctx.projectsApi.previewProjectAdd(input)),
	add: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeProjectAddRequestSchema)
		.output(runtimeProjectAddResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.projectsApi.addProject(ctx.requestedWorkspaceId, input, ctx.kanbanRequestOriginActorEvidence);
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
});

const runtimeApplicationHooksProcedureRouter = t.router({
	ingest: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(runtimeHookIngestRequestSchema)
		.output(runtimeHookIngestResponseSchema)
		.mutation(async ({ ctx, input }) => {
			return await ctx.hooksApi.ingest(input);
		}),
});

const runtimeApplicationDeploymentProcedureRouter = t.router({
	getPostDeployVerificationWorkspaceOverview: workspaceProcedure
		.output(runtimePostDeployVerificationWorkspaceOverviewSchema)
		.query(({ ctx }) => ctx.deploymentApi.getPostDeployVerificationWorkspaceOverview(ctx.workspaceScope)),
	getPostDeployVerificationDeploymentGroup: workspaceProcedure
		.input(runtimeGetPostDeployVerificationDeploymentGroupRequestSchema)
		.output(runtimeGetPostDeployVerificationDeploymentGroupResponseSchema)
		.query(({ ctx, input }) => ctx.deploymentApi.getPostDeployVerificationDeploymentGroup(ctx.workspaceScope, input)),
	resolveTaskPostDeployVerificationEntryNavigationTargets: workspaceProcedure
		.input(runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequestSchema)
		.output(runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponseSchema)
		.query(({ ctx, input }) =>
			ctx.deploymentApi.resolveTaskPostDeployVerificationEntryNavigationTargets(
				ctx.workspaceScope,
				input,
				ctx.workUnitRelationReadApi.getRelationNeighborhoodSummary,
			),
		),
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
	listWorkspacesHavingPostDeployVerificationDeploymentGroups: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.output(runtimeListWorkspacesHavingPostDeployVerificationDeploymentGroupsResponseSchema)
		.query(async ({ ctx }) => {
			return await ctx.deploymentApi.listWorkspacesHavingPostDeployVerificationDeploymentGroups();
		}),
});

const runtimeApplicationWorkUnitProcedureRouter = t.router({
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
	getDirectlyRelatedTaskPreviewPage: procedureRejectingUnknownWebUiPageLoadRequestOriginNonce
		.input(getDirectlyRelatedTaskPreviewPageRequestSchema)
		.output(getDirectlyRelatedTaskPreviewPageResponseSchema)
		.query(({ ctx, input }) => ctx.workUnitRelationReadApi.getDirectlyRelatedTaskPreviewPage(input)),
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
		.query(async ({ ctx, input }) => {
			const draft = await ctx.workUnitRelationReadApi.readRelationModelingEditorDraft(input);
			if (!draft?.createdTaskId || !ctx.taskEditorCreationSubmissionApi) return draft;
			const migrated = await ctx.taskEditorCreationSubmissionApi.migrateLegacyDraft(input.workspaceId, draft);
			await ctx.workUnitRelationReadApi.saveRelationModelingEditorDraft({ ...input, draft: migrated });
			return migrated;
		}),
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
});

const runtimeApplicationConversationTreeProcedureRouter = t.router({
	// 会话 turn 投影（只读派生层，姊妹蓝图 §2.2）：findings 出处锚与（远期）会话树共享同一
	// 数据源。M0 只接 Cline SDK 源，其余 transport 按 session 粒度降级。
	getConversationSessionTurnProjection: workspaceProcedure
		.input(runtimeConversationSessionTurnProjectionRequestSchema)
		.output(runtimeConversationSessionTurnProjectionResponseSchema)
		.query(async ({ ctx, input }) => {
			return await ctx.conversationTreeApi.getConversationSessionTurnProjection(ctx.workspaceScope, input);
		}),
});

const runtimeApplicationTaskVisualizationArtifactsProcedureRouter = t.router({
	publish: workspaceProcedure
		.input(taskVisualizationPublishRequestSchema)
		.output(taskVisualizationPublishResponseSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskVisualizationArtifactApi)
				throw new TRPCError({ code: "PRECONDITION_FAILED", message: "运行时尚未启用可视化发布。" });
			return ctx.taskVisualizationArtifactApi.publish(ctx.workspaceScope, input);
		}),
	list: workspaceProcedure
		.input(taskVisualizationListRequestSchema)
		.output(taskVisualizationListResponseSchema)
		.query(({ ctx, input }) => {
			if (!ctx.taskVisualizationArtifactApi)
				throw new TRPCError({ code: "PRECONDITION_FAILED", message: "运行时尚未启用可视化发布。" });
			return ctx.taskVisualizationArtifactApi.list(ctx.workspaceScope, input);
		}),
	preparePreview: workspaceProcedure
		.input(taskVisualizationSelectArtifactRequestSchema)
		.output(taskVisualizationPreparePreviewResponseSchema)
		.query(({ ctx, input }) => {
			if (!ctx.taskVisualizationArtifactApi)
				throw new TRPCError({ code: "PRECONDITION_FAILED", message: "运行时尚未启用可视化发布。" });
			return ctx.taskVisualizationArtifactApi.preparePreview(ctx.workspaceScope, input);
		}),
	requestPreview: workspaceProcedure
		.input(taskVisualizationSelectArtifactRequestSchema)
		.output(taskVisualizationRequestPreviewResponseSchema)
		.mutation(({ ctx, input }) => {
			if (!ctx.taskVisualizationArtifactApi)
				throw new TRPCError({ code: "PRECONDITION_FAILED", message: "运行时尚未启用可视化发布。" });
			return ctx.taskVisualizationArtifactApi.requestPreview(ctx.workspaceScope, input);
		}),
});

const runtimeApplicationExploratoryProcedureRouter = t.router({
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
});

// 保留具名子路由类型，避免新契约使声明输出超过 TypeScript 的序列化长度上限。
type RuntimeAppRouterProcedureRecord = {
	taskCommandExecution: typeof runtimeApplicationTaskCommandExecutionProcedureRouter;
	dailyWorkProgressStatistics: typeof runtimeApplicationDailyWorkProgressStatisticsProcedureRouter;
	notificationIntelligence: typeof runtimeApplicationNotificationIntelligenceProcedureRouter;
	support: typeof runtimeApplicationSupportProcedureRouter;
	taskEditorCreation: TaskEditorCreationRouter;
	independentTaskCreation: typeof runtimeApplicationIndependentTaskCreationProcedureRouter;
	runtime: typeof runtimeApplicationRuntimeProcedureRouter;
	workspace: typeof runtimeApplicationWorkspaceProcedureRouter;
	taskCardAction: typeof runtimeApplicationTaskCardActionProcedureRouter;
	projects: typeof runtimeApplicationProjectsProcedureRouter;
	hooks: typeof runtimeApplicationHooksProcedureRouter;
	deployment: typeof runtimeApplicationDeploymentProcedureRouter;
	workUnit: typeof runtimeApplicationWorkUnitProcedureRouter;
	conversationTree: typeof runtimeApplicationConversationTreeProcedureRouter;
	taskVisualizationArtifacts: typeof runtimeApplicationTaskVisualizationArtifactsProcedureRouter;
	exploratory: typeof runtimeApplicationExploratoryProcedureRouter;
};
const runtimeAppRouterProcedureRecord: RuntimeAppRouterProcedureRecord = {
	taskCommandExecution: runtimeApplicationTaskCommandExecutionProcedureRouter,
	dailyWorkProgressStatistics: runtimeApplicationDailyWorkProgressStatisticsProcedureRouter,
	notificationIntelligence: runtimeApplicationNotificationIntelligenceProcedureRouter,
	support: runtimeApplicationSupportProcedureRouter,
	taskEditorCreation: taskEditorCreationRouter,
	independentTaskCreation: runtimeApplicationIndependentTaskCreationProcedureRouter,
	runtime: runtimeApplicationRuntimeProcedureRouter,
	workspace: runtimeApplicationWorkspaceProcedureRouter,
	// 看板卡片 per-card 动作（契约与错误语义见 api-contract 的 taskCardAction 一节）。全部 workspace-scoped：
	// 作用于 x-kanban-workspace-id 指向的任意已注册项目，跨项目执行动作不需要切换浏览器当前项目。
	taskCardAction: runtimeApplicationTaskCardActionProcedureRouter,
	projects: runtimeApplicationProjectsProcedureRouter,
	hooks: runtimeApplicationHooksProcedureRouter,
	deployment: runtimeApplicationDeploymentProcedureRouter,
	// dd2db 1b：工作单元间关系的读侧（记录型邻域、跨 project 身份解析、会话归属、上下文端口）。全是只读 query。
	workUnit: runtimeApplicationWorkUnitProcedureRouter,
	conversationTree: runtimeApplicationConversationTreeProcedureRouter,
	taskVisualizationArtifacts: runtimeApplicationTaskVisualizationArtifactsProcedureRouter,
	exploratory: runtimeApplicationExploratoryProcedureRouter,
};

export const runtimeAppRouter: ReturnType<typeof t.router<RuntimeAppRouterProcedureRecord>> = t.router(
	runtimeAppRouterProcedureRecord,
);

export type RuntimeAppRouter = typeof runtimeAppRouter;
export type RuntimeAppRouterInputs = inferRouterInputs<RuntimeAppRouter>;
export type RuntimeAppRouterOutputs = inferRouterOutputs<RuntimeAppRouter>;
