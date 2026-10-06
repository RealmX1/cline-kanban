import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest } from "@/runtime/types";

export function saveAgentRaisedPendingUserDecisionAnswerDraftToRuntime(
	workspaceId: string,
	input: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest,
) {
	return getRuntimeTrpcClient(workspaceId).runtime.saveAgentRaisedPendingUserDecisionAnswerDraft.mutate(input);
}
