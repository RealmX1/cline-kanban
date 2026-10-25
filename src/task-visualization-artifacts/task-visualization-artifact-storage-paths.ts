import { createHash } from "node:crypto";
import { join } from "node:path";
import { taskVisualizationPublicationRequestIdSchema } from "../core/task-visualization-artifact-contract";

export function hashTaskVisualizationIdentity(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function taskVisualizationStorageDirectory(runtimeHomeDirectoryPath: string): string {
	return join(runtimeHomeDirectoryPath, "persistent-task-visualization-artifacts");
}

export function pendingTaskVisualizationPublicationsDirectory(runtimeHomeDirectoryPath: string): string {
	return join(taskVisualizationStorageDirectory(runtimeHomeDirectoryPath), "publications-awaiting-runtime-acceptance");
}

export function taskVisualizationPublicationStagingSequencePath(
	runtimeHomeDirectoryPath: string,
	workspaceId: string,
	taskId: string,
): string {
	return join(
		taskVisualizationStorageDirectory(runtimeHomeDirectoryPath),
		"publication-staging-sequences-by-task",
		hashTaskVisualizationIdentity(workspaceId),
		`${hashTaskVisualizationIdentity(taskId)}.json`,
	);
}

export function pendingTaskVisualizationPublicationDirectory(
	runtimeHomeDirectoryPath: string,
	requestId: string,
): string {
	return join(
		pendingTaskVisualizationPublicationsDirectory(runtimeHomeDirectoryPath),
		taskVisualizationPublicationRequestIdSchema.parse(requestId),
	);
}

export function taskVisualizationTaskStorageDirectory(
	runtimeHomeDirectoryPath: string,
	workspaceId: string,
	taskId: string,
): string {
	return join(
		taskVisualizationStorageDirectory(runtimeHomeDirectoryPath),
		"published-task-artifacts",
		hashTaskVisualizationIdentity(workspaceId),
		hashTaskVisualizationIdentity(taskId),
	);
}
