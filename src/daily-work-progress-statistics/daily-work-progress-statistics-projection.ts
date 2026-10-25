import type {
	RuntimeDailyWorkProgressAchievement,
	RuntimeDailyWorkProgressMetric,
	RuntimeDailyWorkProgressRequest,
	RuntimeDailyWorkProgressSummary,
} from "../core/api-contract";

export interface DailyWorkProgressFact {
	eventId: string;
	workspaceId: string;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	taskTitle: string;
	metric: RuntimeDailyWorkProgressMetric;
	occurredAtEpochMs: number;
}
export interface DailyWorkProgressWorkspaceCoverage {
	workspaceId: string;
	taskHistoryCompleteSinceEpochMs: number | null;
	promptHistoryCompleteSinceEpochMs: number | null;
	warnings: string[];
}
export interface DailyWorkProgressProjectionInput {
	facts: readonly DailyWorkProgressFact[];
	coverage: readonly DailyWorkProgressWorkspaceCoverage[];
	projects: RuntimeDailyWorkProgressSummary["projects"];
	request: RuntimeDailyWorkProgressRequest;
	revision: number;
}

// EXPERIMENT_NODE: 任务与参与里程碑的间距是否能持续提供反馈，后续按实际使用调整。
const TASK_MILESTONE_VALUES = [1, 3, 5, 10, 20, 50, 100];
const HUMAN_PROMPT_MILESTONE_VALUES = [10, 25, 50, 100, 200];
const METRICS: RuntimeDailyWorkProgressMetric[] = ["entered_validation", "entered_done", "human_prompt"];

export function createWorkProgressDateFormatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}
export function formatWorkProgressDate(epochMs: number, formatter: Intl.DateTimeFormat): string {
	const parts = formatter.formatToParts(epochMs);
	const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}
function shiftCalendarDate(dateKey: string, days: number): string {
	return new Date(Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildDailyWorkProgressSummary(
	input: DailyWorkProgressProjectionInput,
): RuntimeDailyWorkProgressSummary {
	const { request } = input;
	const formatter = createWorkProgressDateFormatter(request.timeZone);
	const workspaceIds = new Set(
		request.workspaceId ? [request.workspaceId] : input.projects.map((project) => project.workspaceId),
	);
	const scopedCoverage = [...workspaceIds].map((workspaceId) =>
		input.coverage.find((coverage) => coverage.workspaceId === workspaceId),
	);
	const deduplicatedFacts = new Map<string, DailyWorkProgressFact>();
	for (const fact of input.facts) {
		if (!workspaceIds.has(fact.workspaceId) || !Number.isFinite(fact.occurredAtEpochMs)) continue;
		const date = formatWorkProgressDate(fact.occurredAtEpochMs, formatter);
		if (date > request.dateKey) continue;
		const key =
			fact.metric === "human_prompt"
				? fact.eventId
				: JSON.stringify([date, fact.metric, fact.workspaceId, fact.taskId, fact.taskIncarnationCreatedAtEpochMs]);
		if (!deduplicatedFacts.has(key)) deduplicatedFacts.set(key, fact);
	}
	const countsByMetricAndDate = new Map<string, number>();
	const todayFacts: DailyWorkProgressFact[] = [];
	for (const fact of deduplicatedFacts.values()) {
		const date = formatWorkProgressDate(fact.occurredAtEpochMs, formatter);
		const key = `${fact.metric}:${date}`;
		countsByMetricAndDate.set(key, (countsByMetricAndDate.get(key) ?? 0) + 1);
		if (date === request.dateKey) todayFacts.push(fact);
	}
	const achievements: RuntimeDailyWorkProgressAchievement[] = [];
	const metrics = METRICS.map((metric) => {
		const value = countsByMetricAndDate.get(`${metric}:${request.dateKey}`) ?? 0;
		const starts = scopedCoverage.map((coverage) =>
			metric === "human_prompt"
				? coverage?.promptHistoryCompleteSinceEpochMs
				: coverage?.taskHistoryCompleteSinceEpochMs,
		);
		const completeSince =
			starts.length > 0 && starts.every((start) => start != null)
				? Math.max(...starts.filter((start): start is number => start != null))
				: null;
		// 开始记录当天可能只有半天；从下一自然日开始才有可比较的完整日期。
		const historyStartDate =
			completeSince === null ? null : shiftCalendarDate(formatWorkProgressDate(completeSince, formatter), 1);
		const comparable = historyStartDate !== null && historyStartDate <= shiftCalendarDate(request.dateKey, -7);
		let historicalDailyRecord: number | null = null;
		let sevenDayAverage: number | null = null;
		if (comparable) {
			historicalDailyRecord = 0;
			for (const [key, count] of countsByMetricAndDate) {
				const date = key.slice(metric.length + 1);
				if (key.startsWith(`${metric}:`) && date >= historyStartDate && date < request.dateKey)
					historicalDailyRecord = Math.max(historicalDailyRecord, count);
			}
			sevenDayAverage =
				Array.from(
					{ length: 7 },
					(_, index) =>
						countsByMetricAndDate.get(`${metric}:${shiftCalendarDate(request.dateKey, -index - 1)}`) ?? 0,
				).reduce((sum, count) => sum + count, 0) / 7;
		}
		const addAchievement = (
			kind: RuntimeDailyWorkProgressAchievement["kind"],
			threshold: number | null,
			comparisonValue: number | null,
		) =>
			achievements.push({
				achievementId: JSON.stringify([
					request.timeZone,
					request.workspaceId,
					request.dateKey,
					metric,
					kind,
					threshold,
				]),
				metric,
				kind,
				value,
				threshold,
				comparisonValue,
			});
		if (historicalDailyRecord !== null && value > historicalDailyRecord)
			addAchievement("personal_daily_record", null, historicalDailyRecord);
		if (sevenDayAverage !== null && value > sevenDayAverage)
			addAchievement("above_seven_day_average", null, sevenDayAverage);
		const thresholds = metric === "human_prompt" ? HUMAN_PROMPT_MILESTONE_VALUES : TASK_MILESTONE_VALUES;
		for (const threshold of thresholds) if (value >= threshold) addAchievement("daily_threshold", threshold, null);
		return {
			metric,
			value,
			nextMilestoneValue: thresholds.find((threshold) => threshold > value) ?? null,
			historicalDailyRecord,
			sevenDayAverage,
			historyStartDate,
		};
	});
	const warnings = [...new Set(scopedCoverage.flatMap((coverage) => coverage?.warnings ?? ["项目统计记录尚未就绪"]))];
	return {
		...request,
		revision: input.revision,
		projects: input.projects,
		metrics,
		achievements,
		celebrationEligibleAchievementIds: [],
		recentAccomplishments: todayFacts
			.filter(
				(fact): fact is DailyWorkProgressFact & { metric: "entered_validation" | "entered_done" } =>
					fact.metric !== "human_prompt",
			)
			.sort((a, b) => b.occurredAtEpochMs - a.occurredAtEpochMs)
			.slice(0, 3)
			.map(({ workspaceId, taskId, taskTitle, metric, occurredAtEpochMs }) => ({
				workspaceId,
				taskId,
				taskTitle,
				metric,
				occurredAtEpochMs,
			})),
		coverage: {
			status:
				scopedCoverage.length === 0 || scopedCoverage.every((coverage) => !coverage)
					? "loading"
					: warnings.length > 0 ||
							scopedCoverage.some(
								(coverage) =>
									coverage?.promptHistoryCompleteSinceEpochMs == null ||
									coverage.taskHistoryCompleteSinceEpochMs == null,
							)
						? "partial"
						: "complete",
			warnings,
		},
	};
}
