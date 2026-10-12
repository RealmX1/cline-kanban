import type {
	CrossProjectTaskSwitcherEntryInProject,
	CrossProjectTaskSwitcherPromptCacheWarmthEstimate,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import type { ReactElement, ReactNode } from "react";

import {
	type CrossProjectTaskSwitcherFullTaskCardInListExpansionState,
	CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-full-task-card-in-list-expansion-toggle-button";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import {
	CrossProjectTaskSwitcherRowFirstLine,
	CrossProjectTaskSwitcherRowLeadingActivityIndicator,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-first-line";
import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";
import {
	CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME,
	TaskCardBody,
	type TaskCardBodyCrossProjectTaskSwitcherRowElements,
} from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved } from "@/hooks/use-cross-project-task-switcher-row-in-list-expansion-toggle-keyboard-focus-handoff";
import type { TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import { useTaskCardSnapshotOfOtherProjectForCrossProjectTaskSwitcherRowExpansion } from "@/hooks/use-task-card-snapshot-of-other-project-for-cross-project-task-switcher-row-expansion";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import { useTaskCardActionCommandKindInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardData } from "@/types";

// hover 展开与固定展开的行共用的卡框几何：零内边距、无边框，描边用 ring（box-shadow，不占布局）。这样卡体的
// px-2 py-1.5 正好落在精简行 pl-2 py-1.5 的位置上，三态之间标题首行不动。颜色由行按形态给。
export const CROSS_PROJECT_TASK_SWITCHER_FULL_TASK_CARD_FRAME_GEOMETRY_CLASS_NAME = "rounded-md p-0 ring-1";

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

/**
 * 完整卡片所在的那一行：精简行上有、卡体本身没有的信息（并进卡体，见 TaskCardBodyCrossProjectTaskSwitcherRowElements），
 * 以及这一行的激活与展开开关。
 */
export interface CrossProjectTaskSwitcherFullTaskCardRowContext {
	section: CrossProjectTaskSwitcherTaskRowSection;
	isUnreadHandoff: boolean;
	// null = 只有一个项目，不显示项目名。
	projectName: string | null;
	promptCacheWarmthEstimate?: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
	nowMs: number;
	inListExpansionState: CrossProjectTaskSwitcherFullTaskCardInListExpansionState;
	onToggleInListExpansion: () => void;
	// hover 展开且指针还在这一行上：卡体第一帧就以 hover 态呈现（见 TaskCardBodyCrossProjectTaskSwitcherRowElements）。
	isPresentedAsHoveredFromFirstFrame: boolean;
	// 与点这一行的精简行同一个函数：卡体任何非按钮位置的单击都调它，不走卡体自己的列级单击语义。
	onActivateRow: () => void;
}

function buildTaskCardBodyCrossProjectTaskSwitcherRowElements(
	rowContext: CrossProjectTaskSwitcherFullTaskCardRowContext,
): TaskCardBodyCrossProjectTaskSwitcherRowElements {
	return {
		firstLineLeadingActivityIndicator: (
			<CrossProjectTaskSwitcherRowLeadingActivityIndicator
				section={rowContext.section}
				isUnreadHandoff={rowContext.isUnreadHandoff}
			/>
		),
		projectName: rowContext.projectName,
		promptCacheWarmthPill: rowContext.promptCacheWarmthEstimate ? (
			<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
				promptCacheWarmthEstimate={rowContext.promptCacheWarmthEstimate}
				nowMs={rowContext.nowMs}
			/>
		) : null,
		inListExpansionToggle: (
			<CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton
				expansionState={rowContext.inListExpansionState}
				onToggleInListExpansion={rowContext.onToggleInListExpansion}
			/>
		),
		isPresentedAsHoveredFromFirstFrame: rowContext.isPresentedAsHoveredFromFirstFrame,
	};
}

/**
 * 卡体还拿不到（其他项目的快照在读 / 读失败 / 卡已不在 board 上）时的兜底：先画与精简行同一个首行，提示放在下面，
 * 标题不整行消失；展开开关仍在右上角同一坐标；点它与点精简行同一结果。首行同时是「打开任务」的键盘入口
 * （Enter / Space），与卡体标题一致。快照到了换成卡体时，键盘焦点若在这里的开关上就交给卡体上的开关。
 */
function ExpandedTaskCardUnavailableFallback({
	entryInProject,
	rowContext,
	children,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	rowContext: CrossProjectTaskSwitcherFullTaskCardRowContext;
	children: ReactNode;
}): ReactElement {
	const fallbackElementRefHandingOffToggleKeyboardFocus =
		useCallbackRefHandingOffInListExpansionToggleKeyboardFocusWhenElementIsRemoved();
	return (
		<div
			ref={fallbackElementRefHandingOffToggleKeyboardFocus}
			data-cross-project-task-switcher-full-task-card-unavailable-fallback=""
			className="group/fallback relative cursor-pointer rounded-md px-2 py-1.5 hover:bg-surface-3"
			onClick={(event) => {
				if ((event.target as HTMLElement | null)?.closest("button")) {
					return;
				}
				rowContext.onActivateRow();
			}}
		>
			{/* 块级包一层不改首行几何；单击仍由外层统一处理（这一层不是 <button>，closest("button") 不拦）。 */}
			<div
				role="button"
				tabIndex={0}
				data-cross-project-task-switcher-full-task-card-unavailable-fallback-open-task-keyboard-entry=""
				className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						rowContext.onActivateRow();
					}
				}}
			>
				<CrossProjectTaskSwitcherRowFirstLine
					section={rowContext.section}
					isUnreadHandoff={rowContext.isUnreadHandoff}
					agentId={entryInProject.entry.agentId}
					title={entryInProject.entry.title}
				/>
			</div>
			<div className="mt-1 flex items-center gap-1.5 pl-[19px] text-xs text-text-tertiary">{children}</div>
			<div
				className={cn(
					"absolute right-1 z-30 flex items-center gap-0.5 rounded-md bg-surface-3 px-0.5 shadow-sm",
					CROSS_PROJECT_TASK_SWITCHER_ROW_HOVER_ACTION_GROUP_VERTICAL_POSITION_ABOVE_FIRST_LINE_CLASS_NAME,
				)}
			>
				<CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton
					expansionState={rowContext.inListExpansionState}
					onToggleInListExpansion={rowContext.onToggleInListExpansion}
				/>
			</div>
		</div>
	);
}

function CurrentProjectExpandedTaskCard({
	entryInProject,
	currentProjectTaskCards,
	defaultAgentId,
	rowContext,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion;
	defaultAgentId: RuntimeAgentId | null;
	rowContext: CrossProjectTaskSwitcherFullTaskCardRowContext;
}): ReactElement {
	const { workspaceId, entry } = entryInProject;
	const selection = findCardSelection(currentProjectTaskCards.currentProjectDisplayedBoard, entry.taskId);
	if (!selection) {
		return (
			<ExpandedTaskCardUnavailableFallback entryInProject={entryInProject} rowContext={rowContext}>
				This task is no longer on the board.
			</ExpandedTaskCardUnavailableFallback>
		);
	}
	return (
		<TaskCardBody
			taskCardWorkspaceIdForCrossProjectGitMetadataPolling={workspaceId}
			{...buildTaskCardBusinessProps({
				card: selection.card,
				columnId: selection.column.id,
				sessionSummary: currentProjectTaskCards.currentProjectTaskSessions[entry.taskId],
				handlers: currentProjectTaskCards.currentProjectTaskCardActionHandlers,
				onActivateCard: rowContext.onActivateRow,
				workspacePath: currentProjectTaskCards.currentProjectWorkspacePath,
				defaultAgentId,
			})}
			// 覆盖 buildTaskCardBusinessProps 的列级单击（backlog = 卡体自己的编辑框）：与点精简行同一结果。
			onClick={rowContext.onActivateRow}
			renderRole="expanded_card_copy_in_cross_project_task_switcher_row"
			crossProjectTaskSwitcherRowElementsMergedIntoCardCopy={buildTaskCardBodyCrossProjectTaskSwitcherRowElements(
				rowContext,
			)}
		/>
	);
}

function OtherProjectExpandedTaskCard({
	entryInProject,
	otherProjectWorkspacePath,
	defaultAgentId,
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard,
	rowContext,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	otherProjectWorkspacePath: string | null;
	defaultAgentId: RuntimeAgentId | null;
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard: TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher["buildTaskCardActionHandlerBundleForOtherProjectTaskCard"];
	rowContext: CrossProjectTaskSwitcherFullTaskCardRowContext;
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
				<ExpandedTaskCardUnavailableFallback entryInProject={entryInProject} rowContext={rowContext}>
					<Spinner size={12} />
					Loading task…
				</ExpandedTaskCardUnavailableFallback>
			);
		case "task_card_not_found":
			return (
				<ExpandedTaskCardUnavailableFallback entryInProject={entryInProject} rowContext={rowContext}>
					This task is no longer on its board.
				</ExpandedTaskCardUnavailableFallback>
			);
		case "failed":
			return (
				<ExpandedTaskCardUnavailableFallback entryInProject={entryInProject} rowContext={rowContext}>
					{`Could not load the task: ${loadState.failureMessage}`}
				</ExpandedTaskCardUnavailableFallback>
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
						onActivateCard: rowContext.onActivateRow,
						workspacePath: otherProjectWorkspacePath,
						defaultAgentId,
					})}
					// 覆盖 buildTaskCardBusinessProps 的列级单击（backlog = 卡体自己的编辑框）：与点精简行同一结果。
					onClick={rowContext.onActivateRow}
					renderRole="expanded_card_copy_in_cross_project_task_switcher_row"
					taskCardOwnedByOtherProjectWorkspaceId={workspaceId}
					crossProjectTaskSwitcherRowElementsMergedIntoCardCopy={buildTaskCardBodyCrossProjectTaskSwitcherRowElements(
						rowContext,
					)}
				/>
			);
		}
	}
}

/**
 * All projects 面板里一行的完整卡片（hover 或用户固定展开后原地替换精简行）：与 This project
 * 同一个紧凑 `TaskCardBody`、同一套 stage 门控（buildTaskCardBusinessProps）与同一组服务端卡片动作。
 * 当前项目读浏览器里的 board；其他项目按需读服务端。
 *
 * 自己提供紧凑密度：面板也挂在过渡外壳里（那里没有 Focus View 左栏的密度 provider），完整卡片必须恒为紧凑行，
 * 首行几何才与精简行对得上。
 */
export function CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard({
	entryInProject,
	currentProjectId,
	currentProjectTaskCards,
	otherProjectWorkspacePath,
	defaultAgentId,
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard,
	rowContext,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	currentProjectId: string | null;
	// 没有（跨项目打开在途的过渡外壳里）时当前项目的行也按其他项目处理：读服务端、不带 overlay。
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	otherProjectWorkspacePath: string | null;
	defaultAgentId: RuntimeAgentId | null;
	buildTaskCardActionHandlerBundleForOtherProjectTaskCard: TaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher["buildTaskCardActionHandlerBundleForOtherProjectTaskCard"];
	rowContext: CrossProjectTaskSwitcherFullTaskCardRowContext;
}): ReactElement {
	return (
		<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
			<div className="min-w-0" data-testid="cross-project-task-switcher-full-task-card">
				{entryInProject.workspaceId === currentProjectId && currentProjectTaskCards ? (
					<CurrentProjectExpandedTaskCard
						entryInProject={entryInProject}
						currentProjectTaskCards={currentProjectTaskCards}
						defaultAgentId={defaultAgentId}
						rowContext={rowContext}
					/>
				) : (
					<OtherProjectExpandedTaskCard
						entryInProject={entryInProject}
						otherProjectWorkspacePath={otherProjectWorkspacePath}
						defaultAgentId={defaultAgentId}
						buildTaskCardActionHandlerBundleForOtherProjectTaskCard={
							buildTaskCardActionHandlerBundleForOtherProjectTaskCard
						}
						rowContext={rowContext}
					/>
				)}
			</div>
		</TaskCardBodyVisualDensityProvider>
	);
}
