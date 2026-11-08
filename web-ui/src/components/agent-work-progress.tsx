import {
	resolveAgentCurrentWorkPhaseGoalForDisplay,
	resolveAgentWorkProgressEntriesForDisplay,
} from "@runtime-session-activity";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function AgentWorkProgress({
	summary,
	isProgressHistoryVisible = false,
}: {
	summary: RuntimeTaskSessionSummary | null | undefined;
	isProgressHistoryVisible?: boolean;
}) {
	const goal = resolveAgentCurrentWorkPhaseGoalForDisplay(summary);
	const entries = resolveAgentWorkProgressEntriesForDisplay(summary);
	if (entries.length) {
		const renderProgressEntry = (entry: (typeof entries)[number]) => (
			<div key={entry.progressEntryId} className="flex min-w-0 gap-1" title={entry.outcomeExplanation}>
				<span
					role="img"
					className="shrink-0 text-text-tertiary"
					aria-label={
						entry.outcome === "completed"
							? "已完成"
							: entry.outcome === "abandoned"
								? "已放弃"
								: entry.outcome === "outcome_unknown"
									? "结果未记录"
									: "正在进行"
					}
				>
					{entry.outcome === "completed"
						? "✓"
						: entry.outcome === "abandoned"
							? "✗"
							: entry.outcome === "outcome_unknown"
								? "?"
								: "●"}
				</span>
				<span className={entry.outcome === "abandoned" ? "break-words line-through" : "break-words"}>
					{entry.isHistorical ? "上次进展：" : ""}
					{entry.progressText}
					{entry.outcome === "outcome_unknown" ? "（结果未记录）" : ""}
				</span>
			</div>
		);
		return (
			<div className="mt-1 space-y-1 text-[11px] leading-snug text-text-secondary" data-agent-work-progress="">
				{entries.slice(-1).map(renderProgressEntry)}
				{isProgressHistoryVisible && entries.length > 1 ? (
					<details className="space-y-1">
						<summary className="cursor-pointer text-text-tertiary">历史进展（{entries.length - 1}）</summary>
						{entries.slice(0, -1).map(renderProgressEntry)}
					</details>
				) : null}
			</div>
		);
	}
	if (!goal) return null;
	return (
		<div
			className="mt-1 flex min-w-0 gap-1 text-[11px] leading-snug text-text-secondary"
			data-agent-current-work-phase-goal=""
			data-work-phase-goal-historical={goal.isHistorical}
			title={goal.goalText}
		>
			<span className="shrink-0 text-text-tertiary">
				{goal.isHistorical ? "上次进展" : "当前进展"}（结果未记录）
			</span>
			<span className={isProgressHistoryVisible ? "break-words" : "line-clamp-2 break-words"}>{goal.goalText}</span>
		</div>
	);
}
