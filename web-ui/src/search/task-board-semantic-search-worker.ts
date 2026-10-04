import type { TaskBoardSearchDocument } from "@/search/task-board-search";
import {
	createTaskBoardSemanticSearchIndex,
	type TaskBoardSemanticSearchIndex,
} from "@/search/task-board-semantic-search-engine";
import type {
	TaskBoardSemanticSearchWorkerRequest,
	TaskBoardSemanticSearchWorkerResponse,
} from "@/search/task-board-semantic-search-worker-protocol";

let index: TaskBoardSemanticSearchIndex | null = null;
let documentIndexes = new Map<TaskBoardSearchDocument, number>();
let pendingOperation = Promise.resolve();
// 一个索引只属于一个 Worker；串行化初始化与查询，避免模型并发执行及初始化竞态。
self.onmessage = (event: MessageEvent<TaskBoardSemanticSearchWorkerRequest>) => {
	const request = event.data;
	pendingOperation = pendingOperation.then(async () => {
		let response: TaskBoardSemanticSearchWorkerResponse;
		try {
			if (request.type === "initialize") {
				documentIndexes = new Map(request.documents.map((document, position) => [document, position]));
				index = await createTaskBoardSemanticSearchIndex(request.documents);
				response = { requestId: request.requestId, ok: true, results: [] };
			} else {
				if (!index) throw new Error("语义搜索索引尚未初始化");
				const results = await index.findResults(request.query, request.mode);
				response = {
					requestId: request.requestId,
					ok: true,
					results: results.map(({ document, ...result }) => {
						const documentIndex = documentIndexes.get(document);
						if (documentIndex === undefined) throw new Error("语义搜索命中不属于当前索引");
						return { ...result, documentIndex };
					}),
				};
			}
		} catch (error) {
			response = {
				requestId: request.requestId,
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		self.postMessage(response);
	});
};
