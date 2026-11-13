import type * as FloatingUiDom from "@floating-ui/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskCardBody } from "@/components/task-card-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BoardCard } from "@/types";

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
	useTaskWorkspaceInfoValue: () => null,
}));
vi.mock("@/components/task-comments-dialog-provider", () => ({
	useTaskCommentsDialog: () => ({ currentWorkspaceId: "sticker-workspace", openTaskComments: vi.fn() }),
}));
vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskCardWithBoardColumnInWorkspace: async () => ({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: { taskCard: stickerTaskCard },
	}),
}));
vi.mock("@floating-ui/dom", async (importOriginal) => ({
	...(await importOriginal<typeof FloatingUiDom>()),
	autoUpdate: (_anchor: HTMLElement, _floating: HTMLElement, update: () => void) => {
		update();
		return () => {};
	},
	computePosition: async () => ({ x: 10, y: 20, placement: "top-end", strategy: "fixed", middlewareData: {} }),
}));

const stickerTaskCard: BoardCard = {
	id: "sticker-focus-restoration-task",
	title: "便签编辑器焦点恢复",
	prompt: "便签焦点回归",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 2,
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	// jsdom 没有 inert 焦点约束；只补这一浏览器规则，组件与焦点事件仍使用真实实现。
	const focusWithoutInertConstraint = HTMLElement.prototype.focus;
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
		if (!this.closest("[inert]")) focusWithoutInertConstraint.call(this, options);
	});
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function renderStickerTaskCard(taskCard = stickerTaskCard) {
	await act(async () =>
		root.render(
			<TooltipProvider>
				<TaskCardBody card={taskCard} columnId="review" />
			</TooltipProvider>,
		),
	);
}

async function openStickerEditorFromFloatingToolbar() {
	await renderStickerTaskCard();
	const placeholder = container.querySelector<HTMLElement>("[data-task-card-action-toolbar-placeholder]")!;
	await act(async () => placeholder.focus());
	const toolbar = document.querySelector<HTMLElement>("[data-task-card-primary-actions]")!;
	const opener = toolbar.querySelector<HTMLButtonElement>('[aria-label="添加便签"]')!;
	await act(async () => {
		opener.focus();
		opener.click();
	});
	await act(async () => vi.advanceTimersByTime(32));
	const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="便签正文"]')!;
	expect(document.activeElement).toBe(editor);
	return { toolbar, opener, editor };
}

it("便签编辑器持有键盘焦点时，来源浮动工具栏仍可交互", async () => {
	const { toolbar } = await openStickerEditorFromFloatingToolbar();
	expect(toolbar.getAttribute("data-task-card-action-toolbar-state")).toBe("visible");
	expect(toolbar.hasAttribute("inert")).toBe(false);
});

it("Escape 在关闭便签前交回焦点，避免关闭后的 inert 阻断原按钮", async () => {
	const { toolbar, opener, editor } = await openStickerEditorFromFloatingToolbar();
	await act(async () =>
		editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
	);
	await act(async () => vi.advanceTimersByTime(1));
	expect(document.querySelector("[data-task-sticker-overlay]")).toBeNull();
	expect(document.activeElement === opener).toBe(true);
	expect(toolbar.hasAttribute("inert")).toBe(false);
});

it("卡片底部便签入口打开后 Escape 仍返回原入口，不转到浮动工具栏", async () => {
	await renderStickerTaskCard({
		...stickerTaskCard,
		taskStickerEntries: [
			{
				taskStickerEntryId: "existing-sticker",
				stickerText: "已有便签",
				isCollapsed: false,
				createdAt: 1,
				updatedAt: 1,
			},
		],
	});
	const stub = container.querySelector<HTMLButtonElement>("[data-task-sticker-stub]")!;
	await act(async () => {
		stub.focus();
		stub.click();
	});
	expect(document.querySelector("[data-task-sticker-overlay]")?.contains(document.activeElement)).toBe(true);
	await act(async () =>
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		),
	);
	await act(async () => vi.advanceTimersByTime(1));
	expect(document.querySelector("[data-task-sticker-overlay]")).toBeNull();
	expect(document.activeElement === stub).toBe(true);
});
