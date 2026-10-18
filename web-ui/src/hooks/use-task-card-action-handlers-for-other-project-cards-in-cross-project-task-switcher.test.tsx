import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { BoardCard, BoardColumnId } from "@/types";

const mocks = vi.hoisted(() => ({ move: vi.fn(), read: vi.fn() }));
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: mocks.read }));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime: mocks.move,
	moveTaskCardBetweenNonTrashColumnsThroughRuntime: vi.fn(),
	moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime: vi.fn(),
	permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime: vi.fn(),
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime: vi.fn(),
	startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime: vi.fn(),
	updateTaskCardFieldValuesThroughRuntime: vi.fn(),
}));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn(), showAppToast: vi.fn() }));

const card: BoardCard = {
	id: "shared-task-id",
	title: "其他项目的任务",
	prompt: "原文",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 1,
	updatedAt: 1,
};
const noop = () => {};

function buttonWithText(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
	if (!button) throw new Error(`找不到按钮：${text}`);
	return button;
}

describe("其他项目卡片的评论后完成", () => {
	it.each(["原 ID 同文已保存", "缺少本次评论", "同文但不同 ID", "同 ID 但不同正文", "重试时改写正文"])(
		"响应丢失后重新读取 Done：%s 时仅结算已保存的同一条评论",
		async (savedCommentState) => {
			mocks.move.mockReset();
			mocks.read.mockReset();
			const persistedCard: BoardCard = { ...card, taskCommentEntries: [] };
			mocks.read.mockResolvedValue({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: { taskCard: persistedCard, boardColumnIdContainingTaskCard: "validation" },
			});
			mocks.move.mockImplementationOnce(async (input) => {
				if (savedCommentState !== "缺少本次评论")
					persistedCard.taskCommentEntries = [
						{
							...input.taskCommentToAppendWhenMovingIntoDone,
							...(savedCommentState === "同文但不同 ID" ? { taskCommentEntryId: "另一条评论" } : {}),
							...(savedCommentState === "同 ID 但不同正文" ? { commentText: "另一段正文" } : {}),
							createdAt: 2,
							updatedAt: 2,
						},
					];
				// 模拟运行时已处理请求但响应丢失，命令包装层将网络异常转为失败结果。
				return {
					taskCardActionCommandExecutionOutcome: "command_failed",
					commandFailureMessage: "保存后的网络响应丢失",
				};
			});
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			let actions: TaskCardActionHandlerBundle | null = null;
			function Harness() {
				const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
					onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
					onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
				});
				const bundle = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard: card,
					boardColumnIdContainingTaskCard: "validation",
					taskCardActionCommandKindInFlight: null,
				});
				useEffect(() => {
					actions = bundle;
				});
				return result.otherProjectTaskCardActionConfirmationDialogs;
			}
			async function enterComment(text: string) {
				await act(async () => {
					const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')!;
					Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
			}
			try {
				await act(async () => root.render(<Harness />));
				await act(async () => {
					if (!actions?.onMoveToTrashTask) throw new Error("没有其他项目 Done 动作");
					actions.onMoveToTrashTask(card.id, { requestTaskCommentBeforeMovingIntoDone: true });
				});
				await enterComment("项目二已提交的完成评论");
				await act(async () => buttonWithText("提交评论并移入 Done").click());
				expect(document.querySelector('[role="alert"]')?.textContent).toBe("保存后的网络响应丢失");
				mocks.read.mockResolvedValue({
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: { taskCard: persistedCard, boardColumnIdContainingTaskCard: "trash" },
				});
				if (savedCommentState === "重试时改写正文") await enterComment("改写后的完成评论");
				await act(async () => buttonWithText("提交评论并移入 Done").click());
				if (savedCommentState === "原 ID 同文已保存") {
					expect(document.querySelector('[role="dialog"]')).toBeNull();
					expect(persistedCard.taskCommentEntries).toHaveLength(1);
				} else {
					expect(document.querySelector('[role="alert"]')?.textContent).toContain("未提交评论");
					expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')?.value).toBe(
						savedCommentState === "重试时改写正文" ? "改写后的完成评论" : "项目二已提交的完成评论",
					);
				}
				expect(mocks.move).toHaveBeenCalledOnce();
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		},
	);

	for (const columnId of ["review", "validation"] as const)
		it(`${columnId} 保留项目身份、取消草稿和失败重试`, async () => {
			mocks.move.mockReset();
			mocks.read.mockReset();
			mocks.read.mockResolvedValue({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: columnId },
			});
			mocks.move.mockResolvedValue({
				taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
				response: { taskWorktreeDeletionResult: null },
			});
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			let actions: TaskCardActionHandlerBundle | null = null;
			function Harness({ stage }: { stage: BoardColumnId }) {
				const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
					onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
					onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
				});
				const bundle = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard: card,
					boardColumnIdContainingTaskCard: stage,
					taskCardActionCommandKindInFlight: null,
				});
				useEffect(() => {
					actions = bundle;
				});
				return result.otherProjectTaskCardActionConfirmationDialogs;
			}
			const requestComment = () => {
				if (!actions?.onMoveToTrashTask) throw new Error("没有其他项目 Done 动作");
				actions.onMoveToTrashTask(card.id, { requestTaskCommentBeforeMovingIntoDone: true });
			};
			try {
				await act(async () => root.render(<Harness stage={columnId} />));
				await act(async () => requestComment());
				const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')!;
				await act(async () => {
					Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
						textarea,
						"项目二的评论",
					);
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
				if (columnId === "validation")
					mocks.move.mockResolvedValueOnce({
						taskCardActionCommandExecutionOutcome: "command_failed",
						commandFailureMessage: "网络暂时失败",
					});
				await act(async () => buttonWithText("提交评论并移入 Done").click());
				if (columnId === "review") {
					expect(mocks.move).not.toHaveBeenCalled();
					await act(async () => buttonWithText("Cancel").click());
					expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')?.value).toBe(
						"项目二的评论",
					);
					await act(async () => buttonWithText("提交评论并移入 Done").click());
					await act(async () => buttonWithText("Move to Done").click());
				} else {
					expect(document.querySelector('[role="alert"]')?.textContent).toBe("网络暂时失败");
					await act(async () => buttonWithText("提交评论并移入 Done").click());
					expect(mocks.move.mock.calls[0]?.[0].taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId).toBe(
						mocks.move.mock.calls[1]?.[0].taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
					);
				}
				expect(mocks.move).toHaveBeenLastCalledWith(
					expect.objectContaining({
						workspaceId: "other-project-2",
						taskId: card.id,
						taskCommentToAppendWhenMovingIntoDone: expect.objectContaining({ commentText: "项目二的评论" }),
					}),
				);
				expect(document.querySelector('[role="dialog"]')).toBeNull();
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		});
});
