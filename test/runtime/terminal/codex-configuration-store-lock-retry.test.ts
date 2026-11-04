import { realpath } from "node:fs/promises";
import type * as TimerPromises from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	lockedFileSystem,
	sumLockAcquisitionRetryWaitBudgetMs,
} from "../../../src/fs/locked-file-system";
import { createTempDir } from "../../utilities/temp-dir";

const lockRetryObservation = vi.hoisted(() => ({ onRetryScheduled: () => {} }));
vi.mock("node:timers/promises", async (importOriginal) => ({
	...(await importOriginal<typeof TimerPromises>()),
	// 只替换等待时钟，锁争用仍由真实 SQLite 连接产生。
	setTimeout: (delay: number, value: unknown) =>
		new Promise((resolve) => {
			setTimeout(resolve, delay, value);
			lockRetryObservation.onRetryScheduled();
		}),
}));

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

function configurationStoreLockRequest() {
	const directory = getCodexConfigurationSyncDirectory();
	return { path: directory, type: "directory" as const, lockfilePath: `${directory}.lock`, retries: 0 };
}

describe("配置存储复用统一内核锁预算，只重试取锁", () => {
	it("操作成功后释放同一内核锁路径", async () => {
		const operation = vi.fn(() => "persisted");
		await expect(mutateCodexConfigurationSyncStore(operation)).resolves.toBe("persisted");
		expect(operation).toHaveBeenCalledOnce();
		const release = await lockedFileSystem.acquireLock(configurationStoreLockRequest());
		await release();
	});

	it("持续占用在统一预算耗尽后退出，错误保留代码并报告锁路径、阶段和等待时长", async () => {
		const release = await lockedFileSystem.acquireLock(configurationStoreLockRequest());
		try {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
			const firstRetryScheduled = new Promise<void>((resolve) => {
				lockRetryObservation.onRetryScheduled = resolve;
			});
			const operation = vi.fn();
			let rejected = false;
			const waiting = mutateCodexConfigurationSyncStore(operation).catch((error: unknown) => {
				rejected = true;
				return error;
			});
			await firstRetryScheduled;
			const waitBudgetMs = sumLockAcquisitionRetryWaitBudgetMs(
				DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
			);
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
		} finally {
			await release();
		}
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

	it("释放失败保留诊断，不失败已完成的写入", async () => {
		const acquireLock = lockedFileSystem.acquireLock.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "acquireLock").mockImplementationOnce(async (request) => {
			const release = await acquireLock(request);
			return async () => {
				await release();
				throw Object.assign(new Error("隔离模拟释放失败"), { code: "EIO" });
			};
		});
		const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await expect(mutateCodexConfigurationSyncStore(() => "persisted")).resolves.toBe("persisted");
		expect(
			stderrWrite.mock.calls.some(
				([line]) => String(line).includes("[error] [fs-lock] release-failed") && String(line).includes("EIO"),
			),
		).toBe(true);
		const release = await acquireLock(configurationStoreLockRequest());
		await release();
	});
});
