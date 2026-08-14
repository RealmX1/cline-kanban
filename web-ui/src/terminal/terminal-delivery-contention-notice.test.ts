import { describe, expect, it } from "vitest";

import { describeTerminalDeliveryContention } from "./terminal-delivery-contention-notice";

describe("describeTerminalDeliveryContention", () => {
	it("没有投递在等 → 不打扰用户", () => {
		expect(describeTerminalDeliveryContention(null)).toBeNull();
		expect(describeTerminalDeliveryContention(undefined)).toBeNull();
		expect(
			describeTerminalDeliveryContention({
				pendingProgrammaticDeliveryCount: 0,
				inputBoxHasUncommittedText: true,
				waitingForHumanBecauseAutomaticPreemptionIsUnavailable: true,
			}),
		).toBeNull();
	});

	it("不会自动放行时，明说「要么你动手、要么它诚实报失败」", () => {
		const notice = describeTerminalDeliveryContention({
			pendingProgrammaticDeliveryCount: 1,
			inputBoxHasUncommittedText: true,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: true,
		});
		expect(notice?.headline).toContain("你有还没提交的内容");
		expect(notice?.headline).toContain("机器不会动它");
		expect(notice?.detail).toContain("不会被自动放行");
		expect(notice?.shouldOfferStashAndYieldAction).toBe(true);
	});

	it("稍后会自动暂存抢占时，讲清那件事会发生，而不是让用户以为卡死了", () => {
		const notice = describeTerminalDeliveryContention({
			pendingProgrammaticDeliveryCount: 1,
			inputBoxHasUncommittedText: true,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: false,
		});
		expect(notice?.detail).toContain("无损暂存进 Prompt Library");
		expect(notice?.shouldOfferStashAndYieldAction).toBe(true);
	});

	// 这条钉的是「回执与提示绝不撒谎」：稍后就会被自动抢占清框的那一档，headline 不许承诺机器不动框，
	// 否则用户据前半句判断输入安全、实际却会被清掉。
	it("稍后会自动暂存抢占时，headline 不得承诺「机器不会动它」，而要预告暂存清框", () => {
		const notice = describeTerminalDeliveryContention({
			pendingProgrammaticDeliveryCount: 1,
			inputBoxHasUncommittedText: true,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: false,
		});
		expect(notice?.headline).toContain("你有还没提交的内容");
		expect(notice?.headline).not.toContain("机器不会动它");
		expect(notice?.headline).toContain("暂存进 Prompt Library");
		expect(notice?.headline).toContain("清框");
	});

	it("框里没有未提交内容时，headline 只说有投递在等这个终端", () => {
		const notice = describeTerminalDeliveryContention({
			pendingProgrammaticDeliveryCount: 2,
			inputBoxHasUncommittedText: false,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: true,
		});
		expect(notice?.headline).toBe("有 2 条程序化投递正在等这个终端");
	});
});
