import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { useAppHotkeys } from "../src/hooks/use-app-hotkeys";
import "@xterm/xterm/css/xterm.css";

const ignoreUnrelatedHotkey = () => {};

// 仅观察生产 hook 与真实 xterm 的输入边界；实际范围切换由已有整应用集成测试负责。
function BoardScopeToggleHotkeyBrowserHarness() {
	const [scopeToggleCount, setScopeToggleCount] = useState(0);
	const [terminalOutboundData, setTerminalOutboundData] = useState("");
	const terminalHost = useRef<HTMLDivElement>(null);

	useAppHotkeys({
		selectedCard: null,
		isDetailTerminalOpen: false,
		isHomeTerminalOpen: false,
		isHomeGitHistoryOpen: false,
		canUseCreateTaskShortcut: false,
		canUseTaskSpotlightSearch: false,
		handleToggleDetailTerminal: ignoreUnrelatedHotkey,
		handleToggleHomeTerminal: ignoreUnrelatedHotkey,
		handleToggleExpandDetailTerminal: ignoreUnrelatedHotkey,
		handleToggleExpandHomeTerminal: ignoreUnrelatedHotkey,
		handleOpenCreateTask: ignoreUnrelatedHotkey,
		handleToggleTaskSpotlightSearch: ignoreUnrelatedHotkey,
		handleOpenSettings: ignoreUnrelatedHotkey,
		handleToggleGitHistory: ignoreUnrelatedHotkey,
		handleCloseGitHistory: ignoreUnrelatedHotkey,
		onRequestStartAllReadyBacklogTasks: ignoreUnrelatedHotkey,
		handleToggleBetweenBoardScopeAndFocusedTaskProjectScope: () => setScopeToggleCount((previous) => previous + 1),
	});

	useEffect(() => {
		if (!terminalHost.current) return;
		const terminal = new Terminal({ cols: 60, rows: 6 });
		terminal.open(terminalHost.current);
		terminal.onData((chunk) => setTerminalOutboundData((previous) => previous + chunk));
		return () => terminal.dispose();
	}, []);

	return (
		<main>
			<output data-testid="scope-toggle-count">{scopeToggleCount}</output>
			<output data-testid="terminal-outbound-data">{JSON.stringify(terminalOutboundData)}</output>
			<textarea aria-label="多行输入框" defaultValue={"first line\nsecond line"} />
			<div ref={terminalHost} />
		</main>
	);
}

const harnessContainer = document.createElement("div");
document.body.append(harnessContainer);
createRoot(harnessContainer).render(<BoardScopeToggleHotkeyBrowserHarness />);
