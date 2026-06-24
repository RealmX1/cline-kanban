// Pure state helpers for native Cline sessions.
// This module owns the in-memory summary and message shape plus the low-level
// mutations shared by the event adapter and the message repository.
import type {
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../core/api-contract";
import {
	applySessionFacets,
	deriveSessionFacetsFromLegacyState,
	mergeSummaryWithFacets,
} from "../core/session-activity";

// Stage 4 全写侧反转：Cline SDK 写点经此从「目标 legacy state + 当刻 reviewReason」产出完整三 facet 的
// 写侧补丁（facet 是写时主真相源；state 由 mergeSummaryWithFacets 的 projectLegacyState 投影回填）。
// Cline 在进程内运行（pid 恒 null、无 connectionRetry），故 awaiting 恒 live、永不 exited（harness-aware）。
// 只返回三 facet——reviewReason 由各写点按原样自行设置（不强制改未触 reviewReason 的写点，如 running 续帧）。
// userTurnKindOverride（仅 user 回合生效）用于 harness 采集增强：ask_followup_question→question、
// plan_mode_respond→plan_review（B2）。
export function deriveClineFacetPatch(
	state: RuntimeTaskSessionState,
	reviewReason: RuntimeTaskSessionReviewReason,
	userTurnKindOverride?: RuntimeTaskSessionUserTurnKind | null,
): Partial<RuntimeTaskSessionSummary> {
	const facets = deriveSessionFacetsFromLegacyState(state, {
		reviewReason,
		pid: null,
		connectionRetryActive: false,
		agentId: "cline",
	});
	const userTurnKind =
		userTurnKindOverride !== undefined && facets.turnOwner === "user" ? userTurnKindOverride : facets.userTurnKind;
	return { turnOwner: facets.turnOwner, liveness: facets.liveness, userTurnKind };
}

// ask_followup_question → question / plan_mode_respond → plan_review / 其它 → null（B2 采集增强）。
export function classifyClineUserAttentionTool(toolName: string | null): "question" | "plan_review" | null {
	if (!toolName) {
		return null;
	}
	const normalized = toolName.trim().toLowerCase();
	if (normalized === "ask_followup_question") {
		return "question";
	}
	if (normalized === "plan_mode_respond") {
		return "plan_review";
	}
	return null;
}

/**
 * Detect credit-limit / insufficient-balance errors from an error message string.
 * Shared by the event adapter (for SDK agent events) and the session service (for
 * start/send failures) so the detection logic stays in one place.
 *
 * NOTE: This relies on string matching because the SDK does not yet expose a
 * structured error code for credit exhaustion. If the SDK adds one, prefer
 * checking that code and keep this as a fallback for older SDK versions.
 */
const CREDIT_LIMIT_PATTERNS = [
	"insufficient balance",
	"insufficient_credits",
	"insufficient credits",
	"credit limit",
	"credit_limit_exceeded",
	"credits exhausted",
	"out of credits",
	"no remaining credits",
	"402 payment required",
] as const;

export function isCreditLimitError(errorMessage: string | null): boolean {
	if (!errorMessage) {
		return false;
	}
	const normalized = errorMessage.toLowerCase();
	if (CREDIT_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern))) {
		return true;
	}
	return normalized.includes("402") && (normalized.includes("balance") || normalized.includes("credit"));
}

const WINDOWS_INVALID_SESSION_ID_CHARS = /[<>:"/\\|?*]/g;

export interface ClineTaskSessionEntry {
	summary: RuntimeTaskSessionSummary;
	messages: ClineTaskMessage[];
	activeAssistantMessageId: string | null;
	activeReasoningMessageId: string | null;
	toolMessageIdByToolCallId: Map<string, string>;
	toolInputByToolCallId: Map<string, unknown>;
}

export interface ClineTaskMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool" | "reasoning" | "status";
	content: string;
	images?: RuntimeTaskImage[];
	createdAt: number;
	meta?: {
		toolName?: string | null;
		hookEventName?: string | null;
		toolCallId?: string | null;
		streamType?: string | null;
		messageKind?: string | null;
		displayRole?: string | null;
		reason?: string | null;
		source?: string | null;
		idempotencyKey?: string | null;
		promptSha256?: string | null;
	} | null;
}

export function now(): number {
	return Date.now();
}

export function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		latestHookActivity: summary.latestHookActivity ? { ...summary.latestHookActivity } : null,
		latestTurnCheckpoint: summary.latestTurnCheckpoint ? { ...summary.latestTurnCheckpoint } : null,
		previousTurnCheckpoint: summary.previousTurnCheckpoint ? { ...summary.previousTurnCheckpoint } : null,
	};
}

export function cloneMessage(message: ClineTaskMessage): ClineTaskMessage {
	return {
		...message,
		images: message.images ? message.images.map((image) => ({ ...image })) : message.images,
		meta: message.meta ? { ...message.meta } : message.meta,
	};
}

export function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	// 初始 idle summary 即带上 idle facet（turnOwner=null / liveness=none / userTurnKind=null），
	// 使「直接发出未经 updateSummary 的默认 summary」也自洽。
	return applySessionFacets({
		taskId,
		state: "idle",
		mode: null,
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	});
}

export function updateSummary(
	entry: ClineTaskSessionEntry,
	patch: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	// Cline（in-process SDK）的 output 事件都是真内容（assistant 增量 / 工具活动），非 TUI 重绘，故在
	// 此单一漏斗镜像 lastSubstantiveOutputAt = lastOutputAt（一处覆盖全部 Cline 写点）——使 Cline 任务的
	// Validation 停留判据行为与迁移前一致。仅当 patch 显式给了 lastOutputAt 而未给实质戳时镜像；显式给
	// 实质戳（理论上）或未动 lastOutputAt 的 patch 不干预。终端 agent 侧绝不在此镜像——那侧必须由
	// agent-output-substance.ts 分类器把关（见 session-manager.ts handleTaskOutput）。
	const mirroredPatch =
		patch.lastOutputAt !== undefined && patch.lastSubstantiveOutputAt === undefined
			? { ...patch, lastSubstantiveOutputAt: patch.lastOutputAt }
			: patch;
	// 单一写侧漏斗：经 mergeSummaryWithFacets 派发（facet 写时主真相源，详见该函数）。
	entry.summary = mergeSummaryWithFacets(entry.summary, { ...mirroredPatch, updatedAt: now() });
	return cloneSummary(entry.summary);
}

export function createMessage(
	taskId: string,
	role: ClineTaskMessage["role"],
	content: string,
	images?: RuntimeTaskImage[],
): ClineTaskMessage {
	return {
		id: `${taskId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		images: images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined,
		createdAt: now(),
	};
}

export function createMessageWithMeta(
	taskId: string,
	role: ClineTaskMessage["role"],
	content: string,
	meta: ClineTaskMessage["meta"],
	images?: RuntimeTaskImage[],
): ClineTaskMessage {
	return {
		...createMessage(taskId, role, content, images),
		meta,
	};
}

export function createSessionId(taskId: string): string {
	return `${toSessionIdTaskPrefix(taskId)}-${now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildSessionIdPrefix(taskId: string): string {
	return `${toSessionIdTaskPrefix(taskId)}-`;
}

function toSessionIdTaskPrefix(taskId: string): string {
	const normalized = taskId.replace(WINDOWS_INVALID_SESSION_ID_CHARS, "_").trim();
	return normalized.length > 0 ? normalized : "session";
}

export function canReturnToRunning(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): boolean {
	return reviewReason === "attention" || reviewReason === "hook" || reviewReason === "error";
}

export function latestAssistantMessageMatches(entry: ClineTaskSessionEntry, content: string): boolean {
	const latestAssistant = getLatestAssistantMessage(entry);
	if (!latestAssistant) {
		return false;
	}
	return latestAssistant.content.trim() === content.trim();
}

export function clearActiveTurnState(entry: ClineTaskSessionEntry): void {
	entry.activeAssistantMessageId = null;
	entry.activeReasoningMessageId = null;
	entry.toolMessageIdByToolCallId.clear();
	entry.toolInputByToolCallId.clear();
}

export function appendAssistantChunk(entry: ClineTaskSessionEntry, taskId: string, chunk: string): ClineTaskMessage {
	const existingMessageId = entry.activeAssistantMessageId;
	if (existingMessageId) {
		const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content: `${currentMessage.content}${chunk}`,
		}));
		if (updatedMessage) {
			return updatedMessage;
		}
	}
	return createAssistantMessage(entry, taskId, chunk);
}

export function setOrCreateAssistantMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	content: string,
): ClineTaskMessage | null {
	if (!entry.activeAssistantMessageId) {
		return null;
	}
	const updatedMessage = updateMessageInEntry(entry, entry.activeAssistantMessageId, (currentMessage) => ({
		...currentMessage,
		content,
	}));
	if (updatedMessage) {
		return updatedMessage;
	}
	return createAssistantMessage(entry, taskId, content);
}

export function appendReasoningChunk(entry: ClineTaskSessionEntry, taskId: string, chunk: string): ClineTaskMessage {
	const existingMessageId = entry.activeReasoningMessageId;
	if (existingMessageId) {
		const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content: `${currentMessage.content}${chunk}`,
			meta: {
				...(currentMessage.meta ?? {}),
				hookEventName: "reasoning_delta",
				streamType: "reasoning",
			},
		}));
		if (updatedMessage) {
			return updatedMessage;
		}
	}
	return createReasoningMessage(entry, taskId, chunk, "reasoning_delta");
}

export function setOrCreateReasoningMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	content: string,
): ClineTaskMessage | null {
	if (!entry.activeReasoningMessageId) {
		return null;
	}
	const updatedMessage = updateMessageInEntry(entry, entry.activeReasoningMessageId, (currentMessage) => ({
		...currentMessage,
		content,
		meta: {
			...(currentMessage.meta ?? {}),
			hookEventName: "reasoning_end",
			streamType: "reasoning",
		},
	}));
	if (updatedMessage) {
		return updatedMessage;
	}
	return createReasoningMessage(entry, taskId, content, "reasoning_end");
}

export function createAssistantMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	content: string,
): ClineTaskMessage {
	const message = createMessage(taskId, "assistant", content);
	entry.messages.push(message);
	entry.activeAssistantMessageId = message.id;
	return message;
}

export function createReasoningMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	content: string,
	hookEventName: string,
): ClineTaskMessage {
	const message = createMessageWithMeta(taskId, "reasoning", content, {
		hookEventName,
		streamType: "reasoning",
	});
	entry.messages.push(message);
	entry.activeReasoningMessageId = message.id;
	return message;
}

export function startToolCallMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	input: {
		toolName: string | null;
		toolCallId: string | null;
		input: unknown;
	},
): ClineTaskMessage {
	const toolContent = buildToolCallContent({
		toolName: input.toolName,
		input: input.input,
	});
	const message = createMessageWithMeta(taskId, "tool", toolContent, {
		toolName: input.toolName,
		hookEventName: "tool_call_start",
		toolCallId: input.toolCallId,
		streamType: "tool",
	});
	entry.messages.push(message);
	if (input.toolCallId) {
		entry.toolMessageIdByToolCallId.set(input.toolCallId, message.id);
		entry.toolInputByToolCallId.set(input.toolCallId, input.input);
	}
	return message;
}

export function finishToolCallMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	input: {
		toolName: string | null;
		toolCallId: string | null;
		output: unknown;
		error: string | null;
		durationMs: number | null;
	},
): ClineTaskMessage {
	const existingMessageId = input.toolCallId ? (entry.toolMessageIdByToolCallId.get(input.toolCallId) ?? null) : null;
	const toolInput = input.toolCallId ? entry.toolInputByToolCallId.get(input.toolCallId) : undefined;
	const content = buildToolCallContent({
		toolName: input.toolName,
		input: toolInput,
		output: input.output,
		error: input.error,
		durationMs: input.durationMs,
	});
	if (existingMessageId) {
		const updatedMessage = updateMessageInEntry(entry, existingMessageId, (currentMessage) => ({
			...currentMessage,
			content,
			meta: {
				...(currentMessage.meta ?? {}),
				toolName: input.toolName,
				hookEventName: "tool_call_end",
				toolCallId: input.toolCallId,
				streamType: "tool",
			},
		}));
		if (updatedMessage) {
			if (input.toolCallId) {
				entry.toolMessageIdByToolCallId.delete(input.toolCallId);
				entry.toolInputByToolCallId.delete(input.toolCallId);
			}
			return updatedMessage;
		}
	}
	const message = createMessageWithMeta(taskId, "tool", content, {
		toolName: input.toolName,
		hookEventName: "tool_call_end",
		toolCallId: input.toolCallId,
		streamType: "tool",
	});
	if (input.toolCallId) {
		entry.toolMessageIdByToolCallId.delete(input.toolCallId);
		entry.toolInputByToolCallId.delete(input.toolCallId);
	}
	entry.messages.push(message);
	return message;
}

function stringifyPayload(payload: unknown): string {
	if (payload === undefined || payload === null) {
		return "";
	}
	if (typeof payload === "string") {
		return payload;
	}
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

function buildToolCallContent(input: {
	toolName: string | null;
	input: unknown;
	output?: unknown;
	error?: string | null;
	durationMs?: number | null;
}): string {
	const lines: string[] = [];
	lines.push(`Tool: ${input.toolName ?? "unknown"}`);
	const inputText = stringifyPayload(input.input);
	if (inputText) {
		lines.push("Input:");
		lines.push(inputText);
	}
	if (input.error) {
		lines.push("Error:");
		lines.push(input.error);
	} else if (input.output !== undefined) {
		const outputText = stringifyPayload(input.output);
		if (outputText) {
			lines.push("Output:");
			lines.push(outputText);
		}
	}
	if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
		lines.push(`Duration: ${Math.max(0, Math.round(input.durationMs))}ms`);
	}
	return lines.join("\n");
}

function updateMessageInEntry(
	entry: ClineTaskSessionEntry,
	messageId: string,
	updater: (currentMessage: ClineTaskMessage) => ClineTaskMessage,
): ClineTaskMessage | null {
	const messageIndex = entry.messages.findIndex((message) => message.id === messageId);
	if (messageIndex < 0) {
		return null;
	}
	const currentMessage = entry.messages[messageIndex];
	if (!currentMessage) {
		return null;
	}
	const nextMessage = updater(currentMessage);
	entry.messages[messageIndex] = nextMessage;
	return nextMessage;
}

function getLatestAssistantMessage(entry: ClineTaskSessionEntry): ClineTaskMessage | null {
	for (let index = entry.messages.length - 1; index >= 0; index -= 1) {
		const message = entry.messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return null;
}
