import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { WorkUnitDisplayEntry } from "@runtime-work-unit-relation-read-api-contract";
import type { WorkUnitRelationNeighborPresentation } from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";

export interface RelationTaskCardPreviewTarget {
	workUnitKey: string;
	title: string;
	task: KanbanBoardCardWorkUnitQualifiedReference | null;
	workspaceRepositoryPath: string | null;
	unavailableReason: string | null;
}

export function buildRelationTaskCardPreviewTargetFromDisplayEntry(
	entry: WorkUnitDisplayEntry | undefined,
	workUnitKey: string,
	title: string,
): RelationTaskCardPreviewTarget {
	return {
		workUnitKey,
		title,
		task:
			entry?.workUnit.workUnitType === "kanban_board_card"
				? (entry.kanbanBoardCardIdentity?.kanbanBoardCard ?? entry.workUnit)
				: null,
		workspaceRepositoryPath: entry?.kanbanBoardCardIdentity?.workspaceRepositoryPath ?? null,
		unavailableReason: !entry
			? workUnitKey === "pending-task-creation"
				? "任务尚未创建，创建后才能预览完整卡片。"
				: "尚未取得这项工作单元的完整身份，无法预览任务卡片。"
			: entry.workUnit.workUnitType !== "kanban_board_card"
				? "这是独立会话，没有对应的任务卡片。"
				: entry.kanbanBoardCardIdentity?.permanentlyRemovedFromBoardAt != null
					? "这张卡已被永久删除，只剩关系账本里的墓碑记录。"
					: null,
	};
}

export function buildRelationTaskCardPreviewTargetFromNeighbor(
	neighbor: WorkUnitRelationNeighborPresentation,
): RelationTaskCardPreviewTarget {
	if (neighbor.neighborWorkUnitType !== "kanban_board_card")
		return {
			workUnitKey: neighbor.neighborWorkUnitKey,
			title: neighbor.neighborWorkUnitDisplayLabel,
			task: null,
			workspaceRepositoryPath: null,
			unavailableReason: "这是独立会话，没有对应的任务卡片。",
		};
	return {
		workUnitKey: neighbor.neighborWorkUnitKey,
		title: neighbor.neighborKanbanBoardCardCurrentTitle ?? neighbor.neighborWorkUnitDisplayLabel,
		task: {
			workUnitType: "kanban_board_card",
			workspaceId: neighbor.neighborKanbanBoardCardWorkspaceId,
			taskId: neighbor.neighborKanbanBoardCardTaskId,
			taskIncarnationCreatedAtEpochMs: neighbor.neighborKanbanBoardCardTaskIncarnationCreatedAtEpochMs,
		},
		workspaceRepositoryPath: neighbor.neighborKanbanBoardCardWorkspaceRepositoryPath,
		// 项目可用性随宿主广播变化，由布局在读取时判断；这里只保留不会自行恢复的墓碑状态。
		unavailableReason:
			neighbor.neighborKanbanBoardCardPresenceOnBoardStatus === "permanently_removed_from_kanban_board_tombstone"
				? "这张卡已被永久删除，只剩关系账本里的墓碑记录。"
				: null,
	};
}
