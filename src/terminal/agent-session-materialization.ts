import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, copyFile, cp, link, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeTaskAgentSessionInitialization } from "../core/api-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	type CursorAgentChatStoreEnvironmentOverrides,
	hashCursorAgentChatWorkingDirectoryBucketKey,
	resolveCursorAgentChatStoreRootDirectoryPath,
} from "./cursor-agent-chat-store-location-and-conversation-inspection";

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await access(pathValue, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function encodeClaudeProjectWorkingDirectoryPath(workingDirectoryPath: string): string {
	return resolve(workingDirectoryPath).replace(/[^a-zA-Z0-9]/gu, "-");
}

async function canonicalizeWorkingDirectoryPath(workingDirectoryPath: string): Promise<string> {
	try {
		return await realpath(workingDirectoryPath);
	} catch {
		return resolve(workingDirectoryPath);
	}
}

async function findNewestExistingPath(candidatePaths: string[]): Promise<string | null> {
	const existingCandidates = await Promise.all(
		candidatePaths.map(async (candidatePath) => {
			try {
				return { candidatePath, modifiedAt: (await stat(candidatePath)).mtimeMs };
			} catch {
				return null;
			}
		}),
	);
	return (
		existingCandidates
			.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
			.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.candidatePath ?? null
	);
}

async function readDirectories(directoryPath: string): Promise<Dirent[]> {
	try {
		return (await readdir(directoryPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	} catch {
		return [];
	}
}

async function findClaudeSourceTranscriptPath(
	initialization: RuntimeTaskAgentSessionInitialization,
	targetTranscriptPath: string,
): Promise<string | null> {
	const claudeProjectsDirectoryPath = join(homedir(), ".claude", "projects");
	const preferredSourceWorkingDirectoryPath = initialization.sourceSessionWorkingDirectoryPath;
	if (preferredSourceWorkingDirectoryPath) {
		const canonicalSourceWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
			preferredSourceWorkingDirectoryPath,
		);
		const preferredSourceTranscriptPath = join(
			claudeProjectsDirectoryPath,
			encodeClaudeProjectWorkingDirectoryPath(canonicalSourceWorkingDirectoryPath),
			`${initialization.sourceSessionId}.jsonl`,
		);
		if (
			resolve(preferredSourceTranscriptPath) !== resolve(targetTranscriptPath) &&
			(await pathExists(preferredSourceTranscriptPath))
		) {
			return preferredSourceTranscriptPath;
		}
	}
	const projectDirectories = await readDirectories(claudeProjectsDirectoryPath);
	return findNewestExistingPath(
		projectDirectories
			.map((projectDirectory) =>
				join(claudeProjectsDirectoryPath, projectDirectory.name, `${initialization.sourceSessionId}.jsonl`),
			)
			.filter((candidatePath) => resolve(candidatePath) !== resolve(targetTranscriptPath)),
	);
}

async function findCursorSourceChatDirectoryPath(
	initialization: RuntimeTaskAgentSessionInitialization,
	targetChatDirectoryPath: string,
	cursorChatsDirectoryPath: string,
): Promise<string | null> {
	const preferredSourceWorkingDirectoryPath = initialization.sourceSessionWorkingDirectoryPath;
	if (preferredSourceWorkingDirectoryPath) {
		const canonicalSourceWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
			preferredSourceWorkingDirectoryPath,
		);
		const preferredSourceChatDirectoryPath = join(
			cursorChatsDirectoryPath,
			hashCursorAgentChatWorkingDirectoryBucketKey(canonicalSourceWorkingDirectoryPath),
			initialization.sourceSessionId,
		);
		if (
			resolve(preferredSourceChatDirectoryPath) !== resolve(targetChatDirectoryPath) &&
			(await pathExists(join(preferredSourceChatDirectoryPath, "store.db")))
		) {
			return preferredSourceChatDirectoryPath;
		}
	}
	const workspaceHashDirectories = await readDirectories(cursorChatsDirectoryPath);
	const candidateChatDirectoryPaths = workspaceHashDirectories
		.map((workspaceHashDirectory) =>
			join(cursorChatsDirectoryPath, workspaceHashDirectory.name, initialization.sourceSessionId),
		)
		.filter((candidatePath) => resolve(candidatePath) !== resolve(targetChatDirectoryPath));
	const validCandidateChatDirectoryPaths = (
		await Promise.all(
			candidateChatDirectoryPaths.map(async (candidatePath) =>
				(await pathExists(join(candidatePath, "store.db"))) ? candidatePath : null,
			),
		)
	).filter((candidatePath): candidatePath is string => candidatePath !== null);
	return findNewestExistingPath(validCandidateChatDirectoryPaths);
}

// 复制而不是软链（task 203f3 之前是软链）：软链让新会话直接写进**源** chat 的 store——源对话被改写，源若还在别处
// 跑着就成了两个写者。复制得到一份独立的副本，此后两边各写各的。
//
// 只复制 sqlite 三件套，**不复制 meta.json**：实测 cursor 首次按 id 打开时会依据 store 重建 meta，且写进的是目标
// cwd；把源 meta 复制过来反而会留下一个指向源 cwd 的陈旧值。全程只 copyFile / stat，绝不打开 sqlite。
const CURSOR_AGENT_CHAT_STORE_DATABASE_FILE_NAMES = ["store.db", "store.db-wal", "store.db-shm"] as const;

interface CursorAgentChatStoreFileFingerprint {
	fileName: string;
	sizeBytes: number;
	modifiedAtMs: number;
}

async function fingerprintCursorAgentChatStoreFiles(
	chatDirectoryPath: string,
): Promise<CursorAgentChatStoreFileFingerprint[]> {
	const fingerprints: CursorAgentChatStoreFileFingerprint[] = [];
	for (const fileName of CURSOR_AGENT_CHAT_STORE_DATABASE_FILE_NAMES) {
		try {
			const fileStat = await stat(join(chatDirectoryPath, fileName));
			fingerprints.push({ fileName, sizeBytes: fileStat.size, modifiedAtMs: fileStat.mtimeMs });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	}
	return fingerprints;
}

async function copyCursorAgentChatStoreIntoExecutionWorkingDirectoryBucket(input: {
	sourceChatDirectoryPath: string;
	targetChatDirectoryPath: string;
	sourceSessionId: string;
}): Promise<void> {
	const fingerprintsBeforeCopy = await fingerprintCursorAgentChatStoreFiles(input.sourceChatDirectoryPath);
	// 暂存在 kanban 自己的目录里，复制完整之后再一次 rename 进 cursor 的桶：cursor 永远看不到半份 chat。
	const stagingDirectoryPath = join(
		getRuntimeHomePath(),
		"cursor-agent-chat-materialization-staging",
		`${input.sourceSessionId}-${randomUUID()}`,
	);
	await mkdir(stagingDirectoryPath, { recursive: true });
	try {
		for (const { fileName } of fingerprintsBeforeCopy) {
			await copyFile(join(input.sourceChatDirectoryPath, fileName), join(stagingDirectoryPath, fileName));
		}
		const fingerprintsAfterCopy = await fingerprintCursorAgentChatStoreFiles(input.sourceChatDirectoryPath);
		if (JSON.stringify(fingerprintsAfterCopy) !== JSON.stringify(fingerprintsBeforeCopy)) {
			throw new Error(
				`Cursor session ${input.sourceSessionId} is being written right now (its chat store changed while it was being copied). Wait for the cursor-agent that has it open to finish, then try again.`,
			);
		}
		await mkdir(resolve(input.targetChatDirectoryPath, ".."), { recursive: true });
		try {
			await rename(stagingDirectoryPath, input.targetChatDirectoryPath);
		} catch (error) {
			// 两个并发的物化撞在一起：先到的已经放好了一份完整副本，后到的认它即可。
			if (
				error instanceof Error &&
				"code" in error &&
				(error.code === "ENOTEMPTY" || error.code === "EEXIST") &&
				(await pathExists(join(input.targetChatDirectoryPath, "store.db")))
			) {
				return;
			}
			if (error instanceof Error && "code" in error && error.code === "EXDEV") {
				// kanban 目录与 cursor 配置目录不在同一个卷上（例如 CURSOR_CONFIG_DIR 指到外置盘）：退回目录复制。
				await cp(stagingDirectoryPath, input.targetChatDirectoryPath, { recursive: true, errorOnExist: true });
				return;
			}
			throw error;
		}
	} finally {
		await rm(stagingDirectoryPath, { recursive: true, force: true });
	}
}

async function ensureClaudeTranscriptHardLink(sourcePath: string, targetPath: string): Promise<void> {
	await mkdir(resolve(targetPath, ".."), { recursive: true });
	const targetReferencesSource = async (): Promise<boolean> => {
		const [targetMetadata, sourceMetadata] = await Promise.all([stat(targetPath), stat(sourcePath)]);
		return targetMetadata.dev === sourceMetadata.dev && targetMetadata.ino === sourceMetadata.ino;
	};
	try {
		await lstat(targetPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
		try {
			await link(sourcePath, targetPath);
		} catch (creationError) {
			if (!(creationError instanceof Error && "code" in creationError && creationError.code === "EEXIST")) {
				throw creationError;
			}
			if (!(await targetReferencesSource())) {
				throw new Error(`Session storage was concurrently created at ${targetPath} from a different source.`);
			}
		}
		return;
	}
	if (!(await targetReferencesSource())) {
		throw new Error(`Session storage already exists at ${targetPath} and points to a different session source.`);
	}
}

export async function materializeTaskAgentSessionForExecutionWorkingDirectory(input: {
	initialization: RuntimeTaskAgentSessionInitialization | undefined;
	executionWorkingDirectoryPath: string;
	// 启动请求里对 cursor 配置目录的 env 覆写（CURSOR_CONFIG_DIR / XDG_CONFIG_HOME），决定 chat store 在哪。
	cursorAgentChatStoreEnvironmentOverrides?: CursorAgentChatStoreEnvironmentOverrides;
}): Promise<void> {
	const { initialization } = input;
	if (!initialization || initialization.sourceAgentId === "codex") {
		return;
	}
	const canonicalExecutionWorkingDirectoryPath = await canonicalizeWorkingDirectoryPath(
		input.executionWorkingDirectoryPath,
	);
	if (initialization.sourceAgentId === "claude") {
		const targetTranscriptPath = join(
			homedir(),
			".claude",
			"projects",
			encodeClaudeProjectWorkingDirectoryPath(canonicalExecutionWorkingDirectoryPath),
			`${initialization.sourceSessionId}.jsonl`,
		);
		const targetTranscriptExists = await pathExists(targetTranscriptPath);
		const sourceTranscriptPath = await findClaudeSourceTranscriptPath(initialization, targetTranscriptPath);
		if (!sourceTranscriptPath) {
			if (targetTranscriptExists) {
				return;
			}
			throw new Error(
				`Claude Code session ${initialization.sourceSessionId} was not found in local project history.`,
			);
		}
		await ensureClaudeTranscriptHardLink(sourceTranscriptPath, targetTranscriptPath);
		return;
	}

	const cursorChatsDirectoryPath = resolveCursorAgentChatStoreRootDirectoryPath(
		input.cursorAgentChatStoreEnvironmentOverrides,
	);
	const targetChatDirectoryPath = join(
		cursorChatsDirectoryPath,
		hashCursorAgentChatWorkingDirectoryBucketKey(canonicalExecutionWorkingDirectoryPath),
		initialization.sourceSessionId,
	);
	// 已物化（含旧版留下的软链）就不再动它：幂等，且同一会话的多次启动不会反复复制。
	if (await pathExists(join(targetChatDirectoryPath, "store.db"))) {
		return;
	}
	// 目标位置被别的东西占着（断掉的旧软链、cursor 留下的空目录…）：如实报错，不替用户删。
	try {
		await lstat(targetChatDirectoryPath);
		throw new Error(
			`Session storage already exists at ${targetChatDirectoryPath} and points to a different session source.`,
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	const sourceChatDirectoryPath = await findCursorSourceChatDirectoryPath(
		initialization,
		targetChatDirectoryPath,
		cursorChatsDirectoryPath,
	);
	if (!sourceChatDirectoryPath) {
		throw new Error(
			`Cursor session ${initialization.sourceSessionId} was not found in local chat storage. Cursor keeps chats per working directory under ${cursorChatsDirectoryPath}; the session must exist in one of them.`,
		);
	}
	await copyCursorAgentChatStoreIntoExecutionWorkingDirectoryBucket({
		sourceChatDirectoryPath,
		targetChatDirectoryPath,
		sourceSessionId: initialization.sourceSessionId,
	});
}
