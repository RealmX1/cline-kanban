import type { DropResult } from "@hello-pangea/dnd";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { KanbanBoard } from "../src/components/kanban-board";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { applyDragResult, moveTaskToColumn } from "../src/state/board-state";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "../src/types";
import "../src/styles/globals.css";

const createdAt = Date.now() - 60_000;
const observedDrops: DropResult[] = [];
const initialBoard = createInitialBoardData();
for (const column of initialBoard.columns) {
	column.cards = Array.from(
		{ length: column.id === "in_progress" ? 24 : 2 },
		(_, index): BoardCard => ({
			id: `${column.id}-${index}`,
			title: `${column.title} 任务 ${index} · 手机紧凑列表`,
			prompt: "只在隔离浏览器中验证，不启动任务，不写入运行实例。",
			taskDescription: "完整任务简介与操作只在显式展开后显示。",
			agentId: "codex",
			startInPlanMode: true,
			baseRef: "main",
			createdAt,
			updatedAt: createdAt,
			...(column.id === "in_progress" && index === 0
				? { pinnedToTaskPinboardAt: createdAt, taskPinboardPinReason: "置顶行与本体共用紧凑展示" }
				: {}),
			...(column.id === "review" && index === 1
				? { taskShelvingState: { isShelved: true, lastChangedAt: createdAt } }
				: {}),
		}),
	);
}
for (const column of initialBoard.columns) {
	for (const card of column.cards) {
		setTaskWorkspaceSnapshot({
			taskId: card.id,
			path: `/isolated/single-project-mobile-home/${card.id}`,
			changedFiles: 1,
			additions: 3,
			deletions: 1,
			commitsAheadOfBaseRef: 1,
			commitsBehindBaseRef: 0,
		});
	}
}

declare global {
	interface Window {
		singleProjectMobileHomeBrowserFixture: {
			readBoard: () => BoardData;
			readDrops: () => DropResult[];
			showEmptyBoard: () => void;
		};
	}
}

function SingleProjectMobileHomeBrowserHarness() {
	const [board, setBoard] = useState(initialBoard);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [lastAction, setLastAction] = useState("");
	window.singleProjectMobileHomeBrowserFixture = {
		readBoard: () => board,
		readDrops: () => observedDrops,
		showEmptyBoard: () => setBoard(createInitialBoardData()),
	};
	const moveTask = (taskId: string, columnId: BoardColumnId) => {
		setLastAction(`移列:${taskId}:${columnId}`);
		setBoard((previous) => moveTaskToColumn(previous, taskId, columnId).board);
	};
	const session: RuntimeTaskSessionSummary = {
		taskId: "in_progress-0",
		agentId: "codex",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		workspacePath: "/isolated/single-project-mobile-home",
		pid: 1,
		startedAt: createdAt,
		updatedAt: createdAt,
		lastOutputAt: createdAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
	return (
		<TooltipProvider>
			<output hidden data-browser-last-action="">
				{lastAction}
			</output>
			<main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-surface-0 text-text-primary">
				{selectedTaskId ? (
					<div className="p-3" data-browser-opened-task={selectedTaskId}>
						<button type="button" onClick={() => setSelectedTaskId(null)}>
							返回项目首页
						</button>
					</div>
				) : (
					<KanbanBoard
						data={board}
						taskSessions={{ "in_progress-0": session }}
						workspacePath="/isolated/single-project-mobile-home"
						onCardSelect={setSelectedTaskId}
						onCreateTask={() => setLastAction("新建任务")}
						onEditTask={(card) => setLastAction(`编辑:${card.id}`)}
						onStartTask={(taskId) => setLastAction(`启动:${taskId}`)}
						onSaveTaskTitle={(taskId) => setLastAction(`改标题:${taskId}`)}
						onMoveToReviewTask={(taskId) => moveTask(taskId, "review")}
						onMoveToValidationTask={(taskId) => moveTask(taskId, "validation")}
						onMoveToTrashTask={(taskId) => moveTask(taskId, "trash")}
						onRestoreFromTrashTask={(taskId) => moveTask(taskId, "review")}
						onDeleteTask={(taskId) => setLastAction(`删除:${taskId}`)}
						onDragEnd={(result) => {
							observedDrops.push(result);
							setBoard((previous) => applyDragResult(previous, result).board);
						}}
					/>
				)}
			</main>
		</TooltipProvider>
	);
}

createRoot(document.body.appendChild(document.createElement("div"))).render(<SingleProjectMobileHomeBrowserHarness />);
