import { describe, expect, it } from "vitest";

import {
	computeScrollTopAfterCollapsingStageFromTopRail,
	computeScrollTopForJumpingToStageBelowTopRail,
	computeTopRailHeightAboveStageJumpTarget,
	STAGE_HEADER_HEIGHT_PX,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
	STAGE_RAIL_GAP_PX,
	STAGE_SECTION_BORDER_PX,
} from "@/components/detail-panels/stage-header-rail-geometry";

/** 一个普通 rail 条目占的纵向空间；测试内独立重算，避免与实现共用同一处笔误。 */
const PLAIN_ENTRY_STRIDE = 40 + 2 + 8;

describe("stage header rail geometry constants", () => {
	// 守卫断言：这些数值同时被渲染方、分类方、滚动落点计算消费，漂移必须是一次**有意的**测试改动。
	it("pins the shared rail entry box constants", () => {
		expect(STAGE_HEADER_HEIGHT_PX).toBe(40);
		expect(STAGE_SECTION_BORDER_PX).toBe(2);
		expect(STAGE_RAIL_GAP_PX).toBe(8);
		expect(STAGE_RAIL_FOCUSED_CARD_PADDING_PX).toBe(16);
	});
});

describe("computeTopRailHeightAboveStageJumpTarget", () => {
	const baseInput = {
		targetStageIndex: 2,
		focusedStageIndex: -1,
		focusedCardViewportTop: 0,
		focusedCardHeight: 0,
		targetSectionViewportTop: 0,
	};

	it("returns zero for the first stage (nothing can be pinned above it)", () => {
		expect(computeTopRailHeightAboveStageJumpTarget({ ...baseInput, targetStageIndex: 0 })).toBe(0);
	});

	it("accumulates one plain entry stride per stage above the target", () => {
		expect(computeTopRailHeightAboveStageJumpTarget(baseInput)).toBe(2 * PLAIN_ENTRY_STRIDE);
	});

	it("reserves the focused card clone when the focused card would pin to the top after the jump", () => {
		// 焦点卡远在目标 section 之上（−400）：即使加上 R=100 也仍在视口上沿之上 → 钉顶 → 有克隆。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -400,
				focusedCardHeight: 92,
			}),
		).toBe(100 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92);
	});

	it("omits the clone when the focused card would land below the viewport top even at the smaller rail height", () => {
		// 偏移 −50：−50 + 100 = 50 > 0 → 跳转后焦点卡落在视口上沿之下（被 rail 遮住但判为 hidden）→ 无克隆。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -50,
				focusedCardHeight: 92,
			}),
		).toBe(100);
	});

	it("takes the safe (larger) side at the exact boundary", () => {
		// −100 + 100 = 0，判据取闭区间 → 按有克隆预留：宁可 rail 下方多留空隙，也不把目标塞回 rail 之后。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -100,
				focusedCardHeight: 92,
			}),
		).toBe(100 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92);
	});

	it("ignores the focused stage when it sits at or below the target, or is missing", () => {
		for (const focusedStageIndex of [-1, 2, 3]) {
			expect(
				computeTopRailHeightAboveStageJumpTarget({
					...baseInput,
					focusedStageIndex,
					focusedCardViewportTop: -400,
					focusedCardHeight: 92,
				}),
			).toBe(100);
		}
	});
});

describe("computeScrollTopForJumpingToStageBelowTopRail", () => {
	const baseInput = {
		targetStageIndex: 2,
		focusedStageIndex: -1,
		focusedCardViewportTop: 0,
		focusedCardHeight: 0,
		targetSectionViewportTop: 700,
		scrollRootViewportTop: 100,
		currentScrollTop: 300,
	};

	it("parks the target section top at the bottom edge of the top rail, not at the scrollport top edge", () => {
		// 目标 section 在视口内 600px 处；要把它挪到 rootTop + 100 → 需再向下滚 500。
		// 旧的 scrollIntoView({block:"start"}) 等价于滚 600，多出的 100 正是被 rail 盖住的那截。
		expect(computeScrollTopForJumpingToStageBelowTopRail(baseInput)).toBe(300 + 600 - 100);
	});

	it("clamps to zero instead of producing a negative scrollTop", () => {
		expect(
			computeScrollTopForJumpingToStageBelowTopRail({
				...baseInput,
				currentScrollTop: 0,
				targetSectionViewportTop: 120,
			}),
		).toBe(0);
	});

	it("scrolls upward when the target sits above the current viewport", () => {
		// 目标 section 在视口上沿之上 300px；要把它挪到 rootTop + 100 → 需向上滚 400。
		expect(
			computeScrollTopForJumpingToStageBelowTopRail({
				...baseInput,
				currentScrollTop: 1000,
				targetSectionViewportTop: -200,
			}),
		).toBe(1000 - 400);
	});

	it("shifts the landing point down by the focused card clone when one is reserved", () => {
		expect(
			computeScrollTopForJumpingToStageBelowTopRail({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -400,
				focusedCardHeight: 92,
			}),
		).toBe(300 + 600 - (100 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92));
	});
});

describe("computeScrollTopAfterCollapsingStageFromTopRail", () => {
	it("compensates by the lost height when the whole section is already above the viewport", () => {
		// 用户在看后面的 stage：等量补偿，视口内容零位移（停靠落点 700 更靠上，不取）。
		expect(
			computeScrollTopAfterCollapsingStageFromTopRail({
				scrollTopBeforeCollapse: 1000,
				stageSectionHeightLostByCollapse: 158,
				scrollTopThatDocksCollapsedStageAtItsTopRailSlot: 700,
			}),
		).toBe(842);
	});

	it("docks the collapsed header at its rail slot when its cards were still in view", () => {
		// 用户正在看它：等量补偿（812）会让视口落进下一个 stage 的中段，停靠落点（870）让下一个 stage 紧随卡头。
		expect(
			computeScrollTopAfterCollapsingStageFromTopRail({
				scrollTopBeforeCollapse: 1000,
				stageSectionHeightLostByCollapse: 188,
				scrollTopThatDocksCollapsedStageAtItsTopRailSlot: 870,
			}),
		).toBe(870);
	});

	it("is continuous where the two candidates meet", () => {
		expect(
			computeScrollTopAfterCollapsingStageFromTopRail({
				scrollTopBeforeCollapse: 1000,
				stageSectionHeightLostByCollapse: 130,
				scrollTopThatDocksCollapsedStageAtItsTopRailSlot: 870,
			}),
		).toBe(870);
	});

	it("never pushes content downward, and never goes negative", () => {
		expect(
			computeScrollTopAfterCollapsingStageFromTopRail({
				scrollTopBeforeCollapse: 1000,
				stageSectionHeightLostByCollapse: 0,
				scrollTopThatDocksCollapsedStageAtItsTopRailSlot: 1040,
			}),
		).toBe(1000);
		expect(
			computeScrollTopAfterCollapsingStageFromTopRail({
				scrollTopBeforeCollapse: 20,
				stageSectionHeightLostByCollapse: 300,
				scrollTopThatDocksCollapsedStageAtItsTopRailSlot: -30,
			}),
		).toBe(0);
	});
});
