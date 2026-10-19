// 排队 prompt 的状态 / 阻塞原因 → 人话。**纯函数**，与 terminal-delivery-contention-notice.ts 同形：
// 判据全在运行时（服务端给枚举值），前端只做措辞映射，这样措辞可以独立单测、也不会与判据漂移。

import type {
	QueuedTaskPromptDeliveryState,
	QueuedTaskPromptDispatchBlockReason,
	RuntimeQueuedTaskPromptDeliveryProjection,
} from "@/runtime/types";

export type QueuedTaskPromptDeliveryStatusChipTone = "neutral" | "warning" | "active" | "success" | "danger" | "muted";

export interface QueuedTaskPromptDeliveryStatusChip {
	label: string;
	tone: QueuedTaskPromptDeliveryStatusChipTone;
}

const STATUS_CHIP_BY_DELIVERY_STATE: Record<QueuedTaskPromptDeliveryState, QueuedTaskPromptDeliveryStatusChip> = {
	queued: { label: "Queued", tone: "neutral" },
	// 认领与交付对用户是同一件事：「正在发」。拆成两个词只会让人困惑它们有什么区别。
	claimed_for_dispatch: { label: "Sending…", tone: "active" },
	handed_to_transport: { label: "Sending…", tone: "active" },
	settled_delivered: { label: "Delivered", tone: "success" },
	settled_failed: { label: "Failed", tone: "danger" },
	cancelled: { label: "Cancelled", tone: "muted" },
	// 不是失败：它从未被尝试过，只是放太久已经不可信了。
	expired: { label: "Expired · not sent", tone: "muted" },
};

export function describeQueuedTaskPromptDeliveryStatusChip(
	projection: Pick<
		RuntimeQueuedTaskPromptDeliveryProjection,
		"deliveryState" | "awaitsHumanReconfirmationAfterRuntimeRestart"
	>,
): QueuedTaskPromptDeliveryStatusChip {
	if (projection.deliveryState === "queued" && projection.awaitsHumanReconfirmationAfterRuntimeRestart) {
		return { label: "Confirm after restart", tone: "warning" };
	}
	return STATUS_CHIP_BY_DELIVERY_STATE[projection.deliveryState];
}

const DISPATCH_BLOCK_REASON_WORDING: Record<QueuedTaskPromptDispatchBlockReason, string> = {
	task_main_session_handover_awaiting_user: "主会话正在交接或等待用户消息，排队投递已暂停。",
	awaiting_human_reconfirmation_after_runtime_restart:
		"Queued before Kanban restarted — keep it or cancel it before it is sent.",
	agent_still_generating: "Waiting for the agent to finish its current turn.",
	session_parked_awaiting_dispatched_background_work: "The agent is parked waiting for background work it dispatched.",
	agent_awaiting_modal_user_decision: "The agent is waiting for your answer; the queue will not answer for you.",
	session_not_live: "The agent session is not running. It will be sent after the session resumes and finishes a turn.",
	session_restoring_conversation:
		"The conversation was just restored. It will be sent after you continue the conversation and the agent finishes a turn.",
	another_programmatic_delivery_in_flight: "Another automated message is being delivered to this task first.",
	queued_under_another_live_kanban_runtime_instance:
		"Queued through another running Kanban instance; that instance will send it.",
	awaiting_first_agent_turn_end_after_restart_reconfirmation:
		"Confirmed after the restart. It will be sent after the agent's next turn ends.",
};

/** 只对仍在排队的条目有意义；null = 下一个停止边沿就发（或此刻就在发）。 */
export function describeQueuedTaskPromptDispatchBlockReason(
	blockReason: QueuedTaskPromptDispatchBlockReason | null,
): string | null {
	return blockReason === null ? null : DISPATCH_BLOCK_REASON_WORDING[blockReason];
}

/** 已交给 transport 的条目不能再撤回一个已经粘进框里的字节——取消按钮要如实说出来。 */
export function isQueuedTaskPromptDeliveryInFlight(
	projection: Pick<RuntimeQueuedTaskPromptDeliveryProjection, "deliveryState">,
): boolean {
	return projection.deliveryState === "claimed_for_dispatch" || projection.deliveryState === "handed_to_transport";
}

export function isQueuedTaskPromptDeliveryTerminal(
	projection: Pick<RuntimeQueuedTaskPromptDeliveryProjection, "deliveryState">,
): boolean {
	return (
		projection.deliveryState === "settled_delivered" ||
		projection.deliveryState === "settled_failed" ||
		projection.deliveryState === "cancelled" ||
		projection.deliveryState === "expired"
	);
}

export interface QueuedTaskPromptDeliveryCountIndicator {
	// 仍在排队 / 正在发的条数。0 = 不显示角标。
	pendingCount: number;
	// 有失败条目：角标转红，提醒用户去决定要不要重排。
	hasFailedEntries: boolean;
	// 有重启后待确认的条目：角标转 warning 色。
	hasEntriesAwaitingReconfirmationAfterRestart: boolean;
}

export function summarizeQueuedTaskPromptDeliveryCountIndicator(
	projections: readonly RuntimeQueuedTaskPromptDeliveryProjection[],
): QueuedTaskPromptDeliveryCountIndicator {
	let pendingCount = 0;
	let hasFailedEntries = false;
	let hasEntriesAwaitingReconfirmationAfterRestart = false;
	for (const projection of projections) {
		if (!isQueuedTaskPromptDeliveryTerminal(projection)) {
			pendingCount += 1;
		}
		if (projection.deliveryState === "settled_failed") {
			hasFailedEntries = true;
		}
		if (projection.awaitsHumanReconfirmationAfterRuntimeRestart) {
			hasEntriesAwaitingReconfirmationAfterRestart = true;
		}
	}
	return { pendingCount, hasFailedEntries, hasEntriesAwaitingReconfirmationAfterRestart };
}

export function describeInFlightDeliveryCancelResult(
	cancelResult: "cancelled_before_delivery" | "already_delivered" | "no_pending_delivery" | null | undefined,
): string | null {
	if (cancelResult === "already_delivered") {
		return "Too late to cancel — it was already pasted into the agent's input.";
	}
	return null;
}
