import type { BoardCard, BoardColumn, BoardColumnId, BoardDisplayGroup, BoardDisplayGroupId } from "@/types";

export function projectTaskBoardDisplayGroups(columns: readonly BoardColumn[]): BoardDisplayGroup[] {
	const originalStageByTaskId = new Map(
		columns.flatMap((column) => column.cards.map((card) => [card.id, column.id] as const)),
	);
	const shelvedCards = columns.flatMap((column) => column.cards.filter((card) => card.taskShelvingState?.isShelved));
	shelvedCards.sort(
		(left, right) =>
			(right.taskShelvingState?.lastChangedAt ?? 0) - (left.taskShelvingState?.lastChangedAt ?? 0) ||
			left.id.localeCompare(right.id),
	);
	return [
		...columns.map((column) => ({
			...column,
			cards: column.cards.filter((card) => !card.taskShelvingState?.isShelved),
			originalStageByTaskId,
		})),
		{ id: "shelved", title: "Shelved", cards: shelvedCards, originalStageByTaskId },
	];
}

export function resolveTaskCardOriginalStage(group: BoardDisplayGroup, card: BoardCard): BoardColumnId {
	const originalStage = group.id === "shelved" ? group.originalStageByTaskId?.get(card.id) : group.id;
	if (!originalStage) throw new Error(`任务 ${card.id} 缺少原 Stage。`);
	return originalStage;
}

export function findTaskDisplayGroupId(columns: readonly BoardColumn[], taskId: string): BoardDisplayGroupId | null {
	for (const column of columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) return card.taskShelvingState?.isShelved ? "shelved" : column.id;
	}
	return null;
}
