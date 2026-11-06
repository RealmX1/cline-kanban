import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FocusViewGroupHeader } from "./focus-view-group-header";

it("折叠箭头与标题跳转独立，没有跳转能力时标题为文本", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const toggle = vi.fn();
	const jump = vi.fn();
	try {
		act(() =>
			root.render(
				<FocusViewGroupHeader
					title="Review"
					count={128}
					isExpanded
					onToggleExpanded={toggle}
					onJumpToSection={jump}
				/>,
			),
		);
		act(() => container.querySelector<HTMLButtonElement>('[aria-label="收起 Review"]')!.click());
		expect(toggle).toHaveBeenCalledOnce();
		expect(jump).not.toHaveBeenCalled();
		act(() => container.querySelector<HTMLButtonElement>('[aria-label="跳转到 Review"]')!.click());
		expect(jump).toHaveBeenCalledOnce();
		act(() =>
			root.render(<FocusViewGroupHeader title="Recent" count={1234} isExpanded={false} onToggleExpanded={toggle} />),
		);
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(container.textContent).toContain("Recent1234");
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
