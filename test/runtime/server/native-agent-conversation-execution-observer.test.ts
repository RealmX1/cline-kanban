import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../../../src/core/codex-native-agent-turn-execution-observation";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const observers: ReturnType<typeof createNativeAgentConversationActivityObserver>[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_790_000_000_000);
});
afterEach(() => {
	for (const observer of observers.splice(0)) observer.dispose();
	vi.useRealTimers();
});

function fixture() {
	const state: { summary: RuntimeTaskSessionSummary } = {
		summary: {
			taskId: "background-wait",
			state: "running",
			agentId: "codex",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			workspacePath: "/isolated",
			pid: 12,
			startedAt: Date.now() - 1000,
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			runtimeSessionIncarnationId: "incarnation",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				transcriptPath: "/isolated/native.jsonl",
				observedAt: 1,
			},
			codexNativeSessionControlEndpoint: {
				workspaceId: "isolated",
				conversationSessionId: "background-wait",
				runtimeSessionIncarnationId: "incarnation",
				socketPath: "/isolated/control.sock",
			},
		},
	};
	const execution = (): CodexNativeAgentTurnExecutionObservation => ({
		workspaceId: "isolated",
		conversationSessionId: "background-wait",
		runtimeSessionIncarnationId: "incarnation",
		nativeSessionId: "native",
		nativeTurnId: "current",
		nativeTurnStartedAtMs: Date.now() - 1000,
		observedAtMs: Date.now(),
		threadStatus: "active",
		nativeTurnStatus: "inProgress",
		activeFlags: [],
		canAcceptDirectInput: true,
		executionStatus: "running",
	});
	const read = vi.fn(
		async (
			_input: ReadNativeAgentConversationActivityInput,
		): Promise<NativeAgentConversationActivityReadResult | null> => ({
			events: [],
			cursor: null,
			codexNativeAgentTurnExecution: execution(),
		}),
	);
	const onAccepted = vi.fn();
	const onActivity = vi.fn();
	const onExecution = vi.fn();
	const observer = createNativeAgentConversationActivityObserver({
		readNativeActivity: read,
		onAccepted,
		onActivity,
		onCodexNativeAgentTurnExecution: onExecution,
	});
	observers.push(observer);
	const observe = () => observer.observeTaskSessionSummary("isolated", state.summary, () => state.summary);
	return { observer, state, execution, read, onAccepted, onActivity, onExecution, observe };
}

describe("静默期间持续原生回合核验", () => {
	it("没有摘要或活动也每十五秒核验，基线状态不制造接受或活动", async () => {
		const f = fixture();
		await f.observe();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(f.read).toHaveBeenCalledTimes(21);
		expect(f.onExecution).toHaveBeenCalledTimes(21);
		expect(f.onActivity).not.toHaveBeenCalled();
		expect(f.onAccepted).not.toHaveBeenCalled();
	});
	it("未知按十五、三十、六十秒退避，恢复后自动接续", async () => {
		const f = fixture();
		f.read.mockResolvedValue(null);
		await f.observe();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.read).toHaveBeenCalledTimes(3);
		f.read.mockImplementation(async () => ({
			events: [],
			cursor: null,
			codexNativeAgentTurnExecution: f.execution(),
		}));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.onExecution).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.onExecution).toHaveBeenCalledTimes(2);
	});
	it("未知执行退避期间，普通 hook 摘要仍及时读取活动和原生接受", async () => {
		const f = fixture();
		f.read.mockResolvedValueOnce(null);
		await f.observe();
		await vi.advanceTimersByTimeAsync(251);
		f.state.summary = {
			...f.state.summary,
			lastHookAt: Date.now(),
			latestHookActivity: {
				source: "codex",
				hookEventName: "AfterToolUse",
				toolName: "exec_command",
				toolInputSummary: null,
				activityText: null,
				finalMessage: null,
				notificationType: null,
			},
		};
		f.read.mockResolvedValueOnce({
			events: [
				{
					observedAtMs: Date.now(),
					activityKind: "tool_activity",
					evidenceKind: "structured_agent_session_event",
					eventId: "new-tool-result",
				},
				{
					observedAtMs: Date.now(),
					activityKind: "accepted_user_input",
					evidenceKind: "native_user_prompt_acceptance",
					eventId: "new-native-user-message",
				},
			],
			cursor: null,
		});
		await f.observe();
		expect(f.onActivity).toHaveBeenCalledTimes(2);
		expect(f.onAccepted).toHaveBeenCalledTimes(1);
		expect(f.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ shouldReadCodexNativeAgentTurnExecution: false }),
		);
	});
	it("持续活动补读不改变未知退避的次数和期限，执行补证不会饥饿", async () => {
		const f = fixture();
		const startedAtMs = Date.now();
		const executionReadElapsedTimesMs: number[] = [];
		f.read.mockImplementation(async (input) => {
			if (input.shouldReadCodexNativeAgentTurnExecution !== false) {
				executionReadElapsedTimesMs.push(input.observedAtMs - startedAtMs);
				return null;
			}
			return {
				events: [
					{
						observedAtMs: input.observedAtMs,
						activityKind: "tool_activity",
						evidenceKind: "structured_agent_session_event",
						eventId: `tool-result:${input.observedAtMs}`,
					},
				],
				cursor: null,
			};
		});
		await f.observe();
		for (let elapsedMs = 1_000; elapsedMs <= 165_000; elapsedMs += 1_000) {
			await vi.advanceTimersByTimeAsync(1_000);
			f.state.summary = { ...f.state.summary, updatedAt: Date.now(), lastOutputAt: Date.now() };
			await f.observe();
		}
		expect(executionReadElapsedTimesMs).toEqual([0, 15_000, 45_000, 105_000, 165_000]);
		expect(f.onActivity.mock.calls.length).toBeGreaterThan(150);
		expect(f.onAccepted).not.toHaveBeenCalled();
	});
	it("显式提交候选绕过未知执行退避，接受后恢复普通状态核验", async () => {
		const f = fixture();
		f.read.mockResolvedValueOnce(null);
		await f.observe();
		await vi.advanceTimersByTimeAsync(251);
		f.read.mockResolvedValueOnce({
			events: [
				{
					observedAtMs: Date.now(),
					activityKind: "accepted_user_input",
					evidenceKind: "native_user_prompt_acceptance",
					eventId: "submitted-candidate-accepted",
				},
			],
			cursor: null,
			codexNativeAgentTurnExecution: f.execution(),
		});
		f.observer.wakeForPotentialUserPromptSubmission("isolated", f.state.summary, () => f.state.summary);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.onAccepted).toHaveBeenCalledTimes(1);
		expect(f.onExecution).toHaveBeenCalledTimes(1);
		expect(f.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ shouldReadCodexNativeAgentTurnExecution: true }),
		);
		await vi.advanceTimersByTimeAsync(251);
		await f.observe();
		expect(f.onExecution).toHaveBeenCalledTimes(2);
		expect(f.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ shouldReadCodexNativeAgentTurnExecution: true }),
		);
	});
	it("静默扫描单飞，旧 incarnation 返回不会落进新会话", async () => {
		const f = fixture();
		let finish: (result: NativeAgentConversationActivityReadResult) => void = () => {};
		f.read.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = f.observe();
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.read).toHaveBeenCalledTimes(1);
		f.state.summary = { ...f.state.summary, runtimeSessionIncarnationId: "new-incarnation" };
		finish({ events: [], cursor: null, codexNativeAgentTurnExecution: f.execution() });
		await pending;
		expect(f.onExecution).not.toHaveBeenCalled();
	});
	it("rewind 后丢弃在途旧分支的状态和活动", async () => {
		const f = fixture();
		let finish: (result: NativeAgentConversationActivityReadResult) => void = () => {};
		f.read.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = f.observe();
		await Promise.resolve();
		await Promise.resolve();
		f.state.summary = {
			...f.state.summary,
			lastHookAt: Date.now(),
			latestHookActivity: {
				source: "codex",
				hookEventName: "thread_rolled_back",
				toolName: null,
				toolInputSummary: null,
				activityText: null,
				finalMessage: null,
				notificationType: null,
			},
		};
		void f.observe();
		finish({
			events: [
				{
					observedAtMs: Date.now(),
					activityKind: "tool_activity",
					evidenceKind: "persisted_agent_transcript",
					eventId: "old",
				},
			],
			cursor: null,
			codexNativeAgentTurnExecution: f.execution(),
		});
		await pending;
		expect(f.onExecution).not.toHaveBeenCalled();
		expect(f.onActivity).not.toHaveBeenCalled();
	});
	it("明确 Stop 后停止周期探测，dispose 清理所有调度", async () => {
		const f = fixture();
		await f.observe();
		f.state.summary = { ...f.state.summary, turnOwner: "user", userTurnKind: "review", reviewReason: "hook" };
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.read).toHaveBeenCalledTimes(1);
		f.observer.dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.read).toHaveBeenCalledTimes(1);
	});
});
