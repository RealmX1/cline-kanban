import { describe, expect, it } from "vitest";

import { buildTaskMessageCancelResult, resolveTaskMessageCancelResult } from "../../../src/commands/task";
import type {
	TaskMessageInjectionRecord,
	TaskMessageTerminalDeliveryFailureReason,
	TaskMessageTerminalDeliveryStatus,
} from "../../../src/core/task-message-injection-ledger";

function buildRecord(
	terminalDeliveryStatus: TaskMessageTerminalDeliveryStatus,
	failureReason?: TaskMessageTerminalDeliveryFailureReason,
): TaskMessageInjectionRecord {
	return {
		task_id: "task-cancel-receipt",
		source: "rvf",
		idempotency_key: "key-cancel-receipt",
		prompt_sha256: "0".repeat(64),
		message_id: "terminal:task-cancel-receipt:key-cancel-receipt",
		terminal_delivery_status: terminalDeliveryStatus,
		...(failureReason ? { terminal_delivery_failure_reason: failureReason } : {}),
		terminal_delivery_status_updated_at: "2026-08-12T00:00:00.000Z",
		created_at: "2026-08-12T00:00:00.000Z",
	};
}

describe("message-cancel 回执：只有确认进入 agent 才算 already_delivered", () => {
	it("已落定为 delivery_failed{no_active_terminal_session} 时不谎报已送达", () => {
		expect(
			buildTaskMessageCancelResult({
				record: buildRecord("delivery_failed", "no_active_terminal_session"),
				runtimeCancelResult: null,
			}),
		).toMatchObject({
			cancel_result: "cancelled_before_delivery",
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "no_active_terminal_session",
		});
	});

	it.each<TaskMessageTerminalDeliveryFailureReason>([
		"superseded_by_later_delivery",
		"agent_awaiting_user_decision_timeout",
		"runtime_restarted_before_confirmation",
		// 写进了输入框但确认不到提交：这恰恰是 49 分钟事故的形态，绝不能报「已送达」。
		"submit_confirmation_budget_exhausted",
	])("已落定为 delivery_failed{%s} 时报未送达，真实 reason 原样带出", (reason) => {
		const result = buildTaskMessageCancelResult({
			record: buildRecord("delivery_failed", reason),
			runtimeCancelResult: null,
		});
		expect(result.cancel_result).toBe("cancelled_before_delivery");
		expect(result.terminal_delivery_failure_reason).toBe(reason);
	});

	it("已落定为 delivery_failed{cancelled_before_delivery} 时幂等地报取消成功", () => {
		expect(
			buildTaskMessageCancelResult({
				record: buildRecord("delivery_failed", "cancelled_before_delivery"),
				runtimeCancelResult: null,
			}).cancel_result,
		).toBe("cancelled_before_delivery");
	});

	it.each<TaskMessageTerminalDeliveryStatus>([
		"delivered_and_submit_confirmed",
		"delivered_queued_behind_active_agent_turn",
	])("确认送达的终态 %s 才报 already_delivered", (status) => {
		expect(
			buildTaskMessageCancelResult({ record: buildRecord(status), runtimeCancelResult: null }).cancel_result,
		).toBe("already_delivered");
	});
});

describe("message-cancel 回执：等账本追上 runtime 的落定（fire-and-forget 回写竞态）", () => {
	it("tRPC 已返回但账本回写还没落盘时，不把「已拦下」读成 already_delivered", async () => {
		// runtime 的取消是同步返回的，账本回写走投递登记 observer 里 void 掉的那次写；
		// 第一次读到的必然还是 pending —— 旧实现在这里就直接出回执，于是谎报已送达。
		const reads: TaskMessageInjectionRecord[] = [
			buildRecord("accepted_pending_submit_confirmation"),
			buildRecord("accepted_pending_submit_confirmation"),
			buildRecord("delivery_failed", "cancelled_before_delivery"),
		];
		let readCount = 0;
		const slept: number[] = [];
		const result = await resolveTaskMessageCancelResult({
			runtimeCancelResult: "cancelled_before_delivery",
			readRecord: async () => reads[Math.min(readCount++, reads.length - 1)] as TaskMessageInjectionRecord,
			settleTimeoutMs: 5_000,
			pollIntervalMs: 10,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		expect(result).toMatchObject({
			cancel_result: "cancelled_before_delivery",
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "cancelled_before_delivery",
		});
		expect(readCount).toBe(3);
		expect(slept).toEqual([10, 10]);
	});

	it("账本收敛超时仍 pending 时，用 runtime 的权威结论出 cancel_result 并如实带出非终态", async () => {
		let elapsed = 0;
		const result = await resolveTaskMessageCancelResult({
			runtimeCancelResult: "already_delivered",
			readRecord: async () => buildRecord("accepted_pending_submit_confirmation"),
			settleTimeoutMs: 100,
			pollIntervalMs: 50,
			now: () => elapsed,
			sleep: async (ms) => {
				elapsed += ms;
			},
		});
		expect(result).toMatchObject({
			cancel_result: "already_delivered",
			terminal_delivery_status: "accepted_pending_submit_confirmation",
		});
	});

	it("runtime 手里没有在途投递（no_pending_delivery）时不报已送达", async () => {
		let elapsed = 0;
		expect(
			(
				await resolveTaskMessageCancelResult({
					runtimeCancelResult: "no_pending_delivery",
					readRecord: async () => buildRecord("accepted_pending_submit_confirmation"),
					settleTimeoutMs: 100,
					pollIntervalMs: 50,
					now: () => elapsed,
					sleep: async (ms) => {
						elapsed += ms;
					},
				})
			).cancel_result,
		).toBe("cancelled_before_delivery");
	});
});
