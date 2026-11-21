import { resolveCurrentAgentProcessUserTurnIdleRetentionStarted } from "./agent-conversation-activity-observation";
import type {
	RuntimeLastEffectiveAgentConversationActivityObservation,
	RuntimeTaskSessionSummary,
} from "./api-contract";
import { resolveSessionFacets } from "./session-activity";

// 执行状态不属于有效活动：重复核验不能推进活动、缓存、接受边沿或回合序号。
export interface CodexNativeAgentTurnExecutionObservation {
	workspaceId: string;
	conversationSessionId: string;
	runtimeSessionIncarnationId: string;
	nativeSessionId: string;
	nativeTurnId: string | null;
	nativeTurnStartedAtMs: number | null;
	observedAtMs: number;
	threadStatus: string;
	nativeTurnStatus: string | null;
	nativeTurnErrorMessage?: string | null;
	nativeTurnFinishedAtMs?: number;
	source?: "persisted_codex_turn_completion";
	activeFlags: string[];
	canAcceptDirectInput: boolean | null;
	executionStatus: "running" | "waiting_for_user" | "finished" | "unknown";
	latestSameNativeTurnPersistedToolActivityObservation?: RuntimeLastEffectiveAgentConversationActivityObservation;
}

export function buildCodexNativeAgentTurnExecutionIdentity(summary: RuntimeTaskSessionSummary): string {
	const identity = summary.agentNativeConversationSessionIdentity;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	return JSON.stringify([
		summary.taskId,
		summary.agentId,
		summary.workspacePath,
		summary.pid,
		summary.startedAt,
		summary.runtimeSessionIncarnationId,
		identity?.sourceAgentId,
		identity?.nativeSessionId,
		identity?.transcriptPath,
		endpoint?.workspaceId,
		endpoint?.conversationSessionId,
		endpoint?.runtimeSessionIncarnationId,
		endpoint?.socketPath,
	]);
}

// 不比较 updatedAt / lastOutputAt：PTY 重绘不能使一份仍属于本回合的状态证明永久失效。
export function buildCodexNativeAgentTurnExecutionSemanticGuard(summary: RuntimeTaskSessionSummary): string {
	return JSON.stringify([
		buildCodexNativeAgentTurnExecutionIdentity(summary),
		resolveSessionFacets(summary),
		summary.reviewReason,
		summary.lastHookAt,
		summary.latestHookActivity,
		summary.agentResponseGenerationTurnSequence,
		summary.agentResponseGenerationTurnStarted,
		summary.agentConversationPromptSubmissionAcceptance,
		summary.lastEffectiveAgentConversationActivityObservation,
		summary.lastAgentConversationUserHandoffObservation,
		resolveCurrentAgentProcessUserTurnIdleRetentionStarted(summary),
		summary.awaitingDispatchedBackgroundWork,
		summary.taskConversationSessionMetadata,
	]);
}

export function isCodexReviewMisclassificationNativeReconciliationCandidate(
	summary: RuntimeTaskSessionSummary,
): boolean {
	const facets = resolveSessionFacets(summary);
	const retention = resolveCurrentAgentProcessUserTurnIdleRetentionStarted(summary);
	return (
		summary.agentId === "codex" &&
		facets.liveness === "live" &&
		facets.turnOwner === "user" &&
		facets.userTurnKind === "review" &&
		(summary.reviewReason === "idle_stall" || summary.reviewReason === "hook") &&
		retention?.turnSequence === summary.agentResponseGenerationTurnSequence &&
		retention?.signalConfidence ===
			(summary.reviewReason === "hook" ? "harness_turn_complete" : "prompt_ready_fallback") &&
		!summary.awaitingDispatchedBackgroundWork &&
		!summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover
	);
}

export function shouldContinuouslyObserveCodexNativeTurnExecution(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	return (
		summary.agentId === "codex" &&
		facets.liveness === "live" &&
		(!summary.awaitingDispatchedBackgroundWork ||
			(summary.awaitingDispatchedBackgroundWork.owningCommandExecutionIds?.length ?? 0) > 0) &&
		(facets.turnOwner === "agent" || isCodexReviewMisclassificationNativeReconciliationCandidate(summary))
	);
}

export function isCurrentCodexNativeAgentTurnExecutionObservation(
	before: RuntimeTaskSessionSummary,
	current: RuntimeTaskSessionSummary,
	observation: CodexNativeAgentTurnExecutionObservation,
): boolean {
	const endpoint = current.codexNativeSessionControlEndpoint;
	return (
		buildCodexNativeAgentTurnExecutionSemanticGuard(before) ===
			buildCodexNativeAgentTurnExecutionSemanticGuard(current) &&
		current.agentId === "codex" &&
		current.pid !== null &&
		current.runtimeSessionIncarnationId === observation.runtimeSessionIncarnationId &&
		current.taskId === observation.conversationSessionId &&
		current.agentNativeConversationSessionIdentity?.sourceAgentId === "codex" &&
		current.agentNativeConversationSessionIdentity.nativeSessionId === observation.nativeSessionId &&
		endpoint?.workspaceId === observation.workspaceId &&
		endpoint.conversationSessionId === observation.conversationSessionId &&
		endpoint.runtimeSessionIncarnationId === observation.runtimeSessionIncarnationId &&
		Number.isFinite(observation.observedAtMs) &&
		observation.observedAtMs >= (current.startedAt ?? 0)
	);
}

export function canCorrectCodexReviewMisclassificationForSameNativeTurn(
	summary: RuntimeTaskSessionSummary,
	observation: CodexNativeAgentTurnExecutionObservation,
): boolean {
	if (
		!isCodexReviewMisclassificationNativeReconciliationCandidate(summary) ||
		observation.executionStatus !== "running" ||
		observation.threadStatus !== "active" ||
		observation.nativeTurnStatus !== "inProgress" ||
		observation.activeFlags.length !== 0 ||
		!observation.nativeTurnId
	)
		return false;
	const retention = resolveCurrentAgentProcessUserTurnIdleRetentionStarted(summary);
	const turnSequence = summary.agentResponseGenerationTurnSequence;
	if (
		!retention ||
		retention.signalConfidence !==
			(summary.reviewReason === "hook" ? "harness_turn_complete" : "prompt_ready_fallback") ||
		retention.turnSequence !== turnSequence ||
		observation.nativeTurnStartedAtMs === null ||
		!Number.isFinite(observation.nativeTurnStartedAtMs) ||
		observation.nativeTurnStartedAtMs > retention.stoppedAt ||
		observation.observedAtMs < retention.stoppedAt
	)
		return false;
	const eventPrefix = `codex:${observation.nativeSessionId}:${observation.nativeTurnId}:`;
	if (summary.reviewReason === "hook" || retention.latestCodexStopHookBoundary) {
		const activity =
			observation.latestSameNativeTurnPersistedToolActivityObservation ??
			summary.lastEffectiveAgentConversationActivityObservation;
		const stopBoundary = retention.latestCodexStopHookBoundary;
		if (
			stopBoundary &&
			(stopBoundary.nativeSessionId !== observation.nativeSessionId ||
				stopBoundary.runtimeSessionIncarnationId !== observation.runtimeSessionIncarnationId)
		)
			return false;
		const stoppedAtMs = Math.max(retention.stoppedAt, stopBoundary?.observedAtMs ?? 0);
		return (
			activity?.activityKind === "tool_activity" &&
			activity.evidenceKind === "persisted_agent_transcript" &&
			activity.nativeSessionId === observation.nativeSessionId &&
			activity.eventId?.startsWith(eventPrefix) === true &&
			activity.observedAtMs > stoppedAtMs &&
			activity.observedAtMs <= observation.observedAtMs
		);
	}
	// 仅采信已持有的原生消息关联；同 cwd、同 PID 或当前 active 都不足以证明误判发生在哪一回合。
	return (
		summary.agentConversationPromptSubmissionAcceptance?.eventId?.startsWith(eventPrefix) === true ||
		summary.lastEffectiveAgentConversationActivityObservation?.eventId?.startsWith(eventPrefix) === true
	);
}

export function isCodexNativeTerminalOutcomeForCurrentTurn(
	summary: RuntimeTaskSessionSummary,
	observation: CodexNativeAgentTurnExecutionObservation,
): boolean {
	const nativeTurnId = observation.nativeTurnId;
	const turnStartedAtMs = observation.nativeTurnStartedAtMs;
	if (observation.executionStatus !== "finished" || !nativeTurnId || turnStartedAtMs === null) return false;
	const acceptance = summary.agentConversationPromptSubmissionAcceptance;
	if ((observation.nativeTurnFinishedAtMs ?? observation.observedAtMs) < (acceptance?.attemptedAtMs ?? 0))
		return false;
	const acceptanceEventId = acceptance?.status === "accepted" ? acceptance.eventId : null;
	const nativeEventPrefix = `codex:${observation.nativeSessionId}:`;
	const startedAtMs = summary.startedAt ?? 0;
	if (turnStartedAtMs < Math.floor(startedAtMs / 1_000) * 1_000) return false;
	if (acceptanceEventId?.startsWith("codex:"))
		return acceptanceEventId.startsWith(`${nativeEventPrefix}${nativeTurnId}:`);
	// 秒精度的控制面开始时间不能替未确认的新输入排定同一秒内的顺序。
	if (
		acceptance &&
		(turnStartedAtMs < acceptance.attemptedAtMs ||
			(turnStartedAtMs === acceptance.attemptedAtMs && observation.source !== "persisted_codex_turn_completion"))
	)
		return false;
	const currentTurnStartedAtMs = summary.agentResponseGenerationTurnStarted?.startedAt ?? startedAtMs;
	return turnStartedAtMs >= Math.floor(currentTurnStartedAtMs / 1_000) * 1_000;
}
