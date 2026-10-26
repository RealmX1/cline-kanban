import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/types";
import { type TaskCardStickersController, useTaskCardStickers } from "./use-task-card-stickers";

const { readCard, mutateSticker } = vi.hoisted(() => ({ readCard: vi.fn(), mutateSticker: vi.fn() }));
vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskCardWithBoardColumnInWorkspace: readCard,
	applyTaskStickerEntryMutationInWorkspace: mutateSticker,
}));
const card: BoardCard = {
	id: "sticker-task",
	title: "便签任务",
	prompt: "需求",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 2,
	taskStickerEntries: [
		{ taskStickerEntryId: "first", stickerText: "首行\n完整正文", isCollapsed: true, createdAt: 10, updatedAt: 10 },
	],
};
function snapshot(taskCard = card) {
	return {
		taskCard,
		boardColumnIdContainingTaskCard: "backlog",
		taskSessionSummaryLiveInRuntimeProcessMemory: null,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
	};
}
let root: Root;
let container: HTMLDivElement;
let controller: TaskCardStickersController;
function Harness({
	taskCard = card,
	workspaceId = "workspace",
	readOnly = false,
}: {
	taskCard?: BoardCard;
	workspaceId?: string;
	readOnly?: boolean;
}) {
	controller = useTaskCardStickers({ card: taskCard, workspaceId, readOnly, isDragging: false });
	return <div ref={controller.cardElementRef} />;
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	readCard.mockResolvedValue({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: snapshot(),
	});
	mutateSticker.mockResolvedValue({ boardWasSaved: true, taskCardSnapshotAfterAction: snapshot() });
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

describe("卡片便签浮层控制", () => {
	it("初始不读取，hover 不修改折叠状态，离开延迟 200ms 关闭，进入浮层取消关闭", async () => {
		await act(async () => root.render(<Harness />));
		expect(readCard).not.toHaveBeenCalled();
		await act(async () => {
			controller.pointerEnter();
			controller.activate();
		});
		expect(controller.entries[0]?.isCollapsed).toBe(true);
		expect(mutateSticker).not.toHaveBeenCalled();
		vi.useFakeTimers();
		act(() => {
			controller.pointerLeave();
			vi.advanceTimersByTime(199);
		});
		expect(controller.open).toBe(true);
		act(() => {
			controller.pointerEnter();
			vi.advanceTimersByTime(1);
		});
		expect(controller.open).toBe(true);
		act(() => {
			controller.pointerLeave();
			vi.advanceTimersByTime(200);
		});
		expect(controller.open).toBe(false);
	});

	it("触屏抬手保留浮层，编辑结束后首次外部点按关闭", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew(undefined, "touch_activation"));
		vi.useFakeTimers();
		act(() => {
			controller.pointerLeave();
			vi.advanceTimersByTime(200);
			document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		});
		expect(controller.open).toBe(true);
		expect(controller.editor).not.toBeNull();
		act(() => controller.cancelEditing());
		act(() => {
			vi.advanceTimersByTime(200);
			controller.cardElementRef.current!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		});
		expect(controller.open).toBe(true);
		act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
		expect(controller.open).toBe(false);
	});

	it.each(["保存", "取消"])("指针打开的新便签%s后，已在外部的指针仍触发 200ms 关闭", async (finishEditing) => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("编辑期间保留的正文"));
		const taskStickerEntryId = controller.editor!.taskStickerEntryId;
		mutateSticker.mockResolvedValueOnce({
			boardWasSaved: true,
			taskCardSnapshotAfterAction: snapshot({
				...card,
				taskStickerEntries: [
					...card.taskStickerEntries!,
					{
						taskStickerEntryId,
						stickerText: "编辑期间保留的正文",
						isCollapsed: false,
						createdAt: 20,
						updatedAt: 20,
					},
				],
			}),
		});
		vi.useFakeTimers();
		act(() => {
			controller.pointerLeave();
			vi.advanceTimersByTime(200);
		});
		expect(controller.open).toBe(true);
		await act(async () => {
			if (finishEditing === "保存") controller.saveDraft();
			else controller.cancelEditing();
		});
		expect(controller.editor).toBeNull();
		act(() => vi.advanceTimersByTime(199));
		expect(controller.open).toBe(true);
		act(() => vi.advanceTimersByTime(1));
		expect(controller.open).toBe(false);
	});

	it("保存失败保留草稿，重试复用创建 ID；编辑期间不因离开而关闭", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("需要保存的草稿"));
		const entryId = controller.editor!.taskStickerEntryId;
		mutateSticker.mockRejectedValueOnce(new Error("保存失败"));
		await act(async () => controller.saveDraft());
		expect(controller.editor?.stickerText).toBe("需要保存的草稿");
		expect(controller.error).toContain("保存失败");
		vi.useFakeTimers();
		act(() => {
			controller.pointerLeave();
			vi.advanceTimersByTime(200);
		});
		expect(controller.open).toBe(true);
		vi.useRealTimers();
		mutateSticker.mockResolvedValueOnce({
			boardWasSaved: true,
			taskCardSnapshotAfterAction: snapshot({
				...card,
				taskStickerEntries: [
					...card.taskStickerEntries!,
					{
						taskStickerEntryId: entryId,
						stickerText: "需要保存的草稿",
						isCollapsed: false,
						createdAt: 20,
						updatedAt: 20,
					},
				],
			}),
		});
		await act(async () => controller.saveDraft());
		expect(mutateSticker).toHaveBeenCalledTimes(2);
		for (const call of mutateSticker.mock.calls)
			expect(call).toMatchObject([
				"workspace",
				{
					taskId: card.id,
					expectedTaskIncarnationCreatedAtEpochMs: 1,
					mutation: { operation: "create", taskStickerEntryId: entryId, stickerText: "需要保存的草稿" },
				},
			]);
		expect(controller.editor).toBeNull();
	});

	it("同 ID 重建与切换工作区后丢弃迟到的写入响应", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("旧任务草稿"));
		let finishSave!: (value: unknown) => void;
		mutateSticker.mockReturnValueOnce(
			new Promise((resolve) => {
				finishSave = resolve;
			}),
		);
		act(() => controller.saveDraft());
		const recreated = { ...card, createdAt: 100, taskStickerEntries: [] };
		await act(async () => root.render(<Harness taskCard={recreated} workspaceId="different-workspace" />));
		await act(async () => finishSave({ boardWasSaved: true, taskCardSnapshotAfterAction: snapshot(card) }));
		expect(controller.entries).toEqual([]);
		expect(controller.editor).toBeNull();
		expect(controller.isSaving).toBe(false);
	});

	it("创建已落盘但响应丢失后修改草稿，重试不能静默丢弃新草稿", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("首次保存"));
		const taskStickerEntryId = controller.editor!.taskStickerEntryId;
		mutateSticker.mockRejectedValueOnce(new Error("响应丢失"));
		await act(async () => controller.saveDraft());
		act(() => controller.setDraftText("响应丢失后的新草稿"));
		mutateSticker.mockResolvedValueOnce({
			boardWasSaved: false,
			taskCardSnapshotAfterAction: snapshot({
				...card,
				taskStickerEntries: [
					...card.taskStickerEntries!,
					{ taskStickerEntryId, stickerText: "首次保存", isCollapsed: false, createdAt: 20, updatedAt: 20 },
				],
			}),
		});
		await act(async () => controller.saveDraft());
		expect(controller.editor?.stickerText).toBe("响应丢失后的新草稿");
		expect(controller.error).toContain("之前已保存了不同正文");
		expect(controller.entries.find((entry) => entry.taskStickerEntryId === taskStickerEntryId)?.stickerText).toBe(
			"首次保存",
		);
	});

	it("切换到别的工作区再回到原任务，旧代请求不能清掉本轮草稿", async () => {
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("早先的草稿"));
		const earlierEntryId = controller.editor!.taskStickerEntryId;
		let finishSave!: (value: unknown) => void;
		mutateSticker.mockReturnValueOnce(
			new Promise((resolve) => {
				finishSave = resolve;
			}),
		);
		act(() => controller.saveDraft());
		await act(async () => root.render(<Harness workspaceId="another-workspace" />));
		await act(async () => root.render(<Harness />));
		await act(async () => controller.startNew());
		act(() => controller.setDraftText("本轮需要保留的草稿"));
		await act(async () =>
			finishSave({
				boardWasSaved: true,
				taskCardSnapshotAfterAction: snapshot({
					...card,
					taskStickerEntries: [
						...card.taskStickerEntries!,
						{
							taskStickerEntryId: earlierEntryId,
							stickerText: "早先的草稿",
							isCollapsed: false,
							createdAt: 20,
							updatedAt: 20,
						},
					],
				}),
			}),
		);
		expect(controller.editor?.stickerText).toBe("本轮需要保留的草稿");
	});

	it("迟到旧快照不能撤销折叠或复活已删除条目", async () => {
		await act(async () => root.render(<Harness />));
		mutateSticker.mockResolvedValueOnce({
			boardWasSaved: true,
			taskCardSnapshotAfterAction: snapshot({
				...card,
				taskStickerEntries: [],
				taskStickerDeletedEntryIds: ["first"],
			}),
		});
		await act(async () =>
			controller.mutate({ operation: "delete", taskStickerEntryId: "first", expectedStickerText: "首行\n完整正文" }),
		);
		await act(async () =>
			root.render(<Harness taskCard={{ ...card, taskStickerEntries: [...card.taskStickerEntries!] }} />),
		);
		expect(controller.entries).toEqual([]);
	});

	it("永久删除历史只展示，不读取或写入活动任务", async () => {
		await act(async () => root.render(<Harness readOnly />));
		await act(async () => {
			controller.activate();
			controller.startNew();
		});
		await act(async () =>
			controller.mutate({ operation: "set_collapsed", taskStickerEntryId: "first", isCollapsed: false }),
		);
		expect(controller.entries[0]?.isCollapsed).toBe(false);
		expect(readCard).not.toHaveBeenCalled();
		expect(mutateSticker).not.toHaveBeenCalled();
	});
});
