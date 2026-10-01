// 投递面板答案前关闭终端提问选择器：只有读屏确认输入框出现才放行；输入框已在屏上时绝不发 Esc；
// 读不到输入框、会话中途退出都判失败——宁可这次投递失败，也绝不在选择器可能还在时写回车。
import { describe, expect, it, vi } from "vitest";

import {
	dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible,
	isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible,
} from "../../../src/terminal/agent-user-question-selector-dismissal-before-programmatic-answer-delivery";

function createVirtualClock() {
	let currentMs = 0;
	return {
		now: () => currentMs,
		waitMilliseconds: vi.fn(async (milliseconds: number) => {
			currentMs += milliseconds;
		}),
	};
}

describe("dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible", () => {
	it("输入框已在屏上（resume 后选择器早已不在）→ 不发任何按键", async () => {
		const clock = createVirtualClock();
		const writeEscapeKeyIntoAgentTerminal = vi.fn(() => true);
		const outcome = await dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible({
			isTerminalInputBoxVisibleOnScreen: async () => true,
			writeEscapeKeyIntoAgentTerminal,
			...clock,
		});
		expect(outcome).toBe("terminal_input_box_already_visible");
		expect(writeEscapeKeyIntoAgentTerminal).not.toHaveBeenCalled();
		expect(isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible(outcome)).toBe(true);
	});

	it("选择器在屏上 → 发一次 Esc，读屏确认输入框出现后放行", async () => {
		const clock = createVirtualClock();
		const screenReadings = [false, false, true];
		const writeEscapeKeyIntoAgentTerminal = vi.fn(() => true);
		const outcome = await dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible({
			isTerminalInputBoxVisibleOnScreen: async () => screenReadings.shift() ?? true,
			writeEscapeKeyIntoAgentTerminal,
			...clock,
		});
		expect(outcome).toBe("terminal_input_box_visible_after_escape_key");
		expect(writeEscapeKeyIntoAgentTerminal).toHaveBeenCalledTimes(1);
	});

	it("Esc 之后到超时仍读不到输入框 → 失败，不得继续投递", async () => {
		const clock = createVirtualClock();
		const outcome = await dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible({
			isTerminalInputBoxVisibleOnScreen: async () => false,
			writeEscapeKeyIntoAgentTerminal: () => true,
			pollIntervalMs: 100,
			waitTimeoutMs: 1_000,
			...clock,
		});
		expect(outcome).toBe("terminal_input_box_still_not_visible_after_escape_key");
		expect(isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible(outcome)).toBe(false);
		expect(clock.waitMilliseconds).toHaveBeenCalledTimes(10);
	});

	it("读屏期间会话退出或换代 → 结论作废", async () => {
		const clock = createVirtualClock();
		const screenReadings: Array<boolean | null> = [false, null];
		const outcome = await dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible({
			isTerminalInputBoxVisibleOnScreen: async () => screenReadings.shift() ?? null,
			writeEscapeKeyIntoAgentTerminal: () => true,
			...clock,
		});
		expect(outcome).toBe("no_active_agent_terminal_session");
		expect(isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible(outcome)).toBe(false);
	});
});
