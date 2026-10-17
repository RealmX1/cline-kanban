import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileFocusViewIdleCollapseController } from "@/hooks/use-mobile-focus-view-idle-collapse-controller";

let controller: ReturnType<typeof useMobileFocusViewIdleCollapseController>;
function Harness({ enabled = true, identity = "project/task-1" }: { enabled?: boolean; identity?: string }) {
	const focusViewRootRef = useRef<HTMLDivElement>(null);
	controller = useMobileFocusViewIdleCollapseController({ enabled, focusedTaskIdentity: identity, focusViewRootRef });
	return (
		<div ref={focusViewRootRef}>
			<button type="button">操作</button>
			<textarea data-mobile-focus-view-idle-collapse-suspension="" />
			<input aria-label="Agent 输入" />
			<p>可以选择的任务信息</p>
		</div>
	);
}

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("手机 Focus View 共用闲置收起控制器", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.useFakeTimers();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		document.getSelection()?.removeAllRanges();
		vi.useRealTimers();
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});
	const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));

	it("30 秒到期只发出一次收起通知，重渲染不延后截止时间", () => {
		advance(20_000);
		act(() => root.render(<Harness />));
		advance(9_999);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		advance(1);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
		advance(60_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it.each(["pointerdown", "keydown", "input", "wheel", "touchmove"])(
		"用户 %s 重置共用倒计时，外部活动不重置",
		(eventName) => {
			advance(20_000);
			act(() => host.querySelector("button")?.dispatchEvent(new Event(eventName, { bubbles: true })));
			advance(20_000);
			expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
			act(() => document.body.dispatchEvent(new Event(eventName, { bubbles: true })));
			advance(10_000);
			expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
			act(() => controller.recordUserInteraction());
			advance(30_000);
			expect(controller.idleCollapseRequestSequenceNumber).toBe(2);
		},
	);

	it("Agent 自动跟随输出产生的程序化 scroll 不重置闲置时间", () => {
		advance(20_000);
		act(() => host.firstElementChild?.dispatchEvent(new Event("scroll", { bubbles: true })));
		advance(10_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it("标题编辑期间暂停，离开编辑后重新等待完整 30 秒", () => {
		advance(20_000);
		act(() => host.querySelector("textarea")?.focus());
		advance(60_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		act(() => host.querySelector("button")?.focus());
		advance(29_999);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		advance(1);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it("选中文字暂停，取消选择后重新计时", () => {
		const selection = document.getSelection();
		const range = document.createRange();
		range.selectNodeContents(host.querySelector("p")!);
		act(() => {
			selection?.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));
		});
		advance(60_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		act(() => {
			selection?.removeAllRanges();
			document.dispatchEvent(new Event("selectionchange"));
		});
		advance(30_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it("Agent 输入入口保留焦点时仍能闲置收起", () => {
		act(() => host.querySelector("input")?.focus());
		advance(30_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it("Portal 弹窗打开时暂停，关闭后重新计时", async () => {
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		await act(async () => document.body.append(dialog));
		advance(60_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		await act(async () => dialog.remove());
		advance(30_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});

	it("切换任务重新计时，桌面禁用后不再通知", () => {
		advance(20_000);
		act(() => root.render(<Harness identity="another-project/task-1" />));
		advance(20_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(0);
		advance(10_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
		act(() => root.render(<Harness enabled={false} />));
		advance(60_000);
		expect(controller.idleCollapseRequestSequenceNumber).toBe(1);
	});
});
