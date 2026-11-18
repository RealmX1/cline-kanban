import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { VisitedTaskHistoryEntry } from "@/state/visited-task-navigation-history";

export type VisitedTaskNavigationTarget =
	| { outcome: "available"; entry: VisitedTaskHistoryEntry; currentWorkspaceId: string }
	| { outcome: "unavailable" };

/** 迁移别名必须来自原生身份登记；裸 ID 或相同时间戳都不能单独证明归属。 */
export async function resolveVisitedTaskNavigationTarget(
	entry: VisitedTaskHistoryEntry,
	signal: AbortSignal,
	identityLookupWorkspaceId = entry.workspaceId,
): Promise<VisitedTaskNavigationTarget> {
	let currentWorkspaceId = entry.workspaceId;
	let resolvedEntry = entry;
	let identityLookupSucceeded = false;
	try {
		const response = await getRuntimeTrpcClient(
			identityLookupWorkspaceId,
		).workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({ bareTaskId: entry.taskId }, { signal });
		identityLookupSucceeded = true;
		const candidates = response.kanbanBoardCardIdentityCandidates.filter(
			(candidate) =>
				candidate.kanbanBoardCard.taskIncarnationCreatedAtEpochMs === entry.taskIncarnationCreatedAtEpochMs &&
				(candidate.kanbanBoardCard.workspaceId === entry.workspaceId ||
					candidate.canonicalKanbanBoardCard?.workspaceId === entry.workspaceId ||
					candidate.workspaceIdsUsedByTaskIncarnation?.includes(entry.workspaceId)),
		);
		if (candidates.length > 1) throw new Error("任务身份存在歧义，无法定位原任务。");
		const candidate = candidates[0];
		if (candidate) {
			if (candidate.permanentlyRemovedFromBoardAt !== null) return { outcome: "unavailable" };
			currentWorkspaceId = candidate.kanbanBoardCard.workspaceId;
			resolvedEntry = {
				...entry,
				workspaceId: candidate.canonicalKanbanBoardCard?.workspaceId ?? entry.workspaceId,
				workspaceIdsUsedByTaskIncarnation: [
					...new Set([
						entry.workspaceId,
						currentWorkspaceId,
						candidate.canonicalKanbanBoardCard?.workspaceId ?? entry.workspaceId,
						...(candidate.workspaceIdsUsedByTaskIncarnation ?? []),
					]),
				],
			};
		}
	} catch (error) {
		if (signal.aborted || identityLookupSucceeded) throw error;
		// 身份登记暂不可读时，仍可用原项目的精确 incarnation 快照证明当前打开资格。
	}
	const response = await readTaskCardWithBoardColumnInWorkspace(currentWorkspaceId, entry.taskId, undefined, signal);
	if (
		response.taskCardLookupOutcome !== "task_card_found_on_workspace_board" ||
		response.taskCardSnapshot.taskCard.createdAt !== entry.taskIncarnationCreatedAtEpochMs
	) {
		if (!identityLookupSucceeded) throw new Error("原任务的当前归属暂时无法核验，恢复连接后重试。");
		return { outcome: "unavailable" };
	}
	return {
		outcome: "available",
		currentWorkspaceId,
		entry: {
			...resolvedEntry,
			titleSnapshot: response.taskCardSnapshot.taskCard.title ?? entry.titleSnapshot,
			unavailable: false,
		},
	};
}
