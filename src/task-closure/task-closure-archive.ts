import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	type TaskClosureArchiveManifest,
	taskClosureArchiveManifestSchema,
	taskClosureQualifiedTaskReferenceSchema,
} from "../core/task-closure-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
	readSourceGitWorkingStateSnapshot,
	restoreSourceGitObjectSnapshot,
	restoreSourceGitWorkingState,
	type SourceGitWorkingStateSnapshot,
} from "../independent-task-creation/git-working-state-snapshot";
import { getGitStdout } from "../workspace/git-utils";
import { fingerprintTaskClosureArchivePayload } from "./task-closure-archive-payload-integrity";
import {
	withTaskClosureArchiveVolumeAdmission,
	withTaskClosureLifecycleCancellationSignal,
} from "./task-closure-archive-resource-admission";
import {
	beginTaskClosureAutomaticSideEffect,
	completeTaskClosureAutomaticSideEffect,
	getTaskClosureAutomaticRecoveryState,
	TaskClosureRecoveryPrerequisiteError,
} from "./task-closure-automatic-recovery-policy";
import {
	assertTaskClosureLifecycleNotCancelled,
	ensurePrivateTaskClosureArtifactDirectory,
	readTaskClosureOperation,
	type TaskClosureOperation,
	taskClosureIdentityKey,
	taskClosureOperationDirectory,
	taskClosureOperationsRoot,
	taskClosureVerifiedArchivePublicationReceiptPath,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";
import { assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives } from "./task-closure-restoration-worktree-preservation-guard";
import { reclaimRedundantUnverifiedTaskClosureCandidate } from "./task-closure-unverified-candidate-reclamation";

const archivePublicationReceiptSchema = z.object({
	taskIdentity: taskClosureQualifiedTaskReferenceSchema,
	closureRequestId: z.string().uuid(),
	archiveManifest: taskClosureArchiveManifestSchema,
});

export async function recoverVerifiedTaskClosureArchiveManifest(
	operation: TaskClosureOperation,
	purpose: "closure_archive_candidate" | "damaged_archive_replacement" = "closure_archive_candidate",
) {
	const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
	const path = taskClosureVerifiedArchivePublicationReceiptPath(operation, purpose === "damaged_archive_replacement");
	let receipt: z.infer<typeof archivePublicationReceiptSchema>;
	try {
		receipt = archivePublicationReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const expected = join(
		root,
		purpose === "damaged_archive_replacement"
			? "preserved-replacement-git-working-state-payload"
			: "preserved-git-working-state-payload",
	);
	if (
		taskClosureIdentityKey(receipt.taskIdentity) !== taskClosureIdentityKey(operation.taskIdentity) ||
		receipt.closureRequestId !== operation.progress.closureRequestId ||
		receipt.archiveManifest.archiveDirectory !== expected
	)
		throw new Error("已验证归档的持久回执归属不一致，保留来源。");
	const current = await fingerprintTaskClosureArchivePayload(expected);
	if (current.archivePayloadIntegritySha256 !== receipt.archiveManifest.archivePayloadIntegritySha256)
		throw new TaskClosureRecoveryPrerequisiteError(
			"archive_payload_integrity_failed",
			"已验证归档的持久回执与当前载荷不一致。",
		);
	return receipt.archiveManifest;
}

async function persistVerifiedTaskClosureArchivePublication(
	operation: TaskClosureOperation,
	archiveManifest: TaskClosureArchiveManifest,
	purpose: "closure_archive_candidate" | "damaged_archive_replacement",
) {
	const path = taskClosureVerifiedArchivePublicationReceiptPath(operation, purpose === "damaged_archive_replacement");
	const receipt = {
		taskIdentity: operation.taskIdentity,
		closureRequestId: operation.progress.closureRequestId,
		archiveManifest,
	};
	await lockedFileSystem.withLocks([{ type: "file", path }], async () => {
		try {
			const previous: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!isDeepStrictEqual(previous, receipt)) throw new Error("已验证归档回执不可覆盖，保留原归档。");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(receipt), {
			durable: true,
			fileMode: 0o600,
			lock: null,
		});
	});
}

/** 发布回执先于主操作保存；重启只补齐已经完成的事实，不再创建还原树或消耗次数。 */
export async function reconcileTaskClosureVerifiedArchivePublication(operation: TaskClosureOperation) {
	const state = operation.reopening ? operation.reopening.automaticRecovery : operation.progress.automaticRecovery;
	const purpose =
		state?.pendingSideEffect === "repair_archive" ? "damaged_archive_replacement" : "closure_archive_candidate";
	if (
		state?.pendingSideEffect !== "repair_archive" &&
		(operation.archiveManifest || state?.pendingSideEffect !== "preserve_archive")
	)
		return false;
	const manifest = await recoverVerifiedTaskClosureArchiveManifest(operation, purpose);
	if (!manifest) return false;
	await assertTaskClosureLifecycleNotCancelled(operation);
	if (purpose === "damaged_archive_replacement") operation.archiveRepairManifest = manifest;
	else {
		operation.archiveManifest = manifest;
		operation.progress.phase = "archive_verified";
	}
	await completeTaskClosureAutomaticSideEffect(operation);
	await writeTaskClosureOperation(operation);
	return true;
}

async function flushTaskClosureArchiveContentsAndParentDirectories(archiveDirectory: string) {
	async function flushPath(path: string) {
		const info = await lstat(path);
		if (info.isDirectory()) for (const entry of await readdir(path)) await flushPath(join(path, entry));
		else if (!info.isFile()) throw new Error("成果归档包含无法持久化的特殊文件。");
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
	try {
		await flushPath(archiveDirectory);
		for (let path = dirname(archiveDirectory); ; path = dirname(path)) {
			await flushFileOrDirectory(path);
			if (path === dirname(taskClosureOperationsRoot()) || path === dirname(path)) break;
		}
	} catch (cause) {
		throw new TaskClosureRecoveryPrerequisiteError(
			"archive_payload_persistence_failed",
			`归档持久化失败：${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
}

export function resolveTaskClosureArchiveManifest(operation: TaskClosureOperation) {
	return operation.archiveRepairManifest ?? operation.archiveManifest;
}

async function verifyTaskClosureArchiveByRestoring(
	operation: TaskClosureOperation,
	archiveDirectory: string,
	headCommit: string,
	signal?: AbortSignal,
) {
	const root = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const target = join(root, "archive-restoration-verification-worktree");
	await removeOwnedRestorationWorktreeIfPresent(operation, target, archiveDirectory);
	await restoreSourceGitObjectSnapshot(operation.workspacePath, archiveDirectory);
	await getGitStdout(
		["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--no-checkout", target, headCommit],
		operation.workspacePath,
	);
	try {
		await restoreSourceGitWorkingState(
			target,
			archiveDirectory,
			operation.archiveStorageLimits
				? {
						maximumPayloadBytes: operation.archiveStorageLimits.maximumRestorationWorkspaceBytes,
						signal,
					}
				: undefined,
		);
		await assertSourceGitWorkingStateMatchesSnapshot(target, archiveDirectory);
	} catch (cause) {
		throw new TaskClosureRecoveryPrerequisiteError(
			"archive_restoration_verification_failed",
			`归档还原验证失败：${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	} finally {
		await removeOwnedRestorationWorktreeIfPresent(operation, target, archiveDirectory);
	}
}

async function removeOwnedRestorationWorktreeIfPresent(
	operation: TaskClosureOperation,
	path: string,
	archiveDirectory: string,
	claimReclamationBeforeRemoval?: () => Promise<void>,
) {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("还原工作树的归属路径已变化，保留现场。");
		const common = await getGitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
		const expectedCommon = await getGitStdout(
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			operation.workspacePath,
		);
		if (common !== expectedCommon) throw new Error("还原工作树属于另一仓库，未清理。");
		await assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives({
			worktreePath: path,
			archiveDirectory,
			workspacePath: operation.workspacePath,
			sourceWorktreePath: operation.sourceWorktreePath,
		});
		await claimReclamationBeforeRemoval?.();
		await getGitStdout(["worktree", "remove", "--force", path], operation.workspacePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function reclaimCancelledTaskClosureRestorationWorktrees(operation: TaskClosureOperation) {
	const state = operation.progress.unverifiedCandidateReclamation;
	if (!state) return;
	const root = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	for (const name of ["archive-restoration-verification-worktree", "reopening-archive-restoration-worktree"]) {
		const path = join(root, name);
		try {
			await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (path === operation.sourceWorktreePath) throw new Error("还原暂存路径与来源重叠，未回收。");
		const archive = resolveTaskClosureArchiveManifest(operation);
		const archiveDirectory = archive?.archiveDirectory ?? join(root, "preserved-git-working-state-payload");
		if (archive?.archivePayloadIntegritySha256) await assertTaskClosureArchivePayloadIsRecoverable(operation);
		else if (operation.sourceWorktreePath)
			await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath, archiveDirectory);
		else throw new Error("暂存树缺少已验证的替代恢复来源，保留现场。");
		await removeOwnedRestorationWorktreeIfPresent(operation, path, archiveDirectory, async () => {
			if (state.automaticAttemptCount >= 3) throw new Error("暂存自动回收的三次执行机会已用尽，保留断点。");
			state.automaticAttemptCount += 1;
			await writeTaskClosureOperation(operation);
		});
	}
}

export async function assertTaskClosureArchivePayloadIsRecoverable(operation: TaskClosureOperation) {
	const latest = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
	if (
		latest?.archiveManifest?.archiveDirectory === operation.archiveManifest?.archiveDirectory &&
		latest?.archiveRepairManifest
	)
		operation.archiveRepairManifest = latest.archiveRepairManifest;
	const archive = resolveTaskClosureArchiveManifest(operation);
	if (!archive || archive.availability !== "verified_recoverable") throw new Error("缺少可恢复的任务归档。");
	const before = await fingerprintTaskClosureArchivePayload(archive.archiveDirectory);
	if (archive.archivePayloadIntegritySha256) {
		if (before.archivePayloadIntegritySha256 !== archive.archivePayloadIntegritySha256)
			throw new TaskClosureRecoveryPrerequisiteError("archive_payload_integrity_failed", "任务归档载荷校验失败。");
		return;
	}
	// 旧归档首次补做实际还原，不能仅靠现算 hash 声称历史已经验证。
	await beginTaskClosureAutomaticSideEffect(
		operation,
		"verify_legacy_archive",
		getTaskClosureAutomaticRecoveryState(operation).pendingSideEffect !== null,
	);
	await withTaskClosureArchiveVolumeAdmission(operation, true, async () => {
		const snapshot = await readSourceGitWorkingStateSnapshot(archive.archiveDirectory);
		if (snapshot.headCommit !== archive.headCommit) throw new Error("归档 HEAD 与保全清单不一致。");
		await verifyTaskClosureArchiveByRestoring(operation, archive.archiveDirectory, snapshot.headCommit);
		await flushTaskClosureArchiveContentsAndParentDirectories(archive.archiveDirectory);
		const after = await fingerprintTaskClosureArchivePayload(archive.archiveDirectory);
		if (before.archivePayloadIntegritySha256 !== after.archivePayloadIntegritySha256)
			throw new Error("归档验证期间载荷发生变化。");
		Object.assign(archive, after);
		await completeTaskClosureAutomaticSideEffect(operation);
		await writeTaskClosureOperation(operation);
	});
}

export async function captureAndVerifyTaskClosureArchive(
	operation: TaskClosureOperation,
	purpose: "closure_archive_candidate" | "damaged_archive_replacement" = "closure_archive_candidate",
): Promise<TaskClosureArchiveManifest> {
	const root = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const name =
		purpose === "damaged_archive_replacement"
			? "preserved-replacement-git-working-state-payload"
			: "preserved-git-working-state-payload";
	const directory = join(root, name);
	const selected = operation.request.closure?.selectedArtifactRelativePaths ?? [];
	if (!operation.sourceWorktreePath) {
		if (selected.length) throw new Error("任务工作树不存在，选定成果不可用，未执行清理。");
		return {
			archiveDirectory: directory,
			headCommit: null,
			persistentHeadReference: null,
			verifiedAtEpochMs: Date.now(),
			availability: "no_task_worktree",
			preservedFileCount: 0,
			selectedArtifactRelativePaths: selected,
		};
	}
	const published = await recoverVerifiedTaskClosureArchiveManifest(operation, purpose);
	if (published) {
		await assertTaskClosureLifecycleNotCancelled(operation);
		await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath, published.archiveDirectory);
		return published;
	}
	return withTaskClosureArchiveVolumeAdmission(operation, false, () =>
		withTaskClosureLifecycleCancellationSignal(operation, async (signal) => {
			const alreadyPublished = await recoverVerifiedTaskClosureArchiveManifest(operation, purpose);
			if (alreadyPublished) {
				await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath ?? "", directory);
				return alreadyPublished;
			}
			let snapshot: SourceGitWorkingStateSnapshot | null = null;
			try {
				snapshot = await readSourceGitWorkingStateSnapshot(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				let exists = false;
				try {
					await lstat(directory);
					exists = true;
				} catch (missing) {
					if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
				}
				if (exists) await reclaimRedundantUnverifiedTaskClosureCandidate(operation, name);
			}
			if (snapshot) await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath ?? "", directory);
			else
				snapshot = await captureSourceGitWorkingState(operation.sourceWorktreePath ?? "", directory, selected, {
					maximumPayloadBytes: operation.archiveStorageLimits?.maximumArchivePayloadBytes ?? 0,
					signal,
				});
			const reference = `refs/kanban/task-closure-archives/${taskClosureIdentityKey(operation.taskIdentity)}/${operation.progress.closureRequestId}/head`;
			await getGitStdout(["update-ref", reference, snapshot.headCommit], operation.workspacePath);
			const before = await fingerprintTaskClosureArchivePayload(directory);
			await verifyTaskClosureArchiveByRestoring(operation, directory, snapshot.headCommit, signal);
			await flushTaskClosureArchiveContentsAndParentDirectories(directory);
			const after = await fingerprintTaskClosureArchivePayload(directory);
			if (before.archivePayloadIntegritySha256 !== after.archivePayloadIntegritySha256)
				throw new Error("归档验证期间载荷发生变化。");
			await assertSourceGitWorkingStateMatchesSnapshot(operation.sourceWorktreePath ?? "", directory);
			const manifest: TaskClosureArchiveManifest = {
				archiveDirectory: directory,
				headCommit: snapshot.headCommit,
				persistentHeadReference: reference,
				verifiedAtEpochMs: Date.now(),
				availability: "verified_recoverable",
				preservedFileCount: snapshot.entries.filter((entry) => entry.kind !== "absent").length,
				selectedArtifactRelativePaths: selected,
				...after,
			};
			await persistVerifiedTaskClosureArchivePublication(operation, manifest, purpose);
			return manifest;
		}),
	);
}

export async function restoreVerifiedTaskClosureArchive(operation: TaskClosureOperation, worktreePath: string) {
	const latest = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
	if (latest && latest.archiveManifest?.archiveDirectory === operation.archiveManifest?.archiveDirectory)
		operation.archiveRepairManifest = latest.archiveRepairManifest;
	const archive = resolveTaskClosureArchiveManifest(operation);
	if (!archive || archive.availability !== "verified_recoverable" || !archive.verifiedAtEpochMs) return;
	const snapshot = await readSourceGitWorkingStateSnapshot(archive.archiveDirectory);
	if (snapshot.headCommit !== archive.headCommit) throw new Error("归档 HEAD 与保全清单不一致。");
	try {
		await lstat(worktreePath);
		await assertSourceGitWorkingStateMatchesSnapshot(worktreePath, archive.archiveDirectory);
		await reconcileTaskClosureCompletedArchiveRestoration(operation, worktreePath);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await assertTaskClosureArchivePayloadIsRecoverable(operation);
	if (operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase))
		await beginTaskClosureAutomaticSideEffect(operation, "restore_archive", true);
	await withTaskClosureArchiveVolumeAdmission(operation, true, () =>
		withTaskClosureLifecycleCancellationSignal(operation, async (signal) => {
			await restoreSourceGitObjectSnapshot(operation.workspacePath, archive.archiveDirectory);
			const restoration = join(
				taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
				"reopening-archive-restoration-worktree",
			);
			await removeOwnedRestorationWorktreeIfPresent(operation, restoration, archive.archiveDirectory);
			await getGitStdout(
				[
					"-c",
					"core.hooksPath=/dev/null",
					"worktree",
					"add",
					"--detach",
					"--no-checkout",
					restoration,
					snapshot.headCommit,
				],
				operation.workspacePath,
			);
			await restoreSourceGitWorkingState(restoration, archive.archiveDirectory, {
				maximumPayloadBytes: operation.archiveStorageLimits?.maximumRestorationWorkspaceBytes ?? 0,
				signal,
			});
			await assertSourceGitWorkingStateMatchesSnapshot(restoration, archive.archiveDirectory);
			await assertTaskClosureLifecycleNotCancelled(operation);
			await mkdir(dirname(worktreePath), { recursive: true });
			await getGitStdout(["worktree", "move", restoration, worktreePath], operation.workspacePath);
			await assertSourceGitWorkingStateMatchesSnapshot(worktreePath, archive.archiveDirectory);
		}),
	);
}

export async function reconcileTaskClosureCompletedArchiveRestoration(
	operation: TaskClosureOperation,
	worktreePath: string,
) {
	if (!operation.reopening || operation.reopening.automaticRecovery?.pendingSideEffect !== "restore_archive")
		return false;
	const archive = resolveTaskClosureArchiveManifest(operation);
	if (!archive || archive.availability !== "verified_recoverable") return false;
	try {
		await lstat(worktreePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	await assertSourceGitWorkingStateMatchesSnapshot(worktreePath, archive.archiveDirectory);
	await assertTaskClosureLifecycleNotCancelled(operation);
	await completeTaskClosureAutomaticSideEffect(operation);
	await writeTaskClosureOperation(operation);
	return true;
}

export async function reconcileTaskClosureCompletedSourceWorktreeRemoval(operation: TaskClosureOperation) {
	if (
		operation.reopening ||
		operation.progress.phase !== "closed_cleanup_pending" ||
		operation.progress.automaticRecovery?.pendingSideEffect !== "remove_source_worktree" ||
		!operation.sourceWorktreePath ||
		!resolveTaskClosureArchiveManifest(operation)?.archivePayloadIntegritySha256
	)
		return false;
	try {
		await lstat(operation.sourceWorktreePath);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await assertTaskClosureLifecycleNotCancelled(operation);
	await assertTaskClosureArchivePayloadIsRecoverable(operation);
	await completeTaskClosureAutomaticSideEffect(operation);
	await writeTaskClosureOperation(operation);
	return true;
}
