import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskRetainedCommittedLineChangeHistory } from "@/runtime/types";

export async function fetchTaskRetainedCommittedLineChangeHistory(
	workspaceId: string,
	input: { taskId: string; baseRef: string },
): Promise<RuntimeTaskRetainedCommittedLineChangeHistory> {
	return await getRuntimeTrpcClient(workspaceId).workspace.getTaskRetainedCommittedLineChangeHistory.query(input);
}
