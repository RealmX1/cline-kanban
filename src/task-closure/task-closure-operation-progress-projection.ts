import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { mutateWorkspaceState } from "../state/workspace-state";
import { type TaskClosureOperation, writeTaskClosureOperation } from "./task-closure-operation-store";

export async function persistTaskClosureProgressAndProjectOntoCurrentCard(
	scope: { workspacePath: string },
	operation: TaskClosureOperation,
) {
	await writeTaskClosureOperation(operation);
	const saved = await mutateWorkspaceState(
		scope.workspacePath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"task_closure_operation_progress_changed",
			"task-closure-preservation",
		),
		(state) => {
			const card = state.board.columns
				.flatMap((column) => column.cards)
				.find((card) => card.id === operation.taskIdentity.taskId);
			const activeReopening = operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase);
			if (
				!card ||
				card.createdAt !== operation.taskIdentity.taskIncarnationCreatedAtEpochMs ||
				(card.taskClosureOperationProgress &&
					card.taskClosureOperationProgress.closureRequestId !== operation.progress.closureRequestId &&
					["completed", "cancelled"].includes(operation.progress.phase) &&
					!activeReopening) ||
				JSON.stringify(card.taskClosureOperationProgress) === JSON.stringify(operation.progress)
			)
				return { board: state.board, value: null, save: false };
			return {
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((entry) =>
							entry === card ? { ...entry, taskClosureOperationProgress: operation.progress } : entry,
						),
					})),
				},
				value: null,
			};
		},
	);
	return saved.saved;
}
