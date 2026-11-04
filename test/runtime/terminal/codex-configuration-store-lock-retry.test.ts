import { mkdir, realpath, utimes } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	DEFAULT_LOCK_STALE_MS,
	sumLockAcquisitionRetryWaitBudgetMs,
} from "../../../src/fs/locked-file-system";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-store-lock-retry-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("配置存储复用统一锁预算，只重试取锁", () => {
	it("恢复超过 stale 阈值的孤立锁，并释放原有锁路径", async () => {
		const directory = getCodexConfigurationSyncDirectory();
		await mkdir(directory, { recursive: true });
		await mkdir(`${directory}.lock`);
		const staleAt = new Date(Date.now() - DEFAULT_LOCK_STALE_MS - 10_000);
		await utimes(`${directory}.lock`, staleAt, staleAt);
		const operation = vi.fn(() => "recovered");
		await expect(mutateCodexConfigurationSyncStore(operation)).resolves.toBe("recovered");
		expect(operation).toHaveBeenCalledOnce();
		expect(await lockfile.check(directory, { realpath: false })).toBe(false);
	});

	it("持续占用在统一预算耗尽后退出，错误保留代码并报告锁路径、阶段和等待时长", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
		const acquireLock = lockfile.lock;
		const lockFilesystem = {
			mkdir: vi.fn((_path: string, callback: (error: NodeJS.ErrnoException) => void) =>
				callback(Object.assign(new Error("隔离模拟锁始终被活持有者占用"), { code: "EEXIST" })),
			),
			stat: (_path: string, callback: (error: null, metadata: { mtime: Date }) => void) =>
				callback(null, { mtime: new Date() }),
		};
		let markLockAttemptStarted = () => {};
		const lockAttemptStarted = new Promise<void>((resolve) => {
			markLockAttemptStarted = resolve;
		});
		vi.spyOn(lockfile, "lock").mockImplementation((path, options) => {
			const acquiring = acquireLock(path, { ...options, fs: lockFilesystem });
			markLockAttemptStarted();
			return acquiring;
		});
		const operation = vi.fn();
		let rejected = false;
		const waiting = mutateCodexConfigurationSyncStore(operation).catch((error: unknown) => {
			rejected = true;
			return error;
		});
		await lockAttemptStarted;
		const waitBudgetMs = sumLockAcquisitionRetryWaitBudgetMs(
			DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
		);
		expect(DEFAULT_LOCK_STALE_MS).toBe(30_000);
		expect(waitBudgetMs).toBeGreaterThan(40_000);
		await vi.advanceTimersByTimeAsync(waitBudgetMs - 1);
		expect(rejected).toBe(false);
		expect(operation).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const error = await waiting;
		expect(error).toMatchObject({ code: "ELOCKED" });
		expect((error as Error).message).toContain(`lockPath=${getCodexConfigurationSyncDirectory()}.lock`);
		expect((error as Error).message).toContain("phase=lock_acquisition");
		expect((error as Error).message).toContain(`waitedMs=${waitBudgetMs}`);
		expect(operation).not.toHaveBeenCalled();
		expect(lockFilesystem.mkdir).toHaveBeenCalledTimes(
			DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD.retries + 1,
		);
	});

	it("已开始的操作抛出 ELOCKED 时不重放操作，也不伪报取锁超时", async () => {
		const error = Object.assign(new Error("操作内部故障"), { code: "ELOCKED" });
		const operation = vi.fn(() => {
			throw error;
		});
		await expect(mutateCodexConfigurationSyncStore(operation)).rejects.toBe(error);
		expect(operation).toHaveBeenCalledOnce();
		expect(error.message).toBe("操作内部故障");
	});

	it("锁失效回调不抛出，compromise 后的 ERELEASED 不失败已完成的写入", async () => {
		const acquireLock = lockfile.lock;
		let onCompromised: ((error: Error) => void) | undefined;
		vi.spyOn(lockfile, "lock").mockImplementation((path, options) => {
			onCompromised = options?.onCompromised;
			return acquireLock(path, options).then((release) => async () => {
				await release();
				throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
			});
		});
		const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await expect(mutateCodexConfigurationSyncStore(() => "persisted")).resolves.toBe("persisted");
		expect(typeof onCompromised).toBe("function");
		expect(() => onCompromised?.(new Error("Unable to update lock within the stale threshold"))).not.toThrow();
		const stderrLines = stderrWrite.mock.calls.map((call) => String(call[0]));
		expect(stderrLines.some((line) => line.includes("[warn] [fs-lock]") && line.includes("compromised"))).toBe(true);
		expect(stderrLines.some((line) => line.includes("release-failed-benign") && line.includes("ERELEASED"))).toBe(
			true,
		);
	});
});
