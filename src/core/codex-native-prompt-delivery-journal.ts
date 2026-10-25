import { createHash } from "node:crypto";
import type {
	CodexNativePromptAcceptanceHistoryQueryProgress,
	CodexNativePromptDeliveryEvidence,
	CodexNativePromptDeliveryOperation,
} from "./api-contract";
import {
	findTaskMessageInjectionRecord,
	type TaskMessageInjectionRecord,
	withTaskMessageInjectionLedgerLock,
} from "./task-message-injection-ledger";

export interface CodexNativePromptDeliveryLedgerBinding {
	requestOriginRuntimeProcessInstanceId?: string;
	ledgerPath: string;
	ledgerTaskId: string;
	idempotencyKey: string;
}

export interface CodexNativePromptDeliveryJournalState {
	clientUserMessageId: string;
	requestMayHaveBeenSent: boolean;
	previousTurnId: string | null;
	returnedTurnId: string | null;
	acceptanceHistoryQueryProgress?: CodexNativePromptAcceptanceHistoryQueryProgress;
}

export interface CodexNativePromptDeliveryJournal {
	prepare: (identity: {
		clientUserMessageId: string;
		workspaceId: string;
		conversationSessionId: string;
		nativeSessionId: string;
		workingDirectoryPath: string;
		text: string;
		historicalPromptSha256?: string;
	}) => Promise<CodexNativePromptDeliveryJournalState>;
	recordRequestIntent: (previousTurnId: string | null) => Promise<void>;
	recordRequestInvoked: () => Promise<void>;
	recordReturnedTurn: (returnedTurnId: string) => Promise<void>;
	recordAcceptanceHistoryQueryProgress: (progress: CodexNativePromptAcceptanceHistoryQueryProgress) => Promise<void>;
	recordAcceptance: (evidence: CodexNativePromptDeliveryEvidence) => Promise<void>;
}

export function createCodexNativePromptDeliveryJournal(
	binding: CodexNativePromptDeliveryLedgerBinding,
): CodexNativePromptDeliveryJournal {
	const mutate = async <T>(
		operation: (
			current: CodexNativePromptDeliveryOperation | undefined,
			settled: boolean,
			record: TaskMessageInjectionRecord,
		) => { next: CodexNativePromptDeliveryOperation; result: T },
	): Promise<T> =>
		withTaskMessageInjectionLedgerLock(binding.ledgerPath, async (records) => {
			const record = findTaskMessageInjectionRecord(records, binding.ledgerTaskId, binding.idempotencyKey);
			if (!record) throw new Error("原生发送缺少已登记的程序化投递意图");
			const update = operation(
				record.codex_native_prompt_delivery_operation,
				record.terminal_delivery_status !== "accepted_pending_submit_confirmation",
				record,
			);
			return {
				records: records.map((item) =>
					item === record ? { ...record, codex_native_prompt_delivery_operation: update.next } : item,
				),
				result: update.result,
			};
		});
	const updateExisting = async (
		change: (current: CodexNativePromptDeliveryOperation, settled: boolean) => CodexNativePromptDeliveryOperation,
	): Promise<void> => {
		await mutate((current, settled) => {
			if (!current) throw new Error("原生发送尚未持久登记");
			return { next: { ...change(current, settled), updatedAtIso: new Date().toISOString() }, result: undefined };
		});
	};
	return {
		prepare: async (identity) =>
			mutate((current, settled, record) => {
				const promptSha256 =
					identity.historicalPromptSha256 ?? createHash("sha256").update(identity.text).digest("hex");
				if (
					record.prompt_sha256 !== promptSha256 ||
					(record.attempt_id ?? record.task_id) !== identity.conversationSessionId
				)
					throw new Error("原生投递正文或目标会话与原始意图不一致");
				if (
					current &&
					(current.promptSha256 !== promptSha256 ||
						current.nativeSessionId !== identity.nativeSessionId ||
						current.workspaceId !== identity.workspaceId ||
						current.conversationSessionId !== identity.conversationSessionId ||
						current.workingDirectoryPath !== identity.workingDirectoryPath)
				)
					throw new Error("持久原生发送身份或正文已改变");
				if (!current && settled) throw new Error("已终结的历史投递不能重新登记发送");
				const next: CodexNativePromptDeliveryOperation = current ?? {
					...(binding.requestOriginRuntimeProcessInstanceId
						? { requestOriginRuntimeProcessInstanceId: binding.requestOriginRuntimeProcessInstanceId }
						: {}),
					clientUserMessageId: identity.clientUserMessageId,
					workspaceId: identity.workspaceId,
					conversationSessionId: identity.conversationSessionId,
					nativeSessionId: identity.nativeSessionId,
					workingDirectoryPath: identity.workingDirectoryPath,
					promptSha256,
					sendPhase: "registered",
					actualSendAttemptCount: 0,
					previousTurnId: null,
					returnedTurnId: null,
					updatedAtIso: new Date().toISOString(),
				};
				return {
					next,
					result: {
						clientUserMessageId: next.clientUserMessageId,
						requestMayHaveBeenSent: next.sendPhase !== "registered" || settled,
						previousTurnId: next.previousTurnId,
						returnedTurnId: next.returnedTurnId,
						...(next.acceptanceHistoryQueryProgress
							? { acceptanceHistoryQueryProgress: next.acceptanceHistoryQueryProgress }
							: {}),
					},
				};
			}),
		recordRequestIntent: async (previousTurnId) =>
			updateExisting((current, settled) => {
				if (settled || current.sendPhase !== "registered" || current.actualSendAttemptCount >= 3)
					throw new Error("原生发送已尝试或执行资格已终止，只允许补证");
				return { ...current, sendPhase: "request_intent_persisted", previousTurnId };
			}),
		recordRequestInvoked: async () =>
			updateExisting((current) => {
				if (current.sendPhase === "registered") throw new Error("原生发送必须先持久记录意图");
				return {
					...current,
					sendPhase: current.sendPhase === "native_accepted" ? "native_accepted" : "request_invoked",
					actualSendAttemptCount: Math.max(current.actualSendAttemptCount, 1),
				};
			}),
		recordReturnedTurn: async (returnedTurnId) => updateExisting((current) => ({ ...current, returnedTurnId })),
		recordAcceptanceHistoryQueryProgress: async (acceptanceHistoryQueryProgress) =>
			updateExisting((current) => ({ ...current, acceptanceHistoryQueryProgress })),
		recordAcceptance: async (evidence) =>
			updateExisting((current) => {
				if (
					evidence.nativeSessionId !== current.nativeSessionId ||
					evidence.clientUserMessageId !== current.clientUserMessageId
				)
					throw new Error("原生接受证据与持久发送身份不一致");
				return {
					...current,
					sendPhase: "native_accepted",
					acceptanceHistoryQueryProgress: undefined,
					historicalAcceptanceEvidence: evidence,
				};
			}),
	};
}
