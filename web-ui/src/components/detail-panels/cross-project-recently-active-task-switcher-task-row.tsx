import {
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
	isCrossProjectTaskSwitcherEntryRunning,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Pin, PinOff } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton } from "@/components/detail-panels/cross-project-recently-active-task-switcher-full-task-card-in-list-expansion-toggle-button";
import { CROSS_PROJECT_TASK_SWITCHER_FULL_TASK_CARD_FRAME_GEOMETRY_CLASS_NAME } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { CrossProjectTaskSwitcherRowFirstLine } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-first-line";
import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-worktree-git-metadata";
import { crossProjectTaskSwitcherSectionRowAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { ProjectIcon } from "@/components/project-visual-identity";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import {
	CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_TOP_MARGIN_CLEARING_HOVER_ACTION_GROUP_OVERHANG_AND_EXPANSION_TOGGLE_HIT_AREA_UPWARD_EXTENSION_CLASS_NAME,
	CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME,
} from "@/components/task-card-body";
import { TaskCardCornerStatusIndicators } from "@/components/task-card-corner-status-indicators";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";
import type { CrossProjectTaskSwitcherRowHoverExpansionTriggerProps } from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import { useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved } from "@/hooks/use-cross-project-task-switcher-row-in-list-expansion-toggle-keyboard-focus-handoff";

export type CrossProjectTaskSwitcherTaskRowSection =
	| "pinned"
	| "running"
	| "prompt_cache_warm"
	| "remaining"
	| "shelved";

/**
 * 一行在列表里的形态。hover 展开是临时的（指针挪到别的行停够、或离开面板就收回，见
 * use-cross-project-task-switcher-row-hover-expansion-in-place）；固定展开由用户点右上角开关决定，按任务记。
 */
export type CrossProjectTaskSwitcherRowInPlaceExpansionState =
	| "compact_row"
	| "expanded_in_place_by_hover"
	| "kept_expanded_in_list";

/**
 * 跨项目切换面板的一行。默认态是精简行（只用 projects 广播里的条目）；指针停够 hover 意图（触屏长按）后，这一行在列表里
 * **原地**换成完整卡片、把下面的行往下推；点右上角「Keep expanded in list」后固定展开，收起开关在卡片自己的 hover 动作组里。
 * 完整卡片（`fullTaskCard`）由面板按「当前项目读浏览器 board / 其他项目读服务端」备好。
 *
 * 三种形态共用同一个根节点（hover 交接后检查顶边是否还在可视区的就是它），精简行与完整卡片的首行同一套度量、
 * 同一个左上角起点，hover 动作组同一个坐标（叠在首行上方）（见 cross-project-recently-active-task-switcher-task-row-first-line.tsx）：
 * 三态之间标题一像素不动、开关不挪位，多出来的内容只向下长。
 *
 * 精简行的结构是「主按钮 + 叠在右上角的 hover 动作组」而不是一整个按钮：按钮里不能嵌按钮。
 */
export function CrossProjectRecentlyActiveTaskSwitcherTaskRow({
	entryInProject,
	section,
	isFocused,
	isUnreadHandoff,
	nowMs,
	promptCacheWarmthEstimate,
	showsProjectName,
	currentProjectId,
	inPlaceExpansionState,
	fullTaskCard,
	focusedTaskScrollAnchorKey,
	onKeepExpandedInListAsFullTaskCard,
	rowHoverExpansionTriggerProps,
	onOpen,
	onTogglePinnedToTaskPinboard,
	onEditTaskPinboardPinReason,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	section: CrossProjectTaskSwitcherTaskRowSection;
	isFocused: boolean;
	isUnreadHandoff: boolean;
	nowMs: number;
	promptCacheWarmthEstimate?: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
	showsProjectName: boolean;
	// 决定行上 git 元数据读哪个来源（当前项目的推流 store / 其他项目的轮询 store）。
	currentProjectId: string | null;
	inPlaceExpansionState: CrossProjectTaskSwitcherRowInPlaceExpansionState;
	// 展开时显示；精简行在 hover 意图计时期间也给出，隐藏挂载，借此在展开前就读好其他项目的卡（展开时是同一个实例）。
	fullTaskCard?: ReactNode;
	focusedTaskScrollAnchorKey?: string;
	onKeepExpandedInListAsFullTaskCard?: () => void;
	rowHoverExpansionTriggerProps?: CrossProjectTaskSwitcherRowHoverExpansionTriggerProps;
	onOpen: () => void;
	onTogglePinnedToTaskPinboard: () => void;
	onEditTaskPinboardPinReason?: () => void;
}): ReactElement {
	const { entry, workspaceId, projectName } = entryInProject;
	const isPinned = entry.pinnedToTaskPinboardAt !== null;
	const rowContainerAttributes = {
		"data-cross-project-task-switcher-section": section,
		"data-cross-project-task-switcher-workspace-id": workspaceId,
		"data-cross-project-task-switcher-task-id": entry.taskId,
		"data-cross-project-focused-task-scroll-anchor": focusedTaskScrollAnchorKey,
		"data-cross-project-task-switcher-row-in-place-expansion-state": inPlaceExpansionState,
		// Pinned 行不挂锚点：Pinned 点击后要跳到的正是下方区里的这一行。
		"data-verification-anchor":
			section === "pinned" ? undefined : crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId, entry.taskId),
	};

	const showsFullTaskCard = inPlaceExpansionState !== "compact_row" && fullTaskCard !== undefined;
	// 键盘按展开开关切换形态时，旧形态（连同它的开关）整块卸载：把焦点交给新形态下同一坐标的开关，不落到 body。
	const compactRowElementRefHandingOffToggleKeyboardFocus =
		useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved();
	const fullTaskCardFrameElementRefHandingOffToggleKeyboardFocus =
		useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved();

	return (
		<div
			className={cn(
				"relative flex min-w-0 flex-col",
				// 分区第一行给伸出行顶边的 hover 动作组（连同展开开关向上扩的命中区）让出 header 下方的空间（不压 header 的折叠按钮 / 排序下拉框）。
				CROSS_PROJECT_TASK_SWITCHER_FIRST_ROW_DIRECTLY_BELOW_SECTION_HEADER_TOP_MARGIN_CLEARING_HOVER_ACTION_GROUP_OVERHANG_AND_EXPANSION_TOGGLE_HIT_AREA_UPWARD_EXTENSION_CLASS_NAME,
				showsFullTaskCard ? CROSS_PROJECT_TASK_SWITCHER_FULL_TASK_CARD_FRAME_GEOMETRY_CLASS_NAME : "rounded-md",
				isFocused && "bg-surface-3 ring-1 ring-border-focus",
				!isFocused && inPlaceExpansionState === "expanded_in_place_by_hover" && "bg-surface-2 ring-border",
				!isFocused && inPlaceExpansionState === "kept_expanded_in_list" && "ring-border/60",
			)}
			{...rowContainerAttributes}
			{...rowHoverExpansionTriggerProps}
		>
			{/* 放在持续挂载的行外框上：展开、收起及读取快照期间角标不移动，也不重复出现。 */}
			<TaskCardCornerStatusIndicators
				isAgentRunning={entry.columnId !== "trash" && isCrossProjectTaskSwitcherEntryRunning(entry, nowMs)}
				hasUnreadHandoffNotification={isUnreadHandoff}
			/>
			{showsFullTaskCard ? null : (
				<div
					ref={compactRowElementRefHandingOffToggleKeyboardFocus}
					className="group relative flex min-w-0 rounded-md hover:bg-surface-3"
				>
					<div className="relative flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pl-2 pr-2 text-left">
						<button
							type="button"
							onClick={onOpen}
							aria-current={isFocused ? "true" : undefined}
							className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-accent"
							aria-label={`打开任务：${entry.title}`}
						/>
						<div className="pointer-events-none relative">
							<CrossProjectTaskSwitcherRowFirstLine agentId={entry.agentId} title={entry.title} />
						</div>
						{/* 换行而不是截断：时长药丸必须完整显示，窄宽度下整组药丸折到下一行。 */}
						<span
							data-task-card-secondary-metadata-row=""
							className="pointer-events-none relative flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-none text-text-tertiary"
						>
							{entry.turnOwner === "agent" && entry.liveness === "retrying" ? (
								<span className="shrink-0 text-status-orange" title="正在自动重连，当前任务回合尚未结束">
									重连中
								</span>
							) : null}
							{showsProjectName ? (
								<span className="inline-flex min-w-[min(14ch,100%)] max-w-full items-center gap-1">
									<ProjectIcon workspaceId={workspaceId} projectName={projectName} size={14} />
									<span className="min-w-0 [overflow-wrap:anywhere]">{projectName}</span>
								</span>
							) : null}
							<span className="pointer-events-auto contents">
								<CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata
									entryInProject={entryInProject}
									currentProjectId={currentProjectId}
								/>
							</span>
							{section === "pinned" || section === "shelved" ? (
								<span className="inline-flex shrink-0 items-center gap-0.5">
									<ColumnIndicator columnId={entry.columnId} size={10} />
									{resolveBoardColumnTitle(entry.columnId)}
								</span>
							) : null}
							{/* 与完整卡片元信息行右侧同一组、同一顺序：Cache warm 药丸、时长药丸、置顶标记。 */}
							<span className="ml-auto flex shrink-0 items-center gap-1">
								{promptCacheWarmthEstimate ? (
									<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
										promptCacheWarmthEstimate={promptCacheWarmthEstimate}
										nowMs={nowMs}
									/>
								) : null}
								<TaskActivityElapsedTimePills task={entry} nowMs={nowMs} />
								{isPinned && section !== "pinned" ? (
									<span
										data-cross-project-task-switcher-row-pinned-marker=""
										className="inline-flex shrink-0 text-accent"
										title={
											entry.taskPinboardPinReason
												? `Pinned to Pinboard · ${entry.taskPinboardPinReason}`
												: "Pinned to Pinboard"
										}
									>
										<Pin size={10} />
									</span>
								) : null}
							</span>
						</span>
						{section === "pinned" && entry.taskPinboardPinReason ? (
							<span
								className="pointer-events-none relative truncate text-[11px] text-text-secondary"
								title={entry.taskPinboardPinReason}
							>
								{entry.taskPinboardPinReason}
							</span>
						) : null}
					</div>
					{/* hover 动作组：与完整卡片的 hover 动作组同一几何（叠在首行上方 + right-1 + px-0.5、Button xs），
				    最右一格的展开开关因此与 hover 展开 / 固定展开卡上的开关同一坐标；不压首行的字。常驻 DOM（只切透明度），
				    键盘 Tab 得到，聚焦时显形。 */}
					<div
						className={cn(
							"absolute right-1 z-30 flex items-center gap-0.5 rounded-md bg-surface-3 px-0.5 shadow-sm transition-opacity",
							CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME,
							"pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
							"focus-within:pointer-events-auto focus-within:opacity-100",
						)}
					>
						{section === "pinned" && onEditTaskPinboardPinReason ? (
							<Button
								variant="ghost"
								size="xs"
								onClick={onEditTaskPinboardPinReason}
								aria-label="Edit pin reason"
								title="Edit pin reason"
							>
								Edit
							</Button>
						) : null}
						<Button
							icon={isPinned && section === "pinned" ? <PinOff size={12} /> : <Pin size={12} />}
							variant="ghost"
							size="xs"
							className={isPinned ? "text-accent" : undefined}
							onClick={onTogglePinnedToTaskPinboard}
							aria-label={isPinned ? "Unpin from Pinboard" : "Pin to Pinboard"}
							title={isPinned ? "Unpin from Pinboard" : "Pin to Pinboard"}
						/>
						{onKeepExpandedInListAsFullTaskCard ? (
							<CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton
								expansionState="collapsed_to_compact_row"
								onToggleInListExpansion={onKeepExpandedInListAsFullTaskCard}
							/>
						) : null}
					</div>
				</div>
			)}
			{/* 固定位置（第 2 个子节点）：精简行 ↔ 展开之间完整卡片是同一个实例，不重挂载、不重读。 */}
			{fullTaskCard !== undefined ? (
				<div
					ref={fullTaskCardFrameElementRefHandingOffToggleKeyboardFocus}
					hidden={!showsFullTaskCard}
					className="min-w-0"
				>
					{fullTaskCard}
				</div>
			) : null}
		</div>
	);
}
