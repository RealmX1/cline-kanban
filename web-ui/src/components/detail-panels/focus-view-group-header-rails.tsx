import { type CSSProperties, type ReactElement, type RefObject, useEffect, useState } from "react";
import {
	computeFocusedCardRailContentMaximumHeight,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";
import type { StageHeaderRailEdge } from "@/hooks/use-focus-view-stage-section-expansion";

/** 同一滚动口的上下分组标题共用 overlay 与滚动条避让。 */
export function FocusViewGroupHeaderRails({
	scrollRootRef,
	topPinnedGroupIds,
	bottomPinnedGroupIds,
	totalNavigableGroupCount,
	renderEntry,
}: {
	scrollRootRef: RefObject<HTMLElement | null>;
	topPinnedGroupIds: readonly string[];
	bottomPinnedGroupIds: readonly string[];
	/** 完整副本使用固定标题预算，与共享分类和跳转几何一致。 */
	totalNavigableGroupCount?: number;
	renderEntry: (groupId: string, edge: StageHeaderRailEdge) => ReactElement | null;
}) {
	// 让出滚动条宽度，使纵向滚动条仍可见可点（macOS overlay 滚动条则为 0）。与旧钉住条一致。
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
	useEffect(() => {
		const root = scrollRootRef.current;
		if (!root) {
			return;
		}
		const scrollBoundary = root.closest<HTMLElement>("[data-focus-view-column-scroll-boundary]");
		const measure = (): void => {
			const scrollbarWidth = root.offsetWidth - root.clientWidth;
			setScrollbarWidth(scrollbarWidth);
			scrollBoundary?.style.setProperty("--kb-focus-view-column-scrollbar-width", `${scrollbarWidth}px`);
			setScrollViewportHeight(root.clientHeight);
		};
		measure();
		const forwardWheelToColumn = (event: WheelEvent): void => {
			if (
				event.defaultPrevented ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				event.deltaY === 0 ||
				Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
				(event.target instanceof Node && root.contains(event.target))
			)
				return;
			// 吸顶栏与固定区在主滚动口之外；内部列表先滚，到边界后由同列接续。
			const columnCanScroll =
				event.deltaY < 0 ? root.scrollTop > 1 : root.scrollTop + root.clientHeight < root.scrollHeight - 1;
			for (const target of event.composedPath()) {
				if (target === scrollBoundary) break;
				if (!(target instanceof HTMLElement)) continue;
				// 外层 rail 的少量标题溢出不能吞掉整次滚轮；主列到边界后仍可滚出剩余标题。
				if (target.classList.contains("kb-stage-header-rail") && columnCanScroll) continue;
				if (
					["auto", "scroll"].includes(getComputedStyle(target).overflowY) &&
					(event.deltaY < 0
						? target.scrollTop > 1
						: target.scrollTop + target.clientHeight < target.scrollHeight - 1)
				)
					return;
			}
			const deltaUnitHeight =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? Number.parseFloat(getComputedStyle(root).lineHeight) || 16
					: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? root.clientHeight
						: 1;
			event.preventDefault();
			root.scrollTop += event.deltaY * deltaUnitHeight;
		};
		scrollBoundary?.addEventListener("wheel", forwardWheelToColumn, { passive: false });
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		resizeObserver?.observe(root);
		return () => {
			resizeObserver?.disconnect();
			scrollBoundary?.removeEventListener("wheel", forwardWheelToColumn);
			scrollBoundary?.style.removeProperty("--kb-focus-view-column-scrollbar-width");
		};
	}, [scrollRootRef]);
	const focusedCardContentMaximumHeight = computeFocusedCardRailContentMaximumHeight(
		scrollViewportHeight,
		totalNavigableGroupCount ?? topPinnedGroupIds.length + bottomPinnedGroupIds.length,
	);
	// 为两侧所有标题保留空间；Pinned 改变剩余视口时由同一个 ResizeObserver 更新。
	const railViewportStyle = {
		right: scrollbarWidth,
		"--kb-focused-card-rail-maximum-height": `${focusedCardContentMaximumHeight + STAGE_RAIL_FOCUSED_CARD_PADDING_PX}px`,
	} as CSSProperties;

	return (
		<>
			{topPinnedGroupIds.length > 0 ? (
				<div
					className="kb-stage-header-rail max-h-full overflow-y-auto overscroll-contain"
					data-testid="stage-header-rail"
					data-edge="top"
					style={railViewportStyle}
				>
					{topPinnedGroupIds.map((groupId) => renderEntry(groupId, "pinTop"))}
				</div>
			) : null}
			{bottomPinnedGroupIds.length > 0 ? (
				<div
					className="kb-stage-header-rail max-h-full overflow-y-auto overscroll-contain"
					data-testid="stage-header-rail"
					data-edge="bottom"
					style={railViewportStyle}
				>
					{bottomPinnedGroupIds.map((groupId) => renderEntry(groupId, "pinBottom"))}
				</div>
			) : null}
		</>
	);
}
