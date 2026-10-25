// 排队 prompt 投递的浏览器侧传输助手。把 tRPC 细节挡在这里，hook 只管状态编排。
//
// 队列的真相源在**服务端**（~/.cline/kanban/workspaces/<id>/queued-task-prompt-deliveries.json），浏览器只持有
// 投影（正文截断预览 + 阻塞原因）。全文按需经 fetchQueuedTaskPromptDeliveryFullText 拉。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	QueuedTaskPromptDeliveryMutation,
	RuntimeTaskPromptDeliveryQueueMutateResponse,
	RuntimeTaskPromptDeliveryQueueResponse,
} from "@/runtime/types";

export async function fetchTaskPromptDeliveryQueue(
	workspaceId: string,
	signal?: AbortSignal,
): Promise<RuntimeTaskPromptDeliveryQueueResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getTaskPromptDeliveryQueue.query({}, { signal });
}

export async function mutateTaskPromptDeliveryQueue(
	workspaceId: string,
	mutation: QueuedTaskPromptDeliveryMutation,
): Promise<RuntimeTaskPromptDeliveryQueueMutateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.mutateTaskPromptDeliveryQueue.mutate({ mutation });
}

// 投影只带 200 字预览；展开一行时再拉全文。读的是整份快照（队列恒小：per-workspace 上限 200 条），
// 不值得为「只拉一条」单开一个 procedure。
export async function fetchQueuedTaskPromptDeliveryFullText(
	workspaceId: string,
	taskId: string,
	queueEntryId: string,
): Promise<string | null> {
	const response = await fetchTaskPromptDeliveryQueue(workspaceId);
	if (!response.ok || response.queue === null) {
		return null;
	}
	return response.queue.entriesByTaskId[taskId]?.find((entry) => entry.queueEntryId === queueEntryId)?.text ?? null;
}
