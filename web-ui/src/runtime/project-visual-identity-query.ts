import type { SetProjectVisualIdentityRequest } from "@runtime-project-visual-identity";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export async function saveProjectVisualIdentity(request: SetProjectVisualIdentityRequest) {
	return await getRuntimeTrpcClient(request.workspaceId).projects.setProjectVisualIdentity.mutate(request);
}
export async function resetProjectVisualIdentity(workspaceId: string) {
	return await getRuntimeTrpcClient(workspaceId).projects.resetProjectVisualIdentityToDefault.mutate({ workspaceId });
}

const projectIconImageRequestsByWorkspaceAndAssetId = new Map<string, Promise<string>>();
export function fetchProjectIconImageDataUrl(workspaceId: string, imageAssetId: string): Promise<string> {
	const key = `${workspaceId}:${imageAssetId}`;
	const cached = projectIconImageRequestsByWorkspaceAndAssetId.get(key);
	if (cached) return cached;
	const request = getRuntimeTrpcClient(workspaceId)
		.projects.readProjectIconImage.query({ workspaceId, imageAssetId })
		.then((image) => `data:${image.mediaType};base64,${image.base64Content}`)
		.catch((error: unknown) => {
			projectIconImageRequestsByWorkspaceAndAssetId.delete(key);
			throw error;
		});
	if (projectIconImageRequestsByWorkspaceAndAssetId.size >= 128) {
		const oldestKey = projectIconImageRequestsByWorkspaceAndAssetId.keys().next().value;
		if (oldestKey) projectIconImageRequestsByWorkspaceAndAssetId.delete(oldestKey);
	}
	projectIconImageRequestsByWorkspaceAndAssetId.set(key, request);
	return request;
}
