// Translates raw SDK session events into Kanban summary and message mutations.
// Keep protocol-specific parsing here so the runtime and repository can stay
// focused on lifecycle, storage, and task-facing orchestration.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";
import { logUserTurnKindCapture } from "../diagnostics/user-turn-kind-logger";
import {
	appendAssistantChunk,
	appendReasoningChunk,
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	canReturnToRunning,
	classifyClineUserAttentionTool,
	clearActiveTurnState,
	createAssistantMessage,
	createMessage,
	createReasoningMessage,
	deriveClineFacetPatch,
	finishToolCallMessage,
	isCreditLimitError,
	latestAssistantMessageMatches,
	now,
	setOrCreateAssistantMessage,
	setOrCreateReasoningMessage,
	startToolCallMessage,
	updateSummary,
} from "./cline-session-state";
import { formatClineToolCallLabel, getClineToolCallDisplay } from "./cline-tool-call-display";
import type { ClineSdkAgentEvent, ClineSdkSessionEvent } from "./sdk-runtime-boundary";

function normalizePreviewText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized || null;
}

function toPreviewText(value: string | null | undefined, maxLength = 160): string | null {
	const normalized = normalizePreviewText(value);
	if (!normalized) {
		return null;
	}
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

export interface ApplyClineSessionEventInput {
	event: unknown;
	taskId: string;
	entry: ClineTaskSessionEntry;
	pendingTurnCancelTaskIds: Set<string>;
	isClineProvider: boolean;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
	emitMessage: (taskId: string, message: ClineTaskMessage) => void;
}

type ClineSdkChunkEvent = Extract<ClineSdkSessionEvent, { type: "chunk" }>;
type ClineSdkHookEvent = Extract<ClineSdkSessionEvent, { type: "hook" }>;
type ClineSdkEndedEvent = Extract<ClineSdkSessionEvent, { type: "ended" }>;
type ClineSdkStatusEvent = Extract<ClineSdkSessionEvent, { type: "status" }>;
type RawClineSdkAgentEvent = ClineSdkAgentEvent | (Record<string, unknown> & { type: string });

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readAgentEvent(event: unknown): RawClineSdkAgentEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "agent_event") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload) {
		return null;
	}
	const agentEvent = asRecord(payload.event);
	if (!agentEvent || typeof agentEvent.type !== "string") {
		return null;
	}
	return agentEvent as unknown as RawClineSdkAgentEvent;
}

function readChunkEvent(event: unknown): ClineSdkChunkEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "chunk") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.chunk !== "string") {
		return null;
	}
	if (payload.stream !== "stdout" && payload.stream !== "stderr" && payload.stream !== "agent") {
		return null;
	}
	return { type: "chunk", payload: payload as unknown as ClineSdkChunkEvent["payload"] };
}

function readHookEvent(event: unknown): ClineSdkHookEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "hook") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string") {
		return null;
	}
	return { type: "hook", payload: payload as unknown as ClineSdkHookEvent["payload"] };
}

function readEndedEvent(event: unknown): ClineSdkEndedEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "ended") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.reason !== "string") {
		return null;
	}
	return { type: "ended", payload: payload as unknown as ClineSdkEndedEvent["payload"] };
}

function readStatusEvent(event: unknown): ClineSdkStatusEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "status") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.status !== "string") {
		return null;
	}
	return { type: "status", payload: payload as ClineSdkStatusEvent["payload"] };
}

function getRetainedClineToolActivity(entry: ClineTaskSessionEntry): {
	toolName: string | null;
	toolInputSummary: string | null;
} {
	const latestHookActivity = entry.summary.latestHookActivity;
	if (!latestHookActivity || latestHookActivity.source !== "cline-sdk" || !latestHookActivity.toolName) {
		return {
			toolName: null,
			toolInputSummary: null,
		};
	}

	return {
		toolName: latestHookActivity.toolName,
		toolInputSummary: latestHookActivity.toolInputSummary ?? null,
	};
}

function extractAgentErrorMessage(error: unknown): string | null {
	if (typeof error === "string") {
		const normalized = error.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (error instanceof Error) {
		const normalized = error.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		const normalized = error.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	return null;
}

function emitAssistantTextSummary(input: ApplyClineSessionEventInput, text: string | null): void {
	const fullPreviewText = normalizePreviewText(text);
	const previewText = toPreviewText(fullPreviewText);
	const retainedToolActivity = getRetainedClineToolActivity(input.entry);
	emitSummary(input, {
		...deriveClineFacetPatch("running", null),
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: previewText ?? "Agent active",
			toolName: retainedToolActivity.toolName,
			toolInputSummary: retainedToolActivity.toolInputSummary,
			finalMessage: fullPreviewText,
			hookEventName: "assistant_delta",
			notificationType: null,
			source: "cline-sdk",
		},
	});
}

function readMessagePartText(message: unknown, partType: "text" | "reasoning"): string | null {
	const messageRecord = asRecord(message);
	const content = messageRecord?.content;
	if (!Array.isArray(content)) {
		return null;
	}
	const text = content
		.map((part) => {
			const partRecord = asRecord(part);
			if (!partRecord || partRecord.type !== partType || typeof partRecord.text !== "string") {
				return "";
			}
			return partRecord.text;
		})
		.join("");
	return text.length > 0 ? text : null;
}

function readToolResult(message: unknown): { output: unknown; error: string | null } {
	const messageRecord = asRecord(message);
	const content = messageRecord?.content;
	if (!Array.isArray(content)) {
		return { output: undefined, error: null };
	}
	const result = content.map((part) => asRecord(part)).find((part) => part?.type === "tool-result");
	if (!result) {
		return { output: undefined, error: null };
	}
	const isError = result.isError === true;
	const output = result.output;
	return {
		output,
		error: isError ? (extractAgentErrorMessage(output) ?? "Tool execution failed") : null,
	};
}

export function extractClineSessionId(event: unknown): string | null {
	const record = asRecord(event);
	if (!record) {
		return null;
	}
	const payload = asRecord(record.payload);
	return payload && typeof payload.sessionId === "string" ? payload.sessionId : null;
}

// Translate raw SDK events into Kanban summary and chat mutations so the session service can stay focused on host ownership.
export function applyClineSessionEvent(input: ApplyClineSessionEventInput): void {
	const { entry, event, taskId } = input;
	const agentEvent = readAgentEvent(event);
	const chunkEvent = readChunkEvent(event);
	const hookEvent = readHookEvent(event);
	const endedEvent = readEndedEvent(event);
	const statusEvent = readStatusEvent(event);

	if (agentEvent?.type === "error") {
		const errorMessage = "error" in agentEvent ? extractAgentErrorMessage(agentEvent.error) : null;
		const eventRecord = asRecord(agentEvent);
		const rawMessage = typeof eventRecord?.message === "string" ? eventRecord.message.trim() || null : null;
		const creditLimitSource = errorMessage ?? rawMessage;
		const sdkRecoverable = typeof agentEvent.recoverable === "boolean" ? agentEvent.recoverable : false;
		const creditLimitError = input.isClineProvider && isCreditLimitError(creditLimitSource);
		const recoverable = sdkRecoverable && !creditLimitError;
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		if (!recoverable) {
			clearActiveTurnState(entry);
		}
		if (recoverable && errorMessage) {
			const retryMsg = createMessage(taskId, "system", `Retrying: ${errorMessage}`);
			entry.messages.push(retryMsg);
			input.emitMessage(taskId, retryMsg);
		}
		emitSummary(input, {
			...(recoverable
				? {}
				: {
						reviewReason: "error",
						warningMessage: creditLimitError ? null : (errorMessage ?? "Unknown agent error"),
						...deriveClineFacetPatch("awaiting_review", "error"),
					}),
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: recoverable
					? `Retrying after error: ${errorMessage ?? "Unknown agent error"}`
					: `Agent error: ${errorMessage ?? "Unknown agent error"}`,
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: recoverable ? null : (errorMessage ?? "Unknown agent error"),
				hookEventName: "agent_error",
				notificationType: creditLimitError ? "credit_limit" : null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (agentEvent?.type === "run-failed") {
		if (input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}
		const errorMessage = "error" in agentEvent ? extractAgentErrorMessage(agentEvent.error) : null;
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		clearActiveTurnState(entry);
		emitSummary(input, {
			reviewReason: "error",
			...deriveClineFacetPatch("awaiting_review", "error"),
			warningMessage: errorMessage ?? "Unknown agent error",
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `Agent error: ${errorMessage ?? "Unknown agent error"}`,
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: errorMessage ?? "Unknown agent error",
				hookEventName: "agent_error",
				notificationType: input.isClineProvider && isCreditLimitError(errorMessage) ? "credit_limit" : null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (agentEvent?.type === "assistant-text-delta") {
		const accumulated = typeof agentEvent.accumulatedText === "string" ? agentEvent.accumulatedText : null;
		const text = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (typeof accumulated === "string") {
			const message =
				setOrCreateAssistantMessage(entry, taskId, accumulated) ??
				createAssistantMessage(entry, taskId, accumulated);
			input.emitMessage(taskId, message);
		} else if (typeof text === "string" && text.length > 0) {
			input.emitMessage(taskId, appendAssistantChunk(entry, taskId, text));
		}
		emitAssistantTextSummary(input, accumulated ?? text);
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "text") {
		const accumulated = typeof agentEvent.accumulated === "string" ? agentEvent.accumulated : null;
		const text = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (typeof accumulated === "string") {
			const message =
				setOrCreateAssistantMessage(entry, taskId, accumulated) ??
				createAssistantMessage(entry, taskId, accumulated);
			input.emitMessage(taskId, message);
		} else if (typeof text === "string" && text.length > 0) {
			input.emitMessage(taskId, appendAssistantChunk(entry, taskId, text));
		}
		emitAssistantTextSummary(input, accumulated ?? text);
		return;
	}

	if (agentEvent?.type === "notice") {
		const message = typeof agentEvent.message === "string" ? agentEvent.message.trim() : "";
		const noticeReason: string | null = typeof agentEvent.reason === "string" ? agentEvent.reason : null;
		const noticeType = typeof agentEvent.noticeType === "string" ? agentEvent.noticeType : null;
		if (
			input.isClineProvider &&
			isCreditLimitError(message) &&
			(noticeType === "recovery" || noticeReason === "recovery")
		) {
			return;
		}
		if (message) {
			const displayRole = typeof agentEvent.displayRole === "string" ? agentEvent.displayRole : "system";
			const reason = typeof agentEvent.reason === "string" ? agentEvent.reason : null;
			const normalizedRole = displayRole === "status" ? "status" : "system";
			const noticeMessage = createMessage(taskId, normalizedRole, message);
			noticeMessage.meta = {
				hookEventName: "agent_notice",
				messageKind: noticeType,
				displayRole,
				reason,
			};
			entry.messages.push(noticeMessage);
			input.emitMessage(taskId, noticeMessage);
		}
		return;
	}

	if (agentEvent?.type === "run-finished") {
		const result = asRecord(agentEvent.result);
		const finalText = typeof result?.outputText === "string" ? result.outputText.trim() : "";
		if (finalText) {
			const message = setOrCreateAssistantMessage(entry, taskId, finalText);
			if (message) {
				input.emitMessage(taskId, message);
			} else if (!latestAssistantMessageMatches(entry, finalText)) {
				const assistantMessage = createMessage(taskId, "assistant", finalText);
				entry.messages.push(assistantMessage);
				input.emitMessage(taskId, assistantMessage);
			}
		}

		const status = typeof result?.status === "string" ? result.status : "completed";
		if (status === "aborted" && input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}

		const previousHookActivity = entry.summary.latestHookActivity;
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: finalText ? `Final: ${finalText}` : (previousHookActivity?.activityText ?? null),
				toolName: previousHookActivity?.toolName ?? null,
				toolInputSummary: previousHookActivity?.toolInputSummary ?? null,
				finalMessage: finalText || (previousHookActivity?.finalMessage ?? null),
				hookEventName: "agent_end",
				notificationType: previousHookActivity?.notificationType ?? null,
				source: "cline-sdk",
			},
		};
		if (status === "aborted") {
			summaryPatch.reviewReason = "interrupted";
			Object.assign(summaryPatch, deriveClineFacetPatch("interrupted", "interrupted"));
		} else if (status === "failed") {
			summaryPatch.reviewReason = "error";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "error"));
		} else {
			// B1 completion split：自然完成置 reviewReason:"completion"（区别于 hook 待关注；人轴同 → review）。
			summaryPatch.reviewReason = "completion";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "completion"));
		}

		clearActiveTurnState(entry);
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "done") {
		const finalText = typeof agentEvent.text === "string" ? agentEvent.text.trim() : "";
		if (finalText) {
			const message = setOrCreateAssistantMessage(entry, taskId, finalText);
			if (message) {
				input.emitMessage(taskId, message);
			} else if (!latestAssistantMessageMatches(entry, finalText)) {
				const assistantMessage = createMessage(taskId, "assistant", finalText);
				entry.messages.push(assistantMessage);
				input.emitMessage(taskId, assistantMessage);
			}
		}

		const doneReason = typeof agentEvent.reason === "string" ? agentEvent.reason : "completed";
		if (doneReason === "aborted" && input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}

		const previousHookActivity = entry.summary.latestHookActivity;
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: finalText ? `Final: ${finalText}` : (previousHookActivity?.activityText ?? null),
				toolName: previousHookActivity?.toolName ?? null,
				toolInputSummary: previousHookActivity?.toolInputSummary ?? null,
				finalMessage: finalText || (previousHookActivity?.finalMessage ?? null),
				hookEventName: "agent_end",
				notificationType: previousHookActivity?.notificationType ?? null,
				source: "cline-sdk",
			},
		};
		if (doneReason === "aborted") {
			summaryPatch.reviewReason = "interrupted";
			Object.assign(summaryPatch, deriveClineFacetPatch("interrupted", "interrupted"));
		} else if (doneReason === "error") {
			summaryPatch.reviewReason = "error";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "error"));
		} else {
			// B1 completion split：自然完成置 reviewReason:"completion"（区别于 hook 待关注；人轴同 → review）。
			summaryPatch.reviewReason = "completion";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "completion"));
		}

		clearActiveTurnState(entry);
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "assistant-reasoning-delta") {
		const reasoning = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (reasoning && reasoning.length > 0) {
			input.emitMessage(taskId, appendReasoningChunk(entry, taskId, reasoning));
			emitSummary(input, {
				...deriveClineFacetPatch("running", null),
				lastOutputAt: now(),
			});
		}
		return;
	}

	if (agentEvent?.type === "assistant-message") {
		const text = readMessagePartText(agentEvent.message, "text");
		if (text) {
			const message =
				setOrCreateAssistantMessage(entry, taskId, text) ?? createAssistantMessage(entry, taskId, text);
			input.emitMessage(taskId, message);
			entry.activeAssistantMessageId = null;
			emitAssistantTextSummary(input, text);
			return;
		}

		const reasoning = readMessagePartText(agentEvent.message, "reasoning");
		if (reasoning) {
			const message =
				setOrCreateReasoningMessage(entry, taskId, reasoning) ??
				createReasoningMessage(entry, taskId, reasoning, "reasoning_end");
			input.emitMessage(taskId, message);
			entry.activeReasoningMessageId = null;
			emitSummary(input, {
				lastOutputAt: now(),
			});
		}
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "reasoning") {
		const reasoning = typeof agentEvent.reasoning === "string" ? agentEvent.reasoning : null;
		if (reasoning && reasoning.length > 0) {
			input.emitMessage(taskId, appendReasoningChunk(entry, taskId, reasoning));
			emitSummary(input, {
				...deriveClineFacetPatch("running", null),
				lastOutputAt: now(),
			});
		}
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "reasoning") {
		const reasoning = typeof agentEvent.reasoning === "string" ? agentEvent.reasoning : null;
		if (reasoning) {
			const message =
				setOrCreateReasoningMessage(entry, taskId, reasoning) ??
				createReasoningMessage(entry, taskId, reasoning, "reasoning_end");
			input.emitMessage(taskId, message);
		}
		entry.activeReasoningMessageId = null;
		emitSummary(input, {
			lastOutputAt: now(),
		});
		return;
	}

	if (agentEvent?.type === "tool-started") {
		const toolCall = asRecord(agentEvent.toolCall);
		const toolName = typeof toolCall?.toolName === "string" ? toolCall.toolName : null;
		const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : null;
		const toolInput = toolCall?.input;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const userAttentionKind = classifyClineUserAttentionTool(toolName);
		const isUserAttentionTool = userAttentionKind !== null;
		input.emitMessage(
			taskId,
			startToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				input: toolInput,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `Using ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: isUserAttentionTool ? "user_attention" : null,
				source: "cline-sdk",
			},
		};
		// A3 读迁移：旧 `state==="running"||"idle"` → facet `turnOwner==="agent"||null`（running⟺agent、idle⟺null）。
		const turnOwner = resolveSessionFacets(entry.summary).turnOwner;
		if (isUserAttentionTool && (turnOwner === "agent" || turnOwner === null)) {
			// B2 采集增强：ask_followup_question→question / plan_mode_respond→plan_review。经 deriveClineFacetPatch
			// 产完整 facet 三元组后由 override 写人轴——绝不裸写单 userTurnKind（否则撞 superRefine 共生护栏）。
			summaryPatch.reviewReason = "hook";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "hook", userAttentionKind ?? undefined));
			logUserTurnKindCapture({
				taskId,
				agentId: entry.summary.agentId,
				source: "cline-sdk",
				rawSignal: toolName,
				resolvedKind: userAttentionKind ?? "unclassified",
			});
		} else if (!isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.reviewReason = null;
			Object.assign(summaryPatch, deriveClineFacetPatch("running", null));
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "tool-finished") {
		const toolCall = asRecord(agentEvent.toolCall);
		const toolName = typeof toolCall?.toolName === "string" ? toolCall.toolName : null;
		const toolCallId = typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : null;
		const { output: toolOutput, error: toolError } = readToolResult(agentEvent.message);
		const toolInput = toolCallId ? entry.toolInputByToolCallId.get(toolCallId) : undefined;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const userAttentionKind = classifyClineUserAttentionTool(toolName);
		const isUserAttentionTool = userAttentionKind !== null;
		input.emitMessage(
			taskId,
			finishToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				output: toolOutput,
				error: toolError,
				durationMs: null,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `${toolError ? "Failed" : "Completed"} ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_result",
				notificationType: null,
				source: "cline-sdk",
			},
		};
		if (isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.reviewReason = null;
			Object.assign(summaryPatch, deriveClineFacetPatch("running", null));
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "tool") {
		const toolName = typeof agentEvent.toolName === "string" ? agentEvent.toolName : null;
		const toolCallId = typeof agentEvent.toolCallId === "string" ? agentEvent.toolCallId : null;
		const toolInput = agentEvent.input;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const userAttentionKind = classifyClineUserAttentionTool(toolName);
		const isUserAttentionTool = userAttentionKind !== null;
		input.emitMessage(
			taskId,
			startToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				input: toolInput,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `Using ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: isUserAttentionTool ? "user_attention" : null,
				source: "cline-sdk",
			},
		};
		// A3 读迁移：旧 `state==="running"||"idle"` → facet `turnOwner==="agent"||null`（running⟺agent、idle⟺null）。
		const turnOwner = resolveSessionFacets(entry.summary).turnOwner;
		if (isUserAttentionTool && (turnOwner === "agent" || turnOwner === null)) {
			// B2 采集增强：ask_followup_question→question / plan_mode_respond→plan_review。经 deriveClineFacetPatch
			// 产完整 facet 三元组后由 override 写人轴——绝不裸写单 userTurnKind（否则撞 superRefine 共生护栏）。
			summaryPatch.reviewReason = "hook";
			Object.assign(summaryPatch, deriveClineFacetPatch("awaiting_review", "hook", userAttentionKind ?? undefined));
			logUserTurnKindCapture({
				taskId,
				agentId: entry.summary.agentId,
				source: "cline-sdk",
				rawSignal: toolName,
				resolvedKind: userAttentionKind ?? "unclassified",
			});
		} else if (!isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.reviewReason = null;
			Object.assign(summaryPatch, deriveClineFacetPatch("running", null));
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "tool") {
		const toolName = typeof agentEvent.toolName === "string" ? agentEvent.toolName : null;
		const toolCallId = typeof agentEvent.toolCallId === "string" ? agentEvent.toolCallId : null;
		const toolOutput = agentEvent.output;
		const toolError = typeof agentEvent.error === "string" ? agentEvent.error : null;
		const durationMs = typeof agentEvent.durationMs === "number" ? agentEvent.durationMs : null;
		const toolInput = toolCallId ? entry.toolInputByToolCallId.get(toolCallId) : undefined;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const userAttentionKind = classifyClineUserAttentionTool(toolName);
		const isUserAttentionTool = userAttentionKind !== null;
		input.emitMessage(
			taskId,
			finishToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				output: toolOutput,
				error: toolError,
				durationMs,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `${toolError ? "Failed" : "Completed"} ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_result",
				notificationType: null,
				source: "cline-sdk",
			},
		};
		if (isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.reviewReason = null;
			Object.assign(summaryPatch, deriveClineFacetPatch("running", null));
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "text") {
		const text = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (text) {
			const message =
				setOrCreateAssistantMessage(entry, taskId, text) ?? createAssistantMessage(entry, taskId, text);
			input.emitMessage(taskId, message);
			emitAssistantTextSummary(input, text);
		} else {
			emitSummary(input, {
				lastOutputAt: now(),
			});
		}
		entry.activeAssistantMessageId = null;
		return;
	}

	if (chunkEvent?.payload.stream === "agent") {
		const chunk = chunkEvent.payload.chunk;
		if (chunk.length === 0 || isLikelySerializedAgentEventChunk(chunk)) {
			return;
		}
		input.emitMessage(taskId, appendAssistantChunk(entry, taskId, chunk));
		const fullPreviewText = normalizePreviewText(chunk);
		const previewText = toPreviewText(fullPreviewText);
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		emitSummary(input, {
			...deriveClineFacetPatch("running", null),
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: previewText ?? "Agent active",
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: fullPreviewText,
				hookEventName: "assistant_delta",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (hookEvent) {
		const hookEventName =
			typeof hookEvent.payload.hookEventName === "string" ? hookEvent.payload.hookEventName : null;
		const toolName = typeof hookEvent.payload.toolName === "string" ? hookEvent.payload.toolName : null;
		const activityText = hookEventName && toolName ? `${hookEventName}: ${toolName}` : hookEventName;
		emitSummary(input, {
			lastHookAt: now(),
			latestHookActivity: {
				activityText,
				toolName,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName,
				notificationType: null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (endedEvent) {
		const interrupted =
			endedEvent.payload.reason.includes("abort") || endedEvent.payload.reason.includes("interrupt");
		if (interrupted && input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}
		clearActiveTurnState(entry);
		const endedReviewReason = interrupted ? "interrupted" : "exit";
		emitSummary(input, {
			reviewReason: endedReviewReason,
			...deriveClineFacetPatch(interrupted ? "interrupted" : "awaiting_review", endedReviewReason),
			lastOutputAt: now(),
		});
		return;
	}

	if (statusEvent) {
		if (statusEvent.payload.status !== "running") {
			clearActiveTurnState(entry);
		}
		// A3 读迁移：旧 `state==="awaiting_review"` → facet isAwaitingUserReviewTurn；「保持当前 state」=
		// 发 metadata-only patch（仅 lastOutputAt），由 mergeSummaryWithFacets preserve 现有 facet。
		const statusFacets = resolveSessionFacets(entry.summary);
		const shouldReturnToRunning =
			statusEvent.payload.status === "running" &&
			!(isAwaitingUserReviewTurn(statusFacets) && canReturnToRunning(entry.summary.reviewReason));
		emitSummary(input, {
			lastOutputAt: now(),
			...(shouldReturnToRunning ? deriveClineFacetPatch("running", null) : {}),
		});
	}
}

function emitSummary(input: ApplyClineSessionEventInput, patch: Partial<RuntimeTaskSessionSummary>): void {
	input.emitSummary(updateSummary(input.entry, patch));
}

function emitTurnCanceled(input: ApplyClineSessionEventInput): void {
	input.pendingTurnCancelTaskIds.delete(input.taskId);
	clearActiveTurnState(input.entry);
	emitSummary(input, {
		...deriveClineFacetPatch("idle", null),
		reviewReason: null,
		lastOutputAt: now(),
		lastHookAt: now(),
		latestHookActivity: {
			activityText: "Turn canceled",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "turn_canceled",
			notificationType: null,
			source: "cline-sdk",
		},
	});
}

function isLikelySerializedAgentEventChunk(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) {
		return false;
	}
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return false;
	}
	try {
		const parsed = JSON.parse(trimmed);
		return Boolean(parsed && typeof parsed === "object" && "type" in parsed);
	} catch {
		return false;
	}
}
