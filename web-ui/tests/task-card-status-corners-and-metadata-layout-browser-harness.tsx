import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRow } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "../src/components/task-card-body-visual-density-context";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useCrossProjectTaskSwitcherRowHoverExpansionInPlace } from "../src/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import type {
	RuntimeCrossProjectTaskSwitcherEntry,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeMode,
} from "../src/runtime/types";
import { getTaskWorkspaceSnapshot, setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, BoardData } from "../src/types";
import "../src/styles/globals.css";

const nowMs = Date.now();
setTaskWorkspaceSnapshot({
	taskId: "layout-task",
	path: "/isolated/project-a/task-worktree",
	branch: "task-layout",
	isDetached: false,
	headCommit: "task-head",
	baseCommit: "base-head",
	changedFiles: 2,
	additions: 15,
	deletions: 4,
	commitsAheadOfBaseRef: 2,
	commitsBehindBaseRef: 1,
	taskCommitsIntegratedIntoBaseRef: 2,
	taskCommitIntegrationTrackingStatus: "complete",
	taskCommitCoverageInCurrentDeployment: {
		coverageStatus: "some_known_task_commits_in_current_deployment",
		knownTaskCommitCount: 5,
		matchedTaskCommitCountInCurrentDeployment: 2,
		currentDeploymentId: "initial-deployment",
		currentDeployedSourceCommit: "abcdef1234567890",
		currentDeploymentRecordedAtIso: "2026-10-23T09:00:00.000Z",
		unavailableReason: null,
		coverageVersion: "initial-coverage",
	},
});

function Harness() {
	const [isRunning, setIsRunning] = useState(true);
	const [hasUnread, setHasUnread] = useState(true);
	const [isKeptExpanded, setIsKeptExpanded] = useState(false);
	const [isSnapshotUnavailable, setIsSnapshotUnavailable] = useState(false);
	const [worktreeMode, setWorktreeMode] = useState<RuntimeTaskWorktreeMode>("branch");
	const [openedCount, setOpenedCount] = useState(0);
	const panelRef = useRef<HTMLDivElement>(null);
	const hover = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({ panelScrollContainerRef: panelRef });
	const card: BoardCard = {
		id: "layout-task",
		title: "统一布局的任务标题",
		prompt: "隔离的卡片布局验证",
		agentId: "codex",
		baseRef: "main",
		worktreeMode,
		startInPlanMode: false,
		createdAt: nowMs - 60_000,
		updatedAt: nowMs,
	};
	const summary: RuntimeTaskSessionSummary = {
		taskId: card.id,
		state: isRunning ? "running" : "awaiting_review",
		turnOwner: isRunning ? "agent" : "user",
		liveness: "live",
		userTurnKind: isRunning ? null : "review",
		agentId: "codex",
		workspacePath: "/isolated/project-a",
		pid: 1,
		startedAt: nowMs,
		updatedAt: nowMs,
		lastOutputAt: nowMs,
		lastHookAt: nowMs,
		reviewReason: null,
		exitCode: null,
		latestHookActivity: {
			activityText: "检查 Task Card 布局",
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "PostToolUse",
			notificationType: null,
			source: "codex",
		},
	};
	const entry: RuntimeCrossProjectTaskSwitcherEntry = {
		taskId: card.id,
		title: card.title,
		agentId: "codex",
		baseRef: "main",
		worktreeMode,
		columnId: "in_progress",
		turnOwner: isRunning ? "agent" : "user",
		liveness: "live",
		userTurnKind: isRunning ? null : "review",
		lastOutputAt: nowMs,
		createdAt: card.createdAt,
		taskDescriptionLastUpdatedAt: nowMs,
		lastOpenedByUserAt: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		lastSubstantiveOutputAt: nowMs,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
	};
	const entryInProject = { workspaceId: "project-a", projectName: "测试项目", entry };
	const board: BoardData = { columns: [{ id: "in_progress", title: "In Progress", cards: [card] }] };
	const expansionState = isKeptExpanded
		? "kept_expanded_in_list"
		: hover.rowExpandedInPlaceByHover
			? "expanded_in_place_by_hover"
			: "compact_row";
	const openTask = () => setOpenedCount((count) => count + 1);
	const toggleKeptExpanded = () => {
		hover.cancelPendingHoverIntent();
		if (isKeptExpanded) hover.suppressHoverExpansionUntilPointerLeavesRow("project-a:layout-task");
		else hover.forgetHoverExpansionOfRowNowKeptExpandedInList();
		setIsKeptExpanded((value) => !value);
	};
	return (
		<TooltipProvider>
			<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
				value={{
					projects: [],
					currentProjectId: "project-a",
					isBoardScopeAllProjectsSelected: false,
					focusedTaskInProject: null,
					notificationLogByWorkspaceId: hasUnread
						? {
								"project-a": [
									{
										id: "unread",
										workspaceId: "project-a",
										taskId: card.id,
										repoName: "测试项目",
										taskTitle: card.title,
										userTurnKind: "review",
										triggeredAt: nowMs,
										visitedAt: null,
										isDone: false,
									},
								],
							}
						: {},
					onOpenTaskInProject: openTask,
					onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
					onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
					onEditCurrentProjectTaskPinboardPinReason: () => {},
				}}
			>
				<div className="min-h-screen bg-surface-0 p-6 text-text-primary">
					<div className="mb-8 flex flex-wrap gap-4">
						<button type="button" onClick={() => setIsRunning((value) => !value)}>
							切换运行状态
						</button>
						<button type="button" onClick={() => setHasUnread((value) => !value)}>
							切换未读状态
						</button>
						<button
							type="button"
							onClick={() => setWorktreeMode((value) => (value === "branch" ? "inplace" : "branch"))}
						>
							切换工作区类型
						</button>
						<button type="button" onClick={() => setIsSnapshotUnavailable((value) => !value)}>
							切换快照可用性
						</button>
						<output aria-label="打开任务次数">{openedCount}</output>
						<button type="button" onClick={() => {
							const previous = getTaskWorkspaceSnapshot("layout-task");
							if (previous?.taskCommitCoverageInCurrentDeployment) setTaskWorkspaceSnapshot({
								...previous, taskCommitCoverageInCurrentDeployment: {
									...previous.taskCommitCoverageInCurrentDeployment,
									coverageStatus: "no_known_task_commits_in_current_deployment",
									matchedTaskCommitCountInCurrentDeployment: 0,
									currentDeploymentId: "rollback-deployment",
									coverageVersion: "rollback-coverage",
								},
							});
						}}>模拟部署回滚</button>
					</div>
					<div className="flex flex-wrap items-start gap-8">
						<section className="w-[280px]" data-layout-host="all-projects">
							<h2 className="mb-6">All Projects</h2>
							<div ref={panelRef} className="relative p-2" {...hover.panelPointerHandlers}>
								<CrossProjectRecentlyActiveTaskSwitcherTaskRow
									entryInProject={entryInProject}
									section="remaining"
									isFocused={false}
									isUnreadHandoff={hasUnread}
									nowMs={nowMs}
									showsProjectName
									currentProjectId="project-a"
									inPlaceExpansionState={expansionState}
									onOpen={openTask}
									onTogglePinnedToTaskPinboard={() => {}}
									onKeepExpandedInListAsFullTaskCard={toggleKeptExpanded}
									rowHoverExpansionTriggerProps={hover.buildRowHoverExpansionTriggerProps(
										{ entryKey: "project-a:layout-task", section: "remaining" },
										isKeptExpanded ? "kept_expanded_in_list" : "compact_row",
									)}
									fullTaskCard={
										<CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard
											entryInProject={entryInProject}
											currentProjectId={isSnapshotUnavailable ? null : "project-a"}
											currentProjectTaskCards={{
												currentProjectDisplayedBoard: board,
												currentProjectTaskSessions: { [card.id]: summary },
												currentProjectWorkspacePath: "/isolated/project-a",
												currentProjectTaskCardActionHandlers: {},
											}}
											otherProjectWorkspacePath="/isolated/project-a"
											defaultAgentId="codex"
											buildTaskCardActionHandlerBundleForOtherProjectTaskCard={() => ({})}
											rowContext={{
												projectName: "测试项目",
												nowMs,
												inListExpansionState: isKeptExpanded
													? "kept_expanded_in_list"
													: "collapsed_to_compact_row",
												onToggleInListExpansion: toggleKeptExpanded,
												isPresentedAsHoveredFromFirstFrame: Boolean(
													hover.rowExpandedInPlaceByHover?.isPointerOverRow,
												),
												onActivateRow: openTask,
											}}
										/>
									}
								/>
							</div>
						</section>
						<section className="w-[280px]" data-layout-host="project-specific">
							<h2 className="mb-6">Project Specific</h2>
							<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
								<TaskCardBody card={card} columnId="in_progress" sessionSummary={summary} onClick={openTask} />
							</TaskCardBodyVisualDensityProvider>
						</section>
						<section className="w-[280px]" data-layout-host="standard-board">
							<h2 className="mb-6">标准卡片</h2>
							<TaskCardBody
								card={card}
								columnId="in_progress"
								sessionSummary={summary}
								renderRole="task_card_copy_in_post_deploy_verification_panel_entry"
								onClick={openTask}
							/>
						</section>
					</div>
				</div>
			</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
		</TooltipProvider>
	);
}

const mountElement = document.createElement("div");
document.body.appendChild(mountElement);
createRoot(mountElement).render(<Harness />);
