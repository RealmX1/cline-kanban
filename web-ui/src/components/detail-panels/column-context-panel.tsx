import { type BeforeCapture, DragDropContext, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardCard } from "@/components/board-card";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "@/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { StageHeaderRails } from "@/components/detail-panels/stage-header-rails";
import { TaskPinboardSectionInFocusView } from "@/components/detail-panels/task-pinboard-section-in-focus-view";
import { LoadMoreTasksSentinel } from "@/components/load-more-tasks-sentinel";
import { TaskCardBody, type TaskCardBusinessProps } from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useFocusViewStageSectionExpansion } from "@/hooks/use-focus-view-stage-section-expansion";
import { useProgressiveRenderCount } from "@/hooks/use-progressive-render-count";
import { useRevealCanonicalTaskCard } from "@/hooks/use-reveal-canonical-task-card";
import { useSelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import { useStageHeaderPinLayout } from "@/hooks/use-stage-header-pin-layout";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardColumnId, isCardDropDisabled } from "@/state/drag-rules";
import { collectTasksPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import type { BoardCard as BoardCardModel, BoardColumn, BoardColumnId, CardSelection } from "@/types";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";

// 详情页左侧所有 section 共用一个滚动容器；模块级常量保持引用稳定。
const getDetailTaskListScrollRoot = (sentinel: HTMLElement): HTMLElement | null =>
	sentinel.closest<HTMLElement>(".kb-detail-task-list-scroll");

function ColumnSection({
	column,
	selectedCardId,
	open,
	onToggleOpen,
	taskIdRequestedToReveal,
	onCardClick,
	taskSessions,
	onStartTask,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTitle,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onRequestPinToTaskPinboard,
	onUnpinFromTaskPinboard,
	moveToTrashLoadingById,
	activeDragSourceColumnId,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: {
	column: BoardColumn;
	selectedCardId: string;
	/**
	 * 折叠态由 `ColumnContextPanel` 经 `useFocusViewStageSectionExpansion` 集中持有（不是本组件的私有 state）：
	 * 钉住 rail 里的孪生卡头要呈现并切换同一份状态；置顶板的「跳回本体卡」也必须能先把目标所在的折叠分段
	 * 展开——分段折叠时整段 `display:none`，`scrollIntoView` 对它无效。
	 */
	open: boolean;
	onToggleOpen: () => void;
	/** 置顶板请求跳转的任务 id；命中本列时并入 `ensureVisibleIndex`，保证本体卡已挂载。 */
	taskIdRequestedToReveal?: string | null;
	onCardClick: (card: BoardCardModel) => void;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onStartTask?: (taskId: string) => void;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCardModel) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	moveToTrashLoadingById?: Record<string, boolean>;
	activeDragSourceColumnId?: BoardColumnId | null;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
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
	const indexOfTaskRequestedToReveal = taskIdRequestedToReveal
		? column.cards.findIndex((card) => card.id === taskIdRequestedToReveal)
		: -1;
	// 两个「必须已挂载」的索引取较大者即可：ensureVisibleIndex 语义是「渲染数量至少到这一格」，只增不减。
	const indexThatMustBeRendered = Math.max(selectedIndex, indexOfTaskRequestedToReveal);
	const { visibleCount, hasMore, remainingCount, loadMoreSentinelRef, revealMore } = useProgressiveRenderCount({
		totalCount: column.cards.length,
		getScrollRoot: getDetailTaskListScrollRoot,
		enabled: activeDragSourceColumnId == null,
		ensureVisibleIndex: indexThatMustBeRendered >= 0 ? indexThatMustBeRendered : undefined,
	});

	const containsSelectedCard = selectedIndex >= 0;
	// 折叠焦点 stage 时焦点卡仍「留存」：只渲染焦点卡本身（保活真实 data-task-id 几何），其余卡不渲染。
	// 焦点卡因此永不 0×0 → useSelectedCardPinState / useStageHeaderPinLayout 无需特判，且钉住 rail 里的
	// 焦点卡是 sticky 卡头副本（renderRole 非 canonical，不带 data-task-id），唯一性不破。非焦点 section 折叠仍整体 display:none（保留
	// 原 MutationObserver 的 style 翻转触发）。卡头本身改为随内容自然滚动（static）——「当前所属 stage」
	// 现由 StageHeaderRails 的顶/底手风琴始终呈现，不再依赖各 section 的原生 sticky 卡头。
	const isCollapsedFocusedPeek = !open && containsSelectedCard;
	const isBodyHidden = !open && !containsSelectedCard;
	const renderedCards = isCollapsedFocusedPeek
		? column.cards.filter((card) => card.id === selectedCardId)
		: column.cards.slice(0, visibleCount);

	// 卡片的领域 props（与是否包 Draggable 无关），供列表内可拖卡（BoardCard）与折叠 peek 的非拖卡
	// （裸 TaskCardBody）共用。stage 门控本身交给 buildTaskCardBusinessProps，与看板、两个置顶板容器同源。
	const buildCardBusinessProps = (card: BoardCardModel): TaskCardBusinessProps =>
		buildTaskCardBusinessProps({
			card,
			columnId: column.id,
			sessionSummary: taskSessions[card.id],
			selected: card.id === selectedCardId,
			handlers: {
				onStartTask,
				onMoveToTrashTask,
				onMoveToValidationTask,
				onMoveToReviewTask,
				onRestoreFromTrashTask,
				onDeleteTask,
				onSaveTitle,
				onEditTask,
				onRequestPinToTaskPinboard,
				onUnpinFromTaskPinboard,
				moveToTrashLoadingById,
			},
			onActivateCard: onCardClick,
			workspacePath,
			defaultClineModelId,
			defaultAgentId,
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
					onClick={onToggleOpen}
					aria-expanded={open}
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
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onRequestPinToTaskPinboard,
	onUnpinFromTaskPinboard,
	onEditTaskPinboardPinReason,
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
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	onEditTaskPinboardPinReason?: (taskId: string) => void;
	moveToTrashLoadingById?: Record<string, boolean>;
	panelWidth?: string;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	// 范围由顶栏项目切换器决定（Board Scope = All projects，见 use-selected-board-or-single-project-scope）；
	// 没有宿主（单测里独立挂载）时只有 stage 列表。stage 列表在 Board Scope 下只隐藏不卸载：下面的钉住 rail /
	// 焦点卡几何 hook 都挂在它的 scrollport 上，卸载再挂回会让它们丢掉观察目标。
	const crossProjectRecentlyActiveTaskSwitcherHost = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const showsCrossProjectRecentlyActiveTaskSwitcher =
		crossProjectRecentlyActiveTaskSwitcherHost?.isBoardScopeAllProjectsSelected === true;

	const columnIds = useMemo(() => selection.allColumns.map((column) => column.id), [selection.allColumns]);

	// stage 分段的展开态集中持有（Done 默认折叠，其余默认展开），行内卡头与钉住 rail 的孪生卡头共读同一份；
	// rail 卡头发起的跳转 / 折叠 / 展开各自的滚动落点也由它决定。
	const {
		isStageSectionExpanded,
		toggleStageSectionExpandedFromInFlowHeader,
		toggleStageSectionExpandedFromStageHeaderRail,
		expandStageSectionWithoutScrolling,
		jumpToStageSectionBelowTopRail,
	} = useFocusViewStageSectionExpansion({
		scrollRootRef: scrollContainerRef,
		orderedColumnIds: columnIds,
		focusedColumnId: selection.column.id,
		focusedTaskId: selection.card.id,
	});

	const activateCard = useCallback((card: BoardCardModel) => onCardSelect(card.id), [onCardSelect]);
	const pinnedTasks = useMemo(
		() => collectTasksPinnedToTaskPinboard({ columns: selection.allColumns }),
		[selection.allColumns],
	);

	// 点置顶板分身上的 stage 标签：先把目标所在分段展开（折叠时整段 display:none，scrollIntoView 无效），
	// 再由控制器逐帧重试直到本体卡挂载、滚入视野并脉冲高亮。
	const { taskIdRequestedToReveal, requestRevealCanonicalTaskCard } = useRevealCanonicalTaskCard({
		prepareRevealTarget: (taskId) => {
			const targetColumnId = findCardColumnId(selection.allColumns, taskId);
			if (!targetColumnId) {
				return;
			}
			expandStageSectionWithoutScrolling(targetColumnId);
		},
	});

	const taskCardActionHandlers: TaskCardActionHandlerBundle = {
		onStartTask,
		onMoveToTrashTask,
		onMoveToValidationTask,
		onMoveToReviewTask,
		onRestoreFromTrashTask,
		onDeleteTask,
		onSaveTitle: onSaveTaskTitle,
		onEditTask,
		onRequestPinToTaskPinboard,
		onUnpinFromTaskPinboard,
		moveToTrashLoadingById,
	};

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
		const escapedTaskId = escapeCssAttributeSelectorValue(selection.card.id);
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
		// 从 All projects 切回时 stage 列表刚由 display:none 变回可见，也要把焦点卡重新居中。
	}, [selection.card.id, selection.column.id, showsCrossProjectRecentlyActiveTaskSwitcher]);

	return (
		// Focus View 左栏的三种卡片渲染角色（本体卡、rail 焦点卡克隆、置顶板分身）都在这棵子树里，一处提供紧凑密度
		// 即全覆盖（见 TaskCardBodyVisualDensity）；主看板不在这里，保持标准密度。
		<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
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
				{showsCrossProjectRecentlyActiveTaskSwitcher && crossProjectRecentlyActiveTaskSwitcherHost ? (
					<CrossProjectRecentlyActiveTaskSwitcherPanel host={crossProjectRecentlyActiveTaskSwitcherHost} />
				) : null}
				<div
					className={cn("flex min-h-0 flex-1 flex-col", showsCrossProjectRecentlyActiveTaskSwitcher && "hidden")}
					data-testid="focus-view-current-project-stage-list"
				>
					{/* 创建入口与置顶板同属固定区，不随下方 stage 列表滚走。 */}
					{onCreateTask ? (
						<div className="shrink-0 px-2 pt-2">
							<Button
								icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
								aria-label="Create task"
								fill
								onClick={onCreateTask}
							>
								<span className="inline-flex items-center gap-1.5">
									<span>Create task</span>
									<span aria-hidden className="text-text-secondary">
										(c)
									</span>
								</span>
							</Button>
						</div>
					) : null}
					{/* 置顶板分段是 scrollport 之外的固定区：常驻列表顶端、不随 stage 列表滚走。 */}
					<TaskPinboardSectionInFocusView
						pinnedTasks={pinnedTasks}
						selectedCardId={selection.card.id}
						taskSessions={taskSessions}
						handlers={taskCardActionHandlers}
						onActivateCard={activateCard}
						onRevealCanonicalCardInItsStage={requestRevealCanonicalTaskCard}
						onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
						workspacePath={workspacePath}
						defaultClineModelId={defaultClineModelId}
						defaultAgentId={defaultAgentId}
					/>
					{/* stage 列表区：StageHeaderRails 以绝对定位锚在这里，顶沿 rail 从置顶板分段下沿起算、不会盖住它。
			    它同时必须是 rail 的裁剪边界：底沿 rail 自 bottom:0 向上堆叠，本区矮于 rail 时会越过本区上沿，
			    以 z-index:5 的不透明底盖住上方的置顶板分段（外层面板的 overflow:hidden 只裁面板边界）。
			    用 clip 而非 hidden：不创建滚动容器，scrollIntoView 不会把本区自身滚动错位。 */}
					<div className="relative flex min-h-0 flex-1 flex-col overflow-clip">
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
								{selection.allColumns.map((column) => (
									<ColumnSection
										key={column.id}
										column={column}
										selectedCardId={selection.card.id}
										open={isStageSectionExpanded(column.id)}
										onToggleOpen={() => toggleStageSectionExpandedFromInFlowHeader(column.id)}
										taskIdRequestedToReveal={taskIdRequestedToReveal}
										onCardClick={activateCard}
										taskSessions={taskSessions}
										onStartTask={
											column.id === "backlog" || column.id === "in_progress" ? onStartTask : undefined
										}
										onRequestStartAllReadyBacklogTasks={
											column.id === "backlog" ? onRequestStartAllReadyBacklogTasks : undefined
										}
										onClearTrash={column.id === "trash" ? onClearTrash : undefined}
										onEditTask={column.id === "backlog" ? onEditTask : undefined}
										onSaveTitle={onSaveTaskTitle}
										onMoveToTrashTask={
											column.id === "review" || column.id === "validation" ? onMoveToTrashTask : undefined
										}
										onMoveToValidationTask={column.id === "review" ? onMoveToValidationTask : undefined}
										onMoveToReviewTask={column.id === "in_progress" ? onMoveToReviewTask : undefined}
										onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
										onDeleteTask={onDeleteTask}
										onRequestPinToTaskPinboard={onRequestPinToTaskPinboard}
										onUnpinFromTaskPinboard={onUnpinFromTaskPinboard}
										moveToTrashLoadingById={
											column.id === "review" || column.id === "validation"
												? moveToTrashLoadingById
												: undefined
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
							isStageSectionExpanded={isStageSectionExpanded}
							onToggleStageSectionExpandedFromStageHeaderRail={toggleStageSectionExpandedFromStageHeaderRail}
							onJumpToStageSectionBelowTopRail={jumpToStageSectionBelowTopRail}
							scrollRootRef={scrollContainerRef}
							taskSessions={taskSessions}
							onStartTask={onStartTask}
							onMoveToTrashTask={onMoveToTrashTask}
							onMoveToValidationTask={onMoveToValidationTask}
							onRestoreFromTrashTask={onRestoreFromTrashTask}
							onDeleteTask={onDeleteTask}
							onRequestPinToTaskPinboard={onRequestPinToTaskPinboard}
							onUnpinFromTaskPinboard={onUnpinFromTaskPinboard}
							moveToTrashLoadingById={moveToTrashLoadingById}
							workspacePath={workspacePath}
							defaultClineModelId={defaultClineModelId}
							defaultAgentId={defaultAgentId}
						/>
					</div>
				</div>
			</div>
		</TaskCardBodyVisualDensityProvider>
	);
}
