import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import type { ReactElement } from "react";

import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/** 分身卡固定宽度：横条是横向滚动的一行，卡片必须定宽才不会被内容撑成各种尺寸。 */
const TASK_PINBOARD_CARD_WIDTH_PX = 280;

/**
 * 主看板顶部的置顶板横条。
 *
 * 🔴 它必须渲染在 `<section className="kb-board">` **之外**：
 * - `globals.css` 的 `.kb-board > section { flex: 0 0 auto !important; width: 92vw }` 会在移动端
 *   把任何直接子 section 当成「一列看板列」处理，横条会被拉成一整列宽；
 * - `.kb-board` 同时是 `DependencyOverlay` 的 containerRef 与 `getPrimaryBoardTaskElement` 的查询根，
 *   放在外面才能保证置顶板里的分身不被这两者扫到。
 *
 * 一张都没置顶时整条不渲染——不给从不使用该功能的用户平白占掉 40px 看板高度。
 */
export function TaskPinboardStripOnKanbanBoard({
	pinnedTasks,
	taskSessions,
	handlers,
	onActivateCard,
	onRevealCanonicalCardInItsStage,
	onEditTaskPinboardPinReason,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: {
	pinnedTasks: TaskPinnedToTaskPinboard[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	handlers: TaskCardActionHandlerBundle;
	onActivateCard: (card: BoardCard) => void;
	onRevealCanonicalCardInItsStage: (taskId: string) => void;
	onEditTaskPinboardPinReason?: (taskId: string) => void;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement | null {
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.TaskPinboardStripCollapsedOnKanbanBoard,
		false,
	);

	if (pinnedTasks.length === 0) {
		return null;
	}

	return (
		<div
			data-task-pinboard-container="kanban-board-strip"
			className="mx-2 mt-2 shrink-0 rounded-lg border border-border bg-surface-1"
		>
			<button
				type="button"
				onClick={() => setCollapsed((previousCollapsed) => !previousCollapsed)}
				aria-expanded={!collapsed}
				className="flex h-10 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 text-left text-text-primary hover:bg-surface-0"
			>
				{collapsed ? (
					<ChevronRight size={16} className="shrink-0 text-text-secondary" />
				) : (
					<ChevronDown size={16} className="shrink-0 text-text-secondary" />
				)}
				<Pin size={13} className="shrink-0 text-accent" />
				<span className="text-sm font-semibold">Pinned</span>
				<span className="text-xs text-text-tertiary">{pinnedTasks.length}</span>
			</button>
			{collapsed ? null : (
				<div className="flex gap-2 overflow-x-auto px-3 pb-3 pt-1">
					{pinnedTasks.map(({ card, columnId, columnTitle }) => (
						<div key={card.id} className="shrink-0" style={{ width: TASK_PINBOARD_CARD_WIDTH_PX }}>
							<TaskCardBody
								renderRole="pinned_card_copy_in_task_pinboard"
								stageDisplayNameForTaskPinboardCopy={columnTitle}
								onNavigateToCanonicalCardInItsStage={onRevealCanonicalCardInItsStage}
								onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
								{...buildTaskCardBusinessProps({
									card,
									columnId,
									sessionSummary: taskSessions[card.id],
									handlers,
									onActivateCard,
									workspacePath,
									defaultClineModelId,
									defaultAgentId,
								})}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
