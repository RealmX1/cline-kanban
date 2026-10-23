import { Terminal } from "@xterm/xterm";
import { createRoot } from "react-dom/client";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import { getTerminalThemeColors } from "@/hooks/use-theme";

const terminalHost = document.createElement("div");
const pillHost = document.createElement("div");
document.body.append(pillHost, terminalHost);
const root = createRoot(pillHost);
const terminal = new Terminal({
	...createKanbanTerminalOptions({
		cursorColor: "white",
		isMacPlatform: false,
		terminalBackgroundColor: "black",
		themeColors: getTerminalThemeColors(),
	}),
	cols: 90,
	rows: 14,
});
terminal.open(terminalHost);
declare global {
	interface Window {
		kimiTerminalRedrawHarness: {
			write(text: string): Promise<void>;
			restore(text: string): Promise<void>;
			readText(): string;
			renderAcceptance(summary: RuntimeTaskSessionSummary): void;
		};
	}
}
window.kimiTerminalRedrawHarness = {
	write: (text) => new Promise<void>((resolveWritten) => terminal.write(text, resolveWritten)),
	restore(text) {
		terminal.reset();
		return this.write(text);
	},
	readText() {
		const lines: string[] = [];
		for (let index = 0; index < terminal.buffer.active.length; index += 1)
			lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? "");
		return lines.join("\n");
	},
	renderAcceptance(summary) {
		root.render(
			<TooltipProvider>
				<TaskActivityElapsedTimePills
					task={{
						createdAt: summary.startedAt ?? 1,
						agentConversationPromptSubmissionAcceptance: summary.agentConversationPromptSubmissionAcceptance,
						lastEffectiveAgentConversationActivityObservation:
							summary.lastEffectiveAgentConversationActivityObservation,
					}}
					nowMs={Date.now()}
				/>
			</TooltipProvider>,
		);
	},
};
