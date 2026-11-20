import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LockedFileSystemModule from "../../../src/fs/locked-file-system";

// 保留真实 SQLite 互斥与 fsync，只把锁数据库绑定到 guarded runner 独占的测试目录。
vi.mock("../../../src/fs/locked-file-system", async (importOriginal) => {
	const actual = await importOriginal<typeof LockedFileSystemModule>();
	const guardedTestDirectory = process.env.TMPDIR;
	if (!guardedTestDirectory) throw new Error("必须通过 guarded runner 提供独占测试目录。");
	return { ...actual, lockedFileSystem: await actual.LockedFileSystem.forIsolatedTestDirectory(guardedTestDirectory) };
});

import { getTaskClosureAutomaticRecoveryState } from "../../../src/task-closure/task-closure-automatic-recovery-policy";
import {
	readTaskClosureOperation,
	taskClosureOperationDirectory,
	writeTaskClosureOperation,
} from "../../../src/task-closure/task-closure-operation-store";
import {
	assertTaskClosureStorageProtocolCompatibleWithDistribution,
	TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME,
	taskClosureStorageProtocolAdoptionPath,
} from "../../../src/task-closure/task-closure-storage-protocol-compatibility";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { createClosurePreservationFixture } from "./task-closure-preservation-test-fixture";

afterEach(() => vi.unstubAllEnvs());
describe("结案旧数据及安装协议兼容", () => {
	it("源码 link 安装入口在运行 npm 前拒绝 v1 候选，保持旧入口和协议原件", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const candidateDirectory = join(fixture.fixtureRootDirectoryPath, "old-source-checkout");
		const runtimeHome = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
		await mkdir(join(candidateDirectory, "dist"), { recursive: true });
		await mkdir(runtimeHome, { recursive: true });
		const adoptionPath = join(runtimeHome, "task-closure-storage-protocol-adoption.json");
		const originalAdoption = JSON.stringify({ minimumReadableOperationSchemaVersion: 2 });
		await writeFile(adoptionPath, originalAdoption);
		const globalEntrySentinel = join(fixture.fixtureRootDirectoryPath, "isolated-global-entry-sentinel.txt");
		await writeFile(globalEntrySentinel, "原全局入口");
		const npmEntryFixture = join(fixture.fixtureRootDirectoryPath, "isolated-npm-link-entry.cjs");
		await writeFile(
			npmEntryFixture,
			`require("node:fs").writeFileSync(${JSON.stringify(globalEntrySentinel)}, "已安装兼容候选");`,
		);
		const parallelBuildOutputDirectory = join(candidateDirectory, "parallel-built-distribution");
		await mkdir(parallelBuildOutputDirectory);
		await writeFile(
			join(parallelBuildOutputDirectory, TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME),
			JSON.stringify({ readableOperationSchemaVersions: [1, 2] }),
		);
		const shortLivedNodeChildProcessEnvironment = {
			HOME: fixture.isolatedHomeDirectoryPath,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite-storage"),
			TMPDIR: fixture.fixtureRootDirectoryPath,
			npm_execpath: npmEntryFixture,
			KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY: parallelBuildOutputDirectory,
		};
		const invocation = () =>
			execFileSync(
				process.execPath,
				[
					"--import",
					fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
					fileURLToPath(
						new URL("../../../scripts/link-source-distribution-after-storage-protocol-check.ts", import.meta.url),
					),
				],
				{ cwd: candidateDirectory, env: shortLivedNodeChildProcessEnvironment, stdio: "pipe" },
			);
		expect(invocation).toThrow(/不支持已采用的结案存储协议 v2/u);
		expect(await readFile(globalEntrySentinel, "utf8")).toBe("原全局入口");
		expect(await readFile(adoptionPath, "utf8")).toBe(originalAdoption);
		await writeFile(
			join(candidateDirectory, "dist", TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME),
			JSON.stringify({ readableOperationSchemaVersions: [1, 2] }),
		);
		invocation();
		expect(await readFile(globalEntrySentinel, "utf8")).toBe("已安装兼容候选");
	});
	it("旧 v1 请求保留原取消与次数，采用 v2 后拒绝安装旧写入者且记录字节不变", async () => {
		const { fixture, operation } = await createClosurePreservationFixture();
		operation.progress.phase = "cancelled";
		operation.progress.attemptCount = 144;
		await writeTaskClosureOperation(operation);
		const legacy = await readTaskClosureOperation(operation.taskIdentity, operation.progress.closureRequestId);
		expect(legacy?.progress).toMatchObject({ phase: "cancelled", attemptCount: 144 });
		const oldInstallation = join(fixture.fixtureRootDirectoryPath, "old-v1-runtime-installation");
		await mkdir(oldInstallation);
		await assertTaskClosureStorageProtocolCompatibleWithDistribution(oldInstallation);
		getTaskClosureAutomaticRecoveryState(operation);
		await writeTaskClosureOperation(operation);
		const path = join(
			taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
			"operation.json",
		);
		const before = await readFile(path);
		await expect(assertTaskClosureStorageProtocolCompatibleWithDistribution(oldInstallation)).rejects.toThrow(
			"不支持已采用的结案存储协议 v2",
		);
		expect(await readFile(path)).toEqual(before);
		await writeFile(
			join(oldInstallation, TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME),
			JSON.stringify({ readableOperationSchemaVersions: [1, 2] }),
		);
		await assertTaskClosureStorageProtocolCompatibleWithDistribution(oldInstallation);
	});
	it("未知的新协议下界不能被当前写入者覆盖成 v2", async () => {
		const { operation } = await createClosurePreservationFixture();
		await writeTaskClosureOperation(operation);
		await writeFile(
			taskClosureStorageProtocolAdoptionPath(),
			JSON.stringify({ minimumReadableOperationSchemaVersion: 3 }),
		);
		getTaskClosureAutomaticRecoveryState(operation);
		await expect(writeTaskClosureOperation(operation)).rejects.toThrow("不能降级写入");
		expect(JSON.parse(await readFile(taskClosureStorageProtocolAdoptionPath(), "utf8"))).toEqual({
			minimumReadableOperationSchemaVersion: 3,
		});
	});
});
