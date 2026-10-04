import type { BoardData } from "@/types";

/**
 * 回灌（hydration）时把本地还没保存的编辑「搬」到 runtime 那份新 board 上的三方合并。
 *
 * 为什么需要：卡片动作改走服务端后，服务端写入会经广播回灌，而浏览器的整板保存有 120ms 防抖。若回灌恰好落在
 * 防抖窗口里（或浏览器保存在途时撞上服务端写入、被判 CONFLICT 后重拉），直接整板替换会把本地刚做的编辑静默丢掉。
 *
 * 三份输入：
 *   boardLastConfirmedPersistedByRuntime —— 浏览器最近一次确认 runtime 已持久化的 board（共同祖先）；
 *   localBoard                           —— 浏览器内存里的当前 board（可能带着未保存编辑）；
 *   hydratedRuntimeBoard                 —— runtime 刚推来的 board（服务端真相）。
 *
 * 规则刻意保守——**默认服务端赢**，只带回两类不会与服务端写入冲突的本地编辑：
 *   1. 本地新建、祖先和服务端都还没有的卡（未落盘的建卡），放回它在本地所在的列与位置；
 *   2. 列内重排：某列在本地相对祖先改了顺序（成员不变），且该列在服务端仍与祖先逐位一致（服务端既没重排、
 *      也没增删该列的卡）时，沿用本地顺序。服务端也重排过（taskCardAction 允许 in_progress 等列内重排落盘）
 *      或成员变了，就以服务端顺序为准。
 * 其余一切（移列、改字段、删卡）都以服务端为准——它们已经改走服务端命令，本地不该再有「未保存的版本」。
 *
 * 返回值：没有可带回的编辑时原样返回 hydratedRuntimeBoard 的引用（调用方据此判断「回灌后无需再保存」）。
 */
export function rebaseUnsavedLocalBoardEditsOntoHydratedRuntimeBoard(input: {
	boardLastConfirmedPersistedByRuntime: BoardData | null;
	localBoard: BoardData;
	hydratedRuntimeBoard: BoardData;
}): BoardData {
	const { boardLastConfirmedPersistedByRuntime, localBoard, hydratedRuntimeBoard } = input;
	if (boardLastConfirmedPersistedByRuntime === null || localBoard === boardLastConfirmedPersistedByRuntime) {
		return hydratedRuntimeBoard;
	}
	const taskIdsKnownToAncestor = collectTaskIds(boardLastConfirmedPersistedByRuntime);
	const taskIdsKnownToRuntime = collectTaskIds(hydratedRuntimeBoard);
	let rebasedBoard = hydratedRuntimeBoard;

	// 1. 未落盘的本地新建卡。
	for (const localColumn of localBoard.columns) {
		localColumn.cards.forEach((localCard, localCardIndex) => {
			if (taskIdsKnownToAncestor.has(localCard.id) || taskIdsKnownToRuntime.has(localCard.id)) {
				return;
			}
			rebasedBoard = {
				...rebasedBoard,
				columns: rebasedBoard.columns.map((column) => {
					if (column.id !== localColumn.id) {
						return column;
					}
					const insertAtIndex = Math.min(localCardIndex, column.cards.length);
					return {
						...column,
						cards: [...column.cards.slice(0, insertAtIndex), localCard, ...column.cards.slice(insertAtIndex)],
					};
				}),
			};
		});
	}

	// 2. 列内重排。
	for (const localColumn of localBoard.columns) {
		const ancestorColumn = boardLastConfirmedPersistedByRuntime.columns.find(
			(column) => column.id === localColumn.id,
		);
		const hydratedRuntimeColumn = hydratedRuntimeBoard.columns.find((column) => column.id === localColumn.id);
		const rebasedColumn = rebasedBoard.columns.find((column) => column.id === localColumn.id);
		if (!ancestorColumn || !hydratedRuntimeColumn || !rebasedColumn) {
			continue;
		}
		const localOrder = localColumn.cards.map((card) => card.id);
		const ancestorOrder = ancestorColumn.cards.map((card) => card.id);
		const hydratedRuntimeOrder = hydratedRuntimeColumn.cards.map((card) => card.id);
		const rebasedOrder = rebasedColumn.cards.map((card) => card.id);
		const wasReorderedLocally =
			localOrder.length === ancestorOrder.length &&
			haveSameMembers(localOrder, ancestorOrder) &&
			!haveSameOrder(localOrder, ancestorOrder);
		// 服务端也会重排这一列（taskCardAction 允许 in_progress 等列内重排落盘）：只有服务端这一列仍与祖先逐位一致、
		// 即服务端没碰过它的顺序与成员时，才重放本地顺序；服务端也动过就默认服务端赢，否则随后的整板保存会覆盖已落盘的顺序。
		const isHydratedRuntimeColumnOrderStillAncestorOrder = haveSameOrder(hydratedRuntimeOrder, ancestorOrder);
		if (
			!wasReorderedLocally ||
			!isHydratedRuntimeColumnOrderStillAncestorOrder ||
			!haveSameMembers(localOrder, rebasedOrder) ||
			haveSameOrder(localOrder, rebasedOrder)
		) {
			continue;
		}
		const rebasedCardById = new Map(rebasedColumn.cards.map((card) => [card.id, card]));
		const reorderedCards = localOrder.flatMap((taskId) => {
			const card = rebasedCardById.get(taskId);
			return card ? [card] : [];
		});
		rebasedBoard = {
			...rebasedBoard,
			columns: rebasedBoard.columns.map((column) =>
				column.id === localColumn.id ? { ...column, cards: reorderedCards } : column,
			),
		};
	}
	return rebasedBoard;
}

function collectTaskIds(board: BoardData): Set<string> {
	return new Set(board.columns.flatMap((column) => column.cards.map((card) => card.id)));
}

function haveSameMembers(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const rightSet = new Set(right);
	return left.every((taskId) => rightSet.has(taskId));
}

function haveSameOrder(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}
