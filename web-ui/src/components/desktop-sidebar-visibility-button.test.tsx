import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopSidebarVisibilityButton } from "@/components/desktop-sidebar-visibility-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/utils/platform";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it.each(["left", "right", "bottom"] as const)("%s 按钮保留提示、快捷键与显式点击", async (side) => {
	const onToggle = vi.fn();
	await act(async () =>
		root.render(
			<TooltipProvider>
				<DesktopSidebarVisibilityButton side={side} label="侧栏" isHidden={false} onToggle={onToggle} />
			</TooltipProvider>,
		),
	);
	const button = container.querySelector("button")!;
	expect(button.getAttribute("aria-label")).toBe("隐藏侧栏");
	expect(button.getAttribute("aria-pressed")).toBe("true");
	expect(button.getAttribute("aria-keyshortcuts")).toBe(
		`${isMacPlatform ? "Meta" : "Control"}${side === "left" ? "" : "+Alt"}+B`,
	);
	await act(async () => button.focus());
	expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
		`隐藏侧栏 (${isMacPlatform ? "Cmd" : "Ctrl"}${side === "left" ? "" : isMacPlatform ? "+Option" : "+Alt"}+B)`,
	);
	expect(onToggle).not.toHaveBeenCalled();
	await act(async () => button.click());
	expect(onToggle).toHaveBeenCalledOnce();
});
