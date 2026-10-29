import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskClosureArchiveManifest } from "../core/task-closure-contract";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
	readSourceGitWorkingStateSnapshot,
	restoreSourceGitObjectSnapshot,
	restoreSourceGitWorkingState,
} from "../independent-task-creation/git-working-state-snapshot";
import { getGitStdout } from "../workspace/git-utils";
import {
	ensurePrivateTaskClosureArtifactDirectory,
	type TaskClosureOperation,
	taskClosureIdentityKey,
	taskClosureOperationDirectory,
	taskClosureOperationsRoot,
} from "./task-closure-operation-store";

async function flushTaskClosureArchiveContentsAndParentDirectories(archiveDirectory: string) {
	async function flushPath(path: string) {
		const info = await lstat(path);
		if (info.isDirectory()) {
			for (const entry of await readdir(path)) await flushPath(join(path, entry));
		} else if (!info.isFile()) throw new Error("成果归档包含无法持久化的特殊文件。");
		await flushFileOrDirectory(path);
	}
	async function flushFileOrDirectory(path: string) {
		const handle = await open(path, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	await flushPath(archiveDirectory);
	// 同步各层目录项，包含新建私有根在 runtime 目录中的登记；不改变共享目录权限。
	for (let path = dirname(archiveDirectory); ; path = dirname(path)) {
		await flushFileOrDirectory(path);
		if (path === dirname(taskClosureOperationsRoot()) || path === dirname(path)) break;
	}
}

async function verifyTaskClosureArchiveByRestoring(
	operation: TaskClosureOperation,
	archiveDirectory: string,
	headCommit: string,
) {
	const artifactRoot = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const verificationWorktreePath = join(artifactRoot, "archive-restoration-verification-worktree");
	// 中断残留只属于本操作，不触碰来源；每次验证都重新从归档还原。
	try {
		await lstat(verificationWorktreePath);
		await getGitStdout(["worktree", "remove", "--force", verificationWorktreePath], operation.workspacePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await restoreSourceGitObjectSnapshot(operation.workspacePath, archiveDirectory);
	await getGitStdout(
		[
			"-c",
			"core.hooksPath=/dev/null",
			"worktree",
			"add",
			"--detach",
			"--no-checkout",
			verificationWorktreePath,
			headCommit,
		],
		operation.workspacePath,
	);
	try {
		await restoreSourceGitWorkingState(verificationWorktreePath, archiveDirectory);
		await assertSourceGitWorkingStateMatchesSnapshot(verificationWorktreePath, archiveDirectory);
	} finally {
		await getGitStdout(["worktree", "remove", "--force", verificationWorktreePath], operation.workspacePath);
	}
}

export async function assertTaskClosureArchivePayloadIsRecoverable(operation: TaskClosureOperation) {
	const archive = operation.archiveManifest;
	if (!archive || archive.availability !== "verified_recoverable") throw new Error("缺少可恢复的任务归档。");
	const snapshot = await readSourceGitWorkingStateSnapshot(archive.archiveDirectory);
	if (snapshot.headCommit !== archive.headCommit) throw new Error("归档 HEAD 与保全清单不一致。");
	await verifyTaskClosureArchiveByRestoring(operation, archive.archiveDirectory, snapshot.headCommit);
	await flushTaskClosureArchiveContentsAndParentDirectories(archive.archiveDirectory);
}

export async function captureAndVerifyTaskClosureArchive(
	operation: TaskClosureOperation,
): Promise<TaskClosureArchiveManifest> {
	const artifactRoot = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const archiveDirectory = join(artifactRoot, `preservation-attempt-${operation.progress.attemptCount}`);
	const selectedArtifactRelativePaths = operation.request.closure?.selectedArtifactRelativePaths ?? [];
	if (!operation.sourceWorktreePath) {
		if (selectedArtifactRelativePaths.length) throw new Error("任务工作树不存在，选定成果不可用，未执行清理。");
		return {
			archiveDirectory,
			headCommit: null,
			persistentHeadReference: null,
			verifiedAtEpochMs: Date.now(),
			availability: "no_task_worktree",
			preservedFileCount: 0,
			selectedArtifactRelativePaths,
		};
	}
	const snapshot = await captureSourceGitWorkingState(
		operation.sourceWorktreePath,
		archiveDirectory,
		selectedArtifactRelativePaths,
	);
	const persistentHeadReference = `refs/kanban/task-closure-archives/${taskClosureIdentityKey(operation.taskIdentity)}/${operation.progress.closureRequestId}/head`;
	await getGitStdout(["update-ref", persistentHeadReference, snapshot.headCommit], operation.workspacePath);
	await verifyTaskClosureArchiveByRestoring(operation, archiveDirectory, snapshot.headCommit);
	await flushTaskClosureArchiveContentsAndParentDirectories(archiveDirectory);
	await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath, archiveDirectory);
	return {
		archiveDirectory,
		headCommit: snapshot.headCommit,
		persistentHeadReference,
		verifiedAtEpochMs: Date.now(),
		availability: "verified_recoverable",
		preservedFileCount: snapshot.entries.filter((entry) => entry.kind !== "absent").length,
		selectedArtifactRelativePaths,
	};
}

export async function restoreVerifiedTaskClosureArchive(operation: TaskClosureOperation, worktreePath: string) {
	const archive = operation.archiveManifest;
	if (!archive || archive.availability !== "verified_recoverable" || !archive.verifiedAtEpochMs) return;
	const snapshot = await readSourceGitWorkingStateSnapshot(archive.archiveDirectory);
	if (snapshot.headCommit !== archive.headCommit) throw new Error("归档 HEAD 与保全清单不一致。");
	await restoreSourceGitObjectSnapshot(operation.workspacePath, archive.archiveDirectory);
	try {
		await lstat(worktreePath);
		// 清理失败留下的来源必须仍与归档一致；不覆盖后来新增的工作。
		await assertSourceGitWorkingStateMatchesSnapshot(worktreePath, archive.archiveDirectory);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// 只把完整还原且已核验的树移到任务路径；中断残留留在操作目录，可安全重建。
	const restorationWorktreePath = join(
		taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
		"reopening-archive-restoration-worktree",
	);
	try {
		await lstat(restorationWorktreePath);
		await getGitStdout(["worktree", "remove", "--force", restorationWorktreePath], operation.workspacePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await getGitStdout(
		[
			"-c",
			"core.hooksPath=/dev/null",
			"worktree",
			"add",
			"--detach",
			"--no-checkout",
			restorationWorktreePath,
			snapshot.headCommit,
		],
		operation.workspacePath,
	);
	await restoreSourceGitWorkingState(restorationWorktreePath, archive.archiveDirectory);
	await assertSourceGitWorkingStateMatchesSnapshot(restorationWorktreePath, archive.archiveDirectory);
	await mkdir(dirname(worktreePath), { recursive: true });
	await getGitStdout(["worktree", "move", restorationWorktreePath, worktreePath], operation.workspacePath);
	await assertSourceGitWorkingStateMatchesSnapshot(worktreePath, archive.archiveDirectory);
}
