import { describe, expect, it } from "vitest";

import { applyTaskFilterSelection, type FilterableTaskDescriptor } from "@/task-filtering/apply-task-filter-selection";
import {
	EMPTY_TASK_FILTER_SELECTION,
	type TaskFilterSelection,
	type TaskSessionActivityFilterCategory,
} from "@/task-filtering/task-filter-selection";
import type { BoardColumnId } from "@/types";

const NOW_EPOCH_MS = 10_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

interface TestRow extends FilterableTaskDescriptor {
	taskId: string;
}

function row(overrides: Partial<TestRow> & { taskId: string }): TestRow {
	return {
		projectId: "proj-a",
		columnId: "backlog" as BoardColumnId,
		agentId: null,
		taskLastModifiedAtEpochMs: NOW_EPOCH_MS,
		sessionActivityCategory: "no_live_session" as TaskSessionActivityFilterCategory,
		...overrides,
	};
}

function apply(rows: readonly TestRow[], selection: Partial<TaskFilterSelection>) {
	return applyTaskFilterSelection({
		rows,
		selection: { ...EMPTY_TASK_FILTER_SELECTION, ...selection },
		describeRow: (candidate: TestRow) => candidate,
		nowEpochMs: NOW_EPOCH_MS,
	});
}

function filteredTaskIds(rows: readonly TestRow[], selection: Partial<TaskFilterSelection>): string[] {
	return apply(rows, selection).filteredRows.map((candidate) => candidate.taskId);
}

describe("applyTaskFilterSelection", () => {
	it("treats an empty selection as no constraint at all and preserves input order", () => {
		const rows = [row({ taskId: "a" }), row({ taskId: "b" }), row({ taskId: "c" })];

		expect(filteredTaskIds(rows, {})).toEqual(["a", "b", "c"]);
	});

	it("ORs within a dimension", () => {
		const rows = [
			row({ taskId: "backlog", columnId: "backlog" }),
			row({ taskId: "review", columnId: "review" }),
			row({ taskId: "done", columnId: "trash" }),
		];

		expect(filteredTaskIds(rows, { selectedStageColumnIds: new Set<BoardColumnId>(["backlog", "review"]) })).toEqual([
			"backlog",
			"review",
		]);
	});

	it("ANDs across dimensions", () => {
		const rows = [
			row({ taskId: "match", columnId: "review", agentId: "claude" }),
			row({ taskId: "wrong-stage", columnId: "backlog", agentId: "claude" }),
			row({ taskId: "wrong-agent", columnId: "review", agentId: "codex" }),
		];

		expect(
			filteredTaskIds(rows, {
				selectedStageColumnIds: new Set<BoardColumnId>(["review"]),
				selectedAgentIds: new Set(["claude" as const]),
			}),
		).toEqual(["match"]);
	});

	it("drops rows whose agent is unknown once the agent dimension is used", () => {
		// 「未知」匹配不上任何被选中的 agent，不做「未知即通过」的宽大处理。
		const rows = [row({ taskId: "known", agentId: "claude" }), row({ taskId: "unknown", agentId: null })];

		expect(filteredTaskIds(rows, { selectedAgentIds: new Set(["claude" as const]) })).toEqual(["known"]);
	});

	it("applies the last-modified window against the supplied now", () => {
		const rows = [
			row({ taskId: "fresh", taskLastModifiedAtEpochMs: NOW_EPOCH_MS - HOUR_MS }),
			row({ taskId: "three-days", taskLastModifiedAtEpochMs: NOW_EPOCH_MS - 3 * DAY_MS }),
			row({ taskId: "twenty-days", taskLastModifiedAtEpochMs: NOW_EPOCH_MS - 20 * DAY_MS }),
		];

		expect(filteredTaskIds(rows, { lastModifiedWindow: "past_24_hours" })).toEqual(["fresh"]);
		expect(filteredTaskIds(rows, { lastModifiedWindow: "past_7_days" })).toEqual(["fresh", "three-days"]);
		expect(filteredTaskIds(rows, { lastModifiedWindow: "any" })).toEqual(["fresh", "three-days", "twenty-days"]);
	});

	it("separates 'no session' from 'session state unknown'", () => {
		// 前者是「查过了，确实没有会话」，后者是「根本查不到」（跨项目行）。混为一谈会让
		// 「筛选无会话的任务」把一堆状态未知的跨项目任务一并捞进来。
		const rows = [
			row({ taskId: "idle-here", sessionActivityCategory: "no_live_session" }),
			row({ taskId: "unknown-elsewhere", projectId: "proj-b", sessionActivityCategory: null }),
		];

		const application = apply(rows, {
			selectedSessionActivityCategories: new Set<TaskSessionActivityFilterCategory>(["no_live_session"]),
		});

		expect(application.filteredRows.map((candidate) => candidate.taskId)).toEqual(["idle-here"]);
		expect(application.rowCountExcludedBecauseSessionActivityIsNotObservable).toBe(1);
	});

	it("does not count rows that another dimension had already excluded", () => {
		// 那条解释性计数要能直说「只差会话状态判不了」，把本就落选的行算进去会得到一个虚高的数字。
		const rows = [
			row({
				taskId: "wrong-stage-and-unknown",
				columnId: "trash",
				projectId: "proj-b",
				sessionActivityCategory: null,
			}),
			row({
				taskId: "right-stage-and-unknown",
				columnId: "backlog",
				projectId: "proj-b",
				sessionActivityCategory: null,
			}),
		];

		const application = apply(rows, {
			selectedStageColumnIds: new Set<BoardColumnId>(["backlog"]),
			selectedSessionActivityCategories: new Set<TaskSessionActivityFilterCategory>(["agent_running"]),
		});

		expect(application.filteredRows).toHaveLength(0);
		expect(application.rowCountExcludedBecauseSessionActivityIsNotObservable).toBe(1);
	});

	it("reports zero unobservable rows while the session dimension is unused", () => {
		const rows = [row({ taskId: "unknown", projectId: "proj-b", sessionActivityCategory: null })];

		const application = apply(rows, {});

		expect(application.filteredRows.map((candidate) => candidate.taskId)).toEqual(["unknown"]);
		expect(application.rowCountExcludedBecauseSessionActivityIsNotObservable).toBe(0);
	});
});
