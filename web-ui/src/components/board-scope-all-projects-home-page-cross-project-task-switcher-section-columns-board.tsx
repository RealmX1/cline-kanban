import type { ReactElement } from "react";
import { CrossProjectTaskSwitcherSectionColumnScrollContainerWithOwnRowHoverExpansion } from "@/components/cross-project-task-switcher-section-column-scroll-container-with-own-row-hover-expansion";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import {
	deriveAwaitingUserTaskCount,
	deriveLiveAgentTaskCount,
} from "@/components/top-bar-project-switcher/project-switcher-session-activity-counts";
import { Button } from "@/components/ui/button";
import { useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers } from "@/hooks/use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeAgentId } from "@/runtime/types";

// EXPERIMENT_NODE: 首页分区列顺序——注意力优先（Pinned | Cache warm · your turn | Recent | Running）；也可与左栏面板同序
// （Pinned | Running | Cache warm | Recent），或把 Running 放到 Cache warm 之前。
const BOARD_SCOPE_ALL_PROJECTS_HOME_PAGE_SECTION_COLUMN_ORDER: readonly CrossProjectTaskSwitcherTaskRowSection[] = [
	"pinned",
	"prompt_cache_warm",
	"remaining",
	"running",
];

interface BoardScopeAllProjectsHomePageProps {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	// 当前项目的展开行与主看板同数据、同动作（App 组装，带 overlay）；没有时当前项目的展开行改读服务端。
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId: RuntimeAgentId | null;
}

function BoardScopeAllProjectsHomePageHeader({
	host,
	showsCreateTaskButton,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	showsCreateTaskButton: boolean;
}): ReactElement {
	// 与顶栏项目切换器的 Live / 等你处理两列同一来源（project-switcher-session-activity-counts）。
	const liveAgentTaskCount = host.projects.reduce((total, project) => total + deriveLiveAgentTaskCount(project), 0);
	const awaitingUserTaskCount = host.projects.reduce(
		(total, project) => total + deriveAwaitingUserTaskCount(project),
		0,
	);
	return (
		<header className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-2">
			<div className="flex min-w-0 flex-col">
				<h1 className="m-0 text-lg font-semibold text-text-primary">All projects</h1>
				<span
					className="truncate text-xs text-text-tertiary"
					data-testid="board-scope-all-projects-home-page-summary"
				>
					{`${host.projects.length} ${host.projects.length === 1 ? "project" : "projects"} · ${liveAgentTaskCount} live · ${awaitingUserTaskCount} awaiting you`}
				</span>
			</div>
			{/* Board Scope 建卡：对话框带目标项目字段（Task Creation Target Project），默认上下文项目，不切项目。 */}
			{showsCreateTaskButton && host.onRequestCreateTaskInBoardScope ? (
				<Button
					icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
					aria-label="Create task"
					size="sm"
					className="ml-auto shrink-0"
					onClick={host.onRequestCreateTaskInBoardScope}
				>
					<span className="inline-flex items-center gap-1.5">
						<span>Create task</span>
						<span aria-hidden className="text-text-secondary">
							(c)
						</span>
					</span>
				</Button>
			) : null}
		</header>
	);
}

function BoardScopeAllProjectsHomePageSectionColumns({
	host,
	currentProjectTaskCards,
	defaultAgentId,
}: BoardScopeAllProjectsHomePageProps): ReactElement {
	const sharedSectionRowRendering = useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers({
		host,
		currentProjectTaskCards,
		defaultAgentId,
		sectionBlockPresentation: "section_column_on_board_scope_all_projects_home_page",
	});
	// 没有置顶时连 Pinned 列的包装器一起不挂：包装器（hover 原地展开 hook、还原 scrollTop 的 layout effect）要与
	// 列 DOM 同生命周期，否则置顶从无到有时不还原记住的 scrollTop，置顶清空时 hover 展开状态也留在 hook 里。
	const hasPinnedEntries = sharedSectionRowRendering.sectionsModel.sections.pinnedEntries.length > 0;
	const renderedSectionColumnsInOrder = BOARD_SCOPE_ALL_PROJECTS_HOME_PAGE_SECTION_COLUMN_ORDER.filter(
		(section) => section !== "pinned" || hasPinnedEntries,
	);
	return (
		<div
			className="flex flex-1 min-h-0 min-w-0 flex-col bg-surface-0"
			data-testid="board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board"
		>
			<BoardScopeAllProjectsHomePageHeader host={host} showsCreateTaskButton />
			{/* 列不够宽时整排横向滚动，列本身不压到 260px 以下。 */}
			<div className="flex flex-1 min-h-0 min-w-0 gap-2 overflow-x-auto px-3 pb-3">
				{renderedSectionColumnsInOrder.map((section) => (
					<CrossProjectTaskSwitcherSectionColumnScrollContainerWithOwnRowHoverExpansion
						key={section}
						section={section}
						sharedSectionRowRendering={sharedSectionRowRendering}
					/>
				))}
			</div>
			{sharedSectionRowRendering.pinReasonDialogAndOtherProjectConfirmationDialogs}
		</div>
	);
}

/**
 * All projects（Board Scope）没有聚焦任务时的首页：把 Focus View 左栏跨项目切换面板的分区横排成列，各列独立滚动，
 * 行与 hover 原地展开的完整卡片和左栏同款（docs/context-cross-project-recently-active-task-switcher.md）。
 * 与单项目对称：单项目首页是阶段列看板、Focus View 左栏是阶段竖列表；All projects 首页是分区列看板、
 * Focus View 左栏是同一组分区的竖列表。
 *
 * 移动端放不下多列：直接渲染竖排的切换面板。
 */
export function BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard({
	host,
	currentProjectTaskCards,
	defaultAgentId,
}: BoardScopeAllProjectsHomePageProps): ReactElement {
	const isMobile = useIsMobile();
	if (isMobile) {
		return (
			<div
				className="flex flex-1 min-h-0 min-w-0 flex-col bg-surface-0"
				data-testid="board-scope-all-projects-home-page-stacked-panel-on-mobile"
			>
				{/* 面板顶部自带 Create task，页头不再重复。 */}
				<BoardScopeAllProjectsHomePageHeader host={host} showsCreateTaskButton={false} />
				<CrossProjectRecentlyActiveTaskSwitcherPanel
					host={host}
					currentProjectTaskCards={currentProjectTaskCards}
					defaultAgentId={defaultAgentId}
				/>
			</div>
		);
	}
	return (
		<BoardScopeAllProjectsHomePageSectionColumns
			host={host}
			currentProjectTaskCards={currentProjectTaskCards}
			defaultAgentId={defaultAgentId}
		/>
	);
}
