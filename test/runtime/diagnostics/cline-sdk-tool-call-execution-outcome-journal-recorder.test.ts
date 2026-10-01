import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordClineSdkToolCallExecutionOutcomeToJournal } from "../../../src/diagnostics/cline-sdk-tool-call-execution-outcome-journal-recorder";
import type { DiagnosticEventJournalChannel } from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";

function collectingAppender() {
	const events: Array<{ channel: DiagnosticEventJournalChannel; payload: Record<string, unknown> }> = [];
	return {
		events,
		appendJournalEvent: (channel: DiagnosticEventJournalChannel, payload: Record<string, unknown>) => {
			events.push({ channel, payload });
		},
	};
}

describe("recordClineSdkToolCallExecutionOutcomeToJournal", () => {
	it("records a parallel run_commands batch with its duration and command count", () => {
		const { events, appendJournalEvent } = collectingAppender();

		recordClineSdkToolCallExecutionOutcomeToJournal({
			sessionTaskId: "cc111",
			sessionWorkspacePath: "/Users/u/.cline/worktrees/cc111/repo",
			agentId: "cline",
			toolName: "run_commands",
			toolCallId: "call-1",
			toolInput: { commands: ["npm test", "npm run lint"] },
			toolError: null,
			toolExecutionDurationMs: 30_000,
			appendJournalEvent,
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			attributedTaskCardId: "cc111",
			agentToolCallExecutionOutcomeSource: "cline_sdk_session_event",
			toolCallLifecyclePhase: "tool_call_succeeded",
			toolExecutionDurationMs: 30_000,
			commandLineTextForJournal: "npm test ; npm run lint",
			clineSdkRunCommandsParallelCommandCount: 2,
		});
	});

	it("records the same tool call only once even though the SDK reports it through two event types", () => {
		const { events, appendJournalEvent } = collectingAppender();
		const baseInput = {
			sessionTaskId: "cc222",
			sessionWorkspacePath: null,
			agentId: "cline",
			toolName: "read_files",
			toolCallId: "call-dup",
			toolInput: { paths: ["a.ts"] },
			toolError: null,
			appendJournalEvent,
		};

		recordClineSdkToolCallExecutionOutcomeToJournal({ ...baseInput, toolExecutionDurationMs: 12 });
		recordClineSdkToolCallExecutionOutcomeToJournal({ ...baseInput, toolExecutionDurationMs: null });

		expect(events).toHaveLength(1);
		expect(events[0]?.payload.toolExecutionDurationMs).toBe(12);
	});

	describe("无耗时终态先到", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("tool-finished 先到时不抢占记录：后到的带耗时终态只记一条，并补回先到那条才有的工具输入", () => {
			const { events, appendJournalEvent } = collectingAppender();
			const baseInput = {
				sessionTaskId: "cc444",
				sessionWorkspacePath: null,
				agentId: "cline",
				toolName: "run_commands",
				toolCallId: "call-finished-first",
				toolError: null,
				appendJournalEvent,
			};

			// tool-finished：没有耗时；它先完成了消息，适配层随即删掉 toolInputByToolCallId 里的输入。
			recordClineSdkToolCallExecutionOutcomeToJournal({
				...baseInput,
				toolInput: { commands: ["npm test", "npm run lint"] },
				toolExecutionDurationMs: null,
			});
			// content_end：带耗时，但此时已经读不到工具输入。
			recordClineSdkToolCallExecutionOutcomeToJournal({
				...baseInput,
				toolInput: undefined,
				toolExecutionDurationMs: 30_000,
			});
			vi.runOnlyPendingTimers();

			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({
				toolUseId: "call-finished-first",
				toolExecutionDurationMs: 30_000,
				commandLineTextForJournal: "npm test ; npm run lint",
				clineSdkRunCommandsParallelCommandCount: 2,
			});
		});

		it("只等到无耗时终态时，窗口到期后按无耗时兜底记一条（同一调用的两套无耗时事件也只记一条）", () => {
			const { events, appendJournalEvent } = collectingAppender();
			const baseInput = {
				sessionTaskId: "cc555",
				sessionWorkspacePath: null,
				agentId: "cline",
				toolName: "read_files",
				toolCallId: "call-durationless-only",
				toolInput: { paths: ["a.ts"] },
				toolError: null,
				toolExecutionDurationMs: null,
				appendJournalEvent,
			};

			recordClineSdkToolCallExecutionOutcomeToJournal(baseInput);
			recordClineSdkToolCallExecutionOutcomeToJournal(baseInput);
			vi.runOnlyPendingTimers();
			// 兜底记录之后再到的同一调用一律丢弃。
			recordClineSdkToolCallExecutionOutcomeToJournal({ ...baseInput, toolExecutionDurationMs: 9 });
			vi.runOnlyPendingTimers();

			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toMatchObject({
				toolUseId: "call-durationless-only",
				toolExecutionDurationMs: null,
			});
		});
	});

	it("marks a tool that reported an error as failed", () => {
		const { events, appendJournalEvent } = collectingAppender();

		recordClineSdkToolCallExecutionOutcomeToJournal({
			sessionTaskId: "cc333",
			sessionWorkspacePath: null,
			agentId: "cline",
			toolName: "run_commands",
			toolCallId: "call-3",
			toolInput: { commands: ["false"] },
			toolError: "exit code 1",
			toolExecutionDurationMs: 5,
			appendJournalEvent,
		});

		expect(events[0]?.payload.toolCallLifecyclePhase).toBe("tool_call_failed");
	});
});
