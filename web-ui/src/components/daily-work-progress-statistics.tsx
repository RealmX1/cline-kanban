import {
	ArrowUpRight,
	CheckCheck,
	ChevronDown,
	MessagesSquare,
	Send,
	Sparkles,
	TrendingUp,
	Trophy,
	X,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { DailyWorkProgressStatisticsController } from "@/hooks/use-daily-work-progress-statistics";
import type { RuntimeDailyWorkProgressAchievement, RuntimeDailyWorkProgressMetric } from "@/runtime/types";

const METRIC_PRESENTATION = {
	entered_validation: {
		label: "进入 Validation",
		shortLabel: "Validation",
		icon: Send,
		color: "text-status-purple",
		priority: 2,
	},
	entered_done: { label: "进入 Done", shortLabel: "Done", icon: CheckCheck, color: "text-status-green", priority: 3 },
	human_prompt: {
		label: "人工 prompt",
		shortLabel: "Prompt",
		icon: MessagesSquare,
		color: "text-status-blue",
		priority: 1,
	},
} satisfies Record<
	RuntimeDailyWorkProgressMetric,
	{ label: string; shortLabel: string; icon: typeof Send; color: string; priority: number }
>;
const ALL_METRICS: RuntimeDailyWorkProgressMetric[] = ["entered_validation", "entered_done", "human_prompt"];
const formatCount = (value: number) => value.toLocaleString("zh-CN");
export function describeDailyWorkProgressAchievement(achievement: RuntimeDailyWorkProgressAchievement): string {
	const label = METRIC_PRESENTATION[achievement.metric].label;
	if (achievement.kind === "personal_daily_record")
		return `${label}刷新单日纪录，今天已达 ${formatCount(achievement.value)}`;
	if (achievement.kind === "above_seven_day_average")
		return (
			label +
			"超过近 7 天日均 " +
			(achievement.comparisonValue ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
		);
	return (
		"今天已有 " +
		formatCount(achievement.threshold ?? achievement.value) +
		(achievement.metric === "human_prompt"
			? " 次人工 prompt"
			: achievement.metric === "entered_done"
				? " 个任务进入 Done"
				: " 个任务进入 Validation")
	);
}
export function DailyWorkProgressSummaryButton({ progress }: { progress: DailyWorkProgressStatisticsController }) {
	const scope = progress.workspaceId
		? (progress.summary?.projects.find((project) => project.workspaceId === progress.workspaceId)?.projectName ??
			"单项目")
		: "全部项目";
	return (
		<button
			type="button"
			onClick={progress.toggleExpanded}
			aria-label={`今日进展，${scope}`}
			aria-expanded={progress.isExpanded}
			aria-controls="daily-work-progress-expanded-region"
			data-verification-anchor="daily-work-progress-summary"
			title={`${scope} · 今天实际进入各阶段的任务数，同一任务每阶段只计一次`}
			className={cn(
				"inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent",
				progress.isExpanded && "bg-surface-3 text-text-primary",
			)}
		>
			<TrendingUp size={14} aria-hidden="true" />
			<span className="hidden 2xl:inline">今日</span>
			{progress.summary ? (
				ALL_METRICS.map((key) => {
					const metric = progress.summary?.metrics.find((metric) => metric.metric === key);
					const presentation = METRIC_PRESENTATION[key];
					const Icon = presentation.icon;
					return (
						<span key={key} className="inline-flex items-center gap-1" title={presentation.label}>
							<Icon size={12} className={presentation.color} aria-hidden="true" />
							<span className="font-mono tabular-nums">{formatCount(metric?.value ?? 0)}</span>
						</span>
					);
				})
			) : (
				<span>{progress.error ? "暂不可用" : "…"}</span>
			)}
			<ChevronDown
				size={12}
				className={cn("transition-transform motion-reduce:transition-none", progress.isExpanded && "rotate-180")}
				aria-hidden="true"
			/>
		</button>
	);
}
export function DailyWorkProgressExpandedRegion({
	progress,
	onOpenTask,
}: {
	progress: DailyWorkProgressStatisticsController;
	onOpenTask: (workspaceId: string, taskId: string) => void;
}) {
	if (!progress.isExpanded) return null;
	const { summary } = progress;
	const celebrations = progress.celebrations
		.map((achievement) =>
			achievement.kind === "personal_daily_record"
				? {
						...achievement,
						value:
							summary?.metrics.find((metric) => metric.metric === achievement.metric)?.value ??
							achievement.value,
					}
				: achievement,
		)
		.sort(
			(a, b) =>
				METRIC_PRESENTATION[b.metric].priority - METRIC_PRESENTATION[a.metric].priority ||
				(a.kind === "personal_daily_record" ? -1 : b.kind === "personal_daily_record" ? 1 : 0) ||
				(b.threshold ?? 0) - (a.threshold ?? 0),
		);
	const featured = celebrations[0];
	return (
		<section
			id="daily-work-progress-expanded-region"
			aria-label="今日进展详情"
			data-verification-anchor="daily-work-progress-expanded-region"
			className="absolute inset-x-0 top-0 z-40 max-h-full overflow-y-auto border-b border-border bg-surface-1 shadow-md"
		>
			<div className="daily-work-progress-reveal mx-auto flex max-w-screen-2xl flex-col gap-3 px-3 py-3 sm:px-4">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<TrendingUp size={16} className="text-accent" aria-hidden="true" />
					<h2 className="text-sm font-semibold text-text-primary">今日进展</h2>
					<select
						aria-label="今日进展统计范围"
						value={progress.workspaceId ?? ""}
						onChange={(event) => progress.selectWorkspace(event.target.value || null)}
						className="min-w-0 max-w-48 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
					>
						<option value="">全部项目</option>
						{summary?.projects.map((project) => (
							<option key={project.workspaceId} value={project.workspaceId}>
								{project.projectName}
							</option>
						))}
					</select>
					<span className="text-[11px] text-text-secondary">
						{summary?.dateKey} {summary?.coverage.status !== "complete" && summary ? "· 已记录" : ""}
					</span>
					<div className="ml-auto flex items-center gap-2">
						{progress.isAutomaticallyExpanded ? (
							<span className="hidden text-[11px] text-text-secondary sm:inline">稍后自动收起</span>
						) : null}
						<button
							type="button"
							onClick={progress.collapse}
							aria-label="收起今日进展"
							className="rounded p-1.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
						>
							<X size={16} />
						</button>
					</div>
				</div>
				{featured ? (
					<div role="status" aria-live="polite" className="flex items-start gap-2 text-text-primary">
						<Trophy size={20} className="mt-0.5 shrink-0 text-status-gold" aria-hidden="true" />
						<div className="min-w-0">
							<p className="text-sm font-semibold">{describeDailyWorkProgressAchievement(featured)}</p>
							<p className="mt-0.5 text-xs text-text-secondary">
								{celebrations.length > 1 ? `还达成 ${celebrations.length - 1} 项进展 · ` : ""}
								今天的工作又向前推进了一步。
							</p>
						</div>
						<Sparkles
							size={16}
							className="daily-work-progress-celebration ml-1 shrink-0 text-status-gold"
							aria-hidden="true"
						/>
					</div>
				) : null}
				{progress.error ? (
					<div className="flex items-center gap-2 text-xs text-status-orange">
						<p>{progress.error}</p>
						<button
							type="button"
							className="shrink-0 rounded px-2 py-1 underline hover:bg-surface-3"
							onClick={progress.refresh}
						>
							重试读取
						</button>
					</div>
				) : null}
				{!summary && !progress.error ? (
					<p className="text-xs text-text-secondary" role="status">
						正在读取已确认的进展…
					</p>
				) : null}
				{summary ? (
					<>
						<dl className="grid grid-cols-3 gap-x-3 gap-y-2">
							{ALL_METRICS.map((key) => {
								const metric = summary.metrics.find((metric) => metric.metric === key);
								if (!metric) return null;
								const presentation = METRIC_PRESENTATION[key];
								const Icon = presentation.icon;
								return (
									<div key={key} className="min-w-0">
										<dt className="flex items-center gap-1 text-[11px] text-text-secondary sm:text-xs">
											<Icon size={13} className={presentation.color} aria-hidden="true" />
											<span>{presentation.label}</span>
										</dt>
										<dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-text-primary">
											{formatCount(metric.value)}
											<span className="ml-1 text-xs font-normal text-text-secondary">
												{key === "human_prompt" ? "次" : "个"}
											</span>
										</dd>
										<p className="mt-1 text-[11px] text-text-secondary">
											{metric.nextMilestoneValue
												? "下一站 " +
													formatCount(metric.nextMilestoneValue) +
													" · 差 " +
													formatCount(metric.nextMilestoneValue - metric.value)
												: "今日里程碑全部达成"}
										</p>
										{metric.sevenDayAverage !== null ? (
											<p className="mt-1 text-[11px] text-text-secondary">
												日均 {metric.sevenDayAverage.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}{" "}
												· 纪录 {formatCount(metric.historicalDailyRecord ?? 0)}
											</p>
										) : null}
										{metric.historyStartDate ? (
											<p className="mt-1 hidden text-[10px] text-text-secondary sm:block">
												完整记录自 {metric.historyStartDate}
											</p>
										) : null}
									</div>
								);
							})}
						</dl>
						<p className="text-[10px] text-text-secondary sm:hidden">
							历史比较起点：
							{[...new Set(summary.metrics.map((metric) => metric.historyStartDate).filter(Boolean))].join(
								" / ",
							) || "等待完整记录"}
						</p>
						{summary.recentAccomplishments.length ? (
							<div className="flex min-w-0 flex-col gap-1 border-t border-border pt-2">
								{summary.recentAccomplishments.map((accomplishment, index) => (
									<button
										type="button"
										key={
											accomplishment.workspaceId +
											":" +
											accomplishment.taskId +
											":" +
											accomplishment.metric +
											":" +
											index
										}
										onClick={() => onOpenTask(accomplishment.workspaceId, accomplishment.taskId)}
										className="group flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
									>
										<CheckCheck
											size={12}
											className={METRIC_PRESENTATION[accomplishment.metric].color}
											aria-hidden="true"
										/>
										<span className="shrink-0 text-[10px]">
											{METRIC_PRESENTATION[accomplishment.metric].shortLabel}
										</span>
										<span className="min-w-0 truncate">{accomplishment.taskTitle}</span>
										<span className="ml-auto hidden shrink-0 text-[10px] sm:inline">
											{
												summary.projects.find(
													(project) => project.workspaceId === accomplishment.workspaceId,
												)?.projectName
											}
										</span>
										<ArrowUpRight size={12} className="shrink-0" aria-hidden="true" />
									</button>
								))}
							</div>
						) : (
							<p className="text-xs text-text-secondary">新的任务成果会留在这里，方便回看今天做成了什么。</p>
						)}
						{summary.coverage.status !== "complete" ? (
							<p className="text-[11px] text-text-secondary" title={summary.coverage.warnings.join("；")}>
								当前显示已确认的记录，部分历史仍在读取或暂不可用。积累 7 天完整记录后，会开启历史成就比较。
							</p>
						) : null}
					</>
				) : null}
			</div>
		</section>
	);
}
