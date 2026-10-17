import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import {
	classifyClaudeCodeTranscriptRecord,
	readAppendedCompleteJsonLines,
	readUserMessageText,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import type { RuntimeAgentNativeConversationSessionIdentity } from "../core/api-contract";
import { runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { loadPersistedWorkspaceSessionsById } from "../state/workspace-state";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";

export interface TaskUserPromptForDraftUsage {
	text: string;
	sourceAgentId: string;
	nativeSessionId: string | null;
	messageId: string;
	submittedAtEpochMs: number | null;
}

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

/** 只读用户文字块；工具结果、压缩摘要与 harness 通知不能成为草稿使用证据。 */
export function extractSubmittedUserPromptFromTranscriptRecord(
	sourceAgentId: string,
	record: Record<string, unknown>,
): { text: string; submittedAtEpochMs: number | null; messageId: string | null } | null {
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

export interface TaskUserPromptHistoryReadResult {
	prompts: AsyncIterable<TaskUserPromptForDraftUsage>;
	// 原生身份没有路径、格式不支持或历史账本不可用均如实计入，不当作「完整检查后未命中」。
	warnings: string[];
}

export async function readTaskUserPromptHistoryForDraftUsage(input: {
	workspaceId: string;
	taskId: string;
	currentIdentity?: RuntimeAgentNativeConversationSessionIdentity | null;
	isCancelled?: () => boolean;
}): Promise<TaskUserPromptHistoryReadResult> {
	const warnings: string[] = [];
	const identities = new Map<string, RuntimeAgentNativeConversationSessionIdentity>();
	const remember = (identity: RuntimeAgentNativeConversationSessionIdentity) => {
		const key = `${identity.sourceAgentId}:${identity.nativeSessionId}`;
		identities.set(key, {
			...identity,
			transcriptPath: identity.transcriptPath ?? identities.get(key)?.transcriptPath ?? null,
		});
	};
	const summaries = await loadPersistedWorkspaceSessionsById(input.workspaceId);
	const belongingSessionIds = new Set([input.taskId]);
	for (const summary of Object.values(summaries)) {
		if (
			summary.taskId === input.taskId ||
			summary.taskConversationSessionMetadata?.workspaceTaskId === input.taskId
		) {
			belongingSessionIds.add(summary.taskId);
			if (summary.agentNativeConversationSessionIdentity) remember(summary.agentNativeConversationSessionIdentity);
		}
	}
	try {
		await runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(async (client) => {
			for (const sessionId of belongingSessionIds) {
				let cursor = 0;
				for (;;) {
					if (input.isCancelled?.()) return;
					const events = await client.listCommittedEvents({
						subjectWorkspaceId: input.workspaceId,
						subjectTaskId: sessionId,
						afterGlobalCommittedEventSequence: cursor,
						limit: 500,
					});
					for (const event of events) {
						if (event.eventFamily !== "agent_conversation_session_identity_event") continue;
						const key = readTranscriptRecord(event.eventPayload.conversationSessionIdentityKey);
						if (
							typeof key?.conversationSessionHostKanbanAgentId !== "string" ||
							typeof key.nativeConversationSessionId !== "string"
						)
							continue;
						remember({
							sourceAgentId: key.conversationSessionHostKanbanAgentId,
							nativeSessionId: key.nativeConversationSessionId,
							transcriptPath:
								typeof event.eventPayload.agentNativeConversationSessionTranscriptPath === "string"
									? event.eventPayload.agentNativeConversationSessionTranscriptPath
									: null,
							observedAt: event.occurredAt,
						});
					}
					if (events.length < 500) break;
					cursor = events[events.length - 1].globalCommittedEventSequence;
				}
			}
		});
	} catch {
		warnings.push("native_session_identity_history_unavailable");
	}
	if (input.currentIdentity) remember(input.currentIdentity);
	if (identities.size === 0) warnings.push("no_confirmed_native_conversation_identity");

	async function* prompts(): AsyncGenerator<TaskUserPromptForDraftUsage> {
		for (const identity of identities.values()) {
			const path = identity.transcriptPath;
			if (!path || !path.endsWith(".jsonl")) {
				warnings.push(`unsupported_or_missing_transcript:${identity.sourceAgentId}:${identity.nativeSessionId}`);
				continue;
			}
			try {
				const signatureBeforeRead = await stat(path);
				let offset = 0;
				let rejectedDescendantSession = false;
				while (offset < signatureBeforeRead.size && !input.isCancelled?.()) {
					const chunk = await readAppendedCompleteJsonLines(path, offset);
					if (chunk.nextByteOffset <= offset) {
						if (chunk.appendedBytesRemainBeyondIncrementalReadBudget)
							warnings.push(`transcript_line_exceeds_read_budget:${identity.nativeSessionId}`);
						break;
					}
					for (const line of chunk.completeLines) {
						const record = parseTranscriptJsonRecord(line);
						if (!record) continue;
						if (identity.sourceAgentId === "codex" && record.type === "session_meta") {
							const payload = readTranscriptRecord(record.payload);
							const source = readTranscriptRecord(payload?.source);
							rejectedDescendantSession =
								(payload?.thread_source !== undefined && payload.thread_source !== "user") ||
								source?.subagent !== undefined;
						}
						if (rejectedDescendantSession) break;
						const prompt = extractSubmittedUserPromptFromTranscriptRecord(identity.sourceAgentId, record);
						if (prompt)
							yield {
								...prompt,
								sourceAgentId: identity.sourceAgentId,
								nativeSessionId: identity.nativeSessionId,
								messageId: prompt.messageId ?? createHash("sha256").update(line).digest("hex"),
							};
					}
					if (rejectedDescendantSession) {
						warnings.push(`descendant_session_excluded:${identity.nativeSessionId}`);
						break;
					}
					offset = chunk.nextByteOffset;
					await setImmediate();
				}
			} catch {
				warnings.push(`transcript_unreadable:${identity.sourceAgentId}:${identity.nativeSessionId}`);
			}
		}
	}
	return { prompts: prompts(), warnings };
}
