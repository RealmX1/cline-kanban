import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
	computeFocusViewCompactHeaderColumnCount,
	computeScrollTopAfterCollapsingStageFromTopRail,
	computeScrollTopForJumpingToStageBelowTopRail,
	FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY,
	measureFocusViewUncoveredTaskCardHeightPx,
} from "@/components/detail-panels/stage-header-rail-geometry";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardDisplayGroupId } from "@/types";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/**
 * Focus View 左侧 stage 手风琴的折叠状态 + 由 stage 卡头发起的滚动（跳转 / 折叠 / 展开）。
 *
 * 为什么折叠状态要集中在面板层：同一个 stage 卡头有两份渲染——列表里随内容滚动的**行内卡头**，与
 * `StageHeaderRails` 钉在顶/底沿的**孪生卡头**（不透明 overlay，钉住时盖住行内卡头）。孪生卡头若读不到
 * 这份状态，箭头只能写死「已展开」、点了也折不动；置顶板的「跳回本体卡」也要能先展开目标所在分段
 * （折叠时整段 `display:none`，无法滚入视野）。
 *
 * 由 rail 卡头发起的动作各有滚动策略（行内卡头就在视口里，原地折叠/展开即可，不滚动）：
 * - **跳转**（点 rail 卡头的标签）：把目标 section 上沿停在顶 rail 下沿，第一张卡完整露出；
 * - **从顶 rail 折叠**：见 `computeScrollTopAfterCollapsingStageFromTopRail`——正在看它就把卡头停回槽位、
 *   下一个 stage 紧随其后；整段已在视口之上就等量补偿、视口纹丝不动；
 * - **从底 rail 折叠**：它的内容全在视口之下，折叠不影响视口，不滚动；
 * - **从任一 rail 展开**：展开后顺势跳到该 stage——rail 卡头代表的是视口外的 stage，只翻箭头而视口
 *   不变，等于「点了没反应」。
 */

/** 无显式操作时的默认展开态：Done（trash）默认折叠，其余默认展开。 */
function isStageSectionExpandedByDefault(columnId: string): boolean {
	return columnId !== "trash" && columnId !== "shelved";
}

/** 折叠/展开按钮所在的 rail 沿，对应 `SelectedCardPinState` 的钉住方向。 */
export type StageHeaderRailEdge = "pinTop" | "pinBottom";

type PendingScrollAdjustmentAfterStageSectionToggle =
	| {
			kind: "jump_to_stage_section_after_expanding_it_from_stage_header_rail";
			columnId: string;
	  }
	| {
			kind: "keep_viewport_steady_after_collapsing_stage_section_from_top_rail";
			/** 记住 section 节点本身：翻转后它仍是同一个节点，直接量它折叠后的高度。 */
			stageSectionElement: HTMLElement;
			stageSectionHeightBeforeCollapse: number;
			/** 翻转**前**的 `scrollTop`；折叠后内容变矮，浏览器可能已钳制，必须用这个值做绝对赋值。 */
			scrollTopBeforeCollapse: number;
			scrollTopThatDocksCollapsedStageAtItsTopRailSlot: number;
	  };

export interface UseFocusViewStageSectionExpansionOptions {
	/** 滚动容器（`.kb-detail-task-list-scroll`）的 ref：滚动落点的基准与被写方。 */
	scrollRootRef: RefObject<HTMLElement | null>;
	/** 全部 stage 的 columnId，按列表文档序（跳转落点按目标之上有几个 stage 计算顶 rail 高度）。 */
	orderedColumnIds: readonly BoardDisplayGroupId[];
	fixedTopGroupIds?: readonly string[];
	/** 焦点卡所在 stage：它在目标之上且焦点卡会钉顶时，顶 rail 多出一张焦点卡克隆的高度。 */
	focusedColumnId: BoardDisplayGroupId;
	focusedTaskId: string;
}

export interface FocusViewStageSectionExpansionController {
	isStageSectionExpanded: (columnId: BoardDisplayGroupId) => boolean;
	/** 行内卡头：原地折叠/展开，不滚动。 */
	toggleStageSectionExpandedFromInFlowHeader: (columnId: BoardDisplayGroupId) => void;
	/** rail 孪生卡头的折叠按钮：折叠/展开 + 按上面的策略调整滚动。 */
	toggleStageSectionExpandedFromStageHeaderRail: (
		columnId: BoardDisplayGroupId,
		railEdge: StageHeaderRailEdge,
	) => void;
	/** 只展开、不滚动（调用方自己负责随后的滚动，如置顶板「跳回本体卡」）。 */
	expandStageSectionWithoutScrolling: (columnId: BoardDisplayGroupId) => void;
	/** rail 孪生卡头的标签：跳到该 stage，第一张卡完整露在顶 rail 之下。 */
	jumpToStageSectionBelowTopRail: (columnId: BoardDisplayGroupId) => void;
}

export function useFocusViewStageSectionExpansion({
	scrollRootRef,
	orderedColumnIds,
	fixedTopGroupIds,
	focusedColumnId,
	focusedTaskId,
}: UseFocusViewStageSectionExpansionOptions): FocusViewStageSectionExpansionController {
	const [isShelvedSectionExpanded, setIsShelvedSectionExpanded] = useBooleanLocalStorageValue(
		LocalStorageKey.FocusViewShelvedSectionExpanded,
		false,
	);
	const [explicitExpandedByColumnId, setExplicitExpandedByColumnId] = useState<Partial<Record<string, boolean>>>({});

	const isStageSectionExpanded = useCallback(
		(columnId: string): boolean =>
			columnId === "shelved"
				? isShelvedSectionExpanded
				: (explicitExpandedByColumnId[columnId] ?? isStageSectionExpandedByDefault(columnId)),
		[explicitExpandedByColumnId, isShelvedSectionExpanded],
	);

	const setStageSectionExpanded = useCallback(
		(columnId: string, isExpanded: boolean): void => {
			if (columnId === "shelved") setIsShelvedSectionExpanded(isExpanded);
			setExplicitExpandedByColumnId((previous) => ({ ...previous, [columnId]: isExpanded }));
		},
		[setIsShelvedSectionExpanded],
	);

	return useFocusViewGroupSectionNavigation({
		scrollRootRef,
		orderedColumnIds,
		fixedTopGroupIds,
		focusedColumnId,
		focusedCardElementSelector: `[data-task-id="${escapeCssAttributeSelectorValue(focusedTaskId)}"]`,
		isStageSectionExpanded,
		setStageSectionExpanded,
	});
}

/** 两种 Focus View 共用跳转、折叠补偿与测量，只由宿主提供分组状态和唯一源行。 */
export function useFocusViewGroupSectionNavigation({
	scrollRootRef,
	orderedColumnIds,
	fixedTopGroupIds,
	focusedColumnId,
	focusedCardElementSelector,
	focusedCardCloneHeightPx,
	sectionElementAttributeName = "data-stage-section-id",
	isStageSectionExpanded,
	setStageSectionExpanded,
}: {
	scrollRootRef: RefObject<HTMLElement | null>;
	orderedColumnIds: readonly string[];
	fixedTopGroupIds?: readonly string[];
	focusedColumnId: string;
	focusedCardElementSelector: string;
	/** 未受视口限高的完整副本自然高度，不包含 rail 外层 padding。 */
	focusedCardCloneHeightPx?: number;
	sectionElementAttributeName?: string;
	isStageSectionExpanded: (columnId: string) => boolean;
	setStageSectionExpanded: (columnId: string, isExpanded: boolean) => void;
}) {
	const pendingScrollAdjustmentRef = useRef<PendingScrollAdjustmentAfterStageSectionToggle | null>(null);
	const pendingJumpAfterFirstFocusedCloneMeasurementRef = useRef<{
		columnId: string;
		scrollTop: number;
	} | null>(null);

	const measureScrollTopForJumpingToStageBelowTopRail = useCallback(
		(scrollRoot: HTMLElement, targetColumnId: string): number | null => {
			const targetSection = scrollRoot.querySelector<HTMLElement>(
				`[${sectionElementAttributeName}="${escapeCssAttributeSelectorValue(targetColumnId)}"]`,
			);
			if (!targetSection) {
				return null;
			}
			const focusedCardRect = scrollRoot
				.querySelector<HTMLElement>(focusedCardElementSelector)
				?.getBoundingClientRect();
			const scrollRootRect = scrollRoot.getBoundingClientRect();
			const naturalFocusedCardHeight = focusedCardCloneHeightPx || focusedCardRect?.height || 0;
			return computeScrollTopForJumpingToStageBelowTopRail({
				targetStageIndex: orderedColumnIds.indexOf(targetColumnId),
				// 焦点卡不在 DOM 里（渐进渲染未挂载等）时按「无焦点条目」计，避免凭空预留一段克隆高度。
				focusedStageIndex: focusedCardRect ? orderedColumnIds.indexOf(focusedColumnId) : -1,
				focusedCardViewportTop: focusedCardRect?.top ?? 0,
				focusedCardHeight: naturalFocusedCardHeight,
				railLayout: {
					fixedTopGroupIds,
					sections: orderedColumnIds.map((id) => {
						const rect = scrollRoot
							.querySelector<HTMLElement>(
								`[${sectionElementAttributeName}="${escapeCssAttributeSelectorValue(id)}"]`,
							)
							?.getBoundingClientRect();
						return { id, top: rect?.top ?? Number.NaN, bottom: rect?.bottom ?? Number.NaN };
					}),
					viewportTop: scrollRootRect.top,
					viewportHeight: scrollRootRect.height,
					columnCount: computeFocusViewCompactHeaderColumnCount(scrollRoot.clientWidth || scrollRootRect.width),
					compactHeadersEnabled:
						window.matchMedia?.(FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY).matches ?? false,
					focusedColumnId: focusedCardRect ? focusedColumnId : "",
					focusedCardTop: focusedCardRect?.top ?? 0,
					focusedCardBottom: focusedCardRect?.bottom ?? 0,
					focusedCardHeight: naturalFocusedCardHeight,
					uncoveredTaskCardHeightPx: measureFocusViewUncoveredTaskCardHeightPx(scrollRoot, {
						targetSection,
					}),
				},
				targetSectionViewportTop: targetSection.getBoundingClientRect().top,
				scrollRootViewportTop: scrollRootRect.top,
				currentScrollTop: scrollRoot.scrollTop,
			});
		},
		[
			orderedColumnIds,
			fixedTopGroupIds,
			focusedColumnId,
			focusedCardElementSelector,
			focusedCardCloneHeightPx,
			sectionElementAttributeName,
		],
	);

	// 直接赋值 `scrollTop` 而非 `scrollIntoView`：不会牵动祖先滚动容器，且全局无 `scroll-behavior: smooth`，
	// 与此前的瞬时跳转观感一致。
	const jumpToStageSectionBelowTopRail = useCallback(
		(columnId: string): void => {
			const scrollRoot = scrollRootRef.current;
			if (!scrollRoot) {
				return;
			}
			const scrollTop = measureScrollTopForJumpingToStageBelowTopRail(scrollRoot, columnId);
			if (scrollTop !== null) {
				scrollRoot.scrollTop = scrollTop;
				pendingJumpAfterFirstFocusedCloneMeasurementRef.current = {
					columnId,
					scrollTop: scrollRoot.scrollTop,
				};
			}
		},
		[scrollRootRef, measureScrollTopForJumpingToStageBelowTopRail, orderedColumnIds, focusedColumnId],
	);

	// 副本测高、或跳转后上方分段又多渲染卡片时，按同一目标重算落点。用户自己滚动后不再改。
	const reconcilePendingJumpRef = useRef<() => void>(() => {});
	reconcilePendingJumpRef.current = (): void => {
		const pendingJump = pendingJumpAfterFirstFocusedCloneMeasurementRef.current;
		const scrollRoot = scrollRootRef.current;
		if (!pendingJump || !scrollRoot) return;
		if (Math.abs(scrollRoot.scrollTop - pendingJump.scrollTop) > 1) {
			pendingJumpAfterFirstFocusedCloneMeasurementRef.current = null;
			return;
		}
		const scrollTop = measureScrollTopForJumpingToStageBelowTopRail(scrollRoot, pendingJump.columnId);
		if (scrollTop === null || Math.abs(scrollTop - scrollRoot.scrollTop) <= 1) return;
		scrollRoot.scrollTop = scrollTop;
		pendingJump.scrollTop = scrollRoot.scrollTop;
	};
	useLayoutEffect(() => {
		reconcilePendingJumpRef.current();
	}, [focusedCardCloneHeightPx, scrollRootRef, measureScrollTopForJumpingToStageBelowTopRail]);
	useLayoutEffect(() => {
		const scrollRoot = scrollRootRef.current;
		if (!scrollRoot || typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(() => reconcilePendingJumpRef.current());
		observer.observe(scrollRoot, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [scrollRootRef]);

	const toggleStageSectionExpandedFromInFlowHeader = useCallback(
		(columnId: string): void => {
			setStageSectionExpanded(columnId, !isStageSectionExpanded(columnId));
		},
		[isStageSectionExpanded, setStageSectionExpanded],
	);

	const toggleStageSectionExpandedFromStageHeaderRail = useCallback(
		(columnId: string, railEdge: StageHeaderRailEdge): void => {
			const isExpanding = !isStageSectionExpanded(columnId);
			pendingScrollAdjustmentRef.current = isExpanding
				? { kind: "jump_to_stage_section_after_expanding_it_from_stage_header_rail", columnId }
				: railEdge === "pinTop"
					? captureScrollAdjustmentForCollapsingStageSectionFromTopRail(
							scrollRootRef.current,
							columnId,
							measureScrollTopForJumpingToStageBelowTopRail,
							sectionElementAttributeName,
						)
					: null;
			setStageSectionExpanded(columnId, isExpanding);
		},
		[
			isStageSectionExpanded,
			setStageSectionExpanded,
			scrollRootRef,
			measureScrollTopForJumpingToStageBelowTopRail,
			sectionElementAttributeName,
		],
	);

	const expandStageSectionWithoutScrolling = useCallback(
		(columnId: string): void => setStageSectionExpanded(columnId, true),
		[setStageSectionExpanded],
	);

	// 必须在 commit 后同步写（`useLayoutEffect`）、不能退到 rAF：`useStageHeaderPinLayout` /
	// `useSelectedCardPinState` 的 MutationObserver 回调排在 layout effect 之后，它们 rAF 里的重算因此看到的
	// 是**调整后的最终几何**，rail 不会闪一帧中间态。不带依赖数组、靠 ref 是否为空自守：翻转必然引发一次
	// 重渲染，本 effect 随之运行（它在面板层，子树的 DOM 此时已更新完）。
	useLayoutEffect(() => {
		const pendingScrollAdjustment = pendingScrollAdjustmentRef.current;
		if (!pendingScrollAdjustment) {
			return;
		}
		pendingScrollAdjustmentRef.current = null;
		const scrollRoot = scrollRootRef.current;
		if (!scrollRoot) {
			return;
		}
		if (pendingScrollAdjustment.kind === "jump_to_stage_section_after_expanding_it_from_stage_header_rail") {
			jumpToStageSectionBelowTopRail(pendingScrollAdjustment.columnId);
			return;
		}
		const stageSectionHeightLostByCollapse = Math.max(
			0,
			pendingScrollAdjustment.stageSectionHeightBeforeCollapse -
				pendingScrollAdjustment.stageSectionElement.getBoundingClientRect().height,
		);
		scrollRoot.scrollTop = computeScrollTopAfterCollapsingStageFromTopRail({
			scrollTopBeforeCollapse: pendingScrollAdjustment.scrollTopBeforeCollapse,
			stageSectionHeightLostByCollapse,
			scrollTopThatDocksCollapsedStageAtItsTopRailSlot:
				pendingScrollAdjustment.scrollTopThatDocksCollapsedStageAtItsTopRailSlot,
		});
	});

	return {
		isStageSectionExpanded,
		toggleStageSectionExpandedFromInFlowHeader,
		toggleStageSectionExpandedFromStageHeaderRail,
		expandStageSectionWithoutScrolling,
		jumpToStageSectionBelowTopRail,
	};
}

function captureScrollAdjustmentForCollapsingStageSectionFromTopRail(
	scrollRoot: HTMLElement | null,
	columnId: string,
	measureScrollTopForJumpingToStageBelowTopRail: (scrollRoot: HTMLElement, targetColumnId: string) => number | null,
	sectionElementAttributeName: string,
): PendingScrollAdjustmentAfterStageSectionToggle | null {
	const stageSectionElement = scrollRoot?.querySelector<HTMLElement>(
		`[${sectionElementAttributeName}="${escapeCssAttributeSelectorValue(columnId)}"]`,
	);
	if (!scrollRoot || !stageSectionElement) {
		return null;
	}
	// 自身折叠不改变它上沿及其上方内容的位置，故停靠落点在翻转前测即可（翻转后读 `scrollTop` 反而可能是钳制后的值）。
	const scrollTopThatDocksCollapsedStageAtItsTopRailSlot = measureScrollTopForJumpingToStageBelowTopRail(
		scrollRoot,
		columnId,
	);
	if (scrollTopThatDocksCollapsedStageAtItsTopRailSlot === null) {
		return null;
	}
	return {
		kind: "keep_viewport_steady_after_collapsing_stage_section_from_top_rail",
		stageSectionElement,
		stageSectionHeightBeforeCollapse: stageSectionElement.getBoundingClientRect().height,
		scrollTopBeforeCollapse: scrollRoot.scrollTop,
		scrollTopThatDocksCollapsedStageAtItsTopRailSlot,
	};
}
