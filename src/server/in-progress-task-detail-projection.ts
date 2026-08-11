import type {
	RuntimeBoardData,
	RuntimeInProgressTaskDetail,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";

// 把 board `in_progress` 列的全部 task 投影为 Cross-Repository Stage-First Overview（见 CONTEXT.md）
// 所需的精简明细。按「列归属」判定成员——in_progress 列有几张卡就出几条，awaiting_review / interrupted
// 的卡也一并保留（**不**套用主看板的 live-session overlay，见 ADR-0001）；前端据 turnOwner + lastOutputAt
// 把它们二分为 Active / Stale。turnOwner/liveness 经 facet 真相源 resolveSessionFacets 解析，无 session 的
// 卡回退 turnOwner=null / liveness=none。agentId 优先取运行时 session、回退卡片声明。
//
// 纯函数：无 I/O、无闭包状态，可独立单测（见 in-progress-task-detail-projection.test.ts）。
export function collectInProgressTaskDetailsFromBoard(
	board: RuntimeBoardData,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
): RuntimeInProgressTaskDetail[] {
	const inProgressColumn = board.columns.find((column) => column.id === "in_progress");
	if (!inProgressColumn) {
		return [];
	}
	return inProgressColumn.cards.map((card) => {
		const summary = sessions[card.id];
		const facets = summary ? resolveSessionFacets(summary) : null;
		return {
			taskId: card.id,
			title: card.title,
			agentId: summary?.agentId ?? card.agentId ?? null,
			createdAt: card.createdAt,
			lastOutputAt: summary?.lastOutputAt ?? null,
			lastSubstantiveOutputAt: summary?.lastSubstantiveOutputAt ?? null,
			// 概览行与主看板卡片头部显示同样的两颗时长药丸，故两个量都要投影过来。
			// 只投影、不在此合并或推断——合并是 mergeSummaryWithFacets 里那个唯一 reducer 的事。
			agentResponseGenerationStopped: summary?.agentResponseGenerationStopped ?? null,
			lastConversationProgressObservation: summary?.lastConversationProgressObservation ?? null,
			turnOwner: facets?.turnOwner ?? null,
			liveness: facets?.liveness ?? "none",
		};
	});
}
