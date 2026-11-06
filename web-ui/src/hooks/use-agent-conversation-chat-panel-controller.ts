// 为共享结构化聊天面板构建视图状态。
// Keep panel-specific UI state here so the panel component can stay mostly
// declarative and shared across detail and sidebar surfaces.

import { resolveSessionFacets } from "@runtime-session-activity";
import { useCallback, useState } from "react";

import type { AgentConversationChatActionResult } from "@/hooks/use-agent-conversation-chat-runtime-actions";
import {
	type AgentConversationChatMessage,
	useAgentConversationChatSession,
} from "@/hooks/use-agent-conversation-chat-session";
import type { RuntimeTaskImage, RuntimeTaskSessionMode, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";

interface UseAgentConversationChatPanelControllerInput {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<AgentConversationChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<AgentConversationChatMessage[] | null>;
	incomingMessages?: AgentConversationChatMessage[] | null;
	incomingMessage?: AgentConversationChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	onMoveToTrash?: () => void;
	onMoveToValidation?: () => void;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
	showMoveToValidation?: boolean;
}

interface UseAgentConversationChatPanelControllerResult {
	draft: string;
	setDraft: (draft: string) => void;
	messages: AgentConversationChatMessage[];
	error: string | null;
	isSending: boolean;
	isCanceling: boolean;
	canSend: boolean;
	canCancel: boolean;
	showReviewActions: boolean;
	showAgentProgressIndicator: boolean;
	showActionFooter: boolean;
	showCancelAutomaticAction: boolean;
	handleSendText: (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleSendDraft: (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleCancelTurn: () => void;
}

export function useAgentConversationChatPanelController({
	taskId,
	summary,
	taskColumnId = "in_progress",
	onSendMessage,
	onCancelTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
	onCommit,
	onOpenPr,
	onMoveToTrash,
	onMoveToValidation,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash = false,
	showMoveToValidation = false,
}: UseAgentConversationChatPanelControllerInput): UseAgentConversationChatPanelControllerResult {
	const [draft, setDraft] = useState("");
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const { messages, isSending, isCanceling, error, sendMessage, cancelTurn } = useAgentConversationChatSession({
		taskId,
		onSendMessage,
		onCancelTurn,
		onLoadMessages,
		incomingMessages,
		incomingMessage,
	});
	const canSend = Boolean(onSendMessage) && !isSending && !isCanceling;
	// 旧 `state==="running"` → facet 真相源 turnOwner==="agent"（running 是 agent 回合唯一来源，严格等价）。
	const isAgentTurn = summary ? resolveSessionFacets(summary).turnOwner === "agent" : false;
	const canCancel = Boolean(onCancelTurn) && isAgentTurn && !isCanceling;
	const showReviewActions =
		taskColumnId === "review" &&
		(reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0 &&
		Boolean(onCommit) &&
		Boolean(onOpenPr);
	const showAgentProgressIndicator = isAgentTurn;
	const showActionFooter =
		(showMoveToTrash && Boolean(onMoveToTrash)) || (showMoveToValidation && Boolean(onMoveToValidation));
	const showCancelAutomaticAction = Boolean(cancelAutomaticActionLabel && onCancelAutomaticAction);

	const handleSendText = useCallback(
		async (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			return sendMessage(
				text,
				mode || images?.length
					? {
							...(mode ? { mode } : {}),
							...(images?.length ? { images } : {}),
						}
					: undefined,
			);
		},
		[sendMessage],
	);

	const handleSendDraft = useCallback(
		async (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			const sent = await handleSendText(draft, mode, images);
			if (sent) {
				setDraft("");
			}
			return sent;
		},
		[draft, handleSendText],
	);

	const handleCancelTurn = useCallback(() => {
		void cancelTurn();
	}, [cancelTurn]);

	return {
		draft,
		setDraft,
		messages,
		error,
		isSending,
		isCanceling,
		canSend,
		canCancel,
		showReviewActions,
		showAgentProgressIndicator,
		showActionFooter,
		showCancelAutomaticAction,
		handleSendText,
		handleSendDraft,
		handleCancelTurn,
	};
}
