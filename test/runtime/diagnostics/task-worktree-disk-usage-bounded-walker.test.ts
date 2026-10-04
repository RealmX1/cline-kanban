import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { measureTaskWorktreeDiskUsageWithinTimeBudget } from "../../../src/diagnostics/task-worktree-disk-usage-bounded-walker";
import { createTaskWorktreeDiskUsageMeasurementMonitor } from "../../../src/diagnostics/task-worktree-disk-usage-measurement-monitor";
import { createTempDir } from "../../utilities/temp-dir";

describe("measureTaskWorktreeDiskUsageWithinTimeBudget", () => {
	let worktree: { path: string; cleanup: () => void };
	let sharedDependencies: { path: string; cleanup: () => void };

	beforeEach(() => {
		worktree = createTempDir("kanban-worktree-disk-usage-");
		sharedDependencies = createTempDir("kanban-shared-node-modules-");
	});

	afterEach(() => {
		worktree.cleanup();
		sharedDependencies.cleanup();
	});

	it("breaks the total down by top-level entry and never follows the symlinked node_modules", async () => {
		mkdirSync(join(worktree.path, "dist", "assets"), { recursive: true });
		writeFileSync(join(worktree.path, "dist", "assets", "bundle.js"), "x".repeat(200_000));
		mkdirSync(join(worktree.path, "src"));
		writeFileSync(join(worktree.path, "src", "index.ts"), "x".repeat(10_000));
		writeFileSync(join(sharedDependencies.path, "huge.bin"), "x".repeat(2_000_000));
		symlinkSync(sharedDependencies.path, join(worktree.path, "node_modules"));

		const measurement = await measureTaskWorktreeDiskUsageWithinTimeBudget({
			worktreePath: worktree.path,
			timeBudgetMs: 10_000,
		});

		expect(measurement.skippedSymbolicLinkCount).toBe(1);
		expect(measurement.totalFileCount).toBe(2);
		expect(measurement.largestTopLevelEntries.map((entry) => entry.entryName)).toEqual(["dist", "src"]);
		expect(measurement.worktreeTotalBytes).toBeGreaterThanOrEqual(210_000);
		expect(measurement.worktreeTotalBytes).toBeLessThan(2_000_000);
		expect(measurement.measurementWasCutShortByTimeBudget).toBe(false);
	});

	it("stops at the time budget and marks the result as a lower bound", async () => {
		mkdirSync(join(worktree.path, "a", "b"), { recursive: true });
		let clock = 0;

		const measurement = await measureTaskWorktreeDiskUsageWithinTimeBudget({
			worktreePath: worktree.path,
			timeBudgetMs: 5,
			now: () => {
				clock += 10;
				return clock;
			},
		});

		expect(measurement.measurementWasCutShortByTimeBudget).toBe(true);
	});

	// 每次 lstat 让模拟时钟走 1 秒：预算 5 秒 ⇒ 第 6 次 lstat 之后就该停。
	function createLstatThatAdvancesSimulatedClock() {
		const simulatedClock = { epochMs: 0, lstatCallCount: 0 };
		return {
			simulatedClock,
			now: () => simulatedClock.epochMs,
			readEntryStatsWithoutFollowingSymbolicLinks: async (entryPath: string) => {
				simulatedClock.lstatCallCount += 1;
				simulatedClock.epochMs += 1_000;
				return await lstat(entryPath);
			},
		};
	}

	it("checks the time budget between entries of one huge flat directory instead of only after it finishes", async () => {
		for (let fileIndex = 0; fileIndex < 60; fileIndex += 1) {
			writeFileSync(join(worktree.path, `flat-file-${fileIndex}.txt`), "x");
		}
		const { simulatedClock, now, readEntryStatsWithoutFollowingSymbolicLinks } =
			createLstatThatAdvancesSimulatedClock();

		const measurement = await measureTaskWorktreeDiskUsageWithinTimeBudget({
			worktreePath: worktree.path,
			timeBudgetMs: 5_000,
			now,
			readEntryStatsWithoutFollowingSymbolicLinks,
		});

		expect(measurement.measurementWasCutShortByTimeBudget).toBe(true);
		expect(simulatedClock.lstatCallCount).toBe(6);
		expect(measurement.totalFileCount).toBe(6);
	});

	it("stops in-flight directory reads from issuing further lstat calls once the time budget is exhausted", async () => {
		for (const flatDirectoryName of ["flat-a", "flat-b", "flat-c"]) {
			mkdirSync(join(worktree.path, flatDirectoryName));
			for (let fileIndex = 0; fileIndex < 40; fileIndex += 1) {
				writeFileSync(join(worktree.path, flatDirectoryName, `file-${fileIndex}.txt`), "x");
			}
		}
		const { simulatedClock, now, readEntryStatsWithoutFollowingSymbolicLinks } =
			createLstatThatAdvancesSimulatedClock();

		const measurement = await measureTaskWorktreeDiskUsageWithinTimeBudget({
			worktreePath: worktree.path,
			timeBudgetMs: 5_000,
			now,
			readEntryStatsWithoutFollowingSymbolicLinks,
		});
		const lstatCallCountWhenMeasurementReturned = simulatedClock.lstatCallCount;
		// 给仍在途的目录读取足够的时间：修复前它们会在返回之后把剩下的 lstat 全部做完。
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(measurement.measurementWasCutShortByTimeBudget).toBe(true);
		// 第 6 次 lstat 越过预算；三个在途目录各自最多再完成手上那一次。
		expect(lstatCallCountWhenMeasurementReturned).toBeLessThanOrEqual(6 + 3);
		expect(simulatedClock.lstatCallCount).toBe(lstatCallCountWhenMeasurementReturned);
	});
});

describe("createTaskWorktreeDiskUsageMeasurementMonitor", () => {
	it("measures an active Kanban worktree once per day and skips inplace and long-idle directories", async () => {
		const worktree = createTempDir("kanban-worktree-disk-usage-monitor-");
		const now = 1_790_000_000_000;
		const measure = vi.fn(async () => ({
			worktreeTotalBytes: 1,
			totalFileCount: 1,
			skippedSymbolicLinkCount: 0,
			largestTopLevelEntries: [],
			measurementWasCutShortByTimeBudget: false,
			measurementDurationMs: 1,
		}));
		const appendJournalEvent = vi.fn();
		const monitor = createTaskWorktreeDiskUsageMeasurementMonitor({
			listTaskWorkingDirectoryAttributions: () => [
				{
					workspaceId: "repo",
					workingDirectoryPath: worktree.path,
					attributedTaskCardId: "ab12c",
					latestSessionUpdatedAtEpochMs: now,
				},
				{
					workspaceId: "repo",
					workingDirectoryPath: "/Users/u/repo",
					attributedTaskCardId: "cd34e",
					latestSessionUpdatedAtEpochMs: now,
				},
				{
					workspaceId: "repo",
					workingDirectoryPath: `${worktree.path}-old`,
					attributedTaskCardId: "ef56g",
					latestSessionUpdatedAtEpochMs: now - 30 * 86_400_000,
				},
			],
			isKanbanManagedTaskWorktreePath: (path) => path.startsWith(worktree.path),
			measure,
			now: () => now,
			appendJournalEvent,
		});

		await monitor.runCheck();
		await monitor.runCheck();

		expect(measure).toHaveBeenCalledTimes(1);
		expect(appendJournalEvent).toHaveBeenCalledWith(
			"task-worktree-disk-usage-measurement",
			expect.objectContaining({ attributedTaskCardId: "ab12c", worktreePath: worktree.path, worktreeTotalBytes: 1 }),
		);
		worktree.cleanup();
	});
});
