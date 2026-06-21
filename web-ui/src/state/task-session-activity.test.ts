import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	isAgentActivelyProducingOutput,
	VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
} from "@/state/task-session-activity";

const NOW = 1_700_000_000_000;

// 只构造 isAgentActivelyProducingOutput 关心的字段（state / lastOutputAt），
// 其余按 schema 必填项给安全默认值，方便用 overrides 改写关键字段。
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

describe("isAgentActivelyProducingOutput", () => {
	it("running 且最近一次输出在阈值内 → true（仍在持续产出）", () => {
		const summary = makeSummary({
			state: "running",
			lastOutputAt: NOW - (VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1),
		});
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(true);
	});

	it("running 但最近一次输出超过阈值（空闲）→ false（允许停留 Validation）", () => {
		const summary = makeSummary({
			state: "running",
			lastOutputAt: NOW - (VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS + 1),
		});
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(false);
	});

	it("恰好等于阈值边界 → false（阈值是严格小于）", () => {
		const summary = makeSummary({
			state: "running",
			lastOutputAt: NOW - VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
		});
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(false);
	});

	it("running 但 lastOutputAt 为 null（从未输出 / 已死残留）→ false", () => {
		const summary = makeSummary({ state: "running", lastOutputAt: null });
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(false);
	});

	it("awaiting_review 即使最近有输出也 → false（只对 running 生效）", () => {
		const summary = makeSummary({
			state: "awaiting_review",
			lastOutputAt: NOW,
		});
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(false);
	});

	it("idle → false", () => {
		const summary = makeSummary({ state: "idle", lastOutputAt: NOW });
		expect(isAgentActivelyProducingOutput(summary, NOW)).toBe(false);
	});

	it("undefined summary → false（任务无会话）", () => {
		expect(isAgentActivelyProducingOutput(undefined, NOW)).toBe(false);
	});
});
