import { useCallback, useState } from "react";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";

/**
 * 顶栏项目切换器选中的范围（docs/context-board-scope-all-projects-and-single-project-scope.md 的 Board Scope / Project Scope）：
 *   board_scope_all_projects —— 切换器首行「All projects」。看板页显示 All projects 首页（分区列看板），Focus View 左栏显示跨项目
 *                               「最近活跃任务」切换面板；从面板里跨项目打开任务时范围不变，变的只是当前项目
 *                               （焦点任务所属的项目）。
 *   single_project_scope     —— 切换器里选了某个项目。看板页显示该项目看板，Focus View 左栏显示它的 stage 列表。
 *
 * 只能有一份状态：由 App 持有、经 props / 宿主 context 下发。
 *
 * 每个标签页各存一份（sessionStorage，重载与 Chrome 丢弃后恢复都保留）；localStorage 只记「最后一次选的」，
 * 给新开的标签页当默认值。若两边共用 localStorage，重载时每个标签页都会继承最后写入者的范围——
 * 多标签页下「没做任何操作，范围自己变了」。
 */
export type SelectedBoardOrSingleProjectScope = "board_scope_all_projects" | "single_project_scope";

function normalizeSelectedBoardOrSingleProjectScope(value: string): SelectedBoardOrSingleProjectScope | null {
	return value === "board_scope_all_projects" || value === "single_project_scope" ? value : null;
}

// 旧键（Focus View 左栏的两段切换）只迁移一次：新键还没有时按旧值落一份，然后删掉旧键。
function migrateLegacyFocusViewLeftColumnTaskListScopeIntoSelectedBoardOrSingleProjectScope(): void {
	const legacyValue = readLocalStorageItem(
		LocalStorageKey.LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope,
	);
	if (legacyValue === null) {
		return;
	}
	if (readLocalStorageItem(LocalStorageKey.SelectedBoardOrSingleProjectScope) === null) {
		writeLocalStorageItem(
			LocalStorageKey.SelectedBoardOrSingleProjectScope,
			legacyValue === "all_projects_recently_active_task_switcher"
				? "board_scope_all_projects"
				: "single_project_scope",
		);
	}
	removeLocalStorageItem(
		LocalStorageKey.LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope,
	);
}

// sessionStorage 与 localStorage 用同一个键名，两边各存各的。
const SELECTED_BOARD_OR_SINGLE_PROJECT_SCOPE_OF_THIS_BROWSER_TAB_SESSION_STORAGE_KEY =
	LocalStorageKey.SelectedBoardOrSingleProjectScope;

function readSelectedBoardOrSingleProjectScopeOfThisBrowserTab(): string | null {
	try {
		return window.sessionStorage.getItem(
			SELECTED_BOARD_OR_SINGLE_PROJECT_SCOPE_OF_THIS_BROWSER_TAB_SESSION_STORAGE_KEY,
		);
	} catch {
		return null;
	}
}

function writeSelectedBoardOrSingleProjectScopeOfThisBrowserTab(scope: SelectedBoardOrSingleProjectScope): void {
	try {
		window.sessionStorage.setItem(
			SELECTED_BOARD_OR_SINGLE_PROJECT_SCOPE_OF_THIS_BROWSER_TAB_SESSION_STORAGE_KEY,
			scope,
		);
	} catch {
		// 存不了只是重载后回落到新标签页默认值。
	}
}

function readInitialSelectedBoardOrSingleProjectScopeOfThisBrowserTab(): SelectedBoardOrSingleProjectScope {
	migrateLegacyFocusViewLeftColumnTaskListScopeIntoSelectedBoardOrSingleProjectScope();
	const scopeOfThisBrowserTab = normalizeSelectedBoardOrSingleProjectScope(
		readSelectedBoardOrSingleProjectScopeOfThisBrowserTab() ?? "",
	);
	if (scopeOfThisBrowserTab) {
		return scopeOfThisBrowserTab;
	}
	const scopeDefaultForNewlyOpenedBrowserTabs =
		normalizeSelectedBoardOrSingleProjectScope(
			readLocalStorageItem(LocalStorageKey.SelectedBoardOrSingleProjectScope) ?? "",
		) ?? "single_project_scope";
	// 落一份到本标签页：之后别的标签页改了默认值，本页重载也不跟着变。
	writeSelectedBoardOrSingleProjectScopeOfThisBrowserTab(scopeDefaultForNewlyOpenedBrowserTabs);
	return scopeDefaultForNewlyOpenedBrowserTabs;
}

export function useSelectedBoardOrSingleProjectScope(): {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	setSelectedBoardOrSingleProjectScope: (scope: SelectedBoardOrSingleProjectScope) => void;
} {
	const [selectedBoardOrSingleProjectScope, setSelectedBoardOrSingleProjectScopeState] =
		useState<SelectedBoardOrSingleProjectScope>(readInitialSelectedBoardOrSingleProjectScopeOfThisBrowserTab);
	const setSelectedBoardOrSingleProjectScope = useCallback((scope: SelectedBoardOrSingleProjectScope) => {
		setSelectedBoardOrSingleProjectScopeState(scope);
		writeSelectedBoardOrSingleProjectScopeOfThisBrowserTab(scope);
		writeLocalStorageItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, scope);
	}, []);
	return { selectedBoardOrSingleProjectScope, setSelectedBoardOrSingleProjectScope };
}
