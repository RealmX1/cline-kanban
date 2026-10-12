import type { BoardColumn, BoardColumnId, BoardData } from "@/types";

const columnOrder: Array<{ id: BoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "validation", title: "Validation" },
	{ id: "trash", title: "Done" },
];

// 列 id → 用户可见的 stage 名（trash 显示为 Done）。跨项目视图拿不到别的项目的 board 列对象时用它。
export function resolveBoardColumnTitle(columnId: BoardColumnId): string {
	return columnOrder.find((column) => column.id === columnId)?.title ?? columnId;
}

function createEmptyColumn(id: BoardColumnId, title: string): BoardColumn {
	return {
		id,
		title,
		cards: [],
	};
}

export function createInitialBoardData(): BoardData {
	return {
		columns: columnOrder.map((column) => createEmptyColumn(column.id, column.title)),
	};
}
