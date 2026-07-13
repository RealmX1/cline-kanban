// 应用内通知中心后端：store（append 幂等 / 300 上限丢最旧 / mark 整组 / 并发串行 / readAll 聚合）、
// feed-builder（isDone 随 board 派生 / taskTitle / repoName / 缺失回退）、以及「无客户端也落库」的核心卖点。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import { buildNotificationFeedEntries } from "../../src/state/notification-feed-builder";
import {
	appendNotificationLogEntry,
	clearNotificationLog,
	markTaskNotificationsVisited,
	readAllNotificationLogs,
	readNotificationLog,
} from "../../src/state/notification-log-store";
import {
	getWorkspacesRootPath,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-notif-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

async function registerWorkspace(sandboxRoot: string, name: string): Promise<{ workspaceId: string; path: string }> {
	const workspacePath = join(sandboxRoot, name);
	mkdirSync(workspacePath, { recursive: true });
	initGitRepository(workspacePath);
	await loadWorkspaceState(workspacePath);
	const context = await loadWorkspaceContext(workspacePath);
	return { workspaceId: context.workspaceId, path: workspacePath };
}

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
		dependencies: [],
	};
}

describe.sequential("notification-log-store integration", () => {
	it("append 幂等、300 上限丢最旧", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const { workspaceId } = await registerWorkspace(sandboxRoot, "project-a");

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
				expect(entries).toHaveLength(300);
				// 最旧的 task-1:1000 与最早几条 bulk 已被丢弃；最新的仍在。
				expect(entries.some((entry) => entry.id === "task-1:1000")).toBe(false);
				expect(entries.some((entry) => entry.id === "task-bulk-304:2304")).toBe(true);
			} finally {
				cleanup();
			}
		});
	});

	it("markTaskNotificationsVisited 整组置位、不碰其它 task", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const { workspaceId } = await registerWorkspace(sandboxRoot, "project-a");
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
			} finally {
				cleanup();
			}
		});
	});

	it("并发 append 串行不丢", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const { workspaceId } = await registerWorkspace(sandboxRoot, "project-a");
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
			} finally {
				cleanup();
			}
		});
	});

	it("readAllNotificationLogs 聚合多 workspace", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const first = await registerWorkspace(sandboxRoot, "project-a");
				const second = await registerWorkspace(sandboxRoot, "project-b");
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
				const emptyRegistered = await registerWorkspace(sandboxRoot, "project-c");
				const allAfter = await readAllNotificationLogs();
				expect(allAfter[emptyRegistered.workspaceId]).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	});

	it("feed-builder 派生 isDone / taskTitle / repoName，缺失 task 回退", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const { workspaceId, path: workspacePath } = await registerWorkspace(sandboxRoot, "project-a");
				const initial = await loadWorkspaceState(workspacePath);
				await saveWorkspaceState(workspacePath, {
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

				const entries = await readNotificationLog(workspaceId);
				const feed = await buildNotificationFeedEntries(workspaceId, entries);
				const byTaskId = new Map(feed.map((entry) => [entry.taskId, entry]));

				expect(byTaskId.get("task-active")?.isDone).toBe(false);
				expect(byTaskId.get("task-active")?.taskTitle).toBe("Active task title");
				expect(byTaskId.get("task-active")?.repoName).toBe("project-a");
				expect(byTaskId.get("task-done")?.isDone).toBe(true);
				expect(byTaskId.get("task-missing")?.taskTitle).toBe("Task task-missing");
				expect(byTaskId.get("task-missing")?.isDone).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("无客户端连接也落库（核心卖点：浏览器全关时段的后台事件也记录）", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-notif-");
			try {
				const { workspaceId } = await registerWorkspace(sandboxRoot, "project-a");
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
					// broadcastTaskReadyForReview 内是 fire-and-forget 落库，轮询等它落盘。
					let entries = await readNotificationLog(workspaceId);
					for (let attempt = 0; attempt < 50 && entries.length === 0; attempt += 1) {
						await new Promise((resolve) => setTimeout(resolve, 10));
						entries = await readNotificationLog(workspaceId);
					}
					expect(entries).toHaveLength(1);
					expect(entries[0]?.taskId).toBe("task-x");
					expect(entries[0]?.userTurnKind).toBe("review");
				} finally {
					await hub.close();
				}
			} finally {
				cleanup();
			}
		});
	});

	it("拒绝逃逸 workspaces 根的 workspaceId（防路径遍历）", async () => {
		await withTemporaryHome(async () => {
			const { cleanup } = createTempDir("kanban-notif-");
			try {
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
			} finally {
				cleanup();
			}
		});
	});
});
