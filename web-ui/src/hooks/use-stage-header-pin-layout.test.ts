import { act, createElement, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
}: {
	focusedCardPinState: SelectedCardPinState;
	enabled: boolean;
}): React.ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const layout = useStageHeaderPinLayout({
		scrollRootRef: rootRef,
		columnIds: COLUMN_IDS,
		focusedColumnId: FOCUSED_COLUMN_ID,
		focusedTaskId: FOCUSED_TASK_ID,
		focusedCardPinState,
		enabled,
	});
	const sections: ReactNode[] = COLUMN_IDS.map((columnId) =>
		createElement(
			"div",
			{ key: columnId, "data-stage-section-id": columnId },
			columnId === FOCUSED_COLUMN_ID ? createElement("div", { "data-task-id": FOCUSED_TASK_ID }) : null,
		),
	);
	return createElement(
		"div",
		null,
		createElement("div", { ref: rootRef, "data-testid": "root" }, ...sections),
		createElement("span", { "data-testid": "top" }, layout.topPinnedColumnIds.join(",")),
		createElement("span", { "data-testid": "bottom" }, layout.bottomPinnedColumnIds.join(",")),
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
			const sectionId = this.getAttribute("data-stage-section-id");
			if (sectionId && sectionRects[sectionId]) {
				return toDomRect(sectionRects[sectionId]);
			}
			if (this.getAttribute("data-task-id") === FOCUSED_TASK_ID) {
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

	it("stacks scrolled-past headers at top and upcoming headers at bottom, current stage in flow", async () => {
		// a,b above the top; c in view (middle band, clear of the ~92px a+b top rail incl. borders); d,e below the
		// bottom. Focused card fully visible → no tall entry.
		sectionRects = {
			a: { top: -180, bottom: -100, height: 80 },
			b: { top: -90, bottom: -10, height: 80 },
			c: { top: 120, bottom: 400, height: 280 },
			d: { top: 500, bottom: 560, height: 60 },
			e: { top: 570, bottom: 660, height: 90 },
		};
		await renderHarness("hidden");
		expect(readTop()).toBe("a,b");
		expect(readBottom()).toBe("d,e");
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
		// a + focused b pinned top; b's rail entry is header(40)+border(2)+padding(16)+card(80). The first non-pinned
		// header c must be classified by the TALL rail bottom (~0 + (40+2+8) + (40+2+16+80+8) = 196), not the
		// card-less bottom (~0 + 50 + 50 = 100).
		const scrolledPast: Record<string, Rect> = {
			a: { top: -100, bottom: -60, height: 40 },
			b: { top: -50, bottom: 250, height: 300 },
			d: { top: 400, bottom: 460, height: 60 },
			e: { top: 470, bottom: 530, height: 60 },
		};
		focusedCardRect = { top: -50, bottom: 30, height: 80 };

		// c at sTop=190 is INSIDE the tall rail band (0..196) → must be pinned (masked by the opaque rail).
		sectionRects = { ...scrolledPast, c: { top: 190, bottom: 490, height: 300 } };
		await renderHarness("pinTop");
		expect(readTop()).toBe("a,b,c");

		// c at sTop=204 is BELOW the tall rail band → must stay in flow. Had the hook forgotten the card height
		// (rail bottom ≈ 100), c would already be excluded at 190 — this pair is what proves the height is counted.
		sectionRects = { ...scrolledPast, c: { top: 204, bottom: 504, height: 300 } };
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
});
