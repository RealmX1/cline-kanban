import { Droppable } from "@hello-pangea/dnd";
import { ChevronRight, UnfoldHorizontal } from "lucide-react";
import { memo } from "react";

import { boardColumnAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { cn } from "@/components/ui/cn";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { getTaskGroupSemanticColorStyle } from "@/data/task-group-semantic-color-style";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardDisplayGroup as BoardColumnModel, BoardDisplayGroupId } from "@/types";

/**
 * 主看板折叠的阶段：桌面为 40px 竖条，手机为整行标题，点击即展开。
 *
 * 刻意仍挂着同 id 的 `Droppable`：
 * - 用户可以把卡直接拖进折叠列（落点 index 0）；
 * - 程序化移卡按列序 `moveRight/moveLeft` 逐步走 droppable，折叠列若卸载 droppable 步数就会对不上。
 * 卡片本身不渲染（placeholder 收进 0 高容器），所以竖条宽度不会被拖入的卡片撑开。
 */
export const BoardColumnCollapsedSection = memo(function BoardColumnCollapsedSection({
	column,
	onExpandColumn,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
}: {
	column: BoardColumnModel;
	onExpandColumn: (columnId: BoardDisplayGroupId) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardDisplayGroupId | null;
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
			className="kb-task-group flex flex-col min-h-0 overflow-hidden"
			style={{ ...getTaskGroupSemanticColorStyle(column.id), flex: "0 0 40px" }}
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
						{/* max-[768px] 会编译成 width < 768px，漏掉与手机布局相同的 768px 含边界。 */}
						<button
							type="button"
							onClick={() => onExpandColumn(column.id)}
							aria-expanded={false}
							aria-label={expandLabel}
							title={expandLabel}
							className="kb-task-group-header flex flex-1 min-h-0 flex-col items-center gap-2 py-3 cursor-pointer text-text-secondary hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent [@media(max-width:768px)]:h-11 [@media(max-width:768px)]:min-h-11 [@media(max-width:768px)]:flex-row [@media(max-width:768px)]:px-3 [@media(max-width:768px)]:py-0"
						>
							<UnfoldHorizontal size={14} aria-hidden className="[@media(max-width:768px)]:hidden" />
							<ChevronRight size={14} aria-hidden className="hidden [@media(max-width:768px)]:block" />
							<ColumnIndicator columnId={column.id} />
							<span className="text-xs [@media(max-width:768px)]:order-last [@media(max-width:768px)]:ml-auto">
								{column.cards.length}
							</span>
							<span className="font-semibold text-sm text-text-primary whitespace-nowrap [writing-mode:vertical-rl] [@media(max-width:768px)]:[writing-mode:horizontal-tb]">
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
