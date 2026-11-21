import type { InjectionLedgerTerminalDeliveryReceipt, RuntimeTaskSessionSummary } from "../core/api-contract";
import { injectionLedgerTerminalDeliveryReceiptSchema } from "../core/api-contract";
import {
	getMatchingCodexNativePromptHistoricalAcceptance,
	getOwnedCommandResultReadinessTimeout,
	isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports,
	isOwnedCommandResultInjectionBoundToExecution,
} from "../core/codex-native-prompt-delivery-journal";
import type { TaskChatDeliveryWriteValidator } from "../core/task-chat-delivery-write-validation";
import type { TaskCommandExecutionRecord } from "../core/task-command-execution-contract";
import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import {
	beginManagedTaskPromptDelivery,
	settleManagedTaskPromptDelivery,
} from "../state/managed-task-prompt-delivery-coordinator";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import type { TaskCommandExecutionDependencies } from "../task-command-execution/task-command-execution-service";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import {
	type SendTaskChatMessageAcrossSessionTransportsDependencies,
	sendTaskChatMessageAcrossSessionTransports,
} from "../trpc/task-chat-message-send-across-session-transports";
import { reconcileWorkspaceCodexNativePromptDeliveryAcceptances } from "./codex-native-prompt-delivery-acceptance-reconciliation";

export async function deliverOwnedCommandResultToActiveSession(input: {
	record: TaskCommandExecutionRecord;
	scope: RuntimeTrpcWorkspaceScope;
	summary: RuntimeTaskSessionSummary | null;
	transport: Pick<
		SendTaskChatMessageAcrossSessionTransportsDependencies,
		"getScopedTerminalManager" | "getScopedAcpTaskSessionService" | "loadScopedRuntimeConfig"
	>;
	validateBeforeTerminalWrite: TaskChatDeliveryWriteValidator;
	settled: Parameters<TaskCommandExecutionDependencies["deliver"]>[2];
	warn: (message: string) => void;
}) {
	const { record, scope, summary, transport, validateBeforeTerminalWrite, settled, warn } = input;
	const result = record.resultDelivery;
	if (!result) throw new Error("所属执行缺少冻结结果");
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
	const ownedCommandResultReadinessTimeoutReceipt = await withTaskMessageInjectionLedgerLock(
		ledgerPath,
		async (records) => {
			const existing = findTaskMessageInjectionRecord(records, record.taskId, result.resultId);
			if (existing && !isOwnedCommandResultInjectionBoundToExecution(existing, record))
				throw new Error("所属结果的原生发送意图与冻结身份不符");
			const recordedReceipt = injectionLedgerTerminalDeliveryReceiptSchema.safeParse(result.nativeReceipt);
			const readinessTimeout =
				getOwnedCommandResultReadinessTimeout(existing)?.receipt ??
				(recordedReceipt.success &&
				recordedReceipt.data.status === "delivery_failed" &&
				recordedReceipt.data.reason === "terminal_prompt_readiness_timeout"
					? recordedReceipt.data
					: undefined);
			if (
				summary?.agentId === "codex" &&
				(readinessTimeout ||
					result.nativeReceipt?.reason === "terminal_prompt_readiness_timeout" ||
					result.readinessTimeoutRecoveryAttemptedEvidenceSha256s) &&
				(!readinessTimeout || !existing || !isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports(existing))
			)
				throw new Error("所属结果的就绪超时缺少原生未写入证据，只允许补查接受回执");
			return {
				records: existing
					? undefined
					: [
							...records,
							createPendingTaskMessageInjectionRecord({
								taskId: record.taskId,
								attemptId: record.originatingConversationSessionId,
								source: "owned_command_execution_result",
								idempotencyKey: result.resultId,
								promptSha256: result.textSha256,
								nowIso: new Date().toISOString(),
							}),
						],
				result: readinessTimeout,
			};
		},
	);
	const managed = await beginManagedTaskPromptDelivery({
		workspaceId: record.workspaceId,
		taskId: record.originatingConversationSessionId,
		workspaceTaskId: record.taskId,
		text: result.text,
		deliveryRequestId: result.resultId,
		idempotencyKey: result.resultId,
		injectionLedgerTaskId: record.taskId,
		origin: { messageType: "programmatic_injection", sourceLabel: record.specification.label },
		summary,
	});
	const managedMetadata = managed.entry.managedDelivery;
	if (
		managed.entry.workspaceTaskId !== record.taskId ||
		managedMetadata?.injectionLedgerReference?.taskId !== record.taskId ||
		managedMetadata.injectionLedgerReference.idempotencyKey !== result.resultId ||
		managedMetadata.targetNativeSessionId !== record.originatingNativeSessionId ||
		managed.entry.deliveryState === "cancelled"
	)
		throw new Error("Queue 中所属结果的身份或投递资格已变化");
	const settleOwnedTransportReceipt = async (receipt: InjectionLedgerTerminalDeliveryReceipt) => {
		if (!(await settled(receipt))) return;
		await settleManagedTaskPromptDelivery({
			workspaceId: record.workspaceId,
			taskId: record.originatingConversationSessionId,
			deliveryId: managed.handle.deliveryId,
			receipt,
			ownedCommandResultReadinessTimeoutReceipt,
			expectedRegisteredEntry: managed.entry,
		});
	};
	const response = await sendTaskChatMessageAcrossSessionTransports(
		{
			...transport,
			programmaticInjectionLedgerTaskId: record.taskId,
			validateBeforeTerminalWrite,
			preserveExistingComposerDraft: true,
			owningCommandExecutionId: record.executionId,
			programmaticSubmissionAttemptId: result.attemptId ?? undefined,
			onProgrammaticTerminalDeliverySettled: (receipt) => {
				void settleOwnedTransportReceipt(receipt).catch((error: unknown) =>
					warn(`所属执行投递回执待补核 executionId=${record.executionId} reason=${String(error)}`),
				);
			},
		},
		scope,
		{
			taskId: record.originatingConversationSessionId,
			text: result.text,
			source: "owned_command_execution_result",
			idempotencyKey: result.resultId,
			deliveryRequestId: result.resultId,
			promptSha256: result.textSha256,
		},
	);
	if (response.terminalDelivery && response.terminalDelivery.status !== "accepted_pending_submit_confirmation")
		await settleOwnedTransportReceipt(response.terminalDelivery);
	return response;
}

export async function readOwnedCommandResultReadinessTimeoutObservedAtEpochMs(
	record: TaskCommandExecutionRecord,
): Promise<number | null> {
	if (!record.resultDelivery) return null;
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
	const entry = findTaskMessageInjectionRecord(
		await readTaskMessageInjectionLedger(ledgerPath),
		record.taskId,
		record.resultDelivery.resultId,
	);
	if (
		!isOwnedCommandResultInjectionBoundToExecution(entry, record) ||
		!isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports(entry)
	)
		return null;
	const timeout = getOwnedCommandResultReadinessTimeout(entry);
	return timeout ? Date.parse(timeout.observedAtIso) : null;
}

export async function reconcileOwnedCommandResultPromptDelivery(
	record: TaskCommandExecutionRecord,
	getSummary: (conversationSessionId: string) => RuntimeTaskSessionSummary | null,
): Promise<"native_accepted" | "known_not_submitted" | "unknown"> {
	if (!record.resultDelivery) return "unknown";
	const summary = getSummary(record.originatingConversationSessionId);
	const acceptance = summary?.agentConversationPromptSubmissionAcceptance;
	if (
		acceptance?.status === "accepted" &&
		acceptance.eventId === record.resultDelivery.resultId &&
		acceptance.nativeSessionId === record.originatingNativeSessionId &&
		(acceptance.submittedPromptSha256 == null ||
			acceptance.submittedPromptSha256 === record.resultDelivery.textSha256)
	)
		return "native_accepted";
	const managed = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(record.workspaceId)).entriesByTaskId[
		record.originatingConversationSessionId
	]?.find((entry) => entry.queueEntryId === record.resultDelivery?.resultId);
	const managedReceipt =
		managed?.text === record.resultDelivery.text &&
		managed.workspaceTaskId === record.taskId &&
		managed.managedDelivery?.targetNativeSessionId === record.originatingNativeSessionId &&
		managed.managedDelivery.injectionLedgerReference?.taskId === record.taskId &&
		managed.managedDelivery.injectionLedgerReference.idempotencyKey === record.resultDelivery.resultId
			? managed.managedDelivery.terminalDeliveryReceipt
			: null;
	if (
		managedReceipt?.status === "delivered_and_submit_confirmed" ||
		managedReceipt?.status === "delivered_queued_behind_active_agent_turn"
	)
		return "native_accepted";
	const notStarted = managedReceipt?.nativePromptSubmissionNotStartedEvidence;
	if (
		notStarted?.clientUserMessageId === record.resultDelivery.resultId &&
		notStarted.submissionAttemptId === record.resultDelivery.attemptId &&
		notStarted.nativeSessionId === record.originatingNativeSessionId
	)
		return "known_not_submitted";
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
	const resultId = record.resultDelivery.resultId;
	const readInjection = async () =>
		findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath), record.taskId, resultId);
	let entry = await readInjection();
	if (!isOwnedCommandResultInjectionBoundToExecution(entry, record)) return "unknown";
	if (
		entry.terminal_delivery_status === "delivered_and_submit_confirmed" ||
		entry.terminal_delivery_status === "delivered_queued_behind_active_agent_turn" ||
		getMatchingCodexNativePromptHistoricalAcceptance(entry.codex_native_prompt_delivery_operation)
	)
		return "native_accepted";
	if (isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports(entry)) return "known_not_submitted";
	if (
		entry.codex_native_prompt_delivery_operation &&
		entry.codex_native_prompt_delivery_operation.sendPhase !== "registered"
	) {
		await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
			workspaceId: record.workspaceId,
			ledgerPath,
			getSummary,
		});
		entry = await readInjection();
		if (
			isOwnedCommandResultInjectionBoundToExecution(entry, record) &&
			getMatchingCodexNativePromptHistoricalAcceptance(entry.codex_native_prompt_delivery_operation)
		)
			return "native_accepted";
	}
	return "unknown";
}
