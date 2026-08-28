import * as RadixPopover from "@radix-ui/react-popover";
import { ListFilter } from "lucide-react";

import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId } from "@/runtime/types";
import {
	countActiveTaskFilterDimensions,
	EMPTY_TASK_FILTER_SELECTION,
	isEmptyTaskFilterSelection,
	resolveTaskFilterDimensionRenderableOptions,
	TASK_LAST_MODIFIED_FILTER_WINDOW_LABELS,
	TASK_LAST_MODIFIED_FILTER_WINDOWS,
	TASK_SESSION_ACTIVITY_FILTER_CATEGORIES,
	TASK_SESSION_ACTIVITY_FILTER_CATEGORY_LABELS,
	type TaskFilterSelection,
	type TaskFilterSetDimensionKey,
	toggleTaskFilterSelectionSetMember,
} from "@/task-filtering/task-filter-selection";
import type { BoardColumnId } from "@/types";

/**
 * 一个集合维度上「这批数据里实际存在哪些取值」。控件不摆一排永远筛不出东西的死选项——但**已被选中的取值
 * 即使从这里消失也照样渲染**（弱化显示），否则约束还生效、界面上却无从关闭，见 task-filter-selection 的
 * `resolveTaskFilterDimensionRenderableOptions`。
 */
export interface TaskFilterOptionValue {
	value: string;
	label: string;
}

export interface TaskFilterControlsAvailableValues {
	stageColumnIds: ReadonlyArray<{ value: BoardColumnId; label: string }>;
	projects: readonly TaskFilterOptionValue[];
	agents: ReadonlyArray<{ value: RuntimeAgentId; label: string }>;
}

function TaskFilterChip({
	label,
	isSelected,
	isSelectedButNoLongerAvailable = false,
	shouldUseMobileMinimumTouchTarget,
	onClick,
}: {
	label: string;
	isSelected: boolean;
	/** true = 这个取值已从当前可选集里消失，但约束还在生效——弱化显示，且必须照样点得掉。 */
	isSelectedButNoLongerAvailable?: boolean;
	shouldUseMobileMinimumTouchTarget: boolean;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			aria-pressed={isSelected}
			data-task-filter-chip-selected-but-no-longer-available={isSelectedButNoLongerAvailable ? "" : undefined}
			title={
				isSelectedButNoLongerAvailable
					? "Nothing here matches this filter value right now — click to remove it"
					: undefined
			}
			onClick={onClick}
			className={cn(
				"shrink-0 rounded-md border px-2 text-xs font-medium",
				shouldUseMobileMinimumTouchTarget ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "h-6",
				isSelectedButNoLongerAvailable
					? "border-dashed border-border-bright bg-surface-3 text-text-tertiary line-through hover:text-text-secondary"
					: isSelected
						? "border-border-bright bg-surface-3 text-text-primary"
						: "border-border bg-surface-1 text-text-tertiary hover:text-text-secondary",
			)}
		>
			{label}
		</button>
	);
}

function TaskFilterDimensionSection({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="mb-2.5 last:mb-0">
			<div className="mb-1 px-0.5 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
				{title}
			</div>
			{hint ? <div className="mb-1 px-0.5 text-[11px] text-text-tertiary">{hint}</div> : null}
			<div className="flex flex-wrap items-center gap-1">{children}</div>
		</div>
	);
}

/**
 * 多维任务过滤控件：一个带「已启用维度数」角标的触发按钮 + 一个装着全部维度的浮层。
 *
 * **受控、且不知道自己被谁用**——它只认 `selection` / `availableValues` / `onChange`，不认 Spotlight、
 * 不认看板、不发请求、不读 localStorage。主看板将来要复用同一套过滤时，接的就是这三个 prop。
 *
 * 维度全部收进浮层（而不是把 stage chips 摊在工具栏上）有两个原因：五个维度平铺在窄屏上必然折行、
 * 挤掉本就紧张的结果列表高度；以及维度之间是平级的，摊一个藏四个会让人以为只能按 stage 筛。
 */
export function TaskFilterControls({
	selection,
	availableValues,
	onChange,
	shouldUseMobileMinimumTouchTarget,
	isSessionActivityDimensionSupported,
	sessionActivityDimensionHint,
	onInteractionComplete,
}: {
	selection: TaskFilterSelection;
	availableValues: TaskFilterControlsAvailableValues;
	onChange: (selection: TaskFilterSelection) => void;
	shouldUseMobileMinimumTouchTarget: boolean;
	/** false = 本消费场景根本拿不到会话状态（例如一个纯静态列表），整个维度隐藏而不是摆出来筛不动。 */
	isSessionActivityDimensionSupported: boolean;
	/** 会话状态维度下方的说明（例如「只对当前项目可判」）。 */
	sessionActivityDimensionHint?: string;
	/** 每次改动后回调（Spotlight 用它把键盘焦点还给搜索框）。 */
	onInteractionComplete?: () => void;
}): React.ReactElement {
	const activeDimensionCount = countActiveTaskFilterDimensions(selection);
	// 可选集 + 已选中但当前不可得的成员：后者是唯一能让「角标说有过滤在生效」与「浮层里点得掉它」对上的东西。
	const renderableProjectOptions = resolveTaskFilterDimensionRenderableOptions(
		availableValues.projects,
		selection.selectedProjectIds,
	);
	const renderableAgentOptions = resolveTaskFilterDimensionRenderableOptions(
		availableValues.agents,
		selection.selectedAgentIds,
	);

	const applySelection = (nextSelection: TaskFilterSelection) => {
		onChange(nextSelection);
		onInteractionComplete?.();
	};

	const toggleSetMember = (dimension: TaskFilterSetDimensionKey, member: string) => {
		applySelection(toggleTaskFilterSelectionSetMember(selection, dimension, member));
	};

	return (
		<RadixPopover.Root>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label="Filter tasks"
					className={cn(
						"inline-flex shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium",
						shouldUseMobileMinimumTouchTarget ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "h-6",
						activeDimensionCount > 0
							? "border-accent bg-accent/15 text-accent"
							: "border-border bg-surface-1 text-text-secondary hover:text-text-primary",
					)}
				>
					<ListFilter size={12} />
					<span>Filters</span>
					{activeDimensionCount > 0 ? (
						<span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
							{activeDimensionCount}
						</span>
					) : null}
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					data-task-filter-controls-panel=""
					className="z-50 max-h-[60vh] w-[min(320px,92vw)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface-2 p-2.5 shadow-xl"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					align="start"
					sideOffset={5}
					collisionPadding={8}
				>
					<TaskFilterDimensionSection title="Stage">
						{availableValues.stageColumnIds.map((stage) => (
							<TaskFilterChip
								key={stage.value}
								label={stage.label}
								isSelected={selection.selectedStageColumnIds.has(stage.value)}
								shouldUseMobileMinimumTouchTarget={shouldUseMobileMinimumTouchTarget}
								onClick={() => toggleSetMember("selectedStageColumnIds", stage.value)}
							/>
						))}
					</TaskFilterDimensionSection>

					{renderableProjectOptions.length > 1 || selection.selectedProjectIds.size > 0 ? (
						<TaskFilterDimensionSection title="Project">
							{renderableProjectOptions.map((project) => (
								<TaskFilterChip
									key={project.value}
									label={project.label}
									isSelected={selection.selectedProjectIds.has(project.value)}
									isSelectedButNoLongerAvailable={project.isSelectedButNoLongerAvailable}
									shouldUseMobileMinimumTouchTarget={shouldUseMobileMinimumTouchTarget}
									onClick={() => toggleSetMember("selectedProjectIds", project.value)}
								/>
							))}
						</TaskFilterDimensionSection>
					) : null}

					{renderableAgentOptions.length > 0 ? (
						<TaskFilterDimensionSection title="Agent">
							{renderableAgentOptions.map((agent) => (
								<TaskFilterChip
									key={agent.value}
									label={agent.label}
									isSelected={selection.selectedAgentIds.has(agent.value)}
									isSelectedButNoLongerAvailable={agent.isSelectedButNoLongerAvailable}
									shouldUseMobileMinimumTouchTarget={shouldUseMobileMinimumTouchTarget}
									onClick={() => toggleSetMember("selectedAgentIds", agent.value)}
								/>
							))}
						</TaskFilterDimensionSection>
					) : null}

					{isSessionActivityDimensionSupported ? (
						<TaskFilterDimensionSection title="Session state" hint={sessionActivityDimensionHint}>
							{TASK_SESSION_ACTIVITY_FILTER_CATEGORIES.map((category) => (
								<TaskFilterChip
									key={category}
									label={TASK_SESSION_ACTIVITY_FILTER_CATEGORY_LABELS[category]}
									isSelected={selection.selectedSessionActivityCategories.has(category)}
									shouldUseMobileMinimumTouchTarget={shouldUseMobileMinimumTouchTarget}
									onClick={() => toggleSetMember("selectedSessionActivityCategories", category)}
								/>
							))}
						</TaskFilterDimensionSection>
					) : null}

					<TaskFilterDimensionSection title="Last modified">
						{TASK_LAST_MODIFIED_FILTER_WINDOWS.map((window) => (
							<TaskFilterChip
								key={window}
								label={TASK_LAST_MODIFIED_FILTER_WINDOW_LABELS[window]}
								// 时间窗是单选枚举：点中即设为该窗，`any` 就是「不设约束」那一档。
								isSelected={selection.lastModifiedWindow === window}
								shouldUseMobileMinimumTouchTarget={shouldUseMobileMinimumTouchTarget}
								onClick={() => applySelection({ ...selection, lastModifiedWindow: window })}
							/>
						))}
					</TaskFilterDimensionSection>

					{!isEmptyTaskFilterSelection(selection) ? (
						<button
							type="button"
							className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
							onClick={() => applySelection(EMPTY_TASK_FILTER_SELECTION)}
						>
							Clear all filters
						</button>
					) : null}
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
