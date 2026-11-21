import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	runtimeTaskCardActionMoveIntoDoneRequestSchema,
	runtimeTaskCardActionRestoreFromDoneRequestSchema,
} from "../core/api-contract";
import type { TaskClosureRecord } from "../core/task-closure-contract";
import {
	taskClosureArchiveManifestSchema,
	taskClosureAutomaticRecoveryStateSchema,
	taskClosureOperationProgressSchema,
	taskClosureQualifiedTaskReferenceSchema,
	taskClosureRecordSchema,
} from "../core/task-closure-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { adoptTaskClosureOperationStorageProtocolVersion } from "./task-closure-storage-protocol-compatibility";

export const taskClosureOperationSchema = z.object({
	schemaVersion: z.union([z.literal(1), z.literal(2)]),
	preservationPurpose: z.enum(["close_task", "permanently_delete_task"]).optional(),
	taskIdentity: taskClosureQualifiedTaskReferenceSchema,
	workspacePath: z.string(),
	sourceWorktreePath: z.string().nullable(),
	processIdsAwaitingExit: z.array(z.number().int().positive()).optional(),
	ownedProcessIdentitiesAwaitingExit: z
		.array(
			z.object({
				pid: z.number().int().positive(),
				startAndCommand: z.string(),
				nativeProcessGenerationIdentity: z.string().optional(),
			}),
		)
		.optional(),
	systemBootIdentityAtProcessCapture: z.string().nullable().optional(),
	sourceBoardColumnId: z.enum(["backlog", "in_progress", "review", "validation", "trash"]),
	sourceTaskUpdatedAtEpochMs: z.number(),
	request: runtimeTaskCardActionMoveIntoDoneRequestSchema,
	intent: z.custom<TaskMutationIntentWithResolvedActor>(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"resolvedKanbanActor" in value &&
			"taskMutationIntentKind" in value,
	),
	progress: taskClosureOperationProgressSchema,
	archiveManifest: taskClosureArchiveManifestSchema.nullable(),
	closureRecord: taskClosureRecordSchema.nullable(),
	lastAttemptRuntimeInstanceId: z.string().nullable(),
	lastRecoveryProbeFingerprint: z.string().nullable(),
	archiveStorageLimits: z
		.object({
			maximumArchivePayloadBytes: z.number().nonnegative(),
			maximumRestorationWorkspaceBytes: z.number().nonnegative(),
			minimumRemainingVolumeStorageBytes: z.number().nonnegative(),
		})
		.optional(),
	archiveRepairManifest: taskClosureArchiveManifestSchema.optional(),
	reopening: z
		.object({
			request: runtimeTaskCardActionRestoreFromDoneRequestSchema,
			reopeningRequestId: z.string().uuid().optional(),
			intent: z.custom<TaskMutationIntentWithResolvedActor>(
				(value) =>
					typeof value === "object" &&
					value !== null &&
					"resolvedKanbanActor" in value &&
					"taskMutationIntentKind" in value,
			),
			phase: z.enum(["restoring_archive", "resuming_session", "waiting_for_recovery", "completed", "cancelled"]),
			startedAtEpochMs: z.number(),
			sourceTaskUpdatedAtEpochMs: z.number(),
			lastError: z.string().nullable(),
			automaticRecovery: taskClosureAutomaticRecoveryStateSchema.optional(),
			explicitStopMarkerObservationAtRequest: z.string().optional(),
			sessionResumeAuthorizationApplied: z.boolean().optional(),
		})
		.optional(),
});
export type TaskClosureOperation = z.infer<typeof taskClosureOperationSchema>;

export const taskClosureIdentityKey = (identity: unknown) =>
	createHash("sha256").update(JSON.stringify(identity)).digest("hex");
export const taskClosureOperationsRoot = () => join(getRuntimeHomePath(), "task-closure-preserved-artifacts");
export function taskClosureTaskDirectory(identity: TaskClosureOperation["taskIdentity"]) {
	return join(taskClosureOperationsRoot(), taskClosureIdentityKey(identity));
}
export function taskClosureOperationDirectory(identity: TaskClosureOperation["taskIdentity"], requestId: string) {
	z.string().uuid().parse(requestId);
	return join(taskClosureTaskDirectory(identity), requestId);
}
export async function ensurePrivateTaskClosureArtifactDirectory(
	identity: TaskClosureOperation["taskIdentity"],
	requestId?: string,
) {
	const directories = [taskClosureOperationsRoot(), taskClosureTaskDirectory(identity)];
	if (requestId) directories.push(taskClosureOperationDirectory(identity, requestId));
	for (const directory of directories) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if ((await lstat(directory)).isSymbolicLink()) throw new Error("结案私有目录变成符号链接，未继续写入。");
		await chmod(directory, 0o700);
	}
	return requestId ? taskClosureOperationDirectory(identity, requestId) : taskClosureTaskDirectory(identity);
}
export async function readTaskClosureOperation(identity: TaskClosureOperation["taskIdentity"], requestId: string) {
	try {
		return taskClosureOperationSchema.parse(
			JSON.parse(await readFile(join(taskClosureOperationDirectory(identity, requestId), "operation.json"), "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function writeTaskClosureOperation(operation: TaskClosureOperation) {
	await ensurePrivateTaskClosureArtifactDirectory(operation.taskIdentity, operation.progress.closureRequestId);
	if (operation.schemaVersion === 2) await adoptTaskClosureOperationStorageProtocolVersion();
	await lockedFileSystem.writeTextFileAtomic(
		join(
			taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
			"operation.json",
		),
		JSON.stringify(operation),
		{ lock: null, durable: true, fileMode: 0o600 },
	);
}

export function activeTaskClosureLifecycleRequestId(operation: TaskClosureOperation) {
	return operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)
		? (operation.reopening.reopeningRequestId ?? operation.progress.closureRequestId)
		: operation.progress.closureRequestId;
}

function cancellationRequestPath(operation: TaskClosureOperation, requestId: string) {
	z.string().uuid().parse(requestId);
	return join(
		taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
		`cancel-lifecycle-request-${requestId}.json`,
	);
}

/** 撤销先独立持久化，不等待复制持有的生命周期锁；该标记只追加，不能复活旧请求。 */
export async function requestTaskClosureLifecycleCancellation(operation: TaskClosureOperation) {
	const requestId = activeTaskClosureLifecycleRequestId(operation);
	await ensurePrivateTaskClosureArtifactDirectory(operation.taskIdentity, operation.progress.closureRequestId);
	await lockedFileSystem.writeTextFileAtomic(
		cancellationRequestPath(operation, requestId),
		JSON.stringify({
			taskIdentity: operation.taskIdentity,
			requestId,
		}),
		{ durable: true, fileMode: 0o600 },
	);
}

/** 最终看板提交与独立撤销凭据共用短锁，明确二者的持久提交顺序。 */
export async function withTaskClosureLifecycleCancellationGuards<T>(
	operations: TaskClosureOperation[],
	action: () => Promise<T>,
) {
	return lockedFileSystem.withLocks(
		operations.map((operation) => ({
			path: cancellationRequestPath(operation, activeTaskClosureLifecycleRequestId(operation)),
		})),
		async () => {
			for (const operation of operations) await assertTaskClosureLifecycleNotCancelled(operation);
			return action();
		},
	);
}

export async function isTaskClosureLifecycleCancellationRequested(operation: TaskClosureOperation) {
	try {
		const requestId = activeTaskClosureLifecycleRequestId(operation);
		const record = z
			.object({ requestId: z.string().uuid(), taskIdentity: taskClosureQualifiedTaskReferenceSchema })
			.parse(JSON.parse(await readFile(cancellationRequestPath(operation, requestId), "utf8")));
		if (record.requestId !== requestId || !isDeepStrictEqual(record.taskIdentity, operation.taskIdentity))
			throw new Error("结案撤销记录归属不一致，保留工作树。");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function assertTaskClosureLifecycleNotCancelled(operation: TaskClosureOperation) {
	if (await isTaskClosureLifecycleCancellationRequested(operation))
		throw new Error("任务生命周期请求已取消，未继续执行。");
}

export function taskClosureVerifiedArchivePublicationReceiptPath(
	operation: TaskClosureOperation,
	isDamagedArchiveReplacement = false,
) {
	return join(
		taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
		isDamagedArchiveReplacement
			? "verified-replacement-git-working-state-archive-manifest.json"
			: "verified-git-working-state-archive-manifest.json",
	);
}

export async function writeTaskClosureAutomaticAttemptReceipt(
	operation: TaskClosureOperation,
	event: "started" | "completed" | "failed",
	details: unknown = null,
) {
	const state =
		operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase)
			? operation.reopening.automaticRecovery
			: operation.progress.automaticRecovery;
	if (!state?.pendingSideEffect) return;
	const directory = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const path = join(
		directory,
		`automatic-attempt-${state.automaticAttemptCount}-${state.pendingSideEffect}-${event}.json`,
	);
	const receipt = {
		taskIdentity: operation.taskIdentity,
		requestId: activeTaskClosureLifecycleRequestId(operation),
		automaticAttemptCount: state.automaticAttemptCount,
		sideEffect: state.pendingSideEffect,
		event,
		details,
	};
	try {
		const previous: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isDeepStrictEqual(previous, receipt)) throw new Error("自动尝试回执只允许追加，不能覆盖已有事实。");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(receipt), { durable: true, fileMode: 0o600 });
}

const reportedRecoveryFailuresByIdentity = new Map<string, string>();
export function logTaskClosureRecoveryFailure(identity: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (reportedRecoveryFailuresByIdentity.get(identity) === message) return;
	reportedRecoveryFailuresByIdentity.set(identity, message);
	try {
		process.stderr.write(`[warn] [task-closure-recovery] ${identity}: ${message}\n`);
	} catch {
		/* 诊断失败不影响其他任务恢复。 */
	}
}
export async function listTaskClosureOperations(
	identity?: TaskClosureOperation["taskIdentity"],
): Promise<TaskClosureOperation[]> {
	const records: TaskClosureOperation[] = [];
	async function readDirectory(directory: string, depth: number) {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (depth > 0) {
				if (/^[a-f0-9-]+$/iu.test(entry))
					await readDirectory(join(directory, entry), depth - 1).catch((error: unknown) => {
						if (identity) throw error;
						logTaskClosureRecoveryFailure(join(directory, entry), error);
					});
			} else if (entry === "operation.json") {
				records.push(taskClosureOperationSchema.parse(JSON.parse(await readFile(join(directory, entry), "utf8"))));
			}
		}
	}
	await readDirectory(identity ? taskClosureTaskDirectory(identity) : taskClosureOperationsRoot(), identity ? 1 : 2);
	return records;
}

const lifecycleLocksHeldByCurrentAsyncOperation = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

export async function withTaskClosureLifecycleLocks<T>(
	workspaceId: string,
	taskIds: readonly string[],
	action: () => Promise<T>,
) {
	const inherited = lifecycleLocksHeldByCurrentAsyncOperation.getStore() ?? new Map<string, { active: boolean }>();
	const keys = [...new Set(taskIds)].sort().map((taskId) => taskClosureIdentityKey([workspaceId, taskId]));
	const acquiredKeys = keys.filter((key) => !inherited.get(key)?.active);
	return await lockedFileSystem.withLocks(
		acquiredKeys.map((key) => ({
			type: "directory" as const,
			path: join(getRuntimeHomePath(), "task-lifecycle-operation-locks", key),
		})),
		async () => {
			const leases: Array<[string, { active: boolean }]> = acquiredKeys.map((key) => [key, { active: true }]);
			const held = new Map([...inherited, ...leases]);
			try {
				return await lifecycleLocksHeldByCurrentAsyncOperation.run(held, action);
			} finally {
				for (const [, lease] of leases) lease.active = false;
			}
		},
	);
}

export async function writeTaskClosureHistoryRecord(record: TaskClosureRecord) {
	await ensurePrivateTaskClosureArtifactDirectory(record.taskIdentity);
	const historyDirectory = join(taskClosureTaskDirectory(record.taskIdentity), "closure-history-records");
	await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
	await chmod(historyDirectory, 0o700);
	const path = join(
		taskClosureTaskDirectory(record.taskIdentity),
		"closure-history-records",
		`${record.closureRequestId}.json`,
	);
	try {
		const existing = await readFile(path, "utf8");
		if (!isDeepStrictEqual(JSON.parse(existing), JSON.parse(JSON.stringify(record))))
			throw new Error("结案历史只允许追加，不能覆盖已有记录。");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(record), {
		lock: null,
		durable: true,
		fileMode: 0o600,
	});
}

export async function readTaskClosureHistory(identity: TaskClosureOperation["taskIdentity"]) {
	const directory = join(taskClosureTaskDirectory(identity), "closure-history-records");
	let names: string[] = [];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const records = await Promise.all(
		names
			.filter((name) => /^[a-f0-9-]+\.json$/iu.test(name))
			.map(async (name) => taskClosureRecordSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")))),
	);
	return {
		records: records.sort((a, b) => a.recordedAtEpochMs - b.recordedAtEpochMs),
		operations: (await listTaskClosureOperations(identity)).map((operation) => operation.progress),
		reopeningOperations: (await listTaskClosureOperations(identity)).flatMap((operation) =>
			operation.reopening
				? [
						{
							closureRequestId: operation.progress.closureRequestId,
							phase: operation.reopening.phase,
							lastError: operation.reopening.lastError,
							automaticRecovery: operation.reopening.automaticRecovery,
						},
					]
				: [],
		),
	};
}
