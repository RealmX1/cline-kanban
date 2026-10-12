// cursor-agent 本地 chat store 的位置解析与**只读**检查。
//
// 布局（cursor-agent 2026.10.01 bundle 静态分析 + 隔离实测，证据见
// `~/.cline/validation-evidence/203f3-cursor-agent-chat-identity-isolated-experiments/README.md`）：
//   <chats 根>/<md5(物理 cwd)>/<chatId>/{store.db, store.db-wal, store.db-shm, meta.json}
//   - chats 根 = `$CURSOR_CONFIG_DIR/chats` ‖ `$XDG_CONFIG_HOME/cursor/chats` ‖ `~/.cursor/chats`。
//   - 桶 key 取的是 cursor-agent 进程里 `path.resolve(process.cwd())`。kanban 用 `--workspace <cwd>` 启动，cursor
//     先 chdir 进去，`process.cwd()` 拿到的是**物理路径**（macOS 上 `/tmp/x` 会变成 `/private/tmp/x`），
//     所以这里先 realpath 再算 md5。
//   - meta.json：`{schemaVersion, createdAtMs, hasConversation, title?, updatedAtMs?, isSubagent?, cwd?}`。
//     `hasConversation` 在**首个检查点**才翻 true，不是在 prompt 提交时：长首轮（agent 先跑一个 30s 的命令）
//     期间一直是 false。所以「对话是否已建立」只认 hasConversation，「prompt 是否已提交」看 store.db 是否出现
//     （提交后约 1s 就出现）。
//   - 在首个检查点之前被 SIGTERM 杀掉，cursor 会删掉这个空 chat 目录。
//
// 只读 meta.json 和 stat，**绝不打开 store.db**：sqlite 打开即可能写 -wal / -shm，等于改了别人的会话存储。

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CursorAgentChatStoreEnvironmentOverrides {
	CURSOR_CONFIG_DIR?: string;
	XDG_CONFIG_HOME?: string;
}

export interface CursorAgentChatConversationInspection {
	chatId: string;
	chatDirectoryPath: string;
	storeDatabaseFileExists: boolean;
	// meta.json 缺失或读不出时为 null（例如刚由 kanban 复制进来、cursor 还没重建 meta 的播种 chat）。
	hasConversation: boolean | null;
	isSubagent: boolean;
	updatedAtMs: number | null;
}

function readTrimmedEnvironmentValue(
	environmentOverrides: CursorAgentChatStoreEnvironmentOverrides | undefined,
	key: keyof CursorAgentChatStoreEnvironmentOverrides,
): string | null {
	const value = environmentOverrides?.[key] ?? process.env[key];
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

// 与 cursor-agent 的解析顺序逐条一致。环境取「启动 cursor 时会用的那份」：kanban 拉起的 cursor 继承运行时
// env，再叠加启动请求里的 env 覆写，所以调用方把请求 env 作为 overrides 传进来。
export function resolveCursorAgentChatStoreRootDirectoryPath(
	environmentOverrides?: CursorAgentChatStoreEnvironmentOverrides,
): string {
	const cursorConfigDirectoryPath = readTrimmedEnvironmentValue(environmentOverrides, "CURSOR_CONFIG_DIR");
	if (cursorConfigDirectoryPath) {
		return join(cursorConfigDirectoryPath, "chats");
	}
	const xdgConfigHomeDirectoryPath = readTrimmedEnvironmentValue(environmentOverrides, "XDG_CONFIG_HOME");
	if (xdgConfigHomeDirectoryPath) {
		return join(xdgConfigHomeDirectoryPath, "cursor", "chats");
	}
	return join(homedir(), ".cursor", "chats");
}

export function hashCursorAgentChatWorkingDirectoryBucketKey(physicalWorkingDirectoryPath: string): string {
	return createHash("md5").update(resolve(physicalWorkingDirectoryPath)).digest("hex");
}

export async function resolvePhysicalWorkingDirectoryPath(workingDirectoryPath: string): Promise<string> {
	try {
		return await realpath(workingDirectoryPath);
	} catch {
		return resolve(workingDirectoryPath);
	}
}

export async function resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
	workingDirectoryPath: string,
	environmentOverrides?: CursorAgentChatStoreEnvironmentOverrides,
): Promise<string> {
	return join(
		resolveCursorAgentChatStoreRootDirectoryPath(environmentOverrides),
		hashCursorAgentChatWorkingDirectoryBucketKey(await resolvePhysicalWorkingDirectoryPath(workingDirectoryPath)),
	);
}

async function doesRegularFileExist(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function readCursorAgentChatMeta(chatDirectoryPath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(chatDirectoryPath, "meta.json"), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export async function inspectCursorAgentChatConversation(
	chatDirectoryPath: string,
	chatId: string,
): Promise<CursorAgentChatConversationInspection> {
	const [storeDatabaseFileExists, meta] = await Promise.all([
		doesRegularFileExist(join(chatDirectoryPath, "store.db")),
		readCursorAgentChatMeta(chatDirectoryPath),
	]);
	return {
		chatId,
		chatDirectoryPath,
		storeDatabaseFileExists,
		hasConversation: typeof meta?.hasConversation === "boolean" ? meta.hasConversation : null,
		isSubagent: meta?.isSubagent === true,
		updatedAtMs: typeof meta?.updatedAtMs === "number" ? meta.updatedAtMs : null,
	};
}

export async function inspectCursorAgentChatInWorkingDirectoryBucket(input: {
	workingDirectoryPath: string;
	chatId: string;
	environmentOverrides?: CursorAgentChatStoreEnvironmentOverrides;
}): Promise<CursorAgentChatConversationInspection> {
	const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
		input.workingDirectoryPath,
		input.environmentOverrides,
	);
	return await inspectCursorAgentChatConversation(join(bucketDirectoryPath, input.chatId), input.chatId);
}

export async function listCursorAgentChatsInWorkingDirectoryBucket(input: {
	workingDirectoryPath: string;
	environmentOverrides?: CursorAgentChatStoreEnvironmentOverrides;
}): Promise<CursorAgentChatConversationInspection[]> {
	const bucketDirectoryPath = await resolveCursorAgentChatBucketDirectoryPathForWorkingDirectory(
		input.workingDirectoryPath,
		input.environmentOverrides,
	);
	let chatDirectoryNames: string[];
	try {
		chatDirectoryNames = (await readdir(bucketDirectoryPath, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return await Promise.all(
		chatDirectoryNames.map((chatId) => inspectCursorAgentChatConversation(join(bucketDirectoryPath, chatId), chatId)),
	);
}

// 「这段对话已建立、按 id 续跑能接上历史」。meta 缺失（hasConversation === null）只会出现在 kanban 刚复制进来的
// 播种 chat 上——cursor 首次打开时会按 store 重建 meta——所以按已建立处理；明确为 false 的一律不算：实测
// `--resume <id>` 打开这种 chat 只会得到一段**空对话**，看起来像恢复成功，其实什么都没接上。
export function isCursorAgentChatConversationEstablished(inspection: CursorAgentChatConversationInspection): boolean {
	return inspection.storeDatabaseFileExists && !inspection.isSubagent && inspection.hasConversation !== false;
}
