import * as RadixPopover from "@radix-ui/react-popover";
import { Plus } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProjectSwitcherColumnVisibilityMenu } from "@/components/top-bar-project-switcher/project-switcher-column-visibility-menu";
import {
	buildProjectSwitcherRows,
	DEFAULT_PROJECT_SWITCHER_TABLE_SORT_ORDER,
	filterProjectSwitcherRowsByQuery,
	normalizeProjectSwitcherTableSortOrder,
	type ProjectSwitcherTableSortOrder,
	resolveInitialActiveProjectSwitcherRowIndex,
} from "@/components/top-bar-project-switcher/project-switcher-row-ordering";
import { deriveLiveAgentTaskCount } from "@/components/top-bar-project-switcher/project-switcher-session-activity-counts";
import { ProjectSwitcherTable } from "@/components/top-bar-project-switcher/project-switcher-table";
import {
	DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY,
	normalizeProjectSwitcherTableColumnVisibility,
	type ProjectSwitcherTableColumnId,
} from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";
import { ProjectSwitcherTriggerButton } from "@/components/top-bar-project-switcher/project-switcher-trigger-button";
import { cn } from "@/components/ui/cn";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";
import type { RecentlyUsedProjectSwitchHistory } from "@/hooks/use-recently-used-project-switch-history";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useInterval, useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

/** 项目多到扫视成本高于打字成本时才出现过滤框；少量项目下它只是多一次焦点跳转。 */
const PROJECT_COUNT_THRESHOLD_FOR_FILTER_INPUT = 8;

const LAST_VISITED_RELATIVE_TIME_REFRESH_INTERVAL_MS = 30_000;

/**
 * TopBar 只接这一个可选的 typed 对象，而不是十来个平铺 prop —— 既让 top-bar.tsx 的改动收敛成
 * 「一个 prop + 一段 JSX」，也让既有的 top-bar 测试用例零改动。
 */
export interface TopBarProjectSwitcherState {
	projects: readonly RuntimeProjectSummary[];
	currentProjectId: string | null;
	/** 乐观的「目标项目」：点击后立刻前移，让 trigger 不等运行时确认就显示新项目名。 */
	navigationCurrentProjectId: string | null;
	lastVisitedEpochMsByProjectId: RecentlyUsedProjectSwitchHistory;
	numericSlotGroupNumberByProjectId: ReadonlyMap<string, ProjectNumericSlotGroupNumber>;
	isProjectListLoading: boolean;
	isProjectSwitching: boolean;
	onSelectProject: (projectId: string) => void;
	onAddProject: () => void;
	onAssignProjectToNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber, projectId: string) => void;
	onClearNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber) => void;
}

export function TopBarProjectSwitcher({
	projects,
	currentProjectId,
	navigationCurrentProjectId,
	lastVisitedEpochMsByProjectId,
	numericSlotGroupNumberByProjectId,
	isProjectListLoading,
	isProjectSwitching,
	onSelectProject,
	onAddProject,
	onAssignProjectToNumericSlotGroupNumber,
	onClearNumericSlotGroupNumber,
}: TopBarProjectSwitcherState): React.ReactElement | null {
	const isMobile = useIsMobile();
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeRowIndex, setActiveRowIndex] = useState(0);
	const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
	const contentRef = useRef<HTMLDivElement | null>(null);
	const filterInputRef = useRef<HTMLInputElement | null>(null);

	const [storedSortOrder, setStoredSortOrder] = useRawLocalStorageValue<ProjectSwitcherTableSortOrder>(
		LocalStorageKey.ProjectSwitcherTableSortOrder,
		DEFAULT_PROJECT_SWITCHER_TABLE_SORT_ORDER,
		normalizeProjectSwitcherTableSortOrder,
	);
	const [storedColumnVisibility, setStoredColumnVisibility] = useJsonLocalStorageValue(
		LocalStorageKey.ProjectSwitcherTableColumnVisibility,
		DEFAULT_PROJECT_SWITCHER_TABLE_COLUMN_VISIBILITY,
	);
	const columnVisibility = useMemo(
		() => normalizeProjectSwitcherTableColumnVisibility(storedColumnVisibility),
		[storedColumnVisibility],
	);

	const orderedRows = useMemo(
		() =>
			buildProjectSwitcherRows({
				projects,
				lastVisitedEpochMsByProjectId,
				numericSlotGroupNumberByProjectId,
				sortOrder: storedSortOrder,
			}),
		[lastVisitedEpochMsByProjectId, numericSlotGroupNumberByProjectId, projects, storedSortOrder],
	);
	const visibleRows = useMemo(() => filterProjectSwitcherRowsByQuery(orderedRows, query), [orderedRows, query]);

	const projectNameByNumericSlotGroupNumber = useMemo(() => {
		const byNumericSlotGroupNumber = new Map<ProjectNumericSlotGroupNumber, string>();
		for (const project of projects) {
			const slotNumber = numericSlotGroupNumberByProjectId.get(project.id);
			if (slotNumber !== undefined) {
				byNumericSlotGroupNumber.set(slotNumber, project.name);
			}
		}
		return byNumericSlotGroupNumber;
	}, [numericSlotGroupNumberByProjectId, projects]);

	const navigationCurrentProject =
		projects.find((project) => project.id === navigationCurrentProjectId) ??
		projects.find((project) => project.id === currentProjectId) ??
		null;

	const handleOpenChange = useCallback((nextOpen: boolean) => {
		setIsOpen(nextOpen);
		setQuery("");
		if (nextOpen) {
			setNowEpochMs(Date.now());
		}
	}, []);

	// 打开时把高亮落在第一个非当前项目上，于是「打开 + Enter」= 跳回上一个项目（alt-tab 语义）。
	useEffect(() => {
		if (!isOpen) {
			return;
		}
		setActiveRowIndex(resolveInitialActiveProjectSwitcherRowIndex(orderedRows, currentProjectId));
		// 只在打开的那一刻定位，之后由键鼠接管；orderedRows 的后续推送不该把高亮拽回去。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen]);

	// 过滤结果变短后把高亮夹回合法区间。
	useEffect(() => {
		setActiveRowIndex((currentIndex) => {
			if (visibleRows.length === 0) {
				return 0;
			}
			return Math.min(currentIndex, visibleRows.length - 1);
		});
	}, [visibleRows.length]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		const activeRowElement = contentRef.current?.querySelector<HTMLElement>(
			'[data-testid="project-switcher-table-row"][aria-current="true"]',
		);
		activeRowElement?.scrollIntoView({ block: "nearest" });
	}, [activeRowIndex, isOpen, visibleRows]);

	useInterval(() => setNowEpochMs(Date.now()), isOpen ? LAST_VISITED_RELATIVE_TIME_REFRESH_INTERVAL_MS : null);

	const handleSelectProjectAndClose = useCallback(
		(projectId: string) => {
			handleOpenChange(false);
			if (projectId === currentProjectId) {
				return;
			}
			onSelectProject(projectId);
		},
		[currentProjectId, handleOpenChange, onSelectProject],
	);

	// 分支与 search-select-dropdown 的 handleSearchInputKeyDown 保持一致，避免两处键盘行为分叉。
	const handleNavigationKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (visibleRows.length === 0) {
				if (event.key === "Escape") {
					event.preventDefault();
					handleOpenChange(false);
				}
				return;
			}

			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveRowIndex((currentIndex) => Math.min(currentIndex + 1, visibleRows.length - 1));
				return;
			}

			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveRowIndex((currentIndex) => Math.max(currentIndex - 1, 0));
				return;
			}

			if (event.key === "Home") {
				event.preventDefault();
				setActiveRowIndex(0);
				return;
			}

			if (event.key === "End") {
				event.preventDefault();
				setActiveRowIndex(visibleRows.length - 1);
				return;
			}

			if (event.key === "Enter") {
				event.preventDefault();
				const row = visibleRows[activeRowIndex];
				if (!row) {
					return;
				}
				handleSelectProjectAndClose(row.project.id);
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				handleOpenChange(false);
			}
		},
		[activeRowIndex, handleOpenChange, handleSelectProjectAndClose, visibleRows],
	);

	const handleToggleColumnVisibility = useCallback(
		(columnId: ProjectSwitcherTableColumnId, isVisible: boolean) => {
			setStoredColumnVisibility({ ...columnVisibility, [columnId]: isVisible });
		},
		[columnVisibility, setStoredColumnVisibility],
	);

	if (projects.length === 0 && !isProjectListLoading) {
		return null;
	}

	const shouldShowFilterInput = projects.length >= PROJECT_COUNT_THRESHOLD_FOR_FILTER_INPUT;

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpenChange}>
			<RadixPopover.Trigger asChild>
				<ProjectSwitcherTriggerButton
					projectName={navigationCurrentProject?.name ?? null}
					liveAgentTaskCount={navigationCurrentProject ? deriveLiveAgentTaskCount(navigationCurrentProject) : 0}
					isProjectUnavailable={navigationCurrentProject?.availability.status === "unavailable"}
					isProjectSwitching={isProjectSwitching}
					isMobile={isMobile}
					isOpen={isOpen}
					disabled={isProjectListLoading}
					title={navigationCurrentProject?.path ?? undefined}
				/>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					ref={contentRef}
					className="z-50 flex max-h-[min(480px,70svh)] w-[min(720px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl outline-none"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					align="start"
					sideOffset={5}
					collisionPadding={8}
					onKeyDown={handleNavigationKeyDown}
					onOpenAutoFocus={(event) => {
						// Radix 默认把焦点丢到第一个可聚焦子元素（会是过滤框或第一行的槽位按钮）；
						// 我们自己决定焦点归属，键盘导航才好使。
						//
						// 刻意同步 focus、不套 requestAnimationFrame：延后一帧的话，如果这期间用户已经点开了
						// 行内的槽位选择器（嵌套 popover），这次迟到的 focus 就落在它外面，会把刚打开的选择器
						// 当作「焦点移出」立刻关掉。
						event.preventDefault();
						if (shouldShowFilterInput && !isMobile) {
							filterInputRef.current?.focus();
							return;
						}
						contentRef.current?.focus();
					}}
					tabIndex={-1}
					data-testid="top-bar-project-switcher-panel"
				>
					<div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
						{shouldShowFilterInput ? (
							<input
								ref={filterInputRef}
								className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
								placeholder="Filter projects..."
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								data-testid="project-switcher-filter-input"
							/>
						) : (
							<span className="flex-1 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
								Switch project
							</span>
						)}
						<div
							className="inline-flex shrink-0 items-center rounded-md border border-border bg-surface-1 p-0.5"
							role="group"
							aria-label="Sort projects"
						>
							{(
								[
									{ sortOrder: "last_visited_desc", label: "Recent" },
									{ sortOrder: "name_asc", label: "A–Z" },
								] as const
							).map((option) => (
								<button
									key={option.sortOrder}
									type="button"
									className={cn(
										"rounded px-2 py-0.5 text-[11px] font-medium",
										storedSortOrder === option.sortOrder
											? "bg-surface-3 text-text-primary"
											: "text-text-secondary hover:text-text-primary",
									)}
									aria-pressed={storedSortOrder === option.sortOrder}
									data-testid={`project-switcher-sort-order-${option.sortOrder}`}
									onClick={() => setStoredSortOrder(option.sortOrder)}
								>
									{option.label}
								</button>
							))}
						</div>
						<ProjectSwitcherColumnVisibilityMenu
							columnVisibility={columnVisibility}
							onToggleColumnVisibility={handleToggleColumnVisibility}
						/>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1">
						<ProjectSwitcherTable
							rows={visibleRows}
							currentProjectId={currentProjectId}
							activeRowIndex={activeRowIndex}
							columnVisibility={columnVisibility}
							nowEpochMs={nowEpochMs}
							projectNameByNumericSlotGroupNumber={projectNameByNumericSlotGroupNumber}
							onSelectProject={handleSelectProjectAndClose}
							onActiveRowIndexChange={setActiveRowIndex}
							onAssignProjectToNumericSlotGroupNumber={onAssignProjectToNumericSlotGroupNumber}
							onClearNumericSlotGroupNumber={onClearNumericSlotGroupNumber}
						/>
					</div>

					<div className="shrink-0 border-t border-border p-1">
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
							data-testid="project-switcher-add-project"
							onClick={() => {
								handleOpenChange(false);
								onAddProject();
							}}
						>
							<Plus size={14} />
							Add project
						</button>
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
