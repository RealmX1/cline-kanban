import { spawn } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();

describe.skipIf(process.platform === "win32")("跨进程内核写锁", { timeout: 60_000 }, () => {
	it("不同 HOME 的进程共享同一目标锁；持有者暂停不被接管，退出后自动释放", async (context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const separateHomeFixture = createIsolatedGitTestWorkspaceFixture();
		const directory = join(fixture.isolatedHomeDirectoryPath, "locked-workspace");
		await mkdir(directory);
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		onTestFinished(() => {
			vi.unstubAllEnvs();
			separateHomeFixture.cleanup();
			fixture.cleanup();
		});
		const path = join(directory, "state.json");
		const moduleUrl = new URL("../../src/fs/locked-file-system.ts", import.meta.url).href;
		const holder = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
import { lockedFileSystem } from ${JSON.stringify(moduleUrl)};
await lockedFileSystem.withLock({ path: ${JSON.stringify(path)}, staleMs: 2_000 }, async () => {
 process.stdout.write("已持锁\\n");
 await new Promise(() => { setInterval(() => {}, 1_000); });
});
`,
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: separateHomeFixture.createIsolatedChildProcessEnvironment({
					CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "codex"),
					CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "codex-sqlite"),
				}),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		childProcesses.register(holder);
		let output = "";
		holder.stdout?.on("data", (chunk) => {
			output += String(chunk);
		});
		holder.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		await vi.waitFor(() => expect(output).toContain("已持锁"), { timeout: 30_000 });
		holder.kill("SIGSTOP");
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		const filesystem = new LockedFileSystem();
		await expect(filesystem.withLock({ path, staleMs: 2_000, retries: 0 }, async () => true)).rejects.toMatchObject({
			code: "ELOCKED",
		});
		await expect(
			filesystem.withLock({ path: join(directory, "different.json"), retries: 0 }, async () => true),
		).resolves.toBe(true);
		holder.kill("SIGKILL");
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, holder, {
			waitedForDescription: "隔离子进程退出",
			softDeadlineMsExpectedOnUncontendedHost: 5_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
		});
		await expect(filesystem.withLock({ path, retries: 0 }, async () => true)).resolves.toBe(true);
	});

	it("物理路径别名共用锁，删除并重建 workspace 不会更换锁 inode", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		onTestFinished(() => {
			vi.unstubAllEnvs();
			fixture.cleanup();
		});
		const directory = join(fixture.isolatedHomeDirectoryPath, "workspace");
		const alias = join(fixture.isolatedHomeDirectoryPath, "workspace-alias");
		await mkdir(directory);
		await symlink(directory, alias, "dir");
		const filesystem = new LockedFileSystem();
		const release = await filesystem.acquireLock({ type: "directory", path: directory });
		try {
			await expect(
				filesystem.withLock({ type: "directory", path: alias, retries: 0 }, async () => true),
			).rejects.toMatchObject({ code: "ELOCKED" });
			await rm(directory, { recursive: true });
			await mkdir(directory);
			await expect(
				filesystem.withLock({ type: "directory", path: directory, retries: 0 }, async () => true),
			).rejects.toMatchObject({ code: "ELOCKED" });
		} finally {
			await release();
		}
	});
});
