import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import type { ReactElement } from "react";

import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { Spinner } from "@/components/ui/spinner";
import type { TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import { useTaskCardSnapshotOfOtherProjectForCrossProjectTaskSwitcherRowExpansion } from "@/hooks/use-task-card-snapshot-of-other-project-for-cross-project-task-switcher-row-expansion";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import { useTaskCardActionCommandKindInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardCard, BoardData } from "@/types";

/**
 * 当前项目的卡在浏览器里已有完整数据（带 overlay 的 board、推流的 session summary）与 Focus View 同一套动作；
 * 展开行直接用它们，与 This project 里那张卡逐字一致。
 */
export interface CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion {
	currentProjectDisplayedBoard: BoardData;
	currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectTaskCardActionHandlers: TaskCardActionHandlerBundle;
	currentProjectWorkspacePath: string | null;
}

function ExpandedTaskCardUnavailableNotice({ children }: { children: string }): ReactElement {
	return <div className="px-2 py-1.5 text-xs text-text-tertiary">{children}</div>;
}

function CurrentProjectExpandedTaskCard({
	workspaceId,
	taskId,
	currentProjectTaskCards,
	defaultAgentId,
	onActivateTaskCard,
}: {
	workspaceId: string;
	taskId: string;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion;
	defaultAgentId: RuntimeAgentId | null;
	onActivateTaskCard: (card: BoardCard) => void;
}): ReactElement {
	const selection = findCardSelection(currentProjectTaskCards.currentProjectDisplayedBoard, taskId);
	if (!selection) {
		return (
			<ExpandedTaskCardUnavailableNotice>This task is no longer on the board.</ExpandedTaskCardUnavailableNotice>
		);
	}
	return (
		<TaskCardBody
			taskCardWorkspaceIdForCrossProjectGitMetadataPolling={workspaceId}
			{...buildTaskCardBusinessProps({
				card: selection.card,
				columnId: selection.column.id,
				sessionSummary: currentProjectTaskCards.currentProjectTaskSessions[taskId],
				handlers: currentProjectTaskCards.currentProjectTaskCardActionHandlers,
				onActivateCard: onActivateTaskCard,
				workspacePath: currentProjectTaskCards.currentProjectWorkspacePath,
				defaultAgentId,
			})}
			renderRole="expanded_card_copy_in_cross_project_task_switcher_row"
		/>
	);
}

function OtherProjectExpandedTaskCard({
	entryInProject,
	otherProjectWorkspacePath,
	defaultAgentId,
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard,
	onActivateTaskCard,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	otherProjectWorkspacePath: string | null;
	defaultAgentId: RuntimeAgentId | null;
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard: TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher["buildTaskCardActionHandlerBundleForOtherProjectTaskCard"];
	onActivateTaskCard: (card: BoardCard) => void;
}): ReactElement {
	const { workspaceId, entry } = entryInProject;
	const loadState = useTaskCardSnapshotOfOtherProjectForCrossProjectTaskSwitcherRowExpansion({
		workspaceId,
		taskId: entry.taskId,
		isRowExpanded: true,
		// 条目任何字段变了（列、标题、会话进展、置顶）都说明卡或会话变了，去抖后重读。
		entryRefreshKey: JSON.stringify(entry),
	});
	const taskCardActionCommandKindInFlight = useTaskCardActionCommandKindInFlight(workspaceId, entry.taskId);
	switch (loadState.otherProjectTaskCardSnapshotLoadStatus) {
		case "loading":
			return (
				<div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-text-tertiary">
					<Spinner size={12} />
					Loading task…
				</div>
			);
		case "task_card_not_found":
			return (
				<ExpandedTaskCardUnavailableNotice>This task is no longer on its board.</ExpandedTaskCardUnavailableNotice>
			);
		case "failed":
			return (
				<ExpandedTaskCardUnavailableNotice>{`Could not load the task: ${loadState.failureMessage}`}</ExpandedTaskCardUnavailableNotice>
			);
		case "loaded": {
			const { taskCardSnapshot } = loadState;
			const taskCard = taskCardSnapshot.taskCard;
			return (
				<TaskCardBody
					{...buildTaskCardBusinessProps({
						card: taskCard,
						columnId: taskCardSnapshot.boardColumnIdContainingTaskCard,
						sessionSummary:
							taskCardSnapshot.taskSessionSummaryLiveInRuntimeProcessMemory ??
							taskCardSnapshot.taskSessionSummaryPersistedInWorkspaceSessionsFile ??
							undefined,
						handlers: buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
							workspaceId,
							taskCard,
							boardColumnIdContainingTaskCard: taskCardSnapshot.boardColumnIdContainingTaskCard,
							taskCardActionCommandKindInFlight,
						}),
						onActivateCard: onActivateTaskCard,
						workspacePath: otherProjectWorkspacePath,
						defaultAgentId,
					})}
					renderRole="expanded_card_copy_in_cross_project_task_switcher_row"
					taskCardOwnedByOtherProjectWorkspaceId={workspaceId}
				/>
			);
		}
	}
}

/**
 * All projects 面板里一行的完整卡片（hover 浮层里、或用户点了「Keep open」后原地替换精简行）：与 This project
 * 同一个紧凑 `TaskCardBody`、同一套 stage 门控（buildTaskCardBusinessProps）与同一组服务端卡片动作。
 * 当前项目读浏览器里的 board；其他项目按需读服务端。
 */
export function CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard({
	entryInProject,
	currentProjectId,
	currentProjectTaskCards,
	otherProjectWorkspacePath,
	defaultAgentId,
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard,
	onActivateTaskCard,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	currentProjectId: string | null;
	// 没有（跨项目打开在途的过渡外壳里）时当前项目的行也按其他项目处理：读服务端、不带 overlay。
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	otherProjectWorkspacePath: string | null;
	defaultAgentId: RuntimeAgentId | null;
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard: TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher["buildTaskCardActionHandlerBundleForOtherProjectTaskCard"];
	onActivateTaskCard: (card: BoardCard) => void;
}): ReactElement {
	return (
		<div className="min-w-0" data-testid="cross-project-task-switcher-full-task-card">
			{entryInProject.workspaceId === currentProjectId && currentProjectTaskCards ? (
				<CurrentProjectExpandedTaskCard
					workspaceId={entryInProject.workspaceId}
					taskId={entryInProject.entry.taskId}
					currentProjectTaskCards={currentProjectTaskCards}
					defaultAgentId={defaultAgentId}
					onActivateTaskCard={onActivateTaskCard}
				/>
			) : (
				<OtherProjectExpandedTaskCard
					entryInProject={entryInProject}
					otherProjectWorkspacePath={otherProjectWorkspacePath}
					defaultAgentId={defaultAgentId}
					buildTaskCardActionHandlerBundleForOtherProjectTaskCard={
						buildTaskCardActionHandlerBundleForOtherProjectTaskCard
					}
					onActivateTaskCard={onActivateTaskCard}
				/>
			)}
		</div>
	);
}
