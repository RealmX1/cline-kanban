import { createHash } from "node:crypto";
import { lchmod, lstat, mkdir, open, readdir, rm, statfs, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { TaskClosureAutomaticRecoveryState } from "../core/task-closure-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import {
	estimateSourceGitWorkingStateStorageRequirements,
	readSourceGitWorkingStateCaptureInventory,
	readSourceGitWorkingStateSnapshot,
} from "../independent-task-creation/git-working-state-snapshot";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import {
	hasSameProcessGeneration,
	observeOwnedProcessGenerations,
	readSystemBootIdentity,
} from "../task-command-execution/task-command-execution-supervisor";
import { createTaskConversationSessionOperationStore } from "../task-conversation-sessions/task-conversation-session-operation-store";
import { readTaskClosureArchiveAndGitRepositoryWriteVolumes } from "./task-closure-archive-and-git-repository-write-volumes";
import { fingerprintTaskClosureArchivePayload } from "./task-closure-archive-payload-integrity";
import { ensurePrivateTaskClosureArtifactDirectory, type TaskClosureOperation } from "./task-closure-operation-store";
import {
	measureTaskClosureOwnedDirectoryBytes,
	TASK_CLOSURE_MANAGED_PAYLOAD_DIRECTORY_NAME_PATTERN,
} from "./task-closure-owned-directory-storage-byte-measurement";
import { assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives } from "./task-closure-restoration-worktree-preservation-guard";

type TaskClosureFailureClassification = NonNullable<TaskClosureAutomaticRecoveryState["failureClassification"]>;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// 修改恢复算法时升级此值；运行时启动代次和普通版本号不能充当修复证据。
export const TASK_CLOSURE_ARCHIVE_RESTORATION_PROTOCOL_REVISION = 2;

export async function readTaskClosureRecoveryEvidence(
	operation: TaskClosureOperation,
	classification: TaskClosureFailureClassification,
): Promise<{ fingerprint: string; prerequisiteSatisfied: boolean; provesRelevantRepair: boolean }> {
	if (classification === "archive_payload_integrity_failed") {
		const archive = operation.archiveRepairManifest ?? operation.archiveManifest;
		if (!archive?.archivePayloadIntegritySha256)
			return {
				fingerprint: "archive_integrity_reference_unavailable",
				prerequisiteSatisfied: false,
				provesRelevantRepair: false,
			};
		try {
			const current = await fingerprintTaskClosureArchivePayload(archive.archiveDirectory);
			const verified = current.archivePayloadIntegritySha256 === archive.archivePayloadIntegritySha256;
			return {
				fingerprint: fingerprint([classification, current.archivePayloadIntegritySha256]),
				prerequisiteSatisfied: verified,
				provesRelevantRepair: verified,
			};
		} catch {
			return {
				fingerprint: "archive_payload_unreadable",
				prerequisiteSatisfied: false,
				provesRelevantRepair: false,
			};
		}
	}
	if (classification === "restoration_workspace_contains_unpreserved_work") {
		const root = await ensurePrivateTaskClosureArtifactDirectory(
			operation.taskIdentity,
			operation.progress.closureRequestId,
		);
		const archive =
			operation.archiveRepairManifest?.archiveDirectory ??
			operation.archiveManifest?.archiveDirectory ??
			join(root, "preserved-git-working-state-payload");
		try {
			for (const name of ["archive-restoration-verification-worktree", "reopening-archive-restoration-worktree"]) {
				const path = join(root, name);
				try {
					await lstat(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				await assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives({
					worktreePath: path,
					archiveDirectory: archive,
					workspacePath: operation.workspacePath,
					sourceWorktreePath: operation.sourceWorktreePath,
				});
			}
			return {
				fingerprint: "staging_preservation_proof_available",
				prerequisiteSatisfied: true,
				provesRelevantRepair: true,
			};
		} catch {
			return {
				fingerprint: "staging_preservation_proof_unavailable",
				prerequisiteSatisfied: false,
				provesRelevantRepair: false,
			};
		}
	}
	if (classification === "explicit_execution_stop_still_effective") {
		const board = await loadWorkspaceBoardById(operation.taskIdentity.workspaceId);
		const card = board.columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === operation.taskIdentity.taskId);
		const stopped = (
			await createTaskConversationSessionOperationStore().read({
				workspaceId: operation.taskIdentity.workspaceId,
				workspacePath: operation.workspacePath,
			})
		).explicitlyStoppedSessionIds;
		const blocked = !card || [card.id, resolveMainTaskConversationSessionId(card)].some((id) => stopped.includes(id));
		return {
			fingerprint: fingerprint([classification, blocked]),
			prerequisiteSatisfied: !blocked,
			provesRelevantRepair: false,
		};
	}
	if (classification === "insufficient_storage_space") {
		const state =
			operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)
				? operation.reopening.automaticRecovery
				: operation.progress.automaticRecovery;
		const volumes = await readTaskClosureArchiveAndGitRepositoryWriteVolumes(operation);
		if (state && state.minimumRequiredAvailableStorageBytes === null && operation.sourceWorktreePath) {
			const sizes = await estimateSourceGitWorkingStateStorageRequirements(
				operation.sourceWorktreePath,
				operation.request.closure?.selectedArtifactRelativePaths ?? [],
			);
			state.minimumRequiredAvailableStorageBytes =
				sizes.maximumArchivePayloadBytes +
				sizes.maximumRestorationWorkspaceBytes +
				(operation.archiveStorageLimits?.minimumRemainingVolumeStorageBytes ?? 1024 * 1024 * 1024);
		}
		const required = state?.minimumRequiredAvailableStorageBytes ?? null;
		const observations = await Promise.all(
			volumes.map(async (volume) => {
				const disk = await statfs(volume.path);
				return { deviceId: volume.deviceId, satisfied: required !== null && disk.bavail * disk.bsize >= required };
			}),
		);
		const satisfied = observations.every((observation) => observation.satisfied);
		return {
			fingerprint: fingerprint([classification, observations]),
			prerequisiteSatisfied: satisfied,
			provesRelevantRepair: false,
		};
	}
	if (classification === "storage_limit_exceeded") {
		const limits = operation.archiveStorageLimits;
		if (!limits)
			return {
				fingerprint: "storage_limits_unavailable",
				prerequisiteSatisfied: false,
				provesRelevantRepair: false,
			};
		const root = await ensurePrivateTaskClosureArtifactDirectory(
			operation.taskIdentity,
			operation.progress.closureRequestId,
		);
		let retainedBytes = 0;
		for (const name of await readdir(root))
			if (TASK_CLOSURE_MANAGED_PAYLOAD_DIRECTORY_NAME_PATTERN.test(name))
				retainedBytes += await measureTaskClosureOwnedDirectoryBytes(join(root, name));
		const reservation =
			limits.maximumRestorationWorkspaceBytes + (operation.reopening ? 0 : limits.maximumArchivePayloadBytes);
		const available =
			retainedBytes + reservation <= 2 * limits.maximumArchivePayloadBytes + limits.maximumRestorationWorkspaceBytes;
		const source = operation.sourceWorktreePath
			? await readSourceGitWorkingStateCaptureInventory(
					operation.sourceWorktreePath,
					operation.request.closure?.selectedArtifactRelativePaths ?? [],
				)
			: operation.archiveManifest;
		return {
			fingerprint: fingerprint([classification, available, source]),
			prerequisiteSatisfied: available,
			provesRelevantRepair: false,
		};
	}
	if (classification === "owned_process_exit_unconfirmed") {
		const observations = await readTaskClosureOwnedProcessExitEvidence(operation);
		return {
			fingerprint: fingerprint(observations),
			prerequisiteSatisfied: observations.every((value) => value === "exited"),
			provesRelevantRepair: false,
		};
	}
	if (classification === "source_working_state_changed") {
		if (!operation.sourceWorktreePath)
			return { fingerprint: "missing_source", prerequisiteSatisfied: false, provesRelevantRepair: false };
		const inventory = await readSourceGitWorkingStateCaptureInventory(
			operation.sourceWorktreePath,
			operation.request.closure?.selectedArtifactRelativePaths ?? [],
		);
		return { fingerprint: fingerprint(inventory), prerequisiteSatisfied: true, provesRelevantRepair: false };
	}
	if (classification === "archive_restoration_verification_failed") {
		const root = await ensurePrivateTaskClosureArtifactDirectory(
			operation.taskIdentity,
			operation.progress.closureRequestId,
		);
		const state =
			operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)
				? operation.reopening.automaticRecovery
				: operation.progress.automaticRecovery;
		const failedPath = state?.lastFailureMessage?.match(/来源文件发生变化：([^\n]+)$/u)?.[1];
		let expectedSymlinkMode: number | null = null;
		if (failedPath)
			for (const directory of [
				operation.archiveRepairManifest?.archiveDirectory,
				operation.archiveManifest?.archiveDirectory,
				join(root, "preserved-git-working-state-payload"),
				join(root, "preserved-replacement-git-working-state-payload"),
				join(root, `preservation-attempt-${operation.progress.attemptCount}`),
			]) {
				if (!directory) continue;
				try {
					const snapshot = await readSourceGitWorkingStateSnapshot(directory);
					const entry = snapshot.entries.find((entry) => entry.path === failedPath && entry.kind === "symlink");
					if (entry) {
						expectedSymlinkMode = entry.mode & 0o7777;
						break;
					}
				} catch {
					/* 缺少相应原件时不能把通用能力变化说成相关修复。 */
				}
			}
		const probe = join(root, "symlink-permission-restoration-capability-probe");
		let restored = false;
		try {
			await rm(probe, { force: true });
			await symlink("nonexistent-capability-probe-target", probe);
			restored = true;
			if (process.platform === "darwin")
				for (const mode of [0o755, 0o700, ...(expectedSymlinkMode === null ? [] : [expectedSymlinkMode])]) {
					await lchmod(probe, mode);
					restored &&= ((await lstat(probe)).mode & 0o7777) === mode;
				}
		} finally {
			await rm(probe, { force: true });
		}
		return {
			fingerprint: fingerprint([
				classification,
				TASK_CLOSURE_ARCHIVE_RESTORATION_PROTOCOL_REVISION,
				restored,
				expectedSymlinkMode,
			]),
			prerequisiteSatisfied: restored,
			provesRelevantRepair: restored && expectedSymlinkMode !== null,
		};
	}
	if (classification === "archive_payload_persistence_failed") {
		const root = await ensurePrivateTaskClosureArtifactDirectory(
			operation.taskIdentity,
			operation.progress.closureRequestId,
		);
		const directory = join(root, "archive-persistence-capability-probe");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		let durable = false;
		try {
			const handle = await open(join(directory, "source-git-objects.pack"), "w", 0o600);
			try {
				await handle.writeFile("归档持久化能力探针");
				await handle.sync();
				for (const path of [directory, root]) {
					const directoryHandle = await open(path, "r");
					try {
						await directoryHandle.sync();
					} finally {
						await directoryHandle.close();
					}
				}
				durable = true;
			} finally {
				await handle.close();
			}
		} catch {
			durable = false;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		return {
			fingerprint: fingerprint([classification, durable]),
			prerequisiteSatisfied: durable,
			provesRelevantRepair: durable,
		};
	}
	if (classification === "temporary_io_failure") {
		return { fingerprint: "bounded_transient_io_retry", prerequisiteSatisfied: true, provesRelevantRepair: false };
	}
	return {
		fingerprint: fingerprint([classification, TASK_CLOSURE_ARCHIVE_RESTORATION_PROTOCOL_REVISION]),
		prerequisiteSatisfied: true,
		provesRelevantRepair: false,
	};
}

export async function readTaskClosureOwnedProcessExitEvidence(operation: TaskClosureOperation) {
	if (!operation.processIdsAwaitingExit?.length) return [];
	const boot = await readSystemBootIdentity();
	const originalIdentities = operation.ownedProcessIdentitiesAwaitingExit ?? [];
	const observations = await observeOwnedProcessGenerations(
		(operation.processIdsAwaitingExit ?? []).map(
			(pid) =>
				originalIdentities.find((identity) => identity.pid === pid) ?? {
					pid,
					startAndCommand: "original_process_generation_unavailable",
				},
		),
	);
	return Promise.all(
		(operation.processIdsAwaitingExit ?? []).map(async (pid) => {
			if (
				boot &&
				operation.systemBootIdentityAtProcessCapture &&
				boot !== operation.systemBootIdentityAtProcessCapture
			)
				return "exited";
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return "exited";
				return "unknown";
			}
			const expected = originalIdentities.find((identity) => identity.pid === pid);
			const current = observations.find((observation) => observation.expected.pid === pid)?.current;
			if (current === null) return "exited";
			if (!expected || !current || current === "unreadable") return "unknown";
			return hasSameProcessGeneration(current, expected) ? "live" : "exited";
		}),
	);
}
