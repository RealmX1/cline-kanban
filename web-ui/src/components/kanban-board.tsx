import {
	type BeforeCapture,
	DragDropContext,
	type DragStart,
	type DropResult,
	type FluidDragActions,
	type Sensor,
	type SensorAPI,
	type SnapDragActions,
} from "@hello-pangea/dnd";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardColumn } from "@/components/board-column";
import { BoardColumnCollapsedVerticalStrip } from "@/components/board-column-collapsed-vertical-strip";
import { DependencyOverlay } from "@/components/dependencies/dependency-overlay";
import { useDependencyLinking } from "@/components/dependencies/use-dependency-linking";
import { TaskPinboardStripOnKanbanBoard } from "@/components/task-pinboard-strip-on-kanban-board";
import { useKanbanBoardColumnCollapseAndWidthPreferences } from "@/hooks/use-kanban-board-column-collapse-and-width-preferences";
import { useRevealCanonicalTaskCard } from "@/hooks/use-reveal-canonical-task-card";
import { ResizeHandle } from "@/resize/resize-handle";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { canCreateTaskDependency } from "@/state/board-state";
import { findCardColumnId, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import {
	KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX,
	KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX,
} from "@/state/kanban-board-column-collapse-and-width-preferences";
import { collectTasksPinnedToTaskPinboard } from "@/state/task-pinboard-pinning";
import type { BoardCard, BoardColumnId, BoardData, BoardDependency } from "@/types";

const BOARD_COLUMN_ORDER: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];

// sensors 数组与其中的 sensor 本体都放在模块级：写在 JSX 里的 `[programmaticSensor]` 字面量
// 每次渲染都会新建数组。看板全应用只挂载一个，sensor 拿到的 api 用模块级 holder 承接即可。
const programmaticSensorApiHolder: { current: SensorAPI | null } = { current: null };
const programmaticSensor: Sensor = (api) => {
	programmaticSensorApiHolder.current = api;
};
const PROGRAMMATIC_SENSORS: Sensor[] = [programmaticSensor];

const KANBAN_BOARD_COLUMN_WIDTH_RESIZE_HANDLE_TITLE =
	"Drag (or focus and press ←/→, Home/End) to resize this column · Hold Shift to resize all expanded columns · Double-click or Enter to reset (with Shift resets all)";

export type RequestProgrammaticCardMove = (move: ProgrammaticCardMoveInFlight) => boolean;

function isRectVerticallyVisibleWithinContainer(rect: DOMRect, containerRect: DOMRect): boolean {
	return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
}

export const KanbanBoard = memo(function KanbanBoard({
	data,
	taskSessions,
	onCardSelect,
	onCreateTask,
	onStartTask,
	onRequestStartAllReadyBacklogTasks,
	onClearTrash,
	onEditTask,
	onSaveTaskTitle,
	onCancelAutomaticTaskAction,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onMoveToReviewTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onRequestPinToTaskPinboard,
	onUnpinFromTaskPinboard,
	onEditTaskPinboardPinReason,
	moveToTrashLoadingById,
	moveToValidationLoadingById,
	moveToReviewLoadingById,
	dependencies,
	onCreateDependency,
	onDeleteDependency,
	onDragEnd,
	onRequestProgrammaticCardMoveReady,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: {
	data: BoardData;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onCardSelect: (taskId: string) => void;
	onCreateTask: () => void;
	onStartTask?: (taskId: string) => void;
	onRequestStartAllReadyBacklogTasks?: () => void;
	onClearTrash?: () => void;
	onEditTask?: (card: BoardCard) => void;
	onSaveTaskTitle?: (taskId: string, title: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	onEditTaskPinboardPinReason?: (taskId: string) => void;
	moveToTrashLoadingById?: Record<string, boolean>;
	moveToValidationLoadingById?: Record<string, boolean>;
	moveToReviewLoadingById?: Record<string, boolean>;
	dependencies: BoardDependency[];
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
	onDeleteDependency?: (dependencyId: string) => void;
	onDragEnd: (result: DropResult) => void;
	onRequestProgrammaticCardMoveReady?: (requestMove: RequestProgrammaticCardMove | null) => void;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const dragOccurredRef = useRef(false);
	const boardRef = useRef<HTMLElement>(null);
	const latestDataRef = useRef<BoardData>(data);
	const programmaticCardMoveInFlightRef = useRef<ProgrammaticCardMoveInFlight | null>(null);
	const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null);

	const [activeDragSourceColumnId, setActiveDragSourceColumnId] = useState<BoardColumnId | null>(null);
	const [programmaticCardMoveInFlight, setProgrammaticCardMoveInFlight] =
		useState<ProgrammaticCardMoveInFlight | null>(null);
	const canLinkTasks = useCallback(
		(fromTaskId: string, toTaskId: string) => canCreateTaskDependency(data, fromTaskId, toTaskId),
		[data],
	);
	const activateCard = useCallback((card: BoardCard) => onCardSelect(card.id), [onCardSelect]);
	const activateCardUnlessDragged = useCallback(
		(card: BoardCard) => {
			if (!dragOccurredRef.current) onCardSelect(card.id);
		},
		[onCardSelect],
	);
	const dependencyLinking = useDependencyLinking({
		canLinkTasks,
		onCreateDependency,
	});
	// 每次 board 变化都要重扫全盘卡片，memo 掉避免拖拽期间逐帧重排（拖拽会高频重渲 KanbanBoard）。
	const pinnedTasks = useMemo(() => collectTasksPinnedToTaskPinboard(data), [data]);
	const columnCollapseAndWidthPreferences = useKanbanBoardColumnCollapseAndWidthPreferences({
		orderedColumnIds: BOARD_COLUMN_ORDER,
		boardRef,
	});
	// 程序化移卡回调经 ref 读折叠态，免得每次折叠/展开都换掉 requestProgrammaticCardMove 的引用。
	const isColumnCollapsedRef = useRef(columnCollapseAndWidthPreferences.isColumnCollapsed);
	isColumnCollapsedRef.current = columnCollapseAndWidthPreferences.isColumnCollapsed;
	const { expandColumn } = columnCollapseAndWidthPreferences;
	// 点置顶板分身上的 stage 标签 → 让本体卡所在列强制渲染到它、滚进视野并脉冲高亮；
	// 本体卡所在列若被折叠（卡片不在 DOM 里），先展开它。
	const { taskIdRequestedToReveal, requestRevealCanonicalTaskCard } = useRevealCanonicalTaskCard({
		prepareRevealTarget: (taskId) => {
			const columnIdOfTaskToReveal = findCardColumnId(latestDataRef.current.columns, taskId);
			if (columnIdOfTaskToReveal) {
				expandColumn(columnIdOfTaskToReveal);
			}
		},
	});

	useEffect(() => {
		latestDataRef.current = data;
	}, [data]);

	const getElementClientCenter = useCallback((element: HTMLElement): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();
		return {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
	}, []);

	const canAnimateProgrammaticTopInsertion = useCallback((taskId: string, targetColumnId: BoardColumnId): boolean => {
		const boardElement = boardRef.current;
		if (!boardElement) {
			return false;
		}
		const sourceCardElement = boardElement.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
		const sourceColumnId = findCardColumnId(latestDataRef.current.columns, taskId);
		const sourceColumnElement = sourceColumnId
			? boardElement.querySelector<HTMLElement>(`section[data-column-id="${sourceColumnId}"]`)
			: null;
		const sourceCardsElement = sourceColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
		const targetColumnElement = boardElement.querySelector<HTMLElement>(`[data-column-id="${targetColumnId}"]`);
		const targetCardsElement = targetColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
		if (!sourceCardElement || !sourceCardsElement || !targetCardsElement) {
			return false;
		}

		const sourceCardRect = sourceCardElement.getBoundingClientRect();
		const sourceCardsRect = sourceCardsElement.getBoundingClientRect();
		if (!isRectVerticallyVisibleWithinContainer(sourceCardRect, sourceCardsRect)) {
			return false;
		}

		if (targetCardsElement.scrollTop > 1) {
			return false;
		}

		const firstTargetCardElement = targetCardsElement.querySelector<HTMLElement>("[data-task-id]");
		if (firstTargetCardElement) {
			const firstTargetCardRect = firstTargetCardElement.getBoundingClientRect();
			return isRectVerticallyVisibleWithinContainer(firstTargetCardRect, targetCardsElement.getBoundingClientRect());
		}

		return true;
	}, []);

	const getProgrammaticTopTargetClientSelection = useCallback(
		(taskId: string, targetColumnId: BoardColumnId): { x: number; y: number } | null => {
			const boardElement = boardRef.current;
			if (!boardElement) {
				return null;
			}
			const sourceCardElement = boardElement.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
			const targetColumnElement = boardElement.querySelector<HTMLElement>(`[data-column-id="${targetColumnId}"]`);
			const targetCardsElement = targetColumnElement?.querySelector<HTMLElement>(".kb-column-cards");
			if (!sourceCardElement || !targetCardsElement) {
				return null;
			}

			const sourceCardRect = sourceCardElement.getBoundingClientRect();
			const firstTargetCardElement = targetCardsElement.querySelector<HTMLElement>("[data-task-id]");
			if (firstTargetCardElement) {
				const targetRect = firstTargetCardElement.getBoundingClientRect();
				const desiredCenterY = targetRect.top + sourceCardRect.height / 2;
				const maxTopInsertCenterY = targetRect.top + targetRect.height / 2 - 1;
				return {
					x: targetRect.left + sourceCardRect.width / 2,
					y: Math.min(desiredCenterY, maxTopInsertCenterY),
				};
			}
			const targetRect = targetCardsElement.getBoundingClientRect();
			const targetCardsStyle = window.getComputedStyle(targetCardsElement);
			const paddingTop = Number.parseFloat(targetCardsStyle.paddingTop) || 0;
			const paddingLeft = Number.parseFloat(targetCardsStyle.paddingLeft) || 0;
			return {
				x: targetRect.left + paddingLeft + sourceCardRect.width / 2,
				y: targetRect.top + paddingTop + sourceCardRect.height / 2,
			};
		},
		[],
	);

	const clearProgrammaticCardMoveInFlight = useCallback((taskId?: string) => {
		if (taskId && programmaticCardMoveInFlightRef.current?.taskId !== taskId) {
			return;
		}
		programmaticCardMoveInFlightRef.current = null;
		setProgrammaticCardMoveInFlight(null);
	}, []);

	const requestProgrammaticCardMove = useCallback<RequestProgrammaticCardMove>(
		(move) => {
			const { taskId, toColumnId: targetColumnId } = move;
			const board = latestDataRef.current;
			const sourceColumnId = findCardColumnId(board.columns, taskId);
			if (!sourceColumnId || sourceColumnId !== move.fromColumnId || sourceColumnId === targetColumnId) {
				return false;
			}

			const sensorApi = programmaticSensorApiHolder.current;
			if (!sensorApi) {
				return false;
			}

			const sourceOrderIndex = BOARD_COLUMN_ORDER.indexOf(sourceColumnId);
			const targetOrderIndex = BOARD_COLUMN_ORDER.indexOf(targetColumnId);
			if (sourceOrderIndex < 0 || targetOrderIndex < 0) {
				return false;
			}
			// 源列或目标列折叠时没有可见的卡片位可供动画落点：放弃动画，交给调用方的无动画直接移动兜底。
			if (isColumnCollapsedRef.current(sourceColumnId) || isColumnCollapsedRef.current(targetColumnId)) {
				return false;
			}
			if (move.insertAtTop && !canAnimateProgrammaticTopInsertion(taskId, targetColumnId)) {
				return false;
			}

			const horizontalSteps = targetOrderIndex - sourceOrderIndex;
			programmaticCardMoveInFlightRef.current = move;
			setProgrammaticCardMoveInFlight(move);
			const preDrag = sensorApi.tryGetLock(taskId);
			if (!preDrag) {
				clearProgrammaticCardMoveInFlight(taskId);
				return false;
			}

			const sourceCardElement = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`) ?? null;
			const topTargetClientSelection = move.insertAtTop
				? getProgrammaticTopTargetClientSelection(taskId, targetColumnId)
				: null;
			if (sourceCardElement && topTargetClientSelection) {
				let dragActions: FluidDragActions;
				try {
					dragActions = preDrag.fluidLift(getElementClientCenter(sourceCardElement));
				} catch {
					clearProgrammaticCardMoveInFlight(taskId);
					if (preDrag.isActive()) {
						preDrag.abort();
					}
					return false;
				}

				const startClientSelection = getElementClientCenter(sourceCardElement);
				const startTime = performance.now();
				const deltaX = topTargetClientSelection.x - startClientSelection.x;
				const deltaY = topTargetClientSelection.y - startClientSelection.y;
				const travelDistance = Math.hypot(deltaX, deltaY);
				const durationMs = Math.min(224, Math.max(133, 102 + travelDistance * 0.126)) * 0.5;
				const easeInOutCubic = (value: number) => (value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2);
				const animate = (frameTime: number) => {
					if (!dragActions.isActive()) {
						return;
					}
					try {
						const progress = Math.min((frameTime - startTime) / durationMs, 1);
						const easedProgress = easeInOutCubic(progress);
						dragActions.move({
							x: startClientSelection.x + deltaX * easedProgress,
							y: startClientSelection.y + deltaY * easedProgress,
						});
						if (progress >= 1) {
							dragActions.drop();
							return;
						}
						window.requestAnimationFrame(animate);
					} catch {
						clearProgrammaticCardMoveInFlight(taskId);
						if (dragActions.isActive()) {
							dragActions.cancel();
						}
					}
				};

				window.requestAnimationFrame(animate);
				return true;
			}

			let dragActions: SnapDragActions;
			try {
				dragActions = preDrag.snapLift();
			} catch {
				clearProgrammaticCardMoveInFlight(taskId);
				if (preDrag.isActive()) {
					preDrag.abort();
				}
				return false;
			}

			const moveOneStep = horizontalSteps > 0 ? dragActions.moveRight : dragActions.moveLeft;
			const moveSteps: Array<() => void> = [];
			for (let step = 0; step < Math.abs(horizontalSteps); step += 1) {
				moveSteps.push(moveOneStep);
			}

			const performStep = (stepIndex: number) => {
				if (!dragActions.isActive()) {
					return;
				}
				try {
					if (stepIndex >= moveSteps.length) {
						dragActions.drop();
						return;
					}
					moveSteps[stepIndex]?.();
					window.setTimeout(() => {
						performStep(stepIndex + 1);
					}, 90);
				} catch {
					clearProgrammaticCardMoveInFlight(taskId);
					if (dragActions.isActive()) {
						dragActions.cancel();
					}
				}
			};

			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					performStep(0);
				});
			});
			return true;
		},
		[
			canAnimateProgrammaticTopInsertion,
			clearProgrammaticCardMoveInFlight,
			getElementClientCenter,
			getProgrammaticTopTargetClientSelection,
		],
	);

	useEffect(() => {
		onRequestProgrammaticCardMoveReady?.(requestProgrammaticCardMove);
		return () => {
			onRequestProgrammaticCardMoveReady?.(null);
		};
	}, [onRequestProgrammaticCardMoveReady, requestProgrammaticCardMove]);

	const handleBeforeCapture = useCallback(
		(start: BeforeCapture) => {
			setActiveDragTaskId(start.draggableId);
			setActiveDragSourceColumnId(findCardColumnId(data.columns, start.draggableId));
		},
		[data],
	);

	const handleDragStart = useCallback((_start: DragStart) => {
		dragOccurredRef.current = true;
	}, []);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			setActiveDragTaskId(null);
			setActiveDragSourceColumnId(null);
			clearProgrammaticCardMoveInFlight(result.draggableId);
			requestAnimationFrame(() => {
				dragOccurredRef.current = false;
			});
			onDragEnd(result);
		},
		[clearProgrammaticCardMoveInFlight, onDragEnd],
	);

	// Dependency links should reroute as soon as motion starts, not only after drop.
	// Treat the active card as already belonging to its destination/effective column
	// so the edge transition can animate alongside the move.
	const activeTaskEffectiveColumnId =
		programmaticCardMoveInFlight?.toColumnId ??
		(activeDragTaskId !== null && activeDragSourceColumnId === "backlog" ? "in_progress" : null);

	// Boards without dependency edges are the common case, and a mounted overlay
	// still installs a subtree MutationObserver plus a ResizeObserver over the
	// whole board. Motion keeps it mounted so a link removed mid-drag can still
	// play its transient fade-out.
	const shouldMountDependencyOverlay =
		dependencies.length > 0 ||
		dependencyLinking.draft !== null ||
		activeDragTaskId !== null ||
		programmaticCardMoveInFlight !== null;

	return (
		<DragDropContext
			onBeforeCapture={handleBeforeCapture}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			sensors={PROGRAMMATIC_SENSORS}
		>
			{/* 置顶板横条在 DragDropContext 之内、`.kb-board` 之外：见 TaskPinboardStripOnKanbanBoard 的注释，
			    进了 `.kb-board` 会被移动端的「直接子 section 即一列」规则拉宽，也会落进依赖连线的查询范围。 */}
			<div className="flex min-h-0 flex-1 flex-col">
				<TaskPinboardStripOnKanbanBoard
					pinnedTasks={pinnedTasks}
					taskSessions={taskSessions}
					handlers={{
						onStartTask,
						onMoveToTrashTask,
						onMoveToValidationTask,
						onMoveToReviewTask,
						onRestoreFromTrashTask,
						onDeleteTask,
						onCancelAutomaticTaskAction,
						onSaveTitle: onSaveTaskTitle,
						onEditTask,
						onRequestPinToTaskPinboard,
						onUnpinFromTaskPinboard,
						moveToTrashLoadingById,
						moveToValidationLoadingById,
						moveToReviewLoadingById,
					}}
					onActivateCard={activateCard}
					onRevealCanonicalCardInItsStage={requestRevealCanonicalTaskCard}
					onEditTaskPinboardPinReason={onEditTaskPinboardPinReason}
					workspacePath={workspacePath}
					defaultClineModelId={defaultClineModelId}
					defaultAgentId={defaultAgentId}
				/>
				<section
					ref={boardRef}
					className="kb-board kb-dependency-surface"
					data-programmatic-card-move={programmaticCardMoveInFlight ? "true" : undefined}
				>
					{data.columns.map((column) =>
						columnCollapseAndWidthPreferences.isColumnCollapsed(column.id) ? (
							<BoardColumnCollapsedVerticalStrip
								key={column.id}
								column={column}
								onExpandColumn={columnCollapseAndWidthPreferences.toggleColumnCollapsed}
								activeDragTaskId={activeDragTaskId}
								activeDragSourceColumnId={activeDragSourceColumnId}
								programmaticCardMoveInFlight={programmaticCardMoveInFlight}
							/>
						) : (
							<Fragment key={column.id}>
								<BoardColumn
									column={column}
									onCollapseColumn={columnCollapseAndWidthPreferences.toggleColumnCollapsed}
									columnFlexStyle={columnCollapseAndWidthPreferences.getExpandedColumnFlexStyle(column.id)}
									taskSessions={taskSessions}
									onCreateTask={column.id === "backlog" ? onCreateTask : undefined}
									onStartTask={
										column.id === "backlog" || column.id === "in_progress" ? onStartTask : undefined
									}
									onRequestStartAllReadyBacklogTasks={
										column.id === "backlog" ? onRequestStartAllReadyBacklogTasks : undefined
									}
									onClearTrash={column.id === "trash" ? onClearTrash : undefined}
									onEditTask={column.id === "backlog" ? onEditTask : undefined}
									onSaveTitle={onSaveTaskTitle}
									onCancelAutomaticTaskAction={onCancelAutomaticTaskAction}
									onMoveToTrashTask={
										column.id === "review" || column.id === "validation" ? onMoveToTrashTask : undefined
									}
									onMoveToValidationTask={column.id === "review" ? onMoveToValidationTask : undefined}
									onMoveToReviewTask={column.id === "in_progress" ? onMoveToReviewTask : undefined}
									onRestoreFromTrashTask={column.id === "trash" ? onRestoreFromTrashTask : undefined}
									onDeleteTask={onDeleteTask}
									onRequestPinToTaskPinboard={onRequestPinToTaskPinboard}
									onUnpinFromTaskPinboard={onUnpinFromTaskPinboard}
									taskIdRequestedToReveal={taskIdRequestedToReveal}
									moveToTrashLoadingById={
										column.id === "review" || column.id === "validation" ? moveToTrashLoadingById : undefined
									}
									moveToValidationLoadingById={
										column.id === "review" ? moveToValidationLoadingById : undefined
									}
									moveToReviewLoadingById={column.id === "in_progress" ? moveToReviewLoadingById : undefined}
									activeDragTaskId={activeDragTaskId}
									activeDragSourceColumnId={activeDragSourceColumnId}
									programmaticCardMoveInFlight={programmaticCardMoveInFlight}
									onDependencyPointerDown={dependencyLinking.onDependencyPointerDown}
									onDependencyPointerEnter={dependencyLinking.onDependencyPointerEnter}
									dependencySourceTaskId={dependencyLinking.draft?.sourceTaskId ?? null}
									dependencyTargetTaskId={dependencyLinking.draft?.targetTaskId ?? null}
									isDependencyLinking={dependencyLinking.draft !== null}
									workspacePath={workspacePath}
									defaultClineModelId={defaultClineModelId}
									defaultAgentId={defaultAgentId}
									onCardClick={activateCardUnlessDragged}
								/>
								{/* 列宽 handle 是 `.kb-board` 的直接子元素：负 margin 吃掉它额外引入的那一份 flex gap
		    (8 - 4 + 1 - 5 + 8 = 8px)，列间距保持不变；移动端由 CSS 隐藏。 */}
								<ResizeHandle
									orientation="vertical"
									ariaLabel={`Resize ${column.title} column`}
									title={KANBAN_BOARD_COLUMN_WIDTH_RESIZE_HANDLE_TITLE}
									showBaseLine={false}
									className="rounded-full transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent focus-visible:shadow-[0_0_0_2px_var(--color-accent)]"
									style={{ marginLeft: -4, marginRight: -5 }}
									tabIndex={0}
									ariaValueNow={columnCollapseAndWidthPreferences.getColumnCustomWidthPx(column.id)}
									ariaValueMin={KANBAN_BOARD_COLUMN_MIN_CUSTOM_WIDTH_PX}
									ariaValueMax={KANBAN_BOARD_COLUMN_MAX_CUSTOM_WIDTH_PX}
									ariaValueText={
										columnCollapseAndWidthPreferences.getColumnCustomWidthPx(column.id) === undefined
											? "Auto width"
											: undefined
									}
									onKeyDown={(event) =>
										columnCollapseAndWidthPreferences.handleColumnWidthResizeHandleKeyDown(event, column.id)
									}
									onMouseDown={(event) =>
										columnCollapseAndWidthPreferences.startColumnWidthResizeDrag(event, column.id)
									}
									onDoubleClick={(event) =>
										columnCollapseAndWidthPreferences.resetColumnWidthFromHandleDoubleClick(event, column.id)
									}
								/>
							</Fragment>
						),
					)}
					{shouldMountDependencyOverlay && (
						<DependencyOverlay
							containerRef={boardRef}
							dependencies={dependencies}
							draft={dependencyLinking.draft}
							activeTaskId={activeDragTaskId ?? programmaticCardMoveInFlight?.taskId ?? null}
							activeTaskEffectiveColumnId={activeTaskEffectiveColumnId}
							isMotionActive={activeDragTaskId !== null || programmaticCardMoveInFlight !== null}
							onDeleteDependency={onDeleteDependency}
						/>
					)}
				</section>
			</div>
		</DragDropContext>
	);
});
