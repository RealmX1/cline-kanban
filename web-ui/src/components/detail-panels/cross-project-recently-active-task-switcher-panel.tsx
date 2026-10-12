import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type ReactElement, useLayoutEffect, useRef } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	CrossProjectTaskSwitcherPinnedSectionBlock,
	CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock,
	CrossProjectTaskSwitcherRemainingRecentSectionBlock,
	CrossProjectTaskSwitcherRunningSectionBlock,
	type CrossProjectTaskSwitcherSectionBlockProps,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-section-blocks";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { Button } from "@/components/ui/button";
import { useCrossProjectTaskSwitcherRowHoverExpansionInPlace } from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import { useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers } from "@/hooks/use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers";
import type { RuntimeAgentId } from "@/runtime/types";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

/**
 * Focus View 左栏的 All projects 模式：跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）。
 * 自上而下四个区：Pinned（可与下面重复）→ Running（默认收起）→ Cache warm · your turn（按失效时刻升序）→ 剩余区（三种排序）。
 * 区归属全在 src/core/cross-project-recently-active-task-switcher-section-assignment.ts，这里只渲染。
 * 同一组分区在 All projects 首页横排成列（board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board.tsx）；
 * 移动端首页直接渲染本面板。
 */
export function CrossProjectRecentlyActiveTaskSwitcherPanel({
	host,
	currentProjectTaskCards = null,
	defaultAgentId = null,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	// Focus View 左栏挂载时由 ColumnContextPanel 给出（当前项目的展开行与 This project 同数据、同动作）；
	// 过渡外壳里没有，当前项目的展开行改读服务端。
	currentProjectTaskCards?: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement {
	const {
		sectionsModel,
		renderCrossProjectTaskSwitcherSectionRow,
		pinReasonDialogAndOtherProjectConfirmationDialogs,
	} = useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers({
		host,
		currentProjectTaskCards,
		defaultAgentId,
		sectionBlockPresentation: "stacked_section_in_focus_view_left_column_panel",
	});
	const panelScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const rowHoverExpansionOfPanelScrollContainer = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
		panelScrollContainerRef,
	});
	// 跨重挂载保留（Focus View 左栏 ↔ 过渡外壳），见 cross-project-task-switcher-panel-view-continuity-store。
	useLayoutEffect(() => {
		if (panelScrollContainerRef.current) {
			panelScrollContainerRef.current.scrollTop = readCrossProjectTaskSwitcherPanelViewContinuity().panelScrollTopPx;
		}
	}, []);

	const sectionBlockProps: CrossProjectTaskSwitcherSectionBlockProps = {
		sectionBlockPresentation: "stacked_section_in_focus_view_left_column_panel",
		sectionsModel,
		renderRowInHostingScrollContainer: (
			entryInProject: CrossProjectTaskSwitcherEntryInProject,
			section: CrossProjectTaskSwitcherTaskRowSection,
		) => renderCrossProjectTaskSwitcherSectionRow(entryInProject, section, rowHoverExpansionOfPanelScrollContainer),
	};

	return (
		<div
			ref={panelScrollContainerRef}
			onScroll={(event) =>
				writeCrossProjectTaskSwitcherPanelViewContinuity({ panelScrollTopPx: event.currentTarget.scrollTop })
			}
			onPointerEnter={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerEnter}
			onPointerLeave={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerLeave}
			onPointerDownCapture={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerDownCapture}
			// overflow-anchor: none —— hover 交接时列表顶边固定（见 use-cross-project-task-switcher-row-hover-expansion-in-place）；
			// 浏览器自带的 scroll anchoring 会在面板滚动过时自己补 scrollTop，把指针上方的整列往下拖。
			className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2 [overflow-anchor:none]"
			data-testid="cross-project-recently-active-task-switcher-panel"
		>
			{/* 与 This project 左栏同一个入口样式；Board Scope 下打开带目标项目字段的建卡框（默认上下文项目）。 */}
			{host.onRequestCreateTaskInBoardScope ? (
				<Button
					icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
					aria-label="Create task"
					fill
					onClick={host.onRequestCreateTaskInBoardScope}
					className="shrink-0"
				>
					<span className="inline-flex items-center gap-1.5">
						<span>Create task</span>
						<span aria-hidden className="text-text-secondary">
							(c)
						</span>
					</span>
				</Button>
			) : null}
			<CrossProjectTaskSwitcherPinnedSectionBlock {...sectionBlockProps} />
			<CrossProjectTaskSwitcherRunningSectionBlock {...sectionBlockProps} />
			<CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock {...sectionBlockProps} />
			<CrossProjectTaskSwitcherRemainingRecentSectionBlock {...sectionBlockProps} />
			{pinReasonDialogAndOtherProjectConfirmationDialogs}
		</div>
	);
}
