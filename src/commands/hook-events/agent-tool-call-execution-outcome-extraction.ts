// 从 hook stdin 提取一次工具调用的执行结果（资源占用采集，S2），在 hooks CLI 进程内完成截断 + 脱敏。
//
// 为什么在这里而不是复用 normalizeHookMetadata：metadata 会经 applyHookActivity 进 session summary，
// 而 summary 只保留「最新一条活动」、还会落 sessions.json 与广播；逐调用的执行记录只属于 journal。
// normalizeHookMetadata 也只把 tool_input 拼进 activityText，丢掉了 tool_use_id / duration_ms / is_interrupt。
//
// 各 harness 的事件名：Claude / Codex / Kimi / Droid 用 PreToolUse / PostToolUse（Claude、Kimi、Droid 另有
// PostToolUseFailure）；Gemini 用 BeforeTool / AfterTool。duration_ms 只有 Claude 的 Post 事件保证提供。

import type { RuntimeAgentToolCallExecutionOutcome } from "../../core/api-contract";
import { summarizeProcessCommandLineForDiagnosticJournal } from "../../diagnostics/process-command-line-text-truncation-and-secret-redaction";

const TOOL_CALL_LIFECYCLE_PHASE_BY_NORMALIZED_HOOK_EVENT_NAME: Readonly<
	Record<string, RuntimeAgentToolCallExecutionOutcome["toolCallLifecyclePhase"]>
> = {
	pretooluse: "tool_call_started",
	beforetool: "tool_call_started",
	posttooluse: "tool_call_succeeded",
	aftertool: "tool_call_succeeded",
	posttoolusefailure: "tool_call_failed",
};

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

function readRecordField(record: Record<string, unknown>, ...fieldNames: string[]): unknown {
	for (const fieldName of fieldNames) {
		if (record[fieldName] !== undefined) {
			return record[fieldName];
		}
	}
	return undefined;
}

function readNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Bash 类工具的命令：Claude 是 `tool_input.command` 字符串；Codex 可能给 argv 数组；少数用 `cmd`。
function readToolInputCommandText(payload: Record<string, unknown>): string | null {
	const toolInput = readRecordField(payload, "tool_input", "toolInput");
	if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
		return null;
	}
	const command = readRecordField(toolInput as Record<string, unknown>, "command", "cmd");
	if (typeof command === "string") {
		return command;
	}
	if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
		return command.join(" ");
	}
	return null;
}

export function extractAgentToolCallExecutionOutcomeFromHookPayload(input: {
	payload: Record<string, unknown> | null;
	hookEventName: string | null | undefined;
	toolName: string | null | undefined;
}): RuntimeAgentToolCallExecutionOutcome | undefined {
	const normalizedHookEventName = input.hookEventName?.trim().toLowerCase().replaceAll("_", "") ?? "";
	const toolCallLifecyclePhase = TOOL_CALL_LIFECYCLE_PHASE_BY_NORMALIZED_HOOK_EVENT_NAME[normalizedHookEventName];
	const toolName = input.toolName?.trim();
	if (!toolCallLifecyclePhase || !toolName || !input.payload) {
		return undefined;
	}
	const { payload } = input;
	const toolUseId = readRecordField(payload, "tool_use_id", "toolUseId");
	const isInterrupt = readRecordField(payload, "is_interrupt", "isInterrupt");
	const commandText = readToolInputCommandText(payload);
	const commandLineSummary =
		commandText === null ? null : summarizeProcessCommandLineForDiagnosticJournal(commandText);
	const mcpToolNameMatch = MCP_TOOL_NAME_PATTERN.exec(toolName);
	return {
		toolCallLifecyclePhase,
		toolName,
		toolUseId: typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : null,
		toolExecutionDurationMs: readNonNegativeNumber(readRecordField(payload, "duration_ms", "durationMs")),
		toolCallWasInterrupted: typeof isInterrupt === "boolean" ? isInterrupt : null,
		commandLineTextForJournal: commandLineSummary?.commandLineTextForJournal ?? null,
		originalCommandLineCharacterCount: commandLineSummary?.originalCommandLineCharacterCount ?? null,
		commandLineTextWasTruncated: commandLineSummary?.commandLineTextWasTruncated ?? null,
		mcpServerName: mcpToolNameMatch?.[1] ?? null,
		mcpToolName: mcpToolNameMatch?.[2] ?? null,
	};
}
