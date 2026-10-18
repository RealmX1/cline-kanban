import type { TaskCardBusinessProps } from "@/components/task-card-body";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId } from "@/types";
import type { TaskCardMoveIntoDoneRequestHandler } from "@/types/task-card-move-into-done-request";

/**
 * 「一张任务卡在某个 stage 里有哪些动作可用」的**唯一判定点**。
 *
 * 这条规则原本在 `kanban-board.tsx` 与 `column-context-panel.tsx` 各写了一份；Task Pinboard
 * 又要在两个置顶板容器里渲染同样的卡，四份重复必然漂移——而「分身和原卡完全相同」正是置顶板的核心承诺。
 * 所以把 stage 门控收敛到这里，四个渲染点共用，一致性靠机制而不靠各处自觉抄对。
 *
 * 门控是**幂等**的：调用方传进来的 handler 即使已经按列筛过一遍（`BoardColumn` 收到的就是这种），
 * 再筛一次结果不变，因此接入现有渲染点不需要先改它们的 props 形态。
 */

/** 未按 stage 筛过的完整动作集合（含各动作的 in-flight 表）。 */
export interface TaskCardActionHandlerBundle {
	onStartTask?: (taskId: string) => void;
	onMoveToTrashTask?: TaskCardMoveIntoDoneRequestHandler;
	onMoveToValidationTask?: (taskId: string) => void;
	onMoveToReviewTask?: (taskId: string) => void;
	onRestoreFromTrashTask?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onCancelAutomaticTaskAction?: (taskId: string) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	/** 打开任务编辑弹窗（仅 backlog 卡有此入口，单击也走它）。 */
	onEditTask?: (card: BoardCard) => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	resolveTaskWorkspaceAbsoluteDirectoryPath?: TaskCardBusinessProps["resolveTaskWorkspaceAbsoluteDirectoryPath"];
	moveToTrashLoadingById?: Record<string, boolean>;
	moveToValidationLoadingById?: Record<string, boolean>;
	moveToReviewLoadingById?: Record<string, boolean>;
}

export interface BuildTaskCardBusinessPropsInput {
	card: BoardCard;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	selected?: boolean;
	handlers: TaskCardActionHandlerBundle;
	/** 非 backlog 卡的单击行为（打开详情）。backlog 卡的单击固定走 `onEditTask`。 */
	onActivateCard?: (card: BoardCard) => void;
	workspacePath?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}

export function buildTaskCardBusinessProps({
	card,
	columnId,
	sessionSummary,
	selected = false,
	handlers,
	onActivateCard,
	workspacePath,
	defaultClineModelId = null,
	defaultAgentId = null,
}: BuildTaskCardBusinessPropsInput): TaskCardBusinessProps {
	const isBacklog = columnId === "backlog";
	const isInProgress = columnId === "in_progress";
	const isReview = columnId === "review";
	const isValidation = columnId === "validation";
	const isTrash = columnId === "trash";
	// review / validation 两列都能直接归档进 Done。
	const isArchivableIntoDone = isReview || isValidation;

	return {
		card,
		columnId,
		sessionSummary,
		selected,
		// backlog 与 in_progress 两列可启动；「in_progress 且已有活会话时不显示启动按钮」由卡体自己再判一层。
		onStart: isBacklog || isInProgress ? handlers.onStartTask : undefined,
		onMoveToTrash: isArchivableIntoDone ? handlers.onMoveToTrashTask : undefined,
		onMoveToValidation: isReview ? handlers.onMoveToValidationTask : undefined,
		// 手动把 In Progress 卡翻入 Review：卡死/空闲会话拖不进 Review 时的兜底入口。
		onMoveToReview: isInProgress ? handlers.onMoveToReviewTask : undefined,
		onRestoreFromTrash: isTrash ? handlers.onRestoreFromTrashTask : undefined,
		onDeleteTask: handlers.onDeleteTask,
		onCancelAutomaticAction: handlers.onCancelAutomaticTaskAction,
		onSaveTitle: handlers.onSaveTitle,
		onOpenTaskEditor: isBacklog ? handlers.onEditTask : undefined,
		onRequestPinToTaskPinboard: handlers.onRequestPinToTaskPinboard,
		onUnpinFromTaskPinboard: handlers.onUnpinFromTaskPinboard,
		isMoveToTrashLoading: isArchivableIntoDone ? (handlers.moveToTrashLoadingById?.[card.id] ?? false) : false,
		isMoveToValidationLoading: isReview ? (handlers.moveToValidationLoadingById?.[card.id] ?? false) : false,
		isMoveToReviewLoading: isInProgress ? (handlers.moveToReviewLoadingById?.[card.id] ?? false) : false,
		workspacePath,
		resolveTaskWorkspaceAbsoluteDirectoryPath: handlers.resolveTaskWorkspaceAbsoluteDirectoryPath,
		defaultClineModelId,
		defaultAgentId,
		onClick: isBacklog ? handlers.onEditTask : onActivateCard,
	};
}
