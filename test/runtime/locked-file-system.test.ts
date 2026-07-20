import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { LockedFileSystem } from "../../src/fs/locked-file-system";

type LockOptionsShape = {
	onCompromised?: (error: Error) => void;
};

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
});
