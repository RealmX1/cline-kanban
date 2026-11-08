import { act, createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTaskCardPortalWheelScrollForwarding } from "./use-task-card-portal-wheel-scroll-forwarding";

it.each([false, true])("嵌套浮层沿卡片来源接续滚动并保留手势与清理，面板含预览卡=%s", (containsPreviewCard) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const outer = document.body.appendChild(document.createElement("div"));
	outer.style.overflowY = "auto";
	Object.defineProperties(outer, { clientHeight: { value: 100 }, scrollHeight: { value: 900 } });
	const column = outer.appendChild(document.createElement("div"));
	column.style.overflowY = "auto";
	Object.defineProperties(column, { clientHeight: { value: 100 }, scrollHeight: { value: 600 } });
	const card = column.appendChild(document.createElement("div"));
	card.className = "kb-board-card-shell";
	const triggerRef = { current: card.appendChild(document.createElement("button")) };
	const firstPopupRef = createRef<HTMLDivElement>();
	const nestedTriggerRef = createRef<HTMLButtonElement>();
	const secondPopupRef = createRef<HTMLDivElement>();
	function Popup({
		sourceRef,
		popupRef,
		nested,
	}: {
		sourceRef: RefObject<HTMLElement>;
		popupRef: RefObject<HTMLDivElement>;
		nested?: boolean;
	}) {
		const attach = useTaskCardPortalWheelScrollForwarding(sourceRef, popupRef);
		return (
			<div ref={attach}>
				{nested ? (
					<div className={containsPreviewCard ? "kb-board-card-shell" : undefined}>
						<button ref={nestedTriggerRef} type="button">
							嵌套入口
						</button>
					</div>
				) : (
					<div style={{ overflowY: "auto" }}>内部内容</div>
				)}
			</div>
		);
	}
	const portalHost = document.body.appendChild(document.createElement("div"));
	const root = createRoot(portalHost);
	const wheel = (element: HTMLElement, options: WheelEventInit = {}) => {
		const event = new WheelEvent("wheel", { deltaY: 8, bubbles: true, cancelable: true, ...options });
		element.dispatchEvent(event);
		return event;
	};
	try {
		act(() =>
			root.render(
				<>
					<Popup sourceRef={triggerRef} popupRef={firstPopupRef} nested />
					<Popup sourceRef={nestedTriggerRef} popupRef={secondPopupRef} />
				</>,
			),
		);
		const popup = secondPopupRef.current!;
		const inner = popup.firstElementChild as HTMLElement;
		Object.defineProperties(inner, { clientHeight: { value: 40 }, scrollHeight: { value: 200 } });
		column.scrollTop = 100;
		expect(wheel(firstPopupRef.current!).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(108);
		expect(wheel(inner).defaultPrevented).toBe(false);
		expect(column.scrollTop).toBe(108);
		inner.scrollTop = 160;
		expect(wheel(inner).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(116);
		for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 20 }])
			expect(wheel(inner, options).defaultPrevented).toBe(false);
		expect(column.scrollTop).toBe(116);
		const parentPanel = firstPopupRef.current!;
		parentPanel.style.overflowY = "auto";
		Object.defineProperties(parentPanel, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
		parentPanel.scrollTop = 100;
		expect(wheel(popup).defaultPrevented).toBe(true);
		expect(parentPanel.scrollTop).toBe(108);
		expect(column.scrollTop).toBe(116);
		parentPanel.scrollTop = 400;
		expect(wheel(popup).defaultPrevented).toBe(true);
		expect(parentPanel.scrollTop).toBe(400);
		expect(column.scrollTop).toBe(124);
		column.scrollTop = 500;
		expect(wheel(popup).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(500);
		expect(outer.scrollTop).toBe(0);
		parentPanel.scrollTop = 0;
		column.scrollTop = 100;
		outer.scrollTop = 100;
		expect(wheel(popup, { deltaY: -8 }).defaultPrevented).toBe(true);
		expect(parentPanel.scrollTop).toBe(0);
		expect(column.scrollTop).toBe(92);
		column.scrollTop = 0;
		expect(wheel(popup, { deltaY: -8 }).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(0);
		expect(outer.scrollTop).toBe(100);
		const outsideTaskTrigger = document.body.appendChild(document.createElement("button"));
		act(() => root.render(<Popup sourceRef={{ current: outsideTaskTrigger }} popupRef={secondPopupRef} />));
		expect(wheel(secondPopupRef.current!).defaultPrevented).toBe(false);
		outsideTaskTrigger.remove();
		act(() => root.unmount());
		expect(secondPopupRef.current).toBeNull();
		expect(wheel(popup).defaultPrevented).toBe(false);
	} finally {
		if (portalHost.childNodes.length) act(() => root.unmount());
		portalHost.remove();
		outer.remove();
		vi.unstubAllGlobals();
	}
});

it("所属列到边界后停住，不把滚轮交给外层页面", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const outer = document.body.appendChild(document.createElement("div"));
	outer.style.overflowY = "auto";
	Object.defineProperties(outer, { clientHeight: { value: 120 }, scrollHeight: { value: 900 } });
	const boundary = outer.appendChild(document.createElement("div"));
	boundary.setAttribute("data-focus-view-column-scroll-boundary", "");
	const pinned = boundary.appendChild(document.createElement("div"));
	pinned.style.overflowY = "auto";
	Object.defineProperties(pinned, { clientHeight: { value: 80 }, scrollHeight: { value: 240 } });
	const pinnedCard = pinned.appendChild(document.createElement("div"));
	pinnedCard.className = "kb-board-card-shell";
	const pinnedTriggerRef = { current: pinnedCard.appendChild(document.createElement("button")) };
	const column = boundary.appendChild(document.createElement("div"));
	column.setAttribute("data-task-card-column-scroll-container", "");
	column.style.overflowY = "auto";
	Object.defineProperties(column, { clientHeight: { value: 100 }, scrollHeight: { value: 200 } });
	column.scrollTop = 100;
	const card = column.appendChild(document.createElement("div"));
	card.className = "kb-board-card-shell";
	const triggerRef = { current: card.appendChild(document.createElement("button")) };
	const popupRef = createRef<HTMLDivElement>();
	function Popup({ sourceRef }: { sourceRef: RefObject<HTMLElement> }) {
		const attach = useTaskCardPortalWheelScrollForwarding(sourceRef, popupRef);
		return <div ref={attach}>浮层</div>;
	}
	const portalHost = document.body.appendChild(document.createElement("div"));
	const root = createRoot(portalHost);
	const wheel = (element: HTMLElement, deltaY: number) => {
		const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
		element.dispatchEvent(event);
		return event;
	};
	try {
		const plainColumn = outer.appendChild(document.createElement("div"));
		plainColumn.style.overflowY = "auto";
		Object.defineProperties(plainColumn, { clientHeight: { value: 100 }, scrollHeight: { value: 200 } });
		plainColumn.scrollTop = 100;
		const plainCard = plainColumn.appendChild(document.createElement("div"));
		plainCard.className = "kb-board-card-shell";
		const plainTriggerRef = { current: plainCard.appendChild(document.createElement("button")) };
		act(() => root.render(<Popup sourceRef={plainTriggerRef} />));
		expect(wheel(popupRef.current!, 8).defaultPrevented).toBe(true);
		expect(plainColumn.scrollTop).toBe(100);
		expect(outer.scrollTop).toBe(0);
		plainColumn.remove();
		act(() => root.render(<Popup sourceRef={triggerRef} />));
		const popup = popupRef.current!;
		expect(wheel(popup, 8).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(100);
		expect(outer.scrollTop).toBe(0);
		column.scrollTop = 40;
		expect(wheel(popup, 8).defaultPrevented).toBe(true);
		expect(column.scrollTop).toBe(48);
		expect(outer.scrollTop).toBe(0);
		act(() => root.render(<Popup sourceRef={pinnedTriggerRef} />));
		pinned.scrollTop = 0;
		expect(wheel(popupRef.current!, 8).defaultPrevented).toBe(true);
		expect(pinned.scrollTop).toBe(8);
		expect(column.scrollTop).toBe(48);
		expect(outer.scrollTop).toBe(0);
		pinned.scrollTop = 160;
		expect(wheel(popupRef.current!, 8).defaultPrevented).toBe(true);
		expect(pinned.scrollTop).toBe(160);
		expect(column.scrollTop).toBe(56);
		expect(outer.scrollTop).toBe(0);
	} finally {
		if (portalHost.childNodes.length) act(() => root.unmount());
		portalHost.remove();
		outer.remove();
		vi.unstubAllGlobals();
	}
});
