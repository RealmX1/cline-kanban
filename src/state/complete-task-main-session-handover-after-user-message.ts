import type { RuntimeTaskConversationSessionMetadata } from "../core/api-contract";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "./workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceBoardById, mutateWorkspaceState } from "./workspace-state";

// 聊天 API 与终端原生输入接受证明共用；前置 UserPromptSubmit 不完成交接。报告标记排除机器首轮。
export async function completeTaskMainSessionHandoverAfterUserMessage(input: {
	workspaceId: string;
	workspacePath: string;
	taskConversationSessionId: string;
	promptText: string | undefined;
	expectedHandoverId?: string;
	// 接受证据读取跨 await 时，由调用方在持久化锁内复核仍是同一原生活体。
	isAcceptedConversationIdentityStillCurrent?: () => boolean;
	onTaskConversationSessionMetadataChanged?: (
		sessionId: string,
		metadata: RuntimeTaskConversationSessionMetadata,
	) => void;
}): Promise<RuntimeTaskConversationSessionMetadata | null> {
	if (!input.promptText?.trim() || input.promptText.includes("KANBAN_MAIN_SESSION_HANDOVER_REPORT:")) return null;
	const board = await loadWorkspaceBoardById(input.workspaceId);
	const card = board.columns
		.flatMap((column) => column.cards)
		.find(
			(entry) =>
				entry.mainTaskConversationSessionId === input.taskConversationSessionId &&
				entry.taskMainSessionHandover &&
				(input.expectedHandoverId === undefined ||
					entry.taskMainSessionHandover.handoverId === input.expectedHandoverId) &&
				["report_delivery_pending", "awaiting_user_message", "failed"].includes(
					entry.taskMainSessionHandover.status,
				),
		);
	if (!card) return null;
	const result = await mutateWorkspaceState(
		input.workspacePath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"runtime_complete_main_session_handover_after_user_message",
			"main_session_handover_user_message",
		),
		(state) => {
			// 原生接受证明与异步提交回执可能同时到达；锁内重查，后到者不重写完成时刻。
			// 也不能让旧投递的迟到回执完成同一目标会话上的新一轮交接。
			const currentCard = state.board.columns
				.flatMap((column) => column.cards)
				.find((entry) => entry.id === card.id);
			const currentHandover = currentCard?.taskMainSessionHandover;
			if (
				input.isAcceptedConversationIdentityStillCurrent?.() === false ||
				!currentHandover ||
				currentHandover.handoverId !== card.taskMainSessionHandover?.handoverId ||
				currentCard.mainTaskConversationSessionId !== input.taskConversationSessionId ||
				!["report_delivery_pending", "awaiting_user_message", "failed"].includes(currentHandover.status)
			) {
				return { board: state.board, value: false, save: false };
			}
			return {
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((entry) =>
							entry.id === card.id
								? {
										...entry,
										taskMainSessionHandover: {
											...currentHandover,
											status: "completed" as const,
											automaticRecovery: undefined,
											errorMessage: null,
											updatedAt: Date.now(),
										},
									}
								: entry,
						),
					})),
				},
				value: true,
			};
		},
	);
	if (!result.value) return null;
	for (const session of Object.values(result.state.sessions)) {
		if (session.taskConversationSessionMetadata?.workspaceTaskId === card.id) {
			input.onTaskConversationSessionMetadataChanged?.(session.taskId, session.taskConversationSessionMetadata);
		}
	}
	return result.state.sessions[input.taskConversationSessionId]?.taskConversationSessionMetadata ?? null;
}
