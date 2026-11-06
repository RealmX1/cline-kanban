// 查询与 findings 写回校验共用同一份投影可用性；旧来源退役后不伪造历史 turn。

import type { RuntimeConversationTurnProjectionHarnessSource } from "../core/api-contract";
import type { ConversationTurnProjection } from "./conversation-turn-projection";

// 源不可用时的占位签名（与空消息流的投影签名同形，见 buildConversationTurnProjectionSignature）。
export const UNAVAILABLE_PROJECTION_SIGNATURE = "0:none:0";

export interface ConversationSessionTurnProjectionScope {
	workspaceId: string;
	workspacePath: string;
}

export interface ConversationSessionTurnProjectionSnapshot {
	harnessSource: RuntimeConversationTurnProjectionHarnessSource;
	// 源不可用时 entries 为空、签名为 UNAVAILABLE_PROJECTION_SIGNATURE。
	projection: ConversationTurnProjection;
	// 该任务保留的 checkpoint commit 集合（apply 漏斗校验 agent 自报锚点 commit 的输入）。
	// best-effort：git 故障时为空集——投影条目照常如实降级 unaligned。
	retainedCheckpointCommits: ReadonlySet<string>;
}

// Cline 结构化消息源已退役。保留查询的未知态，不加载 SDK、不伪造旧会话的 turn。
export async function loadConversationSessionTurnProjection(): Promise<ConversationSessionTurnProjectionSnapshot> {
	return {
		harnessSource: "unavailable_live_terminal_pty",
		projection: { entries: [], signature: UNAVAILABLE_PROJECTION_SIGNATURE },
		retainedCheckpointCommits: new Set(),
	};
}
