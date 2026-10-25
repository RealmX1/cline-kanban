import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type TaskIndexingSupportExecutorSettings,
	taskIndexingSupportExecutorSettingsSchema,
} from "../core/task-indexing-support-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath, getWorkspaceDirectoryPath } from "../state/workspace-state";
import { advanceSharedTaskIndexingSnapshot, taskIndexingTextFingerprint } from "./shared-task-indexing-context";

export function taskIndexingSupportWorkspaceStoragePath(workspaceId: string, filename: string): string {
	if (!/^[a-zA-Z0-9_-]+$/u.test(workspaceId)) throw new Error("共享索引需要合法的 workspaceId。");
	return join(getWorkspaceDirectoryPath(workspaceId), "task-indexing-support", filename);
}
export async function readTaskIndexingSupportJsonFile(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}
export async function readTaskIndexingSupportExecutorSettings(
	workspaceId: string | null,
): Promise<TaskIndexingSupportExecutorSettings> {
	const globalValue = await readTaskIndexingSupportJsonFile(
		join(getRuntimeHomePath(), "task-analysis", "executor-settings.json"),
	);
	const value =
		globalValue ??
		(workspaceId
			? await readTaskIndexingSupportJsonFile(
					taskIndexingSupportWorkspaceStoragePath(workspaceId, "executor-settings.json"),
				)
			: null);
	return taskIndexingSupportExecutorSettingsSchema.parse(value ?? {});
}
export async function saveTaskIndexingSupportExecutorSettings(
	_workspaceId: string | null,
	settings: TaskIndexingSupportExecutorSettings,
) {
	await lockedFileSystem.writeJsonFileAtomic(
		join(getRuntimeHomePath(), "task-analysis", "executor-settings.json"),
		taskIndexingSupportExecutorSettingsSchema.parse(settings),
	);
	return settings;
}

export async function loadAndAdvanceSharedTaskIndexingContext(
	input: Parameters<typeof advanceSharedTaskIndexingSnapshot>[1],
) {
	const bucket = taskIndexingTextFingerprint(JSON.stringify([input.instructionVersion, input.settings]));
	const path = taskIndexingSupportWorkspaceStoragePath(input.workspaceId, `context-snapshot-${bucket}.json`);
	return await lockedFileSystem.withLock({ path }, async () => {
		let previous: unknown;
		try {
			previous = await readTaskIndexingSupportJsonFile(path);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			previous = {};
		}
		const { snapshot, context } = advanceSharedTaskIndexingSnapshot(previous, input);
		if (input.forModelRequest) snapshot.lastModelRequestAt = input.now;
		await lockedFileSystem.writeJsonFileAtomic(path, snapshot, { lock: null });
		return context;
	});
}
