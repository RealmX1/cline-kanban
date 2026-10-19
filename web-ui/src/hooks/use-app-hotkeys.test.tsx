import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHotkeys } from "react-hotkeys-hook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: vi.fn(),
}));

const scopeToggleHotkeyTestEnvironment = vi.hoisted(() => ({ isMacPlatform: true }));
vi.mock("@/utils/platform", () => ({
	get isMacPlatform() {
		return scopeToggleHotkeyTestEnvironment.isMacPlatform;
	},
}));

const mockUseHotkeys = vi.mocked(useHotkeys);

function HookHarness(props: Parameters<typeof useAppHotkeys>[0]): null {
	useAppHotkeys(props);
	return null;
}

describe("useAppHotkeys", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockUseHotkeys.mockReset();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("registers git history and settings shortcuts", async () => {
		const handleToggleGitHistory = vi.fn();
		const handleOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen={false}
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					canUseTaskSpotlightSearch
					handleToggleTaskSpotlightSearch={() => {}}
					handleOpenSettings={handleOpenSettings}
					handleToggleGitHistory={handleToggleGitHistory}
					handleCloseGitHistory={() => {}}
					onRequestStartAllReadyBacklogTasks={() => {}}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const gitHistoryCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+g");
		if (!gitHistoryCall || typeof gitHistoryCall[1] !== "function") {
			throw new Error("Expected git history shortcut to be registered.");
		}
		const settingsCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+shift+s");
		if (!settingsCall || typeof settingsCall[1] !== "function") {
			throw new Error("Expected settings shortcut to be registered.");
		}

		act(() => {
			const gitHistoryHandler = gitHistoryCall[1] as () => void;
			const settingsHandler = settingsCall[1] as () => void;
			gitHistoryHandler();
			settingsHandler();
		});

		expect(handleToggleGitHistory).toHaveBeenCalledTimes(1);
		expect(handleOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("closes home git history on Escape", async () => {
		const handleCloseGitHistory = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					canUseTaskSpotlightSearch
					handleToggleTaskSpotlightSearch={() => {}}
					handleOpenSettings={() => {}}
					handleToggleGitHistory={() => {}}
					handleCloseGitHistory={handleCloseGitHistory}
					onRequestStartAllReadyBacklogTasks={() => {}}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const escapeCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "escape");
		if (!escapeCall || typeof escapeCall[1] !== "function") {
			throw new Error("Expected Escape shortcut to be registered.");
		}

		act(() => {
			const escapeHandler = escapeCall[1] as (event: KeyboardEvent) => void;
			escapeHandler(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		});

		expect(handleCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("requests start-all confirmation on Mod+B", async () => {
		const onRequestStartAllReadyBacklogTasks = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen={false}
					canUseCreateTaskShortcut
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					canUseTaskSpotlightSearch
					handleToggleTaskSpotlightSearch={() => {}}
					handleOpenSettings={() => {}}
					handleToggleGitHistory={() => {}}
					handleCloseGitHistory={() => {}}
					onRequestStartAllReadyBacklogTasks={onRequestStartAllReadyBacklogTasks}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const startAllTasksCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+b");
		if (!startAllTasksCall || typeof startAllTasksCall[1] !== "function") {
			throw new Error("Expected start all tasks shortcut to be registered.");
		}

		act(() => {
			const startAllTasksHandler = startAllTasksCall[1] as () => void;
			startAllTasksHandler();
		});

		expect(onRequestStartAllReadyBacklogTasks).toHaveBeenCalledTimes(1);
	});

	it("does not open create task on C when create-task shortcut is disabled", async () => {
		const handleOpenCreateTask = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen={false}
					canUseCreateTaskShortcut={false}
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={handleOpenCreateTask}
					canUseTaskSpotlightSearch={false}
					handleToggleTaskSpotlightSearch={() => {}}
					handleOpenSettings={() => {}}
					handleToggleGitHistory={() => {}}
					handleCloseGitHistory={() => {}}
					onRequestStartAllReadyBacklogTasks={() => {}}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const createTaskCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "c");
		if (!createTaskCall || typeof createTaskCall[1] !== "function") {
			throw new Error("Expected create task shortcut to be registered.");
		}

		act(() => {
			const createTaskHandler = createTaskCall[1] as () => void;
			createTaskHandler();
		});

		expect(handleOpenCreateTask).not.toHaveBeenCalled();
	});

	it("toggles the task spotlight search on Mod+K when enabled", async () => {
		const handleToggleTaskSpotlightSearch = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen={false}
					canUseCreateTaskShortcut
					canUseTaskSpotlightSearch
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					handleToggleTaskSpotlightSearch={handleToggleTaskSpotlightSearch}
					handleOpenSettings={() => {}}
					handleToggleGitHistory={() => {}}
					handleCloseGitHistory={() => {}}
					onRequestStartAllReadyBacklogTasks={() => {}}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const spotlightCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+k");
		if (!spotlightCall || typeof spotlightCall[1] !== "function") {
			throw new Error("Expected task spotlight search shortcut to be registered.");
		}

		act(() => {
			const spotlightHandler = spotlightCall[1] as (event: KeyboardEvent) => void;
			spotlightHandler(new KeyboardEvent("keydown", { cancelable: true }));
		});

		expect(handleToggleTaskSpotlightSearch).toHaveBeenCalledTimes(1);
	});

	it("does not toggle the task spotlight search on Mod+K when disabled", async () => {
		const handleToggleTaskSpotlightSearch = vi.fn();

		await act(async () => {
			root.render(
				<HookHarness
					selectedCard={null}
					isDetailTerminalOpen={false}
					isHomeTerminalOpen={false}
					isHomeGitHistoryOpen={false}
					canUseCreateTaskShortcut
					canUseTaskSpotlightSearch={false}
					handleToggleDetailTerminal={() => {}}
					handleToggleHomeTerminal={() => {}}
					handleToggleExpandDetailTerminal={() => {}}
					handleToggleExpandHomeTerminal={() => {}}
					handleOpenCreateTask={() => {}}
					handleToggleTaskSpotlightSearch={handleToggleTaskSpotlightSearch}
					handleOpenSettings={() => {}}
					handleToggleGitHistory={() => {}}
					handleCloseGitHistory={() => {}}
					onRequestStartAllReadyBacklogTasks={() => {}}
					handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={null}
				/>,
			);
		});

		const spotlightCall = mockUseHotkeys.mock.calls.find(([shortcut]) => shortcut === "mod+k");
		if (!spotlightCall || typeof spotlightCall[1] !== "function") {
			throw new Error("Expected task spotlight search shortcut to be registered.");
		}

		act(() => {
			const spotlightHandler = spotlightCall[1] as (event: KeyboardEvent) => void;
			spotlightHandler(new KeyboardEvent("keydown", { cancelable: true }));
		});

		expect(handleToggleTaskSpotlightSearch).not.toHaveBeenCalled();
	});

	describe("范围切换快捷键", () => {
		beforeEach(() => {
			scopeToggleHotkeyTestEnvironment.isMacPlatform = true;
		});

		async function renderScopeToggleHandler(handler: (() => void) | null): Promise<void> {
			await act(async () => {
				root.render(
					<HookHarness
						selectedCard={null}
						isDetailTerminalOpen={false}
						isHomeTerminalOpen={false}
						isHomeGitHistoryOpen={false}
						canUseCreateTaskShortcut
						canUseTaskSpotlightSearch
						handleToggleDetailTerminal={() => {}}
						handleToggleHomeTerminal={() => {}}
						handleToggleExpandDetailTerminal={() => {}}
						handleToggleExpandHomeTerminal={() => {}}
						handleOpenCreateTask={() => {}}
						handleToggleTaskSpotlightSearch={() => {}}
						handleOpenSettings={() => {}}
						handleToggleGitHistory={() => {}}
						handleCloseGitHistory={() => {}}
						onRequestStartAllReadyBacklogTasks={() => {}}
						handleToggleBetweenBoardScopeAndFocusedTaskProjectScope={handler}
					/>,
				);
			});
		}

		function dispatchScopeToggleKeydown(target: EventTarget, overrides: KeyboardEventInit = {}): KeyboardEvent {
			const event = new KeyboardEvent("keydown", {
				key: "E",
				code: "KeyE",
				metaKey: scopeToggleHotkeyTestEnvironment.isMacPlatform,
				ctrlKey: !scopeToggleHotkeyTestEnvironment.isMacPlatform,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
				...overrides,
			});
			act(() => {
				target.dispatchEvent(event);
			});
			return event;
		}

		it.each([
			{ platform: "macOS", isMacPlatform: true, label: "⌘⇧E" },
			{ platform: "Windows/Linux", isMacPlatform: false, label: "Ctrl+Shift+E" },
		])("$platform：仅接管新组合，捕获后单次切换，放行旧组合和其它修饰键", async ({ isMacPlatform, label }) => {
			scopeToggleHotkeyTestEnvironment.isMacPlatform = isMacPlatform;
			const handler = vi.fn();
			await renderScopeToggleHandler(handler);
			const input = document.createElement("input");
			container.append(input);
			const targetListener = vi.fn();
			input.addEventListener("keydown", targetListener);
			const rejectedCombinations = [
				{ ctrlKey: true, metaKey: false, shiftKey: false },
				{ ctrlKey: false, metaKey: true, shiftKey: false },
				{ ctrlKey: isMacPlatform, metaKey: !isMacPlatform },
				{ ctrlKey: true, metaKey: true },
				{ altKey: true },
				{ code: "KeyF", key: "F" },
			];
			for (const combination of rejectedCombinations) {
				expect(dispatchScopeToggleKeydown(input, combination).defaultPrevented, JSON.stringify(combination)).toBe(
					false,
				);
			}
			expect(targetListener).toHaveBeenCalledTimes(rejectedCombinations.length);
			expect(handler).not.toHaveBeenCalled();
			targetListener.mockClear();
			expect(dispatchScopeToggleKeydown(input).defaultPrevented).toBe(true);
			expect(dispatchScopeToggleKeydown(input, { repeat: true }).defaultPrevented).toBe(true);
			expect(handler).toHaveBeenCalledTimes(1);
			expect(targetListener).not.toHaveBeenCalled();
			expect(formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel()).toBe(label);
			expect(mockUseHotkeys.mock.calls.some(([shortcut]) => shortcut === "mod+e")).toBe(false);
		});

		it("对话框输入保留按键，不切换背后的范围", async () => {
			const handler = vi.fn();
			await renderScopeToggleHandler(handler);
			const dialog = document.createElement("div");
			dialog.setAttribute("role", "dialog");
			const input = document.createElement("input");
			dialog.append(input);
			container.append(dialog);
			expect(dispatchScopeToggleKeydown(input).defaultPrevented).toBe(false);
			expect(handler).not.toHaveBeenCalled();
		});

		it("无项目时放行，回调更新与卸载不残留监听", async () => {
			await renderScopeToggleHandler(null);
			expect(dispatchScopeToggleKeydown(document.body).defaultPrevented).toBe(false);
			const previousHandler = vi.fn();
			await renderScopeToggleHandler(previousHandler);
			const currentHandler = vi.fn();
			await renderScopeToggleHandler(currentHandler);
			dispatchScopeToggleKeydown(document.body);
			expect(previousHandler).not.toHaveBeenCalled();
			expect(currentHandler).toHaveBeenCalledTimes(1);
			await renderScopeToggleHandler(null);
			expect(dispatchScopeToggleKeydown(document.body).defaultPrevented).toBe(false);
			await renderScopeToggleHandler(currentHandler);
			await act(async () => root.render(null));
			expect(dispatchScopeToggleKeydown(document.body).defaultPrevented).toBe(false);
			expect(currentHandler).toHaveBeenCalledTimes(1);
		});

		it("放行输入法组字与已处理的事件", async () => {
			const handler = vi.fn();
			await renderScopeToggleHandler(handler);
			for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
				expect(dispatchScopeToggleKeydown(document.body, composition).defaultPrevented).toBe(false);
			}
			const alreadyHandled = new KeyboardEvent("keydown", {
				code: "KeyE",
				metaKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			alreadyHandled.preventDefault();
			act(() => {
				document.body.dispatchEvent(alreadyHandled);
			});
			expect(handler).not.toHaveBeenCalled();
		});
	});
});
