import type { TaskBoardSearchDocument } from "@/search/task-board-search";
import type { TaskBoardSemanticSearchIndex } from "@/search/task-board-semantic-search-engine";
import type {
	TaskBoardSemanticSearchWorkerRequest,
	TaskBoardSemanticSearchWorkerResponse,
	TaskBoardSemanticSearchWorkerResult,
} from "@/search/task-board-semantic-search-worker-protocol";

export type { TaskBoardSemanticSearchIndex } from "@/search/task-board-semantic-search-engine";

export async function createTaskBoardSemanticSearchIndex(
	documents: readonly TaskBoardSearchDocument[],
	signal?: AbortSignal,
): Promise<TaskBoardSemanticSearchIndex> {
	if (signal?.aborted) throw new Error("语义搜索已取消");
	if (!documents.some((document) => document.title.length > 0 || document.prompt.length > 0))
		return { findResults: async () => [] };
	const worker = new Worker(new URL("./task-board-semantic-search-worker.ts", import.meta.url), { type: "module" });
	let nextRequestId = 0;
	let stoppedError: Error | null = null;
	const pendingRequests = new Map<
		number,
		{
			resolve: (results: TaskBoardSemanticSearchWorkerResult[]) => void;
			reject: (error: Error) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	const abort = () => stop(new Error("语义搜索已取消"));
	const stop = (error: Error) => {
		if (stoppedError) return;
		stoppedError = error;
		worker.terminate();
		signal?.removeEventListener("abort", abort);
		for (const request of pendingRequests.values()) {
			clearTimeout(request.timeout);
			request.reject(error);
		}
		pendingRequests.clear();
	};
	signal?.addEventListener("abort", abort, { once: true });
	worker.onerror = () => stop(new Error("语义搜索 Worker 加载或执行失败"));
	worker.onmessageerror = () => stop(new Error("语义搜索 Worker 响应无法解码"));
	worker.onmessage = (event: MessageEvent<TaskBoardSemanticSearchWorkerResponse>) => {
		const response = event.data;
		const pending = pendingRequests.get(response.requestId);
		if (!pending) return;
		if (!response.ok) {
			stop(new Error(response.message));
			return;
		}
		clearTimeout(pending.timeout);
		pendingRequests.delete(response.requestId);
		pending.resolve(response.results);
	};
	const request = (payload: TaskBoardSemanticSearchWorkerRequest) =>
		new Promise<TaskBoardSemanticSearchWorkerResult[]>((resolve, reject) => {
			if (stoppedError) {
				reject(stoppedError);
				return;
			}
			const timeout = setTimeout(() => stop(new Error("语义搜索超时，请重试或使用模糊搜索")), 120_000);
			pendingRequests.set(payload.requestId, { resolve, reject, timeout });
			try {
				worker.postMessage(payload);
			} catch (error) {
				stop(error instanceof Error ? error : new Error(String(error)));
			}
		});
	await request({ requestId: nextRequestId++, type: "initialize", documents });
	return {
		findResults: async (query, mode) => {
			const results = await request({ requestId: nextRequestId++, type: "search", query, mode });
			return results.map(({ documentIndex, ...result }) => {
				const document = documents[documentIndex];
				if (!document) throw new Error("语义搜索返回了无效文档下标");
				return { ...result, document };
			});
		},
	};
}
