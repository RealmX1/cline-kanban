import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskEditor } from "@/hooks/use-task-editor";
import type {
	RuntimeAgentId,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";

function createTask(taskId: string, prompt: string, createdAt: number, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function createBoard(tasks: BoardCard[] = []): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: tasks },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

interface HookSnapshot {
	board: BoardData;
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	newTaskImages: TaskImage[];
	newTaskBranchRef: string;
	newTaskWorktreeMode: RuntimeTaskWorktreeMode;
	newTaskAgentId: RuntimeAgentId | undefined;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	newTaskTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	editingTaskId: string | null;
	editTaskPrompt: string;
	editTaskStartInPlanMode: boolean;
	isEditTaskStartInPlanModeDisabled: boolean;
	handleOpenCreateTask: () => void;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskImages: (value: TaskImage[]) => void;
	setNewTaskBranchRef: (value: string) => void;
	setNewTaskWorktreeMode: (value: RuntimeTaskWorktreeMode) => void;
	handleOpenEditTask: (task: BoardCard) => void;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	setEditTaskPrompt: (value: string) => void;
	setEditTaskAutoReviewEnabled: (value: boolean) => void;
	setEditTaskAutoReviewMode: (value: TaskAutoReviewMode) => void;
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	setNewTaskClineSettings: (value: RuntimeTaskClineSettings | undefined) => void;
	setNewTaskTerminalAgentModelOverrideSettings: (
		value: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		options?: { rememberSelectionForFutureCreateTasks?: boolean },
	) => void;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	initialBoard,
	onSnapshot,
	queueTaskStartAfterEdit,
	createTaskBranchOptions = [{ value: "main", label: "main" }],
	editTaskBranchOptions = [{ value: "main", label: "main" }],
	defaultTaskBranchRef = "main",
	defaultCreateTaskBranchRef = "main",
	currentProjectId = "project-1",
	selectedAgentId = null,
}: {
	initialBoard: BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	queueTaskStartAfterEdit?: (taskId: string) => void;
	createTaskBranchOptions?: Array<{ value: string; label: string }>;
	editTaskBranchOptions?: Array<{ value: string; label: string }>;
	defaultTaskBranchRef?: string;
	defaultCreateTaskBranchRef?: string;
	currentProjectId?: string | null;
	selectedAgentId?: RuntimeAgentId | null;
}): null {
	const [board, setBoard] = useState<BoardData>(initialBoard);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		createTaskBranchOptions,
		editTaskBranchOptions,
		defaultTaskBranchRef,
		defaultCreateTaskBranchRef,
		currentProjectId,
		selectedAgentId,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		onSnapshot({
			board,
			isInlineTaskCreateOpen: editor.isInlineTaskCreateOpen,
			newTaskPrompt: editor.newTaskPrompt,
			newTaskImages: editor.newTaskImages,
			newTaskBranchRef: editor.newTaskBranchRef,
			newTaskWorktreeMode: editor.newTaskWorktreeMode,
			newTaskAgentId: editor.newTaskAgentId,
			newTaskClineSettings: editor.newTaskClineSettings,
			newTaskTerminalAgentModelOverrideSettings: editor.newTaskTerminalAgentModelOverrideSettings,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			editTaskStartInPlanMode: editor.editTaskStartInPlanMode,
			isEditTaskStartInPlanModeDisabled: editor.isEditTaskStartInPlanModeDisabled,
			handleOpenCreateTask: editor.handleOpenCreateTask,
			handleCreateTask: editor.handleCreateTask,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskImages: editor.setNewTaskImages,
			setNewTaskBranchRef: editor.setNewTaskBranchRef,
			setNewTaskWorktreeMode: editor.setNewTaskWorktreeMode,
			handleOpenEditTask: editor.handleOpenEditTask,
			handleCancelEditTask: editor.handleCancelEditTask,
			handleSaveEditedTask: editor.handleSaveEditedTask,
			handleSaveAndStartEditedTask: editor.handleSaveAndStartEditedTask,
			setEditTaskPrompt: editor.setEditTaskPrompt,
			setEditTaskAutoReviewEnabled: editor.setEditTaskAutoReviewEnabled,
			setEditTaskAutoReviewMode: editor.setEditTaskAutoReviewMode,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskClineSettings: editor.setNewTaskClineSettings,
			setNewTaskTerminalAgentModelOverrideSettings: editor.setNewTaskTerminalAgentModelOverrideSettings,
		});
	}, [
		board,
		editor.handleCreateTask,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editTaskStartInPlanMode,
		editor.editingTaskId,
		editor.handleCancelEditTask,
		editor.handleOpenEditTask,
		editor.handleSaveEditedTask,
		editor.handleSaveAndStartEditedTask,
		editor.isEditTaskStartInPlanModeDisabled,
		editor.isInlineTaskCreateOpen,
		editor.newTaskPrompt,
		editor.newTaskImages,
		editor.newTaskBranchRef,
		editor.newTaskAgentId,
		editor.newTaskClineSettings,
		editor.newTaskTerminalAgentModelOverrideSettings,
		editor.setEditTaskAutoReviewEnabled,
		editor.setEditTaskAutoReviewMode,
		editor.setEditTaskPrompt,
		editor.setNewTaskImages,
		editor.setNewTaskBranchRef,
		editor.setNewTaskPrompt,
		editor.setNewTaskTerminalAgentModelOverrideSettings,
		onSnapshot,
	]);

	return null;
}

describe("useTaskEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
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
		localStorage.clear();
	});

	it("returns the edited task id when saving a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		requireSnapshot(latestSnapshot);

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		let savedTaskId: string | null = null;
		await act(async () => {
			savedTaskId = latestSnapshot?.handleSaveEditedTask() ?? null;
		});

		expect(savedTaskId).toBe("task-1");
		expect(requireSnapshot(latestSnapshot).editingTaskId).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("restores an autosaved edit draft when reopening the same task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const task = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Autosaved draft prompt");
		});
		await act(async () => {});

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toContain("Autosaved draft prompt");

		act(() => {
			root.unmount();
		});
		root = createRoot(container);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const reopenedTask = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!reopenedTask) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(reopenedTask);
		});

		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Autosaved draft prompt");
	});

	it("clears the autosaved edit draft after saving", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const task = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Saved draft prompt");
		});
		await act(async () => {});

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toContain("Saved draft prompt");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Saved draft prompt");
	});

	it("clears the autosaved edit draft after canceling", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const task = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Canceled draft prompt");
		});
		await act(async () => {});

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toContain("Canceled draft prompt");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCancelEditTask();
		});

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Initial prompt");
	});

	it("does not disable start in plan mode when auto review is enabled while editing", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				startInPlanMode: true,
			}),
		]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskAutoReviewEnabled(true);
			latestSnapshot?.setEditTaskAutoReviewMode("commit");
		});

		expect(requireSnapshot(latestSnapshot).isEditTaskStartInPlanModeDisabled).toBe(false);
	});

	it("queues the saved task id when saving and starting an edited task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		await act(async () => {
			latestSnapshot?.handleSaveAndStartEditedTask();
		});

		expect(queueTaskStartAfterEdit).toHaveBeenCalledWith("task-1");
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("keeps the create dialog open when requested after creating a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create another task");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "low",
			});
		});

		await act(async () => {});
		expect(requireSnapshot(latestSnapshot).newTaskPrompt).toBe("Create another task");
		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("main");
		expect(requireSnapshot(latestSnapshot).newTaskWorktreeMode).toBe("branch");

		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(createdTaskId).toBeTruthy();
		expect(snapshot.isInlineTaskCreateOpen).toBe(true);
		expect(snapshot.newTaskPrompt).toBe("");
		expect(snapshot.newTaskBranchRef).toBe("main");
		expect(snapshot.newTaskWorktreeMode).toBe("branch");
		expect(snapshot.newTaskAgentId).toBeUndefined();
		expect(snapshot.newTaskClineSettings).toBeUndefined();
		expect(snapshot.board.columns[0]?.cards[0]?.baseRef).toBe("main");
		expect(snapshot.board.columns[0]?.cards.some((card) => card.prompt === "Create another task")).toBe(true);
	});

	it("remembers the create-task terminal agent model selection for the next task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					selectedAgentId="cursor"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskTerminalAgentModelOverrideSettings({
				agentId: "cursor",
				modelId: "auto",
			});
			requireSnapshot(latestSnapshot).setNewTaskPrompt("First Cursor task");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		let snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards[0]?.terminalAgentModelOverrideSettings).toEqual({
			agentId: "cursor",
			modelId: "auto",
		});
		expect(snapshot.newTaskTerminalAgentModelOverrideSettings).toEqual({
			agentId: "cursor",
			modelId: "auto",
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});
		expect(requireSnapshot(latestSnapshot).newTaskTerminalAgentModelOverrideSettings).toEqual({
			agentId: "cursor",
			modelId: "auto",
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Second Cursor task");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards.map((card) => card.terminalAgentModelOverrideSettings)).toEqual([
			{ agentId: "cursor", modelId: "auto" },
			{ agentId: "cursor", modelId: "auto" },
		]);
	});

	it("does not clear a remembered terminal model selection when an agent switch clears stale task state", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					selectedAgentId="cursor"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskTerminalAgentModelOverrideSettings({
				agentId: "cursor",
				modelId: "auto",
			});
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("claude");
			requireSnapshot(latestSnapshot).setNewTaskTerminalAgentModelOverrideSettings(undefined, {
				rememberSelectionForFutureCreateTasks: false,
			});
		});
		await act(async () => {});

		expect(requireSnapshot(latestSnapshot).newTaskTerminalAgentModelOverrideSettings).toBeUndefined();

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("cursor");
		});
		await act(async () => {});

		expect(requireSnapshot(latestSnapshot).newTaskTerminalAgentModelOverrideSettings).toEqual({
			agentId: "cursor",
			modelId: "auto",
		});
	});

	it("defaults closed create dialogs to the current base ref instead of the last selected base ref", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					createTaskBranchOptions={[
						{ value: "feature/recent", label: "feature/recent" },
						{ value: "main", label: "main (default)" },
					]}
					defaultTaskBranchRef="feature/recent"
					defaultCreateTaskBranchRef="feature/recent"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("feature/recent");

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskBranchRef("main");
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Use main once");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const afterCreateSnapshot = requireSnapshot(latestSnapshot);
		expect(afterCreateSnapshot.isInlineTaskCreateOpen).toBe(false);
		expect(afterCreateSnapshot.newTaskBranchRef).toBe("feature/recent");
		expect(afterCreateSnapshot.board.columns[0]?.cards[0]?.baseRef).toBe("main");

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("feature/recent");
	});

	it("creates a new worktree task from the default base ref", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					createTaskBranchOptions={[
						{ value: "feature/recent", label: "feature/recent" },
						{ value: "main", label: "main (default)" },
					]}
					defaultTaskBranchRef="feature/recent"
					defaultCreateTaskBranchRef="feature/recent"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Use default new worktree");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards[0]?.baseRef).toBe("feature/recent");
		expect(snapshot.board.columns[0]?.cards[0]?.worktreeMode).toBe("branch");
	});

	it("can create a task for the current checkout without changing the base ref", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					createTaskBranchOptions={[
						{ value: "feature/recent", label: "feature/recent" },
						{ value: "main", label: "main (default)" },
					]}
					defaultTaskBranchRef="feature/recent"
					defaultCreateTaskBranchRef="feature/recent"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskWorktreeMode("inplace");
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Use current checkout");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.board.columns[0]?.cards[0]?.baseRef).toBe("feature/recent");
		expect(snapshot.board.columns[0]?.cards[0]?.worktreeMode).toBe("inplace");
		expect(snapshot.newTaskWorktreeMode).toBe("branch");
	});

	it("copies attached images to each split task and clears the draft images", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			latestSnapshot?.setNewTaskImages([
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			]);
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = latestSnapshot?.handleCreateTasks(["First task", "Second task"]) ?? [];
		});

		expect(createdTaskIds).toHaveLength(2);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(2);
		expect(backlogCards.map((card) => card.images)).toEqual([
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
		]);
		expect(requireSnapshot(latestSnapshot).newTaskImages).toEqual([]);
	});

	it("persists reasoning-only task overrides when model/provider stay inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Reasoning override only");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				reasoningEffort: "low",
			});
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const createdCard = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		expect(createdCard?.clineSettings).toEqual({
			reasoningEffort: "low",
		});
	});

	it("preserves per-task agent/model override fields on each split task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = requireSnapshot(latestSnapshot).handleCreateTasks(["Task A", "Task B", "Task C"]);
		});

		expect(createdTaskIds).toHaveLength(3);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(3);
		for (const card of backlogCards) {
			expect(card.agentId).toBe("codex");
			expect(card.clineSettings).toEqual({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		}
	});
});
