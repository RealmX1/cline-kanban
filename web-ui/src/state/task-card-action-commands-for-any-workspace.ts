import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import { pinTaskToTaskPinboard, unpinTaskFromTaskPinboard } from "@runtime-task-pinboard-pinning";
import { setTaskCardShelvingState } from "@runtime-task-state";
import {
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace,
	moveTaskCardIntoReviewByHandingTurnToUserInWorkspace,
	permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace,
	readTaskCardWithBoardColumnInWorkspace,
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace,
	setTaskCardShelvingStateInWorkspace,
	setTaskPinboardPinStateOfTaskCardInWorkspace,
	startTaskCardAgentSessionMovingItIntoInProgressInWorkspace,
	transferNeverStartedBacklogTaskToProjectInWorkspace,
	updateTaskCardFieldValuesInWorkspace,
} from "@/runtime/task-card-action-query";
import type {
	RuntimeAgentTerminalGeometryForTaskSessionSpawn,
	RuntimePermanentlyDeletedTaskCardSelection,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskCardActionMoveIntoReviewResponse,
	RuntimeTaskCardActionPermanentlyDeleteResponse,
	RuntimeTaskCardActionRestoreFromDoneResponse,
	RuntimeTaskCardActionSetShelvingStateResponse,
	RuntimeTaskCardActionSetTaskPinboardPinStateResponse,
	RuntimeTaskCardActionStartAgentSessionResponse,
	RuntimeTaskCardActionUpdateFieldValuesResponse,
	RuntimeTaskCardFieldValuePatch,
} from "@/runtime/types";
import { readEffectiveUserInterfacePreferenceValue } from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { findCardSelection } from "@/state/board-state";
import type { PendingTaskCardCommandExpectedBoardEffect } from "@/state/pending-task-card-command-board-overlay";
import {
	executeTaskCardActionCommand,
	type TaskCardActionCommandExecutionResult,
} from "@/state/task-card-action-command-execution";
import {
	hasAcceptedTaskProjectAssignmentAnalysis,
	rememberTaskProjectAssignmentAnalysisAccepted,
	runTaskProjectAssignmentPreflight,
} from "@/state/task-project-assignment-preflight";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

// 每个用户交互卡片动作在浏览器侧的唯一入口，主看板、Focus View（This project）、跨项目切换面板（All projects）共用。
// 差别只在调用方给不给 `currentProjectBoardForOptimisticOverlay`：
//   - 当前项目：给。动作在渲染层立刻生效（overlay），不改会被整板保存的 board；
//   - 其他项目：不给。board 不在浏览器内存里，只显示在途 spinner，结果随广播回来。
// 乐观结果尽量用与服务端同一个 core 纯函数算（置顶、移列），保证 overlay 与服务端写下的东西一致。

function buildTaskCardFieldPatchProducedByBoardTransformation(
	board: BoardData,
	taskId: string,
	transformBoard: (board: BoardData) => { board: BoardData; updated: boolean },
	fieldNames: ReadonlyArray<keyof BoardCard>,
): Partial<Omit<BoardCard, "id">> | null {
	const transformed = transformBoard(board);
	if (!transformed.updated) {
		return null;
	}
	const updatedCard = findCardSelection(transformed.board, taskId)?.card;
	if (!updatedCard) {
		return null;
	}
	const taskCardFieldPatch: Record<string, unknown> = {};
	for (const fieldName of fieldNames) {
		taskCardFieldPatch[fieldName] = updatedCard[fieldName];
	}
	return taskCardFieldPatch;
}

function expectedBoardEffectsForSingleTaskCard(
	taskId: string,
	expectedBoardEffect: PendingTaskCardCommandExpectedBoardEffect | null,
): ReadonlyMap<string, PendingTaskCardCommandExpectedBoardEffect> | undefined {
	return expectedBoardEffect ? new Map([[taskId, expectedBoardEffect]]) : undefined;
}

// --- 改字段：行内改名、取消自动动作、编辑器保存 ---
// patch 三态语义见 runtimeTaskCardFieldValuePatchSchema：键缺省 = 保留服务端最新现值，null = 清除，值 = 改成它。
// 合并在服务端 board 锁内对最新卡片进行，所以「只改标题」不会抹掉别人刚改的 prompt。
// overlay 的乐观值由调用方给的 board 变换算出（与改动前浏览器 setBoard 用的是同一个纯函数）。
export async function updateTaskCardFieldValuesThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	taskCardFieldValuePatch: RuntimeTaskCardFieldValuePatch;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	optimisticBoardTransformation?: (board: BoardData) => { board: BoardData; updated: boolean };
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionUpdateFieldValuesResponse>> {
	const optimisticTaskCardFieldPatch =
		input.currentProjectBoardForOptimisticOverlay && input.optimisticBoardTransformation
			? buildTaskCardFieldPatchProducedByBoardTransformation(
					input.currentProjectBoardForOptimisticOverlay,
					input.taskId,
					input.optimisticBoardTransformation,
					Object.keys(input.taskCardFieldValuePatch) as Array<keyof BoardCard>,
				)
			: null;
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "update_task_card_field_values",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			optimisticTaskCardFieldPatch
				? {
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
						taskCardFieldPatch: optimisticTaskCardFieldPatch,
					}
				: null,
		),
		sendCommand: () =>
			updateTaskCardFieldValuesInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: input.taskCardFieldValuePatch,
				},
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

function expectedTaskCardMoveIntoBoardColumn(
	currentProjectBoardForOptimisticOverlay: BoardData | undefined,
	targetBoardColumnId: BoardColumnId,
	insertAtIndex: number | undefined,
): PendingTaskCardCommandExpectedBoardEffect | null {
	if (!currentProjectBoardForOptimisticOverlay) {
		return null;
	}
	return {
		pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
		targetBoardColumnId,
		...(insertAtIndex !== undefined ? { insertAtIndex } : {}),
	};
}

// --- 纯看板重新归类：进出 validation、in_progress 列内重排（无会话副作用）---
export async function moveTaskCardBetweenNonTrashColumnsThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	targetBoardColumnId: BoardColumnId;
	// 拖放落点；缺省 = 列顶（与浏览器既有的「移列即置顶」一致）。
	insertAtIndexWithinTargetBoardColumn?: number;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionMoveBetweenNonTrashColumnsResponse>> {
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "move_task_card_between_non_trash_columns_without_session_side_effects",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			expectedTaskCardMoveIntoBoardColumn(
				input.currentProjectBoardForOptimisticOverlay,
				input.targetBoardColumnId,
				input.insertAtIndexWithinTargetBoardColumn,
			),
		),
		sendCommand: () =>
			moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				targetBoardColumnId: input.targetBoardColumnId,
				...(input.insertAtIndexWithinTargetBoardColumn !== undefined
					? { insertAtIndexWithinTargetBoardColumn: input.insertAtIndexWithinTargetBoardColumn }
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

// --- 启动：backlog / in_progress → in_progress，服务端先移列再 ensure worktree、再起会话 ---
export async function startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(input: {
	skipTaskProjectAssignmentPreflight?: boolean;
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	insertAtIndexWithinInProgressBoardColumn?: number;
	agentTerminalGeometryForTaskSessionSpawn?: RuntimeAgentTerminalGeometryForTaskSessionSpawn;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionStartAgentSessionResponse>> {
	const originalWorkspaceId = input.workspaceId;
	if (
		!input.skipTaskProjectAssignmentPreflight &&
		readEffectiveUserInterfacePreferenceValue("taskProjectAssignmentAutomaticAnalysisEnabled") === true &&
		(!input.boardMutationInitiator || input.boardMutationInitiator === "web_ui_user_gesture")
	) {
		try {
			const found = await readTaskCardWithBoardColumnInWorkspace(input.workspaceId, input.taskId);
			if (
				found.taskCardLookupOutcome === "task_card_found_on_workspace_board" &&
				found.taskCardSnapshot.boardColumnIdContainingTaskCard === "backlog"
			) {
				const card = found.taskCardSnapshot.taskCard;
				if (!hasAcceptedTaskProjectAssignmentAnalysis(input.workspaceId, input.taskId, card.title, card.prompt)) {
					const assignment = await runTaskProjectAssignmentPreflight({
						workspaceId: input.workspaceId,
						title: card.title,
						prompt: card.prompt,
						baseRef: card.baseRef ?? "",
					});
					if (!assignment)
						return {
							taskCardActionCommandExecutionOutcome: "command_failed",
							commandFailureMessage: "已取消启动，任务保留在 Backlog。",
						};
					const latest = await readTaskCardWithBoardColumnInWorkspace(input.workspaceId, input.taskId);
					if (
						latest.taskCardLookupOutcome !== "task_card_found_on_workspace_board" ||
						latest.taskCardSnapshot.taskCard.prompt !== card.prompt ||
						latest.taskCardSnapshot.taskCard.title !== card.title ||
						latest.taskCardSnapshot.taskCard.createdAt !== card.createdAt
					)
						throw new Error("分析期间任务已变化，请重新启动。");
					if (assignment.workspaceId !== input.workspaceId) {
						await transferNeverStartedBacklogTaskToProjectInWorkspace(input.workspaceId, {
							operationId: createRandomUuidV4WithInsecureContextFallback(),
							taskId: card.id,
							taskIncarnationCreatedAtEpochMs: card.createdAt,
							targetWorkspaceId: assignment.workspaceId,
							targetBaseRef: assignment.baseRef,
						});
						input = {
							...input,
							workspaceId: assignment.workspaceId,
							currentProjectBoardForOptimisticOverlay: undefined,
						};
					}
					rememberTaskProjectAssignmentAnalysisAccepted(input.workspaceId, input.taskId, card.title, card.prompt);
				}
			}
		} catch (failure) {
			return {
				taskCardActionCommandExecutionOutcome: "command_failed",
				commandFailureMessage: failure instanceof Error ? failure.message : String(failure),
			};
		}
	}

	const result = await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "start_task_card_agent_session_moving_it_into_in_progress",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			expectedTaskCardMoveIntoBoardColumn(
				input.currentProjectBoardForOptimisticOverlay,
				"in_progress",
				input.insertAtIndexWithinInProgressBoardColumn,
			),
		),
		sendCommand: () =>
			startTaskCardAgentSessionMovingItIntoInProgressInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
				...(input.agentTerminalGeometryForTaskSessionSpawn
					? { agentTerminalGeometryForTaskSessionSpawn: input.agentTerminalGeometryForTaskSessionSpawn }
					: {}),
				...(input.insertAtIndexWithinInProgressBoardColumn !== undefined
					? { insertAtIndexWithinInProgressBoardColumn: input.insertAtIndexWithinInProgressBoardColumn }
					: {}),
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
	if (
		result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime" &&
		originalWorkspaceId !== input.workspaceId
	)
		return {
			...result,
			response: {
				...result.response,
				taskCardSnapshotAfterAction: {
					...result.response.taskCardSnapshotAfterAction,
					workspaceId: input.workspaceId,
				},
			},
		};
	return result;
}

// --- 移到 review：把 agent 回合交还用户，成功后服务端显式移列 ---
export async function moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionMoveIntoReviewResponse>> {
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "move_task_card_into_review_by_handing_turn_to_user",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			expectedTaskCardMoveIntoBoardColumn(input.currentProjectBoardForOptimisticOverlay, "review", undefined),
		),
		sendCommand: () =>
			moveTaskCardIntoReviewByHandingTurnToUserInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

// --- 移入 Done：停 agent 会话与详情 shell 终端、删 worktree ---
// 浏览器端「会话中断自动流转进 Done」刻意不走这里：那条要保留 worktree 供恢复。
export async function moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	// 拖放 / 动画落点；缺省 = 列顶。
	insertAtIndexWithinDoneBoardColumn?: number;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
	// 卡片受 Post-Deploy Verification 门禁时的结案原因 / 确认项；缺省 = 不受门禁或尚未问过原因（受门禁时服务端拒绝）。
	postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionMoveIntoDoneResponse>> {
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "move_task_card_into_done_stopping_sessions_and_deleting_worktree",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			expectedTaskCardMoveIntoBoardColumn(
				input.currentProjectBoardForOptimisticOverlay,
				"trash",
				input.insertAtIndexWithinDoneBoardColumn,
			),
		),
		sendCommand: () =>
			moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				...(input.taskCommentToAppendWhenMovingIntoDone
					? { taskCommentToAppendWhenMovingIntoDone: input.taskCommentToAppendWhenMovingIntoDone }
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
				// 落点必须发给服务端：只进 overlay 的话，广播回灌后卡片会跳回列顶。
				...(input.insertAtIndexWithinDoneBoardColumn !== undefined
					? { insertAtIndexWithinDoneBoardColumn: input.insertAtIndexWithinDoneBoardColumn }
					: {}),
				...(input.postDeployVerificationDoneEntryClosure
					? { postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure }
					: {}),
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

// --- 从 Done 恢复：移回 review → ensure worktree → 续跑会话；任一步失败服务端把卡移回 Done ---
export async function restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	insertAtIndexWithinReviewBoardColumn?: number;
	agentTerminalGeometryForTaskSessionSpawn?: RuntimeAgentTerminalGeometryForTaskSessionSpawn;
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionRestoreFromDoneResponse>> {
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "restore_task_card_from_done_into_review_resuming_agent_session",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			expectedTaskCardMoveIntoBoardColumn(
				input.currentProjectBoardForOptimisticOverlay,
				"review",
				input.insertAtIndexWithinReviewBoardColumn,
			),
		),
		sendCommand: () =>
			restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
				...(input.agentTerminalGeometryForTaskSessionSpawn
					? { agentTerminalGeometryForTaskSessionSpawn: input.agentTerminalGeometryForTaskSessionSpawn }
					: {}),
				...(input.insertAtIndexWithinReviewBoardColumn !== undefined
					? { insertAtIndexWithinReviewBoardColumn: input.insertAtIndexWithinReviewBoardColumn }
					: {}),
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

// --- 永久删除（单卡 / 清空整列）：board 删卡 → 清草稿 → 清排队 prompt → 停会话 → 删 worktree → 删 checkpoint ref ---
export async function permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime(input: {
	workspaceId: string;
	permanentlyDeletedTaskCardSelection: RuntimePermanentlyDeletedTaskCardSelection;
	expectedTaskIncarnationCreatedAtEpochMsByTaskId?: Record<string, number>;
	// 在途闸与 overlay 的对象：单卡就是那张，清空整列时是调用方此刻看到的整列卡片。
	taskIdsExpectedToBeDeleted: readonly string[];
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionPermanentlyDeleteResponse>> {
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: input.taskIdsExpectedToBeDeleted,
		commandKind: "permanently_delete_task_card_with_full_resource_cleanup",
		expectedBoardEffectByTaskId: input.currentProjectBoardForOptimisticOverlay
			? new Map(
					input.taskIdsExpectedToBeDeleted.map((taskId) => [
						taskId,
						{ pendingTaskCardCommandExpectedBoardEffectKind: "task_card_removed_from_board" } as const,
					]),
				)
			: undefined,
		sendCommand: () =>
			permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace(input.workspaceId, {
				permanentlyDeletedTaskCardSelection: input.permanentlyDeletedTaskCardSelection,
				...(input.expectedTaskIncarnationCreatedAtEpochMsByTaskId
					? {
							expectedTaskIncarnationCreatedAtEpochMsByTaskId:
								input.expectedTaskIncarnationCreatedAtEpochMsByTaskId,
						}
					: {}),
				boardMutationInitiator: input.boardMutationInitiator ?? "web_ui_user_gesture",
			}),
	});
}

// --- 置顶 / 取消置顶 / 改置顶原因（置顶恒为用户手势）---
export async function setTaskPinboardPinStateOfTaskCardThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	taskPinboardPinChange:
		| { taskPinboardPinAction: "pin_task_card_or_update_pin_reason"; taskPinboardPinReason: string | null }
		| { taskPinboardPinAction: "unpin_task_card" };
	currentProjectBoardForOptimisticOverlay?: BoardData;
	boardMutationInitiator?: WebUiBoardMutationInitiator;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionSetTaskPinboardPinStateResponse>> {
	const { taskPinboardPinChange } = input;
	const optimisticTaskCardFieldPatch = input.currentProjectBoardForOptimisticOverlay
		? buildTaskCardFieldPatchProducedByBoardTransformation(
				input.currentProjectBoardForOptimisticOverlay,
				input.taskId,
				(board) =>
					taskPinboardPinChange.taskPinboardPinAction === "unpin_task_card"
						? unpinTaskFromTaskPinboard(board, input.taskId)
						: pinTaskToTaskPinboard(board, input.taskId, {
								pinReason: taskPinboardPinChange.taskPinboardPinReason,
							}),
				["pinnedToTaskPinboardAt", "taskPinboardPinReason"],
			)
		: null;
	const boardMutationInitiator = input.boardMutationInitiator ?? "web_ui_user_gesture";
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "set_task_pinboard_pin_state_of_task_card",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			optimisticTaskCardFieldPatch
				? {
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
						taskCardFieldPatch: optimisticTaskCardFieldPatch,
					}
				: null,
		),
		sendCommand: () =>
			setTaskPinboardPinStateOfTaskCardInWorkspace(
				input.workspaceId,
				taskPinboardPinChange.taskPinboardPinAction === "unpin_task_card"
					? {
							taskPinboardPinAction: "unpin_task_card",
							taskId: input.taskId,
							boardMutationInitiator,
							...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
								? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
								: {}),
						}
					: {
							taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
							taskId: input.taskId,
							...(input.expectedTaskIncarnationCreatedAtEpochMs !== undefined
								? { expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs }
								: {}),
							taskPinboardPinReason: taskPinboardPinChange.taskPinboardPinReason,
							boardMutationInitiator,
						},
			),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}

export async function setTaskCardShelvingStateThroughRuntime(input: {
	workspaceId: string;
	taskId: string;
	isShelved: boolean;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	currentProjectBoardForOptimisticOverlay?: BoardData;
}): Promise<TaskCardActionCommandExecutionResult<RuntimeTaskCardActionSetShelvingStateResponse>> {
	const patch = input.currentProjectBoardForOptimisticOverlay
		? buildTaskCardFieldPatchProducedByBoardTransformation(
				input.currentProjectBoardForOptimisticOverlay,
				input.taskId,
				(board) => setTaskCardShelvingState(board, input.taskId, input.isShelved),
				["taskShelvingState"],
			)
		: null;
	return await executeTaskCardActionCommand({
		workspaceId: input.workspaceId,
		taskIds: [input.taskId],
		commandKind: "set_task_card_shelving_state",
		expectedBoardEffectByTaskId: expectedBoardEffectsForSingleTaskCard(
			input.taskId,
			patch
				? {
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_fields_patched",
						taskCardFieldPatch: patch,
					}
				: null,
		),
		sendCommand: () =>
			setTaskCardShelvingStateInWorkspace(input.workspaceId, {
				taskId: input.taskId,
				isShelved: input.isShelved,
				expectedTaskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs,
				boardMutationInitiator: "web_ui_user_gesture",
			}),
		readTaskCardSnapshotsAfterAction: (response) => [response.taskCardSnapshotAfterAction],
	});
}
