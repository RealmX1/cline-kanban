import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHotkeys } from "react-hotkeys-hook";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppHotkeys } from "@/hooks/use-app-hotkeys";

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: vi.fn(),
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
});
