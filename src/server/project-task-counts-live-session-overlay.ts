import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectTaskCounts,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";

// 把「实时会话回合状态」叠加到持久化的按列任务计数上。board 落盘时记录的列归属可能落后于 agent
// 实时回合：停在 in_progress 但已转入待审的任务应记入 review，被中断的任务应记入 trash。
//
// 真相源为双轴 facet（resolveSessionFacets），与旧 legacy `state` 读逐项等价（行为保持迁移，
// 同 board-card-session-activity / agent-terminal-panel 一脉）：
//   - 旧 state==="awaiting_review" ⟺ isAwaitingUserReviewTurn(facets)（user 回合且未落终止态
//     failed/interrupted；涵盖 live 与 exited——与旧 projectLegacyState 把这两者压扁为 awaiting_review
//     的有损投影完全一致，故对 live↔exited 不敏感、零行为漂移）；
//   - 旧 state==="interrupted" ⟺ turnOwner==="user" && liveness==="interrupted"
//     （interrupted 仅由 user+interrupted 投影产生，唯一来源）。
// 纯函数：无 I/O、无闭包状态，可独立单测（见 project-task-counts-live-session-overlay.test.ts）。
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
	for (const summary of Object.values(sessionSummaries)) {
		const columnId = taskColumnById.get(summary.taskId);
		if (!columnId) {
			continue;
		}
		const facets = resolveSessionFacets(summary);
		// 待审（user 回合、未落 failed/interrupted）且仍停在 in_progress → 计入 review。
		if (isAwaitingUserReviewTurn(facets) && columnId === "in_progress") {
			next.in_progress = Math.max(0, next.in_progress - 1);
			next.review += 1;
			continue;
		}
		// 被中断（user 回合、liveness=interrupted）→ 计入 trash（trash / validation 列除外）。
		if (
			facets.turnOwner === "user" &&
			facets.liveness === "interrupted" &&
			columnId !== "trash" &&
			columnId !== "validation"
		) {
			next[columnId] = Math.max(0, next[columnId] - 1);
			next.trash += 1;
		}
	}
	return next;
}
