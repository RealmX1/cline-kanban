// 程序化入队：把一条 `kanban task message --deliver-when-agent-idle`（例：RVF 决策点边界标记）排进 prompt queue。
//
// 与人排的入队（store 的 enqueue_prompt_for_delivery_after_current_turn 意图）同一套过期收敛、幂等与容量判据，
// 同一个持锁读-改-写咽喉；只有条目形状不同——带注入账本回执链接、expiresAt 是调用方给的截止时刻、永不合并。
// 不做成浏览器也能发的 mutation 意图：程序化条目要与账本记录成对出现，只能由 runtime 在建账本记录的同一次调用里
// 排（见 src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue.ts）。

import type { QueuedTaskPromptDeliveryEntry, WorkspaceQueuedTaskPromptDeliverySnapshot } from "../core/api-contract";
import {
	getTaskEntries,
	isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask,
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
	withExpiredAndOverflowingEntriesPruned,
	withExpiredQueuedEntriesSettled,
	withTaskEntries,
} from "./queued-task-prompt-delivery-store";
import { getThisRuntimeProcessInstanceId } from "./runtime-process-instance-heartbeat-registry";

export type AgentIdleGatedProgrammaticInjectionEnqueueOutcome =
	| "enqueued"
	// 同一个 queueEntryId 已在队列里（任何状态）：幂等重发，什么都不动。
	| "already_present"
	| "refused_queue_capacity_exhausted";

export interface AgentIdleGatedProgrammaticInjectionEnqueueInput {
	taskId: string;
	workspaceTaskId?: string | null;
	queueEntryId: string;
	text: string;
	injectionLedgerIdempotencyKey: string;
	injectionLedgerTaskId?: string;
	injectionSource: string;
	// 调用方给的「最多等 agent 空闲到这一刻」。直接当 expiresAt：过期收敛、投影、门控都已按它工作，
	// 不另造一个只有程序化条目才看的截止字段。
	agentIdleWaitDeadlineAtEpochMs: number;
	requiredNativeIndependentUserTurnSessionId?: string;
	requiredNativeIndependentUserTurnSessionIncarnationId?: string;
}

// 纯函数。与人排的入队同一套过期收敛、幂等与容量判据，只有条目形状不同。
export function applyAgentIdleGatedProgrammaticInjectionEnqueue(
	snapshotAsRead: WorkspaceQueuedTaskPromptDeliverySnapshot,
	input: AgentIdleGatedProgrammaticInjectionEnqueueInput,
	nowEpochMs: number,
): { next: WorkspaceQueuedTaskPromptDeliverySnapshot; outcome: AgentIdleGatedProgrammaticInjectionEnqueueOutcome } {
	const snapshot = withExpiredQueuedEntriesSettled(snapshotAsRead, nowEpochMs);
	const entries = getTaskEntries(snapshot, input.taskId);
	if (entries.some((entry) => entry.queueEntryId === input.queueEntryId)) {
		return { next: snapshot, outcome: "already_present" };
	}
	if (isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(snapshot, input.taskId)) {
		return { next: snapshot, outcome: "refused_queue_capacity_exhausted" };
	}
	const enqueued: QueuedTaskPromptDeliveryEntry = {
		queueEntryId: input.queueEntryId,
		taskId: input.taskId,
		text: input.text,
		...(input.requiredNativeIndependentUserTurnSessionId
			? {
					requiredNativeIndependentUserTurnSessionId: input.requiredNativeIndependentUserTurnSessionId,
					requiredNativeIndependentUserTurnSessionIncarnationId:
						input.requiredNativeIndependentUserTurnSessionIncarnationId,
				}
			: {}),
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		workspaceTaskId: input.workspaceTaskId ?? input.taskId,
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: nowEpochMs,
		expiresAt: input.agentIdleWaitDeadlineAtEpochMs,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
		programmaticInjectionLedgerReceiptLink: {
			injectionLedgerIdempotencyKey: input.injectionLedgerIdempotencyKey,
			...(input.injectionLedgerTaskId ? { injectionLedgerTaskId: input.injectionLedgerTaskId } : {}),
			injectionSource: input.injectionSource,
			settledTerminalDeliveryReceipt: null,
		},
	};
	return {
		// 截止时刻已经过了（重发时首次入队的截止已到）：照样入队，紧接着的裁剪会把它收敛成 expired，
		// 账本镜像随之落 agent_never_became_idle_before_queued_delivery_deadline——与「排着排着到点了」同一条路。
		next: withExpiredAndOverflowingEntriesPruned(
			withTaskEntries(snapshot, input.taskId, [...entries, enqueued]),
			nowEpochMs,
		),
		outcome: "enqueued",
	};
}

export async function enqueueAgentIdleGatedProgrammaticInjectionIntoQueue(input: {
	workspaceId: string;
	enqueue: AgentIdleGatedProgrammaticInjectionEnqueueInput;
	nowEpochMs?: number;
}): Promise<{
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot;
	outcome: AgentIdleGatedProgrammaticInjectionEnqueueOutcome;
}> {
	const nowEpochMs = input.nowEpochMs ?? Date.now();
	const { snapshot, result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const { next, outcome } = applyAgentIdleGatedProgrammaticInjectionEnqueue(current, input.enqueue, nowEpochMs);
			return { next, result: outcome };
		},
		nowEpochMs,
		"enqueue-agent-idle-gated-programmatic-injection",
	);
	return { snapshot, outcome: result };
}
