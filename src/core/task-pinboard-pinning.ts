/**
 * Task Pinboard（置顶板）的纯状态函数，前后端共用，两条改写路径跑的是同一份代码：
 *   - 浏览器对当前项目（主看板、Focus View，以及跨项目切换面板里属于当前项目的卡）经 setBoard 改写内存 board，
 *     再走整板 saveState——这些卡片动作尚未迁移到 `taskCardAction.*`；
 *   - runtime 经 `taskCardAction.setTaskPinboardPinStateOfTaskCard` 在 board 锁内对最新 board 改写；目前只有跨项目
 *     切换面板对非当前项目的置顶走这条，且浏览器调用的是旧入口 `workspace.setTaskPinboardPinStateOfTaskCard`（转发到它）。
 * web-ui 经 `@runtime-task-pinboard-pinning` 引用。
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
 *
 * 泛型只约束置顶相关的三个字段：web-ui 的 `BoardCard` 与 runtime 的 `RuntimeBoardCard` 是两个独立声明的类型。
 */

export interface TaskPinboardPinnableTaskCard {
	id: string;
	pinnedToTaskPinboardAt?: number;
	taskPinboardPinReason?: string;
}

interface TaskPinboardPinnableBoard<TTaskCard extends TaskPinboardPinnableTaskCard> {
	columns: Array<{ cards: TTaskCard[] }>;
}

export function isPinnedToTaskPinboard(card: TaskPinboardPinnableTaskCard): boolean {
	return card.pinnedToTaskPinboardAt !== undefined;
}

/**
 * 就地改写命中卡片，其余列/卡保持原引用。
 *
 * 🔴 与 `board-state.ts` 里那些 mutation 的关键差别：**不调 `updateTaskTimestamp`**。
 * 置顶表达的是「我要盯着它」，不是任务内容被修改；bump `updatedAt` 会污染以「最近更新的卡」
 * 为还原目标的逻辑（如 Focus View 折叠 Done 列时的默认焦点）。持久化只看 board 引用是否变化，
 * 从不依赖 `updatedAt`，所以不 bump 完全不影响落盘。
 */
function mapPinnedTaskCard<
	TTaskCard extends TaskPinboardPinnableTaskCard,
	TBoard extends TaskPinboardPinnableBoard<TTaskCard>,
>(board: TBoard, taskId: string, mapCard: (card: TTaskCard) => TTaskCard): { board: TBoard; updated: boolean } {
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

function withTaskPinboardPinReason<TTaskCard extends TaskPinboardPinnableTaskCard>(
	card: TTaskCard,
	pinReason: string | null | undefined,
): TTaskCard {
	const trimmedPinReason = pinReason?.trim() ?? "";
	if (!trimmedPinReason) {
		const { taskPinboardPinReason: _droppedPinReason, ...cardWithoutPinReason } = card;
		return cardWithoutPinReason as TTaskCard;
	}
	return { ...card, taskPinboardPinReason: trimmedPinReason };
}

/**
 * 置顶一个任务。已置顶时**保留原有的 `pinnedToTaskPinboardAt`**（不重排到最前），只更新原因——
 * 「编辑原因」不该顺带改变置顶板里的位置。
 */
export function pinTaskToTaskPinboard<
	TTaskCard extends TaskPinboardPinnableTaskCard,
	TBoard extends TaskPinboardPinnableBoard<TTaskCard>,
>(
	board: TBoard,
	taskId: string,
	options: { pinReason?: string | null; pinnedAt?: number } = {},
): { board: TBoard; updated: boolean } {
	const pinnedAt = options.pinnedAt ?? Date.now();
	return mapPinnedTaskCard<TTaskCard, TBoard>(board, taskId, (card) => {
		const nextCard = withTaskPinboardPinReason(
			{ ...card, pinnedToTaskPinboardAt: card.pinnedToTaskPinboardAt ?? pinnedAt },
			options.pinReason,
		);
		// 置顶时刻与原因都没变 ⇒ 原样返回，让调用方据 updated=false 跳过落盘。
		return nextCard.pinnedToTaskPinboardAt === card.pinnedToTaskPinboardAt &&
			nextCard.taskPinboardPinReason === card.taskPinboardPinReason
			? card
			: nextCard;
	});
}

/** 取消置顶：两个字段一起清掉，不留半截状态（原因没了就没有「未置顶但有原因」这种态）。 */
export function unpinTaskFromTaskPinboard<
	TTaskCard extends TaskPinboardPinnableTaskCard,
	TBoard extends TaskPinboardPinnableBoard<TTaskCard>,
>(board: TBoard, taskId: string): { board: TBoard; updated: boolean } {
	return mapPinnedTaskCard<TTaskCard, TBoard>(board, taskId, (card) => {
		if (!isPinnedToTaskPinboard(card) && card.taskPinboardPinReason === undefined) {
			return card;
		}
		const {
			pinnedToTaskPinboardAt: _droppedPinnedAt,
			taskPinboardPinReason: _droppedPinReason,
			...unpinnedCard
		} = card;
		return unpinnedCard as TTaskCard;
	});
}

/** 只改原因，不改置顶态与置顶时间；未置顶的卡不受影响（避免「有原因但没置顶」的孤立态）。 */
export function setTaskPinboardPinReason<
	TTaskCard extends TaskPinboardPinnableTaskCard,
	TBoard extends TaskPinboardPinnableBoard<TTaskCard>,
>(board: TBoard, taskId: string, pinReason: string | null | undefined): { board: TBoard; updated: boolean } {
	return mapPinnedTaskCard<TTaskCard, TBoard>(board, taskId, (card) => {
		if (!isPinnedToTaskPinboard(card)) {
			return card;
		}
		return withTaskPinboardPinReason(card, pinReason);
	});
}
