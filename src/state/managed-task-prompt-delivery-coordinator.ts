import { randomUUID } from "node:crypto";
import type {
	InjectionLedgerTerminalDeliveryReceipt,
	ManagedTaskPromptDeliveryMetadata,
	ManagedTaskPromptDeliveryOrigin,
	QueuedTaskPromptDeliveryEntry,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import { isManagedTaskPromptDeliveryScheduledAfterAgentTurn } from "../core/managed-task-prompt-delivery";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import {
	computeQueuedTaskPromptDeliveryTextSha256,
	getTaskEntries,
	isNonTerminalQueuedTaskPromptDeliveryState,
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
	withExpiredAndOverflowingEntriesPruned,
	withTaskEntries,
} from "./queued-task-prompt-delivery-store";
import { getThisRuntimeProcessInstanceId } from "./runtime-process-instance-heartbeat-registry";
import { getWorkspaceDirectoryPath } from "./workspace-state";

// 即时发送的观察预算大于现有 transport 的最坏收敛预算；它不是等待空闲的期限。
export const MANAGED_TASK_PROMPT_DELIVERY_CONFIRMATION_OBSERVATION_BUDGET_MS = 5 * 60_000;

function isManagedTaskPromptDeliveryAwaitingLateConfirmation(entry: QueuedTaskPromptDeliveryEntry): boolean {
	if (entry.deliveryState !== "settled_failed") return false;
	const reason = entry.managedDelivery?.terminalDeliveryReceipt?.reason;
	return (
		reason === "runtime_restarted_before_confirmation" ||
		reason === "submit_confirmation_budget_exhausted" ||
		reason === "codex_native_prompt_delivery_unconfirmed" ||
		entry.managedDelivery?.terminalDeliveryReceipt == null
	);
}

export interface ManagedTaskPromptDeliveryRegistration {
	workspaceId: string;
	taskId: string;
	workspaceTaskId?: string;
	text: string;
	deliveryRequestId?: string;
	origin: ManagedTaskPromptDeliveryOrigin;
	deliveryStrategy?: "immediate" | "session_startup";
	imageAttachments?: readonly Pick<RuntimeTaskImage, "data" | "mimeType">[];
	cancellationSupported?: boolean;
	idempotencyKey?: string;
	injectionLedgerTaskId?: string;
	summary?: RuntimeTaskSessionSummary | null;
}

type ManagedDeliveryChangeObserver = (workspaceId: string, taskId: string) => Promise<void>;
const managedDeliveryChangeObservers = new Set<ManagedDeliveryChangeObserver>();

export function observeManagedTaskPromptDeliveryChanges(observer: ManagedDeliveryChangeObserver): () => void {
	managedDeliveryChangeObservers.add(observer);
	return () => {
		managedDeliveryChangeObservers.delete(observer);
	};
}

async function announceManagedDeliveryChange(workspaceId: string, taskId: string): Promise<void> {
	for (const observer of managedDeliveryChangeObservers) {
		try {
			await observer(workspaceId, taskId);
		} catch (error) {
			// 记录已落盘，广播失败不是投递失败；既有 dispatcher sweep 会重新读取并广播。
			logAgentSessionRetentionWarning(
				`managed-delivery-projection-refresh-failed workspaceId=${workspaceId} reason=${String(error)}`,
			);
		}
	}
}

// 所有新记录都从这里登记。Queue 仍拥有等待空闲的调度，通用登记不构造第二份队列或正文账本。
export async function registerManagedTaskPromptDeliveryBeforeDispatch(
	input: ManagedTaskPromptDeliveryRegistration,
): Promise<{ entry: QueuedTaskPromptDeliveryEntry; newlyRegistered: boolean }> {
	const nowEpochMs = Date.now();
	const deliveryId = input.deliveryRequestId ?? randomUUID();
	const imageAttachmentCount = input.imageAttachments?.length ?? 0;
	const imageAttachmentContentsSha256 = computeQueuedTaskPromptDeliveryTextSha256(
		JSON.stringify(input.imageAttachments?.map((image) => [image.mimeType, image.data]) ?? []),
	);
	const { result } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const entries = getTaskEntries(current, input.taskId);
			const existing = entries.find((entry) => entry.queueEntryId === deliveryId);
			if (existing) {
				if (
					existing.text !== input.text ||
					existing.managedDelivery?.messageType !== input.origin.messageType ||
					existing.managedDelivery?.imageAttachmentCount !== imageAttachmentCount ||
					(imageAttachmentCount > 0 &&
						existing.managedDelivery?.imageAttachmentContentsSha256 !== imageAttachmentContentsSha256)
				)
					throw new Error("投递标识已用于其他消息，未再次发送。");
				return { next: current, result: { entry: existing, newlyRegistered: false } };
			}
			const entry: QueuedTaskPromptDeliveryEntry = {
				queueEntryId: deliveryId,
				taskId: input.taskId,
				workspaceTaskId: input.workspaceTaskId ?? input.taskId,
				text: input.text,
				deliverTogetherWithNextQueuedEntry: false,
				sourcePromptLibraryEntryId: null,
				sourcePromptLibraryEntryTextSha256: null,
				deliveryState: "handed_to_transport",
				deliveryAttemptCount: 1,
				lastAttemptedAt: nowEpochMs,
				settledAt: null,
				dispatchIdempotencyKey: input.idempotencyKey ?? deliveryId,
				claimedForSessionIncarnationId: input.summary?.runtimeSessionIncarnationId ?? null,
				claimedAtTurnSequence: null,
				enqueuedAt: nowEpochMs,
				expiresAt: nowEpochMs + MANAGED_TASK_PROMPT_DELIVERY_CONFIRMATION_OBSERVATION_BUDGET_MS,
				lastDeliveryFailureNote: null,
				survivedRuntimeRestartAtEpochMs: null,
				humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
				custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
				managedDelivery: {
					messageType: input.origin.messageType,
					sourceLabel: input.origin.sourceLabel ?? null,
					deliveryStrategy: input.deliveryStrategy ?? "immediate",
					imageAttachmentCount,
					imageAttachmentContentsSha256,
					terminalDeliveryReceipt: null,
					cancellationSupported: input.cancellationSupported ?? false,
					targetRuntimeSessionIncarnationId: input.summary?.runtimeSessionIncarnationId ?? null,
					targetNativeSessionId: input.summary?.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
					...(input.idempotencyKey
						? {
								injectionLedgerReference: {
									taskId: input.injectionLedgerTaskId ?? input.taskId,
									idempotencyKey: input.idempotencyKey,
								},
							}
						: {}),
				},
			};
			return {
				next: withExpiredAndOverflowingEntriesPruned(
					withTaskEntries(current, input.taskId, [...entries, entry]),
					nowEpochMs,
				),
				result: { entry, newlyRegistered: true },
			};
		},
		nowEpochMs,
		"register-managed-delivery",
	);
	await announceManagedDeliveryChange(input.workspaceId, input.taskId);
	return result;
}

export async function settleManagedTaskPromptDelivery(input: {
	workspaceId: string;
	taskId: string;
	deliveryId: string;
	receipt: InjectionLedgerTerminalDeliveryReceipt;
	failureNote?: string;
}): Promise<void> {
	if (input.receipt.status === "accepted_pending_submit_confirmation") return;
	const nowEpochMs = Date.now();
	await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			let changed = false;
			const entries = getTaskEntries(current, input.taskId).map((entry) => {
				const delivered = input.receipt.status !== "delivery_failed";
				const recoversLateConfirmation = delivered && isManagedTaskPromptDeliveryAwaitingLateConfirmation(entry);
				if (
					entry.queueEntryId !== input.deliveryId ||
					!entry.managedDelivery ||
					(!isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState) && !recoversLateConfirmation)
				)
					return entry;
				changed = true;
				return {
					...entry,
					deliveryState: delivered
						? ("settled_delivered" as const)
						: input.receipt.reason === "cancelled_before_delivery"
							? ("cancelled" as const)
							: ("settled_failed" as const),
					settledAt: nowEpochMs,
					lastDeliveryFailureNote: delivered
						? null
						: (input.failureNote ?? input.receipt.reason ?? "未能确认消息已送达。"),
					managedDelivery: {
						...entry.managedDelivery,
						terminalDeliveryReceipt: input.receipt,
						...(recoversLateConfirmation
							? {
									recoveredTerminalReceiptAtEpochMs: nowEpochMs,
									previousUnconfirmedTerminalDeliveryReceipt:
										entry.managedDelivery.terminalDeliveryReceipt ?? null,
									previousUnconfirmedDeliveryFailureNote: entry.lastDeliveryFailureNote,
								}
							: {}),
					},
				};
			});
			return {
				next: changed
					? withExpiredAndOverflowingEntriesPruned(withTaskEntries(current, input.taskId, entries), nowEpochMs)
					: current,
				result: null,
			};
		},
		nowEpochMs,
		"settle-managed-delivery",
	);
	await announceManagedDeliveryChange(input.workspaceId, input.taskId);
}

export interface ManagedTaskPromptDeliveryHandle {
	deliveryId: string;
	settle: (receipt: InjectionLedgerTerminalDeliveryReceipt, failureNote?: string) => Promise<void>;
}

export async function beginManagedTaskPromptDelivery(input: ManagedTaskPromptDeliveryRegistration): Promise<{
	handle: ManagedTaskPromptDeliveryHandle;
	entry: QueuedTaskPromptDeliveryEntry;
	newlyRegistered: boolean;
}> {
	// CLI 既有幂等键按 workspace + 目标会话 + key 隔离，不向注入账本制造人工记录。
	const registration = await registerManagedTaskPromptDeliveryBeforeDispatch({
		...input,
		deliveryRequestId:
			input.deliveryRequestId ??
			(input.idempotencyKey
				? `managed-delivery-${computeQueuedTaskPromptDeliveryTextSha256(`${input.taskId}\0${input.idempotencyKey}`)}`
				: undefined),
	});
	const handle: ManagedTaskPromptDeliveryHandle = {
		deliveryId: registration.entry.queueEntryId,
		settle: async (receipt, failureNote) => {
			await settleManagedTaskPromptDelivery({
				workspaceId: input.workspaceId,
				taskId: input.taskId,
				deliveryId: registration.entry.queueEntryId,
				receipt,
				failureNote,
			});
		},
	};
	return { ...registration, handle };
}

// 回执先反馈业务调用方，存储异常独立记录；不能把已发送的消息反报成失败诱导重发。
export function settleManagedTaskPromptDeliveryWithoutBlocking(
	handle: ManagedTaskPromptDeliveryHandle,
	receipt: InjectionLedgerTerminalDeliveryReceipt & { failureNote?: string },
): void {
	void (async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await handle.settle(receipt, receipt.failureNote);
				return;
			} catch (error) {
				logAgentSessionRetentionWarning(
					`managed-delivery-receipt-persistence-failed deliveryId=${handle.deliveryId} attempt=${attempt + 1} reason=${String(error)}`,
				);
				if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 100 * (attempt + 1)));
			}
		}
	})();
}

function buildManagedTaskPromptDeliveryReceiptReconciliationIdentity(entry: QueuedTaskPromptDeliveryEntry): string {
	return JSON.stringify([
		entry.taskId,
		entry.queueEntryId,
		computeQueuedTaskPromptDeliveryTextSha256(entry.text),
		entry.dispatchIdempotencyKey,
		entry.managedDelivery?.messageType,
		entry.managedDelivery?.imageAttachmentCount,
		entry.managedDelivery?.imageAttachmentContentsSha256,
		entry.managedDelivery?.injectionLedgerReference?.taskId,
		entry.managedDelivery?.injectionLedgerReference?.idempotencyKey,
		entry.managedDelivery?.targetRuntimeSessionIncarnationId,
		entry.managedDelivery?.targetNativeSessionId,
	]);
}

// 60s sweep 与重启后首次读取均可调用：只补核回执，不触发任何发送。身份、正文、目标和 key 同时匹配。
export async function reconcileManagedTaskPromptDeliveryReceipts(
	workspaceId: string,
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	nowEpochMs = Date.now(),
): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> {
	const candidates = Object.values(snapshot.entriesByTaskId)
		.flat()
		.filter(
			(entry) =>
				!isManagedTaskPromptDeliveryScheduledAfterAgentTurn(entry) &&
				(isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState) ||
					entry.deliveryState === "settled_failed"),
		);
	if (candidates.length === 0) return snapshot;
	const records = candidates.some((entry) => entry.managedDelivery?.injectionLedgerReference)
		? await readTaskMessageInjectionLedger(
				getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId)),
			).catch(() => [])
		: [];
	const receiptsByDeliveryIdentity = new Map<string, InjectionLedgerTerminalDeliveryReceipt>();
	for (const entry of candidates) {
		const reference = entry.managedDelivery?.injectionLedgerReference;
		// 注入账本只有正文摘要，不能据此证明附件内容；有图请求保留 transport 的直接确认。
		const record =
			reference && entry.managedDelivery?.imageAttachmentCount === 0
				? records.find(
						(candidate) =>
							candidate.task_id === reference.taskId &&
							candidate.idempotency_key === reference.idempotencyKey &&
							candidate.attempt_id === entry.taskId &&
							candidate.prompt_sha256 === computeQueuedTaskPromptDeliveryTextSha256(entry.text),
					)
				: null;
		if (record && record.terminal_delivery_status !== "accepted_pending_submit_confirmation")
			receiptsByDeliveryIdentity.set(buildManagedTaskPromptDeliveryReceiptReconciliationIdentity(entry), {
				status: record.terminal_delivery_status,
				reason: record.terminal_delivery_failure_reason ?? null,
				...(record.codex_native_prompt_delivery_evidence
					? { codexNativePromptDeliveryEvidence: record.codex_native_prompt_delivery_evidence }
					: {}),
			});
		else if (isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState) && nowEpochMs >= entry.expiresAt)
			receiptsByDeliveryIdentity.set(buildManagedTaskPromptDeliveryReceiptReconciliationIdentity(entry), {
				status: "delivery_failed",
				reason: "runtime_restarted_before_confirmation",
			});
	}
	if (receiptsByDeliveryIdentity.size === 0) return snapshot;
	const { snapshot: reconciled } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		workspaceId,
		(current) => {
			let changed = false;
			const entriesByTaskId = Object.fromEntries(
				Object.entries(current.entriesByTaskId).map(([taskId, entries]) => [
					taskId,
					entries.map((entry) => {
						const receipt = receiptsByDeliveryIdentity.get(
							buildManagedTaskPromptDeliveryReceiptReconciliationIdentity(entry),
						);
						if (!receipt || !entry.managedDelivery) return entry;
						const delivered =
							receipt.status === "delivered_and_submit_confirmed" ||
							receipt.status === "delivered_queued_behind_active_agent_turn";
						const previousIsUnconfirmed = isManagedTaskPromptDeliveryAwaitingLateConfirmation(entry);
						if (
							!isNonTerminalQueuedTaskPromptDeliveryState(entry.deliveryState) &&
							!(delivered && previousIsUnconfirmed)
						)
							return entry;
						changed = true;
						return {
							...entry,
							deliveryState: delivered
								? ("settled_delivered" as const)
								: receipt.reason === "cancelled_before_delivery"
									? ("cancelled" as const)
									: ("settled_failed" as const),
							settledAt: nowEpochMs,
							lastDeliveryFailureNote: delivered ? null : "未能核实消息送达，保留原始记录，不自动重发。",
							managedDelivery: {
								...entry.managedDelivery,
								terminalDeliveryReceipt: receipt,
								...(delivered && previousIsUnconfirmed
									? {
											recoveredTerminalReceiptAtEpochMs: nowEpochMs,
											previousUnconfirmedTerminalDeliveryReceipt:
												entry.managedDelivery.terminalDeliveryReceipt ?? null,
											previousUnconfirmedDeliveryFailureNote: entry.lastDeliveryFailureNote,
										}
									: {}),
							},
						};
					}),
				]),
			);
			return {
				next: changed ? withExpiredAndOverflowingEntriesPruned({ entriesByTaskId }, nowEpochMs) : current,
				result: null,
			};
		},
		nowEpochMs,
		"reconcile-managed-delivery-receipts",
	);
	return reconciled;
}

export function buildManagedTaskPromptDeliveryOrigin(input: {
	source?: string;
	deliveryOrigin?: ManagedTaskPromptDeliveryOrigin;
}): ManagedTaskPromptDeliveryOrigin {
	return (
		input.deliveryOrigin ?? {
			messageType:
				input.source === "task_main_session_handover"
					? "system_continuation"
					: input.source
						? "programmatic_injection"
						: "human_message",
			...(input.source ? { sourceLabel: input.source } : {}),
		}
	);
}

export type { ManagedTaskPromptDeliveryMetadata };
