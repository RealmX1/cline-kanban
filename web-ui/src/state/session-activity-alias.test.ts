// 冒烟测试：验证 web-ui 的 vitest 能把「运行时值」别名 @runtime-session-activity 解析到
// src/core/session-activity.ts（该模块导出在浏览器侧被实际调用，故 vite/vitest/tsconfig 三处
// 都必须有别名——与仅 tsconfig 的类型专用别名如 @runtime-contract 不同）。综合逻辑断言放在
// node 侧 test/runtime/core/session-activity.test.ts，此处只验证别名解析 + 函数可调用。
import { isAgentActivelyProducingOutput, VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS } from "@runtime-session-activity";
import { describe, expect, it } from "vitest";

const NOW = 1_700_000_000_000;

describe("@runtime-session-activity alias resolves in web-ui vitest", () => {
	it("导出常量可读且为预期值", () => {
		expect(VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS).toBe(5_000);
	});

	it("running + 窗口内输出 → true；空闲 → false", () => {
		expect(
			isAgentActivelyProducingOutput(
				{
					taskId: "t",
					state: "running",
					agentId: "claude",
					workspacePath: null,
					pid: null,
					startedAt: null,
					updatedAt: NOW,
					lastOutputAt: NOW - 1_000,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				},
				NOW,
			),
		).toBe(true);
		expect(isAgentActivelyProducingOutput(undefined, NOW)).toBe(false);
	});
});
