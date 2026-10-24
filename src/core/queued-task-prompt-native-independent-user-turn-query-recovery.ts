import type { QueuedTaskPromptDeliveryEntry, RuntimeTaskSessionSummary } from "./api-contract";
import { resolveSessionFacets } from "./session-activity";

// 两个持久退避门都放行后才能重试；调度定时器与出队资格必须使用同一个最早合法时刻。
export function resolveNativeIndependentUserTurnQueryRetryNotBeforeEpochMs(
	entry: Pick<
		QueuedTaskPromptDeliveryEntry,
		"nativeIndependentUserTurnPreflightQueryRecovery" | "nativeIndependentUserTurnBeforeSubmissionQueryRecovery"
	>,
): number | null {
	const preflightRetryAtEpochMs = entry.nativeIndependentUserTurnPreflightQueryRecovery?.nextQueryRetryAtEpochMs;
	const beforeSubmissionRetryAtEpochMs =
		entry.nativeIndependentUserTurnBeforeSubmissionQueryRecovery?.nextQueryRetryAtEpochMs;
	if (preflightRetryAtEpochMs == null) return beforeSubmissionRetryAtEpochMs ?? null;
	return beforeSubmissionRetryAtEpochMs == null
		? preflightRetryAtEpochMs
		: Math.max(preflightRetryAtEpochMs, beforeSubmissionRetryAtEpochMs);
}

export function isNativeIndependentUserTurnSubmissionKnownNotStarted(entry: QueuedTaskPromptDeliveryEntry): boolean {
	return (
		["queued", "claimed_for_dispatch", "handed_to_transport"].includes(entry.deliveryState) &&
		entry.nativeIndependentUserTurnSubmissionProgress?.submissionMayHaveStartedAtEpochMs === null &&
		!!entry.requiredNativeIndependentUserTurnSessionId &&
		!!entry.requiredNativeIndependentUserTurnSessionIncarnationId &&
		!!entry.programmaticInjectionLedgerReceiptLink
	);
}

export function buildNativeIndependentUserTurnQueryRecovery(input: {
	previous: QueuedTaskPromptDeliveryEntry["nativeIndependentUserTurnPreflightQueryRecovery"];
	failureReason: string | null;
	nowEpochMs: number;
	expiresAtEpochMs: number;
}): NonNullable<QueuedTaskPromptDeliveryEntry["nativeIndependentUserTurnPreflightQueryRecovery"]> {
	const { previous, nowEpochMs } = input;
	if (input.failureReason === null && previous)
		return { ...previous, recoveredAtEpochMs: nowEpochMs, nextQueryRetryAtEpochMs: null };
	const count = previous?.recoveredAtEpochMs === null ? previous.consecutiveQueryFailureCount + 1 : 1;
	return {
		consecutiveQueryFailureCount: count,
		waitingStartedAtEpochMs: previous?.recoveredAtEpochMs === null ? previous.waitingStartedAtEpochMs : nowEpochMs,
		lastQueryFailureAtEpochMs: nowEpochMs,
		lastQueryFailureReason: input.failureReason ?? "",
		nextQueryRetryAtEpochMs: Math.min(
			input.expiresAtEpochMs,
			nowEpochMs + Math.min(15_000, 1_000 * 2 ** Math.min(count - 1, 4)),
		),
		recoveredAtEpochMs: null,
	};
}

// runtime 热重启不会必然停止 PTY。只对明确零投递、同代活体仍被持有的查询等待恢复托管。
export function resolveNativeIndependentUserTurnPreflightRestartRecovery(input: {
	entry: QueuedTaskPromptDeliveryEntry;
	summary: RuntimeTaskSessionSummary | null | undefined;
	workspaceId: string;
	nowEpochMs: number;
}): "not_eligible" | "awaiting_session_evidence" | "same_session_verified" | "session_replaced" {
	const { entry, summary } = input;
	const submissionKnownNotStarted = isNativeIndependentUserTurnSubmissionKnownNotStarted(entry);
	if (
		(!submissionKnownNotStarted &&
			(!entry.nativeIndependentUserTurnPreflightQueryRecovery ||
				entry.deliveryState !== "queued" ||
				entry.deliveryAttemptCount !== 0 ||
				entry.claimedForSessionIncarnationId !== null ||
				entry.dispatchIdempotencyKey !== null)) ||
		!["queued", "claimed_for_dispatch", "handed_to_transport"].includes(entry.deliveryState) ||
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
