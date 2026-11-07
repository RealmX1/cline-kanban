import { loadTaskConversationHistoryPage } from "../agent-session-history/task-conversation-history-page";
import { classifyConversationTurnBoundaryMessage } from "../conversation-tree/conversation-turn-projection";
import type { RuntimeBoardCard, RuntimeTaskChatMessage, RuntimeTaskSessionSummary } from "../core/api-contract";
import { isAgentAwaitingModalUserDecision, resolveSessionFacets } from "../core/session-activity";
import type { TaskSessionIntentMaterial } from "../core/task-indexing-support-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";

export function projectTaskSessionIntentMessages(
	messages: readonly RuntimeTaskChatMessage[],
	finalTurnIsInProgress = false,
): TaskSessionIntentMaterial["messages"] {
	const intentMessages: TaskSessionIntentMaterial["messages"] = [];
	const questionCallIds = new Set<string>();
	let turnUserMessageId: string | null = null;
	let finalResponse: RuntimeTaskChatMessage | undefined;
	const appendFinalResponse = (isInProgress = false) => {
		if (
			finalResponse &&
			turnUserMessageId &&
			(!isInProgress || ["final", "final_answer"].includes(finalResponse.meta?.nativeMessagePhase ?? ""))
		)
			intentMessages.push({
				kind: "agent_turn_final_response",
				sourceMessageId: finalResponse.id,
				turnUserMessageId,
				text: finalResponse.content,
			});
		finalResponse = undefined;
	};
	for (const message of messages) {
		if (classifyConversationTurnBoundaryMessage(message)) {
			appendFinalResponse();
			turnUserMessageId = message.id;
			intentMessages.push({
				kind: "user_prompt",
				sourceMessageId: message.id,
				turnUserMessageId,
				text: message.content,
			});
		} else if (message.role === "assistant" && message.meta?.nativeMessagePhase !== "commentary") {
			finalResponse = message;
		} else if (message.role === "tool" && message.meta?.toolCallId) {
			const toolName = message.meta.toolName?.split(".").at(-1);
			const isQuestion =
				!questionCallIds.has(message.meta.toolCallId) &&
				["AskUserQuestion", "request_user_input", "request_user_input_async"].includes(toolName ?? "");
			if (isQuestion) questionCallIds.add(message.meta.toolCallId);
			if (isQuestion || questionCallIds.has(message.meta.toolCallId))
				intentMessages.push({
					kind: isQuestion ? "user_question" : "user_question_answer",
					sourceMessageId: message.id,
					turnUserMessageId,
					questionToolCallId: message.meta.toolCallId,
					text: message.content,
				});
		}
	}
	appendFinalResponse(finalTurnIsInProgress);
	return intentMessages;
}

export async function readTaskSessionIntentMaterial(input: {
	card: RuntimeBoardCard;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	abortSignal?: AbortSignal;
}): Promise<{ sessionIntent: TaskSessionIntentMaterial; missingContextParts: string[] }> {
	const taskConversationSessionId = resolveMainTaskConversationSessionId(input.card);
	const pages: RuntimeTaskChatMessage[][] = [];
	const missingContextParts: string[] = [];
	let cursor: string | null = null;
	let scannedMessageByteCount = 0;
	// EXPERIMENT_NODE: Intent System 建模后替换此来源；内容查询另接 agentic search（脚本 grep）与 Embedding/RAG。
	for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
		input.abortSignal?.throwIfAborted();
		const page = await loadTaskConversationHistoryPage({
			card: input.card,
			sessions: input.sessions,
			request: {
				workspaceTaskId: input.card.id,
				taskConversationSessionId,
				transcriptReadConsistency: "stable_snapshot",
				cursor,
			},
		});
		if (page.availability !== "available")
			missingContextParts.push(`session_intent_${page.unavailabilityReason ?? "source"}_unavailable`);
		pages.push(page.messages);
		cursor = page.nextCursor;
		if (!cursor) break;
		scannedMessageByteCount += Buffer.byteLength(JSON.stringify(page.messages));
		if (pageNumber === 63 || scannedMessageByteCount >= 16 * 1024 * 1024) {
			missingContextParts.push("session_intent_scan_bounded");
			break;
		}
	}
	const summary = input.sessions[taskConversationSessionId];
	const mainTaskConversationSessionFacets = summary ? resolveSessionFacets(summary) : null;
	const messages = projectTaskSessionIntentMessages(
		pages.reverse().flat(),
		mainTaskConversationSessionFacets
			? mainTaskConversationSessionFacets.turnOwner === "agent" ||
					isAgentAwaitingModalUserDecision(mainTaskConversationSessionFacets)
			: false,
	);
	if (!messages.length) missingContextParts.push("session_intent_messages_unavailable");
	return {
		sessionIntent: {
			taskConversationSessionId,
			nativeSessionId:
				input.sessions[taskConversationSessionId]?.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
			messages,
		},
		missingContextParts: [...new Set(missingContextParts)],
	};
}
