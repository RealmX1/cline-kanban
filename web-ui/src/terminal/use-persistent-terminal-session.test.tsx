import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTerminalThemeColors, saveThemeId } from "@/hooks/use-theme";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { usePersistentTerminalSession } from "@/terminal/use-persistent-terminal-session";

const ensurePersistentTerminalMock = vi.hoisted(() => vi.fn());
const disposePersistentTerminalMock = vi.hoisted(() => vi.fn());
const registerTerminalControllerMock = vi.hoisted(() => vi.fn());

interface TestPersistentTerminalSubscriber {
	onSearchOpenRequested?: () => void;
	onSearchResults?: (results: { resultCount: number; resultIndex: number }) => void;
}

vi.mock("@/terminal/persistent-terminal-manager", () => ({
	ensurePersistentTerminal: ensurePersistentTerminalMock,
	disposePersistentTerminal: disposePersistentTerminalMock,
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	registerTerminalController: registerTerminalControllerMock,
}));

function createPersistentTerminalMock() {
	return {
		subscribe: vi.fn((_subscriber: TestPersistentTerminalSubscriber) => vi.fn()),
		mount: vi.fn(),
		unmount: vi.fn(),
		reset: vi.fn(),
		input: vi.fn(() => true),
		paste: vi.fn(() => true),
		waitForLikelyPrompt: vi.fn(async () => true),
		clear: vi.fn(),
		clearSearch: vi.fn(),
		focus: vi.fn(),
		searchNext: vi.fn(() => true),
		searchPrevious: vi.fn(() => true),
		stop: vi.fn(async () => {}),
	};
}

function HookHarness({
	taskId,
	workspaceId,
	sessionStartedAt,
	enabled = true,
	onSummary,
	onConnectionReady,
}: {
	taskId: string;
	workspaceId: string | null;
	sessionStartedAt: number | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
}) {
	const {
		containerRef,
		closeTerminalSearch,
		findNextInTerminal,
		findPreviousInTerminal,
		isSearchOpen,
		searchResults,
	} = usePersistentTerminalSession({
		taskId,
		workspaceId,
		enabled,
		onSummary,
		onConnectionReady,
		sessionStartedAt,
		terminalBackgroundColor: "terminal-background",
		cursorColor: "cursor-color",
	});

	return (
		<div
			ref={containerRef}
			data-search-open={String(isSearchOpen)}
			data-search-result-count={String(searchResults.resultCount)}
			data-search-result-index={String(searchResults.resultIndex)}
		>
			<button type="button" onClick={() => closeTerminalSearch()}>
				close
			</button>
			<button type="button" onClick={() => findNextInTerminal("needle", { caseSensitive: true })}>
				next
			</button>
			<button type="button" onClick={() => findPreviousInTerminal("needle")}>
				previous
			</button>
		</div>
	);
}

describe("usePersistentTerminalSession", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		ensurePersistentTerminalMock.mockReset();
		disposePersistentTerminalMock.mockReset();
		registerTerminalControllerMock.mockReset();
		registerTerminalControllerMock.mockReturnValue(() => {});
		ensurePersistentTerminalMock.mockImplementation(() => createPersistentTerminalMock());
		window.localStorage.clear();
		saveThemeId("default");
		document.documentElement.removeAttribute("data-theme");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		window.localStorage.clear();
		saveThemeId("default");
		document.documentElement.removeAttribute("data-theme");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("resets the persistent terminal in place when a new session starts for the same task", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		expect(disposePersistentTerminalMock).not.toHaveBeenCalled();
		expect(ensurePersistentTerminalMock).toHaveBeenCalledTimes(1);
		expect(terminal.reset).not.toHaveBeenCalled();

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={200} />);
		});

		expect(disposePersistentTerminalMock).not.toHaveBeenCalled();
		expect(terminal.reset).toHaveBeenCalledTimes(1);
		expect(ensurePersistentTerminalMock).toHaveBeenCalledTimes(2);
	});

	it("clears terminal search when a new session starts for the same task", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		const harness = container.querySelector("[data-search-open]");
		const subscriber = terminal.subscribe.mock.calls[0]?.[0];
		await act(async () => {
			subscriber?.onSearchOpenRequested?.();
			subscriber?.onSearchResults?.({ resultCount: 3, resultIndex: 1 });
		});

		expect(harness?.getAttribute("data-search-open")).toBe("true");
		expect(harness?.getAttribute("data-search-result-count")).toBe("3");

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={200} />);
		});

		expect(terminal.clearSearch).toHaveBeenCalledTimes(1);
		expect(terminal.reset).toHaveBeenCalledTimes(1);
		expect(harness?.getAttribute("data-search-open")).toBe("false");
		expect(harness?.getAttribute("data-search-result-count")).toBe("0");
		expect(harness?.getAttribute("data-search-result-index")).toBe("-1");
	});

	it("does not dispose when the selected task changes", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		await act(async () => {
			root.render(<HookHarness taskId="task-b" workspaceId="project-1" sessionStartedAt={200} />);
		});

		expect(disposePersistentTerminalMock).not.toHaveBeenCalled();
		expect(ensurePersistentTerminalMock).toHaveBeenCalledTimes(2);
	});

	it("clears parked terminal search when the selected task changes", async () => {
		const firstTerminal = createPersistentTerminalMock();
		const secondTerminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValueOnce(firstTerminal).mockReturnValueOnce(secondTerminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		const harness = container.querySelector("[data-search-open]");
		const subscriber = firstTerminal.subscribe.mock.calls[0]?.[0];
		await act(async () => {
			subscriber?.onSearchOpenRequested?.();
			subscriber?.onSearchResults?.({ resultCount: 7, resultIndex: 4 });
		});

		expect(harness?.getAttribute("data-search-open")).toBe("true");
		expect(harness?.getAttribute("data-search-result-count")).toBe("7");

		await act(async () => {
			root.render(<HookHarness taskId="task-b" workspaceId="project-1" sessionStartedAt={200} />);
		});

		expect(firstTerminal.clearSearch).toHaveBeenCalledTimes(1);
		expect(secondTerminal.clearSearch).not.toHaveBeenCalled();
		expect(harness?.getAttribute("data-search-open")).toBe("false");
		expect(harness?.getAttribute("data-search-result-count")).toBe("0");
		expect(harness?.getAttribute("data-search-result-index")).toBe("-1");
	});

	it("disposes terminal when disabled", async () => {
		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} enabled />);
		});

		disposePersistentTerminalMock.mockClear();

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} enabled={false} />);
		});

		expect(disposePersistentTerminalMock).toHaveBeenCalledTimes(1);
		expect(disposePersistentTerminalMock).toHaveBeenCalledWith("project-1", "task-a");
	});

	it("does not remount when callback props change", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					workspaceId="project-1"
					sessionStartedAt={100}
					onSummary={() => {}}
					onConnectionReady={() => {}}
				/>,
			);
		});

		expect(terminal.mount).toHaveBeenCalledTimes(1);
		expect(terminal.unmount).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					taskId="task-a"
					workspaceId="project-1"
					sessionStartedAt={100}
					onSummary={() => {}}
					onConnectionReady={() => {}}
				/>,
			);
		});

		expect(terminal.mount).toHaveBeenCalledTimes(1);
		expect(terminal.unmount).not.toHaveBeenCalled();
	});

	it("updates terminal appearance when the active theme changes", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		expect(ensurePersistentTerminalMock).toHaveBeenCalledWith(
			expect.objectContaining({
				themeColors: getTerminalThemeColors("default"),
			}),
		);

		await act(async () => {
			saveThemeId("graphite");
		});

		expect(ensurePersistentTerminalMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				themeColors: getTerminalThemeColors("graphite"),
			}),
		);
	});

	it("opens terminal search and tracks result updates from the persistent terminal", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		const harness = container.querySelector("[data-search-open]");
		expect(harness?.getAttribute("data-search-open")).toBe("false");

		const subscriber = terminal.subscribe.mock.calls[0]?.[0];
		await act(async () => {
			subscriber?.onSearchOpenRequested?.();
			subscriber?.onSearchResults?.({ resultCount: 5, resultIndex: 2 });
		});

		expect(harness?.getAttribute("data-search-open")).toBe("true");
		expect(harness?.getAttribute("data-search-result-count")).toBe("5");
		expect(harness?.getAttribute("data-search-result-index")).toBe("2");
	});

	it("forwards search actions to the persistent terminal and clears search on close", async () => {
		const terminal = createPersistentTerminalMock();
		ensurePersistentTerminalMock.mockReturnValue(terminal);

		await act(async () => {
			root.render(<HookHarness taskId="task-a" workspaceId="project-1" sessionStartedAt={100} />);
		});

		const nextButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "next",
		);
		const previousButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "previous",
		);
		const closeButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "close",
		);

		await act(async () => {
			nextButton?.click();
			previousButton?.click();
			closeButton?.click();
		});

		expect(terminal.searchNext).toHaveBeenCalledWith("needle", { caseSensitive: true });
		expect(terminal.searchPrevious).toHaveBeenCalledWith("needle", undefined);
		expect(terminal.clearSearch).toHaveBeenCalledTimes(1);
		expect(terminal.focus).toHaveBeenCalledTimes(1);
	});
});
