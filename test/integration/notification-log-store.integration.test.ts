// 应用内通知中心后端：store（append 幂等 / 超过 300 条永久保留 / mark 整组 / 并发串行 / readAll 聚合）、
// feed-builder（isDone 随 board 派生 / taskTitle / repoName / 缺失回退）、以及「无客户端也落库」的核心卖点。
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import * as notificationDiagnosticLogger from "../../src/diagnostics/agent-session-retention-logger";
import {
	closeDefaultNotificationLifecycleArchive,
	getNotificationLifecycleArchive,
} from "../../src/notifications/notification-lifecycle-archive";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import { buildNotificationFeedEntries } from "../../src/state/notification-feed-builder";
import {
	appendNotificationLogEntry,
	clearNotificationLog,
	markTaskNotificationsVisited,
	notificationCandidateToPersistedEntry,
	readAllNotificationLogs,
	readNotificationLog,
} from "../../src/state/notification-log-store";
import { getWorkspacesRootPath, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import {
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const FIRE_AND_FORGET_NOTIFICATION_LOG_PERSISTENCE_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "无客户端时 broadcastTaskReadyForReview 的 fire-and-forget 通知落盘",
	softDeadlineMsExpectedOnUncontendedHost: 500,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10_000,
};

import { withIsolatedWorkspaceHome as withIsolatedNotificationLogWorkspaces } from "./isolated-workspace-home-fixture";

function boardWith(cards: { columnId: "review" | "trash"; id: string; title: string }[]): RuntimeBoardData {
	const columnCards = (columnId: "review" | "trash") =>
		cards
			.filter((card) => card.columnId === columnId)
			.map((card) => ({
				id: card.id,
				title: card.title,
				prompt: card.title,
				startInPlanMode: false,
				baseRef: "main",
				createdAt: 1,
				updatedAt: 1,
			}));
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: columnCards("review") },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: columnCards("trash") },
		],
	};
}

describe.sequential("notification-log-store integration", () => {
	it.each(["{broken", '[{"id":"missing-required-fields"}]'])(
		"已迁移的旧文件损坏不影响重启后的档案操作：%s",
		async (corruptedLegacyContents) => {
			await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
				const { workspaceId } = await registerIsolatedWorkspace("migrated-project");
				const sourcePath = join(getWorkspacesRootPath(), workspaceId, "notifications.json");
				// 直接种入持久导入标记，模拟重启后兼容层没有内存缓存。
				await getNotificationLifecycleArchive().importLegacy(sourcePath, [
					{
						candidateId: `${workspaceId}:old:1`,
						workspaceId,
						taskId: "old",
						triggeredAt: 1,
						userTurnKind: "review",
						sourceKind: "legacy_imported",
						notificationPanelVisibility: "visible",
					},
				]);
				await closeDefaultNotificationLifecycleArchive();
				await mkdir(dirname(sourcePath), { recursive: true });
				await writeFile(sourcePath, corruptedLegacyContents);
				const diagnostic = vi.spyOn(notificationDiagnosticLogger, "logAgentSessionRetentionWarning");
				try {
					expect(await readNotificationLog(workspaceId)).toHaveLength(1);
					await markTaskNotificationsVisited(workspaceId, "old", 99);
					expect((await readNotificationLog(workspaceId))[0]?.visitedAt).toBe(99);
					await clearNotificationLog(workspaceId);
					expect(await readNotificationLog(workspaceId)).toEqual([]);
					expect((await getNotificationLifecycleArchive().list({ workspaceId })).totalCount).toBe(1);
					expect(await readFile(sourcePath, "utf8")).toBe(corruptedLegacyContents);
					expect(diagnostic).not.toHaveBeenCalled();
				} finally {
					diagnostic.mockRestore();
					await closeDefaultNotificationLifecycleArchive();
				}
			});
		},
	);

	it.each(["{broken", '[{"id":"missing-required-fields"}]'])(
		"未迁移的损坏旧文件可诊断并可重试，不阻断其它工作区：%s",
		async (corruptedLegacyContents) => {
			await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
				const first = await registerIsolatedWorkspace("corrupted-project");
				const second = await registerIsolatedWorkspace("healthy-project");
				const sourcePath = join(getWorkspacesRootPath(), first.workspaceId, "notifications.json");
				await mkdir(dirname(sourcePath), { recursive: true });
				await writeFile(sourcePath, corruptedLegacyContents);
				const diagnostic = vi.spyOn(notificationDiagnosticLogger, "logAgentSessionRetentionWarning");
				try {
					await appendNotificationLogEntry(first.workspaceId, {
						taskId: "new",
						triggeredAt: 2,
						userTurnKind: "review",
					});
					await appendNotificationLogEntry(second.workspaceId, {
						taskId: "healthy",
						triggeredAt: 3,
						userTurnKind: "review",
					});
					const all = await readAllNotificationLogs();
					expect(all[first.workspaceId]).toHaveLength(1);
					expect(all[second.workspaceId]).toHaveLength(1);
					await markTaskNotificationsVisited(first.workspaceId, "new", 99);
					expect((await readNotificationLog(first.workspaceId))[0]?.visitedAt).toBe(99);
					await clearNotificationLog(first.workspaceId);
					expect(await readNotificationLog(first.workspaceId)).toEqual([]);
					expect(await readFile(sourcePath, "utf8")).toBe(corruptedLegacyContents);
					expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(sourcePath));
					expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("notification-legacy-import-failed"));
					// 失败不写成功标记，修复原文件后下次访问仍会导入。
					await writeFile(
						sourcePath,
						JSON.stringify([
							{ id: "old:1", taskId: "old", triggeredAt: 1, userTurnKind: "review", visitedAt: null },
						]),
					);
					expect((await readNotificationLog(first.workspaceId)).map((entry) => entry.taskId)).toEqual(["old"]);
					expect(
						(await getNotificationLifecycleArchive().list({ workspaceId: first.workspaceId })).totalCount,
					).toBe(2);
				} finally {
					diagnostic.mockRestore();
					await closeDefaultNotificationLifecycleArchive();
				}
			});
		},
	);

	it("append 幂等、超过 300 条永久保留", async () => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");

			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-1",
				userTurnKind: "review",
				triggeredAt: 1000,
			});
			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-1",
				userTurnKind: "review",
				triggeredAt: 1000,
			});
			let entries = await readNotificationLog(workspaceId);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.id).toBe("task-1:1000");
			expect(entries[0]?.visitedAt).toBeNull();

			// 追加 305 条（含首条共 306），上限 300、丢最旧。
			for (let index = 0; index < 305; index += 1) {
				await appendNotificationLogEntry(workspaceId, {
					taskId: `task-bulk-${index}`,
					userTurnKind: "review",
					triggeredAt: 2000 + index,
				});
			}
			entries = await readNotificationLog(workspaceId);
			expect(entries).toHaveLength(306);
			// 最旧的 task-1:1000 与最早几条 bulk 已被丢弃；最新的仍在。
			expect(entries.some((entry) => entry.id === "task-1:1000")).toBe(true);
			expect(entries.some((entry) => entry.id === "task-bulk-304:2304")).toBe(true);
		});
	});

	it("markTaskNotificationsVisited 整组置位、不碰其它 task", async () => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await appendNotificationLogEntry(workspaceId, { taskId: "task-a", userTurnKind: "review", triggeredAt: 1 });
			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-a",
				userTurnKind: "question",
				triggeredAt: 2,
			});
			await appendNotificationLogEntry(workspaceId, { taskId: "task-a", userTurnKind: "review", triggeredAt: 3 });
			await appendNotificationLogEntry(workspaceId, { taskId: "task-b", userTurnKind: "review", triggeredAt: 4 });

			await markTaskNotificationsVisited(workspaceId, "task-a", 9000);
			const entries = await readNotificationLog(workspaceId);
			const taskAEntries = entries.filter((entry) => entry.taskId === "task-a");
			const taskBEntry = entries.find((entry) => entry.taskId === "task-b");
			expect(taskAEntries.every((entry) => entry.visitedAt === 9000)).toBe(true);
			expect(taskBEntry?.visitedAt).toBeNull();
		});
	});

	it("并发 append 串行不丢", async () => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			await Promise.all(
				Array.from({ length: 50 }, (_unused, index) =>
					appendNotificationLogEntry(workspaceId, {
						taskId: `task-${index}`,
						userTurnKind: "review",
						triggeredAt: 5000 + index,
					}),
				),
			);
			const entries = await readNotificationLog(workspaceId);
			expect(entries).toHaveLength(50);
		});
	});

	it("readAllNotificationLogs 聚合多 workspace", async () => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const first = await registerIsolatedWorkspace("project-a");
			const second = await registerIsolatedWorkspace("project-b");
			await appendNotificationLogEntry(first.workspaceId, {
				taskId: "t1",
				userTurnKind: "review",
				triggeredAt: 1,
			});
			await appendNotificationLogEntry(first.workspaceId, {
				taskId: "t2",
				userTurnKind: "review",
				triggeredAt: 2,
			});
			await appendNotificationLogEntry(second.workspaceId, {
				taskId: "t3",
				userTurnKind: "error",
				triggeredAt: 3,
			});

			const all = await readAllNotificationLogs();
			expect(all[first.workspaceId]).toHaveLength(2);
			expect(all[second.workspaceId]).toHaveLength(1);
			// 无通知的 workspace 不出现在聚合里。
			const emptyRegistered = await registerIsolatedWorkspace("project-c");
			const allAfter = await readAllNotificationLogs();
			expect(allAfter[emptyRegistered.workspaceId]).toBeUndefined();
		});
	});

	it("feed-builder 派生 isDone / taskTitle / repoName，缺失 task 回退", async () => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const { workspaceId, path: workspacePath } = await registerIsolatedWorkspace("project-a");
			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: boardWith([
					{ columnId: "review", id: "task-active", title: "Active task title" },
					{ columnId: "trash", id: "task-done", title: "Done task title" },
				]),
				sessions: {},
				expectedRevision: initial.revision,
			});

			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-active",
				userTurnKind: "review",
				triggeredAt: 1,
			});
			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-done",
				userTurnKind: "review",
				triggeredAt: 2,
			});
			await appendNotificationLogEntry(workspaceId, {
				taskId: "task-missing",
				userTurnKind: "review",
				triggeredAt: 3,
			});

			const entries = (await getNotificationLifecycleArchive().list({ workspaceId })).entries.map(
				notificationCandidateToPersistedEntry,
			);
			const feed = await buildNotificationFeedEntries(workspaceId, entries);
			const byTaskId = new Map(feed.map((entry) => [entry.taskId, entry]));

			expect(byTaskId.get("task-active")?.isDone).toBe(false);
			expect(byTaskId.get("task-active")?.taskTitle).toBe("Active task title");
			expect(byTaskId.get("task-active")?.repoName).toBe("project-a");
			expect(byTaskId.get("task-done")?.isDone).toBe(true);
			expect(byTaskId.get("task-missing")?.taskTitle).toBe("Task task-missing");
			expect(byTaskId.get("task-missing")?.isDone).toBe(false);
		});
	});

	it("无客户端连接也落库（核心卖点：浏览器全关时段的后台事件也记录）", async (testContext) => {
		await withIsolatedNotificationLogWorkspaces(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			const hub = createRuntimeStateHub({
				workspaceRegistry: {
					resolveWorkspaceForStream: async () => {
						throw new Error("not used in this test");
					},
					buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => ({
						currentProjectId: null,
						projects: [],
					}),
					buildWorkspaceStateSnapshot: async () => {
						throw new Error("not used in this test");
					},
				},
			});
			try {
				// 0 客户端连接：广播的一次性 OS 事件会被丢弃，但持久化必须发生。
				hub.broadcastTaskReadyForReview(workspaceId, "task-x", "review");
				// broadcastTaskReadyForReview 内是 fire-and-forget 落库，两档轮询等它落盘：原先只轮询 50×10ms，
				// 负载下落盘还没完成就判失败。
				let entries = await readNotificationLog(workspaceId);
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					FIRE_AND_FORGET_NOTIFICATION_LOG_PERSISTENCE_TWO_TIER_DEADLINE,
					async () => {
						entries = await readNotificationLog(workspaceId);
						return entries.length > 0;
					},
					{ pollIntervalMs: 10 },
				);
				expect(entries).toHaveLength(1);
				expect(entries[0]?.taskId).toBe("task-x");
				expect(entries[0]?.userTurnKind).toBe("review");
			} finally {
				await hub.close();
			}
		});
	});

	it("拒绝逃逸 workspaces 根的 workspaceId（防路径遍历）", async () => {
		await withIsolatedNotificationLogWorkspaces(async () => {
			// clearNotificationLog 会创建目录并写 []；"../" 逃逸的 workspaceId 必须被拒绝，且不在根外留下文件。
			const escapeTarget = join(getWorkspacesRootPath(), "..", "notif-escape-probe", "notifications.json");
			await expect(clearNotificationLog("../notif-escape-probe")).rejects.toThrow(/outside workspaces root/);
			await expect(markTaskNotificationsVisited("../notif-escape-probe", "t", 1)).rejects.toThrow(
				/outside workspaces root/,
			);
			await expect(
				appendNotificationLogEntry("../notif-escape-probe", {
					taskId: "t",
					userTurnKind: "review",
					triggeredAt: 1,
				}),
			).rejects.toThrow(/outside workspaces root/);
			expect(existsSync(escapeTarget)).toBe(false);
		});
	});
});
