import type { RuntimeBoardData } from "./api-contract";

// 旧页面不认识名称版本；整板保存仍须保留手改历史，防止改回原名后被迟到 AI 结果覆盖。
export function preserveTaskNameVersionsAgainstIncomingBoardSnapshot(
	persisted: RuntimeBoardData,
	incoming: RuntimeBoardData,
): RuntimeBoardData {
	const previousById = new Map(persisted.columns.flatMap((column) => column.cards).map((card) => [card.id, card]));
	return {
		...incoming,
		columns: incoming.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => {
				const previous = previousById.get(card.id);
				if (!previous || previous.createdAt !== card.createdAt) return card;
				const previousVersion = previous.taskNameVersion ?? 0;
				const incomingVersion = card.taskNameVersion ?? 0;
				return {
					...card,
					taskNameVersion: Math.max(previousVersion + (card.title !== previous.title ? 1 : 0), incomingVersion),
				};
			}),
		})),
	};
}
