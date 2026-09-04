// Conversation Tree / Session Map 的客户端消息切段模型（纯函数）。
// 设计蓝图：姊妹蓝图 .plan/docs/conversation-tree-unified-fan-out-interface-deferred-asset.md §5.5
// 与 exploratory-mode 蓝图 §C.3。
//
// 这里实现的是「turn → 消息」的**位置性**滚动定位映射：输出每条消息所属的服务端投影 turn 号。
// turn 编号权威永远在服务端投影层（src/conversation-tree/conversation-turn-projection.ts，
// 与 checkpoint 序数对齐）——本模块不得自行编号，只回答「这条消息属于 T几」，供
// `data-turn-anchor="T{n}"` DOM 锚使用。每次进任务重算；绝不用消息 id 做锚
// （id 重启即变，蓝图代码事实 1）——id 只用于当次渲染期内的「消息 → turn」查表。
//
// 边界分类直接复用服务端同源函数（相对路径 import 先例见
// web-ui/src/runtime/task-edit-draft-store.ts → ../../../src/core/api-contract），
// 保证客户端映射与服务端编号语义同源，不镜像重写。

import type { RuntimeTaskChatMessage } from "@/runtime/types";
import { classifyConversationTurnBoundaryMessage } from "../../../../src/conversation-tree/conversation-turn-projection";

// 位置性切段：真实用户提交（服务端分类器判定）开新 turn，其后消息归入该 turn；
// 首个边界消息之前的旁白消息（会话恢复 history_notice 等）无所属 turn，不进映射。
export function deriveTurnBoundariesFromChatMessages(
	messages: readonly RuntimeTaskChatMessage[],
): ReadonlyMap<string, number> {
	const turnNumberByMessageId = new Map<string, number>();
	let currentTurnNumber = 0;
	for (const message of messages) {
		if (classifyConversationTurnBoundaryMessage(message)) {
			currentTurnNumber += 1;
		}
		if (currentTurnNumber > 0) {
			turnNumberByMessageId.set(message.id, currentTurnNumber);
		}
	}
	return turnNumberByMessageId;
}

// 派生结果的粗粒度 memo 键（姊妹蓝图 §5.5）：消息账本 reducer 每次 upsert 都换数组引用，
// 不能依赖引用相等；形状与服务端投影签名（{count}:{lastMessageId}:{lastMessageContentLength}）
// 同构——流式期间 assistant chunk 同 id 原位追加，只有末条 content 长度能感知追加。
export function buildTurnBoundaryDerivationMemoKey(messages: readonly RuntimeTaskChatMessage[]): string {
	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	return `${messages.length}:${lastMessage?.id ?? "none"}:${lastMessage?.content.length ?? 0}`;
}
