import { resolveAgentSessionTransportPinnedAtTaskCreation } from "./agent-session-transport-selection";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskCommentEntry,
	RuntimeTaskConversationMode,
	RuntimeTaskImage,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "./api-contract";
import {
	hasTaskDescriptionContentChanged,
	resolveTaskDescriptionLastUpdatedAt,
	sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending,
} from "./backlog-task-description-last-updated-ordering";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "./task-agent-permission-mode";
import { createUniqueTaskId } from "./task-id";
import { resolveTaskTitle } from "./task-title";

// 前端经 `@runtime-task-state` 别名（指向本文件）复用这组函数，免得再加一个值别名（tsconfig/vite/vitest 三处同步）。
export {
	hasTaskDescriptionContentChanged,
	resolveTaskDescriptionLastUpdatedAt,
	sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending,
};

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
	// 卡片声明的会话模式（探索/操作，蓝图 §A.1）；不传 = operational（缺省不落盘，字段缺失即默认档）。
	taskConversationMode?: RuntimeTaskConversationMode;
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
	// 三态同上：undefined = 保留卡片原值，null = 清除声明（回落 operational 缺省），具体值 = 改声明。
	// 改模式只影响下一次启动——活会话读的是 summary.taskConversationMode 快照（v1 不热切换）。
	taskConversationMode?: RuntimeTaskConversationMode | null;
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
		// 缺省不落盘：字段缺失即 operational（蓝图 §A.1「legacy 卡片零迁移」）。
		...(input.taskConversationMode !== undefined ? { taskConversationMode: input.taskConversationMode } : {}),
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
		taskDescriptionLastUpdatedAt: now,
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
		board: sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending({
			...board,
			columns,
		}),
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

	return {
		board: {
			...board,
			columns,
		},
		deleted: true,
		deletedTaskIds,
	};
}

// 卡片落进目标列的位置。缺省（不传 insertAtIndex）= 列顶，即历来的「最近移入在最上」语义。
export interface RuntimeMoveTaskTargetColumnPlacement {
	// 拖放落点：目标列里**插入之后**这张卡所在的下标（与 @hello-pangea/dnd 的 destination.index 同义）。
	// 越界时钳到 [0, 目标列现有卡数]，不报错——落点是 UI 几何的近似值，列在请求途中被别人改过也不该让移列失败。
	insertAtIndex?: number;
}

function clampInsertAtIndexIntoBoardColumn(insertAtIndex: number | undefined, boardColumnCardCount: number): number {
	if (insertAtIndex === undefined || !Number.isFinite(insertAtIndex)) {
		return 0;
	}
	return Math.min(Math.max(Math.trunc(insertAtIndex), 0), boardColumnCardCount);
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
	targetColumnPlacement: RuntimeMoveTaskTargetColumnPlacement = {},
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
	// 列顶 = 最近移入：与浏览器程序化移列的 insertAtTop、以及建卡置顶同一语义。曾经只有 trash 置顶、
	// 其余列追加到列尾，于是经 CLI `kanban task start` 等运行时路径启动的卡会沉到一列陈旧卡的最末。
	// 带 insertAtIndex 时（用户拖放到列中某处）保留落点。
	const targetCards = [...targetColumn.cards];
	targetCards.splice(
		clampInsertAtIndexIntoBoardColumn(targetColumnPlacement.insertAtIndex, targetCards.length),
		0,
		movedTask,
	);

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
		board: {
			...board,
			columns,
		},
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export interface RuntimeReorderTaskWithinBoardColumnResult {
	// 卡片位置确实变了才为 true；卡片不存在、或落点就是原位时为 false（调用方据此跳过落盘）。
	reordered: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	boardColumnId: RuntimeBoardColumnId | null;
}

// 列内重排（拖放把卡挪到同一列的另一个位置）。与浏览器 applyDragResult 的同列分支同语义：
// 只改顺序、**不推进 updatedAt**（重排不是对卡片内容的修改）。backlog 按 Description 最后更新时间排序，
// 手动顺序会被下一次排序立刻覆盖，所以这里拒绝重排 backlog（与 drag-rules 一致）。
export function reorderTaskWithinBoardColumn(
	board: RuntimeBoardData,
	taskId: string,
	insertAtIndex: number,
): RuntimeReorderTaskWithinBoardColumnResult {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { reordered: false, board, task: null, boardColumnId: null };
	}
	const column = board.columns[found.columnIndex];
	if (!column || found.columnId === "backlog") {
		return { reordered: false, board, task: found.task, boardColumnId: found.columnId };
	}
	const remainingCards = column.cards.filter((_, index) => index !== found.taskIndex);
	const nextTaskIndex = clampInsertAtIndexIntoBoardColumn(insertAtIndex, remainingCards.length);
	if (nextTaskIndex === found.taskIndex) {
		return { reordered: false, board, task: found.task, boardColumnId: found.columnId };
	}
	remainingCards.splice(nextTaskIndex, 0, found.task);
	return {
		reordered: true,
		board: {
			...board,
			columns: board.columns.map((candidate, index) =>
				index === found.columnIndex ? { ...candidate, cards: remainingCards } : candidate,
			),
		},
		task: found.task,
		boardColumnId: found.columnId,
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
			const nextImages = input.images === undefined ? card.images : cloneTaskImages(input.images);
			// 只有 Description 内容（prompt + 附图）真正变了才推进；编辑框什么都不改直接保存、只改 baseRef / agent
			// 等都不推进。没变时物化回落值（读推进前的卡片），老卡片的值从此固定、不再跟着 updatedAt 漂移。
			const taskDescriptionLastUpdatedAt = hasTaskDescriptionContentChanged({
				previousPrompt: card.prompt,
				previousImages: card.images,
				nextPrompt: prompt,
				nextImages,
			})
				? now
				: resolveTaskDescriptionLastUpdatedAt(card);
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
				images: nextImages,
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
				// 与 ompAgentSessionTransport 同一三态语义；缺省（字段缺失）= operational。
				taskConversationMode:
					input.taskConversationMode === undefined
						? card.taskConversationMode
						: (input.taskConversationMode ?? undefined),
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
				taskDescriptionLastUpdatedAt,
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
		board: sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending({
			...board,
			columns,
		}),
		task: updatedTask,
		updated: true,
	};
}

export interface RuntimeApplyMostRecentlyLaunchedAgentSessionAgentIdResult {
	board: RuntimeBoardData;
	/** 卡片确实被改写时才为 true；卡片不存在或该字段值本就相同时为 false（调用方据此跳过落盘）。 */
	updated: boolean;
}

// 把「这张卡最近一次真正启动成功的会话用的是哪个 agent」记到卡片上。
//
// 刻意不复用 updateTask：那个入口是**用户编辑意图**的载体，要求 prompt / baseRef 非空，且
// title / startInPlanMode / autoReview* 不是三态字段——漏传即复位（见 runtime-api.ts 里
// persistResolvedTerminalAgentSessionModelOverrideSettingsOntoCard 的同款警告）。为写一个
// runtime 观测值而去回填七个用户字段，是纯粹白送的踩雷面。
//
// 同样刻意不 bump `updatedAt`：那是用户可见的「上次修改时间」，参与看板排序与展示，
// 不该被一次后台观测污染。本字段的时效性由「会话启动成功」这一事件本身保证。
export function applyMostRecentlyLaunchedAgentSessionAgentIdToTask(
	board: RuntimeBoardData,
	taskId: string,
	mostRecentlyLaunchedAgentSessionAgentId: RuntimeAgentId,
): RuntimeApplyMostRecentlyLaunchedAgentSessionAgentIdResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return { board, updated: false };
	}
	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (
				card.id !== normalizedTaskId ||
				card.mostRecentlyLaunchedAgentSessionAgentId === mostRecentlyLaunchedAgentSessionAgentId
			) {
				return card;
			}
			columnUpdated = true;
			return { ...card, mostRecentlyLaunchedAgentSessionAgentId };
		});
		if (!columnUpdated) {
			return column;
		}
		updated = true;
		return { ...column, cards };
	});
	return updated ? { board: { ...board, columns }, updated: true } : { board, updated: false };
}
