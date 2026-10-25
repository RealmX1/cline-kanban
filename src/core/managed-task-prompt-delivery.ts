import type { ManagedTaskPromptDeliveryMetadata, QueuedTaskPromptDeliveryEntry } from "./api-contract";

// 旧 Queue 条目按原有来源补齐投影，不重写磁盘、不猜测未知自动来源。
export function resolveManagedTaskPromptDeliveryMetadata(
	entry: QueuedTaskPromptDeliveryEntry,
): ManagedTaskPromptDeliveryMetadata {
	return (
		entry.managedDelivery ?? {
			messageType: entry.programmaticInjectionLedgerReceiptLink
				? "programmatic_injection"
				: entry.sourcePromptLibraryEntryId
					? "prompt_library"
					: "human_message",
			deliveryStrategy: "after_agent_turn",
			sourceLabel: entry.programmaticInjectionLedgerReceiptLink?.injectionSource ?? null,
			imageAttachmentCount: 0,
			terminalDeliveryReceipt: entry.programmaticInjectionLedgerReceiptLink?.settledTerminalDeliveryReceipt ?? null,
		}
	);
}

export function isManagedTaskPromptDeliveryScheduledAfterAgentTurn(
	entry: Pick<QueuedTaskPromptDeliveryEntry, "managedDelivery">,
): boolean {
	return entry.managedDelivery == null || entry.managedDelivery.deliveryStrategy === "after_agent_turn";
}
