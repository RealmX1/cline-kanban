import type {
	RuntimeEffectiveAgentConversationActivityEvidenceKind,
	RuntimeLastAgentConversationPromptCacheReferenceObservation,
	RuntimeLastAgentConversationUserHandoffObservation,
	RuntimeLastEffectiveAgentConversationActivityObservation,
	RuntimeTaskConversationSessionActivityObservation,
	RuntimeTaskSessionSummary,
} from "./api-contract";
import { LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS } from "./last-conversation-progress-observation";

type CompatibleAgentConversationActivitySummary = Partial<
	Pick<
		RuntimeTaskSessionSummary,
		| "lastEffectiveAgentConversationActivityObservation"
		| "lastConversationProgressObservation"
		| "lastMainAgentConversationModelRequestDispatchObservation"
		| "lastSubstantiveOutputAt"
	>
>;

const EFFECTIVE_ACTIVITY_EVIDENCE_CONFIDENCE: Record<RuntimeEffectiveAgentConversationActivityEvidenceKind, number> = {
	terminal_output_heuristic_classification: 0,
	agent_lifecycle_hook_event: 2,
	structured_agent_session_event: 2,
	persisted_agent_transcript: 3,
	native_user_prompt_acceptance: 4,
};

export function isTrustedEffectiveAgentConversationActivityObservation(
	observation: RuntimeLastEffectiveAgentConversationActivityObservation | null | undefined,
): observation is RuntimeLastEffectiveAgentConversationActivityObservation {
	return (
		observation != null &&
		Number.isFinite(observation.observedAtMs) &&
		observation.observedAtMs > 0 &&
		observation.evidenceKind !== "terminal_output_heuristic_classification"
	);
}

// 旧盘只有可信语义观测可以迁移。前置提交 hook 不证明接受，实质 TUI 戳不证明会话活动。
export function resolveLastEffectiveAgentConversationActivityObservation(
	summary: CompatibleAgentConversationActivitySummary | null | undefined,
): RuntimeLastEffectiveAgentConversationActivityObservation | null {
	if (!summary) return null;
	if (summary.lastEffectiveAgentConversationActivityObservation !== undefined) {
		const current = summary.lastEffectiveAgentConversationActivityObservation;
		return isTrustedEffectiveAgentConversationActivityObservation(current) ? current : null;
	}
	const progress = summary.lastConversationProgressObservation;
	let candidate: RuntimeLastEffectiveAgentConversationActivityObservation | null =
		progress && progress.evidenceKind !== "terminal_output_heuristic_classification"
			? { ...progress, activityKind: "agent_output" }
			: null;
	const request = summary.lastMainAgentConversationModelRequestDispatchObservation;
	if (
		request &&
		request.evidenceKind !== "user_prompt_submit_hook_event_accepted" &&
		request.evidenceKind !== "before_agent_hook_event"
	) {
		const requestCandidate: RuntimeLastEffectiveAgentConversationActivityObservation = {
			observedAtMs: request.observedAtMs,
			evidenceKind: "agent_lifecycle_hook_event",
			activityKind:
				request.evidenceKind ===
					"manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request" ||
				request.evidenceKind ===
					"automatic_context_compaction_completed_continuation_model_request_follows_immediately"
					? "context_compaction"
					: "tool_activity",
		};
		if (candidate === null || requestCandidate.observedAtMs > candidate.observedAtMs) candidate = requestCandidate;
	}
	return isTrustedEffectiveAgentConversationActivityObservation(candidate) ? candidate : null;
}

export interface MergeLastEffectiveAgentConversationActivityObservationOptions {
	nowMs: number;
	allowCorrectionOfPreviousTerminalHeuristic?: boolean;
	isAgentResponseGenerationTurnInProgress?: boolean;
	futureObservationToleranceMs?: number;
}

// 单调归并不依赖 incarnation。只有明确标记的旧 TUI 猜测可以被持久转录纠偏。
export function mergeLastEffectiveAgentConversationActivityObservation(
	previous: RuntimeLastEffectiveAgentConversationActivityObservation | null | undefined,
	incoming: RuntimeLastEffectiveAgentConversationActivityObservation,
	options: MergeLastEffectiveAgentConversationActivityObservationOptions,
): RuntimeLastEffectiveAgentConversationActivityObservation | null {
	if (!isTrustedEffectiveAgentConversationActivityObservation(incoming)) return previous ?? null;
	if (
		incoming.observedAtMs >
		options.nowMs +
			(options.futureObservationToleranceMs ?? LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS)
	)
		return previous ?? null;
	const normalized = incoming.observedAtMs > options.nowMs ? { ...incoming, observedAtMs: options.nowMs } : incoming;
	if (
		previous?.eventId &&
		previous.eventId === normalized.eventId &&
		previous.nativeSessionId === normalized.nativeSessionId
	)
		return previous;
	if (
		previous?.evidenceKind === "terminal_output_heuristic_classification" &&
		normalized.evidenceKind === "persisted_agent_transcript" &&
		options.allowCorrectionOfPreviousTerminalHeuristic === true &&
		options.isAgentResponseGenerationTurnInProgress !== true
	)
		return normalized;
	if (!previous || normalized.observedAtMs > previous.observedAtMs) return normalized;
	if (
		normalized.observedAtMs === previous.observedAtMs &&
		EFFECTIVE_ACTIVITY_EVIDENCE_CONFIDENCE[normalized.evidenceKind] >
			EFFECTIVE_ACTIVITY_EVIDENCE_CONFIDENCE[previous.evidenceKind]
	)
		return normalized;
	return previous;
}

export function resolveLastAgentConversationUserHandoffObservation(
	summary:
		| Partial<
				Pick<
					RuntimeTaskSessionSummary,
					"lastAgentConversationUserHandoffObservation" | "agentResponseGenerationStopped"
				>
		  >
		| null
		| undefined,
): RuntimeLastAgentConversationUserHandoffObservation | null {
	// 旧 stopped 也曾由恢复产生，缺少真实边沿证明时不能升级成历史交棒。
	return summary?.lastAgentConversationUserHandoffObservation ?? null;
}

export function resolveCurrentAgentProcessUserTurnIdleRetentionStarted(
	summary:
		| Partial<
				Pick<
					RuntimeTaskSessionSummary,
					"currentAgentProcessUserTurnIdleRetentionStarted" | "agentResponseGenerationStopped"
				>
		  >
		| null
		| undefined,
): RuntimeTaskSessionSummary["currentAgentProcessUserTurnIdleRetentionStarted"] {
	if (!summary) return null;
	return summary.currentAgentProcessUserTurnIdleRetentionStarted !== undefined
		? summary.currentAgentProcessUserTurnIdleRetentionStarted
		: (summary.agentResponseGenerationStopped ?? null);
}

export function resolveLastAgentConversationPromptCacheReferenceObservation(
	summary:
		| Partial<
				Pick<
					RuntimeTaskSessionSummary,
					| "lastAgentConversationPromptCacheReferenceObservation"
					| "lastMainAgentConversationModelRequestDispatchObservation"
				>
		  >
		| null
		| undefined,
): RuntimeLastAgentConversationPromptCacheReferenceObservation | null {
	if (!summary) return null;
	return summary.lastAgentConversationPromptCacheReferenceObservation !== undefined
		? summary.lastAgentConversationPromptCacheReferenceObservation
		: (summary.lastMainAgentConversationModelRequestDispatchObservation ?? null);
}

export function recordEffectiveAgentConversationActivityPatch(
	observation: RuntimeLastEffectiveAgentConversationActivityObservation,
	promptCacheReferenceObservation?: RuntimeLastAgentConversationPromptCacheReferenceObservation | null,
): Partial<RuntimeTaskSessionSummary> {
	return {
		lastEffectiveAgentConversationActivityObservation: observation,
		...(promptCacheReferenceObservation !== undefined
			? { lastAgentConversationPromptCacheReferenceObservation: promptCacheReferenceObservation }
			: {}),
	};
}

type TaskConversationActivitySummary = CompatibleAgentConversationActivitySummary &
	Pick<RuntimeTaskSessionSummary, "taskId" | "agentId" | "taskConversationSessionMetadata">;

// 各会话独立记录；主绑定只决定谁用于主药丸和默认排序，不做所有活动的 max。
export function collectTaskConversationSessionActivityObservations(
	card: {
		id: string;
		mainTaskConversationSessionId?: string;
		taskMainSessionHandover?: { sourceTaskConversationSessionId: string };
	},
	summaries: Iterable<TaskConversationActivitySummary>,
): RuntimeTaskConversationSessionActivityObservation[] {
	const mainSessionId = card.mainTaskConversationSessionId ?? card.id;
	const observations = new Map<string, RuntimeTaskConversationSessionActivityObservation>();
	for (const summary of summaries) {
		const metadata = summary.taskConversationSessionMetadata;
		if (metadata ? metadata.workspaceTaskId !== card.id : summary.taskId !== card.id) continue;
		if (summary.taskId !== mainSessionId && summary.taskId !== card.id && metadata?.workspaceTaskId !== card.id)
			continue;
		const role: RuntimeTaskConversationSessionActivityObservation["role"] =
			summary.taskId === mainSessionId
				? "main"
				: summary.taskId === card.id ||
						summary.taskId === card.taskMainSessionHandover?.sourceTaskConversationSessionId ||
						metadata?.taskConversationSessionRoleAtCreation === "main" ||
						metadata?.taskConversationSessionRole === "main"
					? "former_main"
					: metadata?.taskConversationSessionRole === "by_the_way"
						? "by_the_way"
						: "task_collaborator";
		observations.set(summary.taskId, {
			sessionId: summary.taskId,
			role,
			agentId: summary.agentId,
			lastEffectiveAgentConversationActivityObservation:
				resolveLastEffectiveAgentConversationActivityObservation(summary),
		});
	}
	if (!observations.has(mainSessionId)) {
		observations.set(mainSessionId, {
			sessionId: mainSessionId,
			role: "main",
			agentId: null,
			lastEffectiveAgentConversationActivityObservation: null,
		});
	}
	return [...observations.values()].sort((left, right) => {
		if (left.role === "main") return right.role === "main" ? 0 : -1;
		if (right.role === "main") return 1;
		return left.sessionId.localeCompare(right.sessionId);
	});
}
