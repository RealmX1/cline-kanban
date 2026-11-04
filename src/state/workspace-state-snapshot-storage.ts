import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
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

// meta 正文包含 commitId；日志和投影的 inode/ctime 指纹同时阻止同 revision 或同 mtime 的缓存误命中。
export async function readWorkspaceStateSnapshotReadFingerprint(directoryPath: string): Promise<string> {
	const metaText = await readWorkspaceSnapshotFileText(join(directoryPath, "meta.json"));
	const fileFingerprints = await Promise.all(
		[WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME, "board.json", "sessions.json"].map(async (filename) => {
			try {
				const file = await stat(join(directoryPath, filename), { bigint: true });
				return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
				throw error;
			}
		}),
	);
	return JSON.stringify([metaText, ...fileFingerprints]);
}
