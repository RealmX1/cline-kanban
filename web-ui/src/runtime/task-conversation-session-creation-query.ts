import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskConversationSessionCreateRequest,
	RuntimeTaskConversationSessionRenameRequest,
} from "@/runtime/types";

export async function submitOrRecoverTaskConversationSessionCreation(
	workspaceId: string,
	request: RuntimeTaskConversationSessionCreateRequest,
) {
	const runtime = getRuntimeTrpcClient(workspaceId).runtime;
	const previous = await runtime.lookupTaskConversationSessionCreation.query(request);
	return previous ?? (await runtime.createTaskConversationSession.mutate(request));
}
export async function previewTaskConversationSessionCreation(
	workspaceId: string,
	request: RuntimeTaskConversationSessionCreateRequest,
) {
	return getRuntimeTrpcClient(workspaceId).runtime.previewTaskConversationSession.query(request);
}
export async function renameTaskConversationSession(
	workspaceId: string,
	request: RuntimeTaskConversationSessionRenameRequest,
) {
	return getRuntimeTrpcClient(workspaceId).runtime.renameTaskConversationSession.mutate(request);
}
