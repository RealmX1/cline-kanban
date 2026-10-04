import type { BoardCard, BoardColumnId, BoardData } from "@/types";

/**
 * 卡片动作改走服务端（`taskCardAction.*`）之后，浏览器不再直接改那份会被整板保存的 `board`。为了不让用户点完按钮
 * 要等一个往返才看到卡片移动，命令在途期间在渲染层叠一层**不持久化**的 overlay：`displayedBoard = apply(board, overlay)`。
 * 服务端写成后广播回灌，`board` 自己就满足了期望，overlay 条目随之退场。
 *
 * 只用于当前项目（其他项目的 board 不在浏览器内存里，那边只显示在途 spinner）；切项目时整体清空。
 * 纯函数，无状态；条目的生命周期由 use-task-card-action-handler-bundle-factory 管理。
 */
export type PendingTaskCardCommandExpectedBoardEffect =
	| {
			pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column";
			targetBoardColumnId: BoardColumnId;
			// 拖放落点；缺省放到目标列顶部（与浏览器既有的「移列即置顶」一致）。
			insertAtIndex?: number;
	  }
	| {
			pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched";
			taskCardFieldPatch: Partial<Omit<BoardCard, "id">>;
	  }
	| {
			pendingTaskCardCommandExpectedBoardEffectKind: "task_card_removed_from_board";
	  };

export interface PendingTaskCardCommandBoardOverlayEntry {
	// 每条命令一个，结算时按它删除（同一张卡可能先后挂两条，例如改名后立刻移列）。
	pendingTaskCardCommandOverlayEntryId: string;
	taskId: string;
	expectedBoardEffect: PendingTaskCardCommandExpectedBoardEffect;
}

function findTaskCardLocation(
	board: BoardData,
	taskId: string,
): { columnIndex: number; cardIndex: number; card: BoardCard } | null {
	for (let columnIndex = 0; columnIndex < board.columns.length; columnIndex += 1) {
		const cardIndex = board.columns[columnIndex]?.cards.findIndex((card) => card.id === taskId) ?? -1;
		if (cardIndex >= 0) {
			const card = board.columns[columnIndex]?.cards[cardIndex];
			if (card) {
				return { columnIndex, cardIndex, card };
			}
		}
	}
	return null;
}

function applyOnePendingTaskCardCommandBoardOverlayEntry(
	board: BoardData,
	entry: PendingTaskCardCommandBoardOverlayEntry,
): BoardData {
	const location = findTaskCardLocation(board, entry.taskId);
	if (!location) {
		// 卡已不在（被别处删除、或本就是删除命令且已回灌）：overlay 不凭空造卡。
		return board;
	}
	const effect = entry.expectedBoardEffect;
	switch (effect.pendingTaskCardCommandExpectedBoardEffectKind) {
		case "task_card_removed_from_board":
			return {
				...board,
				columns: board.columns.map((column, columnIndex) =>
					columnIndex === location.columnIndex
						? { ...column, cards: column.cards.filter((card) => card.id !== entry.taskId) }
						: column,
				),
			};
		case "task_card_fields_patched":
			return {
				...board,
				columns: board.columns.map((column, columnIndex) =>
					columnIndex === location.columnIndex
						? {
								...column,
								cards: column.cards.map((card) =>
									card.id === entry.taskId ? { ...card, ...effect.taskCardFieldPatch } : card,
								),
							}
						: column,
				),
			};
		case "task_card_moved_into_board_column": {
			const sourceColumn = board.columns[location.columnIndex];
			if (sourceColumn?.id === effect.targetBoardColumnId && effect.insertAtIndex === undefined) {
				return board;
			}
			const columnsWithoutCard = board.columns.map((column, columnIndex) =>
				columnIndex === location.columnIndex
					? { ...column, cards: column.cards.filter((card) => card.id !== entry.taskId) }
					: column,
			);
			return {
				...board,
				columns: columnsWithoutCard.map((column) => {
					if (column.id !== effect.targetBoardColumnId) {
						return column;
					}
					const insertAtIndex = Math.max(0, Math.min(effect.insertAtIndex ?? 0, column.cards.length));
					return {
						...column,
						cards: [...column.cards.slice(0, insertAtIndex), location.card, ...column.cards.slice(insertAtIndex)],
					};
				}),
			};
		}
	}
}

// 按登记顺序叠加。没有条目时原样返回同一引用（渲染层据此跳过重算）。
export function applyPendingTaskCardCommandBoardOverlay(
	board: BoardData,
	entries: readonly PendingTaskCardCommandBoardOverlayEntry[],
): BoardData {
	let displayedBoard = board;
	for (const entry of entries) {
		displayedBoard = applyOnePendingTaskCardCommandBoardOverlayEntry(displayedBoard, entry);
	}
	return displayedBoard;
}

// 回灌的 board 是否已经体现了这条命令的效果。满足即可删掉 overlay 条目——此后显示的就是服务端真相。
// 不带落点的移列只认列成员、不认落点：服务端按自己的规则排序，非要等到落点一致，overlay 可能永远退不了场。
// 带落点（拖放，含同列重排）时还要比较落点：同列重排时命令发出前那份未变化的 board 就已满足列成员，只认成员会让
// overlay 在服务端落盘前退场、乐观顺序闪回旧顺序。服务端移列与列内重排都按同一夹取语义保留落点；并发写入挪动了
// 落点时，条目由命令结算兜底退场。
export function isPendingTaskCardCommandExpectedBoardEffectSatisfiedByBoard(
	board: BoardData,
	entry: PendingTaskCardCommandBoardOverlayEntry,
): boolean {
	const location = findTaskCardLocation(board, entry.taskId);
	const effect = entry.expectedBoardEffect;
	switch (effect.pendingTaskCardCommandExpectedBoardEffectKind) {
		case "task_card_removed_from_board":
			return location === null;
		case "task_card_moved_into_board_column": {
			if (location === null) {
				return false;
			}
			const boardColumnHoldingTaskCard = board.columns[location.columnIndex];
			if (!boardColumnHoldingTaskCard || boardColumnHoldingTaskCard.id !== effect.targetBoardColumnId) {
				return false;
			}
			if (effect.insertAtIndex === undefined) {
				return true;
			}
			// 与 apply 分支同一索引语义：先把卡从目标列拿掉，再按夹取到「移除自身后的列长」的落点插回。
			const targetBoardColumnCardCountWithoutTaskCard = boardColumnHoldingTaskCard.cards.length - 1;
			const expectedTaskCardIndexWithinTargetBoardColumn = Math.max(
				0,
				Math.min(effect.insertAtIndex, targetBoardColumnCardCountWithoutTaskCard),
			);
			return location.cardIndex === expectedTaskCardIndexWithinTargetBoardColumn;
		}
		case "task_card_fields_patched":
			return (
				location !== null &&
				Object.entries(effect.taskCardFieldPatch).every(
					([fieldName, expectedValue]) =>
						JSON.stringify(location.card[fieldName as keyof BoardCard]) === JSON.stringify(expectedValue),
				)
			);
	}
}
