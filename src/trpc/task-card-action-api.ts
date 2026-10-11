import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskCardActionPermanentlyDeleteResponse,
	RuntimeTaskCardActionRestoreFromDoneResponse,
	RuntimeTaskCardActionStartAgentSessionResponse,
	RuntimeTaskCardRestoreFromDoneOutcome,
	RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorktreeDeletionResultOfTaskCardAction,
	RuntimeTaskWorktreeMode,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import type { WebUiBoardMutationInitiator } from "../core/kanban-web-ui-page-load-request-origin-nonce";
import { resolveSessionFacets } from "../core/session-activity";
import {
	deleteTasksFromBoard,
	moveTaskToColumn,
	reorderTaskWithinBoardColumn,
	updateTask,
} from "../core/task-board-mutations";
import {
	canTaskCardInBoardColumnHostLiveTaskAgentSession,
	isTaskCardBoardPlacementChangeAllowedWithoutSessionSideEffects,
} from "../core/task-card-action-board-column-transitions";
import {
	buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch,
	resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard,
} from "../core/task-card-field-patch-resolution";
import { pinTaskToTaskPinboard, unpinTaskFromTaskPinboard } from "../core/task-pinboard-pinning";
import { buildTaskSessionStartRequestFromBoardCard } from "../core/task-session-start-request-from-board-card";
import { buildTaskCardDetailUserShellTerminalSessionTaskId } from "../core/user-shell-terminal-session-task-id";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { discardTaskEditDraftsForDeletedTasks } from "../state/discard-task-edit-drafts-for-tasks-removed-from-board";
import { discardQueuedTaskPromptDeliveriesForTasks } from "../state/queued-task-prompt-delivery-store";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceBoardById,
	mutateWorkspaceState,
} from "../state/workspace-state";
import { deleteAllTaskTurnCheckpointRefs } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";
import type { TaskCardActionPerTaskCommandSerializer } from "./task-card-action-per-task-command-serializer";
import {
	resolveTaskMutationIntentWithResolvedActorForTaskCardAction,
	type TaskCardActionTaskMutationIntentSubject,
} from "./task-card-action-task-mutation-intent-resolution";

// `taskCardAction.*`：看板卡片 per-card 动作的**唯一**服务端实现。主看板、Focus View、跨项目切换面板与 kanban CLI
// 都调这里；契约（输入 / 输出 / 错误语义）见 src/core/api-contract.ts 的 taskCardAction 一节。
//
// 每个动作的形状都一样：在按卡串行器里，先锁外解析行动者 → board 锁内对**最新** board 做纯变更（漏斗记账）→
// 写成就广播 → 锁外执行会话 / worktree 副作用（复用 runtimeApi / workspaceApi 的现成实现，不复制它们的逻辑）。
// 会话与 worktree 的执行期失败不抛错，回传在响应里；只有「请求本身不成立」（卡不存在、所在列不允许）才抛 TRPCError。

export interface CreateTaskCardActionApiDependencies {
	// 与同一请求上下文里交给路由的是同一个实例（runtime-server.ts 的 createTrpcContext 里提成局部变量后注入）。
	runtimeApi: Pick<
		RuntimeTrpcContext["runtimeApi"],
		"startTaskSession" | "stopTaskSession" | "transitionTaskToReview"
	>;
	workspaceApi: Pick<RuntimeTrpcContext["workspaceApi"], "ensureWorktree" | "deleteWorktree">;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	// runtime 内存里三种 transport 合并后的当前会话摘要；该项目从未加载过会话时为 null。
	findTaskSessionSummaryLiveInRuntimeProcessMemory: (
		workspaceId: string,
		taskId: string,
	) => RuntimeTaskSessionSummary | null;
	// runtime 级单例（不能每个请求新建，否则串不住）。
	taskCardActionPerTaskCommandSerializer: TaskCardActionPerTaskCommandSerializer;
	// 永久删除丢弃排队 prompt 之后，让出队引擎刷新缓存并重发投影。
	onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards?: (
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	) => void;
	// 测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}

interface TaskCardFoundWithBoardColumn {
	taskCard: RuntimeBoardCard;
	boardColumnId: RuntimeBoardColumnId;
}

type AutoReviewSettingsOfTaskCard = Pick<RuntimeBoardCard, "autoReviewEnabled" | "autoReviewMode">;

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

function findTaskCardWithBoardColumnOrThrowNotFound(
	board: RuntimeBoardData,
	taskId: string,
	workspacePath: string,
): TaskCardFoundWithBoardColumn {
	const found = findTaskCardWithBoardColumn(board, taskId);
	if (!found) {
		throw createTaskCardNotFoundOnWorkspaceBoardError(taskId, workspacePath);
	}
	return found;
}

function createTaskCardInBoardColumnNotAllowingActionError(message: string): TRPCError {
	return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

// 纯变更函数对非法输入抛普通 Error（空 prompt、切 agent 缺会话 id 等）。转成 BAD_REQUEST，让调用方拿到原文案；
// TRPCError 原样放行。
export function runPureTaskBoardMutationRejectingInvalidInputAsBadRequest<T>(pureTaskBoardMutation: () => T): T {
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createTaskCardActionApi(
	deps: CreateTaskCardActionApiDependencies,
): RuntimeTrpcContext["taskCardActionApi"] {
	const resolveIntent = async (
		taskCardActionTaskMutationIntentSubject: TaskCardActionTaskMutationIntentSubject,
		kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		boardMutationInitiatorDeclaredByWebUi: WebUiBoardMutationInitiator | undefined,
		subjectTaskIdsOfTaskCardAction: readonly string[],
	) =>
		await resolveTaskMutationIntentWithResolvedActorForTaskCardAction({
			taskCardActionTaskMutationIntentSubject,
			kanbanRequestOriginActorEvidence,
			boardMutationInitiatorDeclaredByWebUi,
			subjectTaskIdsOfTaskCardAction,
			kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
		});

	const broadcastWorkspaceStateUpdatedWhenBoardWasSaved = (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		boardWasSaved: boolean,
	): void => {
		if (!boardWasSaved) {
			return;
		}
		void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
		void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
	};

	const buildTaskCardSnapshot = (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		found: TaskCardFoundWithBoardColumn,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null,
	): RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries => ({
		taskCard: found.taskCard,
		boardColumnIdContainingTaskCard: found.boardColumnId,
		taskSessionSummaryLiveInRuntimeProcessMemory: deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(
			workspaceScope.workspaceId,
			found.taskCard.id,
		),
		taskSessionSummaryPersistedInWorkspaceSessionsFile,
	});

	// 会话启动成功时 runtime 会往卡片上回写 mostRecentlyLaunchedAgentSessionAgentId，所以副作用之后重读一次卡片；
	// 读不到（被并发删掉）就用锁内那份。
	const rereadTaskCardSnapshotAfterSessionSideEffects = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		foundWithinBoardLock: TaskCardFoundWithBoardColumn,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null,
	): Promise<RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries> => {
		const boardAfterSessionSideEffects = await loadWorkspaceBoardById(workspaceScope.workspaceId).catch(() => null);
		const foundAfterSessionSideEffects = boardAfterSessionSideEffects
			? findTaskCardWithBoardColumn(boardAfterSessionSideEffects, foundWithinBoardLock.taskCard.id)
			: null;
		return buildTaskCardSnapshot(
			workspaceScope,
			foundAfterSessionSideEffects ?? foundWithinBoardLock,
			taskSessionSummaryPersistedInWorkspaceSessionsFile,
		);
	};

	// 锁外只读：给「先做会话副作用、再移列」的动作做准入预检用。
	const readTaskCardWithPersistedSessionSummaryOutsideBoardLock = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<
		TaskCardFoundWithBoardColumn & {
			taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
		}
	> => {
		const persistedWorkspaceState = await loadPersistedWorkspaceStateById(workspaceScope.workspaceId);
		const found = findTaskCardWithBoardColumnOrThrowNotFound(
			persistedWorkspaceState.board,
			taskId,
			workspaceScope.workspacePath,
		);
		return {
			...found,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: persistedWorkspaceState.sessions[taskId] ?? null,
		};
	};

	const ensureTaskWorktreeReportingFailure = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskCard: RuntimeBoardCard,
	): Promise<{ ok: true; warningMessage: string | null } | { ok: false; failureMessage: string }> => {
		try {
			const ensured = await deps.workspaceApi.ensureWorktree(workspaceScope, {
				taskId: taskCard.id,
				baseRef: taskCard.baseRef,
				...(taskCard.worktreeMode ? { worktreeMode: taskCard.worktreeMode } : {}),
			});
			if (!ensured.ok) {
				return { ok: false, failureMessage: ensured.error ?? "Could not ensure task worktree." };
			}
			return { ok: true, warningMessage: ensured.warning ?? null };
		} catch (error) {
			return { ok: false, failureMessage: toErrorMessage(error) };
		}
	};

	const startTaskSessionReportingFailure = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskCard: RuntimeBoardCard,
		hints: Parameters<typeof buildTaskSessionStartRequestFromBoardCard>[1],
		failureMessageFallback: string,
	): Promise<{ ok: true; startedSummary: RuntimeTaskSessionSummary } | { ok: false; failureMessage: string }> => {
		try {
			const started = await deps.runtimeApi.startTaskSession(
				workspaceScope,
				buildTaskSessionStartRequestFromBoardCard(taskCard, hints),
			);
			if (!started.ok || !started.summary) {
				return { ok: false, failureMessage: started.error ?? failureMessageFallback };
			}
			return { ok: true, startedSummary: started.summary };
		} catch (error) {
			return { ok: false, failureMessage: toErrorMessage(error) };
		}
	};

	// 停会话是收尾：失败（会话本来就不存在等）只吞不抛，不该让已经移成的卡被报成失败。
	const stopTaskSessionIgnoringFailure = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		sessionTaskId: string,
	): Promise<void> => {
		await deps.runtimeApi.stopTaskSession(workspaceScope, { taskId: sessionTaskId }).catch(() => null);
	};

	// agent 会话（按列门控）与详情 shell 终端（总是）并行停。详情终端的会话 id 形如 `__detail_terminal__:<taskId>`，
	// 同样经 runtime.stopTaskSession 停在 terminal manager 里；不停的话卡片进了 Done / 被删掉，shell 及其后代
	// （dev server 等）还活着。
	const stopTaskAgentSessionAndTaskCardDetailUserShellTerminal = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		boardColumnIdOfTaskCardBeforeAction: RuntimeBoardColumnId,
	): Promise<{ taskAgentSessionStopWasRequested: boolean }> => {
		const taskAgentSessionStopWasRequested = canTaskCardInBoardColumnHostLiveTaskAgentSession(
			boardColumnIdOfTaskCardBeforeAction,
		);
		await Promise.all([
			taskAgentSessionStopWasRequested ? stopTaskSessionIgnoringFailure(workspaceScope, taskId) : Promise.resolve(),
			stopTaskSessionIgnoringFailure(workspaceScope, buildTaskCardDetailUserShellTerminalSessionTaskId(taskId)),
		]);
		return { taskAgentSessionStopWasRequested };
	};

	const deleteTaskWorktreeReportingFailure = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		worktreeMode: RuntimeTaskWorktreeMode | undefined,
	): Promise<RuntimeTaskWorktreeDeletionResultOfTaskCardAction> => {
		try {
			// 删 worktree 不删 task commit provenance：落地数据保全（dd2db Y-PHASE-3），1c 的共享落地判据要读它。
			const deleted = await deps.workspaceApi.deleteWorktree(workspaceScope, {
				taskId,
				...(worktreeMode ? { worktreeMode } : {}),
			});
			return {
				taskWorktreeWasRemoved: deleted.removed,
				taskWorktreeDeletionErrorMessage: deleted.ok ? null : (deleted.error ?? null),
			};
		} catch (error) {
			return { taskWorktreeWasRemoved: false, taskWorktreeDeletionErrorMessage: toErrorMessage(error) };
		}
	};

	const runSeriallyForTaskCards = <TResult>(
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskIds: readonly string[],
		taskCardActionCommand: () => Promise<TResult>,
	): Promise<TResult> =>
		deps.taskCardActionPerTaskCommandSerializer.runTaskCardActionCommandSeriallyForTaskCards(
			workspaceScope.workspaceId,
			taskIds,
			taskCardActionCommand,
		);

	// 恢复失败的回滚：卡片仍在 review（没被别处挪走）才移回 Done，并发挪走的尊重对方。
	// 恢复时若关掉过自动 review，在移回 Done 的同一次写盘里还原成恢复前的开关值：浏览器旧路径 resumeTaskFromTrash
	// 只在续跑成功后才关自动 review，失败时卡片回到 Done、开关原样未动——以它为准，失败的恢复不在卡片上留痕迹。
	// 恢复窗口里开关已被别处改过（不再是恢复写下的 false / "commit"）就尊重对方，不还原。
	const moveTaskCardBackIntoDoneAfterFailedRestore = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		boardMutationInitiator: WebUiBoardMutationInitiator | undefined,
		foundWithinRestoreBoardLock: TaskCardFoundWithBoardColumn,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null,
		autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview: AutoReviewSettingsOfTaskCard | null,
	): Promise<RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries> => {
		const rollback = await mutateWorkspaceState<TaskCardFoundWithBoardColumn | null>(
			workspaceScope.workspacePath,
			await resolveIntent(
				"move_task_card_back_into_done_after_failed_restore",
				kanbanRequestOriginActorEvidence,
				boardMutationInitiator,
				[taskId],
			),
			(state) => {
				const found = findTaskCardWithBoardColumn(state.board, taskId);
				if (!found || found.boardColumnId !== "review") {
					return { board: state.board, value: found, save: false };
				}
				const movedBack = moveTaskToColumn(state.board, taskId, "trash");
				if (!movedBack.moved || !movedBack.task) {
					return { board: state.board, value: found, save: false };
				}
				const movedBackWithoutAutoReviewRestoration = {
					board: movedBack.board,
					value: { taskCard: movedBack.task, boardColumnId: "trash" as const },
				};
				const autoReviewSettingsAreStillThoseWrittenByRestore =
					movedBack.task.autoReviewEnabled === false && movedBack.task.autoReviewMode === "commit";
				if (
					!autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview ||
					!autoReviewSettingsAreStillThoseWrittenByRestore
				) {
					return movedBackWithoutAutoReviewRestoration;
				}
				const autoReviewRestored = updateTask(
					movedBack.board,
					taskId,
					buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(
						movedBack.task,
						autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview,
					),
				);
				if (!autoReviewRestored.updated || !autoReviewRestored.task) {
					return movedBackWithoutAutoReviewRestoration;
				}
				return {
					board: autoReviewRestored.board,
					value: { taskCard: autoReviewRestored.task, boardColumnId: "trash" },
				};
			},
		);
		broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, rollback.saved);
		return buildTaskCardSnapshot(
			workspaceScope,
			rollback.value ?? foundWithinRestoreBoardLock,
			taskSessionSummaryPersistedInWorkspaceSessionsFile,
		);
	};

	return {
		readTaskCardWithBoardColumn: async (workspaceScope, input) => {
			const persistedWorkspaceState = await loadPersistedWorkspaceStateById(workspaceScope.workspaceId);
			const found = findTaskCardWithBoardColumn(persistedWorkspaceState.board, input.taskId);
			if (!found) {
				return { taskCardLookupOutcome: "task_card_not_found_on_workspace_board", lookedUpTaskId: input.taskId };
			}
			return {
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: buildTaskCardSnapshot(
					workspaceScope,
					found,
					persistedWorkspaceState.sessions[input.taskId] ?? null,
				),
			};
		},

		startTaskCardAgentSessionMovingItIntoInProgress: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				const taskMutationIntent = await resolveIntent(
					"start_agent_session_moving_task_card_into_in_progress",
					kanbanRequestOriginActorEvidence,
					input.boardMutationInitiator,
					[input.taskId],
				);
				// 先移列、再起会话：与浏览器一致，也守住「backlog 单向」——启动失败后卡留在 in_progress，
				// 会话状态与错误保持可见，而不是悄悄回到 backlog 像从没点过。
				const movement = await mutateWorkspaceState<{
					foundAfterMovement: TaskCardFoundWithBoardColumn;
					boardColumnIdOfTaskCardBeforeAction: RuntimeBoardColumnId;
					taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
				}>(workspaceScope.workspacePath, taskMutationIntent, (state) => {
					const found = findTaskCardWithBoardColumnOrThrowNotFound(
						state.board,
						input.taskId,
						workspaceScope.workspacePath,
					);
					if (found.boardColumnId !== "backlog" && found.boardColumnId !== "in_progress") {
						throw createTaskCardInBoardColumnNotAllowingActionError(
							`Task "${input.taskId}" is in "${found.boardColumnId}" and can only be started from backlog or in_progress.`,
						);
					}
					const taskSessionSummaryPersistedInWorkspaceSessionsFile = state.sessions[input.taskId] ?? null;
					if (found.boardColumnId === "in_progress") {
						// 本来就在 in_progress：没有卡片级变化，不写盘、不产生空事件批次。
						return {
							board: state.board,
							value: {
								foundAfterMovement: found,
								boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
								taskSessionSummaryPersistedInWorkspaceSessionsFile,
							},
							save: false,
						};
					}
					const moved = moveTaskToColumn(state.board, input.taskId, "in_progress", undefined, {
						insertAtIndex: input.insertAtIndexWithinInProgressBoardColumn,
					});
					if (!moved.moved || !moved.task) {
						throw new TRPCError({
							code: "INTERNAL_SERVER_ERROR",
							message: `Task "${input.taskId}" could not be moved to in_progress.`,
						});
					}
					return {
						board: moved.board,
						value: {
							foundAfterMovement: { taskCard: moved.task, boardColumnId: "in_progress" },
							boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
						},
					};
				});
				broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, movement.saved);
				const { foundAfterMovement, boardColumnIdOfTaskCardBeforeAction } = movement.value;
				const taskSessionSummaryPersistedInWorkspaceSessionsFile =
					movement.value.taskSessionSummaryPersistedInWorkspaceSessionsFile;
				const buildResponse = async (
					outcome: Pick<
						RuntimeTaskCardActionStartAgentSessionResponse,
						| "agentSessionStartOutcome"
						| "agentSessionStartFailureMessage"
						| "ensuredTaskWorktreeWarningMessage"
						| "startedAgentSessionSummary"
					>,
				): Promise<RuntimeTaskCardActionStartAgentSessionResponse> => ({
					boardColumnIdOfTaskCardBeforeAction,
					taskCardWasMovedIntoInProgressColumnByThisAction: movement.saved,
					...outcome,
					taskCardSnapshotAfterAction: await rereadTaskCardSnapshotAfterSessionSideEffects(
						workspaceScope,
						foundAfterMovement,
						taskSessionSummaryPersistedInWorkspaceSessionsFile,
					),
				});

				// 已在 agent 回合（旧 state==="running" ⟺ facet turnOwner==="agent"）就不重复启动：双击「开始」、
				// 或 CLI 对一张正在跑的卡再 start 一次，都不该以原 prompt 再起一段新对话。
				// EXPERIMENT_NODE: in_progress 卡已有「非 agent 回合」的真实会话（中断 / 等审查）时，是沿用 CLI 旧规则以原 prompt
				// 新起会话，还是像浏览器 handleStartTask 那样只放行「从没启动过」的卡、其余交给续跑路径。
				//
				// 判据只采信 runtime 内存里的摘要，**绝不**退回 sessions.json 的持久化摘要：盘上那条是写入那一刻的快照，
				// runtime 重启后仍可能声称 agent 回合 / live，而进程早已随旧 runtime 消失。加载过的项目，内存摘要已经过
				// hydrate 时的「不可恢复进程归零」对账；没加载的项目在本 runtime 里不可能有活会话（内存查询为 null），
				// 放行即可——startTaskSession 会自己加载该项目的会话管理器（同一条 hydrate 对账），不会与盘上状态冲突。
				// 采信持久化摘要会让重启后对未加载项目的卡 start 被静默跳过：卡留在 in_progress、却没有会话。
				const existingTaskSessionSummaryLiveInRuntimeProcessMemory =
					deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(workspaceScope.workspaceId, input.taskId);
				if (
					existingTaskSessionSummaryLiveInRuntimeProcessMemory &&
					resolveSessionFacets(existingTaskSessionSummaryLiveInRuntimeProcessMemory).turnOwner === "agent"
				) {
					return await buildResponse({
						agentSessionStartOutcome: "agent_session_already_in_agent_turn_so_start_was_skipped",
						agentSessionStartFailureMessage: null,
						ensuredTaskWorktreeWarningMessage: null,
						startedAgentSessionSummary: null,
					});
				}

				// startTaskSession 自己也会在 worktree 缺失时建它（resolveExistingTaskCwdOrEnsure），但对**已存在**的
				// worktree 不同步 ignored path / 项目本地 agent 配置、不回传 warning、失败时也不记启动诊断——
				// 所以仍先显式 ensure（与浏览器、迁移前 CLI 一致）。
				const ensured = await ensureTaskWorktreeReportingFailure(workspaceScope, foundAfterMovement.taskCard);
				if (!ensured.ok) {
					return await buildResponse({
						agentSessionStartOutcome: "task_worktree_ensure_failed",
						agentSessionStartFailureMessage: ensured.failureMessage,
						ensuredTaskWorktreeWarningMessage: null,
						startedAgentSessionSummary: null,
					});
				}
				const started = await startTaskSessionReportingFailure(
					workspaceScope,
					foundAfterMovement.taskCard,
					{ agentTerminalGeometryForTaskSessionSpawn: input.agentTerminalGeometryForTaskSessionSpawn },
					"Could not start task session.",
				);
				if (!started.ok) {
					return await buildResponse({
						agentSessionStartOutcome: "agent_session_start_failed",
						agentSessionStartFailureMessage: started.failureMessage,
						ensuredTaskWorktreeWarningMessage: ensured.warningMessage,
						startedAgentSessionSummary: null,
					});
				}
				return await buildResponse({
					agentSessionStartOutcome: "agent_session_started",
					agentSessionStartFailureMessage: null,
					ensuredTaskWorktreeWarningMessage: ensured.warningMessage,
					startedAgentSessionSummary: started.startedSummary,
				});
			}),

		moveTaskCardIntoReviewByHandingTurnToUser: async (workspaceScope, input, kanbanRequestOriginActorEvidence) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				// 锁外预检：翻了回合却移不了列，会留下「用户回合却挂在 in_progress」的卡（浏览器的 review-bounce 不会
				// 再把它拉回，因为要求 turnOwner=agent）。所以只有 in_progress 的卡才去翻回合。
				const foundBeforeHandoff = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
					workspaceScope,
					input.taskId,
				);
				if (foundBeforeHandoff.boardColumnId !== "in_progress") {
					throw createTaskCardInBoardColumnNotAllowingActionError(
						`Task "${input.taskId}" is in "${foundBeforeHandoff.boardColumnId}" and can only be moved to review from in_progress.`,
					);
				}
				const handoff = await deps.runtimeApi
					.transitionTaskToReview(workspaceScope, { taskId: input.taskId })
					.catch((error: unknown) => ({ ok: false, summary: null, error: toErrorMessage(error) }));
				if (!handoff.ok) {
					return {
						agentTurnHandoffToUserOutcome: "agent_turn_handoff_to_user_failed",
						agentTurnHandoffToUserFailureMessage: handoff.error ?? "Could not hand the agent turn to the user.",
						taskCardWasMovedIntoReviewColumnByThisAction: false,
						taskCardSnapshotAfterAction: buildTaskCardSnapshot(
							workspaceScope,
							foundBeforeHandoff,
							foundBeforeHandoff.taskSessionSummaryPersistedInWorkspaceSessionsFile,
						),
					};
				}
				// 跨项目时没有浏览器在跑列自动流转（Rule A），回合翻过来之后必须显式移列。
				const movement = await mutateWorkspaceState<{
					foundAfterMovement: TaskCardFoundWithBoardColumn;
					taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
				}>(
					workspaceScope.workspacePath,
					await resolveIntent(
						"move_task_card_into_review_handing_agent_turn_to_user",
						kanbanRequestOriginActorEvidence,
						input.boardMutationInitiator,
						[input.taskId],
					),
					(state) => {
						const found = findTaskCardWithBoardColumnOrThrowNotFound(
							state.board,
							input.taskId,
							workspaceScope.workspacePath,
						);
						const taskSessionSummaryPersistedInWorkspaceSessionsFile = state.sessions[input.taskId] ?? null;
						// 已在 review（浏览器的列自动流转抢先一步）或已被挪到别处：尊重现状，不再移。
						if (found.boardColumnId !== "in_progress") {
							return {
								board: state.board,
								value: { foundAfterMovement: found, taskSessionSummaryPersistedInWorkspaceSessionsFile },
								save: false,
							};
						}
						const moved = moveTaskToColumn(state.board, input.taskId, "review");
						if (!moved.moved || !moved.task) {
							return {
								board: state.board,
								value: { foundAfterMovement: found, taskSessionSummaryPersistedInWorkspaceSessionsFile },
								save: false,
							};
						}
						return {
							board: moved.board,
							value: {
								foundAfterMovement: { taskCard: moved.task, boardColumnId: "review" },
								taskSessionSummaryPersistedInWorkspaceSessionsFile,
							},
						};
					},
				);
				broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, movement.saved);
				return {
					agentTurnHandoffToUserOutcome: "agent_turn_handed_to_user",
					agentTurnHandoffToUserFailureMessage: null,
					taskCardWasMovedIntoReviewColumnByThisAction: movement.saved,
					taskCardSnapshotAfterAction: buildTaskCardSnapshot(
						workspaceScope,
						movement.value.foundAfterMovement,
						movement.value.taskSessionSummaryPersistedInWorkspaceSessionsFile,
					),
				};
			}),

		moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				const movement = await mutateWorkspaceState<{
					foundAfterMovement: TaskCardFoundWithBoardColumn;
					boardColumnIdOfTaskCardBeforeAction: RuntimeBoardColumnId;
					taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
				}>(
					workspaceScope.workspacePath,
					await resolveIntent(
						"move_task_card_between_non_trash_columns_without_session_side_effects",
						kanbanRequestOriginActorEvidence,
						input.boardMutationInitiator,
						[input.taskId],
					),
					(state) => {
						const found = findTaskCardWithBoardColumnOrThrowNotFound(
							state.board,
							input.taskId,
							workspaceScope.workspacePath,
						);
						if (
							!isTaskCardBoardPlacementChangeAllowedWithoutSessionSideEffects(
								found.boardColumnId,
								input.targetBoardColumnId,
							)
						) {
							throw createTaskCardInBoardColumnNotAllowingActionError(
								`Task "${input.taskId}" cannot be moved from "${found.boardColumnId}" to "${input.targetBoardColumnId}" without session side effects.`,
							);
						}
						const unchanged = {
							board: state.board,
							value: {
								foundAfterMovement: found,
								boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
								taskSessionSummaryPersistedInWorkspaceSessionsFile: state.sessions[input.taskId] ?? null,
							},
							save: false,
						};
						if (found.boardColumnId === input.targetBoardColumnId) {
							if (input.insertAtIndexWithinTargetBoardColumn === undefined) {
								return unchanged;
							}
							const reordered = reorderTaskWithinBoardColumn(
								state.board,
								input.taskId,
								input.insertAtIndexWithinTargetBoardColumn,
							);
							return reordered.reordered ? { ...unchanged, board: reordered.board, save: true } : unchanged;
						}
						const moved = moveTaskToColumn(state.board, input.taskId, input.targetBoardColumnId, undefined, {
							insertAtIndex: input.insertAtIndexWithinTargetBoardColumn,
						});
						if (!moved.moved || !moved.task) {
							throw new TRPCError({
								code: "INTERNAL_SERVER_ERROR",
								message: `Task "${input.taskId}" could not be moved to ${input.targetBoardColumnId}.`,
							});
						}
						return {
							board: moved.board,
							value: {
								...unchanged.value,
								foundAfterMovement: { taskCard: moved.task, boardColumnId: input.targetBoardColumnId },
							},
						};
					},
				);
				broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, movement.saved);
				return {
					boardColumnIdOfTaskCardBeforeAction: movement.value.boardColumnIdOfTaskCardBeforeAction,
					taskCardPlacementWasChangedByThisAction: movement.saved,
					taskCardSnapshotAfterAction: buildTaskCardSnapshot(
						workspaceScope,
						movement.value.foundAfterMovement,
						movement.value.taskSessionSummaryPersistedInWorkspaceSessionsFile,
					),
				};
			}),

		moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(
				workspaceScope,
				[input.taskId],
				async (): Promise<RuntimeTaskCardActionMoveIntoDoneResponse> => {
					const movement = await mutateWorkspaceState<{
						foundAfterMovement: TaskCardFoundWithBoardColumn;
						boardColumnIdOfTaskCardBeforeAction: RuntimeBoardColumnId;
						taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
					}>(
						workspaceScope.workspacePath,
						await resolveIntent(
							"move_task_card_into_done",
							kanbanRequestOriginActorEvidence,
							input.boardMutationInitiator,
							[input.taskId],
						),
						(state) => {
							const found = findTaskCardWithBoardColumnOrThrowNotFound(
								state.board,
								input.taskId,
								workspaceScope.workspacePath,
							);
							const taskSessionSummaryPersistedInWorkspaceSessionsFile = state.sessions[input.taskId] ?? null;
							if (found.boardColumnId === "trash") {
								return {
									board: state.board,
									value: {
										foundAfterMovement: found,
										boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
										taskSessionSummaryPersistedInWorkspaceSessionsFile,
									},
									save: false,
								};
							}
							const trashed = moveTaskToColumn(state.board, input.taskId, "trash", undefined, {
								insertAtIndex: input.insertAtIndexWithinDoneBoardColumn,
							});
							if (!trashed.moved || !trashed.task) {
								throw new TRPCError({
									code: "INTERNAL_SERVER_ERROR",
									message: `Task "${input.taskId}" could not be moved to done.`,
								});
							}
							return {
								board: trashed.board,
								value: {
									foundAfterMovement: { taskCard: trashed.task, boardColumnId: "trash" },
									boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
									taskSessionSummaryPersistedInWorkspaceSessionsFile,
								},
							};
						},
					);
					broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, movement.saved);
					const { foundAfterMovement, boardColumnIdOfTaskCardBeforeAction } = movement.value;
					const taskSessionSummaryPersistedInWorkspaceSessionsFile =
						movement.value.taskSessionSummaryPersistedInWorkspaceSessionsFile;
					// 本来就在 Done：不再停会话、不删 worktree。会话中断自动流转进 Done 的卡刻意保留了 worktree 供恢复，
					// 对它重复「移入 Done」不该把这份保留删掉。
					if (!movement.saved) {
						return {
							boardColumnIdOfTaskCardBeforeAction,
							taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: true,
							taskAgentSessionStopWasRequested: false,
							taskWorktreeDeletionResult: null,
							taskCardSnapshotAfterAction: buildTaskCardSnapshot(
								workspaceScope,
								foundAfterMovement,
								taskSessionSummaryPersistedInWorkspaceSessionsFile,
							),
						};
					}
					const { taskAgentSessionStopWasRequested } =
						await stopTaskAgentSessionAndTaskCardDetailUserShellTerminal(
							workspaceScope,
							input.taskId,
							boardColumnIdOfTaskCardBeforeAction,
						);
					const taskWorktreeDeletionResult = await deleteTaskWorktreeReportingFailure(
						workspaceScope,
						input.taskId,
						foundAfterMovement.taskCard.worktreeMode,
					);
					return {
						boardColumnIdOfTaskCardBeforeAction,
						taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
						taskAgentSessionStopWasRequested,
						taskWorktreeDeletionResult,
						taskCardSnapshotAfterAction: buildTaskCardSnapshot(
							workspaceScope,
							foundAfterMovement,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
						),
					};
				},
			),

		restoreTaskCardFromDoneIntoReviewResumingAgentSession: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(
				workspaceScope,
				[input.taskId],
				async (): Promise<RuntimeTaskCardActionRestoreFromDoneResponse> => {
					const restoration = await mutateWorkspaceState<{
						foundAfterMovement: TaskCardFoundWithBoardColumn;
						taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
						autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview: AutoReviewSettingsOfTaskCard | null;
					}>(
						workspaceScope.workspacePath,
						await resolveIntent(
							"restore_task_card_from_done_into_review",
							kanbanRequestOriginActorEvidence,
							input.boardMutationInitiator,
							[input.taskId],
						),
						(state) => {
							const found = findTaskCardWithBoardColumnOrThrowNotFound(
								state.board,
								input.taskId,
								workspaceScope.workspacePath,
							);
							if (found.boardColumnId !== "trash") {
								throw createTaskCardInBoardColumnNotAllowingActionError(
									`Task "${input.taskId}" is in "${found.boardColumnId}" and can only be restored from done.`,
								);
							}
							const restored = moveTaskToColumn(state.board, input.taskId, "review", undefined, {
								insertAtIndex: input.insertAtIndexWithinReviewBoardColumn,
							});
							if (!restored.moved || !restored.task) {
								throw new TRPCError({
									code: "INTERNAL_SERVER_ERROR",
									message: `Task "${input.taskId}" could not be moved from done to review.`,
								});
							}
							const taskSessionSummaryPersistedInWorkspaceSessionsFile = state.sessions[input.taskId] ?? null;
							const restoredWithoutAutoReviewChange = {
								board: restored.board,
								value: {
									foundAfterMovement: { taskCard: restored.task, boardColumnId: "review" as const },
									taskSessionSummaryPersistedInWorkspaceSessionsFile,
									autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview: null,
								},
							};
							// 恢复出来的卡关掉自动 review 动作（与浏览器 resumeTaskFromTrash 一致）：否则它一回到 review
							// 就会被自动提交 / 自动开 PR 再次带进 Done。必须与移回 review 在**同一次写盘**里关：这次写盘一广播，
							// 浏览器的 useReviewAutoActions 就看得到这张 review 卡，而锁外的 ensure + 续跑常常超过它 500ms 的
							// 触发延迟——等续跑成功再关，中间广播出去的就是一张开着自动动作的 review 卡。只在确实开着时改。
							if (restored.task.autoReviewEnabled !== true) {
								return restoredWithoutAutoReviewChange;
							}
							const autoReviewDisabled = updateTask(
								restored.board,
								input.taskId,
								buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(restored.task, {
									autoReviewEnabled: false,
									autoReviewMode: "commit",
								}),
							);
							if (!autoReviewDisabled.updated || !autoReviewDisabled.task) {
								return restoredWithoutAutoReviewChange;
							}
							return {
								board: autoReviewDisabled.board,
								value: {
									foundAfterMovement: { taskCard: autoReviewDisabled.task, boardColumnId: "review" },
									taskSessionSummaryPersistedInWorkspaceSessionsFile,
									autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview: {
										autoReviewEnabled: restored.task.autoReviewEnabled,
										autoReviewMode: restored.task.autoReviewMode,
									},
								},
							};
						},
					);
					broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, restoration.saved);
					const {
						foundAfterMovement,
						taskSessionSummaryPersistedInWorkspaceSessionsFile,
						autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview,
					} = restoration.value;
					const respondWithRestoreFailureAfterMovingBackIntoDone = async (
						taskCardRestoreFromDoneOutcome: Exclude<
							RuntimeTaskCardRestoreFromDoneOutcome,
							"agent_session_resumed_and_task_card_kept_in_review"
						>,
						taskCardRestoreFromDoneFailureMessage: string,
						ensuredTaskWorktreeWarningMessage: string | null,
					): Promise<RuntimeTaskCardActionRestoreFromDoneResponse> => ({
						taskCardRestoreFromDoneOutcome,
						taskCardRestoreFromDoneFailureMessage,
						ensuredTaskWorktreeWarningMessage,
						resumedAgentSessionSummary: null,
						taskCardSnapshotAfterAction: await moveTaskCardBackIntoDoneAfterFailedRestore(
							workspaceScope,
							input.taskId,
							kanbanRequestOriginActorEvidence,
							input.boardMutationInitiator,
							foundAfterMovement,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
							autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview,
						),
					});

					const ensured = await ensureTaskWorktreeReportingFailure(workspaceScope, foundAfterMovement.taskCard);
					if (!ensured.ok) {
						return await respondWithRestoreFailureAfterMovingBackIntoDone(
							"task_worktree_ensure_failed_so_task_card_was_moved_back_into_done",
							ensured.failureMessage,
							null,
						);
					}
					const resumed = await startTaskSessionReportingFailure(
						workspaceScope,
						foundAfterMovement.taskCard,
						{
							resumeFromTrash: true,
							agentTerminalGeometryForTaskSessionSpawn: input.agentTerminalGeometryForTaskSessionSpawn,
						},
						"Could not resume task session.",
					);
					if (!resumed.ok) {
						return await respondWithRestoreFailureAfterMovingBackIntoDone(
							"agent_session_resume_failed_so_task_card_was_moved_back_into_done",
							resumed.failureMessage,
							ensured.warningMessage,
						);
					}

					return {
						taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
						taskCardRestoreFromDoneFailureMessage: null,
						ensuredTaskWorktreeWarningMessage: ensured.warningMessage,
						resumedAgentSessionSummary: resumed.startedSummary,
						taskCardSnapshotAfterAction: await rereadTaskCardSnapshotAfterSessionSideEffects(
							workspaceScope,
							foundAfterMovement,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
						),
					};
				},
			),

		permanentlyDeleteTaskCardsWithFullResourceCleanup: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) => {
			const selection = input.permanentlyDeletedTaskCardSelection;
			// 串行键 = 会被删的卡。按 id 选中时就是那些 id；整列时锁外预读那一列，选择语义是「发起删除那一刻该列里的卡」：
			// 锁内只删「执行时仍在该列、且在预读集合里」的卡。预读之后才进列的卡没有取得串行权——它自己的生命周期命令
			// （例如 start）可能正挂在锁外 ensure worktree / 起会话；连它一起删，那条命令放行后照样会为已删除的任务建出
			// worktree、起出看板上管不到的 agent 进程。所以这次不删它：它仍在看板上可见，用户可以再清一次。
			const subjectTaskIdsOfTaskCardAction =
				selection.permanentlyDeletedTaskCardSelectionKind === "task_cards_selected_by_task_id"
					? [...new Set(selection.selectedTaskIds)]
					: ((await loadWorkspaceBoardById(workspaceScope.workspaceId)).columns
							.find((column) => column.id === selection.selectedBoardColumnId)
							?.cards.map((taskCard) => taskCard.id) ?? []);
			const subjectTaskIdSetHoldingPerTaskCommandSerialization = new Set(subjectTaskIdsOfTaskCardAction);
			return await runSeriallyForTaskCards(
				workspaceScope,
				subjectTaskIdsOfTaskCardAction,
				async (): Promise<RuntimeTaskCardActionPermanentlyDeleteResponse> => {
					const deletion = await mutateWorkspaceState<
						Array<
							TaskCardFoundWithBoardColumn & {
								taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
							}
						>
					>(
						workspaceScope.workspacePath,
						await resolveIntent(
							"permanently_delete_task_cards",
							kanbanRequestOriginActorEvidence,
							input.boardMutationInitiator,
							subjectTaskIdsOfTaskCardAction,
						),
						(state) => {
							const selectedTaskCards: TaskCardFoundWithBoardColumn[] =
								selection.permanentlyDeletedTaskCardSelectionKind === "task_cards_selected_by_task_id"
									? [...new Set(selection.selectedTaskIds)].map((taskId) =>
											findTaskCardWithBoardColumnOrThrowNotFound(
												state.board,
												taskId,
												workspaceScope.workspacePath,
											),
										)
									: (
											state.board.columns.find((column) => column.id === selection.selectedBoardColumnId)
												?.cards ?? []
										)
											.filter((taskCard) =>
												subjectTaskIdSetHoldingPerTaskCommandSerialization.has(taskCard.id),
											)
											.map((taskCard) => ({ taskCard, boardColumnId: selection.selectedBoardColumnId }));
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
									.map((found) => ({
										...found,
										taskSessionSummaryPersistedInWorkspaceSessionsFile:
											state.sessions[found.taskCard.id] ?? null,
									})),
							};
						},
					);
					broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, deletion.saved);
					const permanentlyDeletedTaskCards = deletion.value;
					const deletedTaskIds = permanentlyDeletedTaskCards.map(({ taskCard }) => taskCard.id);
					if (deletedTaskIds.length === 0) {
						return { permanentlyDeletedTaskCards: [] };
					}

					// 任务本体没了之后，它的编辑草稿与落败副本再也没有可以认领的地方——界面上连打开它的入口都不存在了。
					await discardTaskEditDraftsForDeletedTasks(workspaceScope.workspaceId, deletedTaskIds);
					// 排队 prompt 同理，而且更要紧：它们是待执行的机器动作，不是资产。留着只会在同 id 的任务被恢复时突然发射。
					// 丢完立刻通知 runtime 里的出队引擎重读并重发投影，不等下一次兜底 sweep。失败只记不抛：条目 24h 后自然过期。
					try {
						const queuedTaskPromptDeliverySnapshotAfterDiscard = await discardQueuedTaskPromptDeliveriesForTasks({
							workspaceId: workspaceScope.workspaceId,
							taskIds: deletedTaskIds,
						});
						deps.onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards?.(
							workspaceScope.workspaceId,
							queuedTaskPromptDeliverySnapshotAfterDiscard,
						);
					} catch {
						// 见上。
					}

					await Promise.all(
						permanentlyDeletedTaskCards.map(
							async ({ taskCard, boardColumnId }) =>
								await stopTaskAgentSessionAndTaskCardDetailUserShellTerminal(
									workspaceScope,
									taskCard.id,
									boardColumnId,
								),
						),
					);

					const taskWorktreeDeletionResults = await Promise.all(
						permanentlyDeletedTaskCards.map(
							async ({ taskCard }) =>
								await deleteTaskWorktreeReportingFailure(workspaceScope, taskCard.id, taskCard.worktreeMode),
						),
					);

					// 批删全部 turn checkpoint ref（姊妹蓝图 §1.4：存续期全量保留，永久删除时按前缀批删）。
					// 顺序铁律：必须排在会话停止与 worktree 清理**之后**。hooks-api 的 to_review checkpoint 捕获是
					// runtime 侧不 await 的后台任务（hooks-api.ts F1），若先批删，枚举完成后在途捕获仍可能
					// update-ref，给已删除任务留下再无清理方的孤儿 ref。会话停止切断新 hook 来源（任务已从看板
					// 移除，transition 失败也不会再派生新捕获），批删放到最后给在途捕获最大收敛窗口。
					// 残余窗口：这里无法 await runtime 侧已派生的在途捕获，理论上仍可能有批删后才落定的孤儿 ref——
					// 与草稿清理同一套失败语义：这是删除已成之后的收尾，失败只吞不抛，残留几个无人认领的 ref，
					// 不该让已经删成的任务被报成失败。
					for (const taskId of deletedTaskIds) {
						try {
							await deleteAllTaskTurnCheckpointRefs({ cwd: workspaceScope.workspacePath, taskId });
						} catch {
							// 收尾清理，best-effort。
						}
					}

					return {
						permanentlyDeletedTaskCards: permanentlyDeletedTaskCards.map((deleted, index) => ({
							deletedTaskCard: deleted.taskCard,
							boardColumnIdOfDeletedTaskCardBeforeDeletion: deleted.boardColumnId,
							taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion:
								deleted.taskSessionSummaryPersistedInWorkspaceSessionsFile,
							taskWorktreeDeletionResult: taskWorktreeDeletionResults[index] ?? {
								taskWorktreeWasRemoved: false,
								taskWorktreeDeletionErrorMessage: null,
							},
						})),
					};
				},
			);
		},

		renameCurrentTask: async (workspaceScope, input, evidence) => {
			const intent = await resolveIntent("update_task_card_field_values", evidence, undefined, []);
			const actor = intent.resolvedKanbanActor;
			if (
				actor.kanbanActorKind !== "kanban_board_card_work_unit" ||
				actor.actingKanbanBoardCardWorkUnit.workspaceId !== workspaceScope.workspaceId
			) {
				throw new TRPCError({ code: "FORBIDDEN", message: "当前调用环境没有可解析的 Kanban Task 身份。" });
			}
			const identity = actor.actingKanbanBoardCardWorkUnit;
			const renamed = await mutateWorkspaceState<RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries>(
				workspaceScope.workspacePath,
				intent,
				(state) => {
					const found = findTaskCardWithBoardColumnOrThrowNotFound(
						state.board,
						identity.taskId,
						workspaceScope.workspacePath,
					);
					if (found.taskCard.createdAt !== identity.taskIncarnationCreatedAtEpochMs) {
						throw new TRPCError({ code: "FORBIDDEN", message: "当前 Task 身份已失效。" });
					}
					const snapshot = () =>
						buildTaskCardSnapshot(workspaceScope, found, state.sessions[identity.taskId] ?? null);
					if (found.taskCard.title === input.title) return { board: state.board, value: snapshot(), save: false };
					const timestamp = Date.now();
					const updated = updateTask(
						state.board,
						identity.taskId,
						buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(found.taskCard, {
							title: input.title,
							taskCommentEntries: [
								...(found.taskCard.taskCommentEntries ?? []),
								{
									taskCommentEntryId: randomUUID(),
									commentText: `Agent 自行改名：${found.taskCard.title} → ${input.title}\n原因：${input.reason}\n时间：${new Date(timestamp).toISOString()}`,
									createdAt: timestamp,
									updatedAt: timestamp,
								},
							],
						}),
					);
					return {
						board: updated.board,
						value: buildTaskCardSnapshot(
							workspaceScope,
							{ ...found, taskCard: updated.task ?? found.taskCard },
							state.sessions[identity.taskId] ?? null,
						),
					};
				},
			);
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, renamed.saved);
			return { taskCardSnapshotAfterAction: renamed.value };
		},

		// 不进按卡串行器：纯 board 字段编辑在 board 锁内对最新卡片合并，与进行中的启动 / 移入 Done 不冲突；
		// 排在一次慢启动（建 worktree 可达十几秒）后面只会让改名、置顶显得卡顿。
		// EXPERIMENT_NODE: 改字段 / 置顶是否也进按卡串行器（换「启动途中改的 prompt 不会被这次启动读到」的确定性，代价是编辑卡顿）。
		updateTaskCardFieldValues: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			const update = await mutateWorkspaceState<RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries>(
				workspaceScope.workspacePath,
				await resolveIntent(
					"update_task_card_field_values",
					kanbanRequestOriginActorEvidence,
					input.boardMutationInitiator,
					[input.taskId],
				),
				(state) => {
					const found = findTaskCardWithBoardColumnOrThrowNotFound(
						state.board,
						input.taskId,
						workspaceScope.workspacePath,
					);
					const expected = input.expectedTaskTitleAndPromptForAiNameBackfill;
					if (expected && (found.taskCard.title !== expected.title || found.taskCard.prompt !== expected.prompt)) {
						return {
							board: state.board,
							value: buildTaskCardSnapshot(workspaceScope, found, state.sessions[input.taskId] ?? null),
							save: false,
						};
					}
					// 与卡片**最新**现值合并：updateTask 里非三态的字段漏传会被复位，所以必须在同一把锁内回填。
					const updated = runPureTaskBoardMutationRejectingInvalidInputAsBadRequest(() =>
						updateTask(
							state.board,
							input.taskId,
							resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(
								found.taskCard,
								input.taskCardFieldUpdate,
							),
						),
					);
					if (!updated.updated || !updated.task) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Task "${input.taskId}" could not be updated.`,
						});
					}
					return {
						board: updated.board,
						value: buildTaskCardSnapshot(
							workspaceScope,
							{ taskCard: updated.task, boardColumnId: found.boardColumnId },
							state.sessions[input.taskId] ?? null,
						),
					};
				},
			);
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, update.saved);
			return { taskCardSnapshotAfterAction: update.value };
		},

		// 同 updateTaskCardFieldValues，不进按卡串行器。与浏览器 setBoard 用同一组纯函数（src/core/task-pinboard-pinning.ts）。
		setTaskPinboardPinStateOfTaskCard: async (workspaceScope, input, kanbanRequestOriginActorEvidence) => {
			const pinning = await mutateWorkspaceState<RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries>(
				workspaceScope.workspacePath,
				await resolveIntent(
					input.taskPinboardPinAction === "unpin_task_card"
						? "unpin_task_card_from_task_pinboard"
						: "pin_task_card_to_task_pinboard_or_update_pin_reason",
					kanbanRequestOriginActorEvidence,
					input.boardMutationInitiator,
					[input.taskId],
				),
				(state) => {
					const found = findTaskCardWithBoardColumnOrThrowNotFound(
						state.board,
						input.taskId,
						workspaceScope.workspacePath,
					);
					const taskSessionSummaryPersistedInWorkspaceSessionsFile = state.sessions[input.taskId] ?? null;
					const mutation =
						input.taskPinboardPinAction === "unpin_task_card"
							? unpinTaskFromTaskPinboard(state.board, input.taskId)
							: pinTaskToTaskPinboard(state.board, input.taskId, {
									pinReason: input.taskPinboardPinReason,
								});
					const foundAfterPinning = mutation.updated
						? findTaskCardWithBoardColumn(mutation.board, input.taskId)
						: null;
					if (!foundAfterPinning) {
						return {
							board: state.board,
							value: buildTaskCardSnapshot(
								workspaceScope,
								found,
								taskSessionSummaryPersistedInWorkspaceSessionsFile,
							),
							save: false,
						};
					}
					return {
						board: mutation.board,
						value: buildTaskCardSnapshot(
							workspaceScope,
							foundAfterPinning,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
						),
					};
				},
			);
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, pinning.saved);
			return { boardWasSaved: pinning.saved, taskCardSnapshotAfterAction: pinning.value };
		},
	};
}
