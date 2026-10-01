import type { BoardColumnId } from "@/types";

/**
 * 主看板（非 Focus View）各 stage 列的「折叠 + 自定义宽度」偏好：纯函数层。
 *
 * - 折叠只存**显式覆盖**，缺省值由 `isKanbanBoardColumnCollapsedByDefault` 现算。
 *   这样以后调整默认折叠集合时，没碰过的列会跟着新默认走，不会被旧存档锁死。
 * - 宽度只存用户拖过的列（px）；未设置的列保持 `flex: 1 1 0` 填充剩余空间。
 */

export type KanbanBoardColumnCollapsedOverrides = Partial<Record<BoardColumnId, boolean>>;
export type KanbanBoardColumnCustomWidthsPx = Partial<Record<BoardColumnId, number>>;

export const KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX = 200;
export const KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX = 900;

const KANBAN_BOARD_COLUMN_IDS_COLLAPSED_BY_DEFAULT: ReadonlySet<BoardColumnId> = new Set<BoardColumnId>([
	"validation",
	"trash",
]);

const KNOWN_KANBAN_BOARD_COLUMN_IDS: ReadonlySet<string> = new Set<BoardColumnId>([
	"backlog",
	"in_progress",
	"review",
	"validation",
	"trash",
]);

function isKnownKanbanBoardColumnId(value: string): value is BoardColumnId {
	return KNOWN_KANBAN_BOARD_COLUMN_IDS.has(value);
}

export function isKanbanBoardColumnCollapsedByDefault(columnId: BoardColumnId): boolean {
	return KANBAN_BOARD_COLUMN_IDS_COLLAPSED_BY_DEFAULT.has(columnId);
}

export function resolveKanbanBoardColumnCollapsed(
	overrides: KanbanBoardColumnCollapsedOverrides,
	columnId: BoardColumnId,
): boolean {
	return overrides[columnId] ?? isKanbanBoardColumnCollapsedByDefault(columnId);
}

export function setKanbanBoardColumnCollapsedOverride(
	overrides: KanbanBoardColumnCollapsedOverrides,
	columnId: BoardColumnId,
	collapsed: boolean,
): KanbanBoardColumnCollapsedOverrides {
	// 解析值已是目标值就原样返回：不把当前默认固化成显式覆盖（否则该列再也不跟随将来的新默认），也省一次写盘。
	if (resolveKanbanBoardColumnCollapsed(overrides, columnId) === collapsed) {
		return overrides;
	}
	return { ...overrides, [columnId]: collapsed };
}

export function toggleKanbanBoardColumnCollapsedOverride(
	overrides: KanbanBoardColumnCollapsedOverrides,
	columnId: BoardColumnId,
): KanbanBoardColumnCollapsedOverrides {
	return setKanbanBoardColumnCollapsedOverride(
		overrides,
		columnId,
		!resolveKanbanBoardColumnCollapsed(overrides, columnId),
	);
}

export function clampKanbanBoardColumnWidthPx(widthPx: number): number {
	return Math.round(
		Math.min(KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX, Math.max(KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX, widthPx)),
	);
}

export function applyKanbanBoardColumnWidthToSingleColumn(
	customWidthsPx: KanbanBoardColumnCustomWidthsPx,
	columnId: BoardColumnId,
	widthPx: number,
): KanbanBoardColumnCustomWidthsPx {
	return { ...customWidthsPx, [columnId]: clampKanbanBoardColumnWidthPx(widthPx) };
}

/** 「一次调整全部列宽」：给所有当前展开的列设同一宽度；折叠列的既有宽度原样保留，展开后仍沿用。 */
export function applyKanbanBoardColumnWidthToAllExpandedColumns(
	customWidthsPx: KanbanBoardColumnCustomWidthsPx,
	expandedColumnIds: readonly BoardColumnId[],
	widthPx: number,
): KanbanBoardColumnCustomWidthsPx {
	const clampedWidthPx = clampKanbanBoardColumnWidthPx(widthPx);
	const next: KanbanBoardColumnCustomWidthsPx = { ...customWidthsPx };
	for (const columnId of expandedColumnIds) {
		next[columnId] = clampedWidthPx;
	}
	return next;
}

export function clearKanbanBoardColumnCustomWidth(
	customWidthsPx: KanbanBoardColumnCustomWidthsPx,
	columnId: BoardColumnId,
): KanbanBoardColumnCustomWidthsPx {
	if (!(columnId in customWidthsPx)) {
		return customWidthsPx;
	}
	const next: KanbanBoardColumnCustomWidthsPx = { ...customWidthsPx };
	delete next[columnId];
	return next;
}

export function clearAllKanbanBoardColumnCustomWidths(): KanbanBoardColumnCustomWidthsPx {
	return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** localStorage 读回的值不可信（手改、旧版本、别的 schema）：丢弃未知列 id 与非布尔值。 */
export function normalizeKanbanBoardColumnCollapsedOverrides(value: unknown): KanbanBoardColumnCollapsedOverrides {
	if (!isPlainRecord(value)) {
		return {};
	}
	const normalized: KanbanBoardColumnCollapsedOverrides = {};
	for (const [columnId, collapsed] of Object.entries(value)) {
		if (isKnownKanbanBoardColumnId(columnId) && typeof collapsed === "boolean") {
			normalized[columnId] = collapsed;
		}
	}
	return normalized;
}

/** localStorage 读回的值不可信：丢弃未知列 id 与非有限数值，其余重新 clamp。 */
export function normalizeKanbanBoardColumnCustomWidthsPx(value: unknown): KanbanBoardColumnCustomWidthsPx {
	if (!isPlainRecord(value)) {
		return {};
	}
	const normalized: KanbanBoardColumnCustomWidthsPx = {};
	for (const [columnId, widthPx] of Object.entries(value)) {
		if (isKnownKanbanBoardColumnId(columnId) && typeof widthPx === "number" && Number.isFinite(widthPx)) {
			normalized[columnId] = clampKanbanBoardColumnWidthPx(widthPx);
		}
	}
	return normalized;
}

/** 展开列的 flex 样式：只写 flex-basis，不写 width——移动端的 `flex: 0 0 auto !important` 才能照常压过它。 */
export function resolveKanbanBoardExpandedColumnFlexStyle(
	customWidthsPx: KanbanBoardColumnCustomWidthsPx,
	columnId: BoardColumnId,
): { flex: string } {
	const customWidthPx = customWidthsPx[columnId];
	return customWidthPx === undefined ? { flex: "1 1 0" } : { flex: `0 0 ${customWidthPx}px` };
}
