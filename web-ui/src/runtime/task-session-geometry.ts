export const APPROX_TERMINAL_CELL_WIDTH_PX = 8;
const APPROX_TERMINAL_CELL_HEIGHT_PX = 16;
const APP_TOP_BAR_HEIGHT_PX = 40;
export const TASK_SESSION_TERMINAL_COLS = 60;
export const SHELL_SESSION_TERMINAL_COLS = 120;
const MIN_TERMINAL_ROWS = 12;

export interface TaskSessionGeometry {
	cols: number;
	rows: number;
}

export function estimateTaskSessionGeometry(_viewportWidth: number, viewportHeight: number): TaskSessionGeometry {
	const safeViewportHeight = Math.max(0, viewportHeight - APP_TOP_BAR_HEIGHT_PX);

	return {
		cols: TASK_SESSION_TERMINAL_COLS,
		rows: Math.max(MIN_TERMINAL_ROWS, Math.floor(safeViewportHeight / APPROX_TERMINAL_CELL_HEIGHT_PX)),
	};
}
