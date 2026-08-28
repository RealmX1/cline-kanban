// Conversation Tree / turn 投影层的 tRPC handler 层（姊妹蓝图 §2.2 的 query 形状，
// exploratory 蓝图 M0 的锚点基座数据源）。
// 纯委托：投影加载链（廉价信号判定 + 消息加载 + refs 枚举 + 派生）在
// src/conversation-tree/load-conversation-session-turn-projection.ts——exploratory 写回
// apply 漏斗复用同一条链，两侧不得各写一份。
//
// M0 只接 Cline SDK 源（exact_structured）；PTY 会话按 session 粒度降级为
// unavailable_live_terminal_pty（终端 transcript 全量提取器属姊妹蓝图步骤 4 的其余部分）。
// ACP 会话同样落入该降级档——枚举名的字面语义对 ACP 不精确（其消息在内存、非 PTY），
// M0 实施注记已记录，ACP 投影源形态待蓝图补章后落地。

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import { sliceConversationTurnProjectionEntries } from "../conversation-tree/conversation-turn-projection";
import {
	type ConversationSessionTurnProjectionScope,
	loadConversationSessionTurnProjection,
} from "../conversation-tree/load-conversation-session-turn-projection";
import type {
	RuntimeConversationSessionTurnProjectionRequest,
	RuntimeConversationSessionTurnProjectionResponse,
} from "../core/api-contract";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateConversationTreeApiDependencies {
	getScopedClineTaskSessionService: (
		scope: ConversationSessionTurnProjectionScope,
	) => Promise<ClineTaskSessionService>;
	// 看板卡片上该 task 声明的 agentId（无卡片 / 未声明 → null）。语义见加载器同名 dep 注释。
	loadBoardCardAgentId: (scope: ConversationSessionTurnProjectionScope, taskId: string) => Promise<string | null>;
}

export function createConversationTreeApi(
	deps: CreateConversationTreeApiDependencies,
): RuntimeTrpcContext["conversationTreeApi"] {
	return {
		getConversationSessionTurnProjection: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: RuntimeConversationSessionTurnProjectionRequest,
		): Promise<RuntimeConversationSessionTurnProjectionResponse> => {
			const snapshot = await loadConversationSessionTurnProjection(deps, scope, input.conversationSessionTaskId);
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
