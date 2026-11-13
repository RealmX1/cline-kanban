import { act, createElement, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeScrollTopForJumpingToStageBelowTopRail } from "@/components/detail-panels/stage-header-rail-geometry";
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

function CrossProjectJumpNavigationHarness(): React.ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const navigation = useFocusViewGroupSectionNavigation({
		scrollRootRef: rootRef,
		orderedColumnIds: COLUMN_IDS,
		focusedColumnId: FOCUSED_COLUMN_ID,
		focusedCardElementSelector: `[data-task-id="${FOCUSED_TASK_ID}"]`,
		focusedCardCloneHeightPx: 400,
		isStageSectionExpanded: () => true,
		setStageSectionExpanded: () => {},
	});
	return createElement(
		"div",
		{ ref: rootRef, "data-testid": "root" },
		createElement("div", { "data-task-id": FOCUSED_TASK_ID }),
		createElement("div", { "data-stage-section-id": "c" }),
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
			if (this.getAttribute("data-task-id") === FOCUSED_TASK_ID || this.hasAttribute("data-focused-source")) {
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
			c: { top: 387, bottom: 450, height: 63 },
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
		// 500px 视口扣除五个 38px 标题和 8px padding，卡片可见内容高 302px。
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
		await dispatchScroll();
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
	});

	it("跨项目跳转使用同一受限内容高度，完整副本不会把目标首行推到视口下方", async () => {
		sectionRects.c = { top: 1000, bottom: 1200, height: 200 };
		focusedCardRect = { top: 900, bottom: 960, height: 60 };
		await act(async () => root.render(createElement(CrossProjectJumpNavigationHarness)));
		await act(async () => container.querySelector("button")!.click());
		const scrollTop = container.querySelector<HTMLElement>('[data-testid="root"]')!.scrollTop;
		// 目标上方两个标题 76px + 受限内容 302px + padding 8px，仅计一次 padding。
		expect(scrollTop).toBe(1000 - (76 + 302 + 8));
		expect(1000 - scrollTop + 34).toBeLessThan(rootRect.height);
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
		const railHeight = topIds.length * 38 - 4 + (includesFocusedCard ? 8 + 80 : 0);
		expect(targetTop + 34).toBeGreaterThanOrEqual(railHeight);
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
		focusedCardRect = edge === "top" ? { top: 65, bottom: 145, height: 80 } : { top: 400, bottom: 480, height: 80 };
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
		// 顶部 rail 包括两个 38px 标题、8px 底部 padding 与 80px 焦点副本，总高 164px。
		const scrolledPast: Record<string, Rect> = {
			a: { top: -100, bottom: -60, height: 40 },
			b: { top: -50, bottom: 250, height: 300 },
			d: { top: 400, bottom: 460, height: 60 },
			e: { top: 470, bottom: 530, height: 60 },
		};
		focusedCardRect = { top: -50, bottom: 30, height: 80 };

		// 卡头在 154px，落在包含焦点卡的 rail（0..164）内，必须钉住以免被遮住。
		sectionRects = { ...scrolledPast, c: { top: 154, bottom: 454, height: 300 } };
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
