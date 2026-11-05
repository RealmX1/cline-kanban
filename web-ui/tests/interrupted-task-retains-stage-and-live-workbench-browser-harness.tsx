import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useBoardInteractions } from "../src/hooks/use-board-interactions";
import { LayoutCustomizationsProvider } from "../src/resize/layout-customizations";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

const workspaceId = "isolated-interrupted-task-workspace";
const card: BoardCard = {
	id: "interrupted-task",
	title: "中断任务保留原工作树",
	prompt: "原任务需求",
	agentId: "codex",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 2,
};
const interruptedSummary: RuntimeTaskSessionSummary = {
	taskId: card.id,
	agentId: "codex",
	state: "interrupted",
	turnOwner: "user",
	liveness: "interrupted",
	userTurnKind: "interrupted",
	workspacePath: "/isolated/original-task-worktree",
	pid: null,
	startedAt: 1,
	updatedAt: 2,
	lastOutputAt: 2,
	reviewReason: "interrupted",
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
};
const fetchTaskWorkspaceInfo = async () => null;
const sendTaskInput = async () => ({ ok: true });
const runAutoReviewGitAction = async () => false;
const taskGitActionLoadingByTaskId = {};

function Harness() {
	const [board, setBoard] = useState(() => {
		const initial = createInitialBoardData();
		const columnId = new URLSearchParams(location.search).has("closed") ? "trash" : "in_progress";
		initial.columns.find((column) => column.id === columnId)!.cards = [card];
		return initial;
	});
	const [sessions, setSessions] = useState({ [card.id]: interruptedSummary });
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const [, setIsGitHistoryOpen] = useState(false);
	const column = board.columns.find((entry) => entry.cards.some((entryCard) => entryCard.id === card.id))!;
	const selection: CardSelection | null = selectedTaskId ? { card, column, allColumns: board.columns } : null;
	useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard: selection,
		selectedTaskId,
		setSelectedTaskId,
		currentProjectId: workspaceId,
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
		<main className="min-h-dvh bg-surface-0 p-4 text-text-primary">
			<output aria-label="任务实际所在列">{column.id}</output>
			{selection ? (
				<CardDetailView
					selection={selection}
					currentProjectId={workspaceId}
					workspacePath="/isolated/main-repository"
					selectedAgentId="codex"
					sessionSummary={sessions[card.id]}
					taskSessions={sessions}
					taskIdsOnBoard={new Set([card.id])}
					onSessionSummary={() => {}}
					onCardSelect={setSelectedTaskId}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>
			) : (
				<div className="mt-20 max-w-lg">
					<section aria-label="主看板卡片">
						<TaskCardBody
							card={card}
							columnId={column.id}
							sessionSummary={sessions[card.id]}
							onClick={() => setSelectedTaskId(card.id)}
						/>
					</section>
					<section aria-label="Focus View 卡片">
						<TaskCardBody
							card={card}
							columnId={column.id}
							sessionSummary={sessions[card.id]}
							renderRole="focused_card_copy_under_sticky_stage_header"
							onClick={() => setSelectedTaskId(card.id)}
						/>
					</section>
				</div>
			)}
		</main>
	);
}
createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider>
		<LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}>
			<TaskCommentsDialogProvider currentWorkspaceId={workspaceId}>
				<Harness />
			</TaskCommentsDialogProvider>
		</LayoutCustomizationsProvider>
	</TooltipProvider>,
);
