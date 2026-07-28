import { isKanbanCursorAgentModelId } from "@runtime-agent-catalog";
import { deriveTaskTitleFromPrompt } from "@runtime-task-title";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
} from "@/hooks/app-utils";
import {
	clearTaskEditDraft,
	isTaskEditDraftEqualToTask,
	readSavedTaskEditDraft,
	saveTaskEditDraft,
} from "@/hooks/task-edit-drafts";
import type {
	RuntimeAgentId,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
	RuntimeTerminalAgentModelSelectionAgentId,
} from "@/runtime/types";
import { addTaskToColumnWithResult, findCardSelection, updateTask, updateTaskTitle } from "@/state/board-state";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";
import { toTelemetrySelectedAgentId, trackTaskCreated } from "@/telemetry/events";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskEditorSubmitOptions, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useBooleanLocalStorageValue, useDebouncedEffect, useRawLocalStorageValue } from "@/utils/react-use";

interface StoredTaskCreateTerminalAgentModelSelections {
	selections: Record<string, string>;
}

function isTerminalAgentModelSelectionAgentId(
	agentId: RuntimeAgentId | null | undefined,
): agentId is RuntimeTerminalAgentModelSelectionAgentId {
	return agentId === "claude" || agentId === "codex" || agentId === "cursor";
}

function getTaskCreateTerminalAgentModelSelectionStorageKey(
	projectId: string | null,
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): string {
	return JSON.stringify([projectId ?? "global", agentId]);
}

function readStoredTaskCreateTerminalAgentModelSelections(): StoredTaskCreateTerminalAgentModelSelections {
	const raw = readLocalStorageItem(LocalStorageKey.TaskCreateTerminalAgentModelSelections);
	if (!raw) {
		return { selections: {} };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { selections: {} };
		}
		const selections = (parsed as { selections?: unknown }).selections;
		if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
			return { selections: {} };
		}
		const normalizedSelections: Record<string, string> = {};
		for (const [key, value] of Object.entries(selections)) {
			if (typeof value === "string") {
				normalizedSelections[key] = value.trim();
			}
		}
		return { selections: normalizedSelections };
	} catch {
		return { selections: {} };
	}
}

function readRememberedTaskCreateTerminalAgentModelSelection(
	projectId: string | null,
	agentId: RuntimeTerminalAgentModelSelectionAgentId,
): string | undefined {
	const stored = readStoredTaskCreateTerminalAgentModelSelections();
	return stored.selections[getTaskCreateTerminalAgentModelSelectionStorageKey(projectId, agentId)];
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
	const stored = readStoredTaskCreateTerminalAgentModelSelections();
	stored.selections[getTaskCreateTerminalAgentModelSelectionStorageKey(projectId, agentId)] = modelId.trim();
	writeLocalStorageItem(LocalStorageKey.TaskCreateTerminalAgentModelSelections, JSON.stringify(stored));
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
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
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
	setSelectedTaskId,
	queueTaskStartAfterEdit,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useState(newTaskStartInPlanModeByDefault);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useBooleanLocalStorageValue(
		TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useRawLocalStorageValue<TaskAutoReviewMode>(
		TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
		"commit",
		normalizeStoredTaskAutoReviewMode,
	);
	const isNewTaskStartInPlanModeDisabled = false;
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [newTaskWorktreeMode, setNewTaskWorktreeMode] = useState<RuntimeTaskWorktreeMode>("branch");
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
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
	}, [isInlineTaskCreateOpen, newTaskStartInPlanModeByDefault]);

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
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
		setIsInlineTaskCreateOpen(true);
	}, [
		currentProjectId,
		isNewTaskStartInPlanModeDefaultLoaded,
		newTaskStartInPlanModeByDefault,
		resolvedDefaultCreateTaskBranchRef,
		selectedAgentId,
	]);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);

		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);
		setNewTaskBranchRef(resolvedDefaultCreateTaskBranchRef);
		setNewTaskWorktreeMode("branch");
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskTerminalAgentModelOverrideSettings(undefined);
		setNewTaskAgentSessionInitialization(undefined);
	}, [newTaskStartInPlanModeByDefault, resolvedDefaultCreateTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);

			setNewTaskPrompt("");
			setNewTaskImages([]);
			const taskPrompt = task.prompt.trim();
			const savedDraft = readSavedTaskEditDraft(currentProjectId, task.id);
			setEditingTaskId(task.id);

			setEditTaskPrompt(savedDraft?.prompt ?? taskPrompt);
			setEditTaskImages(
				savedDraft
					? savedDraft.images.map((image) => ({ ...image }))
					: task.images
						? task.images.map((image) => ({ ...image }))
						: [],
			);
			setEditTaskStartInPlanMode(savedDraft?.startInPlanMode ?? task.startInPlanMode);
			setEditTaskAutoReviewEnabled(savedDraft?.autoReviewEnabled ?? task.autoReviewEnabled === true);
			setEditTaskAutoReviewMode(savedDraft?.autoReviewMode ?? resolveTaskAutoReviewMode(task.autoReviewMode));
			const fallbackBranch = task.baseRef || resolvedDefaultTaskBranchRef;
			setEditTaskBranchRef(savedDraft?.branchRef ?? fallbackBranch);
			setEditTaskWorktreeMode(savedDraft?.worktreeMode ?? task.worktreeMode ?? "branch");
			setEditTaskAgentId(savedDraft?.agentId ?? task.agentId);
			setEditTaskClineSettings(savedDraft?.clineSettings ?? task.clineSettings);
			setEditTaskTerminalAgentModelOverrideSettings(
				savedDraft?.terminalAgentModelOverrideSettings ?? task.terminalAgentModelOverrideSettings,
			);
			setEditTaskAgentSessionInitialization(
				savedDraft?.taskAgentSessionInitialization ?? task.taskAgentSessionInitialization,
			);
		},
		[currentProjectId, resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		if (editingTaskId) {
			clearTaskEditDraft(currentProjectId, editingTaskId);
		}
		setEditingTaskId(null);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
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
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				images: newTaskImages,
				agentId: newTaskAgentId,
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
			newTaskPrompt,
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
					autoReviewEnabled: newTaskAutoReviewEnabled,
					autoReviewMode: newTaskAutoReviewMode,
					images: newTaskImages,
					agentId: newTaskAgentId,
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

		setNewTaskPrompt("");
		setNewTaskStartInPlanMode(newTaskStartInPlanModeByDefault);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
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
	}, [newTaskStartInPlanModeByDefault]);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
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
