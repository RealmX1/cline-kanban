import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectTaskCounts,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";
import { resolveMainTaskConversationSessionSummary } from "../core/task-main-conversation-session-binding";

// 待审会话可把 in_progress 计数叠加到 review；会话中断保留原列计数。
// 已结案计数只能来自持久看板的显式结案，不从会话存活状态推断。
export function applyLiveSessionStateToProjectTaskCounts(
	counts: RuntimeProjectTaskCounts,
	board: RuntimeBoardData,
	sessionSummaries: RuntimeWorkspaceStateResponse["sessions"],
): RuntimeProjectTaskCounts {
	const taskColumnById = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskColumnById.set(card.id, column.id);
		}
	}
	const next = {
		...counts,
	};
	for (const card of board.columns.flatMap((column) => column.cards)) {
		const summary = resolveMainTaskConversationSessionSummary(card, sessionSummaries);
		if (!summary) continue;
		const columnId = taskColumnById.get(card.id);
		if (!columnId) {
			continue;
		}
		const facets = resolveSessionFacets(summary);
		// 待审（user 回合、未落 failed/interrupted）且仍停在 in_progress → 计入 review。
		if (isAwaitingUserReviewTurn(facets) && columnId === "in_progress") {
			next.in_progress = Math.max(0, next.in_progress - 1);
			next.review += 1;
		}
	}
	return next;
}
