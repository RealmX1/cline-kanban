import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { buildCrossProjectTaskSwitcherEntryKey } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type ReactElement, useRef } from "react";
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
import { CrossProjectTaskSwitcherFocusedTaskCard } from "@/components/detail-panels/cross-project-task-switcher-focused-task-card";
import { crossProjectTaskSwitcherFocusedTaskVisibilityPanelAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useCrossProjectTaskSwitcherFocusedTaskVisibility } from "@/hooks/use-cross-project-task-switcher-focused-task-visibility";
import { useCrossProjectTaskSwitcherRowHoverExpansionInPlace } from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import { useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers } from "@/hooks/use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers";
import type { RuntimeAgentId } from "@/runtime/types";
import { writeCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

/**
 * Focus View 左栏的 All projects 模式：跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）。
 * 自上而下四个区：Pinned（可与下面重复）→ Running（默认收起）→ Cache warm · your turn → Recent。
 * Cache warm 与 Recent 默认展开，Recent 提供两种排序与可组合阶段筛选。
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
	const focusedTaskVisibility = useCrossProjectTaskSwitcherFocusedTaskVisibility({
		host,
		currentProjectTaskCards,
		sections: sectionsModel.sections,
		scrollRootRef: panelScrollContainerRef,
	});
	const { focusedTaskEntryKey, focusedTaskSelection, focusedTaskSourceSection, focusedTaskPinState } =
		focusedTaskVisibility;
	const focusedTaskProjectName =
		host.projects.find((project) => project.id === focusedTaskVisibility.focusedTaskInProject?.workspaceId)?.name ??
		"";
	const renderFocusedTaskCard = (onRevealFocusedTask?: () => void) => (
		<CrossProjectTaskSwitcherFocusedTaskCard
			selection={focusedTaskSelection}
			projectName={focusedTaskProjectName}
			currentProjectTaskCards={currentProjectTaskCards}
			defaultAgentId={defaultAgentId}
			onRevealFocusedTask={onRevealFocusedTask}
		/>
	);

	const sectionBlockProps: CrossProjectTaskSwitcherSectionBlockProps = {
		sectionBlockPresentation: "stacked_section_in_focus_view_left_column_panel",
		sectionsModel,
		focusedTaskRowToKeepMounted:
			focusedTaskEntryKey && focusedTaskSourceSection
				? { entryKey: focusedTaskEntryKey, section: focusedTaskSourceSection }
				: null,
		renderRowInHostingScrollContainer: (
			entryInProject: CrossProjectTaskSwitcherEntryInProject,
			section: CrossProjectTaskSwitcherTaskRowSection,
		) =>
			renderCrossProjectTaskSwitcherSectionRow(
				entryInProject,
				section,
				rowHoverExpansionOfPanelScrollContainer,
				section === focusedTaskSourceSection &&
					buildCrossProjectTaskSwitcherEntryKey(entryInProject.workspaceId, entryInProject.entry.taskId) ===
						focusedTaskEntryKey
					? focusedTaskEntryKey
					: undefined,
			),
	};

	return (
		<div
			// 源行、Sticky 与它们打开的 Portal 共用同一个 React 指针边界，副本内交互不能被当作离开面板。
			onPointerEnter={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerEnter}
			onPointerLeave={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerLeave}
			onPointerDownCapture={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerDownCapture}
			className="relative flex min-h-0 flex-1 flex-col overflow-clip"
			data-cross-project-focused-task-visibility-panel=""
			data-verification-anchor={crossProjectTaskSwitcherFocusedTaskVisibilityPanelAnchorKey()}
		>
			<div
				ref={panelScrollContainerRef}
				onScroll={(event) =>
					writeCrossProjectTaskSwitcherPanelViewContinuity({ panelScrollTopPx: event.currentTarget.scrollTop })
				}
				// overflow-anchor: none —— hover 交接时列表顶边固定（见 use-cross-project-task-switcher-row-hover-expansion-in-place）；
				// 浏览器自带的 scroll anchoring 会在面板滚动过时自己补 scrollTop，把指针上方的整列往下拖。
				className="isolate flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2 [overflow-anchor:none]"
				data-testid="cross-project-recently-active-task-switcher-panel"
				data-cross-project-focused-task-pin-state={focusedTaskPinState}
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
				{focusedTaskEntryKey && focusedTaskSourceSection === null ? (
					<div
						className="shrink-0"
						data-cross-project-focused-task-outside-sections=""
						data-cross-project-focused-task-scroll-anchor={focusedTaskEntryKey}
					>
						{renderFocusedTaskCard()}
					</div>
				) : null}
				<CrossProjectTaskSwitcherPinnedSectionBlock {...sectionBlockProps} />
				<CrossProjectTaskSwitcherRunningSectionBlock {...sectionBlockProps} />
				<CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock {...sectionBlockProps} />
				<CrossProjectTaskSwitcherRemainingRecentSectionBlock {...sectionBlockProps} />
				{pinReasonDialogAndOtherProjectConfirmationDialogs}
			</div>
			{focusedTaskSelection && focusedTaskPinState !== "hidden" ? (
				<div
					className={cn(
						"pointer-events-none absolute inset-x-0 z-10 max-h-full overflow-y-auto px-2",
						focusedTaskPinState === "pinTop" ? "top-0" : "bottom-0",
					)}
					data-cross-project-focused-task-sticky-edge={focusedTaskPinState === "pinTop" ? "top" : "bottom"}
				>
					<div className="pointer-events-auto bg-surface-0 py-2">
						{renderFocusedTaskCard(focusedTaskVisibility.revealFocusedTaskScrollAnchor)}
					</div>
				</div>
			) : null}
		</div>
	);
}
