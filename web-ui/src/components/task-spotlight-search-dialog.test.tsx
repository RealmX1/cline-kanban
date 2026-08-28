import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskSpotlightSearchDialog } from "@/components/task-spotlight-search-dialog";
import { DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY } from "@/components/task-spotlight-search-result-row-field-visibility";
import type { TaskSpotlightSearchController } from "@/hooks/use-task-spotlight-search-controller";
import { EMPTY_TASK_FILTER_SELECTION } from "@/task-filtering/task-filter-selection";

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
		sortOrder: "relevance",
		setSortOrder: () => {},
		effectiveSortOrder: "relevance",
		filterSelection: EMPTY_TASK_FILTER_SELECTION,
		setFilterSelection: () => {},
		availableFilterValues: {
			stageColumnIds: [
				{ value: "backlog", label: "Backlog" },
				{ value: "in_progress", label: "In Progress" },
			],
			projects: [],
			agents: [],
		},
		fieldVisibility: DEFAULT_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_VISIBILITY,
		toggleFieldVisibility: () => {},
		includeOtherProjects: false,
		setIncludeOtherProjects: () => {},
		crossProjectStatus: "idle",
		isSearchActive: false,
		isBrowsingAllTasksWithoutQuery: false,
		semanticSearchStatus: "idle",
		results: [],
		taskIdMatchedResultCountHiddenByFilters: 0,
		resultCountExcludedBecauseSessionActivityIsNotObservable: 0,
		resolveResultRowDisplayContext: () => ({
			effectiveAgentId: null,
			agentLabel: null,
			sessionActivity: null,
			agentConversationProgressAtEpochMs: null,
		}),
		nowEpochMs: 0,
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

	it("uses a 16px input and 44px toolbar controls on mobile", async () => {
		mockUseIsMobile.mockReturnValue(true);
		await renderDialog();

		// iOS Safari 聚焦小于 16px 的输入框会把整页放大，且失焦后不缩回。
		const input = document.body.querySelector('input[aria-label="Search tasks"]');
		expect(input?.className).toContain("text-base");
		expect(input?.className).not.toContain("text-[15px]");

		// stage chips 已收进 Filters 浮层（默认关着），工具栏上代表它的是这个触发按钮。
		const filtersTrigger = document.body.querySelector('button[aria-label="Filter tasks"]');
		expect(filtersTrigger?.className).toContain("min-h-[44px]");

		// 「All projects」是同一行里唯一非 <button> 的可点控件（label+switch）；必须和相邻 chip 共用
		// 同一 44px 触控下限，否则手指落点稍偏就会点空或误触隔壁 chip。
		const allProjectsLabel = document.body.querySelector('label[for="task-spotlight-include-other-projects"]');
		expect(allProjectsLabel?.className).toContain("min-h-[44px]");
		expect(allProjectsLabel?.className).toContain("min-w-[44px]");
	});

	it("explains that a task id matched but the task is filtered out", async () => {
		// 否则用户拷了个完整 task id 却看到 "No matching tasks"，会以为任务根本不存在。
		await renderDialog({
			isSearchActive: true,
			query: "a3f21",
			results: [],
			taskIdMatchedResultCountHiddenByFilters: 1,
		});

		expect(queryDialogContent()?.textContent).toContain("Task ID matched, but the task is filtered out");
	});

	it("explains that other-project rows were dropped by the session-state dimension", async () => {
		// 会话状态只对当前项目可判。不点破的话，用户勾了「Needs your input」看不到别的项目的任务，
		// 会以为那些任务不存在，而不是「这里判不了」。
		await renderDialog({
			isSearchActive: true,
			query: "anything",
			results: [],
			resultCountExcludedBecauseSessionActivityIsNotObservable: 2,
		});

		expect(queryDialogContent()?.textContent).toContain("their session state is only known for the current project");
	});

	it("falls back to the generic empty state when nothing matched at all", async () => {
		await renderDialog({ isSearchActive: true, query: "nothing", results: [] });

		expect(queryDialogContent()?.textContent).toContain("No matching tasks");
	});

	it("reports the result count while browsing with an empty query", async () => {
		// 空查询不再是「什么都不显示」而是按排序档浏览全量；计数就是「现在列出的是全部 N 个任务」这句话本身。
		await renderDialog({ isBrowsingAllTasksWithoutQuery: true, results: [] });

		const resultCountElement = Array.from(document.body.querySelectorAll("span")).find(
			(element) => element.textContent === "0" && element.className.includes("text-text-tertiary"),
		);
		expect(resultCountElement).toBeInstanceOf(HTMLElement);
	});

	it("keeps the All projects toggle right-aligned via ml-auto on desktop", async () => {
		mockUseIsMobile.mockReturnValue(false);
		await renderDialog();

		const allProjectsLabel = document.body.querySelector('label[for="task-spotlight-include-other-projects"]');
		expect(allProjectsLabel?.className).toContain("ml-auto");
		expect(allProjectsLabel?.className).not.toContain("min-h-[44px]");
	});
});
