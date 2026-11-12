import { Terminal } from "@xterm/xterm";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { FocusViewCrossProjectTaskOpenInTransitShell } from "../src/components/detail-panels/focus-view-cross-project-task-open-in-transit-shell";
import { DesktopSidebarVisibilityButton } from "../src/components/desktop-sidebar-visibility-button";
import { ProjectNavigationPanel } from "../src/components/project-navigation-panel";
import { SideSessionCreationWorkbench } from "../src/components/side-session-creation-workbench";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TopBar } from "../src/components/top-bar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { ExpandedForegroundViewProvider } from "../src/expanded-foreground-view/expanded-foreground-view-provider";
import { useAppHotkeys } from "../src/hooks/use-app-hotkeys";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useIsMobile } from "../src/hooks/use-is-mobile";
import { LayoutCustomizationsProvider, useLayoutCustomizations } from "../src/resize/layout-customizations";
import { useProjectNavigationLayout } from "../src/resize/use-project-navigation-layout";
import { useSidebarVisibilityLayout } from "../src/resize/use-sidebar-visibility-layout";
import type { RuntimeTaskSessionSummary, TaskVisualizationPreviewRequestedMessage } from "../src/runtime/types";
import {
	attachTaskVisualizationRuntimeStreamSender,
	deliverTaskVisualizationStreamMessage,
	readTaskVisualizationBrowserPageId,
} from "../src/stores/task-visualization-browser-bridge";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

const workspaceId = "isolated-sidebar-project";
const card: BoardCard = {
	id: "sidebar-task",
	title: "侧栏显隐验证",
	prompt: "隔离浏览器验证",
	agentId: "codex",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 10,
	updatedAt: 10,
};
const column = {
	id: "in_progress" as const,
	title: "In Progress",
	cards: [
		...Array.from({ length: 40 }, (_, index) => ({
			...card,
			id: `sidebar-task-${index}`,
			title: `列表滚动验证 ${index}`,
		})),
		card,
	],
};
const selection: CardSelection = { card, column, allColumns: [column] };
const summary: RuntimeTaskSessionSummary = {
	taskId: card.id,
	agentId: "codex",
	state: "running",
	turnOwner: "agent",
	liveness: "live",
	userTurnKind: null,
	workspacePath: "/isolated/sidebar-visibility",
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
setTaskWorkspaceSnapshot({
	taskId: card.id,
	path: summary.workspacePath!,
	branch: null,
	isDetached: true,
	headCommit: null,
	baseCommit: null,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
	commitsAheadOfBaseRef: 0,
	commitsBehindBaseRef: 0,
});
let terminalMountCount = 0;
const originalOpenTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent) {
	originalOpenTerminal.call(this, parent);
	terminalMountCount++;
};
const previewAcknowledgments: unknown[] = [];
attachTaskVisualizationRuntimeStreamSender(workspaceId, (message) => previewAcknowledgments.push(message));
Object.assign(window, {
	readSidebarTerminalMountCount: () => terminalMountCount,
	readSidebarPreviewAcknowledgments: () => previewAcknowledgments,
	createSidebarPreviewOffer: (): TaskVisualizationPreviewRequestedMessage => ({
		type: "task_visualization_preview_requested",
		workspaceId,
		taskId: card.id,
		browserPageId: readTaskVisualizationBrowserPageId(),
		deliveryAttemptId: crypto.randomUUID(),
		deliveryState: "offered",
		previewRequest: {
			previewRequestId: crypto.randomUUID(),
			visualizationArtifactId: "a".repeat(64),
			revisionId: "b".repeat(64),
			requestedAtMs: Date.now(),
			displayedAtMs: null,
		},
	}),
	deliverSidebarPreview: deliverTaskVisualizationStreamMessage,
});

function ResetLayoutButton() {
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	return (
		<button type="button" onClick={resetLayoutCustomizations}>
			重置布局
		</button>
	);
}

function Harness() {
	const sidebarVisibility = useSidebarVisibilityLayout();
	const projectNavigationLayout = useProjectNavigationLayout();
	const isMobile = useIsMobile();
	const [isHomePage, setIsHomePage] = useState(false);
	const [isCrossProjectTaskOpenInTransit, setIsCrossProjectTaskOpenInTransit] = useState(false);
	const [isDiffExpanded, setIsDiffExpanded] = useState(false);
	const [changesOpen, setChangesOpen] = useState(false);
	const [isBoardScopeAllProjectsSelected, setIsBoardScopeAllProjectsSelected] = useState(false);
	const [startAllRequests, setStartAllRequests] = useState(0);
	const crossProjectTaskSwitcherSectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({
		projects: [],
		notificationLogByWorkspaceId: {},
		currentProjectId: workspaceId,
	});
	const toggleLeftSidebar = () => {
		if (isHomePage) {
			if (isMobile) projectNavigationLayout.setSidebarCollapsed(!projectNavigationLayout.isCollapsed, false);
			else sidebarVisibility.setHomeProjectSidebarHidden(!sidebarVisibility.isHomeProjectSidebarHidden);
		} else {
			sidebarVisibility.setFocusViewTaskListSidebarHidden(
				isDiffExpanded ? false : !sidebarVisibility.isFocusViewTaskListSidebarHidden,
			);
			setIsDiffExpanded(false);
		}
	};
	const toggleWorkbenchSidebar = () => {
		sidebarVisibility.setFocusViewWorkbenchSidebarHidden(!sidebarVisibility.isFocusViewWorkbenchSidebarHidden);
		setIsDiffExpanded(false);
	};
	const crossProjectTaskSwitcherHost = {
		crossProjectTaskSwitcherSectionsModel,
		projects: [],
		notificationLogByWorkspaceId: {},
		currentProjectId: workspaceId,
		isBoardScopeAllProjectsSelected,
		focusedTaskInProject: null,
		onOpenTaskInProject() {},
		onRequestCreateTaskInBoardScope() {},
		onRequestPinCurrentProjectTaskToTaskPinboard() {},
		onUnpinCurrentProjectTaskFromTaskPinboard() {},
		onEditCurrentProjectTaskPinboardPinReason() {},
	};
	useAppHotkeys({
		selectedCard: isHomePage ? null : selection,
		isDetailTerminalOpen: false,
		isHomeTerminalOpen: false,
		isHomeGitHistoryOpen: false,
		canUseCreateTaskShortcut: false,
		canUseTaskSpotlightSearch: false,
		handleToggleDetailTerminal() {},
		handleToggleHomeTerminal() {},
		handleToggleExpandDetailTerminal() {},
		handleToggleExpandHomeTerminal() {},
		handleOpenCreateTask() {},
		handleToggleTaskSpotlightSearch() {},
		handleOpenSettings() {},
		handleToggleGitHistory() {},
		handleCloseGitHistory() {},
		handleToggleBetweenBoardScopeAndFocusedTaskProjectScope: null,
		handleToggleCurrentPageLeftSidebar: !isMobile || isHomePage ? toggleLeftSidebar : null,
		handleToggleFocusViewWorkbenchSidebar: !isMobile && !isHomePage ? toggleWorkbenchSidebar : null,
		onRequestStartAllReadyBacklogTasks: () => setStartAllRequests((count) => count + 1),
	});
	return (
		<LayoutCustomizationsProvider
			onResetBottomTerminalLayoutCustomizations={() => {}}
			onResetSidebarVisibilityLayoutCustomizations={() => {
				sidebarVisibility.resetSidebarVisibilityLayoutCustomizations();
				setIsDiffExpanded(false);
			}}
		>
			<TaskCommentsDialogProvider currentWorkspaceId={workspaceId}>
			<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={crossProjectTaskSwitcherHost}>
				<div className="flex h-dvh overflow-hidden bg-surface-0 text-text-primary">
					{isHomePage ? (
						<ProjectNavigationPanel
							projects={[]}
							currentProjectId={workspaceId}
							permanentlyDeletingProjectId={null}
							activeSection="projects"
							onActiveSectionChange={() => {}}
							canShowAgentSection={false}
							onSelectProject={() => {}}
							onGetPermanentDeletionPreview={async () => null}
							onPermanentlyDeleteProjectData={async () => null}
							onAddProject={() => {}}
							sidebarWidth={projectNavigationLayout.sidebarWidth}
							setExpandedSidebarWidth={projectNavigationLayout.setExpandedSidebarWidth}
							isCollapsed={projectNavigationLayout.isCollapsed}
							setSidebarCollapsed={projectNavigationLayout.setSidebarCollapsed}
							isDesktopSidebarHidden={sidebarVisibility.isHomeProjectSidebarHidden}
							desktopSidebarVisibilityButton={!isMobile ? (
								<DesktopSidebarVisibilityButton side="left" label="项目栏" isHidden={false} onToggle={toggleLeftSidebar} />
							) : undefined}
						/>
					) : null}
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						<TopBar
							openTargetOptions={[]}
							selectedOpenTargetId="vscode"
							onSelectOpenTarget={() => {}}
							onOpenWorkspace={() => {}}
							canOpenWorkspace={false}
							isOpeningWorkspace={false}
							onToggleSidebar={isHomePage ? toggleLeftSidebar : undefined}
						/>
						<header className="flex h-10 shrink-0 items-center gap-3 px-2">
							<button type="button" onClick={() => setIsHomePage((value) => !value)}>
								切换首页与 Focus View
							</button>
							<button type="button" onClick={() => setChangesOpen((value) => !value)}>
								Changes
							</button>
							<button type="button" onClick={() => setIsCrossProjectTaskOpenInTransit((value) => !value)}>
								切换跨项目在途外壳
							</button>
							<button type="button" onClick={() => setIsBoardScopeAllProjectsSelected((value) => !value)}>
								切换项目范围
							</button>
							<ResetLayoutButton />
							<output aria-label="启动全部请求次数">{startAllRequests}</output>
						</header>
						{isHomePage ? (
							<main className="relative flex-1">
								{!isMobile && sidebarVisibility.isHomeProjectSidebarHidden ? (
									<DesktopSidebarVisibilityButton side="left" label="项目栏" isHidden onToggle={toggleLeftSidebar} />
								) : null}
								隔离首页
							</main>
						) : isCrossProjectTaskOpenInTransit ? (
							<FocusViewCrossProjectTaskOpenInTransitShell
								host={crossProjectTaskSwitcherHost}
								targetProjectName="隔离目标项目"
								targetTaskTitle="隔离目标任务"
								onCancel={() => setIsCrossProjectTaskOpenInTransit(false)}
								isFocusViewTaskListSidebarHidden={sidebarVisibility.isFocusViewTaskListSidebarHidden}
								onToggleFocusViewTaskListSidebar={toggleLeftSidebar}
							/>
						) : (
							<CardDetailView
								selection={selection}
								currentProjectId={workspaceId}
								workspacePath={summary.workspacePath}
								selectedAgentId="codex"
								sessionSummary={summary}
								taskSessions={{ [card.id]: summary }}
								onSessionSummary={() => {}}
								onCardSelect={() => {}}
								onCreateTask={() => {}}
								onTaskDragEnd={() => {}}
								onMoveToTrash={() => {}}
								bottomTerminalOpen={false}
								bottomTerminalTaskId={null}
								bottomTerminalSummary={null}
								onBottomTerminalClose={() => {}}
								isTaskChangesSidebarOpen={changesOpen}
								isFocusViewTaskListSidebarHidden={sidebarVisibility.isFocusViewTaskListSidebarHidden}
								onToggleFocusViewTaskListSidebar={toggleLeftSidebar}
								isFocusViewWorkbenchSidebarHidden={sidebarVisibility.isFocusViewWorkbenchSidebarHidden}
								onFocusViewWorkbenchSidebarHiddenChange={sidebarVisibility.setFocusViewWorkbenchSidebarHidden}
								isDiffExpanded={isDiffExpanded}
								onDiffExpandedChange={setIsDiffExpanded}
								onCreateTaskConversationSession={async () => ({ ok: false, message: "隔离环境" })}
								explorationThreadGraph={{
									queryPhase: "ready",
									view: null,
									turnSourceUnavailableSessionIds: [],
								}}
							/>
						)}
					</div>
				</div>
				<SideSessionCreationWorkbench />
			</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
			</TaskCommentsDialogProvider>
		</LayoutCustomizationsProvider>
	);
}

createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider>
		<ExpandedForegroundViewProvider>
			<Harness />
		</ExpandedForegroundViewProvider>
	</TooltipProvider>,
);
