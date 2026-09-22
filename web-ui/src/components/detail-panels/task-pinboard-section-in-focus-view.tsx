import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import type { ReactElement } from "react";

import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/**
 * Focus View 左侧任务列表顶部的置顶板分段，外观与 `ColumnSection` 同构。
 *
 * 🔴 刻意**不带** `data-stage-section-id`：`useStageHeaderPinLayout` 按该属性枚举 stage 分段做卡头手风琴，
 * 带上就会被当成第六个 stage。它占掉的顶部高度由那个 hook 的实时 `getBoundingClientRect` 自然吸收。
 */
export function TaskPinboardSectionInFocusView({
	pinnedTasks,
	selectedCardId,
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
	selectedCardId: string | null;
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
		LocalStorageKey.TaskPinboardSectionCollapsedInFocusView,
		false,
	);

	if (pinnedTasks.length === 0) {
		return null;
	}

	return (
		<div
			data-task-pinboard-container="focus-view-section"
			className="shrink-0 rounded-lg border border-border bg-surface-1"
		>
			<div className="flex h-10 items-center">
				<button
					type="button"
					onClick={() => setCollapsed((previousCollapsed) => !previousCollapsed)}
					aria-expanded={!collapsed}
					className="mx-1 flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2 text-left text-text-primary hover:bg-surface-0"
				>
					{collapsed ? (
						<ChevronRight size={16} className="shrink-0 text-text-secondary" />
					) : (
						<ChevronDown size={16} className="shrink-0 text-text-secondary" />
					)}
					<Pin size={13} className="shrink-0 text-accent" />
					<span className="truncate text-sm font-semibold">Pinned</span>
					<span className="text-xs text-text-tertiary">{pinnedTasks.length}</span>
				</button>
			</div>
			{collapsed ? null : (
				<div className="flex flex-col px-2 pb-2">
					{pinnedTasks.map(({ card, columnId, columnTitle }) => (
						<div key={card.id} className="mb-1.5 last:mb-0">
							<TaskCardBody
								renderRole="pinned_card_copy_in_task_pinboard"
								stageDisplayNameForTaskPinboardCopy={columnTitle}
								onNavigateToCanonicalCardInItsStage={onRevealCanonicalCardInItsStage}
								onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
								{...buildTaskCardBusinessProps({
									card,
									columnId,
									sessionSummary: taskSessions[card.id],
									selected: card.id === selectedCardId,
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
