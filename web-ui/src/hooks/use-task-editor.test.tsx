import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { readSavedTaskEditDraft, saveTaskEditDraft } from "@/hooks/task-edit-drafts";
import { useTaskEditor } from "@/hooks/use-task-editor";
import { resetTaskEditDraftStoreForTests } from "@/runtime/task-edit-draft-store";
import type {
	RuntimeAgentId,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskConversationMode,
	RuntimeTaskEditDraft,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	WorkspaceTaskEditDraftMutation,
	WorkspaceTaskEditDraftsSnapshot,
} from "@/runtime/types";
import { readEffectiveUserInterfacePreferenceValue } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import type { NewTaskCardRuntimePersistenceOutcome } from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import { applyPendingTaskCardCommandBoardOverlay } from "@/state/pending-task-card-command-board-overlay";
import { startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import {
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	readPendingWebUiBoardMutationInitiatorForTaskCardAspect,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	resetPendingTaskCardCommandBoardOverlayStore,
	usePendingTaskCardCommandBoardOverlayEntries,
} from "@/stores/pending-task-card-command-board-overlay-store";
import {
	clearAllTaskCardActionCommandsInFlight,
	tryBeginTaskCardActionCommandInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";
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

// 建卡时「名字框留空」会 fire-and-forget 去要一个 AI 名字回填。这套用例没有服务器，所以把那条查询
// 换成可编排的替身：默认永不解决（= 与没有起名能力时的行为逐字一致），要测回填的用例自己放行。
const fakeTaskNameSuggestionEndpoint = vi.hoisted(() => ({
	respond: null as ((response: unknown) => void) | null,
	callCount: 0,
}));

// 建卡 id 只由 runtime 分配（dd2db Y-EVENT-12）：测试里把预分配池换成确定性的递增 id，不发真实分配请求。
// takeResultStatusOverride 用来模拟「池里还没备好」「runtime 分配不出 id」。
const runtimeAllocatedTaskIdPrefetchPoolStandIn = vi.hoisted(() => ({
	nextRuntimeAllocatedTaskIdStandInSequence: 0,
	takeResultStatusOverride: null as
		| null
		| "not_enough_runtime_allocated_task_ids_prefetched_yet"
		| "runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable",
	ensuredWorkspaceIds: [] as string[],
}));

vi.mock("@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards", () => ({
	ensureRuntimeAllocatedTaskIdPrefetchPoolFilled: (workspaceId: string) => {
		runtimeAllocatedTaskIdPrefetchPoolStandIn.ensuredWorkspaceIds.push(workspaceId);
	},
	takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards: (_workspaceId: string, count: number) => {
		if (runtimeAllocatedTaskIdPrefetchPoolStandIn.takeResultStatusOverride) {
			return { status: runtimeAllocatedTaskIdPrefetchPoolStandIn.takeResultStatusOverride };
		}
		return {
			status: "taken" as const,
			runtimeAllocatedTaskIds: Array.from({ length: count }, () => {
				runtimeAllocatedTaskIdPrefetchPoolStandIn.nextRuntimeAllocatedTaskIdStandInSequence += 1;
				return `r${String(runtimeAllocatedTaskIdPrefetchPoolStandIn.nextRuntimeAllocatedTaskIdStandInSequence).padStart(4, "0")}`;
			}),
		};
	},
}));

// cf427：建卡同时向 runtime 发起「启动 agent 前先落盘」。这里只记录调用，落盘与等待语义在该模块自己的测试里。
const beginPersistingNewBacklogTaskCardsMock = vi.hoisted(() => vi.fn());
const waitForNewTaskCardPersistedByRuntimeMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
const waitForAlreadyRequestedNewTaskCardRuntimePersistenceMock = vi.hoisted(() =>
	vi.fn(async (): Promise<NewTaskCardRuntimePersistenceOutcome> => ({ ok: true })),
);
vi.mock("@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start", () => ({
	beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart: beginPersistingNewBacklogTaskCardsMock,
	waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart: waitForNewTaskCardPersistedByRuntimeMock,
	waitForAlreadyRequestedNewTaskCardRuntimePersistenceWithoutRetrying:
		waitForAlreadyRequestedNewTaskCardRuntimePersistenceMock,
}));

// 行内改名、编辑器保存走 taskCardAction.updateTaskCardFieldValues：回一份「服务端已按 patch 写下」的动作后快照
//（null = 清除），广播回灌不在这里模拟——断言看 harness 的 displayedBoard（叠了 overlay）。
const updateTaskCardFieldValuesInWorkspaceMock = vi.hoisted(() =>
	vi.fn(
		async (
			_workspaceId: string,
			request: {
				taskId: string;
				taskCardFieldUpdate: { taskCardFieldValuePatch?: Record<string, unknown> };
			},
		) => ({
			taskCardSnapshotAfterAction: {
				taskCard: {
					id: request.taskId,
					title: "",
					prompt: "",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 0,
					updatedAt: 0,
					...Object.fromEntries(
						Object.entries(request.taskCardFieldUpdate.taskCardFieldValuePatch ?? {}).map(
							([fieldName, fieldValue]) => [fieldName, fieldValue ?? undefined],
						),
					),
				},
				boardColumnIdContainingTaskCard: "backlog",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		}),
	),
);
const startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock = vi.hoisted(() =>
	vi.fn(async (_workspaceId: string, request: { taskId: string }) => ({
		taskCardSnapshotAfterAction: {
			taskCard: {
				id: request.taskId,
				title: "",
				prompt: "",
				startInPlanMode: false,
				baseRef: "main",
				createdAt: 0,
				updatedAt: 0,
			},
			boardColumnIdContainingTaskCard: "in_progress",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		},
	})),
);
vi.mock("@/runtime/task-card-action-query", () => ({
	updateTaskCardFieldValuesInWorkspace: updateTaskCardFieldValuesInWorkspaceMock,
	startTaskCardAgentSessionMovingItIntoInProgressInWorkspace:
		startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock,
}));

// 编辑其他项目的卡时按那个项目只读 workspace.getState 拿分支列表。
const fetchWorkspaceStateMock = vi.hoisted(() =>
	vi.fn(async (_workspaceId: string) => ({
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }, { name: "release" }],
		},
	})),
);
vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: fetchWorkspaceStateMock,
}));

vi.mock("@/runtime/task-name-suggestion-query", () => ({
	suggestTaskNamesFromTaskDescription: vi.fn(() => {
		fakeTaskNameSuggestionEndpoint.callCount += 1;
		return new Promise((resolve) => {
			fakeTaskNameSuggestionEndpoint.respond = resolve;
		});
	}),
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
	};
}

// 字段顺序与 runtimeTaskImageSchema / fileToTaskImage 一致（id, data, mimeType, name?）。
function createTaskImage(id: string, data: string, overrides: Partial<TaskImage> = {}): TaskImage {
	return { id, data, mimeType: "image/png", ...overrides };
}

interface HookSnapshot {
	board: BoardData;
	// 与 App 同算法：会被保存的 board 叠上在途卡片命令的 overlay（服务端命令的结果在广播回灌前只在这里可见）。
	displayedBoard: BoardData;
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
	newTaskConversationMode: RuntimeTaskConversationMode;
	editingTaskId: string | null;
	editTaskPrompt: string;
	editTaskName: string;
	editTaskImages: TaskImage[];
	editTaskStartInPlanMode: boolean;
	editTaskWorktreeMode: RuntimeTaskWorktreeMode;
	editTaskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
	editTaskConversationMode: RuntimeTaskConversationMode;
	isEditTaskStartInPlanModeDisabled: boolean;
	handleOpenCreateTask: () => void;
	handleCreateTask: (options?: { keepDialogOpen?: boolean; taskNameOverride?: string }) => string | null;
	handleSaveTaskTitle: (taskId: string, title: string) => void;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskImages: (value: TaskImage[]) => void;
	setNewTaskBranchRef: (value: string) => void;
	setNewTaskWorktreeMode: (value: RuntimeTaskWorktreeMode) => void;
	handleOpenEditTask: (task: BoardCard) => void;
	handleOpenEditTaskCardInOtherProject: (workspaceId: string, task: BoardCard) => void;
	handleOpenCreateTaskInBoardScope: (defaultTargetWorkspaceId: string) => void;
	handleSelectTaskCreationTargetProject: (targetWorkspaceId: string) => void;
	taskCreationTargetWorkspaceId: string | null;
	taskCreationTargetOtherProjectWorkspaceId: string | null;
	createTaskBranchOptionsForCreationTarget: Array<{ value: string; label: string }>;
	handleCreateAndStartTaskInOtherProject: () => string | null;
	editTaskWorkspaceId: string | null;
	editTaskBranchOptionsForEditTarget: Array<{ value: string; label: string }>;
	editTaskBranchRef: string;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	setEditTaskPrompt: (value: string) => void;
	setEditTaskName: (value: string) => void;
	setEditTaskImages: (value: TaskImage[]) => void;
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
	setNewTaskConversationMode: (value: RuntimeTaskConversationMode) => void;
	setEditTaskConversationMode: (value: RuntimeTaskConversationMode) => void;
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
	const pendingTaskCardCommandBoardOverlayEntries = usePendingTaskCardCommandBoardOverlayEntries(currentProjectId);
	const displayedBoard = applyPendingTaskCardCommandBoardOverlay(board, pendingTaskCardCommandBoardOverlayEntries);
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
			displayedBoard,
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
			newTaskConversationMode: editor.newTaskConversationMode,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			editTaskName: editor.editTaskName,
			editTaskImages: editor.editTaskImages,
			editTaskStartInPlanMode: editor.editTaskStartInPlanMode,
			editTaskWorktreeMode: editor.editTaskWorktreeMode,
			editTaskAgentSessionInitialization: editor.editTaskAgentSessionInitialization,
			editTaskConversationMode: editor.editTaskConversationMode,
			isEditTaskStartInPlanModeDisabled: editor.isEditTaskStartInPlanModeDisabled,
			handleOpenCreateTask: editor.handleOpenCreateTask,
			handleCreateTask: editor.handleCreateTask,
			handleSaveTaskTitle: editor.handleSaveTaskTitle,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskImages: editor.setNewTaskImages,
			setNewTaskBranchRef: editor.setNewTaskBranchRef,
			setNewTaskWorktreeMode: editor.setNewTaskWorktreeMode,
			handleOpenEditTask: editor.handleOpenEditTask,
			handleOpenEditTaskCardInOtherProject: editor.handleOpenEditTaskCardInOtherProject,
			handleOpenCreateTaskInBoardScope: editor.handleOpenCreateTaskInBoardScope,
			handleSelectTaskCreationTargetProject: editor.handleSelectTaskCreationTargetProject,
			taskCreationTargetWorkspaceId: editor.taskCreationTargetWorkspaceId,
			taskCreationTargetOtherProjectWorkspaceId: editor.taskCreationTargetOtherProjectWorkspaceId,
			createTaskBranchOptionsForCreationTarget: editor.createTaskBranchOptionsForCreationTarget,
			handleCreateAndStartTaskInOtherProject: editor.handleCreateAndStartTaskInOtherProject,
			editTaskWorkspaceId: editor.editTaskWorkspaceId,
			editTaskBranchOptionsForEditTarget: editor.editTaskBranchOptionsForEditTarget,
			editTaskBranchRef: editor.editTaskBranchRef,
			handleCancelEditTask: editor.handleCancelEditTask,
			handleSaveEditedTask: editor.handleSaveEditedTask,
			handleSaveAndStartEditedTask: editor.handleSaveAndStartEditedTask,
			setEditTaskPrompt: editor.setEditTaskPrompt,
			setEditTaskName: editor.setEditTaskName,
			setEditTaskImages: editor.setEditTaskImages,
			setEditTaskAutoReviewEnabled: editor.setEditTaskAutoReviewEnabled,
			setEditTaskAutoReviewMode: editor.setEditTaskAutoReviewMode,
			setEditTaskWorktreeMode: editor.setEditTaskWorktreeMode,
			setEditTaskAgentSessionInitialization: editor.setEditTaskAgentSessionInitialization,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskClineSettings: editor.setNewTaskClineSettings,
			setNewTaskTerminalAgentModelOverrideSettings: editor.setNewTaskTerminalAgentModelOverrideSettings,
			setNewTaskAgentSessionInitialization: editor.setNewTaskAgentSessionInitialization,
			setNewTaskConversationMode: editor.setNewTaskConversationMode,
			setEditTaskConversationMode: editor.setEditTaskConversationMode,
		});
	}, [
		board,
		displayedBoard,
		editor.handleOpenEditTaskCardInOtherProject,
		editor.handleOpenCreateTaskInBoardScope,
		editor.handleSelectTaskCreationTargetProject,
		editor.taskCreationTargetWorkspaceId,
		editor.taskCreationTargetOtherProjectWorkspaceId,
		editor.createTaskBranchOptionsForCreationTarget,
		editor.handleCreateAndStartTaskInOtherProject,
		editor.editTaskWorkspaceId,
		editor.editTaskBranchOptionsForEditTarget,
		editor.editTaskBranchRef,
		editor.handleCreateTask,
		editor.handleSaveTaskTitle,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editTaskName,
		editor.editTaskImages,
		editor.editTaskAgentSessionInitialization,
		editor.editTaskConversationMode,
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
		editor.newTaskConversationMode,
		editor.setEditTaskAutoReviewEnabled,
		editor.setEditTaskAutoReviewMode,
		editor.setEditTaskWorktreeMode,
		editor.setEditTaskAgentSessionInitialization,
		editor.setEditTaskConversationMode,
		editor.setEditTaskPrompt,
		editor.setEditTaskImages,
		editor.setNewTaskImages,
		editor.setNewTaskBranchRef,
		editor.setNewTaskPrompt,
		editor.setNewTaskTerminalAgentModelOverrideSettings,
		editor.setNewTaskAgentSessionInitialization,
		editor.setNewTaskConversationMode,
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
		beginPersistingNewBacklogTaskCardsMock.mockClear();
		waitForAlreadyRequestedNewTaskCardRuntimePersistenceMock.mockReset();
		fakeWorkspaceTaskEditDraftServer.snapshot = null;
		fakeWorkspaceTaskEditDraftServer.releaseFetch = null;
		fakeTaskNameSuggestionEndpoint.respond = null;
		fakeTaskNameSuggestionEndpoint.callCount = 0;
		runtimeAllocatedTaskIdPrefetchPoolStandIn.takeResultStatusOverride = null;
		runtimeAllocatedTaskIdPrefetchPoolStandIn.ensuredWorkspaceIds = [];
		discardAllPendingWebUiBoardMutationInitiatorRecords();
		updateTaskCardFieldValuesInWorkspaceMock.mockClear();
		startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock.mockClear();
		resetPendingTaskCardCommandBoardOverlayStore();
		clearAllTaskCardActionCommandsInFlight();
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

	async function renderCreateHarness(): Promise<{ current: HookSnapshot | null }> {
		const captured: { current: HookSnapshot | null } = { current: null };
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						captured.current = snapshot;
					}}
				/>,
			);
		});
		return captured;
	}

	it("uses the name typed in the task name field as the card title", async () => {
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
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Login redirects to a blank page after SSO");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask({ taskNameOverride: "  Fix the SSO redirect  " });
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.title).toBe("Fix the SSO redirect");
		// 用户自己给了名字就不该再去问 AI。
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(0);
	});

	describe("建卡 id 由 runtime 预分配（dd2db Y-EVENT-12）与发起方登记（Y-EVENT-8）", () => {
		it("primes the project's id pool on mount and again when the create dialog opens", async () => {
			const captured = await renderCreateHarness();
			expect(runtimeAllocatedTaskIdPrefetchPoolStandIn.ensuredWorkspaceIds).toEqual(["project-1"]);

			await act(async () => {
				requireSnapshot(captured.current).handleOpenCreateTask();
			});
			expect(runtimeAllocatedTaskIdPrefetchPoolStandIn.ensuredWorkspaceIds).toEqual(["project-1", "project-1"]);
		});

		it("creates the card with the prefetched runtime id and records the creation as a user gesture", async () => {
			const captured = await renderCreateHarness();
			await act(async () => {
				requireSnapshot(captured.current).setNewTaskPrompt("Created with a runtime id");
			});
			let createdTaskId: string | null = null;
			await act(async () => {
				createdTaskId = requireSnapshot(captured.current).handleCreateTask({ taskNameOverride: "Named" });
			});

			expect(createdTaskId).toMatch(/^r\d{4}$/u);
			expect(requireSnapshot(captured.current).board.columns[0]?.cards.map((card) => card.id)).toEqual([
				createdTaskId,
			]);
			expect(
				readPendingWebUiBoardMutationInitiatorForTaskCardAspect(createdTaskId ?? "", "task_card_creation"),
			).toBe("web_ui_user_gesture");
			expect(beginPersistingNewBacklogTaskCardsMock).toHaveBeenLastCalledWith({
				workspaceId: "project-1",
				newBacklogTaskCardsCreatedFromWebUi: [expect.objectContaining({ id: createdTaskId, title: "Named" })],
				boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
			});
		});

		it("takes one runtime id per prompt when creating a batch", async () => {
			const captured = await renderCreateHarness();
			let createdTaskIds: string[] = [];
			await act(async () => {
				createdTaskIds = requireSnapshot(captured.current).handleCreateTasks(["First", "Second", "Third"]);
			});

			expect(createdTaskIds).toHaveLength(3);
			expect(new Set(createdTaskIds).size).toBe(3);
			for (const taskId of createdTaskIds) {
				expect(taskId).toMatch(/^r\d{4}$/u);
				expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect(taskId, "task_card_creation")).toBe(
					"web_ui_user_gesture",
				);
			}
			// 整批一次请求落盘，顺序取本地 backlog 列自上而下（后建的在上）。
			expect(beginPersistingNewBacklogTaskCardsMock).toHaveBeenLastCalledWith(
				expect.objectContaining({
					workspaceId: "project-1",
					newBacklogTaskCardsCreatedFromWebUi: [...createdTaskIds]
						.reverse()
						.map((taskId) => expect.objectContaining({ id: taskId })),
				}),
			);
		});

		it.each([
			"not_enough_runtime_allocated_task_ids_prefetched_yet",
			"runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable",
		] as const)(
			"blocks creation and keeps the draft instead of inventing a local id (%s)",
			async (takeResultStatus) => {
				const captured = await renderCreateHarness();
				await act(async () => {
					requireSnapshot(captured.current).handleOpenCreateTask();
					requireSnapshot(captured.current).setNewTaskPrompt("Waiting for an id");
				});
				runtimeAllocatedTaskIdPrefetchPoolStandIn.takeResultStatusOverride = takeResultStatus;

				let createdTaskId: string | null = "not-called";
				let createdTaskIds: string[] = ["not-called"];
				await act(async () => {
					createdTaskId = requireSnapshot(captured.current).handleCreateTask();
					createdTaskIds = requireSnapshot(captured.current).handleCreateTasks(["Batch A", "Batch B"]);
				});

				expect(createdTaskId).toBeNull();
				expect(createdTaskIds).toEqual([]);
				const snapshot = requireSnapshot(captured.current);
				expect(snapshot.board.columns[0]?.cards).toEqual([]);
				expect(snapshot.newTaskPrompt).toBe("Waiting for an id");
				expect(snapshot.isInlineTaskCreateOpen).toBe(true);
			},
		);

		it("records title edits as user gestures but leaves the asynchronous AI title backfill without an initiator", async () => {
			const captured = await renderCreateHarness();
			await act(async () => {
				requireSnapshot(captured.current).setNewTaskPrompt("Login redirects to a blank page after SSO");
			});
			let createdTaskId = "";
			await act(async () => {
				createdTaskId = requireSnapshot(captured.current).handleCreateTask({ taskNameOverride: "   " }) ?? "";
			});
			discardAllPendingWebUiBoardMutationInitiatorRecords();

			await act(async () => {
				fakeTaskNameSuggestionEndpoint.respond?.({
					status: "suggested",
					suggestedTaskNames: ["Fix the SSO redirect"],
				});
			});
			expect(
				readPendingWebUiBoardMutationInitiatorForTaskCardAspect(createdTaskId, "task_card_field_values"),
			).toBeUndefined();
			expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({
					expectedTaskTitleAndPromptForAiNameBackfill: {
						title: "Login redirects to a blank page after SSO",
						prompt: "Login redirects to a blank page after SSO",
					},
				}),
			);

			expect(updateTaskCardFieldValuesInWorkspaceMock.mock.calls.at(-1)?.[1]).not.toHaveProperty(
				"boardMutationInitiator",
			);

			// 用户改名走 taskCardAction：发起方随命令交给服务端（账本在服务端记），不进 saveState 的待配登记。
			await act(async () => {
				requireSnapshot(captured.current).handleSaveTaskTitle(createdTaskId, "Renamed by the user");
			});
			expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith(expect.any(String), {
				taskId: createdTaskId,
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: { title: "Renamed by the user" },
				},
				boardMutationInitiator: "web_ui_user_gesture",
			});
		});
	});

	it("derives the title from the prompt when the name field is empty, then backfills the suggested name", async () => {
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
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Login redirects to a blank page after SSO");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask({ taskNameOverride: "   " });
		});

		// 先落卡：标题是正则推导值，建卡完全不等起名请求。
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.title).toBe(
			"Login redirects to a blank page after SSO",
		);
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);

		await act(async () => {
			fakeTaskNameSuggestionEndpoint.respond?.({
				status: "suggested",
				suggestedTaskNames: ["Fix the SSO redirect", "Repair post-SSO navigation"],
			});
		});

		// 服务端锁内回填，浏览器等广播；不再写一份可能覆盖并发改名的旧 board。
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: { title: "Fix the SSO redirect" },
				},
				expectedTaskTitleAndPromptForAiNameBackfill: {
					title: "Login redirects to a blank page after SSO",
					prompt: "Login redirects to a blank page after SSO",
				},
			}),
		);
	});

	it.each(["同项目单卡", "跨项目单卡", "清空名称保存后启动"])(
		"%s：启动锁在途时仍发送一次 AI 条件回填",
		async (entry) => {
			const captured = await renderCreateHarness();
			const workspaceId = entry === "跨项目单卡" ? "project-b" : "project-1";
			if (entry === "跨项目单卡") {
				await act(async () => requireSnapshot(captured.current).handleOpenCreateTaskInBoardScope(workspaceId));
			}
			await act(async () => requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求"));
			let taskId = "";
			await act(async () => {
				taskId =
					requireSnapshot(captured.current).handleCreateTask(
						entry === "清空名称保存后启动" ? { taskNameOverride: "用户名称" } : undefined,
					) ?? "";
			});
			expect(taskId).not.toBe("");
			if (entry === "清空名称保存后启动") {
				const task = requireSnapshot(captured.current).board.columns[0]?.cards[0];
				if (!task) throw new Error("未找到待编辑的卡片");
				await act(async () => requireSnapshot(captured.current).handleOpenEditTask(task));
				await act(async () => requireSnapshot(captured.current).setEditTaskName(""));
				await act(async () => requireSnapshot(captured.current).handleSaveEditedTask());
				updateTaskCardFieldValuesInWorkspaceMock.mockClear();
			}
			const finishStart = tryBeginTaskCardActionCommandInFlight(
				workspaceId,
				taskId,
				"start_task_card_agent_session_moving_it_into_in_progress",
			);
			expect(finishStart).not.toBeNull();
			try {
				await act(async () =>
					fakeTaskNameSuggestionEndpoint.respond?.({
						status: "suggested",
						suggestedTaskNames: ["[FIX]建议名称"],
					}),
				);
				expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledExactlyOnceWith(
					workspaceId,
					expect.objectContaining({
						taskId,
						expectedTaskTitleAndPromptForAiNameBackfill: { title: "完整初始需求", prompt: "完整初始需求" },
					}),
				);
				expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
			} finally {
				finishStart?.();
			}
		},
	);

	it("AI 回填请求未完成时，正常启动仍发出且完成", async () => {
		const captured = await renderCreateHarness();
		await act(async () => requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求"));
		let taskId = "";
		await act(async () => {
			taskId = requireSnapshot(captured.current).handleCreateTask() ?? "";
		});
		let releaseBackfill!: (response: Awaited<ReturnType<typeof updateTaskCardFieldValuesInWorkspaceMock>>) => void;
		const pendingBackfill = new Promise<Awaited<ReturnType<typeof updateTaskCardFieldValuesInWorkspaceMock>>>(
			(resolve) => {
				releaseBackfill = resolve;
			},
		);
		updateTaskCardFieldValuesInWorkspaceMock.mockReturnValueOnce(pendingBackfill);
		await act(async () =>
			fakeTaskNameSuggestionEndpoint.respond?.({
				status: "suggested",
				suggestedTaskNames: ["[FIX]建议名称"],
			}),
		);
		try {
			await act(async () => {
				const started = await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
					workspaceId: "project-1",
					taskId,
				});
				expect(started.taskCardActionCommandExecutionOutcome).toBe("command_completed_by_runtime");
			});
			expect(startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock).toHaveBeenCalledOnce();
		} finally {
			await act(async () =>
				releaseBackfill({
					taskCardSnapshotAfterAction: {
						taskCard: { ...createTask(taskId, "完整初始需求", 1), title: "[FIX]建议名称" },
						boardColumnIdContainingTaskCard: "backlog",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				}),
			);
		}
	});

	it("AI 先返回时只等待已请求的落盘，建卡不等待且落盘后只回填一次", async () => {
		let releasePersistence!: (outcome: NewTaskCardRuntimePersistenceOutcome) => void;
		waitForAlreadyRequestedNewTaskCardRuntimePersistenceMock.mockReturnValueOnce(
			new Promise((resolve) => {
				releasePersistence = resolve;
			}),
		);
		const captured = await renderCreateHarness();
		await act(async () => requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求"));
		await act(async () => {
			expect(requireSnapshot(captured.current).handleCreateTask()).not.toBeNull();
		});
		expect(requireSnapshot(captured.current).board.columns[0]?.cards[0]?.title).toBe("完整初始需求");
		await act(async () =>
			fakeTaskNameSuggestionEndpoint.respond?.({ status: "suggested", suggestedTaskNames: ["[FIX]建议名称"] }),
		);
		expect(updateTaskCardFieldValuesInWorkspaceMock).not.toHaveBeenCalled();
		await act(async () => releasePersistence({ ok: true }));
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledOnce();
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
	});

	it("落盘失败时结束 AI 回填，不补建卡片或重试模型", async () => {
		waitForAlreadyRequestedNewTaskCardRuntimePersistenceMock.mockResolvedValueOnce({
			ok: false,
			message: "落盘失败",
		});
		const captured = await renderCreateHarness();
		await act(async () => requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求"));
		await act(async () => {
			expect(requireSnapshot(captured.current).handleCreateTask()).not.toBeNull();
		});
		await act(async () =>
			fakeTaskNameSuggestionEndpoint.respond?.({ status: "suggested", suggestedTaskNames: ["[FIX]建议名称"] }),
		);
		expect(updateTaskCardFieldValuesInWorkspaceMock).not.toHaveBeenCalled();
		expect(beginPersistingNewBacklogTaskCardsMock).toHaveBeenCalledOnce();
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
	});

	it("回填请求失败时保留临时名称，不重复模型请求或更新", async () => {
		const captured = await renderCreateHarness();
		await act(async () => requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求"));
		await act(async () => {
			requireSnapshot(captured.current).handleCreateTask();
		});
		updateTaskCardFieldValuesInWorkspaceMock.mockRejectedValueOnce(new Error("更新失败"));
		await act(async () =>
			fakeTaskNameSuggestionEndpoint.respond?.({ status: "suggested", suggestedTaskNames: ["[FIX]建议名称"] }),
		);
		expect(requireSnapshot(captured.current).board.columns[0]?.cards[0]?.title).toBe("完整初始需求");
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledOnce();
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
	});

	it("leaves the derived title alone when the naming endpoint is unavailable", async () => {
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
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Login redirects to a blank page after SSO");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});
		await act(async () => {
			fakeTaskNameSuggestionEndpoint.respond?.({
				status: "unavailable",
				unavailableReason: "api_key_not_configured",
			});
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.title).toBe(
			"Login redirects to a blank page after SSO",
		);
	});

	it("does not overwrite a title the user changed while the naming request was in flight", async () => {
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
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Login redirects to a blank page after SSO");
		});
		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask();
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveTaskTitle(String(createdTaskId), "Renamed by hand");
		});
		await act(async () => {
			fakeTaskNameSuggestionEndpoint.respond?.({
				status: "suggested",
				suggestedTaskNames: ["Fix the SSO redirect"],
			});
		});

		// 改名已发给服务端（广播回灌前只在 overlay 里）：回填看到的是叠了 overlay 的标题，让路，不顶掉用户的名字。
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ taskId: createdTaskId }),
		);
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.title).not.toBe("Fix the SSO redirect");
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

	it("会话模式声明（蓝图 §A.1）：create 落卡片、edit 从卡片铺表单、保存写回", async () => {
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

		// create：默认 operational；切到 exploratory 建卡 → 卡片带上声明。
		expect(requireSnapshot(latestSnapshot).newTaskConversationMode).toBe("operational");
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Explore the codebase");
			requireSnapshot(latestSnapshot).setNewTaskConversationMode("exploratory");
		});
		let taskId: string | null = null;
		await act(async () => {
			taskId = requireSnapshot(latestSnapshot).handleCreateTask();
		});
		const createdTask = requireSnapshot(latestSnapshot).board.columns[0]?.cards.find((card) => card.id === taskId);
		expect(createdTask?.taskConversationMode).toBe("exploratory");
		// 建卡后（非 keepDialogOpen）回到缺省。
		expect(requireSnapshot(latestSnapshot).newTaskConversationMode).toBe("operational");

		// edit：表单从卡片铺模式；改回 operational 保存 → 写回卡片。
		await act(async () => {
			if (createdTask) requireSnapshot(latestSnapshot).handleOpenEditTask(createdTask);
		});
		expect(requireSnapshot(latestSnapshot).editTaskConversationMode).toBe("exploratory");
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskConversationMode("operational");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});
		// 保存走 taskCardAction：广播回灌前，结果在叠了 overlay 的显示看板上。
		const savedTask = requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards.find(
			(card) => card.id === taskId,
		);
		expect(savedTask?.taskConversationMode).toBe("operational");
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
		// 只发改过的字段（标题不发：服务端保留最新标题）；会被保存的 board 不动，显示看板立刻是新值。
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith("project-1", {
			taskId: "task-1",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: expect.objectContaining({ prompt: "Updated prompt" }),
			},
			boardMutationInitiator: "web_ui_user_gesture",
		});
		const sentPatch =
			updateTaskCardFieldValuesInWorkspaceMock.mock.calls[0]?.[1].taskCardFieldUpdate.taskCardFieldValuePatch;
		expect(sentPatch).not.toHaveProperty("title");
		expect(sentPatch).not.toHaveProperty("baseRef");
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Initial prompt");
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("清空名称时保存请求未完成也先显示本次提交描述推导的名称", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const task = createTask("task-1", "原始完整描述", 1, { title: "旧名称" });
		const submittedPrompt = "新的首行描述\n第二行补充说明";
		let resolveSaveCommand: () => void = () => {};
		updateTaskCardFieldValuesInWorkspaceMock.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				resolveSaveCommand = resolve;
			});
			return {
				taskCardSnapshotAfterAction: {
					taskCard: { ...task, title: "新的首行描述", prompt: submittedPrompt },
					boardColumnIdContainingTaskCard: "backlog",
					taskSessionSummaryLiveInRuntimeProcessMemory: null,
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				},
			};
		});
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
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskName(" ");
			requireSnapshot(latestSnapshot).setEditTaskPrompt(submittedPrompt);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.title).toBe("旧名称");
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.title).toBe("新的首行描述");
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(0);
		await act(async () => {
			resolveSaveCommand();
		});
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
	});

	it("Backlog 名称预填且单独改名只提交 title；清空后才发起有条件 AI 回填", async () => {
		const captured = await renderCreateHarness();
		await act(async () => {
			requireSnapshot(captured.current).setNewTaskPrompt("完整初始需求");
		});
		await act(async () => {
			requireSnapshot(captured.current).handleCreateTask({ taskNameOverride: "已保存名称" });
		});
		const task = requireSnapshot(captured.current).board.columns[0]?.cards[0];
		if (!task) throw new Error("Expected a task");
		await act(async () => {
			requireSnapshot(captured.current).handleOpenEditTask(task);
		});
		expect(requireSnapshot(captured.current).editTaskName).toBe("已保存名称");
		await act(async () => {
			requireSnapshot(captured.current).setEditTaskName("[FIX]明确名称");
		});
		await act(async () => {
			requireSnapshot(captured.current).handleSaveEditedTask();
		});
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenLastCalledWith(
			"project-1",
			expect.objectContaining({
				taskCardFieldUpdate: expect.objectContaining({ taskCardFieldValuePatch: { title: "[FIX]明确名称" } }),
			}),
		);
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(0);
		await act(async () => {
			requireSnapshot(captured.current).handleOpenEditTask(task);
		});
		await act(async () => {
			requireSnapshot(captured.current).setEditTaskName(" ");
		});
		await act(async () => {
			requireSnapshot(captured.current).handleSaveEditedTask();
		});
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenLastCalledWith(
			"project-1",
			expect.objectContaining({
				taskCardFieldUpdate: expect.objectContaining({ taskCardFieldValuePatch: { title: null } }),
			}),
		);
		expect(fakeTaskNameSuggestionEndpoint.callCount).toBe(1);
		await act(async () => {
			fakeTaskNameSuggestionEndpoint.respond?.({ status: "suggested", suggestedTaskNames: ["[FIX]建议名称"] });
		});
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenLastCalledWith(
			"project-1",
			expect.objectContaining({
				expectedTaskTitleAndPromptForAiNameBackfill: { title: "完整初始需求", prompt: "完整初始需求" },
			}),
		);
	});

	it("keeps the submitted edits as a draft and does not start when the runtime rejects the save", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		const task = createTask("task-1", "Initial prompt", 1);
		updateTaskCardFieldValuesInWorkspaceMock.mockImplementationOnce(async () => {
			throw new Error('Task "task-1" was not found');
		});

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([task])}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Edits that must not be lost");
			requireSnapshot(latestSnapshot).setEditTaskName("[FIX]不能丢失的名称草稿");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveAndStartEditedTask();
		});

		expect(queueTaskStartAfterEdit).not.toHaveBeenCalled();
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.prompt).toBe("Initial prompt");
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTask(task);
		});
		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Edits that must not be lost");
		expect(requireSnapshot(latestSnapshot).editTaskName).toBe("[FIX]不能丢失的名称草稿");
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

		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]).toMatchObject({
			worktreeMode: "inplace",
			taskAgentSessionInitialization: updatedInitialization,
		});

		const updatedTask = requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0];
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
			requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.taskAgentSessionInitialization,
		).toBeUndefined();
		// 清掉可选字段发 null（服务端三态 patch 的「清除」）。
		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenLastCalledWith(
			"project-1",
			expect.objectContaining({
				taskCardFieldUpdate: expect.objectContaining({
					taskCardFieldValuePatch: { taskAgentSessionInitialization: null },
				}),
			}),
		);
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
		expect(requireSnapshot(latestSnapshot).editTaskName).toBe(task.title);
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
			requireSnapshot(latestSnapshot).setEditTaskName("[FIX]跨重开恢复名称");
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
		expect(requireSnapshot(latestSnapshot).editTaskName).toBe("[FIX]跨重开恢复名称");
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
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.prompt).toBe("Saved draft prompt");
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

	it("does not autosave a draft when an image-bearing edit form still matches the task", async () => {
		// 粘贴图是 MB 级 base64：表单没动过时，去抖那一拍必须判出「等于任务本体」并什么也不写。
		// 任务显式带上与 harness 默认一致的 permission mode，让图片成为唯一可能不等的字段。
		const largeImage = createTaskImage("image-1", `data:image/png;base64,${"a".repeat(1_000_000)}`);
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				images: [largeImage],
				taskAgentPermissionMode: "bypass_all_permission_prompts",
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
		});
		await settleTaskEditDraftPersistence();

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toBeNull();
	});

	it("autosaves a draft when an edited image keeps its byte length but changes its content", async () => {
		// 同 id / 同 mimeType / data 长度也相同，只有内容不同：长度早退放它过去，必须靠 data 本身判出不等。
		const originalImage = createTaskImage("image-1", `data:image/png;base64,${"a".repeat(1_000_000)}`);
		const editedImage = createTaskImage("image-1", `data:image/png;base64,${"a".repeat(999_999)}b`);
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				images: [originalImage],
				taskAgentPermissionMode: "bypass_all_permission_prompts",
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
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskImages([editedImage]);
		});
		await settleTaskEditDraftPersistence();

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toContain("image-1");
	});

	it("does not autosave a draft when images are replaced by copies with identical content", async () => {
		// 内容逐字相同、引用不同的另一份图片对象（含可选 name）：也必须判等，
		// 否则任何一次「重建图片数组」都会被当成改动而落一份假草稿。
		const largeData = `data:image/png;base64,${"a".repeat(1_000_000)}`;
		const taskImage = createTaskImage("image-1", largeData, { name: "paste.png" });
		const identicalCopy = createTaskImage("image-1", largeData, { name: "paste.png" });
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				images: [taskImage],
				taskAgentPermissionMode: "bypass_all_permission_prompts",
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
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskImages([identicalCopy]);
		});
		await settleTaskEditDraftPersistence();

		expect(window.localStorage.getItem(LocalStorageKey.TaskEditDrafts)).toBeNull();
	});

	it("rebases an image-bearing edit form whose images were only replaced by identical copies", async () => {
		// 迟到的服务端快照只有在「用户还没动过表单」时才允许重铺。图片被换成内容相同的副本不算动过——
		// 否则每一次图片数组重建都会把重铺闸门焊死，胜出的服务端草稿永远铺不上来。
		const task = createTask("task-1", "Initial prompt", 1);
		const mirrorImage = createTaskImage("image-1", `data:image/png;base64,${"a".repeat(1_000_000)}`);
		const serverImage = createTaskImage("image-2", `data:image/png;base64,${"c".repeat(1_000_000)}`);
		const losingMirrorDraft: RuntimeTaskEditDraft = {
			taskId: task.id,
			prompt: "Losing mirror draft",
			images: [mirrorImage],
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
			images: [serverImage],
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

		// 用户把图片「换」成了内容逐字相同的另一份对象——表单值与铺表种子判等，重铺闸门必须放行。
		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskImages([createTaskImage("image-1", mirrorImage.data)]);
		});

		await act(async () => {
			fakeWorkspaceTaskEditDraftServer.releaseFetch?.();
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
		});

		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Winning server draft");
		expect(requireSnapshot(latestSnapshot).editTaskImages).toEqual([serverImage]);
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

		// 保存命令在途时还不能排队启动：服务端启动读的是它自己板上的卡，抢先启动会拿旧 prompt 起会话。
		let resolveSaveCommand: () => void = () => {};
		updateTaskCardFieldValuesInWorkspaceMock.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				resolveSaveCommand = resolve;
			});
			return {
				taskCardSnapshotAfterAction: {
					taskCard: { ...task, prompt: "Updated prompt" },
					boardColumnIdContainingTaskCard: "backlog",
					taskSessionSummaryLiveInRuntimeProcessMemory: null,
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				},
			};
		});
		await act(async () => {
			latestSnapshot?.handleSaveAndStartEditedTask();
		});
		expect(queueTaskStartAfterEdit).not.toHaveBeenCalled();
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");

		await act(async () => {
			resolveSaveCommand();
		});
		expect(queueTaskStartAfterEdit).toHaveBeenCalledWith("task-1", 1);
	});

	it("编辑其他项目的 backlog 卡：草稿、分支、保存、保存并启动都作用于那个项目，不叠当前项目的 overlay", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		// 当前项目的 board 里有一张同号的卡：跨项目撞号时不得读到它。
		const currentProjectTaskWithSameId = createTask("task-1", "Current project prompt", 1);
		const otherProjectTask = createTask("task-1", "Other project prompt", 2, { baseRef: "release" });
		startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock.mockClear();
		fetchWorkspaceStateMock.mockClear();

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([currentProjectTaskWithSameId])}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTaskCardInOtherProject("project-b", otherProjectTask);
		});

		expect(requireSnapshot(latestSnapshot).editTaskWorkspaceId).toBe("project-b");
		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Other project prompt");
		expect(fetchWorkspaceStateMock).toHaveBeenCalledWith("project-b");
		// 分支列表按那个项目取；卡上的 base ref 不被当前项目的默认分支覆盖。
		expect(requireSnapshot(latestSnapshot).editTaskBranchOptionsForEditTarget.map((option) => option.value)).toEqual([
			"main",
			"release",
		]);
		expect(requireSnapshot(latestSnapshot).editTaskBranchRef).toBe("release");

		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Edited in place from All projects");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveAndStartEditedTask();
		});

		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith("project-b", {
			taskId: "task-1",
			expectedTaskIncarnationCreatedAtEpochMs: 2,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: expect.objectContaining({ prompt: "Edited in place from All projects" }),
			},
			boardMutationInitiator: "web_ui_user_gesture",
		});
		// 当前项目同号的卡不受影响（没有 overlay 叠到它身上）。
		expect(requireSnapshot(latestSnapshot).displayedBoard.columns[0]?.cards[0]?.prompt).toBe(
			"Current project prompt",
		);
		// 保存结算后直接对那个项目发启动命令，不进当前项目的启动队列。
		expect(queueTaskStartAfterEdit).not.toHaveBeenCalled();
		expect(startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock).toHaveBeenCalledWith(
			"project-b",
			expect.objectContaining({ taskId: "task-1" }),
		);
		expect(requireSnapshot(latestSnapshot).editTaskWorkspaceId).toBe("project-1");
	});

	it("编辑其他项目的 backlog 卡：当前项目 board 里没有同号卡时编辑框保持打开，不按当前项目清草稿，保存发给目标项目", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		// 当前项目只有一张不相干的卡；被编辑的卡只存在于 project-b（跨项目 taskId 通常不重号）。
		const unrelatedCurrentProjectTask = createTask("task-only-in-current-project", "Current project prompt", 1);
		const otherProjectTask = createTask("task-only-in-project-b", "Other project prompt", 2);
		// 当前项目名下一份同号草稿：「卡不在本页 backlog 就关编辑器」若按当前项目清草稿，这份会被误删。
		saveTaskEditDraft("project-1", {
			taskId: otherProjectTask.id,
			prompt: "Draft recorded under the current project",
			images: [],
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			branchRef: "main",
			savedAt: 1,
		});

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard([unrelatedCurrentProjectTask])}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenEditTaskCardInOtherProject("project-b", otherProjectTask);
		});

		// 编辑框一打开就被关掉正是要钉住的回归：按编辑目标判定，那张卡（快照）就在 backlog。
		expect(requireSnapshot(latestSnapshot).editingTaskId).toBe("task-only-in-project-b");
		expect(requireSnapshot(latestSnapshot).editTaskWorkspaceId).toBe("project-b");
		expect(requireSnapshot(latestSnapshot).editTaskPrompt).toBe("Other project prompt");
		expect(readSavedTaskEditDraft("project-1", otherProjectTask.id)?.prompt).toBe(
			"Draft recorded under the current project",
		);

		await act(async () => {
			requireSnapshot(latestSnapshot).setEditTaskPrompt("Edited in place from All projects");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSaveEditedTask();
		});

		expect(updateTaskCardFieldValuesInWorkspaceMock).toHaveBeenCalledWith("project-b", {
			taskId: "task-only-in-project-b",
			expectedTaskIncarnationCreatedAtEpochMs: 2,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: expect.objectContaining({ prompt: "Edited in place from All projects" }),
			},
			boardMutationInitiator: "web_ui_user_gesture",
		});
		expect(readSavedTaskEditDraft("project-1", otherProjectTask.id)?.prompt).toBe(
			"Draft recorded under the current project",
		);
	});

	it("Board Scope 往其他项目建卡：id 取目标项目的池、经同一个 persist 端点落到目标项目，本页 board 不动", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		fetchWorkspaceStateMock.mockClear();
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
			requireSnapshot(latestSnapshot).handleOpenCreateTaskInBoardScope("project-b");
		});

		expect(requireSnapshot(latestSnapshot).isInlineTaskCreateOpen).toBe(true);
		expect(requireSnapshot(latestSnapshot).taskCreationTargetOtherProjectWorkspaceId).toBe("project-b");
		expect(runtimeAllocatedTaskIdPrefetchPoolStandIn.ensuredWorkspaceIds).toContain("project-b");
		// 分支选项按目标项目取。
		expect(fetchWorkspaceStateMock).toHaveBeenCalledWith("project-b");
		expect(
			requireSnapshot(latestSnapshot).createTaskBranchOptionsForCreationTarget.map((option) => option.value),
		).toEqual(["main", "release"]);

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Created from All projects");
		});
		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask({ taskNameOverride: "Named task" });
		});

		expect(createdTaskId).not.toBeNull();
		expect(beginPersistingNewBacklogTaskCardsMock).toHaveBeenCalledWith({
			workspaceId: "project-b",
			newBacklogTaskCardsCreatedFromWebUi: [
				expect.objectContaining({ id: createdTaskId, prompt: "Created from All projects", baseRef: "main" }),
			],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards).toEqual([]);
		// 关框后不再钉住目标。
		expect(requireSnapshot(latestSnapshot).isInlineTaskCreateOpen).toBe(false);
		expect(requireSnapshot(latestSnapshot).taskCreationTargetWorkspaceId).toBe("project-1");
	});

	it("Board Scope 选回当前项目时走本页建卡路径；往其他项目「建卡并启动」等落盘确认后对目标项目发启动命令", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock.mockClear();
		waitForNewTaskCardPersistedByRuntimeMock.mockClear();
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
			requireSnapshot(latestSnapshot).handleOpenCreateTaskInBoardScope("project-b");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleSelectTaskCreationTargetProject("project-1");
		});
		expect(requireSnapshot(latestSnapshot).taskCreationTargetOtherProjectWorkspaceId).toBeNull();
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Lands on this project's board");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards.map((card) => card.prompt)).toEqual([
			"Lands on this project's board",
		]);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleSelectTaskCreationTargetProject("project-b");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Start me in project B");
		});
		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateAndStartTaskInOtherProject();
		});

		expect(waitForNewTaskCardPersistedByRuntimeMock).toHaveBeenCalledWith({
			workspaceId: "project-b",
			taskCard: expect.objectContaining({ id: createdTaskId }),
		});
		expect(startTaskCardAgentSessionMovingItIntoInProgressInWorkspaceMock).toHaveBeenCalledWith(
			"project-b",
			expect.objectContaining({ taskId: createdTaskId }),
		);
		// 本页 board 只有选回当前项目时建的那张。
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards).toHaveLength(1);
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

	it("Board Scope 往其他项目建卡时挑的终端模型记在目标项目名下，不污染当前项目", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const readRememberedTerminalAgentModelSelectionsByProjectAndAgentKey = () =>
			readEffectiveUserInterfacePreferenceValue("taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey") ?? {};
		const creationTargetOtherProjectCursorSelectionKey = JSON.stringify(["project-b", "cursor"]);
		const currentProjectCursorSelectionKey = JSON.stringify(["project-1", "cursor"]);

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
			requireSnapshot(latestSnapshot).handleOpenCreateTaskInBoardScope("project-b");
		});
		expect(requireSnapshot(latestSnapshot).taskCreationTargetWorkspaceId).toBe("project-b");

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskTerminalAgentModelOverrideSettings({
				agentId: "cursor",
				modelId: "auto",
			});
		});

		const rememberedSelections = readRememberedTerminalAgentModelSelectionsByProjectAndAgentKey();
		expect(rememberedSelections[creationTargetOtherProjectCursorSelectionKey]).toBe("auto");
		expect(rememberedSelections[currentProjectCursorSelectionKey]).toBeUndefined();

		// 改回在当前项目建卡：读不到在其他项目挑的模型；再往目标项目建卡：记住的模型回填。
		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});
		expect(requireSnapshot(latestSnapshot).taskCreationTargetWorkspaceId).toBe("project-1");
		expect(requireSnapshot(latestSnapshot).newTaskTerminalAgentModelOverrideSettings).toBeUndefined();

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTaskInBoardScope("project-b");
		});
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

	function renderTaskCreateDialogForSuggestionRounds(open: boolean) {
		return (
			<TaskEditorDialog
				open={open}
				onOpenChange={vi.fn()}
				prompt="Login redirects to a blank page after SSO"
				onPromptChange={vi.fn()}
				images={[]}
				onImagesChange={vi.fn()}
				onCreate={() => "created-task-1"}
				taskAgentPermissionMode="bypass_all_permission_prompts"
				onTaskAgentPermissionModeChange={vi.fn()}
				taskConversationMode="operational"
				onTaskConversationModeChange={vi.fn()}
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
				worktreeMode="branch"
				onWorktreeModeChange={vi.fn()}
				onClineSettingsChange={vi.fn()}
			/>
		);
	}

	/** 关闭再打开会在 body 里留下上一次的 portal 残骸，所以一律只看「最后那个」对话框。 */
	function currentDialogElement(): HTMLElement {
		const dialogs = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]'));
		const currentDialog = dialogs.at(-1);
		if (!currentDialog) {
			throw new Error("Expected a rendered dialog.");
		}
		return currentDialog;
	}

	function findDialogButtonByLabel(label: string): HTMLButtonElement | undefined {
		return Array.from(currentDialogElement().querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === label,
		);
	}

	async function requestOneTaskNameSuggestionRound(): Promise<void> {
		await act(async () => {
			(findDialogButtonByLabel("Suggest names") ?? findDialogButtonByLabel("Suggest more"))?.click();
		});
		await act(async () => {
			fakeTaskNameSuggestionEndpoint.respond?.({
				status: "suggested",
				suggestedTaskNames: ["Fix the SSO redirect"],
			});
		});
	}

	it("drops the name suggestion rounds when the create dialog is closed and reopened", async () => {
		await act(async () => {
			root.render(renderTaskCreateDialogForSuggestionRounds(true));
		});
		await requestOneTaskNameSuggestionRound();
		expect(currentDialogElement().textContent).toContain("Suggestion 1");

		await act(async () => {
			root.render(renderTaskCreateDialogForSuggestionRounds(false));
		});
		await act(async () => {
			root.render(renderTaskCreateDialogForSuggestionRounds(true));
		});

		// 上一次建卡的候选不该跟到下一次打开的对话框里。
		expect(currentDialogElement().textContent).not.toContain("Suggestion 1");
		expect(findDialogButtonByLabel("Suggest more")).toBeUndefined();
	});

	it("drops the name suggestion rounds when Create more reuses the dialog for the next task", async () => {
		await act(async () => {
			root.render(renderTaskCreateDialogForSuggestionRounds(true));
		});
		const createMoreLabel = Array.from(currentDialogElement().querySelectorAll("label")).find((label) =>
			label.textContent?.includes("Create more"),
		);
		await act(async () => {
			document.getElementById(createMoreLabel?.getAttribute("for") ?? "")?.click();
		});
		await requestOneTaskNameSuggestionRound();
		expect(currentDialogElement().textContent).toContain("Suggestion 1");

		// 对话框留在原地不卸载，所以这一次靠换 key 重挂来清——上一张卡的候选不该跟到下一张。
		await act(async () => {
			findDialogButtonByLabel("Create")?.click();
		});
		expect(currentDialogElement().textContent).not.toContain("Suggestion 1");
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
					taskConversationMode="operational"
					onTaskConversationModeChange={vi.fn()}
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
