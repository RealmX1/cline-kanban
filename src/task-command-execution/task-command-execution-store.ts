import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type TaskCommandExecutionRecord,
	taskCommandExecutionRecordSchema,
} from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";

export function taskCommandExecutionArtifactDirectory(workspaceId: string, executionId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), "task-command-executions", executionId);
}

const recordsSchema = z.array(taskCommandExecutionRecordSchema);
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

export async function mutateTaskCommandExecutions<TResult>(
	workspaceId: string,
	mutation: (
		records: TaskCommandExecutionRecord[],
	) =>
		| { records: TaskCommandExecutionRecord[]; result: TResult }
		| Promise<{ records: TaskCommandExecutionRecord[]; result: TResult }>,
): Promise<TResult> {
	await mkdir(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
	return lockedFileSystem.withLock({ path: recordsPath(workspaceId), type: "file" }, async () => {
		const transformed = await mutation(await readTaskCommandExecutions(workspaceId));
		await lockedFileSystem.writeJsonFileAtomic(recordsPath(workspaceId), recordsSchema.parse(transformed.records), {
			lock: null,
			durable: true,
		});
		return transformed.result;
	});
}
