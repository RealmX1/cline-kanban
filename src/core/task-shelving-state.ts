import type { RuntimeBoardData } from "./api-contract";

export interface TaskShelvingState {
	isShelved: boolean;
	lastChangedAt: number;
}

export function isTaskCardShelved(card: { taskShelvingState?: TaskShelvingState }): boolean {
	return card.taskShelvingState?.isShelved === true;
}

/** 搁置只改变独立状态，保留 Stage、置顶、会话和任务内容时间。 */
export function setTaskCardShelvingState(
	board: RuntimeBoardData,
	taskId: string,
	isShelved: boolean,
	now: number = Date.now(),
): { board: RuntimeBoardData; updated: boolean } {
	let updated = false;
	const columns = board.columns.map((column) => {
		const cards = column.cards.map((card) => {
			if (card.id !== taskId || isTaskCardShelved(card) === isShelved) return card;
			updated = true;
			return {
				...card,
				taskShelvingState: {
					isShelved,
					lastChangedAt: Math.max(now, (card.taskShelvingState?.lastChangedAt ?? 0) + 1),
				},
			};
		});
		return cards.some((card, index) => card !== column.cards[index]) ? { ...column, cards } : column;
	});
	return updated ? { board: { ...board, columns }, updated } : { board, updated };
}

/** 整板快照不拥有搁置状态；旧浏览器也不能移走或漏存搁置卡。 */
export function preservePersistedTaskShelvingAgainstIncomingBoardSnapshot(
	persistedBoard: RuntimeBoardData,
	incomingBoard: RuntimeBoardData,
): RuntimeBoardData {
	const persistedCards = new Map(
		persistedBoard.columns.flatMap((column) =>
			column.cards.map((card) => [card.id, { card, columnId: column.id }] as const),
		),
	);
	const incomingCards = new Map(
		incomingBoard.columns.flatMap((column) => column.cards.map((card) => [card.id, card])),
	);
	const mustPreserveStageByTaskId = new Set<string>();
	for (const [taskId, { card }] of persistedCards) {
		const incomingCard = incomingCards.get(taskId);
		if (
			isTaskCardShelved(card) ||
			(card.taskShelvingState &&
				incomingCard &&
				(incomingCard.createdAt !== card.createdAt ||
					incomingCard.taskShelvingState?.lastChangedAt !== card.taskShelvingState.lastChangedAt ||
					incomingCard.taskShelvingState?.isShelved !== card.taskShelvingState.isShelved))
		)
			mustPreserveStageByTaskId.add(taskId);
	}
	return {
		...incomingBoard,
		columns: incomingBoard.columns.map((column) => {
			const cards = column.cards
				.filter((card) => {
					const persisted = persistedCards.get(card.id);
					return !persisted || !mustPreserveStageByTaskId.has(card.id) || persisted.columnId === column.id;
				})
				.map((card) => {
					const persisted = persistedCards.get(card.id);
					if (!persisted) return card;
					if (persisted.card.createdAt !== card.createdAt)
						return persisted.card.taskShelvingState ? persisted.card : card;
					return { ...card, taskShelvingState: persisted.card.taskShelvingState };
				});
			for (const persisted of persistedCards.values()) {
				if (
					persisted.columnId !== column.id ||
					!mustPreserveStageByTaskId.has(persisted.card.id) ||
					cards.some((card) => card.id === persisted.card.id)
				)
					continue;
				const incoming = incomingCards.get(persisted.card.id);
				cards.push({
					...(incoming?.createdAt === persisted.card.createdAt ? incoming : persisted.card),
					taskShelvingState: persisted.card.taskShelvingState,
				});
			}
			return { ...column, cards };
		}),
	};
}
