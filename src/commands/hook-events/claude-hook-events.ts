import { open, stat } from "node:fs/promises";

import type { RuntimeHookEvent, RuntimeTaskHookActivity } from "../../core/api-contract";
import { asRecord, normalizeWhitespace, readNestedString, readStringField } from "./hook-utils";

const CLAUDE_LOG_POLL_INTERVAL_MS = 250;
const CLAUDE_FEATURE_FLAG_ENV = "CLAUDE_HOOK_EVENTS_ENABLED";
const MAX_INPUT_SUMMARY_LEN = 200;
const MAX_ACTIVITY_FINGERPRINT_LEN = 200;

const HOOK_EVENT_NAME_KEYS = ["hook_event_name", "hookEventName", "hookName"] as const;
const TOOL_NAME_KEYS = ["tool_name", "toolName"] as const;
const NOTIFICATION_TYPE_KEYS = ["notification_type", "notificationType"] as const;
const FINAL_MESSAGE_KEYS = ["last_assistant_message", "lastAssistantMessage", "last-assistant-message"] as const;
const MATCHER_KEYS = ["matcher", "notification_matcher", "notificationMatcher"] as const;

export interface ClaudeMappedHookEvent {
	event: RuntimeHookEvent;
	metadata?: Partial<RuntimeTaskHookActivity>;
}

export type ClaudeSessionWatcherNotify = (mapped: ClaudeMappedHookEvent) => void;

export interface ClaudeSessionWatcherOptions {
	cwd?: string;
}

export interface ClaudeWatcherState {
	offset: number;
	remainder: string;
	lastActivityFingerprint: string;
}

export function createClaudeWatcherState(): ClaudeWatcherState {
	return {
		offset: 0,
		remainder: "",
		lastActivityFingerprint: "",
	};
}

function isClaudeWatcherEnabled(): boolean {
	const raw = process.env[CLAUDE_FEATURE_FLAG_ENV];
	if (raw === undefined || raw === null || raw === "") {
		return true;
	}
	return raw !== "0";
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = readStringField(record, key);
		if (value) {
			return value;
		}
	}
	return null;
}

function readToolInputRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
	const candidates: unknown[] = [
		payload.tool_input,
		payload.toolInput,
		asRecord(payload.preToolUse)?.input,
		asRecord(payload.postToolUse)?.input,
	];
	for (const candidate of candidates) {
		const record = asRecord(candidate);
		if (record) {
			return record;
		}
	}
	return null;
}

function summarizeToolInput(payload: Record<string, unknown>): string | null {
	const input = readToolInputRecord(payload);
	if (!input) {
		return null;
	}
	const command = readStringField(input, "command");
	if (command) {
		return command.slice(0, MAX_INPUT_SUMMARY_LEN);
	}
	const filePath =
		readStringField(input, "file_path") ?? readStringField(input, "filePath") ?? readStringField(input, "path");
	if (filePath) {
		return filePath.slice(0, MAX_INPUT_SUMMARY_LEN);
	}
	return null;
}

function classifyHookEvent(
	hookEventName: string,
	notificationType: string | null,
	matcher: string | null,
): RuntimeHookEvent | null {
	const normalized = hookEventName.toLowerCase();
	switch (normalized) {
		case "stop":
		case "permissionrequest":
			return "to_review";
		case "userpromptsubmit":
		case "posttooluse":
		case "posttoolusefailure":
		case "sessionstart":
			return "to_in_progress";
		case "pretooluse":
		// Stage 5 备注：生产环境的 Claude question/plan_review 采集**不走本 log-watcher**——它经
		// command-hook 路径（settings.json 的 PreToolUse matcher `ExitPlanMode|AskUserQuestion`→to_review
		// → `kanban hooks ingest` → classifyHookUserTurnKind 读 toolName，见 agent-session-adapters.ts /
		// hooks-api.ts）。本 watcher 当前**仅测试引用**（startClaudeSessionWatcher 无生产调用点），故此处
		// pretooluse→activity 保持不变；若将来把 watcher 接入生产，需在此把 toolName∈{ExitPlanMode,
		// AskUserQuestion} 的 pretooluse 同样路由到 to_review（classifyHookEvent 需把 toolName 纳入入参）。
		case "subagentstop":
			return "activity";
		case "notification": {
			const tag = (notificationType ?? matcher ?? "").toLowerCase();
			if (tag.startsWith("permission_prompt") || tag === "permission") {
				return "to_review";
			}
			return "activity";
		}
		default:
			return null;
	}
}

function buildActivityText(
	event: RuntimeHookEvent,
	hookEventName: string,
	toolName: string | null,
	toolInputSummary: string | null,
	notificationType: string | null,
	finalMessage: string | null,
): string | null {
	const normalizedHook = hookEventName.toLowerCase();
	if (event === "to_review" && normalizedHook === "stop") {
		return finalMessage ? `Final: ${finalMessage}` : "Awaiting review";
	}
	if (event === "to_review") {
		return notificationType ? `Awaiting review: ${notificationType}` : `Awaiting review: ${hookEventName}`;
	}
	if (toolName) {
		return toolInputSummary ? `Using ${toolName}: ${toolInputSummary}` : `Using ${toolName}`;
	}
	if (notificationType) {
		return `Notification: ${notificationType}`;
	}
	if (normalizedHook === "userpromptsubmit") {
		return "User prompt submitted";
	}
	return null;
}

function safeJsonParse(line: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return null;
	}
}

export function parseClaudeEventLine(line: string, state: ClaudeWatcherState): ClaudeMappedHookEvent | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const payload = safeJsonParse(trimmed);
	if (!payload) {
		return null;
	}
	const hookEventName = readFirstString(payload, HOOK_EVENT_NAME_KEYS);
	if (!hookEventName) {
		return null;
	}
	const toolName =
		readFirstString(payload, TOOL_NAME_KEYS) ??
		readNestedString(payload, ["preToolUse", "tool"]) ??
		readNestedString(payload, ["preToolUse", "toolName"]) ??
		readNestedString(payload, ["postToolUse", "tool"]) ??
		readNestedString(payload, ["postToolUse", "toolName"]);
	const notificationType = readFirstString(payload, NOTIFICATION_TYPE_KEYS);
	const matcher = readFirstString(payload, MATCHER_KEYS);
	const finalMessage = readFirstString(payload, FINAL_MESSAGE_KEYS);

	const event = classifyHookEvent(hookEventName, notificationType, matcher);
	if (!event) {
		return null;
	}

	const toolInputSummary = summarizeToolInput(payload);
	const rawActivityText = buildActivityText(
		event,
		hookEventName,
		toolName,
		toolInputSummary,
		notificationType,
		finalMessage,
	);
	const activityText = rawActivityText ? normalizeWhitespace(rawActivityText) : null;

	const fingerprint = [
		hookEventName,
		toolName ?? "",
		notificationType ?? "",
		(activityText ?? "").slice(0, MAX_ACTIVITY_FINGERPRINT_LEN),
	].join(":");
	if (fingerprint === state.lastActivityFingerprint) {
		return null;
	}
	state.lastActivityFingerprint = fingerprint;

	const metadata: Partial<RuntimeTaskHookActivity> = {
		source: "claude",
		hookEventName,
	};
	if (toolName) {
		metadata.toolName = toolName;
	}
	if (toolInputSummary) {
		metadata.toolInputSummary = toolInputSummary;
	}
	if (notificationType) {
		metadata.notificationType = notificationType;
	}
	if (finalMessage) {
		metadata.finalMessage = finalMessage;
	}
	if (activityText) {
		metadata.activityText = activityText;
	}

	return { event, metadata };
}

export async function startClaudeSessionWatcher(
	logPath: string,
	notify: ClaudeSessionWatcherNotify,
	pollIntervalMs: number = CLAUDE_LOG_POLL_INTERVAL_MS,
	_options: ClaudeSessionWatcherOptions = {},
): Promise<() => Promise<void>> {
	if (!isClaudeWatcherEnabled()) {
		return async () => {};
	}
	const state = createClaudeWatcherState();
	let stopped = false;
	let inflightPoll: Promise<void> | null = null;

	const runPoll = async (): Promise<void> => {
		if (stopped) {
			return;
		}
		try {
			const stats = await stat(logPath).catch(() => null);
			if (!stats) {
				return;
			}
			// Detect file shrink/truncate/rotate: producer may have rewritten the
			// log so the new size is smaller than the previously consumed offset.
			// Reset offset and remainder so we re-read from the beginning of the
			// new content. Fingerprint dedup is intentionally preserved.
			if (stats.size < state.offset) {
				state.offset = 0;
				state.remainder = "";
			}
			if (stats.size <= state.offset) {
				return;
			}
			const fh = await open(logPath, "r").catch(() => null);
			if (!fh) {
				return;
			}
			try {
				const length = stats.size - state.offset;
				const buffer = Buffer.alloc(length);
				await fh.read(buffer, 0, length, state.offset);
				state.offset = stats.size;
				const chunk = state.remainder + buffer.toString("utf8");
				const lines = chunk.split("\n");
				state.remainder = lines.pop() ?? "";
				for (const line of lines) {
					if (stopped) {
						break;
					}
					const mapped = parseClaudeEventLine(line, state);
					if (mapped) {
						notify(mapped);
					}
				}
			} finally {
				await fh.close().catch(() => {});
			}
		} catch {
			// transient I/O / JSON errors are ignored (codex-watcher posture).
		}
	};

	const poll = (): Promise<void> => {
		if (inflightPoll) {
			return inflightPoll;
		}
		const current = runPoll().finally(() => {
			if (inflightPoll === current) {
				inflightPoll = null;
			}
		});
		inflightPoll = current;
		return current;
	};

	const flushRemainder = (): void => {
		const line = state.remainder.trim();
		if (!line) {
			return;
		}
		state.remainder = "";
		// Only treat the trailing buffer as a complete record when it looks like
		// a JSON object/array; otherwise we may be flushing a partial write.
		const lastChar = line[line.length - 1];
		if (lastChar !== "}" && lastChar !== "]") {
			return;
		}
		const mapped = parseClaudeEventLine(line, state);
		if (mapped) {
			notify(mapped);
		}
	};

	const timer = setInterval(() => {
		void poll();
	}, pollIntervalMs);
	timer.unref?.();

	return async () => {
		stopped = true;
		clearInterval(timer);
		// Drain any in-flight poll so its writes to `state` complete before we
		// inspect the trailing remainder.
		if (inflightPoll) {
			await inflightPoll.catch(() => {});
		}
		// Final tail-poll to pick up any bytes written after the last interval
		// tick. This is part of the stop operation, so emitting here is allowed
		// despite `stopped = true` (the `stopped` guard inside `runPoll` early-
		// returns; we explicitly call the underlying read instead).
		stopped = false;
		try {
			await runPoll();
		} finally {
			stopped = true;
		}
		flushRemainder();
	};
}
