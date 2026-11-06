// 各聊天入口共享的 tRPC 操作。
// Detail view and home sidebar both use this to send messages, cancel turns,
// and load history through one runtime contract.
import { useCallback } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	ManagedTaskPromptDeliveryOrigin,
	RuntimeTaskChatMessage,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export interface AgentConversationChatActionResult {
	ok: boolean;
	message?: string;
	chatMessage?: RuntimeTaskChatMessage | null;
}

export interface SendAgentConversationChatMessageOptions {
	deliveryOrigin?: ManagedTaskPromptDeliveryOrigin;
	mode?: RuntimeTaskSessionMode;
	images?: RuntimeTaskImage[];
}

interface UseAgentConversationChatRuntimeActionsInput {
	currentProjectId: string | null;
	onSessionSummary?: (summary: RuntimeTaskSessionSummary) => void;
}

interface UseAgentConversationChatRuntimeActionsResult {
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: SendAgentConversationChatMessageOptions,
	) => Promise<AgentConversationChatActionResult>;
	loadTaskChatMessages: (taskId: string) => Promise<RuntimeTaskChatMessage[] | null>;
	abortTaskChatTurn: (taskId: string) => Promise<AgentConversationChatActionResult>;
	cancelTaskChatTurn: (taskId: string) => Promise<AgentConversationChatActionResult>;
	resolveTaskAgentUserDecision: (
		taskId: string,
		decisionId: string,
		optionId: string | null,
	) => Promise<AgentConversationChatActionResult>;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useAgentConversationChatRuntimeActions({
	currentProjectId,
	onSessionSummary,
}: UseAgentConversationChatRuntimeActionsInput): UseAgentConversationChatRuntimeActionsResult {
	const sendTaskChatMessage = useCallback(
		async (
			taskId: string,
			text: string,
			options?: SendAgentConversationChatMessageOptions,
		): Promise<AgentConversationChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.sendTaskChatMessage.mutate({
					taskId,
					targetTaskConversationSessionId: taskId,
					text,
					deliveryRequestId: createRandomUuidV4WithInsecureContextFallback(),
					...(options?.deliveryOrigin ? { deliveryOrigin: options.deliveryOrigin } : {}),
					...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
					...(options?.mode ? { mode: options.mode } : {}),
				});
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Task chat message failed." };
				}
				if (payload.summary) {
					onSessionSummary?.(payload.summary);
				}
				return {
					ok: true,
					chatMessage: payload.message ?? null,
				};
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, onSessionSummary],
	);

	const loadTaskChatMessages = useCallback(
		async (taskId: string): Promise<RuntimeTaskChatMessage[] | null> => {
			if (!currentProjectId) {
				return null;
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.getTaskChatMessages.query({ taskId });
				return payload.ok ? payload.messages : null;
			} catch {
				return null;
			}
		},
		[currentProjectId],
	);

	const abortTaskChatTurn = useCallback(
		async (taskId: string): Promise<AgentConversationChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.abortTaskChatTurn.mutate({ taskId });
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Could not abort chat turn." };
				}
				if (payload.summary) {
					onSessionSummary?.(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, onSessionSummary],
	);

	// ACP agent 在等用户拍板（工具授权 / 计划批准）时把决策回传给它。
	const resolveTaskAgentUserDecision = useCallback(
		async (
			taskId: string,
			decisionId: string,
			optionId: string | null,
		): Promise<AgentConversationChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.resolveTaskAgentUserDecision.mutate({
					taskId,
					decisionId,
					outcome: optionId ? "selected" : "cancelled",
					...(optionId ? { optionId } : {}),
				});
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Could not send that decision to the agent." };
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId],
	);

	const cancelTaskChatTurn = useCallback(
		async (taskId: string): Promise<AgentConversationChatActionResult> => {
			if (!currentProjectId) {
				return { ok: false, message: "No project selected." };
			}
			try {
				const payload = await getRuntimeTrpcClient(currentProjectId).runtime.cancelTaskChatTurn.mutate({ taskId });
				if (!payload.ok) {
					return { ok: false, message: payload.error ?? "Could not cancel chat turn." };
				}
				if (payload.summary) {
					onSessionSummary?.(payload.summary);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, message: toErrorMessage(error) };
			}
		},
		[currentProjectId, onSessionSummary],
	);

	return {
		resolveTaskAgentUserDecision,
		sendTaskChatMessage,
		loadTaskChatMessages,
		abortTaskChatTurn,
		cancelTaskChatTurn,
	};
}
