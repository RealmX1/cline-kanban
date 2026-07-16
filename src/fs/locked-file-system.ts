import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { logFileLockError, logFileLockWarning } from "./lock-diagnostics-logger";

// proper-lockfile 每 stale/2 刷新一次锁的 mtime；一旦刷新定时器因事件循环停摆而错过、锁即被判 stale
// 并 compromise。10s 太紧，重负载下的偶发 GC/IO/停摆抖动就会误判。放宽到 30s（刷新周期 15s）以吸收
// 这些抖动。注意：这只是纵深防御的调参，真正的停摆根因在 workspace diff 的并发治理（见 git-concurrency）。
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

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
	path: string;
	options: LockOptions;
	sortKey: string;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

function safeLockErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

// compromise 之后 proper-lockfile 会把锁标记为已释放并删除锁文件，此时 release() 以这些 code 拒绝——
// 对一个已失效的锁而言都是良性的、可预期的 compromise 善后信号，而非真正的锁文件删除失败。
const BENIGN_RELEASE_FAILURE_CODES: ReadonlySet<string> = new Set(["ERELEASED", "ENOTACQUIRED", "ENOENT"]);

function isBenignReleaseFailure(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as NodeJS.ErrnoException).code;
		return typeof code === "string" && BENIGN_RELEASE_FAILURE_CODES.has(code);
	}
	return false;
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	const options: LockOptions = {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
	};
	// proper-lockfile 的默认 onCompromised 直接 `throw`；该回调运行在 mtime 刷新的定时器里，抛出即
	// uncaughtException → installCliFatalErrorHandlers → process.exit(1)，一次可恢复的锁抖动就会杀掉整个
	// 多项目服务器。调用方未显式提供时，安装一个「记录且绝不抛」的默认处理器：advisory 锁 compromise 最坏
	// 只是下一次原子写需重取锁/重试，把它降级为可用性事件而非致命退出。
	options.onCompromised =
		typeof request.onCompromised === "function"
			? request.onCompromised
			: (error: Error) => {
					logFileLockWarning(`compromised path=${lockfilePath} error=${safeLockErrorMessage(error)}`);
				};
	return options;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const orderedRequests = normalizedRequests
			.slice()
			.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
		const acquiredLocks: Array<{ lockfilePath: string; release: () => Promise<void> }> = [];
		try {
			for (const request of orderedRequests) {
				const release = await lockfile.lock(request.path, request.options);
				acquiredLocks.push({ lockfilePath: request.sortKey, release });
			}
			return await operation();
		} finally {
			for (const acquired of acquiredLocks.reverse()) {
				try {
					await acquired.release();
				} catch (error) {
					// 所有 release() 失败都在此被【刻意吞掉】、绝不重新抛出：该 try/catch 的唯一职责是消灭
					// 「compromise 后 release() reject → unhandledRejection → installCliFatalErrorHandlers →
					// process.exit(1)」这条第二崩溃路径，一次可恢复的锁抖动不得杀掉整个多项目服务器（尤其在
					// fire-and-forget 的原子写调用点）。但日志需区分两类，避免把真实故障与良性情况混为一谈：
					//   - 良性（ERELEASED / ENOTACQUIRED / ENOENT）：compromise 后锁已被标记释放并删除锁文件，
					//     release() 因此拒绝——对已失效的锁属预期善后，记为 [warn]。
					//   - 意外（EACCES / EIO / EPERM 等）：锁文件真的删不掉，写操作虽已成功却遗留了陈旧锁文件，
					//     记为更醒目的 [error] 让运维察觉；遗留锁本身可经 staleMs(30s) 自愈，故仍无需抛出。
					const releaseFailureLogTail = `path=${acquired.lockfilePath} error=${safeLockErrorMessage(error)}`;
					if (isBenignReleaseFailure(error)) {
						logFileLockWarning(`release-failed-benign ${releaseFailureLogTail}`);
					} else {
						logFileLockError(`release-failed-unexpected ${releaseFailureLogTail}`);
					}
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
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
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
