import { Droppable } from "@hello-pangea/dnd";
import { UnfoldHorizontal } from "lucide-react";
import { memo } from "react";

import { boardColumnAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

/**
 * 主看板上被折叠的 stage 列：约 40px 宽的竖条，只显示指示器、卡片数和竖排标题，点击即展开。
 *
 * 刻意仍挂着同 id 的 `Droppable`：
 * - 用户可以把卡直接拖进折叠列（落点 index 0）；
 * - 程序化移卡按列序 `moveRight/moveLeft` 逐步走 droppable，折叠列若卸载 droppable 步数就会对不上。
 * 卡片本身不渲染（placeholder 收进 0 高容器），所以竖条宽度不会被拖入的卡片撑开。
 */
export const BoardColumnCollapsedVerticalStrip = memo(function BoardColumnCollapsedVerticalStrip({
	column,
	onExpandColumn,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
}: {
	column: BoardColumnModel;
	onExpandColumn: (columnId: BoardColumnId) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
}): React.ReactElement {
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		programmaticCardMoveInFlight,
	});
	const expandLabel = `Expand ${column.title} column`;

	return (
		<section
			data-column-id={column.id}
			data-verification-anchor={boardColumnAnchorKey(column.id)}
			data-kanban-board-column-collapsed="true"
			className="flex flex-col min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border"
			style={{ flex: "0 0 40px" }}
		>
			<Droppable droppableId={column.id} type="CARD" isDropDisabled={isDropDisabled}>
				{(cardProvided, cardSnapshot) => (
					<div
						ref={cardProvided.innerRef}
						{...cardProvided.droppableProps}
						className={cn(
							"flex flex-1 min-h-0 flex-col transition-colors",
							cardSnapshot.isDraggingOver && "bg-surface-3",
						)}
					>
						<button
							type="button"
							onClick={() => onExpandColumn(column.id)}
							aria-expanded={false}
							aria-label={expandLabel}
							title={expandLabel}
							className="flex flex-1 min-h-0 flex-col items-center gap-2 py-3 cursor-pointer text-text-secondary hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
						>
							<UnfoldHorizontal size={14} aria-hidden />
							<ColumnIndicator columnId={column.id} />
							<span className="text-xs">{column.cards.length}</span>
							<span className="font-semibold text-sm text-text-primary whitespace-nowrap [writing-mode:vertical-rl]">
								{column.title}
							</span>
						</button>
						<div aria-hidden className="h-0 overflow-hidden">
							{cardProvided.placeholder}
						</div>
					</div>
				)}
			</Droppable>
		</section>
	);
});
