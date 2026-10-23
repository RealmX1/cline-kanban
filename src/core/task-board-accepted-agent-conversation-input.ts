import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "./api-contract";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "./session-activity";
import { moveTaskToColumn } from "./task-board-mutations";
import { resolveMainTaskConversationSessionId } from "./task-main-conversation-session-binding";

// 只消费一次可信接受边沿。其后用户手动移列的时间更晚时，旧边沿不能把卡再次弹回。
export function projectTaskBoardAfterAcceptedMainConversationInput(
	board: RuntimeBoardData,
	summary: RuntimeTaskSessionSummary,
): { board: RuntimeBoardData; moved: boolean } {
	const accepted = summary.agentConversationPromptSubmissionAcceptance;
	if (
		accepted?.status !== "accepted" ||
		!accepted.eventId ||
		accepted.confirmedAtMs === undefined ||
		accepted.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		resolveSessionFacets(summary).turnOwner !== "agent" ||
		isParkedAwaitingDispatchedBackgroundWork(summary) ||
		summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover
	)
		return { board, moved: false };
	const taskId = summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId;
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (!card) continue;
		if (
			(column.id !== "review" && column.id !== "validation") ||
			resolveMainTaskConversationSessionId(card) !== summary.taskId ||
			card.updatedAt > accepted.confirmedAtMs
		)
			return { board, moved: false };
		const result = moveTaskToColumn(board, card.id, "in_progress");
		return { board: result.board, moved: result.moved };
	}
	return { board, moved: false };
}
