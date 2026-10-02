import type { DropResult } from "@hello-pangea/dnd";
import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import {
	isAgentActivelyProducingOutput,
	isAwaitingUserReviewTurn,
	isNeverStartedPlaceholderTaskSessionSummary,
	isParkedAwaitingDispatchedBackgroundWork,
	resolveSessionFacets,
} from "@runtime-session-activity";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, showAppToast } from "@/components/app-toaster";
import type { TaskPinboardPinReasonDialogRequest } from "@/components/task-pinboard-pin-reason-dialog";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup } from "@/hooks/use-move-task-to-done-with-session-stop-and-workspace-cleanup";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import { discardAllTaskEditDraftsForDeletedTask } from "@/runtime/task-edit-draft-store";
import type { RuntimeTaskSessionSummary, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import {
	applyDragResult,
	clearColumnTasks,
	disableTaskAutoReview,
	findCardSelection,
	getTaskColumnId,
	moveTaskToColumn,
	removeTask,
	updateTask,
} from "@/state/board-state";
import { pinTaskToTaskPinboard, unpinTaskFromTaskPinboard } from "@/state/task-pinboard-pinning";
import {
	recordWebUiBoardMutationInitiatorForTaskCardAspect,
	recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards,
	withWebUiBoardMutationInitiatorRecordedForChangedTaskCards,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import { beginTaskAgentSessionStartRequestInFlight } from "@/stores/task-agent-session-start-request-in-flight-store";
import { clearTaskWorkspaceInfo, setTaskWorkspaceInfo } from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
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
	stopTaskSession: (taskId: string) => Promise<void>;
	transitionTaskToReview: (taskId: string) => Promise<boolean>;
	cleanupTaskWorkspace: UseTaskSessionsResult["cleanupTaskWorkspace"];
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	sendTaskSessionInput: (
		taskId: string,
		input: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	readyForReviewNotificationsEnabled: boolean;
	taskGitActionLoadingByTaskId: Record<string, TaskGitActionLoadingStateLike>;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
}

export interface UseBoardInteractionsResult {
	handleProgrammaticCardMoveReady: ReturnType<typeof useProgrammaticCardMoves>["handleProgrammaticCardMoveReady"];
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	handleDragEnd: (result: DropResult, options?: { selectDroppedTask?: boolean }) => void;
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	handleDetailTaskDragEnd: (result: DropResult) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveToTrash: () => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	isMoveToDoneConfirmOpen: boolean;
	confirmMoveToDone: () => void;
	cancelMoveToDone: () => void;
	// Post-Deploy Verification 全勾入 Done 的移列入口：语义等价 performMoveToTrash（直接移入 trash/Done，
	// 绕过 requestMoveToTrash 对 review/in_progress 的 SkipValidationConfirmDialog），但**可 await 且返回成败**，
	// 供调用方在移列确实成功后才写 boardMovedToDoneAt。fromColumnId 取任务的当前实际列（getTaskColumnId），非快照。
	completePostDeployVerificationMoveToDone: (taskId: string, fromColumnId: BoardColumnId) => Promise<{ ok: boolean }>;
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
	stopTaskSession,
	transitionTaskToReview,
	cleanupTaskWorkspace,
	ensureTaskWorkspace,
	startTaskSession,
	fetchTaskWorkspaceInfo,
	sendTaskSessionInput,
	readyForReviewNotificationsEnabled,
	taskGitActionLoadingByTaskId,
	runAutoReviewGitAction,
}: UseBoardInteractionsInput): UseBoardInteractionsResult {
	// 事件入口读取最新状态，避免每个 session tick 改变整棵卡片树的 handler 身份。
	const latestBoardInteractionStateRef = useRef({ board, sessions });
	latestBoardInteractionStateRef.current = { board, sessions };
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
	const [pendingMoveToDone, setPendingMoveToDone] = useState<{ taskId: string; fromColumnId: BoardColumnId } | null>(
		null,
	);
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
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
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
			const typed = await sendTaskSessionInput(taskId, text, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not send review comments to the task session.",
					timeout: 7000,
				});
				return;
			}
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 200);
			});
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: submitted.message ?? "Could not submit review comments to the task session.",
					timeout: 7000,
				});
			}
		},
		[sendTaskSessionInput],
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

	const kickoffTaskInProgress = useCallback(
		async (
			task: BoardCard,
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { optimisticMove?: boolean },
		): Promise<boolean> => {
			const optimisticMove = options?.optimisticMove ?? true;
			// 整个启动窗口（建 worktree → 启动 RPC）都标成「启动请求进行中」，让终端面板显示「正在启动」，
			// 而不是把占位 summary + 空终端误判成「会话随上一个运行时没了」、再递出一个会和本次启动
			// 抢 per-task 闸门的续跑按钮（详见该 store 顶部注释）。
			const startRequestInFlight = currentProjectId
				? beginTaskAgentSessionStartRequestInFlight(currentProjectId, taskId)
				: null;
			try {
				const ensured = await ensureTaskWorkspace(task);
				if (!ensured.ok) {
					notifyError(ensured.message ?? "Could not set up task workspace.");
					return false;
				}
				startRequestInFlight?.advanceToPhase("launching_agent_session");
				if (ensured.response?.warning) {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: ensured.response.warning,
						timeout: 7000,
					});
				}
				if (selectedTaskId === taskId) {
					if (ensured.response) {
						setTaskWorkspaceInfo({
							taskId,
							path: ensured.response.path,
							exists: true,
							baseRef: ensured.response.baseRef,
							branch: null,
							isDetached: true,
							headCommit: ensured.response.baseCommit,
						});
					}
					const infoAfterEnsure = await fetchTaskWorkspaceInfo(task);
					if (infoAfterEnsure) {
						setTaskWorkspaceInfo(infoAfterEnsure);
					}
				}
				const started = await startTaskSession(task);
				if (!started.ok) {
					notifyError(started.message ?? "Could not start task session.");
					return false;
				}
				if (!optimisticMove) {
					// 只有用户点「开始」的路径会走到非乐观移列（见 startBacklogTaskWithAnimation 的 unavailable 分支）。
					setBoard(
						withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
							const currentColumnId = getTaskColumnId(currentBoard, taskId);
							if (currentColumnId !== fromColumnId) {
								return currentBoard;
							}
							const moved = moveTaskToColumn(currentBoard, taskId, "in_progress", { insertAtTop: true });
							return moved.moved ? moved.board : currentBoard;
						}),
					);
				}
				return true;
			} finally {
				// 成功时 running summary 通常早已经由运行时状态流（spawn 后 150ms 批广播）到达，远早于这条
				// RPC 响应（它还要等写卡片与 turn checkpoint），所以这里清标记不会让「已死」提示闪一下。
				startRequestInFlight?.finish();
			}
		},
		[currentProjectId, ensureTaskWorkspace, fetchTaskWorkspaceInfo, selectedTaskId, setBoard, startTaskSession],
	);

	const startBacklogTaskImmediately = useCallback(
		async (task: BoardCard): Promise<boolean> => {
			const { board } = latestBoardInteractionStateRef.current;
			const selection = findCardSelection(board, task.id);
			if (!selection || selection.column.id !== "backlog") {
				return false;
			}

			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const currentSelection = findCardSelection(currentBoard, task.id);
					if (!currentSelection || currentSelection.column.id !== "backlog") {
						return currentBoard;
					}
					const moved = moveTaskToColumn(currentBoard, task.id, "in_progress", { insertAtTop: true });
					return moved.moved ? moved.board : currentBoard;
				}),
			);

			return kickoffTaskInProgress(task, task.id, "backlog", {
				optimisticMove: true,
			});
		},
		[kickoffTaskInProgress, setBoard],
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
				return kickoffTaskInProgress(task, task.id, "backlog", {
					optimisticMove: false,
				});
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
			kickoffTaskInProgress,
			resolvePendingProgrammaticStartMove,
			selectedCard,
			startBacklogTaskImmediately,
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
			for (const summary of Object.values(sessions)) {
				const previous = previousSessions[summary.taskId];
				// B5 引用短路：summary 引用跨 tick 稳定（runtime-state-hub merge 只替换改动 key），
				// 引用未变即内容未变；board 也未变时本帧处理结果与上一帧相同（纯 no-op），直接跳过，
				// 省掉每 tick 对全部 N 条 summary 的 getTaskColumnId 全板扫描与 resolveSessionFacets。
				// 唯一的时间依赖 isAgentActivelyProducingOutput 只在持续产出时为真，而持续产出 ⇒
				// summary 每 tick 换新引用，不会被本短路跳过。
				if (!boardChangedSinceLastRun && previous === summary) {
					continue;
				}
				if (previous && previous.updatedAt > summary.updatedAt) {
					continue;
				}
				let columnId = getTaskColumnId(nextBoard, summary.taskId);
				// 双轴迁移（Stage 3 ④，行为保持）：列自动流转的 state 读全部翻为 facet 权威
				// （resolveSessionFacets），绕开 projectLegacyState 对 live↔exited 的有损压扁。各判据
				// 严格等价旧 legacy state：isAwaitingUserReviewTurn ⟺ awaiting_review（含 user+exited
				// 折叠，故进程已退却仍等人审的会话照旧自动落位 review，不偷渡 distinction ②）、
				// turnOwner==="agent" ⟺ running、liveness==="interrupted" ⟺ interrupted。
				const facets = resolveSessionFacets(summary);
				const previousFacets = previous ? resolveSessionFacets(previous) : undefined;
				if (columnId === "backlog" && summary.startedAt != null) {
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(summary.taskId);
						nextBoard = moved.board;
						columnId = "in_progress";
					}
				}
				if (isAwaitingUserReviewTurn(facets) && columnId === "in_progress") {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "review", {
						boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						// B5：本帧未落直接移列（动画接管 / 被在途移动阻塞）的 task 不得记录为已见，
						// 否则引用短路会吃掉下一 tick 的重试（短路前由 updatedAt guard 放行每 tick 重估）。
						deferredRetryTaskIds.add(summary.taskId);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(summary.taskId);
						nextBoard = moved.board;
					}
					continue;
				}
				// Review 列与 Validation 列对齐——同用活跃度 offset：仅当 agent 此刻仍在持续产出输出
				// （isAgentActivelyProducingOutput，内含 turnOwner==="agent"）时才打回 In Progress；空闲 /
				// 卡死 / 已退出却仍处 agent 回合的会话允许停留在 review（review 是等人审查回合的自动落位区，
				// 也是「移至 Review」手动钉住空闲会话的落位区）。原 Review 分支只读裸 turnOwner==="agent"，
				// 把空闲 / 卡死的 agent 回合会话也反复打回——这正是当年为绕开它而加 manual_review 永久锁的动因；
				// 补上 offset 后该锁不再必要（见 session-state-machine.ts canReturnToRunning）。
				// **例外（强制）**：parked（已派发后台工作、等自行恢复）的会话被外部编排有意放在 review 等结果，
				// 即便仍在产出也不可打回，否则会被反复 bounce / 抖动。
				const shouldBounceRunningToInProgress =
					(columnId === "review" &&
						!isParkedAwaitingDispatchedBackgroundWork(summary) &&
						isAgentActivelyProducingOutput(summary, nowMs)) ||
					(columnId === "validation" && isAgentActivelyProducingOutput(summary, nowMs));
				if (shouldBounceRunningToInProgress && (columnId === "review" || columnId === "validation")) {
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "in_progress", {
						skipKickoff: true,
						boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						// B5：同 Review 落位分支——动画接管 / 被阻塞的 task 不记录为已见，保留下一 tick 重试。
						deferredRetryTaskIds.add(summary.taskId);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "in_progress", { insertAtTop: true });
					if (moved.moved) {
						recordSessionFacetDrivenColumnAutoflowInitiator(summary.taskId);
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
					const nextTaskId = getNextDetailTaskIdAfterTrashMove(nextBoard, summary.taskId);
					const programmaticMoveAttempt = tryProgrammaticCardMove(summary.taskId, columnId, "trash", {
						skipTrashWorkflow: true,
						boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
					});
					if (programmaticMoveAttempt === "started" || programmaticMoveAttempt === "blocked") {
						if (programmaticMoveAttempt === "blocked") {
							deferredRetryTaskIds.add(summary.taskId);
						}
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						continue;
					}
					const moved = moveTaskToColumn(nextBoard, summary.taskId, "trash", { insertAtTop: true });
					if (moved.moved) {
						recordWebUiBoardMutationInitiatorForTaskCardAspect({
							taskId: summary.taskId,
							boardMutationAspectOfTaskCard: "task_card_column_placement",
							boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
						});
						setSelectedTaskId((currentSelectedTaskId) =>
							currentSelectedTaskId === summary.taskId ? nextTaskId : currentSelectedTaskId,
						);
						nextBoard = moved.board;
					}
				}
			}
			const nextPreviousSessions = { ...sessions };
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
	}, [programmaticCardMoveCycle, sessions, setBoard, setSelectedTaskId, tryProgrammaticCardMove]);

	const { confirmMoveTaskToTrash, requestMoveTaskToTrash } = useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup({
		board,
		setBoard,
		setSelectedTaskId,
		stopTaskSession,
		cleanupTaskWorkspace,
	});

	useEffect(() => {
		setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
	}, [requestMoveTaskToTrash, setRequestMoveTaskToTrashHandler]);

	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
		requestMoveTaskToTrash: requestMoveTaskToTrashWithAnimation,
		resetKey: currentProjectId,
	});

	const resumeTaskFromTrash = useCallback(
		async (task: BoardCard, taskId: string, options?: { optimisticMoveApplied?: boolean }): Promise<void> => {
			const ensured = await ensureTaskWorkspace(task);
			if (!ensured.ok) {
				notifyError(ensured.message ?? "Could not set up task workspace.");
				if (!options?.optimisticMoveApplied) {
					return;
				}
				// 撤回用户「从 Done 恢复」失败后的乐观移列：仍是那次用户手势的一部分。
				setBoard(
					withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
						const currentColumnId = getTaskColumnId(currentBoard, taskId);
						if (currentColumnId !== "review") {
							return currentBoard;
						}
						const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
							insertAtTop: true,
						});
						return reverted.moved ? reverted.board : currentBoard;
					}),
				);
				return;
			}
			if (ensured.response?.warning) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: ensured.response.warning,
					timeout: 7000,
				});
			}
			const resumed = await startTaskSession(task, { resumeFromTrash: true });
			if (resumed.ok) {
				setBoard(
					withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
						const disabledAutoReview = disableTaskAutoReview(currentBoard, taskId);
						return disabledAutoReview.updated ? disabledAutoReview.board : currentBoard;
					}),
				);
				return;
			}

			notifyError(resumed.message ?? "Could not resume task session.");
			if (!options?.optimisticMoveApplied) {
				return;
			}
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const currentColumnId = getTaskColumnId(currentBoard, taskId);
					if (currentColumnId !== "review") {
						return currentBoard;
					}
					const reverted = moveTaskToColumn(currentBoard, taskId, "trash", {
						insertAtTop: true,
					});
					return reverted.moved ? reverted.board : currentBoard;
				}),
			);
		},
		[ensureTaskWorkspace, setBoard, startTaskSession],
	);

	const handleDragEnd = useCallback(
		(result: DropResult, options?: { selectDroppedTask?: boolean }) => {
			const { board } = latestBoardInteractionStateRef.current;
			if (options?.selectDroppedTask && result.type.startsWith("CARD") && result.destination) {
				setSelectedTaskId(result.draggableId);
			}
			const { behavior: programmaticMoveBehavior, programmaticCardMoveInFlight } = consumeProgrammaticCardMove(
				result.draggableId,
			);

			const applied = applyDragResult(board, result, { programmaticCardMoveInFlight });
			// 没有在途程序化移动 = 用户真拖拽；程序化移动（动画）落地时用发起入口随行为一起带来的发起方，没带就登记 null。
			const boardMutationInitiatorForThisDrop: WebUiBoardMutationInitiator | null =
				programmaticCardMoveInFlight || programmaticMoveBehavior
					? (programmaticMoveBehavior?.boardMutationInitiator ?? null)
					: "web_ui_user_gesture";
			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: board,
				boardAfterMutation: applied.board,
				boardMutationInitiator: boardMutationInitiatorForThisDrop,
			});

			const moveEvent = applied.moveEvent;
			if (!moveEvent) {
				resolvePendingProgrammaticStartMove(result.draggableId, false);
				setBoard(applied.board);
				return;
			}

			if (moveEvent.toColumnId === "trash") {
				setBoard(applied.board);
				if (programmaticMoveBehavior?.skipTrashWorkflow) {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
					return;
				}
				const requestPromise = requestMoveTaskToTrash(moveEvent.taskId, moveEvent.fromColumnId, {
					optimisticMoveApplied: true,
					skipWorkingChangeWarning: programmaticMoveBehavior?.skipWorkingChangeWarning,
					boardMutationInitiator: boardMutationInitiatorForThisDrop ?? undefined,
				});
				void requestPromise.finally(() => {
					resolvePendingProgrammaticTrashMove(moveEvent.taskId);
				});
				return;
			}

			if (moveEvent.fromColumnId === "trash" && moveEvent.toColumnId === "review") {
				setBoard(applied.board);
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (!movedSelection) {
					return;
				}
				void resumeTaskFromTrash(movedSelection.card, moveEvent.taskId, { optimisticMoveApplied: true });
				return;
			}

			if (moveEvent.fromColumnId === "review" && moveEvent.toColumnId === "validation") {
				moveFocusedReviewTaskToNextReviewTaskAfterValidationMove(board, moveEvent.taskId);
			}
			setBoard(applied.board);

			if (
				moveEvent.toColumnId === "in_progress" &&
				moveEvent.fromColumnId === "backlog" &&
				!programmaticMoveBehavior?.skipKickoff
			) {
				maybeRequestNotificationPermissionForTaskStart();
				const movedSelection = findCardSelection(applied.board, moveEvent.taskId);
				if (movedSelection) {
					void kickoffTaskInProgress(movedSelection.card, moveEvent.taskId, moveEvent.fromColumnId)
						.then((started) => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, started);
						})
						.catch(() => {
							resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
						});
					return;
				}
				resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
				return;
			}
			resolvePendingProgrammaticStartMove(moveEvent.taskId, false);
		},
		[
			consumeProgrammaticCardMove,
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			requestMoveTaskToTrash,
			resumeTaskFromTrash,
			resolvePendingProgrammaticStartMove,
			resolvePendingProgrammaticTrashMove,
			moveFocusedReviewTaskToNextReviewTaskAfterValidationMove,
			setBoard,
			setSelectedTaskId,
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
			const existingSessionSummary = sessions[taskId];
			const isExistingSessionSummaryPlaceholderOfNeverLaunchedTask =
				existingSessionSummary != null &&
				isNeverStartedPlaceholderTaskSessionSummary(existingSessionSummary) &&
				selection.card.mostRecentlyLaunchedAgentSessionAgentId == null;
			if (
				selection.column.id === "in_progress" &&
				(existingSessionSummary == null || isExistingSessionSummaryPlaceholderOfNeverLaunchedTask)
			) {
				maybeRequestNotificationPermissionForTaskStart();
				void kickoffTaskInProgress(selection.card, taskId, "in_progress");
				return;
			}
			if (selection.column.id !== "backlog") {
				return;
			}
			maybeRequestNotificationPermissionForTaskStart();
			void startBacklogTaskWithAnimation(selection.card);
		},
		[kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, startBacklogTaskWithAnimation],
	);

	const handleStartAllBacklogTasks = useCallback(
		(taskIds?: string[]) => {
			const { board } = latestBoardInteractionStateRef.current;
			const requestedTaskIds =
				taskIds ?? board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
			if (requestedTaskIds.length === 0) {
				return;
			}

			let nextBoard = board;
			const pendingStarts: BoardCard[] = [];
			const startedTaskIds = new Set<string>();

			for (const taskId of requestedTaskIds) {
				if (!taskId || startedTaskIds.has(taskId)) {
					continue;
				}
				const selection = findCardSelection(nextBoard, taskId);
				if (!selection || selection.column.id !== "backlog") {
					continue;
				}
				const moved = moveTaskToColumn(nextBoard, taskId, "in_progress", { insertAtTop: true });
				if (!moved.moved) {
					continue;
				}
				nextBoard = moved.board;
				const movedSelection = findCardSelection(nextBoard, taskId);
				if (!movedSelection) {
					continue;
				}
				pendingStarts.push(movedSelection.card);
				startedTaskIds.add(taskId);
			}

			if (pendingStarts.length === 0) {
				return;
			}

			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: board,
				boardAfterMutation: nextBoard,
				boardMutationInitiator: "web_ui_user_gesture",
			});
			setBoard(nextBoard);
			maybeRequestNotificationPermissionForTaskStart();
			for (const task of pendingStarts) {
				void kickoffTaskInProgress(task, task.id, "backlog");
			}
		},
		[kickoffTaskInProgress, maybeRequestNotificationPermissionForTaskStart, setBoard],
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
			if (!selection || selection.column.id === "trash") {
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
		(taskId: string, fromColumnId: BoardColumnId) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			setTaskMoveToTrashLoading(taskId, true);
			void requestMoveTaskToTrashWithAnimation(taskId, fromColumnId, {
				boardMutationInitiator: "web_ui_user_gesture",
			}).finally(() => {
				setTaskMoveToTrashLoading(taskId, false);
			});
		},
		[requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading],
	);

	// Post-Deploy Verification 全勾入 Done 的移列入口。与 performMoveToTrash 等价——直接走 requestMoveTaskToTrash
	// WithAnimation（保留 stopTaskSession + worktree 清理副作用），绕过 requestMoveToTrash 对 review/in_progress
	// 的 SkipValidationConfirmDialog（Post-Deploy Verification 自有确认框）。关键区别：**awaitable 且返回成败**——
	// performMoveToTrash 吞掉 Promise（fire-and-forget），本导出 await 之，成功 resolve { ok:true }、抛错 { ok:false }，
	// 让调用方在移列确实成功后才回写 boardMovedToDoneAt / 调 confirmVerificationComplete。
	const completePostDeployVerificationMoveToDone = useCallback(
		async (taskId: string, fromColumnId: BoardColumnId): Promise<{ ok: boolean }> => {
			// 同任务移列已在途：不重复触发，报失败让调用方不写完成标记。
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return { ok: false };
			}
			setTaskMoveToTrashLoading(taskId, true);
			try {
				await requestMoveTaskToTrashWithAnimation(taskId, fromColumnId, {
					boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
				});
				return { ok: true };
			} catch {
				return { ok: false };
			} finally {
				setTaskMoveToTrashLoading(taskId, false);
			}
		},
		[requestMoveTaskToTrashWithAnimation, setTaskMoveToTrashLoading],
	);

	// Single entry point for every "Move to Done" trigger (board card, detail sidebar card, agent
	// TUI bottom button). Moving straight to Done from Review / In Progress skips the manual
	// Validation step, so it requires confirmation; from Validation it is the normal completion path.
	const requestMoveToTrash = useCallback(
		(taskId: string, fromColumnId: BoardColumnId) => {
			if (moveToTrashLoadingByIdRef.current[taskId]) {
				return;
			}
			if (fromColumnId === "review" || fromColumnId === "in_progress") {
				setPendingMoveToDone({ taskId, fromColumnId });
				return;
			}
			performMoveToTrash(taskId, fromColumnId);
		},
		[performMoveToTrash],
	);

	const handleMoveToTrash = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		requestMoveToTrash(selectedCard.card.id, selectedCard.column.id);
	}, [requestMoveToTrash, selectedCard]);

	const handleMoveReviewCardToTrash = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			requestMoveToTrash(taskId, getTaskColumnId(board, taskId) ?? "review");
		},
		[requestMoveToTrash],
	);

	const confirmMoveToDone = useCallback(() => {
		if (pendingMoveToDone) {
			performMoveToTrash(pendingMoveToDone.taskId, pendingMoveToDone.fromColumnId);
		}
		setPendingMoveToDone(null);
	}, [pendingMoveToDone, performMoveToTrash]);

	const cancelMoveToDone = useCallback(() => {
		setPendingMoveToDone(null);
	}, []);

	// Pure board move into the manual-validation buffer. No session stop, no worktree teardown —
	// the developer keeps the running agent/diff while validating. Persisted automatically via
	// useWorkspacePersistence. Mirrors the manual in_progress/review → validation drag end-state.
	const handleMoveCardToValidation = useCallback(
		(taskId: string) => {
			const { board, sessions } = latestBoardInteractionStateRef.current;
			const fromColumnId = getTaskColumnId(board, taskId);
			if (fromColumnId !== "in_progress" && fromColumnId !== "review") {
				return;
			}
			const moved = moveTaskToColumn(board, taskId, "validation", { insertAtTop: true });
			if (moved.moved) {
				recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
					boardBeforeMutation: board,
					boardAfterMutation: moved.board,
					boardMutationInitiator: "web_ui_user_gesture",
				});
				setBoard(moved.board);
				if (fromColumnId === "review") {
					moveFocusedReviewTaskToNextReviewTaskAfterValidationMove(board, taskId);
				}
				// A session that is *actively producing output* in Validation gets auto-migrated back to
				// In Progress by the level-triggered effect above, so warn the developer instead of leaving
				// the card looking like it never moved. Idle / already-exited sessions (still flagged
				// "running") now stay in Validation, so the warning must use the same predicate as the
				// bounce — keying off bare state === "running" would false-warn on those. Non-blocking,
				// auto-dismisses after 3s.
				if (isAgentActivelyProducingOutput(sessions[taskId], Date.now())) {
					showAppToast({
						intent: "warning",
						icon: "info-sign",
						message: "Task is still running — it will return to In Progress while the agent keeps working.",
						timeout: 3000,
					});
				}
			}
		},
		[moveFocusedReviewTaskToNextReviewTaskAfterValidationMove, setBoard],
	);

	const handleMoveSelectedCardToValidation = useCallback(() => {
		if (!selectedCard) {
			return;
		}
		handleMoveCardToValidation(selectedCard.card.id);
	}, [handleMoveCardToValidation, selectedCard]);

	// 手动「移至 Review」：把一个停在 agent 回合（多为卡死/空闲——Stop hook 未触发、进程未退）的终端 agent
	// 任务翻入「等人审查」回合。不手动挪列：transitionTaskToReview 成功后即时 upsert 的 summary（turnOwner=user）
	// 触发上方 level-triggered effect 的 Rule A 自动落位 Review，且 review-bounce（要求 turnOwner=agent）不再触发，
	// 卡片稳定停在 Review。仅 In Progress 卡生效（与按钮渲染门控一致，双重保险）。
	const handleMoveCardToReview = useCallback(
		(taskId: string) => {
			const { board } = latestBoardInteractionStateRef.current;
			if (getTaskColumnId(board, taskId) !== "in_progress") {
				return;
			}
			setMoveToReviewLoadingById((current) => ({ ...current, [taskId]: true }));
			void (async () => {
				try {
					const ok = await transitionTaskToReview(taskId);
					if (!ok) {
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
		[transitionTaskToReview],
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

			const moved = moveTaskToColumn(board, taskId, "review", { insertAtTop: true });
			if (!moved.moved) {
				return;
			}
			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: board,
				boardAfterMutation: moved.board,
				boardMutationInitiator: "web_ui_user_gesture",
			});
			setBoard(moved.board);
			const movedSelection = findCardSelection(moved.board, taskId);
			if (!movedSelection) {
				return;
			}
			void resumeTaskFromTrash(movedSelection.card, taskId, { optimisticMoveApplied: true });
		},
		[resumeTaskFromTrash, setBoard, tryProgrammaticCardMove],
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
		const selection = findCardSelection(board, task.id);
		setDeleteTaskTarget(null);
		if (!selection) {
			return;
		}

		setBoard(
			withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
				const currentSelection = findCardSelection(currentBoard, task.id);
				if (!currentSelection) {
					return currentBoard;
				}
				const deleted = removeTask(currentBoard, task.id);
				return deleted.removed ? deleted.board : currentBoard;
			}),
		);
		setSessions((currentSessions) => {
			if (!currentSessions[task.id]) {
				return currentSessions;
			}
			const nextSessions = { ...currentSessions };
			delete nextSessions[task.id];
			return nextSessions;
		});
		if (selectedTaskId === task.id) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(task.id);
		}

		// 草稿的真相源在服务端、且刻意不随看板文档一起写，所以任务删除时要显式清一次：任务没了之后，
		// 留着的草稿再也没有可以认领它的地方，只会变成永远看不见的垃圾。
		if (currentProjectId) {
			discardAllTaskEditDraftsForDeletedTask(currentProjectId, task.id);
		}

		void (async () => {
			await stopTaskSession(task.id);
			await cleanupTaskWorkspace(task.id, task.worktreeMode);
		})();
	}, [
		board,
		cleanupTaskWorkspace,
		deleteTaskTarget,
		selectedTaskId,
		setBoard,
		setSelectedTaskId,
		setSessions,
		stopTaskSession,
		currentProjectId,
	]);

	const handleCancelAutomaticTaskAction = useCallback(
		(taskId: string) => {
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const selection = findCardSelection(currentBoard, taskId);
					if (!selection || selection.card.autoReviewEnabled !== true) {
						return currentBoard;
					}
					const updated = updateTask(currentBoard, taskId, {
						prompt: selection.card.prompt,
						startInPlanMode: selection.card.startInPlanMode,
						autoReviewEnabled: false,
						autoReviewMode: resolveTaskAutoReviewMode(selection.card.autoReviewMode),
						images: selection.card.images,
						agentId: selection.card.agentId,
						clineSettings: selection.card.clineSettings,
						terminalAgentModelOverrideSettings: selection.card.terminalAgentModelOverrideSettings,
						baseRef: selection.card.baseRef,
					});
					return updated.updated ? updated.board : currentBoard;
				}),
			);
		},
		[setBoard],
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

	const handleConfirmTaskPinboardPinReason = useCallback(
		(taskId: string, pinReason: string) => {
			setTaskPinboardPinReasonRequest(null);
			// pinTaskToTaskPinboard 对已置顶的卡保留原 pinnedToTaskPinboardAt，所以「编辑原因」不会把它顶到板首。
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const pinned = pinTaskToTaskPinboard(currentBoard, taskId, { pinReason });
					return pinned.updated ? pinned.board : currentBoard;
				}),
			);
		},
		[setBoard],
	);

	const handleUnpinTaskFromTaskPinboard = useCallback(
		(taskId: string) => {
			setBoard(
				withWebUiBoardMutationInitiatorRecordedForChangedTaskCards("web_ui_user_gesture", (currentBoard) => {
					const unpinned = unpinTaskFromTaskPinboard(currentBoard, taskId);
					return unpinned.updated ? unpinned.board : currentBoard;
				}),
			);
		},
		[setBoard],
	);

	const handleOpenClearTrash = useCallback(() => {
		if (trashTaskCount === 0) {
			return;
		}
		setIsClearTrashDialogOpen(true);
	}, [setIsClearTrashDialogOpen, trashTaskCount]);

	const handleConfirmClearTrash = useCallback(() => {
		const trashColumn = board.columns.find((column) => column.id === "trash");
		const trashCards = trashColumn ? [...trashColumn.cards] : [];
		const taskIds = trashCards.map((card) => card.id);
		setIsClearTrashDialogOpen(false);
		if (taskIds.length === 0) {
			return;
		}

		setBoard(
			withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(
				"web_ui_user_gesture",
				(currentBoard) => clearColumnTasks(currentBoard, "trash").board,
			),
		);
		setSessions((currentSessions) => {
			const nextSessions = { ...currentSessions };
			for (const taskId of taskIds) {
				delete nextSessions[taskId];
			}
			return nextSessions;
		});
		if (selectedTaskId && taskIds.includes(selectedTaskId)) {
			setSelectedTaskId(null);
			clearTaskWorkspaceInfo(selectedTaskId);
		}

		void (async () => {
			await Promise.all(
				trashCards.map(async (card) => {
					await stopTaskSession(card.id);
					await cleanupTaskWorkspace(card.id, card.worktreeMode);
				}),
			);
		})();
	}, [
		board.columns,
		cleanupTaskWorkspace,
		selectedTaskId,
		setBoard,
		setIsClearTrashDialogOpen,
		setSelectedTaskId,
		setSessions,
		stopTaskSession,
	]);

	const resetBoardInteractionsState = useCallback(() => {
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
	}, [resetProgrammaticCardMoves, resolvePendingProgrammaticStartMove, setIsClearTrashDialogOpen]);

	useEffect(() => {
		resetBoardInteractionsState();
	}, [currentProjectId, resetBoardInteractionsState]);

	return {
		handleProgrammaticCardMoveReady,
		confirmMoveTaskToTrash,
		handleDragEnd,
		handleStartTask,
		handleStartAllBacklogTasks,
		handleDetailTaskDragEnd,
		handleCardSelect,
		handleMoveToTrash,
		handleMoveReviewCardToTrash,
		isMoveToDoneConfirmOpen: pendingMoveToDone !== null,
		confirmMoveToDone,
		cancelMoveToDone,
		completePostDeployVerificationMoveToDone,
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
