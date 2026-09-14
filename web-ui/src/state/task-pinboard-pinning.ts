import type { BoardCard, BoardColumnId, BoardData } from "@/types";

/**
 * Task Pinboard（置顶板）的纯状态函数。
 *
 * 置顶态存在**卡片本身**上（`pinnedToTaskPinboardAt` / `taskPinboardPinReason`），不存在
 * 某个全局偏好字典里——这样卡片被永久删除时置顶态随之消失，永远不会留下指向已删任务的孤儿条目，
 * 也天然是 per-project 的（跟着 `board.json` 走）。
 *
 * 「已置顶」由 `pinnedToTaskPinboardAt` 的**存在**表达，同一个值又直接当排序键用，
 * 因此不需要一个额外的布尔字段（两个字段互相矛盾时该信谁，是个不必要的问题）。
 *
 * 命名注意：仓库里 "pin" 另有三种无关语义（Focus View 的 sticky 卡头几何、模型 `pinned_version`、
 * 建卡时固化会话通道）。本模块一律带 `TaskPinboard` 前缀以示区分。
 */

/** 置顶板里的一条：分身卡片本身 + 它真正所在的 stage（分身上的 stage 标签与「跳回原卡」都要用）。 */
export interface TaskPinnedToTaskPinboard {
	card: BoardCard;
	columnId: BoardColumnId;
	columnTitle: string;
}

export function isPinnedToTaskPinboard(card: BoardCard): boolean {
	return card.pinnedToTaskPinboardAt !== undefined;
}

/**
 * 收集全盘已置顶的任务，按置顶时间**倒序**（最近置顶的排在最前）。
 *
 * 刻意不按 stage 分组：分身上已经带了 stage 标签，再分组只会让「我最近盯上的那个」下沉到某一组里。
 * 时间戳相同时（同一毫秒内连点两张）回落到任务 id 排序，保证渲染顺序稳定、不随 map 遍历抖动。
 */
export function collectTasksPinnedToTaskPinboard(board: BoardData): TaskPinnedToTaskPinboard[] {
	const pinnedTasks: TaskPinnedToTaskPinboard[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (!isPinnedToTaskPinboard(card)) {
				continue;
			}
			pinnedTasks.push({ card, columnId: column.id, columnTitle: column.title });
		}
	}
	pinnedTasks.sort((left, right) => {
		const pinnedAtDifference = (right.card.pinnedToTaskPinboardAt ?? 0) - (left.card.pinnedToTaskPinboardAt ?? 0);
		if (pinnedAtDifference !== 0) {
			return pinnedAtDifference;
		}
		return left.card.id.localeCompare(right.card.id);
	});
	return pinnedTasks;
}

/**
 * 就地改写命中卡片，其余列/卡保持原引用。
 *
 * 🔴 与 `board-state.ts` 里那些 mutation 的关键差别：**不调 `updateTaskTimestamp`**。
 * 置顶表达的是「我要盯着它」，不是任务内容被修改；bump `updatedAt` 会污染以「最近更新的卡」
 * 为还原目标的逻辑（如 Focus View 折叠 Done 列时的默认焦点）。持久化只看 board 引用是否变化，
 * 从不依赖 `updatedAt`，所以不 bump 完全不影响落盘。
 */
function mapPinnedTaskCard(
	board: BoardData,
	taskId: string,
	mapCard: (card: BoardCard) => BoardCard,
): { board: BoardData; updated: boolean } {
	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) {
				return card;
			}
			const nextCard = mapCard(card);
			if (nextCard === card) {
				return card;
			}
			columnUpdated = true;
			updated = true;
			return nextCard;
		});
		return columnUpdated ? { ...column, cards } : column;
	});
	if (!updated) {
		return { board, updated: false };
	}
	return { board: { ...board, columns }, updated: true };
}

function withTaskPinboardPinReason(card: BoardCard, pinReason: string | null | undefined): BoardCard {
	const trimmedPinReason = pinReason?.trim() ?? "";
	if (!trimmedPinReason) {
		const { taskPinboardPinReason: _droppedPinReason, ...cardWithoutPinReason } = card;
		return cardWithoutPinReason;
	}
	return { ...card, taskPinboardPinReason: trimmedPinReason };
}

/**
 * 置顶一个任务。已置顶时**保留原有的 `pinnedToTaskPinboardAt`**（不重排到最前），只更新原因——
 * 「编辑原因」不该顺带改变置顶板里的位置。
 */
export function pinTaskToTaskPinboard(
	board: BoardData,
	taskId: string,
	options: { pinReason?: string | null; pinnedAt?: number } = {},
): { board: BoardData; updated: boolean } {
	const pinnedAt = options.pinnedAt ?? Date.now();
	return mapPinnedTaskCard(board, taskId, (card) =>
		withTaskPinboardPinReason(
			{ ...card, pinnedToTaskPinboardAt: card.pinnedToTaskPinboardAt ?? pinnedAt },
			options.pinReason,
		),
	);
}

/** 取消置顶：两个字段一起清掉，不留半截状态（原因没了就没有「未置顶但有原因」这种态）。 */
export function unpinTaskFromTaskPinboard(board: BoardData, taskId: string): { board: BoardData; updated: boolean } {
	return mapPinnedTaskCard(board, taskId, (card) => {
		if (!isPinnedToTaskPinboard(card) && card.taskPinboardPinReason === undefined) {
			return card;
		}
		const {
			pinnedToTaskPinboardAt: _droppedPinnedAt,
			taskPinboardPinReason: _droppedPinReason,
			...unpinnedCard
		} = card;
		return unpinnedCard;
	});
}

/** 只改原因，不改置顶态与置顶时间；未置顶的卡不受影响（避免「有原因但没置顶」的孤立态）。 */
export function setTaskPinboardPinReason(
	board: BoardData,
	taskId: string,
	pinReason: string | null | undefined,
): { board: BoardData; updated: boolean } {
	return mapPinnedTaskCard(board, taskId, (card) => {
		if (!isPinnedToTaskPinboard(card)) {
			return card;
		}
		return withTaskPinboardPinReason(card, pinReason);
	});
}
