import { describe, expect, it } from "vitest";
import {
	collectTaskConversationSessionActivityObservations,
	mergeLastEffectiveAgentConversationActivityObservation,
	resolveLastAgentConversationUserHandoffObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "../../../src/core/agent-conversation-activity-observation";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const NOW = 1_700_000_000_000;

describe("有效会话活动的兼容读取与单调归并", () => {
	it("旧停止时间可能来自进程恢复，不能直接升级为历史交棒", () => {
		expect(
			resolveLastAgentConversationUserHandoffObservation({
				agentResponseGenerationStopped: {
					stoppedAt: NOW,
					signalConfidence: "harness_turn_complete",
					turnSequence: 7,
				},
			}),
		).toBeNull();
	});
	it("历史 TUI 和实质输出不能升级为可信活动", () => {
		expect(
			resolveLastEffectiveAgentConversationActivityObservation({
				lastSubstantiveOutputAt: NOW,
				lastConversationProgressObservation: {
					observedAtMs: NOW,
					evidenceKind: "terminal_output_heuristic_classification",
				},
			}),
		).toBeNull();
	});

	it("旧可信转录保留发生时间，不能被更新的实质输出盖过", () => {
		expect(
			resolveLastEffectiveAgentConversationActivityObservation({
				lastSubstantiveOutputAt: NOW,
				lastConversationProgressObservation: {
					observedAtMs: NOW - 5_000,
					evidenceKind: "persisted_agent_transcript",
				},
			}),
		).toEqual({
			observedAtMs: NOW - 5_000,
			evidenceKind: "persisted_agent_transcript",
			activityKind: "agent_output",
		});
	});

	it("旧前置提交 hook 不等于可靠接受，不能生成已接受输入", () => {
		expect(
			resolveLastEffectiveAgentConversationActivityObservation({
				lastMainAgentConversationModelRequestDispatchObservation: {
					observedAtMs: NOW,
					evidenceKind: "user_prompt_submit_hook_event_accepted",
				},
			}),
		).toBeNull();
	});

	it("新可信输入在 incarnation 边界也不能被旧转录回拉", () => {
		const accepted = {
			observedAtMs: NOW - 100,
			evidenceKind: "native_user_prompt_acceptance" as const,
			activityKind: "accepted_user_input" as const,
			eventId: "native-turn-2:user-message-1",
		};
		expect(
			mergeLastEffectiveAgentConversationActivityObservation(
				accepted,
				{ observedAtMs: NOW - 10_000, evidenceKind: "persisted_agent_transcript", activityKind: "agent_output" },
				{ nowMs: NOW, allowCorrectionOfPreviousTerminalHeuristic: true },
			),
		).toBe(accepted);
	});

	it("重复事件在晚到后不改写发生时间", () => {
		const previous = {
			observedAtMs: NOW - 5_000,
			evidenceKind: "native_user_prompt_acceptance" as const,
			activityKind: "accepted_user_input" as const,
			eventId: "native-turn-2:user-message-1",
		};
		expect(
			mergeLastEffectiveAgentConversationActivityObservation(
				previous,
				{ ...previous, observedAtMs: NOW },
				{ nowMs: NOW },
			),
		).toBe(previous);
	});

	it("非法、未来和 TUI 传入观测不污染已有可信值", () => {
		const previous = {
			observedAtMs: NOW - 100,
			evidenceKind: "native_user_prompt_acceptance" as const,
			activityKind: "accepted_user_input" as const,
		};
		for (const incoming of [
			{ ...previous, observedAtMs: Number.NaN },
			{ ...previous, observedAtMs: NOW + 3_600_000 },
			{ ...previous, observedAtMs: NOW, evidenceKind: "terminal_output_heuristic_classification" as const },
		])
			expect(mergeLastEffectiveAgentConversationActivityObservation(previous, incoming, { nowMs: NOW })).toBe(
				previous,
			);
	});

	it("新字段存在时不再回读旧来源取最大值", () => {
		const current = {
			observedAtMs: NOW - 1_000,
			evidenceKind: "structured_agent_session_event" as const,
			activityKind: "tool_activity" as const,
		};
		const summary: Pick<
			RuntimeTaskSessionSummary,
			"lastEffectiveAgentConversationActivityObservation" | "lastConversationProgressObservation"
		> = {
			lastEffectiveAgentConversationActivityObservation: current,
			lastConversationProgressObservation: { observedAtMs: NOW, evidenceKind: "agent_lifecycle_hook_event" },
		};
		expect(resolveLastEffectiveAgentConversationActivityObservation(summary)).toBe(current);
	});
});

describe("主绑定与旁支活动分别投影", () => {
	it("换主后保留旧主和 peer 的独立时间，不取最新旁支覆盖主时间", () => {
		const activity = (observedAtMs: number) => ({
			observedAtMs,
			evidenceKind: "persisted_agent_transcript" as const,
			activityKind: "agent_output" as const,
		});
		const metadata = (role: "main" | "task_collaborator" | "by_the_way") => ({
			workspaceTaskId: "task",
			taskConversationSessionRole: role,
			taskConversationSessionContextSource: "main" as const,
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		});
		const result = collectTaskConversationSessionActivityObservations(
			{ id: "task", mainTaskConversationSessionId: "new-main" },
			[
				{
					taskId: "task",
					agentId: "codex",
					lastEffectiveAgentConversationActivityObservation: activity(NOW - 10_000),
				},
				{
					taskId: "new-main",
					agentId: "codex",
					taskConversationSessionMetadata: metadata("task_collaborator"),
					lastEffectiveAgentConversationActivityObservation: activity(NOW - 5_000),
				},
				{
					taskId: "peer",
					agentId: "claude",
					taskConversationSessionMetadata: metadata("task_collaborator"),
					lastEffectiveAgentConversationActivityObservation: activity(NOW),
				},
				{
					taskId: "side",
					agentId: "codex",
					taskConversationSessionMetadata: metadata("by_the_way"),
					lastEffectiveAgentConversationActivityObservation: activity(NOW - 1_000),
				},
				{
					taskId: "foreign",
					agentId: "codex",
					taskConversationSessionMetadata: { ...metadata("task_collaborator"), workspaceTaskId: "other-task" },
					lastEffectiveAgentConversationActivityObservation: activity(NOW),
				},
			],
		);
		expect(result[0]).toMatchObject({
			sessionId: "new-main",
			role: "main",
			lastEffectiveAgentConversationActivityObservation: { observedAtMs: NOW - 5_000 },
		});
		expect(result.map((item) => [item.sessionId, item.role])).toEqual([
			["new-main", "main"],
			["peer", "task_collaborator"],
			["side", "by_the_way"],
			["task", "former_main"],
		]);
	});

	it("当前主摘要缺失时留下未知入口，不把 peer 提升为主", () => {
		expect(
			collectTaskConversationSessionActivityObservations(
				{ id: "task", mainTaskConversationSessionId: "missing-main" },
				[],
			),
		).toEqual([
			{
				sessionId: "missing-main",
				role: "main",
				agentId: null,
				lastEffectiveAgentConversationActivityObservation: null,
			},
		]);
	});
	it("显式主会话没有宿主归属时，不把它的活动当作主对话", () => {
		expect(
			collectTaskConversationSessionActivityObservations(
				{ id: "task", mainTaskConversationSessionId: "missing-owner-main" },
				[
					{
						taskId: "missing-owner-main",
						agentId: "codex",
						lastEffectiveAgentConversationActivityObservation: {
							observedAtMs: NOW,
							evidenceKind: "persisted_agent_transcript",
							activityKind: "agent_output",
						},
					},
				],
			),
		).toEqual([
			{
				sessionId: "missing-owner-main",
				role: "main",
				agentId: null,
				lastEffectiveAgentConversationActivityObservation: null,
			},
		]);
	});
});
