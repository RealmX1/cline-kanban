import { spawn } from "node:child_process";
import { once } from "node:events";
import { lchmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LockedFileSystemModule from "../../../src/fs/locked-file-system";

// 保留真实 SQLite 互斥与 fsync，只把锁数据库绑定到 guarded runner 独占的测试目录。
vi.mock("../../../src/fs/locked-file-system", async (importOriginal) => {
	const actual = await importOriginal<typeof LockedFileSystemModule>();
	const guardedTestDirectory = process.env.TMPDIR;
	if (!guardedTestDirectory) throw new Error("必须通过 guarded runner 提供独占测试目录。");
	return { ...actual, lockedFileSystem: await actual.LockedFileSystem.forIsolatedTestDirectory(guardedTestDirectory) };
});

import { captureAndVerifyTaskClosureArchive } from "../../../src/task-closure/task-closure-archive";
import {
	beginTaskClosureAutomaticSideEffect,
	getTaskClosureAutomaticRecoveryState,
	isTaskClosureAutomaticRecoveryEligible,
	recordTaskClosureAutomaticFailure,
	TaskClosureRecoveryPrerequisiteError,
} from "../../../src/task-closure/task-closure-automatic-recovery-policy";
import { readTaskClosureRecoveryEvidence } from "../../../src/task-closure/task-closure-failure-recovery-evidence";
import {
	assertTaskClosureLifecycleNotCancelled,
	readTaskClosureOperation,
	requestTaskClosureLifecycleCancellation,
	withTaskClosureLifecycleCancellationGuards,
	writeTaskClosureOperation,
} from "../../../src/task-closure/task-closure-operation-store";
import { createClosurePreservationFixture } from "./task-closure-preservation-test-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("结案请求跨重启的总次数与修复补试", () => {
	it.each(["insufficient_storage_space", "owned_process_exit_unconfirmed"] as const)(
		"登记失败时 %s 已恢复，持久重读仍可消费剩余预算",
		async (classification) => {
			const { fixture, operation } = await createClosurePreservationFixture();
			operation.progress.attemptCount = 0;
			await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
			getTaskClosureAutomaticRecoveryState(operation).minimumRequiredAvailableStorageBytes = 1;
			if (classification === "owned_process_exit_unconfirmed") {
				const child = spawn(process.execPath, ["-e", ""], {
					env: {
						HOME: fixture.isolatedHomeDirectoryPath,
						CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
						CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite-storage"),
						TMPDIR: fixture.fixtureRootDirectoryPath,
					},
				});
				await once(child, "exit");
				if (!child.pid) throw new Error("测试子进程没有 PID");
				operation.processIdsAwaitingExit = [child.pid];
			}
			await recordTaskClosureAutomaticFailure(
				operation,
				new TaskClosureRecoveryPrerequisiteError(classification, "失败后条件已恢复"),
			);
			await writeTaskClosureOperation(operation);
			const resumed = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
			if (!resumed) throw new Error("持久请求缺失");
			expect((await readTaskClosureRecoveryEvidence(resumed, classification)).prerequisiteSatisfied).toBe(true);
			expect(await isTaskClosureAutomaticRecoveryEligible(resumed)).toBe(true);
			await beginTaskClosureAutomaticSideEffect(resumed, "preserve_archive");
			expect(getTaskClosureAutomaticRecoveryState(resumed).automaticAttemptCount).toBe(2);
		},
	);
	it("来源在失败后保持不变也可在稳定观察后接续，不要求再人为改动一次", async () => {
		const { operation } = await createClosurePreservationFixture();
		operation.progress.attemptCount = 0;
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		await recordTaskClosureAutomaticFailure(
			operation,
			new TaskClosureRecoveryPrerequisiteError("source_working_state_changed", "捕获期间来源发生变化"),
		);
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(false);
		now += 15_001;
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(true);
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		expect(getTaskClosureAutomaticRecoveryState(operation).automaticAttemptCount).toBe(2);
	});
	it("暂时性 I/O 失败跨记录重读共用三次上限，时间推移也不补发", async () => {
		const fixture = await createClosurePreservationFixture();
		let operation = fixture.operation;
		operation.progress.attemptCount = 0;
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
			await recordTaskClosureAutomaticFailure(operation, Object.assign(new Error("文件暂时忙"), { code: "EBUSY" }));
			await writeTaskClosureOperation(operation);
			now += 121_000;
			operation =
				(await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId)) ?? operation;
		}
		expect(getTaskClosureAutomaticRecoveryState(operation).automaticAttemptCount).toBe(3);
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(false);
		await expect(beginTaskClosureAutomaticSideEffect(operation, "preserve_archive")).rejects.toThrow(
			"等待相关恢复证据",
		);
	});
	it("旧请求的 144 次历史不归零，实际软链恢复能力修复仅追加一次", async () => {
		const { operation, sourcePath } = await createClosurePreservationFixture();
		await mkdir(join(sourcePath, ".claude", "commands"), { recursive: true });
		await symlink("../../file.txt", join(sourcePath, ".claude", "commands", "release.md"));
		if (process.platform === "darwin") await lchmod(join(sourcePath, ".claude", "commands", "release.md"), 0o700);
		await captureAndVerifyTaskClosureArchive(operation);
		delete operation.progress.automaticRecovery;
		operation.schemaVersion = 1;
		operation.progress.attemptCount = 144;
		operation.progress.phase = "preservation_waiting_for_recovery";
		operation.progress.lastError = "来源文件发生变化：.claude/commands/release.md";
		expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(true);
		await beginTaskClosureAutomaticSideEffect(operation, "preserve_archive");
		expect(getTaskClosureAutomaticRecoveryState(operation)).toMatchObject({
			automaticAttemptCount: 145,
			maximumAutomaticAttemptCount: 145,
			repairSupplementConsumed: true,
		});
		await recordTaskClosureAutomaticFailure(operation, new Error("来源文件发生变化：.claude/commands/release.md"));
		await writeTaskClosureOperation(operation);
		const restored = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
		expect(restored).not.toBeNull();
		if (!restored) throw new Error("持久请求缺失");
		expect(await isTaskClosureAutomaticRecoveryEligible(restored)).toBe(false);
	});
	it("最终提交持有的短锁与持久撤销互斥，撤销先提交时不得进入提交回调", async () => {
		const { operation } = await createClosurePreservationFixture();
		await writeTaskClosureOperation(operation);
		let releaseFinalCommit = () => {};
		let finalCommitEntered = () => {};
		const enteredFinalCommit = new Promise<void>((resolve) => {
			finalCommitEntered = resolve;
		});
		const finalCommitRelease = new Promise<void>((resolve) => {
			releaseFinalCommit = resolve;
		});
		const commit = withTaskClosureLifecycleCancellationGuards([operation], async () => {
			finalCommitEntered();
			await finalCommitRelease;
			await assertTaskClosureLifecycleNotCancelled(operation);
		});
		await enteredFinalCommit;
		let cancellationPersisted = false;
		const cancellation = requestTaskClosureLifecycleCancellation(operation).then(() => {
			cancellationPersisted = true;
		});
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			expect(cancellationPersisted).toBe(false);
		} finally {
			releaseFinalCommit();
		}
		await commit;
		await cancellation;
		const commitAfterCancellation = vi.fn(async () => undefined);
		await expect(withTaskClosureLifecycleCancellationGuards([operation], commitAfterCancellation)).rejects.toThrow(
			"已取消",
		);
		expect(commitAfterCancellation).not.toHaveBeenCalled();
	});
	it("取消标记不等待复制锁，后续大操作在入口即拒绝", async () => {
		const { operation } = await createClosurePreservationFixture();
		await requestTaskClosureLifecycleCancellation(operation);
		await expect(beginTaskClosureAutomaticSideEffect(operation, "preserve_archive")).rejects.toThrow("已取消");
		expect(operation.progress.attemptCount).toBe(1);
	});
});
