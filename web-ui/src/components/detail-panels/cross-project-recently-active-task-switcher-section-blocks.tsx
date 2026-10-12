import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherRemainingSectionOrderingMode,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Activity, ChevronDown, ChevronRight, ChevronUp, Flame, History, Pin } from "lucide-react";
import {
	type MutableRefObject,
	type ReactElement,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type UIEvent as ReactUIEvent,
	useState,
} from "react";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type { CrossProjectRecentlyActiveTaskSwitcherSectionsModel } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/**
 * 同一组分区（docs/context-cross-project-recently-active-task-switcher.md）的两种呈现：
 * - stacked_section_in_focus_view_left_column_panel：Focus View 左栏面板里自上而下堆叠，整个面板一个滚动容器。
 *   Pinned 可折叠、默认露 5 条；Running 遵循 localStorage 里的收起偏好。
 * - section_column_on_board_scope_all_projects_home_page：All projects 首页横排成列，每列的内容容器自己滚动。
 *   Pinned 全量显示、不折叠；Running 始终列出行。
 * Cache warm 与 Recent 两种呈现相同。
 */
export type CrossProjectTaskSwitcherSectionBlockPresentation =
	| "stacked_section_in_focus_view_left_column_panel"
	| "section_column_on_board_scope_all_projects_home_page";

/** Pinned 区（堆叠呈现）默认露出的条数；超出部分由区底的按钮展开（同 Focus View 置顶板分段）。 */
const DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_CROSS_PROJECT_TASK_SWITCHER = 5;

const REMAINING_SECTION_ORDERING_MODE_LABELS: Record<CrossProjectTaskSwitcherRemainingSectionOrderingMode, string> = {
	most_recently_touched_by_conversation_progress_or_user_open_or_description_edit: "Last touched",
	unread_handoffs_then_recently_opened_by_user: "Unread + opened",
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
}

// 两种呈现都是「h-9 header + 内容容器，行是内容容器的直接子节点」：行根节点自带的 first:mt-4
// （task-card-body.tsx 的 CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_…）只有在紧挨 header 的
// 第一行是 :first-child 时才把首行往下让，让叠在首行上方的 hover 动作组不伸进 header、截走 header 控件的点击。
// 中间不得再插包装层。
function CrossProjectTaskSwitcherSectionFrame({
	header,
	children,
	testIdSuffix,
	sectionBlockPresentation,
	sectionColumnScrollContainerBinding,
}: {
	header: ReactNode;
	children?: ReactNode;
	testIdSuffix: string;
	sectionBlockPresentation: CrossProjectTaskSwitcherSectionBlockPresentation;
	sectionColumnScrollContainerBinding?: CrossProjectTaskSwitcherSectionColumnScrollContainerBinding;
}): ReactElement {
	if (sectionBlockPresentation === "section_column_on_board_scope_all_projects_home_page") {
		return (
			<section
				className="flex min-h-0 min-w-[260px] flex-1 basis-0 flex-col rounded-lg border border-border bg-surface-1"
				data-testid={`cross-project-task-switcher-section-${testIdSuffix}`}
			>
				{/* 列 header 固定在滚动区之外。 */}
				<div className="flex h-9 shrink-0 items-center gap-2 px-2">{header}</div>
				<div
					ref={sectionColumnScrollContainerBinding?.sectionColumnScrollContainerRef}
					onScroll={sectionColumnScrollContainerBinding?.onSectionColumnScroll}
					onPointerEnter={sectionColumnScrollContainerBinding?.onSectionColumnPointerEnter}
					onPointerLeave={sectionColumnScrollContainerBinding?.onSectionColumnPointerLeave}
					onPointerDownCapture={sectionColumnScrollContainerBinding?.onSectionColumnPointerDownCapture}
					// overflow-anchor: none —— 与 Focus View 左栏面板同理：hover 交接时列表顶边固定，浏览器自带的 scroll
					// anchoring 会在列滚动过时自己补 scrollTop。这个容器的顶边也是 hook 判断「交接是否把新行顶边带出可视区」的基准。
					className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1 pb-1.5 [overflow-anchor:none]"
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
		>
			<div className="flex h-9 shrink-0 items-center gap-2 px-2">{header}</div>
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

/** Pinned 区（可与下面重复）。没有置顶时整区不渲染。 */
export function CrossProjectTaskSwitcherPinnedSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement | null {
	const { sections } = sectionsModel;
	// 「展开全部置顶」跨重挂载保留（Focus View 左栏 ↔ 过渡外壳），见 cross-project-task-switcher-panel-view-continuity-store。
	const [showsAllPinnedEntries, setShowsAllPinnedEntriesState] = useState(
		() => readCrossProjectTaskSwitcherPanelViewContinuity().showsAllPinnedEntries,
	);
	const setShowsAllPinnedEntries = (nextShowsAllPinnedEntries: boolean) => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({ showsAllPinnedEntries: nextShowsAllPinnedEntries });
		setShowsAllPinnedEntriesState(nextShowsAllPinnedEntries);
	};
	const [isPinnedSectionCollapsed, setIsPinnedSectionCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed,
		false,
	);
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
	const visiblePinnedEntries = showsAllPinnedEntries
		? sections.pinnedEntries
		: sections.pinnedEntries.slice(0, DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_CROSS_PROJECT_TASK_SWITCHER);
	const hiddenPinnedEntryCount = sections.pinnedEntries.length - visiblePinnedEntries.length;
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="pinned"
			sectionBlockPresentation={sectionBlockPresentation}
			header={
				<button
					type="button"
					onClick={() => setIsPinnedSectionCollapsed((previous) => !previous)}
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
			{isPinnedSectionCollapsed ? null : (
				<>
					{visiblePinnedEntries.map((entryInProject) =>
						renderRowInHostingScrollContainer(entryInProject, "pinned"),
					)}
					{hiddenPinnedEntryCount > 0 || showsAllPinnedEntries ? (
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
			{isRunningSectionExpanded && sections.runningEntries.length > 0
				? sections.runningEntries.map((entryInProject) =>
						renderRowInHostingScrollContainer(entryInProject, "running"),
					)
				: null}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

/** Cache warm · your turn 区：等用户回话、prompt cache 还热着的任务，按失效时刻升序。 */
export function CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const { sections } = sectionsModel;
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="prompt-cache-warm"
			sectionBlockPresentation={sectionBlockPresentation}
			sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
			header={
				<>
					<Flame size={13} className="shrink-0 text-status-orange" />
					<CrossProjectTaskSwitcherSectionTitle
						title="Cache warm · your turn"
						count={sections.promptCacheWarmAwaitingUserEntries.length}
					/>
				</>
			}
		>
			{sections.promptCacheWarmAwaitingUserEntries.length > 0 ? (
				sections.promptCacheWarmAwaitingUserEntries.map((entryInProject) =>
					renderRowInHostingScrollContainer(entryInProject, "prompt_cache_warm"),
				)
			) : (
				<div className="px-2 py-1.5 text-xs text-text-tertiary">No warm prompt caches waiting on you.</div>
			)}
		</CrossProjectTaskSwitcherSectionFrame>
	);
}

/** Recent（剩余区）：三种排序，可「显示更早」拉回 30 天内的旧任务。 */
export function CrossProjectTaskSwitcherRemainingRecentSectionBlock({
	sectionBlockPresentation,
	sectionsModel,
	renderRowInHostingScrollContainer,
	sectionColumnScrollContainerBinding,
}: CrossProjectTaskSwitcherSectionBlockProps): ReactElement {
	const {
		sections,
		remainingSectionOrderingMode,
		setRemainingSectionOrderingMode,
		extendedActivityHorizonLoadState,
		requestEntriesWithinExtendedActivityHorizon,
	} = sectionsModel;
	const remainingSection = sections.remainingSection;
	const remainingEntryCount =
		remainingSection.orderingMode === "unread_handoffs_then_recently_opened_by_user"
			? remainingSection.unreadHandoffEntries.length + remainingSection.recentlyOpenedByUserEntries.length
			: remainingSection.entries.length;
	return (
		<CrossProjectTaskSwitcherSectionFrame
			testIdSuffix="remaining"
			sectionBlockPresentation={sectionBlockPresentation}
			sectionColumnScrollContainerBinding={sectionColumnScrollContainerBinding}
			header={
				<>
					<History size={13} className="shrink-0 text-text-secondary" />
					<CrossProjectTaskSwitcherSectionTitle title="Recent" count={remainingEntryCount} />
					<NativeSelect
						size="sm"
						aria-label="Order recent tasks by"
						containerClassName="ml-auto min-w-0"
						className="h-6 max-w-[150px] text-[11px]"
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
				</>
			}
		>
			{remainingSection.orderingMode === "unread_handoffs_then_recently_opened_by_user" ? (
				<>
					<div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
						Unread
					</div>
					{remainingSection.unreadHandoffEntries.length > 0 ? (
						remainingSection.unreadHandoffEntries.map((entryInProject) =>
							renderRowInHostingScrollContainer(entryInProject, "remaining"),
						)
					) : (
						<div className="px-2 py-1 text-xs text-text-tertiary">No unread handoffs.</div>
					)}
					<div className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
						Recently opened
					</div>
					{remainingSection.recentlyOpenedByUserEntries.length > 0 ? (
						remainingSection.recentlyOpenedByUserEntries.map((entryInProject) =>
							renderRowInHostingScrollContainer(entryInProject, "remaining"),
						)
					) : (
						<div className="px-2 py-1 text-xs text-text-tertiary">Nothing opened recently.</div>
					)}
				</>
			) : remainingSection.entries.length > 0 ? (
				remainingSection.entries.map((entryInProject) =>
					renderRowInHostingScrollContainer(entryInProject, "remaining"),
				)
			) : (
				<div className="px-2 py-1.5 text-xs text-text-tertiary">No other recent tasks.</div>
			)}
			{extendedActivityHorizonLoadState === "loaded" ? null : (
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
