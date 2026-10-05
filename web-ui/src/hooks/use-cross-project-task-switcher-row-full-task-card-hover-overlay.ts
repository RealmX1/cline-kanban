import {
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

// EXPERIMENT_NODE: hover 多久才弹完整卡片浮层（350ms）；太短扫过列表时会一路弹，太长又像没反应
const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_INTENT_REVEAL_DELAY_MS = 350;
// 指针离开行 / 浮层后多久收起：留出从行挪进浮层（浮层盖在行上，几乎同一帧）与擦边而过的余量。
const CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_EXIT_CLOSE_DELAY_MS = 150;
// 触屏没有 hover，改用长按。
const CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_REVEAL_DELAY_MS = 500;
// 长按期间手指挪动超过这么远就算滚动，不弹浮层。
const CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_MOVEMENT_TOLERANCE_PX = 8;

export interface CrossProjectTaskSwitcherRowFullTaskCardHoverOverlayTarget {
	entryKey: string;
	anchorRowElement: HTMLElement;
	// false = 指针刚进来、还在等 hover 意图：浮层已挂载（借此预取其他项目的卡）但不可见、不接指针。
	isRevealed: boolean;
}

export interface CrossProjectTaskSwitcherRowHoverOverlayTriggerProps {
	onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
	onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * All projects 面板的行：hover（触屏长按）后，在行的原位浮出完整卡片（不推挤下方的行）。同一时刻只有一个浮层。
 * 浮层本身的定位与渲染在 cross-project-recently-active-task-switcher-task-row-full-task-card-hover-overlay.tsx。
 */
export function useCrossProjectTaskSwitcherRowFullTaskCardHoverOverlay(): {
	hoverOverlayTarget: CrossProjectTaskSwitcherRowFullTaskCardHoverOverlayTarget | null;
	buildRowHoverOverlayTriggerProps: (entryKey: string) => CrossProjectTaskSwitcherRowHoverOverlayTriggerProps;
	overlayPointerHandlers: { onPointerEnter: () => void; onPointerLeave: () => void };
	closeHoverOverlay: () => void;
	hoverOverlayElementRef: React.MutableRefObject<HTMLDivElement | null>;
} {
	const [hoverOverlayTarget, setHoverOverlayTargetState] =
		useState<CrossProjectTaskSwitcherRowFullTaskCardHoverOverlayTarget | null>(null);
	// 事件处理器要同步读到最新值（不在 setState 的 updater 里做副作用），所以另存一份 ref。
	const hoverOverlayTargetRef = useRef<CrossProjectTaskSwitcherRowFullTaskCardHoverOverlayTarget | null>(null);
	const setHoverOverlayTarget = useCallback(
		(nextTarget: CrossProjectTaskSwitcherRowFullTaskCardHoverOverlayTarget | null) => {
			hoverOverlayTargetRef.current = nextTarget;
			setHoverOverlayTargetState(nextTarget);
		},
		[],
	);
	const revealTimeoutIdRef = useRef<number | null>(null);
	const closeTimeoutIdRef = useRef<number | null>(null);
	const touchLongPressRef = useRef<{ timeoutId: number; startX: number; startY: number } | null>(null);
	// 长按弹出浮层后，抬手那一下会接着派发 click：吞掉它，否则行被当成「打开任务」。
	// 只作用于本次长按手势：不少移动浏览器长按后根本不发 click（或 click 落在盖住行的浮层上），没被消费的标志
	// 会在下一次 pointerdown（新手势）与浮层收起时作废，不能留着吞掉之后第一次点行。
	const suppressNextRowClickAfterTouchLongPressRef = useRef(false);
	const hoverOverlayElementRef = useRef<HTMLDivElement | null>(null);

	const clearRevealTimeout = useCallback(() => {
		if (revealTimeoutIdRef.current !== null) {
			window.clearTimeout(revealTimeoutIdRef.current);
			revealTimeoutIdRef.current = null;
		}
	}, []);
	const clearCloseTimeout = useCallback(() => {
		if (closeTimeoutIdRef.current !== null) {
			window.clearTimeout(closeTimeoutIdRef.current);
			closeTimeoutIdRef.current = null;
		}
	}, []);
	const clearTouchLongPress = useCallback(() => {
		if (touchLongPressRef.current) {
			window.clearTimeout(touchLongPressRef.current.timeoutId);
			touchLongPressRef.current = null;
		}
	}, []);

	const closeHoverOverlay = useCallback(() => {
		clearRevealTimeout();
		clearCloseTimeout();
		clearTouchLongPress();
		suppressNextRowClickAfterTouchLongPressRef.current = false;
		setHoverOverlayTarget(null);
	}, [clearCloseTimeout, clearRevealTimeout, clearTouchLongPress, setHoverOverlayTarget]);

	const scheduleCloseHoverOverlay = useCallback(() => {
		clearCloseTimeout();
		closeTimeoutIdRef.current = window.setTimeout(() => {
			closeTimeoutIdRef.current = null;
			setHoverOverlayTarget(null);
		}, CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_EXIT_CLOSE_DELAY_MS);
	}, [clearCloseTimeout, setHoverOverlayTarget]);

	const revealHoverOverlay = useCallback(() => {
		const currentTarget = hoverOverlayTargetRef.current;
		if (currentTarget && !currentTarget.isRevealed) {
			setHoverOverlayTarget({ ...currentTarget, isRevealed: true });
		}
	}, [setHoverOverlayTarget]);

	const buildRowHoverOverlayTriggerProps = useCallback(
		(entryKey: string): CrossProjectTaskSwitcherRowHoverOverlayTriggerProps => ({
			onPointerEnter: (event) => {
				if (event.pointerType === "touch") {
					return;
				}
				clearCloseTimeout();
				const anchorRowElement = event.currentTarget;
				const currentTarget = hoverOverlayTargetRef.current;
				if (currentTarget?.entryKey === entryKey && currentTarget.anchorRowElement === anchorRowElement) {
					// 从浮层挪回自己这一行：浮层仍开着，不必重新计时。
					if (currentTarget.isRevealed) {
						return;
					}
				} else {
					setHoverOverlayTarget({ entryKey, anchorRowElement, isRevealed: false });
				}
				clearRevealTimeout();
				revealTimeoutIdRef.current = window.setTimeout(() => {
					revealTimeoutIdRef.current = null;
					revealHoverOverlay();
				}, CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_INTENT_REVEAL_DELAY_MS);
			},
			onPointerLeave: (event) => {
				if (event.pointerType === "touch") {
					return;
				}
				clearRevealTimeout();
				const currentTarget = hoverOverlayTargetRef.current;
				if (!currentTarget || currentTarget.entryKey !== entryKey) {
					return;
				}
				// 还没弹出就离开：撤掉预取用的隐形浮层。
				if (!currentTarget.isRevealed) {
					setHoverOverlayTarget(null);
					return;
				}
				scheduleCloseHoverOverlay();
			},
			onPointerDown: (event) => {
				// 新手势开始（任意 pointerType）：上一次长按没被消费的「吞 click」标志作废，免得误吞这次手势的 click。
				suppressNextRowClickAfterTouchLongPressRef.current = false;
				if (event.pointerType !== "touch") {
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
						clearCloseTimeout();
						setHoverOverlayTarget({ entryKey, anchorRowElement, isRevealed: true });
					}, CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_REVEAL_DELAY_MS),
				};
			},
			onPointerMove: (event) => {
				const touchLongPress = touchLongPressRef.current;
				if (!touchLongPress) {
					return;
				}
				if (
					Math.hypot(event.clientX - touchLongPress.startX, event.clientY - touchLongPress.startY) >
					CROSS_PROJECT_TASK_SWITCHER_ROW_TOUCH_LONG_PRESS_MOVEMENT_TOLERANCE_PX
				) {
					clearTouchLongPress();
				}
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
			clearCloseTimeout,
			clearRevealTimeout,
			clearTouchLongPress,
			revealHoverOverlay,
			scheduleCloseHoverOverlay,
			setHoverOverlayTarget,
		],
	);

	const overlayPointerHandlers = {
		onPointerEnter: clearCloseTimeout,
		onPointerLeave: scheduleCloseHoverOverlay,
	};

	const isHoverOverlayRevealed = hoverOverlayTarget?.isRevealed === true;
	useEffect(() => {
		if (!isHoverOverlayRevealed) {
			return;
		}
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				closeHoverOverlay();
			}
		};
		// 浮层按行的位置钉在视口上，列表一滚就对不上了。
		const closeOnScroll = (event: Event) => {
			if (hoverOverlayElementRef.current?.contains(event.target as Node)) {
				return;
			}
			closeHoverOverlay();
		};
		// 触屏没有「指针离开」：点浮层以外任何地方就收起。
		const closeOnPointerDownOutsideOverlay = (event: PointerEvent) => {
			if (hoverOverlayElementRef.current?.contains(event.target as Node)) {
				return;
			}
			closeHoverOverlay();
		};
		document.addEventListener("keydown", closeOnEscape);
		window.addEventListener("scroll", closeOnScroll, true);
		document.addEventListener("pointerdown", closeOnPointerDownOutsideOverlay, true);
		return () => {
			document.removeEventListener("keydown", closeOnEscape);
			window.removeEventListener("scroll", closeOnScroll, true);
			document.removeEventListener("pointerdown", closeOnPointerDownOutsideOverlay, true);
		};
	}, [closeHoverOverlay, isHoverOverlayRevealed]);

	useEffect(
		() => () => {
			clearRevealTimeout();
			clearCloseTimeout();
			clearTouchLongPress();
		},
		[clearCloseTimeout, clearRevealTimeout, clearTouchLongPress],
	);

	return {
		hoverOverlayTarget,
		buildRowHoverOverlayTriggerProps,
		overlayPointerHandlers,
		closeHoverOverlay,
		hoverOverlayElementRef,
	};
}
