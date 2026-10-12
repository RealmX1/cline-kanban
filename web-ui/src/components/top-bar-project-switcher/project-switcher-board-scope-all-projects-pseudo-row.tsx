import { Layers } from "lucide-react";

import { formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import {
	deriveAwaitingUserTaskCount,
	deriveLiveAgentTaskCount,
} from "@/components/top-bar-project-switcher/project-switcher-session-activity-counts";
import type { ProjectSwitcherTableColumnVisibility } from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";

/**
 * 项目切换器表格首行的「All projects」伪行 = Board Scope（docs/context-board-scope-all-projects-and-single-project-scope.md）。
 * 选中后看板页显示 All projects 首页（跨项目切换面板的分区横排成列）、Focus View 左栏显示跨项目「最近活跃任务」
 * 切换面板（见 use-selected-board-or-single-project-scope）。与项目行共用同一套键盘高亮索引（它是第 0 行）。
 */
export function ProjectSwitcherBoardScopeAllProjectsPseudoRow({
	projects,
	isBoardScopeAllProjectsSelected,
	isActiveRow,
	columnVisibility,
	onSelectBoardScopeAllProjects,
	onActivateRow,
}: {
	projects: readonly RuntimeProjectSummary[];
	isBoardScopeAllProjectsSelected: boolean;
	isActiveRow: boolean;
	columnVisibility: ProjectSwitcherTableColumnVisibility;
	onSelectBoardScopeAllProjects: () => void;
	onActivateRow: () => void;
}): React.ReactElement {
	const liveAgentTaskCountAcrossProjects = projects.reduce(
		(total, project) => total + deriveLiveAgentTaskCount(project),
		0,
	);
	const awaitingUserTaskCountAcrossProjects = projects.reduce(
		(total, project) => total + deriveAwaitingUserTaskCount(project),
		0,
	);
	return (
		<tr
			data-testid="project-switcher-board-scope-all-projects-pseudo-row"
			aria-current={isActiveRow ? "true" : undefined}
			className={cn("cursor-pointer", isActiveRow ? "bg-surface-3" : "hover:bg-surface-3/60")}
			onMouseEnter={onActivateRow}
			onClick={onSelectBoardScopeAllProjects}
		>
			<td className="max-w-[280px] px-2 py-1.5 align-middle">
				<div className="flex min-w-0 items-center gap-1.5">
					<Layers size={13} className="shrink-0 text-text-secondary" aria-hidden />
					<span
						className={cn(
							"truncate text-[13px] font-medium",
							isBoardScopeAllProjectsSelected ? "text-accent" : "text-text-primary",
						)}
					>
						All projects
					</span>
					{isBoardScopeAllProjectsSelected ? (
						<span className="inline-flex shrink-0 items-center rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-medium text-accent">
							Current
						</span>
					) : null}
				</div>
				<div className="truncate text-[10px] text-text-secondary">
					Recent tasks across projects · {formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel()} toggles with the
					focused task's project
				</div>
			</td>
			{columnVisibility.numeric_slot_group ? <td className="px-2 py-1.5" /> : null}
			<td className="px-2 py-1.5 text-center align-middle text-[11px] text-text-secondary">
				{liveAgentTaskCountAcrossProjects > 0 ? liveAgentTaskCountAcrossProjects : "—"}
			</td>
			{columnVisibility.awaiting_user_task_count ? (
				<td className="px-2 py-1.5 text-center align-middle text-[11px] text-text-secondary">
					{awaitingUserTaskCountAcrossProjects > 0 ? awaitingUserTaskCountAcrossProjects : "—"}
				</td>
			) : null}
			{columnVisibility.task_distribution_badges ? <td className="px-2 py-1.5" /> : null}
			{columnVisibility.last_visited ? <td className="px-2 py-1.5" /> : null}
		</tr>
	);
}
