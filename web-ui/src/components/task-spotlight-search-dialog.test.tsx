import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskSpotlightSearchDialog } from "@/components/task-spotlight-search-dialog";
import type { TaskSpotlightSearchController } from "@/hooks/use-task-spotlight-search-controller";

const { mockUseIsMobile } = vi.hoisted(() => ({ mockUseIsMobile: vi.fn(() => false) }));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => mockUseIsMobile(),
}));

/**
 * `TaskSpotlightSearchController` 是纯 interface，直接造 stub 即可，无需跑真 hook。
 * 刻意保持 `results: []` + `isSearchActive: false` 走空态分支——Virtuoso 因此根本不渲染，
 * 从而不必 mock `react-virtuoso`（全仓无此先例）。
 */
function createControllerStub(overrides: Partial<TaskSpotlightSearchController> = {}): TaskSpotlightSearchController {
	return {
		isOpen: true,
		canOpen: true,
		open: () => {},
		close: () => {},
		toggle: () => {},
		query: "",
		setQuery: () => {},
		mode: "direct",
		setMode: () => {},
		stageOptions: [
			{ columnId: "backlog", label: "Backlog", isSelected: true },
			{ columnId: "in_progress", label: "In Progress", isSelected: true },
		],
		toggleStage: () => {},
		includeOtherProjects: false,
		setIncludeOtherProjects: () => {},
		crossProjectStatus: "idle",
		isSearchActive: false,
		semanticSearchStatus: "idle",
		results: [],
		activeIndex: 0,
		setActiveIndex: () => {},
		moveActive: () => {},
		openActiveResult: () => {},
		openResultAt: () => {},
		currentProjectId: "alpha",
		...overrides,
	};
}

function queryDialogContent(): HTMLElement | null {
	return document.body.querySelector("[data-task-spotlight-search-dialog]");
}

describe("TaskSpotlightSearchDialog viewport adaptation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockUseIsMobile.mockReturnValue(false);
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

	async function renderDialog(overrides: Partial<TaskSpotlightSearchController> = {}): Promise<void> {
		await act(async () => {
			root.render(<TaskSpotlightSearchDialog controller={createControllerStub(overrides)} />);
		});
	}

	it("keeps the desktop dialog top-aligned with keyboard hints and no close button", async () => {
		await renderDialog();

		const content = queryDialogContent();
		expect(content).toBeInstanceOf(HTMLElement);
		expect(content?.className).toContain("top-[12vh]");
		expect(content?.className).not.toContain("h-[100svh]");
		// 桌面端有 overlay 可点、有 Esc，关闭按钮是纯噪声。
		expect(document.body.querySelector('button[aria-label="Close search"]')).toBeNull();
		expect(content?.textContent).toContain("navigate");
	});

	it("goes fullscreen on mobile and keeps an explicit close path", async () => {
		mockUseIsMobile.mockReturnValue(true);
		const close = vi.fn();
		await renderDialog({ close });

		const content = queryDialogContent();
		expect(content?.className).toContain("h-[100svh]");
		expect(content?.className).not.toContain("top-[12vh]");

		// 最重要的回归护栏：全屏后四周没有 overlay 可点，mobile 又没有 Esc——
		// 这个按钮一旦丢失，Spotlight 就会「打得开、关不掉」。
		const closeButton = document.body.querySelector('button[aria-label="Close search"]');
		expect(closeButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => (closeButton as HTMLButtonElement).click());
		expect(close).toHaveBeenCalledTimes(1);

		// 无物理键盘，↑↓/↵/esc 提示是无效信息，读屏还会念出来，故真删不隐藏。
		expect(content?.textContent).not.toContain("navigate");
	});

	it("uses a 16px input and 44px filter chips on mobile", async () => {
		mockUseIsMobile.mockReturnValue(true);
		await renderDialog();

		// iOS Safari 聚焦小于 16px 的输入框会把整页放大，且失焦后不缩回。
		const input = document.body.querySelector('input[aria-label="Search tasks"]');
		expect(input?.className).toContain("text-base");
		expect(input?.className).not.toContain("text-[15px]");

		const stageChip = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent === "Backlog",
		);
		expect(stageChip?.className).toContain("min-h-[44px]");

		// 「All projects」是同一行里唯一非 <button> 的可点控件（label+switch）；必须和相邻 chip 共用
		// 同一 44px 触控下限，否则手指落点稍偏就会点空或误触隔壁 chip。
		const allProjectsLabel = document.body.querySelector('label[for="task-spotlight-include-other-projects"]');
		expect(allProjectsLabel?.className).toContain("min-h-[44px]");
		expect(allProjectsLabel?.className).toContain("min-w-[44px]");
	});

	it("keeps the All projects toggle right-aligned via ml-auto on desktop", async () => {
		mockUseIsMobile.mockReturnValue(false);
		await renderDialog();

		const allProjectsLabel = document.body.querySelector('label[for="task-spotlight-include-other-projects"]');
		expect(allProjectsLabel?.className).toContain("ml-auto");
		expect(allProjectsLabel?.className).not.toContain("min-h-[44px]");
	});
});
