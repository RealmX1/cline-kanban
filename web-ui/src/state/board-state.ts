import type { DropResult } from "@hello-pangea/dnd";
import { isKanbanCursorAgentModelId } from "@runtime-agent-catalog";
import { createShortTaskId } from "@runtime-task-id";
import * as runtimeTaskState from "@runtime-task-state";
import { createInitialBoardData } from "@/data/board-data";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionTransport,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskClineSettings,
	RuntimeTaskConversationMode,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	RuntimeTaskWorktreeMode,
} from "@/runtime/types";
import { isAllowedCrossColumnCardMove, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import {
	type BoardCard,
	type BoardColumn,
	type BoardColumnId,
	type BoardData,
	type CardSelection,
	DEFAULT_TASK_AUTO_REVIEW_MODE,
	resolveTaskAutoReviewMode,
	type TaskAutoReviewMode,
	type TaskCommentEntry,
	type TaskImage,
} from "@/types";
import {
	runtimeAgentIdSchema,
	runtimeAgentSessionTransportSchema,
	runtimeTaskAgentPermissionModeSchema,
	runtimeTaskAgentSessionInitializationSchema,
	runtimeTaskConversationModeSchema,
} from "../../../src/core/api-contract";

export interface TaskDraft {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled?: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	taskCommentEntries?: TaskCommentEntry[];
	agentId?: RuntimeAgentId;
	// 建卡那一刻的工作区默认 agent（runtimeProjectConfig 的 selectedAgentId）。上面的 agentId 是
	// override，用户没在建卡对话框里挑 agent 时它是空的——但这张卡照样会跑工作区默认 agent，
	// 而「要不要固化会话通道」正是看后者。漏传它就等于「工作区默认是 omp」建出来的卡不落固化值。
	workspaceDefaultAgentIdForNewTasks?: RuntimeAgentId;
	// 建卡那一刻的全局「omp 新任务默认通道」。由调用方从 runtimeProjectConfig 取，
	// 域函数决定要不要固化到卡上（只对可切换 agent 落值）。
	ompAgentSessionTransportForNewTasks?: RuntimeAgentSessionTransport;
	clineSettings?: RuntimeTaskClineSettings;
	terminalAgentModelOverrideSettings?: RuntimeTaskTerminalAgentModelOverrideSettings;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	// 会话模式声明（蓝图 §A.1）。create：缺省 = operational（undefined 不落字段）。
	// updateTask 三态（与域层 RuntimeUpdateTaskInput 对齐）：不提 = 保留卡上原值；null = 清除回缺省；
	// 具体值 = 覆盖。部分重建 draft 的调用点（改标题、取消自动提交等）不提它即不碰。
	taskConversationMode?: RuntimeTaskConversationMode | null;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

export interface TaskMoveEvent {
	taskId: string;
	fromColumnId: BoardColumnId;
	toColumnId: BoardColumnId;
}

function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
	const result = Array.from(list);
	const [removed] = result.splice(startIndex, 1);
	if (removed !== undefined) {
		result.splice(endIndex, 0, removed);
	}
	return result;
}

function updateTaskTimestamp(task: BoardCard): BoardCard {
	return {
		...task,
		updatedAt: Date.now(),
	};
}

function withUpdatedColumns(board: BoardData, columns: BoardColumn[]): BoardData {
	return {
		...board,
		columns,
	};
}

function normalizeColumnId(id: string): BoardColumnId | null {
	if (id === "backlog" || id === "in_progress" || id === "review" || id === "validation" || id === "trash") {
		return id;
	}
	return null;
}

function createBrowserUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2, 12);
}

function normalizeTaskImages(rawImages: unknown): TaskImage[] | undefined {
	if (!Array.isArray(rawImages)) {
		return undefined;
	}
	const images: TaskImage[] = [];
	for (const rawImage of rawImages) {
		if (!rawImage || typeof rawImage !== "object") {
			continue;
		}
		const image = rawImage as { id?: unknown; data?: unknown; mimeType?: unknown; name?: unknown };
		if (typeof image.id !== "string" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
			continue;
		}
		images.push({
			id: image.id,
			data: image.data,
			mimeType: image.mimeType,
			...(typeof image.name === "string" ? { name: image.name } : {}),
		});
	}
	return images.length > 0 ? images : undefined;
}

function normalizeTaskCommentEntries(rawEntries: unknown): TaskCommentEntry[] | undefined {
	if (!Array.isArray(rawEntries)) {
		return undefined;
	}
	const entries: TaskCommentEntry[] = [];
	for (const rawEntry of rawEntries) {
		if (!rawEntry || typeof rawEntry !== "object") {
			continue;
		}
		const entry = rawEntry as {
			taskCommentEntryId?: unknown;
			commentText?: unknown;
			createdAt?: unknown;
			updatedAt?: unknown;
		};
		if (
			typeof entry.taskCommentEntryId !== "string" ||
			typeof entry.commentText !== "string" ||
			typeof entry.createdAt !== "number" ||
			typeof entry.updatedAt !== "number"
		) {
			continue;
		}
		const taskCommentEntryId = entry.taskCommentEntryId.trim();
		const commentText = entry.commentText.trim();
		if (!taskCommentEntryId || !commentText) {
			continue;
		}
		entries.push({
			taskCommentEntryId,
			commentText,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
		});
	}
	return entries.length > 0 ? entries : undefined;
}

function cloneTaskCommentEntries(entries?: TaskCommentEntry[] | null): TaskCommentEntry[] | undefined {
	return normalizeTaskCommentEntries(entries);
}

function normalizeTaskClineReasoningEffort(rawReasoningEffort: unknown): RuntimeClineReasoningEffort | undefined {
	if (
		rawReasoningEffort === "low" ||
		rawReasoningEffort === "medium" ||
		rawReasoningEffort === "high" ||
		rawReasoningEffort === "xhigh"
	) {
		return rawReasoningEffort;
	}
	return undefined;
}

function normalizeTaskClineSettings(input: {
	rawSettings?: unknown;
	legacyProviderId?: unknown;
	legacyModelId?: unknown;
	legacyReasoningEffort?: unknown;
}): RuntimeTaskClineSettings | undefined {
	if (input.rawSettings && typeof input.rawSettings === "object") {
		const settings = input.rawSettings as {
			providerId?: unknown;
			modelId?: unknown;
			reasoningEffort?: unknown;
		};
		const providerId = typeof settings.providerId === "string" ? settings.providerId.trim() : "";
		const modelId = typeof settings.modelId === "string" ? settings.modelId.trim() : "";
		const reasoningEffort = normalizeTaskClineReasoningEffort(settings.reasoningEffort);
		return {
			...(providerId ? { providerId } : {}),
			...(modelId ? { modelId } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
		};
	}

	const legacyProviderId = typeof input.legacyProviderId === "string" ? input.legacyProviderId.trim() : "";
	const legacyModelId = typeof input.legacyModelId === "string" ? input.legacyModelId.trim() : "";
	const reasoningEffort = normalizeTaskClineReasoningEffort(input.legacyReasoningEffort);
	if (!legacyProviderId && !legacyModelId && input.legacyReasoningEffort !== "default" && !reasoningEffort) {
		return undefined;
	}
	return {
		...(legacyProviderId ? { providerId: legacyProviderId } : {}),
		...(legacyModelId ? { modelId: legacyModelId } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
	};
}

function normalizeTaskTerminalAgentModelOverrideSettings(
	rawSettings: unknown,
): RuntimeTaskTerminalAgentModelOverrideSettings | undefined {
	if (!rawSettings || typeof rawSettings !== "object") {
		return undefined;
	}
	const settings = rawSettings as {
		agentId?: unknown;
		modelId?: unknown;
	};
	const agentId =
		settings.agentId === "claude" ||
		settings.agentId === "codex" ||
		settings.agentId === "cursor" ||
		settings.agentId === "kimi"
			? settings.agentId
			: null;
	const modelId = typeof settings.modelId === "string" ? settings.modelId.trim() : "";
	if (!agentId || !modelId) {
		return undefined;
	}
	if (agentId === "cursor" && !isKanbanCursorAgentModelId(modelId)) {
		return undefined;
	}
	return {
		agentId,
		modelId,
	};
}

// `now` 由 normalizeBoardData 统一取一次再传进来：缺时间戳的卡片共享同一个回落值，Backlog 的稳定排序
// 才会保持它们的原次序，而不是按「逐张归一化时 Date.now() 恰好跨过的毫秒」随机翻转。
function normalizeCard(rawCard: unknown, now: number): BoardCard | null {
	if (!rawCard || typeof rawCard !== "object") {
		return null;
	}

	const card = rawCard as {
		id?: unknown;
		title?: unknown;
		prompt?: unknown;
		startInPlanMode?: unknown;
		taskAgentPermissionMode?: unknown;
		autoReviewEnabled?: unknown;
		autoReviewMode?: unknown;
		images?: unknown;
		taskCommentEntries?: unknown;
		pinnedToTaskPinboardAt?: unknown;
		taskPinboardPinReason?: unknown;
		baseRef?: unknown;
		agentId?: unknown;
		ompAgentSessionTransport?: unknown;
		taskConversationMode?: unknown;
		mostRecentlyLaunchedAgentSessionAgentId?: unknown;
		clineSettings?: unknown;
		terminalAgentModelOverrideSettings?: unknown;
		taskAgentSessionInitialization?: unknown;
		clineProviderId?: unknown;
		clineModelId?: unknown;
		clineReasoningEffort?: unknown;
		parentSessionId?: unknown;
		worktreeMode?: unknown;
		prepFilePath?: unknown;
		createdAt?: unknown;
		updatedAt?: unknown;
		taskDescriptionLastUpdatedAt?: unknown;
	};
	const prompt = typeof card.prompt === "string" ? card.prompt.trim() : "";
	if (!prompt) {
		return null;
	}
	const baseRef = typeof card.baseRef === "string" ? card.baseRef.trim() : "";
	if (!baseRef) {
		return null;
	}
	const title = (typeof card.title === "string" ? card.title.trim() : "") || prompt;
	if (!title) {
		return null;
	}
	const clineSettings = normalizeTaskClineSettings({
		rawSettings: card.clineSettings,
		legacyProviderId: card.clineProviderId,
		legacyModelId: card.clineModelId,
		legacyReasoningEffort: card.clineReasoningEffort,
	});
	const terminalAgentModelOverrideSettings = normalizeTaskTerminalAgentModelOverrideSettings(
		card.terminalAgentModelOverrideSettings,
	);
	const parentSessionId = typeof card.parentSessionId === "string" ? card.parentSessionId.trim() : "";
	const parsedTaskAgentSessionInitialization = runtimeTaskAgentSessionInitializationSchema.safeParse(
		card.taskAgentSessionInitialization,
	);
	const parsedLegacyTaskAgentSessionInitialization = parentSessionId
		? runtimeTaskAgentSessionInitializationSchema.safeParse({
				sourceAgentId: "codex",
				sourceSessionId: parentSessionId,
				sourceSessionReuseMode: "fork_existing_session",
			})
		: null;
	const taskAgentSessionInitialization = parsedTaskAgentSessionInitialization.success
		? parsedTaskAgentSessionInitialization.data
		: parsedLegacyTaskAgentSessionInitialization?.success
			? parsedLegacyTaskAgentSessionInitialization.data
			: undefined;

	const prepFilePath = typeof card.prepFilePath === "string" ? card.prepFilePath.trim() : "";
	const worktreeMode =
		card.worktreeMode === "branch" || card.worktreeMode === "inplace" ? card.worktreeMode : undefined;
	// 老卡片没有这个字段：这里留 undefined，由服务端在启动任务时按当时的全局 autonomous 开关推导，
	// 前端不猜（前端拿不到那个开关的历史值）。
	const parsedTaskAgentPermissionMode = runtimeTaskAgentPermissionModeSchema.safeParse(card.taskAgentPermissionMode);
	const taskAgentPermissionMode = parsedTaskAgentPermissionMode.success
		? parsedTaskAgentPermissionMode.data
		: undefined;
	// normalizeCard 是白名单式拷贝，而水合出来的这份 board 会被原样回写持久化：漏掉这个字段
	// 不只是详情视图预判不出下次启动的通道，还会在下一次保存时把服务端卡片上已固化的值抹平。
	// 老卡片没有该字段 ⇒ 留 undefined，由启动处回落到当时的全局默认（见解析优先级注释）。
	const parsedOmpAgentSessionTransport = runtimeAgentSessionTransportSchema.safeParse(card.ompAgentSessionTransport);
	const ompAgentSessionTransport = parsedOmpAgentSessionTransport.success
		? parsedOmpAgentSessionTransport.data
		: undefined;

	// 纯 runtime 观测值：服务端在会话启动成功时写进卡片，前端既不生成也不编辑，只负责原样带过归一化。
	// 这里不保留就等于剥掉——归一化后的 board 会被 useWorkspacePersistence 原样 saveState 回盘，
	// 而服务端 saveWorkspaceState 是整块覆盖 board.json（不按字段与盘上旧卡片合并），
	// 于是硬中断恢复的主 durable 真相源被抹掉，只剩 reclamation 记录 / 项目默认档这两个更弱的源。
	const parsedMostRecentlyLaunchedAgentSessionAgentId = runtimeAgentIdSchema.safeParse(
		card.mostRecentlyLaunchedAgentSessionAgentId,
	);
	const mostRecentlyLaunchedAgentSessionAgentId = parsedMostRecentlyLaunchedAgentSessionAgentId.success
		? parsedMostRecentlyLaunchedAgentSessionAgentId.data
		: undefined;

	// Task Pinboard 置顶态：同样受上面那条白名单铁律约束——不在这里带过就等于「下一次保存把盘上的置顶抹平」。
	// 用「字段存在即已置顶」的时间戳表达，所以非有限数一律当成未置顶（而不是当成置顶但时间未知）。
	const pinnedToTaskPinboardAt =
		typeof card.pinnedToTaskPinboardAt === "number" && Number.isFinite(card.pinnedToTaskPinboardAt)
			? card.pinnedToTaskPinboardAt
			: undefined;
	// 原因留空 ⇒ 不写字段，避免盘上出现一堆空串。
	const taskPinboardPinReason =
		typeof card.taskPinboardPinReason === "string" && card.taskPinboardPinReason.trim()
			? card.taskPinboardPinReason
			: undefined;
	// 会话模式声明（蓝图 §A.1）：与 ompAgentSessionTransport 同款白名单保留——漏掉它会在下一次
	// saveState 时把盘上已声明的模式抹回 operational 缺省。老卡片没有该字段 ⇒ undefined = operational。
	const parsedTaskConversationMode = runtimeTaskConversationModeSchema.safeParse(card.taskConversationMode);
	const taskConversationMode = parsedTaskConversationMode.success ? parsedTaskConversationMode.data : undefined;
	const updatedAt = typeof card.updatedAt === "number" ? card.updatedAt : now;
	// Description 最后更新时间：白名单铁律同上。缺失（老卡片）时物化回落值（= updatedAt，见
	// resolveTaskDescriptionLastUpdatedAt），下一次保存后固定；**绝不回落到 now**——那会让每次水合都把
	// 老卡刷成「刚更新」、打乱 Backlog 顺序。
	const taskDescriptionLastUpdatedAt = runtimeTaskState.resolveTaskDescriptionLastUpdatedAt({
		taskDescriptionLastUpdatedAt:
			typeof card.taskDescriptionLastUpdatedAt === "number" && Number.isFinite(card.taskDescriptionLastUpdatedAt)
				? card.taskDescriptionLastUpdatedAt
				: undefined,
		updatedAt,
	});

	return {
		id: typeof card.id === "string" && card.id ? card.id : createShortTaskId(createBrowserUuid),
		title,
		prompt,
		startInPlanMode: typeof card.startInPlanMode === "boolean" ? card.startInPlanMode : false,
		...(taskAgentPermissionMode !== undefined ? { taskAgentPermissionMode } : {}),
		autoReviewEnabled: typeof card.autoReviewEnabled === "boolean" ? card.autoReviewEnabled : false,
		autoReviewMode: resolveTaskAutoReviewMode(
			typeof card.autoReviewMode === "string" ? (card.autoReviewMode as TaskAutoReviewMode) : undefined,
		),
		images: normalizeTaskImages(card.images),
		taskCommentEntries: normalizeTaskCommentEntries(card.taskCommentEntries),
		...(pinnedToTaskPinboardAt !== undefined ? { pinnedToTaskPinboardAt } : {}),
		...(taskPinboardPinReason !== undefined ? { taskPinboardPinReason } : {}),
		baseRef,
		...(typeof card.agentId === "string" && card.agentId ? { agentId: card.agentId as RuntimeAgentId } : {}),
		...(ompAgentSessionTransport !== undefined ? { ompAgentSessionTransport } : {}),
		...(taskConversationMode !== undefined ? { taskConversationMode } : {}),
		...(mostRecentlyLaunchedAgentSessionAgentId !== undefined ? { mostRecentlyLaunchedAgentSessionAgentId } : {}),
		...(clineSettings !== undefined ? { clineSettings } : {}),
		...(terminalAgentModelOverrideSettings !== undefined ? { terminalAgentModelOverrideSettings } : {}),
		...(taskAgentSessionInitialization !== undefined ? { taskAgentSessionInitialization } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(worktreeMode ? { worktreeMode } : {}),
		...(prepFilePath ? { prepFilePath } : {}),
		createdAt: typeof card.createdAt === "number" ? card.createdAt : now,
		updatedAt,
		taskDescriptionLastUpdatedAt,
	};
}

export function normalizeBoardData(rawBoard: unknown): BoardData | null {
	if (!rawBoard || typeof rawBoard !== "object") {
		return null;
	}

	const candidateColumns = (rawBoard as { columns?: unknown }).columns;
	if (!Array.isArray(candidateColumns)) {
		return null;
	}

	const initial = createInitialBoardData();
	const now = Date.now();
	const normalizedColumns = initial.columns.map((column) => ({ ...column, cards: [] as BoardCard[] }));
	const columnById = new Map(normalizedColumns.map((column) => [column.id, column]));

	for (const rawColumn of candidateColumns) {
		if (!rawColumn || typeof rawColumn !== "object") {
			continue;
		}
		const column = rawColumn as { id?: unknown; cards?: unknown };
		if (typeof column.id !== "string") {
			continue;
		}
		const normalizedId = normalizeColumnId(column.id);
		if (!normalizedId) {
			continue;
		}
		const normalizedColumn = columnById.get(normalizedId);
		if (!normalizedColumn || !Array.isArray(column.cards)) {
			continue;
		}
		for (const rawCard of column.cards) {
			const card = normalizeCard(rawCard, now);
			if (card) {
				normalizedColumn.cards.push(card);
			}
		}
	}

	// 老看板（本字段出现前的手动顺序）在首次水合时即按 Description 最后更新时间排好。
	// 旧盘里已退役的 `dependencies` 键（任务连线 / 完成后自动启动）在这里不再读取，水合结果里随之消失。
	return runtimeTaskState.sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending({
		columns: normalizedColumns,
	});
}

export function addTaskToColumn(
	board: BoardData,
	columnId: BoardColumnId,
	draft: TaskDraft,
	runtimeAllocatedTaskId: string,
): BoardData {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return board;
	}
	return addTaskToColumnWithResult(board, columnId, draft, runtimeAllocatedTaskId).board;
}

// dd2db Y-EVENT-12：新卡 id 只能由 runtime 分配（见 runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards）。
// 本地随机 id 会在保存时被 runtime 的全局 task id 登记簿拒绝或绕开登记簿，所以这里不再提供本地生成的退路。
function refuseLocallyGeneratedTaskIdForNewTaskCard(): string {
	throw new Error("New task card ids must be allocated by the Kanban runtime; refusing to generate one locally.");
}

export function addTaskToColumnWithResult(
	board: BoardData,
	columnId: BoardColumnId,
	draft: TaskDraft,
	runtimeAllocatedTaskId: string,
): { board: BoardData; task: BoardCard } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const trimmedRuntimeAllocatedTaskId = runtimeAllocatedTaskId.trim();
	if (!trimmedRuntimeAllocatedTaskId) {
		throw new Error("A runtime-allocated task id is required to create a task card.");
	}
	const result = runtimeTaskState.addTaskToColumn(
		board,
		columnId,
		{
			taskId: trimmedRuntimeAllocatedTaskId,
			title: draft.title,
			prompt,
			startInPlanMode: draft.startInPlanMode,
			taskAgentPermissionMode: draft.taskAgentPermissionMode,
			autoReviewEnabled: draft.autoReviewEnabled,
			autoReviewMode: draft.autoReviewMode,
			images: draft.images,
			taskCommentEntries: draft.taskCommentEntries,
			agentId: draft.agentId,
			workspaceDefaultAgentIdForNewTasks: draft.workspaceDefaultAgentIdForNewTasks,
			ompAgentSessionTransportForNewTasks: draft.ompAgentSessionTransportForNewTasks,
			clineSettings: draft.clineSettings,
			terminalAgentModelOverrideSettings: draft.terminalAgentModelOverrideSettings,
			taskAgentSessionInitialization: draft.taskAgentSessionInitialization,
			taskConversationMode: draft.taskConversationMode ?? undefined,
			baseRef: draft.baseRef,
			worktreeMode: draft.worktreeMode,
		},
		refuseLocallyGeneratedTaskIdForNewTaskCard,
	);
	return {
		board: result.board,
		task: result.task,
	};
}

export function applyDragResult(
	board: BoardData,
	result: DropResult,
	options?: { programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null },
): { board: BoardData; moveEvent?: TaskMoveEvent } {
	const { source, destination, type } = result;

	if (!destination) {
		return { board };
	}

	if (source.droppableId === destination.droppableId && source.index === destination.index) {
		return { board };
	}

	if (type === "COLUMN") {
		return { board };
	}

	const sourceColumnIndex = board.columns.findIndex((column) => column.id === source.droppableId);
	const destinationColumnIndex = board.columns.findIndex((column) => column.id === destination.droppableId);
	const sourceColumn = board.columns[sourceColumnIndex];
	const destinationColumn = board.columns[destinationColumnIndex];

	if (!sourceColumn || !destinationColumn) {
		return { board };
	}

	if (sourceColumn.id === destinationColumn.id) {
		// Backlog 按 Description 最后更新时间排序，列内手动重排会被下一次排序立刻覆盖——drag-rules 已禁止
		// 往 backlog 放卡，这里再兜一层，免得误导性的临时顺序被落盘。
		if (sourceColumn.id === "backlog") {
			return { board };
		}
		const movedCards = reorder(sourceColumn.cards, source.index, destination.index);
		const columns = Array.from(board.columns);
		columns[sourceColumnIndex] = {
			...sourceColumn,
			cards: movedCards,
		};
		return { board: withUpdatedColumns(board, columns) };
	}

	const isAllowedCrossColumnMove = isAllowedCrossColumnCardMove(sourceColumn.id, destinationColumn.id, {
		taskId: result.draggableId,
		programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
	});
	if (!isAllowedCrossColumnMove) {
		return { board };
	}

	const sourceCards = Array.from(sourceColumn.cards);
	const [movedCard] = sourceCards.splice(source.index, 1);
	if (!movedCard) {
		return { board };
	}

	const destinationCards = Array.from(destinationColumn.cards);
	const destinationInsertIndex = options?.programmaticCardMoveInFlight?.insertAtTop ? 0 : destination.index;
	destinationCards.splice(destinationInsertIndex, 0, updateTaskTimestamp(movedCard));

	const columns = Array.from(board.columns);
	columns[sourceColumnIndex] = {
		...sourceColumn,
		cards: sourceCards,
	};
	columns[destinationColumnIndex] = {
		...destinationColumn,
		cards: destinationCards,
	};

	return {
		board: withUpdatedColumns(board, columns),
		moveEvent: {
			taskId: movedCard.id,
			fromColumnId: sourceColumn.id,
			toColumnId: destinationColumn.id,
		},
	};
}
export function moveTaskToColumn(
	board: BoardData,
	taskId: string,
	targetColumnId: BoardColumnId,
	options?: { insertAtTop?: boolean },
): { board: BoardData; moved: boolean } {
	const moved = runtimeTaskState.moveTaskToColumn(board, taskId, targetColumnId);
	if (!moved.moved || !options?.insertAtTop) {
		return {
			board: moved.moved ? moved.board : board,
			moved: moved.moved,
		};
	}
	const targetColumnIndex = moved.board.columns.findIndex((column) => column.id === targetColumnId);
	const targetColumn = moved.board.columns[targetColumnIndex];
	if (!targetColumn) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const movedTaskIndex = targetColumn.cards.findIndex((card) => card.id === taskId);
	if (movedTaskIndex <= 0) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const targetCards = Array.from(targetColumn.cards);
	const [movedTask] = targetCards.splice(movedTaskIndex, 1);
	if (!movedTask) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	targetCards.unshift(movedTask);
	const columns = Array.from(moved.board.columns);
	columns[targetColumnIndex] = {
		...targetColumn,
		cards: targetCards,
	};
	return {
		board: withUpdatedColumns(moved.board, columns),
		moved: moved.moved,
	};
}

export function updateTask(board: BoardData, taskId: string, draft: TaskDraft): { board: BoardData; updated: boolean } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return { board, updated: false };
	}
	const title = typeof draft.title === "string" ? draft.title.trim() : "";
	const baseRef = draft.baseRef.trim();
	if (!baseRef) {
		return { board, updated: false };
	}
	const shouldUpdateTaskAgentSessionInitialization = Object.hasOwn(draft, "taskAgentSessionInitialization");
	const shouldUpdateWorktreeMode = Object.hasOwn(draft, "worktreeMode");
	// updateTask 是全量覆盖语义，而不少调用点（例如取消自动提交）只重建了部分 draft。
	// 用 Object.hasOwn 区分「显式改成 undefined」与「压根没提」，否则那些调用点会把权限档清零。
	const shouldUpdateTaskAgentPermissionMode = Object.hasOwn(draft, "taskAgentPermissionMode");
	// 会话模式同款三态（TaskDraft 注释）：不提 = 保留；null = 清除回缺省；具体值 = 覆盖。
	const shouldUpdateTaskConversationMode = Object.hasOwn(draft, "taskConversationMode");

	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) {
				return card;
			}
			columnUpdated = true;
			updated = true;
			const nextImages =
				draft.images === undefined
					? card.images
					: draft.images.length > 0
						? draft.images.map((image) => ({ ...image }))
						: undefined;
			// 与运行时 updateTask 同一判据：只有 Description 内容（prompt + 附图）真正变了才推进；
			// 没变时物化回落值，老卡片的值从此固定。
			const taskDescriptionLastUpdatedAt = runtimeTaskState.hasTaskDescriptionContentChanged({
				previousPrompt: card.prompt,
				previousImages: card.images,
				nextPrompt: prompt,
				nextImages,
			})
				? Date.now()
				: runtimeTaskState.resolveTaskDescriptionLastUpdatedAt(card);
			return {
				...card,
				title: title || card.title,
				prompt,
				startInPlanMode: Boolean(draft.startInPlanMode),
				taskAgentPermissionMode: shouldUpdateTaskAgentPermissionMode
					? draft.taskAgentPermissionMode
					: card.taskAgentPermissionMode,
				autoReviewEnabled: Boolean(draft.autoReviewEnabled),
				autoReviewMode: resolveTaskAutoReviewMode(draft.autoReviewMode ?? DEFAULT_TASK_AUTO_REVIEW_MODE),
				images: nextImages,
				taskCommentEntries:
					draft.taskCommentEntries === undefined
						? cloneTaskCommentEntries(card.taskCommentEntries)
						: cloneTaskCommentEntries(draft.taskCommentEntries),
				agentId: draft.agentId,
				clineSettings: draft.clineSettings,
				terminalAgentModelOverrideSettings: draft.terminalAgentModelOverrideSettings,
				taskAgentSessionInitialization: shouldUpdateTaskAgentSessionInitialization
					? draft.taskAgentSessionInitialization
					: card.taskAgentSessionInitialization,
				taskConversationMode: shouldUpdateTaskConversationMode
					? (draft.taskConversationMode ?? undefined)
					: card.taskConversationMode,
				parentSessionId: shouldUpdateTaskAgentSessionInitialization ? undefined : card.parentSessionId,
				baseRef,
				worktreeMode: shouldUpdateWorktreeMode ? draft.worktreeMode : card.worktreeMode,
				updatedAt: Date.now(),
				taskDescriptionLastUpdatedAt,
			};
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updated) {
		return { board, updated: false };
	}
	return {
		board: runtimeTaskState.sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(
			withUpdatedColumns(board, columns),
		),
		updated: true,
	};
}

export function updateTaskCommentEntries(
	board: BoardData,
	taskId: string,
	taskCommentEntries: TaskCommentEntry[],
): { board: BoardData; updated: boolean } {
	const normalizedEntries = cloneTaskCommentEntries(taskCommentEntries);
	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) {
				return card;
			}
			columnUpdated = true;
			updated = true;
			return updateTaskTimestamp({
				...card,
				taskCommentEntries: normalizedEntries,
			});
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updated) {
		return { board, updated: false };
	}
	return { board: withUpdatedColumns(board, columns), updated: true };
}

export function updateTaskTitle(
	board: BoardData,
	taskId: string,
	title: string,
): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}
	return updateTask(board, taskId, {
		title,
		prompt: selection.card.prompt,
		startInPlanMode: selection.card.startInPlanMode,
		autoReviewEnabled: selection.card.autoReviewEnabled,
		autoReviewMode: selection.card.autoReviewMode,
		images: selection.card.images,
		agentId: selection.card.agentId,
		clineSettings: selection.card.clineSettings,
		terminalAgentModelOverrideSettings: selection.card.terminalAgentModelOverrideSettings,
		baseRef: selection.card.baseRef,
	});
}

export function applyTaskDetailClineSettingsSelection(
	board: BoardData,
	taskId: string,
	settings: {
		agentId?: RuntimeAgentId;
		clineSettings?: RuntimeTaskClineSettings | null;
	},
): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}

	const hasExplicitTaskAgentSettings =
		selection.card.agentId === "cline" || selection.card.clineSettings !== undefined;
	if (!hasExplicitTaskAgentSettings) {
		return { board, updated: false };
	}

	return updateTask(board, taskId, {
		prompt: selection.card.prompt,
		startInPlanMode: selection.card.startInPlanMode,
		autoReviewEnabled: selection.card.autoReviewEnabled,
		autoReviewMode: selection.card.autoReviewMode,
		images: selection.card.images,
		agentId: settings.agentId,
		clineSettings: settings.clineSettings ?? undefined,
		terminalAgentModelOverrideSettings: selection.card.terminalAgentModelOverrideSettings,
		baseRef: selection.card.baseRef,
	});
}

export function applyTaskDetailClineSettingsChange(
	board: BoardData,
	taskId: string,
	change: {
		providerId: string;
		modelId: string;
		reasoningEffort: RuntimeClineReasoningEffort | "";
	},
	defaults: {
		providerId?: string | null;
		modelId?: string | null;
	},
): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}

	const hasExplicitTaskAgentSettings =
		selection.card.agentId === "cline" || selection.card.clineSettings !== undefined;
	if (!hasExplicitTaskAgentSettings) {
		return { board, updated: false };
	}

	const nextTaskProviderId = change.providerId.trim() || defaults.providerId?.trim() || "";
	const nextTaskModelId = change.modelId.trim() || defaults.modelId?.trim() || "";
	if (!nextTaskProviderId || !nextTaskModelId) {
		return { board, updated: false };
	}

	return applyTaskDetailClineSettingsSelection(board, taskId, {
		agentId: "cline",
		clineSettings: {
			providerId: nextTaskProviderId,
			modelId: nextTaskModelId,
			...(change.reasoningEffort ? { reasoningEffort: change.reasoningEffort } : {}),
		},
	});
}

export function disableTaskAutoReview(board: BoardData, taskId: string): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}

	return updateTask(board, taskId, {
		prompt: selection.card.prompt,
		startInPlanMode: selection.card.startInPlanMode,
		autoReviewEnabled: false,
		autoReviewMode: DEFAULT_TASK_AUTO_REVIEW_MODE,
		images: selection.card.images,
		agentId: selection.card.agentId,
		clineSettings: selection.card.clineSettings,
		terminalAgentModelOverrideSettings: selection.card.terminalAgentModelOverrideSettings,
		baseRef: selection.card.baseRef,
	});
}

export function removeTask(board: BoardData, taskId: string): { board: BoardData; removed: boolean } {
	let removed = false;
	const columns = board.columns.map((column) => {
		const nextCards = column.cards.filter((card) => card.id !== taskId);
		if (nextCards.length !== column.cards.length) {
			removed = true;
			return { ...column, cards: nextCards };
		}
		return column;
	});
	if (!removed) {
		return { board, removed: false };
	}
	return {
		board: withUpdatedColumns(board, columns),
		removed: true,
	};
}

export function clearColumnTasks(
	board: BoardData,
	columnId: BoardColumnId,
): { board: BoardData; clearedTaskIds: string[] } {
	const targetColumn = board.columns.find((column) => column.id === columnId);
	if (!targetColumn || targetColumn.cards.length === 0) {
		return { board, clearedTaskIds: [] };
	}

	const clearedTaskIds = targetColumn.cards.map((card) => card.id);
	const columns = board.columns.map((column) => (column.id === columnId ? { ...column, cards: [] } : column));
	return {
		board: withUpdatedColumns(board, columns),
		clearedTaskIds,
	};
}

export function findCardSelection(board: BoardData, taskId: string): CardSelection | null {
	for (const column of board.columns) {
		const card = column.cards.find((task) => task.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: board.columns,
			};
		}
	}
	return null;
}

export function getTaskColumnId(board: BoardData, taskId: string): BoardColumnId | null {
	return runtimeTaskState.getTaskColumnId(board, taskId);
}
