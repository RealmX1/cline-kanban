import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId } from "../../../src/core/api-contract";
import {
	canTaskCardInBoardColumnHostLiveTaskAgentSession,
	classifyTaskCardBoardColumnTransitionRequestedByUserGesture,
	isTaskCardBoardPlacementChangeAllowedWithoutSessionSideEffects,
} from "../../../src/core/task-card-action-board-column-transitions";

const ALL_BOARD_COLUMN_IDS: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];

describe("classifyTaskCardBoardColumnTransitionRequestedByUserGesture", () => {
	it("与 web-ui drag-rules / 卡片按钮的语义逐格一致", () => {
		const classificationTable = Object.fromEntries(
			ALL_BOARD_COLUMN_IDS.flatMap((fromBoardColumnId) =>
				ALL_BOARD_COLUMN_IDS.map((toBoardColumnId) => [
					`${fromBoardColumnId}->${toBoardColumnId}`,
					classifyTaskCardBoardColumnTransitionRequestedByUserGesture(fromBoardColumnId, toBoardColumnId),
				]),
			),
		);

		expect(classificationTable).toEqual({
			"backlog->backlog": "board_column_transition_not_allowed_as_user_gesture",
			"backlog->in_progress": "board_column_transition_starting_agent_session",
			"backlog->review": "board_column_transition_not_allowed_as_user_gesture",
			"backlog->validation": "board_column_transition_not_allowed_as_user_gesture",
			"backlog->trash": "board_column_transition_into_done_stopping_sessions_and_deleting_worktree",
			"in_progress->backlog": "board_column_transition_not_allowed_as_user_gesture",
			"in_progress->in_progress": "board_column_reorder_without_session_side_effects",
			"in_progress->review": "board_column_transition_handing_agent_turn_to_user",
			"in_progress->validation": "board_column_transition_without_session_side_effects",
			"in_progress->trash": "board_column_transition_into_done_stopping_sessions_and_deleting_worktree",
			"review->backlog": "board_column_transition_not_allowed_as_user_gesture",
			// review → in_progress 只属于浏览器的会话 facet 驱动自动流转，不是用户手势。
			"review->in_progress": "board_column_transition_not_allowed_as_user_gesture",
			"review->review": "board_column_transition_not_allowed_as_user_gesture",
			"review->validation": "board_column_transition_without_session_side_effects",
			"review->trash": "board_column_transition_into_done_stopping_sessions_and_deleting_worktree",
			"validation->backlog": "board_column_transition_not_allowed_as_user_gesture",
			"validation->in_progress": "board_column_transition_not_allowed_as_user_gesture",
			"validation->review": "board_column_transition_without_session_side_effects",
			"validation->validation": "board_column_transition_not_allowed_as_user_gesture",
			"validation->trash": "board_column_transition_into_done_stopping_sessions_and_deleting_worktree",
			"trash->backlog": "board_column_transition_not_allowed_as_user_gesture",
			"trash->in_progress": "board_column_transition_not_allowed_as_user_gesture",
			"trash->review": "board_column_transition_restoring_from_done_resuming_agent_session",
			"trash->validation": "board_column_transition_not_allowed_as_user_gesture",
			"trash->trash": "board_column_transition_not_allowed_as_user_gesture",
		});
	});

	it("无会话副作用的准入判据只放行进出 validation 与 in_progress 列内重排", () => {
		const allowedPairs = ALL_BOARD_COLUMN_IDS.flatMap((fromBoardColumnId) =>
			ALL_BOARD_COLUMN_IDS.filter((toBoardColumnId) =>
				isTaskCardBoardPlacementChangeAllowedWithoutSessionSideEffects(fromBoardColumnId, toBoardColumnId),
			).map((toBoardColumnId) => `${fromBoardColumnId}->${toBoardColumnId}`),
		);

		expect(allowedPairs).toEqual([
			"in_progress->in_progress",
			"in_progress->validation",
			"review->validation",
			"validation->review",
		]);
	});

	it("只有 in_progress / review / validation 的卡可能挂着活 agent 会话", () => {
		expect(ALL_BOARD_COLUMN_IDS.filter(canTaskCardInBoardColumnHostLiveTaskAgentSession)).toEqual([
			"in_progress",
			"review",
			"validation",
		]);
	});
});
