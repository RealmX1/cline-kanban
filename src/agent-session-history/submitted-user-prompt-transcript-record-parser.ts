// 原生转录的纯解析入口；不读取 workspace 或关系账本，供历史检索与实时接受核验共同使用。
import {
	classifyClaudeCodeTranscriptRecord,
	readUserMessageText,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { readTranscriptRecord } from "./bounded-agent-transcript-reader";

function readTextBlocks(value: unknown, includeTextBlock: (text: string) => boolean = () => true): string {
	if (typeof value === "string") return includeTextBlock(value) ? value : "";
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((block) => {
			const record = readTranscriptRecord(block);
			return (record?.type === "text" || record?.type === "input_text") &&
				typeof record.text === "string" &&
				includeTextBlock(record.text)
				? [record.text]
				: [];
		})
		.join("\n");
}

function isCodexTextBlockEligibleForUserPromptEvidence(text: string): boolean {
	const trimmedStartText = text.trimStart();
	return !(
		/^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/u.test(trimmedStartText) ||
		trimmedStartText.startsWith("<environment_context>") ||
		trimmedStartText.startsWith("<task-notification>")
	);
}

/** 真实输入也可以只有图片或文档；此判据不把附件正文伪造成 draft-usage 的用户文字。 */
export function isAcceptedNativeUserInputWithOnlyAttachments(
	sourceAgentId: string,
	record: Record<string, unknown>,
): boolean {
	if (
		record.synthetic === true ||
		record.isCompactSummary === true ||
		record.isMeta === true ||
		record.isSidechain === true ||
		record.promptSource === "system" ||
		readTranscriptRecord(record.origin)?.kind === "task-notification"
	)
		return false;
	const message = readTranscriptRecord(record.message);
	if (readTextBlocks(message?.content).trimStart().startsWith("<task-notification>")) return false;
	if (sourceAgentId === "claude") {
		if (classifyClaudeCodeTranscriptRecord(record) !== "human_typed_turn_boundary") return false;
	} else if (sourceAgentId === "omp") {
		if (
			record.type !== "message" ||
			message?.role !== "user" ||
			message.synthetic === true ||
			(message.attribution !== undefined && message.attribution !== "user")
		)
			return false;
	} else return false;
	return (
		Array.isArray(message?.content) &&
		message.content.some((block) => {
			const contentBlock = readTranscriptRecord(block);
			return contentBlock?.type === "image" || contentBlock?.type === "document";
		})
	);
}

/** 只读用户文字块；工具结果、压缩摘要与 harness 通知不能成为草稿使用证据。 */
export function extractSubmittedUserPromptFromTranscriptRecord(
	sourceAgentId: string,
	record: Record<string, unknown>,
): { text: string; submittedAtEpochMs: number | null; messageId: string | null } | null {
	if (
		record.synthetic === true ||
		record.isCompactSummary === true ||
		record.isMeta === true ||
		record.promptSource === "system" ||
		readTranscriptRecord(record.origin)?.kind === "task-notification"
	)
		return null;
	let text = "";
	let messageId = typeof record.uuid === "string" ? record.uuid : typeof record.id === "string" ? record.id : null;
	if (sourceAgentId === "claude") {
		if (record.isSidechain === true || classifyClaudeCodeTranscriptRecord(record) !== "human_typed_turn_boundary")
			return null;
		text = readUserMessageText(record);
	} else if (sourceAgentId === "codex") {
		const payload = readTranscriptRecord(record.payload);
		if (record.type === "event_msg" && payload?.type === "user_message") {
			text = readTextBlocks(payload.message);
		} else if (record.type === "response_item" && payload?.type === "message" && payload.role === "user") {
			// 注入上下文与用户原文可各占一个块，逐块排除后保留能确认的用户文字。
			text = readTextBlocks(payload.content, isCodexTextBlockEligibleForUserPromptEvidence);
			if (typeof payload.id === "string") messageId = payload.id;
		} else return null;
	} else {
		if (record.isCompactSummary === true || record.promptSource === "system") return null;
		const message = readTranscriptRecord(record.message) ?? record;
		if (message.role !== "user") return null;
		// OMP 的自动注入也可用 user 角色；来源缺省的历史真人输入仍然有效。
		if (
			sourceAgentId === "omp" &&
			(message.synthetic === true || (message.attribution !== undefined && message.attribution !== "user"))
		)
			return null;
		text = readTextBlocks(message.content ?? message.message);
	}
	if (!text.trim() || text.trimStart().startsWith("<task-notification>")) return null;
	const timestamp = record.timestamp ?? record.createdAt;
	const parsedTimestamp =
		typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
	return {
		text,
		submittedAtEpochMs: Number.isFinite(parsedTimestamp) ? parsedTimestamp : null,
		messageId,
	};
}
