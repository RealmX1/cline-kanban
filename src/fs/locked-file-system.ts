import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as waitBeforeLockAcquisitionRetry } from "node:timers/promises";
import Database from "better-sqlite3";
import type { LockOptions } from "proper-lockfile";
import {
	readUtf8FileWithDailyWorkProgressCostObservation,
	recordDailyWorkProgressFileWrite,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { logFileLockError } from "./lock-diagnostics-logger";

// 兼容旧调用者的导出；内核锁没有租期，staleMs 与 onCompromised 不再参与互斥判定。
export const DEFAULT_LOCK_STALE_MS = 30_000;

// 保留原有约 43s 的异步等待预算，持有者暂停不会释放锁。
// EXPERIMENT_NODE: 取锁退避预算；更长允许慢操作完成，更短可更快报告争用。
export const LOCK_ACQUISITION_WAIT_BUDGET_MARGIN_BEYOND_STALE_THRESHOLD_MS = 10_000;
export const DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD = {
	retries: 200,
	factor: 1.05,
	minTimeout: 25,
	maxTimeout: 250,
	randomize: false,
} as const satisfies NonNullable<LockOptions["retries"]>;

// 按 proper-lockfile 所用 `retry` 包的退避公式（randomize=false 时确定）求和：第 i 次重试前等待
// min(round(minTimeout × factor^i), maxTimeout)。不含每次尝试本身的耗时，所以是下界。
export function sumLockAcquisitionRetryWaitBudgetMs(schedule: {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
}): number {
	let totalWaitMs = 0;
	for (let attempt = 0; attempt < schedule.retries; attempt += 1) {
		totalWaitMs += Math.min(Math.round(schedule.minTimeout * schedule.factor ** attempt), schedule.maxTimeout);
	}
	return totalWaitMs;
}

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	canonicalLockPath: string;
	databasePath: string;
	retries: NonNullable<LockOptions["retries"]>;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
	durable?: boolean;
	fileMode?: number;
}

function safeLockErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

// 数据库文件不能删除或原子替换；它的 inode 在 workspace 删除、重建后仍代表同一把内核锁。
export function getFilesystemKernelWriteLockDirectoryPath(): string {
	// 归属操作系统账号，不能随调用进程 HOME 改变，否则共享目标会被拆成两把锁。
	return join(userInfo().homedir, ".cline", "kanban", "filesystem-kernel-write-locks");
}

async function canonicalizeLockPath(path: string): Promise<string> {
	const absolutePath = resolve(path);
	try {
		return await realpath(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolutePath);
		if (parent === absolutePath) throw error;
		return join(await canonicalizeLockPath(parent), absolutePath.slice(parent.length));
	}
}

function foldCanonicalFilesystemKernelWriteLockPath(canonicalLockPath: string): string {
	let foldedPath = canonicalLockPath.normalize("NFD");
	// 展开 Unicode 大写后再小写，迭代覆盖 ẞ → ß → ss；不能稳定时拒绝创建另一把锁。
	for (let pass = 0; pass < 8; pass += 1) {
		const nextFoldedPath = foldedPath.toUpperCase().toLowerCase().normalize("NFD");
		if (nextFoldedPath === foldedPath) return foldedPath;
		foldedPath = nextFoldedPath;
	}
	throw new Error("锁路径的 Unicode 归一化未能稳定，已拒绝取锁。");
}

async function acquireNormalizedKernelWriteLock(request: NormalizedLockRequest): Promise<() => Promise<void>> {
	const explicitRetryDelays = Array.isArray(request.retries)
		? request.retries.slice().sort((a, b) => a - b)
		: undefined;
	const retryOptions =
		typeof request.retries === "number"
			? { retries: request.retries }
			: Array.isArray(request.retries)
				? {}
				: request.retries;
	const retryCount = explicitRetryDelays?.length ?? retryOptions.retries ?? 10;
	const startedAtMs = performance.now();
	// 禁止 forever：旧请求类型继续兼容，但跨进程争用始终有界。
	if (retryOptions.forever || !Number.isFinite(retryCount) || retryCount < 0)
		throw new Error("文件锁重试必须使用有限的非负预算。");
	const database = new Database(request.databasePath, { timeout: 0 });
	try {
		for (let attempt = 0; ; attempt += 1) {
			try {
				database.exec("BEGIN IMMEDIATE");
				break;
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
				if (attempt >= retryCount || performance.now() - startedAtMs >= (retryOptions.maxRetryTime ?? Infinity))
					throw Object.assign(new Error(`文件锁等待预算耗尽：${request.canonicalLockPath}`), { code: "ELOCKED" });
				const randomFactor = retryOptions.randomize ? 1 + Math.random() : 1;
				const delay =
					explicitRetryDelays?.[attempt] ??
					Math.min(
						Math.round(randomFactor * (retryOptions.minTimeout ?? 1_000) * (retryOptions.factor ?? 2) ** attempt),
						retryOptions.maxTimeout ?? Number.MAX_SAFE_INTEGER,
					);
				if (!Number.isFinite(delay) || delay < 0 || delay > 2_147_483_647)
					throw new Error("文件锁退避时长超出有限计时器预算。");
				await waitBeforeLockAcquisitionRetry(
					Math.min(
						delay,
						Math.max(0, (retryOptions.maxRetryTime ?? Infinity) - (performance.now() - startedAtMs)),
					),
					undefined,
					{ ref: !retryOptions.unref },
				);
			}
		}
	} catch (error) {
		database.close();
		throw error;
	}
	return async () => {
		try {
			if (database.inTransaction) database.exec("ROLLBACK");
		} finally {
			database.close();
		}
	};
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		const content = await readUtf8FileWithDailyWorkProgressCostObservation(path);
		return content;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function synchronizeFilesystemPath(path: string, filesystemPathKind: "file" | "directory"): Promise<void> {
	const isWindows = platform() === "win32";
	// Windows 沿用不执行目录 fsync 的平台契约；文件 FlushFileBuffers 必须取得可写句柄。
	if (isWindows && filesystemPathKind === "directory") return;
	const handle = await open(path, isWindows ? "r+" : "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		await mkdir(request.type === "directory" ? request.path : dirname(request.path), { recursive: true });
		const lockPath =
			request.lockfilePath ??
			(request.type === "directory" ? join(request.path, request.lockfileName ?? ".lock") : `${request.path}.lock`);
		// 不存在的叶子也折叠，保守串行大小写与 Unicode 别名；不依赖会在原子替换后改变的目标 inode。
		const canonicalLockPath = foldCanonicalFilesystemKernelWriteLockPath(await canonicalizeLockPath(lockPath));
		const directoryPath = getFilesystemKernelWriteLockDirectoryPath();
		await mkdir(directoryPath, { recursive: true, mode: 0o700 });
		return {
			canonicalLockPath,
			databasePath: join(directoryPath, `${createHash("sha256").update(canonicalLockPath).digest("hex")}.sqlite`),
			retries: request.retries ?? DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
		};
	}

	// Codex 存储的显式 acquire/release 调用也经同一协议，释放时关闭持锁的同进程连接。
	async acquireLock(request: LockRequest): Promise<() => Promise<void>> {
		return await acquireNormalizedKernelWriteLock(await this.normalizeLockRequest(request));
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(requests.map((request) => this.normalizeLockRequest(request)));
		const orderedRequests = [
			...new Map(normalizedRequests.map((request) => [request.canonicalLockPath, request])).values(),
		].sort((left, right) =>
			left.canonicalLockPath < right.canonicalLockPath
				? -1
				: left.canonicalLockPath > right.canonicalLockPath
					? 1
					: 0,
		);
		const acquiredLocks: Array<{ canonicalLockPath: string; release: () => Promise<void> }> = [];
		try {
			for (const request of orderedRequests) {
				const release = await acquireNormalizedKernelWriteLock(request);
				acquiredLocks.push({ canonicalLockPath: request.canonicalLockPath, release });
			}
			return await operation();
		} finally {
			for (const acquired of acquiredLocks.reverse()) {
				try {
					await acquired.release();
				} catch (error) {
					logFileLockError(
						`release-failed path=${acquired.canonicalLockPath} error=${safeLockErrorMessage(error)}`,
					);
				}
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await chmod(path, 0o755);
				}
				if (options.durable) {
					// 上次可能已 rename，但目录 fsync 失败；同内容重试仍须完成持久化。
					await synchronizeFilesystemPath(path, "file");
					await synchronizeFilesystemPath(dirname(path), "directory");
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			try {
				await writeFile(tempPath, content, { encoding: "utf8", mode: options.fileMode });
				recordDailyWorkProgressFileWrite(content);
				// writeFile 的创建权限会被 umask 过滤，rename 前必须恢复显式权限。
				if (options.fileMode !== undefined) await chmod(tempPath, options.fileMode);
				if (options.executable) await chmod(tempPath, 0o755);
				if (options.durable) await synchronizeFilesystemPath(tempPath, "file");
				await rename(tempPath, path);
				if (options.durable) await synchronizeFilesystemPath(dirname(path), "directory");
			} finally {
				await rm(tempPath, { force: true });
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
