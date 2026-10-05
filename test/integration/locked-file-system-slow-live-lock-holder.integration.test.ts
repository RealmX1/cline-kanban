import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

// 真实 proper-lockfile（不 mock）：一个**活着但慢**的持有者持锁 7s——高负载下 worktree setup 锁 / index
// 锁的真实形状——等待方用默认重试应当等到它释放，而不是在 ~5s 时抛 ELOCKED。
// 同一场景里并排跑一个显式套用旧重试配置（200×25ms≈5s）的等待方，证明这个场景确实能区分新旧两种配置。
//
// 旧配置的名义预算 5s 只是下界：每次尝试另有开销，高负载下它可能拖到持有者固定 7s 释放之后才耗尽，
// 于是两个等待方都拿到锁、用例失败。所以持有者按事件释放：至少持锁 7s，并且在旧配置等待方 settle 之后
// 再多持 Δ——默认配置若被回退成旧配置，它会和旧配置等待方差不多同时放弃，Δ 保证它放弃时锁仍被持有。
const SLOW_LIVE_LOCK_HOLDER_MINIMUM_HOLD_DURATION_MS = 7_000;
// EXPERIMENT_NODE: 旧配置等待方 settle 后持有者再持锁 Δ=2s vs 更大 Δ；Δ 太小时回退后的默认配置可能与旧配置打平
const SLOW_LIVE_LOCK_HOLDER_EXTRA_HOLD_AFTER_PREVIOUS_SCHEDULE_WAITER_SETTLED_MS = 2_000;
const PREVIOUS_FIVE_SECOND_LOCK_ACQUISITION_RETRY_SCHEDULE = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

type LockWaiterSettlement = { outcome: "acquired"; value: string } | { outcome: "rejected"; error: unknown };

function captureLockWaiterSettlement(lockWaiter: Promise<string>): Promise<LockWaiterSettlement> {
	// 提前捕获拒绝：等待方可能在测试 await 它之前就 reject，不能留下未处理的 rejection。
	return lockWaiter.then(
		(value): LockWaiterSettlement => ({ outcome: "acquired", value }),
		(error: unknown): LockWaiterSettlement => ({ outcome: "rejected", error }),
	);
}

describe("LockedFileSystem with a slow live lock holder", () => {
	it("keeps waiting past five seconds with the default schedule, where the previous schedule gave up", async () => {
		const tempDir = createTempDir("kanban-locked-fs-slow-holder-");
		let releaseSlowHolder: () => void = () => {};
		let slowHolder: Promise<void> = Promise.resolve();
		const pendingLockWaiterSettlements: Promise<LockWaiterSettlement>[] = [];
		try {
			const lockedFilePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			let markSlowHolderAcquired: () => void = () => {};
			const slowHolderAcquired = new Promise<void>((resolve) => {
				markSlowHolderAcquired = resolve;
			});
			slowHolder = lockedFileSystem.withLock({ path: lockedFilePath, type: "file" }, async () => {
				markSlowHolderAcquired();
				await new Promise<void>((resolve) => {
					releaseSlowHolder = resolve;
				});
			});
			await slowHolderAcquired;
			const slowHolderAcquiredAtMs = performance.now();

			const lockEventOrder: string[] = [];
			const previousScheduleWaiterSettlement = captureLockWaiterSettlement(
				lockedFileSystem.withLock(
					{ path: lockedFilePath, type: "file", retries: PREVIOUS_FIVE_SECOND_LOCK_ACQUISITION_RETRY_SCHEDULE },
					async () => "acquired",
				),
			).finally(() => {
				lockEventOrder.push("previous_schedule_waiter_settled");
			});
			const defaultScheduleWaiterSettlement = captureLockWaiterSettlement(
				lockedFileSystem.withLock({ path: lockedFilePath, type: "file" }, async () => {
					lockEventOrder.push("default_schedule_waiter_acquired");
					return "acquired";
				}),
			);
			pendingLockWaiterSettlements.push(previousScheduleWaiterSettlement, defaultScheduleWaiterSettlement);

			const previousScheduleWaiterOutcome = await previousScheduleWaiterSettlement;
			const previousScheduleWaiterSettledAfterHolderAcquiredMs = performance.now() - slowHolderAcquiredAtMs;
			await new Promise<void>((resolveHold) => {
				setTimeout(
					resolveHold,
					Math.max(
						SLOW_LIVE_LOCK_HOLDER_MINIMUM_HOLD_DURATION_MS - previousScheduleWaiterSettledAfterHolderAcquiredMs,
						SLOW_LIVE_LOCK_HOLDER_EXTRA_HOLD_AFTER_PREVIOUS_SCHEDULE_WAITER_SETTLED_MS,
					),
				);
			});
			releaseSlowHolder();
			await slowHolder;
			const defaultScheduleWaiterOutcome = await defaultScheduleWaiterSettlement;

			expect(previousScheduleWaiterOutcome).toMatchObject({ outcome: "rejected", error: { code: "ELOCKED" } });
			// 有区分力的断言：默认配置的等待方撑过了旧配置放弃之后的 Δ，最终拿到锁。
			expect(defaultScheduleWaiterOutcome).toEqual({ outcome: "acquired", value: "acquired" });
			expect(lockEventOrder).toEqual(["previous_schedule_waiter_settled", "default_schedule_waiter_acquired"]);
		} finally {
			// 断言或等待中途失败时兜底：先释放持有者并等它结束，再等两个等待方收尾，最后删临时目录。
			releaseSlowHolder();
			await slowHolder.catch(() => undefined);
			await Promise.all(pendingLockWaiterSettlements);
			tempDir.cleanup();
		}
	}, 60_000);
});
