// Leaf module (no React dependency) describing the persisted, user-resizable
// width of the detail/Focus view agent terminal panel. Extracted out of
// use-card-detail-layout.ts so non-React call sites (e.g. the task-start path
// in use-task-sessions.ts) can read the persisted width to derive the PTY
// spawn column count.
import { clampBetween } from "@/resize/resize-persistence";
import { loadResizePreference, type ResizeNumberPreference } from "@/resize/resize-preferences";
import {
	APPROX_TERMINAL_CELL_WIDTH_PX,
	TASK_SESSION_TERMINAL_COLS,
	TERMINAL_PANEL_CHROME_PX,
} from "@/runtime/task-session-geometry";
import { LocalStorageKey } from "@/storage/local-storage-store";

// Default panel width that exactly hosts TASK_SESSION_TERMINAL_COLS columns of
// terminal cells plus the non-terminal chrome — reversible with
// estimateColsForPanelWidth, so the default width round-trips back to 60 cols.
export const DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX =
	TASK_SESSION_TERMINAL_COLS * APPROX_TERMINAL_CELL_WIDTH_PX + TERMINAL_PANEL_CHROME_PX;
export const MIN_DETAIL_TERMINAL_PANEL_WIDTH_PX = 320;
export const MAX_DETAIL_TERMINAL_PANEL_WIDTH_PX = 1400;

export const DETAIL_TERMINAL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailTerminalPanelWidth,
	defaultValue: DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX,
	normalize: (value) =>
		clampBetween(value, MIN_DETAIL_TERMINAL_PANEL_WIDTH_PX, MAX_DETAIL_TERMINAL_PANEL_WIDTH_PX, true),
};

// Pure read of the persisted detail terminal panel width (already clamped to
// [MIN, MAX]). Safe to call outside React.
export function loadDetailTerminalPanelWidth(): number {
	return loadResizePreference(DETAIL_TERMINAL_WIDTH_PREFERENCE);
}
