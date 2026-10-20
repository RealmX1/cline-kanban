import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusViewDesktopPanelArrangement } from "@/hooks/use-focus-view-desktop-panel-arrangement";
import { resolveFocusViewDesktopPanelArrangement } from "@/resize/focus-view-desktop-panel-arrangement";
import { LocalStorageKey } from "@/storage/local-storage-store";

let root: Root;
let container: HTMLDivElement;
let renderCount = 0;
let currentArrangement: ReturnType<typeof useFocusViewDesktopPanelArrangement>;

function ArrangementHarness() {
	renderCount++;
	currentArrangement = useFocusViewDesktopPanelArrangement();
	return null;
}

function resizeViewport(width: number, height: number) {
	act(() => {
		vi.stubGlobal("innerWidth", width);
		vi.stubGlobal("innerHeight", height);
		window.dispatchEvent(new Event("resize"));
	});
}

beforeEach(() => {
	renderCount = 0;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	window.localStorage.clear();
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 1000);
	// CSS 将正方形视口归入 portrait；后台估算使用真实宽高的严格大于判据。
	vi.stubGlobal("matchMedia", () => ({
		matches: window.innerHeight >= window.innerWidth,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("桌面面板布局读取真实视口", () => {
	it("正方形视口与后台估算都使用左右布局", () => {
		act(() => root.render(<ArrangementHarness />));
		expect(currentArrangement.arrangement).toBe("agent_left_workbench_right");
		expect(currentArrangement.arrangement).toBe(
			resolveFocusViewDesktopPanelArrangement("automatic", window.innerWidth, window.innerHeight),
		);
	});

	it("同方向连续 resize 不重渲染面板消费者", () => {
		act(() => root.render(<ArrangementHarness />));
		const initialRenderCount = renderCount;
		resizeViewport(1200, 1000);
		resizeViewport(1400, 900);
		expect(renderCount).toBe(initialRenderCount);
		resizeViewport(900, 1400);
		const portraitRenderCount = renderCount;
		resizeViewport(950, 1500);
		expect(renderCount).toBe(portraitRenderCount);
	});

	it("窗口在横屏、正方形和竖屏之间变化时自动更新", () => {
		act(() => root.render(<ArrangementHarness />));
		resizeViewport(1000, 1200);
		expect(currentArrangement.arrangement).toBe("agent_above_workbench_below");
		resizeViewport(1000, 1000);
		expect(currentArrangement.arrangement).toBe("agent_left_workbench_right");
		resizeViewport(1400, 1000);
		expect(currentArrangement.arrangement).toBe("agent_left_workbench_right");
	});

	it("手动偏好跨 resize 保持，恢复自动后按当前真实宽高解析", () => {
		window.localStorage.setItem(
			LocalStorageKey.FocusViewDesktopPanelArrangementPreference,
			"agent_above_workbench_below",
		);
		act(() => root.render(<ArrangementHarness />));
		expect(currentArrangement.arrangement).toBe("agent_above_workbench_below");
		resizeViewport(1400, 1000);
		expect(currentArrangement.arrangement).toBe("agent_above_workbench_below");
		act(() => currentArrangement.setPreference("agent_left_workbench_right"));
		resizeViewport(1000, 1400);
		expect(currentArrangement.arrangement).toBe("agent_left_workbench_right");
		expect(window.localStorage.getItem(LocalStorageKey.FocusViewDesktopPanelArrangementPreference)).toBe(
			"agent_left_workbench_right",
		);
		act(() => currentArrangement.setPreference("automatic"));
		expect(currentArrangement.arrangement).toBe("agent_above_workbench_below");
	});
});
