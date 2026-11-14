import { act, createElement, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	computeScrollTopForJumpingToStageBelowTopRail,
	FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY,
	STAGE_HEADER_HEIGHT_PX,
	STAGE_SECTION_BORDER_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";
import { useFocusViewGroupSectionNavigation } from "@/hooks/use-focus-view-stage-section-expansion";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { useStageHeaderPinLayout } from "@/hooks/use-stage-header-pin-layout";

type Rect = { top: number; bottom: number; height: number };

const COLUMN_IDS = ["a", "b", "c", "d", "e"];
const FOCUSED_COLUMN_ID = "b";
const FOCUSED_TASK_ID = "focused-card";

// 受控几何：hook 读 getBoundingClientRect 即拿到这些（按元素身份分发）。
let rootRect: Rect = { top: 0, bottom: 500, height: 500 };
let sectionRects: Record<string, Rect> = {};
let focusedCardRect: Rect = { top: 0, bottom: 80, height: 80 };
let targetFirstCardRect: Rect | null = null;

function toDomRect(rect: Rect): DOMRect {
	return {
		top: rect.top,
		bottom: rect.bottom,
		left: 0,
		right: 200,
		width: 200,
		height: rect.height,
		x: 0,
		y: rect.top,
		toJSON: () => ({}),
	} as DOMRect;
}

function Harness({
	focusedCardPinState,
	enabled,
	usesCrossProjectSourceSelectors = false,
	focusedCardCloneHeightPx,
}: {
	focusedCardPinState: SelectedCardPinState;
	enabled: boolean;
	usesCrossProjectSourceSelectors?: boolean;
	focusedCardCloneHeightPx?: number;
}): React.ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const layout = useStageHeaderPinLayout({
		scrollRootRef: rootRef,
		columnIds: COLUMN_IDS,
		focusedColumnId: FOCUSED_COLUMN_ID,
		focusedTaskId: FOCUSED_TASK_ID,
		focusedCardPinState,
		focusedCardCloneHeightPx,
		enabled,
		sectionElementAttributeName: usesCrossProjectSourceSelectors ? "data-focus-view-group-section-id" : undefined,
		focusedCardElementSelector: usesCrossProjectSourceSelectors
			? '[data-focused-source="project-a:focused-card"]'
			: undefined,
	});
	const sections: ReactNode[] = COLUMN_IDS.map((columnId) =>
		createElement(
			"div",
			{
				key: columnId,
				[usesCrossProjectSourceSelectors ? "data-focus-view-group-section-id" : "data-stage-section-id"]: columnId,
			},
			columnId === FOCUSED_COLUMN_ID
				? createElement(
						"div",
						usesCrossProjectSourceSelectors
							? { "data-focused-source": "project-a:focused-card" }
							: { "data-task-id": FOCUSED_TASK_ID },
					)
				: null,
		),
	);
	return createElement(
		"div",
		null,
		createElement("div", { ref: rootRef, "data-testid": "root" }, ...sections),
		createElement("span", { "data-testid": "top" }, layout.topPinnedColumnIds.join(",")),
		createElement("span", { "data-testid": "bottom" }, layout.bottomPinnedColumnIds.join(",")),
		createElement("span", { "data-testid": "focused-edge" }, layout.focusedCardRailEdge),
	);
}

function CrossProjectJumpNavigationHarness({
	focusedCardCloneHeightPx = 400,
	focusedTaskId = FOCUSED_TASK_ID,
	targetFirstCardHeightPx = 0,
}: {
	focusedCardCloneHeightPx?: number;
	focusedTaskId?: string;
	targetFirstCardHeightPx?: number;
}): React.ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const navigation = useFocusViewGroupSectionNavigation({
		scrollRootRef: rootRef,
		orderedColumnIds: COLUMN_IDS,
		focusedColumnId: FOCUSED_COLUMN_ID,
		focusedCardElementSelector: `[data-task-id="${focusedTaskId}"]`,
		focusedCardCloneHeightPx,
		isStageSectionExpanded: () => true,
		setStageSectionExpanded: () => {},
	});
	return createElement(
		"div",
		{ ref: rootRef, "data-testid": "root" },
		createElement("div", { "data-task-id": focusedTaskId }),
		...COLUMN_IDS.map((id) =>
			createElement(
				"div",
				{ key: id, "data-stage-section-id": id },
				id === "c" && targetFirstCardHeightPx > 0
					? createElement("div", { "data-task-id": "target-first-card" })
					: null,
			),
		),
		createElement(
			"button",
			{ type: "button", onClick: () => navigation.jumpToStageSectionBelowTopRail("c") },
			"跳转",
		),
	);
}

describe("useStageHeaderPinLayout", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	const readTop = (): string => container.querySelector('[data-testid="top"]')?.textContent ?? "";
	const readBottom = (): string => container.querySelector('[data-testid="bottom"]')?.textContent ?? "";

	// 改动受控 rect 后触发一次重算（滚动是主信号；与生产同源）。
	const dispatchScroll = async (): Promise<void> => {
		await act(async () => {
			container.querySelector('[data-testid="root"]')?.dispatchEvent(new Event("scroll"));
		});
	};

	beforeEach(() => {
		rootRect = { top: 0, bottom: 500, height: 500 };
		// 默认：所有 section 都完整落在视口内（不触任一边）→ 空布局。
		sectionRects = {
			a: { top: 10, bottom: 50, height: 40 },
			b: { top: 60, bottom: 100, height: 40 },
			c: { top: 110, bottom: 150, height: 40 },
			d: { top: 160, bottom: 200, height: 40 },
			e: { top: 210, bottom: 250, height: 40 },
		};
		focusedCardRect = { top: 65, bottom: 145, height: 80 };
		targetFirstCardRect = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const sectionId =
				this.getAttribute("data-stage-section-id") ?? this.getAttribute("data-focus-view-group-section-id");
			if (sectionId && sectionRects[sectionId]) {
				return toDomRect(sectionRects[sectionId]);
			}
			if (this.getAttribute("data-task-id") === "target-first-card" && targetFirstCardRect) {
				return toDomRect(targetFirstCardRect);
			}
			if (this.hasAttribute("data-task-id") || this.hasAttribute("data-focused-source")) {
				return toDomRect(focusedCardRect);
			}
			if (this.getAttribute("data-testid") === "root") {
				return toDomRect(rootRect);
			}
			return toDomRect({ top: 0, bottom: 0, height: 0 });
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	const renderHarness = async (
		focusedCardPinState: SelectedCardPinState = "hidden",
		enabled = true,
	): Promise<void> => {
		await act(async () => {
			root.render(createElement(Harness, { focusedCardPinState, enabled }));
		});
	};

	it("pins nothing while every stage sits fully inside the viewport", async () => {
		await renderHarness();
		expect(readTop()).toBe("");
		expect(readBottom()).toBe("");
	});

	it("跨项目完整副本按固定标题预算限高，分类不依赖受限副本的反复测量", async () => {
		sectionRects = {
			a: { top: -200, bottom: -150, height: 50 },
			b: { top: -100, bottom: 380, height: 480 },
			c: { top: 400, bottom: 470, height: 70 },
			d: { top: 520, bottom: 560, height: 40 },
			e: { top: 600, bottom: 640, height: 40 },
		};
		focusedCardRect = { top: -80, bottom: -20, height: 60 };
		await act(async () => {
			root.render(
				createElement(Harness, {
					focusedCardPinState: "pinTop",
					enabled: true,
					usesCrossProjectSourceSelectors: true,
					focusedCardCloneHeightPx: 400,
				}),
			);
		});
		// 500px 视口扣除五个 34px 标题、8px padding 和一张任务卡预留。分类不随副本限高来回变。
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
		await dispatchScroll();
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
	});

	it("跨项目跳转按目标首卡实测高度限高，200px 首卡完整留在视口内", async () => {
		const firstCardHeight = 200;
		sectionRects.c = { top: 1000, bottom: 1200, height: 200 };
		focusedCardRect = { top: 900, bottom: 960, height: 60 };
		targetFirstCardRect = { top: 1030, bottom: 1230, height: firstCardHeight };
		await act(async () =>
			root.render(createElement(CrossProjectJumpNavigationHarness, { targetFirstCardHeightPx: firstCardHeight })),
		);
		await act(async () => container.querySelector("button")!.click());
		const scrollTop = container.querySelector<HTMLElement>('[data-testid="root"]')!.scrollTop;
		const firstCardTop = 1000 - scrollTop + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		expect(firstCardHeight).toBeGreaterThan(120);
		expect(firstCardHeight).toBeLessThan(rootRect.height);
		expect(firstCardTop).toBeGreaterThanOrEqual(0);
		expect(firstCardTop + firstCardHeight).toBeLessThanOrEqual(rootRect.height);
	});

	it("跳转后上方分段再挂出卡片时，落点下移并仍让首卡留在视口内", async () => {
		const firstCardHeight = 200;
		sectionRects.c = { top: 1000, bottom: 1200, height: 200 };
		focusedCardRect = { top: 900, bottom: 960, height: 60 };
		targetFirstCardRect = { top: 1030, bottom: 1230, height: firstCardHeight };
		await act(async () =>
			root.render(createElement(CrossProjectJumpNavigationHarness, { targetFirstCardHeightPx: firstCardHeight })),
		);
		await act(async () => container.querySelector("button")!.click());
		const scrollRoot = container.querySelector<HTMLElement>('[data-testid="root"]')!;
		const landedScrollTop = scrollRoot.scrollTop;
		for (const rect of Object.values(sectionRects)) {
			rect.top -= landedScrollTop;
			rect.bottom -= landedScrollTop;
		}
		for (const id of ["c", "d", "e"]) {
			sectionRects[id]!.top += 20;
			sectionRects[id]!.bottom += 20;
		}
		if (targetFirstCardRect) {
			targetFirstCardRect = {
				...targetFirstCardRect,
				top: targetFirstCardRect.top - landedScrollTop + 20,
				bottom: targetFirstCardRect.bottom - landedScrollTop + 20,
			};
		}
		focusedCardRect = {
			top: focusedCardRect.top - landedScrollTop,
			bottom: focusedCardRect.bottom - landedScrollTop,
			height: focusedCardRect.height,
		};
		await act(async () => {
			scrollRoot.appendChild(document.createElement("div"));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(scrollRoot.scrollTop).toBeGreaterThan(landedScrollTop);
		const firstCardTop = 1000 + 20 - scrollRoot.scrollTop + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		expect(firstCardTop).toBeGreaterThanOrEqual(0);
		expect(firstCardTop + firstCardHeight).toBeLessThanOrEqual(rootRect.height);
	});

	it.each([0, 30])("首次完整副本测量只补齐原跳转，用户滚动量=%s", async (userScrollDelta) => {
		sectionRects = {
			a: { top: 0, bottom: 50, height: 50 },
			b: { top: 54, bottom: 996, height: 942 },
			c: { top: 1000, bottom: 1300, height: 300 },
			d: { top: 1304, bottom: 1600, height: 296 },
			e: { top: 1604, bottom: 2000, height: 396 },
		};
		focusedCardRect = { top: 70, bottom: 130, height: 60 };
		const firstCardHeight = 200;
		targetFirstCardRect = { top: 1030, bottom: 1230, height: firstCardHeight };
		await act(async () =>
			root.render(
				createElement(CrossProjectJumpNavigationHarness, {
					focusedCardCloneHeightPx: 0,
					targetFirstCardHeightPx: firstCardHeight,
				}),
			),
		);
		await act(async () => container.querySelector("button")!.click());
		const scrollRoot = container.querySelector<HTMLElement>('[data-testid="root"]')!;
		expect(scrollRoot.scrollTop).toBe(864);
		scrollRoot.scrollTop += userScrollDelta;
		for (const rect of Object.values(sectionRects)) {
			rect.top -= scrollRoot.scrollTop;
			rect.bottom -= scrollRoot.scrollTop;
		}
		focusedCardRect = { top: 70 - scrollRoot.scrollTop, bottom: 130 - scrollRoot.scrollTop, height: 60 };
		await act(async () =>
			root.render(
				createElement(CrossProjectJumpNavigationHarness, {
					focusedCardCloneHeightPx: 400,
					targetFirstCardHeightPx: firstCardHeight,
				}),
			),
		);
		// 未测到副本时按 60px 源行落在 864。测到 400px 后按首卡高度收紧副本；用户已滚动则保持原位置。
		if (userScrollDelta === 0) {
			expect(scrollRoot.scrollTop).not.toBe(864);
			const firstCardTop = 1000 - scrollRoot.scrollTop + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
			expect(firstCardTop + firstCardHeight).toBeLessThanOrEqual(rootRect.height);
		} else {
			expect(scrollRoot.scrollTop).toBe(894);
		}
	});

	it("上一任务残留的非零副本高度会在新副本测到后补齐同一次跳转", async () => {
		sectionRects = {
			a: { top: 8, bottom: 38, height: 30 },
			b: { top: 42, bottom: 996, height: 954 },
			c: { top: 1000, bottom: 1300, height: 300 },
			d: { top: 1304, bottom: 1600, height: 296 },
			e: { top: 1604, bottom: 2000, height: 396 },
		};
		focusedCardRect = { top: 76, bottom: 136, height: 60 };
		const firstCardHeight = 150;
		targetFirstCardRect = { top: 1030, bottom: 1180, height: firstCardHeight };
		await act(async () =>
			root.render(
				createElement(CrossProjectJumpNavigationHarness, {
					focusedCardCloneHeightPx: 160,
					focusedTaskId: "previous-task",
					targetFirstCardHeightPx: firstCardHeight,
				}),
			),
		);
		await act(async () =>
			root.render(
				createElement(CrossProjectJumpNavigationHarness, {
					focusedCardCloneHeightPx: 160,
					focusedTaskId: "next-task",
					targetFirstCardHeightPx: firstCardHeight,
				}),
			),
		);
		await act(async () => container.querySelector("button")!.click());
		const scrollRoot = container.querySelector<HTMLElement>('[data-testid="root"]')!;
		const staleScrollTop = scrollRoot.scrollTop;
		scrollRoot.scrollTop += 0;
		for (const rect of Object.values(sectionRects)) {
			rect.top -= staleScrollTop;
			rect.bottom -= staleScrollTop;
		}
		focusedCardRect = { top: 76 - staleScrollTop, bottom: 136 - staleScrollTop, height: 60 };
		await act(async () =>
			root.render(
				createElement(CrossProjectJumpNavigationHarness, {
					focusedCardCloneHeightPx: 400,
					focusedTaskId: "next-task",
					targetFirstCardHeightPx: firstCardHeight,
				}),
			),
		);
		expect(scrollRoot.scrollTop).not.toBe(staleScrollTop);
		const targetHeaderTop = 1000 - scrollRoot.scrollTop;
		const firstCardTop = targetHeaderTop + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		expect(firstCardTop).toBeLessThan(rootRect.height);
		expect(firstCardTop + firstCardHeight).toBeLessThanOrEqual(rootRect.height);
	});

	it("桌面 hover 媒体查询在首帧分类时就生效", async () => {
		const seenLayouts: string[] = [];
		function Probe(): React.ReactElement {
			const rootRef = useRef<HTMLDivElement | null>(null);
			const layout = useStageHeaderPinLayout({
				scrollRootRef: rootRef,
				columnIds: COLUMN_IDS,
				focusedColumnId: FOCUSED_COLUMN_ID,
				focusedTaskId: FOCUSED_TASK_ID,
				focusedCardPinState: "hidden",
			});
			seenLayouts.push(`${layout.topPinnedColumnIds.join(",")}|${layout.compactGroupIds.join(",")}`);
			return createElement(
				"div",
				{ ref: rootRef, "data-testid": "root" },
				...COLUMN_IDS.map((id) => createElement("div", { key: id, "data-stage-section-id": id })),
				createElement("span", { "data-testid": "compact" }, layout.compactGroupIds.join(",")),
			);
		}
		sectionRects = {
			a: { top: -80, bottom: -20, height: 60 },
			b: { top: 10, bottom: 420, height: 410 },
			c: { top: 430, bottom: 470, height: 40 },
			d: { top: 700, bottom: 740, height: 40 },
			e: { top: 750, bottom: 790, height: 40 },
		};
		vi.spyOn(window, "matchMedia").mockImplementation(
			(query: string) =>
				({
					matches: query === FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY,
					media: query,
					onchange: null,
					addListener: () => {},
					removeListener: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
					dispatchEvent: () => false,
				}) as MediaQueryList,
		);
		await act(async () => {
			root.render(createElement(Probe));
		});
		expect(container.querySelector('[data-testid="compact"]')?.textContent).toContain("a");
		expect(
			seenLayouts.some((layout) => {
				const [top, compact] = layout.split("|");
				return top !== "" && compact === "";
			}),
		).toBe(false);
	});

	it.each([false, true])("跳转落点与实际 rail 分类一致，跨项目选择器=%s", async (usesCrossProjectSourceSelectors) => {
		const initialTargetTop = 500;
		const initialScrollTop = 300;
		const nextScrollTop = computeScrollTopForJumpingToStageBelowTopRail({
			targetStageIndex: 2,
			focusedStageIndex: 1,
			focusedCardViewportTop: 400,
			focusedCardHeight: 80,
			targetSectionViewportTop: initialTargetTop,
			scrollRootViewportTop: 0,
			currentScrollTop: initialScrollTop,
		});
		const scrollDelta = nextScrollTop - initialScrollTop;
		const targetTop = initialTargetTop - scrollDelta;
		sectionRects = {
			a: { top: -100 - scrollDelta, bottom: -60 - scrollDelta, height: 40 },
			b: { top: 0 - scrollDelta, bottom: 496 - scrollDelta, height: 496 },
			c: { top: targetTop, bottom: 900 - scrollDelta, height: 400 },
			d: { top: 904 - scrollDelta, bottom: 1104 - scrollDelta, height: 200 },
			e: { top: 1108 - scrollDelta, bottom: 1308 - scrollDelta, height: 200 },
		};
		focusedCardRect = { top: 400 - scrollDelta, bottom: 480 - scrollDelta, height: 80 };
		await act(async () => {
			root.render(
				createElement(Harness, {
					focusedCardPinState: focusedCardRect.top <= 0 ? "pinTop" : "hidden",
					enabled: true,
					usesCrossProjectSourceSelectors,
				}),
			);
		});
		const topIds = readTop().split(",");
		const includesFocusedCard = container.querySelector('[data-testid="focused-edge"]')?.textContent === "pinTop";
		const railHeight = topIds.length * 34 - 4 + (includesFocusedCard ? 8 + 80 : 0);
		expect(targetTop + 30).toBeGreaterThanOrEqual(railHeight);
	});

	it("stacks scrolled-past headers at top and upcoming headers at bottom, current stage in flow", async () => {
		// a,b above the top; c in view (middle band, clear of the ~92px a+b top rail incl. borders); d,e below the
		// bottom. Focused card fully visible → no tall entry.
		sectionRects = {
			a: { top: -180, bottom: -100, height: 80 },
			b: { top: -90, bottom: 300, height: 390 },
			c: { top: 320, bottom: 400, height: 80 },
			d: { top: 500, bottom: 560, height: 60 },
			e: { top: 570, bottom: 660, height: 90 },
		};
		focusedCardRect = { top: 130, bottom: 210, height: 80 };
		await renderHarness("hidden");
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
	});

	it.each(["top", "bottom"] as const)("焦点卡被 %s 标题栏遮住时，副本跟随真实所属分组", async (edge) => {
		sectionRects =
			edge === "top"
				? {
						a: { top: -50, bottom: -10, height: 40 },
						b: { top: 10, bottom: 250, height: 240 },
						c: { top: 300, bottom: 350, height: 50 },
						d: { top: 400, bottom: 450, height: 50 },
						e: { top: 600, bottom: 650, height: 50 },
					}
				: {
						a: { top: 10, bottom: 50, height: 40 },
						b: { top: 60, bottom: 490, height: 430 },
						c: { top: 510, bottom: 540, height: 30 },
						d: { top: 550, bottom: 590, height: 40 },
						e: { top: 610, bottom: 650, height: 40 },
					};
		focusedCardRect = edge === "top" ? { top: 60, bottom: 140, height: 80 } : { top: 400, bottom: 480, height: 80 };
		await renderHarness("hidden");
		expect(container.querySelector('[data-testid="focused-edge"]')?.textContent).toBe(
			edge === "top" ? "pinTop" : "pinBottom",
		);
		expect(edge === "top" ? readTop() : readBottom()).toBe(edge === "top" ? "a,b" : "b,c,d,e");
	});

	it("gives the top edge precedence for a single stage taller than the viewport (no double-claim)", async () => {
		// b spans the whole viewport (top above, bottom below): must be top-pinned, never claimed by the bottom pass.
		sectionRects = {
			a: { top: -150, bottom: -110, height: 40 },
			b: { top: -100, bottom: 700, height: 800 },
			c: { top: 750, bottom: 800, height: 50 },
			d: { top: 810, bottom: 860, height: 50 },
			e: { top: 870, bottom: 920, height: 50 },
		};
		await renderHarness("hidden");
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("c,d,e");
	});

	it("keeps the focused stage pinned mid-cluster when scrolled far past it", async () => {
		// a,b,c above (b focused, its card above → pinTop). d comfortably below the tall rail → in flow.
		sectionRects = {
			a: { top: -300, bottom: -260, height: 40 },
			b: { top: -250, bottom: -180, height: 70 },
			c: { top: -170, bottom: -100, height: 70 },
			d: { top: 300, bottom: 600, height: 300 },
			e: { top: 700, bottom: 760, height: 60 },
		};
		focusedCardRect = { top: -250, bottom: -170, height: 80 };
		await renderHarness("pinTop");
		expect(readTop()).toBe("a,b,c");
		expect(readBottom()).toBe("e");
	});

	it("adds the focused card height to the top threshold so the boundary header is not swallowed", async () => {
		// 顶部 rail 包括两个 34px 标题、8px 底部 padding 与 80px 焦点副本，总高 152px。
		const scrolledPast: Record<string, Rect> = {
			a: { top: -100, bottom: -60, height: 40 },
			b: { top: -50, bottom: 250, height: 300 },
			d: { top: 400, bottom: 460, height: 60 },
			e: { top: 470, bottom: 530, height: 60 },
		};
		focusedCardRect = { top: -50, bottom: 30, height: 80 };

		// 卡头在 144px，落在包含焦点卡的 rail（0..152）内，必须钉住以免被遮住。
		sectionRects = { ...scrolledPast, c: { top: 144, bottom: 444, height: 300 } };
		await renderHarness("pinTop");
		expect(readTop()).toBe("a,b,c");

		// 卡头在 180px 已越过 rail，保持行内；两组边界证明焦点卡高度仍计入阈值。
		sectionRects = { ...scrolledPast, c: { top: 180, bottom: 480, height: 300 } };
		await dispatchScroll();
		expect(readTop()).toBe("a,b");
	});

	it("does not spuriously pin the last fully-visible stage resting near the bottom edge", async () => {
		// e is short and rests with its header inside the bottom 40px but is fully visible (bottom <= viewport bottom)
		// and nothing is pinned below it → must NOT spawn a bottom rail entry.
		sectionRects = {
			a: { top: 10, bottom: 50, height: 40 },
			b: { top: 60, bottom: 100, height: 40 },
			c: { top: 110, bottom: 150, height: 40 },
			d: { top: 160, bottom: 200, height: 40 },
			e: { top: 470, bottom: 500, height: 30 },
		};
		await renderHarness("hidden");
		expect(readTop()).toBe("");
		expect(readBottom()).toBe("");
	});

	it("returns an empty layout while disabled (e.g. dragging)", async () => {
		sectionRects = {
			a: { top: -180, bottom: -100, height: 80 },
			b: { top: -90, bottom: -10, height: 80 },
			c: { top: 100, bottom: 400, height: 300 },
			d: { top: 500, bottom: 560, height: 60 },
			e: { top: 570, bottom: 660, height: 90 },
		};
		await renderHarness("hidden", false);
		expect(readTop()).toBe("");
		expect(readBottom()).toBe("");
	});

	it("returns an empty layout when the scroll root has no layout (zero height)", async () => {
		rootRect = { top: 0, bottom: 0, height: 0 };
		sectionRects = {
			a: { top: -180, bottom: -100, height: 80 },
			b: { top: -90, bottom: -10, height: 80 },
			c: { top: 100, bottom: 400, height: 300 },
			d: { top: 500, bottom: 560, height: 60 },
			e: { top: 570, bottom: 660, height: 90 },
		};
		await renderHarness("hidden");
		expect(readTop()).toBe("");
		expect(readBottom()).toBe("");
	});
	it("跨项目分组使用唯一源行：标题还在视口内而焦点卡在下方时，所属组进入底沿 rail", async () => {
		sectionRects = {
			a: { top: 8, bottom: 42, height: 34 },
			b: { top: 46, bottom: 900, height: 854 },
			c: { top: 904, bottom: 938, height: 34 },
			d: { top: 942, bottom: 976, height: 34 },
			e: { top: 980, bottom: 1014, height: 34 },
		};
		focusedCardRect = { top: 700, bottom: 780, height: 80 };
		await act(async () =>
			root.render(
				createElement(Harness, {
					focusedCardPinState: "pinBottom",
					enabled: true,
					usesCrossProjectSourceSelectors: true,
				}),
			),
		);
		expect(readTop()).toBe("");
		expect(readBottom()).toBe("b,c,d,e");
	});
});
