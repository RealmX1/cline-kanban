import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { taskClosureQualifiedTaskReferenceSchema } from "../core/task-closure-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	assertSourceGitWorkingStateMatchesInventory,
	sourceGitWorkingStateSnapshotSchema,
} from "../independent-task-creation/git-working-state-snapshot";
import {
	ensurePrivateTaskClosureArtifactDirectory,
	listTaskClosureOperations,
	readTaskClosureHistory,
	type TaskClosureOperation,
	taskClosureOperationDirectory,
	taskClosureVerifiedArchivePublicationReceiptPath,
	writeTaskClosureOperation,
} from "./task-closure-operation-store";

import { measureTaskClosureOwnedDirectoryBytes } from "./task-closure-owned-directory-storage-byte-measurement";
import { assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives } from "./task-closure-unverified-payload-preservation-guard";

const candidateDirectoryIdentitySchema = z.object({
	deviceId: z.number(),
	inode: z.number(),
	createdAtEpochMs: z.number(),
});
const reclamationSchema = z.object({
	taskIdentity: taskClosureQualifiedTaskReferenceSchema,
	candidateDirectoryName: z.enum([
		"preserved-git-working-state-payload",
		"preserved-replacement-git-working-state-payload",
	]),
	sourceInventory: sourceGitWorkingStateSnapshotSchema,
	candidateDirectoryIdentity: candidateDirectoryIdentitySchema.optional(),
	completed: z.boolean(),
});

/** 仅回收新协议未受引用的候选；旧尝试及成功归档不属于自动回收范围。 */
export async function reclaimRedundantUnverifiedTaskClosureCandidate(
	operation: TaskClosureOperation,
	candidateDirectoryName: "preserved-git-working-state-payload" | "preserved-replacement-git-working-state-payload",
) {
	if (!operation.sourceWorktreePath) throw new Error("缺少来源，不能回收未验证载荷。");
	if ((await lstat(operation.sourceWorktreePath)).isSymbolicLink())
		throw new Error("来源根路径的归属已变化，未回收载荷。");
	await ensurePrivateTaskClosureArtifactDirectory(operation.taskIdentity, operation.progress.closureRequestId);
	const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
	const directory = join(root, candidateDirectoryName);
	try {
		await lstat(
			taskClosureVerifiedArchivePublicationReceiptPath(
				operation,
				candidateDirectoryName === "preserved-replacement-git-working-state-payload",
			),
		);
		throw new Error("候选仍受归档或历史引用，已验证发布回执禁止自动回收。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const receiptPath = join(root, `${candidateDirectoryName}-reclamation.json`);
	let receipt: z.infer<typeof reclamationSchema> | null = null;
	try {
		const previous = reclamationSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
		if (!previous.completed) receipt = previous;
		else {
			try {
				await lstat(directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!receipt) {
		const sourceInventory = sourceGitWorkingStateSnapshotSchema.parse(
			JSON.parse(await readFile(join(directory, "git-working-state-capture-inventory.json"), "utf8")),
		);
		const metadata = await lstat(directory);
		receipt = {
			taskIdentity: operation.taskIdentity,
			candidateDirectoryName,
			sourceInventory,
			completed: false,
			candidateDirectoryIdentity: {
				deviceId: metadata.dev,
				inode: metadata.ino,
				createdAtEpochMs: metadata.birthtimeMs,
			},
		};
	}
	if (
		JSON.stringify(receipt.taskIdentity) !== JSON.stringify(operation.taskIdentity) ||
		receipt.candidateDirectoryName !== candidateDirectoryName
	)
		throw new Error("候选回收记录归属不匹配，保留载荷。");
	const history = await readTaskClosureHistory(operation.taskIdentity);
	const operations = await listTaskClosureOperations(operation.taskIdentity);
	if (
		history.records.some((record) => record.archiveManifest.archiveDirectory === directory) ||
		operations.some(
			(entry) =>
				entry.archiveManifest?.archiveDirectory === directory ||
				entry.archiveRepairManifest?.archiveDirectory === directory,
		)
	)
		throw new Error("候选仍受归档或历史引用，未回收。");
	await assertSourceGitWorkingStateMatchesInventory(operation.sourceWorktreePath, receipt.sourceInventory);
	let reclamationAttemptClaimed = false;
	const assertCurrentCandidateIsCovered = async () => {
		const metadata = await lstat(directory);
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			!receipt?.candidateDirectoryIdentity ||
			!isDeepStrictEqual(receipt.candidateDirectoryIdentity, {
				deviceId: metadata.dev,
				inode: metadata.ino,
				createdAtEpochMs: metadata.birthtimeMs,
			})
		)
			throw new Error("候选目录实例改变或旧回收回执缺少实例证明，保留载荷。");
		if (
			!operation.archiveStorageLimits ||
			(await measureTaskClosureOwnedDirectoryBytes(directory)) >
				operation.archiveStorageLimits.maximumArchivePayloadBytes
		)
			throw new Error("候选缺少冻结的体积上界或当前载荷超出上界，保留载荷。");
		if (!reclamationAttemptClaimed) {
			if (operation.progress.unverifiedCandidateReclamation) {
				if (operation.progress.unverifiedCandidateReclamation.automaticAttemptCount >= 3)
					throw new Error("候选自动回收的三次执行机会已用尽，保留回收断点。");
				operation.progress.unverifiedCandidateReclamation.automaticAttemptCount += 1;
				await writeTaskClosureOperation(operation);
			}
			await lockedFileSystem.writeTextFileAtomic(receiptPath, JSON.stringify(receipt), {
				durable: true,
				fileMode: 0o600,
			});
			reclamationAttemptClaimed = true;
		}
		await assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives(
			directory,
			operation.sourceWorktreePath ?? "",
			receipt.sourceInventory,
		);
	};
	try {
		await assertCurrentCandidateIsCovered();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// 删除已完成但回执尚未保存时，只补记原目录缺失，不能删除同名的新目录。
		const stillPresent = await lstat(directory).catch((missing: NodeJS.ErrnoException) => {
			if (missing.code !== "ENOENT") throw missing;
			return null;
		});
		if (stillPresent) throw error;
		receipt.completed = true;
		await lockedFileSystem.writeTextFileAtomic(receiptPath, JSON.stringify(receipt), {
			durable: true,
			fileMode: 0o600,
		});
		return;
	}
	await assertSourceGitWorkingStateMatchesInventory(operation.sourceWorktreePath, receipt.sourceInventory);
	await assertCurrentCandidateIsCovered();
	await assertSourceGitWorkingStateMatchesInventory(operation.sourceWorktreePath, receipt.sourceInventory);
	try {
		await rm(directory, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	receipt.completed = true;
	await lockedFileSystem.writeTextFileAtomic(receiptPath, JSON.stringify(receipt), { durable: true, fileMode: 0o600 });
}

export async function reconcileCancelledTaskClosureCandidateReclamation(operation: TaskClosureOperation) {
	const state = operation.progress.unverifiedCandidateReclamation;
	if (!state || state.phase === "completed") return;
	try {
		const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
		for (const name of [
			"preserved-git-working-state-payload",
			"preserved-replacement-git-working-state-payload",
		] as const) {
			const path = join(root, name);
			if (
				operation.archiveManifest?.archiveDirectory === path ||
				operation.archiveRepairManifest?.archiveDirectory === path
			)
				continue;
			try {
				await lstat(
					taskClosureVerifiedArchivePublicationReceiptPath(
						operation,
						name === "preserved-replacement-git-working-state-payload",
					),
				);
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await lstat(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (state.automaticAttemptCount >= 3) throw new Error("候选自动回收的三次执行机会已用尽，保留回收断点。");
			await reclaimRedundantUnverifiedTaskClosureCandidate(operation, name);
		}
		state.phase = "completed";
		state.lastError = null;
	} catch (error) {
		state.phase = "waiting_for_recovery";
		state.lastError = error instanceof Error ? error.message : String(error);
	}
	await writeTaskClosureOperation(operation);
}
