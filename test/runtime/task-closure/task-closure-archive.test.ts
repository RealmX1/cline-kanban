import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import type { TaskClosureRecord } from "../../../src/core/task-closure-contract";
import { getRuntimeHomePath } from "../../../src/state/runtime-home-path";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../../src/state/workspace-state";
import {
	assertTaskClosureArchivePayloadIsRecoverable,
	captureAndVerifyTaskClosureArchive,
	restoreVerifiedTaskClosureArchive,
} from "../../../src/task-closure/task-closure-archive";
import {
	listTaskClosureOperations,
	readTaskClosureHistory,
	type TaskClosureOperation,
	taskClosureOperationDirectory,
	taskClosureOperationsRoot,
	taskClosureTaskDirectory,
	writeTaskClosureHistoryRecord,
	writeTaskClosureOperation,
} from "../../../src/task-closure/task-closure-operation-store";
import { assertTaskWorktreeCleanupHasCurrentVerifiedArchive } from "../../../src/task-closure/task-worktree-verified-archive-cleanup-guard";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const archiveFlushHarness = vi.hoisted(() => ({
	flushedPaths: [] as string[],
	failurePathSuffix: null as string | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFsPromises>();
	return {
		...actual,
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
});
afterEach(() => vi.unstubAllEnvs());

async function createClosurePreservationFixture(requestId = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF") {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
	const repo = fixture.createNonBareRepository({
		repositoryDirectoryName: "preservation-source",
		initialBranchName: "main",
	});
	writeFileSync(join(repo.repositoryPath, "file.txt"), "base\n");
	repo.commitAllRepositoryFilesAtDate({
		message: "隔离保全初始版本",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const source = await ensureTaskWorktreeIfDoesntExist({ cwd: repo.repositoryPath, taskId: "abc12", baseRef: "main" });
	if (!source.path) throw new Error(source.error ?? "隔离工作树创建失败");
	writeFileSync(join(source.path, "file.txt"), "staged\n");
	repo.runGit(["add", "file.txt"], { workingDirectoryPath: source.path });
	writeFileSync(join(source.path, "file.txt"), "仅此一份的未暂存成果\n");
	const workspace = await loadWorkspaceContext(repo.repositoryPath);
	const operation: TaskClosureOperation = {
		schemaVersion: 1,
		taskIdentity: { workspaceId: workspace.workspaceId, taskId: "abc12", taskIncarnationCreatedAtEpochMs: 1 },
		workspacePath: repo.repositoryPath,
		sourceWorktreePath: source.path,
		sourceBoardColumnId: "review",
		sourceTaskUpdatedAtEpochMs: 1,
		request: {
			taskId: "abc12",
			closure: {
				closureRequestId: requestId,
				details: { outcome: "delivery_accepted", evidence: [], acceptedDeliverables: [] },
				selectedArtifactRelativePaths: [],
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
			closureRequestId: requestId,
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
	return { fixture, repo, sourcePath: source.path, operation };
}

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
		expect(existsSync(interruptedRestoration)).toBe(true);
		writeFileSync(archivedWorkingFile, completeArchivedContent);
		writeFileSync(join(interruptedRestoration, "file.txt"), "中断时尚未写完的内容");
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
