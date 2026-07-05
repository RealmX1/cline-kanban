import * as Collapsible from "@radix-ui/react-collapsible";
import { isAgentOutputWithinActiveWindow, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS } from "@runtime-session-activity";
import { Activity, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { getAgentVisual } from "@/components/agent-visual";
import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import { cn } from "@/components/ui/cn";
import type { RuntimeInProgressTaskDetail, RuntimeProjectSummary, RuntimeProjectTaskCounts } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

// Cross-Repository Stage-First Overview（见 CONTEXT.md / ADR-0001）：把整个看板（Board Scope）所有
// repository 的任务按 Stage → Repository → Task 呈现——正是主看板 repo-first 范式前两级的对调。
// In-Progress 阶段展开到 task 明细并内部二分 Active / Stale；Review/Validation/Done 折叠显示跨-repo
// 总计数、展开显示每-repo 分计数（不下钻到 task）。各 stage 计数按「列归属」（rawColumnTaskCounts）。

// Active 判据：agent 回合 + 距最近 PTY 输出在「近期活跃」窗口内（见 CONTEXT.md Active In-Progress Task）。
function isActiveInProgressTask(task: RuntimeInProgressTaskDetail, nowMs: number): boolean {
	return (
		task.turnOwner === "agent" &&
		isAgentOutputWithinActiveWindow(task.lastOutputAt, nowMs, RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS)
	);
}

interface RepoTaskGroup {
	repo: RuntimeProjectSummary;
	tasks: RuntimeInProgressTaskDetail[];
}

// done 是内部 trash 列的展示名（见 CONTEXT.md Stage）。tone 沿用 project 列表 badge 的配色。
const COUNT_STAGES: { key: keyof RuntimeProjectTaskCounts; label: string; tone: string }[] = [
	{ key: "review", label: "Review", tone: "text-accent-2" },
	{ key: "validation", label: "Validation", tone: "text-status-gold" },
	{ key: "trash", label: "Done", tone: "text-status-red" },
];

function stageCount(project: RuntimeProjectSummary, stage: keyof RuntimeProjectTaskCounts): number {
	// rawColumnTaskCounts 是 stage 计数的权威（列归属，未套 overlay）；旧广播缺它时回退 taskCounts。
	return (project.rawColumnTaskCounts ?? project.taskCounts)[stage];
}

export function CrossRepositoryStageFirstOverview({
	projects,
	onOpenTask,
	onOpenStage,
}: {
	projects: RuntimeProjectSummary[];
	onOpenTask: (repoId: string, taskId: string) => void;
	onOpenStage?: (repoId: string, stage: keyof RuntimeProjectTaskCounts) => void;
}): React.ReactElement {
	// 本地 tick：summary 不会每分钟推送，故自行 tick 让「近期活跃」窗口随时间衰减（同 task-card-body）。
	const [nowMs, setNowMs] = useState(() => Date.now());
	useInterval(() => setNowMs(Date.now()), 30_000);

	const sortedProjects = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);

	const { activeByRepo, staleByRepo, activeTotal, staleTotal } = useMemo(() => {
		const active: RepoTaskGroup[] = [];
		const stale: RepoTaskGroup[] = [];
		let activeCount = 0;
		let staleCount = 0;
		for (const repo of sortedProjects) {
			const activeTasks: RuntimeInProgressTaskDetail[] = [];
			const staleTasks: RuntimeInProgressTaskDetail[] = [];
			for (const task of repo.inProgressTaskDetails) {
				if (isActiveInProgressTask(task, nowMs)) {
					activeTasks.push(task);
				} else {
					staleTasks.push(task);
				}
			}
			if (activeTasks.length > 0) {
				// 活跃组内最近有输出的排前面。
				activeTasks.sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));
				active.push({ repo, tasks: activeTasks });
				activeCount += activeTasks.length;
			}
			if (staleTasks.length > 0) {
				stale.push({ repo, tasks: staleTasks });
				staleCount += staleTasks.length;
			}
		}
		return { activeByRepo: active, staleByRepo: stale, activeTotal: activeCount, staleTotal: staleCount };
	}, [sortedProjects, nowMs]);

	const inProgressTotal = activeTotal + staleTotal;

	return (
		<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-surface-0">
			<div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
				<header className="flex items-baseline gap-2">
					<h1 className="text-lg font-semibold text-text-primary">Board Overview</h1>
					<span className="text-xs text-text-tertiary">across all repositories</span>
				</header>

				{/* In-Progress 阶段：stage → {Active, Stale} → repo → task */}
				<section className="rounded-lg border border-border bg-surface-1">
					<div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
						<span className="text-sm font-semibold text-text-primary">In Progress</span>
						<span className="text-xs text-text-tertiary">{inProgressTotal}</span>
					</div>
					<div className="flex flex-col gap-3 p-3">
						<ActiveSection groups={activeByRepo} total={activeTotal} nowMs={nowMs} onOpenTask={onOpenTask} />
						<StaleSection groups={staleByRepo} total={staleTotal} onOpenTask={onOpenTask} />
					</div>
				</section>

				{/* Review / Validation / Done：折叠总计数、展开每-repo 分计数 */}
				{COUNT_STAGES.map((stage) => (
					<CountStageSection
						key={stage.key}
						stageKey={stage.key}
						label={stage.label}
						tone={stage.tone}
						projects={sortedProjects}
						onOpenStage={onOpenStage}
					/>
				))}
			</div>
		</div>
	);
}

function ActiveSection({
	groups,
	total,
	nowMs,
	onOpenTask,
}: {
	groups: RepoTaskGroup[];
	total: number;
	nowMs: number;
	onOpenTask: (repoId: string, taskId: string) => void;
}): React.ReactElement {
	return (
		<div className="rounded-md border border-status-blue/30 bg-status-blue/5">
			<div className="flex items-center gap-2 px-3 py-2">
				<Activity size={14} className="text-status-blue" />
				<span className="text-xs font-semibold uppercase tracking-wide text-status-blue">Active</span>
				<span className="text-xs text-text-tertiary">{total}</span>
			</div>
			{total === 0 ? (
				<p className="px-3 pb-3 text-xs text-text-tertiary">No agents are actively working right now.</p>
			) : (
				<div className="flex flex-col gap-2 px-2 pb-2">
					{groups.map((group) => (
						<RepoTaskGroupBlock key={group.repo.id} group={group} nowMs={nowMs} onOpenTask={onOpenTask} />
					))}
				</div>
			)}
		</div>
	);
}

function StaleSection({
	groups,
	total,
	onOpenTask,
}: {
	groups: RepoTaskGroup[];
	total: number;
	onOpenTask: (repoId: string, taskId: string) => void;
}): React.ReactElement | null {
	if (total === 0) {
		return null;
	}
	return (
		<Collapsible.Root>
			<Collapsible.Trigger asChild>
				<button
					type="button"
					className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-surface-2"
				>
					<ChevronRight
						size={14}
						className="text-text-tertiary transition-transform group-data-[state=open]:rotate-90"
					/>
					<span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Stale</span>
					<span className="text-xs text-text-tertiary">{total}</span>
				</button>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div className="flex flex-col gap-2 px-2 pb-1 pt-1">
					{groups.map((group) => (
						<RepoTaskGroupBlock key={group.repo.id} group={group} onOpenTask={onOpenTask} />
					))}
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	);
}

function RepoTaskGroupBlock({
	group,
	nowMs,
	onOpenTask,
}: {
	group: RepoTaskGroup;
	nowMs?: number;
	onOpenTask: (repoId: string, taskId: string) => void;
}): React.ReactElement {
	return (
		<div className="rounded-md bg-surface-2/40 px-2 py-1.5">
			<div className="px-1 pb-1 text-[11px] font-medium text-text-secondary">{group.repo.name}</div>
			<div className="flex flex-col">
				{group.tasks.map((task) => (
					<OverviewTaskRow
						key={task.taskId}
						task={task}
						repoId={group.repo.id}
						active={nowMs !== undefined && isActiveInProgressTask(task, nowMs)}
						onOpenTask={onOpenTask}
					/>
				))}
			</div>
		</div>
	);
}

function OverviewTaskRow({
	task,
	repoId,
	active,
	onOpenTask,
}: {
	task: RuntimeInProgressTaskDetail;
	repoId: string;
	active: boolean;
	onOpenTask: (repoId: string, taskId: string) => void;
}): React.ReactElement {
	const visual = getAgentVisual(task.agentId);
	return (
		<button
			type="button"
			onClick={() => onOpenTask(repoId, task.taskId)}
			className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-3"
		>
			<span
				className={cn("inline-block shrink-0 rounded-full", active && "animate-pulse")}
				style={{
					width: 6,
					height: 6,
					backgroundColor: active ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.muted,
				}}
			/>
			<visual.Icon size={14} className={cn("shrink-0", visual.className)} />
			<span className="min-w-0 flex-1 truncate text-sm text-text-primary">{task.title}</span>
		</button>
	);
}

function CountStageSection({
	stageKey,
	label,
	tone,
	projects,
	onOpenStage,
}: {
	stageKey: keyof RuntimeProjectTaskCounts;
	label: string;
	tone: string;
	projects: RuntimeProjectSummary[];
	onOpenStage?: (repoId: string, stage: keyof RuntimeProjectTaskCounts) => void;
}): React.ReactElement {
	const perRepo = projects
		.map((repo) => ({ repo, count: stageCount(repo, stageKey) }))
		.filter((entry) => entry.count > 0);
	const total = perRepo.reduce((sum, entry) => sum + entry.count, 0);

	return (
		<Collapsible.Root>
			<section className="rounded-lg border border-border bg-surface-1">
				<Collapsible.Trigger asChild>
					<button
						type="button"
						disabled={total === 0}
						className="group flex w-full items-center gap-2 px-4 py-2.5 text-left disabled:cursor-default"
					>
						<ChevronRight
							size={14}
							className={cn(
								"text-text-tertiary transition-transform group-data-[state=open]:rotate-90",
								total === 0 && "opacity-30",
							)}
						/>
						<span className={cn("text-sm font-semibold", tone)}>{label}</span>
						<span className="text-xs text-text-tertiary">{total}</span>
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
						{perRepo.map((entry) => (
							<button
								key={entry.repo.id}
								type="button"
								onClick={() => onOpenStage?.(entry.repo.id, stageKey)}
								className="flex items-center justify-between rounded-sm px-2 py-1 text-left hover:bg-surface-2"
							>
								<span className="min-w-0 truncate text-sm text-text-secondary">{entry.repo.name}</span>
								<span className="ml-2 shrink-0 text-xs text-text-tertiary">{entry.count}</span>
							</button>
						))}
					</div>
				</Collapsible.Content>
			</section>
		</Collapsible.Root>
	);
}
