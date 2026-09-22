import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTaskBoardSearchDocument } from "@/search/task-board-search";
import { createTaskBoardSemanticSearchIndex } from "@/search/task-board-semantic-search-engine";

const embeddingModel = vi.hoisted(() => ({ embed: vi.fn() }));

// 只替换远端模型，保留真实 Orama 和 embeddings 插件，覆盖异步 hook 的等待语义。
vi.mock("@tensorflow-models/universal-sentence-encoder", () => ({
	load: async () => embeddingModel,
}));

function createDeferredEmbeddingCompletion() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createEmbeddingTensor(text: string) {
	const vector = new Float32Array(512);
	vector[/deploy|release/u.test(text) ? 0 : 1] = 1;
	return { data: async () => vector };
}

beforeEach(() => {
	embeddingModel.embed.mockReset().mockImplementation(async (text: string) => createEmbeddingTensor(text));
});

afterEach(() => {
	vi.useRealTimers();
});

const documents = ["deploy application", "cake dessert"].map((title, index) =>
	buildTaskBoardSearchDocument({
		projectId: `project-${index}`,
		projectName: `Project ${index}`,
		taskId: "same-id",
		columnId: "review",
		taskCreatedAtEpochMs: 1,
		taskLastModifiedAtEpochMs: 1,
		taskAgentOverrideAgentId: null,
		mostRecentlyLaunchedAgentSessionAgentId: null,
		title,
		prompt: index === 0 ? "release service" : "bake dessert",
	}),
);

it("真实插件等待文档和查询嵌入，semantic 与 hybrid 均能返回正确的跨项目文档", async () => {
	const index = await createTaskBoardSemanticSearchIndex(documents);
	const semantic = await index.findResults("deploy", "semantic");
	expect(semantic).toHaveLength(1);
	expect(semantic[0]?.document).toBe(documents[0]);
	expect(semantic[0]?.matchSources).toEqual(["title", "prompt"]);
	const hybrid = await index.findResults("cake dessert", "hybrid");
	expect(hybrid[0]?.document).toBe(documents[1]);
	expect(hybrid[0]?.matchSources).toEqual(["title", "prompt"]);
});

it("初始化逐条等待全部文档嵌入完成后才允许查询", async () => {
	vi.useFakeTimers();
	const embeddingTexts = documents.flatMap(({ title, prompt }) => [title, prompt]);
	const documentCompletions = embeddingTexts.map(() => createDeferredEmbeddingCompletion());
	const queryCompletion = createDeferredEmbeddingCompletion();
	embeddingModel.embed.mockImplementation(async (text: string) => {
		const completion = documentCompletions[embeddingTexts.indexOf(text)] ?? queryCompletion;
		await completion.promise;
		return createEmbeddingTensor(text);
	});
	let initializationCompleted = false;
	const initialization = createTaskBoardSemanticSearchIndex(documents).then((index) => {
		initializationCompleted = true;
		return index;
	});

	// 清空异步链后检查 pending 状态；完成时机只由 deferred Promise 控制。
	for (const [position, completion] of documentCompletions.entries()) {
		await vi.runAllTimersAsync();
		expect(initializationCompleted).toBe(false);
		expect(embeddingModel.embed.mock.calls.map(([text]) => text)).toEqual(embeddingTexts.slice(0, position + 1));
		completion.resolve();
	}
	const index = await initialization;
	let queryCompleted = false;
	const query = index.findResults("deploy", "semantic").then((results) => {
		queryCompleted = true;
		return results;
	});
	await vi.runAllTimersAsync();
	expect(queryCompleted).toBe(false);
	queryCompletion.resolve();
	const results = await query;
	expect(results).toHaveLength(1);
	expect(results[0]?.document).toBe(documents[0]);
	expect(results[0]?.matchSources).toEqual(["title", "prompt"]);
});

it("文档嵌入失败会拒绝初始化并停止插入后续文档", async () => {
	vi.useFakeTimers();
	const failedEmbedding = createDeferredEmbeddingCompletion();
	embeddingModel.embed.mockImplementation(async (text: string) => {
		await failedEmbedding.promise;
		return createEmbeddingTensor(text);
	});
	const initialization = createTaskBoardSemanticSearchIndex(documents);
	const embeddingError = new Error("文档嵌入失败");
	const rejection = expect(initialization).rejects.toBe(embeddingError);
	await vi.runAllTimersAsync();
	expect(embeddingModel.embed).toHaveBeenCalledExactlyOnceWith(documents[0]?.title);
	failedEmbedding.reject(embeddingError);
	await rejection;
	expect(embeddingModel.embed).toHaveBeenCalledTimes(1);
});
