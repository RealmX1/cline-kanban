import { POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX } from "@runtime-post-deploy-verification-done-entry-closure-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse,
} from "@/runtime/types";
import type { TaskCardActionCommandExecutionResult } from "@/state/task-card-action-command-execution";
import type { BoardColumnId } from "@/types";
import { completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser } from "./post-deploy-verification-panel-completion-move-into-done-for-workspace-board-not-hydrated-in-browser";

const readTaskCardWithBoardColumnInWorkspaceMock = vi.hoisted(() =>
	vi.fn<(workspaceId: string, taskId: string) => Promise<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse>>(),
);
const moveTaskCardIntoDoneMock = vi.hoisted(() =>
	vi.fn<
		(
			input: Record<string, unknown>,
		) => Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionMoveIntoDoneResponse>>
	>(),
);
const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskCardWithBoardColumnInWorkspace: readTaskCardWithBoardColumnInWorkspaceMock,
}));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime: moveTaskCardIntoDoneMock,
}));
vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

const DONE_ENTRY_GATE_REJECTION_MESSAGE = `${POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX} 还有 1 项未勾`;

function taskCardFoundInColumn(boardColumnIdContainingTaskCard: BoardColumnId) {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: {
				id: "task-1",
				title: "卡",
				prompt: "卡",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: 1,
				updatedAt: 1,
			},
			boardColumnIdContainingTaskCard,
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		},
	} as RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse;
}

function moveCompletedByRuntime(
	taskWorktreeDeletionErrorMessage: string | null,
): TaskCardActionCommandExecutionResult<RuntimeTaskCardActionMoveIntoDoneResponse> {
	return {
		taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
		response: {
			taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage },
		} as RuntimeTaskCardActionMoveIntoDoneResponse,
	};
}

beforeEach(() => {
	readTaskCardWithBoardColumnInWorkspaceMock.mockReset();
	moveTaskCardIntoDoneMock.mockReset();
	notifyErrorMock.mockReset();
	showAppToastMock.mockReset();
});

describe("completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser", () => {
	it("服务端复检发现列已变化：不移列，报失败", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValue(taskCardFoundInColumn("in_progress"));
		const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "review",
		});
		expect(result).toEqual({ ok: false, moveIntoDoneFailureMessage: "任务所在列已变化，请重新点击完成核对" });
		expect(readTaskCardWithBoardColumnInWorkspaceMock).toHaveBeenCalledWith("cline-kanban", "task-1");
		expect(moveTaskCardIntoDoneMock).not.toHaveBeenCalled();
	});

	it("卡已不在看板 / 读失败：不移列，报失败", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValueOnce({
			taskCardLookupOutcome: "task_card_not_found_on_workspace_board",
			lookedUpTaskId: "task-1",
		});
		readTaskCardWithBoardColumnInWorkspaceMock.mockRejectedValueOnce(new Error("network down"));
		for (const expectedFailureMessage of ["任务已不在看板", "读取任务所在列失败：network down"]) {
			const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
				workspaceId: "cline-kanban",
				taskId: "task-1",
				boardColumnIdObservedInBoardSnapshot: "validation",
			});
			expect(result).toEqual({ ok: false, moveIntoDoneFailureMessage: expectedFailureMessage });
		}
		expect(moveTaskCardIntoDoneMock).not.toHaveBeenCalled();
	});

	it("成功：显式带 workspaceId、PDV 面板发起方标注与 closure，不带 overlay", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValue(taskCardFoundInColumn("validation"));
		moveTaskCardIntoDoneMock.mockResolvedValue(moveCompletedByRuntime(null));
		const postDeployVerificationDoneEntryClosure: RuntimePostDeployVerificationDoneEntryClosureRequest = {
			confirmedAcknowledgements: ["skip_validation"],
		};
		const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "validation",
			postDeployVerificationDoneEntryClosure,
		});
		expect(result).toEqual({ ok: true });
		expect(moveTaskCardIntoDoneMock).toHaveBeenCalledWith({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
			postDeployVerificationDoneEntryClosure,
		});
		expect(notifyErrorMock).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("成功但 worktree 删除失败：照常算成功，另给 warning 提示", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValue(taskCardFoundInColumn("validation"));
		moveTaskCardIntoDoneMock.mockResolvedValue(moveCompletedByRuntime("worktree busy"));
		const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "validation",
		});
		expect(result).toEqual({ ok: true });
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "warning", message: expect.stringContaining("worktree busy") }),
		);
	});

	it("门禁拒绝：原样返回给 controller，不另弹错", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValue(taskCardFoundInColumn("validation"));
		moveTaskCardIntoDoneMock.mockResolvedValue({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: DONE_ENTRY_GATE_REJECTION_MESSAGE,
		});
		const result = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "validation",
		});
		expect(result).toEqual({ ok: false, moveIntoDoneFailureMessage: DONE_ENTRY_GATE_REJECTION_MESSAGE });
		expect(notifyErrorMock).not.toHaveBeenCalled();
	});

	it("其他失败：弹错并报失败；同卡另有命令在途：报失败不弹错", async () => {
		readTaskCardWithBoardColumnInWorkspaceMock.mockResolvedValue(taskCardFoundInColumn("review"));
		moveTaskCardIntoDoneMock.mockResolvedValueOnce({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: "disk full",
		});
		moveTaskCardIntoDoneMock.mockResolvedValueOnce({
			taskCardActionCommandExecutionOutcome: "rejected_because_another_command_is_in_flight_for_task_card",
		});
		const failed = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "review",
		});
		expect(failed).toEqual({ ok: false, moveIntoDoneFailureMessage: "disk full" });
		expect(notifyErrorMock).toHaveBeenCalledWith("Could not move the task to Done: disk full");
		notifyErrorMock.mockReset();
		const inFlight = await completePostDeployVerificationPanelMoveIntoDoneForWorkspaceBoardNotHydratedInBrowser({
			workspaceId: "cline-kanban",
			taskId: "task-1",
			boardColumnIdObservedInBoardSnapshot: "review",
		});
		expect(inFlight).toEqual({ ok: false, moveIntoDoneFailureMessage: "该任务的移入 Done 已在进行中" });
		expect(notifyErrorMock).not.toHaveBeenCalled();
	});
});
