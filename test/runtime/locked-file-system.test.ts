import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	DEFAULT_LOCK_STALE_MS,
	LOCK_ACQUISITION_WAIT_BUDGET_MARGIN_BEYOND_STALE_THRESHOLD_MS,
	LockedFileSystem,
	sumLockAcquisitionRetryWaitBudgetMs,
} from "../../src/fs/locked-file-system";
import { createTempDir } from "../utilities/temp-dir";

const executeFileAsync = promisify(execFile);

describe("LockedFileSystem", () => {
	beforeEach(() => {
		const isolatedHome = createTempDir("kanban-filesystem-lock-home-");
		vi.stubEnv("HOME", isolatedHome.path);
		onTestFinished(isolatedHome.cleanup);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
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

	it("保留原有默认重试预算", () => {
		expect(
			sumLockAcquisitionRetryWaitBudgetMs(DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD),
		).toBeGreaterThanOrEqual(DEFAULT_LOCK_STALE_MS + LOCK_ACQUISITION_WAIT_BUDGET_MARGIN_BEYOND_STALE_THRESHOLD_MS);
	});

	it("同路径互斥，等待方异步退避；不同路径可并行", async () => {
		const directory = createTempDir("kanban-kernel-lock-contention-");
		onTestFinished(directory.cleanup);
		const filesystem = new LockedFileSystem();
		const path = join(directory.path, "state.json");
		const release = await filesystem.acquireLock({ path });
		try {
			await expect(filesystem.withLock({ path, retries: 0 }, async () => "不应进入")).rejects.toMatchObject({
				code: "ELOCKED",
			});
			let eventLoopAdvanced = false;
			const callback = vi.fn(async () => "不应进入");
			const timeout = setTimeout(() => {
				eventLoopAdvanced = true;
			}, 0);
			await expect(filesystem.withLock({ path, retries: [20, 20] }, callback)).rejects.toMatchObject({
				code: "ELOCKED",
			});
			clearTimeout(timeout);
			expect(eventLoopAdvanced).toBe(true);
			expect(callback).not.toHaveBeenCalled();
			await expect(
				filesystem.withLock({ path: join(directory.path, "other.json"), retries: 0 }, async () => "并行"),
			).resolves.toBe("并行");
		} finally {
			await release();
		}
		await expect(filesystem.withLock({ path, retries: 0 }, async () => "已释放")).resolves.toBe("已释放");
	});

	it.each(["existing_target", "missing_target", "explicit_lock_path", "unicode_normalization"] as const)(
		"%s 的大小写或规范等价别名在原子替换后仍使用同一锁",
		async (kind) => {
			const directory = createTempDir("kanban-kernel-lock-path-aliases-");
			onTestFinished(directory.cleanup);
			const filesystem = new LockedFileSystem();
			const path = join(directory.path, kind === "unicode_normalization" ? "révision.json" : "State.json");
			const aliasPath = join(
				directory.path,
				kind === "unicode_normalization" ? "re\u0301vision.json" : "state.json",
			);
			if (kind === "existing_target") await writeFile(path, "原状态");
			const request =
				kind === "explicit_lock_path" ? { path, lockfilePath: join(directory.path, "EXPLICIT.lock") } : { path };
			const aliasRequest =
				kind === "explicit_lock_path"
					? { path: aliasPath, lockfilePath: join(directory.path, "explicit.lock") }
					: { path: aliasPath };
			await filesystem.withLock(request, async () => {
				await filesystem.writeTextFileAtomic(path, "替换后的状态", { lock: null });
				await expect(filesystem.withLock({ ...aliasRequest, retries: 0 }, async () => true)).rejects.toMatchObject({
					code: "ELOCKED",
				});
			});
			await expect(filesystem.withLock({ ...aliasRequest, retries: 0 }, async () => true)).resolves.toBe(true);
		},
	);

	it.each([
		["Σ-target", "ς-target"],
		["ß-target", "ss-target"],
		["ẞ-target", "ss-target"],
		["ﬀ-target", "ff-target"],
	])("Unicode 别名 %s 与 %s 在临界区和原子替换后都互斥", async (targetName, aliasName) => {
		const directory = createTempDir("kanban-kernel-unicode-lock-aliases-");
		onTestFinished(directory.cleanup);
		const filesystem = new LockedFileSystem();
		const targetPath = join(directory.path, targetName);
		const aliasPath = join(directory.path, aliasName);
		const aliasMutation = vi.fn(async () => true);
		await filesystem.withLock({ path: targetPath }, async () => {
			await expect(filesystem.withLock({ path: aliasPath, retries: 0 }, aliasMutation)).rejects.toMatchObject({
				code: "ELOCKED",
			});
			await filesystem.writeTextFileAtomic(targetPath, "原子替换后的状态", { lock: null });
			await expect(filesystem.withLock({ path: aliasPath, retries: 0 }, aliasMutation)).rejects.toMatchObject({
				code: "ELOCKED",
			});
		});
		expect(aliasMutation).not.toHaveBeenCalled();
		await expect(filesystem.withLock({ path: aliasPath, retries: 0 }, aliasMutation)).resolves.toBe(true);
	});

	it("反向多锁请求使用统一顺序，并合并同一路径", async () => {
		const directory = createTempDir("kanban-kernel-multiple-locks-");
		onTestFinished(directory.cleanup);
		const filesystem = new LockedFileSystem();
		const first = { path: join(directory.path, "first.json") };
		const second = { path: join(directory.path, "second.json") };
		expect(
			await Promise.all([
				filesystem.withLocks([first, second, first], async () => 1),
				filesystem.withLocks([second, first], async () => 2),
			]),
		).toEqual([1, 2]);
	});

	it("业务回调抛错也释放全部已获取的锁", async () => {
		const directory = createTempDir("kanban-kernel-release-on-error-");
		onTestFinished(directory.cleanup);
		const filesystem = new LockedFileSystem();
		const request = { path: join(directory.path, "state.json") };
		await expect(
			filesystem.withLock(request, async () => {
				throw new Error("业务失败");
			}),
		).rejects.toThrow("业务失败");
		await expect(filesystem.withLock({ ...request, retries: 0 }, async () => true)).resolves.toBe(true);
	});
});
