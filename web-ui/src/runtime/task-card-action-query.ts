import type { RuntimeAppRouter, RuntimeAppRouterInputs } from "@runtime-trpc";
import { TRPCClientError } from "@trpc/client";
import type {
	RuntimeTaskCardActionSetShelvingStateRequest,
	RuntimeTaskCardActionSetShelvingStateResponse,
} from "@/runtime/types";
// 看板卡片 per-card 动作（`taskCardAction.*`，唯一实现在 src/trpc/task-card-action-api.ts）的浏览器侧传输助手。
// 只挡住 tRPC 细节；在途闸、overlay、失败提示的编排在 task-card-action-command-execution.ts。
//
// 全部 procedure 都是 workspace-scoped：连接 scope 就是卡片所在的项目，可以是**任意**已注册项目——这正是
// 「跨项目执行动作而不切换当前项目」的基础。

import { getRuntimeTrpcClient, isRuntimeTrpcTransportFailure } from "@/runtime/trpc-client";

export async function readTaskClosureHistoryInWorkspace(workspaceId: string, taskId: string, createdAt: number) {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.readTaskClosureHistory.query({
		taskId,
		expectedTaskIncarnationCreatedAtEpochMs: createdAt,
	});
}
export async function correctTaskClosureOutcomeInWorkspace(
	workspaceId: string,
	request: RuntimeAppRouterInputs["taskCardAction"]["correctTaskClosureOutcome"],
) {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.correctTaskClosureOutcome.mutate(request);
}
export async function cancelTaskClosureOperationInWorkspace(workspaceId: string, taskId: string, createdAt: number) {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.cancelTaskClosureOperation.mutate({
		taskId,
		expectedTaskIncarnationCreatedAtEpochMs: createdAt,
	});
}

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
	expectedTaskIncarnationCreatedAtEpochMs?: number,
	signal?: AbortSignal,
): Promise<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse> {
	const request = {
		taskId,
		...(expectedTaskIncarnationCreatedAtEpochMs !== undefined ? { expectedTaskIncarnationCreatedAtEpochMs } : {}),
	};
	const query = getRuntimeTrpcClient(workspaceId).taskCardAction.readTaskCardWithBoardColumn;
	return await query.query(request, { signal, context: { sendAsIndependentHttpRequest: true } });
}

export async function startTaskCardAgentSessionMovingItIntoInProgressInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionStartAgentSessionRequest,
): Promise<RuntimeTaskCardActionStartAgentSessionResponse> {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress.mutate(
		request,
	);
}

async function runReviewStateRecoveryRequestWithDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			request(controller.signal),
			new Promise<never>((_, reject) => {
				deadline = setTimeout(() => {
					const error = new TRPCClientError<RuntimeAppRouter>("等待运行时响应超时。");
					reject(error);
					controller.abort(error);
				}, 8_000);
			}),
		]);
	} finally {
		clearTimeout(deadline);
	}
}

export async function moveTaskCardIntoReviewByHandingTurnToUserInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionMoveIntoReviewRequest,
): Promise<RuntimeTaskCardActionMoveIntoReviewResponse> {
	try {
		return await runReviewStateRecoveryRequestWithDeadline((signal) =>
			getRuntimeTrpcClient(workspaceId).taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser.mutate(request, {
				signal,
				context: { sendAsIndependentHttpRequest: true },
			}),
		);
	} catch (error) {
		if (!isRuntimeTrpcTransportFailure(error)) throw error;
		// 响应丢失不能证明未执行；只回查原 incarnation，不重发移列副作用。
		for (const backoffMs of [0, 400, 1_200]) {
			if (backoffMs) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
			try {
				const lookup = await runReviewStateRecoveryRequestWithDeadline((signal) =>
					readTaskCardWithBoardColumnInWorkspace(
						workspaceId,
						request.taskId,
						request.expectedTaskIncarnationCreatedAtEpochMs,
						signal,
					),
				);
				if (lookup.taskCardLookupOutcome !== "task_card_found_on_workspace_board") continue;
				const { taskCardSnapshot } = lookup;
				if (
					request.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
					taskCardSnapshot.taskCard.id === request.taskId &&
					taskCardSnapshot.taskCard.createdAt === request.expectedTaskIncarnationCreatedAtEpochMs &&
					taskCardSnapshot.boardColumnIdContainingTaskCard === "review"
				) {
					return {
						agentTurnHandoffToUserOutcome: "agent_turn_handed_to_user",
						agentTurnHandoffToUserFailureMessage: null,
						taskCardWasMovedIntoReviewColumnByThisAction: false,
						taskCardSnapshotAfterAction: taskCardSnapshot,
					};
				}
			} catch {
				// 查询失败保留未知，继续使用同一有限预算。
			}
		}
		throw new Error(
			`移入 Review 的结果未知；已回查三次，请待运行时恢复后查看卡片状态。${error instanceof Error ? ` ${error.message}` : ""}`,
			{ cause: error },
		);
	}
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

export async function setTaskCardShelvingStateInWorkspace(
	workspaceId: string,
	request: RuntimeTaskCardActionSetShelvingStateRequest,
): Promise<RuntimeTaskCardActionSetShelvingStateResponse> {
	return await getRuntimeTrpcClient(
		workspaceId,
	).taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects.mutate(request);
}

export async function applyTaskStickerEntryMutationInWorkspace(
	workspaceId: string,
	request: RuntimeAppRouterInputs["taskCardAction"]["applyTaskStickerEntryMutation"],
) {
	return await getRuntimeTrpcClient(workspaceId).taskCardAction.applyTaskStickerEntryMutation.mutate(request);
}
