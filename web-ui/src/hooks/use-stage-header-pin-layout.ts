import type { RefObject } from "react";
import { useEffect, useState } from "react";

import {
	computeFocusViewCompactHeaderColumnCount,
	computeFocusViewGroupHeaderRailHeight,
	computeStageHeaderPinLayoutGeometry,
	FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY,
	measureFocusViewSectionFirstCardBoxes,
	measureFocusViewUncoveredTaskCardHeightPx,
	type StageHeaderPinLayoutGeometry,
	selectUncoveredTaskCardHeightPx,
} from "@/components/detail-panels/stage-header-rail-geometry";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";
import { useMedia } from "@/utils/react-use";

/** 分组范围、标题行与焦点副本由共享几何计算，DOM 观察只负责提供测量值。 */
export type StageHeaderPinLayout = StageHeaderPinLayoutGeometry;

export interface UseStageHeaderPinLayoutOptions {
	/** 滚动容器（`.kb-detail-task-list-scroll`）的 ref，作为几何判定的视口基准。 */
	scrollRootRef: RefObject<HTMLElement | null>;
	/** 全部 stage 的 columnId，按列表文档序。 */
	columnIds: readonly string[];
	/** 焦点卡所在 stage 的 columnId。 */
	focusedColumnId: string;
	/** 焦点卡 taskId：其真实卡高用于把焦点条目（卡头+卡）计入堆叠偏移。 */
	focusedTaskId: string;
	/** 焦点卡当前钉住状态：仅当它钉在某边时，焦点条目才含卡（高于普通卡头）。 */
	focusedCardPinState: SelectedCardPinState;
	/** 为 `false`（如拖拽期，真实卡被 portal 到 body 致几何失真）时暂停并返回空布局。 */
	enabled?: boolean;
	sectionElementAttributeName?: string;
	focusedCardElementSelector?: string;
	/** 未受视口限高的完整副本自然高度，不包含 rail 外层 padding。 */
	focusedCardCloneHeightPx?: number;
}

const EMPTY_LAYOUT: StageHeaderPinLayout = {
	topPinnedColumnIds: [],
	bottomPinnedColumnIds: [],
	focusedCardRailEdge: "hidden",
	compactGroupIds: [],
	columnCount: 1,
	focusedCardContentMaximumHeight: 0,
};

/** 首帧就读 matchMedia。useMedia 在传入默认值时不会同步查询，桌面会先画一帧普通单列标题。 */
function readCompactGroupHeadersMediaMatch(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY).matches;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) {
			return false;
		}
	}
	return true;
}

export function useStageHeaderPinLayout({
	scrollRootRef,
	columnIds,
	focusedColumnId,
	focusedTaskId,
	focusedCardPinState,
	enabled = true,
	sectionElementAttributeName = "data-stage-section-id",
	focusedCardElementSelector,
	focusedCardCloneHeightPx,
}: UseStageHeaderPinLayoutOptions): StageHeaderPinLayout {
	const compactHeadersEnabled = useMedia(
		FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY,
		readCompactGroupHeadersMediaMatch(),
	);
	const [layout, setLayout] = useState<StageHeaderPinLayout>(EMPTY_LAYOUT);
	// 数组入参每渲染换新引用；用稳定字符串 key 作为 effect 依赖，并在 effect 内还原（columnId 不含此分隔符）。
	const columnIdsKey = columnIds.join("\0");

	useEffect(() => {
		const commit = (next: StageHeaderPinLayout): void => {
			setLayout((prev) =>
				sameIds(prev.topPinnedColumnIds, next.topPinnedColumnIds) &&
				sameIds(prev.bottomPinnedColumnIds, next.bottomPinnedColumnIds) &&
				prev.focusedCardRailEdge === next.focusedCardRailEdge &&
				sameIds(prev.compactGroupIds, next.compactGroupIds) &&
				prev.columnCount === next.columnCount &&
				prev.focusedCardContentMaximumHeight === next.focusedCardContentMaximumHeight
					? prev
					: next,
			);
		};

		if (!enabled) {
			commit(EMPTY_LAYOUT);
			return;
		}
		const root = scrollRootRef.current;
		if (!root) {
			commit(EMPTY_LAYOUT);
			return;
		}
		const orderedColumnIds = columnIdsKey.length > 0 ? columnIdsKey.split("\0") : [];

		let frameId = 0;

		const computeNow = (): void => {
			frameId = 0;
			const rootRect = root.getBoundingClientRect();
			// 无布局（jsdom / 面板隐藏）：零高度视口无法有意义分类 → 空布局，不误钉全部。
			if (rootRect.bottom <= rootRect.top) {
				commit(EMPTY_LAYOUT);
				return;
			}
			const focusedCardRect = root
				.querySelector<HTMLElement>(
					focusedCardElementSelector ?? `[data-task-id="${escapeCssAttributeSelectorValue(focusedTaskId)}"]`,
				)
				?.getBoundingClientRect();
			const sections = orderedColumnIds.map((id) => {
				const rect = root
					.querySelector<HTMLElement>(`[${sectionElementAttributeName}="${escapeCssAttributeSelectorValue(id)}"]`)
					?.getBoundingClientRect();
				return { id, top: rect?.top ?? Number.NaN, bottom: rect?.bottom ?? Number.NaN };
			});
			const naturalFocusedCardHeight = focusedCardRect ? focusedCardCloneHeightPx || focusedCardRect.height : 0;
			const layoutInput = {
				sections,
				viewportTop: rootRect.top,
				viewportHeight: rootRect.height,
				columnCount: computeFocusViewCompactHeaderColumnCount(root.clientWidth || rootRect.width),
				compactHeadersEnabled,
				focusedColumnId,
				focusedCardTop: focusedCardRect?.top ?? 0,
				focusedCardBottom: focusedCardRect?.bottom ?? 0,
				focusedCardHeight: naturalFocusedCardHeight,
				focusedCardPinState,
			};
			const layoutForCard = (uncoveredTaskCardHeightPx: number): StageHeaderPinLayoutGeometry =>
				computeStageHeaderPinLayoutGeometry({ ...layoutInput, uncoveredTaskCardHeightPx });
			const topRailHeightForCard = (uncoveredTaskCardHeightPx: number): number => {
				const layout = layoutForCard(uncoveredTaskCardHeightPx);
				return computeFocusViewGroupHeaderRailHeight({
					groupIds: layout.topPinnedColumnIds,
					compactGroupIds: layout.compactGroupIds,
					columnCount: layout.columnCount,
					focusedGroupId: layout.focusedCardRailEdge === "pinTop" ? focusedColumnId : undefined,
					focusedCardHeight: Math.min(naturalFocusedCardHeight, layout.focusedCardContentMaximumHeight),
				});
			};
			const uncoveredTaskCardHeightPx = selectUncoveredTaskCardHeightPx({
				sections: measureFocusViewSectionFirstCardBoxes(root),
				viewportTop: rootRect.top,
				initialCardHeightPx: measureFocusViewUncoveredTaskCardHeightPx(root),
				topRailHeightForCard,
			});
			commit(layoutForCard(uncoveredTaskCardHeightPx));
		};

		const scheduleCompute = (): void => {
			if (frameId !== 0) {
				return;
			}
			frameId = window.requestAnimationFrame(computeNow);
		};

		computeNow();

		root.addEventListener("scroll", scheduleCompute, { passive: true });
		window.addEventListener("resize", scheduleCompute);
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleCompute);
		resizeObserver?.observe(root);
		// 同 useSelectedCardPinState：`attributeFilter: ["style"]` 抓 stage 折叠/展开的 display 翻转、
		// childList 抓 peek 支路的卡集切换与渐进渲染挂载，characterData 抓活动文案换行改高度。
		const mutationObserver = new MutationObserver(scheduleCompute);
		mutationObserver.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["style"],
		});

		return () => {
			if (frameId !== 0) {
				window.cancelAnimationFrame(frameId);
			}
			root.removeEventListener("scroll", scheduleCompute);
			window.removeEventListener("resize", scheduleCompute);
			resizeObserver?.disconnect();
			mutationObserver.disconnect();
		};
	}, [
		columnIdsKey,
		focusedColumnId,
		focusedTaskId,
		focusedCardPinState,
		enabled,
		scrollRootRef,
		sectionElementAttributeName,
		focusedCardElementSelector,
		focusedCardCloneHeightPx,
		compactHeadersEnabled,
	]);

	return layout;
}
