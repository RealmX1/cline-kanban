import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

export const TASK_CLOSURE_MANAGED_PAYLOAD_DIRECTORY_NAME_PATTERN =
	/^(preservation-attempt-\d+|preserved-git-working-state-payload|preserved-replacement-git-working-state-payload|archive-restoration-verification-worktree|reopening-archive-restoration-worktree)$/u;

export async function measureTaskClosureOwnedDirectoryBytes(path: string): Promise<number> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) return Buffer.byteLength(await readlink(path));
	if (info.isFile()) return info.size;
	if (!info.isDirectory()) throw new Error("归档操作目录含有无法核验的特殊文件，保留现场。");
	let bytes = 0;
	for (const entry of await readdir(path)) bytes += await measureTaskClosureOwnedDirectoryBytes(join(path, entry));
	return bytes;
}
