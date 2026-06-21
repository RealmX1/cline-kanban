import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionDropAutoContinueReaction } from "../../../../src/terminal/output-reactions/connection-drop-auto-continue";
import type {
	ConnectionRetryStatePatch,
	OutputReactionActions,
	OutputReactionContext,
} from "../../../../src/terminal/output-reactions/output-reaction";

const CLAUDE_ERROR_LINE = "⏺ API Error: Connection closed mid-response. The response above may be incomplete.";

function createMockActions(overrides?: Partial<OutputReactionActions>) {
	const scheduleDelays: number[] = [];
	const retryPatches: ConnectionRetryStatePatch[] = [];
	const actions: OutputReactionActions = {
		submitContinuationReference: vi.fn(),
		schedule: vi.fn((delayMs: number) => {
			scheduleDelays.push(delayMs);
		}),
		clearScheduledAttempts: vi.fn(),
		setConnectionRetryState: vi.fn((patch: ConnectionRetryStatePatch) => {
			retryPatches.push(patch);
		}),
		clearConnectionRetryState: vi.fn(),
		isAtInteractivePrompt: vi.fn(() => true),
		canInjectNow: vi.fn(() => true),
		// 默认「已静默」：保持既有用例（agent 停产后注入续跑）的语义不变。
		isAgentOutputQuiet: vi.fn(() => true),
		log: vi.fn(),
		...overrides,
	};
	return { actions, scheduleDelays, retryPatches };
}

function ctx(now: number, chunkText = ""): OutputReactionContext {
	return { agentId: "claude", now, chunkText, scanText: chunkText };
}

describe("connection-drop-auto-continue reaction", () => {
	let reaction: ReturnType<typeof createConnectionDropAutoContinueReaction>;
	let state: unknown;

	beforeEach(() => {
		reaction = createConnectionDropAutoContinueReaction();
		state = reaction.createState();
	});

	it("applies to claude and codex only", () => {
		expect(reaction.appliesTo("claude")).toBe(true);
		expect(reaction.appliesTo("codex")).toBe(true);
		expect(reaction.appliesTo("cline")).toBe(false);
		expect(reaction.appliesTo("gemini")).toBe(false);
	});

	it("does not inject immediately on error; schedules the first attempt and enters retry state", () => {
		const { actions, retryPatches } = createMockActions();
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
		expect(actions.schedule).toHaveBeenCalledTimes(1);
		expect(actions.setConnectionRetryState).toHaveBeenCalledTimes(1);
		expect(retryPatches[0]).toMatchObject({ status: "retrying", retryCount: 0 });
	});

	it("waits for the interactive prompt before injecting", () => {
		const isAtInteractivePrompt = vi.fn(() => false);
		const { actions } = createMockActions({ isAtInteractivePrompt });
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		// Timer fires but the agent is not at an interactive prompt yet → reschedule, no injection.
		reaction.onAttempt(ctx(5_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
		isAtInteractivePrompt.mockReturnValue(true);
		reaction.onAttempt(ctx(8_000), state, actions);
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(1);
	});

	it("suppresses injection while the user is recently typing (canInjectNow=false)", () => {
		const canInjectNow = vi.fn(() => false);
		const { actions } = createMockActions({ canInjectNow });
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		reaction.onAttempt(ctx(5_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
	});

	it("ends the episode (no injection) on an automatic attempt when the agent output is still flowing", () => {
		// 伪 episode：正常输出里含 timeout/5xx 等词起了重试，但 agent 仍在持续产出。
		// 自动 attempt 时输出未静默 → 判定 agent 仍在工作/已恢复 → 结束 episode、绝不注入。
		const isAgentOutputQuiet = vi.fn(() => false);
		const { actions } = createMockActions({ isAgentOutputQuiet });
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		reaction.onAttempt(ctx(5_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
		expect(actions.clearConnectionRetryState).toHaveBeenCalledTimes(1);
		expect(actions.clearScheduledAttempts).toHaveBeenCalled();
	});

	it("manual triggerNow injects even when output is still flowing (silence gate is auto-only)", () => {
		const isAgentOutputQuiet = vi.fn(() => false);
		const { actions } = createMockActions({ isAgentOutputQuiet });
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		reaction.triggerNow(ctx(2_000), state, actions);
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(1);
		expect(actions.clearConnectionRetryState).not.toHaveBeenCalled();
	});

	it("grows the backoff interval across consecutive failed attempts and never stops", () => {
		const { actions, scheduleDelays } = createMockActions();
		// Episode start.
		reaction.onOutput(ctx(0, CLAUDE_ERROR_LINE), state, actions);
		let now = 0;
		// Drive several attempts, re-arming the "still failing" signal before each one.
		for (let i = 0; i < 6; i++) {
			now += 600_000; // well past any backoff cap
			reaction.onAttempt(ctx(now), state, actions);
			// Simulate the agent failing again after our nudge so the next attempt injects.
			reaction.onOutput(ctx(now + 1, CLAUDE_ERROR_LINE), state, actions);
		}
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(6);
		// Backoff delays scheduled after each injection should be non-decreasing and cap (never drop to 0 / stop).
		const postInjectionDelays = scheduleDelays.slice(1); // first entry is the pre-injection schedule
		for (let i = 1; i < postInjectionDelays.length; i++) {
			expect(postInjectionDelays[i]).toBeGreaterThanOrEqual(postInjectionDelays[i - 1]);
		}
		expect(postInjectionDelays.at(-1)).toBeGreaterThan(0);
	});

	it("treats a no-further-error attempt as recovery and clears retry state", () => {
		const { actions } = createMockActions();
		reaction.onOutput(ctx(0, CLAUDE_ERROR_LINE), state, actions);
		// First attempt injects (retryCount 0 → 1).
		reaction.onAttempt(ctx(5_000), state, actions);
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(1);
		// Next attempt with NO new error since the injection → recovered.
		reaction.onAttempt(ctx(30_000), state, actions);
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(1);
		expect(actions.clearConnectionRetryState).toHaveBeenCalledTimes(1);
		expect(actions.clearScheduledAttempts).toHaveBeenCalled();
	});

	it("ignores a redrawn identical error without starting a second episode", () => {
		const { actions } = createMockActions();
		reaction.onOutput(ctx(0, CLAUDE_ERROR_LINE), state, actions);
		reaction.onOutput(ctx(1, CLAUDE_ERROR_LINE), state, actions);
		reaction.onOutput(ctx(2, CLAUDE_ERROR_LINE), state, actions);
		// Still a single episode → a single setConnectionRetryState from the initial start.
		expect(actions.setConnectionRetryState).toHaveBeenCalledTimes(1);
	});

	it("gives up (clears state) on a permanent error", () => {
		const { actions } = createMockActions();
		reaction.onOutput(ctx(0, CLAUDE_ERROR_LINE), state, actions);
		reaction.onOutput(ctx(1, "401 Unauthorized: invalid api key"), state, actions);
		expect(actions.clearConnectionRetryState).toHaveBeenCalledTimes(1);
		expect(actions.clearScheduledAttempts).toHaveBeenCalled();
	});

	it("triggerNow forces an immediate injection even when recovery would otherwise fire", () => {
		const { actions } = createMockActions();
		reaction.onOutput(ctx(0, CLAUDE_ERROR_LINE), state, actions);
		reaction.onAttempt(ctx(5_000), state, actions); // injection #1
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(1);
		// No new error since injection — an automatic attempt would recover. Manual trigger forces inject.
		reaction.triggerNow(ctx(6_000), state, actions);
		expect(actions.submitContinuationReference).toHaveBeenCalledTimes(2);
		expect(actions.clearConnectionRetryState).not.toHaveBeenCalled();
	});

	it("triggerNow is a no-op when not in a retry episode", () => {
		const { actions } = createMockActions();
		reaction.triggerNow(ctx(1_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
	});

	it("dismiss ends the episode (clears retry state, stops timers, no injection)", () => {
		const { actions } = createMockActions();
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		expect(actions.setConnectionRetryState).toHaveBeenCalledTimes(1);
		reaction.dismiss(ctx(2_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
		expect(actions.clearConnectionRetryState).toHaveBeenCalledTimes(1);
		expect(actions.clearScheduledAttempts).toHaveBeenCalled();
		// 移出后退避定时器再触发也不应注入（episode 已结束）。
		reaction.onAttempt(ctx(10_000), state, actions);
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
	});

	it("dismiss is a no-op when not in a retry episode", () => {
		const { actions } = createMockActions();
		reaction.dismiss(ctx(1_000), state, actions);
		expect(actions.clearConnectionRetryState).not.toHaveBeenCalled();
		expect(actions.submitContinuationReference).not.toHaveBeenCalled();
	});

	it("soft dismiss: a new transient error after dismiss re-arms a fresh episode", () => {
		const { actions, retryPatches } = createMockActions();
		reaction.onOutput(ctx(1_000, CLAUDE_ERROR_LINE), state, actions);
		reaction.dismiss(ctx(2_000), state, actions);
		// 新的瞬时连接错误（移出之后）应重新进入一次新 episode。
		reaction.onOutput(ctx(60_000, CLAUDE_ERROR_LINE), state, actions);
		expect(actions.setConnectionRetryState).toHaveBeenCalledTimes(2);
		expect(retryPatches.at(-1)).toMatchObject({ status: "retrying", retryCount: 0 });
	});
});
