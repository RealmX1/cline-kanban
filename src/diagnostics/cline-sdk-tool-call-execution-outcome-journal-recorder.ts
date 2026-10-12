// 进程内 Cline SDK 会话的工具调用执行结果 → journal（与 hook 路径同一条通道 agent-tool-call-execution-outcome）。
//
// Cline SDK 与 Kanban 同进程、没有 hook，命令子进程的 pid 也封在 SDK 内部，所以它的「命令开销」只能从
// 事件流看到：结束事件（content_end）自带 durationMs。一次 run_commands 会用 Promise.all 并行跑 N 条命令，
// 这里记下条数，报告据此区分「一条慢命令」与「一批并行命令」。
//
// 适配层（cline-event-adapter.ts）同时接两种终态形状：旧 AgentEvent 的 content_end(tool)（进程内路径由
// SDK 的翻译层从运行时 tool-finished 换算出 durationMs；hub 路径不带 durationMs）与新运行时事件
// tool-finished（从不带耗时）。同一次调用两种都到时，按 taskId + toolCallId 只记一条，且不依赖到达顺序：
//   - 带耗时的终态到达即记（同 key 若已有无耗时终态在挂起，就取消它并补回它独有的字段）；
//   - 无耗时的终态先挂起一个短窗口，窗口内带耗时的到了就让位，到期仍没等到才按无耗时兜底记录。
// 已记过的 key 之后再到的终态一律丢弃。

import { summarizeProcessCommandLineForDiagnosticJournal } from "./process-command-line-text-truncation-and-secret-redaction";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";

interface ClineSdkToolCallExecutionOutcomeJournalRecordInput {
	sessionTaskId: string;
	sessionWorkspacePath: string | null;
	agentId: string | null;
	toolName: string | null;
	toolCallId: string | null;
	toolInput: unknown;
	toolError: string | null;
	toolExecutionDurationMs: number | null;
	appendJournalEvent?: (channel: DiagnosticEventJournalChannel, payload: DiagnosticEventJournalPayload) => void;
}

const RECENTLY_RECORDED_CLINE_SDK_TOOL_CALL_KEY_CAPACITY = 2_000;
const recentlyRecordedClineSdkToolCallKeys = new Set<string>();

// EXPERIMENT_NODE: 无耗时终态的挂起窗口时长——两套终态出自同一次 SDK 派发时间隔远小于 1s；
// 窗口越长兜底记录越晚，越短越可能在慢派发下丢耗时。
const DURATIONLESS_CLINE_SDK_TOOL_CALL_OUTCOME_PENDING_WINDOW_MS = 1_000;
const pendingDurationlessClineSdkToolCallOutcomeByKey = new Map<
	string,
	{
		durationlessOutcomeInput: ClineSdkToolCallExecutionOutcomeJournalRecordInput;
		fallbackRecordTimer: ReturnType<typeof setTimeout>;
	}
>();

function rememberRecordedClineSdkToolCallKey(key: string): boolean {
	if (recentlyRecordedClineSdkToolCallKeys.has(key)) {
		return false;
	}
	recentlyRecordedClineSdkToolCallKeys.add(key);
	if (recentlyRecordedClineSdkToolCallKeys.size > RECENTLY_RECORDED_CLINE_SDK_TOOL_CALL_KEY_CAPACITY) {
		const oldestKey = recentlyRecordedClineSdkToolCallKeys.values().next().value;
		if (oldestKey !== undefined) {
			recentlyRecordedClineSdkToolCallKeys.delete(oldestKey);
		}
	}
	return true;
}

function readRunCommandsCommandTexts(toolInput: unknown): string[] | null {
	if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
		return null;
	}
	const commands = (toolInput as Record<string, unknown>).commands;
	if (!Array.isArray(commands)) {
		return null;
	}
	return commands.filter((command): command is string => typeof command === "string");
}

function appendClineSdkToolCallExecutionOutcomeJournalRecord(
	input: ClineSdkToolCallExecutionOutcomeJournalRecordInput,
): void {
	const commandTexts = readRunCommandsCommandTexts(input.toolInput);
	const commandLineSummary =
		commandTexts && commandTexts.length > 0
			? summarizeProcessCommandLineForDiagnosticJournal(commandTexts.join(" ; "))
			: null;
	(input.appendJournalEvent ?? appendDiagnosticEventToRotatingJsonlJournal)("agent-tool-call-execution-outcome", {
		// Cline SDK 服务按 workspace 持有，但事件适配层拿不到 workspaceId；报告按工作目录 / 卡片 id 归并。
		workspaceId: null,
		sessionWorkspacePath: input.sessionWorkspacePath,
		attributedTaskCardId: input.sessionTaskId,
		sessionTaskId: input.sessionTaskId,
		sessionCategory: "task_card_main_agent_session",
		agentId: input.agentId,
		agentToolCallExecutionOutcomeSource: "cline_sdk_session_event",
		toolCallLifecyclePhase: input.toolError ? "tool_call_failed" : "tool_call_succeeded",
		toolName: input.toolName,
		toolUseId: input.toolCallId,
		toolExecutionDurationMs: input.toolExecutionDurationMs,
		toolCallWasInterrupted: null,
		commandLineTextForJournal: commandLineSummary?.commandLineTextForJournal ?? null,
		originalCommandLineCharacterCount: commandLineSummary?.originalCommandLineCharacterCount ?? null,
		commandLineTextWasTruncated: commandLineSummary?.commandLineTextWasTruncated ?? null,
		clineSdkRunCommandsParallelCommandCount: commandTexts?.length ?? null,
		mcpServerName: null,
		mcpToolName: null,
	});
}

export function recordClineSdkToolCallExecutionOutcomeToJournal(
	input: ClineSdkToolCallExecutionOutcomeJournalRecordInput,
): void {
	if (!input.toolName) {
		return;
	}
	if (input.toolCallId === null) {
		appendClineSdkToolCallExecutionOutcomeJournalRecord(input);
		return;
	}
	const toolCallKey = `${input.sessionTaskId}\u0000${input.toolCallId}`;
	if (recentlyRecordedClineSdkToolCallKeys.has(toolCallKey)) {
		return;
	}
	const pendingDurationlessOutcome = pendingDurationlessClineSdkToolCallOutcomeByKey.get(toolCallKey);
	if (input.toolExecutionDurationMs === null) {
		// 同一次调用已有一条无耗时终态在挂起：两条信息等价，不重复挂起。
		if (pendingDurationlessOutcome) {
			return;
		}
		const fallbackRecordTimer = setTimeout(() => {
			pendingDurationlessClineSdkToolCallOutcomeByKey.delete(toolCallKey);
			if (rememberRecordedClineSdkToolCallKey(toolCallKey)) {
				appendClineSdkToolCallExecutionOutcomeJournalRecord(input);
			}
		}, DURATIONLESS_CLINE_SDK_TOOL_CALL_OUTCOME_PENDING_WINDOW_MS);
		// 诊断记录不能拖住进程退出。
		fallbackRecordTimer.unref?.();
		pendingDurationlessClineSdkToolCallOutcomeByKey.set(toolCallKey, {
			durationlessOutcomeInput: input,
			fallbackRecordTimer,
		});
		return;
	}
	if (pendingDurationlessOutcome) {
		clearTimeout(pendingDurationlessOutcome.fallbackRecordTimer);
		pendingDurationlessClineSdkToolCallOutcomeByKey.delete(toolCallKey);
	}
	rememberRecordedClineSdkToolCallKey(toolCallKey);
	// 先完成工具消息的那个事件会让适配层删掉 toolInputByToolCallId 里的输入，后到的带耗时终态因此读不到
	// 命令文本；缺的字段从先到的无耗时那条补回，保证最终这一条信息最全。
	appendClineSdkToolCallExecutionOutcomeJournalRecord({
		...input,
		toolInput: input.toolInput ?? pendingDurationlessOutcome?.durationlessOutcomeInput.toolInput,
		toolError: input.toolError ?? pendingDurationlessOutcome?.durationlessOutcomeInput.toolError ?? null,
	});
}
