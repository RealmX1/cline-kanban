import { describe, expect, it } from "vitest";
import {
	buildDailyWorkProgressSummary,
	type DailyWorkProgressFact,
} from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-projection";

const today = "2026-10-23";
const at = (date: string) => Date.parse(`${date}T12:00:00Z`);
function fact(id: string, metric: DailyWorkProgressFact["metric"], date = today): DailyWorkProgressFact {
	return {
		eventId: id,
		workspaceId: "project-a",
		taskId: id,
		taskIncarnationCreatedAtEpochMs: 1,
		taskTitle: `任务 ${id}`,
		metric,
		occurredAtEpochMs: at(date),
	};
}
function summarize(facts: DailyWorkProgressFact[], completeSince: number | null = at("2026-10-01")) {
	return buildDailyWorkProgressSummary({
		facts,
		coverage: [
			{
				workspaceId: "project-a",
				taskHistoryCompleteSinceEpochMs: completeSince,
				promptHistoryCompleteSinceEpochMs: completeSince,
				warnings: [],
			},
		],
		projects: [
			{ workspaceId: "project-a", projectName: "项目 A" },
			{ workspaceId: "project-b", projectName: "项目 B" },
		],
		request: { workspaceId: "project-a", dateKey: today, timeZone: "UTC" },
		revision: 1,
	});
}

describe("今日进展与历史成就", () => {
	it("同一任务当天各阶段分别去重，真实重复 prompt 保留两次", () => {
		const first = fact("task", "entered_validation");
		const result = summarize([
			first,
			{ ...first, eventId: "again" },
			{ ...first, metric: "entered_done", eventId: "done" },
			fact("prompt-1", "human_prompt"),
			fact("prompt-2", "human_prompt"),
		]);
		expect(result.metrics.map((metric) => metric.value)).toEqual([1, 1, 2]);
		expect(result.recentAccomplishments).toHaveLength(2);
	});
	it("跨项目和同 id 的新任务世代分别计数，只汇总选定项目", () => {
		const first = fact("task", "entered_done");
		const facts = [
			first,
			{ ...first, eventId: "project-b-task", workspaceId: "project-b" },
			{ ...first, eventId: "new-incarnation", taskIncarnationCreatedAtEpochMs: 2 },
		];
		expect(summarize(facts).metrics[1]?.value).toBe(2);
	});
	it("按请求时区分日，并正确处理夏令时切换日", () => {
		const facts = [{ ...fact("late", "entered_done"), occurredAtEpochMs: Date.parse("2026-11-02T04:30:00Z") }];
		const result = buildDailyWorkProgressSummary({
			facts,
			coverage: [],
			projects: [{ workspaceId: "project-a", projectName: "项目 A" }],
			request: { workspaceId: null, dateKey: "2026-11-01", timeZone: "America/New_York" },
			revision: 1,
		});
		expect(result.metrics[1]?.value).toBe(1);
	});
	it("近七天包含零活动日，纪录采用严格超过，忽略更晚日期", () => {
		const result = summarize([
			fact("older", "entered_done", "2026-10-16"),
			fact("today-1", "entered_done"),
			fact("today-2", "entered_done"),
			fact("future", "entered_done", "2026-10-24"),
		]);
		expect(result.metrics[1]?.sevenDayAverage).toBeCloseTo(1 / 7);
		expect(result.metrics[1]?.historicalDailyRecord).toBe(1);
		expect(
			result.achievements
				.filter((achievement) => achievement.metric === "entered_done")
				.map((achievement) => achievement.kind),
		).toEqual(["personal_daily_record", "above_seven_day_average", "daily_threshold"]);
		expect(
			summarize([fact("older", "entered_done", "2026-10-16"), fact("today", "entered_done")]).achievements.some(
				(achievement) => achievement.kind === "personal_daily_record",
			),
		).toBe(false);
	});
	it("不足七个完整历史日或缺失历史时不伪造历史成就", () => {
		for (const completeSince of [null, at("2026-10-17")]) {
			const result = summarize([fact("task", "entered_done")], completeSince);
			expect(result.metrics[1]?.sevenDayAverage).toBeNull();
			expect(result.achievements.every((achievement) => achievement.kind === "daily_threshold")).toBe(true);
		}
	});
	it("同一次输入的重复事实幂等，今日成果最多三项", () => {
		const prompt = fact("prompt", "human_prompt");
		const result = summarize([
			prompt,
			prompt,
			...Array.from({ length: 6 }, (_, index) => fact(`task-${index}`, "entered_done")),
		]);
		expect(result.metrics[2]?.value).toBe(1);
		expect(result.recentAccomplishments).toHaveLength(3);
		expect(result.metrics[1]?.nextMilestoneValue).toBe(10);
	});
});
