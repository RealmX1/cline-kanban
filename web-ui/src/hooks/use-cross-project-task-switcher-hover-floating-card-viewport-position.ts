import { autoUpdate } from "@floating-ui/dom";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX } from "@/components/task-card-body";

// 动作组上伸 12px，展开开关的命中区还向上扩 4px；底部为 ring 留 1px。
const FLOATING_CARD_TOP_ACTION_HIT_AREA_RESERVE_PX =
	CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_OVERHANG_ABOVE_ROW_TOP_EDGE_PX + 4;
const FLOATING_CARD_BOTTOM_RING_RESERVE_PX = 1;

interface FloatingCardViewportPosition {
	topOffsetFromRowPx: number;
	maximumHeightPx: number;
	requiresInternalScrolling: boolean;
}

/**
 * 浮层留在行的 React/DOM 子树中，定位只移动浮层，绝不写列表 scrollTop。
 * 测量不受高度限制的内层卡体，首帧、快照到达、滚动与缩放时都以宿主滚动可视区重新夹取位置。
 */
export function useCrossProjectTaskSwitcherHoverFloatingCardViewportPosition({
	isFloatingCardVisible,
	hostingScrollContainerRef,
}: {
	isFloatingCardVisible: boolean;
	hostingScrollContainerRef?: RefObject<HTMLElement | null>;
}) {
	const rowElementRef = useRef<HTMLDivElement | null>(null);
	const fullTaskCardContentElementRef = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState<FloatingCardViewportPosition | null>(null);

	useLayoutEffect(() => {
		if (!isFloatingCardVisible) return;
		const rowElement = rowElementRef.current;
		const fullTaskCardContentElement = fullTaskCardContentElementRef.current;
		const hostingScrollContainer = hostingScrollContainerRef?.current;
		if (!rowElement || !fullTaskCardContentElement || !hostingScrollContainer) return;

		const updateFloatingCardViewportPosition = () => {
			const scrollContainerRect = hostingScrollContainer.getBoundingClientRect();
			const viewportTopPx = Math.max(0, scrollContainerRect.top + hostingScrollContainer.clientTop);
			const viewportBottomPx = Math.min(
				window.innerHeight,
				scrollContainerRect.top + hostingScrollContainer.clientTop + hostingScrollContainer.clientHeight,
			);
			const maximumHeightPx = Math.max(0, viewportBottomPx - viewportTopPx);
			const rowTopPx = rowElement.getBoundingClientRect().top;
			const naturalFloatingCardHeightPx =
				fullTaskCardContentElement.getBoundingClientRect().height +
				FLOATING_CARD_TOP_ACTION_HIT_AREA_RESERVE_PX +
				FLOATING_CARD_BOTTOM_RING_RESERVE_PX;
			const visibleFloatingCardHeightPx = Math.min(naturalFloatingCardHeightPx, maximumHeightPx);
			const floatingCardTopPx = Math.max(
				viewportTopPx,
				Math.min(
					rowTopPx - FLOATING_CARD_TOP_ACTION_HIT_AREA_RESERVE_PX,
					viewportBottomPx - visibleFloatingCardHeightPx,
				),
			);
			const nextPosition: FloatingCardViewportPosition = {
				topOffsetFromRowPx: floatingCardTopPx - rowTopPx,
				maximumHeightPx,
				requiresInternalScrolling: naturalFloatingCardHeightPx > maximumHeightPx,
			};
			setPosition((previous) =>
				previous?.topOffsetFromRowPx === nextPosition.topOffsetFromRowPx &&
				previous.maximumHeightPx === nextPosition.maximumHeightPx &&
				previous.requiresInternalScrolling === nextPosition.requiresInternalScrolling
					? previous
					: nextPosition,
			);
		};

		const stopObservingRowLayoutShift = autoUpdate(
			rowElement,
			fullTaskCardContentElement,
			updateFloatingCardViewportPosition,
			{
				ancestorScroll: false,
				ancestorResize: false,
				elementResize: false,
			},
		);
		const resizeObserver =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFloatingCardViewportPosition);
		resizeObserver?.observe(rowElement);
		resizeObserver?.observe(fullTaskCardContentElement);
		resizeObserver?.observe(hostingScrollContainer);
		window.addEventListener("scroll", updateFloatingCardViewportPosition, true);
		window.addEventListener("resize", updateFloatingCardViewportPosition);
		return () => {
			stopObservingRowLayoutShift();
			resizeObserver?.disconnect();
			window.removeEventListener("scroll", updateFloatingCardViewportPosition, true);
			window.removeEventListener("resize", updateFloatingCardViewportPosition);
		};
	}, [isFloatingCardVisible, hostingScrollContainerRef]);

	const floatingCardViewportStyle: CSSProperties | undefined = isFloatingCardVisible
		? {
				top: position?.topOffsetFromRowPx ?? -FLOATING_CARD_TOP_ACTION_HIT_AREA_RESERVE_PX,
				maxHeight: position?.maximumHeightPx,
				paddingTop: FLOATING_CARD_TOP_ACTION_HIT_AREA_RESERVE_PX,
				paddingBottom: FLOATING_CARD_BOTTOM_RING_RESERVE_PX,
			}
		: undefined;
	return {
		rowElementRef,
		fullTaskCardContentElementRef,
		floatingCardViewportStyle,
		requiresInternalScrolling: position?.requiresInternalScrolling ?? false,
	};
}
