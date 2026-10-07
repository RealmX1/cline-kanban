import { resolveAgentCurrentWorkPhaseGoalForDisplay } from "@runtime-session-activity";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function AgentCurrentWorkPhaseGoal({ summary }: { summary: RuntimeTaskSessionSummary | null | undefined }) {
	const goal = resolveAgentCurrentWorkPhaseGoalForDisplay(summary);
	if (!goal) return null;
	return (
		<div
			className="mt-1 flex min-w-0 gap-1 text-[11px] leading-snug text-text-secondary"
			data-agent-current-work-phase-goal=""
			data-work-phase-goal-historical={goal.isHistorical}
			title={goal.goalText}
		>
			<span className="shrink-0 text-text-tertiary">{goal.isHistorical ? "上次阶段目标" : "当前阶段目标"}</span>
			<span className="line-clamp-2 break-words">{goal.goalText}</span>
		</div>
	);
}
