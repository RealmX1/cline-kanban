import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";

const mobile = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => mobile.value }));
const committedExpansionStates: boolean[][] = [];
let controls: ReturnType<typeof useMobileFocusViewCollapsibleControls>;
function Harness({
	identity = "workspace/task-1",
	visible = true,
	enabled = true,
}: {
	identity?: string;
	visible?: boolean;
	enabled?: boolean;
}) {
	controls = useMobileFocusViewCollapsibleControls({
		enabled,
		focusedTaskIdentity: identity,
		isDocumentVisible: visible,
	});
	useLayoutEffect(() => {
		committedExpansionStates.push([controls.upperNavigationAndToolsExpanded, controls.lowerVirtualKeyBarExpanded]);
	});
	return (
		<div ref={controls.focusViewRootRef}>
			<input aria-label="Agent 输入" />
			<p>输出</p>
		</div>
	);
}
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
describe("手机 Focus View 独立折叠", () => {
	let host: HTMLDivElement;
	let root: Root;
	const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));
	beforeEach(() => {
		vi.useFakeTimers();
		mobile.value = true;
		committedExpansionStates.length = 0;
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.useRealTimers();
		delete environment.IS_REACT_ACT_ENVIRONMENT;
	});
	it("首屏折叠且手动展开上下区域互不影响", () => {
		expect(committedExpansionStates).toEqual([[false, false]]);
		expect(controls.upperNavigationAndToolsExpanded).toBe(false);
		expect(controls.lowerVirtualKeyBarExpanded).toBe(false);
		act(() => controls.expandLowerVirtualKeyBar());
		expect(controls.lowerVirtualKeyBarExpanded).toBe(true);
		expect(controls.upperNavigationAndToolsExpanded).toBe(false);
		act(() => controls.toggleUpperNavigationAndTools());
		act(() => controls.collapseLowerVirtualKeyBar());
		expect(controls.lowerVirtualKeyBarExpanded).toBe(false);
		expect(controls.upperNavigationAndToolsExpanded).toBe(true);
	});
	it("用户输入只续期，不自动重新展开；Agent scroll 不续期", () => {
		advance(30_000);
		act(() => host.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true })));
		expect(controls.upperNavigationAndToolsExpanded).toBe(false);
		act(() => controls.expandLowerVirtualKeyBar());
		advance(20_000);
		act(() => host.querySelector("p")!.dispatchEvent(new Event("scroll", { bubbles: true })));
		advance(10_000);
		expect(controls.lowerVirtualKeyBarExpanded).toBe(false);
	});
	it("换项目或任务从首帧折叠，不继承旧展开状态", () => {
		act(() => controls.toggleUpperNavigationAndTools());
		act(() => controls.expandLowerVirtualKeyBar());
		committedExpansionStates.length = 0;
		act(() => root.render(<Harness identity="other-workspace/task-1" />));
		expect(committedExpansionStates.every((states) => states.every((expanded) => !expanded))).toBe(true);
		act(() => controls.expandLowerVirtualKeyBar());
		advance(29_999);
		expect(controls.lowerVirtualKeyBarExpanded).toBe(true);
		advance(1);
		expect(controls.lowerVirtualKeyBarExpanded).toBe(false);
	});
	it("页面隐藏期间不计时，回到页面不会自动展开", () => {
		advance(30_000);
		act(() => root.render(<Harness visible={false} />));
		advance(60_000);
		act(() => root.render(<Harness />));
		expect(controls.upperNavigationAndToolsExpanded).toBe(false);
	});
	it("切回桌面停用控制器，再进手机视图从首帧折叠", () => {
		advance(30_000);
		mobile.value = false;
		act(() => root.render(<Harness />));
		expect(controls.isEnabled).toBe(false);
		mobile.value = true;
		act(() => root.render(<Harness />));
		expect(controls.upperNavigationAndToolsExpanded).toBe(false);
		expect(controls.lowerVirtualKeyBarExpanded).toBe(false);
	});
	it("离开 Focus View 再进入同一任务也恢复折叠", () => {
		act(() => controls.toggleUpperNavigationAndTools());
		act(() => controls.expandLowerVirtualKeyBar());
		act(() => root.render(<Harness enabled={false} />));
		committedExpansionStates.length = 0;
		act(() => root.render(<Harness />));
		expect(committedExpansionStates.every((states) => states.every((expanded) => !expanded))).toBe(true);
	});
});
