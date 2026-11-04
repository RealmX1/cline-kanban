import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";

vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
const environment = vi.hoisted(() => ({ isMacPlatform: true }));
vi.mock("@/utils/platform", () => ({
	get isMacPlatform() {
		return environment.isMacPlatform;
	},
}));

describe("侧栏快捷键和启动全部任务快捷键", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const toggleLeftSidebar = vi.fn();
	const toggleWorkbenchSidebar = vi.fn();
	const startAllTasks = vi.fn();
	function Harness({ workbenchAvailable = true }: { workbenchAvailable?: boolean }) {
		useAppHotkeys({
			selectedCard: null,
			isDetailTerminalOpen: false,
			isHomeTerminalOpen: false,
			isHomeGitHistoryOpen: false,
			canUseCreateTaskShortcut: false,
			canUseTaskSpotlightSearch: false,
			handleToggleDetailTerminal() {},
			handleToggleHomeTerminal() {},
			handleToggleExpandDetailTerminal() {},
			handleToggleExpandHomeTerminal() {},
			handleOpenCreateTask() {},
			handleToggleTaskSpotlightSearch() {},
			handleOpenSettings() {},
			handleToggleGitHistory() {},
			handleCloseGitHistory() {},
			handleToggleBetweenBoardScopeAndFocusedTaskProjectScope: null,
			handleToggleCurrentPageLeftSidebar: toggleLeftSidebar,
			handleToggleFocusViewWorkbenchSidebar: workbenchAvailable ? toggleWorkbenchSidebar : null,
			onRequestStartAllReadyBacklogTasks: startAllTasks,
		});
		return <textarea aria-label="普通输入框或终端输入入口" />;
	}
	function press(overrides: KeyboardEventInit = {}, target: Element = container.querySelector("textarea")!) {
		const event = new KeyboardEvent("keydown", {
			key: "b",
			code: "KeyB",
			metaKey: environment.isMacPlatform,
			ctrlKey: !environment.isMacPlatform,
			bubbles: true,
			cancelable: true,
			...overrides,
		});
		act(() => {
			target.dispatchEvent(event);
		});
		return event;
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.clearAllMocks();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	it.each([true, false])("平台 macOS=%s 时三个组合精确分流且在输入框内生效", (isMacPlatform) => {
		environment.isMacPlatform = isMacPlatform;
		expect(press().defaultPrevented).toBe(true);
		expect(toggleLeftSidebar).toHaveBeenCalledTimes(1);
		expect(startAllTasks).not.toHaveBeenCalled();
		expect(press({ altKey: true, key: "∫" }).defaultPrevented).toBe(true);
		expect(toggleWorkbenchSidebar).toHaveBeenCalledTimes(1);
		expect(press({ shiftKey: true }).defaultPrevented).toBe(true);
		expect(startAllTasks).toHaveBeenCalledTimes(1);
		for (const modifiers of [
			{ metaKey: !isMacPlatform, ctrlKey: isMacPlatform },
			{ metaKey: true, ctrlKey: true },
			{ shiftKey: true, altKey: true },
			{ code: "KeyN" },
		])
			expect(press(modifiers).defaultPrevented).toBe(false);
		expect(toggleLeftSidebar).toHaveBeenCalledTimes(1);
		expect(toggleWorkbenchSidebar).toHaveBeenCalledTimes(1);
		expect(startAllTasks).toHaveBeenCalledTimes(1);
	});
	it("忽略输入法组字、对话框和已处理事件，长按只切换一次", () => {
		for (const composition of [{ isComposing: true }, { keyCode: 229 }])
			expect(press(composition).defaultPrevented).toBe(false);
		for (const role of ["dialog", "alertdialog"]) {
			const dialog = document.createElement("div");
			dialog.setAttribute("role", role);
			const input = document.createElement("input");
			dialog.append(input);
			container.append(dialog);
			expect(press({}, input).defaultPrevented).toBe(false);
			dialog.remove();
		}
		expect(toggleLeftSidebar).not.toHaveBeenCalled();
		const target = container.querySelector("textarea")!;
		const event = new KeyboardEvent("keydown", {
			code: "KeyB",
			metaKey: true,
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		event.preventDefault();
		act(() => {
			target.dispatchEvent(event);
		});
		expect(toggleLeftSidebar).not.toHaveBeenCalled();
		press();
		expect(press({ repeat: true }).defaultPrevented).toBe(true);
		expect(toggleLeftSidebar).toHaveBeenCalledTimes(1);
	});
	it("首页没有右栏快捷键，卸载后不残留监听", () => {
		act(() => root.render(<Harness workbenchAvailable={false} />));
		expect(press({ altKey: true }).defaultPrevented).toBe(false);
		const input = container.querySelector("textarea")!;
		act(() => root.render(null));
		document.body.append(input);
		expect(press({}, input).defaultPrevented).toBe(false);
		input.remove();
		expect(toggleWorkbenchSidebar).not.toHaveBeenCalled();
		expect(toggleLeftSidebar).not.toHaveBeenCalled();
	});
});
