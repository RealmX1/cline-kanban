import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	accumulateClaudeTranscriptRecordsIntoTokenUsage,
	accumulateCodexRolloutRecordsIntoTokenUsage,
	createAgentConversationModelTokenUsageIncrementalReader,
	createClaudeTranscriptTokenUsageAccumulatorState,
	createCodexRolloutTokenUsageAccumulatorState,
	summarizeClaudeTranscriptTokenUsage,
	summarizeCodexRolloutTokenUsage,
} from "../../../src/agent-session-history/agent-conversation-model-token-usage-incremental-reader";
import { createTempDir } from "../../utilities/temp-dir";

function claudeAssistantRecord(messageId: string, outputTokens: number, model = "claude-opus-5-5") {
	return {
		type: "assistant",
		message: {
			id: messageId,
			model,
			usage: {
				input_tokens: 2,
				cache_creation_input_tokens: 1_000,
				cache_read_input_tokens: 20_000,
				output_tokens: outputTokens,
			},
		},
	};
}

describe("Claude transcript token usage", () => {
	it("counts a message whose content blocks were written as several lines only once", () => {
		const state = createClaudeTranscriptTokenUsageAccumulatorState();

		accumulateClaudeTranscriptRecordsIntoTokenUsage(state, [
			claudeAssistantRecord("msg_1", 400),
			// 同一 message 的第二个内容块：同一份 usage，再写一行。
			claudeAssistantRecord("msg_1", 400),
			claudeAssistantRecord("msg_2", 100, "claude-sonnet-5-5"),
			{ type: "user", message: { content: "hi" } },
		]);

		expect(summarizeClaudeTranscriptTokenUsage([state])).toMatchObject({
			cumulativeInputTokens: 4,
			cumulativeCacheCreationInputTokens: 2_000,
			cumulativeCacheReadInputTokens: 40_000,
			cumulativeOutputTokens: 500,
			assistantMessageCount: 2,
			modelIds: ["claude-opus-5-5", "claude-sonnet-5-5"],
		});
	});
});

describe("Codex rollout token usage", () => {
	it("takes the last cumulative token_count and splits cached input out of input tokens", () => {
		const state = createCodexRolloutTokenUsageAccumulatorState();
		const tokenCount = (
			inputTokens: number,
			cachedInputTokens: number,
			outputTokens: number,
			usedPercent: number,
		) => ({
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: {
						input_tokens: inputTokens,
						cached_input_tokens: cachedInputTokens,
						cache_write_input_tokens: 0,
						output_tokens: outputTokens,
						reasoning_output_tokens: 7,
					},
					model_context_window: 258_400,
				},
				rate_limits: { primary: { used_percent: usedPercent } },
			},
		});

		accumulateCodexRolloutRecordsIntoTokenUsage(state, [
			{ type: "turn_context", payload: { model: "gpt-6-astra" } },
			tokenCount(10_000, 4_000, 100, 30),
			tokenCount(27_624, 13_056, 144, 31),
		]);

		expect(summarizeCodexRolloutTokenUsage(state)).toEqual({
			cumulativeInputTokens: 14_568,
			cumulativeCacheCreationInputTokens: 0,
			cumulativeCacheReadInputTokens: 13_056,
			cumulativeOutputTokens: 144,
			cumulativeReasoningOutputTokens: 7,
			modelIds: ["gpt-6-astra"],
			assistantMessageCount: 0,
			codexRateLimitPrimaryUsedPercent: 31,
			contextWindowSizeTokens: 258_400,
			transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0,
		});
	});

	it("reports nothing before the first token_count", () => {
		expect(summarizeCodexRolloutTokenUsage(createCodexRolloutTokenUsageAccumulatorState())).toBeNull();
	});
});

describe("createAgentConversationModelTokenUsageIncrementalReader", () => {
	let tempDir: { path: string; cleanup: () => void };

	beforeEach(() => {
		tempDir = createTempDir("kanban-token-usage-reader-");
	});

	afterEach(() => {
		tempDir.cleanup();
	});

	it("keeps accumulating across appends and includes subagent transcripts", async () => {
		const transcriptPath = join(tempDir.path, "session-1.jsonl");
		writeFileSync(transcriptPath, `${JSON.stringify(claudeAssistantRecord("msg_1", 100))}\n`);
		const subagentDirectoryPath = join(tempDir.path, "session-1", "subagents");
		mkdirSync(subagentDirectoryPath, { recursive: true });
		writeFileSync(
			join(subagentDirectoryPath, "agent-a1.jsonl"),
			`${JSON.stringify(claudeAssistantRecord("msg_sub", 50))}\n`,
		);
		const reader = createAgentConversationModelTokenUsageIncrementalReader();

		const first = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);
		appendFileSync(transcriptPath, `${JSON.stringify(claudeAssistantRecord("msg_2", 30))}\n`);
		const second = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);

		expect(first.totals.cumulativeOutputTokens).toBe(150);
		expect(first.subagentTranscriptCount).toBe(1);
		expect(second.totals.cumulativeOutputTokens).toBe(180);
		expect(second.totals.assistantMessageCount).toBe(3);
	});

	it("starts over when a transcript is rewritten shorter instead of double counting", async () => {
		const transcriptPath = join(tempDir.path, "session-2.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify(claudeAssistantRecord("msg_1", 100))}\n${JSON.stringify(claudeAssistantRecord("msg_2", 100))}\n`,
		);
		const reader = createAgentConversationModelTokenUsageIncrementalReader();
		await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);

		writeFileSync(transcriptPath, `${JSON.stringify(claudeAssistantRecord("msg_9", 7))}\n`);
		const afterRewrite = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);

		expect(afterRewrite.totals.cumulativeOutputTokens).toBe(7);
	});

	// 单行长过单次读取预算：修复前 offset 原地不动而「预算外还有字节」恒为真，读取永不返回。
	const SMALL_INCREMENTAL_READ_BUDGET_BYTES = 4_096;
	// 比预算长得多，也跨过多个换行扫描块（1 MiB），覆盖「跨块找换行」。
	const oversizedToolResultLine = JSON.stringify({
		type: "user",
		message: { content: [{ type: "tool_result", content: "x".repeat(2_500_000) }] },
	});

	it("skips a complete line longer than the read budget, keeps reading past it, and records the skip", async () => {
		const transcriptPath = join(tempDir.path, "session-oversized.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify(claudeAssistantRecord("msg_1", 100))}\n${oversizedToolResultLine}\n${JSON.stringify(claudeAssistantRecord("msg_2", 30))}\n`,
		);
		const reader = createAgentConversationModelTokenUsageIncrementalReader({
			maxIncrementalReadBytes: SMALL_INCREMENTAL_READ_BUDGET_BYTES,
		});

		const { totals } = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);

		expect(totals.cumulativeOutputTokens).toBe(130);
		expect(totals.assistantMessageCount).toBe(2);
		expect(totals.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount).toBe(1);
	});

	it("stops at an oversized line that is still being written and skips it once it is complete", async () => {
		const transcriptPath = join(tempDir.path, "session-oversized-in-progress.jsonl");
		const oversizedLineWrittenSoFar = oversizedToolResultLine.slice(0, 1_000_000);
		writeFileSync(
			transcriptPath,
			`${JSON.stringify(claudeAssistantRecord("msg_1", 100))}\n${oversizedLineWrittenSoFar}`,
		);
		const reader = createAgentConversationModelTokenUsageIncrementalReader({
			maxIncrementalReadBytes: SMALL_INCREMENTAL_READ_BUDGET_BYTES,
		});

		const whileOversizedLineIsIncomplete = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);
		appendFileSync(
			transcriptPath,
			`${oversizedToolResultLine.slice(oversizedLineWrittenSoFar.length)}\n${JSON.stringify(claudeAssistantRecord("msg_2", 30))}\n`,
		);
		const afterOversizedLineCompleted = await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);

		expect(whileOversizedLineIsIncomplete.totals.cumulativeOutputTokens).toBe(100);
		expect(whileOversizedLineIsIncomplete.totals.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount).toBe(
			0,
		);
		expect(afterOversizedLineCompleted.totals.cumulativeOutputTokens).toBe(130);
		expect(afterOversizedLineCompleted.totals.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount).toBe(1);
	});

	it("skips an oversized Codex rollout line and still takes the token_count written after it", async () => {
		const rolloutPath = join(tempDir.path, "rollout-oversized.jsonl");
		const tokenCount = (outputTokens: number) =>
			JSON.stringify({
				type: "event_msg",
				payload: {
					type: "token_count",
					info: { total_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
				},
			});
		const oversizedFunctionCallOutputLine = JSON.stringify({
			type: "response_item",
			payload: { type: "function_call_output", output: "y".repeat(50_000) },
		});
		writeFileSync(rolloutPath, `${tokenCount(5)}\n${oversizedFunctionCallOutputLine}\n${tokenCount(9)}\n`);
		const reader = createAgentConversationModelTokenUsageIncrementalReader({
			maxIncrementalReadBytes: SMALL_INCREMENTAL_READ_BUDGET_BYTES,
		});

		const totals = await reader.readCodexCumulativeTokenUsage(rolloutPath);

		expect(totals?.cumulativeOutputTokens).toBe(9);
		expect(totals?.transcriptLinesSkippedForExceedingIncrementalReadBudgetCount).toBe(1);
	});
});
