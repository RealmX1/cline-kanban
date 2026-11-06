import { SideSessionCreationWorkbench } from "../src/components/side-session-creation-workbench";
import { NonModalFloatingFormWindowHostProvider } from "../src/components/non-modal-floating-form-window-host-provider";
import { replaceTaskResourceUsageSnapshots } from "../src/stores/task-resource-usage-snapshot-store";
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
const scenario = new URLSearchParams(location.search);
const actionInvocations: string[] = [];
Object.assign(window, {readTaskActionInvocations: () => actionInvocations});
const card: BoardCard = {id: "workbench-test-task", title: "任务工作台布局验证", prompt: "隔离浏览器验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: Date.now(), updatedAt: 1};
const stage = scenario.get("column");
const columnId = stage === "review" || stage === "validation" || stage === "trash" ? stage : "in_progress";
if (scenario.has("auto_review")) { card.autoReviewEnabled = true; card.autoReviewMode = "commit"; }
if (scenario.has("shelved")) card.taskShelvingState = {isShelved: true, lastChangedAt: 1};
const column = {id: columnId, title: columnId, cards: [card]};
Object.assign(window, {readWorkbenchTaskCard: () => card});
if (scenario.has("stage_headers")) card.pinnedToTaskPinboardAt = 1;
const stageIds: CardSelection["column"]["id"][] = ["backlog", "in_progress", "review", "validation", "trash"];
const allColumns = scenario.has("stage_headers") ? stageIds.map((id) => ({
    id,
    title: id === "in_progress" ? "In Progress" : id === "trash" ? "Done" : id[0]!.toUpperCase() + id.slice(1),
    cards: id === columnId ? [card, {...card, id: `${id}-sample-1`, pinnedToTaskPinboardAt: undefined}] : [0,1].map((index) => ({...card, id: `${id}-sample-${index}`, pinnedToTaskPinboardAt: undefined})),
})) : [column];
const selection: CardSelection = {card, column: allColumns.find((entry) => entry.id === columnId)!, allColumns};
const summary: RuntimeTaskSessionSummary = {taskId: card.id, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null, workspacePath: "/isolated/workbench", pid: 1, startedAt: Date.now(), updatedAt: Date.now(), lastOutputAt: Date.now(), reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null, latestTurnCheckpoint: null, previousTurnCheckpoint: null};
if (scenario.has("acp")) { card.agentId = "omp"; summary.agentId = "omp"; summary.sessionTransport = "acp_stdio_subprocess"; }
if (scenario.has("compact")) {
    summary.agentCurrentWorkPhaseGoal = {goalText: "验证长阶段目标在单行中截断，并在详情中保留全部内容，浮层不得改变终端的实际高度。", source: "agent_explicit_declaration", updatedAt: Date.now(), owningKanbanTaskConversationSessionId: card.id, owningNativeConversationSessionId: null};
    replaceTaskResourceUsageSnapshots([{workspaceId: "isolated-workbench", attributedTaskCardId: card.id, sampledAtEpochMs: Date.now(), attributedProcessCount: 3, residentSetSizeKibibytesSumUpperBound: 300000, cpuPercentOfOneCoreOverLastSampleInterval: 12, agentHarnessRootPhysicalFootprintBytes: null, survivedSessionRootExitProcessCount: 1, survivedSessionRootExitResidentSetSizeKibibytesSum: 1024, processCountByProcessClassification: {agent_harness_root_process: 1}, residentSetSizeKibibytesSumUpperBoundByProcessClassification: {agent_harness_root_process: 300000}, mcpServerInstances: []}]);
}
const sideSummary: RuntimeTaskSessionSummary = {...summary, taskId: "workbench-side-session", taskConversationSessionMetadata: {workspaceTaskId: card.id, taskConversationSessionRole: "by_the_way", taskConversationSessionContextSource: "started_from_scratch", parentTaskConversationSessionId: null, mainSessionOriginTurnNumber: 1, mainSessionOriginUserMessagePreview: card.prompt, latestUserMessagePreview: "侧会话验证"}};
setTaskWorkspaceSnapshot({taskId: card.id, path: "/isolated/workbench", changedFiles: columnId === "review" ? 1 : 0, additions: 0, deletions: 0, commitsAheadOfBaseRef: 0, commitsBehindBaseRef: 0});
function Harness() {
	const [changesOpen, setChangesOpen] = useState(false);
	const {resetLayoutCustomizations} = useLayoutCustomizations();
	return <div className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
		<header className="flex h-10 shrink-0 gap-3 px-3"><button type="button" onClick={() => setChangesOpen((value) => !value)}>Changes</button><button type="button" onClick={resetLayoutCustomizations}>重置布局</button></header>
		<CardDetailView onBackToBoard={scenario.has("back_to_board") ? () => actionInvocations.push("back") : undefined} onCancelAutomaticTaskAction={scenario.has("auto_review") ? () => actionInvocations.push("cancel-automatic") : undefined} onRequestStartAllReadyBacklogTasks={() => actionInvocations.push("start-backlog")} onRestoreTaskFromTrash={(taskId) => actionInvocations.push(`restore:${taskId}`)} onClearTrash={() => actionInvocations.push("clear-done")} selection={selection} currentProjectId="isolated-workbench" workspacePath="/isolated/workbench" selectedAgentId="codex" sessionSummary={summary} taskSessions={{[card.id]: summary, ...(scenario.has("side") ? {[sideSummary.taskId]: sideSummary} : {})}} onSessionSummary={() => {}} onCardSelect={() => {}} onTaskDragEnd={() => {}} onMoveToTrash={() => actionInvocations.push("done")} onMoveToValidation={() => actionInvocations.push("validation")} onAgentCommitTask={() => actionInvocations.push("commit")} onAgentOpenPrTask={() => actionInvocations.push("pr")} bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}} isTaskChangesSidebarOpen={changesOpen} onCreateTaskConversationSession={async () => ({ok: false, message: "隔离环境：创建失败后保留草稿"})} explorationThreadGraph={{queryPhase: "ready", view: null, turnSourceUnavailableSessionIds: []}} />
	</div>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<TooltipProvider><NonModalFloatingFormWindowHostProvider><LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}><TaskCommentsDialogProvider currentWorkspaceId="isolated-workbench"><Harness /><SideSessionCreationWorkbench /></TaskCommentsDialogProvider></LayoutCustomizationsProvider></NonModalFloatingFormWindowHostProvider></TooltipProvider>);
