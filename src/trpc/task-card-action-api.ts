import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setTimeout as waitForProcessExit } from "node:timers/promises";
import { TRPCError } from "@trpc/server";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskCardActionMoveIntoDoneRequest,
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
import { runtimeTaskCardActionMoveIntoDoneRequestSchema } from "../core/api-contract";
import type { WebUiBoardMutationInitiator } from "../core/kanban-web-ui-page-load-request-origin-nonce";
import { POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX } from "../core/post-deploy-verification-done-entry-closure-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { projectTaskBoardAfterAcceptedMainConversationInput } from "../core/task-board-accepted-agent-conversation-input";
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
import {
	type TaskClosureRecord,
	taskClosureDetailsSchema,
	taskClosureRequestSchema,
} from "../core/task-closure-contract";
import {
	resolveMainTaskConversationSessionId,
	resolveMainTaskConversationSessionSummaryForTaskId,
} from "../core/task-main-conversation-session-binding";
import { pinTaskToTaskPinboard, unpinTaskFromTaskPinboard } from "../core/task-pinboard-pinning";
import { buildTaskSessionStartRequestFromBoardCard } from "../core/task-session-start-request-from-board-card";
import { isTaskCardShelved, setTaskCardShelvingState } from "../core/task-shelving-state";
import { applyTaskStickerEntryMutationToTaskCard } from "../core/task-sticker-entry-mutation";
import { buildTaskCardDetailUserShellTerminalSessionTaskId } from "../core/user-shell-terminal-session-task-id";
import type {
	authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone,
	finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone,
	revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed,
} from "../deployment/post-deploy-verification-done-entry-gate";
import { assertSourceGitWorkingStateMatchesSnapshot } from "../independent-task-creation/git-working-state-snapshot";
import { assertIndependentTaskSourceLandedBeforeInitialStart } from "../independent-task-creation/source-task-landing-gate";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import {
	recoverPendingBacklogTaskProjectTransfers,
	transferNeverStartedBacklogTaskToProject,
} from "../state/backlog-task-project-transfer";
import { discardTaskEditDraftsForDeletedTasks } from "../state/discard-task-edit-drafts-for-tasks-removed-from-board";
import { discardQueuedTaskPromptDeliveriesForTasks } from "../state/queued-task-prompt-delivery-store";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { buildTaskMutationIntentForKanbanRuntimeSystemComponent } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceBoardById,
	loadWorkspaceContextById,
	mutateWorkspaceState,
} from "../state/workspace-state";
import {
	captureAndVerifyTaskClosureArchive,
	restoreVerifiedTaskClosureArchive,
} from "../task-closure/task-closure-archive";
import {
	listTaskClosureOperations,
	readTaskClosureHistory,
	readTaskClosureOperation,
	type TaskClosureOperation,
	withTaskClosureLifecycleLocks,
	writeTaskClosureHistoryRecord,
	writeTaskClosureOperation,
} from "../task-closure/task-closure-operation-store";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
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
// 动作按卡串行并持有跨进程生命周期锁；结案与永久删除先停止会话、验证归档，再进入 board 变更漏斗。
// 其他动作沿用锁外解析行动者 → board 锁内对最新 board 做纯变更（漏斗记账）→
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
	listTaskSessionSummariesLiveInRuntimeProcessMemory?: (workspaceId: string) => RuntimeTaskSessionSummary[];
	// runtime 级单例（不能每个请求新建，否则串不住）。
	taskCardActionPerTaskCommandSerializer: TaskCardActionPerTaskCommandSerializer;
	// 永久删除丢弃排队 prompt 之后，让出队引擎刷新缓存并重发投影。
	onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards?: (
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	) => void;
	// 测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
	// 移入 Done 的 Post-Deploy Verification 门禁（src/deployment/post-deploy-verification-done-entry-gate.ts）。runtime 注入；
	// 缺省 = 不设门禁（单元测试默认不读 runtime home 下的 PDV 状态）。
	postDeployVerificationDoneEntryGate?: TaskCardActionPostDeployVerificationDoneEntryGate;
}

export interface TaskCardActionPostDeployVerificationDoneEntryGate {
	authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone: typeof authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone;
	finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone: typeof finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone;
	revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed: typeof revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed;
}

function assertTaskCardUnshelvedBeforeStageAction(card: RuntimeBoardCard): void {
	if (isTaskCardShelved(card))
		throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先取消搁置，再移动任务 Stage。" });
}

interface TaskCardFoundWithBoardColumn {
	taskCard: RuntimeBoardCard;
	boardColumnId: RuntimeBoardColumnId;
}

// 原生输入接受后的自动移列仍走同一 board 持久化漏斗，不触发重复启动或发送。
export async function moveTaskCardIntoInProgressAfterAcceptedMainConversationInput(input: {
	workspaceId: string;
	summary: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
}): Promise<{ saved: boolean; workspacePath: string | null }> {
	const context = await loadWorkspaceContextById(input.workspaceId);
	if (!context) return { saved: false, workspacePath: null };
	const eventId = input.summary.agentConversationPromptSubmissionAcceptance?.eventId;
	const result = await mutateWorkspaceState(
		context.repoPath,
		buildTaskMutationIntentForKanbanRuntimeSystemComponent(
			"accepted_main_conversation_input_moves_task_into_in_progress",
			"agent-conversation-input-acceptance",
		),
		(state) => {
			const current = input.getCurrentSummary();
			if (
				!current ||
				current.runtimeSessionIncarnationId !== input.summary.runtimeSessionIncarnationId ||
				current.agentConversationPromptSubmissionAcceptance?.eventId !== eventId
			)
				return { board: state.board, value: false, save: false };
			const projected = projectTaskBoardAfterAcceptedMainConversationInput(state.board, current);
			return { board: projected.board, value: projected.moved, save: projected.moved };
		},
	);
	return { saved: result.saved, workspacePath: context.repoPath };
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

function assertTaskCardIncarnationMatchesExpected(
	taskCard: RuntimeBoardCard,
	expectedCreatedAt: number | undefined,
): void {
	if (expectedCreatedAt !== undefined && taskCard.createdAt !== expectedCreatedAt) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "这张任务卡已被删除并重建；原关联引用不能操作新的同 ID 任务，请刷新后重试。",
		});
	}
}

function findTaskCardWithBoardColumnOrThrowNotFound(
	board: RuntimeBoardData,
	taskId: string,
	workspacePath: string,
	expectedCreatedAt?: number,
): TaskCardFoundWithBoardColumn {
	const found = findTaskCardWithBoardColumn(board, taskId);
	if (!found) {
		throw createTaskCardNotFoundOnWorkspaceBoardError(taskId, workspacePath);
	}
	assertTaskCardIncarnationMatchesExpected(found.taskCard, expectedCreatedAt);
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
			resolveMainTaskConversationSessionId(found.taskCard),
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
		expectedCreatedAt?: number,
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
			expectedCreatedAt,
		);
		return {
			...found,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: resolveMainTaskConversationSessionSummaryForTaskId(
				persistedWorkspaceState.board,
				persistedWorkspaceState.sessions,
				taskId,
			),
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

	const deleteTaskWorktreeReportingFailure = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		worktreeMode: RuntimeTaskWorktreeMode | undefined,
		operation?: TaskClosureOperation,
	): Promise<RuntimeTaskWorktreeDeletionResultOfTaskCardAction> => {
		try {
			// 删 worktree 不删 task commit provenance：落地数据保全（dd2db Y-PHASE-3），1c 的共享落地判据要读它。
			const deleted = await deps.workspaceApi.deleteWorktree(workspaceScope, {
				taskId,
				...(operation
					? {
							taskClosureArchiveCleanupCredential: {
								closureRequestId: operation.progress.closureRequestId,
								taskIncarnationCreatedAtEpochMs: operation.taskIdentity.taskIncarnationCreatedAtEpochMs,
							},
						}
					: {}),
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

	const runSeriallyForTaskCards = async <TResult>(
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskIds: readonly string[],
		taskCardActionCommand: () => Promise<TResult>,
	): Promise<TResult> => {
		await recoverPendingBacklogTaskProjectTransfers(workspaceScope.workspaceId);
		return deps.taskCardActionPerTaskCommandSerializer.runTaskCardActionCommandSeriallyForTaskCards(
			workspaceScope.workspaceId,
			taskIds,
			() =>
				withTaskClosureLifecycleLocks(workspaceScope.workspaceId, taskIds, async () => {
					// 摘要已落盘而历史镜像中断时，先补齐再允许后续动作替换或删除摘要。
					const board = await loadWorkspaceBoardById(workspaceScope.workspaceId);
					for (const taskId of taskIds) {
						const summary = findTaskCardWithBoardColumn(board, taskId)?.taskCard.taskClosureSummary;
						if (summary) await writeTaskClosureHistoryRecord(summary);
					}
					return await taskCardActionCommand();
				}),
		);
	};

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

	// 移入 Done 的门禁授权：返回是否写下了在途授权（之后移列失败要撤销、成功要结案）；拒绝时抛 PRECONDITION_FAILED。
	// 卡已在 Done、或不受门禁（不在该 workspace 活跃部署组里等核对）时直接放行、不写盘。
	const authorizePostDeployVerificationDoneEntryOrThrowPreconditionFailed = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskCardActionMoveIntoDoneRequest,
	): Promise<boolean> => {
		const gate = deps.postDeployVerificationDoneEntryGate;
		if (!gate) {
			return false;
		}
		const persistedBoard = (await loadPersistedWorkspaceStateById(workspaceScope.workspaceId)).board;
		const foundBeforeAuthorization = findTaskCardWithBoardColumn(persistedBoard, input.taskId);
		if (foundBeforeAuthorization)
			assertTaskCardIncarnationMatchesExpected(
				foundBeforeAuthorization.taskCard,
				input.expectedTaskIncarnationCreatedAtEpochMs,
			);
		const boardColumnIdBeforeMove = foundBeforeAuthorization?.boardColumnId;
		if (boardColumnIdBeforeMove === undefined) {
			// 卡不在看板：交给移列本身报 NOT_FOUND。
			return false;
		}
		const authorization = await gate.authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: workspaceScope.workspaceId,
			taskId: input.taskId,
			boardColumnIdOfTaskCardBeforeMove: boardColumnIdBeforeMove,
			postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure,
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			nowIso: new Date().toISOString(),
		});
		if (
			authorization.postDeployVerificationDoneEntryGateDecision ===
			"move_into_done_rejected_because_unchecked_items_lack_closure_reasons"
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: `${POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX} Task "${input.taskId}" has unchecked Post-Deploy Verification items; give a closure reason for each before moving it to Done: ${authorization.uncheckedChecklistItemsMissingClosureReason
					.map((item) => `${item.checklistItemId} (${item.checklistItemLabel})`)
					.join("; ")}`,
			});
		}
		return (
			authorization.postDeployVerificationDoneEntryGateDecision ===
			"move_into_done_authorized_with_closure_authorization_in_flight"
		);
	};

	const revokePostDeployVerificationDoneEntryAuthorization = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		taskId: string,
	): Promise<void> => {
		await deps.postDeployVerificationDoneEntryGate
			?.revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed({
				workspaceId: workspaceScope.workspaceId,
				taskId,
				nowIso: new Date().toISOString(),
			})
			.catch(() => undefined);
	};

	const moveTaskCardIntoTrashColumnWithinBoardLock = async (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskCardActionMoveIntoDoneRequest,
		kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		operation?: TaskClosureOperation,
	) =>
		await mutateWorkspaceState<{
			foundAfterMovement: TaskCardFoundWithBoardColumn;
			boardColumnIdOfTaskCardBeforeAction: RuntimeBoardColumnId;
			taskSessionSummaryPersistedInWorkspaceSessionsFile: RuntimeTaskSessionSummary | null;
		}>(
			workspaceScope.workspacePath,
			operation?.intent ??
				(await resolveIntent(
					"move_task_card_into_done",
					kanbanRequestOriginActorEvidence,
					input.boardMutationInitiator,
					[input.taskId],
				)),
			(state) => {
				const found = findTaskCardWithBoardColumnOrThrowNotFound(
					state.board,
					input.taskId,
					workspaceScope.workspacePath,
					input.expectedTaskIncarnationCreatedAtEpochMs,
				);
				const taskSessionSummaryPersistedInWorkspaceSessionsFile =
					resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId);
				assertTaskCardUnshelvedBeforeStageAction(found.taskCard);
				const completionComment = input.taskCommentToAppendWhenMovingIntoDone;
				const existingCompletionComment = completionComment
					? found.taskCard.taskCommentEntries?.find(
							(entry) => entry.taskCommentEntryId === completionComment.taskCommentEntryId,
						)
					: undefined;
				if (
					completionComment &&
					((existingCompletionComment &&
						existingCompletionComment.commentText !== completionComment.commentText) ||
						(found.boardColumnId === "trash" && !existingCompletionComment))
				) {
					throw new TRPCError({ code: "CONFLICT", message: "任务或评论已被其他操作更新，未提交本次评论。" });
				}
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
				const timestamp = Date.now();
				const boardWithCompletionComment =
					completionComment && !existingCompletionComment
						? updateTask(
								state.board,
								input.taskId,
								buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(found.taskCard, {
									taskCommentEntries: [
										...(found.taskCard.taskCommentEntries ?? []),
										{ ...completionComment, createdAt: timestamp, updatedAt: timestamp },
									],
								}),
							).board
						: state.board;
				if (
					operation &&
					(found.taskCard.updatedAt !== operation.sourceTaskUpdatedAtEpochMs ||
						found.boardColumnId !== operation.sourceBoardColumnId)
				)
					throw new TRPCError({ code: "CONFLICT", message: "保全期间任务已改变，未移列或清理。" });
				const boardWithClosure = operation
					? {
							...boardWithCompletionComment,
							columns: boardWithCompletionComment.columns.map((column) => ({
								...column,
								cards: column.cards.map((card) =>
									card.id === input.taskId
										? {
												...card,
												taskClosureSummary: operation.closureRecord ?? undefined,
												taskClosureOperationProgress: operation.progress,
											}
										: card,
								),
							})),
						}
					: boardWithCompletionComment;
				const trashed = moveTaskToColumn(boardWithClosure, input.taskId, "trash", undefined, {
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
						foundAfterMovement: { taskCard: trashed.task, boardColumnId: "trash" as const },
						boardColumnIdOfTaskCardBeforeAction: found.boardColumnId,
						taskSessionSummaryPersistedInWorkspaceSessionsFile,
					},
				};
			},
		);

	const writeClosureProgress = async (scope: RuntimeTrpcWorkspaceScope, operation: TaskClosureOperation) => {
		await writeTaskClosureOperation(operation);
		const saved = await mutateWorkspaceState(
			scope.workspacePath,
			buildTaskMutationIntentForKanbanRuntimeSystemComponent(
				"task_closure_operation_progress_changed",
				"task-closure-preservation",
			),
			(state) => {
				const found = findTaskCardWithBoardColumn(state.board, operation.taskIdentity.taskId);
				if (!found || found.taskCard.createdAt !== operation.taskIdentity.taskIncarnationCreatedAtEpochMs)
					return { board: state.board, value: null, save: false };
				return {
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.map((card) =>
								card === found.taskCard ? { ...card, taskClosureOperationProgress: operation.progress } : card,
							),
						})),
					},
					value: null,
				};
			},
		);
		broadcastWorkspaceStateUpdatedWhenBoardWasSaved(scope, saved.saved);
	};

	const stopTaskSessionsAndConfirmExitBeforePreservation = async (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		operation: TaskClosureOperation,
	) => {
		const sessionIds = new Set([
			card.id,
			resolveMainTaskConversationSessionId(card),
			buildTaskCardDetailUserShellTerminalSessionTaskId(card.id),
		]);
		const persisted = await loadPersistedWorkspaceStateById(scope.workspaceId);
		for (const summary of [
			...Object.values(persisted.sessions),
			...(deps.listTaskSessionSummariesLiveInRuntimeProcessMemory?.(scope.workspaceId) ?? []),
		]) {
			if (summary.taskConversationSessionMetadata?.workspaceTaskId === card.id) sessionIds.add(summary.taskId);
		}
		const processIds = new Set<number>(operation.processIdsAwaitingExit ?? []);
		// 主会话的停止会连带停止侧会话，须在停止任何会话前保存所有活体 PID。
		for (const taskId of sessionIds) {
			const before = deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(scope.workspaceId, taskId);
			if (before?.pid && before.pid !== process.pid) processIds.add(before.pid);
		}
		operation.processIdsAwaitingExit = [...processIds];
		await writeTaskClosureOperation(operation);
		for (const taskId of sessionIds) {
			const stopped = await deps.runtimeApi.stopTaskSession(scope, { taskId });
			if (stopped.summary?.pid && stopped.summary.pid !== process.pid) processIds.add(stopped.summary.pid);
			operation.processIdsAwaitingExit = [...processIds];
			await writeTaskClosureOperation(operation);
			if (stopped.error) throw new Error(`停止所属会话失败：${stopped.error}`);
		}
		operation.processIdsAwaitingExit = [...processIds];
		await writeTaskClosureOperation(operation);
		for (let attempt = 0; attempt < 50; attempt += 1) {
			for (const pid of processIds) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") processIds.delete(pid);
					else throw error;
				}
			}
			if (!processIds.size) {
				operation.processIdsAwaitingExit = [];
				await writeTaskClosureOperation(operation);
				return;
			}
			await waitForProcessExit(100);
		}
		throw new Error("所属 Agent 或详情终端尚未确认停止，保留工作树等待退出。");
	};

	const assertClosureSuccessorTaskIdentity = async (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		details: TaskClosureRecord["details"],
	) => {
		const successor = details.successorTask;
		if (!successor) return;
		const successorBoard = await loadWorkspaceBoardById(successor.workspaceId);
		const found = findTaskCardWithBoardColumn(successorBoard, successor.taskId);
		if (
			!found ||
			found.taskCard.createdAt !== successor.taskIncarnationCreatedAtEpochMs ||
			(successor.workspaceId === scope.workspaceId && successor.taskId === taskId)
		)
			throw new TRPCError({ code: "CONFLICT", message: "承接任务不存在、身份已变化或指向任务自身。" });
	};

	const prepareVerifiedClosureOperation = async (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeTaskCardActionMoveIntoDoneRequest,
		evidence: KanbanRequestOriginActorEvidence,
		preservationPurpose: "close_task" | "permanently_delete_task" = "close_task",
	) => {
		const initial = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
			scope,
			input.taskId,
			input.expectedTaskIncarnationCreatedAtEpochMs,
		);
		if (preservationPurpose === "close_task") assertTaskCardUnshelvedBeforeStageAction(initial.taskCard);
		const closure = taskClosureRequestSchema.parse(
			input.closure ?? { closureRequestId: randomUUID(), details: { outcome: "closure_outcome_unspecified" } },
		);
		const identity = {
			workspaceId: scope.workspaceId,
			taskId: input.taskId,
			taskIncarnationCreatedAtEpochMs: initial.taskCard.createdAt,
		};
		let operation = await readTaskClosureOperation(identity, closure.closureRequestId);
		const request = runtimeTaskCardActionMoveIntoDoneRequestSchema.parse({
			...input,
			expectedTaskIncarnationCreatedAtEpochMs: initial.taskCard.createdAt,
			closure,
		});
		if (
			operation &&
			JSON.stringify(runtimeTaskCardActionMoveIntoDoneRequestSchema.parse(operation.request)) !==
				JSON.stringify(request)
		)
			throw new TRPCError({ code: "CONFLICT", message: "同一结案请求 ID 已绑定其他内容。" });
		if (operation?.progress.phase === "completed" && initial.boardColumnId !== "trash")
			throw new TRPCError({ code: "CONFLICT", message: "任务已经重开，旧结案请求失效。" });
		if (operation?.progress.phase === "cancelled")
			throw new TRPCError({ code: "CONFLICT", message: "结案操作已取消或任务已重开，旧请求不能继续清理。" });
		if (!operation) {
			for (const old of await listTaskClosureOperations(identity)) {
				if (old.reopening && !["completed", "cancelled"].includes(old.reopening.phase)) {
					old.reopening.phase = "cancelled";
					await writeTaskClosureOperation(old);
				}
			}
			if (
				closure.expectedTaskUpdatedAtEpochMs !== undefined &&
				closure.expectedTaskUpdatedAtEpochMs !== initial.taskCard.updatedAt
			)
				throw new TRPCError({ code: "CONFLICT", message: "任务已被修改，请核对最新任务再结案。" });
			const pending = (await listTaskClosureOperations(identity)).find(
				(candidate) => !["completed", "cancelled"].includes(candidate.progress.phase),
			);
			if (pending)
				throw new TRPCError({
					code: "CONFLICT",
					message: `任务已有待恢复的结案操作：${pending.progress.closureRequestId}`,
				});
			await assertClosureSuccessorTaskIdentity(scope, input.taskId, closure.details);
			const path = await getTaskWorkspacePathInfo({
				cwd: scope.workspacePath,
				taskId: input.taskId,
				baseRef: initial.taskCard.baseRef,
				worktreeMode: initial.taskCard.worktreeMode,
			});
			operation = {
				schemaVersion: 1,
				preservationPurpose,
				taskIdentity: identity,
				workspacePath: scope.workspacePath,
				sourceWorktreePath: path.exists ? path.path : null,
				sourceBoardColumnId: initial.boardColumnId,
				sourceTaskUpdatedAtEpochMs: initial.taskCard.updatedAt,
				request,
				intent: await resolveIntent(
					preservationPurpose === "close_task" ? "move_task_card_into_done" : "permanently_delete_task_cards",
					evidence,
					input.boardMutationInitiator,
					[input.taskId],
				),
				progress: {
					closureRequestId: closure.closureRequestId,
					phase: "preserving",
					attemptCount: 0,
					lastError: null,
					recoveryCondition: null,
					nextRetryAtEpochMs: null,
				},
				archiveManifest: null,
				closureRecord: null,
				lastAttemptRuntimeInstanceId: null,
				lastRecoveryProbeFingerprint: null,
			};
			await writeClosureProgress(scope, operation);
		}
		if (
			initial.boardColumnId !== "trash" &&
			(initial.taskCard.updatedAt !== operation.sourceTaskUpdatedAtEpochMs ||
				initial.boardColumnId !== operation.sourceBoardColumnId)
		)
			throw new TRPCError({ code: "CONFLICT", message: "任务已被修改，旧结案请求已失效。" });
		if (operation.archiveManifest) return operation;
		const refreshedSource = await getTaskWorkspacePathInfo({
			cwd: scope.workspacePath,
			taskId: input.taskId,
			baseRef: initial.taskCard.baseRef,
			worktreeMode: initial.taskCard.worktreeMode,
		});
		operation.sourceWorktreePath = refreshedSource.exists ? refreshedSource.path : null;
		try {
			await stopTaskSessionsAndConfirmExitBeforePreservation(scope, initial.taskCard, operation);
			for (let attempt = 0; attempt < 3; attempt += 1) {
				operation.progress.attemptCount += 1;
				operation.progress.phase = "preserving";
				await writeClosureProgress(scope, operation);
				try {
					operation.archiveManifest = await captureAndVerifyTaskClosureArchive(operation);
					break;
				} catch (error) {
					operation.progress.lastError = toErrorMessage(error);
					await writeClosureProgress(scope, operation);
					if (attempt === 2) throw error;
					await waitForProcessExit(100 * (attempt + 1));
				}
			}
			operation.progress = {
				...operation.progress,
				phase: "archive_verified",
				lastError: null,
				recoveryCondition: null,
			};
			await writeClosureProgress(scope, operation);
			return operation;
		} catch (error) {
			operation.progress = {
				...operation.progress,
				phase: "preservation_waiting_for_recovery",
				lastError: toErrorMessage(error),
				recoveryCondition: "所属进程退出、来源 Git／选定成果或磁盘可用空间变化，或运行时重启后重新核验",
				nextRetryAtEpochMs: null,
			};
			await writeClosureProgress(scope, operation);
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: `成果保全失败，原列和工作树已保留：${toErrorMessage(error)}`,
			});
		}
	};

	const makeClosureRecord = (operation: TaskClosureOperation, previous?: TaskClosureRecord): TaskClosureRecord => ({
		closureRequestId: operation.progress.closureRequestId,
		taskIdentity: operation.taskIdentity,
		details: taskClosureDetailsSchema.parse(
			operation.request.closure?.details ?? { outcome: "closure_outcome_unspecified" },
		),
		recordedAtEpochMs: Math.max(Date.now(), (previous?.recordedAtEpochMs ?? 0) + 1),
		actor: { ...operation.intent.resolvedKanbanActor },
		eventKind: "closed",
		previousClosureRequestId: previous?.closureRequestId ?? null,
		isCurrentlyClosed: true,
		archiveManifest: operation.archiveManifest as NonNullable<TaskClosureOperation["archiveManifest"]>,
	});

	const persistClosureRecord = async (
		scope: RuntimeTrpcWorkspaceScope,
		record: TaskClosureRecord,
		evidence: KanbanRequestOriginActorEvidence,
		resolvedIntent?: TaskMutationIntentWithResolvedActor,
	) => {
		const result = await mutateWorkspaceState(
			scope.workspacePath,
			resolvedIntent ??
				(await resolveIntent("move_task_card_into_done", evidence, undefined, [record.taskIdentity.taskId])),
			(state) => {
				const found = findTaskCardWithBoardColumnOrThrowNotFound(
					state.board,
					record.taskIdentity.taskId,
					scope.workspacePath,
					record.taskIdentity.taskIncarnationCreatedAtEpochMs,
				);
				return {
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.map((card) =>
								card === found.taskCard ? { ...card, taskClosureSummary: record } : card,
							),
						})),
					},
					value: null,
				};
			},
		);
		await writeTaskClosureHistoryRecord(record);
		broadcastWorkspaceStateUpdatedWhenBoardWasSaved(scope, result.saved);
	};

	const cancelPendingClosureOperations = async (
		scope: RuntimeTrpcWorkspaceScope,
		card: RuntimeBoardCard,
		cancelReopening = true,
	) => {
		for (const operation of await listTaskClosureOperations({
			workspaceId: scope.workspaceId,
			taskId: card.id,
			taskIncarnationCreatedAtEpochMs: card.createdAt,
		})) {
			const cancelActiveReopening =
				cancelReopening && operation.reopening && !["completed", "cancelled"].includes(operation.reopening.phase);
			if (["completed", "cancelled"].includes(operation.progress.phase) && !cancelActiveReopening) continue;
			if (cancelActiveReopening && operation.reopening) operation.reopening.phase = "cancelled";
			operation.progress.phase = "cancelled";
			operation.progress.recoveryCondition = null;
			await writeClosureProgress(scope, operation);
		}
	};

	return {
		readTaskClosureHistory: async (scope, input) => {
			const found = findTaskCardWithBoardColumn(await loadWorkspaceBoardById(scope.workspaceId), input.taskId);
			const current =
				found?.taskCard.createdAt === input.expectedTaskIncarnationCreatedAtEpochMs
					? found.taskCard.taskClosureSummary
					: null;
			if (current) await writeTaskClosureHistoryRecord(current);
			return await readTaskClosureHistory({
				workspaceId: scope.workspaceId,
				taskId: input.taskId,
				taskIncarnationCreatedAtEpochMs: input.expectedTaskIncarnationCreatedAtEpochMs,
			});
		},
		correctTaskClosureOutcome: async (scope, input, evidence) =>
			await runSeriallyForTaskCards(scope, [input.taskId], async () => {
				const found = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
					scope,
					input.taskId,
					input.expectedTaskIncarnationCreatedAtEpochMs,
				);
				const history = await readTaskClosureHistory({
					workspaceId: scope.workspaceId,
					taskId: input.taskId,
					taskIncarnationCreatedAtEpochMs: found.taskCard.createdAt,
				});
				const existing =
					history.records.find((record) => record.closureRequestId === input.closure.closureRequestId) ??
					(found.taskCard.taskClosureSummary?.closureRequestId === input.closure.closureRequestId
						? found.taskCard.taskClosureSummary
						: undefined);
				if (existing) {
					if (JSON.stringify(existing.details) !== JSON.stringify(input.closure.details))
						throw new TRPCError({ code: "CONFLICT", message: "此请求 ID 已绑定另一项更正。" });
					await writeTaskClosureHistoryRecord(existing);
					return existing;
				}
				if (
					found.boardColumnId !== "trash" ||
					(found.taskCard.taskClosureSummary?.closureRequestId ?? null) !== input.expectedPreviousClosureRequestId
				)
					throw new TRPCError({ code: "CONFLICT", message: "任务已重开或结案记录已更正，请刷新。" });
				await assertClosureSuccessorTaskIdentity(scope, input.taskId, input.closure.details);
				const record: TaskClosureRecord = {
					closureRequestId: input.closure.closureRequestId,
					taskIdentity: {
						workspaceId: scope.workspaceId,
						taskId: input.taskId,
						taskIncarnationCreatedAtEpochMs: found.taskCard.createdAt,
					},
					details: input.closure.details,
					eventKind: "outcome_corrected",
					isCurrentlyClosed: true,
					previousClosureRequestId: input.expectedPreviousClosureRequestId,
					recordedAtEpochMs: Math.max(Date.now(), (found.taskCard.taskClosureSummary?.recordedAtEpochMs ?? 0) + 1),
					actor: {
						...(await resolveIntent("move_task_card_into_done", evidence, undefined, [input.taskId]))
							.resolvedKanbanActor,
					},
					archiveManifest: found.taskCard.taskClosureSummary?.archiveManifest ?? {
						archiveDirectory: "",
						headCommit: null,
						persistentHeadReference: null,
						verifiedAtEpochMs: null,
						availability: "historical_artifacts_unavailable",
						preservedFileCount: 0,
						selectedArtifactRelativePaths: [],
					},
				};
				await persistClosureRecord(scope, record, evidence);
				return record;
			}),
		cancelTaskClosureOperation: async (scope, input, _evidence) =>
			await runSeriallyForTaskCards(scope, [input.taskId], async () => {
				const found = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
					scope,
					input.taskId,
					input.expectedTaskIncarnationCreatedAtEpochMs,
				);
				await cancelPendingClosureOperations(scope, found.taskCard);
				return await readTaskClosureHistory({
					workspaceId: scope.workspaceId,
					taskId: input.taskId,
					taskIncarnationCreatedAtEpochMs: found.taskCard.createdAt,
				});
			}),
		transferNeverStartedBacklogTaskToProject: async (scope, input, evidence) => {
			const live = deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(scope.workspaceId, input.taskId);
			if (live?.startedAt != null)
				throw new TRPCError({ code: "PRECONDITION_FAILED", message: "任务已有启动会话，不能迁移项目。" });
			const intent = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
				taskMutationIntentKind: "backlog_task_project_transferred",
				kanbanRequestOriginActorEvidence: evidence,
				kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
			});
			const result = await transferNeverStartedBacklogTaskToProject(scope.workspaceId, input, intent);
			const target = await loadWorkspaceContextById(result.workspaceId);
			await deps.broadcastRuntimeWorkspaceStateUpdated(scope.workspaceId, scope.workspacePath);
			if (target) await deps.broadcastRuntimeWorkspaceStateUpdated(target.workspaceId, target.repoPath);
			await deps.broadcastRuntimeProjectsUpdated(null);
			return result;
		},
		readTaskCardWithBoardColumn: async (workspaceScope, input) => {
			const persistedWorkspaceState = await loadPersistedWorkspaceStateById(workspaceScope.workspaceId);
			const found = findTaskCardWithBoardColumn(persistedWorkspaceState.board, input.taskId);
			if (!found) {
				return { taskCardLookupOutcome: "task_card_not_found_on_workspace_board", lookedUpTaskId: input.taskId };
			}
			assertTaskCardIncarnationMatchesExpected(found.taskCard, input.expectedTaskIncarnationCreatedAtEpochMs);
			return {
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: buildTaskCardSnapshot(
					workspaceScope,
					found,
					resolveMainTaskConversationSessionSummaryForTaskId(
						persistedWorkspaceState.board,
						persistedWorkspaceState.sessions,
						input.taskId,
					),
				),
			};
		},

		startTaskCardAgentSessionMovingItIntoInProgress: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				const initialState = await loadPersistedWorkspaceStateById(workspaceScope.workspaceId);
				const initialCard = initialState.board.columns
					.flatMap((column) => column.cards)
					.find((card) => card.id === input.taskId);
				if (
					initialCard?.independentTaskCreationProvenance &&
					!initialState.sessions[resolveMainTaskConversationSessionId(initialCard)]?.startedAt
				) {
					await assertIndependentTaskSourceLandedBeforeInitialStart({
						workspaceId: workspaceScope.workspaceId,
						repoPath: workspaceScope.workspacePath,
						card: initialCard,
					});
				}
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
						input.expectedTaskIncarnationCreatedAtEpochMs,
					);
					if (found.boardColumnId !== "backlog" && found.boardColumnId !== "in_progress") {
						throw createTaskCardInBoardColumnNotAllowingActionError(
							`Task "${input.taskId}" is in "${found.boardColumnId}" and can only be started from backlog or in_progress.`,
						);
					}
					const taskSessionSummaryPersistedInWorkspaceSessionsFile =
						resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId);
					if (found.boardColumnId === "in_progress") {
						assertTaskCardUnshelvedBeforeStageAction(found.taskCard);
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
					const boardAfterUnshelvingBacklog = setTaskCardShelvingState(state.board, input.taskId, false).board;
					const moved = moveTaskToColumn(boardAfterUnshelvingBacklog, input.taskId, "in_progress", undefined, {
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
					deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(
						workspaceScope.workspaceId,
						resolveMainTaskConversationSessionId(foundAfterMovement.taskCard),
					);
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
					input.expectedTaskIncarnationCreatedAtEpochMs,
				);
				assertTaskCardUnshelvedBeforeStageAction(foundBeforeHandoff.taskCard);
				if (foundBeforeHandoff.boardColumnId !== "in_progress") {
					throw createTaskCardInBoardColumnNotAllowingActionError(
						`Task "${input.taskId}" is in "${foundBeforeHandoff.boardColumnId}" and can only be moved to review from in_progress.`,
					);
				}
				const handoff = await deps.runtimeApi
					.transitionTaskToReview(workspaceScope, {
						taskId: resolveMainTaskConversationSessionId(foundBeforeHandoff.taskCard),
					})
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
							input.expectedTaskIncarnationCreatedAtEpochMs,
						);
						const taskSessionSummaryPersistedInWorkspaceSessionsFile =
							resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId);
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
							input.expectedTaskIncarnationCreatedAtEpochMs,
						);
						assertTaskCardUnshelvedBeforeStageAction(found.taskCard);
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
								taskSessionSummaryPersistedInWorkspaceSessionsFile:
									resolveMainTaskConversationSessionSummaryForTaskId(
										state.board,
										state.sessions,
										input.taskId,
									),
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
					const before = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
						workspaceScope,
						input.taskId,
						input.expectedTaskIncarnationCreatedAtEpochMs,
					);
					if (
						before.boardColumnId === "trash" &&
						input.taskCommentToAppendWhenMovingIntoDone &&
						!before.taskCard.taskCommentEntries?.some(
							(entry) =>
								entry.taskCommentEntryId === input.taskCommentToAppendWhenMovingIntoDone?.taskCommentEntryId &&
								entry.commentText === input.taskCommentToAppendWhenMovingIntoDone.commentText,
						)
					)
						throw new TRPCError({ code: "CONFLICT", message: "任务或评论已被其他操作更新，未提交本次评论。" });
					if (before.boardColumnId === "trash" && !input.closure)
						return {
							boardColumnIdOfTaskCardBeforeAction: "trash",
							taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: true,
							taskAgentSessionStopWasRequested: false,
							taskWorktreeDeletionResult: null,
							postDeployVerificationClosureOutcome: null,
							closureRecord: before.taskCard.taskClosureSummary ?? null,
							taskCardSnapshotAfterAction: buildTaskCardSnapshot(
								workspaceScope,
								before,
								before.taskSessionSummaryPersistedInWorkspaceSessionsFile,
							),
						};
					if (
						before.boardColumnId === "trash" &&
						input.closure &&
						!(await readTaskClosureOperation(
							{
								workspaceId: workspaceScope.workspaceId,
								taskId: input.taskId,
								taskIncarnationCreatedAtEpochMs: before.taskCard.createdAt,
							},
							input.closure.closureRequestId,
						))
					)
						throw new TRPCError({ code: "CONFLICT", message: "历史结案请使用更正入口，未重复执行清理。" });
					const pdvAuthorized = await authorizePostDeployVerificationDoneEntryOrThrowPreconditionFailed(
						workspaceScope,
						input,
					);
					let operation: TaskClosureOperation;
					let preparedOperationForFailureRecovery: TaskClosureOperation | null = null;
					let movement: Awaited<ReturnType<typeof moveTaskCardIntoTrashColumnWithinBoardLock>>;
					try {
						operation = await prepareVerifiedClosureOperation(
							workspaceScope,
							input,
							kanbanRequestOriginActorEvidence,
						);
						preparedOperationForFailureRecovery = operation;
						if (operation.progress.phase === "completed")
							return {
								boardColumnIdOfTaskCardBeforeAction: operation.sourceBoardColumnId,
								taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: true,
								taskAgentSessionStopWasRequested: false,
								taskWorktreeDeletionResult: null,
								closureRecord: operation.closureRecord,
								closureOperationProgress: operation.progress,
								taskCardSnapshotAfterAction: buildTaskCardSnapshot(
									workspaceScope,
									before,
									before.taskSessionSummaryPersistedInWorkspaceSessionsFile,
								),
							};
						if (
							before.boardColumnId === "trash" &&
							before.taskCard.taskClosureSummary?.archiveManifest.archiveDirectory !==
								operation.archiveManifest?.archiveDirectory
						)
							throw new TRPCError({ code: "CONFLICT", message: "历史结案请使用更正入口，未重复执行清理。" });
						if (
							operation.sourceWorktreePath &&
							operation.archiveManifest?.availability === "verified_recoverable"
						) {
							try {
								await lstat(operation.sourceWorktreePath);
								await assertSourceGitWorkingStateMatchesSnapshot(
									operation.sourceWorktreePath,
									operation.archiveManifest.archiveDirectory,
								);
							} catch (error) {
								if (preparedOperationForFailureRecovery && before.boardColumnId !== "trash") {
									const failed = preparedOperationForFailureRecovery;
									failed.progress.phase =
										error instanceof TRPCError && error.code === "CONFLICT"
											? "cancelled"
											: "preservation_waiting_for_recovery";
									failed.progress.lastError = toErrorMessage(error);
									failed.progress.recoveryCondition =
										failed.progress.phase === "cancelled" ? null : "来源稳定后重新捕获并验证归档";
									if (failed.progress.phase !== "cancelled") {
										failed.archiveManifest = null;
										failed.closureRecord = null;
									}
									await writeClosureProgress(workspaceScope, failed);
								}
								if ((error as NodeJS.ErrnoException).code !== "ENOENT" || before.boardColumnId !== "trash")
									throw error;
							}
						}
						operation.closureRecord ??= makeClosureRecord(operation, before.taskCard.taskClosureSummary);
						operation.progress.phase = "closed_cleanup_pending";
						await writeTaskClosureOperation(operation);
						movement = await moveTaskCardIntoTrashColumnWithinBoardLock(
							workspaceScope,
							operation.request,
							kanbanRequestOriginActorEvidence,
							operation,
						);
					} catch (error) {
						if (pdvAuthorized)
							await revokePostDeployVerificationDoneEntryAuthorization(workspaceScope, input.taskId);
						throw error;
					}
					broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, movement.saved);
					if (operation.closureRecord) await writeTaskClosureHistoryRecord(operation.closureRecord);
					const postDeployVerificationClosureOutcome =
						pdvAuthorized && deps.postDeployVerificationDoneEntryGate
							? await deps.postDeployVerificationDoneEntryGate
									.finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
										workspaceId: workspaceScope.workspaceId,
										taskId: input.taskId,
										nowIso: new Date().toISOString(),
									})
									.catch(() => null)
							: null;
					const cleanup = await deleteTaskWorktreeReportingFailure(
						workspaceScope,
						input.taskId,
						movement.value.foundAfterMovement.taskCard.worktreeMode,
						operation,
					);
					operation.progress = {
						...operation.progress,
						phase: cleanup?.taskWorktreeDeletionErrorMessage ? "closed_cleanup_pending" : "completed",
						lastError: cleanup?.taskWorktreeDeletionErrorMessage ?? null,
						recoveryCondition: cleanup?.taskWorktreeDeletionErrorMessage
							? "原工作树恢复可读且仍匹配已验证归档后，重试本操作清理"
							: null,
						nextRetryAtEpochMs: null,
					};
					await writeClosureProgress(workspaceScope, operation);
					return {
						boardColumnIdOfTaskCardBeforeAction: operation.sourceBoardColumnId,
						taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: !movement.saved,
						taskAgentSessionStopWasRequested: canTaskCardInBoardColumnHostLiveTaskAgentSession(
							operation.sourceBoardColumnId,
						),
						taskWorktreeDeletionResult: cleanup,
						postDeployVerificationClosureOutcome,
						closureRecord: operation.closureRecord,
						closureOperationProgress: operation.progress,
						taskCardSnapshotAfterAction: await rereadTaskCardSnapshotAfterSessionSideEffects(
							workspaceScope,
							movement.value.foundAfterMovement,
							movement.value.taskSessionSummaryPersistedInWorkspaceSessionsFile,
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
					const reopeningCard = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
						workspaceScope,
						input.taskId,
						input.expectedTaskIncarnationCreatedAtEpochMs,
					);
					const identity = {
						workspaceId: workspaceScope.workspaceId,
						taskId: input.taskId,
						taskIncarnationCreatedAtEpochMs: reopeningCard.taskCard.createdAt,
					};
					const existingOperations = await listTaskClosureOperations(identity);
					const pendingReopening = existingOperations.find(
						(entry) => entry.reopening && !["completed", "cancelled"].includes(entry.reopening.phase),
					);
					const previousClosure = reopeningCard.taskCard.taskClosureSummary;
					if (
						!pendingReopening &&
						reopeningCard.boardColumnId === "review" &&
						previousClosure?.eventKind === "reopened"
					)
						return {
							taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
							taskCardRestoreFromDoneFailureMessage: null,
							ensuredTaskWorktreeWarningMessage: null,
							resumedAgentSessionSummary: deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(
								workspaceScope.workspaceId,
								resolveMainTaskConversationSessionId(reopeningCard.taskCard),
							),
							taskCardSnapshotAfterAction: buildTaskCardSnapshot(
								workspaceScope,
								reopeningCard,
								reopeningCard.taskSessionSummaryPersistedInWorkspaceSessionsFile,
							),
						};

					let reopeningOperation =
						pendingReopening ??
						existingOperations.find(
							(entry) =>
								previousClosure &&
								entry.archiveManifest?.archiveDirectory === previousClosure.archiveManifest.archiveDirectory,
						);
					if (
						reopeningCard.boardColumnId !== "trash" &&
						!(
							pendingReopening &&
							reopeningCard.boardColumnId === "review" &&
							reopeningCard.taskCard.updatedAt === pendingReopening.reopening?.startedAtEpochMs
						)
					)
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: "只能重新打开已结案任务；已修改的恢复请求不能重放。",
						});
					if (!reopeningOperation) {
						const requestId = randomUUID();
						reopeningOperation = {
							schemaVersion: 1,
							taskIdentity: identity,
							workspacePath: workspaceScope.workspacePath,
							sourceWorktreePath: null,
							sourceBoardColumnId: "trash",
							sourceTaskUpdatedAtEpochMs: reopeningCard.taskCard.updatedAt,
							request: { taskId: input.taskId },
							intent: await resolveIntent(
								"restore_task_card_from_done_into_review",
								kanbanRequestOriginActorEvidence,
								input.boardMutationInitiator,
								[input.taskId],
							),
							progress: {
								closureRequestId: requestId,
								phase: "cancelled",
								attemptCount: 0,
								lastError: null,
								recoveryCondition: null,
								nextRetryAtEpochMs: null,
							},
							archiveManifest: previousClosure?.archiveManifest ?? null,
							closureRecord: previousClosure ?? null,
							lastAttemptRuntimeInstanceId: null,
							lastRecoveryProbeFingerprint: null,
						};
					}
					if (!pendingReopening)
						reopeningOperation.reopening = {
							reopeningRequestId: randomUUID(),
							request: {
								...input,
								expectedTaskIncarnationCreatedAtEpochMs: identity.taskIncarnationCreatedAtEpochMs,
							},
							intent: await resolveIntent(
								"restore_task_card_from_done_into_review",
								kanbanRequestOriginActorEvidence,
								input.boardMutationInitiator,
								[input.taskId],
							),
							phase: "restoring_archive",
							startedAtEpochMs: Date.now(),
							sourceTaskUpdatedAtEpochMs: reopeningCard.taskCard.updatedAt,
							lastError: null,
						};
					if (
						pendingReopening?.reopening?.phase === "waiting_for_recovery" &&
						reopeningCard.boardColumnId === "trash" &&
						reopeningOperation.reopening
					)
						reopeningOperation.reopening.startedAtEpochMs = Date.now();
					if (reopeningOperation.progress.phase !== "completed") reopeningOperation.progress.phase = "cancelled";
					await writeClosureProgress(workspaceScope, reopeningOperation);
					await cancelPendingClosureOperations(workspaceScope, reopeningCard.taskCard, false);
					const makeReopenedRecord = (): TaskClosureRecord => ({
						closureRequestId: reopeningOperation.reopening?.reopeningRequestId ?? randomUUID(),
						taskIdentity: identity,
						details:
							previousClosure?.details ??
							taskClosureDetailsSchema.parse({ outcome: "closure_outcome_unspecified" }),
						eventKind: "reopened",
						isCurrentlyClosed: false,
						previousClosureRequestId: previousClosure?.closureRequestId ?? null,
						recordedAtEpochMs: Math.max(Date.now(), (previousClosure?.recordedAtEpochMs ?? 0) + 1),
						actor: { ...(reopeningOperation.reopening?.intent ?? reopeningOperation.intent).resolvedKanbanActor },
						archiveManifest: previousClosure?.archiveManifest ?? {
							archiveDirectory: "",
							headCommit: null,
							persistentHeadReference: null,
							verifiedAtEpochMs: null,
							availability: "historical_artifacts_unavailable",
							preservedFileCount: 0,
							selectedArtifactRelativePaths: [],
						},
					});
					const alreadyResumed = deps.findTaskSessionSummaryLiveInRuntimeProcessMemory(
						workspaceScope.workspaceId,
						resolveMainTaskConversationSessionId(reopeningCard.taskCard),
					);
					if (
						pendingReopening?.reopening &&
						reopeningCard.boardColumnId === "review" &&
						alreadyResumed &&
						resolveSessionFacets(alreadyResumed).liveness === "live" &&
						(alreadyResumed.startedAt ?? 0) >= pendingReopening.reopening.startedAtEpochMs
					) {
						if (previousClosure?.eventKind !== "reopened") {
							const reopened = makeReopenedRecord();
							await persistClosureRecord(
								workspaceScope,
								reopened,
								kanbanRequestOriginActorEvidence,
								reopeningOperation.reopening?.intent,
							);
						}
						if (reopeningOperation.reopening) reopeningOperation.reopening.phase = "completed";
						await writeTaskClosureOperation(reopeningOperation);
						return {
							taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
							taskCardRestoreFromDoneFailureMessage: null,
							ensuredTaskWorktreeWarningMessage: null,
							resumedAgentSessionSummary: alreadyResumed,
							taskCardSnapshotAfterAction: await rereadTaskCardSnapshotAfterSessionSideEffects(
								workspaceScope,
								reopeningCard,
								reopeningCard.taskSessionSummaryPersistedInWorkspaceSessionsFile,
							),
						};
					}
					// 撤销清理后才恢复归档，重启通过同一操作继续；归档记录和校验清单不删除。
					try {
						if (reopeningOperation.archiveManifest?.availability === "verified_recoverable") {
							const target = await getTaskWorkspacePathInfo({
								cwd: workspaceScope.workspacePath,
								taskId: input.taskId,
								baseRef: reopeningCard.taskCard.baseRef,
								worktreeMode: reopeningCard.taskCard.worktreeMode,
							});
							await restoreVerifiedTaskClosureArchive(reopeningOperation, target.path);
						}
					} catch (error) {
						if (reopeningOperation.reopening) {
							reopeningOperation.reopening.phase = "waiting_for_recovery";
							reopeningOperation.reopening.lastError = toErrorMessage(error);
						}
						await writeTaskClosureOperation(reopeningOperation);
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message: `归档恢复失败，保留原列与工作树：${toErrorMessage(error)}`,
						});
					}

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
								input.expectedTaskIncarnationCreatedAtEpochMs,
							);
							assertTaskCardUnshelvedBeforeStageAction(found.taskCard);
							if (
								found.boardColumnId === "review" &&
								pendingReopening &&
								found.taskCard.updatedAt === pendingReopening.reopening?.startedAtEpochMs
							)
								return {
									board: state.board,
									value: {
										foundAfterMovement: found,
										taskSessionSummaryPersistedInWorkspaceSessionsFile:
											resolveMainTaskConversationSessionSummaryForTaskId(
												state.board,
												state.sessions,
												input.taskId,
											),
										autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview: null,
									},
									save: false,
								};
							if (
								found.boardColumnId !== "trash" ||
								found.taskCard.updatedAt !== reopeningOperation?.reopening?.sourceTaskUpdatedAtEpochMs
							)
								throw new TRPCError({ code: "CONFLICT", message: "恢复期间任务已被修改，旧重开操作失效。" });
							const restored = moveTaskToColumn(
								state.board,
								input.taskId,
								"review",
								reopeningOperation?.reopening?.startedAtEpochMs,
								{
									insertAtIndex: input.insertAtIndexWithinReviewBoardColumn,
								},
							);
							if (!restored.moved || !restored.task) {
								throw new TRPCError({
									code: "INTERNAL_SERVER_ERROR",
									message: `Task "${input.taskId}" could not be moved from done to review.`,
								});
							}
							const taskSessionSummaryPersistedInWorkspaceSessionsFile =
								resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId);
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
								reopeningOperation?.reopening?.startedAtEpochMs,
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
					): Promise<RuntimeTaskCardActionRestoreFromDoneResponse> => {
						const snapshot = await moveTaskCardBackIntoDoneAfterFailedRestore(
							workspaceScope,
							input.taskId,
							kanbanRequestOriginActorEvidence,
							input.boardMutationInitiator,
							foundAfterMovement,
							taskSessionSummaryPersistedInWorkspaceSessionsFile,
							autoReviewSettingsOfTaskCardBeforeRestoreDisabledAutoReview,
						);
						if (reopeningOperation.reopening) {
							reopeningOperation.reopening.phase = "waiting_for_recovery";
							reopeningOperation.reopening.lastError = taskCardRestoreFromDoneFailureMessage;
							reopeningOperation.reopening.sourceTaskUpdatedAtEpochMs = snapshot.taskCard.updatedAt;
						}
						await writeTaskClosureOperation(reopeningOperation);
						return {
							taskCardRestoreFromDoneOutcome,
							taskCardRestoreFromDoneFailureMessage,
							ensuredTaskWorktreeWarningMessage,
							resumedAgentSessionSummary: null,
							taskCardSnapshotAfterAction: snapshot,
						};
					};

					const ensured = await ensureTaskWorktreeReportingFailure(workspaceScope, foundAfterMovement.taskCard);
					if (!ensured.ok) {
						return await respondWithRestoreFailureAfterMovingBackIntoDone(
							"task_worktree_ensure_failed_so_task_card_was_moved_back_into_done",
							ensured.failureMessage,
							null,
						);
					}
					if (reopeningOperation.reopening) reopeningOperation.reopening.phase = "resuming_session";
					await writeTaskClosureOperation(reopeningOperation);
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

					{
						const reopened = makeReopenedRecord();
						await persistClosureRecord(
							workspaceScope,
							reopened,
							kanbanRequestOriginActorEvidence,
							reopeningOperation.reopening?.intent,
						);
					}
					if (reopeningOperation.reopening) {
						reopeningOperation.reopening.phase = "completed";
						reopeningOperation.reopening.lastError = null;
					}
					await writeTaskClosureOperation(reopeningOperation);
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
							?.cards.filter((taskCard) => !isTaskCardShelved(taskCard))
							.map((taskCard) => taskCard.id) ?? []);
			const subjectTaskIdSetHoldingPerTaskCommandSerialization = new Set(subjectTaskIdsOfTaskCardAction);
			return await runSeriallyForTaskCards(
				workspaceScope,
				subjectTaskIdsOfTaskCardAction,
				async (): Promise<RuntimeTaskCardActionPermanentlyDeleteResponse> => {
					const preservationByTaskId = new Map<string, TaskClosureOperation>();
					for (const taskId of subjectTaskIdsOfTaskCardAction)
						await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
							workspaceScope,
							taskId,
							input.expectedTaskIncarnationCreatedAtEpochMsByTaskId?.[taskId],
						);
					for (const taskId of subjectTaskIdsOfTaskCardAction) {
						const found = await readTaskCardWithPersistedSessionSummaryOutsideBoardLock(
							workspaceScope,
							taskId,
							input.expectedTaskIncarnationCreatedAtEpochMsByTaskId?.[taskId],
						);
						const existing = (
							await listTaskClosureOperations({
								workspaceId: workspaceScope.workspaceId,
								taskId,
								taskIncarnationCreatedAtEpochMs: found.taskCard.createdAt,
							})
						).find(
							(operation) =>
								operation.preservationPurpose === "permanently_delete_task" &&
								!["completed", "cancelled"].includes(operation.progress.phase),
						);
						if (!existing) await cancelPendingClosureOperations(workspaceScope, found.taskCard);
						const operation = await prepareVerifiedClosureOperation(
							workspaceScope,
							existing?.request ?? { taskId, expectedTaskIncarnationCreatedAtEpochMs: found.taskCard.createdAt },
							kanbanRequestOriginActorEvidence,
							"permanently_delete_task",
						);
						preservationByTaskId.set(taskId, operation);
					}
					for (const preserved of preservationByTaskId.values()) {
						preserved.progress.phase = "closed_cleanup_pending";
						await writeTaskClosureOperation(preserved);
					}
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
												input.expectedTaskIncarnationCreatedAtEpochMsByTaskId?.[taskId],
											),
										)
									: (
											state.board.columns.find((column) => column.id === selection.selectedBoardColumnId)
												?.cards ?? []
										)
											.filter(
												(taskCard) =>
													subjectTaskIdSetHoldingPerTaskCommandSerialization.has(taskCard.id) &&
													!isTaskCardShelved(taskCard),
											)
											.map((taskCard) => ({ taskCard, boardColumnId: selection.selectedBoardColumnId }));
							for (const selected of selectedTaskCards) {
								const preserved = preservationByTaskId.get(selected.taskCard.id);
								if (
									!preserved ||
									preserved.taskIdentity.taskIncarnationCreatedAtEpochMs !== selected.taskCard.createdAt ||
									preserved.sourceTaskUpdatedAtEpochMs !== selected.taskCard.updatedAt
								)
									throw new TRPCError({ code: "CONFLICT", message: "归档期间任务已改变，未执行永久删除。" });
							}
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
											resolveMainTaskConversationSessionSummaryForTaskId(
												state.board,
												state.sessions,
												found.taskCard.id,
											),
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

					const taskWorktreeDeletionResults = await Promise.all(
						permanentlyDeletedTaskCards.map(
							async ({ taskCard }) =>
								await deleteTaskWorktreeReportingFailure(
									workspaceScope,
									taskCard.id,
									taskCard.worktreeMode,
									preservationByTaskId.get(taskCard.id),
								),
						),
					);

					for (let index = 0; index < permanentlyDeletedTaskCards.length; index += 1) {
						const taskId = permanentlyDeletedTaskCards[index]?.taskCard.id;
						const operation = taskId ? preservationByTaskId.get(taskId) : null;
						if (operation) {
							operation.progress.phase = taskWorktreeDeletionResults[index]?.taskWorktreeDeletionErrorMessage
								? "closed_cleanup_pending"
								: "completed";
							operation.progress.lastError =
								taskWorktreeDeletionResults[index]?.taskWorktreeDeletionErrorMessage ?? null;
							await writeTaskClosureOperation(operation);
						}
					}

					// 批删全部 turn checkpoint ref（姊妹蓝图 §1.4：存续期全量保留，永久删除时按前缀批删）。
					// 顺序铁律：必须排在会话停止与 worktree 清理**之后**。hooks-api 的 to_review checkpoint 捕获是
					// runtime 侧不 await 的后台任务（hooks-api.ts F1），若先批删，枚举完成后在途捕获仍可能
					// update-ref，给已删除任务留下再无清理方的孤儿 ref。会话停止切断新 hook 来源（任务已从看板
					// 移除，transition 失败也不会再派生新捕获），批删放到最后给在途捕获最大收敛窗口。
					// 残余窗口：这里无法 await runtime 侧已派生的在途捕获，理论上仍可能有批删后才落定的孤儿 ref——
					// 与草稿清理同一套失败语义：这是删除已成之后的收尾，失败只吞不抛，残留几个无人认领的 ref，
					// 不该让已经删成的任务被报成失败。
					const checkpointOwnerSessionIds = new Set(
						permanentlyDeletedTaskCards.flatMap(({ taskCard }) => [
							taskCard.id,
							resolveMainTaskConversationSessionId(taskCard),
						]),
					);
					for (const taskId of checkpointOwnerSessionIds) {
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
						buildTaskCardSnapshot(
							workspaceScope,
							found,
							resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, identity.taskId),
						);
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
							resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, identity.taskId),
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
			await recoverPendingBacklogTaskProjectTransfers(workspaceScope.workspaceId);
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
						input.expectedTaskIncarnationCreatedAtEpochMs,
					);
					if (
						input.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
						found.taskCard.createdAt !== input.expectedTaskIncarnationCreatedAtEpochMs
					)
						throw new TRPCError({ code: "CONFLICT", message: "任务身份已变化，未写入编辑内容。" });
					const expected = input.expectedTaskTitleAndPromptForAiNameBackfill;
					if (expected && (found.taskCard.title !== expected.title || found.taskCard.prompt !== expected.prompt)) {
						return {
							board: state.board,
							value: buildTaskCardSnapshot(
								workspaceScope,
								found,
								resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId),
							),
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
							resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId),
						),
					};
				},
			);
			broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, update.saved);
			return { taskCardSnapshotAfterAction: update.value };
		},

		applyTaskStickerEntryMutation: async (workspaceScope, input, evidence) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				const mutation = await mutateWorkspaceState(
					workspaceScope.workspacePath,
					await resolveIntent("apply_task_sticker_entry_mutation", evidence, input.boardMutationInitiator, [
						input.taskId,
					]),
					(state) => {
						const found = findTaskCardWithBoardColumnOrThrowNotFound(
							state.board,
							input.taskId,
							workspaceScope.workspacePath,
							input.expectedTaskIncarnationCreatedAtEpochMs,
						);
						const taskCard = applyTaskStickerEntryMutationToTaskCard(found.taskCard, input.mutation, Date.now());
						const updated = taskCard !== found.taskCard;
						return {
							board: updated
								? {
										...state.board,
										columns: state.board.columns.map((column) => ({
											...column,
											cards: column.cards.map((card) => (card === found.taskCard ? taskCard : card)),
										})),
									}
								: state.board,
							save: updated,
							value: buildTaskCardSnapshot(
								workspaceScope,
								{ ...found, taskCard },
								resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId),
							),
						};
					},
				);
				broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, mutation.saved);
				return { boardWasSaved: mutation.saved, taskCardSnapshotAfterAction: mutation.value };
			}),

		setTaskCardShelvingStateWithoutSessionSideEffects: async (
			workspaceScope,
			input,
			kanbanRequestOriginActorEvidence,
		) =>
			await runSeriallyForTaskCards(workspaceScope, [input.taskId], async () => {
				const shelving = await mutateWorkspaceState(
					workspaceScope.workspacePath,
					await resolveIntent(
						"set_task_card_shelving_state",
						kanbanRequestOriginActorEvidence,
						input.boardMutationInitiator,
						[input.taskId],
					),
					(state) => {
						const found = findTaskCardWithBoardColumnOrThrowNotFound(
							state.board,
							input.taskId,
							workspaceScope.workspacePath,
							input.expectedTaskIncarnationCreatedAtEpochMs,
						);
						const mutation = setTaskCardShelvingState(state.board, input.taskId, input.isShelved);
						const updatedFound = findTaskCardWithBoardColumn(mutation.board, input.taskId) ?? found;
						return {
							board: mutation.board,
							save: mutation.updated,
							value: buildTaskCardSnapshot(
								workspaceScope,
								updatedFound,
								resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId),
							),
						};
					},
				);
				broadcastWorkspaceStateUpdatedWhenBoardWasSaved(workspaceScope, shelving.saved);
				return { boardWasSaved: shelving.saved, taskCardSnapshotAfterAction: shelving.value };
			}),

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
						input.expectedTaskIncarnationCreatedAtEpochMs,
					);
					const taskSessionSummaryPersistedInWorkspaceSessionsFile =
						resolveMainTaskConversationSessionSummaryForTaskId(state.board, state.sessions, input.taskId);
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
