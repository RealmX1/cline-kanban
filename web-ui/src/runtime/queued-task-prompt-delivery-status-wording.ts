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
	queued: { label: "等待投递", tone: "neutral" },
	// 认领与交付对用户是同一件事：「正在发」。拆成两个词只会让人困惑它们有什么区别。
	claimed_for_dispatch: { label: "发送中", tone: "active" },
	handed_to_transport: { label: "等待提交确认", tone: "active" },
	settled_delivered: { label: "已确认送达", tone: "success" },
	settled_failed: { label: "投递失败", tone: "danger" },
	cancelled: { label: "已取消", tone: "muted" },
	// 不是失败：它从未被尝试过，只是放太久已经不可信了。
	expired: { label: "已过期，未发送", tone: "muted" },
};

export function describeQueuedTaskPromptDeliveryStatusChip(
	projection: Pick<
		RuntimeQueuedTaskPromptDeliveryProjection,
		"deliveryState" | "awaitsHumanReconfirmationAfterRuntimeRestart"
	> &
		Partial<Pick<RuntimeQueuedTaskPromptDeliveryProjection, "managedDelivery" | "lastDeliveryFailureNote">>,
): QueuedTaskPromptDeliveryStatusChip {
	if (projection.deliveryState === "queued" && projection.awaitsHumanReconfirmationAfterRuntimeRestart) {
		return { label: "重启后待确认", tone: "warning" };
	}
	const receipt = projection.managedDelivery?.terminalDeliveryReceipt;
	if (receipt?.status === "delivered_queued_behind_active_agent_turn")
		return { label: "已送达，等待 agent 处理", tone: "success" };
	if (
		projection.deliveryState === "settled_failed" &&
		(receipt?.reason === "submit_confirmation_budget_exhausted" ||
			receipt?.reason === "runtime_restarted_before_confirmation" ||
			receipt?.reason === "codex_native_prompt_delivery_unconfirmed" ||
			/may or may not|未.*确认|possibly/i.test(projection.lastDeliveryFailureNote ?? ""))
	)
		return { label: "未确认送达", tone: "warning" };
	return STATUS_CHIP_BY_DELIVERY_STATE[projection.deliveryState];
}

export function isTaskPromptDeliveryWaitingForAgentTurn(
	projection: Pick<RuntimeQueuedTaskPromptDeliveryProjection, "managedDelivery">,
): boolean {
	return projection.managedDelivery == null || projection.managedDelivery.deliveryStrategy === "after_agent_turn";
}

export function describeTaskPromptDeliveryMessageType(projection: RuntimeQueuedTaskPromptDeliveryProjection): string {
	const messageType =
		projection.managedDelivery?.messageType ??
		(projection.programmaticInjectionSource
			? "programmatic_injection"
			: projection.sourcePromptLibraryEntryId
				? "prompt_library"
				: "human_message");
	return {
		human_message: "人工发送",
		prompt_library: "Prompt Library",
		programmatic_injection: "自动注入",
		task_action: "快捷动作",
		session_startup: "启动提示",
		user_decision_answer: "问题答复",
		system_continuation: "系统续接",
	}[messageType];
}

const DISPATCH_BLOCK_REASON_WORDING: Record<QueuedTaskPromptDispatchBlockReason, string> = {
	awaiting_native_independent_user_turn_query_retry: "原生回合查询暂时失败，系统将在原截止时间内自动重试，尚未发送。",
	task_main_session_handover_awaiting_user: "主会话正在交接或等待用户消息，排队投递已暂停。",
	awaiting_human_reconfirmation_after_runtime_restart: "此消息在重启前排入，请确认保留或取消。",
	agent_still_generating: "等待 agent 结束当前回合。",
	session_parked_awaiting_dispatched_background_work: "agent 正在等待它派发的后台工作。",
	agent_awaiting_modal_user_decision: "agent 正在等你答复，队列暂不投递。",
	session_not_live: "会话尚未运行，恢复会话并结束下一轮后再投递。",
	session_restoring_conversation: "对话刚恢复，等你继续对话且 agent 结束一轮后再投递。",
	another_programmatic_delivery_in_flight: "另一条自动消息正在投递，请稍候。",
	queued_under_another_live_kanban_runtime_instance: "此消息由另一个仍在运行的 Kanban 实例负责投递。",
	awaiting_first_agent_turn_end_after_restart_reconfirmation: "已在重启后确认，等待 agent 再结束一轮后投递。",
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
		if (isTaskPromptDeliveryWaitingForAgentTurn(projection) && !isQueuedTaskPromptDeliveryTerminal(projection)) {
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
