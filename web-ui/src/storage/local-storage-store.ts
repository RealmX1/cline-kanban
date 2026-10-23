export enum LocalStorageKey {
	TaskAutoReviewEnabled = "kanban.task-auto-review-enabled",
	TaskAutoReviewMode = "kanban.task-auto-review-mode",
	TaskEditDrafts = "kanban.task-edit-drafts.v1",
	AgentRaisedPendingUserDecisionAnswerDrafts = "kanban.agent-raised-pending-user-decision-answer-drafts.v1",
	TaskCreateTerminalAgentModelSelections = "kanban.task-create-terminal-agent-model-selections.v1",
	// projectId → 该项目上次成功建卡所用的 base ref。真相源在服务端 config.json，这里只是本地镜像
	// （服务端写失败时不丢用户这次的选择）。
	MostRecentlyUsedTaskCreateBaseRefByProject = "kanban.most-recently-used-task-create-base-ref-by-project.v1",
	AgentTipsDismissed = "kanban.agent-tips-dismissed",
	TaskCreatePrimaryStartAction = "kanban.task-create-primary-start-action",
	TaskConversationSessionReadReceipts = "kanban.task-conversation-session-read-receipts.v1",
	BottomTerminalPaneHeight = "kanban.bottom-terminal-pane-height",
	DetailAgentPanelRatio = "kanban.detail-agent-panel-ratio",
	DetailTerminalPanelWidth = "kanban.detail-terminal-panel-width",
	DetailTaskCardsPanelRatio = "kanban.detail-task-cards-panel-ratio",
	DetailDiffFileTreePanelRatio = "kanban.detail-diff-file-tree-panel-ratio",
	DetailExpandedDiffFileTreePanelRatio = "kanban.detail-expanded-diff-file-tree-panel-ratio",
	DetailRightPromptPanelRatio = "kanban.detail-right-prompt-panel-ratio",
	FocusViewDesktopPanelArrangementPreference = "kanban.focus-view-desktop-panel-arrangement-preference.v1",
	FocusViewStackedAgentPanelHeightRatio = "kanban.focus-view-stacked-agent-panel-height-ratio.v1",
	TaskWorkbenchModuleSlots = "kanban.task-workbench-module-slots.v1",
	TaskLookupWorkbenchModuleSlots = "kanban.task-lookup-workbench-module-slots.v1",
	TaskLookupConversationSelection = "kanban.task-lookup-conversation-selection.v1",
	TaskLookupQuestionDrafts = "kanban.task-lookup-question-drafts-by-conversation.v1",
	TaskLookupAgentPanelRatio = "kanban.task-lookup-agent-panel-ratio.v1",
	TaskLookupWorkbenchSlotRatio = "kanban.task-lookup-workbench-slot-ratio.v1",
	TaskWorkbenchSideBySideSlotWidthRatio = "kanban.task-workbench-side-by-side-slot-width-ratio.v1",
	// Prompt Library 的真相源已搬到服务端（~/.cline/kanban[/workspaces/<id>]/prompt-library.json）。
	// 下面三个键只剩「升级前留下的历史数据」这一个用途，由 prompt-library-migration-from-browser-local-storage.ts
	// 合并上去；合并按「桶 + 正文」去重且幂等，所以刻意**不删**它们——留着既是回退备份也不会造成重复。
	PromptLibraryGlobal = "kanban.prompt-library.global.v1",
	PromptLibraryByTask = "kanban.prompt-library.by-task.v1",
	PromptLibraryByProject = "kanban.prompt-library.by-project.v1",
	// workspaceId → 该 workspace 的历史 prompt 已合并进服务端的时刻。纯优化（省掉重复发送），
	// 不是正确性依赖：标记丢了最多多发一次请求。
	PromptLibraryUploadedToServerAt = "kanban.prompt-library.uploaded-to-server-at.v1",
	// 顶栏项目快速切换器：projectId → 最近一次成为「当前项目」的 epoch ms。用于 recency 排序与
	// Last visited 列。刻意不进 LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS——「重置布局」不该抹掉访问历史。
	RecentlyUsedProjectSwitchHistory = "kanban.recently-used-project-switch-history.v1",
	// 顶栏项目快速切换器：《红警》式编组槽位，slot(1-9) → projectId。同样不属于布局自定义。
	ProjectNumericSlotGroupAssignments = "kanban.project-numeric-slot-group-assignments.v1",
	ProjectSwitcherTableColumnVisibility = "kanban.project-switcher-table-column-visibility.v1",
	ProjectSwitcherTableSortOrder = "kanban.project-switcher-table-sort-order.v1",
	// ⌘K Spotlight：结果排序档与结果行字段开关。都是「看的方式」而非布局尺寸，
	// 故同样不进 LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS——「重置布局」不该把用户选的排序与字段抹掉。
	TaskSpotlightSearchResultSortOrder = "kanban.task-spotlight-search-result-sort-order.v1",
	TaskSpotlightSearchResultRowFieldVisibility = "kanban.task-spotlight-search-result-row-field-visibility.v1",
	// ⌘K Spotlight：最近用过的检索串（最新在前）。同样不属于布局自定义——「重置布局」不该抹掉检索历史。
	TaskSpotlightSearchQueryHistory = "kanban.task-spotlight-search-query-history.v1",
	// 曾经叫 `kb-sidebar-width`——本枚举里**唯一**没有 `kanban.` 前缀的键，按前缀扫描/导出/清理的逻辑
	// 都会漏掉它。改名后由 legacy-local-storage-key-rename-migration.ts 在启动时把旧键搬过来。
	ProjectNavigationPanelWidth = "kanban.project-navigation-panel-width",
	ProjectNavigationPanelCollapsed = "kanban.project-navigation-panel-collapsed",
	GitHistoryRefsPanelWidth = "kanban.git-history-refs-panel-width",
	GitHistoryCommitsPanelWidth = "kanban.git-history-commits-panel-width",
	GitDiffFileTreePanelRatio = "kanban.git-diff-file-tree-panel-ratio",
	OnboardingDialogShown = "kanban.onboarding.dialog.shown",
	NotificationPermissionPrompted = "kanban.notifications.permission-prompted",
	PreferredOpenTarget = "kanban.preferred-open-target",
	NotificationBadgeClearEvent = "kanban.notification-badge-clear.v1",
	TabVisibilityPresence = "kanban.tab-visibility-presence.v1",
	Theme = "kanban.theme",
	// Post-Deploy Verification 浮动面板的「保持最前」偏好（默认 true，由消费方 use-post-deploy-verification 兜底）。
	PostDeployVerificationStayInFront = "kanban.post-deploy-verification-stay-in-front",
	// Post-Deploy Verification 面板隐藏偏好，旧 key 保持兼容。
	PostDeployVerificationCollapsed = "kanban.post-deploy-verification-collapsed",
	// Task Pinboard（置顶板）折叠态。主看板顶部横条与 Focus View 左侧分段各自一个键：
	// 两处的纵向空间预算完全不同（横条挤的是整个看板高度，分段挤的是左列表），用户大概率不希望联动。
	TaskPinboardStripCollapsedOnKanbanBoard = "kanban.task-pinboard-strip-collapsed-on-kanban-board.v1",
	TaskPinboardSectionCollapsedInFocusView = "kanban.task-pinboard-section-collapsed-in-focus-view.v1",
	// 主看板（非 Focus View）各 stage 列的折叠显式覆盖与自定义列宽；缺省折叠集合见
	// state/kanban-board-column-collapse-and-width-preferences.ts。
	KanbanBoardColumnCollapsedOverrides = "kanban.kanban-board-column-collapsed-overrides.v1",
	KanbanBoardColumnCustomWidthsPx = "kanban.kanban-board-column-custom-widths-px.v1",
	// 顶栏项目切换器选中的范围：Board Scope（All projects，docs/context-board-scope-all-projects-and-single-project-scope.md）vs 单个项目。
	// 看板页据此在 All projects 首页（分区列看板）与项目看板之间切换，Focus View 左栏据此在跨项目切换面板与 stage 列表之间切换。
	// localStorage 里这份只是新开标签页的默认值；每个标签页的实际范围存在 sessionStorage 同名键里
	// （见 use-selected-board-or-single-project-scope）。便利项，丢了回落到单项目。
	SelectedBoardOrSingleProjectScope = "kanban.selected-board-or-single-project-scope.v1",
	// 已并入 SelectedBoardOrSingleProjectScope 的旧键（Focus View 左栏的 This project | All projects 两段切换）。
	// 只为一次性迁移保留，见 use-selected-board-or-single-project-scope。
	LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope = "kanban.focus-view-left-column-task-list-scope.v1",
	// 跨项目切换面板里 Running 区的展开态（默认收起成一行「Running N」）、Pinned 区的折叠态（默认展开，
	// 与 This project 置顶分段各自一个键）与剩余区的排序模式。
	CrossProjectTaskSwitcherRunningSectionExpanded = "kanban.cross-project-task-switcher-running-section-expanded.v1",
	CrossProjectTaskSwitcherPinnedSectionCollapsed = "kanban.cross-project-task-switcher-pinned-section-collapsed.v1",
	CrossProjectTaskSwitcherRemainingSectionOrderingMode = "kanban.cross-project-task-switcher-remaining-section-ordering-mode.v1",
}

export const LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS = [
	LocalStorageKey.BottomTerminalPaneHeight,
	LocalStorageKey.DetailAgentPanelRatio,
	LocalStorageKey.DetailTerminalPanelWidth,
	LocalStorageKey.DetailTaskCardsPanelRatio,
	LocalStorageKey.DetailDiffFileTreePanelRatio,
	LocalStorageKey.DetailExpandedDiffFileTreePanelRatio,
	LocalStorageKey.DetailRightPromptPanelRatio,
	LocalStorageKey.FocusViewDesktopPanelArrangementPreference,
	LocalStorageKey.FocusViewStackedAgentPanelHeightRatio,
	LocalStorageKey.TaskWorkbenchModuleSlots,
	LocalStorageKey.TaskLookupWorkbenchModuleSlots,
	LocalStorageKey.TaskLookupAgentPanelRatio,
	LocalStorageKey.TaskLookupWorkbenchSlotRatio,
	LocalStorageKey.TaskWorkbenchSideBySideSlotWidthRatio,
	LocalStorageKey.ProjectNavigationPanelWidth,
	LocalStorageKey.ProjectNavigationPanelCollapsed,
	LocalStorageKey.GitHistoryRefsPanelWidth,
	LocalStorageKey.GitHistoryCommitsPanelWidth,
	LocalStorageKey.GitDiffFileTreePanelRatio,
	LocalStorageKey.TaskPinboardStripCollapsedOnKanbanBoard,
	LocalStorageKey.TaskPinboardSectionCollapsedInFocusView,
	LocalStorageKey.KanbanBoardColumnCollapsedOverrides,
	LocalStorageKey.KanbanBoardColumnCustomWidthsPx,
] as const;

function getLocalStorage(): Storage | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readLocalStorageItem(key: LocalStorageKey): string | null {
	const storage = getLocalStorage();
	if (!storage) {
		return null;
	}
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

export function writeLocalStorageItem(key: LocalStorageKey, value: string): boolean {
	const storage = getLocalStorage();
	if (!storage) {
		return false;
	}
	try {
		storage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

export function removeLocalStorageItem(key: LocalStorageKey): void {
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.removeItem(key);
	} catch {
		// Ignore storage removal failures.
	}
}

export function resetLayoutCustomizationLocalStorageItems(): void {
	for (const key of LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS) {
		removeLocalStorageItem(key);
	}
}
