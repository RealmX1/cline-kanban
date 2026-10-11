import { Activity, Clock, PencilLine } from "lucide-react";
import type { CSSProperties } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import type { CardSessionActivity } from "@/components/board-card-session-activity";
import { renderFuzzyHighlightedText } from "@/components/shared/render-fuzzy-highlighted-text";
import type { TaskSpotlightSearchResultRowFieldVisibility } from "@/components/task-spotlight-search-result-row-field-visibility";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveSpotlightStageLabel } from "@/hooks/use-task-spotlight-search-controller";
import type { RuntimeAgentId } from "@/runtime/types";
import type { TaskBoardSearchMode, TaskBoardSearchResult } from "@/search/task-board-search";
import { buildPromptMatchSnippet } from "@/search/task-search-prompt-match-snippet";
import type { TaskSearchResultSortOrder } from "@/search/task-search-result-ordering";
import type { BoardColumnId } from "@/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

const HIGHLIGHTED_TEXT_STYLE: CSSProperties = {
	color: "var(--color-status-gold)",
	fontWeight: 600,
};

// 与文本高亮同源的金色：task id 全等命中即整体高亮，不需要字符级位置集。
const TASK_ID_BADGE_MATCHED_STYLE: CSSProperties = {
	color: "var(--color-status-gold)",
	borderColor: "var(--color-status-gold)",
};

// prompt 命中片段的截窗半径（字符）。
const PROMPT_SNIPPET_WINDOW_RADIUS = 48;

// title 与 prompt 皆空时的主行占位。既有文本搜索永远匹配不到这种任务，所以从没出现过；
// task id 搜索**会**把它捞出来，不兜底就是一条空行。
const MISSING_PRIMARY_TEXT_PLACEHOLDER = "Untitled task";

/**
 * 时间药丸展示的是哪一个时刻。跟随**这一行实际被排序所用的那个时间**：既然用户是按某个时间排的序，
 * 行里就该显示那个时间，否则「为什么这条排在前面」在行上根本看不出来。因此要逐行解析——
 * direct 的 relevance 档分两段（有推进时刻的按它排、没有的按上次修改排），同一屏里两种药丸并存。
 */
export type TaskSpotlightSearchResultRowTimePillKind = "created" | "last_modified" | "agent_conversation_progress";

export function resolveTaskSpotlightSearchResultRowTimePillKind({
	effectiveSortOrder,
	mode,
	agentConversationProgressAtEpochMs,
}: {
	effectiveSortOrder: TaskSearchResultSortOrder;
	mode: TaskBoardSearchMode;
	agentConversationProgressAtEpochMs: number | null;
}): TaskSpotlightSearchResultRowTimePillKind {
	if (effectiveSortOrder === "task_created_at_desc") {
		return "created";
	}
	if (effectiveSortOrder === "agent_conversation_progress_desc") {
		return "agent_conversation_progress";
	}
	// direct 的 relevance 档按「最近活跃」排：有推进时刻的行显示它，没有的落到段 2 所用的「上次修改」。
	if (effectiveSortOrder === "relevance" && mode === "direct" && agentConversationProgressAtEpochMs !== null) {
		return "agent_conversation_progress";
	}
	// 其余模式的 relevance 档没有自己的时间语义，落到「上次修改」——它是三者中唯一对每一行都有值的。
	return "last_modified";
}

const TIME_PILL_ICON_BY_KIND = {
	created: Clock,
	last_modified: PencilLine,
	agent_conversation_progress: Activity,
} as const;

const TIME_PILL_TITLE_BY_KIND: Readonly<Record<TaskSpotlightSearchResultRowTimePillKind, string>> = {
	created: "Created",
	last_modified: "Last modified (created, moved, or edited — not agent activity)",
	agent_conversation_progress: "Conversation last advanced",
};

export function TaskSpotlightSearchResultRow({
	result,
	isActive,
	isCrossProject,
	fieldVisibility,
	effectiveAgentId,
	agentLabel,
	sessionActivity,
	timePillKind,
	agentConversationProgressAtEpochMs,
	nowEpochMs,
	shouldUseMobileMinimumTouchTarget,
	onSelect,
	onHover,
}: {
	result: TaskBoardSearchResult;
	isActive: boolean;
	isCrossProject: boolean;
	fieldVisibility: TaskSpotlightSearchResultRowFieldVisibility;
	/** 这一行此刻的有效 agent（活会话 > per-task 覆盖 > 最近一次实际启动 > 项目默认）；未知为 null。 */
	effectiveAgentId: RuntimeAgentId | null;
	/** agent 的展示名（用于 tooltip）；agent 未知时为 null。 */
	agentLabel: string | null;
	/** 会话活性预览（色点 + 文案）；跨项目行与无会话行为 null。 */
	sessionActivity: CardSessionActivity | null;
	timePillKind: TaskSpotlightSearchResultRowTimePillKind;
	/** 「对话上次推进」时刻；当前项目取会话推流、其它项目取跨项目索引快照，从没推进过为 null（药丸此时不显示）。 */
	agentConversationProgressAtEpochMs: number | null;
	/** 由弹层统一传入：每行各自 `Date.now()` 会让同屏各行读数不一致，且每次重渲都变。 */
	nowEpochMs: number;
	/** 由弹层统一传入（见调用处注释）：mobile 下把行高抬到 44px 触控下限。 */
	shouldUseMobileMinimumTouchTarget: boolean;
	onSelect: () => void;
	onHover: () => void;
}): React.ReactElement {
	const { document } = result;
	const stageLabel = resolveSpotlightStageLabel(document.columnId as BoardColumnId);
	// 主行有 title 展示 title，否则回退展示 prompt；高亮位置集必须与「实际展示的字段」保持一致，
	// 否则 title 为空、主行回退展示 prompt 时会错用（必为空的）title 位置集，导致 prompt 命中在主行不高亮。
	const hasTitle = document.title.length > 0;
	const primaryText = hasTitle ? document.title : document.prompt;
	const primaryMatchCharacterPositions = hasTitle
		? result.titleMatchCharacterPositions
		: result.promptMatchCharacterPositions;
	// task id 徽标现在对每一行常驻（用户要的「默认常驻、可选关闭」）；「靠 id 命中」的那条仍上金色，
	// 否则用户看不出它凭什么被顶到最前。
	const isTaskIdMatched = result.matchSources.includes("taskId");
	// 仅「主行展示 title、且 prompt 命中而 title 未命中」时才补下方 prompt 片段行：此时主行（title）无法展示
	// prompt 命中，需 snippet 补救；semantic-only（无位置集）不展示片段，只显徽标。title 为空时主行已直接展示
	// 带高亮的 prompt，无需再补 snippet（否则与主行重复展示同一段 prompt 高亮）。
	const shouldRenderPromptMatchSnippet =
		fieldVisibility.prompt_match_snippet_line &&
		hasTitle &&
		result.promptMatchCharacterPositions.size > 0 &&
		result.titleMatchCharacterPositions.size === 0;
	const promptSnippet = shouldRenderPromptMatchSnippet
		? buildPromptMatchSnippet(document.prompt, result.promptMatchCharacterPositions, PROMPT_SNIPPET_WINDOW_RADIUS)
		: null;

	const agentVisual = effectiveAgentId ? getAgentVisual(effectiveAgentId) : null;
	const TimePillIcon = TIME_PILL_ICON_BY_KIND[timePillKind];
	const timePillEpochMs =
		timePillKind === "created"
			? document.taskCreatedAtEpochMs
			: timePillKind === "last_modified"
				? document.taskLastModifiedAtEpochMs
				: agentConversationProgressAtEpochMs;

	return (
		<button
			type="button"
			onClick={onSelect}
			onMouseMove={onHover}
			className={cn(
				"flex w-full items-start gap-2.5 rounded-md px-3 text-left",
				shouldUseMobileMinimumTouchTarget ? "min-h-[44px] py-3" : "py-2",
				isActive ? "bg-surface-3" : "hover:bg-surface-2",
			)}
		>
			<span className="mt-0.5 inline-flex shrink-0 items-center">
				<ColumnIndicator columnId={document.columnId} size={14} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2">
					{fieldVisibility.agent_identity && agentVisual ? (
						<span
							className={cn("inline-flex shrink-0 items-center", agentVisual.className)}
							title={agentLabel ?? undefined}
						>
							<agentVisual.Icon size={13} />
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
						{primaryText.length > 0 ? (
							renderFuzzyHighlightedText(primaryText, primaryMatchCharacterPositions, HIGHLIGHTED_TEXT_STYLE)
						) : (
							<span className="text-text-tertiary">{MISSING_PRIMARY_TEXT_PLACEHOLDER}</span>
						)}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1.5">
						{fieldVisibility.task_id_badge ? (
							<span
								className={cn(
									// 徽标常驻，而 taskId 在创建路径上允许经 explicitTaskId 传入任意长度的自定义值（只有 5 位
									// [0-9a-z] 范式那批走得进 ID 搜索通道，展示侧没有这个约束）。所在容器是 shrink-0，
									// 不封顶就会把同一行 flex-1 的主文本压到接近零宽。上限比项目名徽标窄一档，
									// 但仍容得下十余个等宽字符，截断后依然看得出这是个 ID。
									"inline-flex h-4 max-w-[96px] items-center truncate rounded-sm border bg-surface-2 px-1.5 font-mono text-[10px] font-medium",
									!isTaskIdMatched && "border-border text-text-tertiary",
								)}
								style={isTaskIdMatched ? TASK_ID_BADGE_MATCHED_STYLE : undefined}
							>
								{document.taskId}
							</span>
						) : null}
						{fieldVisibility.project_name_badge ? (
							<span
								className={cn(
									"inline-flex h-4 max-w-[140px] items-center truncate rounded-sm border border-border bg-surface-2 px-1.5 text-[10px] font-medium",
									// 跨项目行的项目名是「这条不在你当前项目里」的关键信号，比当前项目那条更该被看见。
									isCrossProject ? "text-text-secondary" : "text-text-tertiary",
								)}
							>
								{document.projectName}
							</span>
						) : null}
						{fieldVisibility.stage_label_badge ? (
							<span className="inline-flex h-4 items-center rounded-sm border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-secondary">
								{stageLabel}
							</span>
						) : null}
						{fieldVisibility.relative_time_pill && timePillEpochMs !== null ? (
							<span
								className="inline-flex h-4 items-center gap-0.5 rounded-sm border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-tertiary"
								title={TIME_PILL_TITLE_BY_KIND[timePillKind]}
							>
								<TimePillIcon size={9} />
								{formatCompactElapsedSince(timePillEpochMs, nowEpochMs)}
							</span>
						) : null}
					</span>
				</span>
				{fieldVisibility.session_activity_line && sessionActivity ? (
					<span className="mt-0.5 flex items-center gap-1.5">
						<span
							className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
							style={{ backgroundColor: sessionActivity.dotColor }}
							aria-hidden
						/>
						<span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">
							{sessionActivity.text}
						</span>
					</span>
				) : null}
				{promptSnippet ? (
					<span className="mt-0.5 block truncate font-mono text-[11px] text-text-tertiary">
						{promptSnippet.hasLeadingEllipsis ? "…" : ""}
						{renderFuzzyHighlightedText(
							promptSnippet.text,
							promptSnippet.matchCharacterPositions,
							HIGHLIGHTED_TEXT_STYLE,
						)}
						{promptSnippet.hasTrailingEllipsis ? "…" : ""}
					</span>
				) : null}
			</span>
		</button>
	);
}
