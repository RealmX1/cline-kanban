import { describe, expect, it } from "vitest";

import {
	clampPanelWidthToWindow,
	estimateColsForPanelWidth,
	estimateTaskAgentTerminalGeometry,
	estimateTaskSessionGeometry,
} from "@/runtime/task-session-geometry";

// Sibling diff panel minimum width (MIN_DETAIL_DIFF_PANEL_WIDTH_PX in the detail
// view). Inlined so this leaf geometry test stays React-free, matching the
// container-clamp semantics it mirrors.
const MIN_DETAIL_DIFF_PANEL_WIDTH_PX = 360;

describe("estimateTaskSessionGeometry", () => {
	it("uses fixed terminal width and near-full viewport height", () => {
		expect(estimateTaskSessionGeometry(1440, 900)).toEqual({
			cols: 60,
			rows: 53,
		});
	});

	it("keeps terminal columns independent of viewport width", () => {
		expect(estimateTaskSessionGeometry(900, 900).cols).toBe(60);
		expect(estimateTaskSessionGeometry(1800, 900).cols).toBe(60);
	});

	it("enforces minimum terminal dimensions", () => {
		expect(estimateTaskSessionGeometry(100, 100)).toEqual({
			cols: 60,
			rows: 12,
		});
	});
});

describe("estimateColsForPanelWidth", () => {
	it("is the inverse of the default panel width formula", () => {
		// 520px default panel = 60 cols * 8px + 40px chrome.
		expect(estimateColsForPanelWidth(520)).toBe(60);
	});

	it("derives columns from a wider, non-default panel width", () => {
		expect(estimateColsForPanelWidth(720)).toBe(85);
	});

	it("derives columns at the persisted clamp bounds", () => {
		expect(estimateColsForPanelWidth(320)).toBe(35);
		expect(estimateColsForPanelWidth(1400)).toBe(170);
	});

	it("never returns fewer than one column", () => {
		expect(estimateColsForPanelWidth(8)).toBe(1);
		expect(estimateColsForPanelWidth(0)).toBe(1);
	});
});

describe("clampPanelWidthToWindow", () => {
	it("clamps a persisted width that the current window cannot display", () => {
		// Persisted 1400px in a 1280px window: visible cap = 1280 − 360 = 920.
		expect(clampPanelWidthToWindow(1400, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, 1280)).toBe(920);
	});

	it("leaves a persisted width that fits the current window unchanged", () => {
		// Persisted 720px in a 1920px window: visible cap = 1560 > 720, no clamp.
		expect(clampPanelWidthToWindow(720, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, 1920)).toBe(720);
	});

	it("never narrows the persisted width when the viewport width is unavailable or unusable", () => {
		expect(clampPanelWidthToWindow(1400, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, 0)).toBe(1400);
		expect(clampPanelWidthToWindow(1400, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, Number.NaN)).toBe(1400);
		// Window so narrow the cap goes non-positive: fall back, don't return <=0.
		expect(clampPanelWidthToWindow(1400, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, 300)).toBe(1400);
	});

	it("keeps the derived PTY columns within the window's displayable width", () => {
		// The bug: persisted 1400px → 170 cols spawned even in a 1280px window
		// that can only render up to 920px → 110 cols.
		const persistedCols = estimateColsForPanelWidth(1400);
		const clampedCols = estimateColsForPanelWidth(
			clampPanelWidthToWindow(1400, MIN_DETAIL_DIFF_PANEL_WIDTH_PX, 1280),
		);
		expect(persistedCols).toBe(170);
		expect(clampedCols).toBe(110);
		expect(clampedCols).toBeLessThan(persistedCols);
	});
});

describe("estimateTaskAgentTerminalGeometry", () => {
	it("derives columns from the panel width and rows from the viewport height", () => {
		expect(estimateTaskAgentTerminalGeometry(520, 900)).toEqual({
			cols: 60,
			rows: 53,
		});
		expect(estimateTaskAgentTerminalGeometry(720, 900)).toEqual({
			cols: 85,
			rows: 53,
		});
	});

	it("enforces minimum terminal rows independent of panel width", () => {
		expect(estimateTaskAgentTerminalGeometry(720, 100)).toEqual({
			cols: 85,
			rows: 12,
		});
	});
});
