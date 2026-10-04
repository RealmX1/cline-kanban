import { afterEach, describe, expect, it } from "vitest";

import {
	clearAllTaskCardActionCommandsInFlight,
	readTaskCardActionCommandKindInFlight,
	tryBeginTaskCardActionCommandInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";

afterEach(() => {
	clearAllTaskCardActionCommandsInFlight();
});

describe("task-card-action-commands-in-flight-store", () => {
	it("同一张卡已有命令在途时拒绝第二条（客户端幂等闸），结束后放行", () => {
		const finish = tryBeginTaskCardActionCommandInFlight(
			"ws-a",
			"t1",
			"move_task_card_into_done_stopping_sessions_and_deleting_worktree",
		);
		expect(finish).not.toBeNull();
		expect(
			tryBeginTaskCardActionCommandInFlight(
				"ws-a",
				"t1",
				"start_task_card_agent_session_moving_it_into_in_progress",
			),
		).toBeNull();
		expect(readTaskCardActionCommandKindInFlight("ws-a", "t1")).toBe(
			"move_task_card_into_done_stopping_sessions_and_deleting_worktree",
		);
		finish?.();
		finish?.();
		expect(readTaskCardActionCommandKindInFlight("ws-a", "t1")).toBeNull();
		expect(tryBeginTaskCardActionCommandInFlight("ws-a", "t1", "update_task_card_field_values")).not.toBeNull();
	});

	it("键带 workspace：不同项目的同号任务互不阻塞", () => {
		expect(tryBeginTaskCardActionCommandInFlight("ws-a", "t1", "update_task_card_field_values")).not.toBeNull();
		expect(tryBeginTaskCardActionCommandInFlight("ws-b", "t1", "update_task_card_field_values")).not.toBeNull();
	});
});
