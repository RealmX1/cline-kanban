import { Terminal } from "@xterm/xterm";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import "@/styles/globals.css";

let terminal: Terminal | null = null;
const root = createRoot(document.body.appendChild(document.createElement("div")));

function NativeTranscriptReaderBrowserHarness({ workspaceId, summary }: { workspaceId: string; summary: RuntimeTaskSessionSummary }) {
	useEffect(() => {
		const container = document.querySelector<HTMLElement>(".kb-terminal-container");
		if (!container) throw new Error("缺少终端容器");
		terminal = new Terminal({ cols: 60, rows: 12, scrollback: 20 });
		terminal.open(container);
		terminal.write("终端旧画面\r\n\u001b[?1049h\u001b[2J\u001b[H全屏终端当前画面");
		return () => { terminal?.dispose(); terminal = null; };
	}, []);
	return <TooltipProvider><div className="flex h-dvh min-h-0 flex-col">
		<AgentTerminalPanel workspaceId={workspaceId} taskId={summary.taskId} summary={summary} terminalEnabled={false} />
	</div></TooltipProvider>;
}

declare global {
	interface Window {
		nativeTranscriptReaderBrowserHarness: {
			mount(workspaceId: string, summary: RuntimeTaskSessionSummary): void;
			disconnectTerminal(): void;
			readTerminalScreen(): string;
		};
	}
}
window.nativeTranscriptReaderBrowserHarness = {
	mount(workspaceId, summary) {
		startLoadingUserInterfacePreferencesSharedAcrossBrowserOrigins();
		root.render(<NativeTranscriptReaderBrowserHarness workspaceId={workspaceId} summary={summary} />);
	},
	disconnectTerminal() { terminal?.dispose(); terminal = null; },
	readTerminalScreen() {
		if (!terminal) return "";
		return Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal?.buffer.active.getLine(index)?.translateToString(true) ?? "").join("\n");
	},
};
