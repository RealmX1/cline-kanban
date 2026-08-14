// 程序化投递（RVF followup / task-chat 发送）正在等这个终端的输入框腾出来时，说给用户听的那句话。
//
// 存在的理由就是 2026-08-08 那 49 分钟：投递在等，而屏幕上什么都不说，于是「在等」与「静默故障」
// 对用户完全同形。运行时那边现在会诚实让路（绝不把 paste 插进人打了一半的那一行），但让路必须
// 看得见，否则用户只会觉得机器又莫名其妙地不动了。

import type { RuntimeTaskTerminalDeliveryContention } from "@/runtime/types";

export interface TerminalDeliveryContentionNotice {
	// 一句话说清「谁在等、为什么等，以及框里那段内容会不会被机器动」。最后半句必须跟着
	// waitingForHumanBecauseAutomaticPreemptionIsUnavailable 走：稍后会自动抢占时还承诺「机器不会动它」，
	// 就是拿一句会被自己打脸的话去骗用户对自己的输入放心。
	headline: string;
	// 接下来会发生什么：要么等用户自己让路，要么运行时稍后自动暂存放行。
	detail: string;
	// 是否值得把「暂存我的输入并放行」这个动作摆出来。恒为 true —— 即便运行时随后会自动抢占，
	// 用户此刻主动让路仍然更快、也更符合他的本意（他看见了这条提示，说明他就在跟前）。
	shouldOfferStashAndYieldAction: boolean;
}

// headline 必须与 detail 同源于同一组布尔，否则前半句「机器不会动它」会和后半句「稍后会暂存清框」对撞。
function describeTerminalDeliveryContentionHeadline(
	contention: RuntimeTaskTerminalDeliveryContention,
	pendingDeliveryPhrase: string,
): string {
	if (!contention.inputBoxHasUncommittedText) {
		return `${pendingDeliveryPhrase}正在等这个终端`;
	}
	if (contention.waitingForHumanBecauseAutomaticPreemptionIsUnavailable) {
		return `${pendingDeliveryPhrase}在等这个输入框——你有还没提交的内容，机器不会动它`;
	}
	return `${pendingDeliveryPhrase}在等这个输入框——你有还没提交的内容，运行时稍后会把它暂存进 Prompt Library 再清框放行`;
}

export function describeTerminalDeliveryContention(
	contention: RuntimeTaskTerminalDeliveryContention | null | undefined,
): TerminalDeliveryContentionNotice | null {
	if (!contention || contention.pendingProgrammaticDeliveryCount <= 0) {
		return null;
	}
	const pendingDeliveryPhrase =
		contention.pendingProgrammaticDeliveryCount === 1
			? "有 1 条程序化投递"
			: `有 ${contention.pendingProgrammaticDeliveryCount} 条程序化投递`;
	return {
		headline: describeTerminalDeliveryContentionHeadline(contention, pendingDeliveryPhrase),
		detail: contention.waitingForHumanBecauseAutomaticPreemptionIsUnavailable
			? "在你提交、清空输入框、或点下面这个按钮之前，它不会被自动放行；等待预算耗尽后这条投递会诚实地报失败（可重投）。"
			: "你若一直不动，运行时稍后会把这段未提交的内容无损暂存进 Prompt Library 再放行；现在点按钮可以立刻让路。",
		shouldOfferStashAndYieldAction: true,
	};
}
