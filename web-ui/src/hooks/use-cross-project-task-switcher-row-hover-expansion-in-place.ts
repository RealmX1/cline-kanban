import {
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX } from "@/components/task-card-body";

// EXPERIMENT_NODE: 指针在一行上停多久才原地展开（350ms）；太短扫过列表时会一路展开、整列跟着动，太长又像没反应
const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_INTENT_EXPANSION_DELAY_MS = 350;
// EXPERIMENT_NODE: 指针离开整个面板后多久收起原地展开的那一行（300ms）；太短擦边而过就收，太长移去右侧读详情时左栏还撑着
const CROSS_PROJECT_TASK_SWITCHER_PANEL_POINTER_EXIT_COLLAPSE_DELAY_MS = 300;
// 触屏没有 hover，改用长按。
const CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_EXPANSION_DELAY_MS = 500;
// 长按期间手指挪动超过这么远就算滚动，不展开。
const CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_MOVEMENT_TOLERANCE_PX = 8;

/** 面板里的一行：同一个任务在 Pinned 与下方区各有一行，hover 展开只展开指针下的那一行。 */
export interface CrossProjectTaskSwitcherRowIdentity {
	entryKey: string;
	section: CrossProjectTaskSwitcherTaskRowSection;
}

export function isSameCrossProjectTaskSwitcherRow(
	left: CrossProjectTaskSwitcherRowIdentity | null,
	right: CrossProjectTaskSwitcherRowIdentity | null,
): boolean {
	return left !== null && right !== null && left.entryKey === right.entryKey && left.section === right.section;
}

/** 这一行此刻在列表里的形态（固定展开由面板记、按任务；hover 展开由本 hook 记、按行）。 */
export type CrossProjectTaskSwitcherRowExpansionStateBeforeHover = "compact_row" | "kept_expanded_in_list";

export interface CrossProjectTaskSwitcherRowHoverExpansionTriggerProps {
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

export interface CrossProjectTaskSwitcherRowExpandedInPlaceByHover {
	rowIdentity: CrossProjectTaskSwitcherRowIdentity;
	// 卡体据此第一帧就以 hover 态呈现（展开发生在静止的光标下，卡体收不到 mouseenter）；指针移到别的行后变 false。
	isPointerOverRow: boolean;
}

/**
 * All projects 面板的行：指针停够 hover 意图的时长（触屏长按）后，这一行在列表里**原地**展开成完整卡片，把下面的行
 * 往下推（不做浮层：浮层会盖住下一行，往下挪鼠标切到下一个任务不直观）。同一时刻只有一行因 hover 展开。
 *
 * 原地展开要避开的跳动（都在这里处理）：
 * - **交接，不在离开时收起**：指针离开展开的那一行时不收起；等下一行停够意图时长，旧行收起与新行展开在同一次提交里
 *   完成。若离开即收起，往下挪向下一行时，上一行一收、整列在指针移动途中上移几十像素，指针脚下换成了更下面的行。
 *   指针离开整个面板（延时）、Esc、在面板外按下指针，才收起。
 * - **列表顶边固定（经典手风琴，用户 2026-10-08 选定）**：收起的行在新行上方时，新行随之上移那一行多出的高度，
 *   指针一般落在新行的下半部；上一张卡比这张高时指针会落到再下一行（新行显示在指针上方，手再动才去展开那一行）。
 *   不再补 scrollTop、不垫顶部空白：那样指针下的行不动，代价是指针上方的整列往下拖、滚到顶时顶部露出空白，
 *   且每往下交接一次空白就累加一次（用户否掉）。面板容器关掉浏览器自带的 scroll anchoring（overflow-anchor: none），
 *   否则面板滚动过时浏览器会自己补 scrollTop，又变回「整列往下拖」。唯一的例外是新行的顶边被这次收起带出了可视区
 *   （面板滚过、上一张卡的上半截已在可视区之外）：回滚到刚好露出新行的顶边（最多回滚它被带上去的距离），
 *   不然这张卡的标题看不见。
 * - **只认真实移动**：意图只由坐标真的变了的 pointermove 发起。布局变化 / 滚动把别的行换到静止的光标下时，浏览器
 *   可能补发同坐标的指针事件——不理它们，否则一次交接引起的位移会接着触发下一行展开，连锁下去。
 *
 * 展开是顶边不动、只向下长，展开的那一行不会把自己挤离指针，所以不会出现「展开→挤走指针→收起→回到指针下→再展开」的循环。
 *
 * 另两处主动不展开：在行上按下指针就取消待发的意图（按下与抬起之间行变成卡片，click 会落到公共祖先上丢失）；
 * 用户刚把固定展开的卡收起（`suppressHoverExpansionUntilPointerLeavesRow`），指针离开这一行之前不再 hover 展开。
 */
export function useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
	panelScrollContainerRef,
}: {
	panelScrollContainerRef: RefObject<HTMLElement | null>;
}): {
	rowExpandedInPlaceByHover: CrossProjectTaskSwitcherRowExpandedInPlaceByHover | null;
	// 意图计时中的那一行：面板借此提前挂载（隐藏的）完整卡片，其他项目的卡在展开前就开始读。
	rowWithPendingHoverIntent: CrossProjectTaskSwitcherRowIdentity | null;
	buildRowHoverExpansionTriggerProps: (
		rowIdentity: CrossProjectTaskSwitcherRowIdentity,
		rowExpansionStateBeforeHover: CrossProjectTaskSwitcherRowExpansionStateBeforeHover,
	) => CrossProjectTaskSwitcherRowHoverExpansionTriggerProps;
	panelPointerHandlers: {
		onPointerEnter: () => void;
		onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
	};
	cancelPendingHoverIntent: () => void;
	collapseRowExpandedInPlaceByHover: () => void;
	suppressHoverExpansionUntilPointerLeavesRow: (entryKey: string) => void;
	forgetHoverExpansionOfRowNowKeptExpandedInList: () => void;
} {
	const [rowExpandedInPlaceByHover, setRowExpandedInPlaceByHoverState] =
		useState<CrossProjectTaskSwitcherRowExpandedInPlaceByHover | null>(null);
	// 事件处理器要同步读到最新值（不在 setState 的 updater 里做副作用），所以另存一份 ref。
	const rowExpandedInPlaceByHoverRef = useRef<CrossProjectTaskSwitcherRowExpandedInPlaceByHover | null>(null);
	const setRowExpandedInPlaceByHover = useCallback(
		(nextRowExpandedInPlaceByHover: CrossProjectTaskSwitcherRowExpandedInPlaceByHover | null) => {
			rowExpandedInPlaceByHoverRef.current = nextRowExpandedInPlaceByHover;
			setRowExpandedInPlaceByHoverState(nextRowExpandedInPlaceByHover);
		},
		[],
	);
	const [rowWithPendingHoverIntent, setRowWithPendingHoverIntentState] =
		useState<CrossProjectTaskSwitcherRowIdentity | null>(null);
	const rowWithPendingHoverIntentRef = useRef<CrossProjectTaskSwitcherRowIdentity | null>(null);
	const hoverIntentTimeoutIdRef = useRef<number | null>(null);
	const panelPointerExitCollapseTimeoutIdRef = useRef<number | null>(null);
	const touchLongPressRef = useRef<{ timeoutId: number; startX: number; startY: number } | null>(null);
	// 长按展开后，抬手那一下会接着派发 click：吞掉它，否则行被当成「打开任务」。只作用于本次长按手势，
	// 下一次 pointerdown（新手势）与收起时作废，不能留着吞掉之后第一次点行。
	const suppressNextRowClickAfterTouchLongPressRef = useRef(false);
	// 按任务记（Pinned 与下方区同一个任务一起收起）。
	const entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef = useRef<string | null>(null);
	const lastObservedPointerClientPositionRef = useRef<{ clientX: number; clientY: number } | null>(null);
	// 交接时指针停在的那一行（新展开的行，或停在固定展开的行上时的那一行）与它提交前的顶边；提交后检查交接是否把它的
	// 顶边带出了可视区。
	const rowWhoseTopEdgeMustStayVisibleAfterHandOffRef = useRef<{
		anchorRowElement: HTMLElement;
		anchorRowTopBeforeHandOffPx: number;
	} | null>(null);

	const cancelPendingHoverIntent = useCallback(() => {
		if (hoverIntentTimeoutIdRef.current !== null) {
			window.clearTimeout(hoverIntentTimeoutIdRef.current);
			hoverIntentTimeoutIdRef.current = null;
		}
		if (rowWithPendingHoverIntentRef.current !== null) {
			rowWithPendingHoverIntentRef.current = null;
			setRowWithPendingHoverIntentState(null);
		}
	}, []);
	const clearPanelPointerExitCollapseTimeout = useCallback(() => {
		if (panelPointerExitCollapseTimeoutIdRef.current !== null) {
			window.clearTimeout(panelPointerExitCollapseTimeoutIdRef.current);
			panelPointerExitCollapseTimeoutIdRef.current = null;
		}
	}, []);
	const clearTouchLongPress = useCallback(() => {
		if (touchLongPressRef.current) {
			window.clearTimeout(touchLongPressRef.current.timeoutId);
			touchLongPressRef.current = null;
		}
	}, []);

	const collapseRowExpandedInPlaceByHover = useCallback(() => {
		cancelPendingHoverIntent();
		clearPanelPointerExitCollapseTimeout();
		clearTouchLongPress();
		suppressNextRowClickAfterTouchLongPressRef.current = false;
		if (rowExpandedInPlaceByHoverRef.current !== null) {
			setRowExpandedInPlaceByHover(null);
		}
	}, [
		cancelPendingHoverIntent,
		clearPanelPointerExitCollapseTimeout,
		clearTouchLongPress,
		setRowExpandedInPlaceByHover,
	]);

	// 把 hover 展开交给 `rowIdentity`（null = 只收起当前那一行，用于停在固定展开的行上）。
	// `anchorRowElement` 是指针停在的那一行，提交后它的顶边若被这次交接带出可视区就回滚到刚好露出。
	const handOffHoverExpansion = useCallback(
		(rowIdentity: CrossProjectTaskSwitcherRowIdentity | null, anchorRowElement: HTMLElement) => {
			const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
			if (
				(rowIdentity === null && currentRowExpandedInPlaceByHover === null) ||
				isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity)
			) {
				return;
			}
			rowWhoseTopEdgeMustStayVisibleAfterHandOffRef.current = {
				anchorRowElement,
				anchorRowTopBeforeHandOffPx: anchorRowElement.getBoundingClientRect().top,
			};
			setRowExpandedInPlaceByHover(rowIdentity ? { rowIdentity, isPointerOverRow: true } : null);
		},
		[setRowExpandedInPlaceByHover],
	);

	useLayoutEffect(() => {
		const rowWhoseTopEdgeMustStayVisible = rowWhoseTopEdgeMustStayVisibleAfterHandOffRef.current;
		rowWhoseTopEdgeMustStayVisibleAfterHandOffRef.current = null;
		const panelScrollContainer = panelScrollContainerRef.current;
		if (!rowWhoseTopEdgeMustStayVisible?.anchorRowElement.isConnected || !panelScrollContainer) {
			return;
		}
		// 顶边固定：一般什么都不用做。只有这次交接把这一行往上带、顶边（连同叠在首行上方、伸出顶边的 hover 动作组）
		// 因此落到面板可视区上沿之外，才往回滚，且最多回滚它被带上去的距离——交接前就因用户自己滚动而露不全的部分不管，
		// 那是用户的滚动位置，回滚就成了在静止的光标下拖动列表。在 layout effect 里改，浏览器绘制前就到位。
		const anchorRowTopAfterHandOffPx = rowWhoseTopEdgeMustStayVisible.anchorRowElement.getBoundingClientRect().top;
		const anchorRowCarriedUpwardByHandOffPx =
			rowWhoseTopEdgeMustStayVisible.anchorRowTopBeforeHandOffPx - anchorRowTopAfterHandOffPx;
		const rowTopEdgeHiddenAbovePanelViewportPx =
			panelScrollContainer.getBoundingClientRect().top +
			CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX -
			anchorRowTopAfterHandOffPx;
		const scrollBackPx = Math.min(anchorRowCarriedUpwardByHandOffPx, rowTopEdgeHiddenAbovePanelViewportPx);
		if (scrollBackPx > 0) {
			panelScrollContainer.scrollTop = Math.max(0, panelScrollContainer.scrollTop - scrollBackPx);
		}
	}, [panelScrollContainerRef, rowExpandedInPlaceByHover]);

	const suppressHoverExpansionUntilPointerLeavesRow = useCallback(
		(entryKey: string) => {
			entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current = entryKey;
			cancelPendingHoverIntent();
		},
		[cancelPendingHoverIntent],
	);

	const buildRowHoverExpansionTriggerProps = useCallback(
		(
			rowIdentity: CrossProjectTaskSwitcherRowIdentity,
			rowExpansionStateBeforeHover: CrossProjectTaskSwitcherRowExpansionStateBeforeHover,
		): CrossProjectTaskSwitcherRowHoverExpansionTriggerProps => ({
			onPointerMove: (event) => {
				if (event.pointerType === "touch") {
					const touchLongPress = touchLongPressRef.current;
					if (
						touchLongPress &&
						Math.hypot(event.clientX - touchLongPress.startX, event.clientY - touchLongPress.startY) >
							CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_MOVEMENT_TOLERANCE_PX
					) {
						clearTouchLongPress();
					}
					return;
				}
				const lastObservedPointerClientPosition = lastObservedPointerClientPositionRef.current;
				if (
					lastObservedPointerClientPosition?.clientX === event.clientX &&
					lastObservedPointerClientPosition.clientY === event.clientY
				) {
					// 坐标没变：布局 / 滚动把这一行换到了静止的光标下，不是用户在移动。
					return;
				}
				lastObservedPointerClientPositionRef.current = { clientX: event.clientX, clientY: event.clientY };
				clearPanelPointerExitCollapseTimeout();
				const suppressedEntryKey = entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current;
				if (suppressedEntryKey !== null) {
					if (suppressedEntryKey === rowIdentity.entryKey) {
						return;
					}
					entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current = null;
				}
				const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
				if (isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity)) {
					// 回到 / 停在展开的那一行：别的行的待发意图作废。
					cancelPendingHoverIntent();
					if (currentRowExpandedInPlaceByHover && !currentRowExpandedInPlaceByHover.isPointerOverRow) {
						setRowExpandedInPlaceByHover({ ...currentRowExpandedInPlaceByHover, isPointerOverRow: true });
					}
					return;
				}
				if (isSameCrossProjectTaskSwitcherRow(rowWithPendingHoverIntentRef.current, rowIdentity)) {
					return;
				}
				cancelPendingHoverIntent();
				// 停在固定展开的行上：没有 hover 展开要收起就什么都不用做。
				if (rowExpansionStateBeforeHover === "kept_expanded_in_list" && currentRowExpandedInPlaceByHover === null) {
					return;
				}
				const anchorRowElement = event.currentTarget;
				if (rowExpansionStateBeforeHover === "compact_row") {
					rowWithPendingHoverIntentRef.current = rowIdentity;
					setRowWithPendingHoverIntentState(rowIdentity);
				}
				hoverIntentTimeoutIdRef.current = window.setTimeout(() => {
					hoverIntentTimeoutIdRef.current = null;
					rowWithPendingHoverIntentRef.current = null;
					setRowWithPendingHoverIntentState(null);
					handOffHoverExpansion(
						rowExpansionStateBeforeHover === "compact_row" ? rowIdentity : null,
						anchorRowElement,
					);
				}, CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_INTENT_EXPANSION_DELAY_MS);
			},
			onPointerLeave: (event) => {
				if (event.pointerType === "touch") {
					return;
				}
				if (entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current === rowIdentity.entryKey) {
					entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current = null;
				}
				if (isSameCrossProjectTaskSwitcherRow(rowWithPendingHoverIntentRef.current, rowIdentity)) {
					cancelPendingHoverIntent();
				}
				const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
				if (
					currentRowExpandedInPlaceByHover?.isPointerOverRow &&
					isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover.rowIdentity, rowIdentity)
				) {
					// 不收起（交接见 hook 注释），只是不再以 hover 态呈现。
					setRowExpandedInPlaceByHover({ ...currentRowExpandedInPlaceByHover, isPointerOverRow: false });
				}
			},
			onPointerDown: (event) => {
				// 新手势开始（任意 pointerType）：上一次长按没被消费的「吞 click」标志作废，免得误吞这次手势的 click。
				suppressNextRowClickAfterTouchLongPressRef.current = false;
				if (event.pointerType !== "touch") {
					// 已经在点了：不再在按下与抬起之间把这一行换成卡片、抢走这次 click。
					cancelPendingHoverIntent();
					return;
				}
				clearTouchLongPress();
				const anchorRowElement = event.currentTarget;
				touchLongPressRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					timeoutId: window.setTimeout(() => {
						touchLongPressRef.current = null;
						suppressNextRowClickAfterTouchLongPressRef.current = true;
						handOffHoverExpansion(
							rowExpansionStateBeforeHover === "compact_row" ? rowIdentity : null,
							anchorRowElement,
						);
					}, CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_EXPANSION_DELAY_MS),
				};
			},
			onPointerUp: clearTouchLongPress,
			onPointerCancel: clearTouchLongPress,
			onClickCapture: (event) => {
				if (!suppressNextRowClickAfterTouchLongPressRef.current) {
					return;
				}
				suppressNextRowClickAfterTouchLongPressRef.current = false;
				event.preventDefault();
				event.stopPropagation();
			},
			// 长按在部分移动浏览器上会弹系统菜单。
			onContextMenu: (event) => {
				if (suppressNextRowClickAfterTouchLongPressRef.current || touchLongPressRef.current) {
					event.preventDefault();
				}
			},
		}),
		[
			cancelPendingHoverIntent,
			clearPanelPointerExitCollapseTimeout,
			clearTouchLongPress,
			handOffHoverExpansion,
			setRowExpandedInPlaceByHover,
		],
	);

	const panelPointerHandlers = {
		onPointerEnter: clearPanelPointerExitCollapseTimeout,
		onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
			if (event.pointerType === "touch") {
				return;
			}
			cancelPendingHoverIntent();
			clearPanelPointerExitCollapseTimeout();
			panelPointerExitCollapseTimeoutIdRef.current = window.setTimeout(() => {
				panelPointerExitCollapseTimeoutIdRef.current = null;
				setRowExpandedInPlaceByHover(null);
			}, CROSS_PROJECT_TASK_SWITCHER_PANEL_POINTER_EXIT_COLLAPSE_DELAY_MS);
		},
	};

	const isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed = rowExpandedInPlaceByHover !== null;
	useEffect(() => {
		if (!isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed) {
			return;
		}
		const collapseOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				collapseRowExpandedInPlaceByHover();
			}
		};
		// 触屏没有「指针离开面板」：在面板以外按下就收起。
		const collapseOnPointerDownOutsidePanel = (event: PointerEvent) => {
			if (panelScrollContainerRef.current?.contains(event.target as Node)) {
				return;
			}
			collapseRowExpandedInPlaceByHover();
		};
		document.addEventListener("keydown", collapseOnEscape);
		document.addEventListener("pointerdown", collapseOnPointerDownOutsidePanel, true);
		return () => {
			document.removeEventListener("keydown", collapseOnEscape);
			document.removeEventListener("pointerdown", collapseOnPointerDownOutsidePanel, true);
		};
	}, [
		collapseRowExpandedInPlaceByHover,
		isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed,
		panelScrollContainerRef,
	]);

	useEffect(
		() => () => {
			if (hoverIntentTimeoutIdRef.current !== null) {
				window.clearTimeout(hoverIntentTimeoutIdRef.current);
			}
			clearPanelPointerExitCollapseTimeout();
			clearTouchLongPress();
		},
		[clearPanelPointerExitCollapseTimeout, clearTouchLongPress],
	);

	// 用户把正在 hover 展开的那一行固定展开：形态不变，只清掉 hover 记录（免得之后收起时又落回 hover 展开）。
	const forgetHoverExpansionOfRowNowKeptExpandedInList = useCallback(() => {
		cancelPendingHoverIntent();
		if (rowExpandedInPlaceByHoverRef.current !== null) {
			setRowExpandedInPlaceByHover(null);
		}
	}, [cancelPendingHoverIntent, setRowExpandedInPlaceByHover]);

	return {
		rowExpandedInPlaceByHover,
		rowWithPendingHoverIntent,
		buildRowHoverExpansionTriggerProps,
		panelPointerHandlers,
		cancelPendingHoverIntent,
		collapseRowExpandedInPlaceByHover,
		suppressHoverExpansionUntilPointerLeavesRow,
		forgetHoverExpansionOfRowNowKeptExpandedInList,
	};
}
