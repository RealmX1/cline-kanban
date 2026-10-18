// Main React composition root for the browser app.
// Keep this file focused on wiring top-level hooks and surfaces together, and
// push runtime-specific orchestration down into hooks and service modules.
import { resolveTaskAgentPermissionModeFromLegacyAutonomousFlag } from "@runtime-task-agent-permission-mode";
import { FolderOpen } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AddProjectDialog } from "@/components/add-project-dialog";
import { notifyError, showAppToast } from "@/components/app-toaster";
import { BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard } from "@/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board";
import { BugReportTriggerButton } from "@/components/bug-report/bug-report-trigger-button";
import { CardDetailView } from "@/components/card-detail-view";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import type { ConnectionRetrySessionView } from "@/components/connection-retry-indicator";
import { DebugDialog } from "@/components/debug-dialog";
import { DeleteTaskDialog } from "@/components/delete-task-dialog";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { FocusViewCrossProjectTaskOpenInTransitShell } from "@/components/detail-panels/focus-view-cross-project-task-open-in-transit-shell";
import { FindingsView } from "@/components/findings/findings-view";
import { GitHistoryView } from "@/components/git-history-view";
import { KanbanBoard } from "@/components/kanban-board";
import { NotificationCenter } from "@/components/notification-center";
import { PostDeployVerificationController } from "@/components/post-deploy-verification/post-deploy-verification-controller";
import { PostDeployVerificationUncheckedItemsClosureReasonDialog } from "@/components/post-deploy-verification/post-deploy-verification-unchecked-items-closure-reason-dialog";
import { ProjectNavigationPanel } from "@/components/project-navigation-panel";
import { RuntimeSettingsDialog, type RuntimeSettingsSection } from "@/components/runtime-settings-dialog";
import { SkipValidationConfirmDialog } from "@/components/skip-validation-confirm-dialog";
import { StartAllReadyBacklogTasksConfirmDialog } from "@/components/start-all-ready-backlog-tasks-confirm-dialog";
import { StartupOnboardingDialog } from "@/components/startup-onboarding-dialog";
import type { TaskCreationTargetProjectField } from "@/components/task-creation-target-project-field";
import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { TaskPinboardPinReasonDialog } from "@/components/task-pinboard-pin-reason-dialog";
import { TaskSpotlightSearchDialog } from "@/components/task-spotlight-search-dialog";
import { TopBar } from "@/components/top-bar";
import type { TopBarProjectSwitcherState } from "@/components/top-bar-project-switcher/top-bar-project-switcher";
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
import { useBacklogTaskEditorOpeningInAnyProject } from "@/hooks/use-backlog-task-editor-opening-in-any-project";
import { useBoardInteractions } from "@/hooks/use-board-interactions";
import { useCacheWarmTaskFocusNavigationAfterValidationMove } from "@/hooks/use-cache-warm-task-focus-navigation-after-validation-move";
import { useCrossProjectRecentlyActiveTaskSwitcherHost } from "@/hooks/use-cross-project-recently-active-task-switcher-host";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useCrossProjectTaskOpenInProject } from "@/hooks/use-cross-project-task-open-in-project";
import { useCurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansionOnBoardScopeHomePage } from "@/hooks/use-current-project-task-cards-for-cross-project-task-switcher-row-expansion-on-board-scope-home-page";
import { useDebugTools } from "@/hooks/use-debug-tools";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useExplorationThreadGraph } from "@/hooks/use-exploration-thread-graph";
import { useExploratoryFindings } from "@/hooks/use-exploratory-findings";
import { useFeaturebaseFeedbackWidget } from "@/hooks/use-featurebase-feedback-widget";
import { useGitActions } from "@/hooks/use-git-actions";
import { useHomeSidebarAgentPanel } from "@/hooks/use-home-sidebar-agent-panel";
import { useKanbanAccessGate } from "@/hooks/use-kanban-access-gate";
import { useMobileFocusViewCollapsibleControls } from "@/hooks/use-mobile-focus-view-collapsible-controls";
import { useNotificationCenter } from "@/hooks/use-notification-center";
import { useNotificationTaskFocus } from "@/hooks/use-notification-task-focus";
import { useNotificationTaskFocusRouting } from "@/hooks/use-notification-task-focus-routing";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { usePostDeployVerificationControllerInputsForBoardOrSingleProjectScope } from "@/hooks/use-post-deploy-verification-controller-inputs-for-board-or-single-project-scope";
import { usePostDeployVerificationForBoardOrSingleProjectScope } from "@/hooks/use-post-deploy-verification-for-board-or-single-project-scope";
import { useProjectNavigation } from "@/hooks/use-project-navigation";
import { useProjectNumericSlotGroupHotkeys } from "@/hooks/use-project-numeric-slot-group-hotkeys";
import { useProjectUiState } from "@/hooks/use-project-ui-state";
import { useQueuedTaskPromptDeliveryProjectionSync } from "@/hooks/use-queued-task-prompt-delivery-projection-sync";
import { useRecordTaskOpenedByUserOnRuntime } from "@/hooks/use-record-task-opened-by-user-on-runtime";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import { useSelectedBoardOrSingleProjectScope } from "@/hooks/use-selected-board-or-single-project-scope";
import { useShortcutActions } from "@/hooks/use-shortcut-actions";
import { useStartupOnboarding } from "@/hooks/use-startup-onboarding";
import { useTaskBranchOptions } from "@/hooks/use-task-branch-options";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useTaskSpotlightSearchController } from "@/hooks/use-task-spotlight-search-controller";
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
import type { StreamedTaskSessionSummariesApplier } from "@/runtime/use-runtime-state-stream";
import { useTerminalConnectionReady } from "@/runtime/use-terminal-connection-ready";
import { useMostRecentlyUsedTaskCreateBaseRefByProjectIdPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { fetchTaskWorkspaceInfoForWorkspace, saveWorkspaceState } from "@/runtime/workspace-state-query";
import { applyTaskDetailClineSettingsChange, findCardSelection, updateTaskCommentEntries } from "@/state/board-state";
import { applyPendingTaskCardCommandBoardOverlay } from "@/state/pending-task-card-command-board-overlay";
import { withWebUiBoardMutationInitiatorRecordedForChangedTaskCards } from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import {
	prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard,
	usePendingTaskCardCommandBoardOverlayEntries,
} from "@/stores/pending-task-card-command-board-overlay-store";
import { writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab } from "@/stores/workspace-metadata-probe-scope-declaration-inputs-of-browser-tab-store";
import {
	getTaskWorkspaceInfo,
	getTaskWorkspaceSnapshot,
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
} from "@/stores/workspace-metadata-store";
import { useTerminalThemeColors } from "@/terminal/theme-colors";
import type { BoardCard, BoardData, TaskCommentEntry } from "@/types";

export default function App(): ReactElement {
	const terminalThemeColors = useTerminalThemeColors();
	const [board, setBoard] = useState<BoardData>(() => createInitialBoardData());
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<RuntimeSettingsSection | null>(null);
	const [homeSidebarSection, setHomeSidebarSection] = useState<"projects" | "agent">("projects");
	const sidebarLayout = useProjectNavigationLayout();
	const [isClearTrashDialogOpen, setIsClearTrashDialogOpen] = useState(false);
	const [isGitHistoryOpen, setIsGitHistoryOpen] = useState(false);
	// Exploratory findings 浏览器开关（蓝图 §G.2）：isGitHistoryOpen 同款形态——
	// 开启时置换 home 主视图，非 overlay；与 git history / All projects 首页互斥。
	const [isFindingsOpen, setIsFindingsOpen] = useState(false);
	const [isTaskChangesSidebarOpen, setIsTaskChangesSidebarOpen] = useState(false);
	const [pendingTaskStartAfterEditId, setPendingTaskStartAfterEditId] = useState<string | null>(null);
	const taskEditorResetRef = useRef<() => void>(() => {});
	// useWorkspacePersistence 在本组件更下方才调用；切项目入口经这个 ref 先把旧项目防抖中的整板保存立刻发出。
	const flushPendingWorkspaceStatePersistImmediatelyRef = useRef<() => void>(() => {});
	const lastStreamErrorRef = useRef<string | null>(null);
	const handleProjectSwitchStart = useCallback(() => {
		flushPendingWorkspaceStatePersistImmediatelyRef.current();
		setCanPersistWorkspaceState(false);
		setIsGitHistoryOpen(false);
		setIsFindingsOpen(false);
		setPendingTaskStartAfterEditId(null);
		taskEditorResetRef.current();
	}, []);
	// task_sessions_updated（150ms 一批的最高频推流）旁路的中转 ref：useWorkspaceSync 往里注册
	// 「summaries → 一次 setSessions」的 applier，useRuntimeStateStream 收到批次经回调直接调用。
	// 这样该消息不再经 stream reducer 新建 workspaceState，App 每批只渲染一次而不是两次。
	const streamedTaskSessionSummariesApplierRef = useRef<StreamedTaskSessionSummariesApplier | null>(null);
	const handleStreamedTaskSessionSummaries = useCallback(
		(summaries: RuntimeTaskSessionSummary[], workspaceId: string) => {
			streamedTaskSessionSummariesApplierRef.current?.(summaries, workspaceId);
		},
		[],
	);
	// 只在本地未保存的改动与远端改了同一张卡的同一个面、被以远端为准丢弃时提示；能逐卡合并的（含本地新建的卡）不提示。
	const handleLocalUnsavedBoardChangesDiscardedByRemoteBoardChange = useCallback(() => {
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
	const {
		currentProjectId,
		projects,
		workspaceState: streamedWorkspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		taskReadyForReviewEvents,
		latestMcpAuthStatuses,
		exploratoryFindings: pushedExploratoryFindings,
		latestExplorationThreadGraphUpdate,
		queuedTaskPromptDeliveryProjectionsByTaskId: pushedQueuedTaskPromptDeliveryProjectionsByTaskId,
		streamSnapshotGeneration,
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
		lastVisitedEpochMsByProjectId,
		numericSlotGroupAssignments,
		numericSlotGroupNumberByProjectId,
		assignProjectToNumericSlotGroupNumber,
		clearNumericSlotGroupNumber,
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
		onTaskSessionSummaries: handleStreamedTaskSessionSummaries,
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
	// Exploratory findings（M2）：workspace 级集合的单一真相——初始 getFindings 查询 +
	// exploratory_findings_updated 推送归并；findings 浏览器 / map 面板切片 / 「存为 finding」
	// 查重共用这一份（不重连快照代数做断连窗口的重拉对齐信号）。
	const exploratoryFindingsData = useExploratoryFindings({
		workspaceId: projectRuntimeWorkspaceId,
		refreshKey: streamSnapshotGeneration,
		pushedFindings: pushedExploratoryFindings,
	});
	// 排队 prompt 投影：首屏拉取 + 推送归并 + 重连重拉，写进 per-task store（详情视图与看板卡片按 taskId 订阅）。
	useQueuedTaskPromptDeliveryProjectionSync({
		workspaceId: projectRuntimeWorkspaceId,
		refreshKey: streamSnapshotGeneration,
		pushedProjectedEntriesByTaskId: pushedQueuedTaskPromptDeliveryProjectionsByTaskId,
	});
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
		startTaskSession,
		createTaskConversationSession,
		continueConnectionRetrySessions,
		dismissConnectionRetrySessions,
		sendTaskSessionInput,
		sendTaskChatMessage,
		cancelTaskChatTurn,
		resolveTaskAgentUserDecision,
		fetchTaskChatMessages,
		fetchTaskWorkspaceInfo,
	} = useTaskSessions({
		currentProjectId: projectRuntimeWorkspaceId,
		setSessions,
	});
	const resolveTaskWorkspaceAbsoluteDirectoryPath = useCallback(
		async (card: BoardCard) =>
			projectRuntimeWorkspaceId
				? (
						await fetchTaskWorkspaceInfoForWorkspace(projectRuntimeWorkspaceId, {
							taskId: card.id,
							baseRef: card.baseRef,
							worktreeMode: card.worktreeMode,
						})
					).path
				: null,
		[projectRuntimeWorkspaceId],
	);

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
		projectIdOwningHydratedBoard,
		workspacePath,
		workspaceGit,
		workspaceRevision,
		workspaceHydrationNonce,
		latestWorkspaceBoardHydrationFromRuntime,
		recordWorkspaceBoardSavedByRuntime,
		isWorkspaceStateRefreshing,
		isWorkspaceMetadataPending,
		refreshWorkspaceState,
		resetWorkspaceSyncState,
	} = useWorkspaceSync({
		currentProjectId: projectRuntimeWorkspaceId,
		board,
		streamedWorkspaceState,
		streamedTaskSessionSummariesApplierRef,
		hasNoProjects,
		hasReceivedSnapshot,
		isDocumentVisible,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
		onLocalUnsavedBoardChangesDiscardedByRemoteBoardChange:
			handleLocalUnsavedBoardChangesDiscardedByRemoteBoardChange,
	});
	// 卡片动作命令（taskCardAction.*）在途期间的显示层，见 pending-task-card-command-board-overlay.ts：看板、Focus View
	// 与导航读 displayedBoard；会被整板保存的 board 不受影响（否则浏览器抢先保存的乐观结果会让服务端命令误判
	// 「已完成」而跳过停会话 / 删 worktree）。没有在途命令时二者是同一引用。
	const pendingTaskCardCommandBoardOverlayEntries =
		usePendingTaskCardCommandBoardOverlayEntries(projectRuntimeWorkspaceId);
	const displayedBoard = useMemo(
		() => applyPendingTaskCardCommandBoardOverlay(board, pendingTaskCardCommandBoardOverlayEntries),
		[board, pendingTaskCardCommandBoardOverlayEntries],
	);
	useEffect(() => {
		if (projectRuntimeWorkspaceId) {
			prunePendingTaskCardCommandBoardOverlayEntriesSatisfiedByBoard(projectRuntimeWorkspaceId, board);
		}
	}, [board, projectRuntimeWorkspaceId]);
	// 看板上此刻存在的任务 id。Prompt Library 靠它认出归属任务已被删掉的孤儿条目——判据必须是**当下**
	// 的看板，不能存进库里：trash 里的任务还能恢复，把一个会过期的判断固化进用户资产，任务一恢复它
	// 就开始撒谎。
	const taskIdsOnBoard = useMemo(
		() => new Set(board.columns.flatMap((column) => column.cards.map((card) => card.id))),
		[board],
	);

	const { selectedTaskId, selectedCard, setSelectedTaskId, handleBack } = useDetailTaskNavigation({
		board: displayedBoard,
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
	// exploration thread graph（B.2）：与 findings 不同，它是**按 exploration 分**的——作用域跟着
	// 当前选中的卡片走，所以必须放在 selectedCard 之后。读图免费（服务端不 fork），重连重拉无成本顾虑。
	const explorationThreadGraphData = useExplorationThreadGraph({
		workspaceId: projectRuntimeWorkspaceId,
		explorationId: selectedCard?.card.id ?? null,
		refreshKey: streamSnapshotGeneration,
		pushedUpdate: latestExplorationThreadGraphUpdate,
	});

	// 范围（顶栏项目切换器首行 All projects = Board Scope，见 docs/context-board-scope-all-projects-and-single-project-scope.md）：
	// 看板页据此在 All projects 首页（跨项目切换面板的分区横排成列）与当前项目看板之间切换，Focus View 左栏据此在
	// 跨项目切换面板与 stage 列表之间切换。下面还有跨-workspace 打开某 task 的待定跳转。
	const { selectedBoardOrSingleProjectScope, setSelectedBoardOrSingleProjectScope } =
		useSelectedBoardOrSingleProjectScope();
	const isBoardScopeAllProjectsSelected = selectedBoardOrSingleProjectScope === "board_scope_all_projects";
	const selectBoardScopeAllProjects = useCallback(() => {
		setSelectedBoardOrSingleProjectScope("board_scope_all_projects");
		setIsGitHistoryOpen(false);
		setIsFindingsOpen(false);
	}, [setSelectedBoardOrSingleProjectScope]);
	// 用户明确选了某个项目（顶栏切换器、数字槽热键、首页侧栏）：范围收窄到它。
	// 跨项目打开任务（面板、Spotlight、通知）不走这里——Board Scope 下点别的项目的任务，范围不变。
	const handleSelectProjectNarrowingToSingleProjectScope = useCallback(
		(projectId: string) => {
			setSelectedBoardOrSingleProjectScope("single_project_scope");
			handleSelectProject(projectId);
		},
		[handleSelectProject, setSelectedBoardOrSingleProjectScope],
	);
	// 后绑定：编辑对话框的打开函数在下方 useBoardInteractions 之后才有。
	const openBacklogTaskEditorForCrossProjectTaskOpenRef = useRef<(card: BoardCard) => void>(() => {});
	const isCurrentProjectBoardSettled =
		!isInitialRuntimeLoad && !isProjectSwitching && !isAwaitingWorkspaceSnapshot && !isWorkspaceMetadataPending;
	const {
		pendingCrossProjectTaskOpen,
		handleOpenTaskInProject,
		cancelPendingCrossProjectTaskOpenReturningToOriginTask,
		dismissPendingCrossProjectTaskOpen,
	} = useCrossProjectTaskOpenInProject({
		board,
		currentProjectId,
		projectIdOwningHydratedBoard,
		selectedTaskId,
		isDetailViewOpen: selectedCard !== null,
		isCurrentProjectBoardSettled,
		setSelectedTaskId,
		handleSelectProject,
		openBacklogTaskEditor: (card) => openBacklogTaskEditorForCrossProjectTaskOpenRef.current(card),
	});
	const selectedCardTaskId = selectedCard?.card.id ?? null;
	useRecordTaskOpenedByUserOnRuntime({
		workspaceId: projectRuntimeWorkspaceId,
		openedTaskId: selectedCardTaskId,
		isCurrentProjectBoardSettled,
	});
	// Spotlight 全局任务搜索（mod+k 呼出的纯结果列表弹层）。跨项目结果剔除：当前项目（实时 board 流更新鲜）
	// 与不可用项目（读盘/连接不可靠）。
	const crossProjectTaskSearchExcludeProjectIds = useMemo(() => {
		const excludeProjectIds = new Set<string>();
		if (currentProjectId) {
			excludeProjectIds.add(currentProjectId);
		}
		for (const project of projects) {
			if (project.availability.status === "unavailable") {
				excludeProjectIds.add(project.id);
			}
		}
		return excludeProjectIds;
	}, [currentProjectId, projects]);
	const taskSpotlightSearch = useTaskSpotlightSearchController({
		board,
		currentProjectId,
		currentProjectName: currentProjectSummary?.name ?? null,
		currentProjectDefaultAgentId: runtimeProjectConfig?.selectedAgentId ?? null,
		// 会话摘要只作为「搜索之后叠加」的展示/过滤/排序素材传入。**绝不能进 documents**——
		// 它每 tick 换引用，会把语义索引反复重建（见 controller 里叠加层那一段）。
		taskSessionSummariesByTaskId: sessions,
		canOpen: !hasNoProjects,
		crossProjectWorkspaceId: currentProjectId,
		crossProjectExcludeProjectIds: crossProjectTaskSearchExcludeProjectIds,
		onOpenTaskInProject: handleOpenTaskInProject,
	});
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
		permanentArchiveEnabled: true,
		selectedWorkspaceId: currentProjectId,
		notificationLogByWorkspaceId,
		selectedTaskId,
		onMarkTaskVisited: handleMarkTaskNotificationsVisited,
		onClearWorkspace: handleClearWorkspaceNotifications,
	});

	// 跨 repo 点击通知定位 task：同项目经统一入口选中（找不到卡时提示、不关 Focus）；跨项目经 SW 中转定位既有
	// 目标项目标签页，本 tab 保持不动；没有开着目标项目的标签页、或机制不可用时，本 tab 原地切项目。见 hook 内注释。
	const { focusNotificationTask } = useNotificationTaskFocusRouting({
		currentProjectId,
		isProjectSwitching,
		navigationCurrentProjectId,
		openTaskInProjectInPlace: handleOpenTaskInProject,
	});
	useNotificationTaskFocus({ openTaskInProjectInPlace: handleOpenTaskInProject });

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
		taskReadyForReviewEvents,
		taskSessions: sessions,
		readyForReviewNotificationsEnabled,
		notificationSoundEnabled,
		workspacePath,
		projects,
	});

	const [mostRecentlyUsedTaskCreateBaseRefByProjectId] = useMostRecentlyUsedTaskCreateBaseRefByProjectIdPreference();
	const rememberedTaskCreateBaseRefForCurrentProject = projectRuntimeWorkspaceId
		? (mostRecentlyUsedTaskCreateBaseRefByProjectId[projectRuntimeWorkspaceId] ?? null)
		: null;
	const {
		createTaskBranchOptions,
		editTaskBranchOptions,
		defaultTaskBranchRef,
		defaultCreateTaskBranchRef,
		rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists,
	} = useTaskBranchOptions({
		workspaceGit,
		rememberedTaskCreateBaseRefForCurrentProject,
	});
	const queueTaskStartAfterEdit = useCallback((taskId: string) => {
		setPendingTaskStartAfterEditId(taskId);
	}, []);
	// Board Scope 往其他项目建卡不切项目：提示建到了哪里，新卡随 projects 广播出现在 All projects 面板。
	const handleTaskCardsCreatedInOtherProject = useCallback(
		(workspaceId: string, createdTaskCardCount: number) => {
			const projectName = projects.find((project) => project.id === workspaceId)?.name ?? "another project";
			showAppToast({
				intent: "success",
				message:
					createdTaskCardCount === 1
						? `Created the task in ${projectName}`
						: `Created ${createdTaskCardCount} tasks in ${projectName}`,
				timeout: 4000,
			});
		},
		[projects],
	);

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAgentPermissionMode,
		setNewTaskAgentPermissionMode,
		newTaskConversationMode,
		setNewTaskConversationMode,
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
		editTaskName,
		setEditTaskName,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAgentPermissionMode,
		setEditTaskAgentPermissionMode,
		editTaskConversationMode,
		setEditTaskConversationMode,
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
		handleOpenEditTaskCardInOtherProject,
		editTaskWorkspaceId,
		editTaskBranchOptionsForEditTarget,
		taskCreationTargetWorkspaceId,
		taskCreationTargetOtherProjectWorkspaceId,
		handleOpenCreateTaskInBoardScope,
		handleSelectTaskCreationTargetProject,
		createTaskBranchOptionsForCreationTarget,
		resolvedDefaultCreateTaskBranchRefForCreationTarget,
		rememberedTaskCreateBaseRefForCreationTargetOtherProject,
		repositoryDefaultBranchRefOfCreationTargetOtherProject,
		handleCreateAndStartTaskInOtherProject,
		handleCreateAndStartTasksInOtherProject,
		handleCreateStartAndOpenTaskInOtherProject,
		editTaskFormSeededFromSavedDraftAt,
		handleRevertEditTaskFormToSavedTaskContent,
		handleAdoptPromotedTaskEditDraft,
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
		// 配置还没到（首屏）时回落 TUI —— 与运行时 DEFAULT_OMP_AGENT_SESSION_TRANSPORT_FOR_NEW_TASKS 同值。
		ompAgentSessionTransportForNewTasks: runtimeProjectConfig?.ompAgentSessionTransportForNewTasks ?? "pty_terminal",
		isNewTaskStartInPlanModeDefaultLoaded: runtimeProjectConfig !== null,
		// 全局那个旧开关如今只决定「新任务的默认权限档」，不再直接作用于会话启动。
		newTaskAgentPermissionModeByDefault: resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(
			runtimeProjectConfig?.agentAutonomousModeEnabled ?? true,
		),
		setSelectedTaskId,
		queueTaskStartAfterEdit,
		onTaskCardsCreatedInOtherProject: handleTaskCardsCreatedInOtherProject,
		openTaskInOtherProjectAfterStart: handleOpenTaskInProject,
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

	// Board Scope 的建卡框钉住了目标项目，与「当前项目」无关：在 All projects 面板里点别的项目的任务会切当前项目，
	// 那不该清掉正在填的建卡框。用 ref 读，免得建卡框开合本身触发下面两处重置。
	const isBoardScopeTaskCreateDialogOpenRef = useRef(false);
	isBoardScopeTaskCreateDialogOpenRef.current = isBoardScopeAllProjectsSelected && isInlineTaskCreateOpen;

	useEffect(() => {
		if (!isProjectSwitching || isBoardScopeTaskCreateDialogOpenRef.current) {
			return;
		}
		resetTaskEditorState();
	}, [isProjectSwitching, resetTaskEditorState]);

	// Board Scope 建卡入口（热键 c、跨项目面板与 All projects 首页的 Create task）：默认目标取上下文项目——
	// 跨项目打开在途时是目标项目，否则是当前项目（Focus View 的焦点任务总在当前项目里）。
	// EXPERIMENT_NODE: Board Scope 建卡默认目标项目取上下文项目，还是跨次记忆的上次所用项目
	const handleOpenCreateTaskInCurrentScope = useCallback(() => {
		if (!isBoardScopeAllProjectsSelected) {
			handleOpenCreateTask();
			return;
		}
		const defaultTargetWorkspaceId =
			pendingCrossProjectTaskOpen?.repoId ??
			currentProjectId ??
			projects.find((project) => project.availability.status === "available")?.id ??
			null;
		if (defaultTargetWorkspaceId) {
			handleOpenCreateTaskInBoardScope(defaultTargetWorkspaceId);
		}
	}, [
		currentProjectId,
		handleOpenCreateTask,
		handleOpenCreateTaskInBoardScope,
		isBoardScopeAllProjectsSelected,
		pendingCrossProjectTaskOpen?.repoId,
		projects,
	]);

	// 编辑对话框的「目标项目」字段：编辑其他项目的卡 → 只读标签；Board Scope 建卡 → 可选；单项目范围 → 不显示
	//（对话框与改动前一致）。
	const taskCreationTargetProjectFieldOfTaskEditorDialog = useMemo((): TaskCreationTargetProjectField | undefined => {
		if (editingTaskId) {
			if (!editTaskWorkspaceId || editTaskWorkspaceId === projectRuntimeWorkspaceId) {
				return undefined;
			}
			return {
				taskCreationTargetProjectFieldPresentation: "target_project_shown_read_only",
				projectName: projects.find((project) => project.id === editTaskWorkspaceId)?.name ?? editTaskWorkspaceId,
			};
		}
		if (!isBoardScopeAllProjectsSelected) {
			return undefined;
		}
		return {
			taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope",
			selectableProjects: projects
				.filter((project) => project.availability.status === "available")
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((project) => ({ workspaceId: project.id, projectName: project.name })),
			selectedTargetWorkspaceId: taskCreationTargetWorkspaceId,
			onSelectTargetWorkspaceId: handleSelectTaskCreationTargetProject,
		};
	}, [
		editTaskWorkspaceId,
		editingTaskId,
		handleSelectTaskCreationTargetProject,
		isBoardScopeAllProjectsSelected,
		projectRuntimeWorkspaceId,
		projects,
		taskCreationTargetWorkspaceId,
	]);

	const handleOpenEditTaskKeepingDetailSelection = useCallback(
		(task: BoardCard) => handleOpenEditTask(task, { preserveDetailSelection: true }),
		[handleOpenEditTask],
	);
	openBacklogTaskEditorForCrossProjectTaskOpenRef.current = handleOpenEditTaskKeepingDetailSelection;

	const {
		runningGitAction,
		taskGitActionLoadingByTaskId,
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
		taskConversationSessionSummariesByTaskId: sessions,
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
	// 侧边栏 agent 的懒启动门控：Kanban agent 分段此刻真的渲染在屏幕上时，才允许为当前 workspace 首次
	// spawn 终端会话。默认视图是 "projects"，agent 面板从未渲染，而 useHomeAgentSession 的终端启动
	// effect 过去无条件 startTaskSession，于是每个打开的标签页都为一个没人在看的面板拉起一个 agent 进程。
	// 判据必须是「此刻可见」而非「曾经打开过」：曾经打开过是 App 级单向闩锁，用户在 workspace A 打开一次
	// 之后，每切到一个新 workspace 都会为其静默 spawn 一个隐藏进程，懒启动对多项目用户即告失效。
	// 这里只门控「首次启动」——已启动的会话由 useHomeAgentSession 内部按 workspace+taskId 记住，切走分段、
	// 折叠侧边栏、进入任务详情、切换项目都不会停止它（侧边栏会话的对话内容零持久化，停掉即不可恢复）。
	const isHomeSidebarAgentSectionCurrentlyVisible =
		!selectedCard && !sidebarLayout.isCollapsed && homeSidebarSection === "agent";
	const homeSidebarAgentPanel = useHomeSidebarAgentPanel({
		currentProjectId: projectRuntimeWorkspaceId,
		hasNoProjects,
		runtimeProjectConfig,
		clineSessionContextVersion,
		taskSessions: sessions,
		workspaceGit,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		isHomeSidebarAgentSectionCurrentlyVisible,
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

	// 终端面板上「对话从未建立」的出路之一：以卡片原 prompt 全新开局（服务端会为这次开局分配新的原生会话 id）。
	// 面板只在人确认过 prompt 预览之后才调到这里。
	const handleStartFreshTaskSessionWithOriginalPrompt = useCallback(
		async (taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection) {
				notifyError("Card not found in the workspace board.");
				return;
			}
			const result = await startTaskSession(selection.card);
			if (!result.ok) {
				notifyError(result.message);
			}
		},
		[board, startTaskSession],
	);

	const { flushPendingWorkspaceStatePersistImmediately } = useWorkspacePersistence({
		board,
		sessions,
		currentProjectId: projectRuntimeWorkspaceId,
		workspaceRevision,
		hydrationNonce: workspaceHydrationNonce,
		latestWorkspaceBoardHydrationFromRuntime,
		canPersistWorkspaceState: canPersistWorkspaceState && !isCurrentProjectRuntimeUnavailable,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		persistWorkspaceState: persistWorkspaceStateAsync,
		refetchWorkspaceState: refreshWorkspaceState,
		onWorkspaceBoardSavedByRuntime: recordWorkspaceBoardSavedByRuntime,
	});
	flushPendingWorkspaceStatePersistImmediatelyRef.current = flushPendingWorkspaceStatePersistImmediately;

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
		setIsFindingsOpen(false);
		setSelectedTaskId(null);
		resetTaskEditorState();
		resetTerminalPanelsState();
	}, [isCurrentProjectRuntimeUnavailable, resetTaskEditorState, resetTerminalPanelsState, setSelectedTaskId]);

	useEffect(() => {
		if (!isBoardScopeTaskCreateDialogOpenRef.current) {
			resetTaskEditorState();
		}
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
				setSelectedBoardOrSingleProjectScope("single_project_scope");
				setIsFindingsOpen(false);
			}
			return next;
		});
	}, [hasNoProjects, setSelectedBoardOrSingleProjectScope]);
	const handleCloseGitHistory = useCallback(() => {
		setIsGitHistoryOpen(false);
	}, []);
	const handleToggleFindings = useCallback(() => {
		if (hasNoProjects) {
			return;
		}
		setIsFindingsOpen((current) => {
			const next = !current;
			if (next) {
				setSelectedBoardOrSingleProjectScope("single_project_scope");
				setIsGitHistoryOpen(false);
			}
			return next;
		});
	}, [hasNoProjects, setSelectedBoardOrSingleProjectScope]);

	// Post-Deploy Verification：App.tsx 持有唯一一份 usePostDeployVerification 实例（在下面这个 hook 里），同时供顶栏 badge
	// 派生待核对数、并作为 prop 下传给 PostDeployVerificationController（controller 消费该结果，不再自持第二份实例）。
	// 单实例即消除了双实例各自 30s 轮询同一 endpoint、以及新部署时重复弹「检测到新部署」toast 的根因。
	// 单项目范围绑定当前项目；All projects 下不跟随当前项目，绑定有部署组的项目（见 hook）。
	// 它也是看板「移入 Done」门禁预检的数据源（useBoardInteractions 读活跃组），所以必须在 useBoardInteractions 之前。
	const postDeployVerificationForBoardOrSingleProjectScope = usePostDeployVerificationForBoardOrSingleProjectScope({
		selectedBoardOrSingleProjectScope,
		currentProjectRuntimeWorkspaceId: projectRuntimeWorkspaceId,
		projectIdOwningHydratedBoard,
		projects,
		currentProjectDisplayedBoard: displayedBoard,
		currentProjectTaskSessions: sessions,
		currentProjectWorkspacePath: workspacePath ?? null,
	});
	const { postDeployVerification } = postDeployVerificationForBoardOrSingleProjectScope;
	const crossProjectTaskSwitcherSectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({
		isTaskSwitcherSectionModelActive:
			isBoardScopeAllProjectsSelected && !isRuntimeDisconnected && !isKanbanAccessBlocked,
		projects,
		notificationLogByWorkspaceId,
		currentProjectId,
	});
	const captureCacheWarmTaskFocusNavigationAfterValidationMove = useCacheWarmTaskFocusNavigationAfterValidationMove({
		isBoardScopeAllProjectsSelected,
		currentProjectId,
		selectedTaskId,
		isCrossProjectTaskOpenPending: pendingCrossProjectTaskOpen !== null,
		promptCacheWarmAwaitingUserEntries:
			crossProjectTaskSwitcherSectionsModel.sections.promptCacheWarmAwaitingUserEntries,
		onOpenTaskInProject: handleOpenTaskInProject,
	});

	const {
		handleProgrammaticCardMoveReady,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		completePostDeployVerificationMoveToDone,
		postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
		confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone,
		cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone,
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
		handleRequestPinTaskToTaskPinboard,
		handleRequestEditTaskPinboardPinReason,
		handleCancelTaskPinboardPinReason,
		handleConfirmTaskPinboardPinReason,
		handleUnpinTaskFromTaskPinboard,
		taskPinboardPinReasonRequest,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
	} = useBoardInteractions({
		captureCacheWarmTaskFocusNavigationAfterValidationMove,
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
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput,
		readyForReviewNotificationsEnabled,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck:
			postDeployVerificationForBoardOrSingleProjectScope.postDeployVerificationActiveDeploymentGroupForCurrentProjectDoneEntryGatePrecheck,
		refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection:
			postDeployVerificationForBoardOrSingleProjectScope.refreshPostDeployVerificationReadModelAfterCurrentProjectDoneEntryGateRejection,
	});

	const {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		pendingStartAllReadyBacklogTaskCards,
		requestStartAllReadyBacklogTasksConfirmation,
		confirmStartAllReadyBacklogTasks,
		cancelStartAllReadyBacklogTasksConfirmation,
	} = useTaskStartActions({
		board,
		currentProjectId,
		handleCreateTask,
		handleCreateTasks,
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId,
	});

	const { setCollapsed: setPostDeployVerificationCollapsed } = postDeployVerification;
	const postDeployVerificationPendingCount = postDeployVerification.pendingVerificationTaskCount;
	// 顶栏 badge 与 controller 面板共用同一实例，setCollapsed(false) 直接展开面板，无需强制 remount。
	const handleOpenPostDeployVerification = useCallback(() => {
		setPostDeployVerificationCollapsed(false);
	}, [setPostDeployVerificationCollapsed]);
	// PDV 面板条目上半部分是真实任务卡体：面板读浏览器里当前项目的 board 时，数据与动作和主看板同一份（条目上的
	// 「移入 Done」因此同样过门禁）；All projects 下读 runtime 快照时卡体只做展示（见 hook）。
	const {
		boardShownInPostDeployVerificationPanel,
		completePostDeployVerificationMoveToDone: completePostDeployVerificationMoveToDoneForPanelBoardSource,
		onSelectTaskInPostDeployVerificationPanel,
		realTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
		postDeployVerificationWorkspaceProjectNameShownInPanelHeader,
	} = usePostDeployVerificationControllerInputsForBoardOrSingleProjectScope({
		selectedBoardOrSingleProjectScope,
		postDeployVerificationForBoardOrSingleProjectScope,
		projects,
		currentProjectDisplayedBoard: displayedBoard,
		currentProjectTaskSessions: sessions,
		currentProjectWorkspacePath: workspacePath ?? null,
		completeCurrentProjectPostDeployVerificationMoveToDone: completePostDeployVerificationMoveToDone,
		setSelectedTaskId,
		handleCardSelect,
		handleOpenTaskInProject,
		defaultAgentIdOfCurrentProject: runtimeProjectConfig?.selectedAgentId ?? null,
		defaultClineModelIdOfCurrentProject: runtimeProjectConfig?.clineProviderSettings?.modelId ?? null,
		resolveTaskWorkspaceAbsoluteDirectoryPath,
		onStartTask: handleStartTaskFromBoard,
		onMoveToTrashTask: handleMoveReviewCardToTrash,
		onMoveToValidationTask: handleMoveCardToValidation,
		onMoveToReviewTask: handleMoveCardToReview,
		onRestoreFromTrashTask: handleRestoreTaskFromTrash,
		onDeleteTask: handleOpenDeleteTask,
		onCancelAutomaticTaskAction: handleCancelAutomaticTaskAction,
		onSaveTitle: handleSaveTaskTitle,
		onEditTask: handleOpenEditTaskKeepingDetailSelection,
		onRequestPinToTaskPinboard: handleRequestPinTaskToTaskPinboard,
		onUnpinFromTaskPinboard: handleUnpinTaskFromTaskPinboard,
		moveToTrashLoadingById,
		moveToReviewLoadingById,
	});

	// Board Scope 的 Focus View（含跨项目打开在途）里焦点任务所属的项目：在途时是目标项目。
	const boardScopeFocusViewFocusedTaskProjectId =
		pendingCrossProjectTaskOpen?.originatedFromFocusView === true
			? pendingCrossProjectTaskOpen.repoId
			: selectedCard
				? currentProjectId
				: null;
	// 状态流据此向服务端声明要哪些任务的 git 元数据：All projects 下只要焦点任务（跨项目打开在途时是目标任务）。
	const workspaceMetadataProbeFocusedTaskWorkspaceId = pendingCrossProjectTaskOpen
		? pendingCrossProjectTaskOpen.repoId
		: selectedCard
			? currentProjectId
			: null;
	const workspaceMetadataProbeFocusedTaskId = pendingCrossProjectTaskOpen
		? pendingCrossProjectTaskOpen.taskId
		: (selectedCard?.card.id ?? null);
	useEffect(() => {
		writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab({
			isBoardScopeAllProjectsSelected,
			focusedTaskInProject:
				workspaceMetadataProbeFocusedTaskWorkspaceId && workspaceMetadataProbeFocusedTaskId
					? {
							workspaceId: workspaceMetadataProbeFocusedTaskWorkspaceId,
							taskId: workspaceMetadataProbeFocusedTaskId,
						}
					: null,
		});
	}, [
		isBoardScopeAllProjectsSelected,
		workspaceMetadataProbeFocusedTaskId,
		workspaceMetadataProbeFocusedTaskWorkspaceId,
	]);
	// ⌘E 与顶栏 All projects 按钮：Board Scope ⇄ 焦点任务所属的项目（看板页没有焦点任务时是当前项目）。
	const handleToggleBetweenBoardScopeAndFocusedTaskProjectScope = useCallback(() => {
		if (!isBoardScopeAllProjectsSelected) {
			selectBoardScopeAllProjects();
			return;
		}
		const projectIdToNarrowTo =
			boardScopeFocusViewFocusedTaskProjectId ?? navigationCurrentProjectId ?? currentProjectId;
		if (!projectIdToNarrowTo) {
			return;
		}
		handleSelectProjectNarrowingToSingleProjectScope(projectIdToNarrowTo);
	}, [
		boardScopeFocusViewFocusedTaskProjectId,
		currentProjectId,
		handleSelectProjectNarrowingToSingleProjectScope,
		isBoardScopeAllProjectsSelected,
		navigationCurrentProjectId,
		selectBoardScopeAllProjects,
	]);

	useProjectNumericSlotGroupHotkeys({
		projects,
		currentProjectId,
		isBoardScopeAllProjectsSelected,
		numericSlotGroupAssignments,
		onSelectProject: handleSelectProjectNarrowingToSingleProjectScope,
		onAssignProjectToNumericSlotGroupNumber: assignProjectToNumericSlotGroupNumber,
	});

	useAppHotkeys({
		selectedCard,
		isDetailTerminalOpen,
		isHomeTerminalOpen: showHomeBottomTerminal,
		isHomeGitHistoryOpen: !selectedCard && isGitHistoryOpen,
		// Board Scope 下 c 打开带目标项目字段的建卡框（以前会悄悄建到当前项目）。
		canUseCreateTaskShortcut:
			!hasNoProjects && (projectRuntimeWorkspaceId !== null || isBoardScopeAllProjectsSelected),
		canUseTaskSpotlightSearch: taskSpotlightSearch.canOpen,
		handleToggleDetailTerminal,
		handleToggleHomeTerminal,
		handleToggleExpandDetailTerminal,
		handleToggleExpandHomeTerminal: handleToggleExpandHomeTerminal,
		handleOpenCreateTask: handleOpenCreateTaskInCurrentScope,
		handleToggleTaskSpotlightSearch: taskSpotlightSearch.toggle,
		handleOpenSettings,
		handleToggleGitHistory,
		handleCloseGitHistory,
		onRequestStartAllReadyBacklogTasks: requestStartAllReadyBacklogTasksConfirmation,
		handleToggleBetweenBoardScopeAndFocusedTaskProjectScope: hasNoProjects
			? null
			: handleToggleBetweenBoardScopeAndFocusedTaskProjectScope,
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

	const handleToggleSidebar = useCallback(() => {
		sidebarLayout.setSidebarCollapsed(!sidebarLayout.isCollapsed);
	}, [sidebarLayout]);

	const navbarWorkspacePath = hasNoProjects ? undefined : activeWorkspacePath;
	const navbarWorkspaceHint = hasNoProjects ? undefined : activeWorkspaceHint;
	const navbarRuntimeHint = hasNoProjects ? undefined : runtimeHint;
	const shouldHideProjectDependentTopBarActions =
		isCurrentProjectRuntimeUnavailable ||
		// 跨项目打开在途：屏幕上是过渡外壳，顶栏不该还挂着上一个任务的工作区路径、提示和运行动作。
		pendingCrossProjectTaskOpen?.originatedFromFocusView === true ||
		(!selectedCard && (isProjectSwitching || isAwaitingWorkspaceSnapshot || isWorkspaceMetadataPending));

	// 顶栏最左侧的项目快速切换器。用 displayedProjects 而非 projects：前者把当前项目的 taskCounts
	// 换成了本地 board 的实时计数，切换器里的数字才与主看板一致。
	const topBarProjectSwitcherState = useMemo<TopBarProjectSwitcherState>(
		() => ({
			projects: displayedProjects,
			currentProjectId,
			navigationCurrentProjectId,
			lastVisitedEpochMsByProjectId,
			numericSlotGroupNumberByProjectId,
			isProjectListLoading,
			isProjectSwitching,
			onSelectProject: handleSelectProjectNarrowingToSingleProjectScope,
			onAddProject: handleAddProject,
			onAssignProjectToNumericSlotGroupNumber: assignProjectToNumericSlotGroupNumber,
			onClearNumericSlotGroupNumber: clearNumericSlotGroupNumber,
			selectedBoardOrSingleProjectScope,
			onSelectBoardScopeAllProjects: selectBoardScopeAllProjects,
			boardScopeFocusViewFocusedTaskProjectId,
		}),
		[
			boardScopeFocusViewFocusedTaskProjectId,
			selectBoardScopeAllProjects,
			selectedBoardOrSingleProjectScope,
			assignProjectToNumericSlotGroupNumber,
			clearNumericSlotGroupNumber,
			currentProjectId,
			displayedProjects,
			handleAddProject,
			handleSelectProjectNarrowingToSingleProjectScope,
			isProjectListLoading,
			isProjectSwitching,
			lastVisitedEpochMsByProjectId,
			navigationCurrentProjectId,
			numericSlotGroupNumberByProjectId,
		],
	);

	const {
		openTargetOptions,
		openTargetOptionsFootnote,
		selectedOpenTargetId,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	} = useOpenWorkspace({
		currentProjectId: projectRuntimeWorkspaceId,
		workspacePath: activeWorkspacePath,
		runtimeHostRemoteEditorAccessIdentity: runtimeProjectConfig?.runtimeHostRemoteEditorAccessIdentity ?? null,
	});
	const selectedTaskChatMessages = selectTaskChatMessagesForTask(selectedCard?.card.id, taskChatMessagesByTaskId);

	// All projects 面板里点 backlog 行：原地打开任意项目那张卡的编辑对话框（不切项目）。
	const handleOpenBacklogTaskEditorInProject = useBacklogTaskEditorOpeningInAnyProject({
		currentProjectId: projectRuntimeWorkspaceId,
		currentProjectDisplayedBoard: displayedBoard,
		openTaskEditorForCurrentProjectTaskCardKeepingDetailSelection: handleOpenEditTaskKeepingDetailSelection,
		openTaskEditorForTaskCardInOtherProject: handleOpenEditTaskCardInOtherProject,
		openTaskInProject: handleOpenTaskInProject,
	});
	// 跨项目「最近活跃任务」切换面板（Focus View 左栏的 All projects 模式）的宿主数据与动作。
	const {
		crossProjectRecentlyActiveTaskSwitcherHost,
		isFocusViewCrossProjectTaskOpenInTransit,
		crossProjectTaskOpenInTransitTarget,
	} = useCrossProjectRecentlyActiveTaskSwitcherHost({
		crossProjectTaskSwitcherSectionsModel,
		projects,
		notificationLogByWorkspaceId,
		currentProjectId,
		isBoardScopeAllProjectsSelected,
		selectedCardTaskId,
		pendingCrossProjectTaskOpen,
		onOpenTaskInProject: handleOpenTaskInProject,
		onOpenBacklogTaskEditorInProject: handleOpenBacklogTaskEditorInProject,
		onRequestCreateTaskInBoardScope: handleOpenCreateTaskInCurrentScope,
		onRequestPinCurrentProjectTaskToTaskPinboard: handleRequestPinTaskToTaskPinboard,
		onUnpinCurrentProjectTaskFromTaskPinboard: handleUnpinTaskFromTaskPinboard,
		onEditCurrentProjectTaskPinboardPinReason: handleRequestEditTaskPinboardPinReason,
	});
	// All projects 首页分区列看板里，当前项目的行展开成完整卡片时与主看板同数据、同动作。
	const currentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansionOnBoardScopeHomePage =
		useCurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansionOnBoardScopeHomePage({
			isDisplayedBoardHydratedForCurrentProject:
				projectRuntimeWorkspaceId !== null && projectIdOwningHydratedBoard === projectRuntimeWorkspaceId,
			currentProjectDisplayedBoard: displayedBoard,
			currentProjectTaskSessions: sessions,
			currentProjectWorkspacePath: workspacePath ?? null,
			resolveTaskWorkspaceAbsoluteDirectoryPath,
			onStartTask: handleStartTaskFromBoard,
			onMoveToTrashTask: handleMoveReviewCardToTrash,
			onMoveToValidationTask: handleMoveCardToValidation,
			onMoveToReviewTask: handleMoveCardToReview,
			onRestoreFromTrashTask: handleRestoreTaskFromTrash,
			onDeleteTask: handleOpenDeleteTask,
			onSaveTitle: handleSaveTaskTitle,
			onEditTask: handleOpenEditTask,
			onRequestPinToTaskPinboard: handleRequestPinTaskToTaskPinboard,
			onUnpinFromTaskPinboard: handleUnpinTaskFromTaskPinboard,
			onCancelAutomaticTaskAction: handleCancelAutomaticTaskAction,
			moveToTrashLoadingById,
		});
	// Focus View 的外观（顶栏详情模式、隐藏首页布局与左侧项目栏、看板不挂载）在跨项目打开在途期间保持不变——
	// 否则一次跨项目打开会画出「旧详情 → 首页 / 看板 → 外壳 → 新详情」四个全屏状态。
	const isFocusViewChromeShown = selectedCard !== null || isFocusViewCrossProjectTaskOpenInTransit;
	// 详情页（含 agent 终端）真正渲染的那张卡：在途期间不渲染；board 装的还不是当前项目的数据时也不渲染——
	// 快照到达那一帧 currentProjectId 已是新项目、board 仍是旧项目的，拿旧卡配新 workspaceId 挂终端会在新项目里
	// 给同号任务建出一个幽灵终端，还可能把终端 LRU 里新项目已停放的热终端挤出去。
	// 顶栏「返回」：在途期间先丢掉在途态（导航照常落到目标项目、显示它的看板），再关详情。
	const handleBackFromFocusView = useCallback(() => {
		dismissPendingCrossProjectTaskOpen();
		handleBack();
	}, [dismissPendingCrossProjectTaskOpen, handleBack]);
	const selectedCardRenderedInFocusView =
		!isFocusViewCrossProjectTaskOpenInTransit && projectIdOwningHydratedBoard === projectRuntimeWorkspaceId
			? selectedCard
			: null;
	const mobileFocusViewControls = useMobileFocusViewCollapsibleControls({
		enabled: selectedCardRenderedInFocusView !== null,
		focusedTaskIdentity: JSON.stringify([currentProjectId, selectedCardRenderedInFocusView?.card.id ?? null]),
		isDocumentVisible,
	});
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
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
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
				}),
			);
		},
		[defaultTaskClineProviderId, runtimeProjectConfig, selectedCard, setBoard],
	);

	const handleTaskCommentEntriesChange = useCallback(
		(taskId: string, taskCommentEntries: TaskCommentEntry[]) => {
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const result = updateTaskCommentEntries(currentBoard, taskId, taskCommentEntries);
					return result.updated ? result.board : currentBoard;
				}),
			);
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
		<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={crossProjectRecentlyActiveTaskSwitcherHost}>
			<LayoutCustomizationsProvider
				onResetBottomTerminalLayoutCustomizations={resetBottomTerminalLayoutCustomizations}
			>
				<div
					ref={mobileFocusViewControls.focusViewRootRef}
					style={{ height: mobileFocusViewControls.visibleViewportHeightPx }}
					className="flex h-[100svh] min-w-0 overflow-hidden"
				>
					{!isFocusViewChromeShown ? (
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
								handleSelectProjectNarrowingToSingleProjectScope(projectId);
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
						<div
							hidden={
								mobileFocusViewControls.isEnabled && !mobileFocusViewControls.upperNavigationAndToolsExpanded
							}
							className="shrink-0"
							data-mobile-focus-view-global-navigation=""
							data-mobile-focus-view-collapsible-region=""
						>
							<TopBar
								onToggleSidebar={!isFocusViewChromeShown ? handleToggleSidebar : undefined}
								projectSwitcher={topBarProjectSwitcherState}
								onOpenTaskSpotlightSearch={taskSpotlightSearch.canOpen ? taskSpotlightSearch.open : undefined}
								onToggleBetweenBoardScopeAllProjectsAndSingleProjectScope={
									!isFocusViewChromeShown && !hasNoProjects && !isCurrentProjectRuntimeUnavailable
										? handleToggleBetweenBoardScopeAndFocusedTaskProjectScope
										: undefined
								}
								isBoardScopeAllProjectsSelected={isBoardScopeAllProjectsSelected}
								onBack={isFocusViewChromeShown ? handleBackFromFocusView : undefined}
								workspacePath={isFocusViewCrossProjectTaskOpenInTransit ? undefined : navbarWorkspacePath}
								isWorkspacePathLoading={shouldShowProjectLoadingState}
								workspaceHint={navbarWorkspaceHint}
								runtimeHint={navbarRuntimeHint}
								selectedTaskId={selectedCardRenderedInFocusView?.card.id ?? null}
								selectedTaskBaseRef={selectedCardRenderedInFocusView?.card.baseRef ?? null}
								showHomeGitSummary={
									!hasNoProjects && !isFocusViewChromeShown && !isCurrentProjectRuntimeUnavailable
								}
								runningGitAction={
									isFocusViewChromeShown || hasNoProjects || isCurrentProjectRuntimeUnavailable
										? null
										: runningGitAction
								}
								onGitFetch={
									isFocusViewChromeShown || isCurrentProjectRuntimeUnavailable
										? undefined
										: () => {
												void runGitAction("fetch");
											}
								}
								onGitPull={
									isFocusViewChromeShown || isCurrentProjectRuntimeUnavailable
										? undefined
										: () => {
												void runGitAction("pull");
											}
								}
								onGitPush={
									isFocusViewChromeShown || isCurrentProjectRuntimeUnavailable
										? undefined
										: () => {
												void runGitAction("push");
											}
								}
								onToggleTerminal={
									hasNoProjects ||
									isCurrentProjectRuntimeUnavailable ||
									isFocusViewCrossProjectTaskOpenInTransit
										? undefined
										: selectedCard
											? handleToggleDetailTerminal
											: handleToggleHomeTerminal
								}
								isTerminalOpen={
									isFocusViewCrossProjectTaskOpenInTransit
										? false
										: selectedCard
											? isDetailTerminalOpen
											: showHomeBottomTerminal
								}
								isTerminalLoading={
									isFocusViewCrossProjectTaskOpenInTransit
										? false
										: selectedCard
											? isDetailTerminalStarting
											: isHomeTerminalStarting
								}
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
								openTargetOptionsFootnote={openTargetOptionsFootnote}
								selectedOpenTargetId={selectedOpenTargetId}
								onSelectOpenTarget={onSelectOpenTarget}
								onOpenWorkspace={onOpenWorkspace}
								canOpenWorkspace={canOpenWorkspace}
								isOpeningWorkspace={isOpeningWorkspace}
								onToggleGitHistory={
									hasNoProjects || isCurrentProjectRuntimeUnavailable ? undefined : handleToggleGitHistory
								}
								isGitHistoryOpen={isGitHistoryOpen}
								onToggleFindings={
									!isFocusViewChromeShown && !hasNoProjects && !isCurrentProjectRuntimeUnavailable
										? handleToggleFindings
										: undefined
								}
								isFindingsOpen={isFindingsOpen}
								onToggleTaskChangesSidebar={
									selectedCardRenderedInFocusView
										? () => setIsTaskChangesSidebarOpen((open) => !open)
										: undefined
								}
								isTaskChangesSidebarOpen={selectedCardRenderedInFocusView ? isTaskChangesSidebarOpen : false}
								hideProjectDependentActions={shouldHideProjectDependentTopBarActions}
								connectionRetrySessions={connectionRetrySessions}
								onContinueConnectionRetrySessions={handleContinueConnectionRetrySessions}
								onDismissConnectionRetrySessions={handleDismissConnectionRetrySessions}
								notificationCenter={
									<NotificationCenter
										panelGroups={notificationCenter.panelGroups}
										onLoadMorePanelGroups={notificationCenter.loadMorePanelGroups}
										hasMorePanelGroups={notificationCenter.hasMorePanelGroups}
										archiveReadError={notificationCenter.archiveReadError}
										allGroups={notificationCenter.allGroups}
										allEntriesSortedByTriggeredAtDescending={
											notificationCenter.allEntriesSortedByTriggeredAtDescending
										}
										unreadCount={notificationCenter.unreadCount}
										onFocusTask={focusNotificationTask}
										onMarkGroupVisited={handleMarkTaskNotificationsVisited}
										onMarkAllPanelGroupsVisited={notificationCenter.markAllPanelGroupsVisited}
										onMarkAllHistoryGroupsVisited={notificationCenter.markAllHistoryGroupsVisited}
										onClearAll={notificationCenter.clearAll}
									/>
								}
								postDeployVerificationPendingCount={postDeployVerificationPendingCount}
								onOpenPostDeployVerification={handleOpenPostDeployVerification}
								bugReportTriggerButton={
									<BugReportTriggerButton
										projects={projects}
										currentProjectId={currentProjectId}
										activeView={selectedTaskId ? `task:${selectedTaskId}` : "board"}
									/>
								}
							/>
						</div>
						<div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
							<div
								className="kb-home-layout"
								aria-hidden={isFocusViewChromeShown ? true : undefined}
								style={isFocusViewChromeShown ? { visibility: "hidden" } : undefined}
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
											{/* Focus View 打开时真正卸载看板视图，而不是只让外层 `visibility: hidden`。
										    隐藏保留布局盒：两个 `DragDropContext`（看板 + Focus View 左侧栏）会同时挂载。
										    只卸载这一层：外层 wrapper 与底部 home 终端保持挂载——隐藏的 xterm
										    本就已暂停渲染，卸载它只会换来一次多余的重连 + 快照恢复。
										    列的滚动位置与渐进渲染进度由 `board-column-scroll-offset-store` 补回。 */}
											{isFocusViewChromeShown ? null : isBoardScopeAllProjectsSelected ? (
												<BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard
													host={crossProjectRecentlyActiveTaskSwitcherHost}
													currentProjectTaskCards={
														currentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansionOnBoardScopeHomePage
													}
													defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
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
											) : isFindingsOpen && currentProjectId ? (
												<FindingsView
													workspaceId={currentProjectId}
													findings={exploratoryFindingsData.findings}
													queryPhase={exploratoryFindingsData.queryPhase}
												/>
											) : (
												<div className="flex flex-1 flex-col min-h-0 min-w-0 bg-surface-0">
													<KanbanBoard
														data={displayedBoard}
														taskSessions={sessions}
														workspacePath={workspacePath}
														resolveTaskWorkspaceAbsoluteDirectoryPath={
															resolveTaskWorkspaceAbsoluteDirectoryPath
														}
														onCardSelect={handleCardSelect}
														onCreateTask={handleOpenCreateTask}
														onStartTask={handleStartTaskFromBoard}
														onRequestStartAllReadyBacklogTasks={
															requestStartAllReadyBacklogTasksConfirmation
														}
														onClearTrash={handleOpenClearTrash}
														onEditTask={handleOpenEditTask}
														onSaveTaskTitle={handleSaveTaskTitle}
														onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
														onRequestPinToTaskPinboard={handleRequestPinTaskToTaskPinboard}
														onUnpinFromTaskPinboard={handleUnpinTaskFromTaskPinboard}
														onEditTaskPinboardPinReason={handleRequestEditTaskPinboardPinReason}
														moveToTrashLoadingById={moveToTrashLoadingById}
														moveToReviewLoadingById={moveToReviewLoadingById}
														onMoveToTrashTask={handleMoveReviewCardToTrash}
														onMoveToValidationTask={handleMoveCardToValidation}
														onMoveToReviewTask={handleMoveCardToReview}
														onRestoreFromTrashTask={handleRestoreTaskFromTrash}
														onDeleteTask={handleOpenDeleteTask}
														onRequestProgrammaticCardMoveReady={
															isFocusViewChromeShown ? undefined : handleProgrammaticCardMoveReady
														}
														onDragEnd={handleDragEnd}
														defaultClineModelId={
															runtimeProjectConfig?.clineProviderSettings?.modelId ?? null
														}
														defaultAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
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
							{isFocusViewCrossProjectTaskOpenInTransit ? (
								<div className="absolute inset-0 flex min-h-0 min-w-0">
									<FocusViewCrossProjectTaskOpenInTransitShell
										host={crossProjectRecentlyActiveTaskSwitcherHost}
										targetProjectName={crossProjectTaskOpenInTransitTarget?.projectName ?? null}
										targetTaskTitle={crossProjectTaskOpenInTransitTarget?.taskTitle ?? null}
										onCancel={cancelPendingCrossProjectTaskOpenReturningToOriginTask}
									/>
								</div>
							) : selectedCardRenderedInFocusView && detailSession ? (
								<div className="absolute inset-0 flex min-h-0 min-w-0">
									<CardDetailView
										mobileFocusViewControls={mobileFocusViewControls}
										onBackToBoard={handleBackFromFocusView}
										selection={selectedCardRenderedInFocusView}
										currentProjectId={currentProjectId}
										taskIdsOnBoard={taskIdsOnBoard}
										workspacePath={workspacePath}
										resolveTaskWorkspaceAbsoluteDirectoryPath={resolveTaskWorkspaceAbsoluteDirectoryPath}
										selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
										runtimeConfig={runtimeProjectConfig ?? null}
										sessionSummary={detailSession}
										taskSessions={sessions}
										taskChatMessagesByTaskId={taskChatMessagesByTaskId}
										exploratoryFindings={exploratoryFindingsData.findings}
										explorationThreadGraph={explorationThreadGraphData}
										runtimeStreamSnapshotGeneration={streamSnapshotGeneration}
										isTaskChangesSidebarOpen={isTaskChangesSidebarOpen}
										onCreateTaskConversationSession={async (input) =>
											await createTaskConversationSession({
												task: selectedCardRenderedInFocusView.card,
												...input,
											})
										}
										onSessionSummary={upsertSession}
										onCardSelect={handleCardSelect}
										onTaskDragEnd={handleDetailTaskDragEnd}
										onCreateTask={handleOpenCreateTask}
										onStartTask={handleStartTaskFromBoard}
										onRequestStartAllReadyBacklogTasks={requestStartAllReadyBacklogTasksConfirmation}
										onClearTrash={handleOpenClearTrash}
										onEditTask={handleOpenEditTaskKeepingDetailSelection}
										onSaveTaskTitle={handleSaveTaskTitle}
										onAgentCommitTask={handleAgentCommitTask}
										onAgentOpenPrTask={handleAgentOpenPrTask}
										agentCommitTaskLoadingById={agentCommitTaskLoadingById}
										agentOpenPrTaskLoadingById={agentOpenPrTaskLoadingById}
										moveToTrashLoadingById={moveToTrashLoadingById}
										onMoveReviewCardToTrash={handleMoveReviewCardToTrash}
										onMoveReviewCardToValidation={handleMoveCardToValidation}
										onMoveCardToReview={handleMoveCardToReview}
										moveToReviewLoadingById={moveToReviewLoadingById}
										onRestoreTaskFromTrash={handleRestoreTaskFromTrash}
										onStartFreshTaskSessionWithOriginalPrompt={handleStartFreshTaskSessionWithOriginalPrompt}
										onDeleteTask={handleOpenDeleteTask}
										onCancelAutomaticTaskAction={handleCancelAutomaticTaskAction}
										onRequestPinToTaskPinboard={handleRequestPinTaskToTaskPinboard}
										onUnpinFromTaskPinboard={handleUnpinTaskFromTaskPinboard}
										onEditTaskPinboardPinReason={handleRequestEditTaskPinboardPinReason}
										onAddReviewComments={(taskId: string, text: string) => {
											void handleAddReviewComments(taskId, text);
										}}
										onSendReviewComments={(taskId: string, text: string) => {
											void handleSendReviewComments(taskId, text);
										}}
										onSendClineChatMessage={sendTaskChatMessage}
										onCancelClineChatTurn={cancelTaskChatTurn}
										onResolveTaskAgentUserDecision={resolveTaskAgentUserDecision}
										onLoadClineChatMessages={fetchTaskChatMessages}
										latestClineChatMessage={latestSelectedTaskChatMessage}
										streamedClineChatMessages={selectedTaskChatMessages}
										onMoveToTrash={handleMoveToTrash}
										isMoveToTrashLoading={
											moveToTrashLoadingById[selectedCardRenderedInFocusView.card.id] ?? false
										}
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
						editingTaskName={editTaskName}
						onEditingTaskNameChange={setEditTaskName}
						editingTaskId={editingTaskId}
						editTaskFormSeededFromSavedDraftAt={editTaskFormSeededFromSavedDraftAt}
						onRevertEditTaskFormToSavedTaskContent={handleRevertEditTaskFormToSavedTaskContent}
						onAdoptPromotedTaskEditDraft={handleAdoptPromotedTaskEditDraft}
						prompt={editingTaskId ? editTaskPrompt : newTaskPrompt}
						onPromptChange={editingTaskId ? setEditTaskPrompt : setNewTaskPrompt}
						images={editingTaskId ? editTaskImages : newTaskImages}
						onImagesChange={editingTaskId ? setEditTaskImages : setNewTaskImages}
						onOpenCreatedTaskWithRelations={handleOpenTaskInProject}
						onCreate={editingTaskId ? handleSaveEditedTask : handleCreateTask}
						onCreateAndStart={
							editingTaskId
								? (options) => {
										// options 必须原样转交：里面携带对话框本地草稿的 promptOverride，
										// 丢掉它会让「保存并启动」写回上一次上抛的旧文本。
										handleSaveAndStartEditedTask(options);
										return editingTaskId;
									}
								: taskCreationTargetOtherProjectWorkspaceId
									? handleCreateAndStartTaskInOtherProject
									: handleCreateAndStartTask
						}
						onCreateStartAndOpen={
							editingTaskId
								? undefined
								: taskCreationTargetOtherProjectWorkspaceId
									? handleCreateStartAndOpenTaskInOtherProject
									: handleCreateStartAndOpenTask
						}
						onCreateMultiple={handleCreateTasks}
						onCreateAndStartMultiple={
							taskCreationTargetOtherProjectWorkspaceId
								? handleCreateAndStartTasksInOtherProject
								: handleCreateAndStartTasks
						}
						startInPlanMode={editingTaskId ? editTaskStartInPlanMode : newTaskStartInPlanMode}
						onStartInPlanModeChange={editingTaskId ? setEditTaskStartInPlanMode : setNewTaskStartInPlanMode}
						taskAgentPermissionMode={editingTaskId ? editTaskAgentPermissionMode : newTaskAgentPermissionMode}
						onTaskAgentPermissionModeChange={
							editingTaskId ? setEditTaskAgentPermissionMode : setNewTaskAgentPermissionMode
						}
						taskConversationMode={editingTaskId ? editTaskConversationMode : newTaskConversationMode}
						onTaskConversationModeChange={
							editingTaskId ? setEditTaskConversationMode : setNewTaskConversationMode
						}
						startInPlanModeDisabled={
							editingTaskId ? isEditTaskStartInPlanModeDisabled : isNewTaskStartInPlanModeDisabled
						}
						autoReviewEnabled={editingTaskId ? editTaskAutoReviewEnabled : newTaskAutoReviewEnabled}
						onAutoReviewEnabledChange={editingTaskId ? setEditTaskAutoReviewEnabled : setNewTaskAutoReviewEnabled}
						autoReviewMode={editingTaskId ? editTaskAutoReviewMode : newTaskAutoReviewMode}
						onAutoReviewModeChange={editingTaskId ? setEditTaskAutoReviewMode : setNewTaskAutoReviewMode}
						// 编辑其他项目的卡（All projects 面板原地编辑）时，@file 搜索、会话起步列表、分支都按那个项目取。
						workspaceId={editingTaskId ? editTaskWorkspaceId : taskCreationTargetWorkspaceId}
						branchRef={editingTaskId ? editTaskBranchRef : newTaskBranchRef}
						branchOptions={
							editingTaskId ? editTaskBranchOptionsForEditTarget : createTaskBranchOptionsForCreationTarget
						}
						onBranchRefChange={editingTaskId ? setEditTaskBranchRef : setNewTaskBranchRef}
						taskCreateBaseRefRememberedForCurrentProject={
							taskCreationTargetOtherProjectWorkspaceId
								? rememberedTaskCreateBaseRefForCreationTargetOtherProject
								: rememberedTaskCreateBaseRefForCurrentProject
						}
						repositoryDefaultBranchRef={
							taskCreationTargetOtherProjectWorkspaceId
								? repositoryDefaultBranchRefOfCreationTargetOtherProject
								: (workspaceGit?.defaultBranch ?? null)
						}
						rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists={
							taskCreationTargetOtherProjectWorkspaceId
								? null
								: rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists
						}
						resolvedDefaultTaskCreateBaseRef={resolvedDefaultCreateTaskBranchRefForCreationTarget}
						taskCreationTargetProjectField={taskCreationTargetProjectFieldOfTaskEditorDialog}
						worktreeMode={editingTaskId ? editTaskWorktreeMode : newTaskWorktreeMode}
						onWorktreeModeChange={editingTaskId ? setEditTaskWorktreeMode : setNewTaskWorktreeMode}
						agentId={editingTaskId ? editTaskAgentId : newTaskAgentId}
						onAgentIdChange={editingTaskId ? setEditTaskAgentId : setNewTaskAgentId}
						clineSettings={editingTaskId ? editTaskClineSettings : newTaskClineSettings}
						onClineSettingsChange={editingTaskId ? setEditTaskClineSettings : setNewTaskClineSettings}
						terminalAgentModelOverrideSettings={
							editingTaskId
								? editTaskTerminalAgentModelOverrideSettings
								: newTaskTerminalAgentModelOverrideSettings
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
					<TaskPinboardPinReasonDialog
						request={taskPinboardPinReasonRequest}
						onCancel={handleCancelTaskPinboardPinReason}
						onConfirm={handleConfirmTaskPinboardPinReason}
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
					{postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone ? (
						<PostDeployVerificationUncheckedItemsClosureReasonDialog
							key={`board-move-into-done:${postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone.dialogRequest.taskId}`}
							dialogTitle="带原因移入 Done"
							taskEntries={postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone.taskEntries}
							taskEntrySelectionMode="single_task_entry_always_included"
							isSubmittingClosure={isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting}
							onCancel={cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone}
							onConfirmClosureRequestsBySelectedTaskId={
								confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone
							}
						/>
					) : null}

					<TaskSpotlightSearchDialog controller={taskSpotlightSearch} />

					<StartAllReadyBacklogTasksConfirmDialog
						tasks={pendingStartAllReadyBacklogTaskCards}
						onCancel={cancelStartAllReadyBacklogTasksConfirmation}
						onConfirm={confirmStartAllReadyBacklogTasks}
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

					{/* 面板该读的 board 还没到（快照未读到）时不挂，免得条目全显示「已从看板删除」；换绑 workspace 时重挂，
					    丢掉上一个 workspace 的在途完成流程。 */}
					{boardShownInPostDeployVerificationPanel ? (
						<PostDeployVerificationController
							key={
								postDeployVerificationForBoardOrSingleProjectScope.postDeployVerificationWorkspaceId ??
								"no-post-deploy-verification-workspace"
							}
							verification={postDeployVerification}
							board={boardShownInPostDeployVerificationPanel}
							completePostDeployVerificationMoveToDone={
								completePostDeployVerificationMoveToDoneForPanelBoardSource
							}
							onSelectTask={onSelectTaskInPostDeployVerificationPanel}
							onNavigateToBoard={() => setSelectedTaskId(null)}
							realTaskCardRenderingInputsForPostDeployVerificationPanelEntries={
								realTaskCardRenderingInputsForPostDeployVerificationPanelEntries
							}
							isBoardLevelDialogOpenThatMustCoverPostDeployVerificationPanel={
								postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone !== null ||
								isMoveToDoneConfirmOpen ||
								deleteTaskTarget !== null ||
								taskPinboardPinReasonRequest !== null ||
								editingTaskId !== null
							}
							postDeployVerificationWorkspaceProjectNameShownInPanelHeader={
								postDeployVerificationWorkspaceProjectNameShownInPanelHeader
							}
						/>
					) : null}
				</div>
			</LayoutCustomizationsProvider>
		</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
	);
}
