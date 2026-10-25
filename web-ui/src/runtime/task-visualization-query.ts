import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export async function fetchTaskVisualizationArtifacts(workspaceId: string, taskId: string, signal?: AbortSignal) {
	return await getRuntimeTrpcClient(workspaceId).taskVisualizationArtifacts.list.query({ taskId }, { signal });
}

export async function prepareTaskVisualizationPreview(
	workspaceId: string,
	taskId: string,
	visualizationArtifactId: string,
	revisionId?: string,
	signal?: AbortSignal,
) {
	return await getRuntimeTrpcClient(workspaceId).taskVisualizationArtifacts.preparePreview.query(
		{ taskId, visualizationArtifactId, revisionId },
		{ signal },
	);
}
