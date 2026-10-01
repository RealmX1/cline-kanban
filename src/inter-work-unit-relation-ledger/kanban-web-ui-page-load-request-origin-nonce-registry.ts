import { randomUUID } from "node:crypto";

// 只存内存（Y-EVENT-9）：runtime 重启后旧 nonce 全部失效，Web UI 重连 stream 时重取。
// 上限防长时间运行的 runtime 被频繁重连撑大；被淘汰的 nonce 走「未知 → 重取重试」，不会丢请求。
// EXPERIMENT_NODE: 内存里最多保留多少个已签发 nonce；按「一个标签页一天重连数百次」估算取 10000。
const KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_MAXIMUM_RETAINED_COUNT = 10_000;

// Set 保持插入顺序，最早签发的在前，超限时从头淘汰。
const issuedKanbanWebUiPageLoadRequestOriginNonces = new Set<string>();

export function issueKanbanWebUiPageLoadRequestOriginNonce(): string {
	const issuedNonce = randomUUID();
	issuedKanbanWebUiPageLoadRequestOriginNonces.add(issuedNonce);
	while (
		issuedKanbanWebUiPageLoadRequestOriginNonces.size >
		KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_MAXIMUM_RETAINED_COUNT
	) {
		const oldestIssuedNonce = issuedKanbanWebUiPageLoadRequestOriginNonces.values().next().value;
		if (oldestIssuedNonce === undefined) {
			break;
		}
		issuedKanbanWebUiPageLoadRequestOriginNonces.delete(oldestIssuedNonce);
	}
	return issuedNonce;
}

export type KanbanWebUiPageLoadRequestOriginNonceVerificationStatus = "absent" | "verified" | "unknown";

export function verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue(
	headerValue: string | string[] | undefined,
): KanbanWebUiPageLoadRequestOriginNonceVerificationStatus {
	const rawValue = (Array.isArray(headerValue) ? headerValue[0] : headerValue)?.trim();
	if (!rawValue) {
		return "absent";
	}
	return issuedKanbanWebUiPageLoadRequestOriginNonces.has(rawValue) ? "verified" : "unknown";
}
