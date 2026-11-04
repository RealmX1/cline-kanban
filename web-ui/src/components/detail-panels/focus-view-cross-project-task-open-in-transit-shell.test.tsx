import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { FocusViewCrossProjectTaskOpenInTransitShell } from "@/components/detail-panels/focus-view-cross-project-task-open-in-transit-shell";

const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => viewport.isMobile }));
vi.mock("@/components/detail-panels/cross-project-recently-active-task-switcher-panel", () => ({
	CrossProjectRecentlyActiveTaskSwitcherPanel: () => <div data-testid="mounted-transit-task-list" />,
}));
const host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
	projects: [],
	notificationLogByWorkspaceId: {},
	currentProjectId: "isolated-project",
	isBoardScopeAllProjectsSelected: true,
	focusedTaskInProject: null,
	onOpenTaskInProject() {},
	onRequestPinCurrentProjectTaskToTaskPinboard() {},
	onUnpinCurrentProjectTaskFromTaskPinboard() {},
	onEditCurrentProjectTaskPinboardPinReason() {},
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function renderShell(hidden: boolean) {
	act(() =>
		root.render(
			<FocusViewCrossProjectTaskOpenInTransitShell
				host={host}
				targetProjectName="目标项目"
				targetTaskTitle="目标任务"
				onCancel={() => {}}
				isFocusViewTaskListSidebarHidden={hidden}
			/>,
		),
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	viewport.isMobile = false;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
it("跨项目过渡外壳隐藏左栏时保留挂载及比例，恢复后仍为同一列表", () => {
	renderShell(false);
	const list = container.querySelector('[data-testid="mounted-transit-task-list"]')!;
	const panel = list.parentElement!;
	const originalWidth = panel.style.width;
	renderShell(true);
	expect(panel.style.display).toBe("none");
	expect(panel.style.width).toBe(originalWidth);
	renderShell(false);
	expect(container.querySelector('[data-testid="mounted-transit-task-list"]')).toBe(list);
	expect(panel.style.display).toBe("");
});
it("手机过渡外壳不应用桌面左栏隐藏偏好", () => {
	viewport.isMobile = true;
	renderShell(true);
	expect(container.querySelector('[data-testid="mounted-transit-task-list"]')!.parentElement!.style.display).toBe("");
});
