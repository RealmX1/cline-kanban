import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { FocusViewCrossProjectTaskOpenInTransitShell } from "../src/components/detail-panels/focus-view-cross-project-task-open-in-transit-shell";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useAllProjectsFocusViewAdjacentTaskKeyboardNavigation } from "../src/hooks/use-all-projects-focus-view-adjacent-task-keyboard-navigation";
import { useCrossProjectRecentlyActiveTaskSwitcherHost } from "../src/hooks/use-cross-project-recently-active-task-switcher-host";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useCrossProjectTaskOpenInProject } from "../src/hooks/use-cross-project-task-open-in-project";
import { LayoutCustomizationsProvider } from "../src/resize/layout-customizations";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary, RuntimeTaskSessionSummary } from "../src/runtime/types";
import { findCardSelection } from "../src/state/board-state";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const now = Date.now();
function taskCard(id: string, title: string): BoardCard {
	return { id, title, prompt: "隔离浏览器任务导航验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: now, updatedAt: now };
}
const first = taskCard("same", "项目 A 首项");
const second = taskCard("same", "项目 B 同号次项");
const third = taskCard("third", "项目 A 末项");
const boards = { a: createInitialBoardData(), b: createInitialBoardData() };
// 特意让当前项目 stage 顺序与跨项目左栏不同，旧快捷键会直接跳到 third。
boards.a.columns.find((column) => column.id === "review")!.cards = [third, first];
boards.b.columns.find((column) => column.id === "review")!.cards = [second];
function entry(card: BoardCard, touchedAt: number): RuntimeCrossProjectTaskSwitcherEntry {
	return { taskId: card.id, title: card.title, agentId: "codex", columnId: "review", createdAt: now,
		turnOwner: null, liveness: "none", userTurnKind: null, lastOutputAt: null, lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null, lastConversationProgressObservation: null,
		taskDescriptionLastUpdatedAt: touchedAt, lastOpenedByUserAt: null, pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null, isParkedAwaitingDispatchedBackgroundWork: false };
}
function project(id: string, entries: RuntimeCrossProjectTaskSwitcherEntry[]): RuntimeProjectSummary {
	return { id, name: id, path: `/isolated/${id}`, availability: { status: "available" },
		taskCounts: { backlog: 0, in_progress: 0, review: entries.length, validation: 0, trash: 0 },
		inProgressTaskDetails: [], crossProjectTaskSwitcherEntries: entries };
}
for (const card of [first, third]) setTaskWorkspaceSnapshot({ taskId: card.id, path: `/isolated/a/${card.id}`, changedFiles: 0, additions: 0, deletions: 0 });
function summary(taskId: string, workspaceId: string): RuntimeTaskSessionSummary {
	return { taskId, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null,
		workspacePath: `/isolated/${workspaceId}/${taskId}`, pid: 1, startedAt: now, updatedAt: now, lastOutputAt: now,
		reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null, latestTurnCheckpoint: null, previousTurnCheckpoint: null };
}

function Harness() {
	const [currentProjectId, setCurrentProjectId] = useState("a");
	const [hydratedProjectId, setHydratedProjectId] = useState("a");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>("same");
	const [isAllProjects, setIsAllProjects] = useState(true);
	const [legacySelectionCount, setLegacySelectionCount] = useState(0);
	const [navigationCalls, setNavigationCalls] = useState<string[]>([]);
	const [projects, setProjects] = useState(() => [project("a", [entry(first, now - 1_000), entry(third, now - 3_000)]), project("b", [entry(second, now - 2_000)])]);
	const board = boards[hydratedProjectId as keyof typeof boards];
	const taskOpening = useCrossProjectTaskOpenInProject({
		board, currentProjectId, projectIdOwningHydratedBoard: hydratedProjectId, selectedTaskId,
		isDetailViewOpen: selectedTaskId !== null, isCurrentProjectBoardSettled: currentProjectId === hydratedProjectId,
		setSelectedTaskId, handleSelectProject: setCurrentProjectId, openBacklogTaskEditor: () => {},
	});
	const onOpenTaskInProject = useCallback((workspaceId: string, taskId: string) => {
		setNavigationCalls((previous) => [...previous, `${workspaceId}:${taskId}`]);
		taskOpening.handleOpenTaskInProject(workspaceId, taskId);
	}, [taskOpening.handleOpenTaskInProject]);
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({ projects, currentProjectId, notificationLogByWorkspaceId: {} });
	const { crossProjectRecentlyActiveTaskSwitcherHost: host, isFocusViewCrossProjectTaskOpenInTransit } = useCrossProjectRecentlyActiveTaskSwitcherHost({
		crossProjectTaskSwitcherSectionsModel: sectionsModel, projects, notificationLogByWorkspaceId: {}, currentProjectId,
		isBoardScopeAllProjectsSelected: isAllProjects, selectedCardTaskId: selectedTaskId, pendingCrossProjectTaskOpen: taskOpening.pendingCrossProjectTaskOpen,
		onOpenTaskInProject, onOpenBacklogTaskEditorInProject: () => {}, onRequestCreateTaskInBoardScope: () => {},
		onRequestPinCurrentProjectTaskToTaskPinboard: () => {}, onUnpinCurrentProjectTaskFromTaskPinboard: () => {}, onEditCurrentProjectTaskPinboardPinReason: () => {},
	});
	useAllProjectsFocusViewAdjacentTaskKeyboardNavigation({ host, isFocusViewActive: true });
	useEffect(() => {
		if (currentProjectId !== hydratedProjectId || taskOpening.pendingCrossProjectTaskOpen || !selectedTaskId) return;
		// 模拟真实 runtime 的打开时间广播，不复制导航或排序逻辑。
		setProjects((previous) => previous.map((p) => p.id !== currentProjectId ? p : {
			...p, crossProjectTaskSwitcherEntries: p.crossProjectTaskSwitcherEntries.map((task) => task.taskId === selectedTaskId ? { ...task, lastOpenedByUserAt: Date.now() } : task),
		}));
	}, [currentProjectId, hydratedProjectId, selectedTaskId, taskOpening.pendingCrossProjectTaskOpen]);
	const selection = selectedTaskId ? findCardSelection(board, selectedTaskId) : null;
	const selectedSummary = selection ? summary(selection.card.id, currentProjectId) : null;
	return <CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={host}>
		<TaskCommentsDialogProvider currentWorkspaceId={currentProjectId}>
			<div className="flex h-dvh flex-col bg-surface-0 text-text-primary">
				<header className="flex shrink-0 gap-3 p-2">
					<output aria-label="当前焦点任务">{host.focusedTaskInProject ? `${host.focusedTaskInProject.workspaceId}:${host.focusedTaskInProject.taskId}` : "none"}</output>
					<output aria-label="导航调用">{navigationCalls.join(",")}</output><output aria-label="旧导航调用次数">{legacySelectionCount}</output>
					<button type="button" onClick={() => setHydratedProjectId(currentProjectId)}>完成项目快照</button>
					<button type="button" onClick={() => setIsAllProjects((value) => !value)}>切换项目范围</button>
					<textarea aria-label="任务切换输入框" />
				</header>
				<div className="relative flex min-h-0 flex-1">
					{isFocusViewCrossProjectTaskOpenInTransit ? <FocusViewCrossProjectTaskOpenInTransitShell host={host} targetProjectName={currentProjectId} targetTaskTitle={host.focusedTaskInProject?.taskId ?? null} onCancel={taskOpening.cancelPendingCrossProjectTaskOpenReturningToOriginTask} /> : selection && selectedSummary ?
						<CardDetailView selection={selection} currentProjectId={currentProjectId} workspacePath={`/isolated/${currentProjectId}`} selectedAgentId="codex" sessionSummary={selectedSummary} taskSessions={{ [selection.card.id]: selectedSummary }}
							onSessionSummary={() => {}} onCardSelect={(id) => { setLegacySelectionCount((count) => count + 1); setSelectedTaskId(id); }} onTaskDragEnd={() => {}} onMoveToTrash={() => {}}
							bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}} explorationThreadGraph={{ queryPhase: "ready", view: null, turnSourceUnavailableSessionIds: [] }} /> : null}
				</div>
			</div>
		</TaskCommentsDialogProvider>
	</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider><LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}><Harness /></LayoutCustomizationsProvider></TooltipProvider>,
);
