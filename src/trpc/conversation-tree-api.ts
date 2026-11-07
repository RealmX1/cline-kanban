// Conversation Tree / turn 投影层的 tRPC handler 层（姊妹蓝图 §2.2 的 query 形状，
// exploratory 蓝图 M0 的锚点基座数据源）。
// 纯委托：投影加载链（廉价信号判定 + 消息加载 + refs 枚举 + 派生）在
// src/conversation-tree/load-conversation-session-turn-projection.ts——exploratory 写回
// apply 漏斗复用同一条链，两侧不得各写一份。
//
// 旧结构化投影源已退役；查询如实返回不可用，既有 findings 与出处不变。

import { sliceConversationTurnProjectionEntries } from "../conversation-tree/conversation-turn-projection";
import { loadConversationSessionTurnProjection } from "../conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
} from "../core/api-contract";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export function createConversationTreeApi(): RuntimeTrpcContext["conversationTreeApi"] {
	return {
		getConversationSessionTurnProjection: async (
			_scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConversationSessionTurnProjectionRequest,
		): Promise<RuntimeConversationSessionTurnProjectionResponse> => {
			const snapshot = await loadConversationSessionTurnProjection();
			const sliced = sliceConversationTurnProjectionEntries(snapshot.projection.entries, {
				sinceTurnNumber: input.sinceTurnNumber,
				maxTurnEntries: input.maxTurnEntries,
			});
			return {
				harnessSource: snapshot.harnessSource,
				turnProjectionEntries: sliced.entries,
				turnProjectionSignature: snapshot.projection.signature,
				turnProjectionIsIncomplete: sliced.isIncomplete,
			};
		},
	};
}
