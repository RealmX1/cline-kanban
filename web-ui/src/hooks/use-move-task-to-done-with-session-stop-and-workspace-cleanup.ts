import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import { findCardSelection, moveTaskToColumn } from "@/state/board-state";
import { withWebUiBoardMutationInitiatorRecordedForChangedTaskCards } from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
	// dd2db Y-EVENT-8：这次移入 Done 是谁发起的（用户手势 / PDV 面板完成 / auto-review / 会话中断自动流转）。
	// 不传 = 说不清，登记为 null，runtime 如实记缺标注。
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}

// 把卡移入 Done（trash 列）的浏览器端动作：只负责「移列 + 停会话 + 清理 worktree」。
// dd2db 1a 起任务连线与「完成后自动启动下游 backlog 卡」已整体退役，这里不再计算或启动任何就绪任务；
// 后续由任务关系（Relations）与等待门取代。
export function useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup({
	board,
	setBoard,
	setSelectedTaskId,
	stopTaskSession,
	cleanupTaskWorkspace,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	stopTaskSession: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
}): {
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
} {
	const boardRef = useRef(board);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	const performMoveTaskToTrash = useCallback(
		async (
			task: BoardCard,
			currentBoard: BoardData | undefined,
			boardMutationInitiator: WebUiBoardMutationInitiator | null,
		): Promise<void> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			const trashed = moveTaskToColumn(boardBeforeTrash, task.id, "trash");
			if (!trashed.moved) {
				await stopTaskSession(task.id);
				await cleanupTaskWorkspace(task.id);
				return;
			}

			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(boardMutationInitiator, (currentBoardState) => {
					const latestTrashResult = moveTaskToColumn(currentBoardState, task.id, "trash");
					return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
				}),
			);
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
					: currentSelectedTaskId,
			);

			await Promise.all([stopTaskSession(task.id), stopTaskSession(getDetailTerminalTaskId(task.id))]);
			await cleanupTaskWorkspace(task.id);
		},
		[cleanupTaskWorkspace, setBoard, setSelectedTaskId, stopTaskSession],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, _fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				return;
			}

			const moveSelectionIfOptimisticMoveIsConfirmed = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === taskId
						? getNextDetailTaskIdAfterTrashMove(boardSnapshot, taskId)
						: currentSelectedTaskId,
				);
			};

			const boardMutationInitiator = options?.boardMutationInitiator ?? null;
			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				await performMoveTaskToTrash(selection.card, boardSnapshot, boardMutationInitiator);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			await performMoveTaskToTrash(selection.card, boardSnapshot, boardMutationInitiator);
		},
		[performMoveTaskToTrash, setSelectedTaskId],
	);

	return {
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard, null);
		},
		requestMoveTaskToTrash,
	};
}
