import {
	type FocusEvent as ReactFocusEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";

// EXPERIMENT_NODE: 指针在一行上停多久才悬浮展开（350ms）；太短会在扫过时频繁遮蔽，太长又像没反应
const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_INTENT_EXPANSION_DELAY_MS = 350;
// EXPERIMENT_NODE: 指针离开展开卡片后多久收起（300ms）；保留擦边返回与进入弹窗的时间
const CROSS_PROJECT_TASK_SWITCHER_EXPANDED_ROW_POINTER_EXIT_COLLAPSE_DELAY_MS = 300;
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
	onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
	onFocusCapture: (event: ReactFocusEvent<HTMLElement>) => void;
	onBlurCapture: () => void;
}

export interface CrossProjectTaskSwitcherRowExpandedInPlaceByHover {
	rowIdentity: CrossProjectTaskSwitcherRowIdentity;
	// 卡体据此第一帧就以 hover 态呈现（展开发生在静止的光标下，卡体收不到 mouseenter）；指针移到别的行后变 false。
	isPointerOverRow: boolean;
}

/**
 * 每个宿主滚动容器维护一个悬浮展开：350ms 真实移动意图、500ms 触屏长按、离开卡片 300ms 收起。
 * 几何定位由浮层 hook 负责，缩略行始终保留占位，交接与收起不调整 scrollTop。
 * 卡片里的键盘焦点与 Portal 弹窗保留交互；Esc 先交给弹窗或菜单，外部按下按 React 子树判断。
 * 点击固定展开后的主动收起会抑制同一行的 hover，直到指针离开。
 */
export function useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
	panelScrollContainerRef,
}: {
	panelScrollContainerRef: RefObject<HTMLElement | null>;
}): {
	panelScrollContainerRef: RefObject<HTMLElement | null>;
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
		onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
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
	const focusedInteractionInsideRowRef = useRef<{
		rowIdentity: CrossProjectTaskSwitcherRowIdentity;
		element: HTMLElement;
	} | null>(null);
	const touchLongPressRef = useRef<{ timeoutId: number; startX: number; startY: number } | null>(null);
	// 长按展开后，抬手那一下会接着派发 click：吞掉它，否则行被当成「打开任务」。只作用于本次长按手势，
	// 下一次 pointerdown（新手势）与收起时作废，不能留着吞掉之后第一次点行。
	const suppressNextRowClickAfterTouchLongPressRef = useRef(false);
	// 按任务记（Pinned 与下方区同一个任务一起收起）。
	const entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef = useRef<string | null>(null);
	const lastObservedPointerClientPositionRef = useRef<{ clientX: number; clientY: number } | null>(null);
	// 最近一次沿面板 React 子树传播的 pointerdown 原生事件（含卡上弹出、DOM 挂在 body 下的 portal 弹窗）。
	// 「面板外按下」按事件对象身份对照它，不留滞后的布尔标记。
	const lastPointerDownNativeEventDispatchedThroughPanelReactTreeRef = useRef<Event | null>(null);
	const isExpandedRowRetainedByKeyboardFocusOrPopup = useCallback(() => {
		const focusedInteraction = focusedInteractionInsideRowRef.current;
		return Boolean(
			focusedInteraction &&
				isSameCrossProjectTaskSwitcherRow(
					focusedInteraction.rowIdentity,
					rowExpandedInPlaceByHoverRef.current?.rowIdentity ?? null,
				) &&
				document.activeElement === focusedInteraction.element &&
				(focusedInteraction.element.matches(":focus-visible") ||
					focusedInteraction.element.closest(
						"[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
					)),
		);
	}, []);

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
	const scheduleExpandedRowPointerExitCollapse = useCallback(() => {
		clearPanelPointerExitCollapseTimeout();
		panelPointerExitCollapseTimeoutIdRef.current = window.setTimeout(() => {
			panelPointerExitCollapseTimeoutIdRef.current = null;
			if (!isExpandedRowRetainedByKeyboardFocusOrPopup()) {
				setRowExpandedInPlaceByHover(null);
			}
		}, CROSS_PROJECT_TASK_SWITCHER_EXPANDED_ROW_POINTER_EXIT_COLLAPSE_DELAY_MS);
	}, [
		clearPanelPointerExitCollapseTimeout,
		isExpandedRowRetainedByKeyboardFocusOrPopup,
		setRowExpandedInPlaceByHover,
	]);

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
	const handOffHoverExpansion = useCallback(
		(rowIdentity: CrossProjectTaskSwitcherRowIdentity | null) => {
			const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
			if (
				(rowIdentity === null && currentRowExpandedInPlaceByHover === null) ||
				isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity)
			) {
				return;
			}
			if (isExpandedRowRetainedByKeyboardFocusOrPopup()) return;
			clearPanelPointerExitCollapseTimeout();
			setRowExpandedInPlaceByHover(rowIdentity ? { rowIdentity, isPointerOverRow: true } : null);
		},
		[setRowExpandedInPlaceByHover, clearPanelPointerExitCollapseTimeout, isExpandedRowRetainedByKeyboardFocusOrPopup],
	);

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
			onPointerEnter: (event) => {
				if (event.pointerType === "touch") return;
				const currentRow = rowExpandedInPlaceByHoverRef.current;
				if (currentRow && isSameCrossProjectTaskSwitcherRow(currentRow.rowIdentity, rowIdentity)) {
					clearPanelPointerExitCollapseTimeout();
					setRowExpandedInPlaceByHover({ ...currentRow, isPointerOverRow: true });
				}
			},
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
				const suppressedEntryKey = entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current;
				if (suppressedEntryKey !== null) {
					if (suppressedEntryKey === rowIdentity.entryKey) {
						return;
					}
					entryKeyWithHoverExpansionSuppressedUntilPointerLeavesRowRef.current = null;
				}
				const currentRowExpandedInPlaceByHover = rowExpandedInPlaceByHoverRef.current;
				if (isSameCrossProjectTaskSwitcherRow(currentRowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity)) {
					clearPanelPointerExitCollapseTimeout();
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
				if (rowExpansionStateBeforeHover === "compact_row") {
					rowWithPendingHoverIntentRef.current = rowIdentity;
					setRowWithPendingHoverIntentState(rowIdentity);
				}
				hoverIntentTimeoutIdRef.current = window.setTimeout(() => {
					hoverIntentTimeoutIdRef.current = null;
					rowWithPendingHoverIntentRef.current = null;
					setRowWithPendingHoverIntentState(null);
					handOffHoverExpansion(rowExpansionStateBeforeHover === "compact_row" ? rowIdentity : null);
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
					setRowExpandedInPlaceByHover({ ...currentRowExpandedInPlaceByHover, isPointerOverRow: false });
					scheduleExpandedRowPointerExitCollapse();
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
				touchLongPressRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					timeoutId: window.setTimeout(() => {
						touchLongPressRef.current = null;
						suppressNextRowClickAfterTouchLongPressRef.current = true;
						handOffHoverExpansion(rowExpansionStateBeforeHover === "compact_row" ? rowIdentity : null);
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
			onFocusCapture: (event) => {
				focusedInteractionInsideRowRef.current = { rowIdentity, element: event.target };
				if (isExpandedRowRetainedByKeyboardFocusOrPopup()) clearPanelPointerExitCollapseTimeout();
			},
			onBlurCapture: () => {
				// Portal 的下一个 focus 也会经过这里的 React 子树；等它更新归属后再判断。
				queueMicrotask(() => {
					if (
						isSameCrossProjectTaskSwitcherRow(
							rowExpandedInPlaceByHoverRef.current?.rowIdentity ?? null,
							rowIdentity,
						) &&
						!rowExpandedInPlaceByHoverRef.current?.isPointerOverRow &&
						!isExpandedRowRetainedByKeyboardFocusOrPopup()
					)
						scheduleExpandedRowPointerExitCollapse();
				});
			},
		}),
		[
			cancelPendingHoverIntent,
			clearPanelPointerExitCollapseTimeout,
			clearTouchLongPress,
			handOffHoverExpansion,
			setRowExpandedInPlaceByHover,
			isExpandedRowRetainedByKeyboardFocusOrPopup,
			scheduleExpandedRowPointerExitCollapse,
		],
	);

	const panelPointerHandlers = {
		onPointerEnter: () => {
			if (rowExpandedInPlaceByHoverRef.current?.isPointerOverRow) clearPanelPointerExitCollapseTimeout();
		},
		onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
			if (event.pointerType === "touch") {
				return;
			}
			cancelPendingHoverIntent();
			scheduleExpandedRowPointerExitCollapse();
		},
		onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
			lastPointerDownNativeEventDispatchedThroughPanelReactTreeRef.current = event.nativeEvent;
		},
	};

	const isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed = rowExpandedInPlaceByHover !== null;
	useEffect(() => {
		if (!isHoverExpansionCollapseOnEscapeOrPointerDownOutsidePanelArmed) {
			return;
		}
		// 键盘焦点在弹窗里（如卡上弹出的原始 prompt 弹窗：Radix 把焦点困在 role=dialog 的 Content 内）时这次 Esc 归弹窗，
		// 只关弹窗、不收起这一行。按事件目标判断，不读 defaultPrevented：App 常驻的 Esc 热键（react-hotkeys-hook，
		// preventDefault: true）启动时就挂在 document 上、先于这里对每次 Esc 都 preventDefault，读它就永远收不起。
		// 弹窗即便已被 Radix 的 capture 监听关掉、从 DOM 摘下，target 的祖先链仍在摘下的子树里，closest 照样命中。
		const collapseOnEscapeOutsideDialog = (event: KeyboardEvent) => {
			const isEscapeKeydownInsideDialog =
				event.target instanceof Element &&
				event.target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']") !== null;
			if (event.key === "Escape" && !isEscapeKeydownInsideDialog) {
				collapseRowExpandedInPlaceByHover();
			}
		};
		// 触屏没有「指针离开面板」：在面板以外按下就收起。「面板以外」按 React 子树判断：卡上弹出的 portal 弹窗
		// DOM 挂在 body 下、不在面板 DOM 里，只看 DOM 包含关系会把在弹窗里的每次按下都当成面板外，收起这一行、
		// 连卡体带弹窗一起卸载（原始 prompt 弹窗一点就关、Copy 的 click 落空）。
		// 必须挂 bubble 阶段：面板的 onPointerDownCapture 由 React 挂在 root / portal 容器上的监听派发，晚于 document 的 capture。
		const collapseOnPointerDownOutsidePanel = (event: PointerEvent) => {
			if (
				event === lastPointerDownNativeEventDispatchedThroughPanelReactTreeRef.current ||
				panelScrollContainerRef.current?.contains(event.target as Node)
			) {
				return;
			}
			collapseRowExpandedInPlaceByHover();
		};
		document.addEventListener("keydown", collapseOnEscapeOutsideDialog);
		document.addEventListener("pointerdown", collapseOnPointerDownOutsidePanel);
		return () => {
			document.removeEventListener("keydown", collapseOnEscapeOutsideDialog);
			document.removeEventListener("pointerdown", collapseOnPointerDownOutsidePanel);
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

	// 用户把悬浮卡片固定展开：恢复自然高度占位，清掉 hover 记录，免得主动收起后又落回悬浮展开。
	const forgetHoverExpansionOfRowNowKeptExpandedInList = useCallback(() => {
		cancelPendingHoverIntent();
		if (rowExpandedInPlaceByHoverRef.current !== null) {
			setRowExpandedInPlaceByHover(null);
		}
	}, [cancelPendingHoverIntent, setRowExpandedInPlaceByHover]);

	return {
		panelScrollContainerRef,
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
