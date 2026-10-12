import { isPinnedToTaskPinboard } from "@runtime-task-pinboard-pinning";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

/**
 * Task Pinboard（置顶板）在当前项目 board 上的收集。置顶 / 取消置顶 / 改原因这些改写函数已下沉到
 * `src/core/task-pinboard-pinning.ts`（经 `@runtime-task-pinboard-pinning` 引用），runtime 跨项目置顶共用同一份。
 */

/** 置顶板里的一条：分身卡片本身 + 它真正所在的 stage（分身上的 stage 标签与「跳回原卡」都要用）。 */
export interface TaskPinnedToTaskPinboard {
	card: BoardCard;
	columnId: BoardColumnId;
	columnTitle: string;
}

/**
 * 收集全盘已置顶的任务，按置顶时间**倒序**（最近置顶的排在最前）。
 *
 * 刻意不按 stage 分组：分身上已经带了 stage 标签，再分组只会让「我最近盯上的那个」下沉到某一组里。
 * 时间戳相同时（同一毫秒内连点两张）回落到任务 id 排序，保证渲染顺序稳定、不随 map 遍历抖动。
 */
export function collectTasksPinnedToTaskPinboard(board: BoardData): TaskPinnedToTaskPinboard[] {
	const pinnedTasks: TaskPinnedToTaskPinboard[] = [];
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (!isPinnedToTaskPinboard(card)) {
				continue;
			}
			pinnedTasks.push({ card, columnId: column.id, columnTitle: column.title });
		}
	}
	pinnedTasks.sort((left, right) => {
		const pinnedAtDifference = (right.card.pinnedToTaskPinboardAt ?? 0) - (left.card.pinnedToTaskPinboardAt ?? 0);
		if (pinnedAtDifference !== 0) {
			return pinnedAtDifference;
		}
		return left.card.id.localeCompare(right.card.id);
	});
	return pinnedTasks;
}
