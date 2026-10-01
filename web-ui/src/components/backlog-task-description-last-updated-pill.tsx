import { resolveTaskDescriptionLastUpdatedAt } from "@runtime-task-state";
import { PencilLine } from "lucide-react";
import { useMemo } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardCard } from "@/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

/**
 * Backlog 卡片头部药丸条里的一段：Description（prompt 文本 + 附图）最后一次内容变化至今的时长——也就是
 * Backlog 列的排序键。与左侧 Clock 段（创建时间）读的是两个不同字段，从未编辑过时两者相等但仍都显示，
 * 让排序依据始终可见。
 * EXPERIMENT_NODE: 从未编辑过（值等于 createdAt）时是否隐藏这一段，以减少头部药丸条的重复读数
 */
export function BacklogTaskDescriptionLastUpdatedPill({
	card,
	elapsedNowMs,
	revealHoverActionTooltip,
}: {
	card: BoardCard;
	elapsedNowMs: number;
	// 由 TaskCardBody 提供的 hover 门控（只在卡片 hover 时挂 tooltip），契约见那里的注释。
	revealHoverActionTooltip: (label: string | null) => string | undefined;
}): React.ReactElement {
	const taskDescriptionLastUpdatedAt = resolveTaskDescriptionLastUpdatedAt(card);
	// toLocaleString 不便宜，而卡片会随粗时钟 / hover 反复重渲，时间戳本身极少变化。
	const tooltipContent = useMemo(
		() => `Description last updated · ${new Date(taskDescriptionLastUpdatedAt).toLocaleString()}`,
		[taskDescriptionLastUpdatedAt],
	);
	return (
		<Tooltip content={revealHoverActionTooltip(tooltipContent)}>
			<span
				data-backlog-task-description-last-updated-pill=""
				className="inline-flex items-center gap-0.5 text-[10px] leading-none text-text-secondary"
			>
				<PencilLine size={8} className="shrink-0" />
				{formatCompactElapsedSince(taskDescriptionLastUpdatedAt, elapsedNowMs)}
			</span>
		</Tooltip>
	);
}
