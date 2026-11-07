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
