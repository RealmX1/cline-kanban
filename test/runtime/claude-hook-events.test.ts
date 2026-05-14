import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createClaudeWatcherState,
	parseClaudeEventLine,
	startClaudeSessionWatcher,
} from "../../src/commands/hook-events/claude-hook-events";

function jsonLine(payload: Record<string, unknown>): string {
	return JSON.stringify(payload);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("parseClaudeEventLine", () => {
	it("maps UserPromptSubmit to to_in_progress", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(jsonLine({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), state);
		expect(mapped).toEqual({
			event: "to_in_progress",
			metadata: {
				source: "claude",
				hookEventName: "UserPromptSubmit",
				activityText: "User prompt submitted",
			},
		});
	});

	it("maps PreToolUse with tool input to activity", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(
			jsonLine({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
			}),
			state,
		);
		expect(mapped).toMatchObject({
			event: "activity",
			metadata: {
				source: "claude",
				hookEventName: "PreToolUse",
				toolName: "Bash",
				toolInputSummary: "ls",
				activityText: "Using Bash: ls",
			},
		});
	});

	it("maps Stop to to_review and surfaces final message", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(
			jsonLine({
				hook_event_name: "Stop",
				last_assistant_message: "All done",
			}),
			state,
		);
		expect(mapped).toMatchObject({
			event: "to_review",
			metadata: {
				source: "claude",
				hookEventName: "Stop",
				finalMessage: "All done",
				activityText: "Final: All done",
			},
		});
	});

	it("classifies Notification with permission_prompt matcher as to_review", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(
			jsonLine({ hook_event_name: "Notification", matcher: "permission_prompt" }),
			state,
		);
		expect(mapped?.event).toBe("to_review");
	});

	it("classifies generic Notification as activity", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(
			jsonLine({ hook_event_name: "Notification", notification_type: "info" }),
			state,
		);
		expect(mapped).toMatchObject({
			event: "activity",
			metadata: {
				notificationType: "info",
				activityText: "Notification: info",
			},
		});
	});

	it("deduplicates consecutive identical events", () => {
		const state = createClaudeWatcherState();
		const line = jsonLine({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(parseClaudeEventLine(line, state)).not.toBeNull();
		expect(parseClaudeEventLine(line, state)).toBeNull();
	});

	it("re-emits when a distinguishing field changes", () => {
		const state = createClaudeWatcherState();
		const first = parseClaudeEventLine(
			jsonLine({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
			state,
		);
		const second = parseClaudeEventLine(
			jsonLine({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" } }),
			state,
		);
		expect(first?.metadata?.toolInputSummary).toBe("ls");
		expect(second?.metadata?.toolInputSummary).toBe("pwd");
	});

	it("returns null for unknown hook event names", () => {
		const state = createClaudeWatcherState();
		expect(parseClaudeEventLine(jsonLine({ hook_event_name: "MysteryHook" }), state)).toBeNull();
	});

	it("returns null for empty or non-JSON lines", () => {
		const state = createClaudeWatcherState();
		expect(parseClaudeEventLine("", state)).toBeNull();
		expect(parseClaudeEventLine("   ", state)).toBeNull();
		expect(parseClaudeEventLine("not json", state)).toBeNull();
		expect(parseClaudeEventLine("[1,2,3]", state)).toBeNull();
	});

	it("accepts camelCase hook keys (hookEventName)", () => {
		const state = createClaudeWatcherState();
		const mapped = parseClaudeEventLine(jsonLine({ hookEventName: "PostToolUse", toolName: "Read" }), state);
		expect(mapped?.event).toBe("to_in_progress");
		expect(mapped?.metadata?.toolName).toBe("Read");
	});
});

describe("startClaudeSessionWatcher", () => {
	const originalFlag = process.env.CLAUDE_HOOK_EVENTS_ENABLED;

	beforeEach(() => {
		delete process.env.CLAUDE_HOOK_EVENTS_ENABLED;
	});

	afterEach(() => {
		if (originalFlag === undefined) {
			delete process.env.CLAUDE_HOOK_EVENTS_ENABLED;
		} else {
			process.env.CLAUDE_HOOK_EVENTS_ENABLED = originalFlag;
		}
		vi.useRealTimers();
	});

	it("returns a noop cleanup without scheduling timers when feature flag is 0", async () => {
		process.env.CLAUDE_HOOK_EVENTS_ENABLED = "0";
		vi.useFakeTimers();
		const events: unknown[] = [];
		const stop = await startClaudeSessionWatcher(
			"/nonexistent/path/should-not-be-read.jsonl",
			(mapped) => events.push(mapped),
			10,
		);
		expect(vi.getTimerCount()).toBe(0);
		await stop();
		expect(events).toEqual([]);
	});

	it("tails a JSONL log and notifies on new lines", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-claude-watcher-"));
		const logPath = join(tempDir, "claude-events.jsonl");
		await writeFile(logPath, "", "utf8");
		const events: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
		const stop = await startClaudeSessionWatcher(
			logPath,
			(mapped) => events.push(mapped as { event: string; metadata?: Record<string, unknown> }),
			10,
		);
		try {
			await appendFile(logPath, `${jsonLine({ hook_event_name: "UserPromptSubmit", prompt: "hi" })}\n`, "utf8");
			await appendFile(
				logPath,
				`${jsonLine({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })}\n`,
				"utf8",
			);
			await appendFile(logPath, `${jsonLine({ hook_event_name: "Stop" })}\n`, "utf8");
			await waitFor(() => events.length >= 3, 2_000);
		} finally {
			await stop();
			await rm(tempDir, { recursive: true, force: true });
		}
		expect(events.map((e) => e.event)).toEqual(["to_in_progress", "activity", "to_review"]);
	});

	it("recovers when the log file is truncated/rotated below the current offset", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-claude-watcher-shrink-"));
		const logPath = join(tempDir, "claude-events.jsonl");
		// Pre-seed a large initial event so the offset advances well past the
		// final post-rotation size — guaranteeing the watcher observes shrink.
		const longPrompt = "x".repeat(500);
		await writeFile(logPath, `${jsonLine({ hook_event_name: "UserPromptSubmit", prompt: longPrompt })}\n`, "utf8");
		const events: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
		const stop = await startClaudeSessionWatcher(
			logPath,
			(mapped) => events.push(mapped as { event: string; metadata?: Record<string, unknown> }),
			10,
		);
		try {
			await waitFor(() => events.length >= 1, 2_000);

			// Simulate log rotation: shrink file to zero, give poll a chance to
			// observe the empty file, then write a small new event whose total
			// size is below the previous offset.
			await writeFile(logPath, "", "utf8");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await appendFile(
				logPath,
				`${jsonLine({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rotated" } })}\n`,
				"utf8",
			);

			await waitFor(() => events.length >= 2, 2_000);
		} finally {
			await stop();
			await rm(tempDir, { recursive: true, force: true });
		}
		expect(events.length).toBeGreaterThanOrEqual(2);
		const lastEvent = events[events.length - 1];
		expect(lastEvent?.event).toBe("activity");
		expect(lastEvent?.metadata?.toolInputSummary).toBe("rotated");
	});

	it("flushes a trailing JSON line without newline on stop", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "kanban-claude-watcher-flush-"));
		const logPath = join(tempDir, "claude-events.jsonl");
		await writeFile(logPath, "", "utf8");
		const events: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
		const stop = await startClaudeSessionWatcher(
			logPath,
			(mapped) => events.push(mapped as { event: string; metadata?: Record<string, unknown> }),
			10,
		);
		try {
			// Trailing line has no newline; relies on flush-on-stop.
			await appendFile(logPath, jsonLine({ hook_event_name: "Stop" }), "utf8");
			// Give the poller at least one chance to read the bytes into remainder.
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			await stop();
			await rm(tempDir, { recursive: true, force: true });
		}
		expect(events.map((e) => e.event)).toEqual(["to_review"]);
	});
});
