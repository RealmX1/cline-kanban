import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	AGENT_OUTPUT_QUIET_THRESHOLD_MS,
	deriveDisplayLiveness,
	isAgentActivelyProducingOutput,
	isAgentOutputQuiet,
	isAgentOutputWithinActiveWindow,
	type SessionFacets,
	VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
} from "../../../src/core/session-activity";

const NOW = 1_700_000_000_000;

// 只构造活性判定关心的字段（state / lastOutputAt），其余按 schema 必填项给安全默认值。
function makeSummary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: NOW,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("isAgentOutputWithinActiveWindow（共享新鲜度原语）", () => {
	it("窗口内 → true", () => {
		expect(isAgentOutputWithinActiveWindow(NOW - 1_000, NOW, 2_000)).toBe(true);
	});

	it("恰好等于窗口边界 → false（严格小于）", () => {
		expect(isAgentOutputWithinActiveWindow(NOW - 2_000, NOW, 2_000)).toBe(false);
	});

	it("超过窗口 → false", () => {
		expect(isAgentOutputWithinActiveWindow(NOW - 2_001, NOW, 2_000)).toBe(false);
	});

	it("lastOutputAt 为 null → false（从未产出 / 已死残留）", () => {
		expect(isAgentOutputWithinActiveWindow(null, NOW, 2_000)).toBe(false);
	});

	it("lastOutputAt 为 undefined → false", () => {
		expect(isAgentOutputWithinActiveWindow(undefined, NOW, 2_000)).toBe(false);
	});
});

describe("isAgentOutputQuiet（后端自动续跑静默门控）", () => {
	it("从未产出（null）→ true（视为静默，避免永久卡住注入）", () => {
		expect(isAgentOutputQuiet(null, NOW)).toBe(true);
	});

	it("默认阈值 2s 内有输出 → false（仍在工作）", () => {
		expect(isAgentOutputQuiet(NOW - (AGENT_OUTPUT_QUIET_THRESHOLD_MS - 1), NOW)).toBe(false);
	});

	it("距最近输出恰好 >= 默认 2s → true（已静默）", () => {
		expect(isAgentOutputQuiet(NOW - AGENT_OUTPUT_QUIET_THRESHOLD_MS, NOW)).toBe(true);
	});

	it("与旧实现逐点一致：quiet === (lastOutputAt===null || now-lastOutputAt>=2000)", () => {
		for (const delta of [0, 1, 1_999, 2_000, 2_001, 10_000]) {
			const lastOutputAt = NOW - delta;
			const legacy = lastOutputAt === null ? true : NOW - lastOutputAt >= AGENT_OUTPUT_QUIET_THRESHOLD_MS;
			expect(isAgentOutputQuiet(lastOutputAt, NOW)).toBe(legacy);
		}
		expect(isAgentOutputQuiet(null, NOW)).toBe(true);
	});

	it("自定义阈值参数生效", () => {
		expect(isAgentOutputQuiet(NOW - 3_000, NOW, 5_000)).toBe(false);
		expect(isAgentOutputQuiet(NOW - 6_000, NOW, 5_000)).toBe(true);
	});
});

describe("Validation 持续活动只读统一可信观测", () => {
	it.each([
		"accepted_user_input",
		"agent_output",
		"tool_activity",
		"context_compaction",
		"model_request_dispatch",
	] as const)("agent 回合最近有 %s 时仍有效活动", (activityKind) => {
		const summary = makeSummary({
			lastEffectiveAgentConversationActivityObservation: {
				observedAtMs: NOW - 1_000,
				evidenceKind: "structured_agent_session_event",
				activityKind,
			},
		});
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(true);
	});
	it("实质 TUI 戳和每秒 PTY 字节均不能证明有效活动", () => {
		expect(
			isAgentActivelyProducingOutput(makeSummary({ lastOutputAt: NOW, lastSubstantiveOutputAt: NOW }), NOW),
		).toBe(false);
	});
	it("恰好 5 秒或更早的活动不打回 Validation", () => {
		for (const delta of [VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS, 60_000]) {
			expect(
				isAgentActivelyProducingOutput(
					makeSummary({
						lastEffectiveAgentConversationActivityObservation: {
							observedAtMs: NOW - delta,
							evidenceKind: "persisted_agent_transcript",
							activityKind: "agent_output",
						},
					}),
					NOW,
				),
			).toBe(false);
		}
	});
	it("facet 权威，用户回合和 park 均不打回 Validation", () => {
		const activity = {
			observedAtMs: NOW,
			evidenceKind: "structured_agent_session_event" as const,
			activityKind: "tool_activity" as const,
		};
		const user = makeSummary({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			lastEffectiveAgentConversationActivityObservation: activity,
		});
		expect(isAgentActivelyProducingOutput(user, NOW)).toBe(false);
		const parked = makeSummary({
			awaitingDispatchedBackgroundWork: { sinceMs: NOW },
			lastEffectiveAgentConversationActivityObservation: activity,
		});
		expect(isAgentActivelyProducingOutput(parked, NOW)).toBe(false);
	});
	it("没有会话或只有低可信观测时不打回", () => {
		expect(isAgentActivelyProducingOutput(undefined, NOW)).toBe(false);
		expect(
			isAgentActivelyProducingOutput(
				makeSummary({
					lastEffectiveAgentConversationActivityObservation: {
						observedAtMs: NOW,
						evidenceKind: "terminal_output_heuristic_classification",
						activityKind: "agent_output",
					},
				}),
				NOW,
			),
		).toBe(false);
	});
});

describe("deriveDisplayLiveness（展示叠加：live → computing / quiet）", () => {
	const agentLive: SessionFacets = { turnOwner: "agent", liveness: "live", userTurnKind: null };

	it("live 且最近一次输出在 5s 默认窗口内 → computing", () => {
		expect(deriveDisplayLiveness(agentLive, NOW - (VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1), NOW)).toBe(
			"computing",
		);
	});

	it("live 但最近一次输出超出默认窗口 → quiet（活着但静默）", () => {
		expect(deriveDisplayLiveness(agentLive, NOW - (VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS + 1), NOW)).toBe(
			"quiet",
		);
	});

	it("live 恰好等于窗口边界 → quiet（新鲜度原语是严格小于）", () => {
		expect(deriveDisplayLiveness(agentLive, NOW - VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS, NOW)).toBe("quiet");
	});

	it("live 但 lastOutputAt 为 null（从未产出 / 已死残留）→ quiet", () => {
		expect(deriveDisplayLiveness(agentLive, null, NOW)).toBe("quiet");
	});

	it("自定义 activeWindowMs 生效", () => {
		expect(deriveDisplayLiveness(agentLive, NOW - 3_000, NOW, { activeWindowMs: 5_000 })).toBe("computing");
		expect(deriveDisplayLiveness(agentLive, NOW - 6_000, NOW, { activeWindowMs: 5_000 })).toBe("quiet");
	});

	it("user 回合的 live 也按新鲜度拆分（helper 通用；agent 收窄交由消费者）", () => {
		const userLive: SessionFacets = { turnOwner: "user", liveness: "live", userTurnKind: "review" };
		expect(deriveDisplayLiveness(userLive, NOW, NOW)).toBe("computing");
		expect(deriveDisplayLiveness(userLive, NOW - 10_000, NOW)).toBe("quiet");
	});

	it("非 live 基值一律原样透传（与 lastOutputAt / nowMs 无关）", () => {
		const cases: { liveness: SessionFacets["liveness"]; facets: SessionFacets }[] = [
			{ liveness: "none", facets: { turnOwner: null, liveness: "none", userTurnKind: null } },
			{ liveness: "starting", facets: { turnOwner: "agent", liveness: "starting", userTurnKind: null } },
			{ liveness: "retrying", facets: { turnOwner: "agent", liveness: "retrying", userTurnKind: null } },
			{ liveness: "exited", facets: { turnOwner: "user", liveness: "exited", userTurnKind: "review" } },
			{ liveness: "failed", facets: { turnOwner: "user", liveness: "failed", userTurnKind: "error" } },
			{
				liveness: "interrupted",
				facets: { turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" },
			},
		];
		for (const { liveness, facets } of cases) {
			// 即便 lastOutputAt 很新鲜，非 live 也不会被叠加成 computing。
			expect(deriveDisplayLiveness(facets, NOW, NOW)).toBe(liveness);
		}
	});
});
