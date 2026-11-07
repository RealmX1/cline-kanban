import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FocusViewGroupHeader } from "./focus-view-group-header";
import { FocusViewGroupHeaderRails } from "./focus-view-group-header-rails";

it("折叠箭头与标题跳转独立，没有跳转能力时标题为文本", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const toggle = vi.fn();
	const jump = vi.fn();
	try {
		act(() =>
			root.render(
				<TooltipProvider>
					<FocusViewGroupHeader
						title="Review"
						count={128}
						isExpanded
						onToggleExpanded={toggle}
						onJumpToSection={jump}
					/>
				</TooltipProvider>,
			),
		);
		act(() => container.querySelector<HTMLButtonElement>('[aria-label="收起 Review"]')!.click());
		expect(toggle).toHaveBeenCalledOnce();
		expect(jump).not.toHaveBeenCalled();
		act(() => container.querySelector<HTMLButtonElement>('[aria-label="跳转到 Review"]')!.click());
		expect(jump).toHaveBeenCalledOnce();
		act(() =>
			root.render(
				<TooltipProvider>
					<FocusViewGroupHeader title="Recent" count={1234} isExpanded={false} onToggleExpanded={toggle} />
				</TooltipProvider>,
			),
		);
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(container.textContent).toContain("Recent1234");
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});

it.each([undefined, 5])("焦点副本扣除标题预算并随视口缩小更新，固定分组数=%s", (totalNavigableGroupCount) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	let notifyResize = () => {};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				notifyResize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	const container = document.body.appendChild(document.createElement("div"));
	const scrollRoot = container.appendChild(document.createElement("div"));
	let viewportHeight = 320;
	Object.defineProperty(scrollRoot, "clientHeight", { get: () => viewportHeight });
	const root = createRoot(container.appendChild(document.createElement("div")));
	try {
		act(() =>
			root.render(
				<FocusViewGroupHeaderRails
					scrollRootRef={{ current: scrollRoot }}
					topPinnedGroupIds={["a", "b"]}
					bottomPinnedGroupIds={["c"]}
					totalNavigableGroupCount={totalNavigableGroupCount}
					renderEntry={(id) => <div key={id}>{id}</div>}
				/>,
			),
		);
		const rails = [...container.querySelectorAll<HTMLElement>('[data-testid="stage-header-rail"]')];
		expect(rails).toHaveLength(2);
		for (const rail of rails)
			expect(rail.style.getPropertyValue("--kb-focused-card-rail-maximum-height")).toBe(
				totalNavigableGroupCount === undefined ? "206px" : "130px",
			);
		viewportHeight = 180;
		act(() => notifyResize());
		for (const rail of rails)
			expect(rail.style.getPropertyValue("--kb-focused-card-rail-maximum-height")).toBe(
				totalNavigableGroupCount === undefined ? "66px" : "20px",
			);
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});

it("吸顶区滚轮优先内部滚动，到边界后交给同列，保留缩放和横向手势并清理监听", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	container.setAttribute("data-focus-view-column-scroll-boundary", "");
	const scrollRoot = container.appendChild(document.createElement("div"));
	scrollRoot.style.lineHeight = "20px";
	Object.defineProperties(scrollRoot, {
		offsetWidth: { value: 320 },
		clientWidth: { value: 306 },
		clientHeight: { value: 300 },
		scrollHeight: { value: 1000 },
	});
	const root = createRoot(container.appendChild(document.createElement("div")));
	const dispatchWheel = (element: HTMLElement, options: WheelEventInit = {}) => {
		const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, ...options });
		element.dispatchEvent(event);
		return event;
	};
	try {
		act(() =>
			root.render(
				<FocusViewGroupHeaderRails
					scrollRootRef={{ current: scrollRoot }}
					topPinnedGroupIds={["review"]}
					bottomPinnedGroupIds={[]}
					renderEntry={(id) => (
						<div key={id}>
							<span>标题</span>
							<div style={{ overflowY: "auto" }}>焦点副本</div>
						</div>
					)}
				/>,
			),
		);
		expect(container.style.getPropertyValue("--kb-focus-view-column-scrollbar-width")).toBe("14px");
		const header = container.querySelector("span")!;
		const focusedCard = header.nextElementSibling as HTMLElement;
		const rail = container.querySelector<HTMLElement>('[data-testid="stage-header-rail"]')!;
		rail.style.overflowY = "auto";
		Object.defineProperties(rail, { clientHeight: { value: 160 }, scrollHeight: { value: 162 } });
		Object.defineProperties(focusedCard, { clientHeight: { value: 50 }, scrollHeight: { value: 200 } });
		scrollRoot.scrollTop = 100;
		expect(dispatchWheel(header).defaultPrevented).toBe(true);
		expect(scrollRoot.scrollTop).toBe(140);
		expect(dispatchWheel(scrollRoot).defaultPrevented).toBe(false);
		expect(dispatchWheel(focusedCard).defaultPrevented).toBe(false);
		expect(scrollRoot.scrollTop).toBe(140);
		focusedCard.scrollTop = 150;
		expect(dispatchWheel(focusedCard).defaultPrevented).toBe(true);
		expect(scrollRoot.scrollTop).toBe(180);
		for (const gesture of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 80 }]) {
			expect(dispatchWheel(header, gesture).defaultPrevented).toBe(false);
			expect(scrollRoot.scrollTop).toBe(180);
		}
		dispatchWheel(header, { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 2 });
		expect(scrollRoot.scrollTop).toBe(220);
		dispatchWheel(header, { deltaMode: WheelEvent.DOM_DELTA_PAGE, deltaY: 1 });
		expect(scrollRoot.scrollTop).toBe(520);
		scrollRoot.scrollTop = 700;
		expect(dispatchWheel(header).defaultPrevented).toBe(false);
		expect(scrollRoot.scrollTop).toBe(700);
		act(() => root.unmount());
		expect(dispatchWheel(container).defaultPrevented).toBe(false);
		expect(container.style.getPropertyValue("--kb-focus-view-column-scrollbar-width")).toBe("");
	} finally {
		if (container.querySelector("span")) act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
