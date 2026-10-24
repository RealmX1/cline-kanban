import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "./api-contract";
import { resolveSessionFacets } from "./session-activity";

// 这是当前原生控制面的状态证明，不是用户提交被接受或对话发生新活动的证明。
export interface CodexNativeDirectInputReadinessObservation {
	nativeSessionId: string;
	observedAtMs: number;
}

export function isCodexNativeConversationRewindSignal(metadata: Partial<RuntimeTaskHookActivity> | undefined): boolean {
	return (
		metadata?.source === "codex" &&
		["thread_rolled_back", "thread_reverted", "conversation_reverted"].includes(metadata.hookEventName ?? "")
	);
}

export function isCodexNeedsInputNativeReconciliationCandidate(summary: RuntimeTaskSessionSummary): boolean {
	const facets = resolveSessionFacets(summary);
	return (
		summary.agentId === "codex" &&
		facets.turnOwner === "user" &&
		facets.liveness === "live" &&
		facets.userTurnKind === "needs_input"
	);
}

export function canReconcileCodexNeedsInputWithNativeDirectInputReadiness(
	summaryBeforeRead: RuntimeTaskSessionSummary,
	current: RuntimeTaskSessionSummary,
	observation: CodexNativeDirectInputReadinessObservation,
): boolean {
	const identity = current.agentNativeConversationSessionIdentity;
	const endpoint = current.codexNativeSessionControlEndpoint;
	return (
		isCodexNeedsInputNativeReconciliationCandidate(summaryBeforeRead) &&
		isCodexNeedsInputNativeReconciliationCandidate(current) &&
		current.updatedAt === summaryBeforeRead.updatedAt &&
		current.taskId === summaryBeforeRead.taskId &&
		current.reviewReason === summaryBeforeRead.reviewReason &&
		current.lastHookAt === summaryBeforeRead.lastHookAt &&
		current.latestHookActivity === summaryBeforeRead.latestHookActivity &&
		current.agentResponseGenerationTurnSequence === summaryBeforeRead.agentResponseGenerationTurnSequence &&
		JSON.stringify(current.agentConversationPromptSubmissionAcceptance) ===
			JSON.stringify(summaryBeforeRead.agentConversationPromptSubmissionAcceptance) &&
		current.pid !== null &&
		current.pid === summaryBeforeRead.pid &&
		current.startedAt === summaryBeforeRead.startedAt &&
		current.runtimeSessionIncarnationId != null &&
		current.runtimeSessionIncarnationId === summaryBeforeRead.runtimeSessionIncarnationId &&
		identity?.sourceAgentId === "codex" &&
		identity.nativeSessionId === observation.nativeSessionId &&
		identity.nativeSessionId === summaryBeforeRead.agentNativeConversationSessionIdentity?.nativeSessionId &&
		identity.transcriptPath === summaryBeforeRead.agentNativeConversationSessionIdentity?.transcriptPath &&
		endpoint != null &&
		endpoint.conversationSessionId === current.taskId &&
		endpoint.runtimeSessionIncarnationId === current.runtimeSessionIncarnationId &&
		endpoint.socketPath === summaryBeforeRead.codexNativeSessionControlEndpoint?.socketPath &&
		endpoint.workspaceId === summaryBeforeRead.codexNativeSessionControlEndpoint?.workspaceId &&
		Number.isFinite(observation.observedAtMs) &&
		observation.observedAtMs >= summaryBeforeRead.updatedAt
	);
}
