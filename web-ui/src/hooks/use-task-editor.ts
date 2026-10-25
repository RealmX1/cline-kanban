import { isKanbanCursorAgentModelId } from "@runtime-agent-catalog";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "@runtime-task-agent-permission-mode";
import { deriveTaskTitleFromPrompt, resolveTaskTitle } from "@runtime-task-title";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import {
	areTaskEditDraftFormValuesEqual,
	clearTaskEditDraft,
	isTaskEditDraftEqualToTask,
	readSavedTaskEditDraft,
	saveTaskEditDraft,
	type TaskEditDraft,
	type TaskEditDraftFormValues,
} from "@/hooks/task-edit-drafts";
import {
	buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor,
	type TaskEditorSubmittedTaskCardFieldValues,
} from "@/hooks/task-editor-changed-task-card-field-value-patch";
import { useGitRepositoryInfoOfOtherProjectForTaskEditorDialog } from "@/hooks/use-git-repository-info-of-other-project-for-task-editor-dialog";
import { buildTaskBranchOptions, resolveDefaultTaskBranchRef } from "@/hooks/use-task-branch-options";
import {
	ensureRuntimeAllocatedTaskIdPrefetchPoolFilled,
	takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards,
} from "@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards";
import { updateTaskCardFieldValuesInWorkspace } from "@/runtime/task-card-action-query";
import {
	hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror,
	subscribeToTaskEditDraftStore,
} from "@/runtime/task-edit-draft-store";
import { suggestTaskNamesFromTaskDescription } from "@/runtime/task-name-suggestion-query";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskConversationMode,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	RuntimeTerminalAgentModelSelectionAgentId,
} from "@/runtime/types";
import {
	useNewTaskAutoReviewEnabledPreference,
	useNewTaskAutoReviewModePreference,
} from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import {
	readEffectiveUserInterfacePreferenceValue,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { addTaskToColumnWithResult, findCardSelection, updateTask, updateTaskTitle } from "@/state/board-state";
import {
	beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart,
	waitForAlreadyRequestedNewTaskCardRuntimePersistenceWithoutRetrying,
	waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart,
} from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import {
	startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime,
	updateTaskCardFieldValuesThroughRuntime,
} from "@/state/task-card-action-commands-for-any-workspace";
import { recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards } from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import { toTelemetrySelectedAgentId, trackTaskCreated } from "@/telemetry/events";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import type {
	BoardCard,
	BoardColumnId,
	BoardData,
	TaskAutoReviewMode,
	TaskEditorSubmitOptions,
	TaskImage,
} from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useDebouncedEffect } from "@/utils/react-use";

// dd2db Y-EVENT-12：建卡只用 runtime 预分配的 id。池里不够时如实提示并阻止这次建卡（调用方返回 null / []，
// 建卡框与已填内容保持原样），绝不回退到本地随机 id——那会在保存时被 runtime 的全局 task id 登记簿拒绝。
function takeRuntimeAllocatedTaskIdsForNewTaskCardsOrExplainWhyTaskCreationIsBlocked(
	currentProjectId: string | null,
	requestedTaskCardCount: number,
): string[] | null {
	if (!currentProjectId) {
		showAppToast(
			{ intent: "warning", icon: "warning-sign", message: "Open a project before creating tasks.", timeout: 5000 },
			"task-creation-blocked-without-project",
		);
		return null;
	}
	const taken = takeRuntimeAllocatedTaskIdsForNewWebUiTaskCards(currentProjectId, requestedTaskCardCount);
	if (taken.status === "taken") {
		return taken.runtimeAllocatedTaskIds;
	}
	if (taken.status === "runtime_cannot_allocate_task_ids_because_relation_ledger_is_unavailable") {
		showAppToast(
			{
				intent: "danger",
				icon: "warning-sign",
				message:
					"The Kanban runtime cannot allocate task IDs right now (its relation ledger is unavailable), so new tasks cannot be saved.",
				timeout: 7000,
			},
			"task-creation-blocked-runtime-cannot-allocate-task-ids",
		);
		return null;
	}
	showAppToast(
		{
			intent: "warning",
			icon: "warning-sign",
			message:
				requestedTaskCardCount > 1
					? `Reserving ${requestedTaskCardCount} task IDs from the Kanban runtime — try creating again in a moment.`
					: "Reserving a task ID from the Kanban runtime — try creating again in a moment.",
			timeout: 5000,
		},
		"task-creation-blocked-awaiting-runtime-allocated-task-ids",
	);
	return null;
}

function isTerminalAgentModelSelectionAgentId(
	agentId: RuntimeAgentId | null | undefined,
): agentId is RuntimeTerminalAgentModelSelectionAgentId {
	return agentId === "claude" || agentId === "codex" || agentId === "cursor" || agentId === "kimi";
}

function getTaskCreateTerminalAgentModelSelectionStorageKey(
	projectId: string | null,
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): string {
	return JSON.stringify([projectId ?? "global", agentId]);
}

// 命令式读取（不在 React 渲染里），所以直接问外部 store 拿生效值：服务端优先、回落本地镜像。
function readRememberedTaskCreateTerminalAgentModelSelection(
	projectId: string | null,
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): string | undefined {
	const selections =
		readEffectiveUserInterfacePreferenceValue("taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey") ?? {};
	return selections[getTaskCreateTerminalAgentModelSelectionStorageKey(projectId, agentId)];
}

function resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(
	projectId: string | null,
	agentId: RuntimeAgentId | null | undefined,
): RuntimeTaskTerminalAgentModelOverrideSettings | undefined {
	if (!isTerminalAgentModelSelectionAgentId(agentId)) {
		return undefined;
	}
	const rememberedModelId = readRememberedTaskCreateTerminalAgentModelSelection(projectId, agentId);
	if (agentId === "cursor" && rememberedModelId && !isKanbanCursorAgentModelId(rememberedModelId)) {
		return undefined;
	}
	return rememberedModelId ? { agentId, modelId: rememberedModelId } : undefined;
}

function writeRememberedTaskCreateTerminalAgentModelSelection(
	projectId: string | null,
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
	modelId: string,
): void {
	const currentSelections =
		readEffectiveUserInterfacePreferenceValue("taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey") ?? {};
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins({
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {
			...currentSelections,
			[getTaskCreateTerminalAgentModelSelectionStorageKey(projectId, agentId)]: modelId.trim(),
		},
	});
}

function readMostRecentlyUsedTaskCreateBaseRefForProject(projectId: string): string | null {
	return (
		readEffectiveUserInterfacePreferenceValue("mostRecentlyUsedTaskCreateBaseRefByProjectId")?.[projectId] ?? null
	);
}

/**
 * 记住「这个项目上次建卡用的是哪条 base ref」。
 *
 * 只在**建卡成功**后调用，不在下拉框 change 时调用：点开对话框翻了翻分支又放弃，不该改掉项目默认值。
 *
 * projectId 为空（首屏还没解析出当前项目）时**什么都不写**。退而求其次塞进一个 "global" 桶会让下一个
 * 打开的项目读到别人仓库的分支名——那比不记更糟，而且失效分支的回落会把这类污染掩盖掉。
 */
function writeMostRecentlyUsedTaskCreateBaseRefForProject(projectId: string | null, baseRef: string): void {
	const trimmedBaseRef = baseRef.trim();
	if (!projectId || !trimmedBaseRef) {
		return;
	}
	const currentBaseRefsByProjectId =
		readEffectiveUserInterfacePreferenceValue("mostRecentlyUsedTaskCreateBaseRefByProjectId") ?? {};
	if (currentBaseRefsByProjectId[projectId] === trimmedBaseRef) {
		return;
	}
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins({
		mostRecentlyUsedTaskCreateBaseRefByProjectId: {
			...currentBaseRefsByProjectId,
			[projectId]: trimmedBaseRef,
		},
	});
}

function isSameTerminalAgentModelOverrideSettings(
	left: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
	right: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
): boolean {
	return (left?.agentId ?? null) === (right?.agentId ?? null) && (left?.modelId ?? null) === (right?.modelId ?? null);
}

interface TaskCreateTerminalAgentModelOverrideSettingsChangeOptions {
	rememberSelectionForFutureCreateTasks?: boolean;
}

type SetTaskCreateTerminalAgentModelOverrideSettings = (
	value:
		| RuntimeTaskTerminalAgentModelOverrideSettings
		| undefined
		| ((
				current: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
		  ) => RuntimeTaskTerminalAgentModelOverrideSettings | undefined),
	options?: TaskCreateTerminalAgentModelOverrideSettingsChangeOptions,
) => void;

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	editTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	defaultCreateTaskBranchRef: string;
	currentProjectId: string | null;
	selectedAgentId: RuntimeAgentId | null;
	newTaskStartInPlanModeByDefault: boolean;
	isNewTaskStartInPlanModeDefaultLoaded: boolean;
	// 全局「omp 新任务默认通道」。建卡时随草稿一起下沉，由域层固化到卡上（只对可切换 agent 落值）。
	// 详情页的通道开关改的是**已存在的会话**，与本值无关。
	ompAgentSessionTransportForNewTasks: RuntimeAgentSessionTransport;
	newTaskAgentPermissionModeByDefault: RuntimeTaskAgentPermissionMode;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string, expectedTaskIncarnationCreatedAtEpochMs?: number) => void;
	// Board Scope 往其他项目建卡后（不切项目）：由宿主提示「建到了哪个项目」。
	onTaskCardsCreatedInOtherProject?: (workspaceId: string, createdTaskCardCount: number) => void;
	// 「建卡、启动并打开」的目标在其他项目时，启动成功后跨项目打开它。
	openTaskInOtherProjectAfterStart?: (workspaceId: string, taskId: string) => void;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

/** 这次把编辑表单铺成现在这样的那份「种子」：用的是哪份草稿（null = 任务本体），铺进去的是哪些值。 */
interface EditTaskFormSeed {
	savedDraftSavedAt: number | null;
	formValues: TaskEditDraftFormValues;
}

/**
 * 编辑草稿写盘的去抖窗口。草稿是崩溃恢复用的兜底副本，不需要与击键同频落盘；
 * 真正的提交路径不经过它（见 {@link TaskEditorSubmitOptions.promptOverride}）。
 */
const TASK_EDIT_DRAFT_PERSIST_DEBOUNCE_MS = 400;

async function backfillSuggestedTaskTitleWithRuntimeCompareAndSet(
	workspaceId: string,
	taskId: string,
	prompt: string,
	priorTitle: string,
): Promise<void> {
	try {
		// 在第一个 await 前捕获落盘请求；成功后登记会移除，但这次回填仍须等待该请求。
		const [suggestion, persistenceOutcome] = await Promise.all([
			suggestTaskNamesFromTaskDescription(prompt),
			waitForAlreadyRequestedNewTaskCardRuntimePersistenceWithoutRetrying({ workspaceId, taskId }),
		]);
		if (!persistenceOutcome.ok) return;
		const title = suggestion.status === "suggested" ? suggestion.suggestedTaskNames[0] : undefined;
		if (!title) return;
		// 后台回填由服务端 CAS 保护，不占交互命令锁，否则会丢回填或反向拒绝正常启动。
		await updateTaskCardFieldValuesInWorkspace(workspaceId, {
			taskId,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: { title },
			},
			expectedTaskTitleAndPromptForAiNameBackfill: { title: priorTitle, prompt },
		});
	} catch {
		/* 起名失败保留描述推导名称。 */
	}
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskImages: TaskImage[];
	setNewTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	newTaskStartInPlanMode: boolean;
	setNewTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	newTaskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	setNewTaskAgentPermissionMode: Dispatch<SetStateAction<RuntimeTaskAgentPermissionMode>>;
	newTaskConversationMode: RuntimeTaskConversationMode;
	setNewTaskConversationMode: Dispatch<SetStateAction<RuntimeTaskConversationMode>>;
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isNewTaskStartInPlanModeDisabled: boolean;
	newTaskBranchRef: string;
	setNewTaskBranchRef: Dispatch<SetStateAction<string>>;
	newTaskWorktreeMode: RuntimeTaskWorktreeMode;
	setNewTaskWorktreeMode: Dispatch<SetStateAction<RuntimeTaskWorktreeMode>>;
	newTaskAgentId: RuntimeAgentId | undefined;
	setNewTaskAgentId: Dispatch<SetStateAction<RuntimeAgentId | undefined>>;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setNewTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	newTaskTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	setNewTaskTerminalAgentModelOverrideSettings: SetTaskCreateTerminalAgentModelOverrideSettings;
	newTaskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
	setNewTaskAgentSessionInitialization: Dispatch<SetStateAction<RuntimeTaskAgentSessionInitialization | undefined>>;
	editingTaskId: string | null;
	editTaskName: string;
	setEditTaskName: Dispatch<SetStateAction<string>>;
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskImages: TaskImage[];
	setEditTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	setEditTaskAgentPermissionMode: Dispatch<SetStateAction<RuntimeTaskAgentPermissionMode>>;
	editTaskConversationMode: RuntimeTaskConversationMode;
	setEditTaskConversationMode: Dispatch<SetStateAction<RuntimeTaskConversationMode>>;
	editTaskAutoReviewEnabled: boolean;
	setEditTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewMode: TaskAutoReviewMode;
	setEditTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	isEditTaskStartInPlanModeDisabled: boolean;
	editTaskBranchRef: string;
	setEditTaskBranchRef: Dispatch<SetStateAction<string>>;
	editTaskWorktreeMode: RuntimeTaskWorktreeMode;
	setEditTaskWorktreeMode: Dispatch<SetStateAction<RuntimeTaskWorktreeMode>>;
	editTaskAgentId: RuntimeAgentId | undefined;
	setEditTaskAgentId: Dispatch<SetStateAction<RuntimeAgentId | undefined>>;
	editTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setEditTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	editTaskTerminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined;
	setEditTaskTerminalAgentModelOverrideSettings: Dispatch<
		SetStateAction<RuntimeTaskTerminalAgentModelOverrideSettings | undefined>
	>;
	editTaskAgentSessionInitialization: RuntimeTaskAgentSessionInitialization | undefined;
	setEditTaskAgentSessionInitialization: Dispatch<SetStateAction<RuntimeTaskAgentSessionInitialization | undefined>>;
	handleOpenCreateTask: () => void;
	handleCancelCreateTask: () => void;
	// 值 = 铺表单用的那份草稿的 savedAt；null = 表单就是任务本体。
	editTaskFormSeededFromSavedDraftAt: number | null;
	handleRevertEditTaskFormToSavedTaskContent: () => void;
	handleAdoptPromotedTaskEditDraft: (promotedDraft: TaskEditDraft) => void;
	handleOpenEditTask: (task: BoardCard, options?: OpenEditTaskOptions) => void;
	// All projects 面板里点其他项目的 backlog 行：原地编辑那个项目的卡（卡片快照由调用方从服务端读来）。
	handleOpenEditTaskCardInOtherProject: (workspaceId: string, task: BoardCard) => void;
	// 正在编辑的卡所在项目（编辑对话框的 @file 搜索、分支列表、会话起步列表都按它取）；没在编辑时是当前项目。
	editTaskWorkspaceId: string | null;
	// 编辑对话框的分支选项：当前项目即调用方传入的 editTaskBranchOptions；其他项目按那个项目的分支列表。
	editTaskBranchOptionsForEditTarget: Array<{ value: string; label: string }>;
	// —— Board Scope 建卡（Task Creation Target Project）——
	// 建卡框作用的项目：Board Scope 里钉住的目标，否则当前项目。
	taskCreationTargetWorkspaceId: string | null;
	// 非 null = 目标是其他项目（卡不进本页 board；Create & Start 走下面三个 *InOtherProject 入口）。
	taskCreationTargetOtherProjectWorkspaceId: string | null;
	handleOpenCreateTaskInBoardScope: (defaultTargetWorkspaceId: string) => void;
	handleSelectTaskCreationTargetProject: (targetWorkspaceId: string) => void;
	createTaskBranchOptionsForCreationTarget: Array<{ value: string; label: string }>;
	resolvedDefaultCreateTaskBranchRefForCreationTarget: string;
	rememberedTaskCreateBaseRefForCreationTargetOtherProject: string | null;
	repositoryDefaultBranchRefOfCreationTargetOtherProject: string | null;
	handleCreateAndStartTaskInOtherProject: (options?: TaskEditorSubmitOptions) => string | null;
	handleCreateAndStartTasksInOtherProject: (prompts: string[], options?: TaskEditorSubmitOptions) => string[];
	handleCreateStartAndOpenTaskInOtherProject: (options?: TaskEditorSubmitOptions) => string | null;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: (options?: TaskEditorSubmitOptions) => string | null;
	handleSaveAndStartEditedTask: (options?: TaskEditorSubmitOptions) => void;
	handleSaveTaskTitle: (taskId: string, title: string) => void;
	handleCreateTask: (options?: TaskEditorSubmitOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: TaskEditorSubmitOptions) => string[];
	resetTaskEditorState: () => void;
}

export function useTaskEditor({
	board,
	setBoard,
	createTaskBranchOptions,
	editTaskBranchOptions,
	defaultTaskBranchRef,
	defaultCreateTaskBranchRef,
	currentProjectId,
	selectedAgentId,
	newTaskStartInPlanModeByDefault,
	isNewTaskStartInPlanModeDefaultLoaded,
	ompAgentSessionTransportForNewTasks,
	newTaskAgentPermissionModeByDefault,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
	onTaskCardsCreatedInOtherProject,
	openTaskInOtherProjectAfterStart,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useState(newTaskStartInPlanModeByDefault);
	const [newTaskAgentPermissionMode, setNewTaskAgentPermissionMode] = useState<RuntimeTaskAgentPermissionMode>(
		newTaskAgentPermissionModeByDefault,
	);
	const [newTaskConversationMode, setNewTaskConversationMode] = useState<RuntimeTaskConversationMode>("operational");
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useNewTaskAutoReviewEnabledPreference();
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useNewTaskAutoReviewModePreference();
	const isNewTaskStartInPlanModeDisabled = false;
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [newTaskWorktreeMode, setNewTaskWorktreeMode] = useState<RuntimeTaskWorktreeMode>("branch");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	// 这次打开编辑对话框时，表单是不是被草稿铺过（值 = 那份草稿的 savedAt）。通知栏的文案与
	//「改回已保存内容」按钮都挂在它上面；null = 表单就是任务本体，通知栏那一条不出现。
	const [editTaskFormSeededFromSavedDraftAt, setEditTaskFormSeededFromSavedDraftAt] = useState<number | null>(null);
	const [editTaskName, setEditTaskName] = useState("");
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAgentPermissionMode, setEditTaskAgentPermissionMode] = useState<RuntimeTaskAgentPermissionMode>(
		DEFAULT_TASK_AGENT_PERMISSION_MODE,
	);
	const [editTaskConversationMode, setEditTaskConversationMode] = useState<RuntimeTaskConversationMode>("operational");
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const isEditTaskStartInPlanModeDisabled = false;
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");
	const [editTaskWorktreeMode, setEditTaskWorktreeMode] = useState<RuntimeTaskWorktreeMode>("branch");

	const [newTaskAgentId, setNewTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [newTaskClineSettings, setNewTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);
	const [newTaskTerminalAgentModelOverrideSettings, setNewTaskTerminalAgentModelOverrideSettings] = useState<
		RuntimeTaskTerminalAgentModelOverrideSettings | undefined
	>(undefined);
	const [newTaskAgentSessionInitialization, setNewTaskAgentSessionInitialization] = useState<
		RuntimeTaskAgentSessionInitialization | undefined
	>(undefined);
	const [editTaskAgentId, setEditTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [editTaskClineSettings, setEditTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);
	const [editTaskTerminalAgentModelOverrideSettings, setEditTaskTerminalAgentModelOverrideSettings] = useState<
		RuntimeTaskTerminalAgentModelOverrideSettings | undefined
	>(undefined);
	const [editTaskAgentSessionInitialization, setEditTaskAgentSessionInitialization] = useState<
		RuntimeTaskAgentSessionInitialization | undefined
	>(undefined);

	const resolvedDefaultCreateTaskBranchRef = defaultCreateTaskBranchRef;

	// 正在编辑的卡属于哪个项目。null = 当前项目（卡在本页 board 里，保存带 overlay）；非 null = 其他项目（All projects
	// 面板里点 backlog 行原地编辑）：卡片快照在打开时从服务端读来，草稿按那个项目记，保存走同一个 taskCardAction 命令、
	// 不带 overlay（那个项目的 board 不在浏览器里）。ref 与 state 同步写：打开时紧接着就要按它查卡、铺表单。
	const [editingTaskCardInOtherProject, setEditingTaskCardInOtherProjectState] = useState<{
		workspaceId: string;
		taskCard: BoardCard;
	} | null>(null);
	const editingTaskCardInOtherProjectRef = useRef(editingTaskCardInOtherProject);
	const setEditingTaskCardInOtherProject = useCallback(
		(nextEditingTaskCardInOtherProject: { workspaceId: string; taskCard: BoardCard } | null) => {
			editingTaskCardInOtherProjectRef.current = nextEditingTaskCardInOtherProject;
			setEditingTaskCardInOtherProjectState(nextEditingTaskCardInOtherProject);
		},
		[],
	);
	const editTaskWorkspaceId = editingTaskCardInOtherProject?.workspaceId ?? currentProjectId;
	// 编辑其他项目的卡：分支列表与默认 base ref 按那个项目取（只读 workspace.getState，打开时读一次）。
	const { gitRepositoryInfoOfOtherProject: gitRepositoryInfoOfOtherProjectBeingEdited } =
		useGitRepositoryInfoOfOtherProjectForTaskEditorDialog(editingTaskCardInOtherProject?.workspaceId ?? null);
	const editTaskBranchOptionsForEditTarget = useMemo(() => {
		if (!editingTaskCardInOtherProject) {
			return editTaskBranchOptions;
		}
		const otherProjectTaskBranchOptions = buildTaskBranchOptions(gitRepositoryInfoOfOtherProjectBeingEdited);
		// 分支列表还没读到（或读失败）时至少保留卡上现有的 base ref，免得下方的校验 effect 把它重置掉。
		const baseRefOnTaskCard = editingTaskCardInOtherProject.taskCard.baseRef;
		return !baseRefOnTaskCard || otherProjectTaskBranchOptions.some((option) => option.value === baseRefOnTaskCard)
			? otherProjectTaskBranchOptions
			: [{ value: baseRefOnTaskCard, label: baseRefOnTaskCard }, ...otherProjectTaskBranchOptions];
	}, [editTaskBranchOptions, editingTaskCardInOtherProject, gitRepositoryInfoOfOtherProjectBeingEdited]);
	// 建卡路径的默认 base ref 恒按当前项目（Board Scope 往别的项目建卡另有 resolvedDefaultCreateTaskBranchRefForCreationTarget）。
	const resolvedDefaultTaskBranchRef = defaultTaskBranchRef;
	const resolvedDefaultEditTaskBranchRefForEditTarget = editingTaskCardInOtherProject
		? (gitRepositoryInfoOfOtherProjectBeingEdited?.defaultBranch ?? editingTaskCardInOtherProject.taskCard.baseRef)
		: defaultTaskBranchRef;

	// Board Scope 建卡的目标项目（Task Creation Target Project，docs/context-board-scope-all-projects-and-single-project-scope.md）。null = 当前项目：
	// 单项目范围的唯一形态，建卡路径与改动前一致（乐观插入本页 board）。Board Scope 打开建卡框时由调用方显式给出目标并钉住，
	// 之后焦点 / 当前项目变化都不改它；目标是其他项目时卡不进本页 board，用那个项目的预分配 id 与同一个 persist 端点直接
	// 落到那个项目。分支选项、默认 base ref、记住的终端模型都跟着目标项目走。
	const [taskCreationTargetWorkspaceIdPinnedInBoardScope, setTaskCreationTargetWorkspaceIdPinnedInBoardScope] =
		useState<string | null>(null);
	const taskCreationTargetWorkspaceId = taskCreationTargetWorkspaceIdPinnedInBoardScope ?? currentProjectId;
	const taskCreationTargetOtherProjectWorkspaceId =
		taskCreationTargetWorkspaceIdPinnedInBoardScope !== null &&
		taskCreationTargetWorkspaceIdPinnedInBoardScope !== currentProjectId
			? taskCreationTargetWorkspaceIdPinnedInBoardScope
			: null;

	// 建卡框里挑的终端模型按**建卡目标项目**记住（单项目范围下目标就是当前项目）：读取侧（打开 / 切换目标、
	// 按目标项目回填的 effect）都按目标项目读，写入若记到当前项目名下，既污染当前项目的偏好、目标项目下次也记不住。
	// 必须声明在 taskCreationTargetWorkspaceId 之后：依赖数组在渲染时求值，提前引用会撞上 const 的暂时性死区。
	const rememberNewTaskTerminalAgentModelOverrideSettings = useCallback(
		(
			nextSettings:
				| RuntimeTaskTerminalAgentModelOverrideSettings
				| undefined
				| ((
						current: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
				  ) => RuntimeTaskTerminalAgentModelOverrideSettings | undefined),
			options?: TaskCreateTerminalAgentModelOverrideSettingsChangeOptions,
		) => {
			setNewTaskTerminalAgentModelOverrideSettings((currentSettings) => {
				const resolvedSettings = typeof nextSettings === "function" ? nextSettings(currentSettings) : nextSettings;
				const effectiveAgentId = resolvedSettings?.agentId ?? newTaskAgentId ?? selectedAgentId;
				if (
					options?.rememberSelectionForFutureCreateTasks !== false &&
					isTerminalAgentModelSelectionAgentId(effectiveAgentId)
				) {
					writeRememberedTaskCreateTerminalAgentModelSelection(
						taskCreationTargetWorkspaceId,
						effectiveAgentId,
						resolvedSettings?.modelId ?? "",
					);
				}
				return resolvedSettings;
			});
		},
		[taskCreationTargetWorkspaceId, newTaskAgentId, selectedAgentId],
	);

	const { gitRepositoryInfoOfOtherProject: gitRepositoryInfoOfTaskCreationTargetOtherProject } =
		useGitRepositoryInfoOfOtherProjectForTaskEditorDialog(taskCreationTargetOtherProjectWorkspaceId);
	const createTaskBranchOptionsForCreationTarget = useMemo(
		() =>
			taskCreationTargetOtherProjectWorkspaceId
				? buildTaskBranchOptions(gitRepositoryInfoOfTaskCreationTargetOtherProject)
				: createTaskBranchOptions,
		[
			createTaskBranchOptions,
			gitRepositoryInfoOfTaskCreationTargetOtherProject,
			taskCreationTargetOtherProjectWorkspaceId,
		],
	);
	const rememberedTaskCreateBaseRefForCreationTargetOtherProject = taskCreationTargetOtherProjectWorkspaceId
		? readMostRecentlyUsedTaskCreateBaseRefForProject(taskCreationTargetOtherProjectWorkspaceId)
		: null;
	const resolvedDefaultCreateTaskBranchRefForCreationTarget = taskCreationTargetOtherProjectWorkspaceId
		? resolveDefaultTaskBranchRef(
				gitRepositoryInfoOfTaskCreationTargetOtherProject,
				createTaskBranchOptionsForCreationTarget,
				rememberedTaskCreateBaseRefForCreationTargetOtherProject,
			)
		: resolvedDefaultCreateTaskBranchRef;

	// 进入（或切换到）一个项目就先把建卡 id 池备上，让第一次建卡不必等 runtime 分配。
	useEffect(() => {
		if (currentProjectId) {
			ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(currentProjectId);
		}
	}, [currentProjectId]);

	useEffect(() => {
		if (isInlineTaskCreateOpen) {
			return;
		}
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
	}, [isInlineTaskCreateOpen, newTaskAgentPermissionModeByDefault, newTaskStartInPlanModeByDefault]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptionsForCreationTarget.some(
			(option) => option.value === newTaskBranchRef,
		);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRefForCreationTarget);
	}, [
		createTaskBranchOptionsForCreationTarget,
		newTaskBranchRef,
		resolvedDefaultCreateTaskBranchRefForCreationTarget,
	]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRefForCreationTarget);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultCreateTaskBranchRefForCreationTarget]);

	useEffect(() => {
		const effectiveAgentId = newTaskAgentId ?? selectedAgentId;
		const nextSettings = resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(
			taskCreationTargetWorkspaceId,
			effectiveAgentId,
		);
		setNewTaskTerminalAgentModelOverrideSettings((currentSettings) =>
			isSameTerminalAgentModelOverrideSettings(currentSettings, nextSettings) ? currentSettings : nextSettings,
		);
	}, [taskCreationTargetWorkspaceId, newTaskAgentId, selectedAgentId]);

	useEffect(() => {
		if (!isNewTaskStartInPlanModeDisabled || !newTaskStartInPlanMode) {
			return;
		}
		setNewTaskStartInPlanMode(false);
	}, [isNewTaskStartInPlanModeDisabled, newTaskStartInPlanMode, setNewTaskStartInPlanMode]);

	useEffect(() => {
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const isCurrentValid = editTaskBranchOptionsForEditTarget.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultEditTaskBranchRefForEditTarget);
	}, [
		editTaskBranchOptionsForEditTarget,
		editTaskBranchRef,
		editingTaskId,
		resolvedDefaultEditTaskBranchRefForEditTarget,
	]);

	// 表单此刻的值，与「这次是用什么铺上去的」。两者都得能在渲染循环之外被读到：重铺的判据挂在草稿
	// store 的订阅回调上，而那是 React 之外的调用；进依赖数组则会让订阅随每一次击键重挂一遍。
	const editTaskFormValues: TaskEditDraftFormValues = {
		taskTitleOverride: editTaskName,
		prompt: editTaskPrompt,
		images: editTaskImages,
		startInPlanMode: editTaskStartInPlanMode,
		taskAgentPermissionMode: editTaskAgentPermissionMode,
		autoReviewEnabled: editTaskAutoReviewEnabled,
		autoReviewMode: editTaskAutoReviewMode,
		branchRef: editTaskBranchRef,
		worktreeMode: editTaskWorktreeMode,
		agentId: editTaskAgentId,
		clineSettings: editTaskClineSettings,
		terminalAgentModelOverrideSettings: editTaskTerminalAgentModelOverrideSettings,
		taskAgentSessionInitialization: editTaskAgentSessionInitialization,
	};
	const editTaskFormValuesRef = useRef(editTaskFormValues);
	editTaskFormValuesRef.current = editTaskFormValues;
	const editTaskFormSeedRef = useRef<EditTaskFormSeed | null>(null);
	// 铺表单那一刻的卡片本体：保存时只发与它不同的字段（见 task-editor-changed-task-card-field-value-patch.ts）。
	const editTaskCardTheFormWasSeededFromRef = useRef<BoardCard | null>(null);

	// `board` 只在这里被当作只读查表用（拿到被编辑卡片以做「草稿是否等于任务本体」的比较）。
	// 放进 deps 会让本 effect 随每一次看板刷新（含 150ms 一拍的 session 广播）重跑一遍，
	// 而它做的是 localStorage 写盘。改走 ref：读到的永远是最新 board，但不参与依赖触发。
	const boardRef = useRef(board);
	boardRef.current = board;

	// 被编辑的卡与它所在的列：当前项目查本页 board；其他项目用打开时读来的快照（只有 backlog 卡能打开编辑器）。
	const findEditingTaskCardWithBoardColumn = useCallback(
		(taskId: string): { card: BoardCard; columnId: BoardColumnId } | null => {
			const taskCardInOtherProject = editingTaskCardInOtherProjectRef.current;
			if (taskCardInOtherProject) {
				return taskCardInOtherProject.taskCard.id === taskId
					? { card: taskCardInOtherProject.taskCard, columnId: "backlog" }
					: null;
			}
			const selection = findCardSelection(boardRef.current, taskId);
			return selection ? { card: selection.card, columnId: selection.column.id } : null;
		},
		[],
	);

	// 被编辑的卡离开 backlog（或已不存在）就关编辑器、清它的草稿。必须按编辑目标判定：其他项目的卡不在本页 board 里，
	// 拿本页 board 查会让编辑框一打开就被关掉，还会按当前项目清掉同号卡的草稿。所以查卡走 findEditingTaskCardWithBoardColumn
	//（其他项目用打开时的快照、列视为 backlog），清草稿按 editTaskWorkspaceId。它读的是 boardRef，`board` 留在依赖里
	// 只为让看板刷新时重新判定。本 effect 必须写在 findEditingTaskCardWithBoardColumn 声明之后：依赖数组在渲染时求值，
	// 写在前面会撞 const 暂时性死区。
	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findEditingTaskCardWithBoardColumn(editingTaskId);
		if (!selection || selection.columnId !== "backlog") {
			setEditingTaskId(null);
			setEditingTaskCardInOtherProject(null);

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
			setEditTaskConversationMode("operational");
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
			setEditTaskWorktreeMode("branch");
			setEditTaskAgentId(undefined);
			setEditTaskClineSettings(undefined);
			setEditTaskAgentSessionInitialization(undefined);
			clearTaskEditDraft(editTaskWorkspaceId, editingTaskId);
		}
	}, [
		board,
		editTaskWorkspaceId,
		editingTaskId,
		findEditingTaskCardWithBoardColumn,
		setEditingTaskCardInOtherProject,
	]);

	// 去抖写盘：草稿只是崩溃恢复用的兜底副本，不需要与每一次击键同频落盘。
	// 注意这是整条链路上**唯一**一处去抖——`TaskEditorDialog` 的上抛是事件驱动
	// （失焦 / 关闭 / 提交 / 长时间停顿），不是第二层去抖，因此不存在「两级去抖串联导致
	// 同步 flush 读到过期 state」的问题；提交路径另有 `promptOverride` 显式交接。
	useDebouncedEffect(
		() => {
			if (!editingTaskId) {
				return;
			}
			const selection = findEditingTaskCardWithBoardColumn(editingTaskId);
			if (!selection || selection.columnId !== "backlog") {
				return;
			}
			const draft = {
				taskId: editingTaskId,
				taskTitleOverride: editTaskName,
				prompt: editTaskPrompt,
				// 图片可能是几 MB 的 dataURL，深拷贝要等到确定「真的要写盘」之后再做。
				images: editTaskImages,
				startInPlanMode: editTaskStartInPlanMode,
				taskAgentPermissionMode: editTaskAgentPermissionMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				branchRef: editTaskBranchRef || resolvedDefaultEditTaskBranchRefForEditTarget,
				worktreeMode: editTaskWorktreeMode,
				agentId: editTaskAgentId,
				clineSettings: editTaskClineSettings,
				terminalAgentModelOverrideSettings: editTaskTerminalAgentModelOverrideSettings,
				taskAgentSessionInitialization: editTaskAgentSessionInitialization,
			};
			if (isTaskEditDraftEqualToTask(draft, selection.card)) {
				clearTaskEditDraft(editTaskWorkspaceId, editingTaskId);
				return;
			}
			saveTaskEditDraft(editTaskWorkspaceId, {
				...draft,
				images: draft.images.map((image) => ({ ...image })),
				savedAt: Date.now(),
			});
		},
		TASK_EDIT_DRAFT_PERSIST_DEBOUNCE_MS,
		[
			editTaskWorkspaceId,
			findEditingTaskCardWithBoardColumn,
			editTaskAgentId,
			editTaskAgentPermissionMode,
			editTaskAutoReviewEnabled,
			editTaskAutoReviewMode,
			editTaskBranchRef,
			editTaskClineSettings,
			editTaskTerminalAgentModelOverrideSettings,
			editTaskAgentSessionInitialization,
			editTaskImages,
			editTaskName,
			editTaskPrompt,
			editTaskStartInPlanMode,
			editTaskWorktreeMode,
			editingTaskId,
			resolvedDefaultEditTaskBranchRefForEditTarget,
		],
	);

	const handleOpenCreateTask = useCallback(() => {
		if (!isNewTaskStartInPlanModeDefaultLoaded) {
			return;
		}
		if (currentProjectId) {
			// 之前的分配若因 runtime 暂时不在而失败，打开建卡框时再补一次，填完内容时 id 通常已就绪。
			ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(currentProjectId);
		}
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskImages([]);

		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskTerminalAgentModelOverrideSettings(
			resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(currentProjectId, selectedAgentId),
		);
		setNewTaskAgentSessionInitialization(undefined);
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
		setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
		setIsInlineTaskCreateOpen(true);
	}, [
		currentProjectId,
		isNewTaskStartInPlanModeDefaultLoaded,
		newTaskAgentPermissionModeByDefault,
		newTaskStartInPlanModeByDefault,
		resolvedDefaultCreateTaskBranchRef,
		selectedAgentId,
	]);

	// 钉住建卡目标，并把只对某个项目成立的字段换成目标项目的：base ref（目标项目上次所用，没有就等分支列表到了由
	// 上方校验 effect 补默认）、记住的终端模型、「从已有会话起步」（会话列表按项目）。
	const pinTaskCreationTargetProject = useCallback(
		(targetWorkspaceId: string) => {
			setTaskCreationTargetWorkspaceIdPinnedInBoardScope(targetWorkspaceId);
			ensureRuntimeAllocatedTaskIdPrefetchPoolFilled(targetWorkspaceId);
			setNewTaskBranchRef(
				targetWorkspaceId === currentProjectId
					? resolvedDefaultCreateTaskBranchRef
					: (readMostRecentlyUsedTaskCreateBaseRefForProject(targetWorkspaceId) ?? ""),
			);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(targetWorkspaceId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
		},
		[currentProjectId, resolvedDefaultCreateTaskBranchRef, selectedAgentId],
	);

	// Board Scope 的建卡入口（热键 c、跨项目面板与 All projects 首页的 Create task）：对话框带目标项目字段，
	// 默认目标由调用方按入口上下文给出。
	const handleOpenCreateTaskInBoardScope = useCallback(
		(defaultTargetWorkspaceId: string) => {
			if (!isNewTaskStartInPlanModeDefaultLoaded) {
				return;
			}
			handleOpenCreateTask();
			pinTaskCreationTargetProject(defaultTargetWorkspaceId);
		},
		[handleOpenCreateTask, isNewTaskStartInPlanModeDefaultLoaded, pinTaskCreationTargetProject],
	);

	const handleCancelCreateTask = useCallback(() => {
		setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
		setIsInlineTaskCreateOpen(false);

		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
		setNewTaskConversationMode("operational");
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
		setNewTaskWorktreeMode("branch");
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskTerminalAgentModelOverrideSettings(undefined);
		setNewTaskAgentSessionInitialization(undefined);
	}, [newTaskAgentPermissionModeByDefault, newTaskStartInPlanModeByDefault, resolvedDefaultCreateTaskBranchRef]);

	// 把编辑表单铺成「任务本体 + 可选的草稿覆盖」。打开对话框与通知栏的「改回任务已保存的内容」共用
	// 这一段：两处各写一份的话，将来给任务多加一个字段就只会在其中一处被想起，而漏掉的那处会让用户点完
	// 「改回已保存内容」之后某个字段仍旧停在草稿里的值——一个没人会去核对的静默错位。
	const resolveEditTaskFormValuesFromTask = useCallback(
		(task: BoardCard, savedDraft: TaskEditDraft | null): TaskEditDraftFormValues => ({
			taskTitleOverride: savedDraft?.taskTitleOverride ?? task.title,
			prompt: savedDraft?.prompt ?? task.prompt.trim(),
			images: savedDraft
				? savedDraft.images.map((image) => ({ ...image }))
				: task.images
					? task.images.map((image) => ({ ...image }))
					: [],
			startInPlanMode: savedDraft?.startInPlanMode ?? task.startInPlanMode,
			taskAgentPermissionMode:
				savedDraft?.taskAgentPermissionMode ?? task.taskAgentPermissionMode ?? newTaskAgentPermissionModeByDefault,
			autoReviewEnabled: savedDraft?.autoReviewEnabled ?? task.autoReviewEnabled === true,
			autoReviewMode: savedDraft?.autoReviewMode ?? resolveTaskAutoReviewMode(task.autoReviewMode),
			branchRef: savedDraft?.branchRef ?? (task.baseRef || resolvedDefaultEditTaskBranchRefForEditTarget),
			worktreeMode: savedDraft?.worktreeMode ?? task.worktreeMode ?? "branch",
			agentId: savedDraft?.agentId ?? task.agentId,
			clineSettings: savedDraft?.clineSettings ?? task.clineSettings,
			terminalAgentModelOverrideSettings:
				savedDraft?.terminalAgentModelOverrideSettings ?? task.terminalAgentModelOverrideSettings,
			taskAgentSessionInitialization:
				savedDraft?.taskAgentSessionInitialization ?? task.taskAgentSessionInitialization,
		}),
		[newTaskAgentPermissionModeByDefault, resolvedDefaultEditTaskBranchRefForEditTarget],
	);

	const applyEditTaskFormValuesFromTask = useCallback(
		(task: BoardCard, savedDraft: TaskEditDraft | null) => {
			const formValues = resolveEditTaskFormValuesFromTask(task, savedDraft);
			// 记下这一铺用的是什么：迟到的服务端快照只有在表单仍与它逐字相等（＝用户还没动过）时才可以重铺。
			editTaskFormSeedRef.current = { savedDraftSavedAt: savedDraft?.savedAt ?? null, formValues };
			editTaskCardTheFormWasSeededFromRef.current = task;
			setEditTaskName(formValues.taskTitleOverride ?? task.title);
			setEditTaskPrompt(formValues.prompt);
			setEditTaskImages(formValues.images);
			setEditTaskStartInPlanMode(formValues.startInPlanMode);
			setEditTaskAgentPermissionMode(formValues.taskAgentPermissionMode ?? newTaskAgentPermissionModeByDefault);
			// 会话模式不在编辑草稿体系里（runtimeTaskEditDraftSchema 尚未携带该字段，web 侧不能
			// 单方面扩——store 校验会把未知字段剥掉），所以恒从卡片本体铺，草稿不参与。
			setEditTaskConversationMode(task.taskConversationMode ?? "operational");
			setEditTaskAutoReviewEnabled(formValues.autoReviewEnabled);
			setEditTaskAutoReviewMode(formValues.autoReviewMode);
			setEditTaskBranchRef(formValues.branchRef);
			setEditTaskWorktreeMode(formValues.worktreeMode ?? "branch");
			setEditTaskAgentId(formValues.agentId);
			setEditTaskClineSettings(formValues.clineSettings);
			setEditTaskTerminalAgentModelOverrideSettings(formValues.terminalAgentModelOverrideSettings);
			setEditTaskAgentSessionInitialization(formValues.taskAgentSessionInitialization);
		},
		[newTaskAgentPermissionModeByDefault, resolveEditTaskFormValuesFromTask],
	);

	/**
	 * 打开编辑对话框时表单是**同步**铺的（见 handleOpenEditTask：慢一帧就会先闪一个空表单）。那一刻服务端
	 * 草稿快照往往还没到，铺上去的是本地镜像里那份——它可能已经在服务端合并里落败、或者服务端上根本另有
	 * 一份更新的。快照到达后必须重铺一次：不重铺的话，上面那条去抖自动保存会把落败内容当成用户此刻的意图
	 * 写回「当前草稿」，而 `save_task_edit_draft` 是直接覆盖、**不**产生落败副本——胜出那份就此静默消失，
	 * 正是「草稿绝不静默丢」要防的事。表单铺的是任务本体、服务端其实有草稿时更糟：去抖那一拍会判定
	 * 「表单等于任务本体」并发出 clear，把服务端那份直接删掉。
	 *
	 * 两条闸门：只在用户还没动过表单时重铺（他敲下的字永远优先），且每次打开最多重铺一次——无上限地
	 * 跟随服务端快照会与自己的去抖保存互相触发，转成一个每 400ms 保存一次的死循环。
	 */
	const isEditTaskFormAwaitingServerDraftSnapshotRebaseRef = useRef(false);

	useEffect(() => {
		if (!editTaskWorkspaceId || !editingTaskId) {
			return;
		}
		const rebaseEditTaskFormOnServerDraftSnapshot = (): void => {
			if (!isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current) {
				return;
			}
			if (!hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror(editTaskWorkspaceId)) {
				return;
			}
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
			const seed = editTaskFormSeedRef.current;
			const selection = findEditingTaskCardWithBoardColumn(editingTaskId);
			if (!seed || !selection) {
				return;
			}
			const authoritativeDraft = readSavedTaskEditDraft(editTaskWorkspaceId, editingTaskId);
			if ((authoritativeDraft?.savedAt ?? null) === seed.savedDraftSavedAt) {
				return;
			}
			if (!areTaskEditDraftFormValuesEqual(editTaskFormValuesRef.current, seed.formValues)) {
				return;
			}
			setEditTaskFormSeededFromSavedDraftAt(authoritativeDraft?.savedAt ?? null);
			applyEditTaskFormValuesFromTask(selection.card, authoritativeDraft);
		};
		// 快照可能在这条 effect 挂上之前就到了，所以先自查一次，再挂订阅等后到的那一份。
		rebaseEditTaskFormOnServerDraftSnapshot();
		return subscribeToTaskEditDraftStore(rebaseEditTaskFormOnServerDraftSnapshot);
	}, [applyEditTaskFormValuesFromTask, editTaskWorkspaceId, editingTaskId, findEditingTaskCardWithBoardColumn]);

	// 当前项目与其他项目共用的那一段：按卡所在项目读草稿、铺表单。
	const openEditTaskFormForTaskCardInWorkspace = useCallback(
		(workspaceId: string | null, task: BoardCard) => {
			setIsInlineTaskCreateOpen(false);

			setNewTaskPrompt("");
			setNewTaskImages([]);
			const savedDraft = readSavedTaskEditDraft(workspaceId, task.id);
			// 这一读顺带把服务端快照的后台载入踢了起来；此刻它还没到的话，表单铺的就只是本地镜像，
			// 得等快照落定后重铺（见上面的 rebaseEditTaskFormOnServerDraftSnapshot）。
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current =
				workspaceId !== null &&
				!hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror(workspaceId);
			setEditingTaskId(task.id);
			// 「这次打开用的是草稿」**必须**说出来。在此之前它完全静默：用户看到的是草稿，却以为看到的是
			// 任务本体，界面上没有任何提示、也没有改回去的退路。记下的是草稿自己的 savedAt 而不是一个
			// 布尔——「保存于 <相对时间>」是这条提示的全部信息量，没有它用户无从判断该不该采信眼前这份。
			setEditTaskFormSeededFromSavedDraftAt(savedDraft?.savedAt ?? null);
			applyEditTaskFormValuesFromTask(task, savedDraft);
		},
		[applyEditTaskFormValuesFromTask],
	);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setEditingTaskCardInOtherProject(null);
			openEditTaskFormForTaskCardInWorkspace(currentProjectId, task);
		},
		[currentProjectId, openEditTaskFormForTaskCardInWorkspace, setEditingTaskCardInOtherProject, setSelectedTaskId],
	);

	// All projects 面板里点其他项目的 backlog 行：不切项目、不动 Focus View 的焦点任务，原地打开编辑对话框。
	// 卡片快照由调用方从服务端读来（taskCardAction.readTaskCardWithBoardColumn）。
	const handleOpenEditTaskCardInOtherProject = useCallback(
		(workspaceId: string, task: BoardCard) => {
			if (workspaceId === currentProjectId) {
				setEditingTaskCardInOtherProject(null);
				openEditTaskFormForTaskCardInWorkspace(currentProjectId, task);
				return;
			}
			setEditingTaskCardInOtherProject({ workspaceId, taskCard: task });
			openEditTaskFormForTaskCardInWorkspace(workspaceId, task);
		},
		[currentProjectId, openEditTaskFormForTaskCardInWorkspace, setEditingTaskCardInOtherProject],
	);

	/**
	 * 通知栏的「改回任务已保存的内容」：丢掉这份草稿，把表单重置成任务本体。
	 *
	 * 这是草稿静默套用的**退路**。没有它，用户发现表单里是草稿之后只能一个字段一个字段地手动改回去——
	 * 而他恰恰无从知道任务本体原本长什么样。
	 */
	const handleRevertEditTaskFormToSavedTaskContent = useCallback(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findEditingTaskCardWithBoardColumn(editingTaskId);
		if (!selection) {
			return;
		}
		clearTaskEditDraft(editTaskWorkspaceId, editingTaskId);
		// 用户已经明确表态要任务本体。此后再让迟到的快照把某份草稿重铺回来，等于当场推翻他刚点的这一下。
		isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
		setEditTaskFormSeededFromSavedDraftAt(null);
		applyEditTaskFormValuesFromTask(selection.card, null);
	}, [applyEditTaskFormValuesFromTask, editTaskWorkspaceId, editingTaskId, findEditingTaskCardWithBoardColumn]);

	/**
	 * 通知栏的「用这份替换当前」落定之后，把表单重铺成被提升上来的那份草稿。
	 *
	 * 复用 applyEditTaskFormValuesFromTask（任务本体打底 + 草稿覆盖），与打开对话框走的是同一段：
	 * 草稿里那几个可选字段为 undefined 时该回落到任务本体的哪个值，只在那一处定义。
	 */
	const handleAdoptPromotedTaskEditDraft = useCallback(
		(promotedDraft: TaskEditDraft) => {
			const selection = editingTaskId ? findEditingTaskCardWithBoardColumn(editingTaskId) : null;
			if (!selection) {
				return;
			}
			// 同「改回已保存内容」：用户刚显式挑了这一份，迟到的快照不得再把它换掉。
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
			setEditTaskFormSeededFromSavedDraftAt(promotedDraft.savedAt);
			applyEditTaskFormValuesFromTask(selection.card, promotedDraft);
		},
		[applyEditTaskFormValuesFromTask, editingTaskId, findEditingTaskCardWithBoardColumn],
	);

	const handleCancelEditTask = useCallback(() => {
		if (editingTaskId) {
			clearTaskEditDraft(editTaskWorkspaceId, editingTaskId);
		}
		setEditingTaskId(null);
		setEditingTaskCardInOtherProject(null);
		setEditTaskFormSeededFromSavedDraftAt(null);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
		setEditTaskConversationMode("operational");
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskWorktreeMode("branch");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskTerminalAgentModelOverrideSettings(undefined);
		setEditTaskAgentSessionInitialization(undefined);
	}, [editTaskWorkspaceId, editingTaskId, setEditingTaskCardInOtherProject]);

	// 编辑器保存走 taskCardAction（与行内改名、CLI `task update` 同一个服务端实现），只发改过的字段。对话框立即
	// 关闭、overlay 让卡片立刻显示新值；命令没成功时把这次提交的内容存回草稿并提示，重新打开编辑器就能找回
	//（草稿绝不静默丢）。返回的 promise 在服务端写下（或无需写）时为 true，供 Save & Start 等它再启动。
	const saveEditedTaskThroughRuntime = useCallback(
		(
			options?: TaskEditorSubmitOptions,
		): {
			savedTaskId: string;
			expectedTaskIncarnationCreatedAtEpochMs: number | undefined;
			// 非 null = 卡在其他项目（Save & Start 直接对那个项目发启动命令，不走当前项目的启动队列）。
			savedTaskCardOtherProjectWorkspaceId: string | null;
			editedTaskCardFieldsSavedByRuntime: Promise<boolean>;
		} | null => {
			if (!editingTaskId || !editTaskWorkspaceId) {
				return null;
			}
			const prompt = (options?.promptOverride ?? editTaskPrompt).trim();
			if (!prompt) {
				return null;
			}
			if (!(editTaskBranchRef || resolvedDefaultEditTaskBranchRefForEditTarget)) {
				return null;
			}

			const workspaceId = editTaskWorkspaceId;
			// 其他项目的 board 不在浏览器里：不叠 overlay，结果随广播回来。
			const isEditedTaskCardInOtherProject = editingTaskCardInOtherProjectRef.current !== null;
			const savedTaskId = editingTaskId;
			const submitted: TaskEditorSubmittedTaskCardFieldValues = {
				taskTitleOverride: options?.taskNameOverride ?? editTaskName,
				prompt,
				images: editTaskImages,
				startInPlanMode: editTaskStartInPlanMode,
				taskAgentPermissionMode: editTaskAgentPermissionMode,
				taskConversationMode: editTaskConversationMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				baseRef: editTaskBranchRef || resolvedDefaultEditTaskBranchRefForEditTarget,
				worktreeMode: editTaskWorktreeMode,
				agentId: editTaskAgentId,
				clineSettings: editTaskClineSettings,
				terminalAgentModelOverrideSettings: editTaskTerminalAgentModelOverrideSettings,
				taskAgentSessionInitialization: editTaskAgentSessionInitialization,
			};
			const taskCardTheFormWasSeededFrom =
				editTaskCardTheFormWasSeededFromRef.current?.id === savedTaskId
					? editTaskCardTheFormWasSeededFromRef.current
					: findEditingTaskCardWithBoardColumn(savedTaskId)?.card;
			clearTaskEditDraft(workspaceId, savedTaskId);

			const keepSubmittedEditsAsTaskEditDraft = (): void => {
				saveTaskEditDraft(workspaceId, {
					taskId: savedTaskId,
					taskTitleOverride: submitted.taskTitleOverride,
					prompt: submitted.prompt,
					images: submitted.images.map((image) => ({ ...image })),
					startInPlanMode: submitted.startInPlanMode,
					taskAgentPermissionMode: submitted.taskAgentPermissionMode,
					autoReviewEnabled: submitted.autoReviewEnabled,
					autoReviewMode: submitted.autoReviewMode,
					branchRef: submitted.baseRef,
					worktreeMode: submitted.worktreeMode,
					agentId: submitted.agentId,
					clineSettings: submitted.clineSettings,
					terminalAgentModelOverrideSettings: submitted.terminalAgentModelOverrideSettings,
					taskAgentSessionInitialization: submitted.taskAgentSessionInitialization,
					savedAt: Date.now(),
				});
			};
			const taskCardFieldValuePatch = taskCardTheFormWasSeededFrom
				? buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(
						taskCardTheFormWasSeededFrom,
						submitted,
					)
				: null;
			let editedTaskCardFieldsSavedByRuntime: Promise<boolean>;
			if (!taskCardFieldValuePatch) {
				// 卡片已不在看板上（编辑期间被删）：没有可保存的对象。
				editedTaskCardFieldsSavedByRuntime = Promise.resolve(false);
			} else if (Object.keys(taskCardFieldValuePatch).length === 0) {
				editedTaskCardFieldsSavedByRuntime = Promise.resolve(true);
			} else {
				editedTaskCardFieldsSavedByRuntime = updateTaskCardFieldValuesThroughRuntime({
					workspaceId,
					taskId: savedTaskId,
					expectedTaskIncarnationCreatedAtEpochMs: taskCardTheFormWasSeededFrom?.createdAt,
					taskCardFieldValuePatch,
					...(isEditedTaskCardInOtherProject
						? {}
						: {
								currentProjectBoardForOptimisticOverlay: boardRef.current,
								optimisticBoardTransformation: (currentBoard: BoardData) =>
									updateTask(currentBoard, savedTaskId, {
										...submitted,
										title:
											taskCardFieldValuePatch.title === undefined
												? (findCardSelection(currentBoard, savedTaskId)?.card.title ?? "")
												: (taskCardFieldValuePatch.title ?? resolveTaskTitle(undefined, submitted.prompt)),
									}),
							}),
				}).then((result) => {
					if (result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime") {
						if (taskCardFieldValuePatch.title === null) {
							void backfillSuggestedTaskTitleWithRuntimeCompareAndSet(
								workspaceId,
								savedTaskId,
								submitted.prompt,
								resolveTaskTitle(undefined, submitted.prompt),
							);
						}
						return true;
					}
					keepSubmittedEditsAsTaskEditDraft();
					notifyError(
						result.taskCardActionCommandExecutionOutcome === "command_failed"
							? `Could not save the task edits: ${result.commandFailureMessage}. Your edits were kept as a draft; reopen the task to retry.`
							: "Another action on this task is still running, so the edits were not saved. Your edits were kept as a draft; reopen the task to retry.",
					);
					return false;
				});
			}
			setEditingTaskId(null);
			setEditingTaskCardInOtherProject(null);

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
			setEditTaskConversationMode("operational");
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
			setEditTaskWorktreeMode("branch");
			setEditTaskAgentId(undefined);
			setEditTaskClineSettings(undefined);
			setEditTaskTerminalAgentModelOverrideSettings(undefined);
			setEditTaskAgentSessionInitialization(undefined);
			return {
				savedTaskId,
				expectedTaskIncarnationCreatedAtEpochMs: taskCardTheFormWasSeededFrom?.createdAt,
				savedTaskCardOtherProjectWorkspaceId: isEditedTaskCardInOtherProject ? workspaceId : null,
				editedTaskCardFieldsSavedByRuntime,
			};
		},
		[
			editTaskAgentId,
			editTaskAgentPermissionMode,
			editTaskConversationMode,
			editTaskAutoReviewEnabled,
			editTaskAutoReviewMode,
			editTaskBranchRef,
			editTaskClineSettings,
			editTaskTerminalAgentModelOverrideSettings,
			editTaskAgentSessionInitialization,
			editTaskName,
			editTaskPrompt,
			editTaskImages,
			editTaskStartInPlanMode,
			editTaskWorktreeMode,
			editingTaskId,
			editTaskWorkspaceId,
			findEditingTaskCardWithBoardColumn,
			resolvedDefaultEditTaskBranchRefForEditTarget,
			setEditingTaskCardInOtherProject,
		],
	);

	const handleSaveEditedTask = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => saveEditedTaskThroughRuntime(options)?.savedTaskId ?? null,
		[saveEditedTaskThroughRuntime],
	);

	// Save & Start 等保存命令结算后才启动：服务端启动读的是它自己板上的卡，抢先启动会拿旧 prompt 起会话。
	// 保存没成功就不启动（内容已存回草稿并提示）。当前项目交给 App 的启动队列（要等卡出现在本页 board 里、
	// 走带动画的启动）；其他项目直接对那个项目发启动命令。
	const handleSaveAndStartEditedTask = useCallback(
		(options?: TaskEditorSubmitOptions) => {
			const saved = saveEditedTaskThroughRuntime(options);
			if (!saved) {
				return;
			}
			void saved.editedTaskCardFieldsSavedByRuntime.then((savedByRuntime) => {
				if (!savedByRuntime) {
					return;
				}
				if (saved.savedTaskCardOtherProjectWorkspaceId === null) {
					queueTaskStartAfterEdit?.(saved.savedTaskId, saved.expectedTaskIncarnationCreatedAtEpochMs);
					return;
				}
				void startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
					workspaceId: saved.savedTaskCardOtherProjectWorkspaceId,
					taskId: saved.savedTaskId,
					expectedTaskIncarnationCreatedAtEpochMs: saved.expectedTaskIncarnationCreatedAtEpochMs,
					agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(
						saved.savedTaskId,
					),
				}).then((result) => {
					if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
						notifyError(`Could not start the task: ${result.commandFailureMessage}`);
					}
				});
			});
		},
		[queueTaskStartAfterEdit, saveEditedTaskThroughRuntime],
	);

	// 行内改名走 taskCardAction（主看板与 Focus View 两条宿主链共用）。空标题发 null：服务端由 prompt 派生，与 CLI
	// `task update --title ""` 同语义；overlay 先用浏览器同一个纯函数的推导值，命令回来后换成服务端实际写下的值。
	const handleSaveTaskTitle = useCallback(
		(taskId: string, title: string) => {
			if (!currentProjectId) {
				return;
			}
			void updateTaskCardFieldValuesThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				taskCardFieldValuePatch: { title: title.trim() === "" ? null : title },
				currentProjectBoardForOptimisticOverlay: boardRef.current,
				optimisticBoardTransformation: (currentBoard) => updateTaskTitle(currentBoard, taskId, title),
			}).then((result) => {
				if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
					notifyError(`Could not rename the task: ${result.commandFailureMessage}`);
				}
			});
		},
		[currentProjectId],
	);

	/**
	 * 建卡时名字框留空 → 先按正则推导的标题落卡，再异步向起名端点要一个更好的名字回填。
	 *
	 * 三条刻意的选择：
	 *   - fire-and-forget：起名要往外发一次网络请求，让建卡等它回来会把「点一下就出卡」变成「转两秒」；
	 *   - 失败全静默：标题保持正则推导值，用户什么都不会丢，弹提示只会打断建卡节奏；
	 *   - 服务端同时比对标题与描述：用户手改过、或 agent 已经改过名的卡不该被顶掉。
	 * shortcut: 起名与回填随浏览器页面存活；需要刷新或关闭页面后继续时再移交 runtime。
	 */
	const backfillSuggestedTaskTitleForCreatedTask = useCallback(
		(taskId: string, prompt: string, priorTitle: string) => {
			if (currentProjectId)
				void backfillSuggestedTaskTitleWithRuntimeCompareAndSet(currentProjectId, taskId, prompt, priorTitle);
		},
		[currentProjectId],
	);
	const backfillSuggestedTaskTitleForTaskCardCreatedInOtherProject = useCallback(
		(workspaceId: string, taskId: string, prompt: string, priorTitle: string) => {
			void backfillSuggestedTaskTitleWithRuntimeCompareAndSet(workspaceId, taskId, prompt, priorTitle);
		},
		[],
	);

	// Board Scope 往其他项目建卡：卡片用与本页同一个纯函数（addTaskToColumnWithResult）在空 backlog 上算出，id 取那个项目的
	// 预分配池，经同一个 persist 端点落到那个项目（服务端 board 锁内插卡）。本页 board 不动，结果随 projects 广播出现在
	// All projects 面板里。建好的卡登记下来，Create & Start 要等它落盘确认再启动。
	const taskCardsCreatedInOtherProjectByWorkspaceAndTaskIdRef = useRef(new Map<string, BoardCard>());
	const createBacklogTaskCardsInOtherProject = useCallback(
		(
			workspaceId: string,
			newTaskCards: ReadonlyArray<{ prompt: string; title?: string }>,
			baseRef: string,
		): BoardCard[] | null => {
			const runtimeAllocatedTaskIds = takeRuntimeAllocatedTaskIdsForNewTaskCardsOrExplainWhyTaskCreationIsBlocked(
				workspaceId,
				newTaskCards.length,
			);
			if (!runtimeAllocatedTaskIds) {
				return null;
			}
			let boardHoldingOnlyNewTaskCards: BoardData = { columns: [{ id: "backlog", title: "Backlog", cards: [] }] };
			for (const [newTaskCardIndex, newTaskCard] of newTaskCards.entries()) {
				const runtimeAllocatedTaskId = runtimeAllocatedTaskIds[newTaskCardIndex];
				if (!runtimeAllocatedTaskId) {
					break;
				}
				boardHoldingOnlyNewTaskCards = addTaskToColumnWithResult(
					boardHoldingOnlyNewTaskCards,
					"backlog",
					{
						...(newTaskCard.title !== undefined ? { title: newTaskCard.title } : {}),
						prompt: newTaskCard.prompt,
						startInPlanMode: newTaskStartInPlanMode,
						taskAgentPermissionMode: newTaskAgentPermissionMode,
						taskConversationMode: newTaskConversationMode,
						autoReviewEnabled: newTaskAutoReviewEnabled,
						autoReviewMode: newTaskAutoReviewMode,
						images: newTaskImages,
						agentId: newTaskAgentId,
						workspaceDefaultAgentIdForNewTasks: selectedAgentId ?? undefined,
						ompAgentSessionTransportForNewTasks,
						clineSettings: newTaskClineSettings,
						terminalAgentModelOverrideSettings: newTaskTerminalAgentModelOverrideSettings,
						// 「从已有会话起步」只对单卡有意义（同本页的 handleCreateTasks）。
						...(newTaskCards.length === 1
							? { taskAgentSessionInitialization: newTaskAgentSessionInitialization }
							: {}),
						baseRef,
						worktreeMode: newTaskWorktreeMode,
					},
					runtimeAllocatedTaskId,
				).board;
			}
			// 顺序取 backlog 列自上而下（同本页批量建卡）。
			const createdTaskCards = boardHoldingOnlyNewTaskCards.columns[0]?.cards ?? [];
			beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
				workspaceId,
				newBacklogTaskCardsCreatedFromWebUi: createdTaskCards,
				boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
			});
			for (const createdTaskCard of createdTaskCards) {
				taskCardsCreatedInOtherProjectByWorkspaceAndTaskIdRef.current.set(
					`${workspaceId}\u0000${createdTaskCard.id}`,
					createdTaskCard,
				);
			}
			writeMostRecentlyUsedTaskCreateBaseRefForProject(workspaceId, baseRef);
			onTaskCardsCreatedInOtherProject?.(workspaceId, createdTaskCards.length);
			return createdTaskCards;
		},
		[
			newTaskAgentId,
			newTaskAgentPermissionMode,
			newTaskAgentSessionInitialization,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskClineSettings,
			newTaskConversationMode,
			newTaskImages,
			newTaskStartInPlanMode,
			newTaskTerminalAgentModelOverrideSettings,
			newTaskWorktreeMode,
			ompAgentSessionTransportForNewTasks,
			onTaskCardsCreatedInOtherProject,
			selectedAgentId,
		],
	);

	// 其他项目的新卡：等 runtime 确认落盘后直接对那个项目发启动命令（当前项目的启动队列只认本页 board 里的卡）。
	const startTaskCardsCreatedInOtherProjectAfterRuntimePersistence = useCallback(
		(workspaceId: string, taskIds: readonly string[], options?: { openTaskAfterStart?: boolean }) => {
			for (const taskId of taskIds) {
				const createdTaskCard = taskCardsCreatedInOtherProjectByWorkspaceAndTaskIdRef.current.get(
					`${workspaceId}\u0000${taskId}`,
				);
				if (!createdTaskCard) {
					continue;
				}
				void waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
					workspaceId,
					taskCard: createdTaskCard,
				}).then(async (persisted) => {
					if (!persisted.ok) {
						notifyError(`Could not save the new task card, so its agent was not started: ${persisted.message}`);
						return;
					}
					const result = await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
						workspaceId,
						taskId,
						agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(taskId),
					});
					if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
						notifyError(`Could not start the task: ${result.commandFailureMessage}`);
						return;
					}
					if (options?.openTaskAfterStart) {
						openTaskInOtherProjectAfterStart?.(workspaceId, taskId);
					}
				});
			}
		},
		[openTaskInOtherProjectAfterStart],
	);

	// 往其他项目建卡后的表单复位：与本页建卡同一套规则（见 handleCreateTask 末尾的注释），记住的终端模型按目标项目取；
	// Create more（keepDialogOpen）保留用户选的目标项目。
	const resetNewTaskFormAfterTaskCardsCreatedInOtherProject = useCallback(
		(workspaceId: string, options: TaskEditorSubmitOptions | undefined, baseRef: string) => {
			if (options?.preserveFormUntilCreationConfirmed) return;
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskStartInPlanMode(options?.keepDialogOpen ? newTaskStartInPlanMode : newTaskStartInPlanModeByDefault);
			setNewTaskAgentPermissionMode(
				options?.keepDialogOpen ? newTaskAgentPermissionMode : newTaskAgentPermissionModeByDefault,
			);
			setNewTaskConversationMode(options?.keepDialogOpen ? newTaskConversationMode : "operational");
			setNewTaskBranchRef(baseRef);
			setNewTaskWorktreeMode(options?.keepDialogOpen ? newTaskWorktreeMode : "branch");
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(workspaceId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
			if (!options?.keepDialogOpen) {
				setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
				setIsInlineTaskCreateOpen(false);
			}
		},
		[
			newTaskAgentPermissionMode,
			newTaskAgentPermissionModeByDefault,
			newTaskConversationMode,
			newTaskStartInPlanMode,
			newTaskStartInPlanModeByDefault,
			newTaskWorktreeMode,
			selectedAgentId,
		],
	);

	const handleCreateTask = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			if (!isNewTaskStartInPlanModeDefaultLoaded) {
				return null;
			}
			const prompt = (options?.promptOverride ?? newTaskPrompt).trim();
			if (!prompt) {
				return null;
			}
			const baseRef =
				newTaskBranchRef ||
				(taskCreationTargetOtherProjectWorkspaceId
					? resolvedDefaultCreateTaskBranchRefForCreationTarget
					: resolvedDefaultTaskBranchRef);
			if (!baseRef) {
				return null;
			}
			// 留空与省略同义：两者都走「先推导、再异步回填 AI 名字」。
			const explicitTaskName = options?.taskNameOverride?.trim() ?? "";
			const title = explicitTaskName || deriveTaskTitleFromPrompt(prompt);
			if (taskCreationTargetOtherProjectWorkspaceId) {
				const createdTaskCard = createBacklogTaskCardsInOtherProject(
					taskCreationTargetOtherProjectWorkspaceId,
					[{ prompt, title }],
					baseRef,
				)?.[0];
				if (!createdTaskCard) {
					return null;
				}
				options?.onTaskCardAllocatedForRelationModeling?.(createdTaskCard);
				if (!explicitTaskName) {
					backfillSuggestedTaskTitleForTaskCardCreatedInOtherProject(
						taskCreationTargetOtherProjectWorkspaceId,
						createdTaskCard.id,
						prompt,
						createdTaskCard.title,
					);
				}
				trackTaskCreated({
					selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
					start_in_plan_mode: newTaskStartInPlanMode,
					...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
					prompt_character_count: prompt.length,
				});
				resetNewTaskFormAfterTaskCardsCreatedInOtherProject(
					taskCreationTargetOtherProjectWorkspaceId,
					options,
					baseRef,
				);
				return createdTaskCard.id;
			}
			const runtimeAllocatedTaskIds = takeRuntimeAllocatedTaskIdsForNewTaskCardsOrExplainWhyTaskCreationIsBlocked(
				currentProjectId,
				1,
			);
			const runtimeAllocatedTaskId = runtimeAllocatedTaskIds?.[0];
			if (!runtimeAllocatedTaskId) {
				return null;
			}
			const created = addTaskToColumnWithResult(
				board,
				"backlog",
				{
					title,
					prompt,
					startInPlanMode: newTaskStartInPlanMode,
					taskAgentPermissionMode: newTaskAgentPermissionMode,
					taskConversationMode: newTaskConversationMode,
					autoReviewEnabled: newTaskAutoReviewEnabled,
					autoReviewMode: newTaskAutoReviewMode,
					images: newTaskImages,
					agentId: newTaskAgentId,
					// 用户没在建卡对话框里挑 agent 时 newTaskAgentId 是空的，这张卡会跑工作区默认 agent。
					// 会话通道要不要固化看的正是「实际会跑哪个 agent」，所以工作区默认也得一起下沉到域层。
					workspaceDefaultAgentIdForNewTasks: selectedAgentId ?? undefined,
					ompAgentSessionTransportForNewTasks,
					clineSettings: newTaskClineSettings,
					terminalAgentModelOverrideSettings: newTaskTerminalAgentModelOverrideSettings,
					taskAgentSessionInitialization: newTaskAgentSessionInitialization,
					baseRef,
					worktreeMode: newTaskWorktreeMode,
				},
				runtimeAllocatedTaskId,
			);
			options?.onTaskCardAllocatedForRelationModeling?.(created.task);
			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: board,
				boardAfterMutation: created.board,
				boardMutationInitiator: "web_ui_user_gesture",
			});
			setBoard(created.board);
			// cf427：乐观插入之外立刻让 runtime 落盘，启动 agent 前等它确认（见该登记模块顶部注释）。
			if (currentProjectId) {
				beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
					workspaceId: currentProjectId,
					newBacklogTaskCardsCreatedFromWebUi: [created.task],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				});
			}
			if (!explicitTaskName) {
				backfillSuggestedTaskTitleForCreatedTask(created.task.id, prompt, created.task.title);
			}
			writeMostRecentlyUsedTaskCreateBaseRefForProject(currentProjectId, baseRef);
			trackTaskCreated({
				selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
				start_in_plan_mode: newTaskStartInPlanMode,
				...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
				prompt_character_count: prompt.length,
			});
			if (options?.preserveFormUntilCreationConfirmed) return created.task.id;
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskStartInPlanMode(options?.keepDialogOpen ? newTaskStartInPlanMode : newTaskStartInPlanModeByDefault);
			setNewTaskAgentPermissionMode(
				options?.keepDialogOpen ? newTaskAgentPermissionMode : newTaskAgentPermissionModeByDefault,
			);
			// 会话模式没有全局默认档（恒 operational 缺省），keepDialogOpen 时保留当前选择，
			// 与 worktreeMode 的「连续建同类卡」语义一致。
			setNewTaskConversationMode(options?.keepDialogOpen ? newTaskConversationMode : "operational");
			// 刚用掉的那条 ref 就是这个项目新的默认值（上面已写进记忆），所以两条路径都设回 baseRef。
			// 不能沿用「关掉对话框就复位成 resolvedDefaultCreateTaskBranchRef」：那是闭包里捕获的旧值，
			// 偏好 store 的乐观发布不保证在同一帧内把它重算出来，于是刚记住的选择会闪回旧默认。
			setNewTaskBranchRef(baseRef);
			setNewTaskWorktreeMode(options?.keepDialogOpen ? newTaskWorktreeMode : "branch");
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(currentProjectId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
			if (!options?.keepDialogOpen) {
				setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
				setIsInlineTaskCreateOpen(false);
			}
			return created.task.id;
		},
		[
			backfillSuggestedTaskTitleForCreatedTask,
			backfillSuggestedTaskTitleForTaskCardCreatedInOtherProject,
			createBacklogTaskCardsInOtherProject,
			resetNewTaskFormAfterTaskCardsCreatedInOtherProject,
			resolvedDefaultCreateTaskBranchRefForCreationTarget,
			taskCreationTargetOtherProjectWorkspaceId,
			board,
			isNewTaskStartInPlanModeDefaultLoaded,
			newTaskAgentId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskTerminalAgentModelOverrideSettings,
			newTaskAgentSessionInitialization,
			newTaskImages,
			// 全局默认只在建卡那一刻固化，所以必须进依赖：漏掉它时闭包会一直捕获旧通道，
			// 用户在设置页切换后新建的卡仍被写成切换前的值。
			ompAgentSessionTransportForNewTasks,
			newTaskPrompt,
			newTaskAgentPermissionMode,
			newTaskAgentPermissionModeByDefault,
			newTaskConversationMode,
			newTaskStartInPlanMode,
			newTaskStartInPlanModeByDefault,
			resolvedDefaultTaskBranchRef,
			newTaskWorktreeMode,
			selectedAgentId,
			currentProjectId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: TaskEditorSubmitOptions): string[] => {
			if (!isNewTaskStartInPlanModeDefaultLoaded) {
				return [];
			}
			const validPrompts = prompts.map((p) => p.trim()).filter(Boolean);
			if (validPrompts.length === 0) {
				return [];
			}
			const baseRef =
				newTaskBranchRef ||
				(taskCreationTargetOtherProjectWorkspaceId
					? resolvedDefaultCreateTaskBranchRefForCreationTarget
					: resolvedDefaultTaskBranchRef);
			if (!baseRef) {
				return [];
			}
			if (taskCreationTargetOtherProjectWorkspaceId) {
				const createdTaskCards = createBacklogTaskCardsInOtherProject(
					taskCreationTargetOtherProjectWorkspaceId,
					validPrompts.map((prompt) => ({ prompt })),
					baseRef,
				);
				if (!createdTaskCards) {
					return [];
				}
				for (const prompt of validPrompts) {
					trackTaskCreated({
						selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
						start_in_plan_mode: newTaskStartInPlanMode,
						...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
						prompt_character_count: prompt.length,
					});
				}
				resetNewTaskFormAfterTaskCardsCreatedInOtherProject(
					taskCreationTargetOtherProjectWorkspaceId,
					options,
					baseRef,
				);
				return createdTaskCards.map((createdTaskCard) => createdTaskCard.id);
			}
			const runtimeAllocatedTaskIds = takeRuntimeAllocatedTaskIdsForNewTaskCardsOrExplainWhyTaskCreationIsBlocked(
				currentProjectId,
				validPrompts.length,
			);
			if (!runtimeAllocatedTaskIds) {
				return [];
			}
			const createdTaskIds: string[] = [];
			let updatedBoard = board;
			for (const [promptIndex, prompt] of validPrompts.entries()) {
				const runtimeAllocatedTaskId = runtimeAllocatedTaskIds[promptIndex];
				if (!runtimeAllocatedTaskId) {
					break;
				}
				const created = addTaskToColumnWithResult(
					updatedBoard,
					"backlog",
					{
						prompt,
						startInPlanMode: newTaskStartInPlanMode,
						taskAgentPermissionMode: newTaskAgentPermissionMode,
						taskConversationMode: newTaskConversationMode,
						autoReviewEnabled: newTaskAutoReviewEnabled,
						autoReviewMode: newTaskAutoReviewMode,
						images: newTaskImages,
						agentId: newTaskAgentId,
						// 同 handleCreateTask：agentId 留空的卡片跑的是工作区默认 agent，固化判据要看它。
						workspaceDefaultAgentIdForNewTasks: selectedAgentId ?? undefined,
						ompAgentSessionTransportForNewTasks,
						clineSettings: newTaskClineSettings,
						terminalAgentModelOverrideSettings: newTaskTerminalAgentModelOverrideSettings,
						baseRef,
						worktreeMode: newTaskWorktreeMode,
					},
					runtimeAllocatedTaskId,
				);
				updatedBoard = created.board;
				createdTaskIds.push(created.task.id);
			}
			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: board,
				boardAfterMutation: updatedBoard,
				boardMutationInitiator: "web_ui_user_gesture",
			});
			setBoard(updatedBoard);
			// 同 handleCreateTask：一次请求落盘整批新卡，顺序取本地 backlog 列自上而下的顺序。
			if (currentProjectId && createdTaskIds.length > 0) {
				const createdTaskIdSet = new Set(createdTaskIds);
				beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
					workspaceId: currentProjectId,
					newBacklogTaskCardsCreatedFromWebUi:
						updatedBoard.columns
							.find((column) => column.id === "backlog")
							?.cards.filter((card) => createdTaskIdSet.has(card.id)) ?? [],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				});
			}
			writeMostRecentlyUsedTaskCreateBaseRefForProject(currentProjectId, baseRef);
			for (const prompt of validPrompts) {
				trackTaskCreated({
					selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
					start_in_plan_mode: newTaskStartInPlanMode,
					...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
					prompt_character_count: prompt.length,
				});
			}
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskStartInPlanMode(options?.keepDialogOpen ? newTaskStartInPlanMode : newTaskStartInPlanModeByDefault);
			setNewTaskAgentPermissionMode(
				options?.keepDialogOpen ? newTaskAgentPermissionMode : newTaskAgentPermissionModeByDefault,
			);
			// 会话模式没有全局默认档（恒 operational 缺省），keepDialogOpen 时保留当前选择，
			// 与 worktreeMode 的「连续建同类卡」语义一致。
			setNewTaskConversationMode(options?.keepDialogOpen ? newTaskConversationMode : "operational");
			// 刚用掉的那条 ref 就是这个项目新的默认值（上面已写进记忆），所以两条路径都设回 baseRef。
			// 不能沿用「关掉对话框就复位成 resolvedDefaultCreateTaskBranchRef」：那是闭包里捕获的旧值，
			// 偏好 store 的乐观发布不保证在同一帧内把它重算出来，于是刚记住的选择会闪回旧默认。
			setNewTaskBranchRef(baseRef);
			setNewTaskWorktreeMode(options?.keepDialogOpen ? newTaskWorktreeMode : "branch");
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(currentProjectId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
			if (!options?.keepDialogOpen) {
				setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
			createBacklogTaskCardsInOtherProject,
			resetNewTaskFormAfterTaskCardsCreatedInOtherProject,
			resolvedDefaultCreateTaskBranchRefForCreationTarget,
			taskCreationTargetOtherProjectWorkspaceId,
			board,
			isNewTaskStartInPlanModeDefaultLoaded,
			newTaskAgentId,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskTerminalAgentModelOverrideSettings,
			newTaskImages,
			// 同 handleCreateTask：全局默认只在建卡那一刻固化，漏进依赖会让批量建卡整批写成旧通道。
			ompAgentSessionTransportForNewTasks,
			newTaskAgentPermissionMode,
			newTaskAgentPermissionModeByDefault,
			newTaskConversationMode,
			newTaskStartInPlanMode,
			newTaskStartInPlanModeByDefault,
			resolvedDefaultTaskBranchRef,
			newTaskWorktreeMode,
			selectedAgentId,
			currentProjectId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
		],
	);

	// Board Scope 往其他项目「建卡并启动 / 建卡、启动并打开」：建卡同上，随后等落盘确认、直接对那个项目发启动命令。
	// 目标在建卡前取（建卡会复位表单与钉住的目标）。当前项目的这三条入口仍走 App 的启动队列（use-task-start-actions）。
	const handleCreateAndStartTaskInOtherProject = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			const targetWorkspaceId = taskCreationTargetOtherProjectWorkspaceId;
			const createdTaskId = handleCreateTask(options);
			if (targetWorkspaceId && createdTaskId) {
				startTaskCardsCreatedInOtherProjectAfterRuntimePersistence(targetWorkspaceId, [createdTaskId]);
			}
			return createdTaskId;
		},
		[
			handleCreateTask,
			startTaskCardsCreatedInOtherProjectAfterRuntimePersistence,
			taskCreationTargetOtherProjectWorkspaceId,
		],
	);
	const handleCreateAndStartTasksInOtherProject = useCallback(
		(prompts: string[], options?: TaskEditorSubmitOptions): string[] => {
			const targetWorkspaceId = taskCreationTargetOtherProjectWorkspaceId;
			const createdTaskIds = handleCreateTasks(prompts, options);
			if (targetWorkspaceId && createdTaskIds.length > 0) {
				startTaskCardsCreatedInOtherProjectAfterRuntimePersistence(targetWorkspaceId, createdTaskIds);
			}
			return createdTaskIds;
		},
		[
			handleCreateTasks,
			startTaskCardsCreatedInOtherProjectAfterRuntimePersistence,
			taskCreationTargetOtherProjectWorkspaceId,
		],
	);
	const handleCreateStartAndOpenTaskInOtherProject = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			const targetWorkspaceId = taskCreationTargetOtherProjectWorkspaceId;
			const createdTaskId = handleCreateTask(options);
			if (targetWorkspaceId && createdTaskId) {
				startTaskCardsCreatedInOtherProjectAfterRuntimePersistence(targetWorkspaceId, [createdTaskId], {
					openTaskAfterStart: true,
				});
			}
			return createdTaskId;
		},
		[
			handleCreateTask,
			startTaskCardsCreatedInOtherProjectAfterRuntimePersistence,
			taskCreationTargetOtherProjectWorkspaceId,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setTaskCreationTargetWorkspaceIdPinnedInBoardScope(null);
		setEditingTaskId(null);
		setEditingTaskCardInOtherProject(null);
		setEditTaskFormSeededFromSavedDraftAt(null);

		setNewTaskPrompt("");
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
		setNewTaskConversationMode("operational");

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
		setEditTaskConversationMode("operational");
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskTerminalAgentModelOverrideSettings(undefined);
		setNewTaskImages([]);
		setNewTaskWorktreeMode("branch");
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskTerminalAgentModelOverrideSettings(undefined);
		setNewTaskAgentSessionInitialization(undefined);
	}, [newTaskAgentPermissionModeByDefault, newTaskStartInPlanModeByDefault, setEditingTaskCardInOtherProject]);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAgentPermissionMode,
		setNewTaskAgentPermissionMode,
		newTaskConversationMode,
		setNewTaskConversationMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskWorktreeMode,
		setNewTaskWorktreeMode,
		newTaskAgentId,
		setNewTaskAgentId,
		newTaskClineSettings,
		setNewTaskClineSettings,
		newTaskTerminalAgentModelOverrideSettings,
		setNewTaskTerminalAgentModelOverrideSettings: rememberNewTaskTerminalAgentModelOverrideSettings,
		newTaskAgentSessionInitialization,
		setNewTaskAgentSessionInitialization,
		editingTaskId,
		editTaskName,
		setEditTaskName,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAgentPermissionMode,
		setEditTaskAgentPermissionMode,
		editTaskConversationMode,
		setEditTaskConversationMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskWorktreeMode,
		setEditTaskWorktreeMode,
		editTaskAgentId,
		setEditTaskAgentId,
		editTaskClineSettings,
		setEditTaskClineSettings,
		editTaskTerminalAgentModelOverrideSettings,
		setEditTaskTerminalAgentModelOverrideSettings,
		editTaskAgentSessionInitialization,
		setEditTaskAgentSessionInitialization,
		handleOpenCreateTask,
		handleCancelCreateTask,
		editTaskFormSeededFromSavedDraftAt,
		handleRevertEditTaskFormToSavedTaskContent,
		handleAdoptPromotedTaskEditDraft,
		handleOpenEditTask,
		handleOpenEditTaskCardInOtherProject,
		editTaskWorkspaceId,
		editTaskBranchOptionsForEditTarget,
		taskCreationTargetWorkspaceId,
		taskCreationTargetOtherProjectWorkspaceId,
		handleOpenCreateTaskInBoardScope,
		handleSelectTaskCreationTargetProject: pinTaskCreationTargetProject,
		createTaskBranchOptionsForCreationTarget,
		resolvedDefaultCreateTaskBranchRefForCreationTarget,
		rememberedTaskCreateBaseRefForCreationTargetOtherProject,
		repositoryDefaultBranchRefOfCreationTargetOtherProject:
			gitRepositoryInfoOfTaskCreationTargetOtherProject?.defaultBranch ?? null,
		handleCreateAndStartTaskInOtherProject,
		handleCreateAndStartTasksInOtherProject,
		handleCreateStartAndOpenTaskInOtherProject,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	};
}
