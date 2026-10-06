import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Pin, PinOff } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { getAgentVisual } from "@/components/agent-visual";
import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import { CrossProjectTaskSwitcherFullTaskCardHeaderStrip } from "@/components/detail-panels/cross-project-recently-active-task-switcher-full-task-card-header-strip";
import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-worktree-git-metadata";
import { crossProjectTaskSwitcherSectionRowAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";
import type { CrossProjectTaskSwitcherRowHoverOverlayTriggerProps } from "@/hooks/use-cross-project-task-switcher-row-full-task-card-hover-overlay";

export type CrossProjectTaskSwitcherTaskRowSection = "pinned" | "running" | "prompt_cache_warm" | "remaining";

/**
 * 跨项目切换面板的一行。默认态是精简行（只用 projects 广播里的条目）；hover（触屏长按）后完整卡片以浮层盖在原位
 *（面板负责，见 use-cross-project-task-switcher-row-full-task-card-hover-overlay）。用户在浮层上点了「Keep open」后，
 * 这一行在列表里原地换成完整卡片（`fullTaskCardKeptOpenByUser`，由面板按「当前项目读浏览器 board / 其他项目读
 * 服务端」备好），点「Collapse」换回精简行。
 *
 * 精简行的结构是「主按钮 + 并列的置顶按钮」而不是一整个按钮：按钮里不能嵌按钮。
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
	isKeptOpenAsFullTaskCardByUser = false,
	fullTaskCardKeptOpenByUser,
	onCollapseKeptOpenFullTaskCard,
	rowHoverOverlayTriggerProps,
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
	isKeptOpenAsFullTaskCardByUser?: boolean;
	// 只在 isKeptOpenAsFullTaskCardByUser 时由面板给出。
	fullTaskCardKeptOpenByUser?: ReactNode;
	onCollapseKeptOpenFullTaskCard?: () => void;
	// 精简行上触发 hover 浮层的指针处理器；已经 Keep open 的行没有浮层。
	rowHoverOverlayTriggerProps?: CrossProjectTaskSwitcherRowHoverOverlayTriggerProps;
	onOpen: () => void;
	onTogglePinnedToTaskPinboard: () => void;
	onEditTaskPinboardPinReason?: () => void;
}): ReactElement {
	const { entry, workspaceId, projectName } = entryInProject;
	const visual = getAgentVisual(entry.agentId);
	const isPinned = entry.pinnedToTaskPinboardAt !== null;
	const rowContainerAttributes = {
		"data-cross-project-task-switcher-section": section,
		"data-cross-project-task-switcher-workspace-id": workspaceId,
		"data-cross-project-task-switcher-task-id": entry.taskId,
		"data-cross-project-task-switcher-row-kept-open-as-full-task-card": isKeptOpenAsFullTaskCardByUser,
		// Pinned 行不挂锚点：Pinned 点击后要跳到的正是下方区里的这一行。
		"data-verification-anchor":
			section === "pinned" ? undefined : crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId, entry.taskId),
	};

	if (isKeptOpenAsFullTaskCardByUser && fullTaskCardKeptOpenByUser) {
		return (
			<div
				className={cn(
					"flex min-w-0 flex-col rounded-md border border-border/60 p-1",
					isFocused && "bg-surface-3 ring-1 ring-border-focus",
				)}
				{...rowContainerAttributes}
			>
				<CrossProjectTaskSwitcherFullTaskCardHeaderStrip
					projectName={showsProjectName ? projectName : null}
					isUnreadHandoff={isUnreadHandoff}
					promptCacheWarmthEstimate={promptCacheWarmthEstimate}
					nowMs={nowMs}
					fullTaskCardKeepOpenAction={{
						kind: "collapse_kept_open_full_task_card_back_to_compact_row",
						onCollapse: () => onCollapseKeptOpenFullTaskCard?.(),
					}}
				/>
				{fullTaskCardKeptOpenByUser}
			</div>
		);
	}

	return (
		<div
			className={cn("flex min-w-0 flex-col rounded-md", isFocused && "bg-surface-3 ring-1 ring-border-focus")}
			{...rowContainerAttributes}
		>
			<div
				className="group flex min-w-0 items-center rounded-md hover:bg-surface-3"
				{...rowHoverOverlayTriggerProps}
			>
				<button
					type="button"
					onClick={onOpen}
					aria-current={isFocused ? "true" : undefined}
					className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-none bg-transparent py-1.5 pl-2 pr-2 text-left text-inherit"
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{section === "running" ? (
							<span
								className="inline-block size-1.5 shrink-0 animate-pulse rounded-full"
								style={{ backgroundColor: SESSION_ACTIVITY_COLOR.thinking }}
							/>
						) : isUnreadHandoff ? (
							<span
								className="inline-block size-1.5 shrink-0 rounded-full bg-accent"
								title="Unread handoff notification"
							/>
						) : null}
						<visual.Icon size={13} className={cn("shrink-0", visual.className)} />
						<span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{entry.title}</span>
						{promptCacheWarmthEstimate ? (
							<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
								promptCacheWarmthEstimate={promptCacheWarmthEstimate}
								nowMs={nowMs}
							/>
						) : null}
					</span>
					{/* 换行而不是截断：时长药丸必须完整显示，窄宽度下整组药丸折到下一行。 */}
					<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[19px] text-[10px] leading-none text-text-tertiary">
						{showsProjectName ? <span className="min-w-0 max-w-full truncate">{projectName}</span> : null}
						<CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata
							entryInProject={entryInProject}
							currentProjectId={currentProjectId}
						/>
						{section === "pinned" ? (
							<span className="inline-flex shrink-0 items-center gap-0.5">
								<ColumnIndicator columnId={entry.columnId} size={10} />
								{resolveBoardColumnTitle(entry.columnId)}
							</span>
						) : null}
						<span className="ml-auto flex shrink-0">
							<TaskActivityElapsedTimePills task={entry} nowMs={nowMs} />
						</span>
					</span>
					{section === "pinned" && entry.taskPinboardPinReason ? (
						<span
							className="truncate pl-[19px] text-[11px] text-text-secondary"
							title={entry.taskPinboardPinReason}
						>
							{entry.taskPinboardPinReason}
						</span>
					) : null}
				</button>
				{section === "pinned" && onEditTaskPinboardPinReason ? (
					<button
						type="button"
						onClick={onEditTaskPinboardPinReason}
						aria-label="Edit pin reason"
						title="Edit pin reason"
						className="hidden shrink-0 cursor-pointer rounded-sm border-none bg-transparent px-1 py-1 text-[10px] text-text-tertiary hover:text-text-primary group-hover:block"
					>
						Edit
					</button>
				) : null}
				<button
					type="button"
					onClick={onTogglePinnedToTaskPinboard}
					aria-label={isPinned ? "Unpin from Pinboard" : "Pin to Pinboard"}
					title={isPinned ? "Unpin from Pinboard" : "Pin to Pinboard"}
					className={cn(
						"mr-1 shrink-0 cursor-pointer rounded-sm border-none bg-transparent p-1 text-text-tertiary hover:text-text-primary",
						isPinned && section !== "pinned" ? "block text-accent" : "hidden group-hover:block",
					)}
				>
					{isPinned && section === "pinned" ? <PinOff size={12} /> : <Pin size={12} />}
				</button>
			</div>
		</div>
	);
}
