import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
export async function actOnAutomaticAgentFailureContinuation(
	workspaceId: string,
	taskId: string,
	episodeId: string,
	action: "retry_now" | "cancel",
) {
	return getRuntimeTrpcClient(workspaceId).runtime.actOnAutomaticFailureContinuation.mutate({
		taskId,
		episodeId,
		action,
	});
}
