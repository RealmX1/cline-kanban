import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherRecentTaskStageFilter,
	CrossProjectTaskSwitcherRemainingSectionOrderingMode,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Activity, ChevronDown, ChevronRight, ChevronUp, Flame, History, Pin, UnfoldHorizontal } from "lucide-react";
import type {
	MutableRefObject,
	ReactElement,
	ReactNode,
	PointerEvent as ReactPointerEvent,
	UIEvent as ReactUIEvent,
} from "react";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { CrossProjectTaskSwitcherRecentProjectMultiSelectFilter } from "@/components/detail-panels/cross-project-task-switcher-recent-project-multi-select-filter";
import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type { CrossProjectRecentlyActiveTaskSwitcherSectionsModel } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { collectVisibleCrossProjectTaskSwitcherSectionEntries } from "@/state/cross-project-task-switcher-focus-view-visible-task-rows";

/**
 * 同一组分区（docs/context-cross-project-recently-active-task-switcher.md）的两种呈现：
 * - stacked_section_in_focus_view_left_column_panel：Focus View 左栏面板里自上而下堆叠，整个面板一个滚动容器。
 *   Pinned 可折叠、默认露 5 条；Running 遵循 localStorage 里的收起偏好。
 * - section_column_on_board_scope_all_projects_home_page：All projects 首页横排成列，每列的内容容器自己滚动。
 *   Pinned 全量显示、不折叠；Running 始终列出行。
 * Cache warm 与 Recent 默认展开；两种呈现共用展开态，首页收起时呈现窄列。
 */
export type CrossProjectTaskSwitcherSectionBlockPresentation =
	| "stacked_section_in_focus_view_left_column_panel"
	| "section_column_on_board_scope_all_projects_home_page";

const REMAINING_SECTION_ORDERING_MODE_LABELS: Record<CrossProjectTaskSwitcherRemainingSectionOrderingMode, string> = {
	most_recently_touched_by_conversation_progress_or_user_open_or_description_edit: "Recently touched",
	most_recent_conversation_progress_only: "Conversation progress",
};

/**
 * 首页列呈现时，这一列的滚动容器就是分区的内容容器本身（行是它的直接子节点），由列容器持有 ref、
 * hover 原地展开与滚动位置记忆。堆叠呈现不给：整个面板才是滚动容器。
 */
export interface CrossProjectTaskSwitcherSectionColumnScrollContainerBinding {
	sectionColumnScrollContainerRef: MutableRefObject<HTMLDivElement | null>;
	onSectionColumnScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
	onSectionColumnPointerEnter: () => void;
	onSectionColumnPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
	// 记下沿这一列 React 子树传播的 pointerdown：卡上弹出的 portal 弹窗（DOM 在 body 下）里的按下不算「列外按下」。
	onSectionColumnPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface CrossProjectTaskSwitcherSectionBlockProps {
	sectionBlockPresentation: CrossProjectTaskSwitcherSectionBlockPresentation;
	sectionsModel: CrossProjectRecentlyActiveTaskSwitcherSectionsModel;
	// 已绑定到这一区所在滚动容器的 hover 原地展开（见 use-cross-project-task-switcher-section-row-rendering-shared-across-scroll-containers）。
	renderRowInHostingScrollContainer: (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
	) => ReactElement;
	sectionColumnScrollContainerBinding?: CrossProjectTaskSwitcherSectionColumnScrollContainerBinding;
	/** 只在 Focus View 保留这一定位行，不改变分组数量或持久化展开偏好。 */
	focusedTaskRowToKeepMounted?: { entryKey: string; section: CrossProjectTaskSwitcherTaskRowSection } | null;
}

// 两种呈现都是「h-9 header + 内容容器，行是内容容器的直接子节点」：行根节点自带的 first:mt-4
// （task-card-body.tsx 的 CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_…）只有在紧挨 header 的
// 第一行是 :first-child 时才把首行往下让，让叠在首行上方的 hover 动作组不伸进 header、截走 header 控件的点击。
// 中间不得再插包装层。
function CrossProjectTaskSwitcherSectionFrame({
	header,
	controls,
	children,
	testIdSuffix,
	sectionBlockPresentation,
	sectionColumnScrollContainerBinding,
	isSectionColumnCollapsed = false,
}: {
	header: ReactNode;
	controls?: ReactNode;
	children?: ReactNode;
	testIdSuffix: string;
	sectionBlockPresentation: CrossProjectTaskSwitcherSectionBlockPresentation;
	sectionColumnScrollContainerBinding?: CrossProjectTaskSwitcherSectionColumnScrollContainerBinding;
	isSectionColumnCollapsed?: boolean;
}): ReactElement {
	if (sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page") {
		return (
			<section
				className={cn(
					"flex min-h-0 flex-col rounded-lg border border-border bg-surface-1",
					isSectionColumnCollapsed ? "w-10 shrink-0" : "min-w-[260px] flex-1 basis-0",
				)}
				data-testid={`cross-project-task-switcher-section-${testIdSuffix}`}
				data-verification-anchor={`cross-project-task-switcher-section:${testIdSuffix}`}
			>
				{/* 列 header 固定在滚动区之外。 */}
				<div
					className={cn(
						"flex",
						isSectionColumnCollapsed ? "min-h-0 flex-1" : "h-9 shrink-0 items-center gap-2 px-2",
					)}
				>
					{header}
				</div>
				{controls}
				<div
					ref={sectionColumnScrollContainerBinding?.sectionColumnScrollContainerRef}
					onScroll={sectionColumnScrollContainerBinding?.onSectionColumnScroll}
					onPointerEnter={sectionColumnScrollContainerBinding?.onSectionColumnPointerEnter}
					onPointerLeave={sectionColumnScrollContainerBinding?.onSectionColumnPointerLeave}
					onPointerDownCapture={sectionColumnScrollContainerBinding?.onSectionColumnPointerDownCapture}
					// overflow-anchor: none —— 与 Focus View 左栏同理，异步快照不触发浏览器滚动锚定补偿。
					// 这个容器的可视区也是悬浮卡片定位、向上避让与内部滚动的边界。
					className={cn(
						"flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-1.5 [overflow-anchor:none]",
						isSectionColumnCollapsed && "hidden",
					)}
					data-testid={`cross-project-task-switcher-section-column-scroll-container-${testIdSuffix}`}
				>
					{children}
				</div>
			</section>
		);
	}
	return (
		<section
			className="flex shrink-0 flex-col rounded-lg border border-border bg-surface-1"
			data-testid={`cross-project-task-switcher-section-${testIdSuffix}`}
			data-verification-anchor={`cross-project-task-switcher-section:${testIdSuffix}`}
		>
			<div className="flex h-9 shrink-0 items-center gap-2 px-2">{header}</div>
			{controls}
			{children ? <div className="flex flex-col gap-0.5 px-1 pb-1.5">{children}</div> : null}
		</section>
	);
}

function CrossProjectTaskSwitcherSectionTitle({ title, count }: { title: string; count: number }): ReactElement {
	return (
		<>
			<span className="truncate text-[13px] font-semibold text-text-primary">{title}</span>
			<span className="text-xs text-text-tertiary">{count}</span>
		</>
	);
}

/** 同一展开动作在首页窄列与竖排组头中使用一致的键盘和可访问语义。 */
function CrossProjectTaskSwitcherSectionExpansionButton({
	title,
	count,
	isExpanded,
	setIsExpanded,
	isSectionColumnCollapsed,
}: {
	title: string;
	count: number;
	isExpanded: boolean;
	setIsExpanded: (expanded: boolean) => void;
	isSectionColumnCollapsed: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			onClick={() => setIsExpanded(!isExpanded)}
			aria-expanded={isExpanded}
			aria-label={`${isExpanded ? "Collapse" : "Expand"} ${title}`}
			className={cn(
				"flex min-w-0 flex-1 cursor-pointer border-none bg-transparent text-left text-inherit rounded-md hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
				isSectionColumnCollapsed ? "min-h-0 flex-col items-center gap-2 py-3" : "h-8 items-center gap-2",
			)}
		>
			{isSectionColumnCollapsed ? (
				<>
					<UnfoldHorizontal size={14} aria-hidden className="shrink-0 text-text-secondary" />
					<span className="text-xs text-text-tertiary">{count}</span>
					<span className="text-sm font-semibold text-text-primary whitespace-nowrap [writing-mode:vertical-rl]">
						{title}
					</span>
				</>
			) : (
				<>
					{isExpanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
					<CrossProjectTaskSwitcherSectionTitle title={title} count={count} />
				</>
			)}
		</button>
	);
}

/** Pinned 区（可与下面重复）。没有置顶时整区不渲染。 */
export function CrossProjectTaskSwitcherPinnedSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
	focusedTaskRowToKeepMounted,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement | null {
	const {
		sections,
		showsAllPinnedEntries,
		setShowsAllPinnedEntries,
		isPinnedSectionCollapsed,
		setIsPinnedSectionCollapsed,
	} = sectionsModel;
	if (sections.pinnedEntries.length === 0) {
		return null;
	}
	if (sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page") {
		// 首页一列放得下：全量显示、不折叠，也不读左栏的折叠 / 只露 5 条偏好。
		return (
			<CrossProjectTaskSwitcherSectionFrame
				testIdSuffix="pinned"
				sectionBlockPresentation={sectionBlockPresentation}
				sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
				header={
					<>
						<Pin size={13} className="shrink-0 text-accent" />
						<CrossProjectTaskSwitcherSectionTitle title="Pinned" count={sections.pinnedEntries.length} />
					</>
				}
			>
				{sections.pinnedEntries.map((entryInProject) =>
					renderRowInHostingScrollContainer(entryInProject, "pinned"),
				)}
			</CrossProjectTaskSwitcherSectionFrame>
		);
	}
	const visiblePinnedEntries = collectVisibleCrossProjectTaskSwitcherSectionEntries(
		sections.pinnedEntries,
		"pinned",
		sectionsModel,
		focusedTaskRowToKeepMounted,
		true,
	);
	const hiddenPinnedEntryCount = sections.pinnedEntries.length - visiblePinnedEntries.length;
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="pinned"
			sectionBlockPresentation={sectionBlockPresentation}
			header={
				<button
					type="button"
					onClick={() => setIsPinnedSectionCollapsed(!isPinnedSectionCollapsed)}
					aria-expanded={!isPinnedSectionCollapsed}
					className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none bg-transparent text-left text-inherit"
				>
					{isPinnedSectionCollapsed ? (
						<ChevronRight size={14} className="shrink-0 text-text-secondary" />
					) : (
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					)}
					<Pin size={13} className="shrink-0 text-accent" />
					<CrossProjectTaskSwitcherSectionTitle title="Pinned" count={sections.pinnedEntries.length} />
				</button>
			}
		>
			{visiblePinnedEntries.length === 0 ? null : (
				<>
					{visiblePinnedEntries.map((entryInProject) =>
						renderRowInHostingScrollContainer(entryInProject, "pinned"),
					)}
					{!isPinnedSectionCollapsed && (hiddenPinnedEntryCount > 0 || showsAllPinnedEntries) ? (
						<button
							type="button"
							onClick={() => setShowsAllPinnedEntries(!showsAllPinnedEntries)}
							className="flex cursor-pointer items-center justify-center gap-1 rounded-md border-none bg-transparent py-1 text-xs text-text-tertiary hover:bg-surface-3 hover:text-text-secondary"
						>
							{showsAllPinnedEntries ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
							{showsAllPinnedEntries ? "Show less" : `Show ${hiddenPinnedEntryCount} more`}
						</button>
					) : null}
				</>
			)}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

/** Running 区：agent 正持有回合的任务。堆叠呈现默认收起，首页列始终列出。 */
export function CrossProjectTaskSwitcherRunningSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
	focusedTaskRowToKeepMounted,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const { sections, isRunningSectionExpanded, setIsRunningSectionExpanded } = sectionsModel;
	if (sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page") {
		return (
			<CrossProjectTaskSwitcherSectionFrame
				testIdSuffix="running"
				sectionBlockPresentation={sectionBlockPresentation}
				sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
				header={
					<>
						<Activity size={13} className="shrink-0 text-status-blue" />
						<CrossProjectTaskSwitcherSectionTitle title="Running" count={sections.runningEntries.length} />
					</>
				}
			>
				{sections.runningEntries.length > 0 ? (
					sections.runningEntries.map((entryInProject) =>
						renderRowInHostingScrollContainer(entryInProject, "running"),
					)
				) : (
					<div className="px-2 py-1.5 text-xs text-text-tertiary">No agents running.</div>
				)}
			</CrossProjectTaskSwitcherSectionFrame>
		);
	}
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="running"
			sectionBlockPresentation={sectionBlockPresentation}
			header={
				<button
					type="button"
					onClick={() => setIsRunningSectionExpanded(!isRunningSectionExpanded)}
					aria-expanded={isRunningSectionExpanded}
					disabled={sections.runningEntries.length === 0}
					className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none bg-transparent text-left text-inherit disabled:cursor-default"
				>
					{isRunningSectionExpanded ? (
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					) : (
						<ChevronRight size={14} className="shrink-0 text-text-secondary" />
					)}
					<CrossProjectTaskSwitcherSectionTitle title="Running" count={sections.runningEntries.length} />
				</button>
			}
		>
			{collectVisibleCrossProjectTaskSwitcherSectionEntries(
				sections.runningEntries,
				"running",
				sectionsModel,
				focusedTaskRowToKeepMounted,
				true,
			).map((entryInProject) => renderRowInHostingScrollContainer(entryInProject, "running"))}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

/** Cache warm · your turn 区：按失效时刻升序，支持独立展开与收起。 */
export function CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
	focusedTaskRowToKeepMounted,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const { sections, isPromptCacheWarmSectionExpanded, setIsPromptCacheWarmSectionExpanded } = sectionsModel;
	const isSectionColumnCollapsed =
		sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page" &&
		!isPromptCacheWarmSectionExpanded;
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="prompt-cache-warm"
			sectionBlockPresentation={sectionBlockPresentation}
			sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
			isSectionColumnCollapsed={isSectionColumnCollapsed}
			header={
				<>
					{!isSectionColumnCollapsed ? (
						<Flame size={13} aria-hidden className="shrink-0 text-status-orange" />
					) : null}
					<CrossProjectTaskSwitcherSectionExpansionButton
						title="Cache warm · your turn"
						count={sections.promptCacheWarmAwaitingUserEntries.length}
						isExpanded={isPromptCacheWarmSectionExpanded}
						setIsExpanded={setIsPromptCacheWarmSectionExpanded}
						isSectionColumnCollapsed={isSectionColumnCollapsed}
					/>
				</>
			}
		>
			{isPromptCacheWarmSectionExpanded && sections.promptCacheWarmAwaitingUserEntries.length === 0 ? (
				<div className="px-2 py-1.5 text-xs text-text-tertiary">No warm prompt caches waiting on you.</div>
			) : (
				collectVisibleCrossProjectTaskSwitcherSectionEntries(
					sections.promptCacheWarmAwaitingUserEntries,
					"prompt_cache_warm",
					sectionsModel,
					focusedTaskRowToKeepMounted,
					sectionBlockPresentation === "stacked_section_in_focus_view_left_column_panel",
				).map((entryInProject) => renderRowInHostingScrollContainer(entryInProject, "prompt_cache_warm"))
			)}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

const RECENT_TASK_STAGE_FILTER_LABELS: Record<CrossProjectTaskSwitcherRecentTaskStageFilter, string> = {
	in_progress_and_review: "In progress / Review",
	backlog: "Backlog",
	validation: "Validation",
	done: "Done",
};

/** Recent：阶段筛选取并集，排序不改变候选集合，可按需扩展到 30 天。 */
export function CrossProjectTaskSwitcherRemainingRecentSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
	focusedTaskRowToKeepMounted,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const {
		sections,
		remainingSectionOrderingMode,
		setRemainingSectionOrderingMode,
		isRecentSectionExpanded,
		setIsRecentSectionExpanded,
		selectedRecentTaskStageFilters,
		setSelectedRecentTaskStageFilters,
		showsOnlyRecentTasksWithWorktreeChanges,
		setShowsOnlyRecentTasksWithWorktreeChanges,
		recentTaskWorktreeChangesFilterPendingCount,
		recentTaskWorktreeChangesFilterUnavailableCount,
		extendedActivityHorizonLoadState,
		requestEntriesWithinExtendedActivityHorizon,
	} = sectionsModel;
	const entries = sections.remainingSection.entries;
	const isSectionColumnCollapsed =
		sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page" && !isRecentSectionExpanded;
	const filterButtonClassName = (isSelected: boolean) =>
		cn(
			"cursor-pointer rounded-md border px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-accent",
			isSelected
				? "border-accent bg-accent/15 text-text-primary"
				: "border-border bg-surface-2 text-text-secondary hover:bg-surface-3",
		);
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="remaining"
			sectionBlockPresentation={sectionBlockPresentation}
			sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
			isSectionColumnCollapsed={isSectionColumnCollapsed}
			header={
				<>
					{!isSectionColumnCollapsed ? (
						<History size={13} aria-hidden className="shrink-0 text-text-secondary" />
					) : null}
					<CrossProjectTaskSwitcherSectionExpansionButton
						title="Recent"
						count={entries.length}
						isExpanded={isRecentSectionExpanded}
						setIsExpanded={setIsRecentSectionExpanded}
						isSectionColumnCollapsed={isSectionColumnCollapsed}
					/>
				</>
			}
			controls={
				isRecentSectionExpanded ? (
					<div className="flex shrink-0 flex-col gap-2 border-b border-border px-2 pb-2">
						<div className="flex flex-wrap items-center gap-2">
							<NativeSelect
								size="sm"
								aria-label="Order recent tasks by"
								title={
									remainingSectionOrderingMode === "most_recent_conversation_progress_only"
										? "按对话进展倒序；无对话记录的任务排在末尾，并按 Description 更新时间倒序。"
										: "按对话进展、最近打开或 Description 更新时间中的最新时间倒序。"
								}
								containerClassName="min-w-0"
								value={remainingSectionOrderingMode}
								onChange={(event) =>
									setRemainingSectionOrderingMode(
										event.target.value as CrossProjectTaskSwitcherRemainingSectionOrderingMode,
									)
								}
							>
								{Object.entries(REMAINING_SECTION_ORDERING_MODE_LABELS).map(([mode, label]) => (
									<option key={mode} value={mode}>
										{label}
									</option>
								))}
							</NativeSelect>
							<CrossProjectTaskSwitcherRecentProjectMultiSelectFilter
								projectOptions={sectionsModel.recentProjectFilterOptions}
								selectedProjectWorkspaceIds={sectionsModel.selectedRecentProjectWorkspaceIds}
								onSelectedProjectWorkspaceIdsChange={sectionsModel.setSelectedRecentProjectWorkspaceIds}
							/>
						</div>
						<div role="group" aria-label="Filter recent tasks by stage" className="flex flex-wrap gap-1">
							<button
								type="button"
								aria-pressed={selectedRecentTaskStageFilters.length === 0}
								onClick={() => setSelectedRecentTaskStageFilters([])}
								className={filterButtonClassName(selectedRecentTaskStageFilters.length === 0)}
							>
								All
							</button>
							{Object.entries(RECENT_TASK_STAGE_FILTER_LABELS).map(([filter, label]) => {
								const stageFilter = filter as CrossProjectTaskSwitcherRecentTaskStageFilter;
								const isSelected = selectedRecentTaskStageFilters.includes(stageFilter);
								return (
									<button
										key={stageFilter}
										type="button"
										aria-pressed={isSelected}
										onClick={() =>
											setSelectedRecentTaskStageFilters(
												isSelected
													? selectedRecentTaskStageFilters.filter(
															(selectedFilter) => selectedFilter !== stageFilter,
														)
													: [...selectedRecentTaskStageFilters, stageFilter],
											)
										}
										className={filterButtonClassName(isSelected)}
									>
										{label}
									</button>
								);
							})}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								aria-pressed={showsOnlyRecentTasksWithWorktreeChanges}
								title="仅显示工作树有未提交改动，或相对任务本地 base 有独有提交的任务；任一条件成立即可。"
								onClick={() =>
									setShowsOnlyRecentTasksWithWorktreeChanges(!showsOnlyRecentTasksWithWorktreeChanges)
								}
								className={filterButtonClassName(showsOnlyRecentTasksWithWorktreeChanges)}
							>
								未提交改动 / 独有提交
							</button>
							{showsOnlyRecentTasksWithWorktreeChanges &&
							(recentTaskWorktreeChangesFilterPendingCount > 0 ||
								recentTaskWorktreeChangesFilterUnavailableCount > 0) ? (
								<span role="status" className="text-xs text-text-secondary">
									{recentTaskWorktreeChangesFilterPendingCount > 0
										? `正在检查 ${recentTaskWorktreeChangesFilterPendingCount} 个任务的工作树状态。`
										: null}
									{recentTaskWorktreeChangesFilterUnavailableCount > 0
										? `${recentTaskWorktreeChangesFilterUnavailableCount} 个任务的工作树状态暂不可用，将自动重试。`
										: null}
								</span>
							) : null}
						</div>
					</div>
				) : null
			}
		>
			{isRecentSectionExpanded &&
			entries.length === 0 &&
			recentTaskWorktreeChangesFilterPendingCount === 0 &&
			recentTaskWorktreeChangesFilterUnavailableCount === 0 ? (
				<div className="px-2 py-1.5 text-xs text-text-tertiary">No recent tasks match these filters.</div>
			) : (
				collectVisibleCrossProjectTaskSwitcherSectionEntries(
					entries,
					"remaining",
					sectionsModel,
					focusedTaskRowToKeepMounted,
					sectionBlockPresentation === "stacked_section_in_focus_view_left_column_panel",
				).map((entryInProject) => renderRowInHostingScrollContainer(entryInProject, "remaining"))
			)}
			{!isRecentSectionExpanded || extendedActivityHorizonLoadState === "loaded" ? null : (
				<button
					type="button"
					onClick={requestEntriesWithinExtendedActivityHorizon}
					disabled={extendedActivityHorizonLoadState === "loading"}
					className="mt-1 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border-none bg-transparent py-1 text-xs text-text-tertiary hover:bg-surface-3 hover:text-text-secondary disabled:cursor-default"
				>
					{extendedActivityHorizonLoadState === "loading" ? <Spinner size={12} /> : null}
					{extendedActivityHorizonLoadState === "failed"
						? "Could not load older tasks · Retry"
						: "Show older (last 30 days)"}
				</button>
			)}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

/** 搁置优先于其他归属，默认收起；定位到该组时仍保留唯一焦点卡。 */
export function CrossProjectTaskSwitcherShelvedSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
	focusedTaskRowToKeepMounted,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const { sections, isShelvedSectionExpanded, setIsShelvedSectionExpanded } = sectionsModel;
	const isSectionColumnCollapsed =
		sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page" && !isShelvedSectionExpanded;
	const entries = collectVisibleCrossProjectTaskSwitcherSectionEntries(
		sections.shelvedEntries,
		"shelved",
		sectionsModel,
		focusedTaskRowToKeepMounted,
		true,
	);
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="shelved"
			sectionBlockPresentation={sectionBlockPresentation}
			sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
			isSectionColumnCollapsed={isSectionColumnCollapsed}
			header={
				<CrossProjectTaskSwitcherSectionExpansionButton
					title="Shelved"
					count={sections.shelvedEntries.length}
					isExpanded={isShelvedSectionExpanded}
					setIsExpanded={setIsShelvedSectionExpanded}
					isSectionColumnCollapsed={isSectionColumnCollapsed}
				/>
			}
		>
			{entries.map((entryInProject) => renderRowInHostingScrollContainer(entryInProject, "shelved"))}
			{isShelvedSectionExpanded && entries.length === 0 ? (
				<div className="px-2 py-1.5 text-xs text-text-secondary">没有搁置任务。</div>
			) : null}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}
