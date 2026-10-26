import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { buildDailyWorkProgressSummary } from "../../src/daily-work-progress-statistics/daily-work-progress-statistics-projection";
import {
	createEmptyDailyWorkProgressStatisticsStore,
	readDailyWorkProgressStatisticsStore,
} from "../../src/daily-work-progress-statistics/daily-work-progress-statistics-store";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit());
it("多个独立进程持锁重读统计文件，同一庆祝只领取一次", { timeout: 50_000 }, async (context) => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	try {
		const storageFilePath = join(fixture.isolatedHomeDirectoryPath, "statistics.json");
		const timestamp = Date.parse("2026-10-20T12:00:00Z");
		const state = createEmptyDailyWorkProgressStatisticsStore(timestamp);
		state.factsByEventId.done = {
			eventId: "done",
			metric: "entered_done",
			workspaceId: "project",
			taskId: "task",
			taskIncarnationCreatedAtEpochMs: timestamp - 1,
			taskTitle: "跨进程领取",
			occurredAtEpochMs: timestamp,
		};
		const request = { workspaceId: null, dateKey: "2026-10-20", timeZone: "UTC" };
		const summary = buildDailyWorkProgressSummary({
			facts: Object.values(state.factsByEventId),
			coverage: [],
			projects: [{ workspaceId: "project", projectName: "隔离项目" }],
			request,
			revision: 0,
		});
		expect(summary.achievements.length).toBeGreaterThan(0);
		for (const achievement of summary.achievements)
			state.eligibleAchievementIds[achievement.achievementId] = Date.now();
		await writeFile(storageFilePath, JSON.stringify(state));
		const claim = {
			...request,
			achievementIds: summary.achievements.map((achievement) => achievement.achievementId),
		};
		const results = await Promise.all(
			Array.from({ length: 3 }, async () => {
				const child = childProcesses.register(
					spawn(
						process.execPath,
						[
							"--import",
							"tsx",
							fileURLToPath(
								new URL("./fixtures/daily-work-progress-celebration-claim-child.ts", import.meta.url),
							),
							storageFilePath,
							JSON.stringify(claim),
						],
						{
							cwd: process.cwd(),
							env: fixture.createIsolatedChildProcessEnvironment({
								KANBAN_DAILY_WORK_PROGRESS_COST_RECORDING_DISABLED: "1",
							}),
							stdio: ["ignore", "pipe", "pipe"],
						},
					),
				);
				let output = "";
				let errors = "";
				child.stdout?.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr?.on("data", (chunk) => {
					errors += String(chunk);
				});
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, child, {
					waitedForDescription: "独立庆祝领取进程退出",
					softDeadlineMsExpectedOnUncontendedHost: 8_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 40_000,
				});
				expect(child.exitCode, errors).toBe(0);
				return JSON.parse(output) as { achievements: { achievementId: string }[] };
			}),
		);
		expect(results.flatMap((result) => result.achievements)).toHaveLength(summary.achievements.length);
		expect(
			Object.keys((await readDailyWorkProgressStatisticsStore(storageFilePath)).claimedAchievementIds),
		).toHaveLength(summary.achievements.length);
	} finally {
		await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
		fixture.cleanup();
	}
});
