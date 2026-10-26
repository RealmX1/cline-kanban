import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermanentlyDeletedTaskHistoryDialog } from "@/components/permanently-deleted-task-history-dialog";
import * as taskCardActionQueries from "@/runtime/task-card-action-query";
import type { ListPermanentlyDeletedTaskCardsResponse } from "@/runtime/types";

const readHistory = vi.hoisted(() => vi.fn());
const readVersions = vi.hoisted(() => vi.fn());
const showAppToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast }));
vi.mock("@/runtime/permanently-deleted-task-history-query", () => ({
	readPermanentlyDeletedTaskCards: readHistory,
	readPermanentlyDeletedTaskPromptVersions: readVersions,
}));

const longPrompt = `  第一段\r\n\n${"完整需求😀\n".repeat(200)}  `;
const page: ListPermanentlyDeletedTaskCardsResponse = {
	entries: [
		{
			kanbanBoardCard: {
				workUnitType: "kanban_board_card",
				workspaceId: "rvf",
				taskId: "3c487",
				taskIncarnationCreatedAtEpochMs: 1000,
			},
			workspaceRepositoryPath: null,
			titleBeforePermanentRemoval: "已删除标题",
			permanentlyRemovedFromBoardAt: 2000,
			promptPreview: "删除前预览",
			matchedPromptVersions: [],
		},
	],
	nextCursor: null,
	knownWorkspaces: [{ workspaceId: "rvf", workspaceRepositoryPath: null }],
};

describe("已删除 Task 弹窗", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousClipboard: PropertyDescriptor | undefined;
	beforeEach(() => {
		vi.clearAllMocks();
		previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		readHistory.mockResolvedValue(page);
		readVersions.mockResolvedValue({
			beforePermanentRemoval: { availability: "available", text: longPrompt },
			atCreation: { availability: "available", text: "最初版本" },
			comparison: "different",
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	const mount = async () => {
		await act(async () => {
			root.render(
				<PermanentlyDeletedTaskHistoryDialog
					currentProjectId="rvf"
					defaultWorkspaceId="rvf"
					projects={[{ id: "rvf", name: "RVF Project" }]}
					onClose={() => {}}
				/>,
			);
		});
	};
	const click = async (label: string) => {
		const button = [...document.querySelectorAll("button")].find(
			(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label,
		);
		expect(button, label).toBeTruthy();
		await act(async () => button?.click());
	};
	it("直接展示 Expanded Task Cards，无活卡操作，默认删除前版本并逐字复制", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		await mount();
		expect(
			document.querySelector('[data-task-card-render-role="permanently_deleted_task_history_card"]'),
		).toBeTruthy();
		expect(document.body.textContent).toContain("已永久删除");
		expect(
			document.querySelector(
				'[data-task-card-render-role="permanently_deleted_task_history_card"] [aria-haspopup="menu"]',
			),
		).toBeNull();
		expect(
			document.querySelector(
				'[aria-label="Start task"], [aria-label="Restore task"], [aria-label="Edit task title"], [data-task-directory-copy-actions]',
			),
		).toBeNull();
		await click("查看完整 Prompt");
		await click("复制完整 Prompt");
		expect(writeText).toHaveBeenLastCalledWith(longPrompt);
		await click("创建时 Prompt");
		await click("复制完整 Prompt");
		expect(writeText).toHaveBeenLastCalledWith("最初版本");
		expect(readHistory).toHaveBeenCalledWith({ workspaceId: "rvf", query: "", cursor: null });
	});
	it("删除前便签可只读展开，不查询或修改同 ID 活动卡，跨项目身份切换清理本地状态", async () => {
		const readActiveCard = vi.spyOn(taskCardActionQueries, "readTaskCardWithBoardColumnInWorkspace");
		const writeActiveCard = vi.spyOn(taskCardActionQueries, "applyTaskStickerEntryMutationInWorkspace");
		const stickerText = "历史便签首行\n只能从删除前快照读取的正文";
		const entry = {
			...page.entries[0]!,
			taskStickerEntries: [
				{ taskStickerEntryId: "historical-sticker", stickerText, isCollapsed: true, createdAt: 10, updatedAt: 20 },
			],
		};
		readHistory.mockResolvedValue({ ...page, entries: [entry] });
		await mount();
		await click("便签 1");
		expect(document.querySelector("[data-task-sticker-overlay]")?.textContent).toContain("历史便签首行");
		expect(document.querySelector('[aria-label="展开便签"]')).toBeTruthy();
		await click("展开便签");
		expect(document.querySelector("[data-task-sticker-overlay]")?.textContent).toContain(stickerText);
		expect(document.querySelector('[aria-label="编辑便签"], [aria-label="删除便签"]')).toBeNull();
		expect(document.body.textContent).not.toContain("添加便签");
		await click("关闭便签");
		readHistory.mockResolvedValue({
			...page,
			entries: [{ ...entry, kanbanBoardCard: { ...entry.kanbanBoardCard, workspaceId: "other-project" } }],
		});
		await click("刷新已删除 Task");
		await click("便签 1");
		expect(document.querySelector('[aria-label="展开便签"]')).toBeTruthy();
		expect(readActiveCard).not.toHaveBeenCalled();
		expect(writeActiveCard).not.toHaveBeenCalled();
		expect(entry.taskStickerEntries[0]?.isCollapsed).toBe(true);
	});
	it("缺失删除前版本时不复制预览，允许主动切换到创建时版本", async () => {
		readVersions.mockResolvedValue({
			beforePermanentRemoval: { availability: "content_missing_or_invalid", text: null },
			atCreation: { availability: "available", text: "唯一可用版本" },
			comparison: "unknown",
		});
		await mount();
		await click("查看完整 Prompt");
		expect(document.body.textContent).toContain("正文缺失或损坏");
		const copy = [...document.querySelectorAll("button")].find((button) => button.textContent === "复制完整 Prompt");
		expect(copy?.disabled).toBe(true);
		await click("创建时 Prompt");
		expect(document.querySelector("pre")?.textContent).toBe("唯一可用版本");
	});
	it("先成功后失败的复制不继续显示成功状态", async () => {
		const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("拒绝复制"));
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		await mount();
		await click("查看完整 Prompt");
		await click("复制完整 Prompt");
		await click("已复制");
		expect([...document.querySelectorAll("button")].some((button) => button.textContent === "已复制")).toBe(false);
	});
	it("切换 Prompt 版本后，旧复制请求完成不能显示当前版本已复制", async () => {
		let finishPreviousCopy: (() => void) | undefined;
		const previousCopy = new Promise<void>((resolve) => {
			finishPreviousCopy = resolve;
		});
		const writeText = vi.fn().mockReturnValue(previousCopy);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		await mount();
		await click("查看完整 Prompt");
		await click("复制完整 Prompt");
		expect(writeText).toHaveBeenLastCalledWith(longPrompt);
		await click("创建时 Prompt");
		await act(async () => finishPreviousCopy?.());
		expect(document.querySelector("pre")?.textContent).toBe("最初版本");
		expect([...document.querySelectorAll("button")].some((button) => button.textContent === "已复制")).toBe(false);
	});
	it("旧复制请求晚到的失败不能覆盖新复制的成功状态或弹出过时错误", async () => {
		let failPreviousCopy: ((reason: Error) => void) | undefined;
		const previousCopy = new Promise<void>((_resolve, reject) => {
			failPreviousCopy = reject;
		});
		const writeText = vi.fn().mockReturnValueOnce(previousCopy).mockResolvedValueOnce(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		await mount();
		await click("查看完整 Prompt");
		await click("复制完整 Prompt");
		await click("复制完整 Prompt");
		await act(async () => failPreviousCopy?.(new Error("旧请求被拒绝")));
		expect([...document.querySelectorAll("button")].some((button) => button.textContent === "已复制")).toBe(true);
		expect(showAppToast).not.toHaveBeenCalled();
	});
	it("重复复制后，旧提示定时器不能提前清除新的成功提示", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		await mount();
		await click("查看完整 Prompt");
		await click("复制完整 Prompt");
		act(() => vi.advanceTimersByTime(1000));
		await click("已复制");
		act(() => vi.advanceTimersByTime(500));
		expect([...document.querySelectorAll("button")].some((button) => button.textContent === "已复制")).toBe(true);
		act(() => vi.advanceTimersByTime(1000));
		expect([...document.querySelectorAll("button")].some((button) => button.textContent === "已复制")).toBe(false);
	});
	it("服务不可用与无历史分别显示，不冒充空查询成功", async () => {
		readHistory.mockRejectedValue(new Error("账本不可用"));
		await mount();
		expect(document.body.textContent).toContain("账本不可用");
		expect(document.body.textContent).not.toContain("未找到已删除 Task");
		readHistory.mockResolvedValue({ ...page, entries: [] });
		await click("重试查询");
		expect(document.body.textContent).toContain("未找到已删除 Task");
	});
});
