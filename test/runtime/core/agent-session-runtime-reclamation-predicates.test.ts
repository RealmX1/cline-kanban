// 「停止生成响应后固定宽限期」回收的纯判据（session-activity.ts）：宽限期常量、绝对期限换算、
// 到期判定（含 null=无期限）、「仍在生成」保守判据、以及陈旧定时器双重防护。
import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
	computeAgentSessionRuntimeReclamationEligibleAt,
	isAgentSessionCurrentlyGeneratingResponse,
	isAgentSessionRuntimeReclamationDue,
	isReclamationDeadlineStillCurrentForSession,
	PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS,
	type SessionFacets,
} from "../../../src/core/session-activity";

const NOW = 1_700_000_000_000;

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

function facets(overrides: Partial<SessionFacets> = {}): SessionFacets {
	return { turnOwner: "agent", liveness: "live", userTurnKind: null, ...overrides };
}

describe("回收宽限期常量", () => {
	it("统一宽限期为 2 小时", () => {
		expect(AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS).toBe(2 * 60 * 60_000);
	});

	it("park 兜底默认上限为 24 小时（独立轨道，不等于宽限期）", () => {
		expect(PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS).toBe(24 * 60 * 60_000);
		expect(PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS).not.toBe(
			AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS,
		);
	});
});

describe("computeAgentSessionRuntimeReclamationEligibleAt", () => {
	it("返回绝对时刻 = 锚点 + 宽限期", () => {
		expect(computeAgentSessionRuntimeReclamationEligibleAt(NOW)).toBe(NOW + 2 * 60 * 60_000);
	});

	it("可传入自定义宽限期（park 轨道 / 设置项覆盖）", () => {
		expect(
			computeAgentSessionRuntimeReclamationEligibleAt(NOW, PARKED_AGENT_SESSION_ABANDONED_DEFAULT_MAX_RETENTION_MS),
		).toBe(NOW + 24 * 60 * 60_000);
	});
});

describe("isAgentSessionRuntimeReclamationDue", () => {
	it("未到期 → false", () => {
		expect(isAgentSessionRuntimeReclamationDue(NOW + 1, NOW)).toBe(false);
	});

	it("恰好到期 → true（大于等于，与新鲜度判据的严格小于互补）", () => {
		expect(isAgentSessionRuntimeReclamationDue(NOW, NOW)).toBe(true);
	});

	it("已过期 → true", () => {
		expect(isAgentSessionRuntimeReclamationDue(NOW - 1, NOW)).toBe(true);
	});

	it("null / undefined（显式无期限 / 未设置）→ 恒 false", () => {
		expect(isAgentSessionRuntimeReclamationDue(null, NOW)).toBe(false);
		expect(isAgentSessionRuntimeReclamationDue(undefined, NOW)).toBe(false);
	});
});

describe("isAgentSessionCurrentlyGeneratingResponse（保守：宁可漏回收）", () => {
	it("agent 回合且未 park → 仍在生成", () => {
		expect(isAgentSessionCurrentlyGeneratingResponse(facets(), makeSummary({}))).toBe(true);
	});

	it("agent 回合但已 park → 不算在生成（走 park 独立轨道）", () => {
		const parked = makeSummary({ awaitingDispatchedBackgroundWork: { sinceMs: NOW } });
		expect(isAgentSessionCurrentlyGeneratingResponse(facets(), parked)).toBe(false);
	});

	it("人回合（等人回答 / 等人审查）→ 不算在生成", () => {
		expect(
			isAgentSessionCurrentlyGeneratingResponse(
				facets({ turnOwner: "user", userTurnKind: "question" }),
				makeSummary({}),
			),
		).toBe(false);
	});

	it("无回合（turnOwner=null）→ 不算在生成", () => {
		expect(
			isAgentSessionCurrentlyGeneratingResponse(
				facets({ turnOwner: null, liveness: "none" }),
				makeSummary({ state: "idle" }),
			),
		).toBe(false);
	});

	it("agent 回合但 summary 缺失 → 仍按在生成处理（保守）", () => {
		expect(isAgentSessionCurrentlyGeneratingResponse(facets(), null)).toBe(true);
	});
});

describe("isReclamationDeadlineStillCurrentForSession（陈旧定时器双重防护）", () => {
	const deadline = { runtimeSessionIncarnationId: "incarnation-a", agentResponseGenerationTurnSequence: 3 };

	it("活体与回合序号都匹配 → 仍然有效", () => {
		const summary = makeSummary({
			runtimeSessionIncarnationId: "incarnation-a",
			agentResponseGenerationTurnSequence: 3,
		});
		expect(isReclamationDeadlineStillCurrentForSession(deadline, summary)).toBe(true);
	});

	it("活体变了（会话被重启过）→ 失效", () => {
		const summary = makeSummary({
			runtimeSessionIncarnationId: "incarnation-b",
			agentResponseGenerationTurnSequence: 3,
		});
		expect(isReclamationDeadlineStillCurrentForSession(deadline, summary)).toBe(false);
	});

	it("同一活体但回合序号推进了（用户又发了一句）→ 失效", () => {
		const summary = makeSummary({
			runtimeSessionIncarnationId: "incarnation-a",
			agentResponseGenerationTurnSequence: 4,
		});
		expect(isReclamationDeadlineStillCurrentForSession(deadline, summary)).toBe(false);
	});

	it("summary 不存在（会话已消失）→ 失效", () => {
		expect(isReclamationDeadlineStillCurrentForSession(deadline, null)).toBe(false);
	});

	it("旧盘数据缺 turnSequence → 按 0 处理，与非零期限不匹配", () => {
		const summary = makeSummary({ runtimeSessionIncarnationId: "incarnation-a" });
		expect(isReclamationDeadlineStillCurrentForSession(deadline, summary)).toBe(false);
		expect(
			isReclamationDeadlineStillCurrentForSession(
				{ runtimeSessionIncarnationId: "incarnation-a", agentResponseGenerationTurnSequence: 0 },
				summary,
			),
		).toBe(true);
	});
});
