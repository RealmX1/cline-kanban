import type { RuntimeTaskSessionSummary } from "./api-contract";
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
	activeFlags: string[];
	canAcceptDirectInput: boolean | null;
	executionStatus: "running" | "waiting_for_user" | "finished" | "unknown";
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
		summary.lastAgentConversationUserHandoffObservation,
		summary.currentAgentProcessUserTurnIdleRetentionStarted,
		summary.awaitingDispatchedBackgroundWork,
	]);
}

export function isCodexIdleStallNativeReconciliationCandidate(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	return (
		summary.agentId === "codex" &&
		facets.liveness === "live" &&
		facets.turnOwner === "user" &&
		facets.userTurnKind === "review" &&
		summary.reviewReason === "idle_stall" &&
		!summary.awaitingDispatchedBackgroundWork
	);
}

export function shouldContinuouslyObserveCodexNativeTurnExecution(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	return (
		summary.agentId === "codex" &&
		facets.liveness === "live" &&
		!summary.awaitingDispatchedBackgroundWork &&
		(facets.turnOwner === "agent" || isCodexIdleStallNativeReconciliationCandidate(summary))
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

export function canCorrectCodexIdleStallForSameNativeTurn(
	summary: RuntimeTaskSessionSummary,
	observation: CodexNativeAgentTurnExecutionObservation,
): boolean {
	if (
		!isCodexIdleStallNativeReconciliationCandidate(summary) ||
		observation.executionStatus !== "running" ||
		!observation.nativeTurnId
	)
		return false;
	const retention = summary.currentAgentProcessUserTurnIdleRetentionStarted;
	const turnSequence = summary.agentResponseGenerationTurnSequence;
	if (
		!retention ||
		retention.signalConfidence !== "prompt_ready_fallback" ||
		retention.turnSequence !== turnSequence ||
		observation.nativeTurnStartedAtMs === null ||
		observation.nativeTurnStartedAtMs > retention.stoppedAt
	)
		return false;
	const eventPrefix = `codex:${observation.nativeSessionId}:${observation.nativeTurnId}:`;
	// 仅采信已持有的原生消息关联；同 cwd、同 PID 或当前 active 都不足以证明误判发生在哪一回合。
	return (
		summary.agentConversationPromptSubmissionAcceptance?.eventId?.startsWith(eventPrefix) === true ||
		summary.lastEffectiveAgentConversationActivityObservation?.eventId?.startsWith(eventPrefix) === true
	);
}
