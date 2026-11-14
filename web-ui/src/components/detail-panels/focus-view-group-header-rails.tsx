import {
	type CSSProperties,
	type ReactElement,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import {
	computeFocusViewGroupHeaderRailRows,
	type FocusViewGroupHeaderPresentation,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";
import type { StageHeaderRailEdge } from "@/hooks/use-focus-view-stage-section-expansion";
import { forwardWheelToScrollContainer } from "@/hooks/use-task-card-portal-wheel-scroll-forwarding";

/**
 * Pinned 内容区自己的滚动条占宽时，把滚动槽伸进列滚动条已经预留的右侧空隙。
 * 分组外框保持对齐，卡片内容宽度也不再被扣第二次。
 */
export function useFocusViewPinnedSectionOwnScrollbarSlot(): {
	ref: (element: HTMLDivElement | null) => void;
	style: CSSProperties;
} {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	const ref = useCallback((next: HTMLDivElement | null) => {
		setElement((current) => (current === next ? current : next));
	}, []);
	useLayoutEffect(() => {
		if (!element) return;
		const measure = (): void => {
			const layoutScrollbarWidth = Math.max(0, element.offsetWidth - element.clientWidth);
			setScrollbarWidth((current) => {
				if (layoutScrollbarWidth > 0) return layoutScrollbarWidth === current ? current : layoutScrollbarWidth;
				// 补偿刚好消掉滚动条时，立刻撤销会让占宽滚动条回来并来回抖动。
				const contentStillFillsViewport = element.scrollHeight > element.clientHeight - 1;
				return current > 0 && contentStillFillsViewport ? current : 0;
			});
		};
		measure();
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(element);
		return () => observer?.disconnect();
	}, [element]);
	return {
		ref,
		style: scrollbarWidth > 0 ? { width: `calc(100% + ${scrollbarWidth}px)`, marginRight: -scrollbarWidth } : {},
	};
}

/** 同一滚动口的上下分组标题共用 overlay 与滚动条避让。 */
export function FocusViewGroupHeaderRails({
	scrollRootRef,
	topPinnedGroupIds,
	bottomPinnedGroupIds,
	compactGroupIds = [],
	columnCount = 1,
	focusedGroupId,
	focusedCardContentMaximumHeight = 0,
	renderEntry,
}: {
	scrollRootRef: RefObject<HTMLElement | null>;
	topPinnedGroupIds: readonly string[];
	bottomPinnedGroupIds: readonly string[];
	compactGroupIds?: readonly string[];
	columnCount?: number;
	focusedGroupId?: string;
	focusedCardContentMaximumHeight?: number;
	renderEntry: (
		groupId: string,
		edge: StageHeaderRailEdge,
		presentation: FocusViewGroupHeaderPresentation,
	) => ReactElement | null;
}) {
	// 让出滚动条宽度，使纵向滚动条仍可见可点（macOS overlay 滚动条则为 0）。与旧钉住条一致。
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
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
		};
		measure();
		const forwardWheelToColumn = (event: WheelEvent): void => {
			forwardWheelToScrollContainer(event, root);
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
	const renderRows = (groupIds: readonly string[], edge: StageHeaderRailEdge) =>
		computeFocusViewGroupHeaderRailRows({ groupIds, compactGroupIds, columnCount, focusedGroupId }).flatMap(
			(row, rowIndex) =>
				row.groupIds.map((groupId, columnIndex) => (
					<div
						key={groupId}
						className="min-w-0"
						data-focus-view-header-rail-row={rowIndex}
						style={{
							gridRowStart: rowIndex + 1,
							gridColumn:
								row.groupIds.includes(focusedGroupId ?? "") || row.presentation === "standard"
									? "1 / -1"
									: columnIndex + 1,
						}}
					>
						{renderEntry(groupId, edge, row.presentation)}
					</div>
				)),
		);

	// 为两侧所有标题保留空间；Pinned 改变剩余视口时由同一个 ResizeObserver 更新。
	const railViewportStyle = {
		right: scrollbarWidth,
		gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
		"--kb-focused-card-rail-maximum-height": `${focusedCardContentMaximumHeight + STAGE_RAIL_FOCUSED_CARD_PADDING_PX}px`,
	} as CSSProperties;

	return (
		<>
			{topPinnedGroupIds.length > 0 ? (
				<div
					className="kb-stage-header-rail max-h-full overflow-y-auto overscroll-contain"
					data-testid="stage-header-rail"
					data-verification-anchor="focus-view-group-header-rails"
					data-edge="top"
					style={railViewportStyle}
				>
					{renderRows(topPinnedGroupIds, "pinTop")}
				</div>
			) : null}
			{bottomPinnedGroupIds.length > 0 ? (
				<div
					className="kb-stage-header-rail max-h-full overflow-y-auto overscroll-contain"
					data-testid="stage-header-rail"
					data-verification-anchor="focus-view-group-header-rails"
					data-edge="bottom"
					style={railViewportStyle}
				>
					{renderRows(bottomPinnedGroupIds, "pinBottom")}
				</div>
			) : null}
		</>
	);
}
