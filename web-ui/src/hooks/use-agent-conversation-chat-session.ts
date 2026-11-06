// 管理结构化会话的消息列表、发送与取消。
// It merges loaded history with streamed updates and guards against stale task
// switches so chat surfaces can stay reactive without duplicating logic.
import { useCallback, useEffect, useState } from "react";
import type { AgentConversationChatActionResult } from "@/hooks/use-agent-conversation-chat-runtime-actions";
import type { RuntimeTaskChatMessage, RuntimeTaskImage, RuntimeTaskSessionMode } from "@/runtime/types";

export type AgentConversationChatMessage = RuntimeTaskChatMessage;

interface UseAgentConversationChatSessionInput {
	taskId: string;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<AgentConversationChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<AgentConversationChatMessage[] | null>;
	incomingMessages?: AgentConversationChatMessage[] | null;
	incomingMessage?: AgentConversationChatMessage | null;
}

interface UseAgentConversationChatSessionResult {
	messages: AgentConversationChatMessage[];
	isSending: boolean;
	isCanceling: boolean;
	error: string | null;
	sendMessage: (
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<boolean>;
	cancelTurn: () => Promise<boolean>;
}

function areMessagesEqual(left: AgentConversationChatMessage, right: AgentConversationChatMessage): boolean {
	return (
		left.content === right.content &&
		left.role === right.role &&
		left.createdAt === right.createdAt &&
		JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null)
	);
}

function upsertMessage(
	currentMessages: AgentConversationChatMessage[],
	nextMessage: AgentConversationChatMessage,
): AgentConversationChatMessage[] {
	const existingIndex = currentMessages.findIndex((message) => message.id === nextMessage.id);
	if (existingIndex < 0) {
		return [...currentMessages, nextMessage];
	}
	const existingMessage = currentMessages[existingIndex];
	// 流式 chunk 常会带着同一引用重发同一条消息：引用相等时直接短路，跳过 areMessagesEqual 的字段比对与 JSON.stringify(meta)。
	if (existingMessage === nextMessage || !existingMessage || areMessagesEqual(existingMessage, nextMessage)) {
		return currentMessages;
	}
	const nextMessages = [...currentMessages];
	nextMessages[existingIndex] = nextMessage;
	return nextMessages;
}

function mergeMessages(
	baseMessages: AgentConversationChatMessage[],
	additionalMessages: AgentConversationChatMessage[],
): AgentConversationChatMessage[] {
	return additionalMessages.reduce((nextMessages, message) => upsertMessage(nextMessages, message), [...baseMessages]);
}

export function useAgentConversationChatSession({
	taskId,
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
}: UseAgentConversationChatSessionInput): UseAgentConversationChatSessionResult {
	const [messages, setMessages] = useState<AgentConversationChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [isCanceling, setIsCanceling] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setMessages([]);
		setError(null);
	}, [taskId]);

	useEffect(() => {
		if (!onLoadMessages) {
			setMessages([]);
			return;
		}
		setError(null);
		let cancelled = false;
		setIsLoading(true);
		void onLoadMessages(taskId)
			.then((loadedMessages) => {
				if (cancelled) {
					return;
				}
				setMessages((currentMessages) => mergeMessages(loadedMessages ?? [], currentMessages));
			})
			.catch((loadError) => {
				if (cancelled) {
					return;
				}
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				setError(message);
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [onLoadMessages, taskId]);

	useEffect(() => {
		if (incomingMessages === null) {
			return;
		}
		if (incomingMessages.length === 0) {
			setMessages([]);
			return;
		}
		setMessages((currentMessages) => mergeMessages(currentMessages, incomingMessages));
	}, [incomingMessages]);

	useEffect(() => {
		if (!incomingMessage) {
			return;
		}
		setMessages((currentMessages) => upsertMessage(currentMessages, incomingMessage));
	}, [incomingMessage]);

	const cancelTurn = useCallback(async (): Promise<boolean> => {
		if (!onCancelTurn || isCanceling) {
			return false;
		}
		setError(null);
		setIsCanceling(true);
		try {
			const result = await onCancelTurn(taskId);
			if (!result.ok) {
				setError(result.message ?? "Could not cancel turn.");
				return false;
			}
			return true;
		} catch (cancelError) {
			const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
			setError(message);
			return false;
		} finally {
			setIsCanceling(false);
		}
	}, [isCanceling, onCancelTurn, taskId]);

	const sendMessage = useCallback(
		async (
			text: string,
			options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
		): Promise<boolean> => {
			const trimmed = text.trim();
			const hasImages = Boolean(options?.images && options.images.length > 0);
			if ((!trimmed && !hasImages) || !onSendMessage) {
				return false;
			}

			setError(null);
			setIsSending(true);

			try {
				const result = options
					? await onSendMessage(taskId, trimmed, options)
					: await onSendMessage(taskId, trimmed);
				if (!result.ok) {
					const message = result.message ?? "Could not send message.";
					setError(message);
					return false;
				}
				const sentMessage = result.chatMessage ?? null;
				if (sentMessage) {
					setMessages((currentMessages) => upsertMessage(currentMessages, sentMessage));
				} else if (onLoadMessages) {
					const loadedMessages = await onLoadMessages(taskId);
					setMessages(loadedMessages ?? []);
				}
				return true;
			} catch (sendError) {
				const message = sendError instanceof Error ? sendError.message : String(sendError);
				setError(message);
				return false;
			} finally {
				setIsSending(false);
			}
		},
		[onLoadMessages, onSendMessage, taskId],
	);

	return {
		messages,
		isSending: isSending || isLoading,
		isCanceling,
		error,
		sendMessage,
		cancelTurn,
	};
}
