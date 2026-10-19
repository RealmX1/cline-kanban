import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalVirtualKeyInputBar } from "@/components/detail-panels/terminal-virtual-key-input-bar";
import {
	TERMINAL_ARROW_DOWN_SEQUENCE,
	TERMINAL_ESCAPE_SEQUENCE,
	TERMINAL_INTERRUPT_AND_CLEAR_INPUT_LINE_SEQUENCE,
	TERMINAL_SUBMIT_CARRIAGE_RETURN_SEQUENCE,
} from "@/terminal/terminal-control-key-sequences";

const sentSequences: string[] = [];
const sentAtMilliseconds: number[] = [];
let inputConnected = true;
const controller = {
	input: (sequence: string) => {
		if (!inputConnected) return false;
		sentSequences.push(sequence);
		sentAtMilliseconds.push(Date.now());
		return true;
	},
};
let registeredController: typeof controller | null = controller;
const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast: showToast }));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	getTerminalController: () => registeredController,
}));

const TASK_ID = "task-under-test";

/** 单指/主键按压的指针 id，让测试能断言「按下时确实捕获了这一个指针」。 */
const PRIMARY_POINTER_ID = 1;

/** 让位量断言用的合成几何：390×844 是在用的最小机型档，86 是按键条实测高度。 */
const VIEWPORT_HEIGHT_PX = 844;
const BAR_HEIGHT_PX = 86;

/**
 * jsdom 既没有 PointerEvent 也没有 ResizeObserver，而按键条两条关键行为恰好各依赖其一。
 * 补最小实现让测试走真实代码路径，而不是绕开它去断言降级分支。
 */
class FakePointerEvent extends MouseEvent {
	readonly pointerId: number;

	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? PRIMARY_POINTER_ID;
	}
}
class FakeResizeObserver {
	constructor(private readonly callback: () => void) {}
	observe(): void {
		this.callback();
	}
	unobserve(): void {}
	disconnect(): void {}
}

/**
 * jsdom 也没有实现指针捕获，而真机上它一定存在。默认补一个最小实现，让长按相关的断言
 * 跑在「捕获成立」这条真机路径上；`uninstallPointerCaptureSupport` 再把它抽掉，用来断言
 * API 缺失时的保守兜底确实还在。
 */
const elementPrototypeWithOptionalPointerCapture: Partial<
	Pick<Element, "setPointerCapture" | "releasePointerCapture">
> = Element.prototype;
const capturedPointerIds: number[] = [];

function installPointerCaptureSupport(): void {
	elementPrototypeWithOptionalPointerCapture.setPointerCapture = (pointerId: number): void => {
		capturedPointerIds.push(pointerId);
	};
	elementPrototypeWithOptionalPointerCapture.releasePointerCapture = (): void => {};
}

function uninstallPointerCaptureSupport(): void {
	delete elementPrototypeWithOptionalPointerCapture.setPointerCapture;
	delete elementPrototypeWithOptionalPointerCapture.releasePointerCapture;
}

function findKeyCap(container: HTMLElement, accessibleDescription: string): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${accessibleDescription}"]`);
	if (!button) {
		throw new Error(`No key cap labelled "${accessibleDescription}"`);
	}
	return button;
}

function pressDown(button: HTMLButtonElement): void {
	act(() => {
		button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
	});
}

/**
 * 模拟「按住不放，但指针滑出了键面」。React 的 enter/leave 是由原生 pointerout 合成的，
 * 直接派发不冒泡的 pointerleave 到不了组件，所以这里发真实浏览器同样会发的那一个事件。
 */
function driftPointerOutOfElement(button: HTMLButtonElement): void {
	act(() => {
		button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
	});
}

function pressAndRelease(button: HTMLButtonElement, holdForMs = 0): void {
	pressDown(button);
	if (holdForMs > 0) {
		act(() => {
			vi.advanceTimersByTime(holdForMs);
		});
	}
	act(() => {
		button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
		// 浏览器在 pointer 序列之后总会补发一个 click；按键条必须吞掉它，否则每次点按发两遍。
		button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("TerminalVirtualKeyInputBar", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.stubGlobal("PointerEvent", FakePointerEvent);
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		installPointerCaptureSupport();
		capturedPointerIds.length = 0;
		vi.useFakeTimers();
		sentSequences.length = 0;
		sentAtMilliseconds.length = 0;
		inputConnected = true;
		registeredController = controller;
		showToast.mockClear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(<TerminalVirtualKeyInputBar taskId={TASK_ID} />);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		uninstallPointerCaptureSupport();
	});

	it("sends the key's byte sequence exactly once for a quick tap", () => {
		// pointerdown 触发 + click 补发，若不去重会发两遍中断信号。
		pressAndRelease(findKeyCap(container, "Interrupt the agent, or clear the current input line"));

		expect(sentSequences).toEqual([TERMINAL_INTERRUPT_AND_CLEAR_INPUT_LINE_SEQUENCE]);
	});

	it("一次点按在抬手后仍完成两次独立 ESC，间隔 100ms，补发 click 不产生第三次", () => {
		pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
		act(() => vi.advanceTimersByTime(99));
		expect(sentSequences).toHaveLength(1);
		act(() => vi.advanceTimersByTime(1));
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE, TERMINAL_ESCAPE_SEQUENCE]);
		expect(sentAtMilliseconds[1]! - sentAtMilliseconds[0]!).toBe(100);
	});

	it("两步未完成时忽略重复点按，长按也不重复投递复合按键", () => {
		const rewind = findKeyCap(container, "Open the rewind history view (double escape)");
		pressAndRelease(rewind);
		pressAndRelease(rewind, 5_000);
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE, TERMINAL_ESCAPE_SEQUENCE]);
	});

	it("其他虚拟按键介入时取消待发 ESC", () => {
		pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
		pressAndRelease(findKeyCap(container, "Submit the current selection or input"));
		act(() => vi.advanceTimersByTime(1_000));
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE, TERMINAL_SUBMIT_CARRIAGE_RETURN_SEQUENCE]);
	});

	for (const wheelInput of ["物理滚轮", "虚拟滚轮指针", "虚拟滚轮读屏"] as const) {
		it(`${wheelInput}在两步之间介入时取消待发 ESC，仍只滚动三行`, () => {
			const scrollLineDeltas: number[] = [];
			act(() => {
				root.render(
					<TerminalVirtualKeyInputBar
						taskId={TASK_ID}
						onScrollByMouseWheelLines={(lineDelta) => {
							scrollLineDeltas.push(lineDelta);
							// 生产滚轮入口同样在 xterm screen 上派发 WheelEvent。
							container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: lineDelta }));
						}}
					/>,
				);
			});
			// xterm 可以停止冒泡；取消监听必须在捕获阶段先收到滚轮。
			container.addEventListener("wheel", (event) => event.stopPropagation());
			pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
			act(() => vi.advanceTimersByTime(50));
			if (wheelInput === "物理滚轮") {
				act(() => container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -3 })));
			} else {
				const wheelButton = findKeyCap(container, "向上滚动，长按加速");
				if (wheelInput === "虚拟滚轮指针") {
					pressDown(wheelButton);
					act(() => {
						wheelButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
						wheelButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
					});
				} else act(() => wheelButton.click());
			}
			act(() => vi.advanceTimersByTime(1_000));
			expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
			expect(scrollLineDeltas).toEqual(wheelInput === "物理滚轮" ? [] : [-3]);
		});
	}

	for (const change of ["任务", "会话", "页签隐藏", "禁用", "卸载"] as const) {
		it(`${change}变化后不补发待发 ESC`, () => {
			pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
			act(() => {
				root.render(
					change === "卸载" ? null : (
						<TerminalVirtualKeyInputBar
							taskId={change === "任务" ? "other-task" : TASK_ID}
							terminalInputTargetIdentity={change === "会话" ? "other-incarnation" : TASK_ID}
							isTerminalKeyInputInteractive={change !== "页签隐藏"}
							disabled={change === "禁用"}
						/>
					),
				);
			});
			act(() => vi.advanceTimersByTime(1_000));
			expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
		});
	}

	for (const eventType of ["blur", "keydown", "input", "visibilitychange"] as const) {
		it(`${eventType}中止待发 ESC，恢复页面不会重试`, () => {
			pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
			act(() => {
				if (eventType === "visibilitychange")
					vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
				(eventType === "blur" ? window : document).dispatchEvent(new Event(eventType));
				vi.restoreAllMocks();
				vi.advanceTimersByTime(1_000);
			});
			expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
		});
	}

	it("连接丢失或 controller 更换后不把剩余 ESC 写入新连接", () => {
		pressAndRelease(findKeyCap(container, "Open the rewind history view (double escape)"));
		registeredController = { input: controller.input };
		act(() => vi.advanceTimersByTime(100));
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
		expect(showToast).toHaveBeenCalledTimes(1);
	});

	it("首步失败不安排第二步；第二步断线不在恢复后补发", () => {
		inputConnected = false;
		const rewind = findKeyCap(container, "Open the rewind history view (double escape)");
		pressAndRelease(rewind);
		inputConnected = true;
		act(() => vi.advanceTimersByTime(100));
		expect(sentSequences).toHaveLength(0);
		pressAndRelease(rewind);
		inputConnected = false;
		act(() => vi.advanceTimersByTime(100));
		inputConnected = true;
		act(() => vi.advanceTimersByTime(1_000));
		expect(sentSequences).toEqual([TERMINAL_ESCAPE_SEQUENCE]);
	});

	it("auto-repeats an arrow key while it stays held down", () => {
		// AskUserQuestion 的长选项列表里，逐下点按翻十几项非常折磨人。
		pressAndRelease(findKeyCap(container, "Arrow down"), 400 + 60 * 3);

		expect(sentSequences.length).toBeGreaterThan(1);
		expect(new Set(sentSequences)).toEqual(new Set([TERMINAL_ARROW_DOWN_SEQUENCE]));
	});

	it("never auto-repeats Enter, however long it is held", () => {
		// 连发 Enter 会重复提交，代价远高于省下的几次点按。
		pressAndRelease(findKeyCap(container, "Submit the current selection or input"), 5_000);

		expect(sentSequences).toEqual([TERMINAL_SUBMIT_CARRIAGE_RETURN_SEQUENCE]);
	});

	it("stops repeating as soon as the finger lifts", () => {
		const arrowDownKeyCap = findKeyCap(container, "Arrow down");
		pressAndRelease(arrowDownKeyCap, 400 + 60 * 2);
		const sentWhileHeld = sentSequences.length;

		act(() => {
			vi.advanceTimersByTime(5_000);
		});

		expect(sentSequences.length).toBe(sentWhileHeld);
	});

	it("keeps auto-repeating while the held pointer drifts off the key cap", () => {
		// 方向键键帽只有约 40×36px，按住期间手指/鼠标必然越出键面。按下时捕获了指针，
		// 这类越界就只是按住时的抖动，不该把连发掐断——否则长按连发被自己抵消掉了。
		const arrowDownKeyCap = findKeyCap(container, "Arrow down");
		pressDown(arrowDownKeyCap);
		expect(capturedPointerIds).toEqual([PRIMARY_POINTER_ID]);

		driftPointerOutOfElement(arrowDownKeyCap);
		act(() => {
			vi.advanceTimersByTime(400 + 60 * 3);
		});

		expect(sentSequences.length).toBeGreaterThan(1);
		expect(new Set(sentSequences)).toEqual(new Set([TERMINAL_ARROW_DOWN_SEQUENCE]));
	});

	it("stops repeating when the pointer capture is taken away mid-press", () => {
		// 捕获被系统夺走后 pointerup 不会再送到本元素，lostpointercapture 是最后一道停止信号。
		const arrowDownKeyCap = findKeyCap(container, "Arrow down");
		pressDown(arrowDownKeyCap);
		act(() => {
			vi.advanceTimersByTime(400 + 60 * 2);
		});
		const sentWhileHeld = sentSequences.length;
		expect(sentWhileHeld).toBeGreaterThan(1);

		act(() => {
			arrowDownKeyCap.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true }));
			vi.advanceTimersByTime(5_000);
		});

		expect(sentSequences.length).toBe(sentWhileHeld);
	});

	it("still stops on pointer leave when the runtime has no pointer capture at all", () => {
		// 捕获拿不到时，指针可能在键帽外抬起、pointerup 永远收不到，必须退回保守的
		// 「离开键面即停止」，否则连发会一直跑下去。
		uninstallPointerCaptureSupport();
		const arrowDownKeyCap = findKeyCap(container, "Arrow down");
		pressDown(arrowDownKeyCap);

		driftPointerOutOfElement(arrowDownKeyCap);
		act(() => {
			vi.advanceTimersByTime(5_000);
		});

		expect(sentSequences).toEqual([TERMINAL_ARROW_DOWN_SEQUENCE]);
	});

	it("lays the arrow keys out as an inverted-T cluster instead of one flat row", () => {
		// 三列网格 + 一个占位空格：↑ 独占中列上方，← ↓ → 在下一行。摊平成一行会让四个方向键
		// 退化成一排等价方块，拇指的空间记忆就没了。
		const directionalCluster = container.querySelector(".grid-cols-3");
		expect(directionalCluster).not.toBeNull();
		expect(directionalCluster?.children.length).toBe(6);
		expect(directionalCluster?.querySelectorAll("button").length).toBe(4);
	});

	it("publishes a viewport-bottom inset so floating pills can move out of the way", () => {
		// 两枚 fixed pill 与按键条互不知情，不让位就正好压住方向键和 Enter。
		expect(
			document.documentElement.style.getPropertyValue("--kb-terminal-virtual-key-bar-viewport-bottom-inset"),
		).toMatch(/^\d+px$/);
	});

	it("republishes the distance to the viewport bottom when review actions stack below the bar", async () => {
		// review / validation 两列会在按键条下方再挂 lastError 横幅与动作块，按键条因此不贴视口底。
		// 发布的若是按键条自身高度，pill 就正好少抬了下方那一摞的高度、重新压回按键上。
		const barElement = container.firstElementChild;
		if (!(barElement instanceof HTMLElement)) {
			throw new Error("The virtual key bar did not render");
		}
		Object.defineProperty(document.documentElement, "clientHeight", {
			configurable: true,
			value: VIEWPORT_HEIGHT_PX,
		});
		// jsdom 不跑布局，手动摆出「按键条下方还挂着 48px 内容」时按键条顶边所在的位置。
		const contentBelowBarHeightPx = 48;
		const barTopEdgePx = VIEWPORT_HEIGHT_PX - BAR_HEIGHT_PX - contentBelowBarHeightPx;
		barElement.getBoundingClientRect = () => new DOMRect(0, barTopEdgePx, 390, BAR_HEIGHT_PX);

		await act(async () => {
			// 动作块挂载 —— ResizeObserver 盯不到一个尚未存在的节点，靠 MutationObserver 重新登记。
			container.appendChild(document.createElement("div"));
		});

		expect(
			document.documentElement.style.getPropertyValue("--kb-terminal-virtual-key-bar-viewport-bottom-inset"),
		).toBe(`${BAR_HEIGHT_PX + contentBelowBarHeightPx}px`);
	});
});
