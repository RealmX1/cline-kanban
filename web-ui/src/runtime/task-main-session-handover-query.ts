import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	TaskMainSessionHandoverRecoverWithNewAgentSessionRequest,
	TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
	TaskMainSessionHandoverRequest,
} from "@/runtime/types";

export async function getTaskMainSessionHandoverStatus(workspaceId: string, taskId: string) {
	return await getRuntimeTrpcClient(workspaceId).runtime.getTaskMainSessionHandoverStatus.query({ taskId });
}

export async function recoverTaskMainSessionHandoverWithNewCodexSession(
	workspaceId: string,
	input: TaskMainSessionHandoverRecoverWithNewCodexSessionRequest,
) {
	return await getRuntimeTrpcClient(workspaceId).runtime.recoverTaskMainSessionHandoverWithNewCodexSession.mutate(
		input,
	);
}

export async function recoverTaskMainSessionHandoverWithNewAgentSession(
	workspaceId: string,
	input: TaskMainSessionHandoverRecoverWithNewAgentSessionRequest,
) {
	return await getRuntimeTrpcClient(workspaceId).runtime.recoverTaskMainSessionHandoverWithNewAgentSession.mutate(
		input,
	);
}

export async function prepareTaskMainSessionHandover(workspaceId: string, taskId: string) {
	return await getRuntimeTrpcClient(workspaceId).runtime.prepareTaskMainSessionHandover.query({ taskId });
}

export async function requestTaskMainSessionHandover(workspaceId: string, input: TaskMainSessionHandoverRequest) {
	return await getRuntimeTrpcClient(workspaceId).runtime.requestTaskMainSessionHandover.mutate(input);
}

export async function cancelTaskMainSessionHandover(workspaceId: string, taskId: string) {
	return await getRuntimeTrpcClient(workspaceId).runtime.cancelTaskMainSessionHandover.mutate({ taskId });
}

export async function retryTaskMainSessionHandover(workspaceId: string, taskId: string) {
	return await getRuntimeTrpcClient(workspaceId).runtime.retryTaskMainSessionHandover.mutate({ taskId });
}
