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
		recentSearchQueries: [],
		forgetRecentSearchQuery: () => {},
		mode: "direct",
		setMode: () => {},
		matchedTextFieldScope: "title_and_prompt",
		setMatchedTextFieldScope: () => {},
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

/**
 * 三个 describe 共用同一套 createRoot + act 宿主。弹层内容经 Radix Portal 落在 document.body 上，
 * 所以断言一律从 document.body 查询，而不是从 render 用的 container。
 */
function registerDialogTestHarness(): {
	renderDialog: (overrides?: Partial<TaskSpotlightSearchController>) => Promise<void>;
} {
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

	return {
		renderDialog: async (overrides: Partial<TaskSpotlightSearchController> = {}): Promise<void> => {
			await act(async () => {
				root.render(<TaskSpotlightSearchDialog controller={createControllerStub(overrides)} />);
			});
		},
	};
}

describe("TaskSpotlightSearchDialog viewport adaptation", () => {
	const { renderDialog } = registerDialogTestHarness();

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

function queryDialogSearchInput(): HTMLInputElement {
	const input = document.body.querySelector('input[aria-label="Search tasks"]');
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected the Spotlight search input to be rendered.");
	}
	return input;
}

async function pressKeyInSearchInput(init: KeyboardEventInit): Promise<void> {
	await act(async () => {
		queryDialogSearchInput().dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
		);
	});
}

/**
 * 受控 input 上必须走原生 value setter 再派发 `input`，否则 React 认不出这次改动
 * （直接赋 `.value` 会被 React 的 value tracker 判成「没变」而吞掉 change）。
 */
async function typeIntoSearchInput(value: string): Promise<void> {
	await act(async () => {
		const input = queryDialogSearchInput();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function dispatchCompositionEvent(type: "compositionstart" | "compositionend", data: string): Promise<void> {
	await act(async () => {
		queryDialogSearchInput().dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
	});
}

describe("TaskSpotlightSearchDialog IME composition safety", () => {
	const { renderDialog } = registerDialogTestHarness();

	it("ignores Enter emitted while the IME is still composing", async () => {
		// 用户报的原始故障：中文拼音打到一半按 Enter 想上屏字符原文，这次 Enter 被当成「打开高亮结果」，
		// 弹层关闭跳到别的任务，还顺手把打了一半的查询串清空。
		const openActiveResult = vi.fn();
		await renderDialog({ openActiveResult });

		await pressKeyInSearchInput({ key: "Enter", isComposing: true });
		expect(openActiveResult).not.toHaveBeenCalled();

		// 组字结束后的真回车必须照常打开——守卫不能把正常路径也堵死。
		await pressKeyInSearchInput({ key: "Enter" });
		expect(openActiveResult).toHaveBeenCalledTimes(1);
	});

	it("falls back to the legacy 229 keyCode when isComposing is not reported", async () => {
		const openActiveResult = vi.fn();
		await renderDialog({ openActiveResult });

		await pressKeyInSearchInput({ key: "Enter", keyCode: 229 });
		expect(openActiveResult).not.toHaveBeenCalled();
	});

	it("leaves the arrow keys to the IME candidate window while composing", async () => {
		// 多数中文输入法用 ↑↓ 翻候选页；组字中被 Spotlight 拿去移动结果选中行 = 候选翻不动还选错了任务。
		const moveActive = vi.fn();
		await renderDialog({ moveActive });

		await pressKeyInSearchInput({ key: "ArrowDown", isComposing: true });
		await pressKeyInSearchInput({ key: "ArrowUp", isComposing: true });
		expect(moveActive).not.toHaveBeenCalled();

		await pressKeyInSearchInput({ key: "ArrowDown" });
		expect(moveActive).toHaveBeenCalledWith(1);
	});

	it("holds the query back until the composition commits", async () => {
		// 组字中的拼音字母不是要检索的东西：直接喂给检索会让结果列表随 r → re → ren 抖成一串空结果。
		const setQuery = vi.fn();
		await renderDialog({ setQuery });

		await dispatchCompositionEvent("compositionstart", "");
		await typeIntoSearchInput("zhongwen");
		expect(setQuery).not.toHaveBeenCalled();
		// 但输入框自己必须照常显示中间态，否则输入法根本没法用。
		expect(queryDialogSearchInput().value).toBe("zhongwen");

		await typeIntoSearchInput("中文");
		await dispatchCompositionEvent("compositionend", "中文");
		expect(setQuery).toHaveBeenCalledWith("中文");
	});

	it("commits every keystroke immediately when no composition is in flight", async () => {
		// 英文等不组字的输入路径没有 composition 事件，手感必须零变化。
		const setQuery = vi.fn();
		await renderDialog({ setQuery });

		await typeIntoSearchInput("ka");
		expect(setQuery).toHaveBeenCalledWith("ka");
	});

	it("recovers when the composition is aborted by closing the dialog instead of ending normally", async () => {
		// 本组件在 App 里常驻挂载（Radix 只卸载 Portal 内容），而 Chromium 在组字进行中卸载 input 时
		// 不补发 compositionend——「正在组字」这个状态因此会跨弹层开关存活下来。没有中止复位路径时，
		// 重开的弹层会顶着上次的半截拼音，且此后每次输入都落进组字分支，连纯英文都再也提交不出去。
		const setQuery = vi.fn();
		await renderDialog({ setQuery });

		await dispatchCompositionEvent("compositionstart", "");
		await typeIntoSearchInput("zhongwen");
		expect(setQuery).not.toHaveBeenCalled();

		// 组字打到一半关掉弹层（点弹层外 / ⌘K / Esc），全程没有 compositionend。
		await renderDialog({ setQuery, isOpen: false });
		expect(queryDialogContent()).toBeNull();

		await renderDialog({ setQuery, isOpen: true });
		expect(queryDialogSearchInput().value).toBe("");

		await typeIntoSearchInput("ka");
		expect(setQuery).toHaveBeenCalledWith("ka");
	});
});

describe("TaskSpotlightSearchDialog recent search queries", () => {
	const { renderDialog } = registerDialogTestHarness();

	function queryRecentSearchQueriesRow(): HTMLElement | null {
		return document.body.querySelector("[data-task-spotlight-recent-search-queries]");
	}

	it("offers the recent queries only while the query box is empty", async () => {
		await renderDialog({ recentSearchQueries: ["中文查询", "alpha"] });
		expect(queryRecentSearchQueriesRow()?.textContent).toContain("中文查询");

		// 一开始打字，这块位置就该还给结果列表。
		await renderDialog({ query: "alpha", isSearchActive: true, recentSearchQueries: ["alpha"] });
		expect(queryRecentSearchQueriesRow()).toBeNull();
	});

	it("renders nothing when there is no history yet", async () => {
		await renderDialog({ recentSearchQueries: [] });
		expect(queryRecentSearchQueriesRow()).toBeNull();
		expect(queryDialogContent()?.textContent).not.toContain("recent searches");
	});

	it("refills the query box from a recent chip and can forget one", async () => {
		const setQuery = vi.fn();
		const forgetRecentSearchQuery = vi.fn();
		await renderDialog({ setQuery, forgetRecentSearchQuery, recentSearchQueries: ["中文查询"] });

		const recallButton = queryRecentSearchQueriesRow()?.querySelector("button");
		await act(async () => (recallButton as HTMLButtonElement).click());
		expect(setQuery).toHaveBeenCalledWith("中文查询");

		const forgetButton = document.body.querySelector('button[aria-label="Forget recent search 中文查询"]');
		await act(async () => (forgetButton as HTMLButtonElement).click());
		expect(forgetRecentSearchQuery).toHaveBeenCalledWith("中文查询");
	});

	it("walks the history with Mod+ArrowUp/Down without touching plain arrow navigation", async () => {
		const setQuery = vi.fn();
		const moveActive = vi.fn();
		await renderDialog({ setQuery, moveActive, recentSearchQueries: ["newest", "older"] });

		// 空查询 + ⌘↑ → 最近一条。
		await pressKeyInSearchInput({ key: "ArrowUp", metaKey: true });
		expect(setQuery).toHaveBeenLastCalledWith("newest");
		// 裸 ↑↓ 仍然是结果行导航，是这个弹层的主手势，绝不能被历史抢走。
		expect(moveActive).not.toHaveBeenCalled();

		await renderDialog({ setQuery, moveActive, query: "newest", recentSearchQueries: ["newest", "older"] });
		await pressKeyInSearchInput({ key: "ArrowUp", ctrlKey: true });
		expect(setQuery).toHaveBeenLastCalledWith("older");

		// 往回翻过最新一条即回到空查询。
		await pressKeyInSearchInput({ key: "ArrowDown", metaKey: true });
		expect(setQuery).toHaveBeenLastCalledWith("");
	});
});
