import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTerminalPanel } from "../src/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import "../src/styles/globals.css";

function Harness() {
	const [isActiveTurn, setIsActiveTurn] = useState(false);
	const summary: RuntimeTaskSessionSummary = {
		taskId: "isolated-restart-arguments", agentId: "codex", sessionTransport: "pty_terminal",
		state: isActiveTurn ? "running" : "idle", turnOwner: isActiveTurn ? "agent" : null, liveness: "live", userTurnKind: null,
		workspacePath: "/isolated/restart", pid: 12, startedAt: 1, updatedAt: 1, lastOutputAt: 1, reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null,
	};
	return <TooltipProvider><main className="mx-auto mt-20 h-96 max-w-3xl px-3 text-text-primary">
		<button type="button" onClick={() => setIsActiveTurn((current) => !current)}>切换活跃回合</button>
		<AgentTerminalPanel taskId={summary.taskId} workspaceId="isolated-restart-arguments" summary={summary} showSessionToolbar={!new URLSearchParams(location.search).has("compact")} minimalHeaderTitle="隔离 Codex 终端" />
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
