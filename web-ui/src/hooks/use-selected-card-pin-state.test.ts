import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSelectedCardPinState } from "@/hooks/use-selected-card-pin-state";

type Rect = { top: number; bottom: number; width: number; height: number };

// 每个测试通过这两个可变 rect 驱动几何：hook 读 getBoundingClientRect 即拿到它们。
let cardRect: Rect = { top: 0, bottom: 0, width: 0, height: 0 };
let rootRect: Rect = { top: 0, bottom: 500, width: 320, height: 500 };

function toDomRect(rect: Rect): DOMRect {
	return {
		top: rect.top,
		bottom: rect.bottom,
		left: 0,
		right: rect.width,
		width: rect.width,
		height: rect.height,
		x: 0,
		y: rect.top,
		toJSON: () => ({}),
	} as DOMRect;
}

function ScrollHarness({ enabled }: { enabled: boolean }): React.ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const pinState = useSelectedCardPinState({ selectedTaskId: "task-1", scrollRootRef: rootRef, enabled });
	return createElement(
		"div",
		null,
		createElement("div", { ref: rootRef, "data-testid": "root" }, createElement("div", { "data-task-id": "task-1" })),
		createElement("span", { "data-testid": "pin-state" }, pinState),
	);
}

describe("useSelectedCardPinState", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	const readPinState = (): string | null => container.querySelector('[data-testid="pin-state"]')?.textContent ?? null;

	const dispatchScroll = async (): Promise<void> => {
		await act(async () => {
			container.querySelector('[data-testid="root"]')?.dispatchEvent(new Event("scroll"));
		});
	};

	beforeEach(() => {
		cardRect = { top: 0, bottom: 0, width: 0, height: 0 };
		rootRect = { top: 0, bottom: 500, width: 320, height: 500 };
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		// rAF 同步执行，让 scheduleCompute 在 act 内即刻求值。
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
		// 按元素身份返回受控 rect：选中卡 / 滚动根 / 其它。
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.getAttribute("data-task-id") === "task-1") {
				return toDomRect(cardRect);
			}
			if (this.getAttribute("data-testid") === "root") {
				return toDomRect(rootRect);
			}
			return toDomRect({ top: 0, bottom: 0, width: 0, height: 0 });
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

	const renderHarness = async (enabled = true): Promise<void> => {
		await act(async () => {
			root.render(createElement(ScrollHarness, { enabled }));
		});
	};

	it("is hidden while the selected card overlaps the viewport", async () => {
		cardRect = { top: 10, bottom: 90, width: 200, height: 80 };
		await renderHarness();
		expect(readPinState()).toBe("hidden");
	});

	it("pins to the top when the card is fully above the viewport", async () => {
		cardRect = { top: -120, bottom: -40, width: 200, height: 80 };
		await renderHarness();
		expect(readPinState()).toBe("pinTop");
	});

	it("pins to the bottom when the card is fully below the viewport", async () => {
		cardRect = { top: 560, bottom: 640, width: 200, height: 80 };
		await renderHarness();
		expect(readPinState()).toBe("pinBottom");
	});

	it("treats a zero-size (collapsed/unlaid-out) card as hidden", async () => {
		cardRect = { top: -120, bottom: -120, width: 0, height: 0 };
		await renderHarness();
		expect(readPinState()).toBe("hidden");
	});

	it("flips bottom→top across a single abrupt scroll jump (teleport, no intersection)", async () => {
		// 选中卡先在视口下方 → pinBottom。
		cardRect = { top: 560, bottom: 640, width: 200, height: 80 };
		await renderHarness();
		expect(readPinState()).toBe("pinBottom");
		// 一次性大跳转使卡片瞬移到视口上方（中间从不相交）：滚动事件触发实时几何重算 → pinTop。
		cardRect = { top: -640, bottom: -560, width: 200, height: 80 };
		await dispatchScroll();
		expect(readPinState()).toBe("pinTop");
	});

	it("recomputes to hidden when the card scrolls back into view", async () => {
		cardRect = { top: -120, bottom: -40, width: 200, height: 80 };
		await renderHarness();
		expect(readPinState()).toBe("pinTop");
		cardRect = { top: 200, bottom: 280, width: 200, height: 80 };
		await dispatchScroll();
		expect(readPinState()).toBe("hidden");
	});

	it("stays hidden while disabled (e.g. dragging)", async () => {
		cardRect = { top: -120, bottom: -40, width: 200, height: 80 };
		await renderHarness(false);
		expect(readPinState()).toBe("hidden");
	});
});
