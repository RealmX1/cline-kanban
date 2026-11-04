import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { readSourceGitWorkingStateSnapshot } from "../../src/independent-task-creation/git-working-state-snapshot";
import { fingerprint } from "./experiment-contract";
import {
	assertIndependentGitRepository,
	assertOwnedExperimentRoot,
	createPrivateDirectory,
	executeGit,
	fingerprintFile,
	isWithin,
	safeEntryPath,
} from "./persistent-experiment-storage";

type SourceWorkingState = Awaited<ReturnType<typeof readSourceGitWorkingStateSnapshot>>;

async function existingEntry(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
		throw error;
	}
}

async function assertEntryMatches(repository: string, entry: SourceWorkingState["entries"][number]) {
	const path = await safeEntryPath(repository, entry.path);
	const info = await existingEntry(path);
	if (entry.kind === "absent") {
		if (info && !info.isDirectory()) throw new Error(`删除状态发生漂移：${entry.path}`);
		return;
	}
	if (!info || (entry.kind === "symlink" ? !info.isSymbolicLink() : !info.isFile()))
		throw new Error(`恢复路径种类发生漂移：${entry.path}`);
	const content = entry.kind === "symlink" ? await readlink(path) : await readFile(path);
	if (fingerprint(content) !== entry.hash || (entry.kind === "file" && (info.mode & 0o777) !== (entry.mode & 0o777)))
		throw new Error(`恢复路径内容或模式发生漂移：${entry.path}`);
}

async function verifyOriginalWorkingState(
	root: string,
	repository: string,
	snapshot: SourceWorkingState,
	archive: string,
) {
	const common = await assertIndependentGitRepository(root, repository);
	const head = (await executeGit(repository, ["rev-parse", "HEAD"])).toString().trim();
	const indexPath = (await executeGit(repository, ["rev-parse", "--path-format=absolute", "--git-path", "index"]))
		.toString()
		.trim();
	if (head !== snapshot.headCommit || (await fingerprintFile(indexPath)) !== snapshot.indexHash)
		throw new Error("恢复后的 HEAD 或原始 index 发生漂移；不覆盖既有工作");
	await assertOwnedExperimentRoot(root, indexPath);
	if (snapshot.sharedIndexName) {
		if (
			basename(snapshot.sharedIndexName) !== snapshot.sharedIndexName ||
			!snapshot.sharedIndexName.startsWith("sharedindex.")
		)
			throw new Error("split index 路径不安全");
		const sharedPath = (
			await executeGit(repository, ["rev-parse", "--path-format=absolute", "--git-path", snapshot.sharedIndexName])
		)
			.toString()
			.trim();
		await assertOwnedExperimentRoot(root, sharedPath);
		if ((await fingerprintFile(sharedPath)) !== (await fingerprintFile(join(archive, "source-git-shared-index"))))
			throw new Error("原始 split index 发生漂移；不覆盖既有工作");
	}
	for (const entry of snapshot.entries) await assertEntryMatches(repository, entry);
	const actualPaths = new Set(snapshot.entries.map((entry) => entry.path));
	for (const args of [
		["ls-files", "--cached", "-z"],
		["ls-tree", "-r", "--name-only", "-z", "HEAD"],
		["ls-files", "--others", "--exclude-standard", "-z"],
	]) {
		for (const path of (await executeGit(repository, args)).toString().split("\0").filter(Boolean))
			actualPaths.add(path);
	}
	if (actualPaths.size !== snapshot.entries.length) throw new Error("恢复工作树出现额外路径；不覆盖漂移");
	return { common, indexPath };
}

export async function restoreLinkedTaskWorktreeFromFrozenSnapshot(
	root: string,
	base: string,
	archive: string,
	repository: string,
	snapshot: SourceWorkingState,
) {
	const ownership = await assertOwnedExperimentRoot(root, repository);
	if (snapshot.gitCommonDirectory !== ownership.sourceCommonDirectory)
		throw new Error("任务档案不属于本恢复目录绑定的来源仓库");
	if (
		(await fingerprintFile(join(archive, "source-git-objects.pack"))) !== snapshot.objectPackHash ||
		(await fingerprintFile(join(archive, "source-git-index"))) !== snapshot.indexHash
	)
		throw new Error("任务对象包或原始 index 与冻结档案不一致");
	const common = await assertIndependentGitRepository(root, base);
	await executeGit(base, ["index-pack", "--stdin"], { inputPath: join(archive, "source-git-objects.pack") });
	if (!(await existingEntry(repository))) {
		await createPrivateDirectory(dirname(repository));
		await executeGit(base, ["worktree", "add", "--detach", "--no-checkout", repository, snapshot.headCommit]);
	}
	if ((await assertIndependentGitRepository(root, repository)) !== common)
		throw new Error("task 工作树未绑定本组私有 common-dir");
	if ((await executeGit(repository, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim() !== "HEAD")
		throw new Error("实验 task 必须保持 detached 身份");
	const gitDirectory = (await executeGit(repository, ["rev-parse", "--absolute-git-dir"])).toString().trim();
	if (!isWithin(common, gitDirectory) || resolve(common) === resolve(gitDirectory))
		throw new Error("task git-dir 不是组内独立 worktree 元数据");
	const indexPath = (await executeGit(repository, ["rev-parse", "--path-format=absolute", "--git-path", "index"]))
		.toString()
		.trim();
	if (await existingEntry(indexPath)) {
		// index 最后写入；已存在时只对账，不能把合法输入后的编辑/删除恢复成原件。
		await verifyOriginalWorkingState(root, repository, snapshot, archive);
		return gitDirectory;
	}
	for (const entry of snapshot.entries) {
		const path = await safeEntryPath(repository, entry.path);
		if (await existingEntry(path)) {
			await assertEntryMatches(repository, entry);
			continue;
		}
		if (entry.kind === "absent") continue;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const source = await safeEntryPath(join(archive, "working-files"), entry.path);
		if (entry.kind === "symlink") await symlink((await readFile(source)).toString(), path);
		else {
			await copyFile(source, path, constants.COPYFILE_EXCL);
			await chmod(path, entry.mode & 0o777);
		}
	}
	if (snapshot.sharedIndexName) {
		if (
			basename(snapshot.sharedIndexName) !== snapshot.sharedIndexName ||
			!snapshot.sharedIndexName.startsWith("sharedindex.")
		)
			throw new Error("split index 路径不安全");
		const sharedPath = (
			await executeGit(repository, ["rev-parse", "--path-format=absolute", "--git-path", snapshot.sharedIndexName])
		)
			.toString()
			.trim();
		if (!isWithin(gitDirectory, sharedPath)) throw new Error("split index 超出 task git-dir");
		if (!(await existingEntry(sharedPath)))
			await copyFile(join(archive, "source-git-shared-index"), sharedPath, constants.COPYFILE_EXCL);
		else if (
			(await fingerprintFile(sharedPath)) !== (await fingerprintFile(join(archive, "source-git-shared-index")))
		)
			throw new Error("split index 已漂移");
	}
	if (!(await existingEntry(indexPath)))
		await copyFile(join(archive, "source-git-index"), indexPath, constants.COPYFILE_EXCL);
	await verifyOriginalWorkingState(root, repository, snapshot, archive);
	return gitDirectory;
}
