import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskCardBody, type TaskCardBodyRenderRole } from "@/components/task-card-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskCommentsDialogProvider, useTaskCommentsDialog } from "./task-comments-dialog-provider";

const { readCard, updateCard } = vi.hoisted(() => ({ readCard: vi.fn(), updateCard: vi.fn() }));
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: readCard }));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	updateTaskCardFieldValuesThroughRuntime: updateCard,
}));
vi.mock("@/stores/cross-project-task-worktree-git-metadata-store", () => ({
	useCrossProjectTaskWorktreeGitMetadataSnapshotValue: () => null,
}));

it.each<TaskCardBodyRenderRole>([
	"canonical_card_in_its_stage_list",
	"focused_card_copy_under_sticky_stage_header",
	"focused_task_card_copy_in_mobile_detail_header",
	"pinned_card_copy_in_task_pinboard",
	"expanded_card_copy_in_cross_project_task_switcher_row",
])("任务卡评论入口贯通渲染角色 %s", async (renderRole) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	readCard.mockClear().mockResolvedValue({ taskCardLookupOutcome: "task_card_not_found_on_workspace_board" });
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const isOtherProject = renderRole === "expanded_card_copy_in_cross_project_task_switcher_row";
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TaskCommentsDialogProvider currentWorkspaceId="current-project">
						<TaskCardBody
							renderRole={renderRole}
							columnId="review"
							taskCardOwnedByOtherProjectWorkspaceId={isOtherProject ? "other-project" : null}
							card={{
								id: "shared-id",
								title: "评论入口",
								prompt: "需求",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							}}
						/>
					</TaskCommentsDialogProvider>
				</TooltipProvider>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="任务评论"]')!.click());
		expect(readCard).toHaveBeenCalledWith(isOtherProject ? "other-project" : "current-project", "shared-id");
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});

it("跨项目评论只读取和更新指定任务，失败时保留可重试内容", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	readCard.mockResolvedValue({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: { taskCard: { title: "其他项目任务", taskCommentEntries: [] } },
	});
	updateCard
		.mockResolvedValueOnce({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: "连接暂不可用",
		})
		.mockResolvedValue({ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" });
	function Trigger() {
		const controller = useTaskCommentsDialog()!;
		return (
			<button type="button" onClick={() => controller.openTaskComments("other-project", "same-task-id")}>
				任务评论
			</button>
		);
	}
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TaskCommentsDialogProvider currentWorkspaceId="current-project">
						<Trigger />
					</TaskCommentsDialogProvider>
				</TooltipProvider>,
			),
		);
		await act(async () => container.querySelector("button")!.click());
		expect(readCard).toHaveBeenCalledWith("other-project", "same-task-id");
		const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a task comment..."]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "保留这一条评论");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			Array.from(document.querySelectorAll("button"))
				.find((button) => button.textContent === "Add comment")!
				.click(),
		);
		expect(updateCard).toHaveBeenCalledWith({
			workspaceId: "other-project",
			taskId: "same-task-id",
			taskCardFieldValuePatch: { taskCommentEntries: [expect.objectContaining({ commentText: "保留这一条评论" })] },
		});
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("连接暂不可用");
		await act(async () =>
			Array.from(document.querySelectorAll("button"))
				.find((button) => button.textContent === "重试保存")!
				.click(),
		);
		expect(updateCard).toHaveBeenCalledTimes(2);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
