import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import {
	resolveTaskSpotlightSearchResultRowTimePillKind,
	TaskSpotlightSearchResultRow,
} from "@/components/task-spotlight-search-result-row";
import { TaskSpotlightSearchResultRowFieldVisibilityMenu } from "@/components/task-spotlight-search-result-row-field-visibility-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { TaskSpotlightSearchController } from "@/hooks/use-task-spotlight-search-controller";
import type { TaskBoardSearchMode } from "@/search/task-board-search";
import { TASK_SEARCH_RESULT_SORT_ORDER_OPTIONS } from "@/search/task-search-result-ordering";
import type { TaskBoardSemanticSearchStatus } from "@/search/use-task-board-search";
import { TaskFilterControls } from "@/task-filtering/task-filter-controls";

const SEARCH_MODE_OPTIONS: ReadonlyArray<{ mode: TaskBoardSearchMode; label: string }> = [
	{ mode: "direct", label: "Direct" },
	{ mode: "fuzzy", label: "Fuzzy" },
	{ mode: "semantic", label: "Semantic" },
	{ mode: "hybrid", label: "Hybrid" },
];

const SESSION_ACTIVITY_DIMENSION_HINT = "Only known for the current project — tasks from other projects are excluded";

/**
 * 空结果时的说明文案。两种「其实有东西、只是被你自己的条件挡住了」必须点破原因——否则用户拷了个
 * task id（或敲了它的片段）却看到 "No matching tasks"，会以为任务根本不存在（过滤刻意不为 ID 命中豁免）。
 */
function resolveEmptyResultsMessage({
	isBrowsingAllTasksWithoutQuery,
	semanticSearchStatus,
	taskIdMatchedResultCountHiddenByFilters,
	resultCountExcludedBecauseSessionActivityIsNotObservable,
}: {
	isBrowsingAllTasksWithoutQuery: boolean;
	semanticSearchStatus: TaskBoardSemanticSearchStatus;
	taskIdMatchedResultCountHiddenByFilters: number;
	resultCountExcludedBecauseSessionActivityIsNotObservable: number;
}): string {
	if (taskIdMatchedResultCountHiddenByFilters > 0) {
		return "Task ID matched, but the task is filtered out";
	}
	if (resultCountExcludedBecauseSessionActivityIsNotObservable > 0) {
		return "Tasks from other projects were excluded: their session state is only known for the current project";
	}
	if (semanticSearchStatus === "loading") {
		return "Searching…";
	}
	if (isBrowsingAllTasksWithoutQuery) {
		// 空查询下说 "No matching tasks" 是句不知所云的话——用户根本没输入任何要匹配的东西。
		return "No tasks match the current filters";
	}
	return "No matching tasks";
}

export function TaskSpotlightSearchDialog({
	controller,
}: {
	controller: TaskSpotlightSearchController;
}): React.ReactElement {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle | null>(null);
	const isMobile = useIsMobile();
	const {
		isOpen,
		close,
		query,
		setQuery,
		mode,
		setMode,
		sortOrder,
		setSortOrder,
		effectiveSortOrder,
		filterSelection,
		setFilterSelection,
		availableFilterValues,
		fieldVisibility,
		toggleFieldVisibility,
		includeOtherProjects,
		setIncludeOtherProjects,
		crossProjectStatus,
		isSearchActive,
		isBrowsingAllTasksWithoutQuery,
		semanticSearchStatus,
		results,
		taskIdMatchedResultCountHiddenByFilters,
		resultCountExcludedBecauseSessionActivityIsNotObservable,
		resolveResultRowDisplayContext,
		nowEpochMs,
		activeIndex,
		setActiveIndex,
		moveActive,
		openActiveResult,
		openResultAt,
		currentProjectId,
	} = controller;

	const showSemanticSpinner = semanticSearchStatus === "loading" && (mode === "hybrid" || mode === "semantic");
	const timePillKind = resolveTaskSpotlightSearchResultRowTimePillKind(effectiveSortOrder);

	useEffect(() => {
		if (!isOpen || activeIndex < 0) {
			return;
		}
		virtuosoRef.current?.scrollIntoView({ index: activeIndex });
	}, [isOpen, activeIndex]);

	const focusInput = () => {
		window.requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
	};

	const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			openActiveResult();
		}
	};

	return (
		<RadixDialog.Root
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
		>
			<RadixDialog.Portal>
				<RadixDialog.Overlay
					// touch-none：mobile 全屏化后背后的看板仍在文档流里，不阻断触摸会出现「滑弹层实际滚了看板」。
					className="fixed inset-0 z-50 touch-none bg-black/60"
					style={{ animation: "kb-overlay-show 150ms ease" }}
				/>
				<RadixDialog.Content
					data-task-spotlight-search-dialog=""
					aria-describedby={undefined}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						inputRef.current?.focus();
					}}
					// mobile 全屏化：窄屏上 92vw × 70vh 的浮层留给结果列表的高度太少，而 mobile 恰恰是 Spotlight
					// 最需要「跳到另一个任务」的场景。刻意不复用 `kb-dialog-content`——它的基础规则是
					// translate(-50%,-50%)，会顶掉这里的顶部对齐定位，且它的 mobile 形态是 inset:8px 而非全屏。
					// 高度用 100svh 与 App 外壳一致，避免浏览器工具栏收放时弹层跟着跳。
					className={cn(
						"fixed z-50 flex flex-col overflow-hidden bg-surface-1 shadow-2xl focus:outline-none",
						isMobile
							? "inset-x-0 top-0 h-[100svh] w-full"
							: "left-1/2 top-[12vh] h-[min(70vh,640px)] w-[92vw] max-w-2xl -translate-x-1/2 rounded-xl border border-border-bright",
					)}
				>
					<RadixDialog.Title className="sr-only">Search tasks</RadixDialog.Title>

					<div
						className={cn("flex items-center gap-2 border-b border-border px-3.5", isMobile ? "py-1.5" : "py-3")}
					>
						<Search size={16} className="pointer-events-none shrink-0 text-text-tertiary" />
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							onKeyDown={handleInputKeyDown}
							placeholder="Search tasks"
							aria-label="Search tasks"
							// mobile 必须 ≥16px：iOS Safari 聚焦小于 16px 的输入框会把整页放大，且失焦后不缩回。
							className={cn(
								"min-w-0 flex-1 bg-transparent text-text-primary placeholder:text-text-tertiary focus:outline-none",
								isMobile ? "text-base" : "text-[15px]",
							)}
						/>
						{showSemanticSpinner ? <Spinner size={14} /> : null}
						{/* 浏览态也报数：那正是「现在列出的是全部 N 个任务」这句话本身。 */}
						{isSearchActive || isBrowsingAllTasksWithoutQuery ? (
							<span className="shrink-0 text-xs text-text-tertiary">{results.length}</span>
						) : null}
						{/* 全屏化后弹层四周没有可点的 overlay，mobile 又没有 Esc——这个按钮是唯一的关闭路径，不可删。 */}
						{isMobile ? (
							<Button
								variant="ghost"
								size="sm"
								icon={<X size={18} />}
								onClick={close}
								aria-label="Close search"
								className={cn("shrink-0", MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
							/>
						) : null}
					</div>

					{/* mobile 上工具栏一行放不下，改横滑而不是折行——折行会吃掉本已紧张的结果列表高度。 */}
					<div
						className={cn(
							"flex items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-2",
							isMobile ? "flex-nowrap overflow-x-auto overscroll-x-contain" : "flex-wrap",
						)}
					>
						<TaskFilterControls
							selection={filterSelection}
							availableValues={availableFilterValues}
							onChange={setFilterSelection}
							shouldUseMobileMinimumTouchTarget={isMobile}
							isSessionActivityDimensionSupported
							sessionActivityDimensionHint={SESSION_ACTIVITY_DIMENSION_HINT}
							onInteractionComplete={focusInput}
						/>

						<div
							className={cn(
								"inline-flex shrink-0 items-center rounded-md border border-border bg-surface-1 p-0.5",
								!isMobile && "h-6",
							)}
							role="group"
							aria-label="Sort results"
						>
							{TASK_SEARCH_RESULT_SORT_ORDER_OPTIONS.map((option) => (
								<button
									key={option.sortOrder}
									type="button"
									aria-pressed={option.sortOrder === sortOrder}
									title={option.description}
									onClick={() => {
										setSortOrder(option.sortOrder);
										focusInput();
									}}
									className={cn(
										"shrink-0 rounded-sm px-2 text-[11px] font-medium text-text-secondary hover:text-text-primary",
										isMobile ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "h-5",
										option.sortOrder === sortOrder && "bg-surface-4 text-text-primary",
										// 用户选的是 relevance、但浏览态下真正生效的是另一档：把生效那档也标出来，
										// 否则「我明明选了 Relevance，为什么顺序是按时间的」无从解释。
										option.sortOrder !== sortOrder &&
											option.sortOrder === effectiveSortOrder &&
											"text-text-primary underline decoration-dotted underline-offset-2",
									)}
								>
									{option.label}
								</button>
							))}
						</div>

						<label
							htmlFor="task-spotlight-include-other-projects"
							className={cn(
								"flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-text-secondary",
								// mobile 下与同一行的其它控件共用 44px 触控下限——label 整体是可点区域，
								// min-h/min-w 只撑大命中盒，不影响里面 switch 的视觉尺寸。
								// desktop 则维持 ml-auto 右对齐；横滑容器里 auto margin 会把后续内容推出可视区，只在换行布局下用。
								isMobile ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "ml-auto",
							)}
						>
							<RadixSwitch.Root
								id="task-spotlight-include-other-projects"
								checked={includeOtherProjects}
								onCheckedChange={(checked) => {
									setIncludeOtherProjects(checked);
									focusInput();
								}}
								className="relative h-4 w-7 rounded-full bg-surface-4 outline-none data-[state=checked]:bg-accent"
							>
								<RadixSwitch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3.5" />
							</RadixSwitch.Root>
							<span>All projects</span>
							{includeOtherProjects && crossProjectStatus === "loading" ? <Spinner size={12} /> : null}
							{includeOtherProjects && crossProjectStatus === "error" ? (
								<span className="text-status-red">failed</span>
							) : null}
						</label>

						<div
							className={cn(
								"inline-flex shrink-0 items-center rounded-md border border-border bg-surface-1 p-0.5",
								!isMobile && "h-6",
							)}
							role="group"
							aria-label="Search mode"
						>
							{SEARCH_MODE_OPTIONS.map((option) => (
								<button
									key={option.mode}
									type="button"
									aria-pressed={option.mode === mode}
									onClick={() => {
										setMode(option.mode);
										focusInput();
									}}
									className={cn(
										"shrink-0 rounded-sm px-2 text-[11px] font-medium text-text-secondary hover:text-text-primary",
										isMobile ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "h-5",
										option.mode === mode && "bg-surface-4 text-text-primary",
									)}
								>
									{option.label}
								</button>
							))}
						</div>

						<TaskSpotlightSearchResultRowFieldVisibilityMenu
							fieldVisibility={fieldVisibility}
							onToggleFieldVisibility={toggleFieldVisibility}
							shouldUseMobileMinimumTouchTarget={isMobile}
						/>
					</div>

					<div className="min-h-0 flex-1 overscroll-contain">
						{results.length === 0 ? (
							<div className="flex h-full min-h-[120px] items-center justify-center px-4 py-8 text-center text-xs text-text-tertiary">
								{resolveEmptyResultsMessage({
									isBrowsingAllTasksWithoutQuery,
									semanticSearchStatus,
									taskIdMatchedResultCountHiddenByFilters,
									resultCountExcludedBecauseSessionActivityIsNotObservable,
								})}
							</div>
						) : (
							<Virtuoso
								ref={virtuosoRef}
								style={{ height: "100%" }}
								className="min-h-[120px]"
								data={results}
								computeItemKey={(_, result) => `${result.document.projectId}:${result.document.taskId}`}
								itemContent={(index, result) => {
									const rowDisplayContext = resolveResultRowDisplayContext(result.document);
									return (
										<div className="px-1.5 first:pt-1.5">
											<TaskSpotlightSearchResultRow
												result={result}
												isActive={index === activeIndex}
												isCrossProject={result.document.projectId !== currentProjectId}
												fieldVisibility={fieldVisibility}
												effectiveAgentId={rowDisplayContext.effectiveAgentId}
												agentLabel={rowDisplayContext.agentLabel}
												sessionActivity={rowDisplayContext.sessionActivity}
												timePillKind={timePillKind}
												agentConversationProgressAtEpochMs={
													rowDisplayContext.agentConversationProgressAtEpochMs
												}
												nowEpochMs={nowEpochMs}
												// 由这里传入而非行内调 useIsMobile()：Virtuoso 每条结果一个组件实例，
												// 行内调 hook 等于给每行都挂一个 media query 订阅。
												shouldUseMobileMinimumTouchTarget={isMobile}
												onSelect={() => openResultAt(index)}
												onHover={() => setActiveIndex(index)}
											/>
										</div>
									);
								}}
							/>
						)}
					</div>

					{/* mobile 真删不隐藏：没有物理键盘，这三条提示全是无效信息，读屏还会念出来；
					    且这一行正落在软键盘遮挡区，隐藏也占不到便宜。 */}
					{isMobile ? null : (
						<div className="flex shrink-0 items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-text-tertiary">
							<span className="flex items-center gap-1">
								<Kbd>↑</Kbd>
								<Kbd>↓</Kbd>
								<span>navigate</span>
							</span>
							<span className="flex items-center gap-1">
								<Kbd>↵</Kbd>
								<span>open</span>
							</span>
							<span className="flex items-center gap-1">
								<Kbd>esc</Kbd>
								<span>close</span>
							</span>
						</div>
					)}
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}
