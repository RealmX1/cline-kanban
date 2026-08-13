import { resolveAgentSessionTransportPinnedAtTaskCreation } from "./agent-session-transport-selection";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskCommentEntry,
	RuntimeTaskImage,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "./api-contract";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "./task-agent-permission-mode";
import { createUniqueTaskId } from "./task-id";
import { resolveTaskTitle } from "./task-title";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	taskCommentEntries?: RuntimeTaskCommentEntry[];
	agentId?: RuntimeAgentId;
	// 建卡那一刻的工作区默认 agent（runtime config 的 selectedAgentId）。上面的 agentId 是
	// **override**，用户不在建卡对话框里挑 agent 时它就是空的、这张卡跑的是工作区默认 agent。
	// 「要不要固化会话通道」看的是后者，所以两个值都得下沉到域层；只传 agentId 会让
	// 「工作区默认是 omp」建出来的卡漏掉固化值。仅用于固化判据，不写回卡片的 agentId——
	// 不选 agent 的卡片本来就跟随工作区默认 agent，那份语义不变。
	workspaceDefaultAgentIdForNewTasks?: RuntimeAgentId;
	// 建卡时把「全局新任务默认通道」固化到卡上（只对可切换 agent 有意义，见
	// resolveAgentSessionTransportPinnedAtTaskCreation）。调用方传的是全局默认值本身，
	// 由域函数决定要不要落到卡上——省得每个建卡入口各判一次「这个 agent 能不能切」。
	ompAgentSessionTransportForNewTasks?: RuntimeAgentSessionTransport;
	clineSettings?: RuntimeTaskClineSettings;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	baseRef: string;
	parentSessionId?: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	prepFilePath?: string;
}

export interface RuntimeUpdateTaskInput {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode | null;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	taskCommentEntries?: RuntimeTaskCommentEntry[] | null;
	agentId?: RuntimeAgentId | null;
	// 三态：undefined = 保留卡片原值，null = 清除固化值（回落到全局默认），具体值 = 改成该通道。
	// 通道切换 procedure 用它把新通道钉到卡上，使「下次启动」（含自动续跑、从垃圾桶拖回）也走新通道。
	ompAgentSessionTransport?: RuntimeAgentSessionTransport | null;
	clineSettings?: RuntimeTaskClineSettings | null;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings | null;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization | null;
	baseRef: string;
	parentSessionId?: string | null;
	worktreeMode?: RuntimeTaskWorktreeMode | null;
	prepFilePath?: string | null;
}

function normalizeTaskAutoReviewMode(value: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (value === "pr") {
		return value;
	}
	return "commit";
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function cloneTaskCommentEntries(entries?: RuntimeTaskCommentEntry[] | null): RuntimeTaskCommentEntry[] | undefined {
	if (!entries || entries.length === 0) {
		return undefined;
	}
	const clonedEntries = entries
		.map((entry) => {
			const taskCommentEntryId = entry.taskCommentEntryId.trim();
			const commentText = entry.commentText.trim();
			if (!taskCommentEntryId || !commentText) {
				return null;
			}
			return {
				taskCommentEntryId,
				commentText,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			};
		})
		.filter((entry): entry is RuntimeTaskCommentEntry => entry !== null);
	return clonedEntries.length > 0 ? clonedEntries : undefined;
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings | null): RuntimeTaskClineSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function cloneTaskTerminalAgentModelOverrideSettings(
	settings?: RuntimeTaskTerminalAgentModelOverrideSettings | null,
): RuntimeTaskTerminalAgentModelOverrideSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const modelId = settings.modelId.trim();
	if (!modelId) {
		return undefined;
	}
	return {
		agentId: settings.agentId,
		modelId,
	};
}

function cloneTaskAgentSessionInitialization(
	initialization?: RuntimeTaskAgentSessionInitialization | null,
): RuntimeTaskAgentSessionInitialization | undefined {
	return initialization ? { ...initialization } : undefined;
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeTrashTaskResult extends RuntimeMoveTaskResult {
	readyTaskIds: string[];
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	if (firstColumnId === "trash" || secondColumnId === "trash") {
		return { reason: "trash_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

function getLinkedBacklogTaskIdsReadyAfterTaskTrashed(
	board: RuntimeBoardData,
	taskId: string,
	fromColumnId: RuntimeBoardColumnId | null,
): string[] {
	if (!taskId || board.dependencies.length === 0 || (fromColumnId !== "review" && fromColumnId !== "validation")) {
		return [];
	}
	const readyTaskIds = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.toTaskId !== taskId) {
			continue;
		}
		if (getTaskColumnId(board, dependency.fromTaskId) !== "backlog") {
			continue;
		}
		readyTaskIds.add(dependency.fromTaskId);
	}
	return [...readyTaskIds];
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const resolved = resolveDependencyEndpoints(board, firstTaskId, secondTaskId);
		if ("reason" in resolved) {
			continue;
		}
		const pairKey = createDependencyPairKey(resolved.backlogTaskId, resolved.linkedTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: resolved.backlogTaskId,
			toTaskId: resolved.linkedTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const parentSessionId = input.parentSessionId?.trim();
	const prepFilePath = input.prepFilePath?.trim();
	// 建卡快照：与 startInPlanMode / taskAgentPermissionMode 同一范式——固化「此刻」的全局默认，
	// 之后改全局默认不追溯本卡。调用方没传全局默认时（老调用点 / 测试）落到 catalog 默认。
	const ompAgentSessionTransport = resolveAgentSessionTransportPinnedAtTaskCreation({
		agentIdTheNewTaskWillRunWith: input.agentId ?? input.workspaceDefaultAgentIdForNewTasks,
		globalDefaultSessionTransportForNewTasks: input.ompAgentSessionTransportForNewTasks,
	});
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		title: resolveTaskTitle(input.title, prompt),
		prompt,
		startInPlanMode: input.startInPlanMode ?? true,
		taskAgentPermissionMode: input.taskAgentPermissionMode ?? DEFAULT_TASK_AGENT_PERMISSION_MODE,
		autoReviewEnabled: Boolean(input.autoReviewEnabled),
		autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
		images: cloneTaskImages(input.images),
		taskCommentEntries: cloneTaskCommentEntries(input.taskCommentEntries),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(ompAgentSessionTransport !== undefined ? { ompAgentSessionTransport } : {}),
		...(input.clineSettings !== undefined ? { clineSettings: cloneTaskClineSettings(input.clineSettings) } : {}),
		...(input.terminalAgentModelOverrideSettings !== undefined
			? {
					terminalAgentModelOverrideSettings: cloneTaskTerminalAgentModelOverrideSettings(
						input.terminalAgentModelOverrideSettings,
					),
				}
			: {}),
		...(input.taskAgentSessionInitialization
			? { taskAgentSessionInitialization: cloneTaskAgentSessionInitialization(input.taskAgentSessionInitialization) }
			: {}),
		baseRef,
		worktreeMode: input.worktreeMode ?? "branch",
		...(parentSessionId ? { parentSessionId } : {}),
		...(prepFilePath ? { prepFilePath } : {}),
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		board: {
			...board,
			dependencies: [...board.dependencies, dependency],
		},
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return !hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	if (dependencies.length === board.dependencies.length) {
		return { board, removed: false };
	}
	return {
		board: {
			...board,
			dependencies,
		},
		removed: true,
	};
}

export function getReadyLinkedTaskIdsForTaskInTrash(board: RuntimeBoardData, taskId: string): string[] {
	return getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, getTaskColumnId(board, taskId));
}

export function trashTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const fromColumnId = getTaskColumnId(board, taskId);
	const readyTaskIds = getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, fromColumnId);
	const movedToTrash = moveTaskToColumn(board, taskId, "trash", now);
	return {
		...movedToTrash,
		readyTaskIds: movedToTrash.moved ? readyTaskIds : [],
	};
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: {
			...board,
			columns,
			dependencies,
		},
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	// Backlog 是尚未启动任务的单向入口。任务一旦离开，就不能被失败回滚或其它通用移列调用
	// 重新塞回 Backlog；启动失败仍应留在 In Progress，让会话状态与错误保持可见。
	if (targetColumnId === "backlog") {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	const targetCards =
		targetColumnId === "trash" ? [movedTask, ...targetColumn.cards] : [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: updateTaskDependencies({
			...board,
			columns,
		}),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			const nextParentSessionId =
				input.parentSessionId === undefined
					? card.parentSessionId
					: input.parentSessionId === null
						? undefined
						: input.parentSessionId.trim() || undefined;
			const nextWorktreeMode =
				input.worktreeMode === undefined
					? card.worktreeMode
					: input.worktreeMode === null
						? "branch"
						: input.worktreeMode;
			const nextTaskAgentSessionInitialization =
				input.taskAgentSessionInitialization === undefined
					? cloneTaskAgentSessionInitialization(card.taskAgentSessionInitialization)
					: cloneTaskAgentSessionInitialization(input.taskAgentSessionInitialization);
			const nextPrepFilePath =
				input.prepFilePath === undefined
					? card.prepFilePath
					: input.prepFilePath === null
						? undefined
						: input.prepFilePath.trim() || undefined;
			const nextTask: RuntimeBoardCard = {
				...card,
				title: resolveTaskTitle(input.title, prompt),
				prompt,
				startInPlanMode: Boolean(input.startInPlanMode),
				// 三态：undefined 原样保留卡片现值（**包括「字段缺失」本身**）、null 复位到默认档、其余按传入值。
				// 「缺失」在本设计里不是「等同默认档」：它触发 runtime-api 的 legacy 兼容推导，按当时的全局
				// agentAutonomousModeEnabled 取档（关闭时是 ask）。若在这里把 undefined 物化成 DEFAULT
				// （= bypass），那么在关闭了全局 bypass 的工作区里，只要对一张老卡片跑一次 task update
				// （CLI 恰好传 undefined，因为卡片本来就没有该字段），它就被永久钉成「全部工具自动放行」——
				// 用户从未选过、UI 也不会打降级星标，正是本轮明令禁止的「静默放宽权限」。
				// 前端 board-state.ts 的 updateTask 用 Object.hasOwn 保留缺失，这里必须与之同语义。
				taskAgentPermissionMode:
					input.taskAgentPermissionMode === undefined
						? card.taskAgentPermissionMode
						: (input.taskAgentPermissionMode ?? DEFAULT_TASK_AGENT_PERMISSION_MODE),
				autoReviewEnabled: Boolean(input.autoReviewEnabled),
				autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				taskCommentEntries:
					input.taskCommentEntries === undefined
						? cloneTaskCommentEntries(card.taskCommentEntries)
						: input.taskCommentEntries === null
							? undefined
							: cloneTaskCommentEntries(input.taskCommentEntries),
				agentId: input.agentId === undefined ? card.agentId : (input.agentId ?? undefined),
				// 与 taskAgentPermissionMode 同一三态语义：undefined 原样保留（**含「字段缺失」本身**，
				// 那是「回落到全局默认」的表达），null 显式清除固化值，其余按传入值钉住。
				ompAgentSessionTransport:
					input.ompAgentSessionTransport === undefined
						? card.ompAgentSessionTransport
						: (input.ompAgentSessionTransport ?? undefined),
				clineSettings:
					input.clineSettings === undefined
						? cloneTaskClineSettings(card.clineSettings)
						: input.clineSettings === null
							? undefined
							: cloneTaskClineSettings(input.clineSettings),
				terminalAgentModelOverrideSettings:
					input.terminalAgentModelOverrideSettings === undefined
						? cloneTaskTerminalAgentModelOverrideSettings(card.terminalAgentModelOverrideSettings)
						: input.terminalAgentModelOverrideSettings === null
							? undefined
							: cloneTaskTerminalAgentModelOverrideSettings(input.terminalAgentModelOverrideSettings),
				taskAgentSessionInitialization: nextTaskAgentSessionInitialization,
				baseRef,
				parentSessionId: nextParentSessionId,
				worktreeMode: nextWorktreeMode,
				prepFilePath: nextPrepFilePath,
				updatedAt: now,
			};
			updatedTask = nextTask;
			return nextTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}
