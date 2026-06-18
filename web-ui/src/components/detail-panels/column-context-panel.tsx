import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { useProgressiveRenderCount } from "@/hooks/use-progressive-render-count";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardColumnId, isCardDropDisabled } from "@/state/drag-rules";
import type { BoardCard as BoardCardModel, BoardColumn, BoardColumnId, CardSelection } from "@/types";

// 详情页左侧所有 section 共用一个滚动容器；模块级常量保持引用稳定。
const getDetailTaskListScrollRoot = (sentinel: HTMLElement): HTMLElement | null =>
	sentinel.closest<HTMLElement>(".kb-detail-task-list-scroll");

function ColumnSection({
	column,
	selectedCardId,
	defaultOpen,
	onCardClick,
	taskSessions,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	activeDragSourceColumnId,
	workspacePath,
	defaultClineModelId,
}: {
	column: BoardColumn;
	selectedCardId: string;
	defaultOpen: boolean;
	onCardClick: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	activeDragSourceColumnId?: BoardColumnId | null;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
}): React.ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	const canCreate = column.id === "backlog" && onCreateTask;
	const canStartAllTasks = column.id === "backlog" && onStartAllTasks;
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
	const cardDropType = "CARD";
	const isDropDisabled = isCardDropDisabled(column.id, activeDragSourceColumnId ?? null);
	const selectedIndex = column.cards.findIndex((card) => card.id === selectedCardId);
	const { visibleCount, hasMore, remainingCount, loadMoreSentinelRef, revealMore } = useProgressiveRenderCount({
		totalCount: column.cards.length,
		getScrollRoot: getDetailTaskListScrollRoot,
		enabled: activeDragSourceColumnId == null,
		ensureVisibleIndex: selectedIndex >= 0 ? selectedIndex : undefined,
	});

	useEffect(() => {
		if (!column.cards.some((card) => card.id === selectedCardId)) {
			return;
		}
		setOpen(true);
	}, [column.cards, selectedCardId]);

	return (
		<div className="bg-surface-1 rounded-lg shrink-0 border border-border">
			<div
				style={{
					display: "flex",
					alignItems: "center",
					height: 40,
				}}
			>
				<button
					type="button"
					onClick={() => setOpen((prev) => !prev)}
					className="hover:bg-surface-0 rounded-md"
					style={{
						height: 32,
						flex: "1 1 auto",
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "0 8px",
						margin: "0 4px",
						background: "none",
						border: "none",
						cursor: "pointer",
						color: "inherit",
						textAlign: "left",
					}}
				>
					{open ? (
						<ChevronDown size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					) : (
						<ChevronRight size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					)}
					<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<ColumnIndicator columnId={column.id} />
						<span style={{ fontWeight: 600, fontSize: 13 }}>{column.title}</span>
						<span className="text-text-secondary" style={{ fontSize: 11 }}>
							{column.cards.length}
						</span>
					</span>
				</button>
				{canStartAllTasks ? (
					<Button
						icon={<Play size={14} />}
						variant="ghost"
						size="sm"
						onClick={onStartAllTasks}
						disabled={column.cards.length === 0}
						aria-label="Start all backlog tasks"
						title={column.cards.length > 0 ? "Start all backlog tasks" : "Backlog is empty"}
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
						aria-label="Restore most recent done task"
						title={latestTrashCard ? "Restore most recent done task" : "Done is empty"}
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
						title={column.cards.length > 0 ? "Clear done items permanently" : "Done is empty"}
						style={{ marginRight: 4 }}
					/>
				) : null}
			</div>
			<div style={{ display: open ? "block" : "none" }}>
				<Droppable droppableId={column.id} type={cardDropType} isDropDisabled={isDropDisabled}>
					{(provided) => {
						return (
							<div
								ref={provided.innerRef}
								{...provided.droppableProps}
								style={{
									display: "flex",
									flexDirection: "column",
									padding: 8,
								}}
							>
								{canCreate ? (
									<Button
										icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
										aria-label="Create task"
										fill
										onClick={onCreateTask}
										style={{ marginBottom: 8 }}
									>
										<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
											<span>Create task</span>
											<span aria-hidden className="text-text-secondary">
												(c)
											</span>
										</span>
									</Button>
								) : null}
								{(() => {
									const items: ReactNode[] = [];
									let draggableIndex = 0;
									for (const card of column.cards.slice(0, visibleCount)) {
										if (column.id === "backlog" && editingTaskId === card.id) {
											items.push(
												<div key={card.id} style={{ marginBottom: 8 }}>
													{inlineTaskEditor}
												</div>,
											);
											continue;
										}
										items.push(
											<BoardCard
												key={card.id}
												card={card}
												index={draggableIndex}
												columnId={column.id}
												sessionSummary={taskSessions[card.id]}
												selected={card.id === selectedCardId}
												onStart={onStartTask}
												onMoveToTrash={onMoveToTrashTask}
												onRestoreFromTrash={onRestoreFromTrashTask}
												onDeleteTask={onDeleteTask}
												onCommit={onCommitTask}
												onOpenPr={onOpenPrTask}
												isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
												isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
												isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
												workspacePath={workspacePath}
												defaultClineModelId={defaultClineModelId}
												onSaveTitle={onSaveTitle}
												onClick={() => {
													if (column.id === "backlog") {
														onEditTask?.(card);
														return;
													}
													onCardClick(card);
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
								{provided.placeholder}
								{column.cards.length === 0 ? (
									<div className="flex items-center justify-center py-4 text-text-tertiary text-xs">Empty</div>
								) : null}
							</div>
						);
					}}
				</Droppable>
			</div>
		</div>
	);
}

export function ColumnContextPanel({
	selection,
	workspacePath,
	defaultClineModelId,
	onCardSelect,
	taskSessions,
	onTaskDragEnd,
	onCreateTask,
	onStartTask,
	onStartAllTasks,
	onClearTrash,
	editingTaskId,
	inlineTaskEditor,
	onEditTask,
	onSaveTaskTitle,
	onCommitTask,
	onOpenPrTask,
	onMoveToTrashTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	panelWidth,
}: {
	selection: CardSelection;
	workspacePath?: string | null;
	onCardSelect: (taskId: string) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onTaskDragEnd: (result: DropResult) => void;
	onCreateTask?: () => void;
	onStartTask?: (taskId: string) => void;
	onStartAllTasks?: () => void;
	onClearTrash?: () => void;
	editingTaskId?: string | null;
	inlineTaskEditor?: ReactNode;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTaskTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	panelWidth?: string;
	defaultClineModelId?: string | null;
}): React.ReactElement {
	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);

	const handleBeforeCapture = useCallback(
		(start: BeforeCapture) => {
			setActiveDragSourceColumnId(findCardColumnId(selection.allColumns, start.draggableId));
		},
		[selection.allColumns],
	);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			setActiveDragSourceColumnId(null);
			onTaskDragEnd(result);
		},
		[onTaskDragEnd],
	);

	useEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (!scrollContainer) {
			return;
		}
		const escapedTaskId = selection.card.id.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		// 在 rAF 内查询而非同步查询：被选中的卡片可能因渐进渲染（ensureVisibleIndex）
		// 需要再渲染一帧才挂载到 DOM。若首帧未找到，则在随后的若干帧重试，
		// 直到它出现再居中（命中后立即停止）。
		const MAX_SCROLL_INTO_VIEW_FRAMES = 30;
		let frameId = 0;
		let attempts = 0;
		const centerSelectedCard = () => {
			const selectedCardElement = scrollContainer.querySelector<HTMLElement>(`[data-task-id="${escapedTaskId}"]`);
			if (selectedCardElement) {
				selectedCardElement.scrollIntoView({
					block: "center",
					inline: "nearest",
				});
				return;
			}
			if (attempts < MAX_SCROLL_INTO_VIEW_FRAMES) {
				attempts += 1;
				frameId = window.requestAnimationFrame(centerSelectedCard);
			}
		};
		frameId = window.requestAnimationFrame(centerSelectedCard);
		return () => {
			window.cancelAnimationFrame(frameId);
		};
	}, [selection.card.id, selection.column.id]);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: panelWidth ?? "20%",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
			}}
		>
			<DragDropContext onBeforeCapture={handleBeforeCapture} onDragEnd={handleDragEnd}>
				<div
					ref={scrollContainerRef}
					className="kb-detail-task-list-scroll flex flex-col gap-2 p-2"
					style={{
						flex: "1 1 0",
						minHeight: 0,
						overflowY: "auto",
						overscrollBehavior: "contain",
						overflowAnchor: "none",
					}}
				>
					{selection.allColumns.map((column) => (
						<ColumnSection
							key={column.id}
							column={column}
							selectedCardId={selection.card.id}
							defaultOpen={column.id !== "trash"}
							onCardClick={(card) => onCardSelect(card.id)}
							taskSessions={taskSessions}
							onCreateTask={column.id === "backlog" ? onCreateTask : undefined}
							onStartTask={column.id === "backlog" ? onStartTask : undefined}
							onStartAllTasks={column.id === "backlog" ? onStartAllTasks : undefined}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							editingTaskId={column.id === "backlog" ? editingTaskId : null}
							inlineTaskEditor={column.id === "backlog" ? inlineTaskEditor : undefined}
							onEditTask={column.id === "backlog" ? onEditTask : undefined}
							onSaveTitle={column.id !== "trash" ? onSaveTaskTitle : undefined}
							onCommitTask={column.id === "review" ? onCommitTask : undefined}
							onOpenPrTask={column.id === "review" ? onOpenPrTask : undefined}
							onMoveToTrashTask={column.id === "review" ? onMoveToTrashTask : undefined}
							onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
							onDeleteTask={onDeleteTask}
							commitTaskLoadingById={column.id === "review" ? commitTaskLoadingById : undefined}
							openPrTaskLoadingById={column.id === "review" ? openPrTaskLoadingById : undefined}
							moveToTrashLoadingById={column.id === "review" ? moveToTrashLoadingById : undefined}
							activeDragSourceColumnId={activeDragSourceColumnId}
							workspacePath={workspacePath}
							defaultClineModelId={defaultClineModelId}
						/>
					))}
				</div>
			</DragDropContext>
		</div>
	);
}
