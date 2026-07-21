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

	async function renderHook(initialProps: {
		documents: readonly TaskBoardSearchDocument[];
		query: string;
		mode: TaskBoardSearchMode;
	}): Promise<{
		getState: () => UseTaskBoardSearchResult;
		rerender: (nextProps: {
			documents: readonly TaskBoardSearchDocument[];
			query: string;
			mode: TaskBoardSearchMode;
		}) => Promise<void>;
	}> {
		let hookResult: UseTaskBoardSearchResult | null = null;

		function HookHarness(props: {
			documents: readonly TaskBoardSearchDocument[];
			query: string;
			mode: TaskBoardSearchMode;
		}): null {
			hookResult = useTaskBoardSearch(props);
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

	it("runs direct substring search synchronously without touching the semantic index", async () => {
		const documents = createDocuments();
		const { getState } = await renderHook({ documents, query: "alpha", mode: "direct" });

		expect(getState().orderedResults.map((result) => result.document.taskId)).toEqual(["task-alpha"]);
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).not.toHaveBeenCalled();
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
