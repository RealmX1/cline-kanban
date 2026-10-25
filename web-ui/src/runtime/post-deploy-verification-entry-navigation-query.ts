import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export function fetchTaskPostDeployVerificationEntryNavigationTargets(input: { workspaceId: string; taskId: string }) {
	return getRuntimeTrpcClient(
		input.workspaceId,
	).deployment.resolveTaskPostDeployVerificationEntryNavigationTargets.query({ taskId: input.taskId });
}

export async function readPostDeployVerificationFollowUpSourceTaskIdentity(input: {
	workspaceId: string;
	taskId: string;
}) {
	const response = await getRuntimeTrpcClient(
		input.workspaceId,
	).workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({ bareTaskId: input.taskId });
	const candidates = response.kanbanBoardCardIdentityCandidates.filter(
		(candidate) => candidate.kanbanBoardCard.workspaceId === input.workspaceId,
	);
	const candidate = candidates.length === 1 ? candidates[0] : null;
	if (!candidate) throw new Error("暂时无法唯一确认来源任务身份；请稍后重试，已删除任务可从保留的关系历史恢复身份。");
	return {
		title: candidate.currentTitle ?? input.taskId,
		createdAt: candidate.kanbanBoardCard.taskIncarnationCreatedAtEpochMs,
	};
}
