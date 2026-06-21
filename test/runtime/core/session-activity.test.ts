import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	AGENT_OUTPUT_QUIET_THRESHOLD_MS,
	isAgentActivelyProducingOutput,
	isAgentOutputQuiet,
	isAgentOutputWithinActiveWindow,
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

describe("isAgentActivelyProducingOutput（前端 Validation 停留判据）", () => {
	it("running 且最近一次输出在 5s 阈值内 → true（仍在持续产出）", () => {
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
		const summary = makeSummary({ state: "awaiting_review", lastOutputAt: NOW });
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
