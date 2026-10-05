import type { WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab } from "@runtime-state-stream-workspace-metadata-probe-scope-declaration";

import { LocalStorageKey } from "@/storage/local-storage-store";

/**
 * 本标签页向状态流声明 git 元数据探测范围所需的输入（范围 + 焦点任务）。
 *
 * 为什么是模块级 store 而不是 props：状态流在 useProjectNavigation 里建立，早于 App 算出范围与焦点任务（那两样
 * 又依赖状态流给的 board）。App 每次提交后写一次；跨项目打开在切项目**之前**同步写入目标任务，这样连新项目的
 * WS URL 就已带上新的焦点任务，首轮探测只探它。状态流在连接时读，之后订阅变化经 socket 发更新。
 */
function readBoardScopeAllProjectsSelectedOfThisBrowserTabAtModuleLoad(): boolean {
	// 与 use-selected-board-or-single-project-scope 同一份存储（只读）：页面一加载就在 Board Scope 时，首个连接
	// 不必先探整个项目。
	try {
		const scopeOfThisBrowserTab =
			window.sessionStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope) ??
			window.localStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope);
		return scopeOfThisBrowserTab === "board_scope_all_projects";
	} catch {
		return false;
	}
}

let workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab: WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab =
	{
		isBoardScopeAllProjectsSelected:
			typeof window === "undefined" ? false : readBoardScopeAllProjectsSelectedOfThisBrowserTabAtModuleLoad(),
		focusedTaskInProject: null,
	};
const workspaceMetadataProbeScopeDeclarationInputsListeners = new Set<() => void>();

export function readWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab(): WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab {
	return workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab;
}

export function writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab(
	patch: Partial<WorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab>,
): void {
	const nextInputs = { ...workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab, ...patch };
	if (
		nextInputs.isBoardScopeAllProjectsSelected ===
			workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab.isBoardScopeAllProjectsSelected &&
		nextInputs.focusedTaskInProject?.workspaceId ===
			workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab.focusedTaskInProject?.workspaceId &&
		nextInputs.focusedTaskInProject?.taskId ===
			workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab.focusedTaskInProject?.taskId
	) {
		return;
	}
	workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab = nextInputs;
	for (const listener of workspaceMetadataProbeScopeDeclarationInputsListeners) {
		listener();
	}
}

export function subscribeToWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab(listener: () => void): () => void {
	workspaceMetadataProbeScopeDeclarationInputsListeners.add(listener);
	return () => {
		workspaceMetadataProbeScopeDeclarationInputsListeners.delete(listener);
	};
}

/** 测试用：回到「单项目范围、无焦点任务」。 */
export function resetWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab(): void {
	workspaceMetadataProbeScopeDeclarationInputsOfBrowserTab = {
		isBoardScopeAllProjectsSelected: false,
		focusedTaskInProject: null,
	};
	workspaceMetadataProbeScopeDeclarationInputsListeners.clear();
}
