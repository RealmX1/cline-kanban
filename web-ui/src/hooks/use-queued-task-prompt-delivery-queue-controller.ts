// 某个任务（会话）的排队 prompt 控制器：读投影 + 发意图。
//
// 队列的真相在服务端；这里不做乐观更新——mutation 响应本身就带着服务端锁内算好的整份投影，比推送早到
// 几十毫秒，直接写进 store 就是最快也最诚实的回显。乐观更新在这里只会制造「我点了取消、它又弹回来」：
// 一条正在被 dispatcher 认领的条目，本地先把它标成已取消，服务端却说「已经交给 transport 了」。
//
// taskId 是**会话 id**（by-the-way 子会话有自己独立的队列），与 PromptLibraryPanel 同一口径。

import { useCallback } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	buildQueuedTaskPromptDeliveryDebugReference,
	type QueuedTaskPromptDeliveryDebugReference,
} from "@/runtime/queued-task-prompt-delivery-debug-reference";
import {
	fetchQueuedTaskPromptDeliveryFullText,
	fetchTaskPromptDeliveryQueue,
	mutateTaskPromptDeliveryQueue,
} from "@/runtime/queued-task-prompt-delivery-query";
import {
	describeInFlightDeliveryCancelResult,
	isQueuedTaskPromptDeliveryTerminal,
} from "@/runtime/queued-task-prompt-delivery-status-wording";
import type {
	QueuedTaskPromptDeliveryMutation,
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeTaskPromptDeliveryQueueMutateResponse,
} from "@/runtime/types";
import {
	getQueuedTaskPromptDeliveryProjectionsForTask,
	getQueuedTaskPromptDeliveryProjectionWriteGeneration,
	replaceQueuedTaskPromptDeliveryProjections,
	useQueuedTaskPromptDeliveryProjectionsForTask,
} from "@/stores/queued-task-prompt-delivery-projection-store";

export interface QueuedTaskPromptDeliveryQueueController {
	projections: readonly RuntimeQueuedTaskPromptDeliveryProjection[];
	enqueuePromptForDeliveryAfterCurrentTurn: (input: {
		text: string;
		sourcePromptLibraryEntryId?: string | null;
	}) => Promise<boolean>;
	cancelQueuedPromptDelivery: (queueEntryId: string) => Promise<void>;
	moveQueuedPromptDelivery: (queueEntryId: string, direction: "up" | "down") => Promise<void>;
	setQueuedPromptDeliveryMergeWithNext: (
		queueEntryId: string,
		deliverTogetherWithNextQueuedEntry: boolean,
	) => Promise<void>;
	dismissSettledQueuedPromptDelivery: (queueEntryId: string) => Promise<void>;
	retrySettledFailedQueuedPromptDelivery: (queueEntryId: string) => Promise<void>;
	// 返回服务端是否确认落盘：重启提醒只在它为 true 时才把条目记为「已提醒」（失败要能重试）。
	reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: (queueEntryIds: readonly string[]) => Promise<boolean>;
	fetchFullText: (queueEntryId: string) => Promise<string | null>;
	fetchDebugReference: (
		projection: RuntimeQueuedTaskPromptDeliveryProjection,
	) => Promise<QueuedTaskPromptDeliveryDebugReference>;
}

function createQueueEntryId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `queued-prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 「把 X 往上挪一位」算成**完整有序 id 列表**再发：服务端按「取交集 + 未知 id 追加到尾」调和，
// 并发下不会凭空造出一个谁也没要过的顺序。
export function buildQueuedPromptDeliveryOrderAfterMove(
	projections: readonly Pick<RuntimeQueuedTaskPromptDeliveryProjection, "queueEntryId">[],
	queueEntryId: string,
	direction: "up" | "down",
): string[] | null {
	const orderedQueueEntryIds = projections.map((projection) => projection.queueEntryId);
	const index = orderedQueueEntryIds.indexOf(queueEntryId);
	const targetIndex = direction === "up" ? index - 1 : index + 1;
	if (index < 0 || targetIndex < 0 || targetIndex >= orderedQueueEntryIds.length) {
		return null;
	}
	const movingQueueEntryId = orderedQueueEntryIds[index];
	const displacedQueueEntryId = orderedQueueEntryIds[targetIndex];
	if (movingQueueEntryId === undefined || displacedQueueEntryId === undefined) {
		return null;
	}
	const reordered = [...orderedQueueEntryIds];
	reordered[targetIndex] = movingQueueEntryId;
	reordered[index] = displacedQueueEntryId;
	return reordered;
}

export function useQueuedTaskPromptDeliveryQueueController(
	workspaceId: string | null,
	taskId: string,
	// 该会话所属的看板任务（by-the-way 子会话是它的主任务）。随入队存进条目，主任务被删时连子会话的队列一并丢弃。
	workspaceTaskId: string,
): QueuedTaskPromptDeliveryQueueController {
	const projections = useQueuedTaskPromptDeliveryProjectionsForTask(taskId);

	const sendMutation = useCallback(
		async (
			mutation: QueuedTaskPromptDeliveryMutation,
		): Promise<RuntimeTaskPromptDeliveryQueueMutateResponse | null> => {
			if (!workspaceId) {
				return null;
			}
			try {
				const projectionWriteGenerationAtSend = getQueuedTaskPromptDeliveryProjectionWriteGeneration();
				const response = await mutateTaskPromptDeliveryQueue(workspaceId, mutation);
				// 只在期间没有更新的写入时才用响应回显：服务端先推流后回响应，推送通常先到；那时响应已不是最新，
				// 用它覆盖会把刚推来的状态回滚。workspace 已经切走时 store 自己会丢弃这次写入。
				if (
					response.projectedEntriesByTaskId &&
					getQueuedTaskPromptDeliveryProjectionWriteGeneration() === projectionWriteGenerationAtSend
				) {
					replaceQueuedTaskPromptDeliveryProjections(workspaceId, response.projectedEntriesByTaskId);
				}
				if (!response.ok) {
					showAppToast({
						intent: "danger",
						message: response.error ?? "Could not update the prompt queue.",
					});
				}
				return response;
			} catch (error) {
				showAppToast({
					intent: "danger",
					message: `Could not update the prompt queue: ${error instanceof Error ? error.message : String(error)}`,
				});
				return null;
			}
		},
		[workspaceId],
	);

	const enqueuePromptForDeliveryAfterCurrentTurn = useCallback(
		async (input: { text: string; sourcePromptLibraryEntryId?: string | null }): Promise<boolean> => {
			const response = await sendMutation({
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId,
				queueEntryId: createQueueEntryId(),
				text: input.text,
				sourcePromptLibraryEntryId: input.sourcePromptLibraryEntryId ?? null,
				workspaceTaskId,
			});
			return response?.ok === true;
		},
		[sendMutation, taskId, workspaceTaskId],
	);

	const cancelQueuedPromptDelivery = useCallback(
		async (queueEntryId: string) => {
			const response = await sendMutation({ kind: "cancel_queued_prompt_delivery", taskId, queueEntryId });
			const tooLateNotice = describeInFlightDeliveryCancelResult(response?.inFlightDeliveryCancelResult);
			if (tooLateNotice) {
				showAppToast({ intent: "warning", message: tooLateNotice });
			}
		},
		[sendMutation, taskId],
	);

	const moveQueuedPromptDelivery = useCallback(
		async (queueEntryId: string, direction: "up" | "down") => {
			// 只在还没落定的条目之间挪；终态条目不发给服务端，由它按「未知 id 追加到尾」留在后面。
			const orderedQueueEntryIds = buildQueuedPromptDeliveryOrderAfterMove(
				getQueuedTaskPromptDeliveryProjectionsForTask(taskId).filter(
					(projection) => !isQueuedTaskPromptDeliveryTerminal(projection),
				),
				queueEntryId,
				direction,
			);
			if (orderedQueueEntryIds === null) {
				return;
			}
			await sendMutation({ kind: "reorder_queued_prompt_deliveries", taskId, orderedQueueEntryIds });
		},
		[sendMutation, taskId],
	);

	const setQueuedPromptDeliveryMergeWithNext = useCallback(
		async (queueEntryId: string, deliverTogetherWithNextQueuedEntry: boolean) => {
			await sendMutation({
				kind: "set_queued_prompt_delivery_merge_with_next",
				taskId,
				queueEntryId,
				deliverTogetherWithNextQueuedEntry,
			});
		},
		[sendMutation, taskId],
	);

	const dismissSettledQueuedPromptDelivery = useCallback(
		async (queueEntryId: string) => {
			await sendMutation({ kind: "dismiss_settled_queued_prompt_delivery", taskId, queueEntryId });
		},
		[sendMutation, taskId],
	);

	const retrySettledFailedQueuedPromptDelivery = useCallback(
		async (queueEntryId: string) => {
			await sendMutation({
				kind: "retry_settled_failed_queued_prompt_delivery",
				taskId,
				queueEntryId,
				replacementQueueEntryId: createQueueEntryId(),
			});
		},
		[sendMutation, taskId],
	);

	const reconfirmQueuedPromptDeliveriesAfterRuntimeRestart = useCallback(
		async (queueEntryIds: readonly string[]) => {
			if (queueEntryIds.length === 0) {
				return true;
			}
			const response = await sendMutation({
				kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart",
				taskId,
				queueEntryIds: [...queueEntryIds],
			});
			return response?.ok === true;
		},
		[sendMutation, taskId],
	);

	const fetchFullText = useCallback(
		async (queueEntryId: string) => {
			if (!workspaceId) {
				return null;
			}
			try {
				return await fetchQueuedTaskPromptDeliveryFullText(workspaceId, taskId, queueEntryId);
			} catch {
				return null;
			}
		},
		[workspaceId, taskId],
	);

	const fetchDebugReference = useCallback(
		async (projection: RuntimeQueuedTaskPromptDeliveryProjection) => {
			let queueReadResponse: Awaited<ReturnType<typeof fetchTaskPromptDeliveryQueue>> | null = null;
			if (workspaceId && projection.taskId === taskId) {
				try {
					queueReadResponse = await fetchTaskPromptDeliveryQueue(workspaceId, AbortSignal.timeout(5_000));
				} catch {
					// 读失败不阻止复制已知引用；构造器会标明缺口，展开时可重新读取。
				}
			}
			return buildQueuedTaskPromptDeliveryDebugReference({
				workspaceId,
				workspaceTaskId,
				projection,
				queueReadResponse,
				capturedAtEpochMs: Date.now(),
			});
		},
		[workspaceId, workspaceTaskId, taskId],
	);

	return {
		projections,
		enqueuePromptForDeliveryAfterCurrentTurn,
		cancelQueuedPromptDelivery,
		moveQueuedPromptDelivery,
		setQueuedPromptDeliveryMergeWithNext,
		dismissSettledQueuedPromptDelivery,
		retrySettledFailedQueuedPromptDelivery,
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart,
		fetchFullText,
		fetchDebugReference,
	};
}
