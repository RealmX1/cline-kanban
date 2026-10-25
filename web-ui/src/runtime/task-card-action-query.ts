import type { RuntimeAppRouterInputs } from "@runtime-trpc";
import { TRPCClientError } from "@trpc/client";
// 看板卡片 per-card 动作（`taskCardAction.*`，唯一实现在 src/trpc/task-card-action-api.ts）的浏览器侧传输助手。
// 只挡住 tRPC 细节；在途闸、overlay、失败提示的编排在 task-card-action-command-execution.ts。
//
// 全部 procedure 都是 workspace-scoped：连接 scope 就是卡片所在的项目，可以是**任意**已注册项目——这正是
// 「跨项目执行动作而不切换当前项目」的基础。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskCardActionMoveBetweenNonTrashColumnsRequest,
	RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse,
	RuntimeTaskCardActionMoveIntoDoneRequest,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskCardActionMoveIntoReviewRequest,
	RuntimeTaskCardActionMoveIntoReviewResponse,
	RuntimeTaskCardActionPermanentlyDeleteRequest,
	RuntimeTaskCardActionPermanentlyDeleteResponse,
	RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse,
	RuntimeTaskCardActionRestoreFromDoneRequest,
	RuntimeTaskCardActionRestoreFromDoneResponse,
	RuntimeTaskCardActionSetTaskPinboardPinStateRequest,
	RuntimeTaskCardActionSetTaskPinboardPinStateResponse,
	RuntimeTaskCardActionStartAgentSessionRequest,
	RuntimeTaskCardActionStartAgentSessionResponse,
	RuntimeTaskCardActionUpdateFieldValuesRequest,
	RuntimeTaskCardActionUpdateFieldValuesResponse,
} from "@/runtime/types";

export async function readTaskCardWithBoardColumnInWorkspace(
	workspaceId: string,
	taskId: string,
): Promise<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse> {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.readTaskCardWithBoardColumn.query({ taskId });
}

export async function startTaskCardAgentSessionMovingItIntoInProgressInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionStartAgentSessionRequest,
): Promise<RuntimeTaskCardActionStartAgentSessionResponse> {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress.mutate(
		request,
	);
}

export async function moveTaskCardIntoReviewByHandingTurnToUserInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionMoveIntoReviewRequest,
): Promise<RuntimeTaskCardActionMoveIntoReviewResponse> {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser.mutate(
		request,
	);
}

export async function moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionMoveBetweenNonTrashColumnsRequest,
): Promise<RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse> {
	return await getRuntimeTrpcClient(
		workspaceId,
	).taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects.mutate(request);
}

export async function moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionMoveIntoDoneRequest,
): Promise<RuntimeTaskCardActionMoveIntoDoneResponse> {
	return await getRuntimeTrpcClient(
		workspaceId,
	).taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate(request);
}

export async function restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionRestoreFromDoneRequest,
): Promise<RuntimeTaskCardActionRestoreFromDoneResponse> {
	return await getRuntimeTrpcClient(
		workspaceId,
	).taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession.mutate(request);
}

export async function permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionPermanentlyDeleteRequest,
): Promise<RuntimeTaskCardActionPermanentlyDeleteResponse> {
	return await getRuntimeTrpcClient(
		workspaceId,
	).taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate(request);
}

export async function updateTaskCardFieldValuesInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionUpdateFieldValuesRequest,
): Promise<RuntimeTaskCardActionUpdateFieldValuesResponse> {
	try {
		return await getRuntimeTrpcClient(workspaceId).taskCardAction.updateTaskCardFieldValues.mutate(request);
	} catch (error) {
		if (
			!(error instanceof TRPCClientError) ||
			error.data?.code !== "NOT_FOUND" ||
			request.expectedTaskIncarnationCreatedAtEpochMs === undefined
		)
			throw error;
		const identities = await getRuntimeTrpcClient(
			workspaceId,
		).workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({ bareTaskId: request.taskId });
		const current = identities.kanbanBoardCardIdentityCandidates.filter(
			(candidate) =>
				candidate.permanentlyRemovedFromBoardAt === null &&
				candidate.kanbanBoardCard.taskIncarnationCreatedAtEpochMs ===
					request.expectedTaskIncarnationCreatedAtEpochMs,
		);
		if (current.length !== 1 || !current[0] || current[0].kanbanBoardCard.workspaceId === workspaceId) throw error;
		const response = await getRuntimeTrpcClient(
			current[0].kanbanBoardCard.workspaceId,
		).taskCardAction.updateTaskCardFieldValues.mutate(request);
		return {
			...response,
			taskCardSnapshotAfterAction: {
				...response.taskCardSnapshotAfterAction,
				workspaceId: current[0].kanbanBoardCard.workspaceId,
			},
		};
	}
}

export async function setTaskPinboardPinStateOfTaskCardInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionSetTaskPinboardPinStateRequest,
): Promise<RuntimeTaskCardActionSetTaskPinboardPinStateResponse> {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate(request);
}

export function transferNeverStartedBacklogTaskToProjectInWorkspace(
	workspaceId: string,
	request: RuntimeAppRouterInputs["taskCardAction"]["transferNeverStartedBacklogTaskToProject"],
) {
	return getRuntimeTrpcClient(workspaceId).taskCardAction.transferNeverStartedBacklogTaskToProject.mutate(request);
}
