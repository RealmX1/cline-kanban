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
export const STAGE_HEADER_HEIGHT_PX = 32;
/** rail 条目间距（复刻 scrollport 的 `gap-1` = 4px）；计入阈值时略作高估以偏向「不吞卡」的安全侧。 */
export const STAGE_RAIL_GAP_PX = 4;
/**
 * 每个 rail 条目外框 `border border-border` 的上下边框之和（1px 上 + 1px 下）。渲染侧 `StageHeaderRailEntry`
 * 的外层 `<div className="bg-surface-1 rounded-lg border border-border">` 使条目真实高度比卡头槽高多这 2px；
 * 阈值须逐条计入，否则多条堆叠后累计误差会让「首个未钉卡头」落进不透明 rail 之后被遮住（RVF-002 遮挡类 bug）。
 */
export const STAGE_SECTION_BORDER_PX = 2;
/**
 * 焦点卡克隆外层 `pt-3 pb-2` 的上下 padding 之和（12px 上 + 8px 下），顶部避让悬停操作组。仅焦点条目
 * （`withCard`）挂此包裹层；`focusedCardHeight` 取真实卡 border box（`getBoundingClientRect().height` 不含其
 * `marginBottom: 6`，与 rail 内 sticky 卡头副本的 `marginBottom: 0` 一致），故焦点条目真实高
 * = 卡头槽高 + 外框 + 此 padding + 焦点卡高。漏计这 20px 会使焦点条目严重低估、吞掉相邻随流卡头。
 */
export const STAGE_RAIL_FOCUSED_CARD_PADDING_PX = 20;

/** 一个不含焦点卡克隆的普通 rail 条目所占的纵向空间（条目自身高 + 其下的堆叠间距）。 */
const PLAIN_STAGE_RAIL_ENTRY_STRIDE_PX = STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX + STAGE_RAIL_GAP_PX;

/** 完整副本的内容限高；预留全部可导航标题，避免分类结果反过来改变测量预算。 */
export function computeFocusedCardRailContentMaximumHeight(
	scrollViewportHeight: number,
	navigableGroupCount: number,
): number {
	return Math.max(
		0,
		scrollViewportHeight -
			navigableGroupCount * PLAIN_STAGE_RAIL_ENTRY_STRIDE_PX -
			STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
	);
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
}

/**
 * 跳转落点上，目标 stage 之上那截顶 rail 的总高度 `R`——即目标 stage 的卡头应停靠的位置（相对滚动口上沿）。
 *
 * 与 `use-stage-header-pin-layout.ts` 前向 pass 的 `topOffset` 累加同构：目标之前的每个 stage 都会因
 * 「section 上沿已滚到 rail 增长下沿之上」而钉顶，各占一个条目高 + 一段间距。
 *
 * 先按无副本的落点预测焦点卡位置，再复用分类器的标题遮挡判据（包括目标标题本身）。
 * 焦点卡进入普通标题 rail 时就预留完整副本；只试算一次，避免副本把源卡推低后的反馈循环。
 * 即使最终无需副本，也只会多留空隙，不会把目标首行塞回不透明 rail 之后。
 */
export function computeTopRailHeightAboveStageJumpTarget({
	targetStageIndex,
	focusedStageIndex,
	focusedCardViewportTop,
	focusedCardHeight,
	targetSectionViewportTop,
}: StageJumpTargetRailGeometryInput): number {
	if (targetStageIndex <= 0) {
		return 0;
	}
	const plainTopRailHeightAboveTarget = targetStageIndex * PLAIN_STAGE_RAIL_ENTRY_STRIDE_PX;
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
 * 所在——落点上目标之前的 k 个 stage 全部钉顶，rail 高约 k × 50px，目标卡头连同第一张卡都被盖住，
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
