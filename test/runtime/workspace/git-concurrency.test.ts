import { describe, expect, it } from "vitest";

import { gitFileReadConcurrencyLimiter } from "../../../src/workspace/git-concurrency";

// 直接验证「共享并发上限」这一核心机制：无论一次排入多少任务，同时运行的都不超过上限（12）。
// 这正是把 workspace diff 的无界 per-file fan-out 钳制成常数、从而不再拖垮事件循环的根本保证。
describe("gitFileReadConcurrencyLimiter", () => {
	it("never runs more than its concurrency limit of tasks at once", async () => {
		const EXPECTED_CONCURRENCY_LIMIT = 12;
		const TASK_COUNT = 40;

		let activeCount = 0;
		let peakConcurrency = 0;
		let completedCount = 0;

		const tasks = Array.from({ length: TASK_COUNT }, () =>
			gitFileReadConcurrencyLimiter(async () => {
				activeCount += 1;
				peakConcurrency = Math.max(peakConcurrency, activeCount);
				// 让出事件循环，使被 limiter 放行的任务能够真正重叠运行，从而暴露真实并发峰值。
				await new Promise((resolve) => setTimeout(resolve, 5));
				activeCount -= 1;
				completedCount += 1;
			}),
		);

		await Promise.all(tasks);

		expect(completedCount).toBe(TASK_COUNT);
		expect(peakConcurrency).toBeLessThanOrEqual(EXPECTED_CONCURRENCY_LIMIT);
		// 任务数远大于上限，故并发必然打满到上限——若为 1 则说明限流退化成串行（也是一种回归）。
		expect(peakConcurrency).toBe(EXPECTED_CONCURRENCY_LIMIT);
	});
});
