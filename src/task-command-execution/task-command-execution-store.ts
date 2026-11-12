import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type TaskCommandExecutionRecord,
	taskCommandExecutionRecordSchema,
} from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { createParsedPersistedJsonFileReadCache } from "../state/parsed-persisted-json-file-read-cache";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";

export function taskCommandExecutionArtifactDirectory(workspaceId: string, executionId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), "task-command-executions", executionId);
}

const recordsSchema = z.array(taskCommandExecutionRecordSchema);
const observationReadCache = createParsedPersistedJsonFileReadCache<TaskCommandExecutionRecord[]>();
function recordsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), "task-command-executions.json");
}

export async function readTaskCommandExecutions(workspaceId: string): Promise<TaskCommandExecutionRecord[]> {
	try {
		return recordsSchema.parse(JSON.parse(await readFile(recordsPath(workspaceId), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

// 只供候选筛选和观察使用；返回值不得修改，派发/投递/撤销及持锁写入仍权威重读。
export function readTaskCommandExecutionsForObservation(workspaceId: string): Promise<TaskCommandExecutionRecord[]> {
	return observationReadCache.read(recordsPath(workspaceId), () => readTaskCommandExecutions(workspaceId));
}

export async function mutateTaskCommandExecutions<TResult>(
	workspaceId: string,
	mutation: (
		records: TaskCommandExecutionRecord[],
	) =>
		| { records: TaskCommandExecutionRecord[] | null; result: TResult }
		| Promise<{ records: TaskCommandExecutionRecord[] | null; result: TResult }>,
): Promise<TResult> {
	await mkdir(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
	return lockedFileSystem.withLock({ path: recordsPath(workspaceId), type: "file" }, async () => {
		const records = await readTaskCommandExecutions(workspaceId);
		const transformed = await mutation(records);
		// 显式 null 才跳过写入；旧调用方原地修改并返回原数组的契约继续成立。
		if (transformed.records === null) return transformed.result;
		await lockedFileSystem.writeJsonFileAtomic(recordsPath(workspaceId), recordsSchema.parse(transformed.records), {
			lock: null,
			durable: true,
		});
		observationReadCache.forget(recordsPath(workspaceId));
		return transformed.result;
	});
}
