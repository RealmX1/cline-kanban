import { AlertTriangle } from "lucide-react";

import {
	FUZZY_MATCHED_TEXT_STYLE,
	renderFuzzyHighlightedText,
} from "@/components/shared/render-fuzzy-highlighted-text";
import { ProjectSwitcherNumericSlotCell } from "@/components/top-bar-project-switcher/project-switcher-numeric-slot-cell";
import type { ProjectSwitcherRow } from "@/components/top-bar-project-switcher/project-switcher-row-ordering";
import {
	deriveAwaitingUserTaskCount,
	deriveLiveAgentTaskCount,
} from "@/components/top-bar-project-switcher/project-switcher-session-activity-counts";
import type { ProjectSwitcherTableColumnVisibility } from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";
import { cn } from "@/components/ui/cn";
import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";
import { formatPathForDisplay } from "@/utils/path-display";

interface TaskDistributionBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

function buildTaskDistributionBadges(row: ProjectSwitcherRow): TaskDistributionBadge[] {
	const { taskCounts } = row.project;
	return [
		{
			id: "backlog",
			title: "Backlog",
			shortLabel: "B",
			toneClassName: "bg-text-primary/15 text-text-primary",
			count: taskCounts.backlog,
		},
		{
			id: "in_progress",
			title: "In Progress",
			shortLabel: "IP",
			toneClassName: "bg-accent/20 text-accent",
			count: taskCounts.in_progress,
		},
		{
			id: "review",
			title: "Review",
			shortLabel: "R",
			toneClassName: "bg-accent-2/20 text-accent-2",
			count: taskCounts.review,
		},
		{
			id: "validation",
			title: "Validation",
			shortLabel: "V",
			toneClassName: "bg-status-gold/20 text-status-gold",
			count: taskCounts.validation,
		},
	].filter((badge) => badge.count > 0);
}

function NumericCountCell({
	count,
	toneClassName,
	title,
}: {
	count: number;
	toneClassName: string;
	title: string;
}): React.ReactElement {
	if (count <= 0) {
		return <span className="text-text-tertiary">—</span>;
	}
	return (
		<span
			className={cn("inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-medium", toneClassName)}
			title={title}
		>
			{count}
		</span>
	);
}

export function ProjectSwitcherTableRow({
	row,
	isCurrentProject,
	isActiveRow,
	columnVisibility,
	nowEpochMs,
	projectNameByNumericSlotGroupNumber,
	onSelectProject,
	onActivateRow,
	onAssignProjectToNumericSlotGroupNumber,
	onClearNumericSlotGroupNumber,
}: {
	row: ProjectSwitcherRow;
	isCurrentProject: boolean;
	isActiveRow: boolean;
	columnVisibility: ProjectSwitcherTableColumnVisibility;
	nowEpochMs: number;
	projectNameByNumericSlotGroupNumber: ReadonlyMap<ProjectNumericSlotGroupNumber, string>;
	onSelectProject: (projectId: string) => void;
	onActivateRow: () => void;
	onAssignProjectToNumericSlotGroupNumber: (
		slotNumber: ProjectNumericSlotGroupNumber,
		targetProjectId: string,
	) => void;
	onClearNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber) => void;
}): React.ReactElement {
	const { project } = row;
	const isProjectUnavailable = project.availability.status === "unavailable";
	const taskDistributionBadges = buildTaskDistributionBadges(row);

	return (
		<tr
			data-testid="project-switcher-table-row"
			data-project-id={project.id}
			// aria-current 是全局属性、在原生 <table> 上合法（aria-selected 只在 grid/listbox 里有意义），
			// 键盘高亮的滚动定位也按它查询。
			aria-current={isActiveRow ? "true" : undefined}
			className={cn(
				"cursor-pointer border-t border-border/60",
				isActiveRow ? "bg-surface-3" : "hover:bg-surface-3/60",
			)}
			onMouseEnter={onActivateRow}
			onClick={() => onSelectProject(project.id)}
		>
			<td className="max-w-[280px] px-2 py-1.5 align-middle">
				<div className="flex min-w-0 items-center gap-1.5">
					<span
						className={cn(
							"truncate text-[13px] font-medium",
							isCurrentProject ? "text-accent" : "text-text-primary",
						)}
					>
						{renderFuzzyHighlightedText(
							project.name,
							row.projectNameMatchPositions ?? undefined,
							FUZZY_MATCHED_TEXT_STYLE,
						)}
					</span>
					{isCurrentProject ? (
						<span
							data-testid="project-switcher-current-project-marker"
							className="inline-flex shrink-0 items-center rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-medium text-accent"
						>
							Current
						</span>
					) : null}
					{isProjectUnavailable ? (
						<span
							role="status"
							aria-label="Project unavailable"
							className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-orange/20 px-1.5 py-px text-[10px] font-medium text-status-orange"
						>
							<AlertTriangle size={10} />
							Unavailable
						</span>
					) : null}
				</div>
				<div className="truncate font-mono text-[10px] text-text-secondary" title={project.path}>
					{formatPathForDisplay(project.path)}
				</div>
			</td>

			{columnVisibility.numeric_slot_group ? (
				<td className="px-2 py-1.5 align-middle">
					<ProjectSwitcherNumericSlotCell
						projectId={project.id}
						projectName={project.name}
						numericSlotGroupNumber={row.numericSlotGroupNumber}
						projectNameByNumericSlotGroupNumber={projectNameByNumericSlotGroupNumber}
						onAssignProjectToNumericSlotGroupNumber={onAssignProjectToNumericSlotGroupNumber}
						onClearNumericSlotGroupNumber={onClearNumericSlotGroupNumber}
					/>
				</td>
			) : null}

			<td className="px-2 py-1.5 text-center align-middle">
				<NumericCountCell
					count={deriveLiveAgentTaskCount(project)}
					toneClassName="bg-accent/20 text-accent"
					title="Tasks whose main agent currently holds the turn"
				/>
			</td>

			{columnVisibility.awaiting_user_task_count ? (
				<td className="px-2 py-1.5 text-center align-middle">
					<NumericCountCell
						count={deriveAwaitingUserTaskCount(project)}
						toneClassName="bg-accent-2/20 text-accent-2"
						title="Tasks waiting for you in Review"
					/>
				</td>
			) : null}

			{columnVisibility.task_distribution_badges ? (
				<td className="px-2 py-1.5 align-middle">
					{taskDistributionBadges.length > 0 ? (
						<div className="flex gap-1">
							{taskDistributionBadges.map((badge) => (
								<span
									key={badge.id}
									className={cn(
										"inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium",
										badge.toneClassName,
									)}
									title={badge.title}
								>
									<span>{badge.shortLabel}</span>
									<span style={{ opacity: 0.4 }}>|</span>
									<span>{badge.count}</span>
								</span>
							))}
						</div>
					) : (
						<span className="text-text-tertiary">—</span>
					)}
				</td>
			) : null}

			{columnVisibility.last_visited ? (
				<td className="whitespace-nowrap px-2 py-1.5 text-right align-middle text-[11px] text-text-secondary">
					{row.lastVisitedEpochMs === null ? (
						<span className="text-text-tertiary">Never</span>
					) : (
						formatCompactElapsedSince(row.lastVisitedEpochMs, nowEpochMs)
					)}
				</td>
			) : null}
		</tr>
	);
}
