import type { WebUiUserDecisionClientCharacteristics } from "@runtime-work-unit-relation-assertion-write-api-contract";
import type { ReferenceRelationModelingEditorDraft } from "@runtime-work-unit-relation-modeling-api-contract";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { TaskEditorCreationSubmissionRequest } from "@/runtime/types";

export const submitTaskEditorCreation = (workspaceId: string, request: TaskEditorCreationSubmissionRequest) =>
	getRuntimeTrpcClient(workspaceId).taskEditorCreation.submit.mutate(request);
export const readTaskEditorCreationSubmissionStatus = (workspaceId: string, submissionId: string) =>
	getRuntimeTrpcClient(workspaceId).taskEditorCreation.getStatus.query({ submissionId });
export const readTaskEditorCreationSubmissionsForTask = (
	workspaceId: string,
	taskId: string,
	taskIncarnationCreatedAtEpochMs: number,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).taskEditorCreation.listForTask.query(
		{ taskId, taskIncarnationCreatedAtEpochMs },
		{ signal },
	);
export const retryTaskEditorCreationSubmission = (
	workspaceId: string,
	submissionId: string,
	webUiUserDecisionClientCharacteristics: WebUiUserDecisionClientCharacteristics,
) =>
	getRuntimeTrpcClient(workspaceId).taskEditorCreation.retry.mutate({
		submissionId,
		webUiUserDecisionClientCharacteristics,
	});
export const recoverLegacyTaskEditorCreationDraft = (
	workspaceId: string,
	draft: ReferenceRelationModelingEditorDraft,
) => getRuntimeTrpcClient(workspaceId).taskEditorCreation.recoverLegacyDraft.mutate(draft);
