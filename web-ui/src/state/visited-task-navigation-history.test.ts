import { describe, expect, it } from "vitest";
import {
	createEmptyVisitedTaskNavigationHistory,
	findAdjacentAvailableVisitedTaskPathIndex,
	parseVisitedTaskNavigationHistory,
	recordVisitedTask,
	refreshVisitedTaskHistoryEntry,
	setVisitedTaskUnavailable,
	type VisitedTaskHistoryEntry,
	visitTaskAtHistoryPathIndex,
} from "@/state/visited-task-navigation-history";

function entry(taskId: string, workspaceId = "project-a", incarnation = 1): VisitedTaskHistoryEntry {
	return {
		workspaceId,
		taskId,
		taskIncarnationCreatedAtEpochMs: incarnation,
		titleSnapshot: taskId,
		projectNameSnapshot: workspaceId,
		lastVisitedAtEpochMs: 10,
		unavailable: false,
	};
}

function historyOf(...entries: VisitedTaskHistoryEntry[]) {
	return entries.reduce(recordVisitedTask, createEmptyVisitedTaskNavigationHistory());
}

describe("已访问任务导航历史", () => {
	it("后退后普通访问截断前进路径，但保留最近列表中的原任务", () => {
		const history = historyOf(entry("a"), entry("b"), entry("c"));
		const wentBack = visitTaskAtHistoryPathIndex(history, 1, entry("b"));
		const branched = recordVisitedTask(wentBack, entry("d"));
		expect(branched.navigationPath.map((task) => task.taskId)).toEqual(["a", "b", "d"]);
		expect(branched.recentTasks.map((task) => task.taskId)).toEqual(["d", "b", "c", "a"]);
		expect(branched.cursor).toBe(2);
		expect(history.cursor).toBe(2);
	});

	it("连续访问相同身份不增加路径，非连续访问可回退，列表按身份去重", () => {
		const history = historyOf(entry("a"), entry("a"), entry("b"), entry("a"));
		expect(history.navigationPath.map((task) => task.taskId)).toEqual(["a", "b", "a"]);
		expect(history.recentTasks.map((task) => task.taskId)).toEqual(["a", "b"]);
		expect(historyOf(entry("same", "one"), entry("same", "two"), entry("same", "one", 2)).recentTasks).toHaveLength(
			3,
		);
	});

	it("历史跳转更新最近排序而不追加路径，边界不循环并跳过确认失效的任务", () => {
		let history = historyOf(entry("a"), entry("b"), entry("c"));
		history = setVisitedTaskUnavailable(history, entry("b"));
		expect(findAdjacentAvailableVisitedTaskPathIndex(history, -1)).toBe(0);
		expect(findAdjacentAvailableVisitedTaskPathIndex(history, 1)).toBeNull();
		history = visitTaskAtHistoryPathIndex(history, 0, entry("a"));
		expect(history.navigationPath).toHaveLength(3);
		expect(history.recentTasks[0]?.taskId).toBe("a");
		expect(findAdjacentAvailableVisitedTaskPathIndex(history, -1)).toBeNull();
		expect(findAdjacentAvailableVisitedTaskPathIndex(history, 1)).toBe(2);
	});

	it("最近列表和路径分别最多 200 条且游标保持有效", () => {
		let history = createEmptyVisitedTaskNavigationHistory();
		for (let index = 0; index < 205; index++) history = recordVisitedTask(history, entry(String(index)));
		expect(history.recentTasks).toHaveLength(200);
		expect(history.navigationPath).toHaveLength(200);
		expect(history.navigationPath[0]?.taskId).toBe("5");
		expect(history.cursor).toBe(199);
	});

	it("迁移确认后合并相邻的同一任务，非相邻重复仍保留", () => {
		const visited = historyOf(entry("x", "a"), entry("x", "b"), entry("y", "a"), entry("x", "a"));
		const replacement = { ...entry("x", "a"), workspaceIdsUsedByTaskIncarnation: ["a", "b"] };
		const refreshed = refreshVisitedTaskHistoryEntry(
			visited,
			{ ...entry("x", "b"), workspaceIdsUsedByTaskIncarnation: ["a", "b"] },
			replacement,
		);
		expect(refreshed.recentTasks.map((task) => task.workspaceId)).toEqual(["a", "a"]);
		expect(refreshed.navigationPath.map((task) => `${task.workspaceId}:${task.taskId}`)).toEqual([
			"a:x",
			"a:y",
			"a:x",
		]);
		expect(refreshed.cursor).toBe(2);
		const adjacent = refreshVisitedTaskHistoryEntry(
			historyOf(entry("x", "a"), entry("x", "b")),
			{ ...entry("x", "a"), workspaceIdsUsedByTaskIncarnation: ["a", "b"] },
			replacement,
		);
		expect(adjacent.navigationPath).toHaveLength(1);
		expect(adjacent.cursor).toBe(0);
		expect(adjacent.recentTasks).toHaveLength(1);
	});

	it("版本化存储可恢复，损坏、未知版本和非法游标安全回退", () => {
		const history = historyOf(entry("a"), entry("b"));
		expect(parseVisitedTaskNavigationHistory(JSON.stringify(history))).toEqual(history);
		for (const raw of [
			null,
			"{",
			"null",
			"{}",
			JSON.stringify({ ...history, schemaVersion: 99 }),
			JSON.stringify({ ...history, cursor: -2 }),
			JSON.stringify({ ...history, cursor: 5 }),
			JSON.stringify({ ...history, recentTasks: [{ ...entry("a"), taskIncarnationCreatedAtEpochMs: null }] }),
		]) {
			expect(parseVisitedTaskNavigationHistory(raw)).toEqual(createEmptyVisitedTaskNavigationHistory());
		}
	});
});
