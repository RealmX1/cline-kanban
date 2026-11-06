import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { lockedFileSystem, releaseFilesystemKernelWriteLock } from "../fs/locked-file-system";
import { describeCodexConfigurationHistorySearchText } from "./codex-configuration-change-presentation";
import type { CodexConfigurationSyncStore } from "./codex-configuration-sync-store";

const configurationStorageNativeBindingPath = join(
	dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json")),
	"build",
	"Release",
	"better_sqlite3.node",
);

interface ConfigurationStorageAuthority {
	schemaVersion: 1;
	phase: "migration_prepared" | "sqlite_authoritative" | "legacy_rollback_prepared" | "legacy_restored";
	storageIdentity: string;
	migrationIdentity: string;
	backupDirectory: string;
	originalFileDigest: string | null;
	legacyRollbackExportPath?: string;
	legacyRollbackContentDigest?: string;
	legacyRollbackStorageGeneration?: number;
}
const configurationStorageRecoveryObservationSchema = z.object({
	failureFingerprint: z.string(),
	failureScope: z.enum(["storage", "write", "write_lock"]).default("storage"),
	attemptCount: z.number().int().nonnegative(),
	nextHealthProbeAtMs: z.number(),
	failureReason: z.string(),
	automaticRecoveryCondition: z.literal("database_permission_identity_native_abi_or_lock_availability_changes"),
});
type ConfigurationStorageRecoveryObservation = z.infer<typeof configurationStorageRecoveryObservationSchema>;
const configurationStorageAuthoritySchema = z.object({
	schemaVersion: z.literal(1),
	phase: z.enum(["migration_prepared", "sqlite_authoritative", "legacy_rollback_prepared", "legacy_restored"]),
	storageIdentity: z.string().uuid(),
	migrationIdentity: z.string().uuid(),
	backupDirectory: z.string(),
	originalFileDigest: z.string().nullable(),
	legacyRollbackExportPath: z.string().optional(),
	legacyRollbackContentDigest: z.string().optional(),
	legacyRollbackStorageGeneration: z.number().int().nonnegative().optional(),
});
export interface CodexConfigurationStoreReadSelection {
	scope: "full" | "active" | "lookup";
	changeIds?: string[];
	writerIds?: string[];
	targetWriterIds?: string[];
	writerHomePaths?: string[];
	legacyMarketplaceInstallationSourceIdentities?: string[];
	sourceIdentityBindingEvidenceSourceIdentities?: string[];
	observationIds?: string[];
	receiptKeys?: string[];
	hookTrustDecisionIds?: string[];
	includeTerminalTargets?: boolean;
	includeActiveTargets?: boolean;
}
export interface CodexConfigurationHistoryStoragePage {
	entries: Array<{ entry_kind: "settings" | "sources"; entry_id: string; entry_version: number }>;
	totalCount: number;
	storageIdentity: string;
	storageGeneration: number;
	historyMaximumSequence: number;
	historyProjectionGeneration: number;
	nextCursor: string | null;
}

async function writeDurableConfigurationStorageFile(path: string, bytes: string | Buffer, mode = 0o600) {
	const pending = `${path}.${randomUUID()}.pending`;
	const handle = await open(pending, "wx", mode);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(pending, path);
	if (process.platform === "win32") return;
	const directory = await open(join(path, ".."), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
async function readOptionalFile(path: string) {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
function normalizedContentDigest(value: unknown): string {
	const canonicalize = (entry: unknown): unknown => {
		if (Array.isArray(entry)) return entry.map(canonicalize);
		if (entry && typeof entry === "object")
			return Object.fromEntries(
				Object.entries(entry)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, canonicalize(item)]),
			);
		return entry;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

export class CodexConfigurationSyncDatabaseWorkerClient {
	private readonly worker: Worker;
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	private failed: Error | null = null;
	private recoveryObservation: ConfigurationStorageRecoveryObservation | null = null;
	private recoveryObservationLoaded = false;
	private recoveryPersistence: Promise<void> = Promise.resolve();
	lastReadMetrics = { decodedRows: 0, decodedBytes: 0 };
	cumulativeReadMetrics = { decodedRows: 0, decodedBytes: 0, completedRequests: 0 };
	constructor(
		private readonly directory: string,
		storageIdentity: string,
		allowCreate: boolean,
	) {
		this.worker = new Worker(new URL("./codex-configuration-sync-database-worker.mjs", import.meta.url), {
			workerData: { directory, storageIdentity, allowCreate },
		});
		this.worker.on(
			"message",
			(message: {
				requestId: string;
				result?: unknown;
				error?: string;
				code?: string;
				metrics: { decodedRows: number; decodedBytes: number };
			}) => {
				this.lastReadMetrics = message.metrics;
				this.cumulativeReadMetrics.decodedRows += message.metrics.decodedRows;
				this.cumulativeReadMetrics.decodedBytes += message.metrics.decodedBytes;
				this.cumulativeReadMetrics.completedRequests++;
				const pending = this.pending.get(message.requestId);
				this.pending.delete(message.requestId);
				if (message.error) {
					const error = Object.assign(new Error(message.error), { code: message.code });
					if (message.code === "CONFIGURATION_STORAGE_PHYSICAL_IDENTITY_CHANGED") {
						this.failed = error;
						void this.worker.terminate();
					}
					pending?.reject(error);
				} else pending?.resolve(message.result);
				if (!this.pending.size) this.worker.unref();
			},
		);
		const fail = (error: Error) => {
			this.failed = error;
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", () =>
			fail(this.failed ?? new Error("配置同步数据库 worker 已退出；提交结果须按原操作身份核验。")),
		);
		this.worker.unref();
	}
	get unavailable() {
		return this.failed !== null;
	}
	private async requestRaw<T>(command: string, input: unknown = {}): Promise<T> {
		if (this.failed) throw this.failed;
		const requestId = randomUUID();
		this.worker.ref();
		return await new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(
				() => {
					this.pending.delete(requestId);
					const error = Object.assign(new Error("配置同步数据库响应超时，提交结果保持未知。"), {
						code: "CONFIGURATION_STORAGE_WORKER_RESPONSE_TIMEOUT",
					});
					this.failed = error;
					reject(error);
					void this.worker.terminate();
				},
				command === "import" || (input as { scope?: string })?.scope === "full" ? 120_000 : 15_000,
			);
			timeout.unref();
			this.pending.set(requestId, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			this.worker.postMessage({ requestId, command, input });
		});
	}
	private async failureFingerprint(code: string) {
		return await configurationStorageFailureFingerprint(this.directory, code);
	}

	private async persistRecoveryObservation() {
		this.recoveryPersistence = this.recoveryPersistence
			.catch(() => {})
			.then(async () => {
				if (this.recoveryObservation)
					await writeDurableConfigurationStorageFile(
						join(this.directory, "configuration-sync-database-recovery-observation.json"),
						JSON.stringify(this.recoveryObservation),
					);
			});
		await this.recoveryPersistence;
	}
	private async loadRecoveryObservation() {
		if (this.recoveryObservationLoaded) return;
		const bytes = await readOptionalFile(
			join(this.directory, "configuration-sync-database-recovery-observation.json"),
		);
		this.recoveryObservation = bytes
			? configurationStorageRecoveryObservationSchema.parse(JSON.parse(bytes.toString("utf8")))
			: null;
		this.recoveryObservationLoaded = true;
	}
	private async clearRecoveryObservation() {
		if (!this.recoveryObservation?.attemptCount) return;
		this.recoveryObservation = { ...this.recoveryObservation, attemptCount: 0, nextHealthProbeAtMs: 0 };
		await this.persistRecoveryObservation().catch(() => {});
	}
	private async verifyRecoveryAdmission(requiresWrite: boolean) {
		await this.loadRecoveryObservation();
		const previous = this.recoveryObservation;
		if (
			!previous ||
			(previous.failureScope !== "storage" && !requiresWrite) ||
			previous.attemptCount < 3 ||
			previous.failureFingerprint !== (await this.failureFingerprint(previous.failureReason))
		)
			return;
		if (Date.now() < previous.nextHealthProbeAtMs)
			throw Object.assign(new Error("配置同步存储等待既定恢复条件，后台将自动健康探测。"), {
				code: "CONFIGURATION_STORAGE_AWAITING_RECOVERY_EVIDENCE",
			});
		// 取锁失败只能由同一把内核锁的下一次有界取锁补证，数据库写探测不能替代它。
		if (previous.failureScope === "write_lock") {
			this.recoveryObservation = { ...previous, nextHealthProbeAtMs: Date.now() + 30_000 };
			await this.persistRecoveryObservation();
			return;
		}
		await this.requestRaw("storage_health_probe");
		await this.clearRecoveryObservation();
	}
	private async recordFailure(error: unknown, failureScope: "storage" | "write" | "write_lock") {
		const code = (error as NodeJS.ErrnoException).code ?? (this.failed ? "CONFIGURATION_STORAGE_WORKER_EXITED" : "");
		if (
			!code.startsWith("SQLITE_") &&
			!code.startsWith("ERR_DLOPEN") &&
			![
				"ELOCKED",
				"EACCES",
				"EPERM",
				"ENOSPC",
				"EIO",
				"CONFIGURATION_STORAGE_WORKER_EXITED",
				"CONFIGURATION_STORAGE_WORKER_RESPONSE_TIMEOUT",
			].includes(code)
		)
			return;
		const fingerprint = await this.failureFingerprint(code);
		this.recoveryObservation = {
			failureFingerprint: fingerprint,
			failureScope,
			attemptCount:
				this.recoveryObservation?.failureFingerprint === fingerprint &&
				this.recoveryObservation.failureScope === failureScope
					? Math.min(3, this.recoveryObservation.attemptCount + 1)
					: 1,
			nextHealthProbeAtMs: Date.now() + 30_000,
			failureReason: code,
			automaticRecoveryCondition: "database_permission_identity_native_abi_or_lock_availability_changes",
		};
		await this.persistRecoveryObservation().catch(() => {});
	}
	async verifyWriteAdmission() {
		try {
			await this.verifyRecoveryAdmission(true);
		} catch (error) {
			await this.recordFailure(error, "write");
			throw error;
		}
	}
	async recordWriteLockFailure(error: unknown) {
		await this.loadRecoveryObservation();
		await this.recordFailure(error, "write_lock");
	}
	async confirmWriteLockAcquired() {
		if (this.recoveryObservation?.failureScope === "write_lock") await this.clearRecoveryObservation();
	}
	async request<T>(command: string, input: unknown = {}): Promise<T> {
		if (command === "close") return await this.requestRaw(command, input);
		const requiresWrite = ["import", "commit", "freeze_legacy_rollback", "storage_health_probe"].includes(command);
		try {
			await this.verifyRecoveryAdmission(requiresWrite);
			if (command === "import" || command === "commit") {
				const payload = input as {
					store?: CodexConfigurationSyncStore;
					after?: CodexConfigurationSyncStore;
					before?: CodexConfigurationSyncStore;
				};
				const store = payload.store ?? payload.after;
				if (!store) throw new Error("配置存储提交缺少领域快照。");
				const previous = new Map(payload.before?.changes.map((change) => [change.changeId, change]));
				input = {
					...payload,
					historySearchTexts: Object.fromEntries(
						store.changes
							.filter((change) => JSON.stringify(change) !== JSON.stringify(previous.get(change.changeId)))
							.map((change) => [change.changeId, describeCodexConfigurationHistorySearchText(store, change)]),
					),
				};
			}
			const result = await this.requestRaw<T>(command, input);
			const confirmedDatabaseWrite =
				requiresWrite &&
				(command !== "commit" ||
					(result as { storageGeneration: number }).storageGeneration >
						(input as { expectedStorageGeneration: number }).expectedStorageGeneration);
			if (confirmedDatabaseWrite || this.recoveryObservation?.failureScope === "storage")
				await this.clearRecoveryObservation();
			return result;
		} catch (error) {
			await this.recordFailure(error, requiresWrite ? "write" : "storage");
			throw error;
		}
	}
	async close() {
		try {
			if (!this.failed) await this.request("close");
		} finally {
			await this.worker.terminate();
		}
	}
}

const clientsByDirectory = new Map<string, Promise<CodexConfigurationSyncDatabaseWorkerClient>>();
export async function getCodexConfigurationSyncDatabaseClient(
	directory: string,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
	prepareMigrationStore?: (store: CodexConfigurationSyncStore) => Promise<CodexConfigurationSyncStore>,
	prepareLegacyRollback?: (store: CodexConfigurationSyncStore) => Promise<void>,
): Promise<CodexConfigurationSyncDatabaseWorkerClient> {
	let pending = clientsByDirectory.get(directory);
	if (!pending) {
		for (const [otherDirectory, otherClient] of clientsByDirectory)
			if (otherDirectory !== directory) {
				clientsByDirectory.delete(otherDirectory);
				await (await otherClient.catch(() => null))?.close();
			}
		pending = initializeConfigurationSyncDatabase(
			directory,
			parseLegacy,
			prepareMigrationStore,
			prepareLegacyRollback,
		);
		clientsByDirectory.set(directory, pending);
		void pending.catch(() => {
			if (clientsByDirectory.get(directory) === pending) clientsByDirectory.delete(directory);
		});
	}
	const client = await pending;
	if (client.unavailable) {
		if (clientsByDirectory.get(directory) === pending) clientsByDirectory.delete(directory);
		return await getCodexConfigurationSyncDatabaseClient(
			directory,
			parseLegacy,
			prepareMigrationStore,
			prepareLegacyRollback,
		);
	}
	return client;
}
async function freezeCurrentLegacyConfigurationSource(
	directory: string,
	original: Buffer | null,
): Promise<ConfigurationStorageAuthority> {
	const legacyPath = join(directory, "configuration-sync-state.json");
	const authorityPath = join(directory, "configuration-sync-storage-authority.json");
	const migrationIdentity = randomUUID();
	const backupDirectory = join(directory, "configuration-sync-migration-backups", migrationIdentity);
	await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
	const originalFileDigest = original ? createHash("sha256").update(original).digest("hex") : null;
	const originalMetadata = original ? await lstat(legacyPath, { bigint: true }) : null;
	if (originalMetadata && (!originalMetadata.isFile() || originalMetadata.isSymbolicLink()))
		throw new Error("旧配置同步状态不是普通文件。");
	if (original)
		await writeDurableConfigurationStorageFile(
			join(backupDirectory, "configuration-sync-state.original.json"),
			original,
		);
	await writeDurableConfigurationStorageFile(
		join(backupDirectory, "configuration-sync-original-file-provenance.json"),
		JSON.stringify({
			originalFileDigest,
			mode: originalMetadata ? Number(originalMetadata.mode & 0o777n) : null,
			device: originalMetadata?.dev.toString(),
			inode: originalMetadata?.ino.toString(),
		}),
	);
	const authority: ConfigurationStorageAuthority = {
		schemaVersion: 1,
		phase: "migration_prepared",
		storageIdentity: randomUUID(),
		migrationIdentity,
		backupDirectory,
		originalFileDigest,
	};
	await writeDurableConfigurationStorageFile(authorityPath, JSON.stringify(authority));
	return authority;
}
async function configurationStorageFailureFingerprint(directory: string, code: string) {
	const file = await lstat(join(directory, "codex-configuration-sync.sqlite")).catch(() => null);
	const nativeBinding = await lstat(configurationStorageNativeBindingPath).catch(() => null);
	return createHash("sha256")
		.update(
			JSON.stringify([
				code,
				process.versions.modules,
				file && [
					file.dev,
					file.ino,
					file.mode,
					code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" ? [file.size, file.mtimeMs] : null,
				],
				nativeBinding && [nativeBinding.size, nativeBinding.mtimeMs],
			]),
		)
		.digest("hex");
}
async function initializeConfigurationSyncDatabase(
	directory: string,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
	prepareMigrationStore?: (store: CodexConfigurationSyncStore) => Promise<CodexConfigurationSyncStore>,
	prepareLegacyRollback?: (store: CodexConfigurationSyncStore) => Promise<void>,
) {
	const recoveryPath = join(directory, "configuration-sync-database-recovery-observation.json");
	const previousBytes = await readOptionalFile(recoveryPath);
	const previous = previousBytes
		? configurationStorageRecoveryObservationSchema.parse(JSON.parse(previousBytes.toString("utf8")))
		: null;
	if (
		previous &&
		previous.failureScope === "storage" &&
		previous.attemptCount >= 3 &&
		previous.failureFingerprint ===
			(await configurationStorageFailureFingerprint(directory, previous.failureReason)) &&
		Date.now() < previous.nextHealthProbeAtMs
	)
		throw new Error("配置同步存储等待机器恢复条件，后续健康探测将自动重新打开。");
	try {
		return await initializeConfigurationSyncDatabaseWithoutRecoveryGate(
			directory,
			parseLegacy,
			prepareMigrationStore,
			prepareLegacyRollback,
		);
	} catch (error) {
		const currentBytes = await readOptionalFile(recoveryPath).catch(() => null);
		const current = currentBytes
			? configurationStorageRecoveryObservationSchema.parse(JSON.parse(currentBytes.toString("utf8")))
			: null;
		if (!current || current.attemptCount <= (previous?.attemptCount ?? 0)) {
			const code = (error as NodeJS.ErrnoException).code ?? "CONFIGURATION_STORAGE_INITIALIZATION_UNAVAILABLE";
			const fingerprint = await configurationStorageFailureFingerprint(directory, code);
			const observation: ConfigurationStorageRecoveryObservation = {
				failureFingerprint: fingerprint,
				failureScope: "storage",
				attemptCount: previous?.failureFingerprint === fingerprint ? previous.attemptCount + 1 : 1,
				nextHealthProbeAtMs: Date.now() + 30_000,
				failureReason: code,
				automaticRecoveryCondition: "database_permission_identity_native_abi_or_lock_availability_changes",
			};
			await writeDurableConfigurationStorageFile(recoveryPath, JSON.stringify(observation)).catch(() => {});
		}
		throw error;
	}
}
async function initializeConfigurationSyncDatabaseWithoutRecoveryGate(
	directory: string,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
	prepareMigrationStore?: (store: CodexConfigurationSyncStore) => Promise<CodexConfigurationSyncStore>,
	prepareLegacyRollback?: (store: CodexConfigurationSyncStore) => Promise<void>,
) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
		throw new Error("配置同步目录不是可信普通目录。");
	const lockfilePath = `${directory}.lock`;
	const lockAcquisitionStartedAtMs = performance.now();
	const release = await lockedFileSystem
		.acquireLock({ path: directory, type: "directory", lockfilePath })
		.catch((error: unknown) => {
			if (error instanceof Error)
				error.message = `Codex 配置存储取锁失败：lockPath=${lockfilePath} phase=lock_acquisition waitedMs=${Math.round(performance.now() - lockAcquisitionStartedAtMs)}；${error.message}`;
			throw error;
		});
	let client: CodexConfigurationSyncDatabaseWorkerClient | undefined;
	try {
		const authorityPath = join(directory, "configuration-sync-storage-authority.json");
		const legacyPath = join(directory, "configuration-sync-state.json");
		const authorityBytes = await readOptionalFile(authorityPath);
		let authority = authorityBytes
			? configurationStorageAuthoritySchema.parse(JSON.parse(authorityBytes.toString("utf8")))
			: undefined;
		if (
			authority &&
			authority.backupDirectory !==
				join(directory, "configuration-sync-migration-backups", authority.migrationIdentity)
		)
			throw new Error("迁移备份目录与持久身份不符。");
		if (authority?.phase === "legacy_rollback_prepared") {
			await finishPreparedLegacyRollback(directory, authority, parseLegacy);
			throw new Error("配置同步已恢复到最新旧格式状态，SQLite 写入保持关闭。");
		}
		if (authority?.phase === "legacy_restored")
			throw new Error("配置同步已回退旧存储，须通过新的迁移流程重新取得 SQLite 写入资格。");
		if (!authority) {
			const original = await readOptionalFile(legacyPath);
			if (original && JSON.parse(original.toString("utf8")).storageBackend === "sqlite")
				throw new Error("迁移哨兵存在但权威凭证缺失，已保留现场。");
			if (
				await lstat(join(directory, "codex-configuration-sync.sqlite")).then(
					() => true,
					(error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return false;
						throw error;
					},
				)
			)
				throw new Error("存在无权威凭证的配置同步数据库，禁止覆盖或初始化。");
			authority = await freezeCurrentLegacyConfigurationSource(directory, original);
		}
		if (authority.phase === "migration_prepared") {
			const current = await readOptionalFile(legacyPath);
			const sentinel = current ? (JSON.parse(current.toString("utf8")) as Record<string, unknown>) : undefined;
			if (sentinel?.storageBackend !== "sqlite") {
				const digest = current ? createHash("sha256").update(current).digest("hex") : null;
				if (digest !== authority.originalFileDigest) {
					authority = await freezeCurrentLegacyConfigurationSource(directory, current);
				}
				await writeDurableConfigurationStorageFile(
					legacyPath,
					JSON.stringify({
						schemaVersion: "sqlite_storage_authority_v1",
						storageBackend: "sqlite",
						storageIdentity: authority.storageIdentity,
						migrationIdentity: authority.migrationIdentity,
					}),
				);
			} else if (
				sentinel.storageIdentity !== authority.storageIdentity ||
				sentinel.migrationIdentity !== authority.migrationIdentity
			)
				throw new Error("迁移哨兵身份不匹配。");
			const original = await readOptionalFile(
				join(authority.backupDirectory, "configuration-sync-state.original.json"),
			);
			if ((original ? createHash("sha256").update(original).digest("hex") : null) !== authority.originalFileDigest)
				throw new Error("迁移备份摘要不匹配。");
			const normalizedPath = join(authority.backupDirectory, "configuration-sync-state.normalized.json");
			let normalizedBytes = await readOptionalFile(normalizedPath);
			if (!normalizedBytes) {
				const parsed = parseLegacy(original ? JSON.parse(original.toString("utf8")) : undefined);
				const frozen = prepareMigrationStore ? await prepareMigrationStore(parsed) : parsed;
				normalizedBytes = Buffer.from(JSON.stringify(frozen));
				await writeDurableConfigurationStorageFile(normalizedPath, normalizedBytes);
			}
			const normalized = parseLegacy(JSON.parse(normalizedBytes.toString("utf8")));
			client = new CodexConfigurationSyncDatabaseWorkerClient(directory, authority.storageIdentity, true);
			await client.request("import", {
				store: normalized,
				migrationIdentity: authority.migrationIdentity,
				normalizedContentDigest: normalizedContentDigest(normalized),
			});
			const exported = await client.request<CodexConfigurationSyncStore>("snapshot", { scope: "full" });
			const legacyExport = legacyConfigurationSnapshot(exported);
			if (normalizedContentDigest(legacyExport) !== normalizedContentDigest(normalized))
				throw new Error("迁移后的完整内容核验失败，已保留备份和数据库。");
			authority.phase = "sqlite_authoritative";
			await writeDurableConfigurationStorageFile(authorityPath, JSON.stringify(authority));
		} else {
			client = new CodexConfigurationSyncDatabaseWorkerClient(directory, authority.storageIdentity, false);
			const stored = await client.request<{ writeGateClosed?: boolean }>("metadata");
			if (stored.writeGateClosed) {
				await prepareAndFinishLegacyRollback(directory, authority, client, parseLegacy, prepareLegacyRollback);
				throw new Error("已自动完成中断的旧格式回退，SQLite 写入保持关闭。");
			}
		}
		return client;
	} catch (error) {
		await client?.close().catch(() => {});
		throw error;
	} finally {
		await releaseFilesystemKernelWriteLock(release, lockfilePath);
	}
}
export async function closeCodexConfigurationSyncDatabaseClients() {
	const clients = [...clientsByDirectory.values()];
	clientsByDirectory.clear();
	await Promise.all(clients.map(async (pending) => (await pending.catch(() => null))?.close()));
}

function legacyConfigurationSnapshot(store: CodexConfigurationSyncStore) {
	const {
		storageIdentity: _excludedStorageIdentity,
		storageGeneration: _excludedStorageGeneration,
		sourceDecisionGenerations: _excludedSourceDecisionGenerations,
		historyTotalCount: _excludedHistoryTotalCount,
		historyMaximumSequence: _excludedHistoryMaximumSequence,
		historyProjectionGeneration: _excludedHistoryProjectionGeneration,
		...legacy
	} = store;
	return legacy;
}
async function finishPreparedLegacyRollback(
	directory: string,
	authority: ConfigurationStorageAuthority,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
) {
	const expectedExportPath = join(
		authority.backupDirectory,
		"configuration-sync-latest-state-for-legacy-rollback.json",
	);
	if (authority.legacyRollbackExportPath !== expectedExportPath || !authority.legacyRollbackContentDigest)
		throw new Error("回退导出身份缺失，已保留 SQLite 写入屏障。");
	const exported = await readFile(expectedExportPath, "utf8");
	if (normalizedContentDigest(parseLegacy(JSON.parse(exported))) !== authority.legacyRollbackContentDigest)
		throw new Error("最新状态回退导出摘要不符。");
	const legacyPath = join(directory, "configuration-sync-state.json");
	const current = JSON.parse(await readFile(legacyPath, "utf8")) as { storageBackend?: string };
	if (current.storageBackend === "sqlite") await writeDurableConfigurationStorageFile(legacyPath, exported);
	else parseLegacy(current); // 已恢复的旧写入者可能继续提交，不能覆盖其较新状态。
	authority.phase = "legacy_restored";
	await writeDurableConfigurationStorageFile(
		join(directory, "configuration-sync-storage-authority.json"),
		JSON.stringify(authority),
	);
}

export async function restoreLatestCodexConfigurationSyncStateToLegacyStorage(
	directory: string,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
	prepareLegacyRollback?: (store: CodexConfigurationSyncStore) => Promise<void>,
) {
	const client = await getCodexConfigurationSyncDatabaseClient(
		directory,
		parseLegacy,
		undefined,
		prepareLegacyRollback,
	);
	const lockfilePath = `${directory}.lock`;
	const lockAcquisitionStartedAtMs = performance.now();
	const release = await lockedFileSystem
		.acquireLock({ path: directory, type: "directory", lockfilePath })
		.catch((error: unknown) => {
			if (error instanceof Error)
				error.message = `Codex 配置存储取锁失败：lockPath=${lockfilePath} phase=lock_acquisition waitedMs=${Math.round(performance.now() - lockAcquisitionStartedAtMs)}；${error.message}`;
			throw error;
		});
	try {
		const authority = configurationStorageAuthoritySchema.parse(
			JSON.parse(await readFile(join(directory, "configuration-sync-storage-authority.json"), "utf8")),
		);
		if (authority.phase !== "sqlite_authoritative") throw new Error("当前配置同步存储尚未取得回退资格。");
		return await prepareAndFinishLegacyRollback(directory, authority, client, parseLegacy, prepareLegacyRollback);
	} finally {
		await releaseFilesystemKernelWriteLock(release, lockfilePath);
	}
}

async function prepareAndFinishLegacyRollback(
	directory: string,
	authority: ConfigurationStorageAuthority,
	client: CodexConfigurationSyncDatabaseWorkerClient,
	parseLegacy: (value: unknown) => CodexConfigurationSyncStore,
	prepareLegacyRollback?: (store: CodexConfigurationSyncStore) => Promise<void>,
) {
	const before = await client.request<CodexConfigurationSyncStore>("snapshot", { scope: "full" });
	const frozen = await client.request<{ storageGeneration: number }>("freeze_legacy_rollback", {
		expectedStorageGeneration: before.storageGeneration,
	});
	const snapshot = await client.request<CodexConfigurationSyncStore>("snapshot", { scope: "full" });
	if (snapshot.storageGeneration !== frozen.storageGeneration) throw new Error("回退冻结代数未保持稳定。");
	await prepareLegacyRollback?.(snapshot);
	const legacy = legacyConfigurationSnapshot(snapshot);
	const exportPath = join(authority.backupDirectory, "configuration-sync-latest-state-for-legacy-rollback.json");
	await writeDurableConfigurationStorageFile(exportPath, JSON.stringify(legacy));
	const contentDigest = normalizedContentDigest(legacy);
	if (normalizedContentDigest(parseLegacy(JSON.parse(await readFile(exportPath, "utf8")))) !== contentDigest)
		throw new Error("回退最新完整状态核验失败。");
	const prepared: ConfigurationStorageAuthority = {
		...authority,
		phase: "legacy_rollback_prepared",
		legacyRollbackExportPath: exportPath,
		legacyRollbackContentDigest: contentDigest,
		legacyRollbackStorageGeneration: frozen.storageGeneration,
	};
	await writeDurableConfigurationStorageFile(
		join(directory, "configuration-sync-storage-authority.json"),
		JSON.stringify(prepared),
	);
	await finishPreparedLegacyRollback(directory, prepared, parseLegacy);
	return { exportPath, storageGeneration: frozen.storageGeneration, contentDigest };
}
