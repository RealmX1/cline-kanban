import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskImage } from "./api-contract";

// Backlog 卡片的「Description 最后更新时间」：只在 Description 内容（prompt 文本 + 附图）真正变化时推进，
// 与通用的 `updatedAt`（任何用户可见修改——改标题 / 改 agent / 移列 / 加评论……都推进）刻意分开。
// 本文件是运行时与前端共用的唯一定义点：回落语义、「内容是否变化」判据、Backlog 排序都只在这里写一次。

// 老卡片（本字段出现之前建的）没有该字段：回落到 `updatedAt`，不回落到 `createdAt`——编辑过的老 backlog 卡，
// `updatedAt` 才最接近真实的编辑时间；没编辑过的，`updatedAt` ≈ `createdAt`。绝不回落到 now：
// 那会让每次水合都把老卡刷成「刚更新」，打乱 Backlog 顺序。
export function resolveTaskDescriptionLastUpdatedAt(
	card: Pick<RuntimeBoardCard, "taskDescriptionLastUpdatedAt" | "updatedAt">,
): number {
	return card.taskDescriptionLastUpdatedAt ?? card.updatedAt;
}

function areTaskImageListsIdenticalById(
	previousImages: ReadonlyArray<Pick<RuntimeTaskImage, "id">> | undefined,
	nextImages: ReadonlyArray<Pick<RuntimeTaskImage, "id">> | undefined,
): boolean {
	const previous = previousImages ?? [];
	const next = nextImages ?? [];
	return previous.length === next.length && previous.every((image, index) => image.id === next[index]?.id);
}

// 附图与文本在同一个 prompt composer 里编辑、作为任务内容一起发给 agent，所以算 Description 的一部分。
// 图片按 id 序列比较（`undefined` 与 `[]` 等价）；调用方传入的 prompt 应已 trim，与卡片上存的形态一致。
export function hasTaskDescriptionContentChanged(input: {
	previousPrompt: string;
	previousImages: ReadonlyArray<Pick<RuntimeTaskImage, "id">> | undefined;
	nextPrompt: string;
	nextImages: ReadonlyArray<Pick<RuntimeTaskImage, "id">> | undefined;
}): boolean {
	return (
		input.previousPrompt !== input.nextPrompt ||
		!areTaskImageListsIdenticalById(input.previousImages, input.nextImages)
	);
}

// 在**状态层**保持 Backlog 数组有序，而不是渲染时排序：两个宿主（主看板 / Focus View）的 Draggable index
// 必须等于真实数组索引，只在显示层排序会让拖拽 splice 到错的卡。数组本身有序后，两个宿主、「Start all」、
// CLI 看到的顺序天然一致。稳定排序：同值保持原次序（批量建卡同一毫秒时的顺序不变）。已有序时返回原引用，
// 避免无意义的重渲染与落盘。
// EXPERIMENT_NODE: Backlog 排序键暂用 description 最后更新时间倒序（用户说「暂时」），未来可能换回手动或优先级排序
export function sortBacklogColumnCardsByTaskDescriptionLastUpdatedAtDescending(
	board: RuntimeBoardData,
): RuntimeBoardData {
	const backlogColumnIndex = board.columns.findIndex((column) => column.id === "backlog");
	const backlogColumn = board.columns[backlogColumnIndex];
	if (!backlogColumn) {
		return board;
	}
	const sortedCards = [...backlogColumn.cards].sort(
		(left, right) => resolveTaskDescriptionLastUpdatedAt(right) - resolveTaskDescriptionLastUpdatedAt(left),
	);
	if (sortedCards.every((card, index) => card === backlogColumn.cards[index])) {
		return board;
	}
	const columns = [...board.columns];
	columns[backlogColumnIndex] = { ...backlogColumn, cards: sortedCards };
	return { ...board, columns };
}
