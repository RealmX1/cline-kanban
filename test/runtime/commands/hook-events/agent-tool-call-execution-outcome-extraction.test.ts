import { describe, expect, it } from "vitest";

import { extractAgentToolCallExecutionOutcomeFromHookPayload } from "../../../../src/commands/hook-events/agent-tool-call-execution-outcome-extraction";

describe("extractAgentToolCallExecutionOutcomeFromHookPayload", () => {
	it("turns a Claude PostToolUse Bash payload into a redacted, timed execution record", () => {
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				hookEventName: "PostToolUse",
				toolName: "Bash",
				payload: {
					hook_event_name: "PostToolUse",
					tool_name: "Bash",
					tool_use_id: "toolu_01ABC",
					duration_ms: 48_213,
					tool_input: { command: "GITHUB_TOKEN=abc npm run test:guarded -- --project precommit-safe" },
					tool_response: { stdout: "must never be journaled" },
				},
			}),
		).toEqual({
			toolCallLifecyclePhase: "tool_call_succeeded",
			toolName: "Bash",
			toolUseId: "toolu_01ABC",
			toolExecutionDurationMs: 48_213,
			toolCallWasInterrupted: null,
			commandLineTextForJournal: "GITHUB_TOKEN=[REDACTED] npm run test:guarded -- --project precommit-safe",
			originalCommandLineCharacterCount: "GITHUB_TOKEN=abc npm run test:guarded -- --project precommit-safe".length,
			commandLineTextWasTruncated: false,
			mcpServerName: null,
			mcpToolName: null,
		});
	});

	it("records an interrupted failure with its duration", () => {
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				hookEventName: "PostToolUseFailure",
				toolName: "Bash",
				payload: { tool_use_id: "toolu_02", is_interrupt: true, duration_ms: 120_000, error: "Interrupted" },
			}),
		).toMatchObject({
			toolCallLifecyclePhase: "tool_call_failed",
			toolCallWasInterrupted: true,
			toolExecutionDurationMs: 120_000,
		});
	});

	it("splits an MCP tool name into server and tool", () => {
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				hookEventName: "PreToolUse",
				toolName: "mcp__codegraph__codegraph_explore",
				payload: { tool_use_id: "toolu_03", tool_input: { query: "x" } },
			}),
		).toMatchObject({
			toolCallLifecyclePhase: "tool_call_started",
			mcpServerName: "codegraph",
			mcpToolName: "codegraph_explore",
			commandLineTextForJournal: null,
		});
	});

	it("joins a Codex-style argv command and maps Gemini's AfterTool", () => {
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				hookEventName: "AfterTool",
				toolName: "shell",
				payload: { tool_input: { command: ["bash", "-lc", "cargo build"] } },
			}),
		).toMatchObject({
			toolCallLifecyclePhase: "tool_call_succeeded",
			commandLineTextForJournal: "bash -lc cargo build",
		});
	});

	it("ignores hook events that are not tool calls", () => {
		expect(
			extractAgentToolCallExecutionOutcomeFromHookPayload({
				hookEventName: "Stop",
				toolName: null,
				payload: { hook_event_name: "Stop" },
			}),
		).toBeUndefined();
	});
});
