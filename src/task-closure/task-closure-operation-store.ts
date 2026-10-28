import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
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
	taskClosureOperationProgressSchema,
	taskClosureQualifiedTaskReferenceSchema,
	taskClosureRecordSchema,
} from "../core/task-closure-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

export const taskClosureOperationSchema = z.object({
	schemaVersion: z.literal(1),
	preservationPurpose: z.enum(["close_task", "permanently_delete_task"]).optional(),
	taskIdentity: taskClosureQualifiedTaskReferenceSchema,
	workspacePath: z.string(),
	sourceWorktreePath: z.string().nullable(),
	processIdsAwaitingExit: z.array(z.number().int().positive()).optional(),
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
		await chmod(directory, 0o700);
	}
	return directories[directories.length - 1];
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
	await lockedFileSystem.writeTextFileAtomic(
		join(
			taskClosureOperationDirectory(operation.taskIdentity, operation.progress.closureRequestId),
			"operation.json",
		),
		JSON.stringify(operation),
		{ lock: null, durable: true, fileMode: 0o600 },
	);
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
						},
					]
				: [],
		),
	};
}
