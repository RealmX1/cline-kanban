// 在把 Kanban 面板上的答案投递进**仍活着**的 agent 终端之前，先关掉 agent 正停着的交互式提问选择器。
//
// 为什么必须有这一步：AskUserQuestion 的选择器等的是方向键与回车，不是一段文字。旧实现把答案当作
// bracketed paste 直接写进去——粘贴被选择器吞掉，紧随其后的回车则**确认了当前高亮的那一项**，等于替用户
// 选了默认选项；随后选择器重绘产生的输出又被投递回执当成「已送达」。用户在面板写的答案从未抵达 agent。
//
// 做法：发一次 Esc 关闭选择器（harness 把这次提问记为拒绝），然后**读屏**直到 agent 的输入框结构出现，
// 才允许调用方继续粘贴。读不到输入框就判失败——宁可这次投递失败、答案留在账本里等下次，也绝不在
// 选择器可能还在屏上时写回车。
//
// 只对已建模输入框结构语法的 agent（目前是 Claude）生效：没有读屏这只眼睛，就无法证明选择器已关闭。

export type AgentUserQuestionSelectorDismissalOutcome =
	// 输入框本来就在屏上（选择器早已不在，例如会话 resume 后），没有发送任何按键。
	| "terminal_input_box_already_visible"
	// 发了 Esc，并在超时前读屏确认输入框已出现。
	| "terminal_input_box_visible_after_escape_key"
	// 发了 Esc，但到超时仍读不到输入框：不得继续投递。
	| "terminal_input_box_still_not_visible_after_escape_key"
	// 该 agent 没有建模输入框结构，无法读屏确认：不得继续投递。
	| "agent_terminal_input_box_structure_not_modeled"
	| "no_active_agent_terminal_session";

export const AGENT_USER_QUESTION_SELECTOR_DISMISSAL_INPUT_BOX_POLL_INTERVAL_MS = 150;
export const AGENT_USER_QUESTION_SELECTOR_DISMISSAL_INPUT_BOX_WAIT_TIMEOUT_MS = 4_000;

export function isAgentUserQuestionSelectorDismissedAndTerminalInputBoxVisible(
	outcome: AgentUserQuestionSelectorDismissalOutcome,
): boolean {
	return outcome === "terminal_input_box_already_visible" || outcome === "terminal_input_box_visible_after_escape_key";
}

export async function dismissAgentUserQuestionSelectorUntilTerminalInputBoxVisible(dependencies: {
	// 返回 null 表示这条会话在读屏期间已退出或换代——结论作废。
	isTerminalInputBoxVisibleOnScreen: () => Promise<boolean | null>;
	writeEscapeKeyIntoAgentTerminal: () => boolean;
	waitMilliseconds: (milliseconds: number) => Promise<void>;
	now: () => number;
	pollIntervalMs?: number;
	waitTimeoutMs?: number;
}): Promise<AgentUserQuestionSelectorDismissalOutcome> {
	const pollIntervalMs =
		dependencies.pollIntervalMs ?? AGENT_USER_QUESTION_SELECTOR_DISMISSAL_INPUT_BOX_POLL_INTERVAL_MS;
	const waitTimeoutMs = dependencies.waitTimeoutMs ?? AGENT_USER_QUESTION_SELECTOR_DISMISSAL_INPUT_BOX_WAIT_TIMEOUT_MS;
	const visibleBeforeEscapeKey = await dependencies.isTerminalInputBoxVisibleOnScreen();
	if (visibleBeforeEscapeKey === null) {
		return "no_active_agent_terminal_session";
	}
	if (visibleBeforeEscapeKey) {
		// 输入框已在屏上时绝不发 Esc：Claude 在空闲输入框上连按 Esc 会打开回退菜单。
		return "terminal_input_box_already_visible";
	}
	if (!dependencies.writeEscapeKeyIntoAgentTerminal()) {
		return "no_active_agent_terminal_session";
	}
	const deadlineAt = dependencies.now() + waitTimeoutMs;
	while (dependencies.now() < deadlineAt) {
		await dependencies.waitMilliseconds(pollIntervalMs);
		const visibleAfterEscapeKey = await dependencies.isTerminalInputBoxVisibleOnScreen();
		if (visibleAfterEscapeKey === null) {
			return "no_active_agent_terminal_session";
		}
		if (visibleAfterEscapeKey) {
			return "terminal_input_box_visible_after_escape_key";
		}
	}
	return "terminal_input_box_still_not_visible_after_escape_key";
}
