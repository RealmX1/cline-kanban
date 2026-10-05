import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { ChevronDown, ChevronRight, Minimize2, Pin, PinOff, Timer } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { getAgentVisual } from "@/components/agent-visual";
import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import { CrossProjectRecentlyActiveTaskSwitcherTaskRowWorktreeGitMetadata } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-worktree-git-metadata";
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

const PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION: Record<
	CrossProjectTaskSwitcherPromptCacheWarmthAnchorSource,
	string
> = {
	main_agent_conversation_model_request_dispatch_observation: "last main-conversation model request",
	manual_compaction_replaced_main_conversation_without_follow_up_request:
		"manual /compact completed (conversation replaced by a summary)",
	last_substantive_agent_terminal_output: "last substantive agent output (agent has no turn hooks)",
	high_confidence_last_conversation_progress_observation_fallback:
		"conversation last advanced (fallback: no model request observed yet)",
};

function isPromptCacheWarmthAnchoredOnManualCompaction(
	estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
): boolean {
	return (
		estimate.promptCacheWarmthAnchorSource ===
		"manual_compaction_replaced_main_conversation_without_follow_up_request"
	);
}

function formatContextTokenCountInThousands(tokenCount: number): string {
	return `~${Math.max(1, Math.round(tokenCount / 1000))}k`;
}

// 手动压缩后不显示倒计时（2026-10-05 用户拍板 B′）：压缩请求只按 5 分钟档读了被替换前的旧前缀，下一条回复
// 不论早晚都要重写压缩后的上下文。harness 报了大小（Kimi）才写 N，否则给 Claude 的实测范围，不造数字。
function describeManualCompactionReplacedMainConversation(
	estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
): string {
	const reportedTokenCount = estimate.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness;
	return [
		`Compacted · ${new Date(estimate.promptCacheWarmthAnchorAt).toLocaleString()} · ${
			PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION[estimate.promptCacheWarmthAnchorSource]
		}`,
		reportedTokenCount !== undefined
			? `Your next reply rewrites ${formatContextTokenCountInThousands(reportedTokenCount)} tokens of compacted context`
			: "Your next reply rewrites the compacted context (measured 86k–103k tokens on Claude); only the system and project-context layers still hit the cache",
	].join("\n");
}

function describePromptCacheWarmthEstimate(estimate: CrossProjectTaskSwitcherPromptCacheWarmthEstimate): string {
	return [
		`Prompt cache expected to expire · ${new Date(estimate.promptCacheExpectedExpiryAt).toLocaleString()}`,
		`Countdown started · ${new Date(estimate.promptCacheWarmthAnchorAt).toLocaleString()} · ${
			PROMPT_CACHE_WARMTH_ANCHOR_SOURCE_DESCRIPTION[estimate.promptCacheWarmthAnchorSource]
		}`,
	].join("\n");
}

export type CrossProjectTaskSwitcherTaskRowSection = "pinned" | "running" | "prompt_cache_warm" | "remaining";

/**
 * 跨项目切换面板的一行。默认态是精简行（只用 projects 广播里的条目）；点左侧 chevron 展开成与 This project 同一个
 * 紧凑 `TaskCardBody`（`expandedTaskCard`，由面板按「当前项目读浏览器 board / 其他项目读服务端」备好）。
 *
 * 结构是「展开按钮 + 主按钮 + 并列的置顶按钮」而不是一整个按钮：按钮里不能嵌按钮。
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
	isExpanded = false,
	onToggleExpanded,
	expandedTaskCard,
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
	isExpanded?: boolean;
	onToggleExpanded?: () => void;
	// 只在展开时由面板给出。
	expandedTaskCard?: ReactNode;
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
			className={cn("flex min-w-0 flex-col rounded-md", isFocused && "bg-surface-3 ring-1 ring-border-focus")}
			data-cross-project-task-switcher-section={section}
			data-cross-project-task-switcher-workspace-id={workspaceId}
			data-cross-project-task-switcher-task-id={entry.taskId}
			data-cross-project-task-switcher-row-expanded={isExpanded}
			// Pinned 行不挂锚点：Pinned 点击后要跳到的正是下方区里的这一行。
			data-verification-anchor={
				section === "pinned" ? undefined : crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId, entry.taskId)
			}
		>
			<div className="group flex min-w-0 items-center rounded-md hover:bg-surface-3">
				{onToggleExpanded ? (
					<button
						type="button"
						onClick={onToggleExpanded}
						aria-expanded={isExpanded}
						aria-label={isExpanded ? "Collapse task card" : "Expand task card"}
						title={isExpanded ? "Collapse task card" : "Expand task card"}
						className={cn(
							"ml-0.5 flex shrink-0 cursor-pointer items-center self-start rounded-sm border-none bg-transparent px-0 pt-[7px] text-text-tertiary hover:text-text-primary focus-visible:opacity-100",
							isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
						)}
					>
						{isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
					</button>
				) : null}
				<button
					type="button"
					onClick={onOpen}
					aria-current={isFocused ? "true" : undefined}
					className={cn(
						"flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-none bg-transparent py-1.5 pr-2 text-left text-inherit",
						onToggleExpanded ? "pl-1" : "pl-2",
					)}
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
						{promptCacheWarmthEstimate &&
						isPromptCacheWarmthAnchoredOnManualCompaction(promptCacheWarmthEstimate) ? (
							<span
								className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-surface-4 px-1 text-[10px] leading-4 text-text-secondary"
								title={describeManualCompactionReplacedMainConversation(promptCacheWarmthEstimate)}
							>
								<Minimize2 size={10} className="shrink-0" />
								{promptCacheWarmthEstimate.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness !==
								undefined
									? `Compacted · ${formatContextTokenCountInThousands(
											promptCacheWarmthEstimate.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness,
										)}`
									: "Compacted"}
							</span>
						) : promptCacheWarmthEstimate && promptCacheWarmthRemainingMs !== null ? (
							<span
								className={cn(
									"inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-[10px] leading-4",
									promptCacheWarmthRemainingMs < PROMPT_CACHE_WARMTH_EXPIRY_WARNING_THRESHOLD_MS
										? "bg-status-gold/15 text-status-gold"
										: "bg-accent/15 text-accent",
								)}
								title={describePromptCacheWarmthEstimate(promptCacheWarmthEstimate)}
							>
								<Timer size={10} className="shrink-0" />
								{formatPromptCacheWarmthRemainingDuration(promptCacheWarmthRemainingMs)}
							</span>
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
			{isExpanded ? expandedTaskCard : null}
		</div>
	);
}
