import { TRPCError } from "@trpc/server";
import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskStickerEntryMutation } from "./api-contract";

/** 整板保存可以移列或编辑任务，但便签只接受逐条写入，旧浏览器快照不能覆盖它们。 */
export function preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot(
	persistedBoard: RuntimeBoardData,
	incomingBoard: RuntimeBoardData,
): RuntimeBoardData {
	const persistedCards = new Map(
		persistedBoard.columns.flatMap((column) => column.cards.map((card) => [card.id, card] as const)),
	);
	return {
		...incomingBoard,
		columns: incomingBoard.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => {
				const persisted = persistedCards.get(card.id);
				if (!persisted || persisted.createdAt !== card.createdAt) return card;
				return {
					...card,
					taskStickerEntries: persisted.taskStickerEntries,
					taskStickerDeletedEntryIds: persisted.taskStickerDeletedEntryIds,
				};
			}),
		})),
	};
}

/** 只改指定便签，不推进任务活动、描述排序或会话已读状态。必须在最新 board 的持久化锁内调用。 */
export function applyTaskStickerEntryMutationToTaskCard(
	card: RuntimeBoardCard,
	mutation: RuntimeTaskStickerEntryMutation,
	timestamp: number,
): RuntimeBoardCard {
	const entries = card.taskStickerEntries ?? [];
	const existing = entries.find((entry) => entry.taskStickerEntryId === mutation.taskStickerEntryId);
	if (mutation.operation === "create") {
		// ID 由创建方生成并在重试中复用。即使之后正文已修改或条目已删除，也不能重放创建。
		if (existing || card.taskStickerDeletedEntryIds?.includes(mutation.taskStickerEntryId)) return card;
		return {
			...card,
			taskStickerEntries: [
				...entries,
				{
					taskStickerEntryId: mutation.taskStickerEntryId,
					stickerText: mutation.stickerText,
					isCollapsed: false,
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
		};
	}
	if (!existing) {
		if (mutation.operation === "delete") return card;
		throw new TRPCError({ code: "CONFLICT", message: "这张便签已被删除，草稿已保留。" });
	}
	if (mutation.operation === "set_collapsed") {
		if (existing.isCollapsed === mutation.isCollapsed) return card;
		return {
			...card,
			taskStickerEntries: entries.map((entry) =>
				entry === existing
					? { ...entry, isCollapsed: mutation.isCollapsed, updatedAt: Math.max(timestamp, entry.updatedAt + 1) }
					: entry,
			),
		};
	}
	if (mutation.operation === "update_text" && existing.stickerText === mutation.stickerText) return card;
	if (existing.stickerText !== mutation.expectedStickerText) {
		throw new TRPCError({ code: "CONFLICT", message: "这张便签已被修改，草稿已保留。请核对最新正文后重试。" });
	}
	if (mutation.operation === "delete") {
		return {
			...card,
			taskStickerEntries: entries.filter((entry) => entry !== existing),
			taskStickerDeletedEntryIds: [...(card.taskStickerDeletedEntryIds ?? []), mutation.taskStickerEntryId],
		};
	}
	return {
		...card,
		taskStickerEntries: entries.map((entry) =>
			entry === existing
				? { ...entry, stickerText: mutation.stickerText, updatedAt: Math.max(timestamp, entry.updatedAt + 1) }
				: entry,
		),
	};
}
