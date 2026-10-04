import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { useResizeDrag } from "@/resize/use-resize-drag";
import {
	applyKanbanBoardColumnWidthToAllExpandedColumns,
	applyKanbanBoardColumnWidthToSingleColumn,
	clearAllKanbanBoardColumnCustomWidths,
	clearKanbanBoardColumnCustomWidth,
	KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX,
	KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX,
	type KanbanBoardColumnCustomWidthsPx,
	normalizeKanbanBoardColumnCollapsedOverrides,
	normalizeKanbanBoardColumnCustomWidthsPx,
	resolveKanbanBoardColumnCollapsed,
	resolveKanbanBoardExpandedColumnFlexStyle,
	setKanbanBoardColumnCollapsedOverride,
	toggleKanbanBoardColumnCollapsedOverride,
} from "@/state/kanban-board-column-collapse-and-width-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardColumnId } from "@/types";
import { useJsonLocalStorageValue } from "@/utils/react-use";

export interface KanbanBoardColumnCollapseAndWidthPreferences {
	isColumnCollapsed: (columnId: BoardColumnId) => boolean;
	toggleColumnCollapsed: (columnId: BoardColumnId) => void;
	expandColumn: (columnId: BoardColumnId) => void;
	getExpandedColumnFlexStyle: (columnId: BoardColumnId) => { flex: string };
	/** 拖列宽 handle：普通拖只改这一列；按住 Shift 起拖则所有展开列统一成同一宽度。 */
	startColumnWidthResizeDrag: (event: ReactMouseEvent, columnId: BoardColumnId) => void;
	/** 双击列宽 handle：该列恢复自动填充；Shift+双击则全部列恢复。 */
	resetColumnWidthFromHandleDoubleClick: (event: ReactMouseEvent, columnId: BoardColumnId) => void;
	/**
	 * 列宽 handle 的键盘入口（与鼠标语义一一对应，Shift 一律作用于所有展开列）：
	 * ←/→ 每次 ±KANBAN_BOARD_COLUMN_KEYBOARD_RESIZE_STEP_PX；Home/End 设到最小/最大宽度；Enter/Delete/Backspace 恢复自动填充。
	 */
	handleColumnWidthResizeHandleKeyDown: (event: ReactKeyboardEvent, columnId: BoardColumnId) => void;
	/** 该列已持久化的自定义宽度（px）；未自定义（自动填充）时为 undefined，供 handle 的 aria-valuenow 使用。 */
	getColumnCustomWidthPx: (columnId: BoardColumnId) => number | undefined;
}

export const KANBAN_BOARD_COLUMN_KEYBOARD_RESIZE_STEP_PX = 16;

function findKanbanBoardColumnSection(boardElement: HTMLElement, columnId: BoardColumnId): HTMLElement | null {
	return boardElement.querySelector<HTMLElement>(`:scope > section[data-column-id="${columnId}"]`);
}

/**
 * 主看板 stage 列的折叠 + 列宽偏好（localStorage 持久化，纳入 Reset layout）。
 * 拖拽期间宽度只进 React state，mouseup 才写盘，避免每帧序列化 localStorage。
 */
export function useKanbanBoardColumnCollapseAndWidthPreferences({
	orderedColumnIds,
	boardRef,
}: {
	orderedColumnIds: readonly BoardColumnId[];
	boardRef: RefObject<HTMLElement | null>;
}): KanbanBoardColumnCollapseAndWidthPreferences {
	const [storedCollapsedOverrides, setStoredCollapsedOverrides] = useJsonLocalStorageValue<unknown>(
		LocalStorageKey.KanbanBoardColumnCollapsedOverrides,
		{},
	);
	const [storedCustomWidthsPx, setStoredCustomWidthsPx] = useJsonLocalStorageValue<unknown>(
		LocalStorageKey.KanbanBoardColumnCustomWidthsPx,
		{},
	);
	const collapsedOverrides = useMemo(
		() => normalizeKanbanBoardColumnCollapsedOverrides(storedCollapsedOverrides),
		[storedCollapsedOverrides],
	);
	const persistedCustomWidthsPx = useMemo(
		() => normalizeKanbanBoardColumnCustomWidthsPx(storedCustomWidthsPx),
		[storedCustomWidthsPx],
	);
	const [customWidthsPxDuringActiveDrag, setCustomWidthsPxDuringActiveDrag] =
		useState<KanbanBoardColumnCustomWidthsPx | null>(null);
	const customWidthsPx = customWidthsPxDuringActiveDrag ?? persistedCustomWidthsPx;
	const { startDrag } = useResizeDrag();

	const isColumnCollapsed = useCallback(
		(columnId: BoardColumnId) => resolveKanbanBoardColumnCollapsed(collapsedOverrides, columnId),
		[collapsedOverrides],
	);

	const toggleColumnCollapsed = useCallback(
		(columnId: BoardColumnId) => {
			setStoredCollapsedOverrides(toggleKanbanBoardColumnCollapsedOverride(collapsedOverrides, columnId));
		},
		[collapsedOverrides, setStoredCollapsedOverrides],
	);

	const expandColumn = useCallback(
		(columnId: BoardColumnId) => {
			const nextOverrides = setKanbanBoardColumnCollapsedOverride(collapsedOverrides, columnId, false);
			if (nextOverrides !== collapsedOverrides) {
				setStoredCollapsedOverrides(nextOverrides);
			}
		},
		[collapsedOverrides, setStoredCollapsedOverrides],
	);

	const getExpandedColumnFlexStyle = useCallback(
		(columnId: BoardColumnId) => resolveKanbanBoardExpandedColumnFlexStyle(customWidthsPx, columnId),
		[customWidthsPx],
	);

	const latestCustomWidthsPxDuringActiveDragRef = useRef<KanbanBoardColumnCustomWidthsPx | null>(null);

	const startColumnWidthResizeDrag = useCallback(
		(event: ReactMouseEvent, columnId: BoardColumnId) => {
			const boardElement = boardRef.current;
			const draggedColumnElement = boardElement ? findKanbanBoardColumnSection(boardElement, columnId) : null;
			if (!boardElement || !draggedColumnElement) {
				return;
			}
			const appliesToAllExpandedColumns = event.shiftKey;
			const startPointerX = event.clientX;
			const startWidthPx = draggedColumnElement.getBoundingClientRect().width;
			const expandedColumnIds = orderedColumnIds.filter(
				(candidateColumnId) => !resolveKanbanBoardColumnCollapsed(collapsedOverrides, candidateColumnId),
			);
			// 统一宽度模式下让被拖的 handle 恰好跟手：handle 左侧有 k+1 个展开列（含被拖列）都变成同宽 W，
			// 其余（折叠竖条、gap、padding）不变 ⇒ handle 位置 = 不变部分 + (k+1)·W。起拖时量出不变部分即可反解 W。
			const expandedColumnIdsUpToDraggedColumn = expandedColumnIds.slice(0, expandedColumnIds.indexOf(columnId) + 1);
			const measuredWidthSumOfExpandedColumnsUpToDraggedColumn = expandedColumnIdsUpToDraggedColumn.reduce(
				(sum, expandedColumnId) =>
					sum + (findKanbanBoardColumnSection(boardElement, expandedColumnId)?.getBoundingClientRect().width ?? 0),
				0,
			);
			// 以起拖时的指针位置（而非列右缘）为基准：handle 与列右缘之间还隔着半个 gap，用右缘会让 handle 恒偏几像素。
			const handleClientXUnaffectedByUniformWidth =
				startPointerX - measuredWidthSumOfExpandedColumnsUpToDraggedColumn;
			const baseCustomWidthsPx = persistedCustomWidthsPx;

			startDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const nextCustomWidthsPx = appliesToAllExpandedColumns
						? applyKanbanBoardColumnWidthToAllExpandedColumns(
								baseCustomWidthsPx,
								expandedColumnIds,
								(pointerX - handleClientXUnaffectedByUniformWidth) /
									Math.max(1, expandedColumnIdsUpToDraggedColumn.length),
							)
						: applyKanbanBoardColumnWidthToSingleColumn(
								baseCustomWidthsPx,
								columnId,
								startWidthPx + (pointerX - startPointerX),
							);
					latestCustomWidthsPxDuringActiveDragRef.current = nextCustomWidthsPx;
					setCustomWidthsPxDuringActiveDrag(nextCustomWidthsPx);
				},
				onEnd: () => {
					const finalCustomWidthsPx = latestCustomWidthsPxDuringActiveDragRef.current;
					latestCustomWidthsPxDuringActiveDragRef.current = null;
					if (finalCustomWidthsPx) {
						setStoredCustomWidthsPx(finalCustomWidthsPx);
					}
					setCustomWidthsPxDuringActiveDrag(null);
				},
			});
		},
		[boardRef, collapsedOverrides, orderedColumnIds, persistedCustomWidthsPx, setStoredCustomWidthsPx, startDrag],
	);

	const resetColumnWidthFromHandleDoubleClick = useCallback(
		(event: ReactMouseEvent, columnId: BoardColumnId) => {
			setStoredCustomWidthsPx(
				event.shiftKey
					? clearAllKanbanBoardColumnCustomWidths()
					: clearKanbanBoardColumnCustomWidth(persistedCustomWidthsPx, columnId),
			);
		},
		[persistedCustomWidthsPx, setStoredCustomWidthsPx],
	);

	const handleColumnWidthResizeHandleKeyDown = useCallback(
		(event: ReactKeyboardEvent, columnId: BoardColumnId) => {
			const appliesToAllExpandedColumns = event.shiftKey;
			if (event.key === "Enter" || event.key === "Delete" || event.key === "Backspace") {
				event.preventDefault();
				setStoredCustomWidthsPx(
					appliesToAllExpandedColumns
						? clearAllKanbanBoardColumnCustomWidths()
						: clearKanbanBoardColumnCustomWidth(persistedCustomWidthsPx, columnId),
				);
				return;
			}
			const resolveNextWidthPx = (currentWidthPx: number): number | null => {
				switch (event.key) {
					case "ArrowLeft":
						return currentWidthPx - KANBAN_BOARD_COLUMN_KEYBOARD_RESIZE_STEP_PX;
					case "ArrowRight":
						return currentWidthPx + KANBAN_BOARD_COLUMN_KEYBOARD_RESIZE_STEP_PX;
					case "Home":
						return KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX;
					case "End":
						return KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX;
					default:
						return null;
				}
			};
			// 起点与拖拽一致：已自定义取持久值，自动填充列取 DOM 实测宽度。
			const boardElement = boardRef.current;
			const currentWidthPx =
				persistedCustomWidthsPx[columnId] ??
				(boardElement ? findKanbanBoardColumnSection(boardElement, columnId)?.getBoundingClientRect().width : 0) ??
				0;
			const nextWidthPx = resolveNextWidthPx(currentWidthPx);
			if (nextWidthPx === null) {
				return;
			}
			event.preventDefault();
			const expandedColumnIds = orderedColumnIds.filter(
				(candidateColumnId) => !resolveKanbanBoardColumnCollapsed(collapsedOverrides, candidateColumnId),
			);
			setStoredCustomWidthsPx(
				appliesToAllExpandedColumns
					? applyKanbanBoardColumnWidthToAllExpandedColumns(
							persistedCustomWidthsPx,
							expandedColumnIds,
							nextWidthPx,
						)
					: applyKanbanBoardColumnWidthToSingleColumn(persistedCustomWidthsPx, columnId, nextWidthPx),
			);
		},
		[boardRef, collapsedOverrides, orderedColumnIds, persistedCustomWidthsPx, setStoredCustomWidthsPx],
	);

	const getColumnCustomWidthPx = useCallback((columnId: BoardColumnId) => customWidthsPx[columnId], [customWidthsPx]);

	useLayoutResetEffect(() => {
		setStoredCollapsedOverrides({});
		setStoredCustomWidthsPx({});
		setCustomWidthsPxDuringActiveDrag(null);
	});

	return {
		isColumnCollapsed,
		toggleColumnCollapsed,
		expandColumn,
		getExpandedColumnFlexStyle,
		startColumnWidthResizeDrag,
		resetColumnWidthFromHandleDoubleClick,
		handleColumnWidthResizeHandleKeyDown,
		getColumnCustomWidthPx,
	};
}
