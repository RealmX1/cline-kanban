import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { createCodexNativePromptDeliveryJournal } from "../core/codex-native-prompt-delivery-journal";
import {
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { deliverCodexNativePromptWithoutChangingComposer } from "../terminal/codex-native-prompt-delivery";

// 只查原生历史，不创建会话、不唤醒 Agent，也不改写原始失败回执。
export async function reconcileWorkspaceCodexNativePromptDeliveryAcceptances(input: {
	workspaceId: string;
	ledgerPath: string;
	reconcilerRuntimeProcessInstanceId?: string;
	getSummary: (conversationSessionId: string) => RuntimeTaskSessionSummary | null;
	deliver?: typeof deliverCodexNativePromptWithoutChangingComposer;
}): Promise<{ confirmedCount: number; unknownCount: number }> {
	const records = await readTaskMessageInjectionLedger(input.ledgerPath);
	let confirmedCount = 0;
	let unknownCount = 0;
	for (const record of records.sort((a, b) =>
		(a.codex_native_prompt_delivery_operation?.lastAcceptanceReconciliationAtIso ?? "").localeCompare(
			b.codex_native_prompt_delivery_operation?.lastAcceptanceReconciliationAtIso ?? "",
		),
	)) {
		const operation = record.codex_native_prompt_delivery_operation;
		if (
			!operation ||
			operation.workspaceId !== input.workspaceId ||
			operation.sendPhase === "registered" ||
			operation.historicalAcceptanceEvidence
		)
			continue;
		if (confirmedCount + unknownCount >= 4) break;
		const summary = input.getSummary(operation.conversationSessionId);
		if (!summary) continue;
		const rememberObservation = async (status: "confirmed" | "unknown") => {
			const currentSummary = input.getSummary(operation.conversationSessionId);
			await withTaskMessageInjectionLedgerLock(input.ledgerPath, async (currentRecords) => ({
				records: currentRecords.map((current) =>
					current.task_id === record.task_id &&
					current.idempotency_key === record.idempotency_key &&
					current.codex_native_prompt_delivery_operation
						? {
								...current,
								codex_native_prompt_delivery_operation: {
									...current.codex_native_prompt_delivery_operation,
									lastAcceptanceReconciliationAtIso: new Date().toISOString(),
									lastAcceptanceReconciliationStatus: status,
									...(input.reconcilerRuntimeProcessInstanceId
										? {
												lastAcceptanceReconciliationRuntimeProcessInstanceId:
													input.reconcilerRuntimeProcessInstanceId,
											}
										: {}),
									currentExecutionQualification: !currentSummary?.codexNativeSessionControlEndpoint
										? ("current_native_control_unavailable" as const)
										: currentSummary.agentNativeConversationSessionIdentity?.nativeSessionId ===
												operation.nativeSessionId
											? ("current_native_conversation_matches" as const)
											: ("current_native_conversation_changed" as const),
								},
							}
						: current,
				),
				result: undefined,
			}));
		};
		const result = await (input.deliver ?? deliverCodexNativePromptWithoutChangingComposer)({
			summary,
			workspaceId: input.workspaceId,
			text: "",
			clientUserMessageId: operation.clientUserMessageId,
			deliveryJournal: createCodexNativePromptDeliveryJournal({
				ledgerPath: input.ledgerPath,
				ledgerTaskId: record.task_id,
				idempotencyKey: record.idempotency_key,
			}),
			reconcileAcceptanceOnly: true,
			expectedHistoricalPromptSha256: operation.promptSha256,
			historicalNativeConversation: {
				nativeSessionId: operation.nativeSessionId,
				workingDirectoryPath: operation.workingDirectoryPath,
			},
			confirmationBudgetMs: 2_000,
			isCurrent: () => {
				const current = input.getSummary(operation.conversationSessionId);
				return (
					current?.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
					current?.agentNativeConversationSessionIdentity?.nativeSessionId ===
						summary.agentNativeConversationSessionIdentity?.nativeSessionId
				);
			},
			beforeSubmit: async () => false,
			onRequestAttempted: () => {
				throw new Error("原生接受补证禁止发送请求");
			},
		});
		await rememberObservation(result.status === "confirmed" ? "confirmed" : "unknown");
		if (result.status === "confirmed") confirmedCount += 1;
		else unknownCount += 1;
	}
	return { confirmedCount, unknownCount };
}
