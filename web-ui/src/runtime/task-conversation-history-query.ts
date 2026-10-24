import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
} from "@/runtime/types";

export async function fetchTaskConversationHistoryPage(
	workspaceId: string,
	input: RuntimeTaskConversationHistoryPageRequest,
): Promise<RuntimeTaskConversationHistoryPageResponse> {
	return await getRuntimeTrpcClient(workspaceId).runtime.getTaskConversationHistoryPage.query(input);
}
