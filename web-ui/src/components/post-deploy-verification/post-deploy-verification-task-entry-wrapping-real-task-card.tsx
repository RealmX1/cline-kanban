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
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

// PDV 面板的一个任务条目：上半部分**直接渲染真实的任务卡体**（TaskCardBody，紧凑密度、角色
// task_card_copy_in_post_deploy_verification_panel_entry），任务信息与动作和看板上那张卡逐字一致；
// 下半部分才是 Validation 专有的东西（见 post-deploy-verification-task-entry-checklist-and-closure-section.tsx）。
// 条目 DOM 身份（`verification-panel-task:<taskId>` 引导定位锚点）挂在本 wrapper 上，卡体副本不输出 data-task-id。

/**
 * 渲染真实卡体所需的当前项目数据与看板动作：App 用看板同一份 displayedBoard、推流 session summaries 与同一组
 * handler 组装（与 Focus View 的 column-context-panel 同一套），于是条目上的「移入 Done」等按钮同样经过 PDV 门禁。
 */
export interface RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries {
	currentProjectDisplayedBoard: BoardData;
	currentProjectTaskSessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectTaskCardActionHandlers: TaskCardActionHandlerBundle;
	currentProjectWorkspacePath: string | null;
	onActivateTaskCardOpeningTaskDetail: (card: BoardCard) => void;
	defaultAgentId: RuntimeAgentId | null;
	defaultClineModelId: string | null;
}

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
	onRequestComplete: () => void;
	onSelectTask: () => void;
	// 「定位并核对」中 anchor.view==="board" 时导航回看板。
	onNavigateToBoard: () => void;
}

// spotlight 需在导航切换视图后目标元素挂载完成才生效；视图切换是异步渲染，故延后一帧再定位。
const SPOTLIGHT_AFTER_NAVIGATION_DELAY_MS = 80;

function PostDeployVerificationTaskEntryRealTaskCardOrRemovedFallback({
	taskId,
	board,
	realTaskCardRenderingInputs,
	onSelectTask,
}: {
	taskId: string;
	board: BoardData;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
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
	return (
		<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
			<TaskCardBody
				renderRole="task_card_copy_in_post_deploy_verification_panel_entry"
				{...buildTaskCardBusinessProps({
					card: selection.card,
					columnId: selection.column.id,
					sessionSummary: realTaskCardRenderingInputs.currentProjectTaskSessions[taskId],
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
	onSelectTask,
	onNavigateToBoard,
}: PostDeployVerificationTaskEntryWrappingRealTaskCardProps): ReactElement {
	const currentBoardColumnIdOfTaskCard = findCardSelection(board, task.taskId)?.column.id ?? null;

	// 「定位并核对」：按 anchor.view 导航（task_detail=本任务详情 / board=看板），随后 spotlight 目标元素。
	// 降级：无 anchor 时把面板内本条目滚入视野并高亮（至少让用户知道核对哪个任务）。
	const locateChecklistItem = (item: RuntimePostDeployVerificationChecklistItem): void => {
		const anchor = item.guidance?.anchor ?? null;
		if (anchor?.view === "task_detail") {
			onSelectTask();
		} else if (anchor?.view === "board") {
			onNavigateToBoard();
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
				onRequestComplete={onRequestComplete}
				onLocateChecklistItem={locateChecklistItem}
			/>
		</div>
	);
}
