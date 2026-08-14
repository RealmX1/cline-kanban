import { isKanbanCursorAgentModelId } from "@runtime-agent-catalog";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "@runtime-task-agent-permission-mode";
import { deriveTaskTitleFromPrompt } from "@runtime-task-title";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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
	hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror,
	subscribeToTaskEditDraftStore,
} from "@/runtime/task-edit-draft-store";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
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
import { toTelemetrySelectedAgentId, trackTaskCreated } from "@/telemetry/events";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskEditorSubmitOptions, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useDebouncedEffect } from "@/utils/react-use";

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
	queueTaskStartAfterEdit?: (taskId: string) => void;
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
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskImages: TaskImage[];
	setEditTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	setEditTaskAgentPermissionMode: Dispatch<SetStateAction<RuntimeTaskAgentPermissionMode>>;
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
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useState(newTaskStartInPlanModeByDefault);
	const [newTaskAgentPermissionMode, setNewTaskAgentPermissionMode] = useState<RuntimeTaskAgentPermissionMode>(
		newTaskAgentPermissionModeByDefault,
	);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useNewTaskAutoReviewEnabledPreference();
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useNewTaskAutoReviewModePreference();
	const isNewTaskStartInPlanModeDisabled = false;
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [newTaskWorktreeMode, setNewTaskWorktreeMode] = useState<RuntimeTaskWorktreeMode>("branch");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	// 这次打开编辑对话框时，表单是不是被草稿铺过（值 = 那份草稿的 savedAt）。通知栏的文案与
	//「改回已保存内容」按钮都挂在它上面；null = 表单就是任务本体，通知栏那一条不出现。
	const [editTaskFormSeededFromSavedDraftAt, setEditTaskFormSeededFromSavedDraftAt] = useState<number | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAgentPermissionMode, setEditTaskAgentPermissionMode] = useState<RuntimeTaskAgentPermissionMode>(
		DEFAULT_TASK_AGENT_PERMISSION_MODE,
	);
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
						currentProjectId,
						effectiveAgentId,
						resolvedSettings?.modelId ?? "",
					);
				}
				return resolvedSettings;
			});
		},
		[currentProjectId, newTaskAgentId, selectedAgentId],
	);

	const resolvedDefaultTaskBranchRef = defaultTaskBranchRef;
	const resolvedDefaultCreateTaskBranchRef = defaultCreateTaskBranchRef;

	useEffect(() => {
		if (isInlineTaskCreateOpen) {
			return;
		}
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
	}, [isInlineTaskCreateOpen, newTaskAgentPermissionModeByDefault, newTaskStartInPlanModeByDefault]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === newTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
	}, [createTaskBranchOptions, newTaskBranchRef, resolvedDefaultCreateTaskBranchRef]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultCreateTaskBranchRef]);

	useEffect(() => {
		const effectiveAgentId = newTaskAgentId ?? selectedAgentId;
		const nextSettings = resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(
			currentProjectId,
			effectiveAgentId,
		);
		setNewTaskTerminalAgentModelOverrideSettings((currentSettings) =>
			isSameTerminalAgentModelOverrideSettings(currentSettings, nextSettings) ? currentSettings : nextSettings,
		);
	}, [currentProjectId, newTaskAgentId, selectedAgentId]);

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
		const isCurrentValid = editTaskBranchOptions.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [editTaskBranchOptions, editTaskBranchRef, editingTaskId, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findCardSelection(board, editingTaskId);
		if (!selection || selection.column.id !== "backlog") {
			setEditingTaskId(null);

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
			setEditTaskWorktreeMode("branch");
			setEditTaskAgentId(undefined);
			setEditTaskClineSettings(undefined);
			setEditTaskAgentSessionInitialization(undefined);
			clearTaskEditDraft(currentProjectId, editingTaskId);
		}
	}, [board, currentProjectId, editingTaskId]);

	// 表单此刻的值，与「这次是用什么铺上去的」。两者都得能在渲染循环之外被读到：重铺的判据挂在草稿
	// store 的订阅回调上，而那是 React 之外的调用；进依赖数组则会让订阅随每一次击键重挂一遍。
	const editTaskFormValues: TaskEditDraftFormValues = {
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

	// `board` 只在这里被当作只读查表用（拿到被编辑卡片以做「草稿是否等于任务本体」的比较）。
	// 放进 deps 会让本 effect 随每一次看板刷新（含 150ms 一拍的 session 广播）重跑一遍，
	// 而它做的是 localStorage 写盘。改走 ref：读到的永远是最新 board，但不参与依赖触发。
	const boardRef = useRef(board);
	boardRef.current = board;

	// 去抖写盘：草稿只是崩溃恢复用的兜底副本，不需要与每一次击键同频落盘。
	// 注意这是整条链路上**唯一**一处去抖——`TaskEditorDialog` 的上抛是事件驱动
	// （失焦 / 关闭 / 提交 / 长时间停顿），不是第二层去抖，因此不存在「两级去抖串联导致
	// 同步 flush 读到过期 state」的问题；提交路径另有 `promptOverride` 显式交接。
	useDebouncedEffect(
		() => {
			if (!editingTaskId) {
				return;
			}
			const selection = findCardSelection(boardRef.current, editingTaskId);
			if (!selection || selection.column.id !== "backlog") {
				return;
			}
			const draft = {
				taskId: editingTaskId,
				prompt: editTaskPrompt,
				// 图片可能是几 MB 的 dataURL，深拷贝要等到确定「真的要写盘」之后再做。
				images: editTaskImages,
				startInPlanMode: editTaskStartInPlanMode,
				taskAgentPermissionMode: editTaskAgentPermissionMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				branchRef: editTaskBranchRef || resolvedDefaultTaskBranchRef,
				worktreeMode: editTaskWorktreeMode,
				agentId: editTaskAgentId,
				clineSettings: editTaskClineSettings,
				terminalAgentModelOverrideSettings: editTaskTerminalAgentModelOverrideSettings,
				taskAgentSessionInitialization: editTaskAgentSessionInitialization,
			};
			if (isTaskEditDraftEqualToTask(draft, selection.card)) {
				clearTaskEditDraft(currentProjectId, editingTaskId);
				return;
			}
			saveTaskEditDraft(currentProjectId, {
				...draft,
				images: draft.images.map((image) => ({ ...image })),
				savedAt: Date.now(),
			});
		},
		TASK_EDIT_DRAFT_PERSIST_DEBOUNCE_MS,
		[
			currentProjectId,
			editTaskAgentId,
			editTaskAgentPermissionMode,
			editTaskAutoReviewEnabled,
			editTaskAutoReviewMode,
			editTaskBranchRef,
			editTaskClineSettings,
			editTaskTerminalAgentModelOverrideSettings,
			editTaskAgentSessionInitialization,
			editTaskImages,
			editTaskPrompt,
			editTaskStartInPlanMode,
			editTaskWorktreeMode,
			editingTaskId,
			resolvedDefaultTaskBranchRef,
		],
	);

	const handleOpenCreateTask = useCallback(() => {
		if (!isNewTaskStartInPlanModeDefaultLoaded) {
			return;
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
		setIsInlineTaskCreateOpen(true);
	}, [
		currentProjectId,
		isNewTaskStartInPlanModeDefaultLoaded,
		newTaskAgentPermissionModeByDefault,
		newTaskStartInPlanModeByDefault,
		resolvedDefaultCreateTaskBranchRef,
		selectedAgentId,
	]);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);

		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);
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
			branchRef: savedDraft?.branchRef ?? (task.baseRef || resolvedDefaultTaskBranchRef),
			worktreeMode: savedDraft?.worktreeMode ?? task.worktreeMode ?? "branch",
			agentId: savedDraft?.agentId ?? task.agentId,
			clineSettings: savedDraft?.clineSettings ?? task.clineSettings,
			terminalAgentModelOverrideSettings:
				savedDraft?.terminalAgentModelOverrideSettings ?? task.terminalAgentModelOverrideSettings,
			taskAgentSessionInitialization:
				savedDraft?.taskAgentSessionInitialization ?? task.taskAgentSessionInitialization,
		}),
		[newTaskAgentPermissionModeByDefault, resolvedDefaultTaskBranchRef],
	);

	const applyEditTaskFormValuesFromTask = useCallback(
		(task: BoardCard, savedDraft: TaskEditDraft | null) => {
			const formValues = resolveEditTaskFormValuesFromTask(task, savedDraft);
			// 记下这一铺用的是什么：迟到的服务端快照只有在表单仍与它逐字相等（＝用户还没动过）时才可以重铺。
			editTaskFormSeedRef.current = { savedDraftSavedAt: savedDraft?.savedAt ?? null, formValues };
			setEditTaskPrompt(formValues.prompt);
			setEditTaskImages(formValues.images);
			setEditTaskStartInPlanMode(formValues.startInPlanMode);
			setEditTaskAgentPermissionMode(formValues.taskAgentPermissionMode ?? newTaskAgentPermissionModeByDefault);
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
		if (!currentProjectId || !editingTaskId) {
			return;
		}
		const rebaseEditTaskFormOnServerDraftSnapshot = (): void => {
			if (!isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current) {
				return;
			}
			if (!hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror(currentProjectId)) {
				return;
			}
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
			const seed = editTaskFormSeedRef.current;
			const selection = findCardSelection(boardRef.current, editingTaskId);
			if (!seed || !selection) {
				return;
			}
			const authoritativeDraft = readSavedTaskEditDraft(currentProjectId, editingTaskId);
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
	}, [applyEditTaskFormValuesFromTask, currentProjectId, editingTaskId]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);

			setNewTaskPrompt("");
			setNewTaskImages([]);
			const savedDraft = readSavedTaskEditDraft(currentProjectId, task.id);
			// 这一读顺带把服务端快照的后台载入踢了起来；此刻它还没到的话，表单铺的就只是本地镜像，
			// 得等快照落定后重铺（见上面的 rebaseEditTaskFormOnServerDraftSnapshot）。
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current =
				currentProjectId !== null &&
				!hasWorkspaceTaskEditDraftServerSnapshotSupersededBrowserLocalStorageMirror(currentProjectId);
			setEditingTaskId(task.id);
			// 「这次打开用的是草稿」**必须**说出来。在此之前它完全静默：用户看到的是草稿，却以为看到的是
			// 任务本体，界面上没有任何提示、也没有改回去的退路。记下的是草稿自己的 savedAt 而不是一个
			// 布尔——「保存于 <相对时间>」是这条提示的全部信息量，没有它用户无从判断该不该采信眼前这份。
			setEditTaskFormSeededFromSavedDraftAt(savedDraft?.savedAt ?? null);
			applyEditTaskFormValuesFromTask(task, savedDraft);
		},
		[applyEditTaskFormValuesFromTask, currentProjectId, setSelectedTaskId],
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
		const selection = findCardSelection(boardRef.current, editingTaskId);
		if (!selection) {
			return;
		}
		clearTaskEditDraft(currentProjectId, editingTaskId);
		// 用户已经明确表态要任务本体。此后再让迟到的快照把某份草稿重铺回来，等于当场推翻他刚点的这一下。
		isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
		setEditTaskFormSeededFromSavedDraftAt(null);
		applyEditTaskFormValuesFromTask(selection.card, null);
	}, [applyEditTaskFormValuesFromTask, currentProjectId, editingTaskId]);

	/**
	 * 通知栏的「用这份替换当前」落定之后，把表单重铺成被提升上来的那份草稿。
	 *
	 * 复用 applyEditTaskFormValuesFromTask（任务本体打底 + 草稿覆盖），与打开对话框走的是同一段：
	 * 草稿里那几个可选字段为 undefined 时该回落到任务本体的哪个值，只在那一处定义。
	 */
	const handleAdoptPromotedTaskEditDraft = useCallback(
		(promotedDraft: TaskEditDraft) => {
			const selection = editingTaskId ? findCardSelection(boardRef.current, editingTaskId) : null;
			if (!selection) {
				return;
			}
			// 同「改回已保存内容」：用户刚显式挑了这一份，迟到的快照不得再把它换掉。
			isEditTaskFormAwaitingServerDraftSnapshotRebaseRef.current = false;
			setEditTaskFormSeededFromSavedDraftAt(promotedDraft.savedAt);
			applyEditTaskFormValuesFromTask(selection.card, promotedDraft);
		},
		[applyEditTaskFormValuesFromTask, editingTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		if (editingTaskId) {
			clearTaskEditDraft(currentProjectId, editingTaskId);
		}
		setEditingTaskId(null);
		setEditTaskFormSeededFromSavedDraftAt(null);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskWorktreeMode("branch");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskTerminalAgentModelOverrideSettings(undefined);
		setEditTaskAgentSessionInitialization(undefined);
	}, [currentProjectId, editingTaskId]);

	const handleSaveEditedTask = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			if (!editingTaskId) {
				return null;
			}
			const prompt = (options?.promptOverride ?? editTaskPrompt).trim();
			if (!prompt) {
				return null;
			}
			if (!(editTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return null;
			}

			const baseRef = editTaskBranchRef || resolvedDefaultTaskBranchRef;
			const savedTaskId = editingTaskId;
			clearTaskEditDraft(currentProjectId, savedTaskId);

			setBoard((currentBoard) => {
				const currentCard = currentBoard.columns.flatMap((c) => c.cards).find((c) => c.id === savedTaskId);
				const title = currentCard?.title ?? "";
				const updated = updateTask(currentBoard, savedTaskId, {
					title,
					prompt,
					startInPlanMode: editTaskStartInPlanMode,
					taskAgentPermissionMode: editTaskAgentPermissionMode,
					autoReviewEnabled: editTaskAutoReviewEnabled,
					autoReviewMode: editTaskAutoReviewMode,
					images: editTaskImages,
					agentId: editTaskAgentId,
					clineSettings: editTaskClineSettings,
					terminalAgentModelOverrideSettings: editTaskTerminalAgentModelOverrideSettings,
					taskAgentSessionInitialization: editTaskAgentSessionInitialization,
					baseRef,
					worktreeMode: editTaskWorktreeMode,
				});
				return updated.updated ? updated.board : currentBoard;
			});
			setEditingTaskId(null);

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
			setEditTaskWorktreeMode("branch");
			setEditTaskAgentId(undefined);
			setEditTaskClineSettings(undefined);
			setEditTaskTerminalAgentModelOverrideSettings(undefined);
			setEditTaskAgentSessionInitialization(undefined);
			return savedTaskId;
		},
		[
			editTaskAgentId,
			editTaskAgentPermissionMode,
			editTaskAutoReviewEnabled,
			editTaskAutoReviewMode,
			editTaskBranchRef,
			editTaskClineSettings,
			editTaskTerminalAgentModelOverrideSettings,
			editTaskAgentSessionInitialization,
			editTaskPrompt,
			editTaskImages,
			editTaskStartInPlanMode,
			editTaskWorktreeMode,
			editingTaskId,
			currentProjectId,
			resolvedDefaultTaskBranchRef,
			setBoard,
		],
	);

	const handleSaveAndStartEditedTask = useCallback(
		(options?: TaskEditorSubmitOptions) => {
			const taskId = handleSaveEditedTask(options);
			if (!taskId) {
				return;
			}
			queueTaskStartAfterEdit?.(taskId);
		},
		[handleSaveEditedTask, queueTaskStartAfterEdit],
	);

	const handleSaveTaskTitle = useCallback(
		(taskId: string, title: string) => {
			setBoard((currentBoard) => {
				const updated = updateTaskTitle(currentBoard, taskId, title);
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
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
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			if (!baseRef) {
				return null;
			}
			const title = deriveTaskTitleFromPrompt(prompt);
			const created = addTaskToColumnWithResult(board, "backlog", {
				title,
				prompt,
				startInPlanMode: newTaskStartInPlanMode,
				taskAgentPermissionMode: newTaskAgentPermissionMode,
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
			});
			setBoard(created.board);
			trackTaskCreated({
				selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
				start_in_plan_mode: newTaskStartInPlanMode,
				...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
				prompt_character_count: prompt.length,
			});
			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskStartInPlanMode(options?.keepDialogOpen ? newTaskStartInPlanMode : newTaskStartInPlanModeByDefault);
			setNewTaskAgentPermissionMode(
				options?.keepDialogOpen ? newTaskAgentPermissionMode : newTaskAgentPermissionModeByDefault,
			);
			setNewTaskBranchRef(options?.keepDialogOpen ? newTaskBranchRef : resolvedDefaultCreateTaskBranchRef);
			setNewTaskWorktreeMode(options?.keepDialogOpen ? newTaskWorktreeMode : "branch");
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(currentProjectId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return created.task.id;
		},
		[
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
			newTaskStartInPlanMode,
			newTaskStartInPlanModeByDefault,
			resolvedDefaultCreateTaskBranchRef,
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
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			if (!baseRef) {
				return [];
			}
			const createdTaskIds: string[] = [];
			let updatedBoard = board;
			for (const prompt of validPrompts) {
				const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
					prompt,
					startInPlanMode: newTaskStartInPlanMode,
					taskAgentPermissionMode: newTaskAgentPermissionMode,
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
				});
				updatedBoard = created.board;
				createdTaskIds.push(created.task.id);
			}
			setBoard(updatedBoard);
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
			setNewTaskBranchRef(options?.keepDialogOpen ? newTaskBranchRef : resolvedDefaultCreateTaskBranchRef);
			setNewTaskWorktreeMode(options?.keepDialogOpen ? newTaskWorktreeMode : "branch");
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskTerminalAgentModelOverrideSettings(
				resolveRememberedTaskCreateTerminalAgentModelOverrideSettings(currentProjectId, selectedAgentId),
			);
			setNewTaskAgentSessionInitialization(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
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
			newTaskStartInPlanMode,
			newTaskStartInPlanModeByDefault,
			resolvedDefaultCreateTaskBranchRef,
			resolvedDefaultTaskBranchRef,
			newTaskWorktreeMode,
			selectedAgentId,
			currentProjectId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setEditingTaskId(null);
		setEditTaskFormSeededFromSavedDraftAt(null);

		setNewTaskPrompt("");
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskAgentPermissionMode(newTaskAgentPermissionModeByDefault);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAgentPermissionMode(DEFAULT_TASK_AGENT_PERMISSION_MODE);
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
	}, [newTaskAgentPermissionModeByDefault, newTaskStartInPlanModeByDefault]);

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
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAgentPermissionMode,
		setEditTaskAgentPermissionMode,
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
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
	};
}
