import { type MutableRefObject, type ReactElement, type ReactNode, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/components/ui/cn";

// 浮层离视口上下边至少留这么多。
const HOVER_OVERLAY_VIEWPORT_EDGE_MARGIN_PX = 8;

interface HoverOverlayViewportPosition {
	topPx: number;
	leftPx: number;
	widthPx: number;
}

function computeHoverOverlayViewportPosition(
	anchorRowElement: HTMLElement,
	overlayHeightPx: number,
): HoverOverlayViewportPosition {
	const anchorRowRect = anchorRowElement.getBoundingClientRect();
	const viewportHeightPx = window.innerHeight;
	// 默认盖在行上、上沿对齐；放不下就以行的下沿为底向上翻；还放不下就贴视口上沿。
	let topPx = anchorRowRect.top;
	if (topPx + overlayHeightPx > viewportHeightPx - HOVER_OVERLAY_VIEWPORT_EDGE_MARGIN_PX) {
		topPx = Math.max(HOVER_OVERLAY_VIEWPORT_EDGE_MARGIN_PX, anchorRowRect.bottom - overlayHeightPx);
	}
	return { topPx, leftPx: anchorRowRect.left, widthPx: anchorRowRect.width };
}

/**
 * All projects 面板一行的 hover 浮层：完整卡片盖在该行原位（同左沿、同宽），portal 到 body 以免被面板的滚动容器
 * 裁掉，不推挤下方的行。`isRevealed` 为 false 时已挂载但不可见、不接指针——借此在 hover 意图期间预取其他项目的卡。
 */
export function CrossProjectRecentlyActiveTaskSwitcherTaskRowFullTaskCardHoverOverlay({
	anchorRowElement,
	isRevealed,
	hoverOverlayElementRef,
	onPointerEnter,
	onPointerLeave,
	children,
}: {
	anchorRowElement: HTMLElement;
	isRevealed: boolean;
	hoverOverlayElementRef: MutableRefObject<HTMLDivElement | null>;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	children: ReactNode;
}): ReactElement {
	const [viewportPosition, setViewportPosition] = useState<HoverOverlayViewportPosition>(() =>
		computeHoverOverlayViewportPosition(anchorRowElement, 0),
	);

	useLayoutEffect(() => {
		const overlayElement = hoverOverlayElementRef.current;
		if (!overlayElement) {
			return;
		}
		const reposition = () => {
			setViewportPosition(computeHoverOverlayViewportPosition(anchorRowElement, overlayElement.offsetHeight));
		};
		reposition();
		// 其他项目的卡先显示「加载中」再补全，高度会变：跟着重新算一次是否要向上翻。
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const resizeObserver = new ResizeObserver(reposition);
		resizeObserver.observe(overlayElement);
		return () => resizeObserver.disconnect();
	}, [anchorRowElement, hoverOverlayElementRef]);

	return createPortal(
		<div
			ref={hoverOverlayElementRef}
			role="dialog"
			aria-label="Task details"
			aria-hidden={isRevealed ? undefined : true}
			data-testid="cross-project-task-switcher-row-full-task-card-hover-overlay"
			data-cross-project-task-switcher-hover-overlay-revealed={isRevealed}
			className={cn(
				"fixed z-50 flex max-h-[calc(100svh-16px)] flex-col overflow-y-auto rounded-md border border-border bg-surface-2 p-1 shadow-xl",
				isRevealed ? "visible" : "pointer-events-none invisible",
			)}
			style={{ top: viewportPosition.topPx, left: viewportPosition.leftPx, width: viewportPosition.widthPx }}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
		>
			{children}
		</div>,
		document.body,
	);
}
