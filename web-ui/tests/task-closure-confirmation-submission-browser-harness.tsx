import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SkipValidationConfirmDialog } from "../src/components/skip-validation-confirm-dialog";
import { TaskCommentBeforeMoveIntoDoneDialog } from "../src/components/task-comment-before-move-into-done-dialog";
import { createInitialBoardData } from "../src/data/board-data";
import { useBoardInteractions } from "../src/hooks/use-board-interactions";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "../src/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const sourceColumnId =
	new URLSearchParams(location.search).get("sourceColumn") === "in_progress" ? "in_progress" : "review";
const card: BoardCard = {
	id: "closure-confirmation-fixture",
	title: "隔离结案确认回归任务",
	prompt: "验证提交期间隐藏表单，失败保留草稿。",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 1,
	updatedAt: 1,
};
const fetchTaskWorkspaceInfo = async () => null;
const sendTaskInput = async () => ({ ok: true });
const runAutoReviewGitAction = async () => false;
const taskGitActionLoadingByTaskId = {};

function CurrentProjectClosureHarness() {
	const [board, setBoard] = useState(() => {
		const initialBoard = createInitialBoardData();
		initialBoard.columns.find((column) => column.id === sourceColumnId)!.cards = [card];
		return initialBoard;
	});
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const [, setIsGitHistoryOpen] = useState(false);
	const actions = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard: null,
		selectedTaskId,
		setSelectedTaskId,
		currentProjectId: "isolated-current-project",
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		fetchTaskWorkspaceInfo,
		sendTaskSessionInput: sendTaskInput,
		sendTaskChatMessage: sendTaskInput,
		readyForReviewNotificationsEnabled: false,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});
	return (
		<>
			<button type="button" onClick={() => actions.handleMoveReviewCardToTrash(card.id)}>
				打开结案表单
			</button>
			<TaskCommentBeforeMoveIntoDoneDialog
				controller={actions.taskCommentBeforeMoveIntoDone}
				onSubmit={actions.confirmTaskCommentBeforeMoveIntoDone}
			/>
			<SkipValidationConfirmDialog
				open={actions.isMoveToDoneConfirmOpen}
				onCancel={actions.cancelMoveToDone}
				onConfirm={actions.confirmMoveToDone}
			/>
		</>
	);
}

function OtherProjectClosureHarness() {
	const actions = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({});
	const handlers = actions.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
		workspaceId: "isolated-other-project",
		taskCard: card,
		boardColumnIdContainingTaskCard: sourceColumnId,
		taskCardActionCommandKindInFlight: null,
	});
	return (
		<>
			<button type="button" onClick={() => handlers.onMoveToTrashTask?.(card.id)}>
				打开结案表单
			</button>
			{actions.otherProjectTaskCardActionConfirmationDialogs}
		</>
	);
}

const mountElement = document.createElement("div");
document.body.append(mountElement);
createRoot(mountElement).render(
	new URLSearchParams(location.search).get("entry") === "other-project" ? (
		<OtherProjectClosureHarness />
	) : (
		<CurrentProjectClosureHarness />
	),
);
