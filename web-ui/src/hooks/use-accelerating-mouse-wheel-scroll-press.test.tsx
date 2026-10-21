import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAcceleratingMouseWheelScrollPress } from "@/hooks/use-accelerating-mouse-wheel-scroll-press";

class TestPointerEvent extends MouseEvent {
	readonly pointerId = 1;
	readonly isPrimary = true;
}

const scrollStepTimes: number[] = [];
const recordUserInteraction = vi.fn();
function Harness({ identity = "workspace/task-1", enabled = true }: { identity?: string; enabled?: boolean }) {
	const bindings = useAcceleratingMouseWheelScrollPress({
		enabled,
		interactionIdentity: identity,
		onScrollStep: () => scrollStepTimes.push(Date.now()),
		onUserInteraction: recordUserInteraction,
	});
	return (
		<button type="button" {...bindings}>
			滚动
		</button>
	);
}

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
describe("滚轮按钮长按加速", () => {
	let host: HTMLDivElement;
	let root: Root;
	let capturePointer = vi.fn<(pointerId: number) => void>();
	const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));
	const dispatchPointer = (type: string) =>
		act(() =>
			host
				.querySelector("button")!
				.dispatchEvent(new TestPointerEvent(type, { bubbles: true, cancelable: true, button: 0 })),
		);
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		capturePointer = vi.fn<(pointerId: number) => void>();
		vi.stubGlobal("PointerEvent", TestPointerEvent);
		Element.prototype.setPointerCapture = capturePointer;
		scrollStepTimes.length = 0;
		recordUserInteraction.mockClear();
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete (Element.prototype as Partial<Element>).setPointerCapture;
		vi.useRealTimers();
		delete environment.IS_REACT_ACT_ENVIRONMENT;
	});
	it("点按立即滚动一次，并吞掉后续 click", () => {
		dispatchPointer("pointerdown");
		expect(scrollStepTimes).toEqual([0]);
		advance(399);
		expect(scrollStepTimes).toHaveLength(1);
		dispatchPointer("pointerup");
		act(() => host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
		advance(2000);
		expect(scrollStepTimes).toHaveLength(1);
		expect(capturePointer).toHaveBeenCalledWith(1);
	});
	it("取消触摸后，键盘和读屏的零 detail 激活仍有效", () => {
		dispatchPointer("pointerdown");
		dispatchPointer("pointercancel");
		act(() => host.querySelector("button")!.click());
		expect(scrollStepTimes).toHaveLength(2);
	});
	it("触屏补发 detail=0 的 PointerEvent click 不重复滚动", () => {
		dispatchPointer("pointerdown");
		dispatchPointer("pointerup");
		const click = new TestPointerEvent("click", { bubbles: true, detail: 0 });
		Object.defineProperty(click, "pointerType", { value: "touch" });
		act(() => host.querySelector("button")!.dispatchEvent(click));
		expect(scrollStepTimes).toHaveLength(1);
		act(() => host.querySelector("button")!.click());
		expect(scrollStepTimes).toHaveLength(2);
	});
	it("页面隐藏立即清除连滚", () => {
		dispatchPointer("pointerdown");
		advance(600);
		vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		const count = scrollStepTimes.length;
		advance(1000);
		expect(scrollStepTimes).toHaveLength(count);
	});

	it("400ms 后连滚，2 秒内逐渐提速并封顶，每一步都续期用户活动", () => {
		dispatchPointer("pointerdown");
		advance(400);
		expect(scrollStepTimes).toEqual([0, 400]);
		advance(2800);
		const intervals = scrollStepTimes.slice(1).map((time, index) => time - scrollStepTimes[index]!);
		expect(intervals[1]).toBe(125);
		expect(intervals.at(-1)).toBe(42);
		expect(intervals.slice(2).every((interval) => interval >= 42)).toBe(true);
		expect(recordUserInteraction).toHaveBeenCalledTimes(scrollStepTimes.length);
	});
	it.each(["pointerup", "pointercancel", "lostpointercapture"])(
		"%s 立即停止，下一次按压从低速重新开始",
		(eventName) => {
			dispatchPointer("pointerdown");
			advance(2800);
			dispatchPointer(eventName);
			const count = scrollStepTimes.length;
			advance(1000);
			expect(scrollStepTimes).toHaveLength(count);
			dispatchPointer("pointerdown");
			advance(399);
			expect(scrollStepTimes).toHaveLength(count + 1);
			advance(1);
			expect(scrollStepTimes).toHaveLength(count + 2);
		},
	);
	it("捕获成立时滑出键面继续，捕获失败则滑出立即停止", () => {
		dispatchPointer("pointerdown");
		dispatchPointer("pointerout");
		advance(600);
		expect(scrollStepTimes.length).toBeGreaterThan(1);
		dispatchPointer("pointerup");
		capturePointer.mockImplementation(() => {
			throw new Error("捕获失败");
		});
		dispatchPointer("pointerdown");
		dispatchPointer("pointerout");
		const count = scrollStepTimes.length;
		advance(1000);
		expect(scrollStepTimes).toHaveLength(count);
	});
	it("失焦、禁用、切换会话及卸载都清理长按", () => {
		for (const stop of [
			() => window.dispatchEvent(new Event("blur")),
			() => root.render(<Harness enabled={false} />),
			() => root.render(<Harness identity="workspace/task-2" />),
			() => root.render(null),
		]) {
			act(() => root.render(<Harness />));
			dispatchPointer("pointerdown");
			advance(600);
			act(stop);
			const count = scrollStepTimes.length;
			advance(1000);
			expect(scrollStepTimes).toHaveLength(count);
		}
	});
});
