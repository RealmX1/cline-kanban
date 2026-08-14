import { beforeEach, describe, expect, it } from "vitest";

import {
	migrateRenamedLocalStorageKeysIntoCurrentKeys,
	RENAMED_LOCAL_STORAGE_KEY_MIGRATIONS,
} from "@/storage/legacy-local-storage-key-rename-migration";
import { LocalStorageKey } from "@/storage/local-storage-store";

const LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY = "kb-sidebar-width";

describe("被改名的 localStorage 键搬迁", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("把旧键下的值搬到新键并删掉旧键", () => {
		localStorage.setItem(LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY, "342");

		migrateRenamedLocalStorageKeysIntoCurrentKeys();

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBe("342");
		expect(localStorage.getItem(LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY)).toBeNull();
	});

	it("新键已有值时保留新值，只清理旧键", () => {
		localStorage.setItem(LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY, "342");
		localStorage.setItem(LocalStorageKey.ProjectNavigationPanelWidth, "521");

		migrateRenamedLocalStorageKeysIntoCurrentKeys();

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBe("521");
		expect(localStorage.getItem(LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY)).toBeNull();
	});

	it("重复调用是空操作：搬迁后再写新值不会被第二次搬迁顶掉", () => {
		localStorage.setItem(LEGACY_PROJECT_NAVIGATION_PANEL_WIDTH_KEY, "342");

		migrateRenamedLocalStorageKeysIntoCurrentKeys();
		localStorage.setItem(LocalStorageKey.ProjectNavigationPanelWidth, "480");
		migrateRenamedLocalStorageKeysIntoCurrentKeys();

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBe("480");
	});

	it("旧键不存在时什么都不写", () => {
		migrateRenamedLocalStorageKeysIntoCurrentKeys();

		expect(localStorage.getItem(LocalStorageKey.ProjectNavigationPanelWidth)).toBeNull();
	});

	it("每条搬迁的新键都带 kanban. 前缀——改名的目的就是让前缀扫描不再漏键", () => {
		for (const { currentKey } of RENAMED_LOCAL_STORAGE_KEY_MIGRATIONS) {
			expect(currentKey.startsWith("kanban.")).toBe(true);
		}
	});
});
