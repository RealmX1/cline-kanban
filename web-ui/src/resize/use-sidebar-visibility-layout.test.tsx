import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutCustomizationsProvider, useLayoutCustomizations } from "@/resize/layout-customizations";
import { useSidebarVisibilityLayout } from "@/resize/use-sidebar-visibility-layout";
import { LocalStorageKey } from "@/storage/local-storage-store";

describe("三个桌面侧栏的显隐偏好", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let currentLayout: ReturnType<typeof useSidebarVisibilityLayout>;
	function ResetButton() {
		const { resetLayoutCustomizations } = useLayoutCustomizations();
		return (
			<button type="button" onClick={resetLayoutCustomizations}>
				重置布局
			</button>
		);
	}
	function Harness() {
		currentLayout = useSidebarVisibilityLayout();
		return (
			<LayoutCustomizationsProvider
				onResetBottomTerminalLayoutCustomizations={() => {}}
				onResetSidebarVisibilityLayoutCustomizations={currentLayout.resetSidebarVisibilityLayoutCustomizations}
			>
				<ResetButton />
			</LayoutCustomizationsProvider>
		);
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	it("默认显示，各自持久化，重新挂载后恢复且不改宽度和图标列偏好", () => {
		localStorage.setItem(LocalStorageKey.ProjectNavigationPanelCollapsed, "true");
		localStorage.setItem(LocalStorageKey.DetailTerminalPanelWidth, "640");
		act(() => root.render(<Harness />));
		expect(currentLayout.isHomeProjectSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewTaskListSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewWorkbenchSidebarHidden).toBe(false);
		act(() => currentLayout.setHomeProjectSidebarHidden(true));
		expect(currentLayout.isFocusViewTaskListSidebarHidden).toBe(false);
		act(() => currentLayout.setFocusViewTaskListSidebarHidden(true));
		expect(currentLayout.isFocusViewWorkbenchSidebarHidden).toBe(false);
		act(() => currentLayout.setFocusViewWorkbenchSidebarHidden(true));
		act(() => root.render(null));
		act(() => root.render(<Harness />));
		expect(currentLayout.isHomeProjectSidebarHidden).toBe(true);
		expect(currentLayout.isFocusViewTaskListSidebarHidden).toBe(true);
		expect(currentLayout.isFocusViewWorkbenchSidebarHidden).toBe(true);
		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelCollapsed)).toBe("true");
		expect(localStorage.getItem(LocalStorageKey.DetailTerminalPanelWidth)).toBe("640");
	});
	it("重置布局同时恢复当前页面和后续页面的三个侧栏", () => {
		act(() => root.render(<Harness />));
		act(() => {
			currentLayout.setHomeProjectSidebarHidden(true);
			currentLayout.setFocusViewTaskListSidebarHidden(true);
			currentLayout.setFocusViewWorkbenchSidebarHidden(true);
		});
		act(() => container.querySelector("button")!.click());
		expect(currentLayout.isHomeProjectSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewTaskListSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewWorkbenchSidebarHidden).toBe(false);
		act(() => root.render(null));
		act(() => root.render(<Harness />));
		expect(currentLayout.isHomeProjectSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewTaskListSidebarHidden).toBe(false);
		expect(currentLayout.isFocusViewWorkbenchSidebarHidden).toBe(false);
	});
});
