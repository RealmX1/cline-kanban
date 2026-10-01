// 排队 prompt 措辞：每一个阻塞原因都要有人话；「Sending…」两个内部状态对用户是同一件事；
// 重启后待确认要盖过普通的 Queued；角标只数还没落定的条目。
import { describe, expect, it } from "vitest";

import {
	describeInFlightDeliveryCancelResult,
	describeQueuedTaskPromptDeliveryStatusChip,
	describeQueuedTaskPromptDispatchBlockReason,
	isQueuedTaskPromptDeliveryInFlight,
	summarizeQueuedTaskPromptDeliveryCountIndicator,
} from "@/runtime/queued-task-prompt-delivery-status-wording";
import type {
	QueuedTaskPromptDeliveryState,
	QueuedTaskPromptDispatchBlockReason,
	RuntimeQueuedTaskPromptDeliveryProjection,
} from "@/runtime/types";

function projection(
	overrides: Partial<RuntimeQueuedTaskPromptDeliveryProjection> = {},
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId: "q1",
		taskId: "task-1",
		deliveryState: "queued",
		textPreview: "跑测试",
		textLength: 3,
		deliverTogetherWithNextQueuedEntry: false,
		dispatchBlockReason: null,
		awaitsHumanReconfirmationAfterRuntimeRestart: false,
		deliveryAttemptCount: 0,
		lastDeliveryFailureNote: null,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
		enqueuedAt: 1,
		expiresAt: 2,
		settledAt: null,
		...overrides,
	};
}

const ALL_BLOCK_REASONS: QueuedTaskPromptDispatchBlockReason[] = [
	"awaiting_human_reconfirmation_after_runtime_restart",
	"agent_still_generating",
	"session_parked_awaiting_dispatched_background_work",
	"agent_awaiting_modal_user_decision",
	"session_not_live",
	"session_restoring_conversation",
	"another_programmatic_delivery_in_flight",
];

const ALL_DELIVERY_STATES: QueuedTaskPromptDeliveryState[] = [
	"queued",
	"claimed_for_dispatch",
	"handed_to_transport",
	"settled_delivered",
	"settled_failed",
	"cancelled",
	"expired",
];

describe("queued-task-prompt-delivery-status-wording", () => {
	it("每一个阻塞原因都有措辞；null = 没被挡", () => {
		for (const reason of ALL_BLOCK_REASONS) {
			expect(describeQueuedTaskPromptDispatchBlockReason(reason), reason).toBeTruthy();
		}
		expect(describeQueuedTaskPromptDispatchBlockReason(null)).toBeNull();
	});

	it("每一个状态都有状态 chip；认领与交付对用户都叫 Sending…", () => {
		for (const deliveryState of ALL_DELIVERY_STATES) {
			expect(
				describeQueuedTaskPromptDeliveryStatusChip(projection({ deliveryState })).label,
				deliveryState,
			).toBeTruthy();
		}
		expect(
			describeQueuedTaskPromptDeliveryStatusChip(projection({ deliveryState: "claimed_for_dispatch" })).label,
		).toBe("Sending…");
		expect(
			describeQueuedTaskPromptDeliveryStatusChip(projection({ deliveryState: "handed_to_transport" })).label,
		).toBe("Sending…");
	});

	// 过期不是失败：它从未被尝试过。
	it("expired 的措辞明说「没发」，且不是 danger 色", () => {
		const chip = describeQueuedTaskPromptDeliveryStatusChip(projection({ deliveryState: "expired" }));
		expect(chip.label).toContain("not sent");
		expect(chip.tone).not.toBe("danger");
	});

	it("重启后待确认盖过普通的 Queued，并用 warning 色", () => {
		expect(
			describeQueuedTaskPromptDeliveryStatusChip(projection({ awaitsHumanReconfirmationAfterRuntimeRestart: true })),
		).toEqual({ label: "Confirm after restart", tone: "warning" });
	});

	it("在途判定只认认领 / 交付两态", () => {
		expect(isQueuedTaskPromptDeliveryInFlight(projection({ deliveryState: "claimed_for_dispatch" }))).toBe(true);
		expect(isQueuedTaskPromptDeliveryInFlight(projection({ deliveryState: "handed_to_transport" }))).toBe(true);
		expect(isQueuedTaskPromptDeliveryInFlight(projection({ deliveryState: "queued" }))).toBe(false);
	});

	it("角标只数还没落定的条目；失败与重启待确认分别置位", () => {
		expect(
			summarizeQueuedTaskPromptDeliveryCountIndicator([
				projection({ queueEntryId: "a" }),
				projection({ queueEntryId: "b", deliveryState: "handed_to_transport" }),
				projection({ queueEntryId: "c", deliveryState: "settled_delivered" }),
				projection({ queueEntryId: "d", deliveryState: "settled_failed" }),
				projection({ queueEntryId: "e", awaitsHumanReconfirmationAfterRuntimeRestart: true }),
			]),
		).toEqual({ pendingCount: 3, hasFailedEntries: true, hasEntriesAwaitingReconfirmationAfterRestart: true });
		expect(summarizeQueuedTaskPromptDeliveryCountIndicator([])).toEqual({
			pendingCount: 0,
			hasFailedEntries: false,
			hasEntriesAwaitingReconfirmationAfterRestart: false,
		});
	});

	// already_delivered 必须让用户看见，不能吞成「取消成功」。
	it("取消晚了要明说，其余回执不打扰", () => {
		expect(describeInFlightDeliveryCancelResult("already_delivered")).toContain("Too late");
		expect(describeInFlightDeliveryCancelResult("cancelled_before_delivery")).toBeNull();
		expect(describeInFlightDeliveryCancelResult("no_pending_delivery")).toBeNull();
		expect(describeInFlightDeliveryCancelResult(null)).toBeNull();
	});
});
