// 排队 prompt 投递的浏览器侧传输助手。把 tRPC 细节挡在这里，hook 只管状态编排。
//
// 队列的真相源在**服务端**（~/.cline/kanban/workspaces/<id>/queued-task-prompt-deliveries.json），浏览器只持有
// 投影（正文截断预览 + 阻塞原因）。全文由会话独享的 reader 按需读取并缓存。

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

// 正文入队即冻结。多行同时准备复制时共用一次快照读取，随后展开与复制都复用原文。
// reader 绑定 workspace + 会话；切换归属后创建新 reader，旧请求只会写自己的缓存。
export function createQueuedTaskPromptDeliveryFullTextReader(
	workspaceId: string | null,
	taskId: string,
): (queueEntryId: string) => Promise<string | null> {
	if (!workspaceId) return async () => null;
	const preparedFullTextsByQueueEntryId = new Map<string, string>();
	let inFlightSnapshotRead: Promise<boolean> | null = null;
	const startOrReuseInFlightSnapshotRead = () => {
		if (inFlightSnapshotRead === null) {
			inFlightSnapshotRead = fetchTaskPromptDeliveryQueue(workspaceId, AbortSignal.timeout(5_000))
				.then((response) => {
					if (!response.ok || response.queue === null) return false;
					for (const entry of response.queue.entriesByTaskId[taskId] ?? []) {
						preparedFullTextsByQueueEntryId.set(entry.queueEntryId, entry.text);
					}
					return true;
				})
				.catch(() => {
					// 不缓存读取失败，用户重试或新条目出现时仍可重新取证。
					return false;
				})
				.finally(() => {
					inFlightSnapshotRead = null;
				});
		}
		return inFlightSnapshotRead;
	};
	return async (queueEntryId) => {
		const cachedFullText = preparedFullTextsByQueueEntryId.get(queueEntryId);
		if (cachedFullText !== undefined) return cachedFullText;
		const joinedEarlierSnapshotRead = inFlightSnapshotRead !== null;
		const didReadSnapshotSuccessfully = await startOrReuseInFlightSnapshotRead();
		// 新条目可能晚于共享请求入队；旧快照成功但缺项时仅补读一次，补读仍共用在途请求。
		if (
			joinedEarlierSnapshotRead &&
			didReadSnapshotSuccessfully &&
			!preparedFullTextsByQueueEntryId.has(queueEntryId)
		) {
			await startOrReuseInFlightSnapshotRead();
		}
		return preparedFullTextsByQueueEntryId.get(queueEntryId) ?? null;
	};
}
