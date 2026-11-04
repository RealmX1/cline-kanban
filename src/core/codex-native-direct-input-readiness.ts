import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "./api-contract";
import { buildCodexNativeAgentTurnExecutionSemanticGuard } from "./codex-native-agent-turn-execution-observation";
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
		isUnchangedCodexNeedsInputReconciliationCandidate(summaryBeforeRead, current) &&
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

export function isUnchangedCodexNeedsInputReconciliationCandidate(
	before: RuntimeTaskSessionSummary,
	current: RuntimeTaskSessionSummary,
): boolean {
	return (
		isCodexNeedsInputNativeReconciliationCandidate(before) &&
		isCodexNeedsInputNativeReconciliationCandidate(current) &&
		buildCodexNativeAgentTurnExecutionSemanticGuard(before) ===
			buildCodexNativeAgentTurnExecutionSemanticGuard(current)
	);
}
