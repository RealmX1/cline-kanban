import type { RuntimeBoardData } from "./api-contract";

/** 结案只能经生命周期动作。旧整板保存不能清除摘要、复活旧操作、删卡或直接改变结案状态。 */
export function preserveRuntimeOwnedTaskClosureState(
	persisted: RuntimeBoardData,
	incoming: RuntimeBoardData,
): RuntimeBoardData {
	const previous = new Map(
		persisted.columns.flatMap((column) =>
			column.cards.map((card) => [card.id, { card, columnId: column.id }] as const),
		),
	);
	const columns = incoming.columns.map((column) => ({
		...column,
		title: column.id === "trash" ? "已结案" : column.title,
		cards: column.cards.flatMap((card) => {
			const old = previous.get(card.id);
			if (!old) return column.id === "trash" ? [] : [card];
			if (old.card.createdAt !== card.createdAt) return [];
			const crossesClosureBoundary = (old.columnId === "trash") !== (column.id === "trash");
			if (crossesClosureBoundary) return [];
			return [
				{
					...card,
					taskClosureSummary: old.card.taskClosureSummary,
					taskClosureOperationProgress: old.card.taskClosureOperationProgress,
				},
			];
		}),
	}));
	for (const old of previous.values()) {
		if (
			!columns.some((column) =>
				column.cards.some((card) => card.id === old.card.id && card.createdAt === old.card.createdAt),
			)
		)
			columns.find((column) => column.id === old.columnId)?.cards.push(old.card);
	}
	return { ...incoming, columns };
}
