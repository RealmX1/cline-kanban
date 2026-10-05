import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";
import { executeTaskCardActionCommand } from "@/state/task-card-action-command-execution";
import {
	readPendingTaskCardCommandBoardOverlayEntries,
	resetPendingTaskCardCommandBoardOverlayStore,
} from "@/stores/pending-task-card-command-board-overlay-store";
import {
	clearAllTaskCardActionCommandsInFlight,
	readTaskCardActionCommandKindInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardColumnId } from "@/types";

// 卡片动作命令的统一编排：在途闸、overlay 的生命周期（命令成功 / 失败 / 服务端放到别处 / 兜底退场）。

function snapshotOf(
	taskId: string,
	boardColumnIdContainingTaskCard: BoardColumnId,
	fields: Record<string, unknown> = {},
): RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries {
	return {
		taskCard: {
			id: taskId,
			title: taskId,
			prompt: taskId,
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 0,
			updatedAt: 0,
			...fields,
		},
		boardColumnIdContainingTaskCard,
		taskSessionSummaryLiveInRuntimeProcessMemory: null,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	clearAllTaskCardActionCommandsInFlight();
	resetPendingTaskCardCommandBoardOverlayStore();
});

afterEach(() => {
	resetPendingTaskCardCommandBoardOverlayStore();
	vi.useRealTimers();
});

describe("executeTaskCardActionCommand", () => {
	it("同一张卡已有命令在途时直接拒绝；命令结算后在途登记清掉", async () => {
		let resolveFirstCommand: (value: string) => void = () => {};
		const firstCommand = executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-1"],
			commandKind: "move_task_card_into_done_stopping_sessions_and_deleting_worktree",
			sendCommand: () =>
				new Promise<string>((resolve) => {
					resolveFirstCommand = resolve;
				}),
		});
		expect(readTaskCardActionCommandKindInFlight("ws-1", "task-1")).toBe(
			"move_task_card_into_done_stopping_sessions_and_deleting_worktree",
		);

		const secondSendCommand = vi.fn(async () => "second");
		await expect(
			executeTaskCardActionCommand({
				workspaceId: "ws-1",
				taskIds: ["task-1"],
				commandKind: "update_task_card_field_values",
				sendCommand: secondSendCommand,
			}),
		).resolves.toEqual({
			taskCardActionCommandExecutionOutcome: "rejected_because_another_command_is_in_flight_for_task_card",
		});
		expect(secondSendCommand).not.toHaveBeenCalled();
		// 其他项目里同号的卡不受影响（在途键带 workspace）。
		expect(readTaskCardActionCommandKindInFlight("ws-2", "task-1")).toBeNull();

		resolveFirstCommand("first");
		await expect(firstCommand).resolves.toEqual({
			taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
			response: "first",
		});
		expect(readTaskCardActionCommandKindInFlight("ws-1", "task-1")).toBeNull();
	});

	it("成功后 overlay 留到广播回灌（或兜底定时器到期）；失败立刻撤掉", async () => {
		await executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-1"],
			commandKind: "move_task_card_into_done_stopping_sessions_and_deleting_worktree",
			expectedBoardEffectByTaskId: new Map([
				[
					"task-1",
					{
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
						targetBoardColumnId: "trash",
					},
				],
			]),
			sendCommand: async () => ({ snapshot: snapshotOf("task-1", "trash") }),
			readTaskCardSnapshotsAfterAction: (response) => [response.snapshot],
		});
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toHaveLength(1);
		vi.advanceTimersByTime(5_000);
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toEqual([]);

		const failed = await executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-2"],
			commandKind: "move_task_card_into_done_stopping_sessions_and_deleting_worktree",
			expectedBoardEffectByTaskId: new Map([
				[
					"task-2",
					{
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
						targetBoardColumnId: "trash",
					},
				],
			]),
			sendCommand: async () => {
				throw new Error('Task "task-2" was not found');
			},
		});
		expect(failed).toEqual({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: 'Task "task-2" was not found',
		});
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toEqual([]);
	});

	it("服务端把卡放到了别处：期望永远不会被满足，overlay 立刻撤掉", async () => {
		await executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-1"],
			commandKind: "restore_task_card_from_done_into_review_resuming_agent_session",
			expectedBoardEffectByTaskId: new Map([
				[
					"task-1",
					{
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
						targetBoardColumnId: "review",
					},
				],
			]),
			sendCommand: async () => ({ snapshot: snapshotOf("task-1", "trash") }),
			readTaskCardSnapshotsAfterAction: (response) => [response.snapshot],
		});
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toEqual([]);
	});

	it("字段 patch 换成服务端实际写下的值（置顶时刻由服务端决定）", async () => {
		await executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-1"],
			commandKind: "set_task_pinboard_pin_state_of_task_card",
			expectedBoardEffectByTaskId: new Map([
				[
					"task-1",
					{
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
						taskCardFieldPatch: { pinnedToTaskPinboardAt: 111, taskPinboardPinReason: "watch" },
					},
				],
			]),
			sendCommand: async () => ({
				snapshot: snapshotOf("task-1", "review", { pinnedToTaskPinboardAt: 999, taskPinboardPinReason: "watch" }),
			}),
			readTaskCardSnapshotsAfterAction: (response) => [response.snapshot],
		});
		expect(readPendingTaskCardCommandBoardOverlayEntries("ws-1")).toEqual([
			expect.objectContaining({
				expectedBoardEffect: {
					pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
					taskCardFieldPatch: { pinnedToTaskPinboardAt: 999, taskPinboardPinReason: "watch" },
				},
			}),
		]);
	});

	it("批量命令里有一张卡已在途：整批拒绝，已登记的其余卡回滚", async () => {
		const blocking = executeTaskCardActionCommand({
			workspaceId: "ws-1",
			taskIds: ["task-2"],
			commandKind: "update_task_card_field_values",
			sendCommand: () => new Promise<never>(() => {}),
		});
		void blocking;
		await expect(
			executeTaskCardActionCommand({
				workspaceId: "ws-1",
				taskIds: ["task-1", "task-2"],
				commandKind: "permanently_delete_task_card_with_full_resource_cleanup",
				sendCommand: async () => "deleted",
			}),
		).resolves.toEqual({
			taskCardActionCommandExecutionOutcome: "rejected_because_another_command_is_in_flight_for_task_card",
		});
		expect(readTaskCardActionCommandKindInFlight("ws-1", "task-1")).toBeNull();
	});
});
