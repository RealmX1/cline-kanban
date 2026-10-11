import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTaskBoardSearchDocuments } from "@/search/task-board-search";
import { createTaskBoardSemanticSearchIndex } from "@/search/task-board-semantic-search";
import type {
	TaskBoardSemanticSearchWorkerRequest,
	TaskBoardSemanticSearchWorkerResponse,
} from "@/search/task-board-semantic-search-worker-protocol";

class ControlledWorker {
	static instances: ControlledWorker[] = [];
	onmessage: ((event: MessageEvent<TaskBoardSemanticSearchWorkerResponse>) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessageerror: (() => void) | null = null;
	requests: TaskBoardSemanticSearchWorkerRequest[] = [];
	terminate = vi.fn();
	constructor(
		readonly url: URL,
		readonly options: WorkerOptions,
	) {
		ControlledWorker.instances.push(this);
	}
	postMessage(request: TaskBoardSemanticSearchWorkerRequest) {
		this.requests.push(request);
	}
	respond(response: TaskBoardSemanticSearchWorkerResponse) {
		this.onmessage?.({ data: response } as MessageEvent<TaskBoardSemanticSearchWorkerResponse>);
	}
}
const board = {
	columns: [
		{
			id: "review" as const,
			title: "Review",
			cards: [
				{
					id: "same-id",
					title: "deployment",
					prompt: "prepare API rollout",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		},
	],
};
const documents = [
	...buildTaskBoardSearchDocuments(board, { projectId: "one", projectName: "One" }),
	...buildTaskBoardSearchDocuments(board, { projectId: "two", projectName: "Two" }),
];
beforeEach(() => {
	ControlledWorker.instances = [];
	vi.stubGlobal("Worker", ControlledWorker);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function worker() {
	return ControlledWorker.instances[0]!;
}

it("按请求 id 路由并保留跨项目 document 原引用，取消后拒绝在途与后续请求", async () => {
	const controller = new AbortController();
	const initializing = createTaskBoardSemanticSearchIndex(documents, controller.signal);
	expect(worker().options).toEqual({ type: "module" });
	expect(worker().url.pathname).toContain("task-board-semantic-search-worker.ts");
	worker().respond({ requestId: 0, ok: true, results: [] });
	const index = await initializing;
	const first = index.findResults("deploy", "semantic", "title_and_prompt");
	const second = index.findResults("rollout", "hybrid", "prompt_only");
	// 字段范围随查询请求透传给 Worker（索引在 Worker 里，换范围只换查询、不重发 initialize）。
	expect(worker().requests.slice(1)).toEqual([
		{ requestId: 1, type: "search", query: "deploy", mode: "semantic", matchedTextFieldScope: "title_and_prompt" },
		{ requestId: 2, type: "search", query: "rollout", mode: "hybrid", matchedTextFieldScope: "prompt_only" },
	]);
	const match = {
		score: 0.9,
		matchSources: ["title" as const],
		titleMatchCharacterPositions: new Set<number>(),
		promptMatchCharacterPositions: new Set<number>(),
	};
	worker().respond({ requestId: 2, ok: true, results: [{ ...match, documentIndex: 1 }] });
	worker().respond({ requestId: 1, ok: true, results: [{ ...match, documentIndex: 0 }] });
	expect((await first)[0]?.document).toBe(documents[0]);
	expect((await second)[0]?.document).toBe(documents[1]);
	const pending = index.findResults("another", "semantic", "title_and_prompt");
	const rejected = expect(pending).rejects.toThrow("取消");
	controller.abort();
	await rejected;
	expect(worker().terminate).toHaveBeenCalledOnce();
	await expect(index.findResults("again", "semantic", "title_and_prompt")).rejects.toThrow("取消");
});

it.each(["error", "messageerror", "timeout", "response"] as const)(
	"%s 失败会拒绝请求并终止 Worker，供现有模糊搜索降级",
	async (failure) => {
		const initializing = createTaskBoardSemanticSearchIndex(documents);
		const rejected = expect(initializing).rejects.toThrow();
		if (failure === "error") worker().onerror?.();
		if (failure === "messageerror") worker().onmessageerror?.();
		if (failure === "timeout") await vi.advanceTimersByTimeAsync(120_000);
		if (failure === "response") worker().respond({ requestId: 0, ok: false, message: "模型下载失败" });
		await rejected;
		expect(worker().terminate).toHaveBeenCalledOnce();
	},
);

it("取消模型初始化和空文档不遗留 Worker", async () => {
	const controller = new AbortController();
	const pending = createTaskBoardSemanticSearchIndex(documents, controller.signal);
	const rejected = expect(pending).rejects.toThrow("取消");
	controller.abort();
	await rejected;
	expect(worker().terminate).toHaveBeenCalledOnce();
	await expect(createTaskBoardSemanticSearchIndex(documents, controller.signal)).rejects.toThrow("取消");
	expect(
		await (await createTaskBoardSemanticSearchIndex([])).findResults("x", "semantic", "title_and_prompt"),
	).toEqual([]);
	expect(ControlledWorker.instances).toHaveLength(1);
});
