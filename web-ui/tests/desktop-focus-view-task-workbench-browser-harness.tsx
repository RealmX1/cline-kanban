import { Terminal } from "@xterm/xterm";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { LayoutCustomizationsProvider, useLayoutCustomizations } from "../src/resize/layout-customizations";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

const terminals: Terminal[] = [];
const openTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent) { openTerminal.call(this, parent); terminals.push(this); };
Object.assign(window, {readWorkbenchTerminalCount: () => terminals.length, readWorkbenchTerminalColumns: () => terminals[0]?.cols});
const card: BoardCard = {id: "workbench-test-task", title: "任务工作台布局验证", prompt: "隔离浏览器验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: Date.now(), updatedAt: 1};
const column = {id: "in_progress" as const, title: "In Progress", cards: [card]};
const selection: CardSelection = {card, column, allColumns: [column]};
const summary: RuntimeTaskSessionSummary = {taskId: card.id, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null, workspacePath: "/isolated/workbench", pid: 1, startedAt: Date.now(), updatedAt: Date.now(), lastOutputAt: Date.now(), reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null, latestTurnCheckpoint: null, previousTurnCheckpoint: null};
setTaskWorkspaceSnapshot({taskId: card.id, path: "/isolated/workbench", changedFiles: 0, additions: 0, deletions: 0, commitsAheadOfBaseRef: 0, commitsBehindBaseRef: 0});
function Harness() {
	const [changesOpen, setChangesOpen] = useState(false);
	const {resetLayoutCustomizations} = useLayoutCustomizations();
	return <div className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
		<header className="flex h-10 shrink-0 gap-3 px-3"><button type="button" onClick={() => setChangesOpen((value) => !value)}>Changes</button><button type="button" onClick={resetLayoutCustomizations}>重置布局</button></header>
		<CardDetailView selection={selection} currentProjectId="isolated-workbench" workspacePath="/isolated/workbench" selectedAgentId="codex" sessionSummary={summary} taskSessions={{[card.id]: summary}} onSessionSummary={() => {}} onCardSelect={() => {}} onTaskDragEnd={() => {}} onMoveToTrash={() => {}} bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}} isTaskChangesSidebarOpen={changesOpen} onCreateTaskConversationSession={async () => ({ok: false, message: "隔离环境：创建失败后保留草稿"})} explorationThreadGraph={{queryPhase: "ready", view: null, turnSourceUnavailableSessionIds: []}} />
	</div>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<TooltipProvider><LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}><TaskCommentsDialogProvider currentWorkspaceId="isolated-workbench"><Harness /></TaskCommentsDialogProvider></LayoutCustomizationsProvider></TooltipProvider>);
