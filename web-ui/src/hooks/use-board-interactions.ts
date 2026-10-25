import type { DropResult } from "@hello-pangea/dnd";
import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import {
	isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow,
	isAwaitingUserReviewTurn,
	isNeverStartedPlaceholderTaskSessionSummary,
	isParkedAwaitingDispatchedBackgroundWork,
	isTaskMainSessionHandoverSuspendingAutomaticActions,
	resolveMainTaskConversationSessionSummary,
	resolveSessionFacets,
} from "@runtime-session-activity";
import { classifyTaskCardBoardColumnTransitionRequestedByUserGesture } from "@runtime-task-card-action-board-column-transitions";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import {
	describePostDeployVerificationDoneEntryGateRejectionForHumans,
	doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask,
	evaluatePostDeployVerificationDoneEntryGatePrecheckForTask,
	isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate,
	isWebUiBoardMutationInitiatorClientAutomation,
	resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import type { TaskPinboardPinReasonDialogRequest } from "@/components/task-pinboard-pin-reason-dialog";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import {
	type PostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
	usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone,
} from "@/hooks/use-post-deploy-verification-done-entry-closure-dialog-for-board-moves-into-done";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import {
	type TaskCommentBeforeMoveIntoDoneController,
	useTaskCommentBeforeMoveIntoDone,
} from "@/hooks/use-task-comment-before-move-into-done";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceInfoResponse,
} from "@/runtime/types";
import {
	disableTaskAutoReview,
	findCardSelection,
	getTaskColumnId,
	moveTaskToColumn,
	placeTaskCardIntoBoardColumnAtIndexByTaskId,
	resolveTaskCardDropFromDragResultByTaskId,
} from "@/state/board-state";
import { waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart } from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import {
	moveTaskCardBetweenNonTrashColumnsThroughRuntime,
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime,
	moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime,
	permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime,
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime,
	setTaskPinboardPinStateOfTaskCardThroughRuntime,
	startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime,
	updateTaskCardFieldValuesThroughRuntime,
} from "@/state/task-card-action-commands-for-any-workspace";
import {
	recordWebUiBoardMutationInitiatorForTaskCardAspect,
	withWebUiBoardMutationInitiatorRecordedForChangedTaskCards,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import { hasPendingTaskCardCommandBoardOverlayEntryForTaskCard } from "@/stores/pending-task-card-command-board-overlay-store";
import { beginTaskAgentSessionStartRequestInFlight } from "@/stores/task-agent-session-start-request-in-flight-store";
import { readTaskCardActionCommandKindInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import { clearTaskWorkspaceInfo, setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import { trackTaskResumedFromTrash } from "@/telemetry/events";
import { resolveAgentTerminalGeometryForTaskSessionSpawn } from "@/terminal/agent-terminal-geometry-for-task-session-spawn";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import type {
	TaskCardMoveIntoDoneRequestHandler,
	TaskCommentToAppendWhenMovingIntoDone,
} from "@/types/task-card-move-into-done-request";
import {
	getNextDetailTaskIdAfterTrashMove,
	getNextReviewTaskIdAfterReviewTaskMovesToValidation,
} from "@/utils/detail-view-task-order";
import {
	getBrowserNotificationPermission,
	hasPromptedForBrowserNotificationPermission,
	requestBrowserNotificationPermission,
} from "@/utils/notification-permission";

interface TaskGitActionLoadingStateLike {
	commitSource: string | null;
	prSource: string | null;
}

interface SelectedBoardCard {
	card: BoardCard;
	column: {
		id: BoardColumnId;
	};
}

interface PendingProgrammaticStartMoveCompletion {
	resolve: (started: boolean) => void;
	timeoutId: number;
}

// requestMoveTaskToTrash 撞上浏览器侧在途闸（同卡另有卡片动作命令在途）时抛出：这类失败没有弹过提示、且稍后可重试，
// 调用方（看板级原因对话框）据此与「已弹错的失败」区分开。
class MoveTaskCardIntoDoneRejectedBecauseAnotherCommandInFlightForTaskCardError extends Error {}

interface UseBoardInteractionsInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	selectedCard: SelectedBoardCard | null;
	selectedTaskId: string | null;
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	setIsClearTrashDialogOpen: Dispatch<SetStateAction<boolean>>;
	setIsGitHistoryOpen: Dispatch<SetStateAction<boolean>>;
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	sendTaskSessionInput: UseTaskSessionsResult["sendTaskSessionInput"];
	sendTaskChatMessage: UseTaskSessionsResult["sendTaskChatMessage"];
	readyForReviewNotificationsEnabled: boolean;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingStateLike>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	// All projects Focus View 的分组导航：操作前捕获，成功后调用；null 才回退到普通 Review 列顺序。
	captureCacheWarmTaskFocusNavigationAfterValidationMove?: (taskId: string) => (() => void) | null;
	// Post-Deploy Verification「移入 Done」门禁的客户端预检数据：当前项目的活跃部署组（App 持有的唯一
	// usePostDeployVerification 实例）。缺省 = 不预检，全靠服务端拒绝后的兜底。
	postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck?: RuntimePostDeployVerificationDeploymentGroup | null;
	// 服务端以门禁拒绝（预检数据过期）后立即重拉 PDV 读模型，让原因对话框列出服务端看到的未勾项。
	refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection?: () => void;
}

// completePostDeployVerificationMoveToDone 的结果：失败时带上服务端说明，供 PDV 面板的批量结案逐个报告。
export interface PostDeployVerificationMoveIntoDoneCompletionResult {
	ok: boolean;
	moveIntoDoneFailureMessage?: string;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: TaskCardMoveIntoDoneRequestHandler;
	taskCommentBeforeMoveIntoDone: TaskCommentBeforeMoveIntoDoneController;
	confirmTaskCommentBeforeMoveIntoDone: (commentText: string) => void;
	isMoveToDoneConfirmOpen: boolean;
	confirmMoveToDone: () => void;
	cancelMoveToDone: () => void;
	// Post-Deploy Verification 面板的移入 Done 入口：语义等价 performMoveToTrash（直接移入 trash/Done，
	// 绕过 requestMoveToTrash 对 review/in_progress 的 SkipValidationConfirmDialog 与看板级原因对话框——PDV 面板有自己的
	// 对话框），但**可 await 且返回成败**，供调用方在移列确实成功后才写 boardMovedToDoneAt。fromColumnId 取任务的当前实际列
	// （getTaskColumnId），非快照。带 closure（逐项原因 / 确认项）时不走动画：动画路径的完成 Promise 不传播失败，而带原因的
	// 结案必须让调用方知道服务端有没有收下。
	completePostDeployVerificationMoveToDone: (
		taskId: string,
		fromColumnId: BoardColumnId,
		postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
	) => Promise<PostDeployVerificationMoveIntoDoneCompletionResult>;
	// 看板入口（按钮 / 拖拽 / 服务端拒绝兜底）撞上 PDV 门禁时的原因对话框；null = 未打开。
	postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone: PostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone | null;
	isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting: boolean;
	confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone: (
		closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>,
	) => void;
	cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone: () => void;
	handleMoveCardToValidation: (taskId: string) => void;
	handleMoveSelectedCardToValidation: () => void;
	// 手动「移至 Review」：仅 In Progress 卡可用，翻会话回合 + 由 Rule A 自动落位 Review。
	handleMoveCardToReview: (taskId: string) => void;
	moveToReviewLoadingById: Record<string, boolean>;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleOpenDeleteTask: (taskId: string) => void;
	handleCancelDeleteTask: () => void;
	handleConfirmDeleteTask: () => void;
	deleteTaskTarget: BoardCard | null;
	handleCancelAutomaticTaskAction: (taskId: string) => void;
	// Task Pinboard：点 pin → 打开原因对话框；确认后才真正写盘。unpin 不经对话框，直接生效。
	handleRequestPinTaskToTaskPinboard: (taskId: string) => void;
	handleRequestEditTaskPinboardPinReason: (taskId: string) => void;
	handleCancelTaskPinboardPinReason: () => void;
	handleConfirmTaskPinboardPinReason: (taskId: string, pinReason: string) => void;
	handleUnpinTaskFromTaskPinboard: (taskId: string) => void;
	taskPinboardPinReasonRequest: TaskPinboardPinReasonDialogRequest | null;
	handleOpenClearTrash: () => void;
	handleConfirmClearTrash: () => void;
	handleAddReviewComments: (taskId: string, text: string) => Promise<void>;
	handleSendReviewComments: (taskId: string, text: string) => Promise<void>;
	moveToTrashLoadingById: Record<string, boolean>;
	trashTaskCount: number;
}

export function useBoardInteractions({
	board,
	setBoard,
	sessions,
	setSessions,
	selectedCard,
	selectedTaskId,
	currentProjectId,
	setSelectedTaskId,
	setIsClearTrashDialogOpen,
	setIsGitHistoryOpen,
	fetchTaskWorkspaceInfo,
	sendTaskSessionInput,
	sendTaskChatMessage,
	readyForReviewNotificationsEnabled,
	taskGitActionLoadingByTaskId,
	runAutoReviewGitAction,
	captureCacheWarmTaskFocusNavigationAfterValidationMove,
	postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck = null,
	refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection,
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	// 事件入口读取最新状态，避免每个 session tick 改变整棵卡片树的 handler 身份。PDV 活跃组同理：
	// 30s 轮询换引用不该让卡片 handler 身份跟着变。
	const latestBoardInteractionStateRef = useRef({
		board,
		sessions,
		selectedTaskId,
		captureCacheWarmTaskFocusNavigationAfterValidationMove,
		postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
		refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection,
	});
	latestBoardInteractionStateRef.current = {
		board,
		sessions,
		selectedTaskId,
		captureCacheWarmTaskFocusNavigationAfterValidationMove,
		postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
		refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection,
	};
	const {
		closureDialogForBoardMoveIntoDone: postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		openClosureDialogForBoardMoveIntoDone: openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		markClosureDialogTaskRejectedByRuntimeForMissingClosureReasons:
			markPostDeployVerificationDoneEntryClosureDialogTaskRejectedByRuntime,
		closeClosureDialogForBoardMoveIntoDone: closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		isClosureForBoardMoveIntoDoneSubmitting: isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
		setIsClosureForBoardMoveIntoDoneSubmitting:
			setIsPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
		showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard,
	} = usePostDeployVerificationDoneEntryClosureDialogForBoardMovesIntoDone({
		board,
		postDeployVerificationActiveDeploymentGroup: postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
	});
	const previousSessionsRef = useRef<Record<string, RuntimeTaskSessionSummary>>({});
	// B5：Rule A 列自动流转上一帧处理时的 board 引用，配合下方 effect 的 summary 引用短路。
	// board 自上一帧以来若发生过任何外部写入（用户拖拽等），必须放开全量重估——流转分支由
	// (summary, board) 共同驱动，只看 summary 引用会把「外部板面变更后的 level-triggered 重估」
	// 一并短路掉（例如把 awaiting_review 卡拖回 In Progress，下一 tick 会被自动拉回 Review）。
	const previousAutoFlowBoardRef = useRef<BoardData | null>(null);
	const notificationPermissionPromptInFlightRef = useRef(false);
	const moveToTrashLoadingByIdRef = useRef<Record<string, true>>({});
	const pendingProgrammaticStartMoveCompletionByTaskIdRef = useRef<
		Record<string, PendingProgrammaticStartMoveCompletion>
	>({});
	const [moveToTrashLoadingById, setMoveToTrashLoadingById] = useState<Record<string, boolean>>({});
	// 「移至 Review」按钮的 per-task in-flight 态（端点 await 期间显 Spinner）。
	const [moveToReviewLoadingById, setMoveToReviewLoadingById] = useState<Record<string, boolean>>({});
	// Pending "Move to Done" awaiting confirmation. Set whenever a move would skip the manual
	// Validation step (from Review / In Progress); the App-level SkipValidationConfirmDialog reads
	// this to open, and confirm/cancel resolve it. null = no confirmation in flight.
	const taskCommentBeforeMoveIntoDone = useTaskCommentBeforeMoveIntoDone();
	const {
		open: openTaskCommentBeforeMoveIntoDone,
		complete: completeTaskCommentBeforeMoveIntoDone,
		returnToEditing: returnToEditingTaskCommentBeforeMoveIntoDone,
		suspendForConfirmation: suspendTaskCommentBeforeMoveIntoDone,
		cancel: cancelTaskCommentBeforeMoveIntoDone,
		prepareSubmission: prepareTaskCommentBeforeMoveIntoDone,
	} = taskCommentBeforeMoveIntoDone;
	const [pendingMoveToDone, setPendingMoveToDone] = useState<{
		taskId: string;
		fromColumnId: BoardColumnId;
		taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
	} | null>(null);
	const [deleteTaskTarget, setDeleteTaskTarget] = useState<BoardCard | null>(null);
	// 置顶原因对话框的在途请求（null = 未打开）。新 pin 与「编辑已有原因」共用同一个对话框，
	// 靠 isEditingExistingPin 区分按钮文案与「确认时是否要写入置顶时间」。
	const [taskPinboardPinReasonRequest, setTaskPinboardPinReasonRequest] =
		useState<TaskPinboardPinReasonDialogRequest | null>(null);
	const {
		handleProgrammaticCardMoveReady,
		setRequestMoveTaskToTrashHandler,
		tryProgrammaticCardMove,
		consumeProgrammaticCardMove,
		resolvePendingProgrammaticTrashMove,
		waitForProgrammaticCardMoveAvailability,
		resetProgrammaticCardMoves,
		requestMoveTaskToTrashWithAnimation,
		programmaticCardMoveCycle,
	} = useProgrammaticCardMoves();

	const resolvePendingProgrammaticStartMove = useCallback((taskId: string, started: boolean) => {
		const pending = pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		if (!pending) {
			return;
		}
		window.clearTimeout(pending.timeoutId);
		delete pendingProgrammaticStartMoveCompletionByTaskIdRef.current[taskId];
		pending.resolve(started);
	}, []);

	const moveFocusedReviewTaskToNextReviewTaskAfterValidationMove = useCallback(
		(boardBeforeReviewToValidationMove: BoardData, movedTaskId: string) => {
			const nextReviewTaskId = getNextReviewTaskIdAfterReviewTaskMovesToValidation(
				boardBeforeReviewToValidationMove,
				movedTaskId,
			);
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === movedTaskId ? (nextReviewTaskId ?? currentSelectedTaskId) : currentSelectedTaskId,
			);
		},
		[setSelectedTaskId],
	);

	const getPrimaryBoardTaskElement = useCallback((taskId: string): HTMLElement | null => {
		const boardElement = document.querySelector<HTMLElement>(".kb-board");
		if (!boardElement) {
			return null;
		}
		for (const element of boardElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
			if (element.dataset.taskId === taskId) {
				return element;
			}
		}
		return null;
	}, []);

	const waitForBacklogCardHeightToSettle = useCallback(
		async (taskId: string): Promise<void> => {
			if (!getPrimaryBoardTaskElement(taskId)) {
				return;
			}

			await new Promise<void>((resolve) => {
				let previousHeight = 0;
				let stableFrameCount = 0;
				let framesRemaining = 8;

				const measure = () => {
					const cardElement = getPrimaryBoardTaskElement(taskId);
					const nextHeight = cardElement?.getBoundingClientRect().height ?? 0;
					if (nextHeight > 0 && previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) {
						stableFrameCount += 1;
					} else {
						stableFrameCount = 0;
					}
					previousHeight = nextHeight;

					if (stableFrameCount >= 1 || framesRemaining <= 0) {
						resolve();
						return;
					}

					framesRemaining -= 1;
					window.requestAnimationFrame(measure);
				};

				window.requestAnimationFrame(measure);
			});
		},
		[getPrimaryBoardTaskElement],
	);

	const setTaskMoveToTrashLoading = useCallback((taskId: string, isLoading: boolean) => {
		if (isLoading) {
			moveToTrashLoadingByIdRef.current[taskId] = true;
			setMoveToTrashLoadingById((current) => {
				if (current[taskId]) {
					return current;
				}
				return {
					...current,
					[taskId]: true,
				};
			});
			return;
		}

		delete moveToTrashLoadingByIdRef.current[taskId];
		setMoveToTrashLoadingById((current) => {
			if (!current[taskId]) {
				return current;
			}
			const next = { ...current };
			delete next[taskId];
			return next;
		});
	}, []);

	const handleAddReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const typed = await sendTaskSessionInput(taskId, text, {
				appendNewline: false,
				mode: "paste",
				requireTerminalPasteSuccess: true,
			});
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not add review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
	);

	const handleSendReviewComments = useCallback(
		async (taskId: string, text: string) => {
			const sent = await sendTaskChatMessage(taskId, text, {
				deliveryOrigin: { messageType: "human_message", sourceLabel: "评审意见" },
			});
			if (!sent.ok)
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: sent.message ?? "无法发送评审意见。",
					timeout: 7000,
				});
		},
		[sendTaskChatMessage],
	);

	const trashTaskIds = useMemo(() => {
		const trashColumn = board.columns.find((column) => column.id === "trash");
		return trashColumn ? trashColumn.cards.map((card) => card.id) : [];
	}, [board.columns]);
	const trashTaskCount = trashTaskIds.length;

	const maybeRequestNotificationPermissionForTaskStart = useCallback(() => {
		const shouldPromptForNotificationPermission =
			readyForReviewNotificationsEnabled &&
			getBrowserNotificationPermission() === "default" &&
			!hasPromptedForBrowserNotificationPermission() &&
			!notificationPermissionPromptInFlightRef.current;
		if (!shouldPromptForNotificationPermission) {
			return;
		}
		notificationPermissionPromptInFlightRef.current = true;
		void requestBrowserNotificationPermission().finally(() => {
			notificationPermissionPromptInFlightRef.current = false;
		});
	}, [readyForReviewNotificationsEnabled]);

	// 启动走 taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress：服务端先移列、再 ensure worktree、再起会话，
	// 浏览器只叠 overlay（卡立刻显示在 In Progress，不改会被保存的 board）。
	const startTaskCardAgentSessionInCurrentProject = useCallback(
		async (
			task: BoardCard,
			options?: {
				insertAtIndexWithinInProgressBoardColumn?: number;
				boardMutationInitiator?: WebUiBoardMutationInitiator;
			},
		): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			// 整个启动窗口都标成「启动请求进行中」，让终端面板显示「正在启动」，而不是把占位 summary + 空终端误判成
			// 「会话随上一个运行时没了」、再递出一个会和本次启动抢 per-task 闸门的续跑按钮（详见该 store 顶部注释）。
			const startRequestInFlight = beginTaskAgentSessionStartRequestInFlight(currentProjectId, task.id);
			try {
				// cf427：本页面刚建的卡先等 runtime 确认落盘再启动；runtime 的 startTaskSession 也有同义的门。
				const persisted = await waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
					workspaceId: currentProjectId,
					taskCard: task,
				});
				if (!persisted.ok) {
					notifyError(`Could not save the new task card, so its agent was not started: ${persisted.message}`);
					return false;
				}
				const result = await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
					workspaceId: currentProjectId,
					taskId: task.id,
					expectedTaskIncarnationCreatedAtEpochMs: task.createdAt,
					agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(task.id),
					currentProjectBoardForOptimisticOverlay: latestBoardInteractionStateRef.current.board,
					...(options?.insertAtIndexWithinInProgressBoardColumn !== undefined
						? { insertAtIndexWithinInProgressBoardColumn: options.insertAtIndexWithinInProgressBoardColumn }
						: {}),
					...(options?.boardMutationInitiator ? { boardMutationInitiator: options.boardMutationInitiator } : {}),
				});
				if (
					result.taskCardActionCommandExecutionOutcome ===
					"rejected_because_another_command_is_in_flight_for_task_card"
				) {
					return false;
				}
				if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
					notifyError(`Could not start task session: ${result.commandFailureMessage}`);
					return false;
				}
				const { response } = result;
				if (response.ensuredTaskWorktreeWarningMessage) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: response.ensuredTaskWorktreeWarningMessage,
						timeout: 7000,
					});
				}
				if (latestBoardInteractionStateRef.current.selectedTaskId === task.id) {
					const infoAfterStart = await fetchTaskWorkspaceInfo(task);
					if (infoAfterStart) {
						setTaskWorkspaceInfo(infoAfterStart);
					}
				}
				if (
					response.agentSessionStartOutcome === "task_worktree_ensure_failed" ||
					response.agentSessionStartOutcome === "agent_session_start_failed"
				) {
					// 卡片按服务端规则留在 In Progress，会话状态与错误保持可见。
					notifyError(response.agentSessionStartFailureMessage ?? "Could not start task session.");
					return false;
				}
				return true;
			} finally {
				// 成功时 running summary 通常早已经由运行时状态流（spawn 后 150ms 批广播）到达，远早于这条响应，
				// 所以这里清标记不会让「已死」提示闪一下。
				startRequestInFlight.finish();
			}
		},
		[currentProjectId, fetchTaskWorkspaceInfo],
	);

	const startBacklogTaskImmediately = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			const { board } = latestBoardInteractionStateRef.current;
			const selection = findCardSelection(board, task.id);
			if (!selection || selection.column.id !== "backlog") {
				return false;
			}
			return startTaskCardAgentSessionInCurrentProject(task, { insertAtIndexWithinInProgressBoardColumn: 0 });
		},
		[startTaskCardAgentSessionInCurrentProject],
	);

	const startBacklogTaskWithAnimation = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			if (selectedCard) {
				return startBacklogTaskImmediately(task);
			}

			await waitForBacklogCardHeightToSettle(task.id);

			const programmaticMoveAttempt = tryProgrammaticCardMove(task.id, "backlog", "in_progress", {
				boardMutationInitiator: "web_ui_user_gesture",
			});
			if (programmaticMoveAttempt === "blocked") {
				await waitForProgrammaticCardMoveAvailability();
				return startBacklogTaskWithAnimation(task);
			}
			if (programmaticMoveAttempt === "unavailable") {
				return startTaskCardAgentSessionInCurrentProject(task, { insertAtIndexWithinInProgressBoardColumn: 0 });
			}

			let resolveCompletion: ((started: boolean) => void) | null = null;
			const completionPromise = new Promise<boolean>((resolve) => {
				resolveCompletion = resolve;
			});
			const timeoutId = window.setTimeout(() => {
				resolvePendingProgrammaticStartMove(task.id, false);
			}, 5000);
			pendingProgrammaticStartMoveCompletionByTaskIdRef.current[task.id] = {
				resolve: (started) => {
					resolveCompletion?.(started);
					resolveCompletion = null;
				},
				timeoutId,
			};
			return completionPromise;
		},
		[
			resolvePendingProgrammaticStartMove,
			selectedCard,
			startBacklogTaskImmediately,
			startTaskCardAgentSessionInCurrentProject,
			tryProgrammaticCardMove,
			waitForBacklogCardHeightToSettle,
			waitForProgrammaticCardMoveAvailability,
		],
	);

	// 下方 level-triggered 列自动流转（会话 facet 驱动）在 updater 里逐卡决定移列；直接落列的分支在这里登记发起方，
	// 走动画的分支把发起方放进在途移动，由 handleDragEnd 落地时登记。登记是幂等的「按卡覆盖」，updater 重放无害。
	const recordSessionFacetDrivenColumnAutoflowInitiator = useCallback((taskId: string) => {
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId,
			boardMutationAspectOfTaskCard: "task_card_column_placement",
			boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
		});
	}, []);

	useEffect(() => {
		setBoard((currentBoard) => {
			let nextBoard = currentBoard;
			const previousSessions = previousSessionsRef.current;
			const boardChangedSinceLastRun = previousAutoFlowBoardRef.current !== currentBoard;
			const deferredRetryTaskIds = new Set<string>();
			const nowMs = Date.now();
			const mainSessionsByTaskCardId: Record<string, RuntimeTaskSessionSummary> = {};
			for (const card of currentBoard.columns.flatMap((column) => column.cards)) {
				const primary = resolveMainTaskConversationSessionSummary(card, sessions);
				if (primary && !isTaskMainSessionHandoverSuspendingAutomaticActions(card))
					mainSessionsByTaskCardId[card.id] = primary;
			}
			for (const [taskId, summary] of Object.entries(mainSessionsByTaskCardId)) {
				const previous = previousSessions[taskId];
				// B5 引用短路：summary 引用跨 tick 稳定（runtime-state-hub merge 只替换改动 key），
				// 引用未变即内容未变；board 也未变时本帧处理结果与上一帧相同（纯 no-op），直接跳过，
				// 省掉每 tick 对全部 N 条 summary 的 getTaskColumnId 全板扫描与 resolveSessionFacets。
				// 唯一的时间依赖 isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow 只在持续产出时为真，而持续产出 ⇒
				// summary 每 tick 换新引用，不会被本短路跳过。
				if (!boardChangedSinceLastRun && previous === summary) {
					continue;
				}
				if (previous && previous.updatedAt > summary.updatedAt) {
					continue;
				}
				// 这张卡正等一条服务端卡片动作命令落定（在途、或已结算等广播回灌）：自动流转不抢在它前面改列——
				// 否则浏览器保存的自动移列可能先于命令落盘，让命令看到「卡已经在那了」而跳过它的会话副作用。
				// 不记为已见，命令落定（board 变化）后的下一帧重新评估。
				if (
					currentProjectId &&
					(readTaskCardActionCommandKindInFlight(currentProjectId, taskId) !== null ||
						hasPendingTaskCardCommandBoardOverlayEntryForTaskCard(currentProjectId, taskId))
				) {
					deferredRetryTaskIds.add(taskId);
					continue;
				}
				let columnId = getTaskColumnId(nextBoard, taskId);
				const taskCardUpdatedAtMs = findCardSelection(nextBoard, taskId)?.card.updatedAt;
				// 双轴迁移（Stage 3 ④，行为保持）：列自动流转的 state 读全部翻为 facet 权威
				// （resolveSessionFacets），绕开 projectLegacyState 对 live↔exited 的有损压扁。各判据
				// 严格等价旧 legacy state：isAwaitingUserReviewTurn ⟺ awaiting_review（含 user+exited
				// 折叠，故进程已退却仍等人审的会话照旧自动落位 review，不偷渡 distinction ②）、
				// turnOwner==="agent" ⟺ running、liveness==="interrupted" ⟺ interrupted。
				const facets = resolveSessionFacets(summary);
				const previousFacets = previous ? resolveSessionFacets(previous) : undefined;
				if (columnId === "backlog" && summary.startedAt != null) {
					const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(taskId);
						nextBoard = moved.board;
						columnId = "in_progress";
					}
				}
				if (isAwaitingUserReviewTurn(facets) && columnId === "in_progress") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, columnId, "review", {
						boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						// B5：本帧未落直接移列（动画接管 / 被在途移动阻塞）的 task 不得记录为已见，
						// 否则引用短路会吃掉下一 tick 的重试（短路前由 updatedAt guard 放行每 tick 重估）。
						deferredRetryTaskIds.add(taskId);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, taskId, "review", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(taskId);
						nextBoard = moved.board;
					}
					continue;
				}
				// Review 列与 Validation 列对齐——同用活跃度 offset：仅当 agent 此刻仍在持续产出输出
				// （isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow，内含 turnOwner==="agent"）时才打回 In Progress；空闲 /
				// 卡死 / 已退出却仍处 agent 回合的会话允许停留在 review（review 是等人审查回合的自动落位区，
				// 也是「移至 Review」手动钉住空闲会话的落位区）。原 Review 分支只读裸 turnOwner==="agent"，
				// 把空闲 / 卡死的 agent 回合会话也反复打回——这正是当年为绕开它而加 manual_review 永久锁的动因；
				// 补上 offset 后该锁不再必要（见 session-state-machine.ts canReturnToRunning）。
				// **例外（强制）**：parked（已派发后台工作、等自行恢复）的会话被外部编排有意放在 review 等结果，
				// 即便仍在产出也不可打回，否则会被反复 bounce / 抖动。
				const shouldBounceRunningToInProgress =
					(columnId === "review" &&
						!isParkedAwaitingDispatchedBackgroundWork(summary) &&
						isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow(
							summary,
							nowMs,
							taskCardUpdatedAtMs,
						)) ||
					(columnId === "validation" &&
						isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow(
							summary,
							nowMs,
							taskCardUpdatedAtMs,
						));
				if (shouldBounceRunningToInProgress && (columnId === "review" || columnId === "validation")) {
					const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, columnId, "in_progress", {
						skipKickoff: true,
						boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						// B5：同 Review 落位分支——动画接管 / 被阻塞的 task 不记录为已见，保留下一 tick 重试。
						deferredRetryTaskIds.add(taskId);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(taskId);
						nextBoard = moved.board;
					}
					continue;
				}
				if (
					facets.liveness === "interrupted" &&
					previousFacets?.liveness !== "interrupted" &&
					columnId &&
					columnId !== "trash" &&
					columnId !== "validation"
				) {
					// 受 Post-Deploy Verification 门禁的卡（全勾的也算）：会话中断不自动进 Done，与 validation 列排除同理。
					// 这条自动流转走浏览器本地移列 + 整板保存，不经 taskCardAction 的门禁，结不了案；服务端的整板保存兜底会把
					// 未结案的受门禁卡改回原列，所以这里不移，免得卡片进了 Done 又弹回来。只在中断边沿判一次（上面的
					// previousFacets 条件），不记入重试，因此不会每 tick 重试刷屏。
					if (
						evaluatePostDeployVerificationDoneEntryGatePrecheckForTask(
							latestBoardInteractionStateRef.current
								.postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
							taskId,
						).postDeployVerificationDoneEntryGatePrecheckOutcome !==
						"task_not_subject_to_post_deploy_verification_done_entry_gate"
					) {
						showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard(taskId);
						continue;
					}
					const nextTaskId = getNextDetailTaskIdAfterTrashMove(nextBoard, taskId);
					const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, columnId, "trash", {
						skipTrashWorkflow: true,
						boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						if (programmaticMoveAttempt === "blocked") {
							deferredRetryTaskIds.add(taskId);
						}
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === taskId ? nextTaskId : currentSelectedTaskId,
						);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, taskId, "trash", { insertAtTop: true });
					if (moved.moved) {
						recordWebUiBoardMutationInitiatorForTaskCardAspect({
							taskId: taskId,
							boardMutationAspectOfTaskCard: "task_card_column_placement",
							boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
						});
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === taskId ? nextTaskId : currentSelectedTaskId,
						);
						nextBoard = moved.board;
					}
				}
			}
			const nextPreviousSessions = { ...mainSessionsByTaskCardId };
			for (const taskId of deferredRetryTaskIds) {
				const previousSession = previousSessions[taskId];
				if (previousSession) {
					nextPreviousSessions[taskId] = previousSession;
					continue;
				}
				delete nextPreviousSessions[taskId];
			}
			previousSessionsRef.current = nextPreviousSessions;
			previousAutoFlowBoardRef.current = nextBoard;
			return nextBoard;
		});
	}, [
		currentProjectId,
		programmaticCardMoveCycle,
		sessions,
		setBoard,
		setSelectedTaskId,
		showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard,
		tryProgrammaticCardMove,
	]);

	// 移入 Done 走 taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree：服务端移列、停 agent 会话与
	// 详情 shell 终端、删 worktree。浏览器只叠 overlay、把焦点挪到下一张卡。失败时抛错，让可 await 的调用方（PDV 完成）
	// 拿到失败；动画路径的完成 Promise 照旧不传播失败（与改动前一致）。
	// 服务端以 Post-Deploy Verification 门禁拒绝（PRECONDITION_FAILED，客户端预检数据过期时才会发生）时不弹通用错误，
	// 按 resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone 分流：用户手势 → 打开原因对话框；
	// 浏览器端自动化 → 只提示一次；已带原因 / PDV 面板完成流 → 原样抛给调用方处理。
	const requestMoveTaskToTrash = useCallback(
		async (
			taskId: string,
			_fromColumnId: BoardColumnId,
			options?: {
				optimisticMoveApplied?: boolean;
				skipWorkingChangeWarning?: boolean;
				boardMutationInitiator?: WebUiBoardMutationInitiator;
				insertAtIndexWithinDoneBoardColumn?: number;
				postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest;
				taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone;
			},
		): Promise<void> => {
			const { board } = latestBoardInteractionStateRef.current;
			if (!currentProjectId || !findCardSelection(board, taskId)) {
				if (options?.taskCommentToAppendWhenMovingIntoDone) throw new Error("任务已不在当前项目中，未提交评论。");
				return;
			}
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === taskId ? getNextDetailTaskIdAfterTrashMove(board, taskId) : currentSelectedTaskId,
			);
			const result = await moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				...(options?.taskCommentToAppendWhenMovingIntoDone
					? { taskCommentToAppendWhenMovingIntoDone: options.taskCommentToAppendWhenMovingIntoDone }
					: {}),
				currentProjectBoardForOptimisticOverlay: board,
				...(options?.insertAtIndexWithinDoneBoardColumn !== undefined
					? { insertAtIndexWithinDoneBoardColumn: options.insertAtIndexWithinDoneBoardColumn }
					: {}),
				...(options?.boardMutationInitiator ? { boardMutationInitiator: options.boardMutationInitiator } : {}),
				...(options?.postDeployVerificationDoneEntryClosure
					? { postDeployVerificationDoneEntryClosure: options.postDeployVerificationDoneEntryClosure }
					: {}),
			});
			if (
				result.taskCardActionCommandExecutionOutcome === "command_failed" &&
				isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(result.commandFailureMessage)
			) {
				latestBoardInteractionStateRef.current.refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection?.();
				switch (
					resolvePostDeployVerificationDoneEntryGateRejectionHandlingForMoveIntoDone({
						postDeployVerificationDoneEntryClosureWasSupplied:
							options?.postDeployVerificationDoneEntryClosure !== undefined,
						boardMutationInitiator: options?.boardMutationInitiator,
					})
				) {
					case "open_board_level_closure_reason_dialog_for_user_gesture":
						if (options?.taskCommentToAppendWhenMovingIntoDone) suspendTaskCommentBeforeMoveIntoDone(taskId);
						openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone({
							taskCommentToAppendWhenMovingIntoDone: options?.taskCommentToAppendWhenMovingIntoDone,
							taskId,
							insertAtIndexWithinDoneBoardColumn: options?.insertAtIndexWithinDoneBoardColumn,
							runtimeRejectedMoveIntoDoneForMissingClosureReasons: true,
						});
						break;
					case "show_one_time_notice_because_move_was_automation_initiated":
						showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard(taskId);
						break;
					case "rethrow_to_awaiting_caller_that_supplied_closure_or_owns_completion_flow":
						break;
				}
				throw new Error(result.commandFailureMessage);
			}
			if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
				notifyError(`Could not move the task to Done: ${result.commandFailureMessage}`);
				throw new Error(result.commandFailureMessage);
			}
			if (
				result.taskCardActionCommandExecutionOutcome ===
				"rejected_because_another_command_is_in_flight_for_task_card"
			) {
				// 这里不弹提示（在途 spinner 已可见，连点不刷屏）；用专门的错误类型让需要的调用方自己给反馈。
				throw new MoveTaskCardIntoDoneRejectedBecauseAnotherCommandInFlightForTaskCardError(
					`Another action is still running for task "${taskId}".`,
				);
			}
			const worktreeDeletionErrorMessage =
				result.response.taskWorktreeDeletionResult?.taskWorktreeDeletionErrorMessage ?? null;
			if (worktreeDeletionErrorMessage) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: `Moved to Done, but the task worktree could not be removed: ${worktreeDeletionErrorMessage}`,
					timeout: 7000,
				});
			}
		},
		[
			currentProjectId,
			openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
			setSelectedTaskId,
			suspendTaskCommentBeforeMoveIntoDone,
			showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard,
		],
	);

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	// 自动 review 完成后的自动移入 Done：受 PDV 门禁（有未勾项）的卡不发起（连动画都不放），只提示一次；
	// 自动 review 每次只尝试一次（见 use-review-auto-actions 的在途登记），因此不会重试刷屏。
	const requestMoveTaskToTrashWithAnimationSkippingPostDeployVerificationGatedTaskCards = useCallback(
		async (
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { skipWorkingChangeWarning?: boolean; boardMutationInitiator?: WebUiBoardMutationInitiator },
		): Promise<void> => {
			if (
				doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask(
					latestBoardInteractionStateRef.current
						.postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
					taskId,
				)
			) {
				showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard(taskId);
				return;
			}
			await requestMoveTaskToTrashWithAnimation(taskId, fromColumnId, options);
		},
		[requestMoveTaskToTrashWithAnimation, showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard],
	);

	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		requestMoveTaskToTrash: requestMoveTaskToTrashWithAnimationSkippingPostDeployVerificationGatedTaskCards,
		resetKey: currentProjectId,
	});

	// 从 Done 恢复走 taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession：服务端移回 review → ensure
	// worktree → 续跑会话，任一步失败把卡移回 Done（浏览器不再自己撤回乐观移列），成功后关掉自动 review 动作。
	const restoreTaskCardFromDoneInCurrentProject = useCallback(
		async (taskId: string, options?: { insertAtIndexWithinReviewBoardColumn?: number }): Promise<void> => {
			if (!currentProjectId) {
				return;
			}
			const result = await restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				agentTerminalGeometryForTaskSessionSpawn: resolveAgentTerminalGeometryForTaskSessionSpawn(taskId),
				currentProjectBoardForOptimisticOverlay: latestBoardInteractionStateRef.current.board,
				...(options?.insertAtIndexWithinReviewBoardColumn !== undefined
					? { insertAtIndexWithinReviewBoardColumn: options.insertAtIndexWithinReviewBoardColumn }
					: {}),
			});
			if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
				notifyError(`Could not restore the task: ${result.commandFailureMessage}`);
				return;
			}
			if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime") {
				return;
			}
			const { response } = result;
			if (response.ensuredTaskWorktreeWarningMessage) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: response.ensuredTaskWorktreeWarningMessage,
					timeout: 7000,
				});
			}
			if (response.taskCardRestoreFromDoneOutcome !== "agent_session_resumed_and_task_card_kept_in_review") {
				notifyError(response.taskCardRestoreFromDoneFailureMessage ?? "Could not resume task session.");
				return;
			}
			trackTaskResumedFromTrash();
		},
		[currentProjectId],
	);

	// 拖放落地（含程序化移动的动画落地）。落点按 taskId 解出（见 resolveTaskCardDropFromDragResultByTaskId）。
	//   - 跨列且由用户手势 / PDV / auto-review 发起：按 core 的移列分类映射到对应 taskCardAction 命令，浏览器只叠
	//     overlay，不改会被保存的 board；
	//   - 浏览器端列自动流转（会话 facet 驱动、会话中断进 Done）与列内重排：仍在浏览器改 board、整板保存——
	//     自动流转不搬服务端（计划「明确不做」），中断进 Done 刻意不停会话、不删 worktree（保留供恢复）。
	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			const { board } = latestBoardInteractionStateRef.current;
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);
			const drop = resolveTaskCardDropFromDragResultByTaskId(board, result, { programmaticCardMoveInFlight });
			// 没有在途程序化移动 = 用户真拖拽；程序化移动（动画）落地时用发起入口随行为一起带来的发起方，没带就登记 null。
			const boardMutationInitiatorForThisDrop: WebUiBoardMutationInitiator | null =
				programmaticCardMoveInFlight || programmaticMoveBehavior
					? (programmaticMoveBehavior?.boardMutationInitiator ?? null)
					: "web_ui_user_gesture";
			// 这张卡已有命令在途（或已结算正等广播回灌）：本次拖放作废，别让 board 与在途命令打架。
			const isTaskCardAwaitingTaskCardActionCommand =
				currentProjectId !== null &&
				(readTaskCardActionCommandKindInFlight(currentProjectId, result.draggableId) !== null ||
					hasPendingTaskCardCommandBoardOverlayEntryForTaskCard(currentProjectId, result.draggableId));
			if (drop.taskCardDropKind === "no_effective_task_card_drop" || isTaskCardAwaitingTaskCardActionCommand) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				resolvePendingProgrammaticTrashMove(result.draggableId);
				return;
			}

			const placeTaskCardInBrowserBoard = (destinationColumnId: BoardColumnId) => {
				setBoard(
					withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(
						boardMutationInitiatorForThisDrop,
						(currentBoard) => {
							const placed = placeTaskCardIntoBoardColumnAtIndexByTaskId(
								currentBoard,
								drop.taskId,
								destinationColumnId,
								drop.destinationIndex,
							);
							return placed.placed ? placed.board : currentBoard;
						},
					),
				);
			};

			if (drop.taskCardDropKind === "task_card_reordered_within_board_column") {
				placeTaskCardInBrowserBoard(drop.boardColumnId);
				resolvePendingProgrammaticStartMove(drop.taskId, false);
				return;
			}

			const columnTransitionClassification = classifyTaskCardBoardColumnTransitionRequestedByUserGesture(
				drop.fromColumnId,
				drop.toColumnId,
			);
			// 只对在途程序化移动放行的跨列（in_progress ⇄ review、validation → in_progress）都是浏览器端列自动流转，
			// 不论入口带没带发起方，都留在浏览器（发起方照实登记，没带就是 null）。
			const isBrowserColumnAutoflowMove =
				boardMutationInitiatorForThisDrop === "web_ui_client_automation_session_facet_driven_column_autoflow" ||
				boardMutationInitiatorForThisDrop ===
					"web_ui_client_automation_interrupted_session_autoflow_into_done_column" ||
				programmaticMoveBehavior?.skipTrashWorkflow === true ||
				columnTransitionClassification === "board_column_transition_handing_agent_turn_to_user" ||
				columnTransitionClassification === "board_column_transition_not_allowed_as_user_gesture";
			if (isBrowserColumnAutoflowMove) {
				placeTaskCardInBrowserBoard(drop.toColumnId);
				resolvePendingProgrammaticStartMove(drop.taskId, false);
				resolvePendingProgrammaticTrashMove(drop.taskId);
				return;
			}

			const boardMutationInitiatorForCommand = boardMutationInitiatorForThisDrop ?? undefined;
			switch (columnTransitionClassification) {
				case "board_column_transition_into_done_stopping_sessions_and_deleting_worktree": {
					// Post-Deploy Verification 门禁预检：有未勾项的卡先核对，再决定是否填写原因。board 没被改过（只有命令才叠 overlay），
					// 卡片自然弹回原列；用户手势打开核对与结案流程（记住落点），浏览器端自动化只提示一次。
					if (
						doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask(
							latestBoardInteractionStateRef.current
								.postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
							drop.taskId,
						)
					) {
						if (isWebUiBoardMutationInitiatorClientAutomation(boardMutationInitiatorForCommand)) {
							showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard(drop.taskId);
						} else {
							openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone({
								taskId: drop.taskId,
								insertAtIndexWithinDoneBoardColumn: drop.destinationIndex,
								runtimeRejectedMoveIntoDoneForMissingClosureReasons: false,
							});
						}
						resolvePendingProgrammaticTrashMove(drop.taskId);
						return;
					}
					void requestMoveTaskToTrash(drop.taskId, drop.fromColumnId, {
						optimisticMoveApplied: true,
						skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
						boardMutationInitiator: boardMutationInitiatorForCommand,
						insertAtIndexWithinDoneBoardColumn: drop.destinationIndex,
					})
						.catch(() => {
							// 失败已在 requestMoveTaskToTrash 里提示。
						})
						.finally(() => {
							resolvePendingProgrammaticTrashMove(drop.taskId);
						});
					return;
				}
				case "board_column_transition_restoring_from_done_resuming_agent_session":
					void restoreTaskCardFromDoneInCurrentProject(drop.taskId, {
						insertAtIndexWithinReviewBoardColumn: drop.destinationIndex,
					});
					return;
				case "board_column_transition_starting_agent_session": {
					const card = findCardSelection(board, drop.taskId)?.card;
					if (!card || programmaticMoveBehavior?.skipKickoff) {
						resolvePendingProgrammaticStartMove(drop.taskId, false);
						return;
					}
					maybeRequestNotificationPermissionForTaskStart();
					void startTaskCardAgentSessionInCurrentProject(card, {
						insertAtIndexWithinInProgressBoardColumn: drop.destinationIndex,
						...(boardMutationInitiatorForCommand
							? { boardMutationInitiator: boardMutationInitiatorForCommand }
							: {}),
					})
						.then((started) => {
							resolvePendingProgrammaticStartMove(drop.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(drop.taskId, false);
						});
					return;
				}
				case "board_column_transition_without_session_side_effects": {
					if (!currentProjectId) {
						return;
					}
					const completeCacheWarmFocusNavigation =
						drop.fromColumnId === "review" && drop.toColumnId === "validation"
							? latestBoardInteractionStateRef.current.captureCacheWarmTaskFocusNavigationAfterValidationMove?.(
									drop.taskId,
								)
							: null;
					if (
						drop.fromColumnId === "review" &&
						drop.toColumnId === "validation" &&
						!completeCacheWarmFocusNavigation
					) {
						moveFocusedReviewTaskToNextReviewTaskAfterValidationMove(board, drop.taskId);
					}
					void moveTaskCardBetweenNonTrashColumnsThroughRuntime({
						workspaceId: currentProjectId,
						taskId: drop.taskId,
						targetBoardColumnId: drop.toColumnId,
						insertAtIndexWithinTargetBoardColumn: drop.destinationIndex,
						currentProjectBoardForOptimisticOverlay: board,
						...(boardMutationInitiatorForCommand
							? { boardMutationInitiator: boardMutationInitiatorForCommand }
							: {}),
					}).then((commandResult) => {
						if (
							commandResult.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime" &&
							commandResult.response.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard === "validation"
						) {
							completeCacheWarmFocusNavigation?.();
						}
						if (commandResult.taskCardActionCommandExecutionOutcome === "command_failed") {
							notifyError(`Could not move the task: ${commandResult.commandFailureMessage}`);
						}
					});
					return;
				}
				default:
					// 只对浏览器端自动流转放行的移动已在上面的自动流转分支处理。
					resolvePendingProgrammaticStartMove(drop.taskId, false);
					return;
			}
		},
		[
			consumeProgrammaticCardMove,
			currentProjectId,
			maybeRequestNotificationPermissionForTaskStart,
			openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
			requestMoveTaskToTrash,
			restoreTaskCardFromDoneInCurrentProject,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			moveFocusedReviewTaskToNextReviewTaskAfterValidationMove,
			setBoard,
			setSelectedTaskId,
			showOneTimeNoticeForAutomationSkippingPostDeployVerificationGatedTaskCard,
			startTaskCardAgentSessionInCurrentProject,
		],
	);

	const handleStartTask = useCallback(
		(taskId: string) => {
			const { board, sessions } = latestBoardInteractionStateRef.current;
			const selection = findCardSelection(board, taskId);
			if (!selection) {
				return;
			}
			// 「在 In Progress 但从没真正起过会话」：既包括本地还没有任何 summary，也包括运行时 attach 时造出来的
			// 占位 summary（终端面板一挂上就会有）。后者此前被当成「已有会话」直接 return，
			// 于是启动前段失败（如建 worktree 时锁等待超时）后，这张卡再也点不起来。
			// 但占位形状本身不证明「从没启动过」：硬中断 / 运行时重启后 summary 也会退化成它。卡片上记着
			// 启动成功过的，这里绝不能以原 prompt 再起一段新对话（那会丢掉本可续跑的旧对话）——留给续跑路径。
			// 这里刻意只拦「确有启动记录」而不要求「从没启动过」的正面证据：启动史说不清时，详情面板把「启动」
			// 与「续跑」都摆给人选，人选了启动就走到这里，再要求正面证据会让那个按钮点了没反应。看板 Retry 不是
			// 人在知情下的选择，所以它在 task-card-body 里另要求正面证据（resolveTaskAgentSessionLaunchHistoryEvidence）。
			const existingSessionSummary = resolveMainTaskConversationSessionSummary(selection.card, sessions);
			const isExistingSessionSummaryPlaceholderOfNeverLaunchedTask =
				existingSessionSummary != null &&
				isNeverStartedPlaceholderTaskSessionSummary(existingSessionSummary) &&
				selection.card.mostRecentlyLaunchedAgentSessionAgentId == null;
			if (
				selection.column.id === "in_progress" &&
				(existingSessionSummary == null || isExistingSessionSummaryPlaceholderOfNeverLaunchedTask)
			) {
				maybeRequestNotificationPermissionForTaskStart();
				void startTaskCardAgentSessionInCurrentProject(selection.card);
				return;
			}
			if (selection.column.id !== "backlog") {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			void startBacklogTaskWithAnimation(selection.card);
		},
		[
			maybeRequestNotificationPermissionForTaskStart,
			startBacklogTaskWithAnimation,
			startTaskCardAgentSessionInCurrentProject,
		],
	);

	const handleStartAllBacklogTasks = useCallback(
		(taskIds?: string[]) => {
			const { board } = latestBoardInteractionStateRef.current;
			const requestedTaskIds =
				taskIds ?? board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
			if (requestedTaskIds.length === 0) {
				return;
			}

			const pendingStarts: BoardCard[] = [];
			const startedTaskIds = new Set<string>();
			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(board, taskId);
				if (!selection || selection.column.id !== "backlog") {
					continue;
				}
				pendingStarts.push(selection.card);
				startedTaskIds.add(taskId);
			}
			if (pendingStarts.length === 0) {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			// 每张卡一条启动命令（各自的在途闸与 overlay，都插到 In Progress 列顶，与改动前的批量移列一致）。
			for (const task of pendingStarts) {
				void startTaskCardAgentSessionInCurrentProject(task, { insertAtIndexWithinInProgressBoardColumn: 0 });
			}
		},
		[maybeRequestNotificationPermissionForTaskStart, startTaskCardAgentSessionInCurrentProject],
	);

	const handleDetailTaskDragEnd = useCallback(
		(result: DropResult) => {
			handleDragEnd(result);
		},
		[handleDragEnd],
	);

	const handleCardSelect = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			const selection = findCardSelection(board, taskId);
			if (!selection) {
				return;
			}
			setSelectedTaskId(taskId);
			setIsGitHistoryOpen(false);
		},
		[setIsGitHistoryOpen, setSelectedTaskId],
	);

	// Actually perform the move to Done. Pass the card's source column so the Review→Done slide
	// animation only runs for Review cards and other columns fall back to a direct trash move.
	const performMoveToTrash = useCallback(
		(
			taskId: string,
			fromColumnId: BoardColumnId,
			taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
		) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			setTaskMoveToTrashLoading(taskId, true);
			if (taskCommentToAppendWhenMovingIntoDone) {
				void requestMoveTaskToTrash(taskId, fromColumnId, {
					boardMutationInitiator: "web_ui_user_gesture",
					taskCommentToAppendWhenMovingIntoDone,
				})
					.then(() =>
						completeTaskCommentBeforeMoveIntoDone(
							taskId,
							taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
						),
					)
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						if (!isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(message))
							returnToEditingTaskCommentBeforeMoveIntoDone(
								taskId,
								message,
								taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
							);
					})
					.finally(() => setTaskMoveToTrashLoading(taskId, false));
				return;
			}
			void requestMoveTaskToTrashWithAnimation(taskId, fromColumnId, {
				boardMutationInitiator: "web_ui_user_gesture",
			})
				.catch(() => {
					// 失败已在 requestMoveTaskToTrash 里提示。
				})
				.finally(() => {
					setTaskMoveToTrashLoading(taskId, false);
				});
		},
		[
			requestMoveTaskToTrashWithAnimation,
			requestMoveTaskToTrash,
			completeTaskCommentBeforeMoveIntoDone,
			returnToEditingTaskCommentBeforeMoveIntoDone,
			setTaskMoveToTrashLoading,
		],
	);

	// Post-Deploy Verification 面板的移列入口。与 performMoveToTrash 等价——服务端的 Done 命令照常停会话、删 worktree，
	// 绕过 requestMoveToTrash 对 review/in_progress 的 SkipValidationConfirmDialog 与看板级原因对话框（PDV 面板自有对话框）。
	// 关键区别：**awaitable 且返回成败**——performMoveToTrash 吞掉 Promise（fire-and-forget），本导出 await 之，
	// 让调用方在移列确实成功后才回写 boardMovedToDoneAt / 调 confirmVerificationComplete。
	// 没带 closure（Validation 列全勾）沿用动画路径；带 closure 直接发命令：动画路径的完成 Promise 不传播失败，
	// 带原因的结案必须让调用方知道服务端有没有收下（门禁拒绝时由调用方提示，不另弹看板级对话框）。
	const completePostDeployVerificationMoveToDone = useCallback(
		async (
			taskId: string,
			fromColumnId: BoardColumnId,
			postDeployVerificationDoneEntryClosure?: RuntimePostDeployVerificationDoneEntryClosureRequest,
		): Promise<PostDeployVerificationMoveIntoDoneCompletionResult> => {
			// 同任务移列已在途：不重复触发，报失败让调用方不写完成标记。
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return { ok: false, moveIntoDoneFailureMessage: "该任务的移入 Done 已在进行中" };
			}
			setTaskMoveToTrashLoading(taskId, true);
			try {
				if (postDeployVerificationDoneEntryClosure) {
					await requestMoveTaskToTrash(taskId, fromColumnId, {
						boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
						postDeployVerificationDoneEntryClosure,
					});
				} else {
					await requestMoveTaskToTrashWithAnimation(taskId, fromColumnId, {
						boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
					});
				}
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					...(error instanceof Error && error.message ? { moveIntoDoneFailureMessage: error.message } : {}),
				};
			} finally {
				setTaskMoveToTrashLoading(taskId, false);
			}
		},
		[requestMoveTaskToTrash, requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading],
	);

	// 看板级原因对话框的确认：带上逐项原因直接发命令（不走动画，失败要回到这里处理）。服务端仍以门禁拒绝
	// （又冒出了本地没看到的未勾项）时保持对话框打开、标记「服务端报告有不可见未勾项」并已重拉读模型，让用户补齐；
	// 同卡另有命令在途（暂时冲突、可重试）时保持对话框与已填原因，提示稍后再确认；
	// 其他失败已由 requestMoveTaskToTrash 弹错，关掉对话框。
	const confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone = useCallback(
		(closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>) => {
			const dialogRequest = postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone?.dialogRequest;
			if (!dialogRequest || isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting) {
				return;
			}
			const { taskId, insertAtIndexWithinDoneBoardColumn } = dialogRequest;
			const postDeployVerificationDoneEntryClosure = closureRequestsBySelectedTaskId[taskId];
			const fromColumnId = getTaskColumnId(latestBoardInteractionStateRef.current.board, taskId);
			if (!postDeployVerificationDoneEntryClosure || fromColumnId === null || fromColumnId === "trash") {
				closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone();
				if (dialogRequest.taskCommentToAppendWhenMovingIntoDone)
					returnToEditingTaskCommentBeforeMoveIntoDone(
						taskId,
						"任务或完成条件已变化，未提交评论。",
						dialogRequest.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
					);
				return;
			}
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			setIsPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting(true);
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrash(taskId, fromColumnId, {
				boardMutationInitiator: "web_ui_user_gesture",
				postDeployVerificationDoneEntryClosure,
				taskCommentToAppendWhenMovingIntoDone: dialogRequest.taskCommentToAppendWhenMovingIntoDone,
				...(insertAtIndexWithinDoneBoardColumn !== undefined ? { insertAtIndexWithinDoneBoardColumn } : {}),
			})
				.then(() => {
					if (dialogRequest.taskCommentToAppendWhenMovingIntoDone)
						completeTaskCommentBeforeMoveIntoDone(
							taskId,
							dialogRequest.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
						);
					closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone();
				})
				.catch((error: unknown) => {
					if (error instanceof MoveTaskCardIntoDoneRejectedBecauseAnotherCommandInFlightForTaskCardError) {
						setIsPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting(false);
						showAppToast({
							intent: "warning",
							icon: "warning-sign",
							message: "这张卡另有操作仍在进行中，暂未移入 Done：等它结束后再点确认（已填的原因保留）。",
							timeout: 7000,
						});
						return;
					}
					const moveIntoDoneFailureMessage = error instanceof Error ? error.message : String(error);
					if (
						isMoveIntoDoneFailureMessageRejectedByPostDeployVerificationDoneEntryGate(moveIntoDoneFailureMessage)
					) {
						setIsPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting(false);
						markPostDeployVerificationDoneEntryClosureDialogTaskRejectedByRuntime(taskId);
						showAppToast({
							intent: "warning",
							icon: "warning-sign",
							message: `${describePostDeployVerificationDoneEntryGateRejectionForHumans(moveIntoDoneFailureMessage)}（核对清单已刷新，请补齐原因后再确认）`,
							timeout: 7000,
						});
						return;
					}
					closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone();
					if (dialogRequest.taskCommentToAppendWhenMovingIntoDone)
						returnToEditingTaskCommentBeforeMoveIntoDone(
							taskId,
							moveIntoDoneFailureMessage,
							dialogRequest.taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
						);
				})
				.finally(() => {
					setTaskMoveToTrashLoading(taskId, false);
				});
		},
		[
			closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
			isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
			markPostDeployVerificationDoneEntryClosureDialogTaskRejectedByRuntime,
			completeTaskCommentBeforeMoveIntoDone,
			returnToEditingTaskCommentBeforeMoveIntoDone,
			postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
			requestMoveTaskToTrash,
			setIsPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
			setTaskMoveToTrashLoading,
		],
	);

	const cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone = useCallback(() => {
		if (isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting) {
			return;
		}
		const commentRequest = postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone?.dialogRequest;
		closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone();
		if (commentRequest?.taskCommentToAppendWhenMovingIntoDone)
			returnToEditingTaskCommentBeforeMoveIntoDone(commentRequest.taskId);
	}, [
		postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		returnToEditingTaskCommentBeforeMoveIntoDone,
		closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
	]);

	// Single entry point for every "Move to Done" trigger (board card, detail sidebar card, agent
	// TUI bottom button). Moving straight to Done from Review / In Progress skips the manual
	// Validation step, so it requires confirmation; from Validation it is the normal completion path.
	// 受 Post-Deploy Verification 门禁（有未勾项）的卡先进入核对阶段：跳过 Validation 的确认是它的条件段落，不叠两层。
	const requestMoveToTrash = useCallback(
		(
			taskId: string,
			fromColumnId: BoardColumnId,
			taskCommentToAppendWhenMovingIntoDone?: TaskCommentToAppendWhenMovingIntoDone,
		) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				if (taskCommentToAppendWhenMovingIntoDone)
					returnToEditingTaskCommentBeforeMoveIntoDone(taskId, "任务操作仍在进行中，请稍后重试。");
				return;
			}
			if (
				doesPostDeployVerificationDoneEntryGateRequireClosureReasonsForTask(
					latestBoardInteractionStateRef.current
						.postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck,
					taskId,
				)
			) {
				if (taskCommentToAppendWhenMovingIntoDone) suspendTaskCommentBeforeMoveIntoDone(taskId);
				openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone({
					taskCommentToAppendWhenMovingIntoDone,
					taskId,
					insertAtIndexWithinDoneBoardColumn: undefined,
					runtimeRejectedMoveIntoDoneForMissingClosureReasons: false,
				});
				return;
			}
			if (fromColumnId === "review" || fromColumnId === "in_progress") {
				if (taskCommentToAppendWhenMovingIntoDone) suspendTaskCommentBeforeMoveIntoDone(taskId);
				setPendingMoveToDone({ taskId, fromColumnId, taskCommentToAppendWhenMovingIntoDone });
				return;
			}
			performMoveToTrash(taskId, fromColumnId, taskCommentToAppendWhenMovingIntoDone);
		},
		[
			openPostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
			performMoveToTrash,
			suspendTaskCommentBeforeMoveIntoDone,
			returnToEditingTaskCommentBeforeMoveIntoDone,
		],
	);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		requestMoveToTrash(selectedCard.card.id, selectedCard.column.id);
	}, [requestMoveToTrash, selectedCard]);

	const handleMoveReviewCardToTrash = useCallback<TaskCardMoveIntoDoneRequestHandler>(
		(taskId, options) => {
			const { board } = latestBoardInteractionStateRef.current;
			const selection = findCardSelection(board, taskId);
			if (options?.requestTaskCommentBeforeMovingIntoDone) {
				if (currentProjectId && selection) openTaskCommentBeforeMoveIntoDone(currentProjectId, selection.card);
				return;
			}
			requestMoveToTrash(taskId, getTaskColumnId(board, taskId) ?? "review");
		},
		[currentProjectId, openTaskCommentBeforeMoveIntoDone, requestMoveToTrash],
	);

	const confirmTaskCommentBeforeMoveIntoDone = useCallback(
		(commentText: string) => {
			const request = taskCommentBeforeMoveIntoDone.request;
			if (!request) return;
			const selection = findCardSelection(latestBoardInteractionStateRef.current.board, request.taskId);
			if (request.workspaceId !== currentProjectId || !selection) {
				returnToEditingTaskCommentBeforeMoveIntoDone(request.taskId, "任务已移动或当前项目已切换，未提交评论。");
				return;
			}
			const comment = prepareTaskCommentBeforeMoveIntoDone(commentText);
			if (!comment) return;
			if (selection.column.id === "trash") {
				// 响应可能在写盘后丢失；仅用广播中已保存的同 ID、同正文评论结算原草稿。
				if (
					selection.card.taskCommentEntries?.some(
						(entry) =>
							entry.taskCommentEntryId === comment.taskCommentEntryId &&
							entry.commentText === comment.commentText,
					)
				)
					completeTaskCommentBeforeMoveIntoDone(request.taskId, comment.taskCommentEntryId);
				else
					returnToEditingTaskCommentBeforeMoveIntoDone(
						request.taskId,
						"任务已移动或评论已变化，未提交评论。",
						comment.taskCommentEntryId,
					);
				return;
			}
			requestMoveToTrash(request.taskId, selection.column.id, comment);
		},
		[
			taskCommentBeforeMoveIntoDone.request,
			currentProjectId,
			completeTaskCommentBeforeMoveIntoDone,
			prepareTaskCommentBeforeMoveIntoDone,
			requestMoveToTrash,
			returnToEditingTaskCommentBeforeMoveIntoDone,
		],
	);

	const confirmMoveToDone = useCallback(() => {
		if (pendingMoveToDone) {
			// 本次命令尚未执行时保留确认，草稿仍可取消或在其他操作结束后重试。
			if (moveToTrashLoadingByIdRef.current[pendingMoveToDone.taskId]) return;
			performMoveToTrash(
				pendingMoveToDone.taskId,
				pendingMoveToDone.fromColumnId,
				pendingMoveToDone.taskCommentToAppendWhenMovingIntoDone,
			);
		}
		setPendingMoveToDone(null);
	}, [pendingMoveToDone, performMoveToTrash]);

	const cancelMoveToDone = useCallback(() => {
		if (pendingMoveToDone?.taskCommentToAppendWhenMovingIntoDone)
			returnToEditingTaskCommentBeforeMoveIntoDone(pendingMoveToDone.taskId);
		setPendingMoveToDone(null);
	}, [pendingMoveToDone, returnToEditingTaskCommentBeforeMoveIntoDone]);

	// Pure board move into the manual-validation buffer. No session stop, no worktree teardown —
	// the developer keeps the running agent/diff while validating. Goes through taskCardAction (the
	// overlay shows the move immediately). Mirrors the manual in_progress/review → validation drag end-state.
	const handleMoveCardToValidation = useCallback(
		(taskId: string) => {
			const { board, sessions } = latestBoardInteractionStateRef.current;
			const fromColumnId = getTaskColumnId(board, taskId);
			if (!currentProjectId || (fromColumnId !== "in_progress" && fromColumnId !== "review")) {
				return;
			}
			const completeCacheWarmFocusNavigation =
				fromColumnId === "review"
					? latestBoardInteractionStateRef.current.captureCacheWarmTaskFocusNavigationAfterValidationMove?.(taskId)
					: null;
			void moveTaskCardBetweenNonTrashColumnsThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				targetBoardColumnId: "validation",
				currentProjectBoardForOptimisticOverlay: board,
			}).then((result) => {
				if (
					result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime" &&
					result.response.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard === "validation"
				) {
					completeCacheWarmFocusNavigation?.();
				}
				if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
					notifyError(`Could not move the task to Validation: ${result.commandFailureMessage}`);
				}
			});
			if (fromColumnId === "review" && !completeCacheWarmFocusNavigation) {
				moveFocusedReviewTaskToNextReviewTaskAfterValidationMove(board, taskId);
			}
			// A session that is *actively producing output* in Validation gets auto-migrated back to
			// In Progress by the level-triggered effect above, so warn the developer instead of leaving
			// the card looking like it never moved. Idle / already-exited sessions (still flagged
			// "running") now stay in Validation, so the warning must use the same predicate as the
			// bounce — keying off bare state === "running" would false-warn on those. Non-blocking,
			// auto-dismisses after 3s.
			const card = findCardSelection(board, taskId)?.card;
			if (
				card &&
				isAgentConversationRecentlyEffectivelyActiveForContinuousColumnAutoflow(
					resolveMainTaskConversationSessionSummary(card, sessions),
					Date.now(),
					card.updatedAt,
				)
			) {
				showAppToast({
					intent: "warning",
					icon: "info-sign",
					message: "Task is still running — it will return to In Progress while the agent keeps working.",
					timeout: 3000,
				});
			}
		},
		[currentProjectId, moveFocusedReviewTaskToNextReviewTaskAfterValidationMove],
	);

	const handleMoveSelectedCardToValidation = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		handleMoveCardToValidation(selectedCard.card.id);
	}, [handleMoveCardToValidation, selectedCard]);

	// 手动「移至 Review」：把一个停在 agent 回合（多为卡死/空闲——Stop hook 未触发、进程未退）的终端 agent
	// 任务翻入「等人审查」回合。走 taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser：服务端翻回合成功后显式
	// 移列（跨项目时没有浏览器跑 Rule A），浏览器叠 overlay；review-bounce（要求 turnOwner=agent）不再触发，卡片稳定
	// 停在 Review。仅 In Progress 卡生效（与按钮渲染门控一致，双重保险）。
	const handleMoveCardToReview = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			if (!currentProjectId || getTaskColumnId(board, taskId) !== "in_progress") {
				return;
			}
			setMoveToReviewLoadingById((current) => ({ ...current, [taskId]: true }));
			void (async () => {
				try {
					const result = await moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime({
						workspaceId: currentProjectId,
						taskId,
						currentProjectBoardForOptimisticOverlay: board,
					});
					const handedTurnToUser =
						result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime" &&
						result.response.agentTurnHandoffToUserOutcome === "agent_turn_handed_to_user";
					if (!handedTurnToUser) {
						showAppToast({
							intent: "warning",
							icon: "info-sign",
							message: "Couldn't move task to Review — try again.",
							timeout: 3000,
						});
					}
				} finally {
					setMoveToReviewLoadingById((current) => {
						if (!(taskId in current)) {
							return current;
						}
						const next = { ...current };
						delete next[taskId];
						return next;
					});
				}
			})();
		},
		[currentProjectId],
	);

	const handleRestoreTaskFromTrash = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			const programmaticMoveAttempt = tryProgrammaticCardMove(taskId, "trash", "review", {
				boardMutationInitiator: "web_ui_user_gesture",
			});
			if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
				return;
			}

			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}
			// 没有可用的拖放动画（例如看板不在屏上）：直接发恢复命令，overlay 把卡放到 Review 列顶。
			void restoreTaskCardFromDoneInCurrentProject(taskId, { insertAtIndexWithinReviewBoardColumn: 0 });
		},
		[restoreTaskCardFromDoneInCurrentProject, tryProgrammaticCardMove],
	);

	// 永久删除成功后清掉本地会话摘要（服务端已删 sessions 条目；不等下一次快照，免得详情面板还挂着旧会话）。
	const removeTaskSessionSummariesOfPermanentlyDeletedTaskCards = useCallback(
		(taskIds: readonly string[]) => {
			setSessions((currentSessions) => {
				if (!taskIds.some((taskId) => currentSessions[taskId])) {
					return currentSessions;
				}
				const nextSessions = { ...currentSessions };
				for (const taskId of taskIds) {
					delete nextSessions[taskId];
				}
				return nextSessions;
			});
		},
		[setSessions],
	);

	const handleOpenDeleteTask = useCallback((taskId: string) => {
		const { board } = latestBoardInteractionStateRef.current;
		const selection = findCardSelection(board, taskId);
		if (!selection) {
			return;
		}
		setDeleteTaskTarget(selection.card);
	}, []);

	const handleCancelDeleteTask = useCallback(() => {
		setDeleteTaskTarget(null);
	}, []);

	const handleConfirmDeleteTask = useCallback(() => {
		if (!deleteTaskTarget) {
			return;
		}

		const task = deleteTaskTarget;
		const { board } = latestBoardInteractionStateRef.current;
		setDeleteTaskTarget(null);
		if (!currentProjectId || !findCardSelection(board, task.id)) {
			return;
		}
		if (selectedTaskId === task.id) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(task.id);
		}
		// 走 taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup：服务端按固定顺序删卡、清编辑草稿、清排队
		// prompt、停会话、删 worktree、最后删 checkpoint ref。浏览器叠「已删除」overlay，成功后清掉本地会话摘要。
		void permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime({
			workspaceId: currentProjectId,
			permanentlyDeletedTaskCardSelection: {
				permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
				selectedTaskIds: [task.id],
			},
			taskIdsExpectedToBeDeleted: [task.id],
			currentProjectBoardForOptimisticOverlay: board,
		}).then((result) => {
			if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
				notifyError(`Could not delete the task: ${result.commandFailureMessage}`);
				return;
			}
			if (result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime") {
				removeTaskSessionSummariesOfPermanentlyDeletedTaskCards([task.id]);
			}
		});
	}, [
		currentProjectId,
		deleteTaskTarget,
		removeTaskSessionSummariesOfPermanentlyDeletedTaskCards,
		selectedTaskId,
		setSelectedTaskId,
	]);

	const handleCancelAutomaticTaskAction = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			if (!currentProjectId || findCardSelection(board, taskId)?.card.autoReviewEnabled !== true) {
				return;
			}
			void updateTaskCardFieldValuesThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				taskCardFieldValuePatch: { autoReviewEnabled: false },
				currentProjectBoardForOptimisticOverlay: board,
				optimisticBoardTransformation: (currentBoard) => disableTaskAutoReview(currentBoard, taskId),
			}).then((result) => {
				if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
					notifyError(`Could not cancel the automatic action: ${result.commandFailureMessage}`);
				}
			});
		},
		[currentProjectId],
	);

	const openTaskPinboardPinReasonDialog = useCallback((taskId: string, isEditingExistingPin: boolean) => {
		const { board } = latestBoardInteractionStateRef.current;
		const selection = findCardSelection(board, taskId);
		if (!selection) {
			return;
		}
		setTaskPinboardPinReasonRequest({
			taskId,
			taskTitle: selection.card.title,
			isEditingExistingPin,
			initialPinReason: selection.card.taskPinboardPinReason ?? "",
		});
	}, []);

	const handleRequestPinTaskToTaskPinboard = useCallback(
		(taskId: string) => openTaskPinboardPinReasonDialog(taskId, false),
		[openTaskPinboardPinReasonDialog],
	);

	const handleRequestEditTaskPinboardPinReason = useCallback(
		(taskId: string) => openTaskPinboardPinReasonDialog(taskId, true),
		[openTaskPinboardPinReasonDialog],
	);

	const handleCancelTaskPinboardPinReason = useCallback(() => setTaskPinboardPinReasonRequest(null), []);

	// 置顶改走 taskCardAction（同一张卡在三处共用在途闸）。pinTaskToTaskPinboard 对已置顶的卡保留原
	// pinnedToTaskPinboardAt，所以「编辑原因」不会把它顶到板首——服务端与 overlay 跑的是同一个纯函数。
	const submitTaskPinboardPinChange = useCallback(
		(
			taskId: string,
			taskPinboardPinChange: Parameters<
				typeof setTaskPinboardPinStateOfTaskCardThroughRuntime
			>[0]["taskPinboardPinChange"],
		) => {
			if (!currentProjectId) {
				return;
			}
			void setTaskPinboardPinStateOfTaskCardThroughRuntime({
				workspaceId: currentProjectId,
				taskId,
				taskPinboardPinChange,
				currentProjectBoardForOptimisticOverlay: latestBoardInteractionStateRef.current.board,
			}).then((result) => {
				if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
					notifyError(`Could not update Pinboard: ${result.commandFailureMessage}`);
				}
			});
		},
		[currentProjectId],
	);

	const handleConfirmTaskPinboardPinReason = useCallback(
		(taskId: string, pinReason: string) => {
			setTaskPinboardPinReasonRequest(null);
			submitTaskPinboardPinChange(taskId, {
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskPinboardPinReason: pinReason,
			});
		},
		[submitTaskPinboardPinChange],
	);

	const handleUnpinTaskFromTaskPinboard = useCallback(
		(taskId: string) => {
			submitTaskPinboardPinChange(taskId, { taskPinboardPinAction: "unpin_task_card" });
		},
		[submitTaskPinboardPinChange],
	);

	const handleOpenClearTrash = useCallback(() => {
		if (trashTaskCount === 0) {
			return;
		}
		setIsClearTrashDialogOpen(true);
	}, [setIsClearTrashDialogOpen, trashTaskCount]);

	// 清空 Done：同一个永久删除命令按「整列」选择，服务端只删取得串行权的卡（RVF-004），收尾链与单卡删除相同。
	const handleConfirmClearTrash = useCallback(() => {
		const { board } = latestBoardInteractionStateRef.current;
		const taskIds = board.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id) ?? [];
		setIsClearTrashDialogOpen(false);
		if (!currentProjectId || taskIds.length === 0) {
			return;
		}
		if (selectedTaskId && taskIds.includes(selectedTaskId)) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(selectedTaskId);
		}
		void permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime({
			workspaceId: currentProjectId,
			permanentlyDeletedTaskCardSelection: {
				permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
				selectedBoardColumnId: "trash",
			},
			taskIdsExpectedToBeDeleted: taskIds,
			currentProjectBoardForOptimisticOverlay: board,
		}).then((result) => {
			if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
				notifyError(`Could not clear Done: ${result.commandFailureMessage}`);
				return;
			}
			if (result.taskCardActionCommandExecutionOutcome === "command_completed_by_runtime") {
				removeTaskSessionSummariesOfPermanentlyDeletedTaskCards(
					result.response.permanentlyDeletedTaskCards.map(({ deletedTaskCard }) => deletedTaskCard.id),
				);
			}
		});
	}, [
		currentProjectId,
		removeTaskSessionSummariesOfPermanentlyDeletedTaskCards,
		selectedTaskId,
		setIsClearTrashDialogOpen,
		setSelectedTaskId,
	]);

	const resetBoardInteractionsState = useCallback(() => {
		cancelTaskCommentBeforeMoveIntoDone();
		setPendingMoveToDone(null);
		previousSessionsRef.current = {};
		previousAutoFlowBoardRef.current = null;
		moveToTrashLoadingByIdRef.current = {};
		setMoveToTrashLoadingById({});
		for (const taskId of Object.keys(pendingProgrammaticStartMoveCompletionByTaskIdRef.current)) {
			resolvePendingProgrammaticStartMove(taskId, false);
		}
		resetProgrammaticCardMoves();
		setIsClearTrashDialogOpen(false);
		setDeleteTaskTarget(null);
		setTaskPinboardPinReasonRequest(null);
		closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone();
	}, [
		cancelTaskCommentBeforeMoveIntoDone,
		closePostDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		resetProgrammaticCardMoves,
		resolvePendingProgrammaticStartMove,
		setIsClearTrashDialogOpen,
	]);

	useEffect(() => {
		resetBoardInteractionsState();
	}, [currentProjectId, resetBoardInteractionsState]);

	return {
		handleProgrammaticCardMoveReady,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		taskCommentBeforeMoveIntoDone,
		confirmTaskCommentBeforeMoveIntoDone,
		isMoveToDoneConfirmOpen: pendingMoveToDone !== null,
		confirmMoveToDone,
		cancelMoveToDone,
		completePostDeployVerificationMoveToDone,
		postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone,
		isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting,
		confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone,
		cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone,
		handleMoveCardToValidation,
		handleMoveSelectedCardToValidation,
		handleMoveCardToReview,
		moveToReviewLoadingById,
		handleRestoreTaskFromTrash,
		handleOpenDeleteTask,
		handleCancelDeleteTask,
		handleConfirmDeleteTask,
		deleteTaskTarget,
		handleCancelAutomaticTaskAction,
		handleRequestPinTaskToTaskPinboard,
		handleRequestEditTaskPinboardPinReason,
		handleCancelTaskPinboardPinReason,
		handleConfirmTaskPinboardPinReason,
		handleUnpinTaskFromTaskPinboard,
		taskPinboardPinReasonRequest,
		handleOpenClearTrash,
		handleConfirmClearTrash,
		handleAddReviewComments,
		handleSendReviewComments,
		moveToTrashLoadingById,
		trashTaskCount,
	};
}
