import { CornerUpLeft } from "lucide-react";
import type { MouseEvent } from "react";
import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { TaskCardBody } from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { buildTaskCardBusinessProps } from "@/components/task-card-business-props";
import { Button } from "@/components/ui/button";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";
import type { RuntimeAgentId } from "@/runtime/types";
import type { CardSelection } from "@/types";

/** 分组外保底卡和 Sticky 用同一份实时卡体；只在 Sticky 时接管卡体点击，卡片动作与 Portal 仍独立。 */
export function CrossProjectTaskSwitcherFocusedTaskCard({
	selection,
	projectName,
	currentProjectTaskCards,
	defaultAgentId,
	onRevealFocusedTask,
}: {
	selection: CardSelection | null;
	projectName: string;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId: RuntimeAgentId | null;
	onRevealFocusedTask?: () => void;
}) {
	const revealFromCardBody = (event: MouseEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.target as Node)) return;
		if ((event.target as HTMLElement).closest("button, input, textarea, a, [role='button']")) return;
		onRevealFocusedTask?.();
	};
	return (
		<section
			className="flex min-w-0 shrink-0 flex-col rounded-lg border border-border bg-surface-1"
			aria-label="当前聚焦任务"
		>
			<div className="flex min-h-9 items-center gap-2 px-2 text-xs text-text-secondary">
				<span className="shrink-0 font-semibold text-text-primary">当前聚焦任务</span>
				<span className="min-w-0 truncate" title={projectName}>
					{projectName}
				</span>
				{selection ? (
					<span className="ml-auto inline-flex shrink-0 items-center gap-1">
						<ColumnIndicator columnId={selection.column.id} size={12} />
						{resolveBoardColumnTitle(selection.column.id)}
					</span>
				) : null}
				{onRevealFocusedTask ? (
					<Button
						size="xs"
						variant="ghost"
						icon={<CornerUpLeft size={13} />}
						aria-label="返回当前任务所在位置"
						onClick={onRevealFocusedTask}
					/>
				) : null}
			</div>
			<div className="min-w-0 px-1 pb-1.5" onClick={onRevealFocusedTask ? revealFromCardBody : undefined}>
				{selection && currentProjectTaskCards ? (
					<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
						<TaskCardBody
							{...buildTaskCardBusinessProps({
								card: selection.card,
								columnId: selection.column.id,
								taskSessions: currentProjectTaskCards.currentProjectTaskSessions,
								handlers: currentProjectTaskCards.currentProjectTaskCardActionHandlers,
								selected: true,
								workspacePath: currentProjectTaskCards.currentProjectWorkspacePath,
								defaultAgentId,
							})}
							renderRole="focused_task_card_copy_in_cross_project_task_switcher"
						/>
					</TaskCardBodyVisualDensityProvider>
				) : (
					<div role="status" className="px-2 py-2 text-xs text-text-secondary">
						正在加载目标任务…
					</div>
				)}
			</div>
		</section>
	);
}
