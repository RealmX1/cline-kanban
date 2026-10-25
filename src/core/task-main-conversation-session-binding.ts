import type {
	RuntimeBoardData,
	RuntimeTaskConversationSessionMetadata,
	RuntimeTaskSessionSummary,
} from "./api-contract";
import {
	isTaskMainSessionHandoverSuspendingAutomaticActions,
	type TaskMainSessionHandoverRecord,
} from "./task-main-session-handover-contract";

export interface TaskMainConversationSessionCardIdentity {
	id: string;
	mainTaskConversationSessionId?: string;
	taskMainSessionHandover?: TaskMainSessionHandoverRecord;
}

export function resolveMainTaskConversationSessionId(card: TaskMainConversationSessionCardIdentity): string {
	return card.mainTaskConversationSessionId ?? card.id;
}

export function doesConversationSessionBelongToTask(
	summary: RuntimeTaskSessionSummary,
	workspaceTaskId: string,
): boolean {
	return (
		summary.taskConversationSessionMetadata?.workspaceTaskId === workspaceTaskId ||
		(summary.taskId === workspaceTaskId && !summary.taskConversationSessionMetadata)
	);
}

export function resolveMainTaskConversationSessionSummary(
	card: TaskMainConversationSessionCardIdentity,
	sessions: Readonly<Record<string, RuntimeTaskSessionSummary>>,
): RuntimeTaskSessionSummary | null {
	return resolveTaskChatMessageTargetConversationSessionSummary(card, sessions);
}

export function resolveTaskChatMessageTargetConversationSessionSummary(
	card: TaskMainConversationSessionCardIdentity,
	sessions: Readonly<Record<string, RuntimeTaskSessionSummary>>,
	targetTaskConversationSessionId?: string,
	getCurrentTaskSessionSummary?: (sessionId: string) => RuntimeTaskSessionSummary | null,
): RuntimeTaskSessionSummary | null {
	const sessionId = targetTaskConversationSessionId ?? resolveMainTaskConversationSessionId(card);
	// 活动 manager 的摘要优先；它已存在但归属或 ID 不符时，不能用陈旧持久摘要放行。
	const summary = getCurrentTaskSessionSummary?.(sessionId) ?? sessions[sessionId];
	return summary?.taskId === sessionId && doesConversationSessionBelongToTask(summary, card.id) ? summary : null;
}

export function projectConversationSessionMetadataForMainSessionBinding(
	card: TaskMainConversationSessionCardIdentity,
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskConversationSessionMetadata | undefined {
	if (
		(!card.mainTaskConversationSessionId && !card.taskMainSessionHandover) ||
		!doesConversationSessionBelongToTask(summary, card.id)
	) {
		return summary.taskConversationSessionMetadata;
	}
	const previous = summary.taskConversationSessionMetadata;
	const roleAtCreation =
		previous?.taskConversationSessionRoleAtCreation ??
		(summary.taskId === card.taskMainSessionHandover?.targetTaskConversationSessionId
			? "task_collaborator"
			: summary.taskId === card.taskMainSessionHandover?.sourceTaskConversationSessionId
				? "main"
				: (previous?.taskConversationSessionRole ?? "main"));
	const role =
		summary.taskId === resolveMainTaskConversationSessionId(card)
			? "main"
			: roleAtCreation === "by_the_way"
				? "by_the_way"
				: "task_collaborator";
	const suspended = isTaskMainSessionHandoverSuspendingAutomaticActions(card);
	const hasHeldMainResponsibility =
		previous?.taskConversationSessionHasHeldMainResponsibility === true ||
		roleAtCreation === "main" ||
		role === "main" ||
		summary.taskId === card.taskMainSessionHandover?.sourceTaskConversationSessionId;
	if (
		previous?.taskConversationSessionRole === role &&
		previous.taskConversationSessionRoleAtCreation === roleAtCreation &&
		previous.taskConversationSessionHasHeldMainResponsibility === hasHeldMainResponsibility &&
		previous.taskAutomationSuspendedForMainSessionHandover === suspended
	) {
		return previous;
	}
	return {
		workspaceTaskId: card.id,
		taskConversationSessionContextSource: "main",
		parentTaskConversationSessionId: null,
		mainSessionOriginTurnNumber: null,
		mainSessionOriginUserMessagePreview: null,
		latestUserMessagePreview: null,
		...previous,
		taskConversationSessionRole: role,
		taskConversationSessionRoleAtCreation: roleAtCreation,
		taskConversationSessionHasHeldMainResponsibility: hasHeldMainResponsibility,
		taskAutomationSuspendedForMainSessionHandover: suspended,
	};
}

export function resolveMainTaskConversationSessionSummaryForTaskId(
	board: RuntimeBoardData,
	sessions: Readonly<Record<string, RuntimeTaskSessionSummary>>,
	taskId: string,
): RuntimeTaskSessionSummary | null {
	const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
	return card ? resolveMainTaskConversationSessionSummary(card, sessions) : null;
}

// 角色只是绑定的读模型。入口与旧客户端保存均重投影，不能凭陈旧 role 重新获得主卡权限。
export function projectTaskConversationSessionsForMainSessionBinding(
	board: { columns: readonly { cards: readonly TaskMainConversationSessionCardIdentity[] }[] },
	sessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	let projected = sessions;
	for (const card of board.columns.flatMap((column) => column.cards)) {
		if (!card.mainTaskConversationSessionId && !card.taskMainSessionHandover) continue;
		for (const summary of Object.values(sessions)) {
			const metadata = projectConversationSessionMetadataForMainSessionBinding(card, summary);
			if (metadata === summary.taskConversationSessionMetadata) continue;
			if (projected === sessions) projected = { ...sessions };
			projected[summary.taskId] = { ...summary, taskConversationSessionMetadata: metadata };
		}
	}
	return projected;
}

export function preserveRuntimeOwnedMainSessionBindings(
	persistedBoard: RuntimeBoardData,
	incomingBoard: RuntimeBoardData,
): RuntimeBoardData {
	const persistedCards = new Map(
		persistedBoard.columns.flatMap((column) => column.cards.map((card) => [card.id, card])),
	);
	return {
		...incomingBoard,
		columns: incomingBoard.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => ({
				...card,
				mainTaskConversationSessionId: persistedCards.get(card.id)?.mainTaskConversationSessionId,
				agentId: persistedCards.get(card.id)?.mainTaskConversationSessionId
					? persistedCards.get(card.id)?.agentId
					: card.agentId,
				taskMainSessionHandover: persistedCards.get(card.id)?.taskMainSessionHandover,
				independentTaskCreationProvenance: persistedCards.get(card.id)?.independentTaskCreationProvenance,
			})),
		})),
	};
}
