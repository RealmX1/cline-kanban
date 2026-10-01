import { describe, expect, it } from "vitest";

import {
	applyKanbanBoardColumnWidthToAllExpandedColumns,
	applyKanbanBoardColumnWidthToSingleColumn,
	clampKanbanBoardColumnWidthPx,
	clearKanbanBoardColumnCustomWidth,
	isKanbanBoardColumnCollapsedByDefault,
	KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX,
	KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX,
	normalizeKanbanBoardColumnCollapsedOverrides,
	normalizeKanbanBoardColumnCustomWidthsPx,
	resolveKanbanBoardColumnCollapsed,
	resolveKanbanBoardExpandedColumnFlexStyle,
	setKanbanBoardColumnCollapsedOverride,
	toggleKanbanBoardColumnCollapsedOverride,
} from "@/state/kanban-board-column-collapse-and-width-preferences";

describe("kanban board column collapse preferences", () => {
	it("collapses only validation and done (trash) by default", () => {
		expect(isKanbanBoardColumnCollapsedByDefault("backlog")).toBe(false);
		expect(isKanbanBoardColumnCollapsedByDefault("in_progress")).toBe(false);
		expect(isKanbanBoardColumnCollapsedByDefault("review")).toBe(false);
		expect(isKanbanBoardColumnCollapsedByDefault("validation")).toBe(true);
		expect(isKanbanBoardColumnCollapsedByDefault("trash")).toBe(true);
	});

	it("lets explicit overrides win over the default in both directions", () => {
		const overrides = { trash: false, backlog: true };
		expect(resolveKanbanBoardColumnCollapsed(overrides, "trash")).toBe(false);
		expect(resolveKanbanBoardColumnCollapsed(overrides, "backlog")).toBe(true);
		expect(resolveKanbanBoardColumnCollapsed(overrides, "validation")).toBe(true);
	});

	it("toggles any column relative to its resolved state", () => {
		const expandedDone = toggleKanbanBoardColumnCollapsedOverride({}, "trash");
		expect(expandedDone).toEqual({ trash: false });
		const collapsedReview = toggleKanbanBoardColumnCollapsedOverride(expandedDone, "review");
		expect(collapsedReview).toEqual({ trash: false, review: true });
		expect(toggleKanbanBoardColumnCollapsedOverride(collapsedReview, "review")).toEqual({
			trash: false,
			review: false,
		});
	});

	it("returns the same overrides reference when the resolved state already matches (no default frozen into an override)", () => {
		const emptyOverrides = {};
		expect(setKanbanBoardColumnCollapsedOverride(emptyOverrides, "backlog", false)).toBe(emptyOverrides);
		expect(setKanbanBoardColumnCollapsedOverride(emptyOverrides, "trash", true)).toBe(emptyOverrides);
		const explicitOverrides = { review: true };
		expect(setKanbanBoardColumnCollapsedOverride(explicitOverrides, "review", true)).toBe(explicitOverrides);
		expect(setKanbanBoardColumnCollapsedOverride(emptyOverrides, "trash", false)).toEqual({ trash: false });
	});

	it("drops unknown column ids and non-boolean values read back from storage", () => {
		expect(normalizeKanbanBoardColumnCollapsedOverrides({ trash: false, bogus: true, review: "yes" })).toEqual({
			trash: false,
		});
		expect(normalizeKanbanBoardColumnCollapsedOverrides(null)).toEqual({});
		expect(normalizeKanbanBoardColumnCollapsedOverrides([true])).toEqual({});
	});
});

describe("kanban board column width preferences", () => {
	it("clamps custom widths into the allowed range", () => {
		expect(clampKanbanBoardColumnWidthPx(10)).toBe(KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX);
		expect(clampKanbanBoardColumnWidthPx(99_999)).toBe(KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX);
		expect(clampKanbanBoardColumnWidthPx(321.6)).toBe(322);
	});

	it("sets one column without touching the others", () => {
		expect(applyKanbanBoardColumnWidthToSingleColumn({ backlog: 300 }, "review", 410)).toEqual({
			backlog: 300,
			review: 410,
		});
	});

	it("sets every expanded column to the same width and keeps collapsed columns' remembered width", () => {
		expect(
			applyKanbanBoardColumnWidthToAllExpandedColumns(
				{ backlog: 300, trash: 500 },
				["backlog", "in_progress", "review"],
				360,
			),
		).toEqual({ backlog: 360, in_progress: 360, review: 360, trash: 500 });
	});

	it("clears a single column back to auto fill", () => {
		expect(clearKanbanBoardColumnCustomWidth({ backlog: 300, review: 400 }, "backlog")).toEqual({ review: 400 });
		const unchanged = { review: 400 };
		expect(clearKanbanBoardColumnCustomWidth(unchanged, "backlog")).toBe(unchanged);
	});

	it("drops unknown ids and non-finite widths read back from storage, re-clamping the rest", () => {
		expect(
			normalizeKanbanBoardColumnCustomWidthsPx({ backlog: 50, review: Number.NaN, bogus: 300, trash: "300" }),
		).toEqual({ backlog: KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX });
	});

	it("uses flex fill for columns without a custom width and a fixed flex-basis otherwise", () => {
		expect(resolveKanbanBoardExpandedColumnFlexStyle({}, "backlog")).toEqual({ flex: "1 1 0" });
		expect(resolveKanbanBoardExpandedColumnFlexStyle({ backlog: 333 }, "backlog")).toEqual({ flex: "0 0 333px" });
	});
});
