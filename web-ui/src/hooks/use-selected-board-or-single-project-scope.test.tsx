import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type SelectedBoardOrSingleProjectScope,
	useSelectedBoardOrSingleProjectScope,
} from "@/hooks/use-selected-board-or-single-project-scope";
import { LocalStorageKey } from "@/storage/local-storage-store";

// 范围控件只有一份状态（顶栏切换器 All projects = Board Scope）；旧的 Focus View 左栏两段切换键一次性迁移过来。

let latestScope: SelectedBoardOrSingleProjectScope | null = null;
function Harness(): null {
	latestScope = useSelectedBoardOrSingleProjectScope().selectedBoardOrSingleProjectScope;
	return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	window.localStorage.clear();
	window.sessionStorage.clear();
	latestScope = null;
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
});

describe("useSelectedBoardOrSingleProjectScope", () => {
	it("默认单项目范围", () => {
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("single_project_scope");
	});

	it("旧键选的是 All projects：迁移为 Board Scope 并删掉旧键", () => {
		window.localStorage.setItem(
			LocalStorageKey.LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope,
			"all_projects_recently_active_task_switcher",
		);
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("board_scope_all_projects");
		expect(window.localStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope)).toBe(
			"board_scope_all_projects",
		);
		expect(
			window.localStorage.getItem(
				LocalStorageKey.LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope,
			),
		).toBeNull();
	});

	it("每个标签页各存一份：本页存过的范围优先于 localStorage 里别的标签页最后写下的值", () => {
		window.sessionStorage.setItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, "single_project_scope");
		window.localStorage.setItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, "board_scope_all_projects");
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("single_project_scope");
	});

	it("新开的标签页取 localStorage 的默认值，并落一份到本页", () => {
		window.localStorage.setItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, "board_scope_all_projects");
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("board_scope_all_projects");
		expect(window.sessionStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope)).toBe(
			"board_scope_all_projects",
		);
		// 别的标签页之后改了默认值，本页重载仍是自己的值。
		window.localStorage.setItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, "single_project_scope");
		act(() => root.unmount());
		root = createRoot(container);
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("board_scope_all_projects");
	});

	it("切换范围同时写本页与新标签页默认值", () => {
		let setScope: ((scope: SelectedBoardOrSingleProjectScope) => void) | null = null;
		function SettingHarness(): null {
			const result = useSelectedBoardOrSingleProjectScope();
			latestScope = result.selectedBoardOrSingleProjectScope;
			setScope = result.setSelectedBoardOrSingleProjectScope;
			return null;
		}
		act(() => root.render(<SettingHarness />));
		act(() => setScope?.("board_scope_all_projects"));
		expect(latestScope).toBe("board_scope_all_projects");
		expect(window.sessionStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope)).toBe(
			"board_scope_all_projects",
		);
		expect(window.localStorage.getItem(LocalStorageKey.SelectedBoardOrSingleProjectScope)).toBe(
			"board_scope_all_projects",
		);
	});

	it("新键已有值时不被旧键覆盖", () => {
		window.localStorage.setItem(LocalStorageKey.SelectedBoardOrSingleProjectScope, "single_project_scope");
		window.localStorage.setItem(
			LocalStorageKey.LegacyFocusViewLeftColumnTaskListScopeMigratedIntoSelectedBoardOrSingleProjectScope,
			"all_projects_recently_active_task_switcher",
		);
		act(() => root.render(<Harness />));
		expect(latestScope).toBe("single_project_scope");
	});
});
