import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import lockfile from "proper-lockfile";
import streamJson from "stream-json";
import streamValues from "stream-json/streamers/StreamValues.js";
import { z } from "zod";
import {
	type CodexConfigurationTargetSnapshot,
	codexConfigurationInitiatorTraceChannel,
	codexConfigurationTargetSnapshotSchema,
	createCodexConfigurationTargetObservationMonitor,
	listRuntimeCodexConfigurationTraceTargets,
	normalizeMacosCodexTargetWriteEvent,
	recordCodexConfigurationInitiatorTrace,
	resolvePossibleCodexRequestInitiators,
} from "../src/diagnostics/codex-configuration-and-plugin-cache-initiator-trace";
import { summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided } from "../src/diagnostics/process-command-line-text-truncation-and-secret-redaction";
import {
	DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
	getDiagnosticEventJournalDirectoryPath,
	waitForPendingDiagnosticEventJournalWrites,
} from "../src/diagnostics/rotating-jsonl-diagnostic-event-journal";

const executeFile = promisify(execFile);
const checkpointSchema = z.object({
	schemaVersion: z.literal(1),
	commandDigest: z.string().nullable(),
	commandState: z.enum(["not_requested", "submission_started", "started", "exited"]),
	commandProcessId: z.number().nullable(),
	systemEvidenceAttempts: z.number(),
	systemEvidencePermissionFingerprint: z.string().nullable(),
	journalCursor: z
		.object({
			physicalIdentity: z.string(),
			byteOffset: z.number(),
			discardingOversizedRecord: z.boolean().default(false),
		})
		.nullable(),
});
type TraceCheckpoint = z.infer<typeof checkpointSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function resolvePhysicalPathBeforeCreatingTraceEvidenceDirectory(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return join(await resolvePhysicalPathBeforeCreatingTraceEvidenceDirectory(dirname(path)), basename(path));
	}
}

export async function traceCodexConfigurationAndPluginCacheChangeInitiators(arguments_: string[]) {
	const { values, positionals } = parseArgs({
		args: arguments_,
		allowPositionals: true,
		options: {
			"evidence-directory": { type: "string" },
			"target-home": { type: "string", multiple: true },
			"runtime-journal-directory": { type: "string" },
			"macos-write-events": { type: "boolean", default: false },
			"duration-ms": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"用法：node --import tsx scripts/trace-codex-configuration-and-plugin-cache-change-initiators.ts [--evidence-directory 持久目录] [--target-home CODEX_HOME，可重复] [--macos-write-events] [--duration-ms 毫秒] [-- 要启动的命令 参数…]\n同一证据目录再次运行会接续监听，绝不重启已登记的命令。系统写入事件需 root 和负责进程的 Full Disk Access。\n",
		);
		return;
	}
	const durationMs = values["duration-ms"] === undefined ? null : Number(values["duration-ms"]);
	if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0))
		throw new Error("duration-ms 必须为正整数。");
	const evidenceDirectory = resolve(
		values["evidence-directory"] ??
			join(
				homedir(),
				".cline",
				"kanban",
				"codex-configuration-initiator-evidence",
				`${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
			),
	);
	const explicitHomes = await Promise.all((values["target-home"] ?? []).map((home) => realpath(resolve(home))));
	const listTargets = async () =>
		explicitHomes.length
			? explicitHomes.flatMap((home) => [
					join(home, "config.toml"),
					join(home, "hooks.json"),
					join(home, "plugins", "cache"),
				])
			: listRuntimeCodexConfigurationTraceTargets();
	let targets = await listTargets();
	if (!targets.length) throw new Error("尚无已绑定的观察目标；可使用 --target-home 指定待观察的 Codex 配置目录。");
	let canonicalTargets = await Promise.all(targets.map(resolvePhysicalPathBeforeCreatingTraceEvidenceDirectory));
	const canonicalEvidenceDirectory = await resolvePhysicalPathBeforeCreatingTraceEvidenceDirectory(evidenceDirectory);
	if (
		canonicalTargets.some(
			(path) => canonicalEvidenceDirectory === path || canonicalEvidenceDirectory.startsWith(`${path}/`),
		)
	)
		throw new Error("证据目录必须位于被观察目标之外，避免诊断写入触发自身。");
	await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
	if ((await lstat(evidenceDirectory)).isSymbolicLink()) throw new Error("证据目录不可为符号链接。");
	await chmod(evidenceDirectory, 0o700);
	const releaseEvidenceDirectory = await lockfile.lock(evidenceDirectory, {
		realpath: false,
		stale: 10000,
		retries: { retries: 15, minTimeout: 500, maxTimeout: 1000 },
	});
	let closeOwnedTraceResources: (() => Promise<void>) | null = null;
	try {
		const checkpointPath = join(evidenceDirectory, "trace-checkpoint.json");
		let checkpoint: TraceCheckpoint;
		try {
			checkpoint = checkpointSchema.parse(JSON.parse(await readFile(checkpointPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			checkpoint = {
				schemaVersion: 1,
				commandDigest: null,
				commandState: "not_requested",
				commandProcessId: null,
				systemEvidenceAttempts: 0,
				systemEvidencePermissionFingerprint: null,
				journalCursor: null,
			};
		}
		if (positionals.length && checkpoint.commandDigest && checkpoint.commandDigest !== hash(positionals))
			throw new Error("此证据目录已绑定其他命令；请使用新的持久证据目录。");
		let persistence = Promise.resolve();
		const persistCheckpoint = () => {
			const serialized = JSON.stringify(checkpoint);
			persistence = persistence.then(async () => {
				const pendingPath = join(evidenceDirectory, `${randomUUID()}.pending-trace-checkpoint.json`);
				const file = await open(pendingPath, "wx", 0o600);
				try {
					await file.writeFile(serialized);
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(pendingPath, checkpointPath);
				const directory = await open(evidenceDirectory, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			});
			return persistence;
		};
		const sourceJournalDirectory = values["runtime-journal-directory"] ?? getDiagnosticEventJournalDirectoryPath();
		process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = join(evidenceDirectory, "diagnostic-event-journals");
		const emit = recordCodexConfigurationInitiatorTrace;
		const possibleRequests: Array<{ requestId: string; recordedAtEpochMs: number; targetRootPath: string }> = [];
		const pendingWriterRequestAssociations: Array<{
			writerEvidenceId: string;
			observedAtEpochMs: number;
			writerEvent: { recordedAtEpochMs: number; targetPaths: string[] };
			associatedRequestIds: Set<string>;
		}> = [];
		const prunePendingWriterRequestAssociations = () => {
			const expiredCount = pendingWriterRequestAssociations.filter(
				(writer) => Date.now() - writer.observedAtEpochMs > 60_000,
			).length;
			const removedCount = Math.max(expiredCount, pendingWriterRequestAssociations.length - 1000);
			if (removedCount > 0) {
				pendingWriterRequestAssociations.splice(0, removedCount);
				emit({
					event: "runtime_request_journal_coverage_gap",
					reason: "late_request_association_retention_exceeded",
					removedWriterEvidenceCount: removedCount,
					recoveryCondition: "保留原写入证据及未知因果；后续写入在 60 秒、1000 条有界窗口内继续补证",
				});
			}
		};
		const reconcileLatePossibleRequestEvidence = () => {
			prunePendingWriterRequestAssociations();
			for (let index = pendingWriterRequestAssociations.length - 1; index >= 0; index--) {
				const writer = pendingWriterRequestAssociations[index]!;
				const candidates = resolvePossibleCodexRequestInitiators(writer.writerEvent, possibleRequests).filter(
					(request) => !writer.associatedRequestIds.has(request.requestId),
				);
				const remainingCapacity = 1000 - writer.associatedRequestIds.size;
				const possibleInitiatingRequests = candidates.slice(0, remainingCapacity);
				if (possibleInitiatingRequests.length) {
					for (const request of possibleInitiatingRequests) writer.associatedRequestIds.add(request.requestId);
					emit({
						event: "possible_initiating_request_evidence_supplemented",
						supplementedWriterEvidenceId: writer.writerEvidenceId,
						possibleInitiatingRequests,
						initiatingRequest: "unknown",
					});
				}
				if (writer.associatedRequestIds.size >= 1000) {
					pendingWriterRequestAssociations.splice(index, 1);
					emit({
						event: "runtime_request_journal_coverage_gap",
						reason: "late_request_association_candidate_limit_reached",
						writerEvidenceId: writer.writerEvidenceId,
						recoveryCondition: "此写入保留已追加候选与未知因果；后续写入继续独立补证",
					});
				}
			}
		};
		let journalReading = false;
		const ingestRuntimeJournal = async () => {
			if (journalReading) return;
			journalReading = true;
			try {
				const path = join(sourceJournalDirectory, `${codexConfigurationInitiatorTraceChannel}.jsonl`);
				const information = await stat(path);
				const physicalIdentity = `${information.dev}:${information.ino}`;
				if (
					checkpoint.journalCursor &&
					(checkpoint.journalCursor.physicalIdentity !== physicalIdentity ||
						checkpoint.journalCursor.byteOffset > information.size)
				)
					emit({
						event: "runtime_request_journal_coverage_gap",
						reason: "journal_rotated_or_truncated",
						recoveryCondition: "从当前活动分片接续；轮转前未读取的请求保持未知",
					});
				const offset =
					checkpoint.journalCursor?.physicalIdentity === physicalIdentity &&
					checkpoint.journalCursor.byteOffset <= information.size
						? checkpoint.journalCursor.byteOffset
						: Math.max(0, information.size - 2 * 1024 * 1024);
				const readBudgetBytes = 2 * 1024 * 1024;
				const buffer = Buffer.alloc(Math.min(readBudgetBytes, information.size - offset));
				const file = await open(path, constants.O_RDONLY);
				let bytesRead: number;
				try {
					({ bytesRead } = await file.read(buffer, 0, buffer.length, offset));
				} finally {
					await file.close();
				}
				const chunk = buffer.subarray(0, bytesRead);
				let discardingOversizedRecord =
					checkpoint.journalCursor?.physicalIdentity === physicalIdentity &&
					checkpoint.journalCursor.byteOffset === offset &&
					checkpoint.journalCursor.discardingOversizedRecord;
				let recordStart = 0;
				if (discardingOversizedRecord) {
					recordStart = chunk.indexOf(0x0a) + 1;
					if (recordStart) discardingOversizedRecord = false;
				}
				let consumedBytes = chunk.lastIndexOf(0x0a) + 1;
				if (!consumedBytes && (discardingOversizedRecord || bytesRead === readBudgetBytes)) {
					if (!discardingOversizedRecord)
						emit({
							event: "runtime_request_journal_coverage_gap",
							reason: "record_exceeds_read_budget",
							readBudgetBytes,
							recordStartByteOffset: offset,
							recoveryCondition: "持久接续跳过此超预算记录，遇到换行后恢复后续请求；被跳过记录保持未知",
						});
					discardingOversizedRecord = true;
					consumedBytes = bytesRead;
				}
				// 按字节定位换行，避免窗口末尾的半个 UTF-8 字符改变持久游标。
				const completeText = discardingOversizedRecord ? "" : chunk.subarray(recordStart, consumedBytes).toString("utf8");
				for (const line of completeText.split("\n").filter(Boolean)) {
					let row: Record<string, unknown>;
					try {
						row = JSON.parse(line) as Record<string, unknown>;
					} catch {
						emit({ event: "runtime_request_journal_coverage_gap", reason: "partial_or_invalid_line" });
						continue;
					}
					if (
						row.channel !== codexConfigurationInitiatorTraceChannel ||
						![
							"known_native_request",
							"native_request_writer_ownership_verified",
							"native_request_ownership_unavailable",
						].includes(String(row.event))
					)
						continue;
					emit({ event: "attached_runtime_request_evidence", nativeRequestEvidence: row });
					if (
						row.event === "known_native_request" &&
						typeof row.requestId === "string" &&
						typeof row.targetRootPath === "string"
					)
						possibleRequests.push({
							requestId: row.requestId,
							targetRootPath: row.targetRootPath,
							recordedAtEpochMs: Date.parse(String(row.recordedAtIso)),
						});
				}
				if (possibleRequests.length > 1000) possibleRequests.splice(0, possibleRequests.length - 1000);
				reconcileLatePossibleRequestEvidence();
				checkpoint.journalCursor = {
					physicalIdentity,
					byteOffset: offset + consumedBytes,
					discardingOversizedRecord: Boolean(discardingOversizedRecord),
				};
				await persistCheckpoint();
			} catch (error) {
				emit({
					event: "runtime_request_journal_coverage_gap",
					reason: (error as NodeJS.ErrnoException).code ?? "unreadable",
					recoveryCondition: "基础文件采集继续；运行时日志恢复后自动接续",
				});
			} finally {
				journalReading = false;
			}
		};
		let systemCollector: ChildProcess | null = null;
		const readySystemCollectors = new WeakSet<ChildProcess>();
		const intentionallyStoppedSystemCollectors = new WeakSet<ChildProcess>();
		let reportedExhaustedBudgetFingerprint: string | null = null;
		let systemProbeInProgress = false;
		let bootIdentity = `unknown-boot:${randomUUID()}`;
		if (process.platform === "darwin")
			try {
				bootIdentity = (
					await executeFile("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 2000 })
				).stdout.trim();
			} catch {
				emit({
					event: "system_writer_coverage_gap",
					reason: "boot_identity_unavailable",
					recoveryCondition: "保留本次监听代际，不跨重启合并进程身份",
				});
			}
		const probePermissionFingerprint = async () => {
			const paths = [
				"/Library/Application Support/com.apple.TCC/TCC.db",
				join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
			];
			return hash([
				process.platform,
				process.getuid?.(),
				...(await Promise.all(
					paths.map(async (path) => {
						try {
							const file = await open(path, "r");
							await file.close();
							const metadata = await stat(path);
							return [true, metadata.mtimeMs];
						} catch (error) {
							return [false, (error as NodeJS.ErrnoException).code];
						}
					}),
				)),
			]);
		};
		const stopSystemCollector = async () => {
			const child = systemCollector;
			systemCollector = null;
			if (!child || child.exitCode !== null || !child.pid) return;
			if (readySystemCollectors.has(child)) intentionallyStoppedSystemCollectors.add(child);
			const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				return;
			}
			const hardStop = setTimeout(() => {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {
					/* 进程组已退出。 */
				}
			}, 1000);
			try {
				await exited;
				// 只有已验证就绪且正常结束的监听清零预算；流损坏、异常退出与中途崩溃保留失败次数。
				if (readySystemCollectors.has(child)) {
					checkpoint.systemEvidenceAttempts = 0;
					await persistCheckpoint();
				}
			} finally {
				clearTimeout(hardStop);
			}
		};
		closeOwnedTraceResources = stopSystemCollector;
		const startSystemCollector = async () => {
			if (!values["macos-write-events"] || systemCollector || systemProbeInProgress) return;
			systemProbeInProgress = true;
			try {
				const fingerprint = await probePermissionFingerprint();
				if (checkpoint.systemEvidencePermissionFingerprint !== fingerprint) {
					checkpoint.systemEvidencePermissionFingerprint = fingerprint;
					checkpoint.systemEvidenceAttempts = 0;
				}
				if (checkpoint.systemEvidenceAttempts >= 3) {
					if (reportedExhaustedBudgetFingerprint !== fingerprint) {
						reportedExhaustedBudgetFingerprint = fingerprint;
						emit({
							event: "system_writer_coverage_gap",
							reason: "system_evidence_attempt_budget_exhausted",
							systemWriterCoverage: "unavailable_retry_budget_exhausted",
							attempt: checkpoint.systemEvidenceAttempts,
							recoveryCondition: "基础文件采集继续；root 或 Full Disk Access 能力指纹变化后自动重置预算并重试",
						});
					}
					return;
				}
				checkpoint.systemEvidenceAttempts++;
				await persistCheckpoint();
				if (process.platform !== "darwin" || process.getuid?.() !== 0) {
					emit({
						event: "system_writer_coverage_gap",
						reason: "macos_root_and_full_disk_access_required",
						attempt: checkpoint.systemEvidenceAttempts,
						recoveryCondition: "基础采集继续；权限能力指纹变化后自动重试，同一证据最多三次",
					});
					return;
				}
				const child = spawn(
					"/usr/bin/eslogger",
					["--format", "json", "write", "create", "rename", "unlink", "close"],
					{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
				);
				systemCollector = child;
				const readyProbePath = join(evidenceDirectory, `system-event-listener-ready-probe-${randomUUID()}`);
				let resolveReady!: (value: boolean) => void;
				const ready = new Promise<boolean>((resolveValue) => {
					resolveReady = resolveValue;
				});
				let previousSequence: bigint | null = null;
				const parser = streamJson.parser({ jsonStreaming: true });
				const records = parser.pipe(streamValues.streamValues());
				child.stdout?.pipe(parser);
				const parserFailure = () => {
					const tailTruncatedDuringIntentionalShutdown =
						intentionallyStoppedSystemCollectors.has(child) && child.stdout?.readableEnded === true;
					// 主动结束后的 EOF 仍有尾部覆盖缺口，但不撤销已核验就绪的正常关闭资格。
					if (!tailTruncatedDuringIntentionalShutdown) readySystemCollectors.delete(child);
					emit({
						event: "system_writer_coverage_gap",
						reason: tailTruncatedDuringIntentionalShutdown
							? "system_event_stream_truncated_during_intentional_shutdown"
							: "system_event_stream_invalid_or_lost",
						recoveryCondition: tailTruncatedDuringIntentionalShutdown
							? "保留已确认事件与尾部丢失缺口；本次监听正常关闭，下次可重新订阅"
							: "保留已确认事件，按持久预算重建系统监听",
					});
					resolveReady(false);
					void stopSystemCollector();
				};
				parser.on("error", parserFailure);
				records.on("error", parserFailure);
				records.on("data", ({ value }: { value: unknown }) => {
					if (typeof value !== "object" || value === null) return;
					const row = value as Record<string, unknown>;
					if (JSON.stringify(row.event ?? {}).includes(readyProbePath)) resolveReady(true);
					if (typeof row.global_seq_num === "number" || typeof row.global_seq_num === "string") {
						try {
							const sequence = BigInt(row.global_seq_num);
							if (previousSequence !== null && sequence !== previousSequence + 1n)
								emit({
									event: "system_writer_coverage_gap",
									reason: "endpoint_security_sequence_gap",
									previousSequence: String(previousSequence),
									currentSequence: String(sequence),
								});
							previousSequence = sequence;
						} catch {
							emit({ event: "system_writer_coverage_gap", reason: "invalid_event_sequence" });
						}
					}
					const normalized = normalizeMacosCodexTargetWriteEvent(value, canonicalTargets, bootIdentity);
					if (normalized?.event === "confirmed_target_file_writer") {
						const writerEvidenceId = randomUUID();
						const possibleInitiatingRequests = resolvePossibleCodexRequestInitiators(normalized, possibleRequests);
						pendingWriterRequestAssociations.push({
							writerEvidenceId,
							observedAtEpochMs: Date.now(),
							writerEvent: { recordedAtEpochMs: normalized.recordedAtEpochMs, targetPaths: normalized.targetPaths },
							associatedRequestIds: new Set(possibleInitiatingRequests.map((request) => request.requestId)),
						});
						prunePendingWriterRequestAssociations();
						emit({
							...normalized,
							writerEvidenceId,
							possibleInitiatingRequests,
						});
					} else if (normalized) emit(normalized);
				});
				child.stderr?.on("data", () => {
					emit({
						event: "system_writer_coverage_gap",
						reason: "eslogger_reported_diagnostic_stderr",
						recoveryCondition: "核对 root 与负责进程的 Full Disk Access，能力指纹变化后自动重试",
					});
				});
				child.once("error", () => {
					readySystemCollectors.delete(child);
					resolveReady(false);
					emit({ event: "system_writer_coverage_gap", reason: "eslogger_spawn_failed" });
				});
				child.once("close", () => {
					if (systemCollector === child) systemCollector = null;
					resolveReady(false);
					if (intentionallyStoppedSystemCollectors.has(child)) {
						emit({ event: "system_writer_listener_stopped", coverage: "observation_session_closed" });
						return;
					}
					readySystemCollectors.delete(child);
					emit({
						event: "system_writer_coverage_gap",
						reason: "eslogger_process_exited",
						recoveryCondition: "基础采集继续，按持久预算重建系统监听",
					});
				});
				const probeTimer = setInterval(() => {
					void writeFile(readyProbePath, "仅用于系统监听就绪核验", { mode: 0o600 }).catch(() =>
						resolveReady(false),
					);
				}, 150);
				const deadline = setTimeout(() => resolveReady(false), 2500);
				try {
					if ((await ready) && systemCollector === child) {
						readySystemCollectors.add(child);
						emit({
							event: "system_writer_listener_ready",
							coverage: "endpoint_security_notify_events",
							bootIdentity,
						});
					} else {
						emit({
							event: "system_writer_coverage_gap",
							reason: "subscription_readiness_not_confirmed",
							recoveryCondition: "基础快照仍可用；权限恢复后按预算重试",
						});
						await stopSystemCollector();
					}
				} finally {
					clearInterval(probeTimer);
					clearTimeout(deadline);
					await rm(readyProbePath, { force: true });
				}
			} finally {
				systemProbeInProgress = false;
			}
		};
		emit({
			event: "trace_session_started",
			evidenceDirectory,
			commandRecoveryState: checkpoint.commandState,
			systemWriterCoverage: values["macos-write-events"] ? "pending_system_permission_probe" : "not_requested",
			requestAttribution: "possible_only_without_direct_native_causality",
		});
		await startSystemCollector();
		const snapshotCheckpointPath = join(evidenceDirectory, "target-snapshot-checkpoint.json");
		let previousSnapshots: Record<string, CodexConfigurationTargetSnapshot> = {};
		try {
			previousSnapshots = z
				.record(z.string(), codexConfigurationTargetSnapshotSchema)
				.parse(JSON.parse(await readFile(snapshotCheckpointPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		let snapshotPersistence = Promise.resolve();
		const monitor = createCodexConfigurationTargetObservationMonitor({
			listTargetPaths: listTargets,
			previousSnapshots,
			emit: (event) => {
				emit(event);
				if (typeof event.targetRootPath === "string" && event.currentSnapshot) {
					previousSnapshots[event.targetRootPath] = codexConfigurationTargetSnapshotSchema.parse(
						event.currentSnapshot,
					);
					const serializedSnapshots = JSON.stringify(previousSnapshots);
					snapshotPersistence = snapshotPersistence.then(async () => {
						const pendingSnapshotPath = join(evidenceDirectory, `${randomUUID()}.pending-target-snapshot.json`);
						const file = await open(pendingSnapshotPath, "wx", 0o600);
						try {
							await file.writeFile(serializedSnapshots);
							await file.sync();
						} finally {
							await file.close();
						}
						await rename(pendingSnapshotPath, snapshotCheckpointPath);
						const directory = await open(evidenceDirectory, "r");
						try {
							await directory.sync();
						} finally {
							await directory.close();
						}
					});
				}
			},
		});
		closeOwnedTraceResources = async () => {
			await stopSystemCollector();
			await monitor.close();
			await snapshotPersistence;
			await persistence;
			await waitForPendingDiagnosticEventJournalWrites();
		};
		await monitor.start();
		await snapshotPersistence;
		await waitForPendingDiagnosticEventJournalWrites();
		await ingestRuntimeJournal();
		let resolveFinished!: () => void;
		const finished = new Promise<void>((resolveValue) => {
			resolveFinished = resolveValue;
		});
		const finish = () => resolveFinished();
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
		const duration = durationMs === null ? null : setTimeout(finish, durationMs);
		let refreshOperation: Promise<void> | null = null;
		const refresh = setInterval(() => {
			if (refreshOperation) return;
			refreshOperation = (async () => {
				targets = await listTargets();
				canonicalTargets = await Promise.all(targets.map((path) => realpath(path).catch(() => resolve(path))));
				await ingestRuntimeJournal();
				await startSystemCollector();
			})()
				.catch(() => emit({ event: "trace_refresh_coverage_gap", recoveryCondition: "下一次周期自动重验" }))
				.finally(() => {
					refreshOperation = null;
				});
		}, 1000);
		let observationSessionClosing = false;
		try {
			if (positionals.length && checkpoint.commandState === "not_requested") {
				checkpoint.commandDigest = hash(positionals);
				checkpoint.commandState = "submission_started";
				await persistCheckpoint();
				const child = spawn(positionals[0]!, positionals.slice(1), {
					stdio: "inherit",
					env: { ...process.env, [DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR]: sourceJournalDirectory },
				});
				if (durationMs !== null) child.unref();
				checkpoint.commandProcessId = child.pid ?? null;
				checkpoint.commandState = "started";
				child.once("error", () => {
					emit({ event: "diagnostic_command_spawn_failed", executionResult: "unknown_no_automatic_relaunch" });
					finish();
				});
				child.once("close", (exitCode, signal) => {
					if (observationSessionClosing) return;
					checkpoint.commandState = "exited";
					void persistCheckpoint();
					emit({ event: "diagnostic_command_exited", exitCode, signal });
					if (durationMs === null) finish();
				});
				await persistCheckpoint();
				emit({
					event: "diagnostic_command_started_after_listeners_and_snapshot",
					processId: child.pid ?? null,
					commandSummary: summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided(positionals.join(" ")),
				});
			} else if (checkpoint.commandState !== "not_requested")
				emit({
					event: "diagnostic_command_not_reexecuted_on_resume",
					commandRecoveryState: checkpoint.commandState,
					processId: checkpoint.commandProcessId,
				});
			process.stdout.write(
				`追踪已就绪，证据目录：${evidenceDirectory}\n实际写入者仅在系统事件已核验时确认；普通文件通知和相邻请求不构成发起者证明。\n`,
			);
			await finished;
		} finally {
			observationSessionClosing = true;
			clearInterval(refresh);
			if (duration) clearTimeout(duration);
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
			await refreshOperation;
			await stopSystemCollector();
			await monitor.scan();
			await monitor.close();
			await ingestRuntimeJournal();
			await persistence;
			await snapshotPersistence;
			emit({ event: "trace_session_closed", commandRecoveryState: checkpoint.commandState });
			await waitForPendingDiagnosticEventJournalWrites();
		}
	} finally {
		try {
			await closeOwnedTraceResources?.();
		} finally {
			await releaseEvidenceDirectory();
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	void traceCodexConfigurationAndPluginCacheChangeInitiators(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`追踪未能完成：${error instanceof Error ? error.message : "未知错误"}\n`);
		process.exitCode = 1;
	});
