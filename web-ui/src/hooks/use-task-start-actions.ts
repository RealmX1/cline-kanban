import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData, TaskEditorSubmitOptions } from "@/types";

interface UseTaskStartActionsInput {
	board: BoardData;
	currentProjectId: string | null;
	handleCreateTask: (options?: TaskEditorSubmitOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: TaskEditorSubmitOptions) => string[];
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: TaskEditorSubmitOptions) => string | null;
	handleCreateAndStartTasks: (prompts: string[], options?: TaskEditorSubmitOptions) => string[];
	handleCreateStartAndOpenTask: (options?: TaskEditorSubmitOptions) => string | null;
	handleStartTaskFromBoard: (taskId: string) => void;
	pendingStartAllReadyBacklogTaskCards: BoardCard[] | null;
	requestStartAllReadyBacklogTasksConfirmation: () => void;
	confirmStartAllReadyBacklogTasks: () => void;
	cancelStartAllReadyBacklogTasksConfirmation: () => void;
}

interface PendingStartAllReadyBacklogTasksConfirmation {
	projectId: string | null;
	requestedTaskIds: string[];
}

// 过渡语义（dd2db 1a）：任务连线已退役、等待门（阶段 3）尚未落地，backlog 里的卡全部视为可启动。
export function getStartableBacklogTaskIds(board: BoardData): string[] {
	return board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
}

export function useTaskStartActions({
	board,
	currentProjectId,
	handleCreateTask,
	handleCreateTasks,
	handleStartTask,
	handleStartAllBacklogTasks,
	setSelectedTaskId,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	// 事件入口读取最新状态，避免每个 session tick 改变整棵卡片树的 handler 身份。
	const latestTaskStartBoardRef = useRef({ board });
	latestTaskStartBoardRef.current = { board };
	const [pendingTaskStartAfterCreateIds, setPendingTaskStartAfterCreateIds] = useState<string[] | null>(null);
	const [pendingStartAllReadyBacklogTasksConfirmation, setPendingStartAllReadyBacklogTasksConfirmation] =
		useState<PendingStartAllReadyBacklogTasksConfirmation | null>(null);

	const startBacklogTasks = useCallback(
		(taskIds: string[]) => {
			const { board } = latestTaskStartBoardRef.current;
			const backlogTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))].filter((taskId) => {
				const selection = findCardSelection(board, taskId);
				return selection?.column.id === "backlog";
			});

			if (backlogTaskIds.length === 0) {
				return;
			}

			if (backlogTaskIds.length === 1) {
				const firstTaskId = backlogTaskIds[0];
				if (!firstTaskId) {
					return;
				}
				handleStartTask(firstTaskId);
				return;
			}
			handleStartAllBacklogTasks(backlogTaskIds);
		},
		[handleStartAllBacklogTasks, handleStartTask],
	);

	const handleStartTaskFromBoard = useCallback(
		(taskId: string) => {
			const { board } = latestTaskStartBoardRef.current;
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				handleStartTask(taskId);
				return;
			}
			startBacklogTasks([taskId]);
		},
		[handleStartTask, startBacklogTasks],
	);

	const requestStartAllReadyBacklogTasksConfirmation = useCallback(() => {
		const { board } = latestTaskStartBoardRef.current;
		const backlogTaskIds = getStartableBacklogTaskIds(board);

		if (backlogTaskIds.length === 0) {
			return;
		}
		setPendingStartAllReadyBacklogTasksConfirmation({
			projectId: currentProjectId,
			requestedTaskIds: backlogTaskIds,
		});
	}, [currentProjectId]);

	const pendingStartAllReadyBacklogTaskCards = useMemo(() => {
		if (
			!pendingStartAllReadyBacklogTasksConfirmation ||
			pendingStartAllReadyBacklogTasksConfirmation.projectId !== currentProjectId
		) {
			return null;
		}

		const currentlyStartableTaskIds = new Set(getStartableBacklogTaskIds(board));
		return pendingStartAllReadyBacklogTasksConfirmation.requestedTaskIds
			.filter((taskId) => currentlyStartableTaskIds.has(taskId))
			.map((taskId) => findCardSelection(board, taskId)?.card ?? null)
			.filter((card): card is BoardCard => card !== null);
	}, [board, currentProjectId, pendingStartAllReadyBacklogTasksConfirmation]);

	const cancelStartAllReadyBacklogTasksConfirmation = useCallback(() => {
		setPendingStartAllReadyBacklogTasksConfirmation(null);
	}, []);

	const confirmStartAllReadyBacklogTasks = useCallback(() => {
		const confirmedTaskIds = pendingStartAllReadyBacklogTaskCards?.map((card) => card.id) ?? [];
		setPendingStartAllReadyBacklogTasksConfirmation(null);
		startBacklogTasks(confirmedTaskIds);
	}, [pendingStartAllReadyBacklogTaskCards, startBacklogTasks]);

	useEffect(() => {
		setPendingStartAllReadyBacklogTasksConfirmation((currentConfirmation) => {
			if (!currentConfirmation || currentConfirmation.projectId === currentProjectId) {
				return currentConfirmation;
			}
			return null;
		});
	}, [currentProjectId]);

	useEffect(() => {
		if (pendingStartAllReadyBacklogTasksConfirmation !== null && pendingStartAllReadyBacklogTaskCards?.length === 0) {
			setPendingStartAllReadyBacklogTasksConfirmation(null);
		}
	}, [pendingStartAllReadyBacklogTaskCards, pendingStartAllReadyBacklogTasksConfirmation]);

	const handleCreateAndStartTask = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			const taskId = handleCreateTask(options);
			if (!taskId) {
				return null;
			}
			setPendingTaskStartAfterCreateIds([taskId]);
			return taskId;
		},
		[handleCreateTask],
	);

	const handleCreateAndStartTasks = useCallback(
		(prompts: string[], options?: TaskEditorSubmitOptions): string[] => {
			const taskIds = handleCreateTasks(prompts, options);
			if (taskIds.length === 0) {
				return [];
			}
			setPendingTaskStartAfterCreateIds(taskIds);
			return taskIds;
		},
		[handleCreateTasks],
	);

	const handleCreateStartAndOpenTask = useCallback(
		(options?: TaskEditorSubmitOptions): string | null => {
			const taskId = handleCreateTask(options);
			if (!taskId) {
				return null;
			}
			setPendingTaskStartAfterCreateIds([taskId]);
			if (!options?.keepDialogOpen) {
				setSelectedTaskId(taskId);
			}
			return taskId;
		},
		[handleCreateTask, setSelectedTaskId],
	);

	useEffect(() => {
		if (!pendingTaskStartAfterCreateIds || pendingTaskStartAfterCreateIds.length === 0) {
			return;
		}
		const allInBacklog = pendingTaskStartAfterCreateIds.every((taskId) => {
			const selection = findCardSelection(board, taskId);
			return selection?.column.id === "backlog";
		});
		if (!allInBacklog) {
			return;
		}
		startBacklogTasks(pendingTaskStartAfterCreateIds);
		setPendingTaskStartAfterCreateIds(null);
	}, [board, pendingTaskStartAfterCreateIds, startBacklogTasks]);

	return {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		pendingStartAllReadyBacklogTaskCards,
		requestStartAllReadyBacklogTasksConfirmation,
		confirmStartAllReadyBacklogTasks,
		cancelStartAllReadyBacklogTasksConfirmation,
	};
}
