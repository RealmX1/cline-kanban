import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
	reconcileCodexPromptSubmissionAcceptance,
	submittedPromptSha256,
} from "../agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import type { InjectionLedgerTerminalDeliveryReceipt, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import {
	type AgentRaisedPendingUserDecisionAnswerDeliveryAttempt,
	type PersistedAgentRaisedPendingUserDecision,
	readAgentRaisedPendingUserDecisions,
	updateAgentRaisedPendingUserDecisionAnswerDeliveryState,
} from "../state/agent-raised-pending-user-decision-store";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../state/queued-task-prompt-delivery-store";
import {
	getThisRuntimeProcessInstanceId,
	readRuntimeProcessInstanceLiveness,
} from "../state/runtime-process-instance-heartbeat-registry";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { buildAgentRaisedPendingUserDecisionAnswerMessage } from "./agent-raised-pending-user-decision-answer-message";
import { reconcileWorkspaceCodexNativePromptDeliveryAcceptances } from "./codex-native-prompt-delivery-acceptance-reconciliation";
import { reconcileClaudePendingUserDecisionAnswerTranscriptAcceptance } from "./pending-user-decision-answer-transcript-acceptance";

export const activePendingUserDecisionAnswerDeliveryAttemptIds = new Set<string>();

export interface PendingUserDecisionAnswerDeliveryEvidence {
	state: "delivered" | "delivery_failed" | "delivery_unconfirmed";
	reason?: string;
	acceptanceVerification?: AgentRaisedPendingUserDecisionAnswerDeliveryAttempt["acceptanceVerification"];
}

function receiptConfirmsDelivery(receipt: InjectionLedgerTerminalDeliveryReceipt | null | undefined): boolean {
	return (
		receipt?.status === "delivered_and_submit_confirmed" ||
		receipt?.status === "delivered_queued_behind_active_agent_turn"
	);
}

// 写入后的失败原因可能与写入前相同；显式阶段证据优先于原因码。
export function isPendingUserDecisionAnswerDefinitelyNotSubmitted(
	receipt: InjectionLedgerTerminalDeliveryReceipt,
): boolean {
	return (
		receipt.status === "delivery_failed" &&
		receipt.submissionMayHaveStarted !== true &&
		(receipt.submissionMayHaveStarted === false ||
			receipt.nativePromptSubmissionNotStartedEvidence !== undefined ||
			[
				"no_active_terminal_session",
				"terminal_prompt_readiness_timeout",
				"human_terminal_contention_timeout",
				"terminal_input_box_contended_but_unstashable",
				"agent_awaiting_user_decision_timeout",
				"cancelled_before_delivery",
				"native_independent_user_turn_capability_unavailable",
				"native_independent_user_turn_session_replaced",
			].some((reason) => reason === receipt.reason))
	);
}

async function readAnswerDeliveryEvidence(
	decision: PersistedAgentRaisedPendingUserDecision,
	getSummary: ((taskId: string) => RuntimeTaskSessionSummary | null) | undefined,
	now: number,
): Promise<PendingUserDecisionAnswerDeliveryEvidence> {
	const attempt = decision.answerDeliveryAttempts?.at(-1);
	const text = decision.answer ? buildAgentRaisedPendingUserDecisionAnswerMessage(decision, decision.answer) : "";
	const promptSha256 = createHash("sha256").update(text).digest("hex");
	if (attempt && promptSha256 !== attempt.promptSha256)
		return { state: "delivery_unconfirmed", reason: "answer_attempt_prompt_mismatch" };
	const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(decision.workspaceId).catch(() => null);
	const matchingEntries = (snapshot?.entriesByTaskId[decision.taskId] ?? []).filter(
		(entry) =>
			entry.managedDelivery?.messageType === "user_decision_answer" &&
			entry.managedDelivery.sourceLabel === decision.decisionId &&
			entry.text === text &&
			(attempt
				? entry.dispatchIdempotencyKey === attempt.dispatchIdempotencyKey &&
					entry.managedDelivery.targetNativeSessionId === (attempt.targetNativeSessionId ?? null) &&
					entry.managedDelivery.targetRuntimeSessionIncarnationId ===
						(attempt.targetRuntimeSessionIncarnationId ?? null)
				: !!decision.nativeConversationSessionId &&
					entry.managedDelivery.targetNativeSessionId === decision.nativeConversationSessionId &&
					entry.enqueuedAt >= (decision.answer?.answeredAt ?? Infinity)),
	);
	const queueReceipt =
		matchingEntries.length === 1 ? matchingEntries[0].managedDelivery?.terminalDeliveryReceipt : null;
	if (
		queueReceipt &&
		(!queueReceipt.codexNativePromptDeliveryEvidence ||
			queueReceipt.codexNativePromptDeliveryEvidence.nativeSessionId ===
				(attempt?.targetNativeSessionId ?? decision.nativeConversationSessionId))
	) {
		if (receiptConfirmsDelivery(queueReceipt))
			return { state: "delivered", reason: "durable_transport_receipt_verified" };
		if (isPendingUserDecisionAnswerDefinitelyNotSubmitted(queueReceipt))
			return { state: "delivery_failed", reason: "durable_submission_not_started_receipt_verified" };
	}
	if (!attempt) return { state: "delivery_unconfirmed", reason: "legacy_delivery_identity_unavailable" };
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(decision.workspaceId));
	const readBoundRecord = async () =>
		(await readTaskMessageInjectionLedger(ledgerPath)).find(
			(record) =>
				record.task_id === decision.taskId &&
				record.source === "user_decision_answer" &&
				(record.attempt_id ?? record.task_id) === decision.taskId &&
				record.idempotency_key === attempt.dispatchIdempotencyKey &&
				record.prompt_sha256 === promptSha256 &&
				promptSha256 === attempt.promptSha256,
		);
	let record = await readBoundRecord();
	if (
		record?.codex_native_prompt_delivery_evidence &&
		record.codex_native_prompt_delivery_evidence.nativeSessionId !== attempt.targetNativeSessionId
	)
		record = undefined;
	const operation = record?.codex_native_prompt_delivery_operation;
	if (
		operation &&
		operation.workspaceId === decision.workspaceId &&
		operation.nativeSessionId === attempt.targetNativeSessionId &&
		operation.workingDirectoryPath === attempt.workingDirectoryPath &&
		operation.promptSha256 === attempt.promptSha256 &&
		getSummary
	) {
		await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
			workspaceId: decision.workspaceId,
			ledgerPath,
			idempotencyKey: attempt.dispatchIdempotencyKey,
			getSummary,
		});
		record = await readBoundRecord();
		const evidence = record?.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence;
		if (
			evidence?.nativeSessionId === attempt.targetNativeSessionId &&
			evidence.clientUserMessageId === operation.clientUserMessageId
		)
			return { state: "delivered", reason: "native_acceptance_verified" };
	}
	if (
		record &&
		receiptConfirmsDelivery({
			status: record.terminal_delivery_status,
			reason: record.terminal_delivery_failure_reason ?? null,
		})
	)
		return { state: "delivered", reason: "durable_transport_receipt_verified" };
	if (
		record &&
		isPendingUserDecisionAnswerDefinitelyNotSubmitted({
			status: record.terminal_delivery_status,
			reason: record.terminal_delivery_failure_reason ?? null,
			submissionMayHaveStarted: record.submission_may_have_started,
		})
	)
		return { state: "delivery_failed", reason: "durable_submission_not_started_receipt_verified" };
	const summary = getSummary?.(decision.taskId);
	const acceptance = summary?.agentConversationPromptSubmissionAcceptance;
	if (
		decision.sessionTransport === "acp_stdio_subprocess" &&
		summary?.sessionTransport === "acp_stdio_subprocess" &&
		summary.agentId === decision.agentId &&
		attempt.targetNativeSessionId &&
		attempt.targetRuntimeSessionIncarnationId &&
		summary.agentNativeConversationSessionIdentity?.nativeSessionId === attempt.targetNativeSessionId &&
		summary.agentNativeConversationSessionIdentity.sourceAgentId === decision.agentId &&
		summary.runtimeSessionIncarnationId === attempt.targetRuntimeSessionIncarnationId &&
		acceptance?.status === "accepted" &&
		acceptance.eventId === attempt.dispatchIdempotencyKey &&
		acceptance.nativeSessionId === attempt.targetNativeSessionId &&
		acceptance.runtimeSessionIncarnationId === attempt.targetRuntimeSessionIncarnationId
	)
		return { state: "delivered", reason: "acp_prompt_acceptance_verified" };
	// 旧正文不带尝试身份，同文新问题也可能位于提交位置之后；只允许其精确回执补证。
	if (attempt.answerMessageFormatVersion !== 2)
		return { state: "delivery_unconfirmed", reason: "legacy_answer_text_not_uniquely_bound" };
	if (decision.agentId === "claude")
		return reconcileClaudePendingUserDecisionAnswerTranscriptAcceptance(attempt, text, now);
	if (
		decision.agentId === "codex" &&
		summary &&
		attempt.targetNativeSessionId &&
		attempt.targetRuntimeSessionIncarnationId &&
		attempt.workingDirectoryPath &&
		attempt.transcriptPath &&
		attempt.preSubmissionTranscriptByteOffset !== undefined &&
		attempt.preSubmissionTranscriptFileIdentity
	) {
		const metadata = await stat(attempt.transcriptPath);
		if (
			`${metadata.dev}:${metadata.ino}` !== attempt.preSubmissionTranscriptFileIdentity ||
			metadata.size < attempt.preSubmissionTranscriptByteOffset ||
			metadata.size < (attempt.acceptanceVerification?.transcriptCursor?.lastObservedFileSize ?? 0)
		)
			return { state: "delivery_unconfirmed", reason: "native_transcript_replaced" };
		const reconciled = await reconcileCodexPromptSubmissionAcceptance({
			summary: {
				...summary,
				agentId: "codex",
				workspacePath: attempt.workingDirectoryPath,
				runtimeSessionIncarnationId: attempt.targetRuntimeSessionIncarnationId,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: attempt.targetNativeSessionId,
					transcriptPath: attempt.transcriptPath,
					observedAt: attempt.startedAt,
				},
				agentConversationPromptSubmissionAcceptance: {
					status: "unconfirmed",
					attemptedAtMs: attempt.startedAt,
					submissionId: attempt.attemptId,
					submissionSource: "programmatic_submission",
					submittedPromptSha256: submittedPromptSha256(text),
					nativeSessionId: attempt.targetNativeSessionId,
					runtimeSessionIncarnationId: attempt.targetRuntimeSessionIncarnationId,
					predecessorAcceptedEventId: attempt.preSubmissionAcceptance?.eventId,
					verification: attempt.acceptanceVerification ?? {
						checkedAtMs: now,
						nextCheckAtMs: null,
						consecutiveUnchangedCheckCount: 0,
						reason: "scanning_native_transcript",
						transcriptCursor: {
							fileIdentity: attempt.preSubmissionTranscriptFileIdentity,
							nextByteOffset: attempt.preSubmissionTranscriptByteOffset,
							lastObservedFileSize: attempt.preSubmissionTranscriptByteOffset,
							verifiedSessionMetadata: false,
							skippingOversizedRecord: false,
						},
					},
				},
			},
			observedAtMs: now,
			force: true,
		});
		if (reconciled)
			return {
				state: reconciled.accepted ? "delivered" : "delivery_unconfirmed",
				reason: reconciled.verification.reason,
				acceptanceVerification: reconciled.verification,
			};
	}
	return { state: "delivery_unconfirmed", reason: "no_matching_native_acceptance" };
}

// 所有恢复入口共用此只读补证路径；发送始终留在显式回答入口。
export async function reconcileAgentRaisedPendingUserDecisionAnswerDelivery(input: {
	workspaceId: string;
	decisionId: string;
	now?: number;
	force?: boolean;
	getSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	readEvidence?: (
		decision: PersistedAgentRaisedPendingUserDecision,
	) => Promise<PendingUserDecisionAnswerDeliveryEvidence>;
}): Promise<PersistedAgentRaisedPendingUserDecision | null> {
	const now = input.now ?? Date.now();
	const decision = (await readAgentRaisedPendingUserDecisions(input.workspaceId)).find(
		(record) => record.decisionId === input.decisionId,
	);
	if (
		!decision ||
		!decision.answer ||
		decision.status !== "answered" ||
		decision.answerHandledConfirmation ||
		decision.answerDeliveryState === "delivered" ||
		decision.answerDeliveryState === "answer_recorded"
	)
		return decision ?? null;
	const attempt = decision.answerDeliveryAttempts?.at(-1);
	if (attempt && activePendingUserDecisionAnswerDeliveryAttemptIds.has(attempt.attemptId)) return decision;
	let ownerLiveness: "live" | "dead" | "unknown" = attempt
		? attempt.ownerRuntimeProcessInstanceId === getThisRuntimeProcessInstanceId()
			? "dead"
			: await readRuntimeProcessInstanceLiveness(attempt.ownerRuntimeProcessInstanceId)
		: "unknown";
	if (decision.answerDeliveryState === "delivery_in_progress" && ownerLiveness !== "dead") {
		// 旧记录没有属主，只能保留真实未知；不能仅凭过去很久就判执行已经退出。
		if (attempt) return decision;
	}
	const queue = await readWorkspaceQueuedTaskPromptDeliverySnapshot(input.workspaceId).catch(() => null);
	let originalExecutionHasSettled = ownerLiveness === "dead";
	if (!attempt && decision.answerDeliveryState === "delivery_in_progress") {
		const text = buildAgentRaisedPendingUserDecisionAnswerMessage(decision, decision.answer);
		const matches = (queue?.entriesByTaskId[decision.taskId] ?? []).filter(
			(entry) =>
				entry.managedDelivery?.messageType === "user_decision_answer" &&
				entry.managedDelivery.sourceLabel === decision.decisionId &&
				entry.text === text &&
				entry.enqueuedAt >= (decision.answer?.answeredAt ?? Infinity),
		);
		if (matches.length === 1) {
			const receipt = matches[0].managedDelivery?.terminalDeliveryReceipt;
			const owner = matches[0].custodianRuntimeProcessInstanceId;
			if (owner) ownerLiveness = await readRuntimeProcessInstanceLiveness(owner);
			originalExecutionHasSettled =
				ownerLiveness === "dead" ||
				(!!receipt &&
					receipt.status !== "accepted_pending_submit_confirmation" &&
					receipt.reason !== "runtime_restarted_before_confirmation");
		}
	}
	const metadata = attempt?.transcriptPath ? await stat(attempt.transcriptPath).catch(() => null) : null;
	const summary = input.getSummary?.(decision.taskId);
	const acceptance = summary?.agentConversationPromptSubmissionAcceptance;
	const boundLedgerRecord = attempt
		? (
				await readTaskMessageInjectionLedger(
					getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(input.workspaceId)),
				).catch(() => [])
			).find(
				(record) => record.task_id === decision.taskId && record.idempotency_key === attempt.dispatchIdempotencyKey,
			)
		: undefined;
	const fingerprint = JSON.stringify([
		metadata?.ino,
		metadata?.size,
		metadata?.mtimeMs,
		acceptance?.status,
		acceptance?.eventId,
		acceptance?.submissionId,
		acceptance?.nativeSessionId,
		acceptance?.runtimeSessionIncarnationId,
		summary?.runtimeSessionIncarnationId,
		summary?.agentNativeConversationSessionIdentity?.nativeSessionId,
		summary?.codexNativeSessionControlEndpoint,
		boundLedgerRecord?.terminal_delivery_status,
		boundLedgerRecord?.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence,
		(queue?.entriesByTaskId[decision.taskId] ?? [])
			.filter((entry) => entry.managedDelivery?.sourceLabel === decision.decisionId)
			.map((entry) => [
				entry.dispatchIdempotencyKey,
				entry.deliveryState,
				entry.managedDelivery?.terminalDeliveryReceipt,
			]),
	]);
	const progress = decision.answerDeliveryReconciliation ?? attempt;
	const evidenceChanged = progress?.evidenceFingerprint !== fingerprint;
	if (
		!input.force &&
		progress &&
		!evidenceChanged &&
		(progress.nextReconciliationAt === null || (progress.nextReconciliationAt ?? 0) > now)
	)
		return decision;
	let evidence: PendingUserDecisionAnswerDeliveryEvidence;
	try {
		evidence = await (input.readEvidence
			? input.readEvidence(decision)
			: readAnswerDeliveryEvidence(decision, input.getSummary, now));
	} catch {
		evidence = { state: "delivery_unconfirmed", reason: "delivery_evidence_unavailable" };
	}
	// 已确证未发送的尝试保留重投资格；遗留失败没有这项证据，须迁移为未知。
	if (evidence.state === "delivery_unconfirmed" && attempt?.state === "delivery_failed")
		evidence.state = "delivery_failed";
	if (
		attempt?.submissionPhase === "preparing_session" &&
		ownerLiveness === "dead" &&
		evidence.state === "delivery_unconfirmed"
	)
		evidence = { state: "delivery_failed", reason: "original_execution_exited_before_submission" };
	const reconciledState =
		evidence.state === "delivery_unconfirmed" &&
		decision.answerDeliveryState === "delivery_in_progress" &&
		ownerLiveness === "live" &&
		!originalExecutionHasSettled
			? "delivery_in_progress"
			: evidence.state;
	const madeScanProgress =
		(evidence.acceptanceVerification?.transcriptCursor?.nextByteOffset ?? 0) >
		(attempt?.acceptanceVerification?.transcriptCursor?.nextByteOffset ??
			attempt?.preSubmissionTranscriptByteOffset ??
			0);
	const unchangedCount = evidenceChanged || madeScanProgress ? 1 : (progress?.unchangedReconciliationCount ?? 0) + 1;
	const nextReconciliationAt =
		evidence.state === "delivered"
			? null
			: evidence.acceptanceVerification?.reason === "scanning_native_transcript" && madeScanProgress
				? now + 250
				: unchangedCount <= 3
					? now + [15_000, 30_000, 60_000][unchangedCount - 1]
					: null;
	return (
		(await updateAgentRaisedPendingUserDecisionAnswerDeliveryState(input.workspaceId, decision.decisionId, {
			answerDeliveryState: reconciledState,
			updatedAt: now,
			answerDeliveryReconciliation: {
				lastReconciliationAt: now,
				nextReconciliationAt,
				unchangedReconciliationCount: unchangedCount,
				evidenceFingerprint: fingerprint,
				reconciliationReason: evidence.reason,
			},
			...(attempt
				? {
						expectedAttemptId: attempt.attemptId,
						answerDeliveryAttemptPatch: {
							state: reconciledState,
							submissionPhase: "settled",
							lastReconciliationAt: now,
							nextReconciliationAt,
							unchangedReconciliationCount: unchangedCount,
							evidenceFingerprint: fingerprint,
							reconciliationReason: evidence.reason,
							...(evidence.acceptanceVerification
								? { acceptanceVerification: evidence.acceptanceVerification }
								: {}),
						},
					}
				: {}),
		})) ?? decision
	);
}

export async function reconcilePendingUserDecisionAnswerDeliveriesForWorkspace(input: {
	workspaceId: string;
	taskId?: string;
	getSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
}): Promise<number | null> {
	let earliestNextCheckAt: number | null = null;
	for (const decision of await readAgentRaisedPendingUserDecisions(input.workspaceId)) {
		if (
			(input.taskId && input.taskId !== decision.taskId) ||
			!decision.answer ||
			decision.answerHandledConfirmation ||
			decision.answerDeliveryState === "delivered" ||
			decision.answerDeliveryState === "answer_recorded"
		)
			continue;
		const updated = await reconcileAgentRaisedPendingUserDecisionAnswerDelivery({
			...input,
			decisionId: decision.decisionId,
		});
		const next =
			updated?.answerDeliveryReconciliation?.nextReconciliationAt ??
			updated?.answerDeliveryAttempts?.at(-1)?.nextReconciliationAt;
		if (typeof next === "number" && next > Date.now())
			earliestNextCheckAt = Math.min(earliestNextCheckAt ?? Infinity, next);
	}
	return earliestNextCheckAt;
}
