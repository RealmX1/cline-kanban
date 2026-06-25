import { ChevronDown } from "lucide-react";
import type { MouseEvent, RefObject } from "react";
import { useEffect, useState } from "react";

import { StageHeaderLabel } from "@/components/detail-panels/stage-header-label";
import { TaskCardBody } from "@/components/task-card-body";
import type { SelectedCardPinState } from "@/hooks/use-selected-card-pin-state";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { CardSelection } from "@/types";

function escapeAttributeValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Focus View 左侧列表的「跨 stage 浮动钉住条」。
 *
 * 当被选中卡（连同其所在 stage）被滚出视口、列内 CSS sticky 失效后，本组件以 overlay
 * 形式在滚动视口的顶沿（`pinTop`）或底沿（`pinBottom`）浮现「stage 卡头 + 完整保真的选中卡」，
 * 实现跨 stage 的持续可见。卡体用 `TaskCardBody` 的 `pinnedClone` 模式渲染：不携带
 * `data-task-id`（保证全局唯一）、非拖拽、关闭导航/改标题/依赖，但保留 hover 与各动作按钮。
 * 点击钉住条本体会把列表滚回真实卡片（随后 pin 状态重算判为可见、钉住条自动隐藏）。
 */
export function SelectedTaskPinBar({
	selection,
	pinState,
	scrollRootRef,
	pinBarRootRef,
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
}: {
	selection: CardSelection;
	pinState: Exclude<SelectedCardPinState, "hidden">;
	scrollRootRef: RefObject<HTMLElement | null>;
	/** 浮动条根元素（`.kb-detail-pin-bar`）的 ref，供面板 ResizeObserver 测高以让位原生 sticky 卡头。 */
	pinBarRootRef?: RefObject<HTMLDivElement>;
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
}): React.ReactElement {
	const { card, column } = selection;
	const columnId = column.id;
	const isReview = columnId === "review";
	const isReviewOrValidation = columnId === "review" || columnId === "validation";

	// 让出滚动条宽度，使纵向滚动条仍可见可点（macOS overlay 滚动条则为 0）。
	const [scrollbarWidth, setScrollbarWidth] = useState(0);
	useEffect(() => {
		const root = scrollRootRef.current;
		if (!root) {
			return;
		}
		const measure = () => setScrollbarWidth(root.offsetWidth - root.clientWidth);
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const resizeObserver = new ResizeObserver(measure);
		resizeObserver.observe(root);
		return () => resizeObserver.disconnect();
	}, [scrollRootRef]);

	const scrollBackToSelectedCard = (event: MouseEvent<HTMLElement>) => {
		// 克隆卡里的「View original prompt」按钮会打开 TaskOriginalPromptDialog，
		// 该 Dialog 经 Radix Portal 挂到 document.body，但 React 合成 click 事件仍沿组件树
		// 冒泡回到本 overlay 的 onClick；先做 DOM containment 检查，避免点击 Dialog 正文/空白
		// 误触滚动（与 task-card-body.tsx 的守卫写法保持一致）。
		if (!event.currentTarget.contains(event.target as Node)) {
			return;
		}
		const root = scrollRootRef.current;
		if (!root) {
			return;
		}
		const selectedCardElement = root.querySelector<HTMLElement>(`[data-task-id="${escapeAttributeValue(card.id)}"]`);
		selectedCardElement?.scrollIntoView({ block: "center", inline: "nearest" });
	};

	return (
		<div
			ref={pinBarRootRef}
			className="kb-detail-pin-bar"
			data-testid="selected-task-pin-bar"
			data-pin={pinState === "pinTop" ? "top" : "bottom"}
			style={{ right: scrollbarWidth }}
			onClick={scrollBackToSelectedCard}
		>
			<div className="bg-surface-1 rounded-lg border border-border">
				<div style={{ display: "flex", alignItems: "center", height: 40 }}>
					<div
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
					</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", padding: 8 }}>
					<TaskCardBody
						pinnedClone
						card={card}
						columnId={columnId}
						sessionSummary={taskSessions[card.id]}
						selected
						onStart={columnId === "backlog" ? onStartTask : undefined}
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
			</div>
		</div>
	);
}
