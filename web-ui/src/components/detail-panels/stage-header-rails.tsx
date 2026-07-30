import { ChevronDown } from "lucide-react";
import type { MouseEvent, RefObject } from "react";
import { useEffect, useMemo, useState } from "react";

import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { TaskCardBody } from "@/components/task-card-body";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardColumn, CardSelection } from "@/types";

function escapeAttributeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** 焦点 stage 的动作 handler 与卡片数据；顶/底 rail 的焦点条目挂焦点卡克隆时透传给 `TaskCardBody`。 */
interface StageRailFocusedCardProps {
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onStartTask?: (taskId: string) => void;
	onMoveToTrashTask?: (taskId: string) => void;
	onMoveToValidationTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onCommitTask?: (taskId: string) => void;
	onOpenPrTask?: (taskId: string) => void;
	commitTaskLoadingById?: Record<string, boolean>;
	openPrTaskLoadingById?: Record<string, boolean>;
	moveToTrashLoadingById?: Record<string, boolean>;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}

interface StageHeaderRailsProps extends StageRailFocusedCardProps {
	selection: CardSelection;
	/** 已滚过、卡头钉顶的 stage columnId（文档序）。 */
	topPinnedColumnIds: string[];
	/** 未到达、卡头钉底的 stage columnId（文档序）。 */
	bottomPinnedColumnIds: string[];
	/** 焦点卡钉住状态：决定焦点 stage 的 rail 条目是否挂焦点卡克隆及挂在哪条 rail。 */
	focusedCardPinState: SelectedCardPinState;
	scrollRootRef: RefObject<HTMLElement | null>;
}

/** 单条 rail 条目：始终渲染 stage 卡头；`withCard` 时其下挂焦点卡 `pinnedClone`（克隆不带 data-task-id）。 */
function StageHeaderRailEntry({
	column,
	withCard,
	selection,
	onScrollToSection,
	onScrollToFocusedCard,
	taskSessions,
	onStartTask,
	onMoveToTrashTask,
	onMoveToValidationTask,
	onRestoreFromTrashTask,
	onDeleteTask,
	onCommitTask,
	onOpenPrTask,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: StageRailFocusedCardProps & {
	column: BoardColumn;
	withCard: boolean;
	selection: CardSelection;
	onScrollToSection: () => void;
	onScrollToFocusedCard: (event: MouseEvent<HTMLElement>) => void;
}): React.ReactElement {
	const columnId = column.id;
	const { card } = selection;
	const isReview = columnId === "review";
	const isReviewOrValidation = columnId === "review" || columnId === "validation";

	return (
		<div className="bg-surface-1 rounded-lg border border-border">
			<button
				type="button"
				onClick={onScrollToSection}
				className="hover:bg-surface-0 rounded-md"
				title={`Jump to ${column.title}`}
				style={{
					display: "flex",
					alignItems: "center",
					width: "100%",
					height: 40,
					padding: 0,
					background: "none",
					border: "none",
					cursor: "pointer",
					color: "inherit",
					textAlign: "left",
				}}
			>
				<span
					style={{
						height: 32,
						flex: "1 1 auto",
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "0 8px",
						margin: "0 4px",
					}}
				>
					<ChevronDown size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					<StageHeaderLabel columnId={columnId} title={column.title} count={column.cards.length} />
				</span>
			</button>
			{withCard ? (
				<div
					data-testid="stage-header-rail-focused-card"
					style={{ display: "flex", flexDirection: "column", padding: 8 }}
					onClick={onScrollToFocusedCard}
				>
					<TaskCardBody
						pinnedClone
						card={card}
						columnId={columnId}
						sessionSummary={taskSessions[card.id]}
						selected
						onStart={columnId === "backlog" || columnId === "in_progress" ? onStartTask : undefined}
						onMoveToValidation={isReview ? onMoveToValidationTask : undefined}
						onMoveToTrash={isReviewOrValidation ? onMoveToTrashTask : undefined}
						onRestoreFromTrash={columnId === "trash" ? onRestoreFromTrashTask : undefined}
						onDeleteTask={onDeleteTask}
						onCommit={isReview ? onCommitTask : undefined}
						onOpenPr={isReview ? onOpenPrTask : undefined}
						isCommitLoading={isReview ? (commitTaskLoadingById?.[card.id] ?? false) : false}
						isOpenPrLoading={isReview ? (openPrTaskLoadingById?.[card.id] ?? false) : false}
						isMoveToTrashLoading={isReviewOrValidation ? (moveToTrashLoadingById?.[card.id] ?? false) : false}
						workspacePath={workspacePath}
						defaultClineModelId={defaultClineModelId}
						defaultAgentId={defaultAgentId}
					/>
				</div>
			) : null}
		</div>
	);
}

/**
 * Focus View 左侧列表的「全 stage 卡头手风琴」overlay：顶沿 rail（已滚过卡头，顶→下堆叠）+
 * 底沿 rail（未到达卡头）。钉住布局由 `useStageHeaderPinLayout` 以实时几何算出；本组件仅按结果
 * 渲染两条脱流 overlay，条目用 flexbox 自然堆叠（不手算逐条偏移）。焦点 stage 的条目在焦点卡钉在
 * 同侧时额外挂「stage 卡头 + 完整焦点卡克隆」，即旧 `SelectedTaskPinBar` 的职责——已并入此处，
 * 使焦点卡与普通卡头处于同一堆叠、由同一分类定位，无需再做卡头去重或双 overlay 争边。
 *
 * 点击卡头区 → 滚到对应 stage（导航）；点击焦点卡区 → 滚回真实焦点卡（含 Radix portal 的
 * DOM-containment 守卫，避免点开「View original prompt」弹层误触滚动）。
 */
export function StageHeaderRails({
	selection,
	topPinnedColumnIds,
	bottomPinnedColumnIds,
	focusedCardPinState,
	scrollRootRef,
	...focusedCardProps
}: StageHeaderRailsProps): React.ReactElement | null {
	const columnById = useMemo(
		() => new Map<string, BoardColumn>(selection.allColumns.map((column) => [column.id, column])),
		[selection.allColumns],
	);

	// 让出滚动条宽度，使纵向滚动条仍可见可点（macOS overlay 滚动条则为 0）。与旧钉住条一致。
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	useEffect(() => {
		const root = scrollRootRef.current;
		if (!root) {
			return;
		}
		const measure = (): void => setScrollbarWidth(root.offsetWidth - root.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const resizeObserver = new ResizeObserver(measure);
		resizeObserver.observe(root);
		return () => resizeObserver.disconnect();
	}, [scrollRootRef]);

	const scrollToFocusedCard = (event: MouseEvent<HTMLElement>): void => {
		if (!event.currentTarget.contains(event.target as Node)) {
			return;
		}
		scrollRootRef.current
			?.querySelector<HTMLElement>(`[data-task-id="${escapeAttributeValue(selection.card.id)}"]`)
			?.scrollIntoView({ block: "center", inline: "nearest" });
	};

	const buildScrollToSection =
		(columnId: string): (() => void) =>
		(): void => {
			scrollRootRef.current
				?.querySelector<HTMLElement>(`[data-stage-section-id="${escapeAttributeValue(columnId)}"]`)
				?.scrollIntoView({ block: "start", inline: "nearest" });
		};

	const renderEntry = (columnId: string, edge: "pinTop" | "pinBottom"): React.ReactElement | null => {
		const column = columnById.get(columnId);
		if (!column) {
			return null;
		}
		const withCard = columnId === selection.column.id && focusedCardPinState === edge;
		return (
			<StageHeaderRailEntry
				key={columnId}
				column={column}
				withCard={withCard}
				selection={selection}
				onScrollToSection={buildScrollToSection(columnId)}
				onScrollToFocusedCard={scrollToFocusedCard}
				{...focusedCardProps}
			/>
		);
	};

	const hasTop = topPinnedColumnIds.length > 0;
	const hasBottom = bottomPinnedColumnIds.length > 0;
	if (!hasTop && !hasBottom) {
		return null;
	}

	return (
		<>
			{hasTop ? (
				<div
					className="kb-stage-header-rail"
					data-testid="stage-header-rail"
					data-edge="top"
					style={{ right: scrollbarWidth }}
				>
					{topPinnedColumnIds.map((columnId) => renderEntry(columnId, "pinTop"))}
				</div>
			) : null}
			{hasBottom ? (
				<div
					className="kb-stage-header-rail"
					data-testid="stage-header-rail"
					data-edge="bottom"
					style={{ right: scrollbarWidth }}
				>
					{bottomPinnedColumnIds.map((columnId) => renderEntry(columnId, "pinBottom"))}
				</div>
			) : null}
		</>
	);
}
