import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildTaskBoardSearchDocuments,
	type TaskBoardSearchDocument,
	type TaskBoardSearchMode,
	type TaskBoardSearchProjectContext,
	type TaskBoardSearchResult,
} from "@/search/task-board-search";
import type { TaskSearchResultSortOrder } from "@/search/task-search-result-ordering";
import { type UseTaskBoardSearchResult, useTaskBoardSearch } from "@/search/use-task-board-search";
import type { BoardData } from "@/types";

const semanticSearchMocks = vi.hoisted(() => ({
	createTaskBoardSemanticSearchIndex: vi.fn(),
}));

vi.mock("@/search/task-board-semantic-search", () => ({
	createTaskBoardSemanticSearchIndex: semanticSearchMocks.createTaskBoardSemanticSearchIndex,
}));

const PROJECT_CONTEXT: TaskBoardSearchProjectContext = { projectId: "proj-a", projectName: "Project A" };

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-alpha",
						title: "Alpha rollout",
						prompt: "Prepare API deployment",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "task-beta",
						title: "Beta cleanup",
						prompt: "Refine prompt rendering",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createDocuments(): TaskBoardSearchDocument[] {
	return buildTaskBoardSearchDocuments(createBoard(), PROJECT_CONTEXT);
}

function findDocument(documents: readonly TaskBoardSearchDocument[], taskId: string): TaskBoardSearchDocument {
	const document = documents.find((candidate) => candidate.taskId === taskId);
	if (!document) {
		throw new Error(`missing document ${taskId}`);
	}
	return document;
}

function createSemanticResult(document: TaskBoardSearchDocument): TaskBoardSearchResult {
	return {
		document,
		score: 1,
		matchSources: ["title"],
		titleMatchCharacterPositions: new Set<number>(),
		promptMatchCharacterPositions: new Set<number>(),
	};
}

/**
 * 测试只关心「按 mode 分发匹配 + ID 置顶」这一层，故排序档/活跃度解析/浏览开关都取不影响该层的默认值：
 * relevance 档原样返回入参、活跃度恒 null、浏览关闭。要测排序或浏览的用例自行覆盖对应字段。
 */
type UseTaskBoardSearchHarnessProps = {
	documents: readonly TaskBoardSearchDocument[];
	query: string;
	mode: TaskBoardSearchMode;
	sortOrder?: TaskSearchResultSortOrder;
	resolveAgentConversationProgressAtEpochMs?: (document: TaskBoardSearchDocument) => number | null;
	isBrowsingAllTasksWithoutQueryEnabled?: boolean;
};

const NO_AGENT_CONVERSATION_PROGRESS = (): number | null => null;

describe("useTaskBoardSearch", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function renderHook(initialProps: UseTaskBoardSearchHarnessProps): Promise<{
		getState: () => UseTaskBoardSearchResult;
		rerender: (nextProps: UseTaskBoardSearchHarnessProps) => Promise<void>;
	}> {
		let hookResult: UseTaskBoardSearchResult | null = null;

		function HookHarness(props: UseTaskBoardSearchHarnessProps): null {
			hookResult = useTaskBoardSearch({
				sortOrder: "relevance",
				resolveAgentConversationProgressAtEpochMs: NO_AGENT_CONVERSATION_PROGRESS,
				isBrowsingAllTasksWithoutQueryEnabled: false,
				...props,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness {...initialProps} />);
			await Promise.resolve();
		});

		return {
			getState: () => {
				if (!hookResult) {
					throw new Error("Hook state not available");
				}
				return hookResult;
			},
			rerender: async (nextProps) => {
				await act(async () => {
					root.render(<HookHarness {...nextProps} />);
					await Promise.resolve();
				});
			},
		};
	}

	function createTaskIdShapedBoard(): BoardData {
		return {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "a3f21",
							// title / prompt 都不含 "a3f21"：这条只能靠 task id 通道被捞出来。
							title: "Alpha rollout",
							prompt: "Prepare API deployment",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
						{
							id: "94c87",
							title: "Follows a3f21 closely",
							prompt: "Continue the work",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
						{
							id: "b7d33",
							title: "Beta cleanup",
							prompt: "Mentions a3f21 in the prompt body",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
	}

	function createTaskIdShapedDocuments(): TaskBoardSearchDocument[] {
		return buildTaskBoardSearchDocuments(createTaskIdShapedBoard(), PROJECT_CONTEXT);
	}

	it("hoists the task-id match to the top in direct mode without disturbing the text order below it", async () => {
		const documents = createTaskIdShapedDocuments();
		const { getState } = await renderHook({ documents, query: "a3f21", mode: "direct" });

		// 第 0 位是 id 全等命中；其后仍是 direct 自己的排序（title 命中 > 仅 prompt 命中）。
		expect(getState().orderedResults.map((result) => result.document.taskId)).toEqual(["a3f21", "94c87", "b7d33"]);
		expect(getState().orderedResults[0]?.matchSources).toEqual(["taskId"]);
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).not.toHaveBeenCalled();
	});

	it("hoists the task-id match in fuzzy mode too (the layer is mode-agnostic)", async () => {
		const documents = createTaskIdShapedDocuments();
		const { getState } = await renderHook({ documents, query: "a3f21", mode: "fuzzy" });

		expect(getState().orderedResults[0]?.document.taskId).toBe("a3f21");
		expect(getState().orderedResults[0]?.matchSources).toContain("taskId");
	});

	it("keeps the task-id match pinned across the semantic result landing", async () => {
		vi.useFakeTimers();
		const documents = createTaskIdShapedDocuments();
		const semanticTargetDocument = findDocument(documents, "94c87");
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockResolvedValue({
			findResults: vi.fn(async () => [createSemanticResult(semanticTargetDocument)]),
		});

		const { getState } = await renderHook({ documents, query: "a3f21", mode: "hybrid" });

		// 语义结果还没到货时，id 命中行已经零延迟可见（"Searching…" 空态让位于它，这是刻意的改进）。
		expect(getState().semanticSearchStatus).toBe("loading");
		expect(getState().orderedResults[0]?.document.taskId).toBe("a3f21");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});

		// 语义结果落地后顶行仍是同一个 document，不会闪烁重排。
		expect(getState().semanticSearchStatus).toBe("ready");
		expect(getState().orderedResults[0]?.document.taskId).toBe("a3f21");
	});

	it("keeps the ordered results reference stable when no task id matches", async () => {
		// 引用稳定性：换引用会让 controller 的 useEffect([results]) 把 activeIndex 钉回 0，↑↓ 导航就废了。
		const documents = createTaskIdShapedDocuments();
		const { getState, rerender } = await renderHook({ documents, query: "alpha", mode: "direct" });
		const firstOrderedResults = getState().orderedResults;

		await rerender({ documents, query: "alpha", mode: "direct" });

		expect(getState().orderedResults).toBe(firstOrderedResults);
	});

	it("returns no results for an empty query even though the id gate is in the path", async () => {
		const documents = createTaskIdShapedDocuments();
		const { getState } = await renderHook({ documents, query: "   ", mode: "direct" });

		expect(getState().isSearchActive).toBe(false);
		expect(getState().orderedResults).toEqual([]);
	});

	it("runs direct substring search synchronously without touching the semantic index", async () => {
		const documents = createDocuments();
		const { getState } = await renderHook({ documents, query: "alpha", mode: "direct" });

		expect(getState().orderedResults.map((result) => result.document.taskId)).toEqual(["task-alpha"]);
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).not.toHaveBeenCalled();
	});

	it("文档变化、关闭搜索及卸载会取消索引；失败后的下一次查询能重新初始化", async () => {
		vi.useFakeTimers();
		const documents = createDocuments();
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockResolvedValue({ findResults: async () => [] });
		const { rerender, getState } = await renderHook({ documents, query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		const firstSignal = semanticSearchMocks.createTaskBoardSemanticSearchIndex.mock.calls[0]![1] as AbortSignal;
		await rerender({ documents: createDocuments(), query: "alpha", mode: "semantic" });
		expect(firstSignal.aborted).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		const secondSignal = semanticSearchMocks.createTaskBoardSemanticSearchIndex.mock.calls[1]![1] as AbortSignal;
		await rerender({ documents, query: "", mode: "semantic" });
		expect(secondSignal.aborted).toBe(true);
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockRejectedValueOnce(new Error("网络不可用"));
		await rerender({ documents, query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		expect(getState().semanticSearchStatus).toBe("error");
		await rerender({ documents, query: "beta", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		expect(getState().semanticSearchStatus).toBe("ready");
		const lastSignal = semanticSearchMocks.createTaskBoardSemanticSearchIndex.mock.calls.at(-1)![1] as AbortSignal;
		await act(async () => root.render(null));
		expect(lastSignal.aborted).toBe(true);
	});

	it("初始化迟到时不把已过期查询送进 Worker", async () => {
		vi.useFakeTimers();
		let finish: ((index: { findResults: ReturnType<typeof vi.fn> }) => void) | undefined;
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const documents = createDocuments();
		const { rerender } = await renderHook({ documents, query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		await rerender({ documents, query: "beta", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
		});
		const findResults = vi.fn(async () => []);
		await act(async () => finish?.({ findResults }));
		expect(findResults).toHaveBeenCalledExactlyOnceWith("beta", "semantic");
	});

	it("reuses the semantic index for query changes and does not show stale semantic results", async () => {
		vi.useFakeTimers();
		const documents = createDocuments();
		const alphaDocument = findDocument(documents, "task-alpha");
		const betaDocument = findDocument(documents, "task-beta");
		const semanticIndex = {
			findResults: vi.fn(async (query: string) =>
				query === "alpha" ? [createSemanticResult(alphaDocument)] : [createSemanticResult(betaDocument)],
			),
		};
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockResolvedValue(semanticIndex);

		const { getState, rerender } = await renderHook({ documents, query: "alpha", mode: "semantic" });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});

		expect(getState().orderedResults.map((result) => result.document.taskId)).toEqual(["task-alpha"]);

		await rerender({ documents, query: "beta", mode: "semantic" });

		expect(getState().semanticSearchStatus).toBe("loading");
		expect(getState().orderedResults).toEqual([]);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});

		expect(getState().orderedResults.map((result) => result.document.taskId)).toEqual(["task-beta"]);
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).toHaveBeenCalledTimes(1);
		expect(semanticIndex.findResults).toHaveBeenCalledTimes(2);
	});

	it("reuses the semantic index across identical documents references and rebuilds when the reference changes", async () => {
		vi.useFakeTimers();
		const documents = createDocuments();
		const alphaDocument = findDocument(documents, "task-alpha");
		const semanticIndex = {
			findResults: vi.fn(async () => [createSemanticResult(alphaDocument)]),
		};
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockResolvedValue(semanticIndex);

		const { rerender } = await renderHook({ documents, query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).toHaveBeenCalledTimes(1);

		// 同一 documents 引用 → 索引不重建。
		await rerender({ documents, query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).toHaveBeenCalledTimes(1);

		// 新 documents 引用（内容签名稳定化由 controller 负责，非本 hook 职责）→ 索引重建。
		await rerender({ documents: createDocuments(), query: "alpha", mode: "semantic" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).toHaveBeenCalledTimes(2);
	});
});
