import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { Pin, PinOff, Timer } from "lucide-react";
import type { ReactElement } from "react";
import { getAgentVisual } from "@/components/agent-visual";
import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import { crossProjectTaskSwitcherSectionRowAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { TaskActivityElapsedTimePills } from "@/components/task-activity-elapsed-time-pills";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";

const MINUTE_MS = 60_000;
// 剩余不足这么久时倒计时药丸转警示色。
// EXPERIMENT_NODE: 倒计时药丸转警示色的阈值取 10 分钟；够不够人从切过去到发出下一句。
const PROMPT_CACHE_WARMTH_EXPIRY_WARNING_THRESHOLD_MS = 10 * MINUTE_MS;

function formatPromptCacheWarmthRemainingDuration(remainingMs: number): string {
	if (remainingMs < MINUTE_MS) {
		return "<1m";
	}
	const remainingMinutes = Math.floor(remainingMs / MINUTE_MS);
	if (remainingMinutes < 60) {
		return `${remainingMinutes}m`;
	}
	return `${Math.floor(remainingMinutes / 60)}h${String(remainingMinutes % 60).padStart(2, "0")}m`;
}

export type CrossProjectTaskSwitcherTaskRowSection = "pinned" | "running" | "prompt_cache_warm" | "remaining";

/**
 * 跨项目切换面板的一行。刻意不复用 `TaskCardBody`：别的项目的卡只有 projects 广播里的精简条目，
 * 没有 prompt / 完整 session summary，拼一张假 BoardCard 去喂它只会让卡片动作按钮半残。
 *
 * 结构是「主按钮 + 并列的置顶按钮」而不是一整个按钮：按钮里不能嵌按钮。
 */
export function CrossProjectRecentlyActiveTaskSwitcherTaskRow({
	entryInProject,
	section,
	isFocused,
	isUnreadHandoff,
	nowMs,
	promptCacheWarmthEstimate,
	showsProjectName,
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
	onOpen: () => void;
	onTogglePinnedToTaskPinboard: () => void;
	onEditTaskPinboardPinReason?: () => void;
}): ReactElement {
	const { entry, workspaceId, projectName } = entryInProject;
	const visual = getAgentVisual(entry.agentId);
	const isPinned = entry.pinnedToTaskPinboardAt !== null;
	const promptCacheWarmthRemainingMs = promptCacheWarmthEstimate
		? promptCacheWarmthEstimate.promptCacheExpectedExpiryAt - nowMs
		: null;
	return (
		<div
			className={cn(
				"group flex min-w-0 items-center rounded-md hover:bg-surface-3",
				isFocused && "bg-surface-3 ring-1 ring-border-focus",
			)}
			data-cross-project-task-switcher-section={section}
			data-cross-project-task-switcher-workspace-id={workspaceId}
			data-cross-project-task-switcher-task-id={entry.taskId}
			// Pinned 行不挂锚点：Pinned 点击后要跳到的正是下方区里的这一行。
			data-verification-anchor={
				section === "pinned" ? undefined : crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId, entry.taskId)
			}
		>
			<button
				type="button"
				onClick={onOpen}
				aria-current={isFocused ? "true" : undefined}
				className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-none bg-transparent px-2 py-1.5 text-left text-inherit"
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
					{promptCacheWarmthEstimate && promptCacheWarmthRemainingMs !== null ? (
						<span
							className={cn(
								"inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10px] leading-4",
								promptCacheWarmthRemainingMs < PROMPT_CACHE_WARMTH_EXPIRY_WARNING_THRESHOLD_MS
									? "bg-status-gold/15 text-status-gold"
									: "bg-accent/15 text-accent",
							)}
							title={`Prompt cache expected to expire · ${new Date(
								promptCacheWarmthEstimate.promptCacheExpectedExpiryAt,
							).toLocaleString()}`}
						>
							<Timer size={10} className="shrink-0" />
							{formatPromptCacheWarmthRemainingDuration(promptCacheWarmthRemainingMs)}
						</span>
					) : null}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 pl-[19px] text-[10px] leading-none text-text-tertiary">
					{showsProjectName ? <span className="min-w-0 max-w-[45%] truncate">{projectName}</span> : null}
					{section === "pinned" ? (
						<span className="inline-flex shrink-0 items-center gap-0.5">
							<ColumnIndicator columnId={entry.columnId} size={10} />
							{resolveBoardColumnTitle(entry.columnId)}
						</span>
					) : null}
					<span className="ml-auto flex shrink-0">
						<TaskActivityElapsedTimePills task={entry} nowMs={nowMs} showsCreatedAtPill={false} />
					</span>
				</span>
				{section === "pinned" && entry.taskPinboardPinReason ? (
					<span className="truncate pl-[19px] text-[11px] text-text-secondary" title={entry.taskPinboardPinReason}>
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
	);
}
