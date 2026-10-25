import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { GetDirectlyRelatedTaskPreviewPageResponse } from "@runtime-work-unit-relation-read-api-contract";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { createTaskRelatedPreviewReadCache } from "@/runtime/task-related-preview-read-cache";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

const sharedTaskPreviewReadCache = createTaskRelatedPreviewReadCache();

export function buildQualifiedTaskPreviewIdentityKey(task: KanbanBoardCardWorkUnitQualifiedReference): string {
	return JSON.stringify([task.workspaceId, task.taskId, task.taskIncarnationCreatedAtEpochMs]);
}

export function fetchDirectlyRelatedTaskPreviewPage(
	task: KanbanBoardCardWorkUnitQualifiedReference,
	cursor?: string,
	forceReload = false,
): Promise<GetDirectlyRelatedTaskPreviewPageResponse> {
	return sharedTaskPreviewReadCache.read(
		`relations:${buildQualifiedTaskPreviewIdentityKey(task)}:${cursor ?? "first"}`,
		() =>
			getRuntimeTrpcClient(task.workspaceId).workUnit.getDirectlyRelatedTaskPreviewPage.query(
				{ task, cursor },
				{ signal: AbortSignal.timeout(15_000) },
			),
		forceReload,
	);
}

export function fetchQualifiedTaskCardSnapshotForRelatedPreview(
	task: KanbanBoardCardWorkUnitQualifiedReference,
	forceReload = false,
	freshnessToken?: string,
) {
	const cacheKey = `snapshot:${buildQualifiedTaskPreviewIdentityKey(task)}`;
	if (forceReload && freshnessToken !== undefined)
		sharedTaskPreviewReadCache.invalidateIfFreshnessTokenChanged(cacheKey, freshnessToken);
	return sharedTaskPreviewReadCache.read(
		cacheKey,
		() =>
			readTaskCardWithBoardColumnInWorkspace(
				task.workspaceId,
				task.taskId,
				task.taskIncarnationCreatedAtEpochMs,
				AbortSignal.timeout(15_000),
			),
		forceReload,
	);
}
