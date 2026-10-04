import { describe, expect, it, vi } from "vitest";

import type { AgentConversationModelTokenUsageIncrementalReader } from "../../../src/agent-session-history/agent-conversation-model-token-usage-incremental-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { DiagnosticEventJournalChannel } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTaskAgentConversationModelTokenUsageJournalMonitor } from "../../../src/diagnostics/task-agent-conversation-model-token-usage-journal-monitor";

const NOW = 1_790_000_000_000;

function summary(taskId: string, sourceAgentId: string, transcriptPath: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: sourceAgentId === "codex" ? "codex" : "claude",
		workspacePath: null,
		pid: 1,
		startedAt: NOW,
		updatedAt: NOW,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId,
			nativeSessionId: `native-${taskId}`,
			transcriptPath,
			observedAt: NOW,
		},
	};
}

function createFakeReader(signatures: Map<string, string>): AgentConversationModelTokenUsageIncrementalReader {
	return {
		readTranscriptFileSignature: vi.fn(async (path: string) => signatures.get(path) ?? null),
		readClaudeCodeCumulativeTokenUsage: vi.fn(async () => ({
			totals: {
				cumulativeInputTokens: 10,
				cumulativeCacheCreationInputTokens: 20,
				cumulativeCacheReadInputTokens: 30,
				cumulativeOutputTokens: 40,
				cumulativeReasoningOutputTokens: null,
				modelIds: ["claude-opus-5-5"],
				assistantMessageCount: 2,
				codexRateLimitPrimaryUsedPercent: null,
				contextWindowSizeTokens: null,
				transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0,
			},
			subagentTranscriptCount: 1,
		})),
		readCodexCumulativeTokenUsage: vi.fn(async () => null),
	};
}

describe("createTaskAgentConversationModelTokenUsageJournalMonitor", () => {
	it("records a cumulative snapshot attributed to the card, and skips the transcript while it is unchanged", async () => {
		const signatures = new Map([["/t/a.jsonl", `100:${NOW - 60_000}`]]);
		const reader = createFakeReader(signatures);
		const journalEvents: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
		const monitor = createTaskAgentConversationModelTokenUsageJournalMonitor({
			listSessionSummariesWithWorkspace: () => [
				{ workspaceId: "repo", summary: summary("ab12c", "claude", "/t/a.jsonl") },
			],
			reader,
			now: () => NOW,
			appendJournalEvent: (channel, payload) => {
				journalEvents.push({ channel, payload });
			},
		});

		await monitor.runTick();
		await monitor.runTick();
		signatures.set("/t/a.jsonl", `200:${NOW}`);
		await monitor.runTick();

		expect(journalEvents).toHaveLength(2);
		expect(journalEvents[0]).toMatchObject({
			channel: "task-agent-conversation-model-token-usage-cumulative-snapshot",
			payload: {
				workspaceId: "repo",
				attributedTaskCardId: "ab12c",
				modelTokenUsageSource: "claude_code_transcript",
				nativeSessionId: "native-ab12c",
				cumulativeOutputTokens: 40,
				subagentTranscriptCount: 1,
				harnessReportedCumulativeCostUsd: null,
				transcriptLinesSkippedForExceedingIncrementalReadBudgetCount: 0,
			},
		});
	});

	it("leaves transcripts untouched for more than a day alone on first sight", async () => {
		const reader = createFakeReader(new Map([["/t/old.jsonl", `100:${NOW - 3 * 86_400_000}`]]));
		const monitor = createTaskAgentConversationModelTokenUsageJournalMonitor({
			listSessionSummariesWithWorkspace: () => [
				{ workspaceId: "repo", summary: summary("old01", "claude", "/t/old.jsonl") },
			],
			reader,
			now: () => NOW,
			appendJournalEvent: vi.fn(),
		});

		await monitor.runTick();

		expect(reader.readClaudeCodeCumulativeTokenUsage).not.toHaveBeenCalled();
	});
});
