import type { TaskBoardSearchDocument, TaskBoardSearchResult } from "@/search/task-board-search";

export type TaskBoardSemanticSearchWorkerRequest = { requestId: number } & (
	| { type: "initialize"; documents: readonly TaskBoardSearchDocument[] }
	| { type: "search"; query: string; mode: "hybrid" | "semantic" }
);
// 只传数组下标，主线程恢复原 document 引用；跨项目相同 taskId 不能合并成同一命中。
export type TaskBoardSemanticSearchWorkerResult = Omit<TaskBoardSearchResult, "document"> & { documentIndex: number };
export type TaskBoardSemanticSearchWorkerResponse = { requestId: number } & (
	| { ok: true; results: TaskBoardSemanticSearchWorkerResult[] }
	| { ok: false; message: string }
);
