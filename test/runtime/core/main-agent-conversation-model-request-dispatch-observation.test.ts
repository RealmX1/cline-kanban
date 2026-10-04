import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { mergeLastMainAgentConversationModelRequestDispatchObservation } from "../../../src/core/last-main-agent-conversation-model-request-dispatch-observation";
import { classifyHookEventAsMainAgentConversationModelRequestDispatch } from "../../../src/core/main-agent-conversation-model-request-dispatch-hook-event-classification";
import { mergeSummaryWithFacets } from "../../../src/core/session-activity";

// 「主对话最后一次向模型发出请求」观测：Cache warm 倒计时起点（见 api-contract 的 schema 注释）。

const NOW_MS = 10_000_000_000;

describe("mergeLastMainAgentConversationModelRequestDispatchObservation", () => {
	const merge = mergeLastMainAgentConversationModelRequestDispatchObservation;
	const at = (observedAtMs: number) => ({ observedAtMs, evidenceKind: "post_tool_use_hook_event" as const });

	it("只单调前进：更旧的观测不覆盖", () => {
		expect(merge(null, at(NOW_MS - 10), { nowMs: NOW_MS })).toEqual(at(NOW_MS - 10));
		expect(merge(at(NOW_MS - 10), at(NOW_MS - 20), { nowMs: NOW_MS })).toEqual(at(NOW_MS - 10));
		expect(merge(at(NOW_MS - 10), at(NOW_MS - 5), { nowMs: NOW_MS })).toEqual(at(NOW_MS - 5));
	});

	it("拒收非法与远未来时刻；容忍窗口内的超前夹到 now", () => {
		expect(merge(at(1), at(Number.NaN), { nowMs: NOW_MS })).toEqual(at(1));
		expect(merge(at(1), at(NOW_MS + 3_600_000), { nowMs: NOW_MS })).toEqual(at(1));
		expect(merge(null, at(NOW_MS + 1_000), { nowMs: NOW_MS })).toEqual(at(NOW_MS));
	});

	it("经 summary 写侧漏斗合并：没有写点能把值往回改", () => {
		const prev = {
			taskId: "t",
			state: "running",
			agentId: "claude",
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: NOW_MS,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			lastMainAgentConversationModelRequestDispatchObservation: at(NOW_MS - 10),
		} as RuntimeTaskSessionSummary;
		const merged = mergeSummaryWithFacets(prev, {
			updatedAt: NOW_MS,
			lastMainAgentConversationModelRequestDispatchObservation: at(NOW_MS - 1_000),
		});
		expect(merged.lastMainAgentConversationModelRequestDispatchObservation).toEqual(at(NOW_MS - 10));
	});
});

describe("classifyHookEventAsMainAgentConversationModelRequestDispatch", () => {
	const classify = classifyHookEventAsMainAgentConversationModelRequestDispatch;
	const agentTurn = { turnOwner: "agent", liveness: "live", userTurnKind: null } as const;
	const reviewTurn = { turnOwner: "user", liveness: "live", userTurnKind: "review" } as const;

	it("未被拦截的 UserPromptSubmit / BeforeAgent：无论此刻球在谁手上都算（它正是开始一轮的那个事件）", () => {
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "userpromptsubmit",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: reviewTurn,
			}),
		).toBe("user_prompt_submit_hook_event_accepted");
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "beforeagent",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: reviewTurn,
			}),
		).toBe("before_agent_hook_event");
	});

	it("工具完成事件：agent 回合里算；Codex 的 PostToolUse 走 activity 也算", () => {
		expect(
			classify({
				event: "activity",
				normalizedHookEventName: "posttooluse",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: agentTurn,
			}),
		).toBe("post_tool_use_hook_event");
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "posttoolusefailure",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: agentTurn,
			}),
		).toBe("post_tool_use_failure_hook_event");
	});

	it("用户回合冻结：Stop 之后到来的工具事件（后台子代理）不算；工具调用本身引出的提问 / 授权答完后算", () => {
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "posttooluse",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: reviewTurn,
			}),
		).toBeNull();
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "posttooluse",
				hookEventFiredInsideSubagentContext: false,
				sessionFacetsBeforeTransition: { turnOwner: "user", liveness: "live", userTurnKind: "needs_input" },
			}),
		).toBeNull();
		for (const userTurnKind of ["question", "plan_review", "permission"] as const) {
			expect(
				classify({
					event: "to_in_progress",
					normalizedHookEventName: "posttooluse",
					hookEventFiredInsideSubagentContext: false,
					sessionFacetsBeforeTransition: { turnOwner: "user", liveness: "live", userTurnKind },
				}),
			).toBe("post_tool_use_hook_event");
		}
	});

	it("子代理内的事件、SubagentStop、Stop、PreToolUse 一律不算", () => {
		expect(
			classify({
				event: "to_in_progress",
				normalizedHookEventName: "posttooluse",
				hookEventFiredInsideSubagentContext: true,
				sessionFacetsBeforeTransition: agentTurn,
			}),
		).toBeNull();
		for (const [event, normalizedHookEventName] of [
			["activity", "subagentstop"],
			["to_review", "stop"],
			["activity", "pretooluse"],
		] as const) {
			expect(
				classify({
					event,
					normalizedHookEventName,
					hookEventFiredInsideSubagentContext: false,
					sessionFacetsBeforeTransition: agentTurn,
				}),
			).toBeNull();
		}
	});
});
