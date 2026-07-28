import type { ProjectSwitcherRow } from "@/components/top-bar-project-switcher/project-switcher-row-ordering";
import type { ProjectSwitcherTableColumnVisibility } from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";
import { ProjectSwitcherTableRow } from "@/components/top-bar-project-switcher/project-switcher-table-row";
import type { ProjectNumericSlotGroupNumber } from "@/hooks/use-project-numeric-slot-group-assignments";

export function ProjectSwitcherTable({
	rows,
	currentProjectId,
	activeRowIndex,
	columnVisibility,
	nowEpochMs,
	projectNameByNumericSlotGroupNumber,
	onSelectProject,
	onActiveRowIndexChange,
	onAssignProjectToNumericSlotGroupNumber,
	onClearNumericSlotGroupNumber,
}: {
	rows: readonly ProjectSwitcherRow[];
	currentProjectId: string | null;
	activeRowIndex: number;
	columnVisibility: ProjectSwitcherTableColumnVisibility;
	nowEpochMs: number;
	projectNameByNumericSlotGroupNumber: ReadonlyMap<ProjectNumericSlotGroupNumber, string>;
	onSelectProject: (projectId: string) => void;
	onActiveRowIndexChange: (rowIndex: number) => void;
	onAssignProjectToNumericSlotGroupNumber: (
		slotNumber: ProjectNumericSlotGroupNumber,
		targetProjectId: string,
	) => void;
	onClearNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber) => void;
}): React.ReactElement {
	// 2 = 必有列（项目名 + Live），其余额外列按各自可见性计入，空态行的 colSpan 才不会串列。
	const visibleColumnCount =
		2 +
		(columnVisibility.numeric_slot_group ? 1 : 0) +
		(columnVisibility.awaiting_user_task_count ? 1 : 0) +
		(columnVisibility.task_distribution_badges ? 1 : 0) +
		(columnVisibility.last_visited ? 1 : 0);

	return (
		// 宽表必须在自己的容器里横向滚动，绝不能让 popover 面板本身横向滚动。
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-left">
				<thead>
					<tr className="text-[10px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
						<th scope="col" className="px-2 pb-1 font-medium">
							Project
						</th>
						{columnVisibility.numeric_slot_group ? (
							<th scope="col" className="px-2 pb-1 font-medium">
								Slot
							</th>
						) : null}
						<th scope="col" className="px-2 pb-1 text-center font-medium" title="Tasks with a live agent">
							Live
						</th>
						{columnVisibility.awaiting_user_task_count ? (
							<th scope="col" className="px-2 pb-1 text-center font-medium">
								Awaiting you
							</th>
						) : null}
						{columnVisibility.task_distribution_badges ? (
							<th scope="col" className="px-2 pb-1 font-medium">
								Tasks
							</th>
						) : null}
						{columnVisibility.last_visited ? (
							<th scope="col" className="px-2 pb-1 text-right font-medium">
								Last visited
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<tr>
							<td colSpan={visibleColumnCount} className="px-2 py-3 text-[13px] text-text-tertiary">
								No matching projects
							</td>
						</tr>
					) : (
						rows.map((row, rowIndex) => (
							<ProjectSwitcherTableRow
								key={row.project.id}
								row={row}
								isCurrentProject={row.project.id === currentProjectId}
								isActiveRow={rowIndex === activeRowIndex}
								columnVisibility={columnVisibility}
								nowEpochMs={nowEpochMs}
								projectNameByNumericSlotGroupNumber={projectNameByNumericSlotGroupNumber}
								onSelectProject={onSelectProject}
								onActivateRow={() => onActiveRowIndexChange(rowIndex)}
								onAssignProjectToNumericSlotGroupNumber={onAssignProjectToNumericSlotGroupNumber}
								onClearNumericSlotGroupNumber={onClearNumericSlotGroupNumber}
							/>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}
