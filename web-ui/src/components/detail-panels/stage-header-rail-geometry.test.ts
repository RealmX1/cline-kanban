import { describe, expect, it } from "vitest";

import {
	computeFocusedCardRailContentMaximumHeight,
	computeFocusViewCompactHeaderColumnCount,
	computeFocusViewGroupHeaderRailHeight,
	computeFocusViewGroupHeaderRailRows,
	computeScrollTopAfterCollapsingStageFromTopRail,
	computeScrollTopForJumpingToStageBelowTopRail,
	computeStageHeaderPinLayoutGeometry,
	computeTopRailHeightAboveStageJumpTarget,
	STAGE_HEADER_HEIGHT_PX,
	STAGE_RAIL_FOCUSED_CARD_PADDING_PX,
	STAGE_RAIL_GAP_PX,
	STAGE_SECTION_BORDER_PX,
	selectUncoveredTaskCardHeightPx,
} from "@/components/detail-panels/stage-header-rail-geometry";

describe("紧凑分组标题的共享几何", () => {
	it.each([
		[199, 1],
		[200, 2],
		[299, 2],
		[300, 3],
	])("%spx 滚动口扣除两侧 2px 后容纳 %s 列", (width, expectedColumns) => {
		expect(computeFocusViewCompactHeaderColumnCount(width)).toBe(expectedColumns);
	});

	it("连续紧凑项按列换行，普通标题和焦点副本各占整行", () => {
		const rows = computeFocusViewGroupHeaderRailRows({
			groupIds: ["a", "b", "c", "d", "e", "f"],
			compactGroupIds: ["a", "b", "c", "e", "f"],
			columnCount: 2,
			focusedGroupId: "e",
			focusedCardHeight: 80,
		});
		expect(rows.map(({ groupIds }) => groupIds)).toEqual([["a", "b"], ["c"], ["d"], ["e"], ["f"]]);
		expect(rows.map(({ height }) => height)).toEqual([26, 26, 30, 114, 26]);
	});

	it.each([2, 3])("四个视口外分组在 %s 列时，标题总高至少减少一半", (columnCount) => {
		const rows = computeFocusViewGroupHeaderRailRows({
			groupIds: ["a", "b", "c", "d"],
			compactGroupIds: ["a", "b", "c", "d"],
			columnCount,
		});
		const height = rows.reduce((sum, row) => sum + row.height + 4, -4);
		expect(height).toBeLessThanOrEqual((4 * 34 + 3 * 4) / 2);
	});

	it("分组名称是否压缩只看分组范围，与焦点卡位置无关", () => {
		const input = {
			sections: [
				{ id: "a", top: -200, bottom: -20 },
				{ id: "b", top: -16, bottom: 450 },
				{ id: "c", top: 504, bottom: 800 },
				{ id: "d", top: 804, bottom: 834 },
			],
			viewportTop: 0,
			viewportHeight: 500,
			columnCount: 2,
			compactHeadersEnabled: true,
			focusedColumnId: "b",
			focusedCardTop: -10,
			focusedCardBottom: 70,
			focusedCardHeight: 80,
			focusedCardPinState: "pinTop" as const,
		};
		const first = computeStageHeaderPinLayoutGeometry(input);
		const second = computeStageHeaderPinLayoutGeometry({
			...input,
			focusedColumnId: "d",
			focusedCardPinState: "pinBottom",
		});
		expect(first.compactGroupIds).toEqual(["a", "c", "d"]);
		expect(second.compactGroupIds).toEqual(first.compactGroupIds);
		expect(first.topPinnedColumnIds).toContain("b");
	});

	it("视口内的连续折叠标题不会按标准行距锁步进顶轨", () => {
		const sections = placeCollapsedSections([30, 30, 30, 500, 30, 30], 36);
		const layout = computeStageHeaderPinLayoutGeometry({
			sections,
			viewportTop: 0,
			viewportHeight: 640,
			columnCount: 2,
			compactHeadersEnabled: true,
			focusedColumnId: "",
			focusedCardTop: 0,
			focusedCardBottom: 0,
			focusedCardHeight: 0,
			focusedCardPinState: "hidden",
		});
		const expanded = sections[3]!;
		const topRail = railHeightFor(layout.topPinnedColumnIds, layout);
		const firstCardTop = expanded.top + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		expect(layout.compactGroupIds).toEqual(["a"]);
		expect(layout.topPinnedColumnIds).not.toContain("d");
		expect(firstCardTop).toBeGreaterThanOrEqual(topRail);
	});

	it("六个折叠分组轻微下滚后，视口内标题不会全部钉死", () => {
		const sections = placeCollapsedSections([30, 30, 30, 30, 30, 30], 40);
		const layout = computeStageHeaderPinLayoutGeometry({
			sections,
			viewportTop: 0,
			viewportHeight: 640,
			columnCount: 2,
			compactHeadersEnabled: true,
			focusedColumnId: "",
			focusedCardTop: 0,
			focusedCardBottom: 0,
			focusedCardHeight: 0,
			focusedCardPinState: "hidden",
		});
		const topRail = railHeightFor(layout.topPinnedColumnIds, layout);
		expect(layout.topPinnedColumnIds.length).toBeLessThan(sections.length);
		expect(sections.some((section) => section.top >= topRail)).toBe(true);
	});
});

/** 列表 padding 8px、分段之间 gap 4px，与 Focus View 滚动口一致。 */
function placeCollapsedSections(heights: number[], scrollTop: number) {
	const sections = [];
	let top = 8;
	for (const [index, height] of heights.entries()) {
		sections.push({ id: String.fromCharCode(97 + index), top: top - scrollTop, bottom: top + height - scrollTop });
		top += height + STAGE_RAIL_GAP_PX;
	}
	return sections;
}

function railHeightFor(
	groupIds: readonly string[],
	layout: { compactGroupIds: readonly string[]; columnCount: number },
): number {
	return computeFocusViewGroupHeaderRailHeight({
		groupIds,
		compactGroupIds: layout.compactGroupIds,
		columnCount: layout.columnCount,
	});
}

describe("跳转落点让实测高度的首张任务卡完整露出", () => {
	function landingVisibleHeight({
		viewportHeight,
		groupCount,
		targetIndex,
		naturalCardHeight,
		firstCardHeight,
		compact,
	}: {
		viewportHeight: number;
		groupCount: number;
		targetIndex: number;
		naturalCardHeight: number;
		firstCardHeight: number;
		compact: boolean;
	}) {
		const sectionHeight = 300;
		const ids = Array.from({ length: groupCount }, (_, index) => `g${index}`);
		const sections = ids.map((id, index) => ({
			id,
			top: index * (sectionHeight + STAGE_RAIL_GAP_PX),
			bottom: index * (sectionHeight + STAGE_RAIL_GAP_PX) + sectionHeight,
		}));
		const focusedIndex = Math.min(1, targetIndex);
		const columnCount = computeFocusViewCompactHeaderColumnCount(320);
		const railLayout = {
			sections,
			viewportTop: 0,
			viewportHeight,
			columnCount,
			compactHeadersEnabled: compact,
			focusedColumnId: ids[focusedIndex]!,
			focusedCardTop: sections[focusedIndex]!.top + 36,
			focusedCardBottom: sections[focusedIndex]!.top + 116,
			focusedCardHeight: naturalCardHeight,
			uncoveredTaskCardHeightPx: firstCardHeight,
		};
		const reserved = computeTopRailHeightAboveStageJumpTarget({
			targetStageIndex: targetIndex,
			focusedStageIndex: focusedIndex,
			focusedCardViewportTop: railLayout.focusedCardTop,
			focusedCardHeight: naturalCardHeight,
			targetSectionViewportTop: sections[targetIndex]!.top,
			railLayout,
		});
		const delta = sections[targetIndex]!.top - reserved;
		const layout = computeStageHeaderPinLayoutGeometry({
			...railLayout,
			sections: sections.map((section) => ({
				...section,
				top: section.top - delta,
				bottom: section.bottom - delta,
			})),
			focusedCardTop: railLayout.focusedCardTop - delta,
			focusedCardBottom: railLayout.focusedCardBottom - delta,
			focusedCardPinState: "pinTop",
		});
		const topRail = computeFocusViewGroupHeaderRailHeight({
			groupIds: layout.topPinnedColumnIds,
			compactGroupIds: layout.compactGroupIds,
			columnCount,
			focusedGroupId: layout.focusedCardRailEdge === "pinTop" ? ids[focusedIndex] : undefined,
			focusedCardHeight: Math.min(naturalCardHeight, layout.focusedCardContentMaximumHeight),
		});
		const bottomRail = computeFocusViewGroupHeaderRailHeight({
			groupIds: layout.bottomPinnedColumnIds,
			compactGroupIds: layout.compactGroupIds,
			columnCount,
			focusedGroupId: layout.focusedCardRailEdge === "pinBottom" ? ids[focusedIndex] : undefined,
			focusedCardHeight: Math.min(naturalCardHeight, layout.focusedCardContentMaximumHeight),
		});
		const firstCardTop = reserved + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		const firstCardBottom = firstCardTop + firstCardHeight;
		const visibleBottom = viewportHeight - bottomRail;
		return {
			firstCardStartsBelowRail: firstCardTop >= topRail,
			firstCardFitsBeforeBottomRail: firstCardBottom <= visibleBottom,
			visibleHeight: visibleBottom - Math.max(firstCardTop, topRail),
		};
	}

	it.each([
		{ viewportHeight: 500, groupCount: 6, targetIndex: 5, compact: false },
		{ viewportHeight: 500, groupCount: 6, targetIndex: 5, compact: true },
		{ viewportHeight: 640, groupCount: 6, targetIndex: 5, compact: false },
		{ viewportHeight: 500, groupCount: 5, targetIndex: 2, compact: false },
	])("视口 $viewportHeight、目标 $targetIndex、紧凑 $compact 时 200px 首卡完整露出", (scenario) => {
		const firstCardHeight = 200;
		const landing = landingVisibleHeight({ ...scenario, naturalCardHeight: 400, firstCardHeight });
		expect(firstCardHeight).toBeGreaterThan(120);
		expect(firstCardHeight).toBeLessThan(scenario.viewportHeight);
		expect(landing.firstCardStartsBelowRail).toBe(true);
		expect(landing.firstCardFitsBeforeBottomRail).toBe(true);
		expect(landing.visibleHeight).toBeGreaterThanOrEqual(firstCardHeight);
	});
});

describe("副本限高在首卡放不进剩余空间时保留内部滚动", () => {
	it("首卡高于标题之外的剩余空间时不把副本压成 0", () => {
		const viewportHeight = 420;
		const headerRailHeight = viewportHeight - 34;
		const roomAfterHeaders = viewportHeight - headerRailHeight - STAGE_RAIL_FOCUSED_CARD_PADDING_PX;
		expect(roomAfterHeaders).toBe(26);
		expect(computeFocusedCardRailContentMaximumHeight(viewportHeight, headerRailHeight, 0)).toBe(26);
		expect(computeFocusedCardRailContentMaximumHeight(viewportHeight, headerRailHeight, 120)).toBe(26);
		expect(computeFocusedCardRailContentMaximumHeight(viewportHeight, headerRailHeight, 26)).toBe(0);
	});

	it("首卡能放进剩余空间时仍完整扣除", () => {
		expect(computeFocusedCardRailContentMaximumHeight(500, 204, 200)).toBe(88);
		expect(computeFocusedCardRailContentMaximumHeight(500, 204, 0)).toBe(288);
	});
});

describe("跳转落点与分类使用同一张首卡", () => {
	const columnCount = computeFocusViewCompactHeaderColumnCount(320);
	const sections = [
		{ id: "running", top: 8, bottom: 1391.625 },
		{ id: "waiting", top: 1395.625, bottom: 1493.25 },
		{ id: "cache", top: 1497.25, bottom: 1561.25 },
		{ id: "remaining", top: 1565.25, bottom: 2778.875 },
		{ id: "shelved", top: 2782.875, bottom: 2812.875 },
	];
	const focusedCardTop = 37;
	const railLayout = {
		sections,
		viewportTop: 0,
		viewportHeight: 500,
		columnCount,
		compactHeadersEnabled: true,
		focusedColumnId: "running",
		focusedCardTop,
		focusedCardBottom: focusedCardTop + 400,
		focusedCardHeight: 400,
		uncoveredTaskCardHeightPx: 200,
	};

	function layoutAfterJump(cardHeight: number) {
		const reserved = computeTopRailHeightAboveStageJumpTarget({
			targetStageIndex: 3,
			focusedStageIndex: 0,
			focusedCardViewportTop: focusedCardTop,
			focusedCardHeight: 400,
			targetSectionViewportTop: sections[3]!.top,
			railLayout: { ...railLayout, uncoveredTaskCardHeightPx: cardHeight },
		});
		const delta = sections[3]!.top - reserved;
		const shifted = sections.map((section) => ({
			...section,
			top: section.top - delta,
			bottom: section.bottom - delta,
		}));
		const layout = computeStageHeaderPinLayoutGeometry({
			...railLayout,
			sections: shifted,
			focusedCardTop: focusedCardTop - delta,
			focusedCardBottom: focusedCardTop + 400 - delta,
			focusedCardPinState: "pinTop",
			uncoveredTaskCardHeightPx: cardHeight,
		});
		const topRail = computeFocusViewGroupHeaderRailHeight({
			groupIds: layout.topPinnedColumnIds,
			compactGroupIds: layout.compactGroupIds,
			columnCount,
			focusedGroupId: layout.focusedCardRailEdge === "pinTop" ? "running" : undefined,
			focusedCardHeight: Math.min(400, layout.focusedCardContentMaximumHeight),
		});
		const bottomRail = computeFocusViewGroupHeaderRailHeight({
			groupIds: layout.bottomPinnedColumnIds,
			compactGroupIds: layout.compactGroupIds,
			columnCount,
		});
		const firstCardTop = reserved + STAGE_HEADER_HEIGHT_PX + STAGE_SECTION_BORDER_PX;
		return { reserved, shifted, layout, topRail, bottomRail, firstCardTop };
	}

	it("目标分组正好落在顶轨下沿时不被钉住，200px 首卡留在上下轨之间", () => {
		const landing = layoutAfterJump(200);
		expect(landing.layout.topPinnedColumnIds).not.toContain("remaining");
		expect(landing.firstCardTop).toBeGreaterThanOrEqual(landing.topRail);
		expect(landing.firstCardTop + 200).toBeLessThanOrEqual(500 - landing.bottomRail);
	});

	it("顶轨盖住目标首卡时，分类改用这张更高的卡而不是中间分组的矮卡", () => {
		const landing = layoutAfterJump(200);
		const classifyAtLanding = (cardHeight: number) => {
			const layout = computeStageHeaderPinLayoutGeometry({
				...railLayout,
				sections: landing.shifted,
				focusedCardTop: focusedCardTop - (sections[3]!.top - landing.reserved),
				focusedCardBottom: focusedCardTop + 400 - (sections[3]!.top - landing.reserved),
				focusedCardPinState: "pinTop",
				uncoveredTaskCardHeightPx: cardHeight,
			});
			return computeFocusViewGroupHeaderRailHeight({
				groupIds: layout.topPinnedColumnIds,
				compactGroupIds: layout.compactGroupIds,
				columnCount,
				focusedGroupId: layout.focusedCardRailEdge === "pinTop" ? "running" : undefined,
				focusedCardHeight: Math.min(400, layout.focusedCardContentMaximumHeight),
			});
		};
		const selected = selectUncoveredTaskCardHeightPx({
			sections: landing.shifted.map((section) => ({
				top: section.top,
				cardTop: section.id === "remaining" ? landing.firstCardTop : section.top + 29,
				cardHeight:
					section.id === "running" ? 400 : section.id === "waiting" ? 61.63 : section.id === "remaining" ? 200 : 0,
			})),
			viewportTop: 0,
			initialCardHeightPx: 61.63,
			topRailHeightForCard: classifyAtLanding,
		});
		expect(selected).toBe(200);
		expect(classifyAtLanding(61.63)).toBeGreaterThan(landing.firstCardTop);
		expect(classifyAtLanding(200)).toBeLessThanOrEqual(landing.firstCardTop);
	});
});

/** 一个普通 rail 条目占的纵向空间；测试内独立重算，避免与实现共用同一处笔误。 */
const PLAIN_ENTRY_STRIDE = 28 + 2 + 4;

describe("stage header rail geometry constants", () => {
	// 守卫断言：这些数值同时被渲染方、分类方、滚动落点计算消费，漂移必须是一次**有意的**测试改动。
	it("pins the shared rail entry box constants", () => {
		expect(STAGE_HEADER_HEIGHT_PX).toBe(28);
		expect(STAGE_SECTION_BORDER_PX).toBe(2);
		expect(STAGE_RAIL_GAP_PX).toBe(4);
		expect(STAGE_RAIL_FOCUSED_CARD_PADDING_PX).toBe(8);
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
		// 焦点卡远在目标 section 之上（−400）：即使加上 R=68 也仍在视口上沿之上 → 钉顶 → 有克隆。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -400,
				focusedCardHeight: 92,
			}),
		).toBe(68 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92);
	});

	it("焦点卡跳转后仍在视口内但被标题 rail 遮住时，也预留完整副本", () => {
		// 偏移 −50：无副本时落在 26px，位于普通标题 rail 内，分类器仍会补出焦点副本。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -50,
				focusedCardHeight: 92,
			}),
		).toBe(68 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92);
	});

	it("takes the safe (larger) side at the exact boundary", () => {
		// −68 + 68 = 0，判据取闭区间 → 按有克隆预留：宁可 rail 下方多留空隙，也不把目标塞回 rail 之后。
		expect(
			computeTopRailHeightAboveStageJumpTarget({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -68,
				focusedCardHeight: 92,
			}),
		).toBe(68 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92);
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
			).toBe(68);
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
		// 目标 section 在视口内 600px 处；要把它挪到 rootTop + 68 → 需再向下滚 524。
		// 旧的 scrollIntoView({block:"start"}) 等价于滚 600，多出的 68 正是被 rail 盖住的那截。
		expect(computeScrollTopForJumpingToStageBelowTopRail(baseInput)).toBe(300 + 600 - 68);
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
		// 目标 section 在视口上沿之上 300px；要把它挪到 rootTop + 68 → 需向上滚 368。
		expect(
			computeScrollTopForJumpingToStageBelowTopRail({
				...baseInput,
				currentScrollTop: 1000,
				targetSectionViewportTop: -200,
			}),
		).toBe(1000 - 368);
	});

	it("shifts the landing point down by the focused card clone when one is reserved", () => {
		expect(
			computeScrollTopForJumpingToStageBelowTopRail({
				...baseInput,
				focusedStageIndex: 0,
				focusedCardViewportTop: -400,
				focusedCardHeight: 92,
			}),
		).toBe(300 + 600 - (68 + STAGE_RAIL_FOCUSED_CARD_PADDING_PX + 92));
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
