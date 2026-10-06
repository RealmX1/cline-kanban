// dd2db Relations 面板里记录型关系行（1b）与断言型关系行（2.1）共用的小件：邻居工作单元引用（可跨项目打开）、
// 状态徽标、分区小标题、tooltip 时间格式。单独成文件，免得断言型关系的 section 组件反向 import 面板文件形成环。

import { ArrowUpRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import type { WorkUnitRelationNeighborPresentation } from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";

export function formatEpochMsAsUtcMinuteForRelationTooltip(epochMs: number): string {
	return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

export function RelationStatusBadge({ className, children }: { className: string; children: ReactNode }): ReactElement {
	return <span className={cn("shrink-0 rounded-sm px-1.5 py-px text-[11px] font-medium", className)}>{children}</span>;
}

export function RelationNeighborhoodSectionHeading({ children }: { children: ReactNode }): ReactElement {
	return <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-text-tertiary">{children}</div>;
}

export function RelationNeighborWorkUnitReference({
	neighbor,
	openNeighborKanbanBoardCardInItsProject,
}: {
	neighbor: WorkUnitRelationNeighborPresentation;
	// null = 没有跨项目打开宿主（单测 / 独立挂载）：邻居只展示。
	openNeighborKanbanBoardCardInItsProject: ((workspaceId: string, taskId: string) => void) | null;
}): ReactElement {
	if (neighbor.neighborWorkUnitType === "kanban_unmanaged_standalone_agent_conversation_session") {
		return <span className="text-text-primary">{neighbor.neighborWorkUnitDisplayLabel}</span>;
	}
	const neighborTitle =
		neighbor.neighborKanbanBoardCardCurrentTitle ?? `task ${neighbor.neighborKanbanBoardCardTaskId}`;
	const openAvailability = neighbor.neighborKanbanBoardCardOpenInProjectAvailability;
	const openThisNeighborKanbanBoardCardInItsProject = openAvailability.isNeighborKanbanBoardCardOpenable
		? openNeighborKanbanBoardCardInItsProject
		: null;
	return (
		<span className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle">
			{openThisNeighborKanbanBoardCardInItsProject ? (
				<button
					type="button"
					className="inline-flex min-w-0 items-center gap-0.5 text-left text-text-primary underline-offset-2 hover:text-accent hover:underline"
					title={`打开 ${neighbor.neighborWorkUnitDisplayLabel}`}
					aria-label={`打开 ${neighbor.neighborWorkUnitDisplayLabel}`}
					onClick={() =>
						openThisNeighborKanbanBoardCardInItsProject(
							neighbor.neighborKanbanBoardCardWorkspaceId,
							neighbor.neighborKanbanBoardCardTaskId,
						)
					}
				>
					<span className="min-w-0 break-words">{neighborTitle}</span>
					<ArrowUpRight size={11} className="shrink-0" />
				</button>
			) : (
				<span
					className="min-w-0 break-words text-text-primary"
					title={
						openAvailability.isNeighborKanbanBoardCardOpenable
							? neighbor.neighborWorkUnitDisplayLabel
							: openAvailability.neighborKanbanBoardCardNotOpenableReason
					}
				>
					{neighborTitle}
				</span>
			)}
			<RelationStatusBadge className="bg-surface-3 font-normal text-text-secondary">
				<span title={neighbor.neighborKanbanBoardCardWorkspaceId}>
					{neighbor.neighborKanbanBoardCardWorkspaceDisplayName}
					{neighbor.isNeighborKanbanBoardCardInCurrentKanbanProject ? "（本项目）" : ""}
				</span>
			</RelationStatusBadge>
			{neighbor.neighborKanbanBoardCardPresenceOnBoardStatus === "moved_to_done_trash_column" ? (
				<RelationStatusBadge className="bg-status-orange/15 text-status-orange">
					在 Done（trash）
				</RelationStatusBadge>
			) : null}
			{neighbor.neighborKanbanBoardCardPresenceOnBoardStatus ===
			"permanently_removed_from_kanban_board_tombstone" ? (
				<RelationStatusBadge className="bg-status-red/15 text-status-red">墓碑 · 已永久删除</RelationStatusBadge>
			) : null}
		</span>
	);
}
