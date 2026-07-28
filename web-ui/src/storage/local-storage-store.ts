export enum LocalStorageKey {
	TaskStartInPlanMode = "kanban.task-start-in-plan-mode",
	TaskAutoReviewEnabled = "kanban.task-auto-review-enabled",
	TaskAutoReviewMode = "kanban.task-auto-review-mode",
	TaskEditDrafts = "kanban.task-edit-drafts.v1",
	TaskCreateTerminalAgentModelSelections = "kanban.task-create-terminal-agent-model-selections.v1",
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
	PromptLibraryGlobal = "kanban.prompt-library.global.v1",
	PromptLibraryByTask = "kanban.prompt-library.by-task.v1",
	PromptLibraryByProject = "kanban.prompt-library.by-project.v1",
	// 顶栏项目快速切换器：projectId → 最近一次成为「当前项目」的 epoch ms。用于 recency 排序与
	// Last visited 列。刻意不进 LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS——「重置布局」不该抹掉访问历史。
	RecentlyUsedProjectSwitchHistory = "kanban.recently-used-project-switch-history.v1",
	// 顶栏项目快速切换器：《红警》式编组槽位，slot(1-9) → projectId。同样不属于布局自定义。
	ProjectNumericSlotGroupAssignments = "kanban.project-numeric-slot-group-assignments.v1",
	ProjectSwitcherTableColumnVisibility = "kanban.project-switcher-table-column-visibility.v1",
	ProjectSwitcherTableSortOrder = "kanban.project-switcher-table-sort-order.v1",
	ProjectNavigationPanelWidth = "kb-sidebar-width",
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
	// Post-Deploy Verification 面板折叠为右下角 badge 的偏好。
	PostDeployVerificationCollapsed = "kanban.post-deploy-verification-collapsed",
}

export const LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS = [
	LocalStorageKey.BottomTerminalPaneHeight,
	LocalStorageKey.DetailAgentPanelRatio,
	LocalStorageKey.DetailTerminalPanelWidth,
	LocalStorageKey.DetailTaskCardsPanelRatio,
	LocalStorageKey.DetailDiffFileTreePanelRatio,
	LocalStorageKey.DetailExpandedDiffFileTreePanelRatio,
	LocalStorageKey.DetailRightPromptPanelRatio,
	LocalStorageKey.ProjectNavigationPanelWidth,
	LocalStorageKey.ProjectNavigationPanelCollapsed,
	LocalStorageKey.GitHistoryRefsPanelWidth,
	LocalStorageKey.GitHistoryCommitsPanelWidth,
	LocalStorageKey.GitDiffFileTreePanelRatio,
] as const;

function getLocalStorage(): Storage | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window.localStorage;
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

export function writeLocalStorageItem(key: LocalStorageKey, value: string): void {
	const storage = getLocalStorage();
	if (!storage) {
		return;
	}
	try {
		storage.setItem(key, value);
	} catch {
		// Ignore storage write failures.
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
