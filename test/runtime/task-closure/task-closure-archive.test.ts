import {
	chmodSync,
	existsSync,
	lchmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LockedFileSystemModule from "../../../src/fs/locked-file-system";

// 保留真实 SQLite 互斥与 fsync，只把锁数据库绑定到 guarded runner 独占的测试目录。
vi.mock("../../../src/fs/locked-file-system", async (importOriginal) => {
	const actual = await importOriginal<typeof LockedFileSystemModule>();
	const guardedTestDirectory = process.env.TMPDIR;
	if (!guardedTestDirectory) throw new Error("必须通过 guarded runner 提供独占测试目录。");
	return { ...actual, lockedFileSystem: await actual.LockedFileSystem.forIsolatedTestDirectory(guardedTestDirectory) };
});

import type { RuntimeBoardData } from "../../../src/core/api-contract";
import type { TaskClosureRecord } from "../../../src/core/task-closure-contract";
import { getRuntimeHomePath } from "../../../src/state/runtime-home-path";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import {
	assertTaskClosureArchivePayloadIsRecoverable,
	captureAndVerifyTaskClosureArchive,
	reconcileTaskClosureCompletedArchiveRestoration,
	reconcileTaskClosureCompletedSourceWorktreeRemoval,
	reconcileTaskClosureVerifiedArchivePublication,
	recoverVerifiedTaskClosureArchiveManifest,
	restoreVerifiedTaskClosureArchive,
} from "../../../src/task-closure/task-closure-archive";
import {
	beginTaskClosureAutomaticSideEffect,
	getTaskClosureAutomaticRecoveryState,
	isTaskClosureAutomaticRecoveryEligible,
	recordTaskClosureAutomaticFailure,
} from "../../../src/task-closure/task-closure-automatic-recovery-policy";
import {
	listTaskClosureOperations,
	readTaskClosureHistory,
	readTaskClosureOperation,
	type TaskClosureOperation,
	taskClosureOperationDirectory,
	taskClosureOperationsRoot,
	taskClosureTaskDirectory,
	writeTaskClosureHistoryRecord,
	writeTaskClosureOperation,
} from "../../../src/task-closure/task-closure-operation-store";
import { assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives } from "../../../src/task-closure/task-closure-restoration-worktree-preservation-guard";
import { reclaimRedundantUnverifiedTaskClosureCandidate } from "../../../src/task-closure/task-closure-unverified-candidate-reclamation";
import { assertTaskWorktreeCleanupHasCurrentVerifiedArchive } from "../../../src/task-closure/task-worktree-verified-archive-cleanup-guard";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createClosurePreservationFixture } from "./task-closure-preservation-test-fixture";

const archiveFlushHarness = vi.hoisted(() => ({
	flushedPaths: [] as string[],
	failurePathSuffix: null as string | null,
	skipSymlinkModeRestoration: false,
	restorationWriteFailure: false,
	availableStorageBytes: null as number | null,
	reclamationRemovalFailure: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFsPromises>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			if (
				archiveFlushHarness.reclamationRemovalFailure &&
				String(args[0]).endsWith("preserved-git-working-state-payload")
			) {
				await actual.rm(join(String(args[0]), "git-working-state-capture-inventory.json"), { force: true });
				throw new Error("注入候选回收中断");
			}
			return actual.rm(...args);
		},
		statfs: async (...args: Parameters<typeof actual.statfs>) => {
			const disk = await actual.statfs(...args);
			return archiveFlushHarness.availableStorageBytes === null
				? disk
				: { ...disk, bavail: archiveFlushHarness.availableStorageBytes / Number(disk.bsize) };
		},
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			if (
				archiveFlushHarness.restorationWriteFailure &&
				String(args[0]).endsWith("reopening-archive-restoration-worktree/file.txt")
			)
				throw new Error("注入恢复写入中断");
			return actual.writeFile(...args);
		},
		lchmod: async (...args: Parameters<typeof actual.lchmod>) => {
			if (!archiveFlushHarness.skipSymlinkModeRestoration) await actual.lchmod(...args);
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				const path = String(args[0]);
				if (archiveFlushHarness.failurePathSuffix && path.endsWith(archiveFlushHarness.failurePathSuffix))
					throw new Error("注入归档 fsync 失败");
				await sync();
				archiveFlushHarness.flushedPaths.push(path);
			};
			return handle;
		},
	};
});
beforeEach(() => {
	archiveFlushHarness.flushedPaths.length = 0;
	archiveFlushHarness.failurePathSuffix = null;
	archiveFlushHarness.skipSymlinkModeRestoration = false;
	archiveFlushHarness.restorationWriteFailure = false;
	archiveFlushHarness.availableStorageBytes = null;
	archiveFlushHarness.reclamationRemovalFailure = false;
});
afterEach(() => vi.unstubAllEnvs());

function closureRecordForArchive(operation: TaskClosureOperation): TaskClosureRecord {
	if (!operation.archiveManifest || !operation.request.closure) throw new Error("测试尚未捕获归档");
	return {
		closureRequestId: operation.progress.closureRequestId,
		taskIdentity: operation.taskIdentity,
		details: operation.request.closure.details,
		recordedAtEpochMs: 2,
		actor: operation.intent.resolvedKanbanActor,
		eventKind: "closed",
		previousClosureRequestId: null,
		isCurrentlyClosed: true,
		archiveManifest: operation.archiveManifest,
	};
}

describe("结案归档的实际恢复验证", () => {
	it("还原树有 index 而归档对应原件缺失时，不能将暂存成果当成可删除衍生物", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		const manifest = await captureAndVerifyTaskClosureArchive(operation);
		rmSync(join(manifest.archiveDirectory, "source-git-index"));
		await expect(
			assertTaskClosureRestorationWorktreeContainsOnlySnapshotDerivatives({
				worktreePath: sourcePath,
				archiveDirectory: manifest.archiveDirectory,
				workspacePath: operation.workspacePath,
				sourceWorktreePath: null,
			}),
		).rejects.toMatchObject({ code: "KANBAN_RESTORATION_WORKSPACE_CONTAINS_UNPRESERVED_WORK" });
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});
	it("第三次清理已删除来源但回执丢失，核验成功归档后补记且不新增删除机会", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		operation.progress.phase = "closed_cleanup_pending";
		Object.assign(getTaskClosureAutomaticRecoveryState(operation), {
			automaticAttemptCount: 2,
			pendingSideEffect: "remove_source_worktree",
		});
		await beginTaskClosureAutomaticSideEffect(operation, "remove_source_worktree");
		await deleteTaskWorktree({ repoPath: operation.workspacePath, taskId: operation.taskIdentity.taskId });
		expect(await reconcileTaskClosureCompletedSourceWorktreeRemoval(operation)).toBe(true);
		expect(operation.progress.automaticRecovery).toMatchObject({ automaticAttemptCount: 3, pendingSideEffect: null });
		expect(existsSync(operation.archiveManifest.archiveDirectory)).toBe(true);
	});
	it("只有确因余量不足等待的请求在安全阈值恢复后补试，64 MiB 波动不能发放机会", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.progress.attemptCount = 0;
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		archiveFlushHarness.availableStorageBytes = 0;
		try {
			await captureAndVerifyTaskClosureArchive(operation);
			throw new Error("应拒绝不足余量");
		} catch (error) {
			await recordTaskClosureAutomaticFailure(operation, error);
		}
		expect(operation.progress.automaticRecovery?.failureClassification).toBe("insufficient_storage_space");
		for (const available of [64 * 1024 * 1024, 0, 128 * 1024 * 1024]) {
			archiveFlushHarness.availableStorageBytes = available;
			expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(false);
		}
		expect(operation.progress.automaticRecovery?.automaticAttemptCount).toBe(1);
		archiveFlushHarness.availableStorageBytes = 1024 ** 4;
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(true);
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		expect((await captureAndVerifyTaskClosureArchive(operation)).availability).toBe("verified_recoverable");
		expect(operation.progress.automaticRecovery?.automaticAttemptCount).toBe(2);
	});
	it("归档载荷恢复到原完整性凭据后可自动接续，损坏期间不执行补试", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		await beginTaskClosureAutomaticSideEffect(operation, "remove_source_worktree");
		const path = join(operation.archiveManifest.archiveDirectory, "working-files/file.txt");
		const original = readFileSync(path);
		writeFileSync(path, "注入损坏");
		try {
			await assertTaskClosureArchivePayloadIsRecoverable(operation);
			throw new Error("应拒绝损坏归档");
		} catch (error) {
			await recordTaskClosureAutomaticFailure(operation, error);
		}
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(false);
		writeFileSync(path, original);
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(true);
	});
	it("第三次复开已还原但完成记录未保存，按原内容补证且不重新消耗次数", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		await deleteTaskWorktree({ repoPath: operation.workspacePath, taskId: operation.taskIdentity.taskId });
		operation.reopening = {
			request: { taskId: operation.taskIdentity.taskId },
			intent: operation.intent,
			phase: "restoring_archive",
			startedAtEpochMs: Date.now(),
			sourceTaskUpdatedAtEpochMs: 1,
			lastError: null,
		};
		Object.assign(getTaskClosureAutomaticRecoveryState(operation), {
			automaticAttemptCount: 2,
			pendingSideEffect: "restore_archive",
		});
		await restoreVerifiedTaskClosureArchive(operation, sourcePath);
		const resumed = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
		if (!resumed) throw new Error("复开操作未持久化");
		expect(resumed.reopening?.automaticRecovery?.automaticAttemptCount).toBe(3);
		archiveFlushHarness.availableStorageBytes = 0;
		expect(await reconcileTaskClosureCompletedArchiveRestoration(resumed, sourcePath)).toBe(true);
		await restoreVerifiedTaskClosureArchive(resumed, sourcePath);
		expect(resumed.reopening?.automaticRecovery).toMatchObject({ automaticAttemptCount: 3, pendingSideEffect: null });
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});
	it("最后一次验证后主回执未保存就退出，重启采用发布回执且不再复制或补发次数", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.progress.attemptCount = 2;
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		const manifest = await captureAndVerifyTaskClosureArchive(operation);
		const resumed = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
		if (!resumed) throw new Error("测试操作未持久化");
		expect(resumed.archiveManifest).toBeNull();
		await expect(
			reclaimRedundantUnverifiedTaskClosureCandidate(resumed, "preserved-git-working-state-payload"),
		).rejects.toThrow("发布回执");
		archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
		archiveFlushHarness.availableStorageBytes = 0;
		expect(await reconcileTaskClosureVerifiedArchivePublication(resumed)).toBe(true);
		expect(resumed.archiveManifest).toEqual(manifest);
		expect(resumed.progress.automaticRecovery).toMatchObject({
			automaticAttemptCount: 3,
			pendingSideEffect: null,
			repairSupplementConsumed: false,
		});
		expect(await captureAndVerifyTaskClosureArchive(resumed)).toEqual(manifest);
	});
	it("发布回执不能把损坏载荷重新认定为成功，保留来源与原回执", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		const manifest = await captureAndVerifyTaskClosureArchive(operation);
		writeFileSync(join(manifest.archiveDirectory, "working-files/file.txt"), "注入归档损坏");
		await expect(recoverVerifiedTaskClosureArchiveManifest(operation)).rejects.toThrow("持久回执与当前载荷不一致");
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("持久回执与当前载荷不一致");
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});
	it.each(["extra_file", "modified_working_file", "replaced_directory"] as const)(
		"回收拒绝含有来源未覆盖内容的候选：%s",
		async (scenario) => {
			const { operation, sourcePath } = await createClosurePreservationFixture();
			archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
			await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("fsync 失败");
			const directory = join(
				taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
				"preserved-git-working-state-payload",
			);
			if (scenario === "replaced_directory") {
				archiveFlushHarness.reclamationRemovalFailure = true;
				await expect(
					reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload"),
				).rejects.toThrow("回收中断");
				archiveFlushHarness.reclamationRemovalFailure = false;
				rmSync(directory, { recursive: true });
				mkdirSync(directory);
			}
			const uniquePath =
				scenario === "modified_working_file"
					? join(directory, "working-files", "file.txt")
					: join(directory, "uniquely-recovered-artifact.txt");
			writeFileSync(uniquePath, "只能从候选恢复的独有成果");
			await expect(
				reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload"),
			).rejects.toThrow(/保留|未覆盖/u);
			expect(readFileSync(uniquePath, "utf8")).toBe("只能从候选恢复的独有成果");
			expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
		},
	);
	it("候选回收中断丢失原目录清单后，仍用持久回收回执接续且不删来源", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("fsync 失败");
		archiveFlushHarness.reclamationRemovalFailure = true;
		await expect(
			reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload"),
		).rejects.toThrow("回收中断");
		archiveFlushHarness.reclamationRemovalFailure = false;
		await reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload");
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});
	it("对象证明同因失败前即持久扣回收次数，冷重读三次后停止且不累积证明文件", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("fsync 失败");
		operation.progress.unverifiedCandidateReclamation = {
			phase: "pending",
			automaticAttemptCount: 0,
			lastError: null,
		};
		await writeTaskClosureOperation(operation);
		const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
		const candidate = join(root, "preserved-git-working-state-payload");
		writeFileSync(join(candidate, "source-git-objects.pack"), "损坏的 pack，必须保留");
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const resumed = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
			if (!resumed) throw new Error("回收请求未持久化");
			await expect(
				reclaimRedundantUnverifiedTaskClosureCandidate(resumed, "preserved-git-working-state-payload"),
			).rejects.toThrow(attempt <= 3 ? /保留/u : /三次执行机会已用尽/u);
			const persisted = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
			expect(persisted?.progress.unverifiedCandidateReclamation?.automaticAttemptCount).toBe(Math.min(attempt, 3));
			expect(
				JSON.parse(readFileSync(join(root, "preserved-git-working-state-payload-reclamation.json"), "utf8")),
			).toMatchObject({ completed: false, candidateDirectoryName: "preserved-git-working-state-payload" });
			expect(readdirSync(root).some((name) => name.startsWith("unverified-payload-object-coverage-"))).toBe(false);
			expect(readFileSync(join(candidate, "source-git-objects.pack"), "utf8")).toBe("损坏的 pack，必须保留");
		}
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});
	it("不足的卷余量不会开始复制，字节上限阻止大文件并可安全回收不完整候选", async () => {
		const { sourcePath, operation } = await createClosurePreservationFixture();
		archiveFlushHarness.availableStorageBytes = 0;
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("未开始复制");
		const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
		expect(existsSync(join(root, "preserved-git-working-state-payload"))).toBe(false);
		archiveFlushHarness.availableStorageBytes = null;
		writeFileSync(join(sourcePath, "oversized-untracked-artifact.bin"), Buffer.alloc(64 * 1024, 7));
		operation.archiveStorageLimits = {
			maximumArchivePayloadBytes: 8192,
			maximumRestorationWorkspaceBytes: 1024 * 1024,
			minimumRemainingVolumeStorageBytes: 0,
		};
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("字节上限");
		await reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload");
		await reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload");
		expect(existsSync(join(root, "preserved-git-working-state-payload"))).toBe(false);
		expect(readFileSync(join(sourcePath, "oversized-untracked-artifact.bin"))).toEqual(Buffer.alloc(64 * 1024, 7));
	});

	it("来源漂移时保留未验证的唯一载荷，成功归档也不能作为冗余候选回收", async () => {
		const { sourcePath, operation } = await createClosurePreservationFixture();
		archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("fsync 失败");
		writeFileSync(join(sourcePath, "file.txt"), "之后产生的新工作");
		await expect(
			reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload"),
		).rejects.toThrow("保留载荷");
		const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
		expect(readFileSync(join(root, "preserved-git-working-state-payload", "working-files", "file.txt"), "utf8")).toBe(
			"仅此一份的未暂存成果\n",
		);
		writeFileSync(join(sourcePath, "file.txt"), "仅此一份的未暂存成果\n");
		archiveFlushHarness.failurePathSuffix = null;
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		await writeTaskClosureOperation(operation);
		await expect(
			reclaimRedundantUnverifiedTaskClosureCandidate(operation, "preserved-git-working-state-payload"),
		).rejects.toThrow("仍受归档或历史引用");
	});
	it.skipIf(process.platform !== "darwin")("真实软链权限失败后复用同一候选，后续尝试不再保留第二份副本", async () => {
		const originalUmask = process.umask(0o022);
		try {
			const { sourcePath, operation } = await createClosurePreservationFixture();
			symlinkSync("file.txt", join(sourcePath, "release-link"));
			lchmodSync(join(sourcePath, "release-link"), 0o700);
			archiveFlushHarness.skipSymlinkModeRestoration = true;
			await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("来源文件发生变化");
			const root = taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId);
			const candidates = () =>
				readdirSync(root).filter((name) => /preservation-attempt-|preserved-git-working-state-payload/u.test(name));
			expect(candidates()).toHaveLength(1);
			const packPath = join(root, candidates()[0] ?? "", "source-git-objects.pack");
			const capturedPackInode = statSync(packPath).ino;
			archiveFlushHarness.skipSymlinkModeRestoration = false;
			operation.progress.attemptCount += 1;
			operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
			expect(candidates()).toHaveLength(1);
			expect(statSync(join(operation.archiveManifest.archiveDirectory, "source-git-objects.pack")).ino).toBe(
				capturedPackInode,
			);
		} finally {
			process.umask(originalUmask);
		}
	});
	it("umask 022 下先收紧私有归档父目录，保持共享 runtime 权限并恢复 0600 文件", async () => {
		const originalUmask = process.umask(0o022);
		try {
			const { sourcePath, operation } = await createClosurePreservationFixture();
			chmodSync(join(sourcePath, "file.txt"), 0o600);
			const runtimeDirectoryMode = statSync(getRuntimeHomePath()).mode & 0o777;
			mkdirSync(taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId), {
				recursive: true,
				mode: 0o755,
			});
			operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
			await writeTaskClosureOperation(operation);
			await writeTaskClosureHistoryRecord(closureRecordForArchive(operation));
			for (const directory of [
				taskClosureOperationsRoot(),
				taskClosureTaskDirectory(operation.taskIdentity),
				taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
			])
				expect(statSync(directory).mode & 0o777).toBe(0o700);
			expect(statSync(getRuntimeHomePath()).mode & 0o777).toBe(runtimeDirectoryMode);
			expect(
				statSync(
					join(
						taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
						"operation.json",
					),
				).mode & 0o777,
			).toBe(0o600);
			await deleteTaskWorktree({ repoPath: operation.workspacePath, taskId: operation.taskIdentity.taskId });
			await restoreVerifiedTaskClosureArchive(operation, sourcePath);
			expect(statSync(join(sourcePath, "file.txt")).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(originalUmask);
		}
	});

	it("合法大写 UUID 可从全部操作、任务操作和持久历史扫描恢复", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		await writeTaskClosureOperation(operation);
		const record = closureRecordForArchive(operation);
		await writeTaskClosureHistoryRecord(record);
		expect(await listTaskClosureOperations()).toEqual([operation]);
		expect(await listTaskClosureOperations(operation.taskIdentity)).toEqual([operation]);
		expect((await readTaskClosureHistory(operation.taskIdentity)).records).toEqual([record]);
		const { details, ...recordWithoutDetails } = record;
		await writeTaskClosureHistoryRecord({ details, ...recordWithoutDetails });
		await expect(
			writeTaskClosureHistoryRecord({ ...record, details: { ...details, reason: "不可覆盖的另一判断" } }),
		).rejects.toThrow("只允许追加");
	});

	it("发放凭据前同步所有工作文件、index、对象包、快照及祖先目录；同步失败不发放凭据", async () => {
		const { sourcePath, operation } = await createClosurePreservationFixture();
		archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
		await expect(captureAndVerifyTaskClosureArchive(operation)).rejects.toThrow("fsync 失败");
		expect(operation.archiveManifest).toBeNull();
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
		archiveFlushHarness.failurePathSuffix = null;
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		const directory = operation.archiveManifest.archiveDirectory;
		for (const relativePath of [
			"working-files/file.txt",
			"working-files",
			"source-git-index",
			"source-git-objects.pack",
			"git-working-state.json",
			"",
		])
			expect(archiveFlushHarness.flushedPaths).toContain(join(directory, relativePath));
		for (const path of [
			dirname(directory),
			taskClosureTaskDirectory(operation.taskIdentity),
			taskClosureOperationsRoot(),
			getRuntimeHomePath(),
		])
			expect(archiveFlushHarness.flushedPaths).toContain(path);
	});

	it.each(["working-files/file.txt", "source-git-index", "source-git-objects.pack"])(
		"清理恢复前发现 %s 损坏，修复失败时保留来源，成功重新保全后才允许删除",
		async (damagedRelativePath) => {
			const { sourcePath, operation } = await createClosurePreservationFixture();
			operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
			operation.progress.phase = "closed_cleanup_pending";
			await writeTaskClosureOperation(operation);
			const record = closureRecordForArchive(operation);
			const board: RuntimeBoardData = {
				columns: [
					{
						id: "trash",
						title: "已结案",
						cards: [
							{
								id: "abc12",
								title: "归档",
								prompt: "归档",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 2,
								taskClosureSummary: record,
							},
						],
					},
				],
			};
			const assertCleanup = () =>
				assertTaskWorktreeCleanupHasCurrentVerifiedArchive({
					workspaceId: operation.taskIdentity.workspaceId,
					taskId: "abc12",
					worktreePath: sourcePath,
					board,
					credential: {
						closureRequestId: operation.progress.closureRequestId,
						taskIncarnationCreatedAtEpochMs: 1,
					},
				});
			writeFileSync(join(operation.archiveManifest.archiveDirectory, damagedRelativePath), "损坏的归档");
			await expect(assertTaskClosureArchivePayloadIsRecoverable(operation)).rejects.toThrow("校验失败");
			archiveFlushHarness.failurePathSuffix = "source-git-objects.pack";
			await expect(assertCleanup()).rejects.toThrow("fsync 失败");
			expect(existsSync(sourcePath)).toBe(true);
			archiveFlushHarness.failurePathSuffix = null;
			await assertCleanup();
			await assertTaskClosureArchivePayloadIsRecoverable(operation);
			const removed = await deleteTaskWorktree({
				repoPath: operation.workspacePath,
				taskId: "abc12",
				assertCleanupStillAuthorizedBeforeRemoval: assertCleanup,
			});
			expect(removed.removed).toBe(true);
			await restoreVerifiedTaskClosureArchive(operation, sourcePath);
			expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
		},
	);

	it("Git 元数据损坏时 ensure 保留唯一成果；已结案任务不能通过 ensure 重建目录", async () => {
		const { repo, sourcePath, operation } = await createClosurePreservationFixture();
		rmSync(join(sourcePath, ".git"));
		const failed = await ensureTaskWorktreeIfDoesntExist({
			cwd: repo.repositoryPath,
			taskId: "abc12",
			baseRef: "main",
		});
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("已保留全部内容");
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
		const boardDirectory = getWorkspaceDirectoryPath(operation.taskIdentity.workspaceId);
		mkdirSync(boardDirectory, { recursive: true });
		writeFileSync(
			join(boardDirectory, "board.json"),
			JSON.stringify({
				columns: [
					{
						id: "trash",
						title: "已结案",
						cards: [
							{
								id: "abc12",
								title: "归档",
								prompt: "归档",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 2,
							},
						],
					},
				],
			}),
		);
		const closed = await ensureTaskWorktreeIfDoesntExist({
			cwd: repo.repositoryPath,
			taskId: "abc12",
			baseRef: "main",
		});
		expect(closed.ok).toBe(false);
		expect(closed.error).toContain("先通过归档重开");
		expect(readFileSync(join(sourcePath, "file.txt"), "utf8")).toBe("仅此一份的未暂存成果\n");
	});

	it("detached 独有提交、暂存与工作区、ignored 成果经清理和 GC 后仍完整恢复", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		const repo = fixture.createNonBareRepository({
			repositoryDirectoryName: "closure-source",
			initialBranchName: "main",
		});
		writeFileSync(join(repo.repositoryPath, "file.txt"), "base\n");
		writeFileSync(join(repo.repositoryPath, "renamed-from.txt"), "rename\n");
		writeFileSync(join(repo.repositoryPath, ".gitignore"), "reports/\n");
		repo.commitAllRepositoryFilesAtDate({ message: "初始版本", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
		const source = await ensureTaskWorktreeIfDoesntExist({
			cwd: repo.repositoryPath,
			taskId: "abc12",
			baseRef: "main",
		});
		expect(source.ok).toBe(true);
		if (!source.path) throw new Error(source.error ?? "隔离工作树创建失败");
		const git = (args: string[]) => repo.runGit(args, { workingDirectoryPath: source.path }).stdout;
		git(["switch", "--detach"]);
		writeFileSync(join(source.path, "unique.txt"), "唯一提交\n");
		git(["add", "unique.txt"]);
		git(["commit", "-m", "独有成果"]);
		writeFileSync(join(source.path, "file.txt"), "staged\n");
		git(["add", "file.txt"]);
		writeFileSync(join(source.path, "file.txt"), "unstaged\n");
		git(["mv", "renamed-from.txt", "renamed-to.txt"]);
		writeFileSync(join(source.path, "binary.bin"), Buffer.from([0, 255, 0, 7]));
		symlinkSync("renamed-to.txt", join(source.path, "report-link"));
		mkdirSync(join(source.path, "reports"));
		writeFileSync(join(source.path, "reports", "accepted.md"), "已接受的调查\n");
		const before = git(["--no-optional-locks", "status", "--porcelain=v1"]);
		const operation: TaskClosureOperation = {
			schemaVersion: 1,
			taskIdentity: { workspaceId: "test-closure", taskId: "abc12", taskIncarnationCreatedAtEpochMs: 1 },
			workspacePath: repo.repositoryPath,
			sourceWorktreePath: source.path,
			sourceBoardColumnId: "review",
			sourceTaskUpdatedAtEpochMs: 1,
			request: {
				taskId: "abc12",
				closure: {
					closureRequestId: "11111111-1111-4111-8111-111111111111",
					details: { outcome: "plan_retired", reason: "采用后继方案", evidence: [], acceptedDeliverables: [] },
					selectedArtifactRelativePaths: ["reports"],
				},
			},
			intent: {
				taskMutationIntentKind: "close_task",
				resolvedKanbanActor: {
					kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
					missingEnvironmentVariableNames: [],
				},
			},
			progress: {
				closureRequestId: "11111111-1111-4111-8111-111111111111",
				phase: "preserving",
				attemptCount: 1,
				lastError: null,
				nextRetryAtEpochMs: null,
				recoveryCondition: null,
			},
			archiveManifest: null,
			closureRecord: null,
			lastAttemptRuntimeInstanceId: null,
			lastRecoveryProbeFingerprint: null,
		};
		operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
		expect(operation.archiveManifest.availability).toBe("verified_recoverable");
		expect(git(["--no-optional-locks", "status", "--porcelain=v1"])).toBe(before);
		expect((await deleteTaskWorktree({ repoPath: repo.repositoryPath, taskId: "abc12" })).removed).toBe(true);
		repo.runGit(["reflog", "expire", "--expire=now", "--all"]);
		repo.runGit(["gc", "--prune=now"]);
		const interruptedRestoration = join(
			taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
			"reopening-archive-restoration-worktree",
		);
		const archivedWorkingFile = join(operation.archiveManifest.archiveDirectory, "working-files", "file.txt");
		const completeArchivedContent = readFileSync(archivedWorkingFile);
		writeFileSync(archivedWorkingFile, "注入归档读入故障");
		await expect(restoreVerifiedTaskClosureArchive(operation, source.path)).rejects.toThrow("校验失败");
		expect(existsSync(source.path)).toBe(false);
		expect(existsSync(interruptedRestoration)).toBe(false);
		writeFileSync(archivedWorkingFile, completeArchivedContent);
		archiveFlushHarness.restorationWriteFailure = true;
		await expect(restoreVerifiedTaskClosureArchive(operation, source.path)).rejects.toThrow("注入恢复写入中断");
		expect(existsSync(interruptedRestoration)).toBe(true);
		archiveFlushHarness.restorationWriteFailure = false;
		writeFileSync(join(interruptedRestoration, "file.txt"), "中断时尚未写完的内容");
		await expect(restoreVerifiedTaskClosureArchive(operation, source.path)).rejects.toThrow("未被恢复来源覆盖");
		expect(readFileSync(join(interruptedRestoration, "file.txt"), "utf8")).toBe("中断时尚未写完的内容");
		writeFileSync(join(interruptedRestoration, "file.txt"), "uns");
		await restoreVerifiedTaskClosureArchive(operation, source.path);
		expect(existsSync(interruptedRestoration)).toBe(false);
		expect(git(["--no-optional-locks", "status", "--porcelain=v1"])).toBe(before);
		expect(git(["show", ":file.txt"])).toBe("staged\n");
		expect(readFileSync(join(source.path, "file.txt"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(source.path, "reports", "accepted.md"), "utf8")).toBe("已接受的调查\n");
		expect(readFileSync(join(source.path, "binary.bin"))).toEqual(Buffer.from([0, 255, 0, 7]));
		writeFileSync(join(source.path, "file.txt"), "重新打开后的新成果\n");
		await expect(restoreVerifiedTaskClosureArchive(operation, source.path)).rejects.toThrow("变化");
		expect(readFileSync(join(source.path, "file.txt"), "utf8")).toBe("重新打开后的新成果\n");
	});
});
