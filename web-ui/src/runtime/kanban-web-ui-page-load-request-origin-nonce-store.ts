// Web UI 页面加载 nonce 的浏览器端单一来源（dd2db §R3 Y-EVENT-9）。
//
// - runtime-state-stream 每次连上 / 重连都调用 reacquire，向 runtime 重新签发一个 nonce（runtime 只在内存里认它，
//   重启后旧 nonce 全部失效）；
// - trpc-client 的每个请求在发出那一刻读当前 nonce 塞进请求头；还没拿到过 nonce（首次连上之前）就不带头，照常发；
// - 任何请求被 runtime 以「未知 nonce」拒绝时，由 trpc-client 的重试 link 调 reacquire 后重发一次。
//
// 签发请求走本文件自带的专用 client：既不带 nonce 头、也不经过「未知 nonce → 重取并重发」link，所以重取请求本身
// 不可能因为带着旧 nonce 被拒、再触发重取，形成死循环。

import type { RuntimeAppRouter } from "@runtime-trpc";
import { createTRPCProxyClient, httpLink } from "@trpc/client";

let kanbanWebUiPageLoadRequestOriginNonceLatestIssuedByRuntime: string | null = null;
// 单飞：同一时刻最多一个签发请求在途；重连与「未知 nonce」重试同时触发时共享同一次签发。
let kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight: Promise<string> | null = null;

type KanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient = ReturnType<
	typeof createTRPCProxyClient<RuntimeAppRouter>
>;
let kanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient: KanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient | null =
	null;

function getKanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient(): KanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient {
	if (!kanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient) {
		kanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient = createTRPCProxyClient<RuntimeAppRouter>({
			links: [httpLink({ url: "/api/trpc" })],
		});
	}
	return kanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient;
}

export function readKanbanWebUiPageLoadRequestOriginNonceForOutgoingRuntimeRequests(): string | null {
	return kanbanWebUiPageLoadRequestOriginNonceLatestIssuedByRuntime;
}

// 向 runtime 重新签发一个 nonce 并设为当前值。签发失败时 reject（调用方决定是吞掉还是把原错误抛回去），
// 当前值保持不变。
export function reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime(): Promise<string> {
	if (kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight) {
		return kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight;
	}
	const reacquisition = (async () => {
		try {
			const issued =
				await getKanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient().runtime.issueKanbanWebUiPageLoadRequestOriginNonce.mutate();
			kanbanWebUiPageLoadRequestOriginNonceLatestIssuedByRuntime =
				issued.kanbanWebUiPageLoadIssuedRequestOriginNonce;
			return issued.kanbanWebUiPageLoadIssuedRequestOriginNonce;
		} finally {
			kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight = null;
		}
	})();
	kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight = reacquisition;
	return reacquisition;
}

// 「未知 nonce」重试用：被拒请求发出时带的 nonce 若已被别的重取换掉（例如重连刚签发了新的），直接用新的重发，
// 不再多签发一次；否则（仍是那个被拒的 nonce，或还没有 nonce）才真正向 runtime 重取。
export function reacquireKanbanWebUiPageLoadRequestOriginNonceUnlessAlreadyReplacedSince(
	kanbanWebUiPageLoadRequestOriginNonceRejectedByRuntime: string | null,
): Promise<string> {
	const latest = kanbanWebUiPageLoadRequestOriginNonceLatestIssuedByRuntime;
	if (
		latest !== null &&
		latest !== kanbanWebUiPageLoadRequestOriginNonceRejectedByRuntime &&
		kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight === null
	) {
		return Promise.resolve(latest);
	}
	return reacquireKanbanWebUiPageLoadRequestOriginNonceFromRuntime();
}

export function resetKanbanWebUiPageLoadRequestOriginNonceStoreForTests(): void {
	kanbanWebUiPageLoadRequestOriginNonceLatestIssuedByRuntime = null;
	kanbanWebUiPageLoadRequestOriginNonceReacquisitionInFlight = null;
	kanbanWebUiPageLoadRequestOriginNonceIssuingTrpcClient = null;
}
