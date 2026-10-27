import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import {
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	DEFAULT_LOCK_STALE_MS,
	LOCK_ACQUISITION_WAIT_BUDGET_MARGIN_BEYOND_STALE_THRESHOLD_MS,
	LockedFileSystem,
	sumLockAcquisitionRetryWaitBudgetMs,
} from "../../src/fs/locked-file-system";

type LockOptionsShape = {
	onCompromised?: (error: Error) => void;
	retries?: unknown;
};

const executeFileAsync = promisify(execFile);

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32")(
		"严格 umask 下原子替换保留显式权限，并沿用默认权限与 executable 优先级",
		async () => {
			const directory = createTempDir("kanban-atomic-write-file-mode-");
			const parentProcessUmask = process.umask();
			const childProcessAbortController = new AbortController();
			onTestFinished(() => childProcessAbortController.abort());
			const filesystemModuleUrl = new URL("../../src/fs/locked-file-system.ts", import.meta.url);
			const childProcessSource = `
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LockedFileSystem } from ${JSON.stringify(filesystemModuleUrl.href)};

process.umask(0o077);
const directoryPath = ${JSON.stringify(directory.path)};
const filesystem = new LockedFileSystem();
const fileWriteCases = [
	{ name: "explicit-0644", options: { fileMode: 0o644 } },
	{ name: "explicit-0640-durable-without-lock", options: { fileMode: 0o640, durable: true, lock: null } },
	{ name: "default-mode", options: {} },
	{ name: "explicit-mode-with-executable", options: { fileMode: 0o640, executable: true } },
	{ name: "default-mode-with-executable", options: { executable: true } },
];
const results = [];
for (const fileWriteCase of fileWriteCases) {
	const filePath = join(directoryPath, fileWriteCase.name);
	await writeFile(filePath, "original");
	await chmod(filePath, fileWriteCase.options.fileMode ?? 0o644);
	await filesystem.writeTextFileAtomic(filePath, "rewritten", fileWriteCase.options);
	results.push({
		name: fileWriteCase.name,
		mode: (await stat(filePath)).mode & 0o777,
		content: await readFile(filePath, "utf8"),
	});
}
process.stdout.write(JSON.stringify({ results, remainingFiles: (await readdir(directoryPath)).sort() }));
`;
			try {
				const { stdout } = await executeFileAsync(
					process.execPath,
					["--import", "tsx", "--input-type=module", "--eval", childProcessSource],
					{
						cwd: fileURLToPath(new URL("../../", import.meta.url)),
						env: { PATH: process.env.PATH, HOME: directory.path },
						signal: childProcessAbortController.signal,
					},
				);
				expect(JSON.parse(stdout)).toEqual({
					results: [
						{ name: "explicit-0644", mode: 0o644, content: "rewritten" },
						{ name: "explicit-0640-durable-without-lock", mode: 0o640, content: "rewritten" },
						{ name: "default-mode", mode: 0o600, content: "rewritten" },
						{ name: "explicit-mode-with-executable", mode: 0o755, content: "rewritten" },
						{ name: "default-mode-with-executable", mode: 0o755, content: "rewritten" },
					],
					remainingFiles: [
						"default-mode",
						"default-mode-with-executable",
						"explicit-0640-durable-without-lock",
						"explicit-0644",
						"explicit-mode-with-executable",
					],
				});
				expect(process.umask()).toBe(parentProcessUmask);
			} finally {
				directory.cleanup();
			}
		},
	);

	it("installs a non-throwing default onCompromised when no handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			const options = lockfileMocks.lock.mock.calls[0]?.[1] as LockOptionsShape;
			// 关键行为反转：默认不再"省略" onCompromised，而是安装一个"记录且绝不抛"的处理器，
			// 以杜绝 proper-lockfile 默认 throw → uncaughtException → 整个多项目服务器退出的崩溃路径。
			expect(typeof options.onCompromised).toBe("function");

			const compromiseError = new Error("Unable to update lock within the stale threshold");
			// 默认处理器被触发时必须不抛，且把事件降级为 [fs-lock] warn 日志。
			expect(() => options.onCompromised?.(compromiseError)).not.toThrow();
			const loggedFsLockWarning = stderrWrite.mock.calls.some((call) => String(call[0]).includes("[fs-lock]"));
			expect(loggedFsLockWarning).toBe(true);

			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("forwards onCompromised when a handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as LockOptionsShape;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});

	it("swallows a release() rejection after compromise instead of surfacing it as an unhandled rejection", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			// compromise 后 proper-lockfile 会把锁标记为已释放并删除锁文件，此时 release() 以 ERELEASED 拒绝。
			const releaseError = Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
			lockfileMocks.release.mockRejectedValue(releaseError);

			// withLock 必须照常返回 operation 的结果，绝不因 release() 拒绝而 reject（那正是第二条崩溃路径）。
			const result = await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => "operation-ok");

			expect(result).toBe("operation-ok");
			const loggedReleaseFailure = stderrWrite.mock.calls.some((call) => String(call[0]).includes("release-failed"));
			expect(loggedReleaseFailure).toBe(true);
		} finally {
			tempDir.cleanup();
		}
	});

	it("logs an unexpected (EACCES) release() rejection at error visibility while still not throwing", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			// 真实的锁文件删除失败（权限/IO 错误）不是 compromise 善后，release() 会以 EACCES 等 code 拒绝。
			const releaseError = Object.assign(new Error("permission denied unlinking lockfile"), { code: "EACCES" });
			lockfileMocks.release.mockRejectedValue(releaseError);

			// 硬约束：非良性的 release() 失败同样绝不能升级为抛出/reject（否则重新引入全服崩溃路径），
			// withLock 必须照常返回 operation 的结果。
			const result = await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => "operation-ok");

			expect(result).toBe("operation-ok");

			const stderrLines = stderrWrite.mock.calls.map((call) => String(call[0]));
			// 意外失败必须记为更醒目的 [error] 级别、且用与良性不同的 release-failed-unexpected 标记。
			const loggedUnexpected = stderrLines.some(
				(line) => line.includes("[error] [fs-lock]") && line.includes("release-failed-unexpected"),
			);
			expect(loggedUnexpected).toBe(true);
			// 且绝不能被误记为良性（区别于 compromise 善后）。
			const loggedAsBenign = stderrLines.some((line) => line.includes("release-failed-benign"));
			expect(loggedAsBenign).toBe(false);
		} finally {
			tempDir.cleanup();
		}
	});

	it("waits at least the stale threshold plus margin before giving up on a held lock", () => {
		// 不变式：活着但慢的持有者不能比「已经死掉的持有者被判 stale」更早让等待方失败。
		// 旧预算 200×25ms≈5s < 30s stale，高负载下新任务的 ensureWorktree 因此抛 ELOCKED。
		expect(
			sumLockAcquisitionRetryWaitBudgetMs(DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD),
		).toBeGreaterThanOrEqual(DEFAULT_LOCK_STALE_MS + LOCK_ACQUISITION_WAIT_BUDGET_MARGIN_BEYOND_STALE_THRESHOLD_MS);
		// 公式自检：旧配置算出来正是那个过短的 5s。
		expect(sumLockAcquisitionRetryWaitBudgetMs({ retries: 200, factor: 1, minTimeout: 25, maxTimeout: 50 })).toBe(
			5_000,
		);
	});

	it("passes the stale-covering retry schedule to proper-lockfile when the caller does not override it", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: join(tempDir.path, "state.json"), type: "file" }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as LockOptionsShape;
			expect(options.retries).toEqual(DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD);
		} finally {
			tempDir.cleanup();
		}
	});
});
