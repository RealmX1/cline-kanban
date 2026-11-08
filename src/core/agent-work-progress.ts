import { resolveAgentCurrentWorkPhaseGoalForDisplay } from "./agent-current-work-phase-goal";
import type {
	RuntimeAgentCurrentWorkPhaseGoal,
	RuntimeAgentWorkProgressEntry,
	RuntimeRecordCurrentTaskProgressRequest,
	RuntimeTaskSessionSummary,
} from "./api-contract";

export function preservePersistedAgentWorkProgressEntriesAgainstStaleSnapshot(
	persistedEntries: RuntimeAgentWorkProgressEntry[] | undefined,
	incomingEntries: RuntimeAgentWorkProgressEntry[] | undefined,
): RuntimeAgentWorkProgressEntry[] | undefined {
	if (!persistedEntries?.length) return incomingEntries;
	const entries = new Map(persistedEntries.map((entry) => [entry.progressEntryId, entry]));
	for (const incoming of incomingEntries ?? []) {
		const persisted = entries.get(incoming.progressEntryId);
		if (
			!persisted ||
			(persisted.progressMutationFingerprint === incoming.progressMutationFingerprint &&
				persisted.outcome === "in_progress" &&
				incoming.updatedAt >= persisted.updatedAt)
		)
			entries.set(incoming.progressEntryId, incoming);
	}
	return [...entries.values()];
}

export function resolveAgentWorkProgressEntriesForDisplay(summary: RuntimeTaskSessionSummary | null | undefined) {
	return (summary?.agentWorkProgressEntries ?? [])
		.filter((entry) => entry.owningKanbanTaskConversationSessionId === summary?.taskId)
		.map((entry) => ({
			...entry,
			isHistorical:
				entry.outcome === "in_progress" &&
				(entry.updatedAt <= (summary?.agentCurrentWorkPhaseGoalInvalidatedAt ?? -1) ||
					(entry.owningNativeConversationSessionId
						? entry.owningNativeConversationSessionId !==
							summary?.agentNativeConversationSessionIdentity?.nativeSessionId
						: entry.owningRuntimeSessionIncarnationId !== (summary?.runtimeSessionIncarnationId ?? null))),
		}));
}

export function advanceAgentWorkProgress(
	summary: RuntimeTaskSessionSummary,
	request: RuntimeRecordCurrentTaskProgressRequest,
	progressMutationFingerprint: string,
	now: number,
): RuntimeAgentWorkProgressEntry[] {
	const existing = summary.agentWorkProgressEntries ?? [];
	const replay = existing.find((entry) => entry.progressEntryId === request.progressEntryId);
	if (replay) {
		if (replay.progressMutationFingerprint !== progressMutationFingerprint)
			throw new Error("进展条目身份已用于不同内容，请读取现有记录后使用新的身份。");
		return existing;
	}
	const entries = existing.map((entry) => ({ ...entry }));
	const current = resolveAgentWorkProgressEntriesForDisplay(summary)
		.filter(
			(entry) =>
				entry.outcome === "in_progress" &&
				(entry.owningNativeConversationSessionId
					? entry.owningNativeConversationSessionId ===
						summary.agentNativeConversationSessionIdentity?.nativeSessionId
					: entry.owningRuntimeSessionIncarnationId === (summary.runtimeSessionIncarnationId ?? null)),
		)
		.at(-1);
	if (current?.progressEntryId !== request.previousProgressEntryId)
		throw new Error("上一条当前进展已变化，请读取最新进展后再更新。");
	if (request.previousProgressEntryId) {
		const previous = entries.find((entry) => entry.progressEntryId === request.previousProgressEntryId);
		if (!previous || previous.outcome !== "in_progress") throw new Error("上一条进展不能再次改变结果。");
		previous.outcome = request.previousProgressEntryOutcome ?? "outcome_unknown";
		previous.outcomeExplanation = request.outcomeExplanation;
		previous.updatedAt = Math.max(now, previous.updatedAt + 1);
	}
	if (!entries.length) {
		const legacy = resolveAgentCurrentWorkPhaseGoalForDisplay(summary);
		if (legacy)
			entries.push({
				progressEntryId: `legacy-phase-goal-${legacy.updatedAt}`,
				progressText: legacy.goalText,
				outcome: "outcome_unknown",
				recordedAt: legacy.updatedAt,
				updatedAt: legacy.updatedAt,
				owningKanbanTaskConversationSessionId: summary.taskId,
				owningNativeConversationSessionId: legacy.owningNativeConversationSessionId,
				owningRuntimeSessionIncarnationId: legacy.owningRuntimeSessionIncarnationId ?? null,
				progressMutationFingerprint: "legacy-phase-goal-result-unrecorded",
			});
	}
	entries.push({
		progressEntryId: request.progressEntryId,
		progressText: request.progressText,
		outcome: request.progressEntryOutcome ?? "in_progress",
		outcomeExplanation:
			request.progressEntryOutcome === "completed" || request.progressEntryOutcome === "abandoned"
				? request.outcomeExplanation
				: undefined,
		recordedAt: now,
		updatedAt: Math.max(now, (summary.agentCurrentWorkPhaseGoalInvalidatedAt ?? -1) + 1),
		owningKanbanTaskConversationSessionId: summary.taskId,
		owningNativeConversationSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
		owningRuntimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
		progressMutationFingerprint,
	});
	return entries;
}

export function projectLegacyWorkPhaseGoalIntoExistingProgress(
	summary: RuntimeTaskSessionSummary,
	goal: RuntimeAgentCurrentWorkPhaseGoal | null,
	now: number,
): RuntimeAgentWorkProgressEntry[] | undefined {
	if (!summary.agentWorkProgressEntries?.length) return undefined;
	const entries = summary.agentWorkProgressEntries.map((entry) =>
		entry.outcome === "in_progress"
			? { ...entry, outcome: "outcome_unknown" as const, updatedAt: Math.max(now, entry.updatedAt + 1) }
			: entry,
	);
	if (goal)
		entries.push({
			progressEntryId: `legacy-phase-goal-${goal.updatedAt}-${entries.length}`,
			progressText: goal.goalText,
			outcome: "in_progress",
			recordedAt: goal.updatedAt,
			updatedAt: goal.updatedAt,
			owningKanbanTaskConversationSessionId: summary.taskId,
			owningNativeConversationSessionId: goal.owningNativeConversationSessionId,
			owningRuntimeSessionIncarnationId: goal.owningRuntimeSessionIncarnationId ?? null,
			progressMutationFingerprint: "legacy-phase-goal-result-unrecorded",
		});
	return entries;
}
