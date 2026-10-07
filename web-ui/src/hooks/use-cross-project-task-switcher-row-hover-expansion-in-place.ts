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
 * 原地展开要避开的三种跳动（都在这里处理）：
 * - **交接，不在离开时收起**：指针离开展开的那一行时不收起；等下一行停够意图时长，旧行收起与新行展开在同一次提交里
 *   完成。若离开即收起，往下挪向下一行时，上一行一收、整列上移几十像素，指针脚下换成了更下面的行（跳过想看的那个）。
 *   指针离开整个面板（延时）、Esc、在面板外按下指针，才收起。
 * - **锚定指针下的行**：交接时若收起的行在新行上方，新行会随之上移；提交后把面板 scrollTop 补回同样的距离，新展开的行
 *   停在指针下不动。面板已滚到顶、scrollTop 不够补时，差额垫成面板顶部的空白（`panelTopSpacerKeepingHoverAnchorRowInPlacePx`），
 *   效果与滚动补偿相同——指针上方的内容下移、指针下的行不动；整组 hover 展开收起时（指针离开面板等）空白一并撤掉。
 *   实测：不垫的话面板在顶部时新行上移 47px，指针落到新行下沿之外，再一动就去展开再下一行（跳过想看的那个）。
 *   面板容器关掉浏览器自带的 scroll anchoring（overflow-anchor: none），免得两套补偿叠加。
 * - **只认真实移动**：意图只由坐标真的变了的 pointermove 发起。布局变化 / 滚动把别的行换到静止的光标下时，浏览器
 *   可能补发同坐标的指针事件——不理它们，否则一次展开引起的位移会接着触发下一行展开，连锁下去。
 *
 * 展开是顶边不动、只向下长，指针始终留在展开的那一行里，所以不会出现「展开→挤走指针→收起→回到指针下→再展开」的循环。
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
	// 面板顶部额外垫的空白（px）；面板把它加进顶部内边距。
	panelTopSpacerKeepingHoverAnchorRowInPlacePx: number;
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
	// 交接前量下的「指针下那一行」的上沿；提交后对比、补 scrollTop。
	const pendingScrollCompensationRef = useRef<{ anchorRowElement: HTMLElement; anchorRowTopBeforePx: number } | null>(
		null,
	);
	// EXPERIMENT_NODE: 面板滚到顶、scrollTop 不够补时用顶部空白锚住指针下的行；另一选择是接受新行上移（指针可能落到下一行）
	const [panelTopSpacerKeepingHoverAnchorRowInPlacePx, setPanelTopSpacerKeepingHoverAnchorRowInPlacePx] = useState(0);

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
		setPanelTopSpacerKeepingHoverAnchorRowInPlacePx(0);
	}, [
		cancelPendingHoverIntent,
		clearPanelPointerExitCollapseTimeout,
		clearTouchLongPress,
		setRowExpandedInPlaceByHover,
	]);

	// 把 hover 展开交给 `rowIdentity`（null = 只收起当前那一行，用于停在固定展开的行上）。
	// 提交前量一次 anchorRowElement 的上沿，提交后若它被上方的收起带着移动了，就补 scrollTop。
	const handOffHoverExpansion = useCallback(
		(rowIdentity: CrossProjectTaskSwitcherRowIdentity | null, anchorRowElement: HTMLElement) => {
			const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
			if (
				(rowIdentity === null && currentRowExpandedInPlaceByHover === null) ||
				isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity)
			) {
				return;
			}
			pendingScrollCompensationRef.current = {
				anchorRowElement,
				anchorRowTopBeforePx: anchorRowElement.getBoundingClientRect().top,
			};
			setRowExpandedInPlaceByHover(rowIdentity ? { rowIdentity, isPointerOverRow: true } : null);
		},
		[setRowExpandedInPlaceByHover],
	);

	useLayoutEffect(() => {
		const pendingScrollCompensation = pendingScrollCompensationRef.current;
		pendingScrollCompensationRef.current = null;
		const panelScrollContainer = panelScrollContainerRef.current;
		if (
			!pendingScrollCompensation ||
			!panelScrollContainer ||
			!pendingScrollCompensation.anchorRowElement.isConnected
		) {
			return;
		}
		const anchorRowDriftPx =
			pendingScrollCompensation.anchorRowElement.getBoundingClientRect().top -
			pendingScrollCompensation.anchorRowTopBeforePx;
		if (Math.abs(anchorRowDriftPx) < 0.5) {
			return;
		}
		// 上移（drift < 0）→ scrollTop 减同样多，内容整体下移回原位。scrollTop 不够减的差额垫成顶部空白：在 layout
		// effect 里 setState，React 会在浏览器绘制前同步重渲，中间没有一帧是错位的。
		const compensatedScrollTopPx = panelScrollContainer.scrollTop + anchorRowDriftPx;
		if (compensatedScrollTopPx >= 0) {
			panelScrollContainer.scrollTop = compensatedScrollTopPx;
			return;
		}
		panelScrollContainer.scrollTop = 0;
		setPanelTopSpacerKeepingHoverAnchorRowInPlacePx((previousSpacerPx) => previousSpacerPx - compensatedScrollTopPx);
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
				setPanelTopSpacerKeepingHoverAnchorRowInPlacePx(0);
			}, CROSS_PROJECT_TASK_SWITCHER_PANEL_POINTER_EXIT_COLLAPSE_DELAY_MS);
		},
	};

	// 顶部空白也要挂着这两条收起路径：把 hover 展开的行固定展开（forgetHoverExpansionOfRowNowKeptExpandedInList）后
	// 已没有 hover 展开的行，空白却留着；若只在有 hover 行时监听，触屏（没有指针离开面板）/ 键盘用户就再也清不掉它。
	const isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed =
		rowExpandedInPlaceByHover !== null || panelTopSpacerKeepingHoverAnchorRowInPlacePx > 0;
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

	// 用户把正在 hover 展开的那一行固定展开：形态不变，只清掉 hover 记录（免得之后收起时又落回 hover 展开）；
	// 指针还在面板里，顶部空白不撤（撤了指针下的行会移动）；之后由指针离开面板、Esc、在面板外按下指针撤掉。
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
		panelTopSpacerKeepingHoverAnchorRowInPlacePx,
	};
}
