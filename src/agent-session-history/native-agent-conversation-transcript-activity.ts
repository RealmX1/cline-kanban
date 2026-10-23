// 仅解析已确认的原生对话记录；时间取记录本身，绝不用文件 mtime 补造业务时间。
import { createHash } from "node:crypto";
import type {
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeLastAgentConversationPromptCacheReferenceObservation,
	RuntimeLastEffectiveAgentConversationActivityObservation,
} from "../core/api-contract";
import { readTranscriptRecord } from "./bounded-agent-transcript-reader";
import {
	extractSubmittedUserPromptFromTranscriptRecord,
	isAcceptedNativeUserInputWithOnlyAttachments,
} from "./submitted-user-prompt-transcript-record-parser";

export type NativeAgentConversationTranscriptActivityObservation =
	RuntimeLastEffectiveAgentConversationActivityObservation & {
		// 仅供接受边沿消费，不持久化进 session summary。
		submittedPromptText?: string;
		// Codex 原生回合状态只用于判断接受事实能否重新开启 Agent 回合，不持久化。
		acceptedNativeAgentTurnIsInProgress?: boolean;
		// 原生回合中的首条输入已有真实模型响应；排队输入不能借用此前的响应。
		acceptedNativeAgentTurnHasModelResponse?: boolean;
		// 仅真实模型响应携带；通用活动和用户接受记录不携带缓存推导。
		nativeAgentResponsePromptCacheReferenceObservation?: RuntimeLastAgentConversationPromptCacheReferenceObservation;
		nativeAgentResponseAcceptedUserInputEventId?: string;
	};

export function parseNativeAgentConversationTranscriptActivity(input: {
	identity: RuntimeAgentNativeConversationSessionIdentity;
	record: Record<string, unknown>;
	serializedRecord: string;
}): NativeAgentConversationTranscriptActivityObservation | null {
	const { identity, record } = input;
	if (record.isSidechain === true || record.synthetic === true || record.isMeta === true) return null;
	if (typeof record.sessionId === "string" && record.sessionId !== identity.nativeSessionId) return null;
	const timestamp = record.timestamp ?? record.createdAt;
	const observedAtMs =
		typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	if (!Number.isFinite(observedAtMs)) return null;
	const payload = readTranscriptRecord(record.payload);
	const message = readTranscriptRecord(record.message);
	if (message?.model === "<synthetic>") return null;
	const source = identity.sourceAgentId;
	let activityKind: RuntimeLastEffectiveAgentConversationActivityObservation["activityKind"] | null = null;
	const prompt = extractSubmittedUserPromptFromTranscriptRecord(source, record);
	if (prompt || isAcceptedNativeUserInputWithOnlyAttachments(source, record)) activityKind = "accepted_user_input";
	else if (source === "claude") {
		const content = Array.isArray(message?.content) ? message.content.map(readTranscriptRecord) : [];
		if (record.type === "system" && record.subtype === "compact_boundary") activityKind = "context_compaction";
		else if (record.type === "assistant" && content.some((block) => block?.type === "tool_use"))
			activityKind = "tool_activity";
		else if (
			record.type === "assistant" &&
			content.some((block) => block?.type === "text" || block?.type === "thinking")
		)
			activityKind = "agent_output";
		else if (record.type === "user" && content.some((block) => block?.type === "tool_result"))
			activityKind = "tool_activity";
	} else if (source === "omp") {
		if (record.type === "compaction") activityKind = "context_compaction";
		else if (record.type === "message" && message?.role === "toolResult") activityKind = "tool_activity";
		else if (record.type === "message" && message?.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content.map(readTranscriptRecord) : [];
			activityKind = blocks.some((block) => block?.type === "toolCall") ? "tool_activity" : "agent_output";
		}
	} else if (source === "codex") {
		if (record.type === "compacted" || (record.type === "event_msg" && payload?.type === "context_compacted"))
			activityKind = "context_compaction";
		else if (
			record.type === "response_item" &&
			["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(
				String(payload?.type),
			)
		)
			activityKind = "tool_activity";
		else if (
			(record.type === "response_item" && payload?.type === "message" && payload.role === "assistant") ||
			(record.type === "event_msg" && ["agent_message", "agent_reasoning"].includes(String(payload?.type)))
		)
			activityKind = "agent_output";
	}
	if (!activityKind) return null;
	const nativeMessageId =
		prompt?.messageId ??
		(typeof record.uuid === "string"
			? record.uuid
			: typeof record.id === "string"
				? record.id
				: typeof payload?.id === "string"
					? payload.id
					: createHash("sha256").update(input.serializedRecord).digest("hex"));
	return {
		observedAtMs,
		evidenceKind:
			activityKind === "accepted_user_input" ? "native_user_prompt_acceptance" : "persisted_agent_transcript",
		activityKind,
		eventId: `${source}:${identity.nativeSessionId}:${nativeMessageId}`,
		nativeSessionId: identity.nativeSessionId,
		...(prompt ? { submittedPromptText: prompt.text } : {}),
		...(record.isCompactSummary !== true &&
		message?.isCompactSummary !== true &&
		(record.type === "assistant" || (record.type === "message" && message?.role === "assistant")) &&
		(activityKind === "agent_output" || activityKind === "tool_activity")
			? {
					nativeAgentResponsePromptCacheReferenceObservation: {
						observedAtMs,
						evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate" as const,
					},
				}
			: {}),
	};
}
