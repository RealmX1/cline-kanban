import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { SelectedTaskPinBar } from "@/components/detail-panels/selected-task-pin-bar";
import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
import { Button } from "@/components/ui/button";
import { useProgressiveRenderCount } from "@/hooks/use-progressive-render-count";
import { type SelectedCardPinState, useSelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardColumnId, isCardDropDisabled } from "@/state/drag-rules";
import type { BoardCard as BoardCardModel, BoardColumn, BoardColumnId, CardSelection } from "@/types";

// 详情页左侧所有 section 共用一个滚动容器；模块级常量保持引用稳定。
const getDetailTaskListScrollRoot = (sentinel: HTMLElement): HTMLElement | null =>
	sentinel.closest<HTMLElement>(".kb-detail-task-list-scroll");

function ColumnSection({
	column,
	selectedCardId,
	defaultOpen,
	pinState,
	onCardClick,
	taskSessions,
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
	onMoveToValidationTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	activeDragSourceColumnId,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: {
	column: BoardColumn;
	selectedCardId: string;
	defaultOpen: boolean;
	/** 选中卡当前的钉住状态：用于「含选中卡 section」在 pinTop 时去重原生卡头（见下方 headerSticky）。 */
	pinState: SelectedCardPinState;
	onCardClick: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
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
	onMoveToValidationTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	activeDragSourceColumnId?: BoardColumnId | null;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const [open, setOpen] = useState(defaultOpen);
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

	// 原生 sticky 区段卡头（解决「滚过在视 stage 卡头后分不清当前所属 stage」）：浏览器自动 swap、零 JS 抖动。
	// 去重：含选中卡的 section 在 pinTop 时，其原生卡头与浮动条里的卡头重复 → 该 section 卡头改非 sticky；
	// 其余情形（pinBottom / hidden，或不含选中卡的 section）照常 sticky，充当「当前在视 stage 卡头」。
	// top 引用 scrollport 上由面板写的 --kb-selected-pin-top：pinTop 时 = 浮动条高度，使卡头停在浮动条下方。
	const containsSelectedCard = selectedIndex >= 0;
	const headerSticky = !(containsSelectedCard && pinState === "pinTop");

	return (
		<div className="bg-surface-1 rounded-lg shrink-0 border border-border">
			<div
				style={{
					display: "flex",
					alignItems: "center",
					height: 40,
					position: headerSticky ? "sticky" : "static",
					top: "var(--kb-selected-pin-top, 0px)",
					zIndex: 4,
					background: "var(--color-surface-1)",
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
					<StageHeaderLabel columnId={column.id} title={column.title} count={column.cards.length} />
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
												onMoveToValidation={onMoveToValidationTask}
												onRestoreFromTrash={onRestoreFromTrashTask}
												onDeleteTask={onDeleteTask}
												onCommit={onCommitTask}
												onOpenPr={onOpenPrTask}
												isCommitLoading={commitTaskLoadingById?.[card.id] ?? false}
												isOpenPrLoading={openPrTaskLoadingById?.[card.id] ?? false}
												isMoveToTrashLoading={moveToTrashLoadingById?.[card.id] ?? false}
												workspacePath={workspacePath}
												defaultClineModelId={defaultClineModelId}
												defaultAgentId={defaultAgentId}
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
	defaultAgentId,
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
	onMoveToValidationTask,
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
	onMoveToValidationTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	panelWidth?: string;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const pinBarRootRef = useRef<HTMLDivElement | null>(null);

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

	// 选中卡是左列唯一钉住机制：前沿一触视口边即由浮动钉住条接管（stage 内 + 跨 stage 持续可见）。
	// 拖拽进行中真实卡会被 portal 到 body 致目标丢失，故拖拽期暂停侦测、归 hidden。
	const selectedCardPinState = useSelectedCardPinState({
		selectedTaskId: selection.card.id,
		scrollRootRef: scrollContainerRef,
		enabled: activeDragSourceColumnId == null,
	});

	// 浮动条钉顶（pinTop）时，原生 sticky 区段卡头须停在浮动条「下方」，否则被不透明浮动条（z-5）盖住。
	// 实测浮动条高度写入 scrollport 的 --kb-selected-pin-top（区段卡头 top 引用它）；pinBottom/hidden
	// 时浮动条不在顶沿、offset 归 0，卡头照常停在 top:0。用 ResizeObserver 跟随浮动条高度变化（卡体展开等）。
	useEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (!scrollContainer) {
			return;
		}
		if (selectedCardPinState !== "pinTop") {
			scrollContainer.style.setProperty("--kb-selected-pin-top", "0px");
			return;
		}
		const pinBarRoot = pinBarRootRef.current;
		if (!pinBarRoot) {
			scrollContainer.style.setProperty("--kb-selected-pin-top", "0px");
			return;
		}
		const applyOffset = (): void => {
			// 原生 sticky 卡头的 top 从 scrollport「内容盒」上沿（即 p-2 顶 padding 之下）起算，而浮动条
			// overlay 贴在 scrollport 边框盒上沿（top:0）。若直接用浮动条全高，卡头会比浮动条底沿再低 paddingTop，
			// 露出 paddingTop 宽的「可透视缝」。故扣掉 scrollport 顶 padding，使卡头上沿与浮动条底沿严丝合缝。
			const paddingTop = Number.parseFloat(getComputedStyle(scrollContainer).paddingTop) || 0;
			const offset = Math.max(0, pinBarRoot.offsetHeight - paddingTop);
			scrollContainer.style.setProperty("--kb-selected-pin-top", `${offset}px`);
		};
		applyOffset();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const resizeObserver = new ResizeObserver(applyOffset);
		resizeObserver.observe(pinBarRoot);
		return () => {
			resizeObserver.disconnect();
		};
	}, [selectedCardPinState]);

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
				position: "relative",
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
					data-selected-pinned={selectedCardPinState !== "hidden" ? "true" : undefined}
					style={{
						flex: "1 1 0",
						minHeight: 0,
						overflowY: "auto",
						overscrollBehavior: "contain",
						overflowAnchor: "none",
					}}
				>
					{onCreateTask ? (
						<Button
							icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
							aria-label="Create task"
							fill
							onClick={onCreateTask}
						>
							<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
								<span>Create task</span>
								<span aria-hidden className="text-text-secondary">
									(c)
								</span>
							</span>
						</Button>
					) : null}
					{selection.allColumns.map((column) => (
						<ColumnSection
							key={column.id}
							column={column}
							selectedCardId={selection.card.id}
							defaultOpen={column.id !== "trash"}
							pinState={selectedCardPinState}
							onCardClick={(card) => onCardSelect(card.id)}
							taskSessions={taskSessions}
							onStartTask={column.id === "backlog" ? onStartTask : undefined}
							onStartAllTasks={column.id === "backlog" ? onStartAllTasks : undefined}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							editingTaskId={column.id === "backlog" ? editingTaskId : null}
							inlineTaskEditor={column.id === "backlog" ? inlineTaskEditor : undefined}
							onEditTask={column.id === "backlog" ? onEditTask : undefined}
							onSaveTitle={onSaveTaskTitle}
							onCommitTask={column.id === "review" ? onCommitTask : undefined}
							onOpenPrTask={column.id === "review" ? onOpenPrTask : undefined}
							onMoveToTrashTask={
								column.id === "review" || column.id === "validation" ? onMoveToTrashTask : undefined
							}
							onMoveToValidationTask={column.id === "review" ? onMoveToValidationTask : undefined}
							onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
							onDeleteTask={onDeleteTask}
							commitTaskLoadingById={column.id === "review" ? commitTaskLoadingById : undefined}
							openPrTaskLoadingById={column.id === "review" ? openPrTaskLoadingById : undefined}
							moveToTrashLoadingById={
								column.id === "review" || column.id === "validation" ? moveToTrashLoadingById : undefined
							}
							activeDragSourceColumnId={activeDragSourceColumnId}
							workspacePath={workspacePath}
							defaultClineModelId={defaultClineModelId}
							defaultAgentId={defaultAgentId}
						/>
					))}
				</div>
			</DragDropContext>
			{selectedCardPinState !== "hidden" ? (
				<SelectedTaskPinBar
					selection={selection}
					pinState={selectedCardPinState}
					scrollRootRef={scrollContainerRef}
					pinBarRootRef={pinBarRootRef}
					taskSessions={taskSessions}
					onStartTask={onStartTask}
					onMoveToTrashTask={onMoveToTrashTask}
					onMoveToValidationTask={onMoveToValidationTask}
					onRestoreFromTrashTask={onRestoreFromTrashTask}
					onDeleteTask={onDeleteTask}
					onCommitTask={onCommitTask}
					onOpenPrTask={onOpenPrTask}
					commitTaskLoadingById={commitTaskLoadingById}
					openPrTaskLoadingById={openPrTaskLoadingById}
					moveToTrashLoadingById={moveToTrashLoadingById}
					workspacePath={workspacePath}
					defaultClineModelId={defaultClineModelId}
					defaultAgentId={defaultAgentId}
				/>
			) : null}
		</div>
	);
}
