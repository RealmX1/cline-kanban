import type { QueuedTaskPromptDeliveryEntry } from "./api-contract";

// 只匹配已退役的自动协议；用户自行标注 RVF 的普通任务消息仍沿通用投递路径。
export function isRetiredRvfAutomaticMessageSource(source: string | null | undefined): boolean {
	return (
		source === "rvf_automatic_closeout" ||
		source === "rvf-out-of-band-decision-point" ||
		source === "rvf_review_start_boundary"
	);
}

export function isRetiredRvfAutomaticQueuedDelivery(entry: QueuedTaskPromptDeliveryEntry): boolean {
	return (
		isRetiredRvfAutomaticMessageSource(entry.programmaticInjectionLedgerReceiptLink?.injectionSource) ||
		isRetiredRvfAutomaticMessageSource(entry.managedDelivery?.sourceLabel)
	);
}
