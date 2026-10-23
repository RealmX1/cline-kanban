import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { readAppendedCompleteJsonLines } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import type { RuntimeAgentNativeConversationSessionIdentity } from "../core/api-contract";
import { runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { loadPersistedWorkspaceSessionsById } from "../state/workspace-state";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

export interface TaskUserPromptForDraftUsage {
	text: string;
	sourceAgentId: string;
	nativeSessionId: string | null;
	messageId: string;
	submittedAtEpochMs: number | null;
}

export { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

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
					const lastEvent = events.at(-1);
					if (lastEvent) cursor = lastEvent.globalCommittedEventSequence;
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
