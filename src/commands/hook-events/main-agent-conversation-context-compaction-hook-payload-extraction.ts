import type { RuntimeHookEvent, RuntimeMainAgentConversationContextCompactionTrigger } from "../../core/api-contract";
import { readStringField } from "./hook-utils";

export interface MainAgentConversationContextCompactionFactsFromHookPayload {
	mainAgentConversationContextCompactionTriggerReportedByHarness?: RuntimeMainAgentConversationContextCompactionTrigger;
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness?: number;
}

// Claude / Codex / Kimi 的 PostCompact 载荷都用 `trigger: "manual" | "auto"`。只对压缩完成事件抽取；
// 未知值不猜，交给服务端按回合归属判定。压缩后上下文大小只有 Kimi 报（estimatedTokenCount = tokensAfter，
// 字段名取自 kimi-code 2.1.1 二进制，载荷里的实际拼写未经真机核对，故两种拼写都认）。
export function extractMainAgentConversationContextCompactionFactsFromHookPayload(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
): MainAgentConversationContextCompactionFactsFromHookPayload {
	if (event !== "main_agent_conversation_context_compaction_completed" || !payload) {
		return {};
	}
	const facts: MainAgentConversationContextCompactionFactsFromHookPayload = {};
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
