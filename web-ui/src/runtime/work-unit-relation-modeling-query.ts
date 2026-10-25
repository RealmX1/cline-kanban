import { getWorkspaceFolderLabelForWorktreePath } from "@runtime-task-worktree-path";
import type {
	ApplyReferenceRelationModelingChangesRequest,
	ReferenceRelationModelingEditorDraft,
	ReferenceRelationModelingSuggestionsRequest,
	RelationModelingPreviewRequest,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart } from "@/runtime/new-backlog-task-card-persistence-before-agent-session-start-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeBoardCard } from "@/runtime/types";

export function readRelationModelingPreview(workspaceId: string, input: RelationModelingPreviewRequest) {
	return getRuntimeTrpcClient(workspaceId).workUnit.getRelationModelingPreview.query(input);
}
export function requestReferenceRelationModelingSuggestions(
	workspaceId: string,
	input: ReferenceRelationModelingSuggestionsRequest,
) {
	return getRuntimeTrpcClient(workspaceId).workUnit.suggestReferenceRelationsForTaskModeling.mutate(input);
}
export function applyReferenceRelationModelingChangesFromExplicitUserGesture(
	workspaceId: string,
	input: ApplyReferenceRelationModelingChangesRequest,
) {
	return getRuntimeTrpcClient(workspaceId).workUnit.applyReferenceRelationModelingChangesDirectlyAsWebUiUser.mutate(
		input,
	);
}
export function readRelationModelingEditorDraft(workspaceId: string, draftScopeId: string) {
	return getRuntimeTrpcClient(workspaceId).workUnit.readRelationModelingEditorDraft.query({
		workspaceId,
		draftScopeId,
	});
}
export function persistRelationModelingEditorDraft(
	workspaceId: string,
	draftScopeId: string,
	draft: ReferenceRelationModelingEditorDraft | null,
) {
	return getRuntimeTrpcClient(workspaceId).workUnit.saveRelationModelingEditorDraft.mutate({
		workspaceId,
		draftScopeId,
		draft,
	});
}
export async function resolveRelationModelingCounterpart(workspaceId: string, taskId: string) {
	const response = await getRuntimeTrpcClient(workspaceId).workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({
		bareTaskId: taskId,
	});
	const candidates = response.kanbanBoardCardIdentityCandidates.filter(
		(entry) => entry.kanbanBoardCard.workspaceId === workspaceId && entry.permanentlyRemovedFromBoardAt === null,
	);
	if (candidates.length !== 1) throw new Error("任务身份已变化，请重新搜索并选择。 ");
	const candidate = candidates[0];
	if (!candidate) throw new Error("未找到任务身份。 ");
	return candidate.canonicalKanbanBoardCard ?? candidate.kanbanBoardCard;
}

export async function resolveTaskEditorClipboardTaskCandidates(
	workspaceId: string,
	reference: { taskId: string; repositoryFolder: string | null },
) {
	const response = await getRuntimeTrpcClient(workspaceId).workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({
		bareTaskId: reference.taskId,
	});
	return response.kanbanBoardCardIdentityCandidates.filter((candidate) => {
		if (candidate.permanentlyRemovedFromBoardAt !== null) return false;
		if (!reference.repositoryFolder) return true;
		return [candidate.workspaceRepositoryPath, ...(candidate.previousWorkspaceRepositoryPaths ?? [])].some(
			(path) => path && getWorkspaceFolderLabelForWorktreePath(path) === reference.repositoryFolder,
		);
	});
}

export async function ensureRelationModelingCreatedTaskCardPersisted(
	workspaceId: string,
	snapshot: RuntimeBoardCard,
): Promise<void> {
	const client = getRuntimeTrpcClient(workspaceId);
	const identities = await client.workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({
		bareTaskId: snapshot.id,
	});
	const existing = identities.kanbanBoardCardIdentityCandidates.find(
		(entry) => entry.kanbanBoardCard.workspaceId === workspaceId,
	);
	if (
		existing &&
		(existing.permanentlyRemovedFromBoardAt !== null ||
			existing.kanbanBoardCard.taskIncarnationCreatedAtEpochMs !== snapshot.createdAt)
	)
		throw new Error("原任务已删除或身份已变化，不能恢复为新任务。 ");
	if (!existing)
		await persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
			workspaceId,
			newBacklogTaskCardsCreatedFromWebUi: [snapshot],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});
}
