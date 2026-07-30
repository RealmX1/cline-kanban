import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { StageHeaderRails } from "@/components/detail-panels/stage-header-rails";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
import { TaskCardBody, type TaskCardBusinessProps } from "@/components/task-card-body";
import { Button } from "@/components/ui/button";
import { useProgressiveRenderCount } from "@/hooks/use-progressive-render-count";
import { useSelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { useStageHeaderPinLayout } from "@/hooks/use-stage-header-pin-layout";
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
	onCardClick,
	taskSessions,
	onStartTask,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTitle,
	onCommitTask,
	onOpenPrTask,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
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
	onCardClick: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onStartTask?: (taskId: string) => void;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
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
	const canRequestStartAllReadyBacklogTasks = column.id === "backlog" && onRequestStartAllReadyBacklogTasks;
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

	const containsSelectedCard = selectedIndex >= 0;
	// 折叠焦点 stage 时焦点卡仍「留存」：只渲染焦点卡本身（保活真实 data-task-id 几何），其余卡不渲染。
	// 焦点卡因此永不 0×0 → useSelectedCardPinState / useStageHeaderPinLayout 无需特判，且钉住 rail 里的
	// 焦点卡是 pinnedClone（不带 data-task-id），唯一性不破。非焦点 section 折叠仍整体 display:none（保留
	// 原 MutationObserver 的 style 翻转触发）。卡头本身改为随内容自然滚动（static）——「当前所属 stage」
	// 现由 StageHeaderRails 的顶/底手风琴始终呈现，不再依赖各 section 的原生 sticky 卡头。
	const isCollapsedFocusedPeek = !open && containsSelectedCard;
	const isBodyHidden = !open && !containsSelectedCard;
	const renderedCards = isCollapsedFocusedPeek
		? column.cards.filter((card) => card.id === selectedCardId)
		: column.cards.slice(0, visibleCount);

	// 卡片的领域 props（与是否包 Draggable 无关），供列表内可拖卡（BoardCard）与折叠 peek 的非拖卡
	// （裸 TaskCardBody）共用，确保两处业务行为一致。
	const buildCardBusinessProps = (card: BoardCardModel): TaskCardBusinessProps => ({
		card,
		columnId: column.id,
		sessionSummary: taskSessions[card.id],
		selected: card.id === selectedCardId,
		onStart: onStartTask,
		onMoveToTrash: onMoveToTrashTask,
		onMoveToValidation: onMoveToValidationTask,
		onMoveToReview: onMoveToReviewTask,
		onRestoreFromTrash: onRestoreFromTrashTask,
		onDeleteTask,
		onCommit: onCommitTask,
		onOpenPr: onOpenPrTask,
		isCommitLoading: commitTaskLoadingById?.[card.id] ?? false,
		isOpenPrLoading: openPrTaskLoadingById?.[card.id] ?? false,
		isMoveToTrashLoading: moveToTrashLoadingById?.[card.id] ?? false,
		workspacePath,
		defaultClineModelId,
		defaultAgentId,
		onSaveTitle,
		onOpenTaskEditor: column.id === "backlog" && onEditTask ? () => onEditTask(card) : undefined,
		onClick: () => {
			if (column.id === "backlog") {
				onEditTask?.(card);
				return;
			}
			onCardClick(card);
		},
	});

	return (
		<div className="bg-surface-1 rounded-lg shrink-0 border border-border" data-stage-section-id={column.id}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					height: 40,
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
				{canRequestStartAllReadyBacklogTasks ? (
					<Button
						icon={<Play size={14} />}
						variant="ghost"
						size="sm"
						onClick={onRequestStartAllReadyBacklogTasks}
						disabled={column.cards.length === 0}
						aria-label="Start all ready backlog tasks"
						title={column.cards.length > 0 ? "Start all ready backlog tasks" : "Backlog is empty"}
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
			<div style={{ display: isBodyHidden ? "none" : "block" }}>
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
								{isCollapsedFocusedPeek
									? // 折叠焦点 stage 的 peek：焦点卡渲染为非拖拽的裸 TaskCardBody（不包 <Draggable>、
										// 不传 index/drag）。此前它经 BoardCard 走 draggableIndex 从 0 起算的循环，得到假的
										// Draggable index=0；而落地 splice 用真实 source.index，焦点卡真实索引非 0 时会跨列
										// 移错卡（数据损坏）。裸 TaskCardBody 仍输出唯一真实 data-task-id、保留 onClick 与动作
										// 按钮、维持折叠留存 peek，且 peek 卡本身不可拖，从根上消除假 index。
										renderedCards.map((card) => (
											<TaskCardBody key={card.id} {...buildCardBusinessProps(card)} />
										))
									: // 展开：BoardCard 包 <Draggable>，index 从 0 连续（@hello-pangea/dnd 要求 Droppable 内
										// draggable index 连续从 0），且 renderedCards 是 column.cards.slice(0, …)，故 Draggable
										// index 与真实 column.cards 索引一致，落地 splice 用的 source.index 精确对应被拖卡。
										renderedCards.map((card, draggableIndex) => (
											<BoardCard key={card.id} index={draggableIndex} {...buildCardBusinessProps(card)} />
										))}
								{open && hasMore ? (
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
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTaskTitle,
	onCommitTask,
	onOpenPrTask,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
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
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTaskTitle?: (taskId: string, title: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
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

	// 焦点「卡」是否滚出视口（hidden / pinTop / pinBottom）：决定焦点 stage 的 rail 条目是否挂焦点卡克隆、
	// 以及 scrollport 是否标 data-selected-pinned 隐藏真实焦点卡。拖拽期真实卡被 portal 到 body 致目标丢失，
	// 故暂停侦测、归 hidden。
	const selectedCardPinState = useSelectedCardPinState({
		selectedTaskId: selection.card.id,
		scrollRootRef: scrollContainerRef,
		enabled: activeDragSourceColumnId == null,
	});

	// 全部 stage「卡头」的手风琴钉住布局（已滚过钉顶、未到达钉底、中间随流）。把单卡钉住的几何模式推广到
	// N 个卡头；由 StageHeaderRails 以脱流 overlay 渲染。拖拽期同样暂停（真实卡 portal 到 body、几何失真）。
	const columnIds = useMemo(() => selection.allColumns.map((column) => column.id), [selection.allColumns]);
	const stageHeaderPinLayout = useStageHeaderPinLayout({
		scrollRootRef: scrollContainerRef,
		columnIds,
		focusedColumnId: selection.column.id,
		focusedTaskId: selection.card.id,
		focusedCardPinState: selectedCardPinState,
		enabled: activeDragSourceColumnId == null,
	});

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
							onCardClick={(card) => onCardSelect(card.id)}
							taskSessions={taskSessions}
							onStartTask={column.id === "backlog" || column.id === "in_progress" ? onStartTask : undefined}
							onRequestStartAllReadyBacklogTasks={
								column.id === "backlog" ? onRequestStartAllReadyBacklogTasks : undefined
							}
							onClearTrash={column.id === "trash" ? onClearTrash : undefined}
							onEditTask={column.id === "backlog" ? onEditTask : undefined}
							onSaveTitle={onSaveTaskTitle}
							onCommitTask={column.id === "review" ? onCommitTask : undefined}
							onOpenPrTask={column.id === "review" ? onOpenPrTask : undefined}
							onMoveToTrashTask={
								column.id === "review" || column.id === "validation" ? onMoveToTrashTask : undefined
							}
							onMoveToValidationTask={column.id === "review" ? onMoveToValidationTask : undefined}
							onMoveToReviewTask={column.id === "in_progress" ? onMoveToReviewTask : undefined}
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
			<StageHeaderRails
				selection={selection}
				topPinnedColumnIds={stageHeaderPinLayout.topPinnedColumnIds}
				bottomPinnedColumnIds={stageHeaderPinLayout.bottomPinnedColumnIds}
				focusedCardPinState={selectedCardPinState}
				scrollRootRef={scrollContainerRef}
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
		</div>
	);
}
