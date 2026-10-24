import type { ReactElement } from "react";

import { resolveTaskTitleForPostDeployVerificationPanel } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import { PostDeployVerificationTaskEntryChecklistAndClosureSection } from "@/components/post-deploy-verification/post-deploy-verification-task-entry-checklist-and-closure-section";
import {
	spotlightAnchor,
	VERIFICATION_ANCHOR_ATTR,
	verificationPanelTaskAnchorKey,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import { TaskCardBody } from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { buildTaskCardBusinessProps, type TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import type {
	RuntimeAgentId,
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { fetchTaskWorkspaceInfoForWorkspace } from "@/runtime/workspace-state-query";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";
import type { TaskCardMoveIntoDoneRequestHandler } from "@/types/task-card-move-into-done-request";

// PDV 面板的一个任务条目：上半部分**直接渲染真实的任务卡体**（TaskCardBody，紧凑密度、角色
// task_card_copy_in_post_deploy_verification_panel_entry），任务信息与动作和看板上那张卡逐字一致；
// 下半部分才是 Validation 专有的东西（见 post-deploy-verification-task-entry-checklist-and-closure-section.tsx）。
// 条目 DOM 身份（`verification-panel-task:<taskId>` 引导定位锚点）挂在本 wrapper 上，卡体副本不输出 data-task-id。

/**
 * 渲染真实卡体所需的数据与动作，按面板读的 board 分两路（见
 * post-deploy-verification-workspace-and-panel-task-card-board-source-for-board-or-single-project-scope.ts）：
 *   - current_project_board_hydrated_in_browser：App 用看板同一份推流 session summaries 与同一组 handler 组装（与 Focus View
 *     的 column-context-panel 同一套），于是条目上的「移入 Done」等按钮同样经过 PDV 门禁；
 *   - runtime_board_snapshot_of_workspace_not_hydrated_in_browser：PDV workspace 的 board 不在浏览器里（All projects 视图），
 *     卡体只做展示——Done 按钮走条目自己的完成核对（同一个原因对话框），点卡或卡上其余按列画出的动作按钮
 *     （Start / Move to validation / Move to review / Restore）都在它所属的项目里打开该任务，动作到那边再用。
 *     不叫 "otherProject"：跨项目打开的过渡窗口里，快照的 workspace 可能正是 currentProjectId。
 */
export type RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries =
	| {
			realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser";
			currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
			currentProjectTaskCardActionHandlers: TaskCardActionHandlerBundle;
			currentProjectWorkspacePath: string | null;
			onActivateTaskCardOpeningTaskDetail: (card: BoardCard) => void;
			defaultAgentId: RuntimeAgentId | null;
			defaultClineModelId: string | null;
	  }
	| {
			realTaskCardRenderingInputsBoardSourceKind: "runtime_board_snapshot_of_workspace_not_hydrated_in_browser";
			workspaceIdOwningRuntimeBoardSnapshot: string;
			taskSessionsFromRuntimeBoardSnapshot: Record<string, RuntimeTaskSessionSummary>;
			workspacePathOwningRuntimeBoardSnapshot: string | null;
			onActivateTaskCardOpeningTaskInItsProject: (card: BoardCard) => void;
			defaultAgentId: RuntimeAgentId | null;
			defaultClineModelId: string | null;
	  };

export interface PostDeployVerificationTaskEntryWrappingRealTaskCardProps {
	postDeployVerificationTask: RuntimePostDeployVerificationTask;
	board: BoardData;
	// null = 宿主没给（隔离的浏览器 fixture）：上半部分退回标题行。
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	retainedDeploymentGroupsByDeploymentId: ReadonlyMap<string, RuntimePostDeployVerificationDeploymentGroup>;
	interactive: boolean;
	checklistInitiallyExpanded: boolean;
	isCompleting: boolean;
	onToggleChecklistItem: (itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (label: string) => void;
	onRemoveCustomChecklistItem: (itemId: string) => void;
	onRunVerificationItem: (itemId: string) => void;
	onRequestComplete: (options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => void;
	onRequestMoveIntoDoneFromTaskCard?: (options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => void;
	completionActionRendering?: "post_deploy_verification_panel" | "review_before_move_into_done";
	onRequestGuidedManualVerification?: (
		item: RuntimePostDeployVerificationChecklistItem,
		locate: () => void | Promise<void>,
	) => void;
	onSelectTask: () => void;
	// 「定位并核对」中 anchor.view==="board" 时导航回看板。
	onNavigateToBoard: () => void | Promise<void>;
	onCreateFollowUpTaskFromSelectedChecklistItems?: (selectedChecklistItemIds: string[]) => void;
}

// spotlight 需在导航切换视图后目标元素挂载完成才生效；视图切换是异步渲染，故延后一帧再定位。
const SPOTLIGHT_AFTER_NAVIGATION_DELAY_MS = 80;

// 快照模式卡体的动作：只给 Done（= 条目自己的完成核对）与「在所属项目打开」，其余动作点开任务后在那个项目里用。
// TaskCardBody 有几颗按钮只按列渲染、不看 handler 在不在（Done：review / validation；Start：backlog；
// Move to validation：review；Move to review：in_progress 且是终端 agent 会话；Restore：trash），不给 handler 就是
// 「画出来了、点了没反应」。所以这几颗一律接上：Done 在条目可交互时走完成核对，其余（含不可交互历史组的 Done）
// 都改为在所属项目打开任务，到那边再做。其他按钮（改标题、置顶、Delete、取消自动动作）按 handler 门控，这里不给就不画。
// 接上 onStartTask 后 in_progress 卡在「从没起过会话」时也会画出 Retry 按钮，与看板上那张卡一致，点了同样去所属项目。
function buildTaskCardActionHandlersForRuntimeBoardSnapshotTaskCardCopy(input: {
	card: BoardCard;
	workspaceIdOwningRuntimeBoardSnapshot: string;
	interactive: boolean;
	isCompleting: boolean;
	onRequestComplete: (options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => void;
	onActivateTaskCardOpeningTaskInItsProject: (card: BoardCard) => void;
}): TaskCardActionHandlerBundle {
	const openTaskCardInItsProjectToUseColumnActionThere = (): void =>
		input.onActivateTaskCardOpeningTaskInItsProject(input.card);
	return {
		resolveTaskWorkspaceAbsoluteDirectoryPath: async (card) =>
			(
				await fetchTaskWorkspaceInfoForWorkspace(input.workspaceIdOwningRuntimeBoardSnapshot, {
					taskId: card.id,
					baseRef: card.baseRef,
					worktreeMode: card.worktreeMode,
				})
			).path,
		onMoveToTrashTask: input.interactive
			? (_taskId, options) => input.onRequestComplete(options)
			: openTaskCardInItsProjectToUseColumnActionThere,
		moveToTrashLoadingById: { [input.card.id]: input.isCompleting },
		onStartTask: openTaskCardInItsProjectToUseColumnActionThere,
		onMoveToValidationTask: openTaskCardInItsProjectToUseColumnActionThere,
		onMoveToReviewTask: openTaskCardInItsProjectToUseColumnActionThere,
		onRestoreFromTrashTask: openTaskCardInItsProjectToUseColumnActionThere,
		onEditTask: input.onActivateTaskCardOpeningTaskInItsProject,
	};
}

function PostDeployVerificationTaskEntryRealTaskCardOrRemovedFallback({
	taskId,
	board,
	realTaskCardRenderingInputs,
	interactive,
	isCompleting,
	onRequestComplete,
	onSelectTask,
}: {
	taskId: string;
	board: BoardData;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	interactive: boolean;
	isCompleting: boolean;
	onRequestComplete: (options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1]) => void;
	onSelectTask: () => void;
}): ReactElement {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return (
			<div
				data-post-deploy-verification-task-entry-card-removed-from-board=""
				className="flex items-baseline gap-2 px-2 py-1.5"
			>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-secondary">
					{resolveTaskTitleForPostDeployVerificationPanel(board, taskId)}
				</span>
				<span className="shrink-0 text-[11px] italic text-text-tertiary">已从看板删除</span>
			</div>
		);
	}
	if (!realTaskCardRenderingInputs) {
		const taskTitle = resolveTaskTitleForPostDeployVerificationPanel(board, taskId);
		return (
			<button
				type="button"
				onClick={onSelectTask}
				title={taskTitle}
				className="block w-full min-w-0 cursor-pointer truncate px-2 py-1.5 text-left text-[13px] font-medium text-text-primary hover:text-accent-hover"
			>
				{taskTitle}
			</button>
		);
	}
	if (
		realTaskCardRenderingInputs.realTaskCardRenderingInputsBoardSourceKind ===
		"runtime_board_snapshot_of_workspace_not_hydrated_in_browser"
	) {
		return (
			<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
				<TaskCardBody
					renderRole="task_card_copy_in_post_deploy_verification_panel_entry"
					taskCardOwnedByOtherProjectWorkspaceId={
						realTaskCardRenderingInputs.workspaceIdOwningRuntimeBoardSnapshot
					}
					{...buildTaskCardBusinessProps({
						card: selection.card,
						columnId: selection.column.id,
						taskSessions: realTaskCardRenderingInputs.taskSessionsFromRuntimeBoardSnapshot,
						handlers: buildTaskCardActionHandlersForRuntimeBoardSnapshotTaskCardCopy({
							card: selection.card,
							workspaceIdOwningRuntimeBoardSnapshot:
								realTaskCardRenderingInputs.workspaceIdOwningRuntimeBoardSnapshot,
							interactive,
							isCompleting,
							onRequestComplete,
							onActivateTaskCardOpeningTaskInItsProject:
								realTaskCardRenderingInputs.onActivateTaskCardOpeningTaskInItsProject,
						}),
						onActivateCard: realTaskCardRenderingInputs.onActivateTaskCardOpeningTaskInItsProject,
						workspacePath: realTaskCardRenderingInputs.workspacePathOwningRuntimeBoardSnapshot,
						defaultAgentId: realTaskCardRenderingInputs.defaultAgentId,
						defaultClineModelId: realTaskCardRenderingInputs.defaultClineModelId,
					})}
				/>
			</TaskCardBodyVisualDensityProvider>
		);
	}
	return (
		<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
			<TaskCardBody
				renderRole="task_card_copy_in_post_deploy_verification_panel_entry"
				{...buildTaskCardBusinessProps({
					card: selection.card,
					columnId: selection.column.id,
					taskSessions: realTaskCardRenderingInputs.currentProjectTaskSessions,
					handlers: realTaskCardRenderingInputs.currentProjectTaskCardActionHandlers,
					onActivateCard: realTaskCardRenderingInputs.onActivateTaskCardOpeningTaskDetail,
					workspacePath: realTaskCardRenderingInputs.currentProjectWorkspacePath,
					defaultAgentId: realTaskCardRenderingInputs.defaultAgentId,
					defaultClineModelId: realTaskCardRenderingInputs.defaultClineModelId,
				})}
			/>
		</TaskCardBodyVisualDensityProvider>
	);
}

export function PostDeployVerificationTaskEntryWrappingRealTaskCard({
	postDeployVerificationTask: task,
	board,
	realTaskCardRenderingInputs,
	retainedDeploymentGroupsByDeploymentId,
	interactive,
	checklistInitiallyExpanded,
	isCompleting,
	onToggleChecklistItem,
	onAddCustomChecklistItem,
	onRemoveCustomChecklistItem,
	onRunVerificationItem,
	onRequestComplete,
	onRequestMoveIntoDoneFromTaskCard,
	completionActionRendering,
	onRequestGuidedManualVerification,
	onSelectTask,
	onNavigateToBoard,
	onCreateFollowUpTaskFromSelectedChecklistItems,
}: PostDeployVerificationTaskEntryWrappingRealTaskCardProps): ReactElement {
	const currentBoardColumnIdOfTaskCard = findCardSelection(board, task.taskId)?.column.id ?? null;

	// 「定位并核对」：按 anchor.view 导航（task_detail=本任务详情 / board=看板），随后 spotlight 目标元素。
	// 降级：无 anchor 时把面板内本条目滚入视野并高亮（至少让用户知道核对哪个任务）。
	const locateChecklistItem = async (item: RuntimePostDeployVerificationChecklistItem): Promise<void> => {
		const anchor = item.guidance?.anchor ?? null;
		if (anchor?.view === "task_detail") {
			onSelectTask();
		} else if (anchor?.view === "board") {
			await onNavigateToBoard();
		}
		const anchorKey = anchor?.anchorKey ?? verificationPanelTaskAnchorKey(task.taskId);
		window.setTimeout(() => spotlightAnchor(anchorKey), SPOTLIGHT_AFTER_NAVIGATION_DELAY_MS);
	};

	return (
		<div
			data-post-deploy-verification-task-entry={task.taskId}
			className="rounded-md border border-border bg-surface-1"
			{...{ [VERIFICATION_ANCHOR_ATTR]: verificationPanelTaskAnchorKey(task.taskId) }}
		>
			<PostDeployVerificationTaskEntryRealTaskCardOrRemovedFallback
				taskId={task.taskId}
				board={board}
				realTaskCardRenderingInputs={realTaskCardRenderingInputs}
				interactive={interactive}
				isCompleting={isCompleting}
				onRequestComplete={onRequestMoveIntoDoneFromTaskCard ?? onRequestComplete}
				onSelectTask={onSelectTask}
			/>
			<PostDeployVerificationTaskEntryChecklistAndClosureSection
				postDeployVerificationTask={task}
				currentBoardColumnIdOfTaskCard={currentBoardColumnIdOfTaskCard}
				retainedDeploymentGroupsByDeploymentId={retainedDeploymentGroupsByDeploymentId}
				interactive={interactive}
				checklistInitiallyExpanded={checklistInitiallyExpanded}
				isCompleting={isCompleting}
				onToggleChecklistItem={onToggleChecklistItem}
				onAddCustomChecklistItem={onAddCustomChecklistItem}
				onRemoveCustomChecklistItem={onRemoveCustomChecklistItem}
				onRunVerificationItem={onRunVerificationItem}
				onRequestComplete={() => onRequestComplete()}
				completionActionRendering={completionActionRendering}
				onRequestGuidedManualVerification={onRequestGuidedManualVerification}
				onLocateChecklistItem={locateChecklistItem}
				onCreateFollowUpTaskFromSelectedChecklistItems={onCreateFollowUpTaskFromSelectedChecklistItems}
			/>
		</div>
	);
}
