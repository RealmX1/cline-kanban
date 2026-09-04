// Session Map 面板的浏览器侧传输助手。把 tRPC 细节挡在这里，hook 只管状态编排
// （镜像 prompt-library-query.ts 的同款分层）。
//
// 数据源（server 侧 M0 已落地）：
// - conversationTree.getConversationSessionTurnProjection：harness-neutral turn 投影
//   （姊妹蓝图 §2.2），map 面板裸锚点骨架的数据源；
// - exploratory.getSessionMap：per-workspace map store 中该会话的集合
//   （蓝图 §B.1）。M0 恒为 null（agent 写入通道属 M1），面板在此态渲染投影层 turn 骨架。

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeGetExploratorySessionMapResponse,
} from "@/runtime/types";

export async function fetchConversationSessionTurnProjection(
	workspaceId: string,
	request: RuntimeConversationSessionTurnProjectionRequest,
): Promise<RuntimeConversationSessionTurnProjectionResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.conversationTree.getConversationSessionTurnProjection.query(request);
}

export async function fetchExploratorySessionMap(
	workspaceId: string,
	conversationSessionTaskId: string,
): Promise<RuntimeGetExploratorySessionMapResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.exploratory.getSessionMap.query({ conversationSessionTaskId });
}
