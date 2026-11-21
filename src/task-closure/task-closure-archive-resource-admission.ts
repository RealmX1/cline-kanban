import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { estimateSourceGitWorkingStateStorageRequirements } from "../independent-task-creation/git-working-state-snapshot";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { readTaskClosureArchiveAndGitRepositoryWriteVolumes } from "./task-closure-archive-and-git-repository-write-volumes";
import {
	getTaskClosureAutomaticRecoveryState,
	TaskClosureRecoveryPrerequisiteError,
} from "./task-closure-automatic-recovery-policy";
import {
	assertTaskClosureLifecycleNotCancelled,
	ensurePrivateTaskClosureArtifactDirectory,
	type TaskClosureOperation,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";
import {
	measureTaskClosureOwnedDirectoryBytes,
	TASK_CLOSURE_MANAGED_PAYLOAD_DIRECTORY_NAME_PATTERN,
} from "./task-closure-owned-directory-storage-byte-measurement";

export async function prepareTaskClosureArchiveStorageLimits(operation: TaskClosureOperation) {
	if (operation.archiveStorageLimits) return operation.archiveStorageLimits;
	let sizes: { maximumArchivePayloadBytes: number; maximumRestorationWorkspaceBytes: number };
	let sourceExists = false;
	if (operation.sourceWorktreePath) {
		try {
			sourceExists = (await lstat(operation.sourceWorktreePath)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (sourceExists && operation.sourceWorktreePath)
		sizes = await estimateSourceGitWorkingStateStorageRequirements(
			operation.sourceWorktreePath,
			operation.request.closure?.selectedArtifactRelativePaths ?? [],
		);
	else {
		const manifest = operation.archiveRepairManifest ?? operation.archiveManifest;
		const bytes =
			manifest?.availability === "verified_recoverable"
				? await measureTaskClosureOwnedDirectoryBytes(manifest.archiveDirectory)
				: 0;
		sizes = {
			maximumArchivePayloadBytes: bytes + 1024 * 1024,
			maximumRestorationWorkspaceBytes: bytes + 1024 * 1024,
		};
	}
	operation.archiveStorageLimits = { ...sizes, minimumRemainingVolumeStorageBytes: 1024 * 1024 * 1024 };
	operation.schemaVersion = 2;
	await writeTaskClosureOperation(operation);
	return operation.archiveStorageLimits;
}

export async function withTaskClosureArchiveVolumeAdmission<T>(
	operation: TaskClosureOperation,
	restoringOnly: boolean,
	action: () => Promise<T>,
) {
	const root = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const limits = await prepareTaskClosureArchiveStorageLimits(operation);
	const volumes = await readTaskClosureArchiveAndGitRepositoryWriteVolumes(operation);
	return lockedFileSystem.withLocks(
		volumes.map((volume) => ({
			type: "directory" as const,
			path: join(getRuntimeHomePath(), "task-closure-volume-write-locks", String(volume.deviceId)),
		})),
		async () => {
			await assertTaskClosureLifecycleNotCancelled(operation);
			let retainedBytes = 0;
			for (const name of await readdir(root)) {
				if (TASK_CLOSURE_MANAGED_PAYLOAD_DIRECTORY_NAME_PATTERN.test(name))
					retainedBytes += await measureTaskClosureOwnedDirectoryBytes(join(root, name));
			}
			const reservation =
				limits.maximumRestorationWorkspaceBytes + (restoringOnly ? 0 : limits.maximumArchivePayloadBytes);
			if (
				retainedBytes + reservation >
				2 * limits.maximumArchivePayloadBytes + limits.maximumRestorationWorkspaceBytes
			)
				throw new TaskClosureRecoveryPrerequisiteError(
					"storage_limit_exceeded",
					"本请求的保留载荷已达到冻结的体积上限；未创建新副本。",
				);
			const required = reservation + limits.minimumRemainingVolumeStorageBytes;
			getTaskClosureAutomaticRecoveryState(operation).minimumRequiredAvailableStorageBytes = required;
			await writeTaskClosureOperation(operation);
			for (const volume of volumes) {
				const disk = await statfs(volume.path);
				if (disk.bavail * disk.bsize < required)
					throw new TaskClosureRecoveryPrerequisiteError(
						"insufficient_storage_space",
						`目标卷余量不足（${volume.path}），需至少 ${required} 字节；未开始复制。`,
					);
			}
			return action();
		},
	);
}

export async function withTaskClosureLifecycleCancellationSignal<T>(
	operation: TaskClosureOperation,
	action: (signal: AbortSignal) => Promise<T>,
) {
	const controller = new AbortController();
	let checking: Promise<void> | null = null;
	const timer = setInterval(() => {
		checking ??= assertTaskClosureLifecycleNotCancelled(operation)
			.catch((error: unknown) => {
				controller.abort(error);
			})
			.finally(() => {
				checking = null;
			});
	}, 250);
	timer.unref();
	try {
		await assertTaskClosureLifecycleNotCancelled(operation);
		const result = await action(controller.signal);
		await assertTaskClosureLifecycleNotCancelled(operation);
		return result;
	} finally {
		clearInterval(timer);
		await checking;
	}
}
