import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readCodexConfigurationSyncActiveStore as readCodexConfigurationSyncStore } from "../codex-configuration-sync/codex-configuration-sync-store";
import { assertCodexConfigurationWriterBindingIdentity } from "../codex-configuration-sync/codex-configuration-writer-binding";
import { codexSourceSharedPluginInstallationIdentityDirectoryPaths } from "../codex-configuration-sync/codex-source-shared-plugin-installation-directories";
import {
	prepareCodexDirectoryVolumeObservations,
	runWithCodexDirectoryVolumeSystemQueriesDisabled,
} from "../codex-conversation-storage/codex-persistent-directory-identity";
import type { CodexConfigurationWriterBinding } from "../core/codex-configuration-sync-contract";
import { redactSecretShapedSubstringsInCommandLineText } from "./process-command-line-text-truncation-and-secret-redaction";
import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const codexConfigurationInitiatorTraceChannel = "codex-configuration-and-plugin-cache-initiator-trace";
export const recordCodexConfigurationInitiatorTrace = (event: Record<string, unknown>) =>
	appendDiagnosticEventToRotatingJsonlJournal(codexConfigurationInitiatorTraceChannel, event);

const configurationRelevantNativeMethods = new Set([
	"config/read",
	"config/batchWrite",
	"config/value/write",
	"hooks/list",
	"plugin/list",
	"plugin/install",
	"plugin/uninstall",
	"plugin/marketplace/add",
	"plugin/marketplace/remove",
	"thread/start",
	"thread/resume",
	"thread/fork",
	"thread/settings/update",
	"turn/start",
]);
const pendingWriterOwnershipVerifications = new Set<Promise<void>>();
// 静态加载时建立独立诊断上下文，避免继承调用方事务的锁内系统查询禁令；业务请求不等待此后台补证。
const writerOwnershipDiagnosticContext = new AsyncResource("codex-configuration-writer-ownership-diagnostic");
export async function waitForCodexConfigurationRequestWriterOwnershipVerifications() {
	await Promise.all([...pendingWriterOwnershipVerifications]);
}

// 只记录已存在的请求；绝不为诊断主动调用 plugin/list 或其它原生查询。
export function recordKnownCodexConfigurationNativeRequest(input: {
	requestId: string;
	method: string;
	purpose: string;
	targetProcessId?: number;
	endpointSha256?: string;
	configurationHomeDirectoryPath?: string;
	writerBinding?: CodexConfigurationWriterBinding;
	outcome?: string;
}) {
	if (!configurationRelevantNativeMethods.has(input.method)) return;
	const { writerBinding, configurationHomeDirectoryPath, ...request } = input;
	recordCodexConfigurationInitiatorTrace({
		event: "known_native_request",
		...request,
		requesterProcessId: process.pid,
		requesterProcessStartedAtEpochMs: Date.now() - process.uptime() * 1000,
		targetRootPath: writerBinding?.configurationHomeDirectoryPath ?? configurationHomeDirectoryPath ?? null,
		attribution: "possible_initiating_request",
		ownership: "not_yet_verified",
	});
	if (!writerBinding) return;
	const verification = writerOwnershipDiagnosticContext.runInAsyncScope(async () => {
		try {
			await prepareCodexDirectoryVolumeObservations([
				writerBinding.sourceHomeDirectoryPath,
				writerBinding.conversationStorageHomeDirectoryPath,
				writerBinding.sqliteHomeDirectoryPath,
				...codexSourceSharedPluginInstallationIdentityDirectoryPaths(writerBinding),
			]);
			await runWithCodexDirectoryVolumeSystemQueriesDisabled(async () => {
				await assertCodexConfigurationWriterBindingIdentity(writerBinding);
				const stored = (await readCodexConfigurationSyncStore({ writerIds: [writerBinding.writerId] })).writers[
					writerBinding.writerId
				];
				if (!stored || !isDeepStrictEqual(stored.binding, writerBinding)) throw new Error("持久绑定不符");
			});
			recordCodexConfigurationInitiatorTrace({
				event: "native_request_writer_ownership_verified",
				requestId: input.requestId,
				writerId: writerBinding.writerId,
				workspaceId: writerBinding.workspaceId,
				conversationSessionId: writerBinding.conversationSessionId,
				runtimeSessionIncarnationId: writerBinding.runtimeSessionIncarnationId,
				sourceIdentity: writerBinding.sourceIdentity,
				targetRootPath: writerBinding.configurationHomeDirectoryPath,
				sourceHomeDirectoryPath: writerBinding.sourceHomeDirectoryPath,
			});
		} catch {
			recordCodexConfigurationInitiatorTrace({
				event: "native_request_ownership_unavailable",
				requestId: input.requestId,
				ownership: "unknown",
				recoveryCondition: "持久 writer 绑定及物理目录身份恢复后，后续请求重新核验",
			});
		}
	});
	pendingWriterOwnershipVerifications.add(verification);
	void verification.finally(() => pendingWriterOwnershipVerifications.delete(verification));
}

export const codexConfigurationTargetSnapshotSchema = z.object({
	entries: z.record(
		z.string(),
		z.object({
			kind: z.string(),
			size: z.number(),
			modifiedAtMs: z.number(),
			physicalIdentity: z.string(),
			sha256: z.string().optional(),
		}),
	),
	coverageGaps: z.array(z.object({ path: z.string(), code: z.string() })),
});
export type CodexConfigurationTargetSnapshot = z.infer<typeof codexConfigurationTargetSnapshotSchema>;
export async function readCodexConfigurationTargetSnapshot(
	targetPath: string,
): Promise<CodexConfigurationTargetSnapshot> {
	const snapshot: CodexConfigurationTargetSnapshot = { entries: {}, coverageGaps: [] };
	let remainingHashedBytes = 8 * 1024 * 1024;
	const visit = async (path: string, depth: number): Promise<void> => {
		const key = relative(targetPath, path) || ".";
		if (Object.keys(snapshot.entries).length >= 4000 || depth > 16) {
			snapshot.coverageGaps.push({ path: key, code: "bounded_snapshot_budget_exhausted" });
			return;
		}
		try {
			const before = await lstat(path);
			const entry: CodexConfigurationTargetSnapshot["entries"][string] = {
				kind: before.isSymbolicLink() ? "symlink" : before.isDirectory() ? "directory" : "file",
				size: before.size,
				modifiedAtMs: before.mtimeMs,
				physicalIdentity: `${before.dev}:${before.ino}`,
			};
			snapshot.entries[key] = entry;
			if (before.isSymbolicLink()) entry.sha256 = digest(await readlink(path));
			else if (before.isDirectory()) {
				for (const name of (await readdir(path)).sort()) {
					if (Object.keys(snapshot.entries).length >= 4000) {
						snapshot.coverageGaps.push({ path: key, code: "bounded_snapshot_budget_exhausted" });
						break;
					}
					await visit(join(path, name), depth + 1);
				}
			} else if (before.isFile()) {
				if (before.size > 2 * 1024 * 1024 || before.size > remainingHashedBytes) {
					snapshot.coverageGaps.push({ path: key, code: "content_digest_budget_exhausted" });
					return;
				}
				remainingHashedBytes -= before.size;
				const buffer = Buffer.alloc(before.size + 1);
				const file = await open(path, "r");
				let offset = 0;
				try {
					while (offset < buffer.length) {
						const result = await file.read(buffer, offset, buffer.length - offset, offset);
						if (!result.bytesRead) break;
						offset += result.bytesRead;
					}
				} finally {
					await file.close();
				}
				entry.sha256 = digest(buffer.subarray(0, offset));
				const after = await lstat(path);
				if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
					delete entry.sha256;
					snapshot.coverageGaps.push({ path: key, code: "file_changed_during_snapshot" });
				}
			}
		} catch (error) {
			snapshot.coverageGaps.push({ path: key, code: (error as NodeJS.ErrnoException).code ?? "unreadable" });
		}
	};
	await visit(targetPath, 0);
	return snapshot;
}

export function createCodexConfigurationTargetObservationMonitor(input: {
	listTargetPaths: () => Promise<string[]>;
	emit?: (event: Record<string, unknown>) => void;
	pollIntervalMs?: number;
	previousSnapshots?: Record<string, CodexConfigurationTargetSnapshot>;
}) {
	const emit = input.emit ?? recordCodexConfigurationInitiatorTrace;
	const monitorIncarnationId = randomUUID();
	const watchers = new Map<string, { watcher: FSWatcher; listeningDirectoryIdentity: string }>();
	const snapshots = new Map<string, CodexConfigurationTargetSnapshot>(Object.entries(input.previousSnapshots ?? {}));
	let timer: NodeJS.Timeout | undefined;
	let scanning: Promise<void> | null = null;
	let closed = false;
	let changedWhileScanning = false;
	const publish = (event: Record<string, unknown>) =>
		emit({ monitorIncarnationId, recordedAtEpochMs: Date.now(), actualWriter: "unknown", ...event });
	const scan = (): Promise<void> => {
		if (closed) return Promise.resolve();
		if (scanning) {
			changedWhileScanning = true;
			return scanning;
		}
		scanning = (async () => {
			const paths = [
				...new Set(
					await Promise.all(
						(await input.listTargetPaths()).map(async (path) => realpath(path).catch(() => resolve(path))),
					),
				),
			];
			for (const path of paths) {
				const information = await lstat(path).catch(() => null);
				const isDirectory = information?.isDirectory() ?? false;
				const listeningDirectoryPath = isDirectory ? path : dirname(path);
				const directoryInformation = isDirectory
					? information
					: await lstat(listeningDirectoryPath).catch(() => null);
				const listeningDirectoryIdentity = `${listeningDirectoryPath}:${isDirectory}:${directoryInformation?.dev}:${directoryInformation?.ino}`;
				const existingListenerBinding = watchers.get(path);
				if (
					existingListenerBinding &&
					existingListenerBinding.listeningDirectoryIdentity !== listeningDirectoryIdentity
				) {
					existingListenerBinding.watcher.close();
					watchers.delete(path);
					publish({
						event: "target_listener_coverage_gap",
						targetRootPath: path,
						reason: "target_directory_or_listener_mode_changed",
						recoveryCondition: "重建目标当前目录的监听并补扫；转换期间的短命事件仍未知",
					});
				}
				if (!watchers.has(path)) {
					try {
						const watcher = watch(listeningDirectoryPath, { recursive: isDirectory }, (eventType, filename) => {
							if (!isDirectory && filename && filename.toString() !== basename(path)) return;
							changedWhileScanning = true;
							publish({
								event: "target_filesystem_notification",
								targetRootPath: path,
								eventType,
								relativePath: filename
									? redactSecretShapedSubstringsInCommandLineText(filename.toString())
									: null,
								coverage: "notification_only_actual_writer_unknown",
							});
						});
						watcher.on("error", () => {
							if (watchers.get(path)?.watcher !== watcher) return;
							watcher.close();
							watchers.delete(path);
							publish({
								event: "target_listener_coverage_gap",
								targetRootPath: path,
								recoveryCondition: "五秒周期重建监听并只读补扫",
							});
						});
						watcher.unref();
						watchers.set(path, { watcher, listeningDirectoryIdentity });
						publish({
							event: "target_listener_ready",
							targetRootPath: path,
							coverage: "filesystem_notifications_and_periodic_snapshots",
							systemWriterEvidence: "unavailable",
						});
					} catch {
						publish({
							event: "target_listener_coverage_gap",
							targetRootPath: path,
							recoveryCondition: "周期补扫，目录可读后自动重建监听",
						});
					}
				}
				let currentSnapshot = await readCodexConfigurationTargetSnapshot(path);
				for (
					let attempt = 1;
					attempt < 3 && currentSnapshot.coverageGaps.some((gap) => gap.code === "file_changed_during_snapshot");
					attempt++
				)
					currentSnapshot = await readCodexConfigurationTargetSnapshot(path);
				const previousSnapshot = snapshots.get(path);
				if (!previousSnapshot || !isDeepStrictEqual(previousSnapshot, currentSnapshot))
					publish({
						event: previousSnapshot ? "target_snapshot_changed" : "initial_target_snapshot",
						targetRootPath: path,
						previousSnapshot: previousSnapshot ?? null,
						currentSnapshot,
					});
				snapshots.set(path, currentSnapshot);
			}
			for (const [path, { watcher }] of watchers)
				if (!paths.includes(path)) {
					watcher.close();
					watchers.delete(path);
				}
		})()
			.catch(() =>
				publish({ event: "target_scan_coverage_gap", recoveryCondition: "下次周期扫描重新核验目录归属与可读性" }),
			)
			.finally(() => {
				scanning = null;
			});
		return scanning;
	};
	return {
		scan,
		getCoverage: () => ({
			fileObservation: snapshots.size ? ("active" as const) : ("starting" as const),
			targetCount: snapshots.size,
			coverageGapCount: [...snapshots.values()].reduce((count, snapshot) => count + snapshot.coverageGaps.length, 0),
			systemWriterEvidence: "not_collected_by_runtime" as const,
		}),
		start: async () => {
			await scan();
			if (changedWhileScanning) {
				changedWhileScanning = false;
				await scan();
			}
			if (closed) return;
			timer = setInterval(() => {
				changedWhileScanning = false;
				void scan();
			}, input.pollIntervalMs ?? 5_000);
			timer.unref();
		},
		close: async () => {
			closed = true;
			clearInterval(timer);
			await scanning;
			for (const { watcher } of watchers.values()) watcher.close();
			watchers.clear();
		},
	};
}

export async function listRuntimeCodexConfigurationTraceTargets() {
	const store = await readCodexConfigurationSyncStore();
	const homes = [
		...Object.values(store.sources).map((source) => source.home),
		...Object.values(store.writers)
			.filter((writer) => !writer.retiredAt)
			.map((writer) => writer.binding.configurationHomeDirectoryPath),
	];
	const targets: string[] = [];
	for (const home of new Set(homes)) {
		targets.push(join(home, "config.toml"), join(home, "hooks.json"), join(home, "plugins", "cache"));
		try {
			targets.push(
				...(await readdir(home))
					.filter((name) => /^[\w.-]+\.config\.toml$/.test(name))
					.map((name) => join(home, name)),
			);
		} catch {
			/* 上层扫描保留不可读覆盖缺口。 */
		}
	}
	return targets;
}

const esProcessSchema = z.object({
	audit_token: z.object({ pid: z.number().int().positive(), pidversion: z.number().int().nonnegative() }),
	executable: z.object({ path: z.string() }),
});
const esMessageSchema = z.object({
	event_type: z.union([z.string(), z.number()]),
	time: z.union([z.string(), z.number()]).optional(),
	process: esProcessSchema,
	event: z.record(z.string(), z.unknown()),
	global_seq_num: z.union([z.number(), z.string()]).optional(),
});
function pathIsWithinTarget(path: string, root: string) {
	const difference = relative(resolve(root), resolve(path));
	return !difference || (!difference.startsWith("..") && !isAbsolute(difference));
}

export function normalizeMacosCodexTargetWriteEvent(message: unknown, targetRoots: string[], bootIdentity: string) {
	const eventEnvelope = z.object({ event: z.record(z.string(), z.unknown()) }).safeParse(message);
	if (!eventEnvelope.success) return null;
	const targets: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (depth > 6 || !value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "path" && typeof child === "string" && targetRoots.some((root) => pathIsWithinTarget(child, root)))
				targets.push(child);
			else visit(child, depth + 1);
		}
	};
	const writeEvent = Object.entries(eventEnvelope.data.event).find(
		([kind, event]) =>
			["write", "create", "rename", "unlink", "close"].includes(kind) &&
			(kind !== "close" ||
				(typeof event === "object" && event !== null && "modified" in event && event.modified === true)),
	);
	if (!writeEvent) return null;
	visit(writeEvent[1], 0);
	const destinationSchema = z.object({
		destination: z.object({ new_path: z.object({ dir: z.object({ path: z.string() }), filename: z.string() }) }),
	});
	const destination = destinationSchema.safeParse(writeEvent[1]);
	if (destination.success) {
		const path = join(destination.data.destination.new_path.dir.path, destination.data.destination.new_path.filename);
		if (targetRoots.some((root) => pathIsWithinTarget(path, root))) targets.push(path);
	}
	if (!targets.length) return null;
	const parsed = esMessageSchema.safeParse(message);
	if (!parsed.success)
		return {
			event: "system_writer_coverage_gap" as const,
			reason: "targeted_event_identity_or_schema_unavailable",
			targetPaths: [...new Set(targets)],
			actualWriter: "unknown",
			recoveryCondition: "保留目标摘要观察；后续可识别且带完整进程身份的系统事件恢复写入者核验",
		};
	const row = parsed.data;
	const actor = row.process;
	return {
		event: "confirmed_target_file_writer" as const,
		eventType: writeEvent[0],
		recordedAtEpochMs:
			typeof row.time === "string" ? Date.parse(row.time) : typeof row.time === "number" ? row.time : Date.now(),
		targetPaths: [...new Set(targets)],
		systemEventSequence: row.global_seq_num ?? null,
		actualWriterProcess: {
			processId: actor.audit_token.pid,
			processLifetimeIdentityKey: `${bootIdentity}:${actor.audit_token.pid}:${actor.audit_token.pidversion}`,
			executablePath: redactSecretShapedSubstringsInCommandLineText(actor.executable.path),
		},
		initiatingRequest: "unknown",
	};
}

export function resolvePossibleCodexRequestInitiators(
	event: { recordedAtEpochMs: number; targetPaths: string[] },
	requests: Array<{ requestId: string; recordedAtEpochMs: number; targetRootPath: string }>,
) {
	return requests
		.filter(
			(request) =>
				event.recordedAtEpochMs >= request.recordedAtEpochMs &&
				event.recordedAtEpochMs - request.recordedAtEpochMs <= 10_000 &&
				event.targetPaths.some((path) => pathIsWithinTarget(path, request.targetRootPath)),
		)
		.map((request) => ({ requestId: request.requestId, attribution: "possible_initiating_request" as const }));
}
