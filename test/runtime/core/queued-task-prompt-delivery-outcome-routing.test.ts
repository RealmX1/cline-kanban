// 回执 → 队列条目去向的路由表。这张表两个方向的后果不对称：把「可能已经送到了」判成可重试 ⇒ 同一段话
// 发两遍；把「确定没送到」判成终态失败 ⇒ 只是多让用户点一次「重新排队」。所以语义暧昧的一律交给人。
import { describe, expect, it } from "vitest";

import {
	type TerminalDeliveryFailureReason,
	terminalDeliveryFailureReasonSchema,
} from "../../../src/core/api-contract";
import {
	routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted,
	routeQueuedTaskPromptDeliveryTerminalOutcome,
} from "../../../src/core/queued-task-prompt-delivery-outcome-routing";

function routeFailure(reason: TerminalDeliveryFailureReason) {
	return routeQueuedTaskPromptDeliveryTerminalOutcome({ status: "delivery_failed", reason });
}

describe("queued-task-prompt-delivery-outcome-routing — 送达", () => {
	it.each(["delivered_and_submit_confirmed", "delivered_queued_behind_active_agent_turn"] as const)(
		"%s ⇒ delivered",
		(status) => {
			expect(routeQueuedTaskPromptDeliveryTerminalOutcome({ status, reason: null })).toEqual({
				outcome: "delivered",
				failureNote: null,
			});
		},
	);
});

describe("queued-task-prompt-delivery-outcome-routing — 失败原因分档", () => {
	// 「确定一个字节都没进 agent」：回队首等下一轮。
	it.each([
		"no_active_terminal_session",
		"terminal_prompt_readiness_timeout",
		"human_terminal_contention_timeout",
		// 账本明写「可以择机换新 idempotency key 重投」——base 吸收后才出现的值，计划初稿漏分了它。
		"terminal_input_box_contended_but_unstashable",
		"agent_awaiting_user_decision_timeout",
		// 与 RVF 单飞槽的 TOCTOU 对撞：绝不静默丢。
		"superseded_by_later_delivery",
		"session_ended_before_delivery",
	] as const)("%s ⇒ 可重试", (reason) => {
		const routed = routeFailure(reason);
		expect(routed.outcome).toBe("retryable_failure");
		expect(routed.failureNote).toBeTruthy();
	});

	// 「可能已经送到了」：落终态、由人决定。自动重投 = 同一段话送两次。
	it.each(["submit_confirmation_budget_exhausted", "runtime_restarted_before_confirmation"] as const)(
		"%s ⇒ 终态失败（绝不自动重投）",
		(reason) => {
			const routed = routeFailure(reason);
			expect(routed.outcome).toBe("terminal_failure");
			expect(routed.failureNote).toBeTruthy();
		},
	);

	it("cancelled_before_delivery ⇒ cancelled，不是失败", () => {
		expect(routeFailure("cancelled_before_delivery")).toEqual({ outcome: "cancelled", failureNote: null });
	});

	// 契约将来新增一个原因、而这张表没跟上时，必须落在安全那一侧——不能默认成可重试。
	it("契约里的每一个失败原因都被显式分过档（没有任何一个落进兜底分支）", () => {
		for (const reason of terminalDeliveryFailureReasonSchema.options) {
			const routed = routeFailure(reason);
			expect(routed.failureNote ?? "", `reason=${reason}`).not.toContain("it is unclear whether");
		}
	});

	it("不认识的原因 / 缺原因 ⇒ 终态失败（暧昧交给人）", () => {
		expect(routeQueuedTaskPromptDeliveryTerminalOutcome({ status: "delivery_failed", reason: null }).outcome).toBe(
			"terminal_failure",
		);
	});

	it("非终态回执被误传进来 ⇒ 终态失败，而不是假设送达", () => {
		expect(
			routeQueuedTaskPromptDeliveryTerminalOutcome({ status: "accepted_pending_submit_confirmation", reason: null })
				.outcome,
		).toBe("terminal_failure");
	});
});

describe("queued-task-prompt-delivery-outcome-routing — transport 受理之前就被拒", () => {
	it("可重试，并把出口给的错误原样带给用户", () => {
		expect(routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted("Task chat session is not running.")).toEqual(
			{
				outcome: "retryable_failure",
				failureNote: "The agent session did not accept the queued prompt: Task chat session is not running.",
			},
		);
	});
});
