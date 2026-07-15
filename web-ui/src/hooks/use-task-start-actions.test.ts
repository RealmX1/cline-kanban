import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStartableBacklogTaskIds, useTaskStartActions } from "@/hooks/use-task-start-actions";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

function createCard(id: string, prompt = "Do something"): BoardCard {
	return {
		id,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard({
	backlogCards,
	dependencies = [],
	inProgressCards = [],
}: {
	backlogCards: BoardCard[];
	dependencies?: BoardDependency[];
	inProgressCards?: BoardCard[];
}): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: inProgressCards },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies,
	};
}

describe("getStartableBacklogTaskIds", () => {
	it("returns all backlog task ids when there are no dependencies", () => {
		const board = createBoard({ backlogCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")] });
		expect(getStartableBacklogTaskIds(board)).toEqual(["task-1", "task-2", "task-3"]);
	});

	it("returns empty array when backlog is empty", () => {
		const board = createBoard({ backlogCards: [] });
		expect(getStartableBacklogTaskIds(board)).toEqual([]);
	});

	it("excludes a parent task whose child is also in the backlog", () => {
		const board = createBoard({
			backlogCards: [createCard("task-a"), createCard("task-b")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
		});
		expect(getStartableBacklogTaskIds(board)).toEqual(["task-b"]);
	});

	it("excludes a parent task whose child is in progress", () => {
		const board = createBoard({
			backlogCards: [createCard("task-a")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
			inProgressCards: [createCard("task-b")],
		});
		expect(getStartableBacklogTaskIds(board)).toEqual([]);
	});
});

type TaskStartActionsSnapshot = ReturnType<typeof useTaskStartActions>;

function TaskStartActionsHarness({
	board,
	currentProjectId,
	handleStartTask,
	handleStartAllBacklogTasks,
	onSnapshot,
}: {
	board: BoardData;
	currentProjectId: string | null;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	onSnapshot: (snapshot: TaskStartActionsSnapshot) => void;
}): null {
	const actions = useTaskStartActions({
		board,
		currentProjectId,
		handleCreateTask: () => null,
		handleCreateTasks: () => [],
		handleStartTask,
		handleStartAllBacklogTasks,
		setSelectedTaskId: () => {},
	});

	useEffect(() => {
		onSnapshot(actions);
	}, [actions, onSnapshot]);

	return null;
}

describe("useTaskStartActions start-all confirmation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestSnapshot: TaskStartActionsSnapshot | null;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestSnapshot = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function requireSnapshot(): TaskStartActionsSnapshot {
		if (!latestSnapshot) {
			throw new Error("Expected useTaskStartActions snapshot.");
		}
		return latestSnapshot;
	}

	async function renderHarness({
		board,
		currentProjectId = "project-1",
		handleStartTask,
		handleStartAllBacklogTasks,
	}: {
		board: BoardData;
		currentProjectId?: string | null;
		handleStartTask: (taskId: string) => void;
		handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	}): Promise<void> {
		await act(async () => {
			root.render(
				createElement(TaskStartActionsHarness, {
					board,
					currentProjectId,
					handleStartTask,
					handleStartAllBacklogTasks,
					onSnapshot: (snapshot) => {
						latestSnapshot = snapshot;
					},
				}),
			);
		});
	}

	it("requires confirmation before starting multiple ready backlog tasks and cancellation has no side effects", async () => {
		const handleStartTask = vi.fn();
		const handleStartAllBacklogTasks = vi.fn();
		const board = createBoard({
			backlogCards: [createCard("task-1", "First task"), createCard("task-2", "Second task")],
		});
		await renderHarness({ board, handleStartTask, handleStartAllBacklogTasks });

		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards?.map((card) => card.id)).toEqual([
			"task-1",
			"task-2",
		]);
		expect(handleStartTask).not.toHaveBeenCalled();
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();

		act(() => {
			requireSnapshot().cancelStartAllReadyBacklogTasksConfirmation();
		});
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toBeNull();
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();

		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});
		act(() => {
			requireSnapshot().confirmStartAllReadyBacklogTasks();
		});
		expect(handleStartAllBacklogTasks).toHaveBeenCalledTimes(1);
		expect(handleStartAllBacklogTasks).toHaveBeenCalledWith(["task-1", "task-2"]);
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toBeNull();
	});

	it("does nothing when no ready backlog tasks exist", async () => {
		const handleStartTask = vi.fn();
		const handleStartAllBacklogTasks = vi.fn();
		await renderHarness({
			board: createBoard({ backlogCards: [] }),
			handleStartTask,
			handleStartAllBacklogTasks,
		});

		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});

		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toBeNull();
		expect(handleStartTask).not.toHaveBeenCalled();
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();
	});

	it("requires confirmation when only one ready backlog task exists", async () => {
		const handleStartTask = vi.fn();
		const handleStartAllBacklogTasks = vi.fn();
		await renderHarness({
			board: createBoard({ backlogCards: [createCard("task-1")] }),
			handleStartTask,
			handleStartAllBacklogTasks,
		});

		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});
		expect(handleStartTask).not.toHaveBeenCalled();
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toHaveLength(1);

		act(() => {
			requireSnapshot().confirmStartAllReadyBacklogTasks();
		});
		expect(handleStartTask).toHaveBeenCalledWith("task-1");
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();
	});

	it("revalidates the requested snapshot without adding newly-created backlog tasks", async () => {
		const handleStartTask = vi.fn();
		const handleStartAllBacklogTasks = vi.fn();
		const firstTask = createCard("task-1");
		const secondTask = createCard("task-2");
		const thirdTask = createCard("task-3");
		await renderHarness({
			board: createBoard({ backlogCards: [firstTask, secondTask] }),
			handleStartTask,
			handleStartAllBacklogTasks,
		});

		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});
		await renderHarness({
			board: createBoard({ backlogCards: [secondTask, thirdTask], inProgressCards: [firstTask] }),
			handleStartTask,
			handleStartAllBacklogTasks,
		});
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards?.map((card) => card.id)).toEqual(["task-2"]);

		act(() => {
			requireSnapshot().confirmStartAllReadyBacklogTasks();
		});
		expect(handleStartTask).toHaveBeenCalledWith("task-2");
		expect(handleStartTask).not.toHaveBeenCalledWith("task-3");
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();
	});

	it("clears a pending confirmation when the project changes", async () => {
		const handleStartTask = vi.fn();
		const handleStartAllBacklogTasks = vi.fn();
		const board = createBoard({ backlogCards: [createCard("task-1")] });
		await renderHarness({ board, handleStartTask, handleStartAllBacklogTasks });
		act(() => {
			requireSnapshot().requestStartAllReadyBacklogTasksConfirmation();
		});
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toHaveLength(1);

		await renderHarness({
			board,
			currentProjectId: "project-2",
			handleStartTask,
			handleStartAllBacklogTasks,
		});
		expect(requireSnapshot().pendingStartAllReadyBacklogTaskCards).toBeNull();
		expect(handleStartTask).not.toHaveBeenCalled();
		expect(handleStartAllBacklogTasks).not.toHaveBeenCalled();
	});
});
