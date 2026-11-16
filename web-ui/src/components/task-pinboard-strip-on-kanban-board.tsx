import { resolveMainTaskConversationSessionSummary } from "@runtime-session-activity";
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import type { ReactElement } from "react";
import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { BOARD_TASK_GROUP_HEADER_HEIGHT_PX } from "@/components/task-group-header-geometry";
import { cn } from "@/components/ui/cn";
import { getTaskGroupSemanticColorStyle } from "@/data/task-group-semantic-color-style";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/** 分身卡固定宽度：横条是横向滚动的一行，卡片必须定宽才不会被内容撑成各种尺寸。 */
const TASK_PINBOARD_CARD_WIDTH_PX = 280;

/**
 * 主看板顶部的置顶板，桌面横排，手机随阶段列表纵向滚动。
 *
 * 🔴 它必须渲染在 `<section className="kb-board">` **之外**：
 * - `.kb-board > section` 的响应式规则只适用于阶段；
 * - `.kb-board` 同时是 `getPrimaryBoardTaskElement` 的查询根，放在外面才能保证置顶板里的分身不被它扫到。
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
	defaultAgentId,
	compactRowWithExpandableDetails = false,
}: {
	pinnedTasks: TaskPinnedToTaskPinboard[];
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	handlers: TaskCardActionHandlerBundle;
	onActivateCard: (card: BoardCard) => void;
	onRevealCanonicalCardInItsStage: (taskId: string) => void;
	onEditTaskPinboardPinReason?: (taskId: string) => void;
	workspacePath?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
	compactRowWithExpandableDetails?: boolean;
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
			className="kb-task-group mx-0.5 mt-2 shrink-0"
			style={getTaskGroupSemanticColorStyle("pinned")}
		>
			<button
				type="button"
				onClick={() => setCollapsed((previousCollapsed) => !previousCollapsed)}
				aria-expanded={!collapsed}
				style={{ height: compactRowWithExpandableDetails ? 44 : BOARD_TASK_GROUP_HEADER_HEIGHT_PX }}
				className="kb-task-group-header flex w-full cursor-pointer items-center gap-2 px-3 text-left text-text-primary hover:bg-surface-0 focus-visible:outline-2 focus-visible:outline-accent"
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
				<div
					className={cn(
						"flex gap-2 px-0.5 pb-3",
						compactRowWithExpandableDetails ? "flex-col" : "overflow-x-auto",
					)}
				>
					{pinnedTasks.map(({ card, columnId, columnTitle }) => (
						<div
							key={`${card.id}:${card.createdAt}`}
							className="min-w-0 shrink-0"
							style={compactRowWithExpandableDetails ? undefined : { width: TASK_PINBOARD_CARD_WIDTH_PX }}
						>
							<TaskCardBody
								compactRowWithExpandableDetails={compactRowWithExpandableDetails}
								renderRole="pinned_card_copy_in_task_pinboard"
								stageDisplayNameForTaskPinboardCopy={columnTitle}
								onNavigateToCanonicalCardInItsStage={onRevealCanonicalCardInItsStage}
								onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
								{...buildTaskCardBusinessProps({
									card,
									columnId,
									sessionSummary: resolveMainTaskConversationSessionSummary(card, taskSessions) ?? undefined,
									taskSessions,
									handlers,
									onActivateCard,
									workspacePath,
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
