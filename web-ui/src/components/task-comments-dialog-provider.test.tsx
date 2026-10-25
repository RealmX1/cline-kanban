import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCardBody, type TaskCardBodyRenderRole } from "@/components/task-card-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse } from "@/runtime/types";
import { TaskCommentsDialogProvider, useTaskCommentsDialog } from "./task-comments-dialog-provider";

const { readCard, updateCard } = vi.hoisted(() => ({ readCard: vi.fn(), updateCard: vi.fn() }));
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: readCard }));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	updateTaskCardFieldValuesThroughRuntime: updateCard,
}));
vi.mock("@/stores/cross-project-task-worktree-git-metadata-store", () => ({
	useCrossProjectTaskWorktreeGitMetadataSnapshotValue: () => null,
}));

afterEach(() => {
	readCard.mockReset();
	updateCard.mockReset();
	vi.unstubAllGlobals();
});

function taskCardLookupResult(
	createdAt: number,
	commentText?: string,
): RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: {
				id: "same-task-id",
				title: "其他项目任务",
				prompt: "需求",
				baseRef: "main",
				startInPlanMode: false,
				createdAt,
				updatedAt: createdAt,
				taskCommentEntries: commentText
					? [{ taskCommentEntryId: "existing-comment", commentText, createdAt, updatedAt: createdAt }]
					: [],
			},
			boardColumnIdContainingTaskCard: "review",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		},
	};
}

function CommentsTrigger({ createdAt, label = "打开评论" }: { createdAt: number; label?: string }) {
	const controller = useTaskCommentsDialog()!;
	return (
		<button type="button" onClick={() => controller.openTaskComments("other-project", "same-task-id", createdAt)}>
			{label}
		</button>
	);
}

async function withCommentsDialog(children: ReactNode, verify: (container: HTMLDivElement) => Promise<void>) {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TaskCommentsDialogProvider currentWorkspaceId="current-project">{children}</TaskCommentsDialogProvider>
				</TooltipProvider>,
			),
		);
		await verify(container);
	} finally {
		act(() => root.unmount());
		container.remove();
	}
}

async function clickCommentsButton(label: string) {
	const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
	expect(button).toBeDefined();
	await act(async () => button!.click());
}

async function addComment(commentText: string) {
	const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Write a task comment..."]')!;
	expect(textarea).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, commentText);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await clickCommentsButton("Add comment");
}

function deferredResult<T>() {
	let resolve!: (result: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

it.each<TaskCardBodyRenderRole>([
	"canonical_card_in_its_stage_list",
	"focused_card_copy_under_sticky_stage_header",
	"focused_task_card_copy_in_mobile_detail_header",
	"pinned_card_copy_in_task_pinboard",
	"expanded_card_copy_in_cross_project_task_switcher_row",
	"task_card_copy_in_related_task_preview",
])("任务卡评论入口贯通渲染角色 %s", async (renderRole) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	readCard.mockClear().mockResolvedValue({ taskCardLookupOutcome: "task_card_not_found_on_workspace_board" });
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const isOtherProject =
		renderRole === "expanded_card_copy_in_cross_project_task_switcher_row" ||
		renderRole === "task_card_copy_in_related_task_preview";
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
								createdAt: 41,
								updatedAt: Date.now(),
							}}
						/>
					</TaskCommentsDialogProvider>
				</TooltipProvider>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="任务评论"]')!.click());
		expect(readCard).toHaveBeenCalledWith(isOtherProject ? "other-project" : "current-project", "shared-id", 41);
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
		taskCardSnapshot: { taskCard: { title: "其他项目任务", createdAt: 41, taskCommentEntries: [] } },
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
		expect(readCard).toHaveBeenCalledWith("other-project", "same-task-id", undefined);
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
			expectedTaskIncarnationCreatedAtEpochMs: 41,
			taskCardFieldValuePatch: { taskCommentEntries: [expect.objectContaining({ commentText: "保留这一条评论" })] },
		});
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("连接暂不可用");
		await act(async () =>
			Array.from(document.querySelectorAll("button"))
				.find((button) => button.textContent === "重试保存")!
				.click(),
		);
		expect(updateCard).toHaveBeenCalledTimes(2);
		expect(readCard.mock.calls.slice(1).map((call) => call[2])).toEqual([41, 41]);
		expect(updateCard.mock.calls.map((call) => call[0].expectedTaskIncarnationCreatedAtEpochMs)).toEqual([41, 41]);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});

it("打开前已被同 ID 新卡替换时，不读取新卡评论", async () => {
	readCard.mockImplementation(async (_workspaceId: string, _taskId: string, expectedCreatedAt?: number) => {
		if (expectedCreatedAt !== undefined && expectedCreatedAt !== 42) throw new Error("任务已被同 ID 的新任务替换。");
		return taskCardLookupResult(42, "新卡私有评论");
	});
	await withCommentsDialog(<CommentsTrigger createdAt={41} />, async () => {
		await clickCommentsButton("打开评论");
		expect(readCard).toHaveBeenCalledWith("other-project", "same-task-id", 41);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("任务已被同 ID 的新任务替换");
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.body.textContent).not.toContain("新卡私有评论");
		expect(updateCard).not.toHaveBeenCalled();
	});
});

it("初次读取失败后的重试保持打开时的一世身份", async () => {
	readCard
		.mockRejectedValueOnce(new Error("读取暂不可用"))
		.mockImplementation(async (_workspaceId: string, _taskId: string, expectedCreatedAt?: number) => {
			if (expectedCreatedAt !== undefined && expectedCreatedAt !== 42)
				throw new Error("任务已被同 ID 的新任务替换。");
			return taskCardLookupResult(42, "重建后评论");
		});
	await withCommentsDialog(<CommentsTrigger createdAt={41} />, async () => {
		await clickCommentsButton("打开评论");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("读取暂不可用");
		await clickCommentsButton("重新读取");
		expect(readCard.mock.calls.map((call) => call[2])).toEqual([41, 41]);
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.body.textContent).not.toContain("重建后评论");
		expect(updateCard).not.toHaveBeenCalled();
	});
});

it.each(["打开", "保存前重读"])("%s 的运行时忽略身份过滤时，仍拒绝使用同 ID 新卡快照", async (readStage) => {
	readCard.mockResolvedValue(taskCardLookupResult(41));
	await withCommentsDialog(<CommentsTrigger createdAt={41} />, async () => {
		if (readStage === "打开") readCard.mockResolvedValue(taskCardLookupResult(42, "不应泄露的新卡评论"));
		await clickCommentsButton("打开评论");
		if (readStage === "保存前重读") {
			readCard.mockResolvedValue(taskCardLookupResult(42, "不应泄露的新卡评论"));
			await addComment("旧卡评论");
		}
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("任务已被同 ID 的新任务替换");
		expect(document.body.textContent).not.toContain("不应泄露的新卡评论");
		expect(updateCard).not.toHaveBeenCalled();
	});
});

it("打开后同 ID 重建时，保存前重读及重试均拒绝修改新卡", async () => {
	let currentCreatedAt = 41;
	readCard.mockImplementation(async (_workspaceId: string, _taskId: string, expectedCreatedAt?: number) => {
		if (expectedCreatedAt !== undefined && expectedCreatedAt !== currentCreatedAt)
			throw new Error("任务已被同 ID 的新任务替换。");
		return taskCardLookupResult(currentCreatedAt);
	});
	updateCard.mockResolvedValue({ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" });
	await withCommentsDialog(<CommentsTrigger createdAt={41} />, async () => {
		await clickCommentsButton("打开评论");
		currentCreatedAt = 42;
		await addComment("只属于旧卡的评论");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("任务已被同 ID 的新任务替换");
		await clickCommentsButton("重试保存");
		expect(readCard.mock.calls.map((call) => call[2])).toEqual([41, 41, 41]);
		expect(updateCard).not.toHaveBeenCalled();
	});
});

it("保存前重读后才同 ID 重建时，最终命令仍携带旧身份供服务端拒绝", async () => {
	let currentCreatedAt = 41;
	readCard.mockImplementation(async () => {
		const result = taskCardLookupResult(currentCreatedAt);
		if (readCard.mock.calls.length === 2) currentCreatedAt = 42;
		return result;
	});
	updateCard.mockImplementation(async (input: { expectedTaskIncarnationCreatedAtEpochMs?: number }) => {
		return input.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
			input.expectedTaskIncarnationCreatedAtEpochMs !== currentCreatedAt
			? { taskCardActionCommandExecutionOutcome: "command_failed", commandFailureMessage: "最终写入身份冲突" }
			: { taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" };
	});
	await withCommentsDialog(<CommentsTrigger createdAt={41} />, async () => {
		await clickCommentsButton("打开评论");
		await addComment("不得写入新卡");
		expect(updateCard).toHaveBeenCalledWith(expect.objectContaining({ expectedTaskIncarnationCreatedAtEpochMs: 41 }));
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("最终写入身份冲突");
	});
});

it("迟到的初次读取不能改变新打开评论目标的一世身份", async () => {
	const oldRead = deferredResult<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse>();
	readCard.mockImplementation(async (_workspaceId: string, _taskId: string, expectedCreatedAt?: number) =>
		expectedCreatedAt === 41 ? await oldRead.promise : taskCardLookupResult(42, "新卡评论"),
	);
	updateCard.mockResolvedValue({ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" });
	await withCommentsDialog(
		<>
			<CommentsTrigger createdAt={41} label="打开旧卡" />
			<CommentsTrigger createdAt={42} label="打开新卡" />
		</>,
		async () => {
			await clickCommentsButton("打开旧卡");
			await clickCommentsButton("打开新卡");
			await act(async () => oldRead.resolve(taskCardLookupResult(41, "迟到旧卡评论")));
			expect(document.body.textContent).not.toContain("迟到旧卡评论");
			await addComment("为新卡保存");
			expect(updateCard).toHaveBeenCalledWith(
				expect.objectContaining({ expectedTaskIncarnationCreatedAtEpochMs: 42 }),
			);
		},
	);
});

it.each(["保存前重读", "最终写入"])("%s 迟到时，不污染另一世评论且原命令保留原身份", async (delayedStage) => {
	const delayedRead = deferredResult<RuntimeTaskCardActionReadTaskCardWithBoardColumnResponse>();
	const delayedWrite = deferredResult<{ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" }>();
	readCard.mockImplementation(async (_workspaceId: string, _taskId: string, expectedCreatedAt?: number) => {
		if (delayedStage === "保存前重读" && readCard.mock.calls.length === 2) return await delayedRead.promise;
		return taskCardLookupResult(expectedCreatedAt ?? 41);
	});
	updateCard.mockImplementation(async () =>
		delayedStage === "最终写入" && updateCard.mock.calls.length === 1
			? await delayedWrite.promise
			: { taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" },
	);
	await withCommentsDialog(
		<>
			<CommentsTrigger createdAt={41} label="打开旧卡" />
			<CommentsTrigger createdAt={42} label="打开新卡" />
		</>,
		async () => {
			await clickCommentsButton("打开旧卡");
			await addComment("旧卡待保存评论");
			await clickCommentsButton("打开新卡");
			await act(async () => {
				delayedRead.resolve(taskCardLookupResult(41));
				delayedWrite.resolve({ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime" });
			});
			expect(document.body.textContent).not.toContain("旧卡待保存评论");
			if (delayedStage === "最终写入")
				expect(updateCard.mock.calls[0]?.[0].expectedTaskIncarnationCreatedAtEpochMs).toBe(41);
			else expect(updateCard).not.toHaveBeenCalled();
			await addComment("新卡的新评论");
			expect(updateCard).toHaveBeenLastCalledWith(
				expect.objectContaining({
					expectedTaskIncarnationCreatedAtEpochMs: 42,
					taskCardFieldValuePatch: {
						taskCommentEntries: [expect.objectContaining({ commentText: "新卡的新评论" })],
					},
				}),
			);
		},
	);
});
