import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useShortcutActions } from "@/hooks/use-shortcut-actions";

const fetchRuntimeConfigMock = vi.hoisted(() => vi.fn());
const saveRuntimeConfigMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const waitForTerminalLikelyPromptMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	saveRuntimeConfig: saveRuntimeConfigMock,
	fetchRuntimeConfig: fetchRuntimeConfigMock,
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/terminal/terminal-controller-registry", () => ({
	waitForTerminalLikelyPrompt: waitForTerminalLikelyPromptMock,
}));

interface HookSnapshot {
	handleRunShortcut: ReturnType<typeof useShortcutActions>["handleRunShortcut"];
	handleCreateShortcut: ReturnType<typeof useShortcutActions>["handleCreateShortcut"];
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	onSnapshot,
	prepareTerminalForShortcut,
	sendTaskSessionInput,
	currentProjectId = "project-1",
	selectedShortcutLabel = "Ship",
	shortcuts = [{ label: "Ship", command: "npm run ship" }],
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	prepareTerminalForShortcut: Parameters<typeof useShortcutActions>[0]["prepareTerminalForShortcut"];
	sendTaskSessionInput: Parameters<typeof useShortcutActions>[0]["sendTaskSessionInput"];
	currentProjectId?: string | null;
	selectedShortcutLabel?: string | null | undefined;
	shortcuts?: Parameters<typeof useShortcutActions>[0]["shortcuts"];
}): null {
	const shortcutActions = useShortcutActions({
		currentProjectId,
		selectedShortcutLabel,
		shortcuts,
		refreshRuntimeProjectConfig: () => {},
		prepareTerminalForShortcut,
		prepareWaitForTerminalConnectionReady: () => async () => {},
		sendTaskSessionInput,
	});

	useEffect(() => {
		onSnapshot({
			handleRunShortcut: shortcutActions.handleRunShortcut,
			handleCreateShortcut: shortcutActions.handleCreateShortcut,
		});
	}, [onSnapshot, shortcutActions.handleCreateShortcut, shortcutActions.handleRunShortcut]);

	return null;
}

describe("useShortcutActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchRuntimeConfigMock.mockReset().mockResolvedValue({ shortcuts: [] });
		saveRuntimeConfigMock.mockReset();
		showAppToastMock.mockReset();
		waitForTerminalLikelyPromptMock.mockReset();
		waitForTerminalLikelyPromptMock.mockResolvedValue(true);
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("interrupts reused terminals before sending the shortcut command", async () => {
		const prepareTerminalForShortcut = vi.fn(async () => ({
			hadExistingOpenTerminal: true,
			ok: true,
			targetTaskId: "__home_terminal__",
		}));
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).handleRunShortcut("Ship");
		});

		expect(waitForTerminalLikelyPromptMock).toHaveBeenCalledWith("__home_terminal__", 3000);
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(1, "__home_terminal__", "\u0003", {
			appendNewline: false,
		});
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "__home_terminal__", "npm run ship", {
			appendNewline: true,
		});
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("跨项目导航后仍保存到原项目，并保留打开浮窗后新增的快捷方式", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const prepareTerminalForShortcut = vi.fn(async () => ({ ok: true }));
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const onSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};
		await act(async () =>
			root.render(
				<HookHarness
					currentProjectId="project-a"
					shortcuts={[]}
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={onSnapshot}
				/>,
			),
		);
		const saveFromOriginalWindow = requireSnapshot(latestSnapshot).handleCreateShortcut;
		await act(async () =>
			root.render(
				<HookHarness
					currentProjectId="project-b"
					shortcuts={[]}
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={onSnapshot}
				/>,
			),
		);
		fetchRuntimeConfigMock.mockResolvedValue({ shortcuts: [{ label: "Run", command: "npm run build" }] });
		await act(async () => {
			await saveFromOriginalWindow({ label: "Run", command: "npm run dev" });
		});
		expect(fetchRuntimeConfigMock).toHaveBeenCalledWith("project-a");
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-a", {
			shortcuts: [
				{ label: "Run", command: "npm run build" },
				{ label: "Run 2", command: "npm run dev", icon: undefined },
			],
			selectedShortcutLabel: "Run 2",
		});
	});

	it("waits for a prompt without interrupting when it just opened the terminal", async () => {
		const prepareTerminalForShortcut = vi.fn(async () => ({
			hadExistingOpenTerminal: false,
			ok: true,
			targetTaskId: "__home_terminal__",
		}));
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).handleRunShortcut("Ship");
		});

		expect(waitForTerminalLikelyPromptMock).toHaveBeenCalledWith("__home_terminal__", 3000);
		expect(sendTaskSessionInput).toHaveBeenCalledTimes(1);
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(1, "__home_terminal__", "npm run ship", {
			appendNewline: true,
		});
	});

	it("saves a created shortcut and selects it", async () => {
		saveRuntimeConfigMock.mockResolvedValue({
			selectedShortcutLabel: "Run",
			shortcuts: [{ label: "Run", command: "npm run dev", icon: "play" }],
		});
		const prepareTerminalForShortcut = vi.fn(async () => ({
			hadExistingOpenTerminal: true,
			ok: true,
			targetTaskId: "__home_terminal__",
		}));
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					sendTaskSessionInput={sendTaskSessionInput}
					currentProjectId="project-1"
					selectedShortcutLabel={null}
					shortcuts={[]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).handleCreateShortcut({
				label: "Run",
				command: "npm run dev",
				icon: "play",
			});
		});

		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-1", {
			shortcuts: [{ label: "Run", command: "npm run dev", icon: "play" }],
			selectedShortcutLabel: "Run",
		});
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
