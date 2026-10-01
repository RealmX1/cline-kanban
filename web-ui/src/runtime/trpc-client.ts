import {
	KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME,
	KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE,
} from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import type { RuntimeAppRouter } from "@runtime-trpc";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable, type Unsubscribable } from "@trpc/server/observable";
import {
	reacquireKanbanWebUiPageLoadRequestOriginNonceUnlessAlreadyReplacedSince,
	readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests,
} from "@/runtime/kanban-web-ui-page-load-request-origin-nonce-store";

interface TrpcErrorDataWithConflictRevision {
	code?: string;
	conflictRevision?: number | null;
}

type RuntimeTrpcClient = ReturnType<typeof createTRPCProxyClient<RuntimeAppRouter>>;

const clientByWorkspaceId = new Map<string, RuntimeTrpcClient>();

// 请求头在每个 HTTP 请求发出那一刻求值：nonce 被重连 / 重试换掉后，后续请求（含重发）自动带上新值。
// 还没拿到过 nonce 时不带这个头——runtime 不拒绝不带头的请求，只把它记成裸 tRPC 调用方。
export function buildRuntimeTrpcRequestHeadersWithWorkspaceScopeAndWebUiPageLoadNonce(
	workspaceId: string | null,
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (workspaceId) {
		headers["x-kanban-workspace-id"] = workspaceId;
	}
	const kanbanWebUiPageLoadRequestOriginNonce = readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests();
	if (kanbanWebUiPageLoadRequestOriginNonce) {
		headers[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME] = kanbanWebUiPageLoadRequestOriginNonce;
	}
	return headers;
}

export function isKanbanWebUiPageLoadRequestOriginNonceUnknownToRuntimeError(error: unknown): boolean {
	if (!(error instanceof TRPCClientError)) {
		return false;
	}
	const data = error.data as { code?: unknown } | undefined;
	return (
		data?.code === "PRECONDITION_FAILED" &&
		error.message === KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE
	);
}

// runtime 重启后旧 nonce 全部失效，带旧 nonce 的请求会以 PRECONDITION_FAILED + 固定消息被拒。这个 link 逐个 op
// 处理（批量请求里每个被拒的 op 各自走一遍）：重取 nonce → 原样重发**一次**；重发仍失败、或重取本身失败，都把
// 原错误抛给调用方。重取用 nonce store 的专用 client，不经过本 link，不会递归。
function createKanbanWebUiPageLoadRequestOriginNonceReacquireAndRetryOnceLink(): TRPCLink<RuntimeAppRouter> {
	return () =>
		({ op, next }) =>
			observable((observer) => {
				let activeSubscription: Unsubscribable | null = null;
				let isUnsubscribed = false;
				const sendOperation = (isRetryAfterNonceReacquisition: boolean) => {
					const kanbanWebUiPageLoadRequestOriginNonceAtSend =
						readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests();
					activeSubscription = next(op).subscribe({
						next(envelope) {
							observer.next(envelope);
						},
						error(error) {
							if (
								isRetryAfterNonceReacquisition ||
								!isKanbanWebUiPageLoadRequestOriginNonceUnknownToRuntimeError(error)
							) {
								observer.error(error);
								return;
							}
							reacquireKanbanWebUiPageLoadRequestOriginNonceUnlessAlreadyReplacedSince(
								kanbanWebUiPageLoadRequestOriginNonceAtSend,
							).then(
								() => {
									if (!isUnsubscribed) {
										sendOperation(true);
									}
								},
								() => {
									observer.error(error);
								},
							);
						},
						complete() {
							observer.complete();
						},
					});
				};
				sendOperation(false);
				return () => {
					isUnsubscribed = true;
					activeSubscription?.unsubscribe();
				};
			});
}

export function getRuntimeTrpcClient(workspaceId: string | null): RuntimeTrpcClient {
	const key = workspaceId ?? "__unscoped__";
	const existing = clientByWorkspaceId.get(key);
	if (existing) {
		return existing;
	}
	const created = createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			createKanbanWebUiPageLoadRequestOriginNonceReacquireAndRetryOnceLink(),
			httpBatchLink({
				url: "/api/trpc",
				headers: () => buildRuntimeTrpcRequestHeadersWithWorkspaceScopeAndWebUiPageLoadNonce(workspaceId),
			}),
		],
	});
	clientByWorkspaceId.set(key, created);
	return created;
}

export function createWorkspaceTrpcClient(workspaceId: string): RuntimeTrpcClient {
	return getRuntimeTrpcClient(workspaceId);
}

function readTrpcErrorData(error: TRPCClientError<RuntimeAppRouter>): TrpcErrorDataWithConflictRevision | null {
	const data = error.data as TrpcErrorDataWithConflictRevision | undefined;
	if (!data || typeof data !== "object") {
		return null;
	}
	return data;
}

export function readTrpcConflictRevision(error: unknown): number | null {
	if (!(error instanceof TRPCClientError)) {
		return null;
	}
	const data = readTrpcErrorData(error);
	if (data?.code !== "CONFLICT") {
		return null;
	}
	return typeof data.conflictRevision === "number" ? data.conflictRevision : null;
}
