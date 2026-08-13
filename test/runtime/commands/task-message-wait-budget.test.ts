import { describe, expect, it } from "vitest";

import { resolveTaskMessageTerminalStatusWaitBudgetMs } from "../../../src/commands/task";

// `kanban task message` 是非 server-style 调用，cli.ts 会给它装 CLI 硬超时（默认 35s），到点
// exit(124) 且 stdout 什么都不输出。--wait-for-terminal-status 的等待必须留在这个预算之内，
// 否则最需要诚实回执的那条路径反而完全没有回执。
describe("--wait-for-terminal-status 的等待预算收敛到 CLI 硬超时之内", () => {
	it("契约建议的 190s 等待被收敛到硬超时余量内，而不是撞上 exit 124", () => {
		expect(
			resolveTaskMessageTerminalStatusWaitBudgetMs({
				requestedWaitTimeoutMs: 190_000,
				cliHardTimeoutMs: 35_000,
				elapsedSinceCliStartMs: 3_000,
			}),
		).toBe(30_000);
	});

	it("默认 30s 等待在慢路径上同样被收敛（已经耗掉 10s 时只剩 23s）", () => {
		expect(
			resolveTaskMessageTerminalStatusWaitBudgetMs({
				requestedWaitTimeoutMs: 30_000,
				cliHardTimeoutMs: 35_000,
				elapsedSinceCliStartMs: 10_000,
			}),
		).toBe(23_000);
	});

	it("请求值小于剩余预算时原样返回，不放大等待", () => {
		expect(
			resolveTaskMessageTerminalStatusWaitBudgetMs({
				requestedWaitTimeoutMs: 5_000,
				cliHardTimeoutMs: 35_000,
				elapsedSinceCliStartMs: 1_000,
			}),
		).toBe(5_000);
	});

	it("预算已耗尽时返回 0：立刻吐出当前真实状态，好过被杀掉后毫无输出", () => {
		expect(
			resolveTaskMessageTerminalStatusWaitBudgetMs({
				requestedWaitTimeoutMs: 30_000,
				cliHardTimeoutMs: 35_000,
				elapsedSinceCliStartMs: 34_500,
			}),
		).toBe(0);
	});

	it("调大 KANBAN_CLI_HARD_TIMEOUT_MS 后能真的等满契约的 190s", () => {
		expect(
			resolveTaskMessageTerminalStatusWaitBudgetMs({
				requestedWaitTimeoutMs: 190_000,
				cliHardTimeoutMs: 200_000,
				elapsedSinceCliStartMs: 3_000,
			}),
		).toBe(190_000);
	});
});
