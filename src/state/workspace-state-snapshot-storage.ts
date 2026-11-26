import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";

export const WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME = "workspace-state-snapshot-commit.json";
export const WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME = "workspace-state-legacy-observation.json";

export const workspaceStateSnapshotMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
	workspaceStateSnapshotCommitId: z.uuid().optional(),
});
export type WorkspaceStateSnapshotMeta = z.infer<typeof workspaceStateSnapshotMetaSchema>;

const workspaceStateSnapshotCommitSchema = z
	.object({
		schemaVersion: z.literal(1),
		workspaceId: z.string().min(1),
		workspaceStateSnapshotCommitId: z.uuid(),
		boardJsonText: z.string(),
		sessionsJsonText: z.string(),
		meta: workspaceStateSnapshotMetaSchema.extend({ workspaceStateSnapshotCommitId: z.uuid() }),
	})
	.superRefine((snapshot, context) => {
		if (snapshot.workspaceStateSnapshotCommitId !== snapshot.meta.workspaceStateSnapshotCommitId)
			context.addIssue({ code: "custom", message: "快照提交与 meta 的 commitId 不一致。" });
	});
export type WorkspaceStateSnapshotCommit = z.infer<typeof workspaceStateSnapshotCommitSchema>;

export async function readWorkspaceSnapshotFileText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function readWorkspaceStateSnapshotCommit(
	directoryPath: string,
	workspaceId: string,
): Promise<WorkspaceStateSnapshotCommit | null> {
	const text = await readWorkspaceSnapshotFileText(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME));
	if (text === null) return null;
	const snapshot = workspaceStateSnapshotCommitSchema.parse(JSON.parse(text));
	if (snapshot.workspaceId !== workspaceId) throw new Error("快照提交的 workspaceId 不匹配，已保留日志。");
	return snapshot;
}

export const WORKSPACE_STATE_SNAPSHOT_PROJECTION_FILENAMES = ["board.json", "sessions.json", "meta.json"] as const;

export async function readRawWorkspaceStateSnapshot(
	directoryPath: string,
	workspaceId: string,
	validateBody: (board: unknown, sessions: unknown) => void,
) {
	const journalPath = join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME);
	type RawFile = { filename: string; bytes: Buffer; mode: number };
	async function readRawFile(filename: string): Promise<RawFile | null> {
		const path = join(directoryPath, filename);
		const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (!metadata) return null;
		if (!metadata.isFile()) throw new Error(`工作区原始快照条目不是普通文件：${path}`);
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			},
		);
		if (!file) return null;
		try {
			const openedMetadata = await file.stat();
			if (!openedMetadata.isFile()) throw new Error(`工作区原始快照条目不是普通文件：${path}`);
			return { filename, bytes: await file.readFile(), mode: openedMetadata.mode & 0o7777 };
		} finally {
			await file.close();
		}
	}
	function parseRawJson(file: RawFile): unknown {
		const text = file.bytes.toString("utf8");
		if (!Buffer.from(text).equals(file.bytes)) throw new Error(`工作区快照正文不是有效 UTF-8：${file.filename}`);
		return JSON.parse(text);
	}
	async function readJournal() {
		const journal = await readRawFile(WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME);
		if (!journal) return null;
		const snapshot = workspaceStateSnapshotCommitSchema.parse(parseRawJson(journal));
		if (snapshot.workspaceId !== workspaceId) throw new Error("快照提交的 workspaceId 不匹配。");
		validateBody(JSON.parse(snapshot.boardJsonText), JSON.parse(snapshot.sessionsJsonText));
		return { kind: "journal" as const, commitId: snapshot.workspaceStateSnapshotCommitId, files: [journal] };
	}
	try {
		for (let attempt = 0; attempt < 8; attempt++) {
			const journalBefore = await readJournal();
			if (journalBefore) return journalBefore;
			const before = await readWorkspaceSnapshotFileIdentities(directoryPath, [
				WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
				...WORKSPACE_STATE_SNAPSHOT_PROJECTION_FILENAMES,
			]);
			const [board, sessions, meta] = await Promise.all(
				WORKSPACE_STATE_SNAPSHOT_PROJECTION_FILENAMES.map(readRawFile),
			);
			const after = await readWorkspaceSnapshotFileIdentities(directoryPath, [
				WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
				...WORKSPACE_STATE_SNAPSHOT_PROJECTION_FILENAMES,
			]);
			const journalAfter = await readJournal();
			if (journalAfter) return journalAfter;
			if (before[0] !== "missing" || before.some((identity, index) => identity !== after[index])) continue;
			if (
				before.every((identity) => identity === "missing") &&
				(await readRawFile(WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME)) === null
			)
				return { kind: "uninitialized" as const, commitId: null, files: [] };
			if (!sessions || !meta) throw new Error("工作区快照的 sessions 或 meta 缺失。");
			const metadata = workspaceStateSnapshotMetaSchema.parse(parseRawJson(meta));
			if (!board && metadata.workspaceStateSnapshotCommitId) throw new Error("工作区提交投影的 board 缺失。");
			// 旧会话写入只落 sessions 和 meta，缺省看板由原生读取补齐。
			validateBody(board ? parseRawJson(board) : undefined, parseRawJson(sessions));
			return {
				kind: metadata.workspaceStateSnapshotCommitId ? ("projection" as const) : ("legacy" as const),
				commitId: metadata.workspaceStateSnapshotCommitId ?? null,
				files: board ? [board, sessions, meta] : [sessions, meta],
			};
		}
		throw new Error("工作区快照在有界采样期间持续变化。");
	} catch (error) {
		throw Object.assign(
			new Error(`无法只读核验工作区 ${workspaceId} 的原始快照：${String(error)}`, { cause: error }),
			{
				code: "WORKSPACE_SNAPSHOT_UNAVAILABLE",
				path: journalPath,
			},
		);
	}
}

export function createWorkspaceStateSnapshotCommit(input: {
	workspaceId: string;
	boardJsonText: string;
	sessionsJsonText: string;
	meta: WorkspaceStateSnapshotMeta;
}): WorkspaceStateSnapshotCommit {
	const workspaceStateSnapshotCommitId = randomUUID();
	return {
		...input,
		schemaVersion: 1,
		workspaceStateSnapshotCommitId,
		meta: { ...input.meta, workspaceStateSnapshotCommitId },
	};
}

export async function writeWorkspaceStateSnapshotCommitDurably(
	directoryPath: string,
	snapshot: WorkspaceStateSnapshotCommit,
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME), snapshot, {
		lock: null,
		durable: true,
	});
	// 新建 workspace 的目录项也必须持久化，否则只同步目录内部不足以保证重启后仍可寻址。
	if (process.platform !== "win32") {
		const parentDirectory = await open(dirname(directoryPath), "r");
		try {
			await parentDirectory.sync();
		} finally {
			await parentDirectory.close();
		}
	}
}

// 调用方持有 workspace 锁；日志是提交点，三个 JSON 只重放已提交字节，不执行任何业务回调。
export async function projectWorkspaceStateSnapshotCommitWithinLock(
	directoryPath: string,
	snapshot: WorkspaceStateSnapshotCommit,
): Promise<void> {
	// 同内容重试也同步日志，补齐 rename 成功但目录 fsync 失败的情况。
	await writeWorkspaceStateSnapshotCommitDurably(directoryPath, snapshot);
	for (const [filename, text] of [
		["board.json", snapshot.boardJsonText],
		["sessions.json", snapshot.sessionsJsonText],
		["meta.json", JSON.stringify(snapshot.meta, null, 2)],
	] as const) {
		await lockedFileSystem.writeTextFileAtomic(join(directoryPath, filename), text, { lock: null, durable: true });
	}
	await rm(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME));
	if (process.platform !== "win32") {
		const directory = await open(directoryPath, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}

async function readWorkspaceSnapshotFileIdentities(
	directoryPath: string,
	filenames: readonly string[],
	statFile: typeof lstat = lstat,
) {
	return Promise.all(
		filenames.map(async (filename) => {
			try {
				const file = await statFile(join(directoryPath, filename), { bigint: true });
				return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
				throw error;
			}
		}),
	);
}

// meta 正文包含 commitId；日志和投影的 inode/ctime 指纹同时阻止同 revision 或同 mtime 的缓存误命中。
export async function readWorkspaceStateSnapshotReadFingerprint(directoryPath: string): Promise<string> {
	const metaText = await readWorkspaceSnapshotFileText(join(directoryPath, "meta.json"));
	const fileFingerprints = await readWorkspaceSnapshotFileIdentities(
		directoryPath,
		[WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME, "board.json", "sessions.json"],
		stat,
	);
	return JSON.stringify([metaText, ...fileFingerprints]);
}
