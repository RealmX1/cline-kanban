import { createHash } from "node:crypto";
import { readCodexNativeAgentTurnExecution } from "../agent-session-history/codex-native-agent-turn-execution-reader";
import { supplementCodexNativeTurnExecutionWithTranscriptEvidence } from "../agent-session-history/codex-native-turn-completion-transcript-evidence";
import type { RuntimeAutomaticAgentFailureContinuation, RuntimeTaskSessionSummary } from "../core/api-contract";
import { createCodexNativePromptDeliveryJournal } from "../core/codex-native-prompt-delivery-journal";
import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { beginManagedTaskPromptDelivery } from "../state/managed-task-prompt-delivery-coordinator";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import type { AutomaticFailureContinuationAttemptResult } from "./automatic-agent-failure-continuation-coordinator";
import { inspectCodexNativeConnectionRetryContinuationReadiness } from "./codex-native-connection-retry-continuation-readiness";
import { deliverCodexNativePromptWithoutChangingComposer } from "./codex-native-prompt-delivery";
import { classifyConnectionError } from "./output-reactions/connection-error-patterns";
import { normalizeTerminalText } from "./terminal-output-normalization";

export function classifyCodexNativeTurnRetryableFailureReason(
	errorMessage: string,
): RuntimeAutomaticAgentFailureContinuation["reason"] | null {
	const normalizedMessage = normalizeTerminalText(errorMessage);
	const classification = classifyConnectionError(normalizedMessage).classification;
	if (classification === "permanent") return null;
	if (normalizedMessage.includes("selected model is at capacity. please try a different model."))
		return "model_capacity";
	return classification === "transient" || /\bunexpected status (?:429|502|503|504)\b/u.test(normalizedMessage)
		? "connection"
		: null;
}

export function buildAutomaticAgentFailureContinuationPrompt(
	reason: RuntimeAutomaticAgentFailureContinuation["reason"],
): string {
	return `${reason === "model_capacity" ? "刚才模型容量暂时不足" : "刚才服务连接暂时中断"}。请先核对上一步的真实执行结果，避免重复已完成的操作；在原模型、模式和权限下继续原任务。若仍有瞬时故障，请如实保留错误。`;
}
export async function deliverAutomaticAgentFailureContinuationNativePrompt(input: {
	record: RuntimeAutomaticAgentFailureContinuation;
	summary: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
	beforeSubmit: () => Promise<boolean>;
	readSoftDeferral?: () => string | null;
	onSubmissionStarted?: () => void;
	onRequestInvoked?: () => void;
	onAcceptanceConfirmed?: () => void;
	sender?: typeof deliverCodexNativePromptWithoutChangingComposer;
}): Promise<AutomaticFailureContinuationAttemptResult> {
	const { record, summary } = input;
	if (
		!summary.codexNativeSessionControlEndpoint ||
		!summary.agentNativeConversationSessionIdentity ||
		record.workspaceId === "unmanaged"
	)
		return { outcome: "deferred", blockingReason: "waiting_for_native_identity_and_control_endpoint" };
	if (!record.activeDeliveryId) return { outcome: "deferred", blockingReason: "delivery_identity_unavailable" };
	const deliveryId = record.activeDeliveryId;
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
	const text = buildAutomaticAgentFailureContinuationPrompt(record.reason);
	const ledgerRecord = await withTaskMessageInjectionLedgerLock(ledgerPath, async (records) => {
		const existing = findTaskMessageInjectionRecord(records, record.taskId, deliveryId);
		if (existing) return { result: existing };
		const next = createPendingTaskMessageInjectionRecord({
			taskId: record.taskId,
			attemptId: record.conversationSessionId,
			source: "automatic_agent_failure_continuation",
			idempotencyKey: deliveryId,
			promptSha256: createHash("sha256").update(text).digest("hex"),
			nowIso: new Date().toISOString(),
		});
		return { records: [...records, next], result: next };
	});
	const operation = ledgerRecord.codex_native_prompt_delivery_operation;
	const requestMayHaveBeenSent = !!operation && operation.sendPhase !== "registered";
	if (!requestMayHaveBeenSent) {
		if (record.pendingCompletionReview) {
			const execution = await readCodexNativeAgentTurnExecution({
				workspaceId: record.workspaceId,
				summary,
				observedAtMs: Date.now(),
			});
			if (!input.getCurrentSummary()) return { outcome: "invalidated" };
			if (
				execution?.executionStatus === "finished" &&
				execution.nativeTurnStatus === "completed" &&
				(!record.faultNativeTurnId || record.faultNativeTurnId === execution.nativeTurnId)
			)
				return { outcome: "completed_without_submission", requestWasInvoked: false };
		}
		if (record.deadlineAtMs !== null && Date.now() >= record.deadlineAtMs)
			return { outcome: "deferred", blockingReason: "capacity_recovery_deadline_reached", requestWasInvoked: false };
		const readiness = await inspectCodexNativeConnectionRetryContinuationReadiness({
			summary,
			getCurrentSummary: input.getCurrentSummary,
			...(record.faultNativeTurnId ? { requiredNativeTurnId: record.faultNativeTurnId } : {}),
		});
		if (readiness.outcome === "target_invalidated") return { outcome: "invalidated" };
		if (readiness.outcome !== "ready_for_terminal_write")
			return { outcome: "deferred", blockingReason: "waiting_for_failed_native_turn_evidence" };
	}
	const { handle } = await beginManagedTaskPromptDelivery({
		workspaceId: record.workspaceId,
		taskId: record.conversationSessionId,
		workspaceTaskId: record.taskId,
		deliveryRequestId: deliveryId,
		text,
		idempotencyKey: deliveryId,
		injectionLedgerTaskId: record.taskId,
		origin: {
			messageType: "system_continuation",
			sourceLabel: record.reason === "model_capacity" ? "容量不足自动恢复" : "网络中断自动恢复",
		},
		summary,
	});
	let requestWasInvoked = (operation?.actualSendAttemptCount ?? 0) > 0;
	const journal = createCodexNativePromptDeliveryJournal({
		ledgerPath,
		ledgerTaskId: record.taskId,
		idempotencyKey: deliveryId,
	});
	let beforeSubmitSoftDeferral: string | null = null;
	const readSendingDeferral = () =>
		input.readSoftDeferral?.() ??
		(record.deadlineAtMs !== null && Date.now() >= record.deadlineAtMs ? "capacity_recovery_deadline_reached" : null);
	const result = await (input.sender ?? deliverCodexNativePromptWithoutChangingComposer)({
		summary,
		workspaceId: record.workspaceId,
		text,
		clientUserMessageId: deliveryId,
		deliveryJournal: {
			...journal,
			recordRequestInvoked: async () => {
				await journal.recordRequestInvoked();
				requestWasInvoked = true;
				input.onRequestInvoked?.();
			},
			recordAcceptance: async (evidence) => {
				await journal.recordAcceptance(evidence);
				input.onAcceptanceConfirmed?.();
			},
		},
		isCurrent: () => input.getCurrentSummary() !== null,
		beforeSubmit: async () => {
			beforeSubmitSoftDeferral = readSendingDeferral();
			if (beforeSubmitSoftDeferral || !(await input.beforeSubmit())) return false;
			const current = input.getCurrentSummary();
			if (!current) return false;
			const ready = await inspectCodexNativeConnectionRetryContinuationReadiness({
				summary: current,
				getCurrentSummary: input.getCurrentSummary,
				...(record.faultNativeTurnId ? { requiredNativeTurnId: record.faultNativeTurnId } : {}),
			});
			beforeSubmitSoftDeferral =
				readSendingDeferral() ??
				(ready.outcome === "deferred_before_terminal_write" ? "waiting_for_failed_native_turn_evidence" : null);
			return (
				ready.outcome === "ready_for_terminal_write" &&
				input.getCurrentSummary() !== null &&
				!beforeSubmitSoftDeferral
			);
		},
		mayInvokeNativeTurnStartRequest: () => {
			if (input.getCurrentSummary() === null || readSendingDeferral() !== null) return false;
			input.onSubmissionStarted?.();
			return true;
		},
		onRequestAttempted: () => {},
		confirmationBudgetMs: 2_000,
	});
	if (result.status === "confirmed") {
		await handle.settle({
			status: "delivered_and_submit_confirmed",
			reason: null,
			codexNativePromptDeliveryEvidence: result.evidence,
		});
		const current = input.getCurrentSummary();
		if (!current) return { outcome: "invalidated" };
		const nativeTurnReadInput = { workspaceId: record.workspaceId, summary: current, observedAtMs: Date.now() };
		const execution = await supplementCodexNativeTurnExecutionWithTranscriptEvidence({
			...nativeTurnReadInput,
			control: await readCodexNativeAgentTurnExecution(nativeTurnReadInput).catch(() => null),
			requiredNativeTurnId: result.evidence.nativeTurnId,
		});
		if (!input.getCurrentSummary()) return { outcome: "invalidated" };
		if (!execution || execution.nativeTurnId !== result.evidence.nativeTurnId)
			return {
				outcome: "unconfirmed",
				nativeAcceptanceConfirmed: true,
				nativeTurnId: result.evidence.nativeTurnId,
				blockingReason: "waiting_for_accepted_turn_execution",
			};
		if (execution.executionStatus === "running")
			return { outcome: "accepted_running", nativeTurnId: execution.nativeTurnId };
		if (
			execution.executionStatus === "finished" &&
			execution.nativeTurnStatus === "failed" &&
			execution.nativeTurnId
		) {
			const errorMessage = execution.nativeTurnErrorMessage ?? "";
			// 新的重试必须有本回合原因，旧 episode 原因不能充当证据。
			const observedFailure = record.activeDeliveryObservedFailure;
			const retryableFailureReason =
				classifyCodexNativeTurnRetryableFailureReason(errorMessage) ??
				(!errorMessage &&
				observedFailure &&
				(observedFailure.nativeTurnId === execution.nativeTurnId ||
					(observedFailure.nativeTurnId === null && record.faultNativeTurnId === execution.nativeTurnId))
					? observedFailure.reason
					: null);
			if (retryableFailureReason)
				return { outcome: "accepted_failed", nativeTurnId: execution.nativeTurnId, retryableFailureReason };
			if (
				errorMessage ||
				(record.blockingReason === "waiting_for_failed_native_turn_reason" && record.unchangedCheckCount >= 4)
			)
				return {
					outcome: "accepted_terminal_failure",
					nativeTurnId: execution.nativeTurnId,
					blockingReason: errorMessage ? "non_retryable_native_turn_failure" : "native_failure_reason_unavailable",
				};
			return {
				outcome: "unconfirmed",
				nativeAcceptanceConfirmed: true,
				nativeTurnId: execution.nativeTurnId,
				blockingReason: "waiting_for_failed_native_turn_reason",
			};
		}
		if (execution.executionStatus === "finished" && execution.nativeTurnStatus === "completed")
			return { outcome: "accepted_finished", nativeTurnId: execution.nativeTurnId };
		return {
			outcome: "unconfirmed",
			nativeAcceptanceConfirmed: true,
			nativeTurnId: result.evidence.nativeTurnId,
			blockingReason: "native_turn_waiting_or_execution_unknown",
		};
	}
	if (result.status === "cancelled") {
		if (!input.getCurrentSummary()) return { outcome: "invalidated" };
		const blockingReason = readSendingDeferral() ?? beforeSubmitSoftDeferral;
		return blockingReason
			? { outcome: "deferred", blockingReason, requestWasInvoked: false }
			: { outcome: "invalidated" };
	}
	if (result.status === "not_ready" || result.status === "unavailable")
		return { outcome: "deferred", blockingReason: "native_control_temporarily_unavailable" };
	return { outcome: "unconfirmed", requestWasInvoked, blockingReason: "checking_original_native_acceptance" };
}
