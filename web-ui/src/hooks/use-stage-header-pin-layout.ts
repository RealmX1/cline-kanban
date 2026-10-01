import type { RefObject } from "react";
import { useEffect, useState } from "react";

import {
	STAGE_HEADER_HEIGHT_PX,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
	STAGE_RAIL_GAP_PX,
	STAGE_SECTION_BORDER_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";

/**
 * Focus View 左侧列表里「全部 stage 卡头」相对滚动视口的钉住布局——把单卡钉住
 * （`useSelectedCardPinState`）的几何模式从「1 个目标」推广到「N 个卡头」的手风琴：
 * - 已滚过的 stage（卡头自然位置越过视口上沿）→ 卡头钉在**顶沿**，文档序自上而下堆叠；
 * - 未到达的 stage（卡头自然位置仍在视口下沿之下）→ 卡头钉在**底沿**，文档序堆叠；
 * - 视口中间带内的 stage → 卡头随内容自然滚动（不进 rail）。
 *
 * 原生 CSS sticky 做不到「把 fold 之下的未来卡头拉到底沿」「跨 section 顶部增长堆叠」，因为每个
 * 卡头被关在各自矮 section 盒的 containing block 里；本 hook 以实时几何（`getBoundingClientRect`）
 * 判定，由 `StageHeaderRails` 以脱流 overlay 渲染，无此限制。
 *
 * 单调性（实现基石）：sections 文档序、非重叠 → `sectionTop` 严格递增 → **钉顶必是前缀
 * `[0..a]`、钉底必是后缀 `[b..N-1]`、中间随流**。故一次前向 pass 求前缀、一次后向 pass 求后缀即可。
 *
 * 条目真实高度的构成：每个 rail 条目外框有 `border border-border`（上下共 2px）；焦点 stage 的条目在其卡
 * 钉在同侧时额外挂「焦点卡克隆」，克隆外还有 `padding: 8`（上下共 16px），整条比普通卡头（40px 槽高 +
 * 2px 外框）高。堆叠偏移阈值必须把**边框**与**焦点卡（padding + 卡高）**一并计入，否则「首个未钉卡头」会被
 * 焦点条目吞在 rail 之后（与旧 `--kb-selected-pin-top` 变量要解决的是同一类遮挡 bug）。焦点卡高取**真实卡**
 * （`[data-task-id]`，折叠时由 peek 支路保活）的实测高度——它不依赖分类结果、**无反馈环**；绝不测
 * rail 克隆（那才循环）。渲染侧仍用 flexbox 自然堆叠、不手算逐条偏移。
 *
 * 条目几何常量（卡头槽高 / 外框 / 间距 / 焦点卡 padding）是本 hook 与渲染方、跳转/折叠滚动计算共用的契约，
 * 单一真源在 `@/components/detail-panels/stage-header-rail-geometry`。
 */

export interface StageHeaderPinLayout {
	/** 已滚过、卡头钉在视口顶沿的 stage columnId（文档序，顶→下堆叠）。 */
	topPinnedColumnIds: string[];
	/** 未到达、卡头钉在视口底沿的 stage columnId（文档序，上→下堆叠）。 */
	bottomPinnedColumnIds: string[];
}

export interface UseStageHeaderPinLayoutOptions {
	/** 滚动容器（`.kb-detail-task-list-scroll`）的 ref，作为几何判定的视口基准。 */
	scrollRootRef: RefObject<HTMLElement | null>;
	/** 全部 stage 的 columnId，按列表文档序。 */
	columnIds: string[];
	/** 焦点卡所在 stage 的 columnId。 */
	focusedColumnId: string;
	/** 焦点卡 taskId：其真实卡高用于把焦点条目（卡头+卡）计入堆叠偏移。 */
	focusedTaskId: string;
	/** 焦点卡当前钉住状态：仅当它钉在某边时，焦点条目才含卡（高于普通卡头）。 */
	focusedCardPinState: SelectedCardPinState;
	/** 为 `false`（如拖拽期，真实卡被 portal 到 body 致几何失真）时暂停并返回空布局。 */
	enabled?: boolean;
}

const EMPTY_LAYOUT: StageHeaderPinLayout = { topPinnedColumnIds: [], bottomPinnedColumnIds: [] };

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
}: UseStageHeaderPinLayoutOptions): StageHeaderPinLayout {
	const [layout, setLayout] = useState<StageHeaderPinLayout>(EMPTY_LAYOUT);
	// 数组入参每渲染换新引用；用稳定字符串 key 作为 effect 依赖，并在 effect 内还原（columnId 不含此分隔符）。
	const columnIdsKey = columnIds.join("\0");

	useEffect(() => {
		const commit = (next: StageHeaderPinLayout): void => {
			setLayout((prev) =>
				sameIds(prev.topPinnedColumnIds, next.topPinnedColumnIds) &&
				sameIds(prev.bottomPinnedColumnIds, next.bottomPinnedColumnIds)
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
			const rootTop = rootRect.top;
			const rootBottom = rootRect.bottom;
			const focusedIndex = orderedColumnIds.indexOf(focusedColumnId);

			let focusedCardHeight = 0;
			if (focusedIndex >= 0) {
				const focusedCard = root.querySelector(
					`[data-task-id="${escapeCssAttributeSelectorValue(focusedTaskId)}"]`,
				);
				if (focusedCard) {
					focusedCardHeight = focusedCard.getBoundingClientRect().height;
				}
			}

			const sectionTops: number[] = [];
			const sectionBottoms: number[] = [];
			for (const columnId of orderedColumnIds) {
				const section = root.querySelector(
					`[data-stage-section-id="${escapeCssAttributeSelectorValue(columnId)}"]`,
				);
				if (!section) {
					sectionTops.push(Number.NaN);
					sectionBottoms.push(Number.NaN);
					continue;
				}
				const rect = section.getBoundingClientRect();
				sectionTops.push(rect.top);
				sectionBottoms.push(rect.bottom);
			}

			const total = orderedColumnIds.length;
			const entryHeight = (index: number, edge: SelectedCardPinState): number =>
				index === focusedIndex && focusedCardPinState === edge
					? STAGE_HEADER_HEIGHT_PX +
						STAGE_SECTION_BORDER_PX +
						STAGE_RAIL_FOCUSED_CARD_PADDING_PX +
						focusedCardHeight
					: STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;

			// 前向 pass：卡头自然上沿滚到 rail 增长下沿（`<=`，含等号，sticky 语义）即钉顶。
			// topOffset 从 rootTop 起（scrollport 8px 顶 padding 天然形成静止不误钉的死区）；每条计入
			// gap 略作高估，保证「首个未钉卡头」严格落在 rail 下沿之下（偏安全侧，至多提前 8px 钉）。
			let topOffset = rootTop;
			const topPinnedColumnIds: string[] = [];
			let lastTopIndex = -1;
			for (let index = 0; index < total; index += 1) {
				const sectionTop = sectionTops[index];
				const columnId = orderedColumnIds[index];
				if (sectionTop === undefined || columnId === undefined || Number.isNaN(sectionTop)) {
					break;
				}
				if (sectionTop <= topOffset) {
					topPinnedColumnIds.push(columnId);
					lastTopIndex = index;
					topOffset += entryHeight(index, "pinTop") + STAGE_RAIL_GAP_PX;
				} else {
					break;
				}
			}

			// 后向 pass：镜像前向。卡头自然上沿在 rail 槽上沿之下（`>=`）即钉底；`i <= lastTopIndex → break`
			// 定优先级为「顶胜」，杜绝上下双认领（含单个高 section 撑满视口的退化）。第二守卫防「静止时最后
			// 一节短卡头落在底 40px 内」的伪钉：section 须真溢出底沿（`sBottom > rootBottom`），除非其下已有钉底
			// 条目（此时不透明 rail 会遮住它的真实卡头，必须一并进 rail 以免「被遮却不显」）。
			let bottomOffset = rootBottom;
			const bottomPinnedReversed: string[] = [];
			for (let index = total - 1; index > lastTopIndex; index -= 1) {
				const sectionTop = sectionTops[index];
				const sectionBottom = sectionBottoms[index];
				const columnId = orderedColumnIds[index];
				if (
					sectionTop === undefined ||
					sectionBottom === undefined ||
					columnId === undefined ||
					Number.isNaN(sectionTop) ||
					Number.isNaN(sectionBottom)
				) {
					break;
				}
				const slotTopEdge = bottomOffset - entryHeight(index, "pinBottom");
				const overflowsBelow = sectionBottom > rootBottom;
				if (sectionTop >= slotTopEdge && (overflowsBelow || bottomPinnedReversed.length > 0)) {
					bottomPinnedReversed.push(columnId);
					bottomOffset -= entryHeight(index, "pinBottom") + STAGE_RAIL_GAP_PX;
				} else {
					break;
				}
			}
			bottomPinnedReversed.reverse();

			commit({ topPinnedColumnIds, bottomPinnedColumnIds: bottomPinnedReversed });
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
	}, [columnIdsKey, focusedColumnId, focusedTaskId, focusedCardPinState, enabled, scrollRootRef]);

	return layout;
}
