import { TRPCError } from "@trpc/server";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeKanbanCliTaskBoardMutationKind,
	RuntimeKanbanCliTaskBoardMutationRequest,
	RuntimeKanbanCliTaskBoardMutationResponse,
} from "../core/api-contract";
import { buildRuntimeUpdateTaskInputFromKanbanCliTaskCardFieldUpdateRawInput } from "../core/kanban-cli-task-card-field-input-resolution";
import {
	addTaskToColumn,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../core/task-board-mutations";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";

// `workspace.applyKanbanCliTaskBoardMutation` 的 runtime 侧实现（dd2db 1a.2b）。
// CLI 的 board 写动词全部经这里进入持久化漏斗：先按请求头上的 CLI 行动者声明解析行动者，再在 board 锁内
// 对**最新** board 做纯变更。CLI 侧的前后副作用（停会话、删 worktree、自动开跑 linked 任务、清草稿与
// checkpoint ref）仍由 CLI 按原顺序编排，这里只负责 board 本身，写成后像其他 runtime 写入一样广播。

export interface KanbanCliTaskBoardMutationApiDependencies {
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	// 测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}

// 意图种类沿用迁移前 CLI 直接写盘时的命名，账本读侧据此把迁移前后的同一动词对齐。
const TASK_MUTATION_INTENT_KIND_BY_KANBAN_CLI_TASK_BOARD_MUTATION_KIND = {
	create_backlog_task_card: "kanban_cli_task_create",
	update_task_card_fields: "kanban_cli_task_update",
	move_task_card_to_in_progress_column: "kanban_cli_task_start_move_to_in_progress",
	move_task_card_to_trash_column: "kanban_cli_task_trash",
	permanently_delete_task_cards: "kanban_cli_task_delete",
} as const satisfies Record<RuntimeKanbanCliTaskBoardMutationKind, string>;

// 每种动词的响应字段（去掉判别键）＝ board 锁内 mutate 回调产出的 value。
type KanbanCliTaskBoardMutationResponseFieldsOfKind<
	TKanbanCliTaskBoardMutationKind extends RuntimeKanbanCliTaskBoardMutationKind,
> = Omit<
	Extract<
		RuntimeKanbanCliTaskBoardMutationResponse,
		{ kanbanCliTaskBoardMutationKind: TKanbanCliTaskBoardMutationKind }
	>,
	"kanbanCliTaskBoardMutationKind"
>;

interface TaskCardFoundWithBoardColumn {
	taskCard: RuntimeBoardCard;
	boardColumnId: RuntimeBoardColumnId;
}

function findTaskCardWithBoardColumn(board: RuntimeBoardData, taskId: string): TaskCardFoundWithBoardColumn | null {
	for (const column of board.columns) {
		const taskCard = column.cards.find((candidate) => candidate.id === taskId);
		if (taskCard) {
			return { taskCard, boardColumnId: column.id };
		}
	}
	return null;
}

function createTaskCardNotFoundOnWorkspaceBoardError(taskId: string, workspacePath: string): TRPCError {
	// 文案与迁移前 CLI 本地报错逐字一致：调用方脚本可能在匹配它。
	return new TRPCError({
		code: "NOT_FOUND",
		message: `Task "${taskId}" was not found in workspace ${workspacePath}.`,
	});
}

// 纯变更函数对非法 CLI 输入抛普通 Error（空 prompt、切 agent 缺会话 id 等）。转成 BAD_REQUEST，
// 让 CLI 拿到原文案；TRPCError 原样放行。
function runPureTaskBoardMutationRejectingInvalidKanbanCliInputAsBadRequest<T>(pureTaskBoardMutation: () => T): T {
	try {
		return pureTaskBoardMutation();
	} catch (error) {
		if (error instanceof TRPCError) {
			throw error;
		}
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		});
	}
}

export async function applyKanbanCliTaskBoardMutation(
	deps: KanbanCliTaskBoardMutationApiDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	request: RuntimeKanbanCliTaskBoardMutationRequest,
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
): Promise<RuntimeKanbanCliTaskBoardMutationResponse> {
	const taskMutationIntentWithResolvedActor = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
		taskMutationIntentKind:
			TASK_MUTATION_INTENT_KIND_BY_KANBAN_CLI_TASK_BOARD_MUTATION_KIND[request.kanbanCliTaskBoardMutationKind],
		kanbanRequestOriginActorEvidence,
		kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
	});
	const broadcastWorkspaceStateUpdatedWhenBoardWasSaved = (boardWasSaved: boolean): void => {
		if (!boardWasSaved) {
			return;
		}
		void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
		void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
	};

	switch (request.kanbanCliTaskBoardMutationKind) {
		case "create_backlog_task_card": {
			const fieldValues = request.backlogTaskCardFieldValuesResolvedByKanbanCli;
			const mutation = await mutateWorkspaceState(
				workspaceScope.workspacePath,
				taskMutationIntentWithResolvedActor,
				(state) => {
					const created = runPureTaskBoardMutationRejectingInvalidKanbanCliInputAsBadRequest(() =>
						addTaskToColumn(
							state.board,
							"backlog",
							{
								title: fieldValues.title,
								prompt: fieldValues.prompt,
								startInPlanMode: fieldValues.startInPlanMode,
								ompAgentSessionTransportForNewTasks: fieldValues.ompAgentSessionTransportForNewTasks,
								workspaceDefaultAgentIdForNewTasks: fieldValues.workspaceDefaultAgentIdForNewTasks,
								taskAgentPermissionMode: fieldValues.taskAgentPermissionMode,
								autoReviewEnabled: fieldValues.autoReviewEnabled,
								autoReviewMode: fieldValues.autoReviewMode,
								agentId: fieldValues.agentId,
								clineSettings: fieldValues.clineSettings,
								taskAgentSessionInitialization: fieldValues.taskAgentSessionInitialization,
								baseRef: fieldValues.baseRef,
								parentSessionId: fieldValues.parentSessionId,
								worktreeMode: fieldValues.worktreeMode,
								prepFilePath: fieldValues.prepFilePath,
							},
							() => globalThis.crypto.randomUUID(),
						),
					);
					return { board: created.board, value: created.task };
				},
			);
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(mutation.saved);
			return { kanbanCliTaskBoardMutationKind: "create_backlog_task_card", createdBacklogTaskCard: mutation.value };
		}

		case "update_task_card_fields": {
			const mutation = await mutateWorkspaceState<
				KanbanCliTaskBoardMutationResponseFieldsOfKind<"update_task_card_fields">
			>(workspaceScope.workspacePath, taskMutationIntentWithResolvedActor, (state) => {
				const found = findTaskCardWithBoardColumn(state.board, request.updatedTaskId);
				if (!found) {
					throw createTaskCardNotFoundOnWorkspaceBoardError(request.updatedTaskId, workspaceScope.workspacePath);
				}
				const updated = runPureTaskBoardMutationRejectingInvalidKanbanCliInputAsBadRequest(() =>
					updateTask(
						state.board,
						request.updatedTaskId,
						buildRuntimeUpdateTaskInputFromKanbanCliTaskCardFieldUpdateRawInput(
							found.taskCard,
							request.kanbanCliTaskCardFieldUpdateRawInput,
						),
					),
				);
				if (!updated.updated || !updated.task) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Task "${request.updatedTaskId}" could not be updated.`,
					});
				}
				return {
					board: updated.board,
					value: {
						updatedTaskCard: updated.task,
						updatedTaskCardBoardColumnId: found.boardColumnId,
						updatedTaskCardSessionSummaryPersistedOnDisk: state.sessions[request.updatedTaskId] ?? null,
					},
				};
			});
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(mutation.saved);
			return { kanbanCliTaskBoardMutationKind: "update_task_card_fields", ...mutation.value };
		}

		case "move_task_card_to_in_progress_column": {
			const mutation = await mutateWorkspaceState<
				KanbanCliTaskBoardMutationResponseFieldsOfKind<"move_task_card_to_in_progress_column">
			>(workspaceScope.workspacePath, taskMutationIntentWithResolvedActor, (state) => {
				const movement = moveTaskToColumn(state.board, request.movedTaskId, "in_progress");
				if (!movement.task) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Task "${request.movedTaskId}" could not be resolved.`,
					});
				}
				const value = {
					taskCardWasMovedIntoInProgressColumn: movement.moved,
					movedTaskCardAfterMutation: movement.task,
					movedTaskCardBoardColumnIdBeforeMutation: movement.fromColumnId,
				};
				// 本来就在 in_progress：没有卡片级变化，不写盘、不产生空事件批次。
				return movement.moved ? { board: movement.board, value } : { board: state.board, value, save: false };
			});
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(mutation.saved);
			return { kanbanCliTaskBoardMutationKind: "move_task_card_to_in_progress_column", ...mutation.value };
		}

		case "move_task_card_to_trash_column": {
			const mutation = await mutateWorkspaceState<
				KanbanCliTaskBoardMutationResponseFieldsOfKind<"move_task_card_to_trash_column">
			>(workspaceScope.workspacePath, taskMutationIntentWithResolvedActor, (state) => {
				const found = findTaskCardWithBoardColumn(state.board, request.movedTaskId);
				if (!found) {
					throw createTaskCardNotFoundOnWorkspaceBoardError(request.movedTaskId, workspaceScope.workspacePath);
				}
				const movedTaskCardSessionSummaryPersistedOnDisk = state.sessions[request.movedTaskId] ?? null;
				if (found.boardColumnId === "trash") {
					return {
						board: state.board,
						value: {
							taskCardWasAlreadyInTrashColumn: true,
							linkedBacklogTaskIdsReadyToStartAfterTrash: [],
							movedTaskCardAfterMutation: found.taskCard,
							movedTaskCardBoardColumnIdBeforeMutation: found.boardColumnId,
							movedTaskCardSessionSummaryPersistedOnDisk,
						},
						save: false,
					};
				}
				const trashed = trashTaskAndGetReadyLinkedTaskIds(state.board, request.movedTaskId);
				if (!trashed.moved || !trashed.task) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Task "${request.movedTaskId}" could not be moved to done.`,
					});
				}
				return {
					board: trashed.board,
					value: {
						taskCardWasAlreadyInTrashColumn: false,
						linkedBacklogTaskIdsReadyToStartAfterTrash: trashed.readyTaskIds,
						movedTaskCardAfterMutation: trashed.task,
						movedTaskCardBoardColumnIdBeforeMutation: found.boardColumnId,
						movedTaskCardSessionSummaryPersistedOnDisk,
					},
				};
			});
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(mutation.saved);
			return { kanbanCliTaskBoardMutationKind: "move_task_card_to_trash_column", ...mutation.value };
		}

		case "permanently_delete_task_cards": {
			const selection = request.permanentlyDeletedTaskCardSelection;
			const mutation = await mutateWorkspaceState<
				KanbanCliTaskBoardMutationResponseFieldsOfKind<"permanently_delete_task_cards">["permanentlyDeletedTaskCards"]
			>(workspaceScope.workspacePath, taskMutationIntentWithResolvedActor, (state) => {
				const selectedTaskCards: TaskCardFoundWithBoardColumn[] =
					selection.permanentlyDeletedTaskCardSelectionKind === "task_cards_selected_by_task_id"
						? [...new Set(selection.selectedTaskIds)].map((taskId) => {
								const found = findTaskCardWithBoardColumn(state.board, taskId);
								if (!found) {
									throw createTaskCardNotFoundOnWorkspaceBoardError(taskId, workspaceScope.workspacePath);
								}
								return found;
							})
						: (
								state.board.columns.find((column) => column.id === selection.selectedBoardColumnId)?.cards ?? []
							).map((taskCard) => ({ taskCard, boardColumnId: selection.selectedBoardColumnId }));
				const deleted = deleteTasksFromBoard(
					state.board,
					selectedTaskCards.map(({ taskCard }) => taskCard.id),
				);
				if (!deleted.deleted) {
					return { board: state.board, value: [], save: false };
				}
				const deletedTaskIds = new Set(deleted.deletedTaskIds);
				return {
					board: deleted.board,
					value: selectedTaskCards
						.filter(({ taskCard }) => deletedTaskIds.has(taskCard.id))
						.map(({ taskCard, boardColumnId }) => ({
							deletedTaskCard: taskCard,
							deletedTaskCardBoardColumnIdBeforeDeletion: boardColumnId,
							deletedTaskCardSessionSummaryPersistedOnDisk: state.sessions[taskCard.id] ?? null,
						})),
				};
			});
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(mutation.saved);
			return {
				kanbanCliTaskBoardMutationKind: "permanently_delete_task_cards",
				permanentlyDeletedTaskCards: mutation.value,
			};
		}
	}
}
