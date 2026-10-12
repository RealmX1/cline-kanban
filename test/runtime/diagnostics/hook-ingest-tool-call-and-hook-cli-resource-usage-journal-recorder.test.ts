import { describe, expect, it } from "vitest";

import type { RuntimeHookIngestRequest, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { recordHookIngestToolCallAndHookCliResourceUsageToJournal } from "../../../src/diagnostics/hook-ingest-tool-call-and-hook-cli-resource-usage-journal-recorder";
import type { DiagnosticEventJournalChannel } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";

const TOOL_CALL_BODY: RuntimeHookIngestRequest = {
	taskId: "btw-77",
	workspaceId: "repo",
	event: "to_in_progress",
	metadata: { source: "claude", hookEventName: "PostToolUse", toolName: "Bash" },
	agentToolCallExecutionOutcome: {
		toolCallLifecyclePhase: "tool_call_succeeded",
		toolName: "Bash",
		toolUseId: "toolu_01",
		toolExecutionDurationMs: 1_234,
		toolCallWasInterrupted: null,
		commandLineTextForJournal: "npm test",
		originalCommandLineCharacterCount: 8,
		commandLineTextWasTruncated: false,
		mcpServerName: null,
		mcpToolName: null,
	},
	hookCliProcessResourceUsage: {
		lifetimeMaximumResidentSetSizeKibibytes: 290_000,
		cumulativeUserCpuTimeSeconds: 0.4,
		cumulativeSystemCpuTimeSeconds: 0.1,
		hookCliProcessUptimeMs: 620,
		hookIngestDeliveryAttempt: 1,
	},
};

const SIDE_CONVERSATION_SUMMARY = {
	taskId: "btw-77",
	agentId: "claude",
	runtimeSessionIncarnationId: "inc-9",
	taskConversationSessionMetadata: {
		workspaceTaskId: "ab12c",
		taskConversationSessionRole: "by_the_way",
		taskConversationSessionContextSource: "started_from_scratch",
		parentTaskConversationSessionId: null,
		mainSessionOriginTurnNumber: null,
		mainSessionOriginUserMessagePreview: null,
		latestUserMessagePreview: null,
	},
} as unknown as RuntimeTaskSessionSummary;

function record(body: RuntimeHookIngestRequest, summary: RuntimeTaskSessionSummary | null) {
	const events: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
	recordHookIngestToolCallAndHookCliResourceUsageToJournal({
		body,
		summary,
		appendJournalEvent: (channel, payload) => {
			events.push({ channel, payload });
		},
	});
	return events;
}

describe("recordHookIngestToolCallAndHookCliResourceUsageToJournal", () => {
	it("writes the tool call and the hook CLI overhead, both attributed to the card behind the session", () => {
		const events = record(TOOL_CALL_BODY, SIDE_CONVERSATION_SUMMARY);

		expect(events.map((event) => event.channel)).toEqual([
			"agent-tool-call-execution-outcome",
			"kanban-hook-cli-invocation-resource-usage",
		]);
		expect(events[0]?.payload).toMatchObject({
			workspaceId: "repo",
			attributedTaskCardId: "ab12c",
			sessionTaskId: "btw-77",
			sessionCategory: "task_card_side_conversation_agent_session",
			agentId: "claude",
			toolUseId: "toolu_01",
			toolExecutionDurationMs: 1_234,
			commandLineTextForJournal: "npm test",
		});
		expect(events[1]?.payload).toMatchObject({
			attributedTaskCardId: "ab12c",
			hookEvent: "to_in_progress",
			toolName: "Bash",
			lifetimeMaximumResidentSetSizeKibibytes: 290_000,
			hookCliProcessUptimeMs: 620,
		});
	});

	it("still records a hook for a session the runtime no longer knows, falling back to the session id", () => {
		const events = record({ ...TOOL_CALL_BODY, taskId: "zz999" }, null);

		expect(events[0]?.payload).toMatchObject({ attributedTaskCardId: "zz999", agentId: null });
	});

	it("writes nothing for a hook that carries no resource usage fields", () => {
		expect(record({ taskId: "ab12c", workspaceId: "repo", event: "activity" }, null)).toEqual([]);
	});
});
