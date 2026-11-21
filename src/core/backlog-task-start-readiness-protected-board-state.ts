import type { RuntimeBoardData } from "./api-contract";

// 整板快照没有启动授权；只有服务端卡片动作可以在复核后移出 Backlog。
export function preserveBacklogTaskStartReadinessAgainstClientBoardSnapshot(
	previous: RuntimeBoardData,
	incoming: RuntimeBoardData,
): RuntimeBoardData {
	const backlog = new Map(
		previous.columns.find((column) => column.id === "backlog")?.cards.map((card) => [card.id, card]) ?? [],
	);
	const restored: RuntimeBoardData["columns"][number]["cards"] = [];
	const columns = incoming.columns.map((column) => ({
		...column,
		cards: column.cards.flatMap((card) => {
			const original = backlog.get(card.id);
			if (original?.createdAt !== card.createdAt) return [card];
			const protectedCard = {
				...card,
				backlogTaskStartReadinessReview: original.backlogTaskStartReadinessReview,
				backlogTaskCreationRepositoryBaseline: original.backlogTaskCreationRepositoryBaseline,
				backlogTaskStartReadinessExecutionRevision: original.backlogTaskStartReadinessExecutionRevision,
			};
			if (column.id === "backlog") return [protectedCard];
			restored.push(protectedCard);
			return [];
		}),
	}));
	columns.find((column) => column.id === "backlog")?.cards.push(...restored);
	return { ...incoming, columns };
}
