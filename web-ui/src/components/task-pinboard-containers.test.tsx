import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPinboardSectionInFocusView } from "@/components/detail-panels/task-pinboard-section-in-focus-view";
import { TaskPinboardStripOnKanbanBoard } from "@/components/task-pinboard-strip-on-kanban-board";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";

// 两个置顶板容器的共同契约：0 张时整块不渲染、折叠态落 localStorage、分身不携带 data-task-id
// （全局唯一是「点 stage 标签跳回本体卡」以及依赖连线锚点能工作的前提）。

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
}));

function createPinnedTask(id: string, overrides: Partial<BoardCard> = {}): TaskPinnedToTaskPinboard {
	return {
		card: {
			id,
			title: `Task ${id}`,
			prompt: `Prompt ${id}`,
			startInPlanMode: false,
			baseRef: "main",
			createdAt: Date.now() - 60_000,
			updatedAt: Date.now(),
			pinnedToTaskPinboardAt: 5_000,
			...overrides,
		},
		columnId: "review",
		columnTitle: "Review",
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function render(children: ReactNode): HTMLDivElement {
	act(() => root.render(children));
	return container;
}

function findHeaderToggle(host: HTMLElement): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Pinned"));
}

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
	container.remove();
	window.localStorage.clear();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("主看板顶部的置顶板横条", () => {
	const baseProps = {
		taskSessions: {},
		handlers: {},
		onActivateCard: () => {},
		onRevealCanonicalCardInItsStage: () => {},
		onEditTaskPinboardPinReason: () => {},
	};

	// 一张都没置顶时不该平白占掉 40px 看板高度。
	it("0 张置顶时整条不渲染", () => {
		const host = render(<TaskPinboardStripOnKanbanBoard {...baseProps} pinnedTasks={[]} />);
		expect(host.querySelector('[data-task-pinboard-container="kanban-board-strip"]')).toBeNull();
	});

	it("渲染分身，且分身不携带 data-task-id", () => {
		const host = render(<TaskPinboardStripOnKanbanBoard {...baseProps} pinnedTasks={[createPinnedTask("task-a")]} />);
		expect(host.querySelector('[data-task-pinboard-container="kanban-board-strip"]')).not.toBeNull();
		expect(host.querySelectorAll("[data-task-id]").length).toBe(0);
		expect(host.querySelectorAll('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]').length).toBe(1);
	});

	it("折叠后隐藏分身，并把折叠态写进 localStorage", () => {
		const host = render(<TaskPinboardStripOnKanbanBoard {...baseProps} pinnedTasks={[createPinnedTask("task-a")]} />);
		act(() => findHeaderToggle(host)?.click());

		expect(host.querySelectorAll('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]').length).toBe(0);
		expect(window.localStorage.getItem(LocalStorageKey.TaskPinboardStripCollapsedOnKanbanBoard)).toBe("true");
		// 卡头本身仍在，否则折叠后就没有入口再展开。
		expect(findHeaderToggle(host)).toBeInstanceOf(HTMLButtonElement);
	});

	it("点分身上的 stage 标签请求跳回本体卡", () => {
		const onRevealCanonicalCardInItsStage = vi.fn();
		const host = render(
			<TaskPinboardStripOnKanbanBoard
				{...baseProps}
				pinnedTasks={[createPinnedTask("task-a")]}
				onRevealCanonicalCardInItsStage={onRevealCanonicalCardInItsStage}
			/>,
		);
		act(() => host.querySelector<HTMLButtonElement>("[data-task-pinboard-stage-label]")?.click());
		expect(onRevealCanonicalCardInItsStage).toHaveBeenCalledWith("task-a");
	});
});

describe("Focus View 左侧的置顶板分段", () => {
	const baseProps = {
		selectedCardId: null,
		taskSessions: {},
		handlers: {},
		onActivateCard: () => {},
		onRevealCanonicalCardInItsStage: () => {},
		onEditTaskPinboardPinReason: () => {},
	};

	it("0 张置顶时整段不渲染", () => {
		const host = render(<TaskPinboardSectionInFocusView {...baseProps} pinnedTasks={[]} />);
		expect(host.querySelector('[data-task-pinboard-container="focus-view-section"]')).toBeNull();
	});

	// 带上 data-stage-section-id 会被 useStageHeaderPinLayout 当成第六个 stage 卷进卡头手风琴。
	it("不冒充 stage 分段，且分身不携带 data-task-id", () => {
		const host = render(<TaskPinboardSectionInFocusView {...baseProps} pinnedTasks={[createPinnedTask("task-a")]} />);
		expect(host.querySelector('[data-task-pinboard-container="focus-view-section"]')).not.toBeNull();
		expect(host.querySelector("[data-stage-section-id]")).toBeNull();
		expect(host.querySelectorAll("[data-task-id]").length).toBe(0);
	});

	// 两处的纵向空间预算不同，折叠态各存各的键，不联动。
	it("折叠态存在与横条不同的 localStorage 键下", () => {
		const host = render(<TaskPinboardSectionInFocusView {...baseProps} pinnedTasks={[createPinnedTask("task-a")]} />);
		act(() => findHeaderToggle(host)?.click());

		expect(window.localStorage.getItem(LocalStorageKey.TaskPinboardSectionCollapsedInFocusView)).toBe("true");
		expect(window.localStorage.getItem(LocalStorageKey.TaskPinboardStripCollapsedOnKanbanBoard)).toBeNull();
	});

	it("选中的任务被置顶时，它的分身也标为 selected", () => {
		const host = render(
			<TaskPinboardSectionInFocusView
				{...baseProps}
				selectedCardId="task-a"
				pinnedTasks={[createPinnedTask("task-a"), createPinnedTask("task-b")]}
			/>,
		);
		const shells = [...host.querySelectorAll<HTMLElement>(".kb-board-card-shell")];
		expect(shells.map((shell) => shell.getAttribute("data-selected"))).toEqual(["true", "false"]);
	});
});
