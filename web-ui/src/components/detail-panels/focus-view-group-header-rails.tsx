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
		const measure = (): void => {
			setScrollbarWidth(root.offsetWidth - root.clientWidth);
			setScrollViewportHeight(root.clientHeight);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const resizeObserver = new ResizeObserver(measure);
		resizeObserver.observe(root);
		return () => resizeObserver.disconnect();
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
