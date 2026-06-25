export const APPROX_TERMINAL_CELL_WIDTH_PX = 8;
const APPROX_TERMINAL_CELL_HEIGHT_PX = 16;
const APP_TOP_BAR_HEIGHT_PX = 40;
export const TASK_SESSION_TERMINAL_COLS = 60;
export const SHELL_SESSION_TERMINAL_COLS = 120;
const MIN_TERMINAL_ROWS = 12;
// Non-terminal horizontal chrome inside the agent terminal panel (padding /
// resize handle / borders) that does not host terminal cells. This is the
// `+ 40` baked into DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX, named so panel
// width <-> column count stays a single reversible formula.
export const TERMINAL_PANEL_CHROME_PX = 40;

export interface TaskSessionGeometry {
	cols: number;
	rows: number;
}

function estimateTerminalRows(viewportHeight: number): number {
	const safeViewportHeight = Math.max(0, viewportHeight - APP_TOP_BAR_HEIGHT_PX);
	return Math.max(MIN_TERMINAL_ROWS, Math.floor(safeViewportHeight / APPROX_TERMINAL_CELL_HEIGHT_PX));
}

export function estimateTaskSessionGeometry(_viewportWidth: number, viewportHeight: number): TaskSessionGeometry {
	return {
		cols: TASK_SESSION_TERMINAL_COLS,
		rows: estimateTerminalRows(viewportHeight),
	};
}

// Inverse of DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX's formula: how many
// terminal columns fit in a panel of the given pixel width. Reversible with
// the default panel width derivation, so estimateColsForPanelWidth(520) === 60.
export function estimateColsForPanelWidth(panelWidthPx: number): number {
	const cellAreaWidth = panelWidthPx - TERMINAL_PANEL_CHROME_PX;
	return Math.max(1, Math.floor(cellAreaWidth / APPROX_TERMINAL_CELL_WIDTH_PX));
}

// Upper-bound the persisted detail terminal panel width by what the CURRENT
// window can actually display, mirroring the detail view's own container clamp
// (`clampTerminalPanelWidthToContainer`: max panel width = container width −
// the sibling diff panel's minimum width). When a task is started in a narrower
// window than the one where the wide width was persisted, the unmounted-start
// path would otherwise spawn the PTY at the full persisted column count; the
// detail view then renders the agent panel narrower (min(persisted, container −
// minSiblingDiffPanelWidth)), and the TUI's already-hard-wrapped history can't
// be repaired by a later mount-time resize. Clamping here keeps the spawn width
// within reach of the visible width.
//
// `viewportWidth` approximates the detail terminal container width. It is a
// LOOSE upper bound: the real container is narrower (the task-cards panel and
// agent/diff split are subtracted from the window), and at start time the
// detail container is not mounted so its exact width is unknown. The loose
// bound still eliminates the severe "persisted 1400px into a narrow window"
// overflow; mount-time FitAddon geometry refines the rest. A non-finite or
// non-positive `viewportWidth` (e.g. `window` unavailable) safely returns the
// persisted width unchanged — never a narrower-than-current-behavior result.
export function clampPanelWidthToWindow(
	panelWidthPx: number,
	minSiblingDiffPanelWidthPx: number,
	viewportWidth: number,
): number {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
		return panelWidthPx;
	}
	const maxDisplayableWidth = viewportWidth - minSiblingDiffPanelWidthPx;
	if (!Number.isFinite(maxDisplayableWidth) || maxDisplayableWidth <= 0) {
		return panelWidthPx;
	}
	return Math.min(panelWidthPx, maxDisplayableWidth);
}

// Geometry for a task agent terminal whose visible width is the persisted,
// user-resizable detail terminal panel width. Used to spawn the PTY at the
// real width BEFORE the terminal is ever mounted, so a background-started TUI
// hard-wraps its history at the width the user will actually view it at.
export function estimateTaskAgentTerminalGeometry(panelWidthPx: number, viewportHeight: number): TaskSessionGeometry {
	return {
		cols: estimateColsForPanelWidth(panelWidthPx),
		rows: estimateTerminalRows(viewportHeight),
	};
}
