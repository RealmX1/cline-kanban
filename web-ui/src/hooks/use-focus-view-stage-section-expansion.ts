import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
	computeScrollTopAfterCollapsingStageFromTopRail,
	computeScrollTopForJumpingToStageBelowTopRail,
} from "@/components/detail-panels/stage-header-rail-geometry";
import type { BoardColumnId } from "@/types";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";

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
function isStageSectionExpandedByDefault(columnId: BoardColumnId): boolean {
	return columnId !== "trash";
}

/** 折叠/展开按钮所在的 rail 沿，对应 `SelectedCardPinState` 的钉住方向。 */
export type StageHeaderRailEdge = "pinTop" | "pinBottom";

type PendingScrollAdjustmentAfterStageSectionToggle =
	| {
			kind: "jump_to_stage_section_after_expanding_it_from_stage_header_rail";
			columnId: BoardColumnId;
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
	orderedColumnIds: readonly BoardColumnId[];
	/** 焦点卡所在 stage：它在目标之上且焦点卡会钉顶时，顶 rail 多出一张焦点卡克隆的高度。 */
	focusedColumnId: BoardColumnId;
	focusedTaskId: string;
}

export interface FocusViewStageSectionExpansionController {
	isStageSectionExpanded: (columnId: BoardColumnId) => boolean;
	/** 行内卡头：原地折叠/展开，不滚动。 */
	toggleStageSectionExpandedFromInFlowHeader: (columnId: BoardColumnId) => void;
	/** rail 孪生卡头的折叠按钮：折叠/展开 + 按上面的策略调整滚动。 */
	toggleStageSectionExpandedFromStageHeaderRail: (columnId: BoardColumnId, railEdge: StageHeaderRailEdge) => void;
	/** 只展开、不滚动（调用方自己负责随后的滚动，如置顶板「跳回本体卡」）。 */
	expandStageSectionWithoutScrolling: (columnId: BoardColumnId) => void;
	/** rail 孪生卡头的标签：跳到该 stage，第一张卡完整露在顶 rail 之下。 */
	jumpToStageSectionBelowTopRail: (columnId: BoardColumnId) => void;
}

export function useFocusViewStageSectionExpansion({
	scrollRootRef,
	orderedColumnIds,
	focusedColumnId,
	focusedTaskId,
}: UseFocusViewStageSectionExpansionOptions): FocusViewStageSectionExpansionController {
	const [explicitExpandedByColumnId, setExplicitExpandedByColumnId] = useState<
		Partial<Record<BoardColumnId, boolean>>
	>({});
	const pendingScrollAdjustmentRef = useRef<PendingScrollAdjustmentAfterStageSectionToggle | null>(null);

	const isStageSectionExpanded = useCallback(
		(columnId: BoardColumnId): boolean =>
			explicitExpandedByColumnId[columnId] ?? isStageSectionExpandedByDefault(columnId),
		[explicitExpandedByColumnId],
	);

	const setStageSectionExpanded = useCallback((columnId: BoardColumnId, isExpanded: boolean): void => {
		setExplicitExpandedByColumnId((previous) => ({ ...previous, [columnId]: isExpanded }));
	}, []);

	const measureScrollTopForJumpingToStageBelowTopRail = useCallback(
		(scrollRoot: HTMLElement, targetColumnId: BoardColumnId): number | null => {
			const targetSection = scrollRoot.querySelector<HTMLElement>(
				`[data-stage-section-id="${escapeCssAttributeSelectorValue(targetColumnId)}"]`,
			);
			if (!targetSection) {
				return null;
			}
			const focusedCardRect = scrollRoot
				.querySelector<HTMLElement>(`[data-task-id="${escapeCssAttributeSelectorValue(focusedTaskId)}"]`)
				?.getBoundingClientRect();
			return computeScrollTopForJumpingToStageBelowTopRail({
				targetStageIndex: orderedColumnIds.indexOf(targetColumnId),
				// 焦点卡不在 DOM 里（渐进渲染未挂载等）时按「无焦点条目」计，避免凭空预留一段克隆高度。
				focusedStageIndex: focusedCardRect ? orderedColumnIds.indexOf(focusedColumnId) : -1,
				focusedCardViewportTop: focusedCardRect?.top ?? 0,
				focusedCardHeight: focusedCardRect?.height ?? 0,
				targetSectionViewportTop: targetSection.getBoundingClientRect().top,
				scrollRootViewportTop: scrollRoot.getBoundingClientRect().top,
				currentScrollTop: scrollRoot.scrollTop,
			});
		},
		[orderedColumnIds, focusedColumnId, focusedTaskId],
	);

	// 直接赋值 `scrollTop` 而非 `scrollIntoView`：不会牵动祖先滚动容器，且全局无 `scroll-behavior: smooth`，
	// 与此前的瞬时跳转观感一致。
	const jumpToStageSectionBelowTopRail = useCallback(
		(columnId: BoardColumnId): void => {
			const scrollRoot = scrollRootRef.current;
			if (!scrollRoot) {
				return;
			}
			const scrollTop = measureScrollTopForJumpingToStageBelowTopRail(scrollRoot, columnId);
			if (scrollTop !== null) {
				scrollRoot.scrollTop = scrollTop;
			}
		},
		[scrollRootRef, measureScrollTopForJumpingToStageBelowTopRail],
	);

	const toggleStageSectionExpandedFromInFlowHeader = useCallback(
		(columnId: BoardColumnId): void => {
			setStageSectionExpanded(columnId, !isStageSectionExpanded(columnId));
		},
		[isStageSectionExpanded, setStageSectionExpanded],
	);

	const toggleStageSectionExpandedFromStageHeaderRail = useCallback(
		(columnId: BoardColumnId, railEdge: StageHeaderRailEdge): void => {
			const isExpanding = !isStageSectionExpanded(columnId);
			pendingScrollAdjustmentRef.current = isExpanding
				? { kind: "jump_to_stage_section_after_expanding_it_from_stage_header_rail", columnId }
				: railEdge === "pinTop"
					? captureScrollAdjustmentForCollapsingStageSectionFromTopRail(
							scrollRootRef.current,
							columnId,
							measureScrollTopForJumpingToStageBelowTopRail,
						)
					: null;
			setStageSectionExpanded(columnId, isExpanding);
		},
		[isStageSectionExpanded, setStageSectionExpanded, scrollRootRef, measureScrollTopForJumpingToStageBelowTopRail],
	);

	const expandStageSectionWithoutScrolling = useCallback(
		(columnId: BoardColumnId): void => setStageSectionExpanded(columnId, true),
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
			const scrollTop = measureScrollTopForJumpingToStageBelowTopRail(scrollRoot, pendingScrollAdjustment.columnId);
			if (scrollTop !== null) {
				scrollRoot.scrollTop = scrollTop;
			}
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
	columnId: BoardColumnId,
	measureScrollTopForJumpingToStageBelowTopRail: (
		scrollRoot: HTMLElement,
		targetColumnId: BoardColumnId,
	) => number | null,
): PendingScrollAdjustmentAfterStageSectionToggle | null {
	const stageSectionElement = scrollRoot?.querySelector<HTMLElement>(
		`[data-stage-section-id="${escapeCssAttributeSelectorValue(columnId)}"]`,
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
