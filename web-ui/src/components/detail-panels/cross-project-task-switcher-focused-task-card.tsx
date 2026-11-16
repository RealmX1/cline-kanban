import type { CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { TaskCardBody } from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { buildTaskCardBusinessProps } from "@/components/task-card-business-props";
import { ColumnIndicator } from "@/components/ui/column-indicator";
import { resolveBoardColumnTitle } from "@/data/board-data";
import type { RuntimeAgentId } from "@/runtime/types";
import type { CardSelection } from "@/types";

/** 分组外保底卡使用实时完整卡体；组内 Sticky 复用列表行。 */
export function CrossProjectTaskSwitcherFocusedTaskCard({
	selection,
	projectName,
	currentProjectTaskCards,
	defaultAgentId,
}: {
	selection: CardSelection | null;
	projectName: string;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId: RuntimeAgentId | null;
}) {
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
			</div>
			<div className="min-w-0 px-0.5 pb-1.5">
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
