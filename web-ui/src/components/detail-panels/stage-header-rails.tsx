import { resolveMainTaskConversationSessionSummary } from "@runtime-session-activity";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MouseEvent, RefObject } from "react";
import { useEffect, useMemo, useState } from "react";

import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { STAGE_HEADER_HEIGHT_PX } from "@/components/detail-panels/stage-header-rail-geometry";
import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type { StageHeaderRailEdge } from "@/hooks/use-focus-view-stage-section-expansion";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardColumn, BoardColumnId, CardSelection } from "@/types";
import { escapeCssAttributeSelectorValue } from "@/utils/css-attribute-selector-value";

/**
 * 焦点 stage 的动作集合与卡片数据；顶/底 rail 的焦点条目挂焦点卡克隆时经 `buildTaskCardBusinessProps` 交给
 * `TaskCardBody`——与本体卡、置顶板分身、All projects 展开行同一个 stage 门控。这里曾手抄一份门控，漏了
 * 「移到 Review」与「取消自动动作」，按钮显示出来却什么都不做。
 */
interface StageRailFocusedCardProps {
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	taskCardActionHandlers: TaskCardActionHandlerBundle;
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
	/** 折叠状态真源（面板层 `useFocusViewStageSectionExpansion`）：rail 条目的箭头必须如实呈现它。 */
	isStageSectionExpanded: (columnId: BoardColumnId) => boolean;
	/** rail 条目的折叠按钮：与行内卡头共用同一份状态，滚动策略按所在 rail 沿区分。 */
	onToggleStageSectionExpandedFromStageHeaderRail: (columnId: BoardColumnId, railEdge: StageHeaderRailEdge) => void;
	/** rail 条目的标签：跳到该 stage，第一张卡完整露在顶 rail 之下。 */
	onJumpToStageSectionBelowTopRail: (columnId: BoardColumnId) => void;
	scrollRootRef: RefObject<HTMLElement | null>;
}

/** 单条 rail 条目：始终渲染 stage 卡头；`withCard` 时其下挂焦点卡的只读副本（副本不带 data-task-id）。 */
function StageHeaderRailEntry({
	column,
	withCard,
	selection,
	isStageSectionExpanded,
	onToggleStageSectionExpanded,
	onScrollToSection,
	onScrollToFocusedCard,
	taskSessions,
	taskCardActionHandlers,
	workspacePath,
	defaultClineModelId,
	defaultAgentId,
}: StageRailFocusedCardProps & {
	column: BoardColumn;
	withCard: boolean;
	selection: CardSelection;
	isStageSectionExpanded: boolean;
	onToggleStageSectionExpanded: () => void;
	onScrollToSection: () => void;
	onScrollToFocusedCard: (event: MouseEvent<HTMLElement>) => void;
}): React.ReactElement {
	const columnId = column.id;
	const { card } = selection;

	return (
		<div className="bg-surface-1 rounded-lg border border-border">
			{/*
			 * 卡头行拆成**两个同级按钮**（嵌套 <button> 是非法 HTML）：箭头折叠、其余跳转。钉住时这个条目在视觉上
			 * 替代被它盖住的行内卡头，故几何与 `ColumnSection` 的行内卡头逐项对位：行内是 `margin: 0 4px` +
			 * `padding: 0 8px` + `gap: 8` → 箭头占 x∈[12,28]、标签起于 36。这里箭头按钮 margin-left 4 + 宽 32
			 * → [4,36] 内居中 16px 图标 → [12,28]；跳转按钮起于 36、padding-left 0 → 标签起于 36；右侧
			 * margin 4 + padding 8 = 12，与行内一致。行高必须仍是 STAGE_HEADER_HEIGHT_PX、外层保留
			 * `border border-border`，且不得新增纵向 padding——否则钉住分类器与跳转落点的堆叠阈值全部失准。
			 */}
			<div style={{ display: "flex", alignItems: "center", height: STAGE_HEADER_HEIGHT_PX }}>
				<button
					type="button"
					onClick={onToggleStageSectionExpanded}
					aria-expanded={isStageSectionExpanded}
					aria-label={`${isStageSectionExpanded ? "Collapse" : "Expand"} ${column.title}`}
					title={`${isStageSectionExpanded ? "Collapse" : "Expand"} ${column.title}`}
					className="hover:bg-surface-0 rounded-md"
					style={{
						height: 32,
						width: 32,
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						padding: 0,
						margin: "0 0 0 4px",
						background: "none",
						border: "none",
						cursor: "pointer",
						color: "inherit",
					}}
				>
					{isStageSectionExpanded ? (
						<ChevronDown size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					) : (
						<ChevronRight size={16} className="text-text-secondary" style={{ flexShrink: 0 }} />
					)}
				</button>
				<button
					type="button"
					onClick={onScrollToSection}
					className="hover:bg-surface-0 rounded-md"
					aria-label={`Jump to ${column.title}`}
					title={`Jump to ${column.title}`}
					style={{
						height: 32,
						flex: "1 1 auto",
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						padding: "0 8px 0 0",
						margin: "0 4px 0 0",
						background: "none",
						border: "none",
						cursor: "pointer",
						color: "inherit",
						textAlign: "left",
					}}
				>
					<StageHeaderLabel columnId={columnId} title={column.title} count={column.cards.length} />
				</button>
			</div>
			{withCard ? (
				<div
					data-testid="stage-header-rail-focused-card"
					style={{ display: "flex", flexDirection: "column", padding: 8 }}
					onClick={onScrollToFocusedCard}
				>
					<TaskCardBody
						renderRole="focused_card_copy_under_sticky_stage_header"
						{...buildTaskCardBusinessProps({
							card,
							columnId,
							sessionSummary: resolveMainTaskConversationSessionSummary(card, taskSessions) ?? undefined,
							selected: true,
							handlers: taskCardActionHandlers,
							workspacePath,
							defaultClineModelId,
							defaultAgentId,
						})}
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
 * 卡头行拆成箭头（折叠/展开，与行内卡头同一份状态）+ 标签（跳到对应 stage）两个动作，两者的滚动落点都由
 * 面板层 `useFocusViewStageSectionExpansion` 决定；点击焦点卡区 → 滚回真实焦点卡（含 Radix portal 的
 * DOM-containment 守卫，避免点开「View original prompt」弹层误触滚动）。
 *
 * 下面所有非焦点卡用途的 props 都**显式解构**：漏一个就会被 `...focusedCardProps` 的 rest-spread 带进
 * 焦点卡的 prop 包。
 */
export function StageHeaderRails({
	selection,
	topPinnedColumnIds,
	bottomPinnedColumnIds,
	focusedCardPinState,
	isStageSectionExpanded,
	onToggleStageSectionExpandedFromStageHeaderRail,
	onJumpToStageSectionBelowTopRail,
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
			?.querySelector<HTMLElement>(`[data-task-id="${escapeCssAttributeSelectorValue(selection.card.id)}"]`)
			?.scrollIntoView({ block: "center", inline: "nearest" });
	};

	const renderEntry = (columnId: string, edge: StageHeaderRailEdge): React.ReactElement | null => {
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
				isStageSectionExpanded={isStageSectionExpanded(column.id)}
				onToggleStageSectionExpanded={() => onToggleStageSectionExpandedFromStageHeaderRail(column.id, edge)}
				onScrollToSection={() => onJumpToStageSectionBelowTopRail(column.id)}
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
