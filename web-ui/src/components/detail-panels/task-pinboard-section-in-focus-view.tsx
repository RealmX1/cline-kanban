import { resolveMainTaskConversationSessionSummary } from "@runtime-session-activity";
import { ChevronDown, ChevronUp, Pin } from "lucide-react";
import { type ReactElement, useState } from "react";
import { FocusViewGroupHeader } from "@/components/detail-panels/focus-view-group-header";
import { useFocusViewPinnedSectionOwnScrollbarSlot } from "@/components/detail-panels/focus-view-group-header-rails";

import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { getTaskGroupSemanticColorStyle } from "@/data/task-group-semantic-color-style";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { TaskPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardCard } from "@/types";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/** 分段展开时默认露出的置顶分身张数；超出部分由分段最下方的按钮展开。 */
const DEFAULT_VISIBLE_PINNED_TASK_COUNT_IN_FOCUS_VIEW_PINBOARD_SECTION = 5;

/**
 * Focus View 左侧任务列表顶部的置顶板分段，外观与 `ColumnSection` 同构。
 *
 * 位于 stage 列表的 scrollport（`.kb-detail-task-list-scroll`）**之外**，是面板顶部的固定区：不随列表滚走。
 * stage 卡头 rail 锚在 scrollport 所在的「stage 列表区」上，故顶沿 rail 从本分段下沿起算、不会盖住它。
 * 分段整体限高，展开全部后超出部分在分段内部滚动，不把下方的 stage 列表挤没。
 *
 * 🔴 刻意**不带** `data-stage-section-id`：`useStageHeaderPinLayout` 按该属性枚举 stage 分段做卡头手风琴，
 * 带上就会被当成第六个 stage。
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
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement | null {
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.TaskPinboardSectionCollapsedInFocusView,
		false,
	);
	// 只存内存：每次重新挂载都回到「默认 5 张」。
	const [showsAllPinnedTasksBeyondDefaultVisibleCount, setShowsAllPinnedTasksBeyondDefaultVisibleCount] =
		useState(false);
	const pinnedScrollbarSlot = useFocusViewPinnedSectionOwnScrollbarSlot();

	if (pinnedTasks.length === 0) {
		return null;
	}

	const hiddenPinnedTaskCountBeyondDefaultVisibleCount = Math.max(
		0,
		pinnedTasks.length - DEFAULT_VISIBLE_PINNED_TASK_COUNT_IN_FOCUS_VIEW_PINBOARD_SECTION,
	);
	const visiblePinnedTasks = showsAllPinnedTasksBeyondDefaultVisibleCount
		? pinnedTasks
		: pinnedTasks.slice(0, DEFAULT_VISIBLE_PINNED_TASK_COUNT_IN_FOCUS_VIEW_PINBOARD_SECTION);

	return (
		<div
			data-task-pinboard-container="focus-view-section"
			className="kb-task-group ml-0.5 mr-[calc(2px+var(--kb-focus-view-column-scrollbar-width,0px))] mt-1 flex min-h-0 min-w-0 flex-col"
			// EXPERIMENT_NODE: Pinned 固定区的高度上限比例（50% 面板高），决定展开全部后给 stage 列表留多少空间。
			style={{ ...getTaskGroupSemanticColorStyle("pinned"), maxHeight: "50%" }}
		>
			<FocusViewGroupHeader
				title="Pinned"
				count={pinnedTasks.length}
				icon={<Pin size={13} className="text-accent" />}
				isExpanded={!collapsed}
				onToggleExpanded={() => setCollapsed((previousCollapsed) => !previousCollapsed)}
			/>
			{collapsed ? null : (
				<div
					ref={pinnedScrollbarSlot.ref}
					style={pinnedScrollbarSlot.style}
					className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-0.5 pb-2"
				>
					{visiblePinnedTasks.map(({ card, columnId, columnTitle }) => (
						<div key={card.id} className="mb-1.5 last:mb-0">
							<TaskCardBody
								renderRole="pinned_card_copy_in_task_pinboard"
								stageDisplayNameForTaskPinboardCopy={columnTitle}
								onNavigateToCanonicalCardInItsStage={onRevealCanonicalCardInItsStage}
								onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
								{...buildTaskCardBusinessProps({
									card,
									columnId,
									sessionSummary: resolveMainTaskConversationSessionSummary(card, taskSessions) ?? undefined,
									taskSessions,
									selected: card.id === selectedCardId,
									handlers,
									onActivateCard,
									workspacePath,
									defaultAgentId,
								})}
							/>
						</div>
					))}
					{hiddenPinnedTaskCountBeyondDefaultVisibleCount > 0 ? (
						<div className="flex shrink-0 justify-center pt-1">
							<button
								type="button"
								onClick={() => setShowsAllPinnedTasksBeyondDefaultVisibleCount((previous) => !previous)}
								aria-expanded={showsAllPinnedTasksBeyondDefaultVisibleCount}
								className="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-surface-3 hover:text-text-secondary"
							>
								{showsAllPinnedTasksBeyondDefaultVisibleCount ? (
									<ChevronUp size={12} className="shrink-0" />
								) : (
									<ChevronDown size={12} className="shrink-0" />
								)}
								{showsAllPinnedTasksBeyondDefaultVisibleCount
									? "Show less"
									: `Show ${hiddenPinnedTaskCountBeyondDefaultVisibleCount} more`}
							</button>
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
