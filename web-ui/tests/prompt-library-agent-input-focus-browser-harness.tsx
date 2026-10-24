import { Terminal } from "@xterm/xterm";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { LayoutCustomizationsProvider } from "../src/resize/layout-customizations";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { getTerminalController } from "../src/terminal/terminal-controller-registry";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

const terminalInputFrames: string[] = [];
const sentConversationMessages: string[] = [];
const originalTerminalOpen = Terminal.prototype.open;
Terminal.prototype.open = function (parent) {
	originalTerminalOpen.call(this, parent);
	this.onData((text) => terminalInputFrames.push(text));
};
Object.assign(window, {
	readShortcutInputFocusObservations: () => ({ terminalInputFrames, sentConversationMessages }),
});

const usesConversationComposer = new URLSearchParams(window.location.search).get("transport") === "acp";
const card: BoardCard = {
	id: "shortcut-focus-task",
	title: "快捷输入焦点验证",
	prompt: "隔离浏览器验证",
	agentId: "omp",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};
const column = { id: "in_progress" as const, title: "In Progress", cards: [card] };
const selection: CardSelection = { card, column, allColumns: [column] };
const summary: RuntimeTaskSessionSummary = {
	taskId: card.id,
	agentId: "omp",
	sessionTransport: usesConversationComposer ? "acp_stdio_subprocess" : "pty_terminal",
	state: "awaiting_review",
	turnOwner: "user",
	liveness: "live",
	userTurnKind: "review",
	workspacePath: "/isolated/shortcut-input-focus",
	pid: 1,
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: 1,
	reviewReason: null,
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
	latestTurnCheckpoint: null,
	previousTurnCheckpoint: null,
};

createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider>
		<LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}>
			<TaskCommentsDialogProvider currentWorkspaceId="isolated-shortcut-input-focus">
				<div className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
					<CardDetailView
						selection={selection}
						currentProjectId="isolated-shortcut-input-focus"
						workspacePath="/isolated/shortcut-input-focus"
						selectedAgentId="omp"
						sessionSummary={summary}
						taskSessions={{ [card.id]: summary }}
						onSessionSummary={() => {}}
						onCardSelect={() => {}}
						onTaskDragEnd={() => {}}
						onMoveToTrash={() => {}}
						onAddReviewComments={(taskId, text) => {
							getTerminalController(taskId)?.paste(text);
						}}
						onSendClineChatMessage={async (_taskId, text) => {
							sentConversationMessages.push(text);
							return { ok: true };
						}}
						onLoadClineChatMessages={async () => []}
						bottomTerminalOpen={false}
						bottomTerminalTaskId={null}
						bottomTerminalSummary={null}
						onBottomTerminalClose={() => {}}
						explorationThreadGraph={{ queryPhase: "ready", view: null, turnSourceUnavailableSessionIds: [] }}
					/>
					<button type="button">焦点保护验证按钮</button>
				</div>
			</TaskCommentsDialogProvider>
		</LayoutCustomizationsProvider>
	</TooltipProvider>,
);
