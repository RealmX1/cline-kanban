import { useState } from "react";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";
import { useRawLocalStorageValue } from "@/utils/react-use";

/**
 * 顶栏项目切换器选中的范围（docs/context-stage-first-overview.md 的 Board Scope / Project Scope）：
 *   board_scope_all_projects —— 切换器首行「All projects」。看板页显示 Board Overview，Focus View 左栏显示跨项目
 *                               「最近活跃任务」切换面板；从面板里跨项目打开任务时范围不变，变的只是当前项目
 *                               （焦点任务所属的项目）。
 *   single_project_scope     —— 切换器里选了某个项目。看板页显示该项目看板，Focus View 左栏显示它的 stage 列表。
 *
 * 只能有一份状态：react-use 的 useLocalStorage 各实例互不同步，所以由 App 持有、经 props / 宿主 context 下发。
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

export function useSelectedBoardOrSingleProjectScope(): {
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
	setSelectedBoardOrSingleProjectScope: (scope: SelectedBoardOrSingleProjectScope) => void;
} {
	// 必须排在下面那个读存储的 hook 之前：首次渲染时它的初始化器先跑，迁移落盘后才被读到。
	useState(migrateLegacyFocusViewLeftColumnTaskListScopeIntoSelectedBoardOrSingleProjectScope);
	const [selectedBoardOrSingleProjectScope, setSelectedBoardOrSingleProjectScope] =
		useRawLocalStorageValue<SelectedBoardOrSingleProjectScope>(
			LocalStorageKey.SelectedBoardOrSingleProjectScope,
			"single_project_scope",
			normalizeSelectedBoardOrSingleProjectScope,
		);
	return { selectedBoardOrSingleProjectScope, setSelectedBoardOrSingleProjectScope };
}
