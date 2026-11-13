import { autoUpdate } from "@floating-ui/dom";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";

// 底部为卡体描边保留 1px，按钮独立定位，不计入卡体限高。
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
		const headerRailHost = hostingScrollContainer.parentElement;
		const findHeaderRails = () =>
			headerRailHost?.querySelectorAll<HTMLElement>(":scope > .kb-stage-header-rail") ?? [];

		const updateFloatingCardViewportPosition = () => {
			const scrollContainerRect = hostingScrollContainer.getBoundingClientRect();
			let viewportTopPx = Math.max(0, scrollContainerRect.top + hostingScrollContainer.clientTop);
			let viewportBottomPx = Math.min(
				window.innerHeight,
				scrollContainerRect.top + hostingScrollContainer.clientTop + hostingScrollContainer.clientHeight,
			);
			// 直接复用已渲染标题 rail 的边界，完整副本和展开卡也不能盖住导航。
			for (const headerRail of findHeaderRails()) {
				const headerRailRect = headerRail.getBoundingClientRect();
				if (headerRail.dataset.edge === "top") viewportTopPx = Math.max(viewportTopPx, headerRailRect.bottom);
				else if (headerRail.dataset.edge === "bottom")
					viewportBottomPx = Math.min(viewportBottomPx, headerRailRect.top);
			}
			const maximumHeightPx = Math.max(0, viewportBottomPx - viewportTopPx);
			const rowTopPx = rowElement.getBoundingClientRect().top;
			const naturalFloatingCardHeightPx =
				fullTaskCardContentElement.getBoundingClientRect().height + FLOATING_CARD_BOTTOM_RING_RESERVE_PX;
			const visibleFloatingCardHeightPx = Math.min(naturalFloatingCardHeightPx, maximumHeightPx);
			const floatingCardTopPx = Math.max(
				viewportTopPx,
				Math.min(rowTopPx, viewportBottomPx - visibleFloatingCardHeightPx),
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
		const observeHeaderRails = () => {
			for (const headerRail of findHeaderRails()) resizeObserver?.observe(headerRail);
			updateFloatingCardViewportPosition();
		};
		observeHeaderRails();
		const headerRailMutationObserver = new MutationObserver(observeHeaderRails);
		if (headerRailHost) headerRailMutationObserver.observe(headerRailHost, { childList: true });
		window.addEventListener("scroll", updateFloatingCardViewportPosition, true);
		window.addEventListener("resize", updateFloatingCardViewportPosition);
		return () => {
			stopObservingRowLayoutShift();
			resizeObserver?.disconnect();
			headerRailMutationObserver.disconnect();
			window.removeEventListener("scroll", updateFloatingCardViewportPosition, true);
			window.removeEventListener("resize", updateFloatingCardViewportPosition);
		};
	}, [isFloatingCardVisible, hostingScrollContainerRef]);

	const floatingCardViewportStyle: CSSProperties | undefined = isFloatingCardVisible
		? {
				top: position?.topOffsetFromRowPx ?? 0,
				maxHeight: position?.maximumHeightPx,
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
