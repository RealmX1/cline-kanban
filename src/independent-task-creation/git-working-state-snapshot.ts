import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { createGitProcessEnv } from "../core/git-process-env";
import { getGitStdout } from "../workspace/git-utils";

const snapshotSchema = z.object({
	headCommit: z.string(),
	gitCommonDirectory: z.string(),
	indexHash: z.string(),
	sharedIndexName: z.string().nullable(),
	objectPackHash: z.string().optional(),
	sourceHadUncommittedChanges: z.boolean().default(false),
	entries: z.array(
		z.object({ path: z.string(), kind: z.enum(["file", "symlink", "absent"]), hash: z.string(), mode: z.number() }),
	),
});
export type SourceGitWorkingStateSnapshot = z.infer<typeof snapshotSchema>;

const fingerprint = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
const gitReadOptions = () => ({ trimStdout: false, env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }) });
const git = async (cwd: string, args: string[]) =>
	await getGitStdout(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], cwd, gitReadOptions());

async function assertSafeParentDirectories(root: string, path: string): Promise<string> {
	if (isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === ".." || part === ".git")) {
		throw new Error("Git 快照包含不安全路径。");
	}
	const destination = resolve(root, path);
	if (!relative(resolve(root), destination) || relative(resolve(root), destination).startsWith(`..${sep}`)) {
		throw new Error("Git 快照路径超出任务目录。");
	}
	let parent = dirname(destination);
	while (parent !== resolve(root)) {
		try {
			if ((await lstat(parent)).isSymbolicLink()) throw new Error(`路径父目录是符号链接，无法安全复制：${path}`);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
		parent = dirname(parent);
	}
	return destination;
}

async function fingerprintFile(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function transferGitObjectPack(repoPath: string, packPath: string, revisions?: string[]) {
	const child = spawn(
		"git",
		revisions ? ["pack-objects", "--stdout", "--revs", "--threads=1"] : ["index-pack", "--stdin"],
		{
			cwd: repoPath,
			env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }),
			stdio: ["pipe", "pipe", "pipe"],
			signal: AbortSignal.timeout(120_000),
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${String(chunk)}`.slice(-4000);
	});
	const exited = new Promise<void>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.stdin.once("error", rejectExit);
		child.once("close", (code) =>
			code === 0 ? resolveExit() : rejectExit(new Error(`Git 对象快照处理失败：${stderr}`)),
		);
	});
	try {
		if (revisions) {
			child.stdin.end(`${revisions.join("\n")}\n`);
			await Promise.all([exited, pipeline(child.stdout, createWriteStream(packPath))]);
		} else {
			child.stdout.resume();
			await Promise.all([exited, pipeline(createReadStream(packPath), child.stdin)]);
		}
	} catch (error) {
		child.kill("SIGKILL");
		await exited.catch(() => {});
		throw error;
	}
}

export async function restoreSourceGitObjectSnapshot(repoPath: string, artifactDirectory: string) {
	const snapshot = await readSourceGitWorkingStateSnapshot(artifactDirectory);
	if (!snapshot.objectPackHash) throw new Error("来源快照缺少持久 Git 对象，无法证明完整恢复。");
	const common = (await git(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	if (common !== snapshot.gitCommonDirectory) throw new Error("来源 Git 对象快照属于另一仓库。");
	const path = join(artifactDirectory, "source-git-objects.pack");
	if ((await fingerprintFile(path)) !== snapshot.objectPackHash) throw new Error("持久 Git 对象快照校验失败。");
	await transferGitObjectPack(repoPath, path);
}

async function inspectEntry(root: string, path: string) {
	const absolutePath = await assertSafeParentDirectories(root, path);
	try {
		const info = await lstat(absolutePath);
		if (info.isSymbolicLink()) {
			const content = await readlink(absolutePath);
			return { kind: "symlink" as const, content, hash: fingerprint(content), mode: info.mode };
		}
		if (info.isDirectory()) {
			// HEAD 中的文件可能已被工作目录中的目录替代；目录内容由各 Git 路径单独保存。
			return { kind: "absent" as const, content: "", hash: "", mode: 0 };
		}
		if (!info.isFile()) throw new Error(`暂不支持复制 Git 子模块或特殊文件：${path}`);
		const content = await readFile(absolutePath);
		return { kind: "file" as const, content, hash: fingerprint(content), mode: info.mode };
	} catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		return { kind: "absent" as const, content: "", hash: "", mode: 0 };
	}
}

async function readSnapshotIdentity(sourcePath: string) {
	const [head, common, indexPath, shared, cached, committed, untracked, unmerged, stages] = await Promise.all([
		git(sourcePath, ["rev-parse", "HEAD"]),
		git(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		git(sourcePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
		git(sourcePath, ["rev-parse", "--shared-index-path"]),
		git(sourcePath, ["ls-files", "--cached", "-z"]),
		git(sourcePath, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
		git(sourcePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
		git(sourcePath, ["ls-files", "--unmerged"]),
		git(sourcePath, ["ls-files", "--stage"]),
	]);
	if (unmerged.trim()) throw new Error("来源任务存在尚未解决的 Git 冲突，请解决后再复制。");
	if (/^160000 /mu.test(stages)) throw new Error("来源包含 Git 子模块，暂不支持完整复制其独立工作状态。");
	const paths = [...new Set(`${cached}${committed}${untracked}`.split("\0").filter(Boolean))].sort();
	return { head: head.trim(), common: common.trim(), indexPath: indexPath.trim(), shared: shared.trim(), paths };
}

export async function captureSourceGitWorkingState(sourcePath: string, artifactDirectory: string) {
	const identity = await readSnapshotIdentity(sourcePath);
	const index = await readFile(identity.indexPath);
	await mkdir(join(artifactDirectory, "working-files"), { recursive: true });
	const entries: SourceGitWorkingStateSnapshot["entries"] = [];
	for (const path of identity.paths) {
		const entry = await inspectEntry(sourcePath, path);
		entries.push({ path, kind: entry.kind, hash: entry.hash, mode: entry.mode });
		if (entry.kind === "absent") continue;
		const target = await assertSafeParentDirectories(join(artifactDirectory, "working-files"), path);
		await mkdir(dirname(target), { recursive: true });
		// 符号链接在快照中以链接文本保存，避免交接目录自身出现可穿越的链接。
		await writeFile(target, entry.content);
	}
	await writeFile(join(artifactDirectory, "source-git-index"), index);
	if (identity.shared)
		await copyFile(resolve(sourcePath, identity.shared), join(artifactDirectory, "source-git-shared-index"));
	// HEAD 历史和暂存 blob 一并归档，来源清理或 gc 后仍能恢复；pack-objects 不修改来源。
	const stagedObjects = (await git(sourcePath, ["ls-files", "--stage", "-z"])).split("\0").flatMap((entry) => {
		const objectId = entry.match(/^\d+ ([a-f0-9]+) /u)?.[1];
		return objectId && !/^0+$/u.test(objectId) ? [objectId] : [];
	});
	const objectPackPath = join(artifactDirectory, "source-git-objects.pack");
	await transferGitObjectPack(sourcePath, objectPackPath, [identity.head, ...new Set(stagedObjects)]);
	const after = await readSnapshotIdentity(sourcePath);
	if (
		identity.head !== after.head ||
		JSON.stringify(identity.paths) !== JSON.stringify(after.paths) ||
		fingerprint(await readFile(after.indexPath)) !== fingerprint(index)
	) {
		throw new Error("复制期间来源 Git 状态发生变化，请等写入结束后重试。");
	}
	for (const entry of entries) {
		const current = await inspectEntry(sourcePath, entry.path);
		if (entry.hash !== current.hash || entry.kind !== current.kind || entry.mode !== current.mode) {
			throw new Error("复制期间来源文件发生变化，请等写入结束后重试。");
		}
	}
	const snapshot: SourceGitWorkingStateSnapshot = {
		headCommit: identity.head,
		gitCommonDirectory: identity.common,
		indexHash: fingerprint(index),
		sharedIndexName: identity.shared ? basename(identity.shared) : null,
		objectPackHash: await fingerprintFile(objectPackPath),
		sourceHadUncommittedChanges: Boolean((await git(sourcePath, ["status", "--porcelain=v1"])).trim()),
		entries,
	};
	await writeFile(join(artifactDirectory, "git-working-state.json"), JSON.stringify(snapshot));
	return snapshot;
}

export async function readSourceGitWorkingStateSnapshot(artifactDirectory: string) {
	return snapshotSchema.parse(JSON.parse(await readFile(join(artifactDirectory, "git-working-state.json"), "utf8")));
}

export async function restoreSourceGitWorkingState(targetPath: string, artifactDirectory: string) {
	const snapshot = await readSourceGitWorkingStateSnapshot(artifactDirectory);
	await restoreSourceGitObjectSnapshot(targetPath, artifactDirectory);
	const identity = await readSnapshotIdentity(targetPath);
	if (identity.common !== snapshot.gitCommonDirectory || identity.head !== snapshot.headCommit) {
		throw new Error("目标 worktree 的仓库或起始提交与来源快照不一致，未应用复制。");
	}
	for (const entry of snapshot.entries
		.filter((entry) => entry.kind === "absent")
		.sort((a, b) => b.path.length - a.path.length)) {
		const target = await assertSafeParentDirectories(targetPath, entry.path);
		try {
			await rm(target, { force: true, recursive: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
		}
	}
	for (const entry of snapshot.entries.filter((entry) => entry.kind !== "absent")) {
		const target = await assertSafeParentDirectories(targetPath, entry.path);
		const content = await readFile(join(artifactDirectory, "working-files", entry.path));
		if (fingerprint(content) !== entry.hash) throw new Error("持久 Git 快照校验失败。");
		await mkdir(dirname(target), { recursive: true });
		await rm(target, { force: true, recursive: true });
		if (entry.kind === "symlink") await symlink(content.toString(), target);
		else {
			await writeFile(target, content);
			await chmod(target, entry.mode & 0o777);
		}
	}
	const index = await readFile(join(artifactDirectory, "source-git-index"));
	if (fingerprint(index) !== snapshot.indexHash) throw new Error("持久 Git index 快照校验失败。");
	if (snapshot.sharedIndexName)
		await copyFile(
			join(artifactDirectory, "source-git-shared-index"),
			join(dirname(identity.indexPath), snapshot.sharedIndexName),
		);
	await writeFile(identity.indexPath, index);
}
