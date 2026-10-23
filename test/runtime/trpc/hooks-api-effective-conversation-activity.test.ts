import { describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

function setup(overrides: Partial<RuntimeTaskSessionSummary> = {}) {
	const summary: RuntimeTaskSessionSummary = {
		taskId: "main-session",
		agentId: "claude",
		state: "awaiting_review",
		workspacePath: "/unavailable/activity-test",
		pid: 123,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "incarnation-1",
		...overrides,
	};
	const manager = {
		getSummary: () => summary,
		transitionToRunning: vi.fn(() => summary),
		transitionToReview: vi.fn(() => summary),
		applyHookActivity: vi.fn(),
		recordAgentLifecycleHookConversationProgress: vi.fn(),
		recordMainAgentConversationModelRequestDispatch: vi.fn(),
		markAgentConversationPromptSubmissionPending: vi.fn(),
	} as unknown as TerminalSessionManager;
	const api = createHooksApi({
		getWorkspacePathById: () => "/unavailable/activity-test",
		ensureTerminalManagerForWorkspace: async () => manager,
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: vi.fn(),
	});
	return { api, manager };
}

describe("hook 有效会话活动的证据边界", () => {
	it("前置提交 hook 只登记待确认，不把放行当作 harness 接受", async () => {
		const { api, manager } = setup();
		const result = await api.ingest({
			workspaceId: "isolated",
			taskId: "main-session",
			event: "to_in_progress",
			submittedPromptText: "请继续",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});
		expect(result.ok).toBe(true);
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.recordMainAgentConversationModelRequestDispatch).not.toHaveBeenCalled();
		expect(manager.markAgentConversationPromptSubmissionPending).toHaveBeenCalled();
	});

	it("内部 subagent 的结束不推进或交回主会话", async () => {
		const { api, manager } = setup();
		const result = await api.ingest({
			workspaceId: "isolated",
			taskId: "main-session",
			event: "to_review",
			hookEventFiredInsideSubagentContext: true,
			metadata: { source: "claude", hookEventName: "SubagentStop" },
		});
		expect(result.ok).toBe(true);
		expect(manager.recordAgentLifecycleHookConversationProgress).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it.each(["Stop", "AfterAgent", "agent-turn-complete"])(
		"本代待确认输入之后的真实 %s 仍交给回合漏斗，不能被 user→user 门控丢弃",
		async (hookEventName) => {
			const { api, manager } = setup({
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs: Date.now() - 10,
					runtimeSessionIncarnationId: "incarnation-1",
				},
			});
			const result = await api.ingest({
				workspaceId: "isolated",
				taskId: "main-session",
				event: "to_review",
				metadata: { source: "claude", hookEventName },
			});
			expect(result.ok).toBe(true);
			expect(manager.transitionToReview).toHaveBeenCalledOnce();
			expect(manager.recordAgentLifecycleHookConversationProgress).toHaveBeenCalledOnce();
			expect(manager.transitionToRunning).not.toHaveBeenCalled();
		},
	);

	it.each(["", "PermissionRequest", "PreToolUse"])(
		"待确认输入不会把非完成信号 %s 当作已完成回合",
		async (hookEventName) => {
			const { api, manager } = setup({
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs: Date.now() - 10,
					runtimeSessionIncarnationId: "incarnation-1",
				},
			});
			const result = await api.ingest({
				workspaceId: "isolated",
				taskId: "main-session",
				event: "to_review",
				metadata: {
					source: "claude",
					hookEventName,
					...(hookEventName === "PreToolUse" ? { toolName: "AskUserQuestion" } : {}),
				},
			});
			expect(result.ok).toBe(true);
			expect(manager.transitionToReview).not.toHaveBeenCalled();
			expect(manager.recordAgentLifecycleHookConversationProgress).not.toHaveBeenCalled();
		},
	);

	it.each(["older_stop", "prior_incarnation", "duplicate_stop", "modal_turn", "subagent_stop"] as const)(
		"待确认输入不能由 %s 完成信号制造新回合",
		async (scenario) => {
			const attemptedAtMs = Date.now() - 10;
			const { api, manager } = setup({
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					attemptedAtMs,
					runtimeSessionIncarnationId: scenario === "prior_incarnation" ? "incarnation-previous" : "incarnation-1",
				},
				...(scenario === "duplicate_stop"
					? {
							lastAgentConversationUserHandoffObservation: {
								observedAtMs: attemptedAtMs + 1,
								signalConfidence: "harness_turn_complete" as const,
								turnSequence: 1,
							},
						}
					: {}),
				...(scenario === "modal_turn" ? { userTurnKind: "question" as const } : {}),
			});
			const result = await api.ingest({
				workspaceId: "isolated",
				taskId: "main-session",
				event: "to_review",
				...(scenario === "older_stop" ? { hookEventCapturedAtEpochMs: attemptedAtMs - 1 } : {}),
				hookEventFiredInsideSubagentContext: scenario === "subagent_stop",
				metadata: { source: "claude", hookEventName: "Stop" },
			});
			expect(result.ok).toBe(true);
			expect(manager.transitionToReview).not.toHaveBeenCalled();
			expect(manager.recordAgentLifecycleHookConversationProgress).not.toHaveBeenCalled();
		},
	);
});
