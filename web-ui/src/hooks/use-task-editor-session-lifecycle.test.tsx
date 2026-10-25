import type { ReferenceRelationModelingEditorDraft } from "@runtime-work-unit-relation-modeling-api-contract";
import type { Dispatch, SetStateAction } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { readSavedTaskEditDraft } from "@/hooks/task-edit-drafts";
import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/use-task-editor";
import * as taskCardQueries from "@/runtime/task-card-action-query";
import { resetTaskEditDraftStoreForTests } from "@/runtime/task-edit-draft-store";
import * as taskDraftQueries from "@/runtime/task-edit-drafts-query";
import type { WorkspaceTaskEditDraftsSnapshot } from "@/runtime/types";
import { resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import * as relationQueries from "@/runtime/work-unit-relation-modeling-query";
import * as assignmentPreflight from "@/state/task-project-assignment-preflight";
import { resetPendingTaskCardCommandBoardOverlayStore } from "@/stores/pending-task-card-command-board-overlay-store";
import { clearAllTaskCardActionCommandsInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardCard, BoardData, TaskImage } from "@/types";

vi.mock("@/state/task-project-assignment-preflight", () => ({
	runTaskProjectAssignmentPreflight: vi.fn(async (input: { workspaceId: string; baseRef: string }) => ({
		workspaceId: input.workspaceId,
		baseRef: input.baseRef,
	})),
	rememberTaskProjectAssignmentAnalysisAccepted: vi.fn(),
	hasAcceptedTaskProjectAssignmentAnalysis: vi.fn(() => true),
}));
vi.mock("@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards", () => ({
	ensureRuntimeAllocatedTaskIdPrefetchPoolFilled: vi.fn(),
	ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission: vi.fn(async () => undefined),
}));
vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: vi.fn(async (workspaceId: string) => ({
		git: {
			currentBranch: workspaceId === "target-project" ? "master" : "main",
			defaultBranch: workspaceId === "target-project" ? "master" : "main",
			branches: [{ name: workspaceId === "target-project" ? "master" : "main" }],
		},
	})),
}));
// 仅替换展示控件，实际 useTaskEditor、TaskEditorDialog 与关系草稿 hook 都参与时序。
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
vi.mock("@/components/task-creation-target-project-field", () => ({
	TaskCreationTargetProjectFieldControl: ({
		taskCreationTargetProjectField,
	}: {
		taskCreationTargetProjectField: { onSelectTargetWorkspaceId: (workspaceId: string) => void };
	}) => (
		<button type="button" onClick={() => taskCreationTargetProjectField.onSelectTargetWorkspaceId("target-project")}>
			选择目标项目
		</button>
	),
}));

const originalTask: BoardCard = {
	id: "task-editor-lifecycle",
	title: "已保存的任务",
	prompt: "已保存的正文",
	createdAt: 123,
	updatedAt: 123,
	baseRef: "main",
	startInPlanMode: false,
	taskAgentPermissionMode: "bypass_all_permission_prompts",
	taskConversationMode: "operational",
	autoReviewEnabled: false,
	autoReviewMode: "commit",
	worktreeMode: "branch",
};
function boardWithTask(task: BoardCard | null = originalTask): BoardData {
	return { columns: [{ id: "backlog", title: "Backlog", cards: task ? [task] : [] }] };
}
function taskSnapshot(task: BoardCard, workspaceId = "source-project") {
	return {
		workspaceId,
		taskCard: task,
		boardColumnIdContainingTaskCard: "backlog" as const,
		taskSessionSummaryLiveInRuntimeProcessMemory: null,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
	};
}
function deferredResult<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("异步门禁尚未初始化");
	};
	let reject: (reason: Error) => void = () => {
		throw new Error("异步门禁尚未初始化");
	};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
function relationDraft(): ReferenceRelationModelingEditorDraft {
	return {
		createdTaskId: null,
		createdTaskCardSnapshot: null,
		modelingSubmissionId: "lifecycle-relations",
		creationPrompt: "",
		creationTitle: "",
		relationRevocations: [],
		referenceRelationDrafts: [
			{
				draftId: "pending-reference",
				replacesRelationId: null,
				expectedAssertedRelationStateVersion: null,
				counterpartWorkUnit: {
					workUnitType: "kanban_board_card",
					workspaceId: "source-project",
					taskId: "peer-task",
					taskIncarnationCreatedAtEpochMs: 1,
				},
				relationKind: "reference_is_generally_related_with",
				currentTaskIsStatementSubject: true,
				relationAssertionRationaleOneSentence: "保留迁移后的关系",
				relationAssertionEvidencePointers: [],
				assertedRelationKindSpecificAttributes: {},
			},
		],
	};
}

let latestEditor: UseTaskEditorResult;
let replaceBroadcastBoard: Dispatch<SetStateAction<BoardData>>;
let renderCount = 0;
function SessionHarness({
	showDialog = false,
	currentProjectId = "source-project",
	selectedAgentId = "codex",
}: {
	showDialog?: boolean;
	currentProjectId?: string;
	selectedAgentId?: "codex" | "claude";
}) {
	const [board, setBoard] = useState(boardWithTask);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		createTaskBranchOptions: [{ value: "main", label: "main" }],
		editTaskBranchOptions: [{ value: "main", label: "main" }],
		defaultTaskBranchRef: "main",
		defaultCreateTaskBranchRef: "main",
		currentProjectId,
		selectedAgentId,
		newTaskStartInPlanModeByDefault: true,
		isNewTaskStartInPlanModeDefaultLoaded: true,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		newTaskAgentPermissionModeByDefault: "bypass_all_permission_prompts",
		setSelectedTaskId,
	});
	latestEditor = editor;
	replaceBroadcastBoard = setBoard;
	renderCount += 1;
	if (renderCount > 100) throw new Error("目标项目与基础分支出现持续重渲染");
	if (!showDialog) return null;
	const editing = editor.editingTaskId !== null;
	return (
		<TaskEditorDialog
			open={editing || editor.isInlineTaskCreateOpen}
			onOpenChange={(open) => {
				if (!open) {
					if (editing) editor.handleCancelEditTask();
					else editor.handleCancelCreateTask();
				}
			}}
			taskEditorMode={editing ? "edit" : "create"}
			editingTaskId={editor.editingTaskId}
			editorSessionWorkspaceId={editor.taskEditorSessionWorkspaceId}
			creatingTaskName={editor.newTaskName}
			onCreatingTaskNameChange={editor.setNewTaskName}
			editingTaskName={editor.editTaskName}
			onEditingTaskNameChange={editor.setEditTaskName}
			prompt={editing ? editor.editTaskPrompt : editor.newTaskPrompt}
			onPromptChange={editing ? editor.setEditTaskPrompt : editor.setNewTaskPrompt}
			images={editing ? editor.editTaskImages : editor.newTaskImages}
			onImagesChange={editing ? editor.setEditTaskImages : editor.setNewTaskImages}
			onCreate={editing ? editor.handleSaveEditedTask : editor.handleCreateTask}
			onCreateMultiple={editor.handleCreateTasks}
			startInPlanMode={editing ? editor.editTaskStartInPlanMode : editor.newTaskStartInPlanMode}
			onStartInPlanModeChange={editing ? editor.setEditTaskStartInPlanMode : editor.setNewTaskStartInPlanMode}
			taskAgentPermissionMode={editing ? editor.editTaskAgentPermissionMode : editor.newTaskAgentPermissionMode}
			onTaskAgentPermissionModeChange={
				editing ? editor.setEditTaskAgentPermissionMode : editor.setNewTaskAgentPermissionMode
			}
			taskConversationMode={editing ? editor.editTaskConversationMode : editor.newTaskConversationMode}
			onTaskConversationModeChange={editing ? editor.setEditTaskConversationMode : editor.setNewTaskConversationMode}
			autoReviewEnabled={editing ? editor.editTaskAutoReviewEnabled : editor.newTaskAutoReviewEnabled}
			onAutoReviewEnabledChange={editing ? editor.setEditTaskAutoReviewEnabled : editor.setNewTaskAutoReviewEnabled}
			autoReviewMode={editing ? editor.editTaskAutoReviewMode : editor.newTaskAutoReviewMode}
			onAutoReviewModeChange={editing ? editor.setEditTaskAutoReviewMode : editor.setNewTaskAutoReviewMode}
			workspaceId={editing ? editor.editTaskWorkspaceId : editor.taskCreationTargetWorkspaceId}
			branchRef={editing ? editor.editTaskBranchRef : editor.newTaskBranchRef}
			branchOptions={
				editing ? editor.editTaskBranchOptionsForEditTarget : editor.createTaskBranchOptionsForCreationTarget
			}
			onBranchRefChange={editing ? editor.setEditTaskBranchRef : editor.setNewTaskBranchRef}
			worktreeMode={editing ? editor.editTaskWorktreeMode : editor.newTaskWorktreeMode}
			onWorktreeModeChange={editing ? editor.setEditTaskWorktreeMode : editor.setNewTaskWorktreeMode}
			taskCreationTargetProjectField={{
				taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope",
				selectedTargetWorkspaceId: editing
					? editor.editTaskTargetWorkspaceId
					: editor.taskCreationTargetWorkspaceId,
				onSelectTargetWorkspaceId: editing
					? editor.handleSelectEditTaskTargetProject
					: editor.handleSelectTaskCreationTargetProject,
				selectableProjects: [
					{ workspaceId: "source-project", projectName: "来源项目" },
					{ workspaceId: "target-project", projectName: "目标项目" },
				],
			}}
		/>
	);
}

function button(label: string): HTMLButtonElement {
	const match = Array.from(document.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.trim().startsWith(label),
	);
	if (!match) throw new Error(`找不到按钮：${label}`);
	return match;
}
async function settleDraftPersistence() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 600));
	});
}

describe("任务编辑会话的挂起、目标与迁移生命周期", () => {
	let root: Root;
	let container: HTMLDivElement;
	let previousActEnvironment: boolean | undefined;
	let serverDrafts: Map<string, WorkspaceTaskEditDraftsSnapshot>;
	let storedTask: BoardCard;
	beforeEach(() => {
		renderCount = 0;
		localStorage.clear();
		sessionStorage.clear();
		resetTaskEditDraftStoreForTests();
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
		clearAllTaskCardActionCommandsInFlight();
		resetPendingTaskCardCommandBoardOverlayStore();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })),
		);
		serverDrafts = new Map();
		const readServerDrafts = (workspaceId: string) =>
			serverDrafts.get(workspaceId) ?? { draftsByTaskId: {}, supersededDraftCopies: [] };
		vi.spyOn(taskDraftQueries, "fetchWorkspaceTaskEditDrafts").mockImplementation(async (workspaceId) =>
			readServerDrafts(workspaceId),
		);
		vi.spyOn(taskDraftQueries, "mutateWorkspaceTaskEditDrafts").mockImplementation(async (workspaceId, mutation) => {
			const snapshot = structuredClone(readServerDrafts(workspaceId));
			if (mutation.kind === "save_task_edit_draft") snapshot.draftsByTaskId[mutation.draft.taskId] = mutation.draft;
			if (mutation.kind === "clear_task_edit_draft") delete snapshot.draftsByTaskId[mutation.taskId];
			serverDrafts.set(workspaceId, snapshot);
			return snapshot;
		});
		vi.spyOn(relationQueries, "readRelationModelingEditorDraft").mockResolvedValue(null);
		vi.spyOn(relationQueries, "persistRelationModelingEditorDraft").mockResolvedValue({ saved: true });
		vi.spyOn(relationQueries, "readRelationModelingPreview").mockImplementation(() => new Promise(() => {}));
		vi.spyOn(relationQueries, "applyReferenceRelationModelingChangesFromExplicitUserGesture").mockResolvedValue({
			modelingSubmissionId: "lifecycle-relations",
			alreadyApplied: false,
		});
		storedTask = { ...originalTask };
		vi.spyOn(taskCardQueries, "updateTaskCardFieldValuesInWorkspace").mockImplementation(
			async (workspaceId, request) => {
				if (request.taskCardFieldUpdate.taskCardFieldUpdateInputKind !== "three_state_task_card_field_value_patch")
					throw new Error("此回归要求三态字段补丁");
				storedTask = { ...storedTask, ...request.taskCardFieldUpdate.taskCardFieldValuePatch } as BoardCard;
				return { taskCardSnapshotAfterAction: taskSnapshot(storedTask, workspaceId) };
			},
		);
		vi.spyOn(taskCardQueries, "transferNeverStartedBacklogTaskToProjectInWorkspace").mockImplementation(
			async (_workspaceId, request) => ({
				operationId: request.operationId,
				taskId: request.taskId,
				workspaceId: request.targetWorkspaceId,
			}),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		resetTaskEditDraftStoreForTests();
		resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
		if (previousActEnvironment === undefined)
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		else
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
	});

	it("新建草稿挂起后恢复正文、附件、名称、全部设置与原目标，不重新套用默认值", async () => {
		await act(async () => root.render(<SessionHarness />));
		await act(async () => latestEditor.handleOpenCreateTaskInBoardScope("target-project"));
		const images: TaskImage[] = [
			{ id: "draft-image", data: "data:image/png;base64,YQ==", mimeType: "image/png", name: "附件.png" },
		];
		await act(async () => {
			latestEditor.setNewTaskName?.("不能丢失的名称");
			latestEditor.setNewTaskPrompt("不能丢失的新建正文");
			latestEditor.setNewTaskImages(images);
			latestEditor.setNewTaskStartInPlanMode(false);
			latestEditor.setNewTaskAgentPermissionMode("ask_for_every_tool_use");
			latestEditor.setNewTaskConversationMode("exploratory");
			latestEditor.setNewTaskAutoReviewEnabled(true);
			latestEditor.setNewTaskAutoReviewMode("pr");
			latestEditor.setNewTaskWorktreeMode("inplace");
			latestEditor.setNewTaskAgentId("codex");
			latestEditor.setNewTaskAgentSessionInitialization({
				sourceAgentId: "codex",
				sourceSessionId: "00000000-0000-4000-8000-000000000001",
				sourceSessionReuseMode: "fork_existing_session",
			});
		});
		await act(async () =>
			latestEditor.setNewTaskTerminalAgentModelOverrideSettings(
				{ agentId: "codex", modelId: "custom-draft-model" },
				{ rememberSelectionForFutureCreateTasks: false },
			),
		);
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await act(async () => root.render(<SessionHarness currentProjectId="background-project" />));
		await act(async () => latestEditor.handleResumeSuspendedTaskEditor());
		expect(latestEditor).toMatchObject({
			isInlineTaskCreateOpen: true,
			editingTaskId: null,
			newTaskName: "不能丢失的名称",
			newTaskPrompt: "不能丢失的新建正文",
			newTaskImages: images,
			newTaskStartInPlanMode: false,
			newTaskAgentPermissionMode: "ask_for_every_tool_use",
			newTaskConversationMode: "exploratory",
			newTaskAutoReviewEnabled: true,
			newTaskAutoReviewMode: "pr",
			newTaskBranchRef: "master",
			newTaskWorktreeMode: "inplace",
			newTaskAgentId: "codex",
			newTaskTerminalAgentModelOverrideSettings: { agentId: "codex", modelId: "custom-draft-model" },
			taskCreationTargetWorkspaceId: "target-project",
			taskEditorSessionWorkspaceId: "target-project",
			newTaskAgentSessionInitialization: {
				sourceAgentId: "codex",
				sourceSessionId: "00000000-0000-4000-8000-000000000001",
				sourceSessionReuseMode: "fork_existing_session",
			},
		});
	});

	it.each(["create", "edit"] as const)("%s 的目标选择与父层共用分支集合，不在 main/master 之间往返", async (mode) => {
		await act(async () => root.render(<SessionHarness showDialog />));
		await act(async () => {
			if (mode === "edit") latestEditor.handleOpenEditTask(originalTask);
			else latestEditor.handleOpenCreateTask();
		});
		await act(async () => {
			if (mode === "edit") latestEditor.setEditTaskPrompt("项目切换时保留正文");
			else latestEditor.setNewTaskPrompt("项目切换时保留正文");
		});
		await act(async () => button("选择目标项目").click());
		expect(
			mode === "edit" ? latestEditor.editTaskTargetWorkspaceId : latestEditor.taskCreationTargetWorkspaceId,
		).toBe("target-project");
		expect(mode === "edit" ? latestEditor.editTaskBranchRef : latestEditor.newTaskBranchRef).toBe("master");
		expect(mode === "edit" ? latestEditor.editTaskPrompt : latestEditor.newTaskPrompt).toBe("项目切换时保留正文");
		expect(latestEditor.taskEditorSessionWorkspaceId).toBe("source-project");
		const settledRenderCount = renderCount;
		await act(async () => Promise.resolve());
		expect(renderCount).toBe(settledRenderCount);
	});

	it("只有会话模式变化也会写到服务端草稿，清空浏览器状态后重开可恢复", async () => {
		await act(async () => root.render(<SessionHarness />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await settleDraftPersistence();
		const priorMutationCount = vi.mocked(taskDraftQueries.mutateWorkspaceTaskEditDrafts).mock.calls.length;
		await act(async () => latestEditor.setEditTaskConversationMode("exploratory"));
		await settleDraftPersistence();
		const subsequentMutations = vi
			.mocked(taskDraftQueries.mutateWorkspaceTaskEditDrafts)
			.mock.calls.slice(priorMutationCount);
		expect(subsequentMutations).toContainEqual([
			"source-project",
			{ kind: "save_task_edit_draft", draft: expect.objectContaining({ taskConversationMode: "exploratory" }) },
		]);
		await act(async () => root.render(null));
		localStorage.clear();
		resetTaskEditDraftStoreForTests();
		await act(async () => root.render(<SessionHarness />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		expect(latestEditor.editTaskConversationMode).toBe("exploratory");
		expect(readSavedTaskEditDraft("source-project", originalTask.id)?.taskConversationMode).toBe("exploratory");
	});

	it.each([undefined, "codex"] as const)("后台默认 Agent 变化不覆盖未提交的 %s 模型选择", async (explicitAgentId) => {
		await act(async () => root.render(<SessionHarness />));
		await act(async () => latestEditor.handleOpenCreateTask());
		await act(async () => latestEditor.setNewTaskAgentId(explicitAgentId));
		await act(async () =>
			latestEditor.setNewTaskTerminalAgentModelOverrideSettings(
				{ agentId: "codex", modelId: "model-kept-with-source-draft" },
				{ rememberSelectionForFutureCreateTasks: false },
			),
		);
		await act(async () =>
			root.render(<SessionHarness currentProjectId="background-project" selectedAgentId="claude" />),
		);
		expect(latestEditor.newTaskTerminalAgentModelOverrideSettings).toEqual({
			agentId: "codex",
			modelId: "model-kept-with-source-draft",
		});
	});

	it("原卡为探索模式时，未改动表单仍可采用迟到的服务端草稿", async () => {
		const pendingServerDrafts = deferredResult<WorkspaceTaskEditDraftsSnapshot>();
		vi.mocked(taskDraftQueries.fetchWorkspaceTaskEditDrafts).mockImplementationOnce(
			() => pendingServerDrafts.promise,
		);
		await act(async () => root.render(<SessionHarness />));
		const exploratoryTask = { ...originalTask, taskConversationMode: "exploratory" as const };
		await act(async () => replaceBroadcastBoard(boardWithTask(exploratoryTask)));
		await act(async () => latestEditor.handleOpenEditTask(exploratoryTask));
		await act(async () =>
			pendingServerDrafts.resolve({
				draftsByTaskId: {
					[originalTask.id]: {
						taskId: originalTask.id,
						prompt: "迟到的服务端探索草稿",
						images: [],
						taskTitleOverride: originalTask.title,
						startInPlanMode: false,
						taskConversationMode: "exploratory",
						taskAgentPermissionMode: "bypass_all_permission_prompts",
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						branchRef: "main",
						worktreeMode: "branch",
						savedAt: 999,
					},
				},
				supersededDraftCopies: [],
			}),
		);
		expect(latestEditor.editTaskConversationMode).toBe("exploratory");
		expect(latestEditor.editTaskPrompt).toBe("迟到的服务端探索草稿");
	});

	it("迁移广播先于响应时，直接保存入口也保留任务身份和正文", async () => {
		const pendingTransfer = deferredResult<void>();
		vi.mocked(taskCardQueries.transferNeverStartedBacklogTaskToProjectInWorkspace).mockImplementationOnce(
			async (_workspaceId, request) => {
				replaceBroadcastBoard(boardWithTask(null));
				await pendingTransfer.promise;
				return { operationId: request.operationId, taskId: request.taskId, workspaceId: request.targetWorkspaceId };
			},
		);
		await act(async () => root.render(<SessionHarness />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await act(async () => latestEditor.setEditTaskPrompt("直接保存的迁移草稿"));
		let persistence: Promise<boolean> | null = null;
		await act(async () =>
			latestEditor.handleSaveEditedTask({
				targetWorkspaceIdOverride: "target-project",
				baseRefOverride: "master",
				preserveFormUntilCreationConfirmed: true,
				onTaskPersistenceRequested: (requested) => {
					persistence = requested;
				},
			}),
		);
		expect(latestEditor.editingTaskId).toBe(originalTask.id);
		expect(latestEditor.editTaskPrompt).toBe("直接保存的迁移草稿");
		await act(async () => pendingTransfer.resolve());
		expect(await persistence).toBe(true);
		expect(latestEditor.editTaskWorkspaceId).toBe("target-project");
		expect(latestEditor.editTaskTargetWorkspaceId).toBe("target-project");
		expect(latestEditor.editTaskBranchRef).toBe("master");
		expect(readSavedTaskEditDraft("target-project", originalTask.id)?.prompt).toBe("直接保存的迁移草稿");
	});

	it("来源移除先广播仍保留编辑会话，迁移后关系失败可按目标身份重试，成功后才关闭", async () => {
		const pendingTransfer = deferredResult<void>();
		const pendingRelations =
			deferredResult<
				Awaited<ReturnType<typeof relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture>>
			>();
		vi.mocked(relationQueries.readRelationModelingEditorDraft).mockResolvedValue(relationDraft());
		vi.mocked(relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture).mockImplementationOnce(
			() => pendingRelations.promise,
		);
		vi.mocked(taskCardQueries.transferNeverStartedBacklogTaskToProjectInWorkspace).mockImplementationOnce(
			async (_workspaceId, request) => {
				replaceBroadcastBoard(boardWithTask(null));
				await pendingTransfer.promise;
				return { operationId: request.operationId, taskId: request.taskId, workspaceId: request.targetWorkspaceId };
			},
		);
		await act(async () => root.render(<SessionHarness showDialog />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await act(async () => latestEditor.setEditTaskPrompt("迁移中不能丢失的正文"));
		await act(async () => button("选择目标项目").click());
		await act(async () => button("保存更改").click());
		expect(latestEditor.editingTaskId).toBe(originalTask.id);
		expect(latestEditor.editTaskPrompt).toBe("迁移中不能丢失的正文");
		expect(relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture).not.toHaveBeenCalled();
		await act(async () => pendingTransfer.resolve());
		expect(latestEditor.editingTaskId).toBe(originalTask.id);
		expect(latestEditor.editTaskWorkspaceId).toBe("target-project");
		expect(latestEditor.taskEditorSessionWorkspaceId).toBe("source-project");
		expect(relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture).toHaveBeenCalledWith(
			"target-project",
			expect.objectContaining({ workUnit: expect.objectContaining({ bareTaskId: originalTask.id }) }),
		);
		await act(async () => pendingRelations.reject(new Error("受控关系写入失败")));
		expect(latestEditor.editingTaskId).toBe(originalTask.id);
		expect(readSavedTaskEditDraft("target-project", originalTask.id)?.prompt).toBe("迁移中不能丢失的正文");
		await act(async () => latestEditor.setEditTaskName("在目标位置重试的名称"));
		await act(async () => button("保存更改").click());
		expect(taskCardQueries.updateTaskCardFieldValuesInWorkspace).toHaveBeenLastCalledWith(
			"target-project",
			expect.objectContaining({ expectedTaskIncarnationCreatedAtEpochMs: originalTask.createdAt }),
		);
		expect(taskCardQueries.transferNeverStartedBacklogTaskToProjectInWorkspace).toHaveBeenCalledTimes(1);
		expect(latestEditor.editingTaskId).toBeNull();
	});

	it("本轮明确接受的归属分析可调整目标与分支，不被输入失效保护误拒", async () => {
		vi.mocked(assignmentPreflight.runTaskProjectAssignmentPreflight).mockResolvedValueOnce({
			workspaceId: "target-project",
			baseRef: "master",
		});
		vi.mocked(relationQueries.readRelationModelingEditorDraft).mockResolvedValue(relationDraft());
		await act(async () => root.render(<SessionHarness showDialog />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await act(async () => button("保存更改").click());
		expect(relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture).toHaveBeenCalledWith(
			"target-project",
			expect.objectContaining({ workUnit: expect.objectContaining({ bareTaskId: originalTask.id }) }),
		);
		expect(latestEditor.editingTaskId).toBeNull();
	});

	it("保存期间真实正文变化仍阻止关系应用，旧回调不能关闭新草稿", async () => {
		const pendingTransfer = deferredResult<void>();
		vi.mocked(relationQueries.readRelationModelingEditorDraft).mockResolvedValue(relationDraft());
		vi.mocked(taskCardQueries.transferNeverStartedBacklogTaskToProjectInWorkspace).mockImplementationOnce(
			async (_workspaceId, request) => {
				replaceBroadcastBoard(boardWithTask(null));
				await pendingTransfer.promise;
				return { operationId: request.operationId, taskId: request.taskId, workspaceId: request.targetWorkspaceId };
			},
		);
		await act(async () => root.render(<SessionHarness showDialog />));
		await act(async () => latestEditor.handleOpenEditTask(originalTask));
		await act(async () => button("选择目标项目").click());
		await act(async () => button("保存更改").click());
		await act(async () => latestEditor.setEditTaskPrompt("提交后出现的真实新输入"));
		await act(async () => pendingTransfer.resolve());
		expect(relationQueries.applyReferenceRelationModelingChangesFromExplicitUserGesture).not.toHaveBeenCalled();
		expect(latestEditor.editTaskPrompt).toBe("提交后出现的真实新输入");
		expect(latestEditor.editingTaskId).toBe(originalTask.id);
	});
});
