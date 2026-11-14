import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Play, RotateCcw, Trash2 } from "lucide-react";
import type { FocusViewGroupHeaderPresentation } from "@/components/detail-panels/stage-header-rail-geometry";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardCard as BoardCardModel, BoardDisplayGroup } from "@/types";

export function FocusViewStageGroupHeaderActions({
	column,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onRestoreFromTrashTask,
	presentation = "standard",
}: {
	column: BoardDisplayGroup;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	presentation?: FocusViewGroupHeaderPresentation;
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
	if (presentation === "compact") {
		if (!canRequestStartAllReadyBacklogTasks && !canClearTrash && !(column.id === "trash" && onRestoreFromTrashTask))
			return null;
		const itemClassName =
			"flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
		return (
			<DropdownMenu.Root>
				<Tooltip content={`${column.title} 更多操作`} side="right">
					<DropdownMenu.Trigger asChild>
						<button
							type="button"
							aria-label={`${column.title} 更多操作`}
							className="inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
						>
							<MoreHorizontal size={14} />
						</button>
					</DropdownMenu.Trigger>
				</Tooltip>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="end"
						sideOffset={4}
						className="z-50 rounded-md border border-border bg-surface-1 p-1 text-text-primary"
						data-mobile-focus-view-idle-collapse-suspension=""
					>
						{canRequestStartAllReadyBacklogTasks ? (
							<DropdownMenu.Item
								className={itemClassName}
								disabled={column.cards.length === 0}
								onSelect={onRequestStartAllReadyBacklogTasks}
							>
								<Play size={14} />
								启动所有就绪任务
							</DropdownMenu.Item>
						) : null}
						{column.id === "trash" && onRestoreFromTrashTask ? (
							<DropdownMenu.Item
								className={itemClassName}
								disabled={!latestTrashCard}
								onSelect={() => {
									if (latestTrashCard) onRestoreFromTrashTask(latestTrashCard.id);
								}}
							>
								<RotateCcw size={14} />
								重新打开最近结案的任务
							</DropdownMenu.Item>
						) : null}
						{canClearTrash ? (
							<DropdownMenu.Item
								className={`${itemClassName} text-status-red`}
								disabled={column.cards.length === 0}
								onSelect={onClearTrash}
							>
								<Trash2 size={14} />
								永久删除已结案任务
							</DropdownMenu.Item>
						) : null}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		);
	}
	return (
		<>
			{canRequestStartAllReadyBacklogTasks ? (
				<Button
					icon={<Play size={14} />}
					variant="ghost"
					size="xs"
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
					size="xs"
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
					size="xs"
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
