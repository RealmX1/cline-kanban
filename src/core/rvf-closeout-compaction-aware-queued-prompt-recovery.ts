import { createHash } from "node:crypto";
import type { InjectionLedgerTerminalDeliveryReceipt, QueuedTaskPromptDeliveryEntry } from "./api-contract";
import {
	CODEX_RVF_CLOSEOUT_CONFIRMATION_SWEEP_MARGIN_MS,
	resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs,
} from "./codex-rvf-closeout-compaction-aware-confirmation";
import type { TaskMessageInjectionRecord } from "./task-message-injection-ledger";

export type RvfCloseoutQueuedPromptRecovery =
	| { kind: "waiting_for_existing_submission"; becomesStaleAtEpochMs: number }
	| { kind: "settled_existing_submission"; receipt: InjectionLedgerTerminalDeliveryReceipt; settledAtEpochMs: number };

// 只恢复已经交给 transport、且有同一正文和提交快照的自动收尾；不授予重新发送资格。
export function resolveRvfCloseoutCompactionAwareQueuedPromptRecovery(input: {
	workspaceId: string;
	entry: QueuedTaskPromptDeliveryEntry;
	ledgerRecords: readonly TaskMessageInjectionRecord[];
	nowEpochMs: number;
}): RvfCloseoutQueuedPromptRecovery | null {
	const { entry } = input;
	const link = entry.programmaticInjectionLedgerReceiptLink;
	if (entry.deliveryState !== "handed_to_transport" || link?.injectionSource !== "rvf_automatic_closeout") return null;
	const queuedPromptSha256 = createHash("sha256").update(entry.text).digest("hex");
	const matches = input.ledgerRecords.filter((record) => {
		const binding = record.nativeCompactionAwareConfirmation?.binding;
		return (
			binding?.workspaceId === input.workspaceId &&
			binding.conversationSessionId === entry.taskId &&
			binding.idempotencyKey === link.injectionLedgerIdempotencyKey &&
			binding.idempotencyKey === entry.dispatchIdempotencyKey &&
			binding.promptSha256 === record.prompt_sha256 &&
			record.prompt_sha256 === queuedPromptSha256 &&
			record.idempotency_key === binding.idempotencyKey &&
			record.source === link.injectionSource &&
			record.task_id === (link.injectionLedgerTaskId ?? entry.taskId) &&
			(record.task_id === binding.taskId || record.task_id === binding.conversationSessionId) &&
			(record.attempt_id === undefined || record.attempt_id === entry.taskId) &&
			(record.agent_idle_gated_queue_entry_id === undefined ||
				record.agent_idle_gated_queue_entry_id === entry.queueEntryId)
		);
	});
	const record = matches.length === 1 ? matches[0] : undefined;
	const state = record?.nativeCompactionAwareConfirmation;
	if (!record || !state) return null;
	if (record.terminal_delivery_status === "accepted_pending_submit_confirmation") {
		const becomesStaleAtEpochMs =
			resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(state) + CODEX_RVF_CLOSEOUT_CONFIRMATION_SWEEP_MARGIN_MS;
		if (input.nowEpochMs < becomesStaleAtEpochMs)
			return { kind: "waiting_for_existing_submission", becomesStaleAtEpochMs };
		return {
			kind: "settled_existing_submission",
			settledAtEpochMs: input.nowEpochMs,
			receipt: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
		};
	}
	return {
		kind: "settled_existing_submission",
		settledAtEpochMs: Date.parse(record.terminal_delivery_status_updated_at) || input.nowEpochMs,
		receipt: {
			status: record.terminal_delivery_status,
			reason:
				record.terminal_delivery_status === "delivery_failed"
					? (record.terminal_delivery_failure_reason ?? "submit_confirmation_budget_exhausted")
					: null,
			...(record.codex_native_prompt_delivery_evidence
				? { codexNativePromptDeliveryEvidence: record.codex_native_prompt_delivery_evidence }
				: {}),
		},
	};
}

export function settleQueuedRvfCloseoutFromExistingSubmission(
	entry: QueuedTaskPromptDeliveryEntry,
	recovery: Extract<RvfCloseoutQueuedPromptRecovery, { kind: "settled_existing_submission" }>,
): QueuedTaskPromptDeliveryEntry {
	const link = entry.programmaticInjectionLedgerReceiptLink;
	if (!link) return entry;
	return {
		...entry,
		deliveryState: recovery.receipt.status === "delivery_failed" ? "settled_failed" : "settled_delivered",
		settledAt: recovery.settledAtEpochMs,
		lastDeliveryFailureNote: recovery.receipt.reason,
		programmaticInjectionLedgerReceiptLink: { ...link, settledTerminalDeliveryReceipt: recovery.receipt },
	};
}
