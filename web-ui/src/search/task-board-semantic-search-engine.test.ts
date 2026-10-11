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
		crossProjectAgentConversationProgressAtEpochMs: null,
		title,
		prompt: index === 0 ? "release service" : "bake dessert",
	}),
);

it("真实插件等待文档和查询嵌入，semantic 与 hybrid 均能返回正确的跨项目文档", async () => {
	const index = await createTaskBoardSemanticSearchIndex(documents);
	const semantic = await index.findResults("deploy", "semantic", "title_and_prompt");
	expect(semantic).toHaveLength(1);
	expect(semantic[0]?.document).toBe(documents[0]);
	expect(semantic[0]?.matchSources).toEqual(["title", "prompt"]);
	const hybrid = await index.findResults("cake dessert", "hybrid", "title_and_prompt");
	expect(hybrid[0]?.document).toBe(documents[1]);
	expect(hybrid[0]?.matchSources).toEqual(["title", "prompt"]);
});

it("字段范围在查询时丢弃范围外字段的命中：同一个索引换范围即可，不必重建", async () => {
	const titleOnlyMatchingDocument = buildTaskBoardSearchDocument({
		projectId: "project-scope",
		projectName: "Project scope",
		taskId: "scope-id",
		columnId: "review",
		taskCreatedAtEpochMs: 1,
		taskLastModifiedAtEpochMs: 1,
		taskAgentOverrideAgentId: null,
		mostRecentlyLaunchedAgentSessionAgentId: null,
		crossProjectAgentConversationProgressAtEpochMs: null,
		title: "deploy pipeline",
		prompt: "bake bread",
	});
	const index = await createTaskBoardSemanticSearchIndex([titleOnlyMatchingDocument]);
	const embeddingCallCountAfterIndexing = embeddingModel.embed.mock.calls.length;

	const titleOnly = await index.findResults("deploy", "semantic", "title_only");
	expect(titleOnly.map((result) => result.matchSources)).toEqual([["title"]]);
	// 唯一命中的字段被范围排除 → 整篇文档不入选，而不是带着空 matchSources 混进来。
	expect(await index.findResults("deploy", "semantic", "prompt_only")).toEqual([]);
	expect(await index.findResults("deploy", "hybrid", "prompt_only")).toEqual([]);
	// 三次查询只多嵌入了三次查询串本身，文档记录没有重新嵌入。
	expect(embeddingModel.embed.mock.calls.length - embeddingCallCountAfterIndexing).toBe(3);
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
	const query = index.findResults("deploy", "semantic", "title_and_prompt").then((results) => {
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
