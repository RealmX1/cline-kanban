import type { RuntimeAgentCurrentWorkPhaseGoal, RuntimeTaskSessionSummary } from "./api-contract";

// 显式目标优先；用户新输入之前的目标只能显示为历史，原生更新不能让旧事件复活。
export function resolveAgentCurrentWorkPhaseGoalForDisplay(
	summary: RuntimeTaskSessionSummary | null | undefined,
): (RuntimeAgentCurrentWorkPhaseGoal & { isHistorical: boolean }) | null {
	if (!summary) return null;
	const nativeSessionId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
	const candidates = [summary.agentCurrentWorkPhaseGoal, summary.agentNativeCurrentWorkPhaseGoal].filter(
		(goal): goal is RuntimeAgentCurrentWorkPhaseGoal =>
			Boolean(
				goal &&
					goal.owningKanbanTaskConversationSessionId === summary.taskId &&
					(goal.owningNativeConversationSessionId
						? goal.owningNativeConversationSessionId === nativeSessionId
						: goal.owningRuntimeSessionIncarnationId === (summary.runtimeSessionIncarnationId ?? null)),
			),
	);
	const invalidatedAt = summary.agentCurrentWorkPhaseGoalInvalidatedAt ?? -1;
	const current = candidates.find(
		(goal) =>
			goal.updatedAt > invalidatedAt &&
			(!goal.owningRuntimeSessionIncarnationId ||
				goal.owningRuntimeSessionIncarnationId === summary.runtimeSessionIncarnationId),
	);
	const selected = current ?? candidates[0];
	return selected
		? {
				...selected,
				isHistorical:
					selected.updatedAt <= invalidatedAt ||
					Boolean(
						selected.owningRuntimeSessionIncarnationId &&
							selected.owningRuntimeSessionIncarnationId !== summary.runtimeSessionIncarnationId,
					),
			}
		: null;
}

export function projectUniqueNativeInProgressWorkPhaseGoal(
	entries: ReadonlyArray<{ status: string; content?: string; subject?: string; activeForm?: string }>,
): string | null {
	const active = entries.filter((entry) => entry.status === "in_progress");
	if (active.length !== 1) return null;
	const text = (
		active[0]?.activeForm?.trim() ||
		active[0]?.subject?.trim() ||
		active[0]?.content?.trim() ||
		""
	).replace(/\s+/gu, " ");
	return text && text.length <= 160 ? text : null;
}

export function mergeWorkPhaseGoalConversationOwnership(
	previous: RuntimeTaskSessionSummary,
	merged: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	const previousNativeId = previous.agentNativeConversationSessionIdentity?.nativeSessionId;
	const nextNativeId = merged.agentNativeConversationSessionIdentity?.nativeSessionId;
	if (nextNativeId && previousNativeId && nextNativeId !== previousNativeId) {
		return {
			...merged,
			agentCurrentWorkPhaseGoal: null,
			agentNativeCurrentWorkPhaseGoal: null,
			agentCurrentWorkPhaseGoalInvalidatedAt: undefined,
		};
	}
	return merged;
}
