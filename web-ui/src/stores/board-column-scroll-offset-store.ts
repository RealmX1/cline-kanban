/**
 * 看板每一列的滚动位置与渐进渲染进度的进程内记忆。
 *
 * 存在理由：打开 Focus View 时看板整棵子树会真正卸载（此前是 `visibility: hidden`，
 * 盒子仍在，DependencyOverlay 的强制回流照样要遍历全部卡片，两个 `DragDropContext`
 * 也同时挂载）。卸载解决了那些成本，代价是列的 `scrollTop` 和「已展开到第几批」会随
 * DOM 一起消失——用户从详情页返回时会被弹回列顶。这里把这两个值留在模块级 Map 里补回来。
 *
 * 刻意不落 localStorage：这是同一次浏览会话内的导航连续性，不是需要跨会话保留的偏好。
 */

interface BoardColumnScrollOffsetRecord {
	scrollTop: number;
	/** 该列在卸载前已渐进渲染到的卡片数量，用于重新挂载时一次性还原、避免又从前 10 张开始。 */
	revealedCardCount: number;
}

const recordsByColumnKey = new Map<string, BoardColumnScrollOffsetRecord>();

/**
 * 记忆按 project + column 分键：不同 project 的同名列（backlog/in_progress/…）
 * 各自独立，切 project 后不会串用上一个 project 的滚动位置。
 */
function buildColumnKey(workspaceKey: string | null, columnId: string): string {
	return `${workspaceKey ?? "no-workspace"}::${columnId}`;
}

export function readBoardColumnScrollOffset(
	workspaceKey: string | null,
	columnId: string,
): BoardColumnScrollOffsetRecord | undefined {
	return recordsByColumnKey.get(buildColumnKey(workspaceKey, columnId));
}

export function writeBoardColumnScrollOffset(
	workspaceKey: string | null,
	columnId: string,
	record: BoardColumnScrollOffsetRecord,
): void {
	// 损坏值（NaN / 负数）一旦入记忆，重挂载时会被原样还原回 DOM，直接拒写。
	if (
		!Number.isFinite(record.scrollTop) ||
		record.scrollTop < 0 ||
		!Number.isFinite(record.revealedCardCount) ||
		record.revealedCardCount < 0
	) {
		return;
	}
	const key = buildColumnKey(workspaceKey, columnId);
	// 滚动经 rAF 折叠后仍是每帧一次的高频写：值没变就保留原记录，不做无意义替换。
	const existing = recordsByColumnKey.get(key);
	if (existing && existing.scrollTop === record.scrollTop && existing.revealedCardCount === record.revealedCardCount) {
		return;
	}
	recordsByColumnKey.set(key, record);
}

/** 测试用：清空全部记忆。 */
export function clearAllBoardColumnScrollOffsets(): void {
	recordsByColumnKey.clear();
}
