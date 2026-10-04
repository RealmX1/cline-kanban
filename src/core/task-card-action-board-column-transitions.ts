import type { RuntimeBoardColumnId } from "./api-contract";

// 「用户手势请求把一张卡从 A 列放到 B 列」该由哪条 `taskCardAction.*` procedure 执行。
//
// 为什么集中在 core：看板拖放、卡片按钮、Focus View、跨项目面板与 kanban CLI 都要回答同一个问题——
// 这次移列有没有会话副作用、走哪个服务端动作。语义源自浏览器的 drag-rules.ts（isAllowedCrossColumnCardMove /
// isCardDropDisabled）与 use-board-interactions 的各移列入口；服务端按这里校验，浏览器之后改为直接引用本模块
// （web-ui 有值引用要同步 tsconfig / vite / vitest 三处 alias）。本模块只依赖列 id 类型，保持可被浏览器零成本引用。
//
// 不在这里的：浏览器端由会话 facet 驱动的列自动流转（review ⇄ in_progress、validation → in_progress、
// 中断会话进 Done）。那些不是用户手势，drag-rules 里也只对「在途程序化移动」放行。

export type TaskCardBoardColumnTransitionRequestedByUserGestureClassification =
	// 纯看板重新归类：进出 validation 缓冲区。不停会话、不动 worktree。
	| "board_column_transition_without_session_side_effects"
	// 同列内拖放换位置（目前只有 in_progress 允许，与 drag-rules 一致）。
	| "board_column_reorder_without_session_side_effects"
	// backlog → in_progress：启动 agent 会话（taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress）。
	| "board_column_transition_starting_agent_session"
	// in_progress → review：把 agent 回合交还用户（taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser）。
	| "board_column_transition_handing_agent_turn_to_user"
	// 任意非 Done 列 → Done：停会话并删 worktree（taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree）。
	| "board_column_transition_into_done_stopping_sessions_and_deleting_worktree"
	// Done → review：恢复会话（taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession）。
	| "board_column_transition_restoring_from_done_resuming_agent_session"
	// 其余组合：用户手势不允许（例如任何列拖回 backlog——backlog 是单向入口）。
	| "board_column_transition_not_allowed_as_user_gesture";

// 「无会话副作用」的跨列移动白名单。与 drag-rules 的自由拖放分支逐条对应：
// in_progress / review → validation（进人工验证缓冲区），validation → review（撤回那一步）。
const TASK_CARD_BOARD_COLUMN_TRANSITIONS_WITHOUT_SESSION_SIDE_EFFECTS: ReadonlyArray<{
	fromBoardColumnId: RuntimeBoardColumnId;
	toBoardColumnId: RuntimeBoardColumnId;
}> = [
	{ fromBoardColumnId: "in_progress", toBoardColumnId: "validation" },
	{ fromBoardColumnId: "review", toBoardColumnId: "validation" },
	{ fromBoardColumnId: "validation", toBoardColumnId: "review" },
];

// 允许列内重排的列。backlog 按 Description 最后更新时间排序（手动顺序会被立刻覆盖）；review / validation /
// Done 在 drag-rules 里禁止同列落点。
const BOARD_COLUMN_IDS_ALLOWING_REORDER_WITHOUT_SESSION_SIDE_EFFECTS: ReadonlySet<RuntimeBoardColumnId> = new Set([
	"in_progress",
]);

export function classifyTaskCardBoardColumnTransitionRequestedByUserGesture(
	fromBoardColumnId: RuntimeBoardColumnId,
	toBoardColumnId: RuntimeBoardColumnId,
): TaskCardBoardColumnTransitionRequestedByUserGestureClassification {
	if (fromBoardColumnId === toBoardColumnId) {
		return BOARD_COLUMN_IDS_ALLOWING_REORDER_WITHOUT_SESSION_SIDE_EFFECTS.has(fromBoardColumnId)
			? "board_column_reorder_without_session_side_effects"
			: "board_column_transition_not_allowed_as_user_gesture";
	}
	if (fromBoardColumnId === "backlog" && toBoardColumnId === "in_progress") {
		return "board_column_transition_starting_agent_session";
	}
	if (fromBoardColumnId === "in_progress" && toBoardColumnId === "review") {
		return "board_column_transition_handing_agent_turn_to_user";
	}
	if (toBoardColumnId === "trash") {
		return "board_column_transition_into_done_stopping_sessions_and_deleting_worktree";
	}
	if (fromBoardColumnId === "trash" && toBoardColumnId === "review") {
		return "board_column_transition_restoring_from_done_resuming_agent_session";
	}
	const isTransitionWithoutSessionSideEffects = TASK_CARD_BOARD_COLUMN_TRANSITIONS_WITHOUT_SESSION_SIDE_EFFECTS.some(
		(transition) =>
			transition.fromBoardColumnId === fromBoardColumnId && transition.toBoardColumnId === toBoardColumnId,
	);
	return isTransitionWithoutSessionSideEffects
		? "board_column_transition_without_session_side_effects"
		: "board_column_transition_not_allowed_as_user_gesture";
}

// taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects 的准入判据。
export function isTaskCardBoardPlacementChangeAllowedWithoutSessionSideEffects(
	fromBoardColumnId: RuntimeBoardColumnId,
	toBoardColumnId: RuntimeBoardColumnId,
): boolean {
	const classification = classifyTaskCardBoardColumnTransitionRequestedByUserGesture(
		fromBoardColumnId,
		toBoardColumnId,
	);
	return (
		classification === "board_column_transition_without_session_side_effects" ||
		classification === "board_column_reorder_without_session_side_effects"
	);
}

// 卡片在这些列里时才可能挂着活的 agent 会话：backlog 是「从未启动」的单向入口，Done 里的会话在移入时已停。
// 移入 Done / 永久删除据此决定要不要停 agent 会话（对 backlog 卡发 stop 会白白唤醒 Cline SDK 的持久会话查找）。
export function canTaskCardInBoardColumnHostLiveTaskAgentSession(boardColumnId: RuntimeBoardColumnId): boolean {
	return boardColumnId === "in_progress" || boardColumnId === "review" || boardColumnId === "validation";
}
