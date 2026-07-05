// 应用内通知中心的持久化存储：每个 workspace 一个 notifications.json（与 board.json 同级）。
// 存「最小字段」——taskTitle/repoName/isDone 不落库，由 notification-feed-builder 在发送时派生。
// 关键卖点：落库发生在 runtime-state-hub 的「0 客户端提前返回」之前，故浏览器全关时段的后台事件也记录。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type RuntimeTaskSessionUserTurnKind, runtimeTaskSessionUserTurnKindSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath, listWorkspaceIndexEntries } from "./workspace-state";

const NOTIFICATION_LOG_FILENAME = "notifications.json";

// ponytail: 固定 300/工作区，日志够用；要「永不丢」再上归档层。
const MAX_ENTRIES_PER_WORKSPACE = 300;

const persistedNotificationEntrySchema = z.object({
	id: z.string(),
	taskId: z.string(),
	userTurnKind: runtimeTaskSessionUserTurnKindSchema,
	triggeredAt: z.number(),
	visitedAt: z.number().nullable(),
});
export type PersistedNotificationEntry = z.infer<typeof persistedNotificationEntrySchema>;

const persistedNotificationLogFileSchema = z.array(persistedNotificationEntrySchema);

export interface AppendNotificationLogEntryInput {
	taskId: string;
	userTurnKind: RuntimeTaskSessionUserTurnKind;
	triggeredAt: number;
}

function getNotificationLogPath(workspaceId: string): string {
	// 防路径遍历（root-cause 单一 choke point，覆盖 append/read/mark/clear 全部入口）：workspaceId 经
	// markTaskNotificationsVisited / clearNotificationLog 两个 tRPC mutation 从客户端 input 进来，且这两个
	// mutation 用 t.procedure 不校验连接 scope；未校验的 "../" 会让 join 逃逸出 workspaces 根（clearNotificationLog
	// 会创建目录并写入 []）。要求 workspace 目录必须是 workspaces 根的直接子目录，否则拒绝。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(`Refusing notification log access outside workspaces root for workspaceId: ${workspaceId}`);
	}
	return join(workspaceDirectory, NOTIFICATION_LOG_FILENAME);
}

async function readRawNotificationLog(workspaceId: string): Promise<PersistedNotificationEntry[]> {
	const path = getNotificationLogPath(workspaceId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch {
		// 日志是可丢弃数据：损坏文件不应让整个快照构建崩溃。以空日志兜底。
		return [];
	}
	const parsed = persistedNotificationLogFileSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : [];
}

async function writeNotificationLog(workspaceId: string, entries: PersistedNotificationEntry[]): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getNotificationLogPath(workspaceId), entries, {
		lock: null,
	});
}

// 每工作区 in-process 串行队列（Promise 链），把 read-modify-write 串起来防并发 append 互覆盖。
// ponytail: 单后端进程，进程内串行足够；多进程写同一 workspace 才需要 writeJsonFileAtomic 的跨进程锁。
const writeQueueByWorkspaceId = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueueByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	// 无论上一个操作成败都要跑本操作，故 then 的两个分支都指向 operation。
	const next = previous.then(operation, operation);
	// 存入队列的是「吞掉异常」的版本，避免失败的一环打断后续操作或产生未处理拒绝；
	// 但返回给调用方的是原始 next（保留真实结果 / 异常）。
	writeQueueByWorkspaceId.set(
		workspaceId,
		next.catch(() => undefined),
	);
	return next;
}

export async function readNotificationLog(workspaceId: string): Promise<PersistedNotificationEntry[]> {
	return await readRawNotificationLog(workspaceId);
}

// 聚合全部 workspace 的日志（快照构建用）。只返回「有条目」的 workspace，压小 payload。
export async function readAllNotificationLogs(): Promise<Record<string, PersistedNotificationEntry[]>> {
	const indexEntries = await listWorkspaceIndexEntries();
	const result: Record<string, PersistedNotificationEntry[]> = {};
	await Promise.all(
		indexEntries.map(async (entry) => {
			const entries = await readRawNotificationLog(entry.workspaceId);
			if (entries.length > 0) {
				result[entry.workspaceId] = entries;
			}
		}),
	);
	return result;
}

export async function appendNotificationLogEntry(
	workspaceId: string,
	input: AppendNotificationLogEntryInput,
): Promise<void> {
	await enqueueWrite(workspaceId, async () => {
		const entries = await readRawNotificationLog(workspaceId);
		const id = `${input.taskId}:${input.triggeredAt}`;
		if (entries.some((entry) => entry.id === id)) {
			// 幂等：同 id 已存在（同 task 同一毫秒重复触发），不重复追加。
			return;
		}
		const nextEntry: PersistedNotificationEntry = {
			id,
			taskId: input.taskId,
			userTurnKind: input.userTurnKind,
			triggeredAt: input.triggeredAt,
			visitedAt: null,
		};
		const nextEntries = [...entries, nextEntry];
		// 上限丢最旧：条目按追加顺序（最旧在前），超限从头切。
		const capped =
			nextEntries.length > MAX_ENTRIES_PER_WORKSPACE
				? nextEntries.slice(nextEntries.length - MAX_ENTRIES_PER_WORKSPACE)
				: nextEntries;
		await writeNotificationLog(workspaceId, capped);
	});
}

// 「标记最新 = 标记整组」：把该 taskId 组内所有未读（visitedAt===null）置为 visitedAt。
export async function markTaskNotificationsVisited(
	workspaceId: string,
	taskId: string,
	visitedAt: number,
): Promise<void> {
	await enqueueWrite(workspaceId, async () => {
		const entries = await readRawNotificationLog(workspaceId);
		let changed = false;
		const nextEntries = entries.map((entry) => {
			if (entry.taskId === taskId && entry.visitedAt === null) {
				changed = true;
				return { ...entry, visitedAt };
			}
			return entry;
		});
		if (!changed) {
			return;
		}
		await writeNotificationLog(workspaceId, nextEntries);
	});
}

export async function clearNotificationLog(workspaceId: string): Promise<void> {
	await enqueueWrite(workspaceId, async () => {
		await writeNotificationLog(workspaceId, []);
	});
}
