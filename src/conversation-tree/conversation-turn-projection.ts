// Harness-neutral turn 投影层（只读派生，无持久化真相）。
// 设计：姊妹蓝图 .plan/docs/conversation-tree-unified-fan-out-interface-deferred-asset.md §2
// 与 exploratory-mode 蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md（锚点基座）。
//
// 本模块是纯函数层：输入 harness 规整后的消息流，输出统一 turn 序列 + 投影签名。
// turn 编号权威在这里（与 checkpoint 序数对齐）；web-ui 的消息切段只做滚动定位映射，
// 不得自行编号。M0 只接 Cline SDK 源（exact_structured）；终端 transcript 全量提取器
// 属姊妹蓝图步骤 4 的其余部分，落地时把解析骨架喂给同一派生函数即可。

import type {
	RuntimeConversationTurnCheckpointAlignmentConfidence,
	RuntimeConversationTurnProjectionEntry,
} from "../core/api-contract";

// 投影层消费的 harness-neutral 最小消息形状（ClineTaskMessage / RuntimeTaskChatMessage 的
// 结构子集）。刻意不从 cline-sdk / acp 边界 import 类型——投影层自身保持 harness-neutral，
// 由调用方（tRPC 层）把各 transport 的消息规整喂入。
export interface ConversationTurnProjectionSourceMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool" | "reasoning" | "status";
	content: string;
	createdAt: number;
	meta?: {
		hookEventName?: string | null;
		displayRole?: string | null;
		messageKind?: string | null;
	} | null;
}

export interface ConversationTurnProjectionCheckpointAlignmentInput {
	// 现存 checkpoint ref 的 turn → commit 枚举（listTaskTurnCheckpointRefs）。
	checkpointCommitsByTurnNumber: ReadonlyMap<number, string>;
	// summary.latestTurnCheckpoint?.turn（最近一次已落定的 checkpoint 序数）。
	latestCheckpointTurnNumber: number | null;
}

export interface DeriveConversationTurnProjectionOptions {
	checkpointAlignment?: ConversationTurnProjectionCheckpointAlignmentInput;
	// 末尾 turn 是否仍在 agent 回合中（调用方按 summary facet turnOwner==="agent" 推）。
	finalTurnIsInProgress?: boolean;
	maxExcerptLength?: number;
}

export interface ConversationTurnProjection {
	entries: RuntimeConversationTurnProjectionEntry[];
	signature: string;
}

const DEFAULT_MAX_EXCERPT_LENGTH = 400;

// turn 边界 = 真实用户提交。判定与 checkpoint 捕获时机（cline-task-session-service 的
// 「进入 awaiting user review」边沿抓 nextTurn）同源单测——两侧对「什么算一轮」必须一致。
//
// 排除：
// - 非 user role（assistant/tool/reasoning/system/status 永不开新 turn）；
// - meta.hookEventName 非空：hydrate 旁白（history_notice）与 hook 注入消息；
// - meta.displayRole 非空：特殊显示用途的旁白消息。
//
// 已知残余偏移（姊妹蓝图风险 1）：self-injection followup（RVF 程序化投递）在 Cline 消息
// 层面没有可靠标记（source 是自由文本、由外部投递方决定），而它引发的 agent 回合会抓
// checkpoint——于是 checkpoint 序数可能超前于本投影的 turn 编号。该偏移不在这里硬猜，
// 由 turnCheckpointAlignmentConfidence 显式降级吸收（best_effort_ordinal_match）。
export function classifyConversationTurnBoundaryMessage(message: ConversationTurnProjectionSourceMessage): boolean {
	if (message.role !== "user") {
		return false;
	}
	if (message.meta?.hookEventName != null && message.meta.hookEventName !== "") {
		return false;
	}
	if (message.meta?.displayRole != null && message.meta.displayRole !== "") {
		return false;
	}
	return true;
}

// 投影签名（Cline 源）：{messageCount}:{lastMessageId}:{lastMessageContentLength}。
// 末项必须是末条消息 content 长度而非 createdAt：流式期间 assistant chunk 以同 id 原位
// 追加（cline-session-state appendAssistantChunk），messageCount / lastMessageId / createdAt
// 三者全程不变，只有 content 长度能感知追加、使缓存与对账失效重算。
export function buildConversationTurnProjectionSignature(
	messages: readonly ConversationTurnProjectionSourceMessage[],
): string {
	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	return `${messages.length}:${lastMessage?.id ?? "none"}:${lastMessage?.content.length ?? 0}`;
}

function truncateExcerpt(content: string, maxLength: number): string {
	return content.length <= maxLength ? content : content.slice(0, maxLength);
}

function resolveCheckpointAlignment(
	turnNumber: number,
	latestProjectedTurnNumber: number,
	alignment: ConversationTurnProjectionCheckpointAlignmentInput | undefined,
): { commit: string | null; confidence: RuntimeConversationTurnCheckpointAlignmentConfidence } {
	const commit = alignment?.checkpointCommitsByTurnNumber.get(turnNumber) ?? null;
	if (commit === null) {
		return { commit: null, confidence: "unaligned" };
	}
	// 两侧序数同源单调递增：最新 turn 对得上 ⇒ 无累积偏移，全序列置信；对不上 ⇒ 有
	// self-injection 轮次等已知偏移源（姊妹蓝图风险 1），逐 ref 对齐但序列级降级。
	const latestCheckpointTurnNumber = alignment?.latestCheckpointTurnNumber ?? null;
	if (latestCheckpointTurnNumber !== null && latestCheckpointTurnNumber === latestProjectedTurnNumber) {
		return { commit, confidence: "exact_ordinal_match" };
	}
	return { commit, confidence: "best_effort_ordinal_match" };
}

// 从消息流派生 turn 序列。首个边界之前的消息（会话恢复旁白等）不进任何 turn——
// map / 树只关心「用户提交开启的对话轮次」。
export function deriveConversationTurnProjection(
	messages: readonly ConversationTurnProjectionSourceMessage[],
	options: DeriveConversationTurnProjectionOptions = {},
): ConversationTurnProjection {
	const maxExcerptLength = options.maxExcerptLength ?? DEFAULT_MAX_EXCERPT_LENGTH;
	interface TurnBucket {
		boundaryMessage: ConversationTurnProjectionSourceMessage;
		messageCount: number;
		lastAssistantContent: string | null;
	}
	const buckets: TurnBucket[] = [];
	for (const message of messages) {
		if (classifyConversationTurnBoundaryMessage(message)) {
			buckets.push({ boundaryMessage: message, messageCount: 1, lastAssistantContent: null });
			continue;
		}
		const current = buckets.length > 0 ? buckets[buckets.length - 1] : null;
		if (!current) {
			continue;
		}
		current.messageCount += 1;
		if (message.role === "assistant") {
			current.lastAssistantContent = message.content;
		}
	}
	const latestProjectedTurnNumber = buckets.length;
	const entries: RuntimeConversationTurnProjectionEntry[] = buckets.map((bucket, index) => {
		const turnNumber = index + 1;
		const alignment = resolveCheckpointAlignment(turnNumber, latestProjectedTurnNumber, options.checkpointAlignment);
		return {
			turnNumber,
			turnStartedAt: bucket.boundaryMessage.createdAt,
			turnUserMessageExcerpt: truncateExcerpt(bucket.boundaryMessage.content, maxExcerptLength),
			turnAssistantResponseExcerpt:
				bucket.lastAssistantContent !== null
					? truncateExcerpt(bucket.lastAssistantContent, maxExcerptLength)
					: null,
			turnMessageCount: bucket.messageCount,
			turnCheckpointCommit: alignment.commit,
			turnCheckpointAlignmentConfidence: alignment.confidence,
			turnIsInProgress: turnNumber === latestProjectedTurnNumber && options.finalTurnIsInProgress === true,
			// M0 恒 false：by-the-way 锚 join 属姊妹蓝图树装配步骤，且不参与投影签名。
			turnHasConversationTreeForkAnchor: false,
		};
	});
	return { entries, signature: buildConversationTurnProjectionSignature(messages) };
}

// 响应切片（姊妹蓝图 §2.2 的 since/max 增量参数）。签名永远按全量投影计算、在切片前取好——
// 它是 map / 归组资产的 apply 乐观并发对账键，切片只是控制单次响应体量。
export function sliceConversationTurnProjectionEntries(
	entries: readonly RuntimeConversationTurnProjectionEntry[],
	options: { sinceTurnNumber?: number; maxTurnEntries?: number } = {},
): { entries: RuntimeConversationTurnProjectionEntry[]; isIncomplete: boolean } {
	const sinceTurnNumber = options.sinceTurnNumber ?? null;
	const filtered =
		sinceTurnNumber !== null ? entries.filter((entry) => entry.turnNumber > sinceTurnNumber) : [...entries];
	const maxTurnEntries = options.maxTurnEntries ?? null;
	if (maxTurnEntries === null || filtered.length <= maxTurnEntries) {
		return { entries: filtered, isIncomplete: false };
	}
	// 增量语义下保留**最新**的 maxTurnEntries 条（调用方关心的是尾部推进）。
	return { entries: filtered.slice(filtered.length - maxTurnEntries), isIncomplete: true };
}
