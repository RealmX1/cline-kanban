// 「用户最近一次打开某任务」的时刻账本：每个 workspace 一个 task-last-opened-by-user-records.json
// （与 board.json / notifications.json 同级），内容是 { [taskId]: epoch ms }。
//
// 为什么记在服务端而不是浏览器 localStorage：同一个 runtime 会经 127.0.0.1 / localhost / Tailscale 3485
// 三个 origin 被打开，localStorage 各存各的；跨项目切换面板（docs/context-cross-project-recently-active-task-switcher.md）
// 要的是「我在任何一个窗口里最近碰过哪些任务」。记录时机与通知中心「打开即已读」相同：前端选中任务时调一次。
//
// 为什么不并进 board.json：打开任务是高频、非用户意图的观测，写进 board 会推进 revision、触发全量广播，
// 还会和浏览器的 saveState 抢乐观锁。骨架（串行写队列 / 原子写 / 损坏容错 / 路径遍历守卫）对齐
// agent-session-reclamation-deadline-store.ts；多了一层内存读缓存，因为 projects_updated 每次广播都要读它，
// 而 runtime 是这个文件唯一的写者。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "./workspace-state";

const TASK_LAST_OPENED_BY_USER_RECORD_FILENAME = "task-last-opened-by-user-records.json";

// 每 workspace 上限，超限丢最旧。切换面板最多回看 30 天，几百条足够。
const MAX_TASK_LAST_OPENED_BY_USER_RECORDS_PER_WORKSPACE = 500;

const persistedTaskLastOpenedByUserRecordFileSchema = z.record(z.string(), z.number());

function getTaskLastOpenedByUserRecordPath(workspaceId: string): string {
	// 防路径遍历：workspaceId 经 tRPC input 传入，要求 workspace 目录必须是 workspaces 根的直接子目录。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(workspaceDirectory) !== resolve(getWorkspacesRootPath())) {
		throw new Error(
			`Refusing task last-opened-by-user record access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, TASK_LAST_OPENED_BY_USER_RECORD_FILENAME);
}

async function readTaskLastOpenedByUserRecordsFromDisk(workspaceId: string): Promise<Map<string, number>> {
	let raw: string;
	try {
		raw = await readFile(getTaskLastOpenedByUserRecordPath(workspaceId), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return new Map();
		}
		throw error;
	}
	try {
		const parsed = persistedTaskLastOpenedByUserRecordFileSchema.safeParse(JSON.parse(raw) as unknown);
		// fail-open：账本损坏只损失「我最近打开」这一个排序信号，按空处理。
		return parsed.success ? new Map(Object.entries(parsed.data)) : new Map();
	} catch {
		return new Map();
	}
}

const cachedRecordsByWorkspaceId = new Map<string, Map<string, number>>();
const pendingDiskReadsByWorkspaceId = new Map<string, Promise<Map<string, number>>>();
const writeQueueByWorkspaceId = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueueByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	writeQueueByWorkspaceId.set(
		workspaceId,
		next.catch(() => undefined),
	);
	return next;
}

async function loadCachedTaskLastOpenedByUserRecords(workspaceId: string): Promise<Map<string, number>> {
	const cached = cachedRecordsByWorkspaceId.get(workspaceId);
	if (cached) {
		return cached;
	}
	const pending = pendingDiskReadsByWorkspaceId.get(workspaceId);
	if (pending) {
		return await pending;
	}
	const loading = readTaskLastOpenedByUserRecordsFromDisk(workspaceId)
		.then((records) => {
			cachedRecordsByWorkspaceId.set(workspaceId, records);
			return records;
		})
		.finally(() => {
			pendingDiskReadsByWorkspaceId.delete(workspaceId);
		});
	pendingDiskReadsByWorkspaceId.set(workspaceId, loading);
	return await loading;
}

export async function readTaskLastOpenedByUserAtByTaskId(workspaceId: string): Promise<ReadonlyMap<string, number>> {
	return await loadCachedTaskLastOpenedByUserRecords(workspaceId);
}

// 返回 true = 记录有变化（调用方据此决定是否广播）。时钟回拨时只前进不后退。
export async function recordTaskLastOpenedByUser(
	workspaceId: string,
	taskId: string,
	openedAt: number,
): Promise<boolean> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await loadCachedTaskLastOpenedByUserRecords(workspaceId);
		const previousOpenedAt = records.get(taskId);
		if (previousOpenedAt !== undefined && previousOpenedAt >= openedAt) {
			return false;
		}
		const nextRecords = new Map(records);
		nextRecords.set(taskId, openedAt);
		const cappedRecords =
			nextRecords.size <= MAX_TASK_LAST_OPENED_BY_USER_RECORDS_PER_WORKSPACE
				? nextRecords
				: new Map(
						[...nextRecords.entries()]
							.sort((left, right) => right[1] - left[1])
							.slice(0, MAX_TASK_LAST_OPENED_BY_USER_RECORDS_PER_WORKSPACE),
					);
		await lockedFileSystem.writeJsonFileAtomic(
			getTaskLastOpenedByUserRecordPath(workspaceId),
			Object.fromEntries(cappedRecords),
			{ lock: null },
		);
		cachedRecordsByWorkspaceId.set(workspaceId, cappedRecords);
		return true;
	});
}

// 测试与 workspace 删除用：丢掉内存缓存，下次从盘重读。
export function forgetCachedTaskLastOpenedByUserRecords(workspaceId: string): void {
	cachedRecordsByWorkspaceId.delete(workspaceId);
}
