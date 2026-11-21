import { randomUUID } from "node:crypto";
import type { RuntimeAutomaticAgentFailureContinuation } from "../core/api-contract";

export type AutomaticFailureContinuationReason = RuntimeAutomaticAgentFailureContinuation["reason"];
export type AutomaticFailureContinuationTarget = Pick<
	RuntimeAutomaticAgentFailureContinuation,
	| "agentId"
	| "nativeTranscriptPath"
	| "executionWorkingDirectoryPath"
	| "ownerProcessId"
	| "workspaceId"
	| "taskId"
	| "taskIncarnationCreatedAtEpochMs"
	| "conversationSessionId"
	| "runtimeSessionIncarnationId"
	| "nativeSessionId"
	| "faultTurnIdentity"
>;
export interface AutomaticFailureContinuationAttemptResult {
	outcome:
		| "deferred"
		| "unconfirmed"
		| "accepted_running"
		| "accepted_failed"
		| "accepted_terminal_failure"
		| "accepted_finished"
		| "accepted_progressed"
		| "completed_without_submission"
		| "invalidated";
	blockingReason?: string;
	nativeTurnId?: string;
	requestWasInvoked?: boolean;
	nativeAcceptanceConfirmed?: boolean;
	retryableFailureReason?: AutomaticFailureContinuationReason;
}
const CAPACITY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const CONNECTION_BACKOFF_MS = [4_000, 15_000, 60_000, 240_000, 480_000];
const EVIDENCE_RECHECK_MS = [5_000, 15_000, 30_000, 60_000];
const TERMINAL_PHASES = new Set(["cancelled", "expired", "recovered", "failed"]);
export const ACCEPTED_EXECUTION_INTERRUPTED_BY_NEW_FAILURE = "accepted_execution_interrupted_by_new_failure";
/**
 * 只有确定还没到首字节写前标记，才恢复发送资格。
 * 已计入尝试、已做写前标记，或回执不能证明「一个字节都没写」时，保持只读核对。
 */
export function claudeAutomaticFailureContinuationMayStartWrite(input: {
	activeDeliveryAttemptCounted: boolean;
	activeDeliveryRequestMayHaveBeenSent?: boolean;
	hasManagedEntry: boolean;
	managedReceiptStatus?: string | null;
	managedReceiptReason?: string | null;
}): boolean {
	if (input.activeDeliveryAttemptCounted || input.activeDeliveryRequestMayHaveBeenSent) return false;
	if (!input.hasManagedEntry) return true;
	if (input.managedReceiptStatus == null) return true;
	return (
		input.managedReceiptStatus === "delivery_failed" &&
		(input.managedReceiptReason === "cancelled_before_delivery" ||
			input.managedReceiptReason === "session_ended_before_delivery")
	);
}
export function isAutomaticAgentFailureContinuationWaiting(
	record: RuntimeAutomaticAgentFailureContinuation | null | undefined,
): boolean {
	return !!record && !TERMINAL_PHASES.has(record.phase) && record.phase !== "executing";
}
export function isAutomaticAgentFailureContinuationActive(
	record: RuntimeAutomaticAgentFailureContinuation | null | undefined,
): boolean {
	return !!record && !TERMINAL_PHASES.has(record.phase);
}
export function hasCompletionReviewForSubmittedAutomaticFailureContinuation(
	record: RuntimeAutomaticAgentFailureContinuation,
): boolean {
	const pendingReview = record.pendingCompletionReview;
	const submissionStartedAtMs = record.activeDeliverySubmissionStartedAtMs ?? record.lastAttemptAtMs;
	return (
		!!record.activeDeliveryId &&
		pendingReview?.activeDeliveryId === record.activeDeliveryId &&
		submissionStartedAtMs != null &&
		pendingReview.observedAtMs >= Math.max(submissionStartedAtMs, record.lastErrorAtMs)
	);
}
export function createAutomaticAgentFailureContinuationCoordinator(port: {
	now: () => number;
	target: () => AutomaticFailureContinuationTarget;
	publish: (record: RuntimeAutomaticAgentFailureContinuation) => void;
	schedule: (delayMs: number) => void;
	clearScheduled: () => void;
	canAttempt: () => boolean;
	/** 模态等待等只否决这一次发送的原因。返回非空时不得取消 episode。 */
	softDeferralReason?: () => string | null;
	submit: (record: RuntimeAutomaticAgentFailureContinuation) => Promise<AutomaticFailureContinuationAttemptResult>;
}) {
	let record: RuntimeAutomaticAgentFailureContinuation | null = null;
	let inFlight = false;
	let suspendedForRuntimeShutdown = false;
	let manualRecheckRequestedWhileInFlight = false;
	const publish = () => {
		if (record) port.publish({ ...record });
	};
	const schedule = (delay: number) => {
		if (!record || suspendedForRuntimeShutdown) return;
		const next = port.now() + delay;
		record.nextCheckAtMs =
			record.deadlineAtMs !== null && record.phase !== "executing" ? Math.min(next, record.deadlineAtMs) : next;
		publish();
		port.schedule(Math.max(0, record.nextCheckAtMs - port.now()));
	};
	const finish = (phase: RuntimeAutomaticAgentFailureContinuation["phase"], reason: string) => {
		if (!record) return;
		if (
			phase === "recovered" &&
			(record.activeDeliverySubmissionStartedAtMs !== undefined ||
				record.activeDeliveryAttemptCounted ||
				record.activeDeliveryWasAccepted) &&
			!hasCompletionReviewForSubmittedAutomaticFailureContinuation(record)
		)
			record.pendingCompletionReview = undefined;
		record = {
			...record,
			phase,
			blockingReason: reason,
			nextCheckAtMs: null,
			...(phase === "cancelled" ? { faultTurnIdentity: port.target().faultTurnIdentity } : {}),
		};
		port.clearScheduled();
		publish();
	};
	const backoff = () => {
		const sequence = record?.reason === "model_capacity" ? CAPACITY_BACKOFF_MS : CONNECTION_BACKOFF_MS;
		const attempts =
			record?.reason === "model_capacity"
				? (record.capacityRetryAttemptCount ?? record.attemptCount)
				: (record?.attemptCount ?? 0);
		return sequence[Math.min(attempts, sequence.length - 1)];
	};
	const coordinator = {
		snapshot: () => (record ? { ...record } : null),
		suspendForRuntimeShutdown() {
			suspendedForRuntimeShutdown = true;
			manualRecheckRequestedWhileInFlight = false;
			port.clearScheduled();
		},
		markActiveDeliverySubmissionStarted(deliveryId: string) {
			if (
				suspendedForRuntimeShutdown ||
				record?.activeDeliveryId !== deliveryId ||
				!isAutomaticAgentFailureContinuationActive(record) ||
				record.activeDeliverySubmissionStartedAtMs !== undefined
			)
				return;
			// 登记投递仍属于旧回合；只有紧邻实际写出的边沿才开启新提示的交棒归属。
			record.activeDeliverySubmissionStartedAtMs = port.now();
			record.pendingCompletionReview = undefined;
			publish();
		},
		recordNativeRequestInvoked(deliveryId: string, reason: AutomaticFailureContinuationReason) {
			if (!record || record.activeDeliveryId !== deliveryId || record.activeDeliveryAttemptCounted) return;
			record.activeDeliveryAttemptCounted = true;
			record.attemptCount += 1;
			if (reason === "model_capacity")
				record.capacityRetryAttemptCount = (record.capacityRetryAttemptCount ?? 0) + 1;
			record.lastAttemptAtMs = port.now();
			publish();
		},
		recordNativeAcceptanceConfirmed(deliveryId: string) {
			if (!record || record.activeDeliveryId !== deliveryId || record.activeDeliveryWasAccepted) return;
			record.activeDeliveryWasAccepted = true;
			record.acceptedCount += 1;
			publish();
		},
		markTerminalRequestMayHaveBeenSent(
			deliveryId: string,
			cursor?: RuntimeAutomaticAgentFailureContinuation["terminalSubmissionTranscriptReadCursor"],
		) {
			if (
				suspendedForRuntimeShutdown ||
				record?.activeDeliveryId !== deliveryId ||
				!isAutomaticAgentFailureContinuationActive(record)
			)
				return false;
			record.activeDeliveryRequestMayHaveBeenSent = true;
			if (cursor) record.terminalSubmissionTranscriptReadCursor = cursor;
			publish();
			return true;
		},
		bindTaskIncarnation(createdAtMs: number | null) {
			if (record) {
				record.taskIncarnationCreatedAtEpochMs = createdAtMs;
				publish();
			}
		},
		bindNativeSession(nativeSessionId: string, transcriptPath: string | null) {
			if (record) {
				record.nativeSessionId = nativeSessionId;
				record.nativeTranscriptPath = transcriptPath;
				publish();
			}
		},
		bindCurrentProcess(incarnationId: string | null, pid: number | null) {
			if (record) {
				record.runtimeSessionIncarnationId = incarnationId;
				record.ownerProcessId = pid;
				publish();
			}
		},
		restore(saved: RuntimeAutomaticAgentFailureContinuation) {
			record = { ...saved };
			if (isAutomaticAgentFailureContinuationActive(record)) {
				if (record.activeDeliveryId) record.phase = "reconciling_acceptance";
				schedule(Math.max(0, (saved.nextCheckAtMs ?? port.now()) - port.now()));
			} else publish();
		},
		observeFailure(reason: AutomaticFailureContinuationReason, nativeTurnId: string | null = null) {
			if (suspendedForRuntimeShutdown) return;
			const target = port.target();
			if (
				record &&
				!isAutomaticAgentFailureContinuationActive(record) &&
				(record.faultTurnIdentity === target.faultTurnIdentity ||
					(nativeTurnId && record.faultNativeTurnId === nativeTurnId))
			)
				return;
			if (record && isAutomaticAgentFailureContinuationActive(record)) {
				record.lastErrorAtMs = port.now();
				record.faultTurnIdentity = target.faultTurnIdentity;
				record.pendingCompletionReview = undefined;
				if (
					record.activeDeliveryId &&
					(record.activeDeliveryWasAccepted ||
						record.activeDeliveryAttemptCounted ||
						record.activeDeliveryRequestMayHaveBeenSent)
				)
					record.activeDeliveryObservedFailure = { reason, nativeTurnId };
				if (reason === "model_capacity" && record.reason !== reason) {
					record.reason = reason;
					record.firstCapacityErrorAtMs = port.now();
					record.capacityRetryAttemptCount = 0;
					record.deadlineAtMs = record.firstCapacityErrorAtMs + 30 * 60_000;
					if (!inFlight && !record.activeDeliveryId) {
						record.phase = "waiting_backoff";
						schedule(CAPACITY_BACKOFF_MS[0]);
					}
				}
				if (nativeTurnId) record.faultNativeTurnId = nativeTurnId;
				if (record.phase === "executing" || record.activeDeliveryObservedFailure) {
					record.phase = "reconciling_acceptance";
					record.blockingReason = record.activeDeliveryWasAccepted
						? ACCEPTED_EXECUTION_INTERRUPTED_BY_NEW_FAILURE
						: "checking_original_native_acceptance";
					schedule(0);
					return;
				}
				publish();
				return;
			}
			record = {
				...target,
				episodeId: randomUUID(),
				reason,
				phase: "waiting_backoff",
				faultNativeTurnId: nativeTurnId,
				firstErrorAtMs: port.now(),
				...(reason === "model_capacity"
					? { firstCapacityErrorAtMs: port.now(), capacityRetryAttemptCount: 0 }
					: {}),
				lastErrorAtMs: port.now(),
				deadlineAtMs: reason === "model_capacity" ? port.now() + 30 * 60_000 : null,
				lastCheckAtMs: null,
				nextCheckAtMs: null,
				lastAttemptAtMs: null,
				attemptCount: 0,
				acceptedCount: 0,
				activeDeliveryId: null,
				activeDeliveryWasAccepted: false,
				activeDeliveryAttemptCounted: false,
				activeDeliveryRequestMayHaveBeenSent: false,
				unchangedCheckCount: 0,
				blockingReason: null,
			};
			schedule(backoff());
		},
		cancel(reason: string) {
			manualRecheckRequestedWhileInFlight = false;
			if (isAutomaticAgentFailureContinuationActive(record)) finish("cancelled", reason);
		},
		finishRecovered(reason: string) {
			if (isAutomaticAgentFailureContinuationActive(record)) finish("recovered", reason);
		},
		requestCompletionReview(reason: "hook" | "idle_stall", observedAtMs: number) {
			if (!record || !isAutomaticAgentFailureContinuationActive(record)) return;
			const submissionStartedAtMs = record.activeDeliverySubmissionStartedAtMs ?? record.lastAttemptAtMs;
			if (observedAtMs < Math.max(submissionStartedAtMs ?? 0, record.lastErrorAtMs)) return;
			record.pendingCompletionReview = {
				reason,
				observedAtMs,
				activeDeliveryId:
					record.activeDeliverySubmissionStartedAtMs !== undefined ||
					record.activeDeliveryWasAccepted ||
					(record.agentId === "codex" && record.activeDeliveryAttemptCounted)
						? record.activeDeliveryId
						: null,
			};
			publish();
		},
		observeProgress(observedAtMs: number) {
			if (
				!suspendedForRuntimeShutdown &&
				record &&
				isAutomaticAgentFailureContinuationActive(record) &&
				observedAtMs > record.lastErrorAtMs
			) {
				if (record.agentId === "codex") {
					if (hasCompletionReviewForSubmittedAutomaticFailureContinuation(record)) schedule(0);
				} else finish("recovered", "trusted_conversation_progress");
			}
		},
		async attempt(manual = false) {
			if (!record || suspendedForRuntimeShutdown) return;
			if (inFlight) {
				if (manual) manualRecheckRequestedWhileInFlight = true;
				return;
			}
			if (TERMINAL_PHASES.has(record.phase)) {
				if (!manual || record.phase === "recovered") return;
				// 明确重启产生新 episode，但未决投递仍必须沿用原引用只读核对。
				record = {
					...record,
					episodeId: randomUUID(),
					firstErrorAtMs: port.now(),
					...(record.reason === "model_capacity"
						? { firstCapacityErrorAtMs: port.now(), capacityRetryAttemptCount: 0 }
						: {}),
					deadlineAtMs: record.reason === "model_capacity" ? port.now() + 30 * 60_000 : null,
					phase: record.activeDeliveryId ? "reconciling_acceptance" : "waiting_backoff",
					blockingReason: null,
					nextCheckAtMs: port.now(),
				};
			}
			if (!manual && record.nextCheckAtMs !== null && port.now() < record.nextCheckAtMs) {
				schedule(record.nextCheckAtMs - port.now());
				return;
			}
			record.lastCheckAtMs = port.now();
			if (record.deadlineAtMs !== null && port.now() >= record.deadlineAtMs && record.phase !== "executing") {
				finish("expired", "capacity_recovery_deadline_reached");
				return;
			}
			if (!port.canAttempt()) {
				finish("cancelled", "execution_qualification_revoked");
				return;
			}
			const softDeferral = port.softDeferralReason?.() ?? null;
			if (softDeferral) {
				record.phase = "waiting_machine_evidence";
				record.blockingReason = softDeferral;
				schedule(EVIDENCE_RECHECK_MS[Math.min(record.unchangedCheckCount++, EVIDENCE_RECHECK_MS.length - 1)]);
				return;
			}
			const originalEpisodeId = record.episodeId;
			const submittedReason = record.reason;
			const originalRecord = record;
			if (!record.activeDeliveryId) record.activeDeliveryId = randomUUID();
			const originalDeliveryId = record.activeDeliveryId;
			record.phase =
				record.activeDeliveryAttemptCounted || record.activeDeliveryRequestMayHaveBeenSent
					? "reconciling_acceptance"
					: "sending";
			publish();
			inFlight = true;
			try {
				const result = await port.submit({ ...record });
				if (
					suspendedForRuntimeShutdown ||
					record !== originalRecord ||
					record.episodeId !== originalEpisodeId ||
					record.activeDeliveryId !== originalDeliveryId ||
					TERMINAL_PHASES.has(record.phase)
				)
					return;
				if (result.outcome === "invalidated") {
					finish("cancelled", result.blockingReason ?? "target_invalidated");
					return;
				}
				if (result.outcome === "completed_without_submission") {
					finish("recovered", "native_turn_completed");
					return;
				}
				if (result.outcome === "deferred") {
					if (result.blockingReason === "capacity_recovery_deadline_reached") {
						finish("expired", result.blockingReason);
						return;
					}
					record.phase = "waiting_machine_evidence";
					record.blockingReason = result.blockingReason ?? "native_evidence_unavailable";
				} else {
					if (!record.activeDeliveryAttemptCounted && result.requestWasInvoked !== false) {
						record.attemptCount += 1;
						if (submittedReason === "model_capacity")
							record.capacityRetryAttemptCount =
								(record.capacityRetryAttemptCount ?? record.attemptCount - 1) + 1;
						record.lastAttemptAtMs = port.now();
						record.activeDeliveryAttemptCounted = true;
					}
					if (
						(result.nativeAcceptanceConfirmed || result.outcome.startsWith("accepted_")) &&
						!record.activeDeliveryWasAccepted
					) {
						record.acceptedCount += 1;
						record.activeDeliveryWasAccepted = true;
					}
					if (result.nativeTurnId) record.faultNativeTurnId = result.nativeTurnId;
					record.blockingReason = result.blockingReason ?? null;
					if (result.outcome === "accepted_finished") {
						finish("recovered", "native_turn_completed");
						return;
					}
					if (result.outcome === "accepted_progressed") {
						finish("recovered", "trusted_conversation_progress");
						return;
					}
					if (result.outcome === "accepted_terminal_failure") {
						finish("failed", result.blockingReason ?? "non_retryable_native_turn_failure");
						return;
					}
					if (result.outcome === "accepted_failed") {
						record.activeDeliveryId = null;
						record.activeDeliveryWasAccepted = false;
						record.activeDeliveryAttemptCounted = false;
						record.activeDeliveryRequestMayHaveBeenSent = false;
						record.activeDeliverySubmissionStartedAtMs = undefined;
						record.activeDeliveryObservedFailure = undefined;
						record.pendingCompletionReview = undefined;
						record.terminalSubmissionTranscriptReadCursor = undefined;
						record.phase = "waiting_backoff";
						record.unchangedCheckCount = 0;
						schedule(backoff());
						return;
					}
					const deferral = port.softDeferralReason?.() ?? null;
					if (deferral && (result.outcome === "accepted_running" || result.outcome === "unconfirmed")) {
						record.phase = "waiting_machine_evidence";
						record.blockingReason = deferral;
					} else record.phase = result.outcome === "accepted_running" ? "executing" : "reconciling_acceptance";
				}
			} catch {
				if (suspendedForRuntimeShutdown || record !== originalRecord || TERMINAL_PHASES.has(record.phase)) return;
				record.phase = "waiting_machine_evidence";
				record.blockingReason = "query_or_persistence_temporarily_unavailable";
			} finally {
				inFlight = false;
				if (manualRecheckRequestedWhileInFlight) {
					manualRecheckRequestedWhileInFlight = false;
					void coordinator.attempt(true);
				}
			}
			if (suspendedForRuntimeShutdown || record !== originalRecord || TERMINAL_PHASES.has(record.phase)) return;
			schedule(EVIDENCE_RECHECK_MS[Math.min(record.unchangedCheckCount++, EVIDENCE_RECHECK_MS.length - 1)]);
		},
	};
	return coordinator;
}
