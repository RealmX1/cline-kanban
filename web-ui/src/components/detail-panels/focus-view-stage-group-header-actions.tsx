import { Play, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BoardCard as BoardCardModel, BoardDisplayGroup } from "@/types";

export function FocusViewStageGroupHeaderActions({
	column,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onRestoreFromTrashTask,
}: {
	column: BoardDisplayGroup;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
}) {
	const canRequestStartAllReadyBacklogTasks = column.id === "backlog" && onRequestStartAllReadyBacklogTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	const latestTrashCard =
		column.id === "trash"
			? column.cards.reduce<BoardCardModel | null>((latestCard, card) => {
					if (!latestCard || card.updatedAt > latestCard.updatedAt) {
						return card;
					}
					return latestCard;
				}, null)
			: null;
	return (
		<>
			{canRequestStartAllReadyBacklogTasks ? (
				<Button
					icon={<Play size={14} />}
					variant="ghost"
					size="sm"
					onClick={onRequestStartAllReadyBacklogTasks}
					disabled={column.cards.length === 0}
					aria-label="Start all ready backlog tasks"
					title={column.cards.length > 0 ? "Start all ready backlog tasks" : "Backlog is empty"}
					style={{ marginRight: 4 }}
				/>
			) : null}
			{column.id === "trash" && onRestoreFromTrashTask ? (
				<Button
					icon={<RotateCcw size={14} />}
					variant="ghost"
					size="sm"
					onClick={() => {
						if (latestTrashCard) {
							onRestoreFromTrashTask(latestTrashCard.id);
						}
					}}
					disabled={!latestTrashCard}
					aria-label="重新打开最近结案的任务"
					title={latestTrashCard ? "重新打开最近结案的任务" : "暂无已结案任务"}
					style={{ marginRight: 4 }}
				/>
			) : null}
			{canClearTrash ? (
				<Button
					icon={<Trash2 size={14} />}
					variant="ghost"
					size="sm"
					className="text-status-red hover:text-status-red"
					onClick={onClearTrash}
					disabled={column.cards.length === 0}
					aria-label="Clear done"
					title={column.cards.length > 0 ? "永久删除已结案任务" : "暂无已结案任务"}
					style={{ marginRight: 4 }}
				/>
			) : null}
		</>
	);
}
