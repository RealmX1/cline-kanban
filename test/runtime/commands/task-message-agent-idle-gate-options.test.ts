import { describe, expect, it } from "vitest";

import { resolveTaskMessageAgentIdleGateOptions } from "../../../src/commands/task";

// `kanban task message --deliver-when-agent-idle --max-wait-for-agent-idle-ms <ms>`：两个 flag 必须成对出现，
// 等多久没有默认值（那是调用方的策略），上限 24h。跨仓契约：terminal-delivery-interface-contract.md
// § agent 空闲门控的排队投递。
const UPPER_BOUND_MS = 86_400_000;

describe("--deliver-when-agent-idle 的参数配对", () => {
	it("两个都不给 ⇒ 立即投递（null），行为一字不变", () => {
		expect(
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: false,
				maxWaitForAgentIdleMs: undefined,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toBeNull();
	});

	it("成对给出 ⇒ 带上等待上限", () => {
		expect(
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: true,
				maxWaitForAgentIdleMs: 600_000,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toEqual({ maxWaitForAgentIdleMs: 600_000 });
	});

	it("只给 --deliver-when-agent-idle ⇒ 报错（不替调用方猜一个默认上限）", () => {
		expect(() =>
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: true,
				maxWaitForAgentIdleMs: undefined,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toThrow("--deliver-when-agent-idle requires --max-wait-for-agent-idle-ms.");
	});

	it("只给 --max-wait-for-agent-idle-ms ⇒ 报错（单给它没有任何意义，多半是漏了 flag）", () => {
		expect(() =>
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: false,
				maxWaitForAgentIdleMs: 600_000,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toThrow("--max-wait-for-agent-idle-ms requires --deliver-when-agent-idle.");
	});

	it("超过 24h ⇒ 报错；恰好 24h 可以", () => {
		expect(() =>
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: true,
				maxWaitForAgentIdleMs: UPPER_BOUND_MS + 1,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toThrow("must not exceed 86400000");
		expect(
			resolveTaskMessageAgentIdleGateOptions({
				deliverWhenAgentIdle: true,
				maxWaitForAgentIdleMs: UPPER_BOUND_MS,
				maxWaitForAgentIdleUpperBoundMs: UPPER_BOUND_MS,
			}),
		).toEqual({ maxWaitForAgentIdleMs: UPPER_BOUND_MS });
	});
});
