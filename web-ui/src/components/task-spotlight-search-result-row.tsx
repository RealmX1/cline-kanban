import type { CSSProperties } from "react";

import { renderFuzzyHighlightedText } from "@/components/shared/render-fuzzy-highlighted-text";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveSpotlightStageLabel } from "@/hooks/use-task-spotlight-search-controller";
import type { TaskBoardSearchResult } from "@/search/task-board-search";
import { buildPromptMatchSnippet } from "@/search/task-search-prompt-match-snippet";
import type { BoardColumnId } from "@/types";

const HIGHLIGHTED_TEXT_STYLE: CSSProperties = {
	color: "var(--color-status-gold)",
	fontWeight: 600,
};

// 与文本高亮同源的金色：task id 全等命中即整体高亮，不需要字符级位置集。
const TASK_ID_BADGE_STYLE: CSSProperties = {
	color: "var(--color-status-gold)",
	borderColor: "var(--color-status-gold)",
};

// prompt 命中片段的截窗半径（字符）。
const PROMPT_SNIPPET_WINDOW_RADIUS = 48;

// title 与 prompt 皆空时的主行占位。既有文本搜索永远匹配不到这种任务，所以从没出现过；
// task id 搜索**会**把它捞出来，不兜底就是一条空行。
const MISSING_PRIMARY_TEXT_PLACEHOLDER = "Untitled task";

export function TaskSpotlightSearchResultRow({
	result,
	isActive,
	isCrossProject,
	shouldUseMobileMinimumTouchTarget,
	onSelect,
	onHover,
}: {
	result: TaskBoardSearchResult;
	isActive: boolean;
	isCrossProject: boolean;
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
	// 只有 task id 命中的行显示 id 徽标：这类行在 title / prompt 上通常没有任何高亮，
	// 不显 id 用户就不知道它凭什么被顶到最前。
	const shouldRenderTaskIdBadge = result.matchSources.includes("taskId");
	// 仅「主行展示 title、且 prompt 命中而 title 未命中」时才补下方 prompt 片段行：此时主行（title）无法展示
	// prompt 命中，需 snippet 补救；semantic-only（无位置集）不展示片段，只显徽标。title 为空时主行已直接展示
	// 带高亮的 prompt，无需再补 snippet（否则与主行重复展示同一段 prompt 高亮）。
	const shouldRenderPromptMatchSnippet =
		hasTitle && result.promptMatchCharacterPositions.size > 0 && result.titleMatchCharacterPositions.size === 0;
	const promptSnippet = shouldRenderPromptMatchSnippet
		? buildPromptMatchSnippet(document.prompt, result.promptMatchCharacterPositions, PROMPT_SNIPPET_WINDOW_RADIUS)
		: null;

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
					<span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
						{primaryText.length > 0 ? (
							renderFuzzyHighlightedText(primaryText, primaryMatchCharacterPositions, HIGHLIGHTED_TEXT_STYLE)
						) : (
							<span className="text-text-tertiary">{MISSING_PRIMARY_TEXT_PLACEHOLDER}</span>
						)}
					</span>
					<span className="inline-flex shrink-0 items-center gap-1.5">
						{shouldRenderTaskIdBadge ? (
							<span
								className="inline-flex h-4 items-center rounded-sm border bg-surface-2 px-1.5 font-mono text-[10px] font-medium"
								style={TASK_ID_BADGE_STYLE}
							>
								{document.taskId}
							</span>
						) : null}
						{isCrossProject ? (
							<span className="inline-flex h-4 max-w-[140px] items-center truncate rounded-sm border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-secondary">
								{document.projectName}
							</span>
						) : null}
						<span className="inline-flex h-4 items-center rounded-sm border border-border bg-surface-2 px-1.5 text-[10px] font-medium text-text-secondary">
							{stageLabel}
						</span>
					</span>
				</span>
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
