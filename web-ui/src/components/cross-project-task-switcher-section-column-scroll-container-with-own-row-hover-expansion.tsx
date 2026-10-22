import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type ReactElement, useLayoutEffect, useRef } from "react";
import {
	CrossProjectTaskSwitcherBacklogSectionBlock,
	CrossProjectTaskSwitcherPinnedSectionBlock,
	CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock,
	CrossProjectTaskSwitcherRemainingRecentSectionBlock,
	CrossProjectTaskSwitcherRunningSectionBlock,
	type CrossProjectTaskSwitcherSectionBlockProps,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-section-blocks";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { useCrossProjectTaskSwitcherRowHoverExpansionInPlace } from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import type { CrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers } from "@/hooks/use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeBoardScopeAllProjectsHomePageSectionColumnScrollTopPx,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

/**
 * All projects 首页分区列看板的一列：这一列的内容容器自己滚动，并自持一个 hover 原地展开（与 Focus View 左栏面板
 * 同一个 hook、同一套手风琴语义——列表顶边固定，只有交接把新行顶边带出这一列的可视区时才回滚）。
 *
 * hook 的「指针离开面板约 300ms 收起」「Esc / 在面板外按下收起」都以这一列的滚动容器为面板：指针从 A 列移到
 * B 列，A 列 hover 展开的那一行约 300ms 后收起，B 列的行照常停够意图时长再展开。滚动位置跨重挂载保留
 * （Focus View 打开时首页被卸载），记在 cross-project-task-switcher-panel-view-continuity-store。
 */
export function CrossProjectTaskSwitcherSectionColumnScrollContainerWithOwnRowHoverExpansion({
	section,
	sharedSectionRowRendering,
}: {
	section: CrossProjectTaskSwitcherTaskRowSection;
	sharedSectionRowRendering: CrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers;
}): ReactElement | null {
	const { sectionsModel, renderCrossProjectTaskSwitcherSectionRow } = sharedSectionRowRendering;
	const sectionColumnScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const rowHoverExpansionOfSectionColumnScrollContainer = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
		panelScrollContainerRef: sectionColumnScrollContainerRef,
	});
	useLayoutEffect(() => {
		if (sectionColumnScrollContainerRef.current) {
			sectionColumnScrollContainerRef.current.scrollTop =
				readCrossProjectTaskSwitcherPanelViewContinuity()
					.boardScopeAllProjectsHomePageSectionColumnScrollTopPxBySection[section] ?? 0;
		}
	}, [section]);

	const sectionBlockProps: CrossProjectTaskSwitcherSectionBlockProps = {
		sectionBlockPresentation: "section_column_on_board_scope_all_projects_home_page",
		sectionsModel,
		renderRowInHostingScrollContainer: (
			entryInProject: CrossProjectTaskSwitcherEntryInProject,
			rowSection: CrossProjectTaskSwitcherTaskRowSection,
		) =>
			renderCrossProjectTaskSwitcherSectionRow(
				entryInProject,
				rowSection,
				rowHoverExpansionOfSectionColumnScrollContainer,
			),
		sectionColumnScrollContainerBinding: {
			sectionColumnScrollContainerRef,
			onSectionColumnScroll: (event) =>
				writeBoardScopeAllProjectsHomePageSectionColumnScrollTopPx(section, event.currentTarget.scrollTop),
			onSectionColumnPointerEnter:
				rowHoverExpansionOfSectionColumnScrollContainer.panelPointerHandlers.onPointerEnter,
			onSectionColumnPointerLeave:
				rowHoverExpansionOfSectionColumnScrollContainer.panelPointerHandlers.onPointerLeave,
			onSectionColumnPointerDownCapture:
				rowHoverExpansionOfSectionColumnScrollContainer.panelPointerHandlers.onPointerDownCapture,
		},
	};
	switch (section) {
		case "backlog":
			return <CrossProjectTaskSwitcherBacklogSectionBlock {...sectionBlockProps} />;
		case "pinned":
			return <CrossProjectTaskSwitcherPinnedSectionBlock {...sectionBlockProps} />;
		case "running":
			return <CrossProjectTaskSwitcherRunningSectionBlock {...sectionBlockProps} />;
		case "prompt_cache_warm":
			return <CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock {...sectionBlockProps} />;
		case "remaining":
			return <CrossProjectTaskSwitcherRemainingRecentSectionBlock {...sectionBlockProps} />;
	}
}
