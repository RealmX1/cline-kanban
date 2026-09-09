// 会话 turn 投影的浏览器侧传输助手。把 tRPC 细节挡在这里，hook 只管状态编排
// （镜像 prompt-library-query.ts / findings-query.ts 的同款分层）。
//
// 数据源：conversationTree.getConversationSessionTurnProjection——harness-neutral turn 投影
// （姊妹蓝图 .plan/docs/conversation-tree-unified-fan-out-interface-deferred-asset.md §2.2）。
// 消费者：findings「存为 finding」的锚三元 commit 解析（use-conversation-session-turn-projection）；
// exploration thread graph 面板（B.2）同样以它做 turn 行的展示数据。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
} from "@/runtime/types";

export async function fetchConversationSessionTurnProjection(
	workspaceId: string,
	request: RuntimeConversationSessionTurnProjectionRequest,
): Promise<RuntimeConversationSessionTurnProjectionResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.conversationTree.getConversationSessionTurnProjection.query(request);
}
