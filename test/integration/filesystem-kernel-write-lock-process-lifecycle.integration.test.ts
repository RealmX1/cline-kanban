import { spawn } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LockedFileSystem } from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe.skipIf(process.platform === "win32")("跨进程内核写锁", { timeout: 60_000 }, () => {
	it("不同 HOME 的进程共享同一目标锁；持有者暂停不被接管，退出后自动释放", async (context) => {
		const lockFixture = createTempDir("kanban-kernel-cross-process-locks-");
		const childHome = createTempDir("kanban-kernel-lock-holder-home-");
		const directory = join(lockFixture.path, "locked-workspace");
		vi.stubEnv("HOME", lockFixture.path);
		onTestFinished(async () => {
			await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
			vi.unstubAllEnvs();
			childHome.cleanup();
			lockFixture.cleanup();
		});
		await mkdir(directory);
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
import { LockedFileSystem } from ${JSON.stringify(moduleUrl)};
const lockedFileSystem = await LockedFileSystem.forIsolatedTestDirectory(${JSON.stringify(lockFixture.path)});
if (process.env.HOME !== ${JSON.stringify(childHome.path)}) throw new Error("子进程 HOME 未隔离");
await lockedFileSystem.withLock({ path: ${JSON.stringify(path)}, staleMs: 2_000 }, async () => {
 process.stdout.write("已持锁\\n");
 await new Promise((resolve) => {
  process.stdin.once("end", resolve);
  process.stdin.resume();
 });
});
`,
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: {
					PATH: process.env.PATH,
					HOME: childHome.path,
					NODE_OPTIONS: process.env.NODE_OPTIONS,
					TMPDIR: process.env.TMPDIR,
				},
				stdio: ["pipe", "pipe", "pipe"],
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
		await vi.waitFor(() => expect(output.includes("已持锁") || hasChildProcessExited(holder)).toBe(true), {
			timeout: 30_000,
		});
		expect(output).toContain("已持锁");
		expect(holder.kill("SIGSTOP")).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(hasChildProcessExited(holder), output).toBe(false);
		const filesystem = await LockedFileSystem.forIsolatedTestDirectory(lockFixture.path);
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
		const lockFixture = createTempDir("kanban-kernel-lock-directory-recreation-");
		onTestFinished(lockFixture.cleanup);
		const directory = join(lockFixture.path, "workspace");
		const alias = join(lockFixture.path, "workspace-alias");
		await mkdir(directory);
		await symlink(directory, alias, "dir");
		const filesystem = await LockedFileSystem.forIsolatedTestDirectory(lockFixture.path);
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
