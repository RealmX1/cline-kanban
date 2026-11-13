import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { AgentTerminalPanel } from "../src/components/detail-panels/agent-terminal-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import "../src/styles/globals.css";

function Harness() {
	const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
	const parameters = new URLSearchParams(location.search);
	const focus = parameters.has("focus");
	const summary: RuntimeTaskSessionSummary = {
		taskId: "isolated-collaborator", agentId: "codex", sessionTransport: "pty_terminal", state: "awaiting_review",
		turnOwner: "user", liveness: "live", userTurnKind: "review", runtimeSessionIncarnationId: "281fd234-c6df-4563-ae2b-c9b2e33541f1",
		workspacePath: "/isolated/plan-mode", pid: 12, startedAt: 1, updatedAt: 1, lastOutputAt: 1, reviewReason: "hook", exitCode: null, lastHookAt: null, latestHookActivity: null,
		agentNativeConversationSessionIdentity: { sourceAgentId: "codex", nativeSessionId: "isolated-native-session", transcriptPath: null, observedAt: 1 },
		codexNativeSessionControlEndpoint: { socketPath: "/isolated/control.sock", workspaceId: "isolated-workspace", conversationSessionId: "isolated-collaborator", runtimeSessionIncarnationId: "281fd234-c6df-4563-ae2b-c9b2e33541f1" },
	};
	return <TooltipProvider><main className="mx-auto mt-16 h-96 max-w-3xl px-3 text-text-primary">
		<header ref={setToolbarHost} className="flex h-11 items-center justify-end" />
		<AgentTerminalPanel taskId={summary.taskId} workspaceId="isolated-workspace" summary={summary}
			showSessionToolbar={!focus} headerInformationContent={focus ? <span>隔离侧会话</span> : undefined}
			mobileHeaderToolbarElement={toolbarHost} minimalHeaderTitle="隔离 Codex 终端" />
		<Toaster theme="dark" />
	</main></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
