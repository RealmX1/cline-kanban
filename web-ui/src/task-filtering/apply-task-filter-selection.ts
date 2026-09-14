import type { RuntimeAgentId } from "@/runtime/types";
import {
	resolveTaskLastModifiedFilterWindowDurationMs,
	type TaskFilterSelection,
	type TaskSessionActivityFilterCategory,
} from "@/task-filtering/task-filter-selection";
import type { BoardColumnId } from "@/types";

/**
 * 过滤判据所需的、与「行长什么样」无关的最小事实。调用方负责把自己的行（Spotlight 结果、看板卡片、
 * 概览行……）投影成这个形状，过滤本身因此不依赖任何具体界面的数据结构。
 */
export interface FilterableTaskDescriptor {
	projectId: string;
	columnId: BoardColumnId;
	/** 该任务此刻的有效 agent；未知为 null（例如跨项目行既没有活会话、卡片也没设 per-task 覆盖）。 */
	agentId: RuntimeAgentId | null;
	/** 卡片的 `updatedAt`：建卡 / 跨列移动 / 用户编辑才 bump，**不是** agent 活跃时间。 */
	taskLastModifiedAtEpochMs: number;
	/**
	 * 会话状态分类；**null = 这一行的会话状态结构性不可知**（跨项目行：会话只经当前 workspace 的推流可得）。
	 * 注意与 `"no_live_session"` 的区别：那是「查过了，确实没有会话」，这里是「根本查不到」。
	 * 二者混为一谈就会让「筛选无会话的任务」把一堆状态未知的跨项目任务一并捞进来。
	 */
	sessionActivityCategory: TaskSessionActivityFilterCategory | null;
}

export interface TaskFilterApplicationResult<TRow> {
	filteredRows: TRow[];
	/**
	 * 因「会话状态维度已启用、但这一行的会话状态不可知」而被排除的行数。
	 * 调用方必须把它讲给用户听（照 `taskIdMatchedResultCountHiddenByStageSelection` 那条诚实空态的做法）：
	 * 否则用户勾了「Needs your input」却看不到别的项目的任务，会以为那些任务不存在，而不是「这里判不了」。
	 */
	rowCountExcludedBecauseSessionActivityIsNotObservable: number;
}

/**
 * 除会话状态外的四个维度。单独拆出来是为了让「这一行只差会话状态判不了」与「这一行本来就被别的维度筛掉」
 * 可区分——否则那条解释性计数会把一堆本就落选的行也算进去，用户读到的是个虚高的数字。
 */
function matchesTaskFilterSelectionExceptSessionActivity(
	descriptor: FilterableTaskDescriptor,
	selection: TaskFilterSelection,
	nowEpochMs: number,
): boolean {
	if (selection.selectedStageColumnIds.size > 0 && !selection.selectedStageColumnIds.has(descriptor.columnId)) {
		return false;
	}
	if (selection.selectedProjectIds.size > 0 && !selection.selectedProjectIds.has(descriptor.projectId)) {
		return false;
	}
	if (selection.selectedAgentIds.size > 0) {
		// agent 未知的行匹配不上任何被选中的 agent —— 落选，不做「未知即通过」的宽大处理。
		if (!descriptor.agentId || !selection.selectedAgentIds.has(descriptor.agentId)) {
			return false;
		}
	}
	const windowDurationMs = resolveTaskLastModifiedFilterWindowDurationMs(selection.lastModifiedWindow);
	if (windowDurationMs !== null && nowEpochMs - descriptor.taskLastModifiedAtEpochMs > windowDurationMs) {
		return false;
	}
	return true;
}

/**
 * 把过滤选择应用到任意一组行上。纯函数：无 React、无界面假设、无 `Date.now()`（`nowEpochMs` 由调用方传入，
 * 这样时间窗维度也可被确定性地单测）。
 *
 * 各维度之间是**且**（AND）关系，维度内部的多选之间是**或**（OR）关系 —— 即「Backlog 或 Review 的、
 * 且由 claude 跑的、且 7 天内改过的任务」。这正是用户要的「多种分类维度单独或一同 filtering」。
 *
 * 行顺序原样保留：排序是排序层的职责，过滤只做减法。
 */
export function applyTaskFilterSelection<TRow>({
	rows,
	selection,
	describeRow,
	nowEpochMs,
}: {
	rows: readonly TRow[];
	selection: TaskFilterSelection;
	describeRow: (row: TRow) => FilterableTaskDescriptor;
	nowEpochMs: number;
}): TaskFilterApplicationResult<TRow> {
	const filteredRows: TRow[] = [];
	let rowCountExcludedBecauseSessionActivityIsNotObservable = 0;
	const isSessionActivityDimensionActive = selection.selectedSessionActivityCategories.size > 0;
	for (const row of rows) {
		const descriptor = describeRow(row);
		if (!matchesTaskFilterSelectionExceptSessionActivity(descriptor, selection, nowEpochMs)) {
			continue;
		}
		if (!isSessionActivityDimensionActive) {
			filteredRows.push(row);
			continue;
		}
		if (descriptor.sessionActivityCategory === null) {
			rowCountExcludedBecauseSessionActivityIsNotObservable += 1;
			continue;
		}
		if (selection.selectedSessionActivityCategories.has(descriptor.sessionActivityCategory)) {
			filteredRows.push(row);
		}
	}
	return { filteredRows, rowCountExcludedBecauseSessionActivityIsNotObservable };
}
