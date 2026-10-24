import type { QueuedTaskPromptDeliveryEntry, RuntimeTaskSessionSummary } from "./api-contract";
import { resolveSessionFacets } from "./session-activity";

// runtime 热重启不会必然停止 PTY。只对明确零投递、同代活体仍被持有的查询等待恢复托管。
export function resolveNativeIndependentUserTurnPreflightRestartRecovery(input: {
	entry: QueuedTaskPromptDeliveryEntry;
	summary: RuntimeTaskSessionSummary | null | undefined;
	workspaceId: string;
	nowEpochMs: number;
}): "not_eligible" | "awaiting_session_evidence" | "same_session_verified" | "session_replaced" {
	const { entry, summary } = input;
	if (
		!entry.nativeIndependentUserTurnPreflightQueryRecovery ||
		entry.deliveryState !== "queued" ||
		entry.deliveryAttemptCount !== 0 ||
		entry.claimedForSessionIncarnationId !== null ||
		entry.dispatchIdempotencyKey !== null ||
		!entry.requiredNativeIndependentUserTurnSessionId ||
		entry.expiresAt <= input.nowEpochMs ||
		!entry.programmaticInjectionLedgerReceiptLink
	)
		return "not_eligible";
	if (!summary) return "awaiting_session_evidence";
	if (
		summary.agentId !== "codex" ||
		resolveSessionFacets(summary).liveness !== "live" ||
		summary.runtimeSessionIncarnationId !== entry.requiredNativeIndependentUserTurnSessionIncarnationId
	)
		return "session_replaced";
	// 同代活体的原生身份可能尚未水合；没有身份不是身份已经改变的证据。
	const nativeIdentity = summary.agentNativeConversationSessionIdentity;
	if (!nativeIdentity) return "awaiting_session_evidence";
	if (nativeIdentity.nativeSessionId !== entry.requiredNativeIndependentUserTurnSessionId) return "session_replaced";
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (!endpoint) return "awaiting_session_evidence";
	return endpoint.workspaceId === input.workspaceId &&
		endpoint.conversationSessionId === entry.taskId &&
		endpoint.runtimeSessionIncarnationId === entry.requiredNativeIndependentUserTurnSessionIncarnationId
		? "same_session_verified"
		: "session_replaced";
}
