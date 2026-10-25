import type { RuntimeHookEvent, RuntimeMainAgentConversationContextCompactionTrigger } from "../../core/api-contract";
import { readStringField } from "./hook-utils";

export interface MainAgentConversationContextCompactionFactsFromHookPayload {
	mainAgentConversationContextCompactionNativeTurnId?: string;
	mainAgentConversationContextCompactionTriggerReportedByHarness?: RuntimeMainAgentConversationContextCompactionTrigger;
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness?: number;
}

// 压缩 hook 使用 `trigger: "manual" | "auto"`；Codex 的开始/完成事件还提供同一原生 turn。
// 未知值不猜，交给服务端按回合归属判定。压缩后上下文大小只有 Kimi 报（estimatedTokenCount = tokensAfter，
// 字段名取自 kimi-code 2.1.1 二进制，载荷里的实际拼写未经真机核对，故两种拼写都认）。
export function extractMainAgentConversationContextCompactionFactsFromHookPayload(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
): MainAgentConversationContextCompactionFactsFromHookPayload {
	if (
		![
			"main_agent_conversation_context_compaction_started",
			"main_agent_conversation_context_compaction_completed",
		].includes(event) ||
		!payload
	) {
		return {};
	}
	const facts: MainAgentConversationContextCompactionFactsFromHookPayload = {};
	const nativeTurnId = readStringField(payload, "turn_id")?.trim();
	if (nativeTurnId && nativeTurnId.length <= 200)
		facts.mainAgentConversationContextCompactionNativeTurnId = nativeTurnId;
	const trigger = readStringField(payload, "trigger")?.trim().toLowerCase();
	if (trigger === "manual") {
		facts.mainAgentConversationContextCompactionTriggerReportedByHarness = "manual_compact_command";
	} else if (trigger === "auto") {
		facts.mainAgentConversationContextCompactionTriggerReportedByHarness = "automatic_context_window_compaction";
	}
	const reportedTokenCount = payload.estimatedTokenCount ?? payload.estimated_token_count;
	if (typeof reportedTokenCount === "number" && Number.isInteger(reportedTokenCount) && reportedTokenCount >= 0) {
		facts.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness = reportedTokenCount;
	}
	return facts;
}
