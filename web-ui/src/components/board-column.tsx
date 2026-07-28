import { Droppable } from "@hello-pangea/dnd";
import { Play, Plus, Trash2 } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

import { BoardCard } from "@/components/board-card";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
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

export function BoardColumn({
	column,
	taskSessions,
	onCreateTask,
	onStartTask,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	moveToValidationLoadingById,
	moveToReviewLoadingById,
	onCardClick,
	activeDragTaskId,
	activeDragSourceColumnId,
	programmaticCardMoveInFlight,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	dependencySourceTaskId,
	dependencyTargetTaskId,
	isDependencyLinking,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: {
	column: BoardColumnModel;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	moveToValidationLoadingById?: Record<string, boolean>;
	moveToReviewLoadingById?: Record<string, boolean>;
	onCardClick?: (card: BoardCardModel) => void;
	activeDragTaskId?: string | null;
	activeDragSourceColumnId?: BoardColumnId | null;
	programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null;
	onDependencyPointerDown?: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	dependencySourceTaskId?: string | null;
	dependencyTargetTaskId?: string | null;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const canCreate = column.id === "backlog" && onCreateTask;
	const canRequestStartAllReadyBacklogTasks = column.id === "backlog" && onRequestStartAllReadyBacklogTasks;
	const canClearTrash = column.id === "trash" && onClearTrash;
	// 打开 Focus View 会真正卸载看板（不再是 visibility:hidden），因此返回时要把这一列的
	// 滚动位置与「已展开到第几批」补回来，否则用户每次从详情页返回都被弹回列顶。
	// 只在挂载那一次读取：后续渲染沿用同一份初值，避免自己写进去的值又反过来改初值。
	const restoredScrollOffsetRef = useRef(readBoardColumnScrollOffset(workspacePath ?? null, column.id));
	const { visibleCount, hasMore, remainingCount, loadMoreSentinelRef, revealMore } = useProgressiveRenderCount({
		totalCount: column.cards.length,
		getScrollRoot: getColumnCardsScrollRoot,
		enabled: activeDragTaskId == null,
		initialCount: restoredScrollOffsetRef.current?.revealedCardCount,
	});

	const cardsScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const visibleCountRef = useRef(visibleCount);
	visibleCountRef.current = visibleCount;

	// 布局提交后、绘制之前还原滚动位置，避免先闪一帧列顶再跳。
	useLayoutEffect(() => {
		const restored = restoredScrollOffsetRef.current;
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
				scrollTop: container?.scrollTop ?? restoredScrollOffsetRef.current?.scrollTop ?? 0,
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
			className="flex flex-col min-w-0 min-h-0 bg-surface-1 rounded-lg overflow-hidden border border-border"
			style={{
				flex: "1 1 0",
			}}
		>
			<div className="flex flex-col min-h-0" style={{ flex: "1 1 0" }}>
				<div
					className="flex items-center justify-between"
					style={{
						height: 40,
						padding: "0 12px",
					}}
				>
					<div className="flex items-center gap-2">
						<ColumnIndicator columnId={column.id} />
						<span className="font-semibold text-sm">{column.title}</span>
						<span className="text-text-secondary text-xs">{column.cards.length}</span>
					</div>
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
											onCommit={onCommitTask}
											onOpenPr={onOpenPrTask}
											onCancelAutomaticAction={onCancelAutomaticTaskAction}
											isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
											isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
											isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
											isMoveToValidationLoading={moveToValidationLoadingById?.[card.id] ?? false}
											isMoveToReviewLoading={moveToReviewLoadingById?.[card.id] ?? false}
											onDependencyPointerDown={onDependencyPointerDown}
											onDependencyPointerEnter={onDependencyPointerEnter}
											isDependencySource={dependencySourceTaskId === card.id}
											isDependencyTarget={dependencyTargetTaskId === card.id}
											isDependencyLinking={isDependencyLinking}
											workspacePath={workspacePath}
											defaultClineModelId={defaultClineModelId}
											defaultAgentId={defaultAgentId}
											onSaveTitle={onSaveTitle}
											onOpenTaskEditor={
												column.id === "backlog" && onEditTask ? () => onEditTask(card) : undefined
											}
											onClick={() => {
												if (column.id === "backlog") {
													onEditTask?.(card);
													return;
												}
												onCardClick?.(card);
											}}
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
}
