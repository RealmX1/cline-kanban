import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { resetTaskEditDraftStoreForTests } from "@/runtime/task-edit-draft-store";
import type {
	RuntimeAgentId,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskEditDraft,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";
import { readEffectiveUserInterfacePreferenceValue } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";

/**
 * 服务端草稿的假替身。
 *
 * `snapshot === null` = 运行时够不着，与这套用例此前（没有服务器可连）的真实行为逐字等价，所以除了
 * 显式给它装快照的那条用例，其余用例的行为一个字都没变。`releaseFetch` 让用例自己决定快照**什么时候**
 * 到达——「表单先被镜像铺上、快照后到」正是要钉住的那条时序。
 */
const fakeWorkspaceTaskEditDraftServer = vi.hoisted(() => ({
	snapshot: null as WorkspaceTaskEditDraftsSnapshot | null,
	releaseFetch: null as (() => void) | null,
}));

vi.mock("@/runtime/task-edit-drafts-query", () => {
	function applyFakeMutation(
		snapshot: WorkspaceTaskEditDraftsSnapshot,
		mutation: WorkspaceTaskEditDraftMutation,
		nowEpochMs: number,
	): WorkspaceTaskEditDraftsSnapshot {
		if (mutation.kind === "save_task_edit_draft") {
			return {
				...snapshot,
				draftsByTaskId: { ...snapshot.draftsByTaskId, [mutation.draft.taskId]: mutation.draft },
			};
		}
		if (mutation.kind === "clear_task_edit_draft") {
			const { [mutation.taskId]: _cleared, ...remainingDrafts } = snapshot.draftsByTaskId;
			return { ...snapshot, draftsByTaskId: remainingDrafts };
		}
		if (mutation.kind !== "merge_task_edit_drafts_migrated_from_browser_local_storage") {
			return snapshot;
		}
		let merged = snapshot;
		for (const incomingDraft of mutation.drafts) {
			const existingDraft = merged.draftsByTaskId[incomingDraft.taskId];
			if (!existingDraft || existingDraft.savedAt === incomingDraft.savedAt) {
				merged = {
					...merged,
					draftsByTaskId: { ...merged.draftsByTaskId, [incomingDraft.taskId]: existingDraft ?? incomingDraft },
				};
				continue;
			}
			const winningDraft = incomingDraft.savedAt > existingDraft.savedAt ? incomingDraft : existingDraft;
			const losingDraft = winningDraft === incomingDraft ? existingDraft : incomingDraft;
			merged = {
				draftsByTaskId: { ...merged.draftsByTaskId, [incomingDraft.taskId]: winningDraft },
				supersededDraftCopies: [
					...merged.supersededDraftCopies,
					{ draft: losingDraft, supersededAt: nowEpochMs, supersededBySavedAt: winningDraft.savedAt },
				],
			};
		}
		return merged;
	}

	return {
		EMPTY_WORKSPACE_TASK_EDIT_DRAFTS_SNAPSHOT: { draftsByTaskId: {}, supersededDraftCopies: [] },
		fetchWorkspaceTaskEditDrafts: async (): Promise<WorkspaceTaskEditDraftsSnapshot | null> => {
			if (fakeWorkspaceTaskEditDraftServer.snapshot === null) {
				throw new Error("Fake runtime is unreachable.");
			}
			await new Promise<void>((resolve) => {
				fakeWorkspaceTaskEditDraftServer.releaseFetch = resolve;
			});
			return fakeWorkspaceTaskEditDraftServer.snapshot;
		},
		mutateWorkspaceTaskEditDrafts: async (
			_workspaceId: string,
			mutation: WorkspaceTaskEditDraftMutation,
		): Promise<WorkspaceTaskEditDraftsSnapshot | null> => {
			if (fakeWorkspaceTaskEditDraftServer.snapshot === null) {
				throw new Error("Fake runtime is unreachable.");
			}
			fakeWorkspaceTaskEditDraftServer.snapshot = applyFakeMutation(
				fakeWorkspaceTaskEditDraftServer.snapshot,
				mutation,
				Date.now(),
			);
			return fakeWorkspaceTaskEditDraftServer.snapshot;
		},
	};
});

/**
 * 编辑草稿改成了去抖写盘（`use-task-editor.ts` 的 `TASK_EDIT_DRAFT_PERSIST_DEBOUNCE_MS`，
 * 目的是不让每次击键都触发一次 localStorage 写入）。断言草稿内容前必须真的等过那个窗口，
 * 单靠 `await act(async () => {})` 冲一遍 effect 队列是等不到的。
 */
const TASK_EDIT_DRAFT_PERSIST_SETTLE_MS = 600;

async function settleTaskEditDraftPersistence(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, TASK_EDIT_DRAFT_PERSIST_SETTLE_MS);
		});
	});
}

vi.mock("@/components/task-agent-model-picker", () => ({
	TaskAgentModelPicker: () => null,
	useTaskAgentModelPicker: () => ({
		agentOptions: [],
		clineProviderOptions: [],
		clineModelOptions: [],
		terminalAgentModelOptions: [],
		terminalAgentDefaultModelId: null,
		effectiveDefaultModelId: null,
		providerModels: [],
		isLoadingProviders: false,
		isLoadingModels: false,
		isLoadingTerminalAgentModels: false,
		providerDefaultModels: {},
	}),
}));

vi.mock("@/components/task-agent-session-initialization-control", () => ({
	TaskAgentSessionInitializationControl: () => null,
}));

vi.mock("@/components/task-prompt-composer", () => ({
	TaskPromptComposer: () => null,
}));

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
	newTaskStartInPlanMode: boolean;
	newTaskBranchRef: string;
	newTaskWorktreeMode: RuntimeTaskWorktreeMode;
	newTaskAgentId: RuntimeAgentId | undefined;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	newTaskTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	newTaskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
	editingTaskId: string | null;
	editTaskPrompt: string;
	editTaskStartInPlanMode: boolean;
	editTaskWorktreeMode: RuntimeTaskWorktreeMode;
	editTaskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
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
	setEditTaskWorktreeMode: (value: RuntimeTaskWorktreeMode) => void;
	setEditTaskAgentSessionInitialization: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	setNewTaskClineSettings: (value: RuntimeTaskClineSettings | undefined) => void;
	setNewTaskTerminalAgentModelOverrideSettings: (
		value: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		options?: { rememberSelectionForFutureCreateTasks?: boolean },
	) => void;
	setNewTaskAgentSessionInitialization: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
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
	newTaskStartInPlanModeByDefault = true,
	newTaskAgentPermissionModeByDefault = "bypass_all_permission_prompts" as const,
	isNewTaskStartInPlanModeDefaultLoaded = true,
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
	newTaskStartInPlanModeByDefault?: boolean;
	newTaskAgentPermissionModeByDefault?: RuntimeTaskAgentPermissionMode;
	isNewTaskStartInPlanModeDefaultLoaded?: boolean;
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
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		newTaskStartInPlanModeByDefault,
		newTaskAgentPermissionModeByDefault,
		isNewTaskStartInPlanModeDefaultLoaded,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		onSnapshot({
			board,
			isInlineTaskCreateOpen: editor.isInlineTaskCreateOpen,
			newTaskPrompt: editor.newTaskPrompt,
			newTaskImages: editor.newTaskImages,
			newTaskStartInPlanMode: editor.newTaskStartInPlanMode,
			newTaskBranchRef: editor.newTaskBranchRef,
			newTaskWorktreeMode: editor.newTaskWorktreeMode,
			newTaskAgentId: editor.newTaskAgentId,
			newTaskClineSettings: editor.newTaskClineSettings,
			newTaskTerminalAgentModelOverrideSettings: editor.newTaskTerminalAgentModelOverrideSettings,
			newTaskAgentSessionInitialization: editor.newTaskAgentSessionInitialization,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			editTaskStartInPlanMode: editor.editTaskStartInPlanMode,
			editTaskWorktreeMode: editor.editTaskWorktreeMode,
			editTaskAgentSessionInitialization: editor.editTaskAgentSessionInitialization,
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
			setEditTaskWorktreeMode: editor.setEditTaskWorktreeMode,
			setEditTaskAgentSessionInitialization: editor.setEditTaskAgentSessionInitialization,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskClineSettings: editor.setNewTaskClineSettings,
			setNewTaskTerminalAgentModelOverrideSettings: editor.setNewTaskTerminalAgentModelOverrideSettings,
			setNewTaskAgentSessionInitialization: editor.setNewTaskAgentSessionInitialization,
		});
	}, [
		board,
		editor.handleCreateTask,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editTaskAgentSessionInitialization,
		editor.editTaskStartInPlanMode,
		editor.editTaskWorktreeMode,
		editor.editingTaskId,
		editor.handleCancelEditTask,
		editor.handleOpenEditTask,
		editor.handleSaveEditedTask,
		editor.handleSaveAndStartEditedTask,
		editor.isEditTaskStartInPlanModeDisabled,
		editor.isInlineTaskCreateOpen,
		editor.newTaskPrompt,
		editor.newTaskImages,
		editor.newTaskStartInPlanMode,
		editor.newTaskBranchRef,
		editor.newTaskAgentId,
		editor.newTaskClineSettings,
		editor.newTaskTerminalAgentModelOverrideSettings,
		editor.newTaskAgentSessionInitialization,
		editor.setEditTaskAutoReviewEnabled,
		editor.setEditTaskAutoReviewMode,
		editor.setEditTaskWorktreeMode,
		editor.setEditTaskAgentSessionInitialization,
		editor.setEditTaskPrompt,
		editor.setNewTaskImages,
		editor.setNewTaskBranchRef,
		editor.setNewTaskPrompt,
		editor.setNewTaskTerminalAgentModelOverrideSettings,
		editor.setNewTaskAgentSessionInitialization,
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
		resetTaskEditDraftStoreForTests();
		fakeWorkspaceTaskEditDraftServer.snapshot = null;
		fakeWorkspaceTaskEditDraftServer.releaseFetch = null;
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

	it("defaults new tasks to plan mode from the runtime setting", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					newTaskStartInPlanModeByDefault={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(requireSnapshot(latestSnapshot).newTaskStartInPlanMode).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create default plan task");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.startInPlanMode).toBe(true);
	});

	it("ignores the legacy browser-local plan mode default when runtime setting is false", async () => {
		// 这个键早已退役（新任务是否进计划模式的真相源是服务端的 newTaskStartInPlanModeByDefault），
		// 所以刻意用裸字面量而不是 LocalStorageKey 成员——把它加回枚举等于承认它还是个现役键。
		localStorage.setItem("kanban.task-start-in-plan-mode", "true");
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					newTaskStartInPlanModeByDefault={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(requireSnapshot(latestSnapshot).newTaskStartInPlanMode).toBe(false);
	});

	it("does not create tasks before the runtime plan mode default has loaded", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					newTaskStartInPlanModeByDefault={true}
					isNewTaskStartInPlanModeDefaultLoaded={false}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create after config loads");
		});
		await act(async () => {
			const createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask();
			expect(createdTaskId).toBeNull();
		});

		expect(requireSnapshot(latestSnapshot).isInlineTaskCreateOpen).toBe(false);
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards).toHaveLength(0);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={requireSnapshot(latestSnapshot).board}
					newTaskStartInPlanModeByDefault={false}
					isNewTaskStartInPlanModeDefaultLoaded={true}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create after config loads");
		});
		await act(async () => {
			const createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask();
			expect(createdTaskId).not.toBeNull();
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.startInPlanMode).toBe(false);
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

	it("saves edited worktree mode and agent session initialization", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const originalInitialization: RuntimeTaskAgentSessionInitialization = {
			sourceAgentId: "codex",
			sourceSessionId: "123e4567-e89b-42d3-a456-426614174000",
			sourceSessionReuseMode: "resume_existing_session",
		};
		const updatedInitialization: RuntimeTaskAgentSessionInitialization = {
			...originalInitialization,
			sourceSessionReuseMode: "fork_existing_session",
		};
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				agentId: "codex",
				worktreeMode: "branch",
				taskAgentSessionInitialization: originalInitialization,
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

		const task = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
			requireSnapshot(latestSnapshot).setEditTaskWorktreeMode("inplace");
			requireSnapshot(latestSnapshot).setEditTaskAgentSessionInitialization(updatedInitialization);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]).toMatchObject({
			worktreeMode: "inplace",
			taskAgentSessionInitialization: updatedInitialization,
		});

		const updatedTask = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		if (!updatedTask) {
			throw new Error("Expected the updated backlog task.");
		}
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(updatedTask);
			requireSnapshot(latestSnapshot).setEditTaskAgentSessionInitialization(undefined);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});

		expect(
			requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.taskAgentSessionInitialization,
		).toBeUndefined();
	});

	it("falls back to an inplace task when a legacy edit draft has no worktree mode", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const task = createTask("task-1", "Initial prompt", 1, { worktreeMode: "inplace" });
		const legacyDraftKey = JSON.stringify(["project-1", task.id]);
		window.localStorage.setItem(
			LocalStorageKey.TaskEditDrafts,
			JSON.stringify({
				drafts: {
					[legacyDraftKey]: {
						taskId: task.id,
						prompt: "Legacy draft prompt",
						images: [],
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						branchRef: "main",
						savedAt: 1,
					},
				},
			}),
		);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([task])}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});

		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Legacy draft prompt");
		expect(requireSnapshot(latestSnapshot).editTaskWorktreeMode).toBe("inplace");
	});

	it("rebases the edit form onto the server draft that only arrives after the form was seeded from the mirror", async () => {
		const task = createTask("task-1", "Initial prompt", 1);
		const losingMirrorDraft: RuntimeTaskEditDraft = {
			taskId: task.id,
			prompt: "Losing mirror draft",
			images: [],
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			branchRef: "main",
			worktreeMode: "branch",
			savedAt: 1_000,
		};
		const winningServerDraft: RuntimeTaskEditDraft = {
			...losingMirrorDraft,
			prompt: "Winning server draft",
			savedAt: 2_000,
		};
		window.localStorage.setItem(
			LocalStorageKey.TaskEditDrafts,
			JSON.stringify({ drafts: { [JSON.stringify(["project-1", task.id])]: losingMirrorDraft } }),
		);
		fakeWorkspaceTaskEditDraftServer.snapshot = {
			draftsByTaskId: { [task.id]: winningServerDraft },
			supersededDraftCopies: [],
		};

		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([task])}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});

		// 快照还没到，表单只能被本地镜像里那份铺上——这一步本身没有错。
		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Losing mirror draft");

		await act(async () => {
			fakeWorkspaceTaskEditDraftServer.releaseFetch?.();
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		});

		// 快照落定后表单必须重铺成胜出那份。不重铺的话，接下来的去抖自动保存会拿落败内容直接覆盖
		// 服务端的当前草稿，而 save 意图**不**产生落败副本——胜出那份就此静默消失。
		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Winning server draft");

		await settleTaskEditDraftPersistence();

		expect(fakeWorkspaceTaskEditDraftServer.snapshot?.draftsByTaskId[task.id]?.prompt).toBe("Winning server draft");
		// 落败的那份也没丢：它由合并转存进了副本，等着用户自己认领或丢弃。
		expect(fakeWorkspaceTaskEditDraftServer.snapshot?.supersededDraftCopies.map((copy) => copy.draft.prompt)).toEqual(
			["Losing mirror draft"],
		);
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
		await settleTaskEditDraftPersistence();

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
		await settleTaskEditDraftPersistence();

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
		await settleTaskEditDraftPersistence();

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

	// 这条断言的方向是**有意反过来**的：以前每次建完卡都把下拉框复位回默认分支，于是在非默认分支
	// 上连续建卡的人每张卡都要重挑一次。现在刚用过的那条 ref 会留在框里（并由上层写进项目记忆）。
	it("keeps the base ref just used after creating, instead of snapping back to the default", async () => {
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
		expect(afterCreateSnapshot.newTaskBranchRef).toBe("main");
		expect(afterCreateSnapshot.board.columns[0]?.cards[0]?.baseRef).toBe("main");

		// 建卡成功会把这条 ref 写进项目记忆，于是上层重算出来的默认值也变成它——这里用「换个 prop
		// 再渲染一次」模拟那一步（本 hook 自己不读偏好，默认值一律由调用方算好传进来）。
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={afterCreateSnapshot.board}
					createTaskBranchOptions={[
						{ value: "feature/recent", label: "feature/recent" },
						{ value: "main", label: "main (default)" },
					]}
					defaultTaskBranchRef="feature/recent"
					defaultCreateTaskBranchRef="main"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("main");
	});

	it("remembers the base ref per project only once a task is actually created", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					currentProjectId="project-remembering-base-ref"
					createTaskBranchOptions={[
						{ value: "feature/recent", label: "feature/recent" },
						{ value: "main", label: "main (default)" },
					]}
					defaultTaskBranchRef="main"
					defaultCreateTaskBranchRef="main"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskBranchRef("feature/recent");
		});
		await act(async () => {});

		// 只是在下拉框里挑了一下还没建卡——此时改掉项目默认值会把「点开翻了翻又放弃」记成意图。
		expect(
			readEffectiveUserInterfacePreferenceValue("mostRecentlyUsedTaskCreateBaseRefByProjectId")?.[
				"project-remembering-base-ref"
			],
		).toBeUndefined();

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Build it on the feature branch");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});
		await act(async () => {});

		expect(
			readEffectiveUserInterfacePreferenceValue("mostRecentlyUsedTaskCreateBaseRefByProjectId")?.[
				"project-remembering-base-ref"
			],
		).toBe("feature/recent");
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

	it("persists session initialization on create and loads it with worktree mode in the shared backlog editor", async () => {
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

		const initialization: RuntimeTaskAgentSessionInitialization = {
			sourceAgentId: "claude",
			sourceSessionId: "11111111-2222-3333-8444-555555555555",
			sourceSessionReuseMode: "resume_existing_session",
		};
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Continue existing Claude work");
			requireSnapshot(latestSnapshot).setNewTaskAgentId("claude");
			requireSnapshot(latestSnapshot).setNewTaskWorktreeMode("inplace");
			requireSnapshot(latestSnapshot).setNewTaskAgentSessionInitialization(initialization);
		});
		let taskId: string | null = null;
		await act(async () => {
			taskId = requireSnapshot(latestSnapshot).handleCreateTask();
		});
		const createdTask = requireSnapshot(latestSnapshot).board.columns[0]?.cards.find((card) => card.id === taskId);
		expect(createdTask?.taskAgentSessionInitialization).toEqual(initialization);

		await act(async () => {
			if (createdTask) requireSnapshot(latestSnapshot).handleOpenEditTask(createdTask);
		});
		expect(requireSnapshot(latestSnapshot).editTaskWorktreeMode).toBe("inplace");
		expect(requireSnapshot(latestSnapshot).editTaskAgentSessionInitialization).toEqual(initialization);
	});

	it("allows selecting a new worktree when continuing a Claude session", async () => {
		const onWorktreeModeChange = vi.fn();
		await act(async () => {
			root.render(
				<TaskEditorDialog
					open
					onOpenChange={vi.fn()}
					prompt="Continue existing Claude work"
					onPromptChange={vi.fn()}
					images={[]}
					onImagesChange={vi.fn()}
					onCreate={() => null}
					taskAgentPermissionMode="bypass_all_permission_prompts"
					onTaskAgentPermissionModeChange={vi.fn()}
					onCreateMultiple={() => []}
					startInPlanMode={false}
					onStartInPlanModeChange={vi.fn()}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={vi.fn()}
					autoReviewMode="commit"
					onAutoReviewModeChange={vi.fn()}
					workspaceId="workspace-1"
					branchRef="main"
					branchOptions={[{ value: "main", label: "main" }]}
					onBranchRefChange={vi.fn()}
					worktreeMode="inplace"
					onWorktreeModeChange={onWorktreeModeChange}
					agentId="claude"
					onAgentIdChange={vi.fn()}
					onClineSettingsChange={vi.fn()}
					taskAgentSessionInitialization={{
						sourceAgentId: "claude",
						sourceSessionId: "11111111-2222-4333-8444-555555555555",
						sourceSessionReuseMode: "resume_existing_session",
					}}
					onTaskAgentSessionInitializationChange={vi.fn()}
				/>,
			);
		});

		const newWorktreeButton = document.body.querySelector<HTMLButtonElement>("#task-create-worktree-mode-branch");
		expect(newWorktreeButton?.disabled).toBe(false);

		await act(async () => {
			newWorktreeButton?.click();
		});

		expect(onWorktreeModeChange).toHaveBeenCalledWith("branch");
	});
});
