import { Droppable } from "@hello-pangea/dnd";
import { FoldHorizontal, Play, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
import { boardColumnAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { useProgressiveRenderCount } from "@/hooks/use-progressive-render-count";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import { readBoardColumnScrollOffset, writeBoardColumnScrollOffset } from "@/stores/board-column-scroll-offset-store";
import type { BoardCard as BoardCardModel, BoardColumnId, BoardColumn as BoardColumnModel } from "@/types";

// 模块级常量，保持引用稳定（避免每次渲染都给 hook 传新函数触发 observer 重建）。
const getColumnCardsScrollRoot = (sentinel: HTMLElement): HTMLElement | null =>
	sentinel.closest<HTMLElement>(".kb-column-cards");

export const BoardColumn = memo(function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartTask,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTitle,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onRequestPinToTaskPinboard,
	onUnpinFromTaskPinboard,
	taskIdRequestedToReveal,
	moveToTrashLoadingById,
	moveToValidationLoadingById,
	moveToReviewLoadingById,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	workspacePath,
	resolveTaskWorkspaceAbsoluteDirectoryPath,
	defaultClineModelId,
	defaultAgentId,
	onCollapseColumn,
	columnFlexStyle,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	/**
	 * 置顶板请求「跳回本体卡」的任务 id（全局唯一，非本列时本列忽略）。
	 * 命中本列时把该卡的索引交给渐进渲染，保证它即便排在初始 cap 之后也已挂载，供 scrollIntoView 命中。
	 */
	taskIdRequestedToReveal?: string | null;
	moveToTrashLoadingById?: Record<string, boolean>;
	moveToValidationLoadingById?: Record<string, boolean>;
	moveToReviewLoadingById?: Record<string, boolean>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	workspacePath?: string | null;
	resolveTaskWorkspaceAbsoluteDirectoryPath?: (task: BoardCardModel) => Promise<string | null>;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
	/** 主看板的列折叠入口；不传则不渲染折叠按钮。 */
	onCollapseColumn?: (columnId: BoardColumnId) => void;
	/** 主看板列宽偏好算出的 flex 样式（自动填充或固定 flex-basis）；缺省为等分填充。 */
	columnFlexStyle?: { flex: string };
}): React.ReactElement {
	const canCreate = column.id === "backlog" && onCreateTask;
	const canRequestStartAllReadyBacklogTasks = column.id === "backlog" && onRequestStartAllReadyBacklogTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	// 打开 Focus View 会真正卸载看板（不再是 visibility:hidden），因此返回时要把这一列的
	// 滚动位置与「已展开到第几批」补回来，否则用户每次从详情页返回都被弹回列顶。
	// 惰性 useState 保证只在挂载那一次求值（useRef(初值) 的实参每次渲染都会求值一次）：
	// 后续渲染沿用同一份初值，避免自己写进去的值又反过来改初值。
	const [restoredScrollOffset] = useState(() => readBoardColumnScrollOffset(workspacePath ?? null, column.id));
	const indexOfTaskRequestedToReveal = taskIdRequestedToReveal
		? column.cards.findIndex((card) => card.id === taskIdRequestedToReveal)
		: -1;
	const { visibleCount, hasMore, remainingCount, loadMoreSentinelRef, revealMore } = useProgressiveRenderCount({
		totalCount: column.cards.length,
		getScrollRoot: getColumnCardsScrollRoot,
		enabled: activeDragTaskId == null,
		initialCount: restoredScrollOffset?.revealedCardCount,
		ensureVisibleIndex: indexOfTaskRequestedToReveal >= 0 ? indexOfTaskRequestedToReveal : undefined,
	});

	const cardsScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const visibleCountRef = useRef(visibleCount);
	visibleCountRef.current = visibleCount;

	// 布局提交后、绘制之前还原滚动位置，避免先闪一帧列顶再跳。
	useLayoutEffect(() => {
		const restored = restoredScrollOffset;
		const container = cardsScrollContainerRef.current;
		if (!restored || !container || restored.scrollTop <= 0) {
			return;
		}
		container.scrollTop = restored.scrollTop;
	}, []);

	// 滚动是高频事件，用 rAF 折叠成每帧至多一次写入。
	const pendingScrollRecordFrameRef = useRef(0);
	const handleCardsScroll = useCallback(() => {
		if (pendingScrollRecordFrameRef.current !== 0) {
			return;
		}
		pendingScrollRecordFrameRef.current = window.requestAnimationFrame(() => {
			pendingScrollRecordFrameRef.current = 0;
			const container = cardsScrollContainerRef.current;
			if (!container) {
				return;
			}
			writeBoardColumnScrollOffset(workspacePath ?? null, column.id, {
				scrollTop: container.scrollTop,
				revealedCardCount: visibleCountRef.current,
			});
		});
	}, [column.id, workspacePath]);

	useLayoutEffect(
		() => () => {
			if (pendingScrollRecordFrameRef.current !== 0) {
				window.cancelAnimationFrame(pendingScrollRecordFrameRef.current);
				pendingScrollRecordFrameRef.current = 0;
			}
			// 卸载前落一次最终值：用户可能展开了更多卡片却没有再滚动过。
			const container = cardsScrollContainerRef.current;
			writeBoardColumnScrollOffset(workspacePath ?? null, column.id, {
				scrollTop: container?.scrollTop ?? restoredScrollOffset?.scrollTop ?? 0,
				revealedCardCount: visibleCountRef.current,
			});
		},
		[column.id, workspacePath],
	);
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null, {
		activeDragTaskId,
		programmaticCardMoveInFlight,
	});
	const createTaskButtonText = (
		<span className="inline-flex items-center gap-1.5">
			<span>Create task</span>
			<span aria-hidden className="text-text-secondary">
				(c)
			</span>
		</span>
	);

	return (
		<section
			data-column-id={column.id}
			data-verification-anchor={boardColumnAnchorKey(column.id)}
			className="flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border"
			style={columnFlexStyle ?? { flex: "1 1 0" }}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<div
					className="flex items-center justify-between"
					style={{
						height: 40,
						padding: "0 12px",
					}}
				>
					<div className="flex items-center gap-2 min-w-0">
						<ColumnIndicator columnId={column.id} />
						<span className="font-semibold text-sm truncate">{column.title}</span>
						<span className="text-text-secondary text-xs">{column.cards.length}</span>
					</div>
					<div className="flex items-center gap-0.5 shrink-0">
						{canRequestStartAllReadyBacklogTasks ? (
							<Button
								icon={<Play size={14} />}
								variant="ghost"
								size="sm"
								onClick={onRequestStartAllReadyBacklogTasks}
								disabled={column.cards.length === 0}
								aria-label="Start all ready backlog tasks"
								title={column.cards.length > 0 ? "Start all ready backlog tasks" : "Backlog is empty"}
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
								title={column.cards.length > 0 ? "Clear done items permanently" : "Done is empty"}
							/>
						) : null}
						{onCollapseColumn ? (
							<Button
								icon={<FoldHorizontal size={14} />}
								variant="ghost"
								size="sm"
								onClick={() => onCollapseColumn(column.id)}
								aria-expanded
								aria-label={`Collapse ${column.title} column`}
								title={`Collapse ${column.title} column`}
							/>
						) : null}
					</div>
				</div>

				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(cardProvided) => (
						<div
							ref={(element: HTMLDivElement | null) => {
								cardsScrollContainerRef.current = element;
								cardProvided.innerRef(element);
							}}
							{...cardProvided.droppableProps}
							className="kb-column-cards"
							onScroll={handleCardsScroll}
						>
							{canCreate ? (
								<Button
									icon={<Plus size={14} />}
									aria-label="Create task"
									fill
									onClick={onCreateTask}
									style={{ marginBottom: 6, flexShrink: 0 }}
								>
									{createTaskButtonText}
								</Button>
							) : null}

							{(() => {
								const items: ReactNode[] = [];
								let draggableIndex = 0;
								for (const card of column.cards.slice(0, visibleCount)) {
									items.push(
										<BoardCard
											key={card.id}
											card={card}
											index={draggableIndex}
											columnId={column.id}
											sessionSummary={taskSessions[card.id]}
											onStart={onStartTask}
											onMoveToTrash={onMoveToTrashTask}
											onMoveToValidation={onMoveToValidationTask}
											onMoveToReview={onMoveToReviewTask}
											onRestoreFromTrash={onRestoreFromTrashTask}
											onDeleteTask={onDeleteTask}
											onRequestPinToTaskPinboard={onRequestPinToTaskPinboard}
											onUnpinFromTaskPinboard={onUnpinFromTaskPinboard}
											onCancelAutomaticAction={onCancelAutomaticTaskAction}
											isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
											isMoveToValidationLoading={moveToValidationLoadingById?.[card.id] ?? false}
											isMoveToReviewLoading={moveToReviewLoadingById?.[card.id] ?? false}
											workspacePath={workspacePath}
											resolveTaskWorkspaceAbsoluteDirectoryPath={resolveTaskWorkspaceAbsoluteDirectoryPath}
											defaultClineModelId={defaultClineModelId}
											defaultAgentId={defaultAgentId}
											onSaveTitle={onSaveTitle}
											onOpenTaskEditor={column.id === "backlog" ? onEditTask : undefined}
											onClick={column.id === "backlog" ? onEditTask : onCardClick}
										/>,
									);
									draggableIndex += 1;
								}
								return items;
							})()}
							{hasMore ? (
								<LoadMoreTasksSentinel
									ref={loadMoreSentinelRef}
									remainingCount={remainingCount}
									onReveal={revealMore}
								/>
							) : null}
							{cardProvided.placeholder}
						</div>
					)}
				</Droppable>
			</div>
		</section>
	);
});
