import { describe, expect, it, vi } from "vitest";
import { createConnectionDropAutoContinueReaction } from "../../../../src/terminal/output-reactions/connection-drop-auto-continue";
import type { OutputReactionActions } from "../../../../src/terminal/output-reactions/output-reaction";

function fixture() {
	const onAutomaticFailureDetected = vi.fn();
	let agentTurn = true;
	const actions: OutputReactionActions = {
		onAutomaticFailureDetected,
		isAgentTurnActive: () => agentTurn,
		submitContinuationReference: () => ({ outcome: "deferred_before_terminal_write" }),
		schedule: vi.fn(),
		clearScheduledAttempts: vi.fn(),
		setConnectionRetryState: vi.fn(),
		clearConnectionRetryState: vi.fn(),
		isAtInteractivePrompt: () => true,
		canInjectNow: () => true,
		isEffectiveAgentConversationActivityQuiet: () => true,
		log: vi.fn(),
	};
	const reaction = createConnectionDropAutoContinueReaction();
	const state = reaction.createState();
	const output = (chunkText: string) =>
		reaction.onOutput({ agentId: "claude", now: 1000, chunkText, scanText: chunkText }, state, actions);
	return {
		reaction,
		state,
		output,
		onAutomaticFailureDetected,
		setUserTurn: () => {
			agentTurn = false;
		},
	};
}
describe("网络错误检测只委托共用协调器", () => {
	it("仅启用 Claude 和 Codex", () => {
		const { reaction } = fixture();
		expect(reaction.appliesTo("claude")).toBe(true);
		expect(reaction.appliesTo("codex")).toBe(true);
		expect(reaction.appliesTo("cursor")).toBe(false);
	});
	it.each([
		["Error: read ECONNRESET\n"],
		["Error: read E", "CON", "NRE", "SET\n"],
		["⏺ API Error: Connection closed mid-response. The response above may be incomplete."],
	])("完整或跨批错误只产生故障事件：%j", (...chunks) => {
		const h = fixture();
		chunks.forEach(h.output);
		expect(h.onAutomaticFailureDetected).toHaveBeenCalledExactlyOnceWith("connection");
	});
	it("Python 错误名和普通重绘不产生连接故障", () => {
		const h = fixture();
		["ModuleNotFo", "undError: No module named yaml\n", "working…"].forEach(h.output);
		expect(h.onAutomaticFailureDetected).not.toHaveBeenCalled();
	});
	it("旧错误缓存不会被普通重绘重新命中", () => {
		const h = fixture();
		h.output("ECONNRESET\n");
		h.output("\rWorking…\n");
		expect(h.onAutomaticFailureDetected).toHaveBeenCalledOnce();
	});
	it("用户模态回合排除错误文本并清除桥接残留", () => {
		const h = fixture();
		h.setUserTurn();
		h.output("ECONNRESET\n");
		h.output(" ");
		expect(h.onAutomaticFailureDetected).not.toHaveBeenCalled();
		expect(h.state).toEqual({ splitCarryover: " " });
	});
});
