import { FOCUS_VIEW_TASK_GROUP_HEADER_HEIGHT_PX } from "@/components/task-group-header-geometry";

/**
 * Focus View 左侧「全 stage 卡头钉住 rail」的几何单一真源。
 *
 * 这些常量描述的是**渲染出来的 rail 条目盒子**，同时被三方消费，任何一方漂移都会造成遮挡类 bug：
 * - 渲染方 `stage-header-rails.tsx`（条目卡头槽高、外框、条目间距）；
 * - 分类方 `use-stage-header-pin-layout.ts`（前/后向 pass 的堆叠偏移阈值）；
 * - 滚动方 `use-focus-view-stage-section-expansion.ts`（跳到某 stage、从顶 rail 折叠某 stage 后的落点）。
 *
 * 故独立成模块而非从 hook 导出——让渲染方 import 一个 hook 模块会倒置依赖。
 */

/** stage 卡头槽高（与 `ColumnSection` / rail 条目卡头内联 `height` 一致）。 */
export const STAGE_HEADER_HEIGHT_PX = FOCUS_VIEW_TASK_GROUP_HEADER_HEIGHT_PX;
/** rail 条目间距（复刻 scrollport 的 `gap-1` = 4px）；计入阈值时略作高估以偏向「不吞卡」的安全侧。 */
export const STAGE_RAIL_GAP_PX = 4;
/**
 * 每个 rail 条目外框的上下边框之和（1px 上 + 1px 下）。渲染侧 `StageHeaderRailEntry`
 * 的外层 `kb-task-group` 使条目真实高度比卡头槽高多这 2px；
 * 阈值须逐条计入，否则多条堆叠后累计误差会让「首个未钉卡头」落进不透明 rail 之后被遮住（RVF-002 遮挡类 bug）。
 */
export const STAGE_SECTION_BORDER_PX = 2;
/** 焦点卡副本外层只保留 pb-2（8px）；悬浮按钮不参与卡体与 rail 的测量。 */
export const STAGE_RAIL_FOCUSED_CARD_PADDING_PX = 8;

/** 桌面视口外标题：24px 槽高、至少 96px 宽，触屏保留普通标题。 */
export const FOCUS_VIEW_COMPACT_GROUP_HEADER_HEIGHT_PX = 24;
export const FOCUS_VIEW_COMPACT_GROUP_HEADER_MINIMUM_WIDTH_PX = 96;
export const FOCUS_VIEW_COMPACT_GROUP_HEADERS_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";
/** 当前项目本体卡与 All projects 行都算一张任务卡；副本不带这些身份。 */
const UNCOVERED_TASK_CARD_SELECTOR = "[data-task-id], [data-cross-project-task-switcher-task-id]";
const STAGE_SECTION_SELECTOR = "[data-stage-section-id], [data-focus-view-group-section-id]";

export type FocusViewGroupHeaderPresentation = "standard" | "compact";
type FocusedCardRailEdge = "hidden" | "pinTop" | "pinBottom";

export interface FocusViewGroupHeaderRailRowsInput {
	groupIds: readonly string[];
	compactGroupIds: readonly string[];
	columnCount: number;
	focusedGroupId?: string;
	focusedCardHeight?: number;
}

export interface FocusViewGroupHeaderRailRow {
	groupIds: string[];
	presentation: FocusViewGroupHeaderPresentation;
	height: number;
}

/** 两侧各 2px，与 scrollport 和 rail 的横向 padding 一致。 */
export function computeFocusViewCompactHeaderColumnCount(scrollRootClientWidth: number): number {
	return Math.max(
		1,
		Math.floor(
			(scrollRootClientWidth - 4 + STAGE_RAIL_GAP_PX) /
				(FOCUS_VIEW_COMPACT_GROUP_HEADER_MINIMUM_WIDTH_PX + STAGE_RAIL_GAP_PX),
		),
	);
}

/** 渲染、遮挡分类和跳转共用行模型；焦点副本将所在项独立成整行。 */
export function computeFocusViewGroupHeaderRailRows({
	groupIds,
	compactGroupIds,
	columnCount,
	focusedGroupId,
	focusedCardHeight,
}: FocusViewGroupHeaderRailRowsInput): FocusViewGroupHeaderRailRow[] {
	const rows: FocusViewGroupHeaderRailRow[] = [];
	for (const groupId of groupIds) {
		const presentation = compactGroupIds.includes(groupId) ? "compact" : "standard";
		const containsFocusedCard = groupId === focusedGroupId;
		const previousRow = rows.at(-1);
		if (
			presentation === "compact" &&
			!containsFocusedCard &&
			previousRow?.presentation === "compact" &&
			!previousRow.groupIds.includes(focusedGroupId ?? "") &&
			previousRow.groupIds.length < columnCount
		) {
			previousRow.groupIds.push(groupId);
		} else {
			rows.push({
				groupIds: [groupId],
				presentation,
				height:
					(presentation === "compact" ? FOCUS_VIEW_COMPACT_GROUP_HEADER_HEIGHT_PX : STAGE_HEADER_HEIGHT_PX) +
					STAGE_SECTION_BORDER_PX +
					(containsFocusedCard && focusedCardHeight !== undefined
						? focusedCardHeight + STAGE_RAIL_FOCUSED_CARD_PADDING_PX
						: 0),
			});
		}
	}
	return rows;
}

export function computeFocusViewGroupHeaderRailHeight(input: FocusViewGroupHeaderRailRowsInput): number {
	const rows = computeFocusViewGroupHeaderRailRows(input);
	return (
		rows.reduce((height, row) => height + row.height + STAGE_RAIL_GAP_PX, 0) -
		(rows.length > 0 ? STAGE_RAIL_GAP_PX : 0)
	);
}

export interface FocusViewGroupSectionGeometry {
	id: string;
	top: number;
	bottom: number;
}

export interface StageHeaderPinLayoutGeometryInput {
	sections: readonly FocusViewGroupSectionGeometry[];
	/** 收起的固定分组始终占顶轨首行，与滚出视口的标题共享排列。 */
	fixedTopGroupIds?: readonly string[];
	viewportTop: number;
	viewportHeight: number;
	columnCount: number;
	compactHeadersEnabled: boolean;
	focusedColumnId: string;
	focusedCardTop: number;
	focusedCardBottom: number;
	focusedCardHeight: number;
	focusedCardPinState: FocusedCardRailEdge;
	/**
	 * 跳转目标或当前视口内首张任务卡的自然高度（border box）。
	 * 分类、副本限高和跳转落点共用这一预算，使该卡在顶轨与底轨之间完整露出。
	 */
	uncoveredTaskCardHeightPx?: number;
}

export interface StageHeaderPinLayoutGeometry {
	topPinnedColumnIds: string[];
	bottomPinnedColumnIds: string[];
	compactGroupIds: string[];
	columnCount: number;
	focusedCardRailEdge: FocusedCardRailEdge;
	focusedCardContentMaximumHeight: number;
}

export function computeStageHeaderPinLayoutGeometry(
	input: StageHeaderPinLayoutGeometryInput,
): StageHeaderPinLayoutGeometry {
	const { sections, viewportTop, viewportHeight, columnCount, focusedColumnId } = input;
	const viewportBottom = viewportTop + viewportHeight;
	const fixedTopGroupIds = input.fixedTopGroupIds ?? [];
	const groupIds = [...fixedTopGroupIds, ...sections.map(({ id }) => id)];
	const compactGroupIds: string[] = input.compactHeadersEnabled ? [...fixedTopGroupIds] : [];
	const compactHeight = (ids: string[]) =>
		computeFocusViewGroupHeaderRailHeight({ groupIds: ids, compactGroupIds: ids, columnCount });
	if (input.compactHeadersEnabled) {
		const prefix: string[] = [];
		for (const section of sections) {
			if (
				section.bottom > viewportTop + compactHeight([...fixedTopGroupIds, ...prefix, section.id]) ||
				!Number.isFinite(section.bottom)
			)
				break;
			prefix.push(section.id);
		}
		const suffix: string[] = [];
		for (const section of [...sections].reverse()) {
			if (
				prefix.includes(section.id) ||
				section.top < viewportBottom - compactHeight([section.id, ...suffix]) ||
				!Number.isFinite(section.top)
			)
				break;
			suffix.unshift(section.id);
		}
		compactGroupIds.push(...prefix, ...suffix);
	}
	// 预留全部标题的实际行数，并把焦点项固定为整行；预算不依赖副本的受限测量。
	// 再按实测首卡高度留白，避免副本把落点上的那张卡挤出视口。
	const headerBudget =
		computeFocusViewGroupHeaderRailHeight({
			groupIds,
			compactGroupIds,
			columnCount,
			focusedGroupId: focusedColumnId,
		}) + STAGE_RAIL_GAP_PX;
	const focusedCardContentMaximumHeight = computeFocusedCardRailContentMaximumHeight(
		viewportHeight,
		headerBudget,
		input.uncoveredTaskCardHeightPx,
	);
	const focusedCardHeight = Math.min(input.focusedCardHeight, focusedCardContentMaximumHeight);
	const railHeight = (ids: string[], edge: FocusedCardRailEdge, focusedEdge: FocusedCardRailEdge) =>
		computeFocusViewGroupHeaderRailHeight({
			groupIds: ids,
			compactGroupIds,
			columnCount,
			focusedGroupId: edge === focusedEdge ? focusedColumnId : undefined,
			focusedCardHeight,
		});
	const classify = (focusedEdge: FocusedCardRailEdge) => {
		const topPinnedColumnIds: string[] = [...fixedTopGroupIds];
		for (const section of sections) {
			if (section.id === focusedColumnId && focusedEdge === "pinBottom") break;
			const threshold =
				viewportTop +
				railHeight(topPinnedColumnIds, "pinTop", focusedEdge) +
				(topPinnedColumnIds.length > 0 ? STAGE_RAIL_GAP_PX : 0);
			// 落点把目标分段的上沿放在这条线上。等于阈值的分段是当前行内分组，不能再钉进顶轨。
			if (!Number.isFinite(section.top) || section.top >= threshold) break;
			// 折叠分段与标准行距同宽。视口内的折叠标题还没进入紧凑前缀，若按标准行距继续钉顶，
			// 阈值会锁步吞掉后续标题，并把后面展开分组的首卡盖住。
			if (isInFlowHeaderOnlySection(section, input.compactHeadersEnabled, compactGroupIds)) break;
			topPinnedColumnIds.push(section.id);
		}
		const bottomPinnedColumnIds: string[] = [];
		const focusedSectionIndex = sections.findIndex(({ id }) => id === focusedColumnId);
		const topPinnedSectionCount = topPinnedColumnIds.length - fixedTopGroupIds.length;
		for (let index = sections.length - 1; index >= topPinnedSectionCount; index--) {
			const section = sections[index];
			if (!section || !Number.isFinite(section.top) || !Number.isFinite(section.bottom)) break;
			const containsFocusedCardBelow =
				focusedEdge === "pinBottom" && focusedSectionIndex >= topPinnedSectionCount && index >= focusedSectionIndex;
			if (
				!containsFocusedCardBelow &&
				isInFlowHeaderOnlySection(section, input.compactHeadersEnabled, compactGroupIds)
			)
				break;
			const threshold =
				viewportBottom - railHeight([section.id, ...bottomPinnedColumnIds], "pinBottom", focusedEdge);
			if (
				!containsFocusedCardBelow &&
				!(section.top >= threshold && (section.bottom > viewportBottom || bottomPinnedColumnIds.length > 0))
			)
				break;
			bottomPinnedColumnIds.unshift(section.id);
		}
		return {
			topPinnedColumnIds,
			bottomPinnedColumnIds,
			focusedCardRailEdge:
				focusedEdge === "hidden"
					? ("hidden" as const)
					: topPinnedColumnIds.includes(focusedColumnId)
						? ("pinTop" as const)
						: bottomPinnedColumnIds.includes(focusedColumnId)
							? ("pinBottom" as const)
							: ("hidden" as const),
		};
	};
	let layout = classify(input.focusedCardPinState);
	if (input.focusedCardPinState === "hidden" && input.focusedCardHeight > 0) {
		const topHeight = railHeight(layout.topPinnedColumnIds, "pinTop", "hidden");
		const bottomHeight = railHeight(layout.bottomPinnedColumnIds, "pinBottom", "hidden");
		if (isFocusedCardOccludedByTopRail(input.focusedCardTop - viewportTop, topHeight)) layout = classify("pinTop");
		else if (bottomHeight > 0 && input.focusedCardBottom >= viewportBottom - bottomHeight)
			layout = classify("pinBottom");
	}
	return { ...layout, compactGroupIds, columnCount, focusedCardContentMaximumHeight };
}

/** 折叠后只剩标题盒的分段。正文 `display:none` 或空组都落在这个高度里。 */
function isFocusViewHeaderOnlySection(section: FocusViewGroupSectionGeometry): boolean {
	if (!Number.isFinite(section.top) || !Number.isFinite(section.bottom)) return false;
	return section.bottom - section.top <= STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX + 1;
}

/**
 * 桌面紧凑模式下，仍在文档流中的折叠标题不能进入钉住轨道。
 * 已经滚出视口的折叠标题会先进入 compactGroupIds，并按 24px 多列计算。
 */
function isInFlowHeaderOnlySection(
	section: FocusViewGroupSectionGeometry,
	compactHeadersEnabled: boolean,
	compactGroupIds: readonly string[],
): boolean {
	return compactHeadersEnabled && isFocusViewHeaderOnlySection(section) && !compactGroupIds.includes(section.id);
}

/**
 * 内容限高扣除已排列的标题行和副本底部 padding。
 * 实测首卡能完整放进剩余空间时再扣掉它，分类、渲染和跳转因此给整张卡留位。
 * 首卡高于剩余空间时，再扣只会把副本压成 0，卡仍然放不下；这时保留可内部滚动的副本。
 */
export function computeFocusedCardRailContentMaximumHeight(
	scrollViewportHeight: number,
	headerRailHeight: number,
	uncoveredTaskCardHeightPx = 0,
): number {
	const roomAfterHeaders = scrollViewportHeight - headerRailHeight - STAGE_RAIL_FOCUSED_CARD_PADDING_PX;
	if (roomAfterHeaders <= 0) return 0;
	const cardHeight = Math.max(0, uncoveredTaskCardHeightPx);
	if (cardHeight === 0 || cardHeight > roomAfterHeaders) return roomAfterHeaders;
	return roomAfterHeaders - cardHeight;
}

function measuredTaskCardHeightPx(card: HTMLElement): number {
	if (card.closest("[data-testid='stage-header-rail']")) return 0;
	return Math.max(0, card.getBoundingClientRect().height);
}

function firstUncoveredTaskCardHeightPx(scope: ParentNode): number {
	for (const card of scope.querySelectorAll<HTMLElement>(UNCOVERED_TASK_CARD_SELECTOR)) {
		const height = measuredTaskCardHeightPx(card);
		if (height > 0) return height;
	}
	return 0;
}

export interface FocusViewSectionFirstCardBox {
	top: number;
	cardTop: number;
	cardHeight: number;
}

/** 每个分段的首张任务卡。副本和 rail 内的卡高度记 0。 */
export function measureFocusViewSectionFirstCardBoxes(scrollRoot: HTMLElement): FocusViewSectionFirstCardBox[] {
	const boxes: FocusViewSectionFirstCardBox[] = [];
	for (const section of scrollRoot.querySelectorAll<HTMLElement>(STAGE_SECTION_SELECTOR)) {
		const rect = section.getBoundingClientRect();
		let cardTop = rect.top;
		let cardHeight = 0;
		for (const card of section.querySelectorAll<HTMLElement>(UNCOVERED_TASK_CARD_SELECTOR)) {
			const height = measuredTaskCardHeightPx(card);
			if (height > 0) {
				cardTop = card.getBoundingClientRect().top;
				cardHeight = height;
				break;
			}
		}
		boxes.push({ top: rect.top, cardTop, cardHeight });
	}
	return boxes;
}

/**
 * 顶轨若盖住比当前预算更高的首卡，就改用那张卡并缩短副本。
 * 放不下的卡不会让顶轨变矮，因此不会挡住后面其实放得下的目标卡。
 */
export function selectUncoveredTaskCardHeightPx({
	sections,
	viewportTop,
	initialCardHeightPx,
	topRailHeightForCard,
}: {
	sections: readonly FocusViewSectionFirstCardBox[];
	viewportTop: number;
	initialCardHeightPx: number;
	topRailHeightForCard: (cardHeight: number) => number;
}): number {
	let cardHeight = Math.max(0, initialCardHeightPx);
	let topRailHeight = topRailHeightForCard(cardHeight);
	for (let attempt = 0; attempt < sections.length; attempt++) {
		const railBottom = viewportTop + topRailHeight;
		const coveredCardHeights = sections
			.filter(
				(section) =>
					section.top >= viewportTop - 1 && section.cardHeight > cardHeight && section.cardTop < railBottom - 0.5,
			)
			.map((section) => section.cardHeight)
			.sort((left, right) => right - left);
		let improved = false;
		for (const candidate of coveredCardHeights) {
			const nextTopRailHeight = topRailHeightForCard(candidate);
			if (nextTopRailHeight < topRailHeight - 0.5) {
				cardHeight = candidate;
				topRailHeight = nextTopRailHeight;
				improved = true;
				break;
			}
		}
		if (!improved) break;
	}
	return cardHeight;
}

/**
 * 跳转时读目标分段里的首张任务卡；滚动分类时读第一个仍从视口上沿开始的分段。
 * 分类随后还会把被顶轨盖住的更高首卡纳入同一预算。
 */
export function measureFocusViewUncoveredTaskCardHeightPx(
	scrollRoot: HTMLElement,
	{
		targetSection = null,
	}: {
		targetSection?: HTMLElement | null;
	} = {},
): number {
	if (targetSection) return firstUncoveredTaskCardHeightPx(targetSection);
	const viewportTop = scrollRoot.getBoundingClientRect().top;
	for (const section of scrollRoot.querySelectorAll<HTMLElement>(STAGE_SECTION_SELECTOR)) {
		if (section.getBoundingClientRect().top < viewportTop - 1) continue;
		const height = firstUncoveredTaskCardHeightPx(section);
		if (height > 0) return height;
	}
	return 0;
}

/** 焦点卡仍在视口内但已进入不透明标题 rail 时，同样需要副本。 */
export function isFocusedCardOccludedByTopRail(
	focusedCardTopRelativeToScrollRoot: number,
	topRailHeight: number,
): boolean {
	return topRailHeight > 0 && focusedCardTopRelativeToScrollRoot <= topRailHeight;
}

export interface StageJumpTargetRailGeometryInput {
	/** 目标 stage 在文档序中的下标。 */
	targetStageIndex: number;
	/** 焦点卡所在 stage 的文档序下标；焦点卡不在 DOM 里时传 `-1`。 */
	focusedStageIndex: number;
	/** 焦点卡真实盒的视口上沿（`getBoundingClientRect().top`）。`focusedStageIndex < 0` 时忽略。 */
	focusedCardViewportTop: number;
	/** 焦点卡真实盒高度（border box）。`focusedStageIndex < 0` 时忽略。 */
	focusedCardHeight: number;
	/** 目标 stage section 的视口上沿（`getBoundingClientRect().top`）。 */
	targetSectionViewportTop: number;
	/** 有真实 section 几何时，按目标落点预测多列排列及副本预算。 */
	railLayout?: Omit<StageHeaderPinLayoutGeometryInput, "focusedCardPinState">;
}

/**
 * 跳转落点上，目标 stage 之上那截顶 rail 的总高度 `R`——即目标 stage 的卡头应停靠的位置（相对滚动口上沿）。
 *
 * 与 `use-stage-header-pin-layout.ts` 前向 pass 的 `topOffset` 累加同构：目标之前的每个 stage 都会因
 * 「section 上沿已滚到 rail 增长下沿之上」而钉顶，各占一个条目高 + 一段间距。
 *
 * 先按无副本的落点预测焦点卡位置，再复用分类器的标题遮挡判据（包括目标标题本身）。
 * 焦点卡进入标题 rail 时预留完整副本；有真实分组几何时做有界预测，取已见最大遮挡。
 * 即使最终无需副本，也只会多留空隙，不会把目标首行塞回不透明 rail 之后。
 */
export function computeTopRailHeightAboveStageJumpTarget({
	targetStageIndex,
	focusedStageIndex,
	focusedCardViewportTop,
	focusedCardHeight,
	targetSectionViewportTop,
	railLayout,
}: StageJumpTargetRailGeometryInput): number {
	if (targetStageIndex <= 0 && !railLayout?.fixedTopGroupIds?.length) {
		return 0;
	}
	if (railLayout) {
		let reservedHeight = 0;
		// 布局只在有限个分组边界变化；取已见最大遮挡，避免副本反馈让落点反复切换。
		for (let attempt = 0; attempt <= railLayout.sections.length + 1; attempt++) {
			const delta = targetSectionViewportTop - railLayout.viewportTop - reservedHeight;
			const predictedLayout = computeStageHeaderPinLayoutGeometry({
				...railLayout,
				sections: railLayout.sections.map((section) => ({
					...section,
					top: section.top - delta,
					bottom: section.bottom - delta,
				})),
				focusedCardTop: railLayout.focusedCardTop - delta,
				focusedCardBottom: railLayout.focusedCardBottom - delta,
				focusedCardPinState: focusedStageIndex >= 0 && focusedStageIndex < targetStageIndex ? "pinTop" : "hidden",
			});
			const nextHeight =
				computeFocusViewGroupHeaderRailHeight({
					groupIds: [
						...(railLayout.fixedTopGroupIds ?? []),
						...railLayout.sections.slice(0, targetStageIndex).map(({ id }) => id),
					],
					compactGroupIds: predictedLayout.compactGroupIds,
					columnCount: railLayout.columnCount,
					focusedGroupId:
						predictedLayout.focusedCardRailEdge === "pinTop" ? railLayout.focusedColumnId : undefined,
					focusedCardHeight: Math.min(focusedCardHeight, predictedLayout.focusedCardContentMaximumHeight),
				}) + STAGE_RAIL_GAP_PX;
			if (nextHeight <= reservedHeight) break;
			reservedHeight = nextHeight;
		}
		return reservedHeight;
	}
	const plainTopRailHeightAboveTarget =
		computeFocusViewGroupHeaderRailHeight({
			groupIds: Array.from({ length: targetStageIndex }, (_, index) => String(index)),
			compactGroupIds: [],
			columnCount: 1,
		}) + STAGE_RAIL_GAP_PX;
	// 焦点 stage 不在目标之上 → 它不会出现在目标之上那截顶 rail 里，无克隆项可言。
	if (focusedStageIndex < 0 || focusedStageIndex >= targetStageIndex) {
		return plainTopRailHeightAboveTarget;
	}
	const predictedFocusedCardTopRelativeToScrollRoot =
		focusedCardViewportTop - targetSectionViewportTop + plainTopRailHeightAboveTarget;
	if (
		!isFocusedCardOccludedByTopRail(
			predictedFocusedCardTopRelativeToScrollRoot,
			plainTopRailHeightAboveTarget + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX,
		)
	) {
		return plainTopRailHeightAboveTarget;
	}
	return plainTopRailHeightAboveTarget + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + focusedCardHeight;
}

export interface StageJumpScrollTopInput extends StageJumpTargetRailGeometryInput {
	/** 滚动容器当前的 `scrollTop`。 */
	currentScrollTop: number;
	/** 滚动容器的视口上沿（`getBoundingClientRect().top`）。 */
	scrollRootViewportTop: number;
}

/**
 * 「跳到某个 stage」应该滚到的 `scrollTop`：把目标 section 的上沿停在顶 rail 的下沿，
 * 使它的卡头与其在 rail 中的孪生条目像素级重合、第一张卡正好完整露在 rail 之下。
 *
 * 裸 `scrollIntoView({ block: "start" })` 会把 section 顶对齐到滚动口**顶沿**，而顶沿正是不透明 rail
 * 所在，目标之前的标题排列与焦点副本会盖住目标卡头和第一张卡，
 * 看上去就是「总比预期多滚了一截」。
 */
export function computeScrollTopForJumpingToStageBelowTopRail(input: StageJumpScrollTopInput): number {
	const topRailHeightAboveTarget = computeTopRailHeightAboveStageJumpTarget(input);
	const scrollDelta = input.targetSectionViewportTop - input.scrollRootViewportTop - topRailHeightAboveTarget;
	return Math.max(0, input.currentScrollTop + scrollDelta);
}

export interface ScrollTopAfterCollapsingStageFromTopRailInput {
	/** 折叠**前**的 `scrollTop`（折叠后内容变矮，浏览器可能已钳制，不能读折叠后的值）。 */
	scrollTopBeforeCollapse: number;
	/** 折叠让该 section 变矮了多少（折叠前高 − 折叠后高，≥ 0）。 */
	stageSectionHeightLostByCollapse: number;
	/** 折叠前测得的、把该 stage 卡头停在它顶 rail 槽位上的 `scrollTop`（即对它自己做一次跳转的落点）。 */
	scrollTopThatDocksCollapsedStageAtItsTopRailSlot: number;
}

/**
 * 从**顶 rail** 折叠一个 stage 后应滚到的 `scrollTop`：`min(折叠前, max(折叠前 − 变矮量, 停靠落点))`。
 *
 * 顶 rail 上的 stage 卡头已滚过视口上沿，保持 `scrollTop` 不变会让它下方的全部内容上移「变矮量」——
 * 用户正在看的内容整段被抽走，视口可能直接落进后面某个 stage 的中段。两种情形取较大（滚得较少）的一个：
 * - **整段已在视口之上**（用户在看后面的 stage，只是顺手收起它）：`折叠前 − 变矮量` 较大 → 等量补偿，
 *   视口内容零位移，该 stage 仍钉在顶 rail，只有箭头变了；
 * - **它的卡片仍露在视口里**（用户正在看它）：`停靠落点` 较大 → 卡头停在它的 rail 槽位、下一个 stage
 *   紧跟其后，和原地折叠一个手风琴的观感一致。
 * 两式在「折叠前 section 下沿恰好与它自己的 rail 条目下沿齐平（卡片刚好全部滑进 rail 之下）」处相等，故落点随几何连续变化、无跳变。外层 `min` 保证只会向上
 * 回滚、绝不因折叠而把内容往下推。必须以绝对值赋回 `scrollTop`（不能 `+=`）：内容变矮时浏览器会先钳制
 * 一次 `scrollTop`，再叠加相对量就是双倍补偿。
 */
export function computeScrollTopAfterCollapsingStageFromTopRail({
	scrollTopBeforeCollapse,
	stageSectionHeightLostByCollapse,
	scrollTopThatDocksCollapsedStageAtItsTopRailSlot,
}: ScrollTopAfterCollapsingStageFromTopRailInput): number {
	const scrollTopThatKeepsContentBelowStageStill = scrollTopBeforeCollapse - stageSectionHeightLostByCollapse;
	return Math.max(
		0,
		Math.min(
			scrollTopBeforeCollapse,
			Math.max(scrollTopThatKeepsContentBelowStageStill, scrollTopThatDocksCollapsedStageAtItsTopRailSlot),
		),
	);
}
