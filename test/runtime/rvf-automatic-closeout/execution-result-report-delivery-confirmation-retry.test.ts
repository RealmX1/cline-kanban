import { TRPCClientError } from "@trpc/client";
import { describe, expect, it, vi } from "vitest";
import { reportRvfCloseoutExecutionResultWhileDeliveryConfirmationPending } from "../../../src/commands/report-rvf-closeout-execution-result-while-delivery-confirmation-pending";

const pending = () =>
	TRPCClientError.from({
		error: { code: -32012, message: "等待真实投递确认", data: { code: "PRECONDITION_FAILED" } },
	});
describe("收尾执行报告与投递确认竞态", () => {
	it("明确的确认等待限时重试，同一报告成功后立即返回", async () => {
		const report = vi.fn().mockRejectedValueOnce(pending()).mockResolvedValue({ accepted: true });
		const sleep = vi.fn(async () => {});
		expect(
			await reportRvfCloseoutExecutionResultWhileDeliveryConfirmationPending(report, { now: () => 0, sleep }),
		).toEqual({ accepted: true });
		expect(report).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledOnce();
	});
	it("三十秒仍未确认时保留失败，不冒充执行成功", async () => {
		let now = 0;
		const report = vi.fn().mockRejectedValue(pending());
		await expect(
			reportRvfCloseoutExecutionResultWhileDeliveryConfirmationPending(report, {
				now: () => now,
				sleep: async () => {
					now += 30_000;
				},
			}),
		).rejects.toThrow("等待");
		expect(report).toHaveBeenCalledTimes(2);
	});
	it("身份、Git 或其他未知失败均不重试", async () => {
		const report = vi.fn().mockRejectedValue(new Error("Git 证据不符"));
		await expect(reportRvfCloseoutExecutionResultWhileDeliveryConfirmationPending(report)).rejects.toThrow("Git");
		expect(report).toHaveBeenCalledOnce();
	});
});
