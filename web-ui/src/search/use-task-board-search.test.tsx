import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskBoardSearchMode, TaskBoardSearchResult } from "@/search/task-board-search";
import { type UseTaskBoardSearchResult, useTaskBoardSearch } from "@/search/use-task-board-search";
import type { BoardData } from "@/types";

const semanticSearchMocks = vi.hoisted(() => ({
	createTaskBoardSemanticSearchIndex: vi.fn(),
}));

vi.mock("@/search/task-board-semantic-search", () => ({
	createTaskBoardSemanticSearchIndex: semanticSearchMocks.createTaskBoardSemanticSearchIndex,
}));

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

function createSemanticResult(taskId: string): TaskBoardSearchResult {
	return {
		taskId,
		score: 1,
		matchSources: ["title"],
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

	async function renderHook({
		board,
		query,
		mode,
	}: {
		board: BoardData;
		query: string;
		mode: TaskBoardSearchMode;
	}): Promise<{
		getState: () => UseTaskBoardSearchResult;
		rerender: (nextProps: { board: BoardData; query: string; mode: TaskBoardSearchMode }) => Promise<void>;
	}> {
		let hookResult: UseTaskBoardSearchResult | null = null;

		function HookHarness(props: { board: BoardData; query: string; mode: TaskBoardSearchMode }): null {
			hookResult = useTaskBoardSearch(props);
			return null;
		}

		await act(async () => {
			root.render(<HookHarness board={board} query={query} mode={mode} />);
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

	it("reuses the semantic index for query changes and does not show stale semantic results", async () => {
		vi.useFakeTimers();
		const semanticIndex = {
			findResults: vi.fn(async (query: string) =>
				query === "alpha" ? [createSemanticResult("task-alpha")] : [createSemanticResult("task-beta")],
			),
		};
		semanticSearchMocks.createTaskBoardSemanticSearchIndex.mockResolvedValue(semanticIndex);
		const board = createBoard();

		const { getState, rerender } = await renderHook({ board, query: "alpha", mode: "semantic" });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});

		expect(getState().visibleTaskIds).toEqual(new Set(["task-alpha"]));

		await rerender({ board, query: "beta", mode: "semantic" });

		expect(getState().semanticSearchStatus).toBe("loading");
		expect(getState().visibleTaskIds).toEqual(new Set<string>());

		await act(async () => {
			await vi.advanceTimersByTimeAsync(220);
			await Promise.resolve();
		});

		expect(getState().visibleTaskIds).toEqual(new Set(["task-beta"]));
		expect(semanticSearchMocks.createTaskBoardSemanticSearchIndex).toHaveBeenCalledTimes(1);
		expect(semanticIndex.findResults).toHaveBeenCalledTimes(2);
	});
});
