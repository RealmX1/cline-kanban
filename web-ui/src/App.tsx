// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.
import { FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AddProjectDialog } from "@/components/add-project-dialog";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { BugReportFab } from "@/components/bug-report/bug-report-fab";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import type { ConnectionRetrySessionView } from "@/components/connection-retry-indicator";
import { CrossRepositoryStageFirstOverview } from "@/components/cross-repository-stage-first-overview";
import { DebugDialog } from "@/components/debug-dialog";
import { DeleteTaskDialog } from "@/components/delete-task-dialog";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { GitHistoryView } from "@/components/git-history-view";
import { GuidedVerificationController } from "@/components/guided-verification/guided-verification-controller";
import { KanbanBoard } from "@/components/kanban-board";
import { NotificationCenter } from "@/components/notification-center";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { RuntimeSettingsDialog, type RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import { SkipValidationConfirmDialog } from "@/components/skip-validation-confirm-dialog";
import { StartupOnboardingDialog } from "@/components/startup-onboarding-dialog";
import { TaskBoardSearchToolbar } from "@/components/task-board-search-toolbar";
import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { UnavailableProjectRuntimeState } from "@/components/unavailable-project-runtime-state";
import { UpdateNotificationController } from "@/components/update-notification-controller";
import { createInitialBoardData } from "@/data/board-data";
import { createIdleTaskSession } from "@/hooks/app-utils";
import { KanbanAccessBlockedFallback } from "@/hooks/kanban-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { useAppHotkeys } from "@/hooks/use-app-hotkeys";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useFeaturebaseFeedbackWidget } from "@/hooks/use-featurebase-feedback-widget";
import { useGitActions } from "@/hooks/use-git-actions";
import { useGuidedVerification } from "@/hooks/use-guided-verification";
import { useHomeSidebarAgentPanel } from "@/hooks/use-home-sidebar-agent-panel";
import { useKanbanAccessGate } from "@/hooks/use-kanban-access-gate";
import { useNotificationCenter } from "@/hooks/use-notification-center";
import { useNotificationTaskFocus } from "@/hooks/use-notification-task-focus";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskStartActions } from "@/hooks/use-task-start-actions";
import { useTerminalPanels } from "@/hooks/use-terminal-panels";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import { LayoutCustomizationsProvider } from "@/resize/layout-customizations";
import { ResizableBottomPane } from "@/resize/resizable-bottom-pane";
import { useProjectNavigationLayout } from "@/resize/use-project-navigation-layout";
import {
	getTaskAgentNavbarHint,
	isTaskAgentSetupSatisfied,
	selectLatestTaskChatMessageForTask,
	selectTaskChatMessagesForTask,
} from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeClineReasoningEffort, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useRuntimeProjectConfig } from "@/runtime/use-runtime-project-config";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { saveWorkspaceState } from "@/runtime/workspace-state-query";
import type { TaskBoardSearchMode } from "@/search/task-board-search";
import { useTaskBoardSearch } from "@/search/use-task-board-search";
import { applyTaskDetailClineSettingsChange, findCardSelection, updateTaskCommentEntries } from "@/state/board-state";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
} from "@/stores/workspace-metadata-store";
import { useTerminalThemeColors } from "@/terminal/theme-colors";
import type { BoardData, TaskCommentEntry } from "@/types";

export default function App(): ReactElement {
	const terminalThemeColors = useTerminalThemeColors();
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [taskSearchQuery, setTaskSearchQuery] = useState("");
	// 默认 fuzzy（fzf）：语义（hybrid/semantic）栈重，且其相似度分并不用于看板排序（列内不重排卡片），
	// 默认走 fuzzy 省去每次搜索的 embedding 开销；需要语义召回时用户可在工具栏切到 Hybrid/Semantic。
	const [taskSearchMode, setTaskSearchMode] = useState<TaskBoardSearchMode>("fuzzy");
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [homeSidebarSection, setHomeSidebarSection] = useState<"projects" | "agent">("projects");
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	const [isTaskChangesSidebarOpen, setIsTaskChangesSidebarOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	const lastStreamErrorRef = useRef<string | null>(null);
	const handleProjectSwitchStart = useCallback(() => {
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setTaskSearchQuery("");
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);
	const {
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		notificationLogByWorkspaceId,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		recheckProjectAvailability,
		navigationCurrentProjectId,
		permanentlyDeletingProjectId,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleAddProject,
		handleAddProjectSuccess,
		handleGetPermanentDeletionPreview,
		handlePermanentlyDeleteProjectData,
		isAddProjectDialogOpen,
		setIsAddProjectDialogOpen,
		pendingNativeGitInitPath,
		resetProjectNavigationState,
	} = useProjectNavigation({
		onProjectSwitchStart: handleProjectSwitchStart,
	});
	const currentProjectSummary = projects.find((project) => project.id === currentProjectId) ?? null;
	const currentUnavailableProject =
		currentProjectSummary?.availability.status === "unavailable"
			? {
					...currentProjectSummary,
					availability: currentProjectSummary.availability,
				}
			: null;
	const isCurrentProjectRuntimeUnavailable = currentUnavailableProject !== null;
	const projectRuntimeWorkspaceId = isCurrentProjectRuntimeUnavailable ? null : currentProjectId;
	const activeNotificationWorkspaceId = isCurrentProjectRuntimeUnavailable ? null : navigationCurrentProjectId;
	const isDocumentVisible = useDocumentVisibility();
	const isInitialRuntimeLoad =
		!hasReceivedSnapshot && currentProjectId === null && projects.length === 0 && !streamError;
	const isAwaitingWorkspaceSnapshot = projectRuntimeWorkspaceId !== null && streamedWorkspaceState === null;
	const {
		config: runtimeProjectConfig,
		isLoading: isRuntimeProjectConfigLoading,
		refresh: refreshRuntimeProjectConfig,
	} = useRuntimeProjectConfig(projectRuntimeWorkspaceId);
	const { isBlocked: isKanbanAccessBlocked, refresh: refreshKanbanAccess } = useKanbanAccessGate({
		workspaceId: projectRuntimeWorkspaceId,
	});
	const isTaskAgentReady = isTaskAgentSetupSatisfied(runtimeProjectConfig);
	const settingsWorkspaceId = isCurrentProjectRuntimeUnavailable
		? null
		: (navigationCurrentProjectId ?? currentProjectId);
	const { config: settingsRuntimeProjectConfig, refresh: refreshSettingsRuntimeProjectConfig } =
		useRuntimeProjectConfig(settingsWorkspaceId);
	const featurebaseFeedbackState = useFeaturebaseFeedbackWidget({
		workspaceId: settingsWorkspaceId,
		clineProviderSettings: settingsRuntimeProjectConfig?.clineProviderSettings ?? null,
	});
	const {
		isStartupOnboardingDialogOpen,
		handleOpenStartupOnboardingDialog,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
		handleOnboardingClineSetupSaved,
	} = useStartupOnboarding({
		currentProjectId: projectRuntimeWorkspaceId,
		runtimeProjectConfig,
		isRuntimeProjectConfigLoading,
		isTaskAgentReady,
		refreshRuntimeProjectConfig,
		refreshSettingsRuntimeProjectConfig,
	});
	const {
		debugModeEnabled,
		isDebugDialogOpen,
		isResetAllStatePending,
		handleOpenDebugDialog,
		handleShowStartupOnboardingDialog,
		handleDebugDialogOpenChange,
		handleResetAllState,
	} = useDebugTools({
		runtimeProjectConfig,
		settingsRuntimeProjectConfig,
		onOpenStartupOnboardingDialog: handleOpenStartupOnboardingDialog,
	});
	const {
		markConnectionReady: markTerminalConnectionReady,
		prepareWaitForConnection: prepareWaitForTerminalConnectionReady,
	} = useTerminalConnectionReady();
	const readyForReviewNotificationsEnabled = runtimeProjectConfig?.readyForReviewNotificationsEnabled ?? true;
	const notificationSoundEnabled = runtimeProjectConfig?.notificationSoundEnabled ?? true;
	const shortcuts = runtimeProjectConfig?.shortcuts ?? [];
	const selectedShortcutLabel = useMemo(() => {
		if (shortcuts.length === 0) {
			return null;
		}
		const configured = runtimeProjectConfig?.selectedShortcutLabel ?? null;
		if (configured && shortcuts.some((shortcut) => shortcut.label === configured)) {
			return configured;
		}
		return shortcuts[0]?.label ?? null;
	}, [runtimeProjectConfig?.selectedShortcutLabel, shortcuts]);
	const {
		upsertSession,
		ensureTaskWorkspace,
		startTaskSession,
		createByTheWayTaskConversationSession,
		stopTaskSession,
		transitionTaskToReview,
		continueConnectionRetrySessions,
		dismissConnectionRetrySessions,
		sendTaskSessionInput,
		sendTaskChatMessage,
		cancelTaskChatTurn,
		fetchTaskChatMessages,
		cleanupTaskWorkspace,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId: projectRuntimeWorkspaceId,
		setSessions,
	});

	// 当前 workspace 内正处于连接重试的会话视图（驱动顶栏「重连中」指示器）。
	// sessions 已按 workspace 范围维护，因此这里天然是 per-tab 范围。
	const connectionRetrySessions = useMemo<ConnectionRetrySessionView[]>(() => {
		const titleByTaskId = new Map<string, string>();
		for (const column of board.columns) {
			for (const card of column.cards) {
				titleByTaskId.set(card.id, card.title);
			}
		}
		const views: ConnectionRetrySessionView[] = [];
		for (const summary of Object.values(sessions)) {
			const retry = summary.connectionRetry;
			if (!retry || retry.status !== "retrying") {
				continue;
			}
			views.push({
				taskId: summary.taskId,
				taskTitle: titleByTaskId.get(summary.taskId) ?? summary.taskId,
				retryCount: retry.retryCount,
				nextAttemptAt: retry.nextAttemptAt,
			});
		}
		return views;
	}, [board, sessions]);
	const taskBoardSearch = useTaskBoardSearch({
		board,
		query: taskSearchQuery,
		mode: taskSearchMode,
	});

	const handleContinueConnectionRetrySessions = useCallback(
		(taskIds: string[]) => {
			void continueConnectionRetrySessions(taskIds);
		},
		[continueConnectionRetrySessions],
	);

	const handleDismissConnectionRetrySessions = useCallback(
		(taskIds: string[]) => {
			void dismissConnectionRetrySessions(taskIds);
		},
		[dismissConnectionRetrySessions],
	);

	const {
		workspacePath,
		workspaceGit,
		workspaceRevision,
		setWorkspaceRevision,
		workspaceHydrationNonce,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId: projectRuntimeWorkspaceId,
		streamedWorkspaceState,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});
	const { selectedTaskId, selectedCard, setSelectedTaskId, handleBack } = useDetailTaskNavigation({
		board,
		currentProjectId: projectRuntimeWorkspaceId,
		isAwaitingWorkspaceSnapshot,
		isInitialRuntimeLoad,
		isProjectSwitching,
		isWorkspaceMetadataPending,
		onDetailClosed: () => {
			setIsGitHistoryOpen(false);
		},
	});

	useEffect(() => {
		setIsTaskChangesSidebarOpen(false);
	}, [selectedCard?.card.id]);
	useNotificationTaskFocus({ currentProjectId: navigationCurrentProjectId, setSelectedTaskId });

	// Board Scope 的 Stage-First Overview（跨-repo 概览，见 CONTEXT.md）开关 + 跨-workspace 打开某 task 的待定跳转。
	const [isBoardOverviewOpen, setIsBoardOverviewOpen] = useState(false);
	const [pendingOverviewTaskOpen, setPendingOverviewTaskOpen] = useState<{ repoId: string; taskId: string } | null>(
		null,
	);
	const handleToggleBoardOverview = useCallback(() => {
		setIsBoardOverviewOpen((open) => {
			const next = !open;
			if (next) {
				setIsGitHistoryOpen(false);
			}
			return next;
		});
	}, []);
	const handleOpenOverviewTask = useCallback(
		(repoId: string, taskId: string) => {
			// 刻意不关概览：detail 打开时 home layout 只是 visibility:hidden（非卸载），概览仍在其下；
			// 从 detail 返回（handleBack 清 selectedTaskId）即重现概览——与 Guided Verification 面板点 task
			// 后返回回到面板的行为一致（避免「从概览点进去、返回却落到普通 board」的困惑）。
			if (repoId === currentProjectId) {
				setSelectedTaskId(taskId);
				return;
			}
			// 跨 repo：先切 workspace，待目标 board 加载出该 task 再打开 detail（见下方 effect）。
			setPendingOverviewTaskOpen({ repoId, taskId });
			handleSelectProject(repoId);
		},
		[currentProjectId, handleSelectProject, setSelectedTaskId],
	);
	const handleOpenOverviewStage = useCallback(
		(repoId: string) => {
			setIsBoardOverviewOpen(false);
			handleSelectProject(repoId);
		},
		[handleSelectProject],
	);
	// 跨-workspace 打开 task 的收尾：目标 repo 已激活、且其 board 加载出该 task 后，再 setSelectedTaskId
	// ——绕开 project-switch 时 use-detail-task-navigation 的 closeDetail 竞态（见该 hook）。
	useEffect(() => {
		if (!pendingOverviewTaskOpen || currentProjectId !== pendingOverviewTaskOpen.repoId) {
			return;
		}
		if (!findCardSelection(board, pendingOverviewTaskOpen.taskId)) {
			return;
		}
		setSelectedTaskId(pendingOverviewTaskOpen.taskId);
		setPendingOverviewTaskOpen(null);
	}, [board, currentProjectId, pendingOverviewTaskOpen, setSelectedTaskId]);

	// 应用内通知中心（跨 repo 铃铛）。mark/clear 是跨 repo mutation：用 notification 的 workspaceId 起 tRPC 客户端，
	// input 显式携带同一 workspaceId（服务端 t.procedure 忽略连接 scope，按 input.workspaceId 操作）。
	const handleMarkTaskNotificationsVisited = useCallback((workspaceId: string, taskId: string) => {
		void getRuntimeTrpcClient(workspaceId)
			.runtime.markTaskNotificationsVisited.mutate({ workspaceId, taskId })
			.catch(() => {
				// 标记已读失败可忽略：下次快照/广播会纠正。
			});
	}, []);
	const handleClearWorkspaceNotifications = useCallback((workspaceId: string) => {
		void getRuntimeTrpcClient(workspaceId)
			.runtime.clearNotificationLog.mutate({ workspaceId })
			.catch(() => {
				// 清空失败可忽略：下次快照/广播会纠正。
			});
	}, []);
	const notificationCenter = useNotificationCenter({
		notificationLogByWorkspaceId,
		selectedTaskId,
		onMarkTaskVisited: handleMarkTaskNotificationsVisited,
		onClearWorkspace: handleClearWorkspaceNotifications,
	});

	// 跨 repo 点击通知定位 task：同项目直接选中；跨项目先切项目，待目标项目数据落地（currentProjectId 到位、
	// 非切换中）后再选中——否则会被 useDetailTaskNavigation 切项目时的 closeDetail 清掉。
	const pendingNotificationFocusRef = useRef<{ workspaceId: string; taskId: string } | null>(null);
	const focusNotificationTask = useCallback(
		(workspaceId: string, taskId: string) => {
			// 目标项目已完全落地（loaded 且非切换中）才直接选中——与下方 pending-effect 同轴（currentProjectId）。
			// 若只看 navigationCurrentProjectId（导航意图），切换在途时会过早 setSelectedTaskId，随后被
			// useDetailTaskNavigation 切项目的 closeDetail 清掉且无 pending 恢复，通知点击打不开详情。
			if (workspaceId === currentProjectId && !isProjectSwitching) {
				setSelectedTaskId(taskId);
				return;
			}
			// 否则挂 pending，待目标项目落地后由 effect 选中；仅当导航意图尚未指向目标时才触发切项目
			// （已在切往目标时重复 handleSelectProject 无意义）。
			pendingNotificationFocusRef.current = { workspaceId, taskId };
			if (workspaceId !== navigationCurrentProjectId) {
				void handleSelectProject(workspaceId);
			}
		},
		[currentProjectId, isProjectSwitching, navigationCurrentProjectId, setSelectedTaskId, handleSelectProject],
	);
	useEffect(() => {
		const pending = pendingNotificationFocusRef.current;
		if (!pending) {
			return;
		}
		if (currentProjectId === pending.workspaceId && !isProjectSwitching) {
			pendingNotificationFocusRef.current = null;
			setSelectedTaskId(pending.taskId);
		}
	}, [currentProjectId, isProjectSwitching, setSelectedTaskId]);

	useEffect(() => {
		replaceWorkspaceMetadata(workspaceMetadata);
	}, [workspaceMetadata]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceMetadataStore();
	}, [isProjectSwitching]);

	const {
		displayedProjects,
		navigationProjectPath,
		shouldShowProjectLoadingState,
		isProjectListLoading,
		shouldUseNavigationPath,
	} = useProjectUiState({
		board,
		canPersistWorkspaceState,
		currentProjectId,
		projects,
		navigationCurrentProjectId,
		selectedTaskId,
		streamError,
		isProjectSwitching,
		isInitialRuntimeLoad,
		isAwaitingWorkspaceSnapshot,
		isWorkspaceMetadataPending,
		hasReceivedSnapshot,
	});

	useReviewReadyNotifications({
		activeWorkspaceId: activeNotificationWorkspaceId,
		board,
		isDocumentVisible,
		latestTaskReadyForReview,
		taskSessions: sessions,
		readyForReviewNotificationsEnabled,
		notificationSoundEnabled,
		workspacePath,
	});

	const { createTaskBranchOptions, editTaskBranchOptions, defaultTaskBranchRef, defaultCreateTaskBranchRef } =
		useTaskBranchOptions({ workspaceGit });
	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskWorktreeMode,
		setNewTaskWorktreeMode,
		newTaskAgentId,
		setNewTaskAgentId,
		newTaskClineSettings,
		setNewTaskClineSettings,
		newTaskTerminalAgentModelOverrideSettings,
		setNewTaskTerminalAgentModelOverrideSettings,
		newTaskAgentSessionInitialization,
		setNewTaskAgentSessionInitialization,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskWorktreeMode,
		setEditTaskWorktreeMode,
		editTaskAgentId,
		setEditTaskAgentId,
		editTaskClineSettings,
		setEditTaskClineSettings,
		editTaskTerminalAgentModelOverrideSettings,
		setEditTaskTerminalAgentModelOverrideSettings,
		editTaskAgentSessionInitialization,
		setEditTaskAgentSessionInitialization,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	} = useTaskEditor({
		board,
		setBoard,
		createTaskBranchOptions,
		editTaskBranchOptions,
		defaultTaskBranchRef,
		defaultCreateTaskBranchRef,
		currentProjectId: projectRuntimeWorkspaceId,
		selectedAgentId: runtimeProjectConfig?.selectedAgentId ?? null,
		newTaskStartInPlanModeByDefault: runtimeProjectConfig?.newTaskStartInPlanModeByDefault ?? true,
		isNewTaskStartInPlanModeDefaultLoaded: runtimeProjectConfig !== null,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		taskEditorResetRef.current = resetTaskEditorState;
	}, [resetTaskEditorState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetWorkspaceSyncState();
	}, [isProjectSwitching, resetWorkspaceSyncState]);

	useEffect(() => {
		if (!isProjectSwitching) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	const {
		runningGitAction,
		taskGitActionLoadingByTaskId,
		commitTaskLoadingById,
		openPrTaskLoadingById,
		agentCommitTaskLoadingById,
		agentOpenPrTaskLoadingById,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError,
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		handleCommitTask,
		handleOpenPrTask,
		handleAgentCommitTask,
		handleAgentOpenPrTask,
		runAutoReviewGitAction,
		resetGitActionState,
	} = useGitActions({
		currentProjectId: projectRuntimeWorkspaceId,
		board,
		selectedCard,
		runtimeProjectConfig,
		sendTaskSessionInput,
		sendTaskChatMessage,
		fetchTaskWorkspaceInfo,
		isGitHistoryOpen,
		refreshWorkspaceState,
	});
	const agentCommand = runtimeProjectConfig?.effectiveCommand ?? null;
	const {
		homeTerminalTaskId,
		isHomeTerminalOpen,
		isHomeTerminalStarting,
		homeTerminalPaneHeight,
		isDetailTerminalOpen,
		detailTerminalTaskId,
		isDetailTerminalStarting,
		detailTerminalPaneHeight,
		isHomeTerminalExpanded,
		isDetailTerminalExpanded,
		setHomeTerminalPaneHeight,
		setDetailTerminalPaneHeight,
		handleToggleExpandHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleDetailTerminal,
		handleSendAgentCommandToHomeTerminal,
		handleSendAgentCommandToDetailTerminal,
		prepareTerminalForShortcut,
		resetBottomTerminalLayoutCustomizations,
		collapseHomeTerminal,
		collapseDetailTerminal,
		closeHomeTerminal,
		closeDetailTerminal,
		resetTerminalPanelsState,
	} = useTerminalPanels({
		currentProjectId: projectRuntimeWorkspaceId,
		selectedCard,
		workspaceGit,
		agentCommand,
		upsertSession,
		sendTaskSessionInput,
	});
	const homeTerminalSummary = sessions[homeTerminalTaskId] ?? null;
	const homeSidebarAgentPanel = useHomeSidebarAgentPanel({
		currentProjectId: projectRuntimeWorkspaceId,
		hasNoProjects,
		runtimeProjectConfig,
		clineSessionContextVersion,
		taskSessions: sessions,
		workspaceGit,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
	});
	const { runningShortcutLabel, handleSelectShortcutLabel, handleRunShortcut, handleCreateShortcut } =
		useShortcutActions({
			currentProjectId: projectRuntimeWorkspaceId,
			selectedShortcutLabel: runtimeProjectConfig?.selectedShortcutLabel,
			shortcuts,
			refreshRuntimeProjectConfig,
			prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
		});

	const persistWorkspaceStateAsync = useCallback(
		async (input: { workspaceId: string; payload: Parameters<typeof saveWorkspaceState>[1] }) =>
			await saveWorkspaceState(input.workspaceId, input.payload),
		[],
	);
	const handleWorkspaceStateConflict = useCallback(() => {
		showAppToast(
			{
				intent: "warning",
				icon: "warning-sign",
				message: "Workspace changed elsewhere. Synced latest state. Retry your last edit if needed.",
				timeout: 5000,
			},
			"workspace-state-conflict",
		);
	}, []);

	useWorkspacePersistence({
		board,
		sessions,
		currentProjectId: projectRuntimeWorkspaceId,
		workspaceRevision,
		hydrationNonce: workspaceHydrationNonce,
		canPersistWorkspaceState: canPersistWorkspaceState && !isCurrentProjectRuntimeUnavailable,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: refreshWorkspaceState,
		onWorkspaceRevisionChange: setWorkspaceRevision,
		onWorkspaceStateConflict: handleWorkspaceStateConflict,
	});

	useEffect(() => {
		if (!streamError) {
			lastStreamErrorRef.current = null;
			return;
		}
		if (isRuntimeDisconnected) {
			lastStreamErrorRef.current = streamError;
			return;
		}
		if (lastStreamErrorRef.current !== streamError) {
			notifyError(streamError, { key: `error:${streamError}` });
		}
		lastStreamErrorRef.current = streamError;
	}, [isRuntimeDisconnected, streamError]);

	useEffect(() => {
		if (!isCurrentProjectRuntimeUnavailable) {
			return;
		}
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setSelectedTaskId(null);
		resetTaskEditorState();
		resetTerminalPanelsState();
	}, [isCurrentProjectRuntimeUnavailable, resetTaskEditorState, resetTerminalPanelsState, setSelectedTaskId]);

	useEffect(() => {
		resetTaskEditorState();
		setIsClearTrashDialogOpen(false);
		resetGitActionState();
		resetProjectNavigationState();
		resetTerminalPanelsState();
	}, [
		currentProjectId,
		resetGitActionState,
		resetProjectNavigationState,
		resetTaskEditorState,
		resetTerminalPanelsState,
	]);

	useEffect(() => {
		if (selectedCard) {
			return;
		}
		if (hasNoProjects || !currentProjectId) {
			if (isHomeTerminalOpen) {
				closeHomeTerminal();
			}
			return;
		}
	}, [closeHomeTerminal, currentProjectId, hasNoProjects, isHomeTerminalOpen, selectedCard]);
	const showHomeBottomTerminal = !selectedCard && !hasNoProjects && isHomeTerminalOpen;
	const homeTerminalSubtitle = useMemo(
		() => workspacePath ?? navigationProjectPath ?? null,
		[navigationProjectPath, workspacePath],
	);

	const handleOpenSettings = useCallback((section?: RuntimeSettingsSection) => {
		setSettingsInitialSection(section ?? null);
		setIsSettingsOpen(true);
	}, []);
	const handleToggleGitHistory = useCallback(() => {
		if (hasNoProjects) {
			return;
		}
		setIsGitHistoryOpen((current) => {
			const next = !current;
			if (next) {
				setIsBoardOverviewOpen(false);
			}
			return next;
		});
	}, [hasNoProjects]);
	const handleCloseGitHistory = useCallback(() => {
		setIsGitHistoryOpen(false);
	}, []);

	const {
		handleProgrammaticCardMoveReady,
		handleCreateDependency,
		handleDeleteDependency,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		completeGuidedVerificationMoveToDone,
		isMoveToDoneConfirmOpen,
		confirmMoveToDone,
		cancelMoveToDone,
		handleMoveCardToValidation,
		handleMoveSelectedCardToValidation,
		handleMoveCardToReview,
		moveToReviewLoadingById,
		handleRestoreTaskFromTrash,
		handleOpenDeleteTask,
		handleCancelDeleteTask,
		handleConfirmDeleteTask,
		deleteTaskTarget,
		handleCancelAutomaticTaskAction,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
	} = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId,
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		stopTaskSession,
		transitionTaskToReview,
		cleanupTaskWorkspace,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput,
		readyForReviewNotificationsEnabled,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	} = useTaskStartActions({
		board,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	// Guided Verification：App.tsx 持有唯一一份 useGuidedVerification 实例，同时供顶栏 badge 派生待核对数、
	// 并作为 prop 下传给 GuidedVerificationController（controller 消费该结果，不再自持第二份实例）。
	// 单实例即消除了双实例各自 30s 轮询同一 endpoint、以及新部署时重复弹「检测到新部署」toast 的根因。
	const guidedVerification = useGuidedVerification(projectRuntimeWorkspaceId);
	const { setCollapsed: setGuidedVerificationCollapsed } = guidedVerification;
	const guidedVerificationActiveGroup = guidedVerification.activeGroup;
	// 待核对数 = active 组内未核对且未被 reconcile 移除的任务数；与面板 countPending 语义一致。
	// 未加载或无 active 组时为 null → 顶栏不渲染 badge（项目切换时 hook 会重置 hasLoadedOnce，badge 自动隐藏）。
	const guidedVerificationPendingCount =
		guidedVerification.hasLoadedOnce && guidedVerificationActiveGroup
			? guidedVerificationActiveGroup.tasks.filter((task) => task.verifiedAt === null && task.droppedReason === null)
					.length
			: null;
	// 顶栏 badge 与 controller 面板共用同一实例，setCollapsed(false) 直接展开面板，无需强制 remount。
	const handleOpenGuidedVerification = useCallback(() => {
		setGuidedVerificationCollapsed(false);
	}, [setGuidedVerificationCollapsed]);

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen,
		isHomeTerminalOpen: showHomeBottomTerminal,
		isHomeGitHistoryOpen: !selectedCard && isGitHistoryOpen,
		canUseCreateTaskShortcut: !hasNoProjects && projectRuntimeWorkspaceId !== null,
		handleToggleDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: handleToggleExpandHomeTerminal,
		handleOpenCreateTask,
		handleOpenSettings,
		handleToggleGitHistory,
		handleCloseGitHistory,
		onStartAllTasks: handleStartAllBacklogTasksFromBoard,
	});

	useEffect(() => {
		if (!pendingTaskStartAfterEditId) {
			return;
		}
		const selection = findCardSelection(board, pendingTaskStartAfterEditId);
		if (!selection || selection.column.id !== "backlog") {
			return;
		}
		handleStartTaskFromBoard(pendingTaskStartAfterEditId);
		setPendingTaskStartAfterEditId(null);
	}, [board, handleStartTaskFromBoard, pendingTaskStartAfterEditId]);

	const detailSession = selectedCard
		? (sessions[selectedCard.card.id] ?? createIdleTaskSession(selectedCard.card.id))
		: null;
	const detailTerminalSummary = detailTerminalTaskId ? (sessions[detailTerminalTaskId] ?? null) : null;
	const detailTerminalSubtitle = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return (
			getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			null
		);
	}, [selectedCard]);

	const runtimeHint = useMemo(() => {
		return getTaskAgentNavbarHint(runtimeProjectConfig, {
			shouldUseNavigationPath,
		});
	}, [runtimeProjectConfig, shouldUseNavigationPath]);

	const activeWorkspacePath = selectedCard
		? (getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef)?.path ??
			getTaskWorkspaceSnapshot(selectedCard.card.id)?.path ??
			workspacePath ??
			undefined)
		: shouldUseNavigationPath
			? (navigationProjectPath ?? undefined)
			: (workspacePath ?? undefined);

	const activeWorkspaceHint = useMemo(() => {
		if (!selectedCard) {
			return undefined;
		}
		const activeSelectedTaskWorkspaceInfo = getTaskWorkspaceInfo(selectedCard.card.id, selectedCard.card.baseRef);
		if (!activeSelectedTaskWorkspaceInfo) {
			return undefined;
		}
		if (!activeSelectedTaskWorkspaceInfo.exists) {
			return selectedCard.column.id === "trash" ? "Task worktree deleted" : "Task worktree not created yet";
		}
		return undefined;
	}, [selectedCard]);

	const sidebarLayout = useProjectNavigationLayout();
	const handleToggleSidebar = useCallback(() => {
		sidebarLayout.setSidebarCollapsed(!sidebarLayout.isCollapsed);
	}, [sidebarLayout]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		isCurrentProjectRuntimeUnavailable ||
		(!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending));

	const {
		openTargetOptions,
		selectedOpenTargetId,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	} = useOpenWorkspace({
		currentProjectId: projectRuntimeWorkspaceId,
		workspacePath: activeWorkspacePath,
	});
	const selectedTaskChatMessages = selectTaskChatMessagesForTask(selectedCard?.card.id, taskChatMessagesByTaskId);
	const latestSelectedTaskChatMessage = selectLatestTaskChatMessageForTask(
		selectedCard?.card.id,
		latestTaskChatMessage,
	);
	const defaultTaskClineProviderId =
		runtimeProjectConfig?.clineProviderSettings?.providerId ??
		runtimeProjectConfig?.clineProviderSettings?.oauthProvider ??
		null;
	const handleClineTaskSettingsChangedForTask = useCallback(
		({
			providerId,
			modelId,
			reasoningEffort,
		}: {
			providerId: string;
			modelId: string;
			reasoningEffort: RuntimeClineReasoningEffort | "";
		}) => {
			if (!selectedCard) {
				return;
			}
			const taskId = selectedCard.card.id;
			setBoard((currentBoard) => {
				const result = applyTaskDetailClineSettingsChange(
					currentBoard,
					taskId,
					{
						providerId,
						modelId,
						reasoningEffort,
					},
					{
						providerId: defaultTaskClineProviderId,
						modelId: runtimeProjectConfig?.clineProviderSettings?.modelId ?? null,
					},
				);
				return result.updated ? result.board : currentBoard;
			});
		},
		[defaultTaskClineProviderId, runtimeProjectConfig, selectedCard, setBoard],
	);

	const handleTaskCommentEntriesChange = useCallback(
		(taskId: string, taskCommentEntries: TaskCommentEntry[]) => {
			setBoard((currentBoard) => {
				const result = updateTaskCommentEntries(currentBoard, taskId, taskCommentEntries);
				return result.updated ? result.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleCreateDialogOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				if (editingTaskId) {
					handleCancelEditTask();
				} else {
					handleCancelCreateTask();
				}
			}
		},
		[editingTaskId, handleCancelCreateTask, handleCancelEditTask],
	);

	if (isRuntimeDisconnected) {
		return <RuntimeDisconnectedFallback />;
	}
	if (isKanbanAccessBlocked) {
		return <KanbanAccessBlockedFallback />;
	}

	return (
		<LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={resetBottomTerminalLayoutCustomizations}>
			<div className="flex h-[100svh] min-w-0 overflow-hidden">
				{!selectedCard ? (
					<ProjectNavigationPanel
						projects={displayedProjects}
						isLoadingProjects={isProjectListLoading}
						currentProjectId={navigationCurrentProjectId}
						permanentlyDeletingProjectId={permanentlyDeletingProjectId}
						activeSection={homeSidebarSection}
						onActiveSectionChange={setHomeSidebarSection}
						canShowAgentSection={!hasNoProjects && projectRuntimeWorkspaceId !== null}
						agentSectionContent={homeSidebarAgentPanel}
						selectedAgentId={settingsRuntimeProjectConfig?.selectedAgentId ?? null}
						clineProviderSettings={settingsRuntimeProjectConfig?.clineProviderSettings ?? null}
						featurebaseFeedbackState={featurebaseFeedbackState}
						onSelectProject={(projectId) => {
							void handleSelectProject(projectId);
						}}
						onGetPermanentDeletionPreview={handleGetPermanentDeletionPreview}
						onPermanentlyDeleteProjectData={handlePermanentlyDeleteProjectData}
						onAddProject={() => {
							void handleAddProject();
						}}
						sidebarWidth={sidebarLayout.sidebarWidth}
						setExpandedSidebarWidth={sidebarLayout.setExpandedSidebarWidth}
						isCollapsed={sidebarLayout.isCollapsed}
						setSidebarCollapsed={sidebarLayout.setSidebarCollapsed}
					/>
				) : null}
				<div className="flex flex-col flex-1 min-w-0 overflow-hidden">
					<TopBar
						onToggleSidebar={!selectedCard ? handleToggleSidebar : undefined}
						onToggleBoardOverview={
							!selectedCard && !hasNoProjects && !isCurrentProjectRuntimeUnavailable
								? handleToggleBoardOverview
								: undefined
						}
						isBoardOverviewOpen={isBoardOverviewOpen}
						onBack={selectedCard ? handleBack : undefined}
						workspacePath={navbarWorkspacePath}
						isWorkspacePathLoading={shouldShowProjectLoadingState}
						workspaceHint={navbarWorkspaceHint}
						runtimeHint={navbarRuntimeHint}
						selectedTaskId={selectedCard?.card.id ?? null}
						selectedTaskBaseRef={selectedCard?.card.baseRef ?? null}
						showHomeGitSummary={!hasNoProjects && !selectedCard && !isCurrentProjectRuntimeUnavailable}
						runningGitAction={
							selectedCard || hasNoProjects || isCurrentProjectRuntimeUnavailable ? null : runningGitAction
						}
						onGitFetch={
							selectedCard || isCurrentProjectRuntimeUnavailable
								? undefined
								: () => {
										void runGitAction("fetch");
									}
						}
						onGitPull={
							selectedCard || isCurrentProjectRuntimeUnavailable
								? undefined
								: () => {
										void runGitAction("pull");
									}
						}
						onGitPush={
							selectedCard || isCurrentProjectRuntimeUnavailable
								? undefined
								: () => {
										void runGitAction("push");
									}
						}
						onToggleTerminal={
							hasNoProjects || isCurrentProjectRuntimeUnavailable
								? undefined
								: selectedCard
									? handleToggleDetailTerminal
									: handleToggleHomeTerminal
						}
						isTerminalOpen={selectedCard ? isDetailTerminalOpen : showHomeBottomTerminal}
						isTerminalLoading={selectedCard ? isDetailTerminalStarting : isHomeTerminalStarting}
						onOpenSettings={handleOpenSettings}
						showDebugButton={debugModeEnabled}
						onOpenDebugDialog={debugModeEnabled ? handleOpenDebugDialog : undefined}
						shortcuts={shortcuts}
						selectedShortcutLabel={selectedShortcutLabel}
						onSelectShortcutLabel={handleSelectShortcutLabel}
						runningShortcutLabel={runningShortcutLabel}
						onRunShortcut={handleRunShortcut}
						onCreateFirstShortcut={projectRuntimeWorkspaceId ? handleCreateShortcut : undefined}
						openTargetOptions={openTargetOptions}
						selectedOpenTargetId={selectedOpenTargetId}
						onSelectOpenTarget={onSelectOpenTarget}
						onOpenWorkspace={onOpenWorkspace}
						canOpenWorkspace={canOpenWorkspace}
						isOpeningWorkspace={isOpeningWorkspace}
						onToggleGitHistory={
							hasNoProjects || isCurrentProjectRuntimeUnavailable ? undefined : handleToggleGitHistory
						}
						isGitHistoryOpen={isGitHistoryOpen}
						onToggleTaskChangesSidebar={
							selectedCard ? () => setIsTaskChangesSidebarOpen((open) => !open) : undefined
						}
						isTaskChangesSidebarOpen={selectedCard ? isTaskChangesSidebarOpen : false}
						hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
						connectionRetrySessions={connectionRetrySessions}
						onContinueConnectionRetrySessions={handleContinueConnectionRetrySessions}
						onDismissConnectionRetrySessions={handleDismissConnectionRetrySessions}
						notificationCenter={
							<NotificationCenter
								panelGroups={notificationCenter.panelGroups}
								allGroups={notificationCenter.allGroups}
								unreadCount={notificationCenter.unreadCount}
								onFocusTask={focusNotificationTask}
								onMarkGroupVisited={handleMarkTaskNotificationsVisited}
								onMarkAllVisited={notificationCenter.markAllVisited}
								onClearAll={notificationCenter.clearAll}
							/>
						}
						guidedVerificationPendingCount={guidedVerificationPendingCount}
						onOpenGuidedVerification={handleOpenGuidedVerification}
					/>
					<div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
						<div
							className="kb-home-layout"
							aria-hidden={selectedCard ? true : undefined}
							style={selectedCard ? { visibility: "hidden" } : undefined}
						>
							{shouldShowProjectLoadingState ? (
								<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0">
									<Spinner size={30} />
								</div>
							) : hasNoProjects ? (
								<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0 p-6">
									<div className="flex flex-col items-center justify-center gap-3 text-text-tertiary">
										<FolderOpen size={48} strokeWidth={1} />
										<h3 className="text-sm font-semibold text-text-primary">No projects yet</h3>
										<p className="text-[13px] text-text-secondary">
											Add a git repository to start using Kanban.
										</p>
										<Button
											variant="primary"
											onClick={() => {
												void handleAddProject();
											}}
										>
											Add Project
										</Button>
									</div>
								</div>
							) : currentUnavailableProject ? (
								<UnavailableProjectRuntimeState
									project={currentUnavailableProject}
									onRecheck={recheckProjectAvailability}
								/>
							) : (
								<div className="flex flex-1 flex-col min-h-0 min-w-0">
									<div className="flex flex-1 min-h-0 min-w-0">
										{isBoardOverviewOpen ? (
											<CrossRepositoryStageFirstOverview
												projects={projects}
												onOpenTask={handleOpenOverviewTask}
												onOpenStage={handleOpenOverviewStage}
											/>
										) : isGitHistoryOpen ? (
											<GitHistoryView
												workspaceId={currentProjectId}
												gitHistory={gitHistory}
												onCheckoutBranch={(branch) => {
													void switchHomeBranch(branch);
												}}
												onDiscardWorkingChanges={() => {
													void discardHomeWorkingChanges();
												}}
												isDiscardWorkingChangesPending={isDiscardingHomeWorkingChanges}
											/>
										) : (
											<div className="flex flex-1 flex-col min-h-0 min-w-0 bg-surface-0">
												<TaskBoardSearchToolbar
													query={taskSearchQuery}
													mode={taskSearchMode}
													visibleTaskCount={taskBoardSearch.visibleTaskCount}
													totalTaskCount={taskBoardSearch.totalTaskCount}
													semanticSearchStatus={taskBoardSearch.semanticSearchStatus}
													onQueryChange={setTaskSearchQuery}
													onModeChange={setTaskSearchMode}
												/>
												<KanbanBoard
													data={taskBoardSearch.filteredBoard}
													taskSessions={sessions}
													workspacePath={workspacePath}
													onCardSelect={handleCardSelect}
													onCreateTask={handleOpenCreateTask}
													onStartTask={handleStartTaskFromBoard}
													onStartAllTasks={handleStartAllBacklogTasksFromBoard}
													onClearTrash={handleOpenClearTrash}
													onEditTask={handleOpenEditTask}
													onSaveTaskTitle={handleSaveTaskTitle}
													onCommitTask={handleCommitTask}
													onOpenPrTask={handleOpenPrTask}
													onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
													commitTaskLoadingById={commitTaskLoadingById}
													openPrTaskLoadingById={openPrTaskLoadingById}
													moveToTrashLoadingById={moveToTrashLoadingById}
													moveToReviewLoadingById={moveToReviewLoadingById}
													onMoveToTrashTask={handleMoveReviewCardToTrash}
													onMoveToValidationTask={handleMoveCardToValidation}
													onMoveToReviewTask={handleMoveCardToReview}
													onRestoreFromTrashTask={handleRestoreTaskFromTrash}
													onDeleteTask={handleOpenDeleteTask}
													dependencies={taskBoardSearch.filteredDependencies}
													onCreateDependency={handleCreateDependency}
													onDeleteDependency={handleDeleteDependency}
													onRequestProgrammaticCardMoveReady={
														selectedCard || taskBoardSearch.isSearchActive
															? undefined
															: handleProgrammaticCardMoveReady
													}
													onDragEnd={handleDragEnd}
													defaultClineModelId={
														runtimeProjectConfig?.clineProviderSettings?.modelId ?? null
													}
													defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
													taskSearchResultById={taskBoardSearch.resultByTaskId}
													isCardDragDisabled={taskBoardSearch.isSearchActive}
												/>
											</div>
										)}
									</div>
									{showHomeBottomTerminal ? (
										<ResizableBottomPane
											minHeight={200}
											initialHeight={homeTerminalPaneHeight}
											onHeightChange={setHomeTerminalPaneHeight}
											onCollapse={collapseHomeTerminal}
											isExpanded={isHomeTerminalExpanded}
										>
											<div
												style={{
													display: "flex",
													flex: "1 1 0",
													minWidth: 0,
													paddingLeft: 12,
													paddingRight: 12,
												}}
											>
												<AgentTerminalPanel
													key={`home-shell-${homeTerminalTaskId}`}
													taskId={homeTerminalTaskId}
													workspaceId={currentProjectId}
													summary={homeTerminalSummary}
													onSummary={upsertSession}
													showSessionToolbar={false}
													autoFocus
													onClose={closeHomeTerminal}
													minimalHeaderTitle="Terminal"
													minimalHeaderSubtitle={homeTerminalSubtitle}
													panelBackgroundColor="var(--color-surface-1)"
													terminalBackgroundColor={terminalThemeColors.surfaceRaised}
													cursorColor={terminalThemeColors.textPrimary}
													onConnectionReady={markTerminalConnectionReady}
													agentCommand={agentCommand}
													onSendAgentCommand={handleSendAgentCommandToHomeTerminal}
													isExpanded={isHomeTerminalExpanded}
													onToggleExpand={handleToggleExpandHomeTerminal}
												/>
											</div>
										</ResizableBottomPane>
									) : null}
								</div>
							)}
						</div>
						{selectedCard && detailSession ? (
							<div className="absolute inset-0 flex min-h-0 min-w-0">
								<CardDetailView
									selection={selectedCard}
									currentProjectId={currentProjectId}
									workspacePath={workspacePath}
									selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
									runtimeConfig={runtimeProjectConfig ?? null}
									sessionSummary={detailSession}
									taskSessions={sessions}
									taskChatMessagesByTaskId={taskChatMessagesByTaskId}
									isTaskChangesSidebarOpen={isTaskChangesSidebarOpen}
									onCreateByTheWayTaskConversationSession={async (input) => {
										const effectiveAgentId =
											detailSession.agentId ??
											selectedCard.card.agentId ??
											runtimeProjectConfig?.selectedAgentId;
										if (
											!effectiveAgentId ||
											!(["cline", "claude", "codex"] as const).includes(
												effectiveAgentId as "cline" | "claude" | "codex",
											)
										) {
											return {
												ok: false,
												message: effectiveAgentId
													? `${effectiveAgentId} By the way sessions are not available.`
													: "No supported agent is selected.",
											};
										}
										return await createByTheWayTaskConversationSession({
											task: selectedCard.card,
											agentId: effectiveAgentId,
											...input,
										});
									}}
									onSessionSummary={upsertSession}
									onCardSelect={handleCardSelect}
									onTaskDragEnd={handleDetailTaskDragEnd}
									onCreateTask={handleOpenCreateTask}
									onStartTask={handleStartTaskFromBoard}
									onStartAllTasks={handleStartAllBacklogTasksFromBoard}
									onClearTrash={handleOpenClearTrash}
									onEditTask={(task) => {
										handleOpenEditTask(task, { preserveDetailSelection: true });
									}}
									onSaveTaskTitle={handleSaveTaskTitle}
									onCommitTask={handleCommitTask}
									onOpenPrTask={handleOpenPrTask}
									onAgentCommitTask={handleAgentCommitTask}
									onAgentOpenPrTask={handleAgentOpenPrTask}
									commitTaskLoadingById={commitTaskLoadingById}
									openPrTaskLoadingById={openPrTaskLoadingById}
									agentCommitTaskLoadingById={agentCommitTaskLoadingById}
									agentOpenPrTaskLoadingById={agentOpenPrTaskLoadingById}
									moveToTrashLoadingById={moveToTrashLoadingById}
									onMoveReviewCardToTrash={handleMoveReviewCardToTrash}
									onMoveReviewCardToValidation={handleMoveCardToValidation}
									onMoveCardToReview={handleMoveCardToReview}
									onRestoreTaskFromTrash={handleRestoreTaskFromTrash}
									onDeleteTask={handleOpenDeleteTask}
									onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
									onAddReviewComments={(taskId: string, text: string) => {
										void handleAddReviewComments(taskId, text);
									}}
									onSendReviewComments={(taskId: string, text: string) => {
										void handleSendReviewComments(taskId, text);
									}}
									onSendClineChatMessage={sendTaskChatMessage}
									onCancelClineChatTurn={cancelTaskChatTurn}
									onLoadClineChatMessages={fetchTaskChatMessages}
									latestClineChatMessage={latestSelectedTaskChatMessage}
									streamedClineChatMessages={selectedTaskChatMessages}
									onMoveToTrash={handleMoveToTrash}
									isMoveToTrashLoading={moveToTrashLoadingById[selectedCard.card.id] ?? false}
									onMoveToValidation={handleMoveSelectedCardToValidation}
									gitHistoryPanel={
										isGitHistoryOpen ? (
											<GitHistoryView workspaceId={currentProjectId} gitHistory={gitHistory} />
										) : undefined
									}
									onCloseGitHistory={handleCloseGitHistory}
									bottomTerminalOpen={isDetailTerminalOpen}
									bottomTerminalTaskId={detailTerminalTaskId}
									bottomTerminalSummary={detailTerminalSummary}
									bottomTerminalSubtitle={detailTerminalSubtitle}
									onBottomTerminalClose={closeDetailTerminal}
									onBottomTerminalCollapse={collapseDetailTerminal}
									bottomTerminalPaneHeight={detailTerminalPaneHeight}
									onBottomTerminalPaneHeightChange={setDetailTerminalPaneHeight}
									onBottomTerminalConnectionReady={markTerminalConnectionReady}
									bottomTerminalAgentCommand={agentCommand}
									onBottomTerminalSendAgentCommand={handleSendAgentCommandToDetailTerminal}
									isBottomTerminalExpanded={isDetailTerminalExpanded}
									onBottomTerminalToggleExpand={handleToggleExpandDetailTerminal}
									isDocumentVisible={isDocumentVisible}
									onClineSettingsSaved={refreshRuntimeProjectConfig}
									onTaskClineSettingsChanged={handleClineTaskSettingsChangedForTask}
									onTaskCommentEntriesChange={handleTaskCommentEntriesChange}
								/>
							</div>
						) : null}
					</div>
				</div>
				<RuntimeSettingsDialog
					open={isSettingsOpen}
					workspaceId={settingsWorkspaceId}
					initialConfig={settingsRuntimeProjectConfig}
					liveMcpAuthStatuses={latestMcpAuthStatuses}
					initialSection={settingsInitialSection}
					onOpenChange={(nextOpen) => {
						setIsSettingsOpen(nextOpen);
						if (!nextOpen) {
							setSettingsInitialSection(null);
						}
					}}
					onSaved={() => {
						refreshRuntimeProjectConfig();
						refreshSettingsRuntimeProjectConfig();
					}}
					onAccountSwitched={refreshKanbanAccess}
				/>
				<DebugDialog
					open={isDebugDialogOpen}
					onOpenChange={handleDebugDialogOpenChange}
					isResetAllStatePending={isResetAllStatePending}
					onShowStartupOnboardingDialog={handleShowStartupOnboardingDialog}
					onResetAllState={handleResetAllState}
				/>
				<TaskEditorDialog
					open={!isCurrentProjectRuntimeUnavailable && (isInlineTaskCreateOpen || editingTaskId !== null)}
					onOpenChange={handleCreateDialogOpenChange}
					taskEditorMode={editingTaskId ? "edit" : "create"}
					prompt={editingTaskId ? editTaskPrompt : newTaskPrompt}
					onPromptChange={editingTaskId ? setEditTaskPrompt : setNewTaskPrompt}
					images={editingTaskId ? editTaskImages : newTaskImages}
					onImagesChange={editingTaskId ? setEditTaskImages : setNewTaskImages}
					onCreate={editingTaskId ? handleSaveEditedTask : handleCreateTask}
					onCreateAndStart={
						editingTaskId
							? () => {
									handleSaveAndStartEditedTask();
									return editingTaskId;
								}
							: handleCreateAndStartTask
					}
					onCreateStartAndOpen={editingTaskId ? undefined : handleCreateStartAndOpenTask}
					onCreateMultiple={handleCreateTasks}
					onCreateAndStartMultiple={handleCreateAndStartTasks}
					startInPlanMode={editingTaskId ? editTaskStartInPlanMode : newTaskStartInPlanMode}
					onStartInPlanModeChange={editingTaskId ? setEditTaskStartInPlanMode : setNewTaskStartInPlanMode}
					startInPlanModeDisabled={
						editingTaskId ? isEditTaskStartInPlanModeDisabled : isNewTaskStartInPlanModeDisabled
					}
					autoReviewEnabled={editingTaskId ? editTaskAutoReviewEnabled : newTaskAutoReviewEnabled}
					onAutoReviewEnabledChange={editingTaskId ? setEditTaskAutoReviewEnabled : setNewTaskAutoReviewEnabled}
					autoReviewMode={editingTaskId ? editTaskAutoReviewMode : newTaskAutoReviewMode}
					onAutoReviewModeChange={editingTaskId ? setEditTaskAutoReviewMode : setNewTaskAutoReviewMode}
					workspaceId={projectRuntimeWorkspaceId}
					branchRef={editingTaskId ? editTaskBranchRef : newTaskBranchRef}
					branchOptions={editingTaskId ? editTaskBranchOptions : createTaskBranchOptions}
					onBranchRefChange={editingTaskId ? setEditTaskBranchRef : setNewTaskBranchRef}
					worktreeMode={editingTaskId ? editTaskWorktreeMode : newTaskWorktreeMode}
					onWorktreeModeChange={editingTaskId ? setEditTaskWorktreeMode : setNewTaskWorktreeMode}
					agentId={editingTaskId ? editTaskAgentId : newTaskAgentId}
					onAgentIdChange={editingTaskId ? setEditTaskAgentId : setNewTaskAgentId}
					clineSettings={editingTaskId ? editTaskClineSettings : newTaskClineSettings}
					onClineSettingsChange={editingTaskId ? setEditTaskClineSettings : setNewTaskClineSettings}
					terminalAgentModelOverrideSettings={
						editingTaskId ? editTaskTerminalAgentModelOverrideSettings : newTaskTerminalAgentModelOverrideSettings
					}
					onTerminalAgentModelOverrideSettingsChange={
						editingTaskId
							? setEditTaskTerminalAgentModelOverrideSettings
							: setNewTaskTerminalAgentModelOverrideSettings
					}
					taskAgentSessionInitialization={
						editingTaskId ? editTaskAgentSessionInitialization : newTaskAgentSessionInitialization
					}
					onTaskAgentSessionInitializationChange={
						editingTaskId ? setEditTaskAgentSessionInitialization : setNewTaskAgentSessionInitialization
					}
					agents={runtimeProjectConfig?.agents ?? []}
					defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
					defaultProviderId={defaultTaskClineProviderId}
					defaultModelId={runtimeProjectConfig?.clineProviderSettings?.modelId ?? null}
					defaultReasoningEffort={runtimeProjectConfig?.clineProviderSettings?.reasoningEffort ?? null}
				/>
				<ClearTrashDialog
					open={isClearTrashDialogOpen}
					taskCount={trashTaskCount}
					onCancel={() => setIsClearTrashDialogOpen(false)}
					onConfirm={handleConfirmClearTrash}
				/>
				<DeleteTaskDialog
					task={deleteTaskTarget}
					onCancel={handleCancelDeleteTask}
					onConfirm={handleConfirmDeleteTask}
				/>
				<StartupOnboardingDialog
					open={isStartupOnboardingDialogOpen}
					onClose={handleCloseStartupOnboardingDialog}
					selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
					agents={runtimeProjectConfig?.agents ?? []}
					clineProviderSettings={runtimeProjectConfig?.clineProviderSettings ?? null}
					workspaceId={currentProjectId}
					runtimeConfig={runtimeProjectConfig ?? null}
					onSelectAgent={handleSelectOnboardingAgent}
					onClineSetupSaved={handleOnboardingClineSetupSaved}
				/>

				<AddProjectDialog
					open={isAddProjectDialogOpen}
					onOpenChange={setIsAddProjectDialogOpen}
					onProjectAdded={handleAddProjectSuccess}
					currentProjectId={currentProjectId}
					initialGitInitPath={pendingNativeGitInitPath}
				/>

				<UpdateNotificationController />

				<SkipValidationConfirmDialog
					open={isMoveToDoneConfirmOpen}
					onCancel={cancelMoveToDone}
					onConfirm={confirmMoveToDone}
				/>

				<AlertDialog
					open={gitActionError !== null}
					onOpenChange={(open) => {
						if (!open) {
							clearGitActionError();
						}
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{gitActionErrorTitle}</AlertDialogTitle>
					</AlertDialogHeader>
					<AlertDialogBody>
						<p>{gitActionError?.message}</p>
						{gitActionError?.output ? (
							<pre className="max-h-[220px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs text-text-secondary whitespace-pre-wrap">
								{gitActionError.output}
							</pre>
						) : null}
					</AlertDialogBody>
					<AlertDialogFooter className="justify-end">
						<AlertDialogAction asChild>
							<Button variant="default" onClick={clearGitActionError}>
								Close
							</Button>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialog>

				<BugReportFab
					projects={projects}
					currentProjectId={currentProjectId}
					activeView={selectedTaskId ? `task:${selectedTaskId}` : "board"}
				/>

				<GuidedVerificationController
					verification={guidedVerification}
					board={board}
					completeGuidedVerificationMoveToDone={completeGuidedVerificationMoveToDone}
					onSelectTask={setSelectedTaskId}
				/>
			</div>
		</LayoutCustomizationsProvider>
	);
}
