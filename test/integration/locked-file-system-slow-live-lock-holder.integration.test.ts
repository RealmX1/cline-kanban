import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

// 真实 proper-lockfile（不 mock）：一个**活着但慢**的持有者持锁 7s——高负载下 worktree setup 锁 / index
// 锁的真实形状——等待方用默认重试应当等到它释放，而不是在 ~5s 时抛 ELOCKED。
// 同一场景里并排跑一个显式套用旧重试配置（200×25ms≈5s）的等待方，证明这个场景确实能区分新旧两种配置。
const SLOW_LIVE_LOCK_HOLDER_HOLD_DURATION_MS = 7_000;
const PREVIOUS_FIVE_SECOND_LOCK_ACQUISITION_RETRY_SCHEDULE = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

describe("LockedFileSystem with a slow live lock holder", () => {
	it("keeps waiting past five seconds with the default schedule, where the previous schedule gave up", async () => {
		const tempDir = createTempDir("kanban-locked-fs-slow-holder-");
		try {
			const lockedFilePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			let releaseSlowHolder: () => void = () => {};
			let markSlowHolderAcquired: () => void = () => {};
			const slowHolderAcquired = new Promise<void>((resolve) => {
				markSlowHolderAcquired = resolve;
			});
			const slowHolder = lockedFileSystem.withLock({ path: lockedFilePath, type: "file" }, async () => {
				markSlowHolderAcquired();
				await new Promise<void>((resolve) => {
					releaseSlowHolder = resolve;
				});
			});
			await slowHolderAcquired;
			const slowHolderReleaseTimer = setTimeout(() => releaseSlowHolder(), SLOW_LIVE_LOCK_HOLDER_HOLD_DURATION_MS);

			const waiterUsingPreviousSchedule = lockedFileSystem.withLock(
				{ path: lockedFilePath, type: "file", retries: PREVIOUS_FIVE_SECOND_LOCK_ACQUISITION_RETRY_SCHEDULE },
				async () => "acquired",
			);
			const waiterUsingDefaultSchedule = lockedFileSystem.withLock(
				{ path: lockedFilePath, type: "file" },
				async () => "acquired",
			);

			await expect(waiterUsingPreviousSchedule).rejects.toMatchObject({ code: "ELOCKED" });
			await expect(waiterUsingDefaultSchedule).resolves.toBe("acquired");
			await slowHolder;
			clearTimeout(slowHolderReleaseTimer);
		} finally {
			tempDir.cleanup();
		}
	}, 30_000);
});
