import { describe, expect, it } from "vitest";
import { extractMainAgentConversationContextCompactionFactsFromHookPayload } from "../../../../src/commands/hook-events/main-agent-conversation-context-compaction-hook-payload-extraction";

// PostCompact 载荷（Claude / Codex / Kimi 都用 `trigger: manual|auto`；只有 Kimi 报压缩后上下文大小）。

describe("extractMainAgentConversationContextCompactionFactsFromHookPayload", () => {
	const extract = extractMainAgentConversationContextCompactionFactsFromHookPayload;
	const COMPACTION = "main_agent_conversation_context_compaction_completed" as const;

	it("manual / auto 映射成过度指定的触发方式", () => {
		expect(extract(COMPACTION, { hook_event_name: "PostCompact", trigger: "manual" })).toEqual({
			mainAgentConversationContextCompactionTriggerReportedByHarness: "manual_compact_command",
		});
		expect(extract(COMPACTION, { hook_event_name: "PostCompact", trigger: "AUTO " })).toEqual({
			mainAgentConversationContextCompactionTriggerReportedByHarness: "automatic_context_window_compaction",
		});
	});

	it("缺失或未知的 trigger 不猜（交给服务端按回合归属判）", () => {
		expect(extract(COMPACTION, { hook_event_name: "PostCompact" })).toEqual({});
		expect(extract(COMPACTION, { hook_event_name: "PostCompact", trigger: "scheduled" })).toEqual({});
	});

	it("Kimi 的 estimatedTokenCount 带上；非整数 / 负数不带", () => {
		expect(extract(COMPACTION, { trigger: "manual", estimatedTokenCount: 42_000 })).toEqual({
			mainAgentConversationContextCompactionTriggerReportedByHarness: "manual_compact_command",
			mainAgentConversationContextTokenCountAfterCompactionReportedByHarness: 42_000,
		});
		expect(
			extract(COMPACTION, { trigger: "manual", estimated_token_count: 7 })
				.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness,
		).toBe(7);
		expect(extract(COMPACTION, { trigger: "manual", estimatedTokenCount: -1 })).toEqual({
			mainAgentConversationContextCompactionTriggerReportedByHarness: "manual_compact_command",
		});
		expect(extract(COMPACTION, { trigger: "manual", estimatedTokenCount: "42000" })).toEqual({
			mainAgentConversationContextCompactionTriggerReportedByHarness: "manual_compact_command",
		});
	});

	it("其它事件一律不抽", () => {
		expect(extract("activity", { trigger: "manual", estimatedTokenCount: 1 })).toEqual({});
		expect(extract(COMPACTION, null)).toEqual({});
	});
});
