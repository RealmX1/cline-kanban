import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	readSourceGitWorkingStateSnapshot,
} from "../independent-task-creation/git-working-state-snapshot";
import { getGitStdout } from "../workspace/git-utils";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const refuse = (path: string) =>
	Object.assign(new Error(`还原暂存树含有未被恢复来源覆盖的工作，保留现场：${path}`), {
		code: "KANBAN_RESTORATION_WORKSPACE_CONTAINS_UNPRESERVED_WORK",
	});

/** 中断写入可留下原载荷的前缀；额外路径、其他内容和独有提交均不能当成临时文件删除。 */
export async function assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives(input: {
	worktreePath: string;
	archiveDirectory: string;
	workspacePath: string;
	sourceWorktreePath: string | null;
}) {
	const snapshot = await readSourceGitWorkingStateSnapshot(input.archiveDirectory);
	const [head, common, expectedCommon, indexPath] = await Promise.all([
		getGitStdout(["rev-parse", "HEAD"], input.worktreePath),
		getGitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], input.worktreePath),
		getGitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], input.workspacePath),
		getGitStdout(["rev-parse", "--path-format=absolute", "--git-path", "index"], input.worktreePath),
	]);
	if (head !== snapshot.headCommit || common !== expectedCommon) throw refuse(input.worktreePath);
	const expectedEntries = new Map(
		snapshot.entries.filter((entry) => entry.kind !== "absent").map((entry) => [entry.path, entry]),
	);
	const expectedDirectories = new Set<string>();
	for (const path of expectedEntries.keys())
		for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) expectedDirectories.add(parent);
	let sourceConfirmed = false;
	const expectedContent = async (path: string, expectedHash: string, kind: string) => {
		let content = await readFile(join(input.archiveDirectory, "working-files", path));
		if (hash(content) !== expectedHash && input.sourceWorktreePath) {
			if (!sourceConfirmed) {
				await assertSourceGitWorkingStateMatchesSnapshot(input.sourceWorktreePath, input.archiveDirectory);
				sourceConfirmed = true;
			}
			content =
				kind === "symlink"
					? Buffer.from(await readlink(join(input.sourceWorktreePath, path)))
					: await readFile(join(input.sourceWorktreePath, path));
		}
		if (hash(content) !== expectedHash) throw refuse(path);
		return content;
	};
	const inspect = async (directory: string, prefix = "") => {
		for (const name of await readdir(directory)) {
			if (!prefix && name === ".git") continue;
			const path = prefix ? `${prefix}/${name}` : name;
			const absolute = join(directory, name);
			const info = await lstat(absolute);
			if (info.isDirectory() && !info.isSymbolicLink()) {
				if (!expectedDirectories.has(path)) throw refuse(path);
				await inspect(absolute, path);
				continue;
			}
			const expected = expectedEntries.get(path);
			if (!expected || (expected.kind === "symlink" ? !info.isSymbolicLink() : !info.isFile())) throw refuse(path);
			const original = await expectedContent(path, expected.hash, expected.kind);
			const actual = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
			if (
				actual.length > original.length ||
				!actual.equals(original.subarray(0, actual.length)) ||
				(info.isSymbolicLink() && actual.length !== original.length)
			)
				throw refuse(path);
		}
	};
	await inspect(input.worktreePath);
	let index: Buffer;
	try {
		index = await readFile(indexPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let original: Buffer;
	try {
		original = await readFile(join(input.archiveDirectory, "source-git-index"));
	} catch {
		throw refuse(indexPath);
	}
	if (
		hash(original) !== snapshot.indexHash ||
		index.length > original.length ||
		!index.equals(original.subarray(0, index.length))
	)
		throw refuse(indexPath);
}
