import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { buildCrossProjectTaskSwitcherEntryKey } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type ReactElement, useEffect, useRef } from "react";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	CrossProjectTaskSwitcherAutomaticRecoveryWaitingSectionBlock,
	CrossProjectTaskSwitcherPinnedSectionBlock,
	CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock,
	CrossProjectTaskSwitcherRemainingRecentSectionBlock,
	CrossProjectTaskSwitcherRunningSectionBlock,
	type CrossProjectTaskSwitcherSectionBlockProps,
	CrossProjectTaskSwitcherShelvedSectionBlock,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-section-blocks";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { CrossProjectTaskSwitcherFocusedTaskCard } from "@/components/detail-panels/cross-project-task-switcher-focused-task-card";
import { FocusViewGroupHeaderRails } from "@/components/detail-panels/focus-view-group-header-rails";
import { crossProjectTaskSwitcherFocusedTaskVisibilityPanelAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { Button } from "@/components/ui/button";
import { DeletedTaskHistoryIcon } from "@/components/ui/deleted-task-history-icon";
import { Tooltip } from "@/components/ui/tooltip";
import { useCrossProjectTaskSwitcherFocusedTaskVisibility } from "@/hooks/use-cross-project-task-switcher-focused-task-visibility";
import { useCrossProjectTaskSwitcherRowHoverExpansionInPlace } from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import { useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers } from "@/hooks/use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers";
import { useFocusViewGroupSectionNavigation } from "@/hooks/use-focus-view-stage-section-expansion";
import { useStageHeaderPinLayout } from "@/hooks/use-stage-header-pin-layout";
import type { RuntimeAgentId } from "@/runtime/types";
import { writeCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { useMeasure } from "@/utils/react-use";

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
	onOpenPermanentlyDeletedTaskHistory,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	// Focus View 左栏挂载时由 ColumnContextPanel 给出（当前项目的展开行与 This project 同数据、同动作）；
	// 过渡外壳里没有，当前项目的展开行改读服务端。
	currentProjectTaskCards?: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId?: RuntimeAgentId | null;
	onOpenPermanentlyDeletedTaskHistory?: () => void;
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
	const pinnedScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const rowHoverExpansionOfPinnedScrollContainer = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
		panelScrollContainerRef: pinnedScrollContainerRef,
	});
	const rowHoverExpansionOfPanelScrollContainer = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({
		panelScrollContainerRef,
	});
	const focusedTaskVisibility = useCrossProjectTaskSwitcherFocusedTaskVisibility({
		host,
		currentProjectTaskCards,
		sections: sectionsModel.sections,
		scrollRootRef: panelScrollContainerRef,
		pinnedScrollRootRef: pinnedScrollContainerRef,
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

	useEffect(() => {
		if (focusedTaskSourceSection === "shelved") sectionsModel.setIsShelvedSectionExpanded(true);
	}, [focusedTaskSourceSection, focusedTaskEntryKey, sectionsModel.setIsShelvedSectionExpanded]);

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

	const navigableGroups = [
		{
			id: "running",
			Component: CrossProjectTaskSwitcherRunningSectionBlock,
			isExpanded: sectionsModel.isRunningSectionExpanded,
			setExpanded: sectionsModel.setIsRunningSectionExpanded,
		},
		...(sectionsModel.sections.automaticRecoveryWaitingEntries.length > 0
			? [
					{
						id: "waiting_automatic_recovery",
						Component: CrossProjectTaskSwitcherAutomaticRecoveryWaitingSectionBlock,
						isExpanded: true,
						setExpanded: (_expanded: boolean) => {},
					},
				]
			: []),
		{
			id: "prompt_cache_warm",
			Component: CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock,
			isExpanded: sectionsModel.isPromptCacheWarmSectionExpanded,
			setExpanded: sectionsModel.setIsPromptCacheWarmSectionExpanded,
		},
		{
			id: "remaining",
			Component: CrossProjectTaskSwitcherRemainingRecentSectionBlock,
			isExpanded: sectionsModel.isRecentSectionExpanded,
			setExpanded: sectionsModel.setIsRecentSectionExpanded,
		},
		{
			id: "shelved",
			Component: CrossProjectTaskSwitcherShelvedSectionBlock,
			isExpanded: sectionsModel.isShelvedSectionExpanded,
			setExpanded: sectionsModel.setIsShelvedSectionExpanded,
		},
	];
	const [measureFocusedCardClone, focusedCardCloneBounds] = useMeasure<HTMLDivElement>();
	const groupIds = navigableGroups.map(({ id }) => id);
	const groupNavigation = useFocusViewGroupSectionNavigation({
		scrollRootRef: panelScrollContainerRef,
		orderedColumnIds: groupIds,
		focusedColumnId: focusedTaskSelection ? (focusedTaskSourceSection ?? "") : "",
		focusedCardElementSelector: focusedTaskVisibility.focusedTaskScrollAnchorSelector,
		focusedCardCloneHeightPx: focusedCardCloneBounds.height,
		sectionElementAttributeName: "data-focus-view-group-section-id",
		isStageSectionExpanded: (groupId) => navigableGroups.find(({ id }) => id === groupId)?.isExpanded ?? false,
		setStageSectionExpanded: (groupId, expanded) =>
			navigableGroups.find(({ id }) => id === groupId)?.setExpanded(expanded),
	});
	const headerPinLayout = useStageHeaderPinLayout({
		scrollRootRef: panelScrollContainerRef,
		columnIds: groupIds,
		focusedColumnId: focusedTaskSelection ? (focusedTaskSourceSection ?? "") : "",
		focusedTaskId: host.focusedTaskInProject?.taskId ?? "",
		focusedCardElementSelector: focusedTaskVisibility.focusedTaskScrollAnchorSelector,
		focusedCardCloneHeightPx: focusedCardCloneBounds.height,
		sectionElementAttributeName: "data-focus-view-group-section-id",
		focusedCardPinState: focusedTaskPinState,
	});
	return (
		<div
			onPointerEnter={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerEnter}
			onPointerLeave={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerLeave}
			onPointerDownCapture={rowHoverExpansionOfPanelScrollContainer.panelPointerHandlers.onPointerDownCapture}
			className="relative flex min-h-0 flex-1 flex-col overflow-clip"
			data-cross-project-focused-task-visibility-panel=""
			data-focus-view-column-scroll-boundary=""
			data-verification-anchor={crossProjectTaskSwitcherFocusedTaskVisibilityPanelAnchorKey()}
		>
			{host.onRequestCreateTaskInBoardScope || onOpenPermanentlyDeletedTaskHistory ? (
				<div className="flex shrink-0 items-center gap-1 px-2 pt-2">
					{host.onRequestCreateTaskInBoardScope ? (
						<Button
							icon={<span className="text-base leading-none">+</span>}
							aria-label="Create task"
							className="min-w-0 flex-1"
							onClick={host.onRequestCreateTaskInBoardScope}
						>
							Create task{" "}
							<span aria-hidden className="text-text-secondary">
								(c)
							</span>
						</Button>
					) : null}
					{onOpenPermanentlyDeletedTaskHistory ? (
						<Tooltip content="已删除 Task" side="top">
							<Button
								icon={<DeletedTaskHistoryIcon />}
								aria-label="已删除 Task"
								onClick={onOpenPermanentlyDeletedTaskHistory}
								data-verification-anchor="permanently-deleted-task-history-focus-view-entry"
							/>
						</Tooltip>
					) : null}
				</div>
			) : null}
			<CrossProjectTaskSwitcherPinnedSectionBlock
				{...sectionBlockProps}
				sectionColumnScrollContainerBinding={{
					sectionColumnScrollContainerRef: pinnedScrollContainerRef,
					onSectionColumnScroll: () => {},
					onSectionColumnPointerEnter:
						rowHoverExpansionOfPinnedScrollContainer.panelPointerHandlers.onPointerEnter,
					onSectionColumnPointerLeave:
						rowHoverExpansionOfPinnedScrollContainer.panelPointerHandlers.onPointerLeave,
					onSectionColumnPointerDownCapture:
						rowHoverExpansionOfPinnedScrollContainer.panelPointerHandlers.onPointerDownCapture,
				}}
				renderRowInHostingScrollContainer={(entry, section) =>
					renderCrossProjectTaskSwitcherSectionRow(
						entry,
						section,
						rowHoverExpansionOfPinnedScrollContainer,
						section === focusedTaskSourceSection &&
							buildCrossProjectTaskSwitcherEntryKey(entry.workspaceId, entry.entry.taskId) ===
								focusedTaskEntryKey
							? (focusedTaskEntryKey ?? undefined)
							: undefined,
					)
				}
			/>
			{focusedTaskEntryKey && focusedTaskSourceSection === null ? (
				<div
					className="mx-2 mt-1 shrink-0"
					data-cross-project-focused-task-outside-sections=""
					data-cross-project-focused-task-scroll-anchor={focusedTaskEntryKey}
				>
					{renderFocusedTaskCard()}
				</div>
			) : null}
			<div className="relative flex min-h-0 flex-1 flex-col overflow-clip">
				<div
					ref={panelScrollContainerRef}
					data-task-card-column-scroll-container=""
					onScroll={(event) =>
						writeCrossProjectTaskSwitcherPanelViewContinuity({ panelScrollTopPx: event.currentTarget.scrollTop })
					}
					className="isolate flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-2 [overflow-anchor:none]"
					data-testid="cross-project-recently-active-task-switcher-panel"
					data-cross-project-focused-task-pin-state={headerPinLayout.focusedCardRailEdge}
				>
					{navigableGroups.map(({ id, Component }) => (
						<Component
							key={id}
							{...sectionBlockProps}
							headerNavigation={{ onJumpToSection: () => groupNavigation.jumpToStageSectionBelowTopRail(id) }}
						/>
					))}
				</div>
				<FocusViewGroupHeaderRails
					scrollRootRef={panelScrollContainerRef}
					topPinnedGroupIds={headerPinLayout.topPinnedColumnIds}
					bottomPinnedGroupIds={headerPinLayout.bottomPinnedColumnIds}
					totalNavigableGroupCount={groupIds.length}
					renderEntry={(groupId, edge) => {
						const group = navigableGroups.find(({ id }) => id === groupId);
						if (!group) return null;
						const showsFocusedCard =
							groupId === focusedTaskSourceSection && headerPinLayout.focusedCardRailEdge === edge;
						return (
							<group.Component
								key={groupId}
								{...sectionBlockProps}
								rendersGroupHeaderRailEntry
								headerNavigation={{
									onJumpToSection: () => groupNavigation.jumpToStageSectionBelowTopRail(groupId),
									onToggleExpanded: () =>
										groupNavigation.toggleStageSectionExpandedFromStageHeaderRail(groupId, edge),
								}}
								focusedCardContent={
									showsFocusedCard ? (
										<div
											className="max-h-[var(--kb-focused-card-rail-maximum-height)] overflow-y-auto overscroll-contain px-2 pb-2 pt-3"
											data-cross-project-focused-task-sticky-edge={edge === "pinTop" ? "top" : "bottom"}
										>
											{/* 测量自然内容盒；外层限高与 padding 不回灌分类和跳转。 */}
											<div ref={measureFocusedCardClone}>
												{renderFocusedTaskCard(focusedTaskVisibility.revealFocusedTaskScrollAnchor)}
											</div>
										</div>
									) : null
								}
							/>
						);
					}}
				/>
			</div>
			{pinReasonDialogAndOtherProjectConfirmationDialogs}
		</div>
	);
}
