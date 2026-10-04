import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardColumn } from "@/components/board-column";
import {
	clearAllBoardColumnScrollOffsets,
	readBoardColumnScrollOffset,
} from "@/stores/board-column-scroll-offset-store";
import type { BoardCard, BoardColumn as BoardColumnModel } from "@/types";

// BoardColumn 只需要 Droppable 的 render-prop 容器；dnd 的拖拽维度测量与本测试无关。
vi.mock("@hello-pangea/dnd", () => ({
	Droppable: ({
		children,
	}: {
		children: (provided: {
			innerRef: (element: HTMLElement | null) => void;
			droppableProps: Record<string, never>;
			placeholder: null;
		}) => ReactNode;
	}): React.ReactElement => <>{children({ innerRef: () => {}, droppableProps: {}, placeholder: null })}</>,
}));

// 卡片本体与本测试无关，只保留 data-task-id 骨架。
vi.mock("@/components/board-card", () => ({
	BoardCard: ({ card }: { card: BoardCard }): React.ReactElement => <div data-task-id={card.id} />,
}));

function makeCard(id: string): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

const column: BoardColumnModel = {
	id: "backlog",
	title: "Backlog",
	cards: [makeCard("task-1"), makeCard("task-2"), makeCard("task-3")],
};

describe("BoardColumn scroll offset restore", () => {
	let container: HTMLDivElement | null;
	let root: Root | null;
	let rafCallbacks: FrameRequestCallback[];
	let previousActEnvironment: boolean | undefined;

	// 滚动写入经 rAF 折叠成每帧至多一次；手动队列让「何时 flush」完全受控。
	const flushRaf = (): void => {
		const pending = rafCallbacks;
		rafCallbacks = [];
		for (const callback of pending) {
			callback(0);
		}
	};

	const mountColumn = async (workspacePath: string | null): Promise<void> => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(<BoardColumn column={column} taskSessions={{}} workspacePath={workspacePath} />);
		});
	};

	const unmountColumn = (): void => {
		const mountedRoot = root;
		root = null;
		if (mountedRoot) {
			act(() => {
				mountedRoot.unmount();
			});
		}
		container?.remove();
		container = null;
	};

	const cardsScrollContainer = (): HTMLElement => {
		const element = container?.querySelector<HTMLElement>(".kb-column-cards");
		if (!element) {
			throw new Error("cards scroll container not rendered");
		}
		return element;
	};

	beforeEach(() => {
		clearAllBoardColumnScrollOffsets();
		rafCallbacks = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		unmountColumn();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("restores the memorized scroll offset after unmount and remount (Focus View round-trip)", async () => {
		await mountColumn("/repo-a");

		// 用户滚动到 120px：先经 rAF 折叠写入一次，卸载时再落一次最终值。
		cardsScrollContainer().scrollTop = 120;
		await act(async () => {
			cardsScrollContainer().dispatchEvent(new Event("scroll"));
		});
		await act(async () => {
			flushRaf();
		});
		unmountColumn();

		expect(readBoardColumnScrollOffset("/repo-a", "backlog")).toEqual({
			scrollTop: 120,
			revealedCardCount: 3,
		});

		// 从详情页返回 = 整列全新挂载：useLayoutEffect 应在绘制前把 scrollTop 补回来。
		await mountColumn("/repo-a");
		expect(cardsScrollContainer().scrollTop).toBe(120);
	});

	it("starts at the top when nothing was memorized for the workspace", async () => {
		await mountColumn("/repo-never-scrolled");
		expect(cardsScrollContainer().scrollTop).toBe(0);
		expect(readBoardColumnScrollOffset("/repo-never-scrolled", "backlog")).toBeUndefined();
	});
});

describe("BoardColumn collapse button and width style", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders a collapse button only when the board passes a collapse handler", async () => {
		await act(async () => {
			root.render(<BoardColumn column={column} taskSessions={{}} />);
		});
		expect(container.querySelector('button[aria-label="Collapse Backlog column"]')).toBeNull();

		const onCollapseColumn = vi.fn();
		await act(async () => {
			root.render(<BoardColumn column={column} taskSessions={{}} onCollapseColumn={onCollapseColumn} />);
		});
		await act(async () => {
			container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Backlog column"]')?.click();
		});
		expect(onCollapseColumn).toHaveBeenCalledWith("backlog");
	});

	it("uses the board-provided flex style and falls back to equal fill", async () => {
		await act(async () => {
			root.render(<BoardColumn column={column} taskSessions={{}} />);
		});
		expect(container.querySelector<HTMLElement>("section[data-column-id]")?.style.flex).toBe("1 1 0px");

		await act(async () => {
			root.render(<BoardColumn column={column} taskSessions={{}} columnFlexStyle={{ flex: "0 0 420px" }} />);
		});
		expect(container.querySelector<HTMLElement>("section[data-column-id]")?.style.flex).toBe("0 0 420px");
	});
});
