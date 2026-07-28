import { describe, expect, it } from "vitest";

import {
	DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY,
	normalizeProjectSwitcherTableColumnVisibility,
	TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS,
} from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";

describe("project switcher table column definitions", () => {
	it("keeps only the two load-bearing columns out of the toggle menu", () => {
		const toggleableColumnIds = TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS.map(
			(definition) => definition.id,
		);
		expect(toggleableColumnIds).not.toContain("project_name");
		expect(toggleableColumnIds).not.toContain("live_agent_task_count");
	});

	it("offers the numeric slot group column as a toggleable column that is visible by default", () => {
		const toggleableColumnIds = TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS.map(
			(definition) => definition.id,
		);
		expect(toggleableColumnIds).toContain("numeric_slot_group");
		expect(DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY.numeric_slot_group).toBe(true);
	});

	it("defaults to Awaiting you on and the duplicate task-distribution badges off", () => {
		expect(DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY.awaiting_user_task_count).toBe(true);
		expect(DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY.task_distribution_badges).toBe(false);
	});
});

describe("normalizeProjectSwitcherTableColumnVisibility", () => {
	it("falls back to defaults for malformed archives", () => {
		expect(normalizeProjectSwitcherTableColumnVisibility(["last_visited"])).toEqual(
			DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY,
		);
		expect(normalizeProjectSwitcherTableColumnVisibility(null)).toEqual(
			DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY,
		);
	});

	it("never lets an archive hide a non-toggleable column, but does honour a hidden numeric slot group column", () => {
		const normalized = normalizeProjectSwitcherTableColumnVisibility({
			project_name: false,
			numeric_slot_group: false,
			live_agent_task_count: false,
		});
		expect(normalized.project_name).toBe(true);
		expect(normalized.live_agent_task_count).toBe(true);
		// 编组槽位现在是可 toggle 的额外列，存档说关就该关。
		expect(normalized.numeric_slot_group).toBe(false);
	});

	it("honours stored toggles and ignores unknown column ids", () => {
		const normalized = normalizeProjectSwitcherTableColumnVisibility({
			last_visited: false,
			task_distribution_badges: true,
			some_removed_column: true,
		});
		expect(normalized.last_visited).toBe(false);
		expect(normalized.task_distribution_badges).toBe(true);
		expect(Object.keys(normalized)).not.toContain("some_removed_column");
	});
});
