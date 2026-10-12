import type { DropResult } from "@hello-pangea/dnd";
import { act, type Dispatch, type ReactElement, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardInteractions } from "@/hooks/use-board-interactions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type * as BoardStateModule from "@/state/board-state";
import { moveTaskToColumn } from "@/state/board-state";
import type { ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import {
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	readPendingWebUiBoardMutationInitiatorForTaskCardAspect,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import {
	readPendingTaskCardCommandBoardOverlayEntries,
	resetPendingTaskCardCommandBoardOverlayStore,
} from "@/stores/pending-task-card-command-board-overlay-store";
import { getTaskAgentSessionStartRequestInFlightPhase } from "@/stores/task-agent-session-start-request-in-flight-store";
import { clearAllTaskCardActionCommandsInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const useProgrammaticCardMovesMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

// 卡片动作走 taskCardAction（见 task-card-action-commands-for-any-workspace.ts）：断言命令入参，而不是浏览器
// 自己停会话 / 删 worktree / 起会话。缺省实现返回「成功、卡已到目标列」的动作后快照。
const taskCardActionQueryMocks = vi.hoisted(() => ({
	startTaskCardAgentSessionMovingItIntoInProgressInWorkspace: vi.fn(),
	moveTaskCardIntoReviewByHandingTurnToUserInWorkspace: vi.fn(),
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace: vi.fn(),
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace: vi.fn(),
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace: vi.fn(),
	permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace: vi.fn(),
	updateTaskCardFieldValuesInWorkspace: vi.fn(),
	setTaskPinboardPinStateOfTaskCardInWorkspace: vi.fn(),
	readTaskCardWithBoardColumnInWorkspace: vi.fn(),
}));
vi.mock("@/runtime/task-card-action-query", () => taskCardActionQueryMocks);

function makeTaskCardSnapshotAfterAction(taskId: string, boardColumnIdContainingTaskCard: BoardColumnId) {
	return {
		taskCard: createTask(taskId, taskId, 1),
		boardColumnIdContainingTaskCard,
		taskSessionSummaryLiveInRuntimeProcessMemory: null,
		taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
	};
}

function resetTaskCardActionQueryMocksToSucceed(): void {
	taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace.mockReset();
	taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace.mockImplementation(
		async (_workspaceId: string, request: { taskId: string }) => ({
			boardColumnIdOfTaskCardBeforeAction: "backlog",
			taskCardWasMovedIntoInProgressColumnByThisAction: true,
			agentSessionStartOutcome: "agent_session_started",
			agentSessionStartFailureMessage: null,
			ensuredTaskWorktreeWarningMessage: null,
			startedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction(request.taskId, "in_progress"),
		}),
	);
	taskCardActionQueryMocks.moveTaskCardIntoReviewByHandingTurnToUserInWorkspace.mockReset();
	taskCardActionQueryMocks.moveTaskCardIntoReviewByHandingTurnToUserInWorkspace.mockImplementation(
		async (_workspaceId: string, request: { taskId: string }) => ({
			agentTurnHandoffToUserOutcome: "agent_turn_handed_to_user",
			agentTurnHandoffToUserFailureMessage: null,
			taskCardWasMovedIntoReviewColumnByThisAction: true,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction(request.taskId, "review"),
		}),
	);
	taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace.mockReset();
	taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace.mockImplementation(
		async (_workspaceId: string, request: { taskId: string; targetBoardColumnId: BoardColumnId }) => ({
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardPlacementWasChangedByThisAction: true,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction(request.taskId, request.targetBoardColumnId),
		}),
	);
	taskCardActionQueryMocks.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace.mockReset();
	taskCardActionQueryMocks.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace.mockImplementation(
		async (_workspaceId: string, request: { taskId: string }) => ({
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
			taskAgentSessionStopWasRequested: true,
			taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction(request.taskId, "trash"),
		}),
	);
	taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace.mockReset();
	taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace.mockImplementation(
		async (_workspaceId: string, request: { taskId: string }) => ({
			taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
			taskCardRestoreFromDoneFailureMessage: null,
			ensuredTaskWorktreeWarningMessage: null,
			resumedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction(request.taskId, "review"),
		}),
	);
	taskCardActionQueryMocks.permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace.mockReset();
	taskCardActionQueryMocks.permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace.mockImplementation(
		async (
			_workspaceId: string,
			request: { permanentlyDeletedTaskCardSelection: { selectedTaskIds?: string[] } },
		) => ({
			permanentlyDeletedTaskCards: (request.permanentlyDeletedTaskCardSelection.selectedTaskIds ?? []).map(
				(taskId) => ({
					deletedTaskCard: createTask(taskId, taskId, 1),
					boardColumnIdOfDeletedTaskCardBeforeDeletion: "review",
					taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion: null,
					taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
				}),
			),
		}),
	);
	taskCardActionQueryMocks.updateTaskCardFieldValuesInWorkspace.mockReset();
	taskCardActionQueryMocks.setTaskPinboardPinStateOfTaskCardInWorkspace.mockReset();
	taskCardActionQueryMocks.readTaskCardWithBoardColumnInWorkspace.mockReset();
}

vi.mock("@/hooks/use-programmatic-card-moves", () => ({
	useProgrammaticCardMoves: useProgrammaticCardMovesMock,
}));

// cf427：启动前等「本页面新建的卡已被 runtime 确认落盘」。缺省放行；个别用例改成落盘失败。
const waitForNewTaskCardPersistedByRuntimeMock = vi.hoisted(() =>
	vi.fn(async (): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
);
vi.mock("@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start", () => ({
	waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart: waitForNewTaskCardPersistedByRuntimeMock,
}));

vi.mock("@/hooks/use-review-auto-actions", () => ({
	useReviewAutoActions: () => ({}) as ReturnType<typeof useBoardInteractions>,
}));

// B5 引用短路测试的观察点：getTaskColumnId 是 Rule A 自动流转 effect 每 tick 对每条 summary
// 跑的全板 O(卡) 扫描。用 spy 包裹真实实现（行为不变），断言未变引用的 summary 连这次扫描
// 都被整体跳过。
const getTaskColumnIdSpy = vi.hoisted(() => vi.fn<(board: BoardData, taskId: string) => BoardColumnId | null>());

vi.mock("@/state/board-state", async (importOriginal) => {
	const actual = await importOriginal<typeof BoardStateModule>();
	return {
		...actual,
		getTaskColumnId: (board: BoardData, taskId: string): BoardColumnId | null => {
			getTaskColumnIdSpy(board, taskId);
			return actual.getTaskColumnId(board, taskId);
		},
	};
});

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createRunningSession(
	taskId: string,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: null,
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

// Board with a populated Validation column (createBoard omits it) so the
// level-triggered effect can be observed deciding whether a running session
// stays in Validation or bounces back to In Progress.
function createBoardWithValidationTask(taskId: string): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [createTask(taskId, "Validating task", 1)] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

// Full column set with a single task placed in `columnId`, so the level-triggered effect's
// facet-driven column mapping (awaiting-review → review, agent-turn → bounce, interrupted → trash)
// can be observed end-to-end.
function createBoardWithTaskInColumn(taskId: string, columnId: BoardData["columns"][number]["id"]): BoardData {
	const columns: BoardData["columns"] = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "validation", title: "Validation", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	for (const column of columns) {
		if (column.id === columnId) {
			column.cards = [createTask(taskId, "Mapped task", 1)];
		}
	}
	return { columns };
}

function createBoardWithReviewTaskIds(
	reviewTaskIds: string[],
	otherColumnCardsByColumnId?: Partial<Record<BoardData["columns"][number]["id"], BoardCard[]>>,
): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: otherColumnCardsByColumnId?.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: otherColumnCardsByColumnId?.in_progress ?? [] },
			{
				id: "review",
				title: "Review",
				cards: reviewTaskIds.map((taskId, index) => createTask(taskId, `Review task ${taskId}`, index + 1)),
			},
			{ id: "validation", title: "Validation", cards: otherColumnCardsByColumnId?.validation ?? [] },
			{ id: "trash", title: "Done", cards: otherColumnCardsByColumnId?.trash ?? [] },
		],
	};
}

const NOOP_FETCH_WORKSPACE_INFO = async (): Promise<null> => null;
const NOOP_SEND_TASK_INPUT = async (): Promise<{ ok: boolean }> => ({ ok: true });
const NOOP_RUN_AUTO_REVIEW = async (): Promise<boolean> => false;

// The level-triggered column-mapping effect only needs "unavailable" programmatic moves (so it falls
// through to the direct moveTaskToColumn path) plus no-op move-to-done actions. Shared by the
// facet-driven mapping tests below to avoid repeating the full mock objects.
function mockUnavailableProgrammaticCardMoves(): void {
	useProgrammaticCardMovesMock.mockReturnValue({
		handleProgrammaticCardMoveReady: () => {},
		setRequestMoveTaskToTrashHandler: () => {},
		tryProgrammaticCardMove: () => "unavailable",
		consumeProgrammaticCardMove: () => ({}),
		resolvePendingProgrammaticTrashMove: () => {},
		waitForProgrammaticCardMoveAvailability: async () => {},
		resetProgrammaticCardMoves: () => {},
		requestMoveTaskToTrashWithAnimation: async () => {},
		programmaticCardMoveCycle: 0,
	});
}

interface HookSnapshot {
	handleAddReviewComments: (taskId: string, text: string) => Promise<void>;
	handleSendReviewComments: (taskId: string, text: string) => Promise<void>;
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleOpenDeleteTask: (taskId: string) => void;
	handleConfirmDeleteTask: () => void;
	deleteTaskTarget: BoardCard | null;
	handleStartTask: (taskId: string) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleMoveCardToValidation: (taskId: string) => void;
	handleDragEnd: (result: DropResult) => void;
	isMoveToDoneConfirmOpen: boolean;
	confirmMoveToDone: () => void;
	cancelMoveToDone: () => void;
	handleMoveCardToReview: (taskId: string) => void;
	moveToReviewLoadingById: Record<string, boolean>;
	completePostDeployVerificationMoveToDone: (taskId: string, fromColumnId: BoardColumnId) => Promise<{ ok: boolean }>;
}

function createRect(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		width,
		height,
		right: width,
		bottom: height,
		toJSON: () => ({}),
	} as DOMRect;
}

function HookHarness({
	board,
	setBoard,
	selectedCard = null,
	selectedTaskId = null,
	setSelectedTaskIdOverride,
	sendTaskSessionInput = NOOP_SEND_TASK_INPUT,
	initialSessions,
	onSnapshot,
	onSessionsControl,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	selectedCard?: { card: BoardCard; column: { id: "backlog" | "in_progress" | "review" | "trash" } } | null;
	selectedTaskId?: string | null;
	setSelectedTaskIdOverride?: Dispatch<SetStateAction<string | null>>;
	sendTaskSessionInput?: UseTaskSessionsResult["sendTaskSessionInput"];
	initialSessions?: Record<string, RuntimeTaskSessionSummary>;
	onSnapshot?: (snapshot: HookSnapshot) => void;
	onSessionsControl?: (control: {
		setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
	}) => void;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>(initialSessions ?? {});
	const [, setSelectedTaskId] = useState<string | null>(selectedTaskId);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const [, setIsGitHistoryOpen] = useState(false);

	const actions = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId,
		currentProjectId: "project-1",
		setSelectedTaskId: setSelectedTaskIdOverride ?? setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		fetchTaskWorkspaceInfo: NOOP_FETCH_WORKSPACE_INFO,
		sendTaskSessionInput,
		readyForReviewNotificationsEnabled: false,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction: NOOP_RUN_AUTO_REVIEW,
	});

	useEffect(() => {
		onSnapshot?.({
			handleAddReviewComments: actions.handleAddReviewComments,
			handleSendReviewComments: actions.handleSendReviewComments,
			handleRestoreTaskFromTrash: actions.handleRestoreTaskFromTrash,
			handleOpenDeleteTask: actions.handleOpenDeleteTask,
			handleConfirmDeleteTask: actions.handleConfirmDeleteTask,
			deleteTaskTarget: actions.deleteTaskTarget,
			handleStartTask: actions.handleStartTask,
			handleCardSelect: actions.handleCardSelect,
			handleMoveReviewCardToTrash: actions.handleMoveReviewCardToTrash,
			handleMoveCardToValidation: actions.handleMoveCardToValidation,
			handleDragEnd: actions.handleDragEnd,
			isMoveToDoneConfirmOpen: actions.isMoveToDoneConfirmOpen,
			confirmMoveToDone: actions.confirmMoveToDone,
			cancelMoveToDone: actions.cancelMoveToDone,
			handleMoveCardToReview: actions.handleMoveCardToReview,
			moveToReviewLoadingById: actions.moveToReviewLoadingById,
			completePostDeployVerificationMoveToDone: actions.completePostDeployVerificationMoveToDone,
		});
	}, [
		actions.handleAddReviewComments,
		actions.handleSendReviewComments,
		actions.completePostDeployVerificationMoveToDone,
		actions.deleteTaskTarget,
		actions.handleCardSelect,
		actions.handleConfirmDeleteTask,
		actions.handleOpenDeleteTask,
		actions.handleRestoreTaskFromTrash,
		actions.handleStartTask,
		actions.handleMoveReviewCardToTrash,
		actions.handleMoveCardToValidation,
		actions.handleDragEnd,
		actions.isMoveToDoneConfirmOpen,
		actions.confirmMoveToDone,
		actions.cancelMoveToDone,
		actions.handleMoveCardToReview,
		actions.moveToReviewLoadingById,
		onSnapshot,
	]);

	useEffect(() => {
		onSessionsControl?.({ setSessions });
	}, [onSessionsControl]);

	return null;
}

describe("useBoardInteractions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		resetTaskCardActionQueryMocksToSucceed();
		clearAllTaskCardActionCommandsInFlight();
		resetPendingTaskCardCommandBoardOverlayStore();
		useProgrammaticCardMovesMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderMoveToValidationHarness(board: BoardData, initialSelectedTaskId: string | null) {
		let currentBoard = board;
		let selectedTaskId = initialSelectedTaskId;
		let latestSnapshot: HookSnapshot | null = null;
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>((nextSelectedTaskId) => {
			selectedTaskId =
				typeof nextSelectedTaskId === "function" ? nextSelectedTaskId(selectedTaskId) : nextSelectedTaskId;
		});

		mockUnavailableProgrammaticCardMoves();

		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					selectedTaskId={initialSelectedTaskId}
					setSelectedTaskIdOverride={setSelectedTaskId}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const requireSnapshot = (): HookSnapshot => {
			if (!latestSnapshot) {
				throw new Error("Expected a hook snapshot.");
			}
			return latestSnapshot;
		};

		return {
			getCurrentBoard: () => currentBoard,
			getSelectedTaskId: () => selectedTaskId,
			requireSnapshot,
			setBoard,
			setSelectedTaskId,
		};
	}

	it("仅填入启用严格粘贴，显式发送保留程序化投递与单独提交", async () => {
		mockUnavailableProgrammaticCardMoves();
		const sendTaskSessionInput = vi
			.fn<UseTaskSessionsResult["sendTaskSessionInput"]>()
			.mockResolvedValue({ ok: true });
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard()}
					setBoard={() => {}}
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		await act(async () => {
			await latestSnapshot?.handleAddReviewComments("task-1", "\n提示词\n");
		});
		expect(sendTaskSessionInput).toHaveBeenCalledExactlyOnceWith("task-1", "\n提示词\n", {
			appendNewline: false,
			mode: "paste",
			requireTerminalPasteSuccess: true,
		});
		sendTaskSessionInput.mockClear();
		await act(async () => {
			const sending = latestSnapshot?.handleSendReviewComments("task-1", "审查指令");
			await vi.advanceTimersByTimeAsync(200);
			await sending;
		});
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(1, "task-1", "审查指令", {
			appendNewline: false,
			mode: "paste",
		});
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-1", "\r", { appendNewline: false });
		expect(sendTaskSessionInput).toHaveBeenCalledTimes(2);
	});

	it("回调身份跨 board/session 更新稳定，旧回调仍读取最新卡片及会话", async () => {
		mockUnavailableProgrammaticCardMoves();
		const setBoard = vi.fn();
		let snapshot: HookSnapshot | null = null;
		let updateSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>> | undefined;
		const render = (board: BoardData) =>
			act(() =>
				root.render(
					<HookHarness
						board={board}
						setBoard={setBoard}
						onSnapshot={(value) => {
							snapshot = value;
						}}
						onSessionsControl={(value) => {
							updateSessions = value.setSessions;
						}}
					/>,
				),
			);
		render(createBoard());
		const first = snapshot!;
		const changedBoard = createBoard();
		changedBoard.columns[0]!.cards[0]!.title = "最新标题";
		render(changedBoard);
		act(() => updateSessions?.({ unrelated: createRunningSession("unrelated") }));
		for (const key of [
			"handleStartTask",
			"handleDragEnd",
			"handleCardSelect",
			"handleOpenDeleteTask",
			"handleMoveReviewCardToTrash",
			"handleMoveCardToValidation",
			"handleMoveCardToReview",
			"handleRestoreTaskFromTrash",
		] as const)
			expect(snapshot![key], key).toBe(first[key]);
		act(() => first.handleOpenDeleteTask("task-1"));
		expect(snapshot!.deleteTaskTarget?.title).toBe("最新标题");
	});

	it("does not send the start command when the new card could not be saved by the runtime (cf427)", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		waitForNewTaskCardPersistedByRuntimeMock.mockResolvedValueOnce({ ok: false, message: "runtime unreachable" });
		const board = createBoardWithTaskInColumn("task-1", "in_progress");
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>();

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleStartTask("task-1");
		});

		expect(waitForNewTaskCardPersistedByRuntimeMock).toHaveBeenCalledWith({
			workspaceId: "project-1",
			taskCard: expect.objectContaining({ id: "task-1" }),
		});
		expect(
			taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace,
		).not.toHaveBeenCalled();
		expect(notifyErrorMock).toHaveBeenCalledWith(expect.stringContaining("runtime unreachable"));
	});

	it("retries an In Progress task in place through the start command when no session was created", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		const board = createBoardWithTaskInColumn("task-1", "in_progress");
		let currentBoard = board;
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleStartTask("task-1");
		});

		expect(taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ taskId: "task-1", boardMutationInitiator: "web_ui_user_gesture" }),
		);
		// 浏览器不改会被保存的 board（移列与起会话都在服务端）。
		expect(currentBoard).toBe(board);
	});

	it("retries an In Progress task in place when only a never-started placeholder session exists", async () => {
		// 终端面板一挂上，运行时就会回一份占位 summary（idle、agent/pid/startedAt 全空）。启动前段失败
		// （例如建 worktree 时锁等待超时）后 sessions 里留下的就是它——此前它被当成「已有会话」，卡片再也点不起来。
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		const board = createBoardWithTaskInColumn("task-1", "in_progress");
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>();
		const neverStartedPlaceholderSummary = {
			taskId: "task-1",
			state: "idle",
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		} as RuntimeTaskSessionSummary;

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					initialSessions={{ "task-1": neverStartedPlaceholderSummary }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleStartTask("task-1");
		});

		expect(taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).toHaveBeenCalledTimes(
			1,
		);
	});

	it("does not resend the prompt for a placeholder session when the card records a previous launch", async () => {
		// 硬中断 / 运行时重启后 summary 也会退化成占位形状。卡片记着启动成功过的，就不能以原 prompt 再起一段
		// 新对话（会丢掉本可续跑的旧对话）——那属于续跑路径。
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		const board = createBoardWithTaskInColumn("task-1", "in_progress");
		const launchedCard = board.columns.find((column) => column.id === "in_progress")?.cards[0];
		if (launchedCard) {
			launchedCard.mostRecentlyLaunchedAgentSessionAgentId = "claude";
		}

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={vi.fn<Dispatch<SetStateAction<BoardData>>>()}
					initialSessions={{
						"task-1": {
							taskId: "task-1",
							state: "idle",
							agentId: null,
							workspacePath: null,
							pid: null,
							startedAt: null,
							updatedAt: 1,
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: null,
						} as RuntimeTaskSessionSummary,
					}}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleStartTask("task-1");
		});

		expect(
			taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace,
		).not.toHaveBeenCalled();
	});

	it("marks the start request in flight while the start command runs and clears it when the start fails", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		const board = createBoardWithTaskInColumn("task-1", "in_progress");
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>();
		const observedPhases: Array<string | null> = [];
		let resolveStart: () => void = () => {};
		taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace.mockImplementation(
			() =>
				new Promise((resolve) => {
					observedPhases.push(getTaskAgentSessionStartRequestInFlightPhase("project-1", "task-1"));
					resolveStart = () =>
						resolve({
							boardColumnIdOfTaskCardBeforeAction: "in_progress",
							taskCardWasMovedIntoInProgressColumnByThisAction: false,
							agentSessionStartOutcome: "agent_session_start_failed",
							agentSessionStartFailureMessage: "spawn failed",
							ensuredTaskWorktreeWarningMessage: null,
							startedAgentSessionSummary: null,
							taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction("task-1", "in_progress"),
						});
				}),
		);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleStartTask("task-1");
		});
		await act(async () => {
			resolveStart();
		});

		// ensure worktree 与起会话合在一条服务端命令里，浏览器只看得到「准备中」这一相位。
		expect(observedPhases).toEqual(["preparing_task_worktree"]);
		expect(notifyErrorMock).toHaveBeenCalledWith("spawn failed");
		// 失败也必须清掉：否则面板永远停在「正在启动」，且重启入口一直被禁用。
		expect(getTaskAgentSessionStartRequestInFlightPhase("project-1", "task-1")).toBeNull();
	});

	it("permanently deletes one task from any column without clearing the rest of the board", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		let latestBoard: BoardData | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const initialBoard = createBoard();
		initialBoard.columns[3] = {
			...initialBoard.columns[3]!,
			cards: [createTask("done-1", "Keep done", 10), createTask("done-2", "Keep me", 11)],
		};

		function StatefulHarness(): ReactElement {
			const [board, setBoard] = useState(initialBoard);
			useEffect(() => {
				latestBoard = board;
			}, [board]);
			return (
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>
			);
		}

		await act(async () => {
			root.render(<StatefulHarness />);
		});

		const requireSnapshot = (): HookSnapshot => {
			if (!latestSnapshot) {
				throw new Error("Expected a hook snapshot.");
			}
			return latestSnapshot;
		};
		const requireBoard = (): BoardData => {
			if (!latestBoard) {
				throw new Error("Expected latest board.");
			}
			return latestBoard;
		};

		await act(async () => {
			requireSnapshot().handleOpenDeleteTask("task-1");
		});

		expect(requireSnapshot().deleteTaskTarget?.id).toBe("task-1");

		await act(async () => {
			requireSnapshot().handleConfirmDeleteTask();
		});

		// 永久删除走服务端命令（按 id 只选这一张；停会话、删 worktree、清草稿都在服务端收尾链里）。
		expect(
			taskCardActionQueryMocks.permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace,
		).toHaveBeenCalledWith("project-1", {
			permanentlyDeletedTaskCardSelection: {
				permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
				selectedTaskIds: ["task-1"],
			},
			boardMutationInitiator: "web_ui_user_gesture",
		});
		// 浏览器不改会被保存的 board；显示层的「已删除」由 overlay 承担，等广播回灌。
		const doneCards = requireBoard().columns.find((column) => column.id === "trash")?.cards ?? [];
		expect(doneCards.map((card) => card.id)).toEqual(["done-1", "done-2"]);
		expect(readPendingTaskCardCommandBoardOverlayEntries("project-1")).toEqual([
			expect.objectContaining({
				taskId: "task-1",
				expectedBoardEffect: { pendingTaskCardCommandExpectedBoardEffectKind: "task_card_removed_from_board" },
			}),
		]);
	});

	it("waits for a new backlog card height to settle before starting animation", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const tryProgrammaticCardMove = vi.fn(() => "unavailable" as const);
		let measurementCount = 0;
		const boardElement = document.createElement("section");
		boardElement.className = "kb-board";
		const taskElement = document.createElement("div");
		taskElement.dataset.taskId = "task-1";
		vi.spyOn(taskElement, "getBoundingClientRect").mockImplementation(() => {
			measurementCount += 1;
			if (measurementCount === 1) {
				return createRect(160, 44);
			}
			return createRect(160, 96);
		});
		boardElement.appendChild(taskElement);
		document.body.appendChild(boardElement);

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove,
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>(() => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleStartTask("task-1");
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(32);
			await Promise.resolve();
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(16);
			await Promise.resolve();
		});

		expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-1", "backlog", "in_progress", {
			boardMutationInitiator: "web_ui_user_gesture",
		});
		boardElement.remove();
	});

	it("starts backlog tasks immediately from detail view without waiting for card height to settle", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const tryProgrammaticCardMove = vi.fn(() => "unavailable" as const);
		let measurementCount = 0;
		const boardElement = document.createElement("section");
		boardElement.className = "kb-board";
		const taskElement = document.createElement("div");
		taskElement.dataset.taskId = "task-1";
		vi.spyOn(taskElement, "getBoundingClientRect").mockImplementation(() => {
			measurementCount += 1;
			if (measurementCount === 1) {
				return createRect(160, 44);
			}
			return createRect(160, 96);
		});
		boardElement.appendChild(taskElement);
		document.body.appendChild(boardElement);

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove,
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const board = createBoard();
		let currentBoard = board;
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					selectedCard={{ card: board.columns[0]!.cards[0]!, column: { id: "backlog" } }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleStartTask("task-1");
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();
		expect(measurementCount).toBe(0);
		// 移列在服务端，浏览器只叠 overlay（卡插到 In Progress 列顶），不改会被保存的 board。
		expect(currentBoard).toBe(board);
		expect(taskCardActionQueryMocks.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ taskId: "task-1", insertAtIndexWithinInProgressBoardColumn: 0 }),
		);
		boardElement.remove();
	});

	it("shows a warning toast when restoring a trashed task with a saved patch warning", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [trashTask] },
			],
		};
		let currentBoard = board;
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace.mockResolvedValueOnce({
			taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
			taskCardRestoreFromDoneFailureMessage: null,
			ensuredTaskWorktreeWarningMessage: "Saved task changes could not be reapplied automatically.",
			resumedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction("task-trash", "review"),
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleRestoreTaskFromTrash("task-trash");
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		// 恢复走服务端命令（移回 review → ensure worktree → 续跑），浏览器不改会被保存的 board。
		expect(
			taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace,
		).toHaveBeenCalledWith("project-1", expect.objectContaining({ taskId: "task-trash" }));
		expect(currentBoard).toBe(board);
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "warning",
			icon: "warning-sign",
			message: "Saved task changes could not be reapplied automatically.",
			timeout: 7000,
		});
	});

	// 恢复失败时服务端把卡移回 Done：动作后快照与 overlay 的期望（在 Review）不符，overlay 立即撤掉，不盖住真相。
	it("drops the restore overlay right away when the runtime moved the card back into Done", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		mockUnavailableProgrammaticCardMoves();
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [createTask("task-trash", "Trash task", 2)] },
			],
		};
		taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace.mockResolvedValueOnce({
			taskCardRestoreFromDoneOutcome: "agent_session_resume_failed_so_task_card_was_moved_back_into_done",
			taskCardRestoreFromDoneFailureMessage: "resume failed",
			ensuredTaskWorktreeWarningMessage: null,
			resumedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction("task-trash", "trash"),
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={vi.fn<Dispatch<SetStateAction<BoardData>>>()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			(latestSnapshot as HookSnapshot | null)?.handleRestoreTaskFromTrash("task-trash");
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		expect(notifyErrorMock).toHaveBeenCalledWith("resume failed");
		expect(readPendingTaskCardCommandBoardOverlayEntries("project-1")).toEqual([]);
	});

	it("ignores card selection requests for trashed tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [trashTask] },
			],
		};
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={() => board}
					setSelectedTaskIdOverride={setSelectedTaskId}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleCardSelect("task-trash");
		});

		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("moves focus to the following review task when the selected review task moves to validation", async () => {
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2", "review-3"]),
			"review-2",
		);

		await act(async () => {
			harness.requireSnapshot().handleMoveCardToValidation("review-2");
		});

		// 移列走服务端命令（overlay 立刻显示），焦点照旧挪到下一张 review 卡。
		expect(
			taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
		).toHaveBeenCalledWith("project-1", {
			taskId: "review-2",
			targetBoardColumnId: "validation",
			boardMutationInitiator: "web_ui_user_gesture",
		});
		expect(harness.getSelectedTaskId()).toBe("review-3");
	});

	it("moves focus to the previous review task when the selected last review task moves to validation", async () => {
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2"]),
			"review-2",
		);

		await act(async () => {
			harness.requireSnapshot().handleMoveCardToValidation("review-2");
		});

		expect(harness.getSelectedTaskId()).toBe("review-1");
	});

	it("keeps focus on the moved validation task when review has no remaining tasks", async () => {
		const harness = await renderMoveToValidationHarness(createBoardWithReviewTaskIds(["review-1"]), "review-1");

		await act(async () => {
			harness.requireSnapshot().handleMoveCardToValidation("review-1");
		});

		expect(harness.getSelectedTaskId()).toBe("review-1");
	});

	it("does not steal focus when a non-selected review task moves to validation", async () => {
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2", "review-3"]),
			"review-1",
		);

		await act(async () => {
			harness.requireSnapshot().handleMoveCardToValidation("review-2");
		});

		expect(harness.getSelectedTaskId()).toBe("review-1");
	});

	it("moves focus to the following review task when the selected review task is dragged to validation", async () => {
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2"]),
			"review-1",
		);
		const reviewToValidationDropResult: DropResult = {
			draggableId: "review-1",
			type: "CARD",
			source: { droppableId: "review", index: 0 },
			destination: { droppableId: "validation", index: 0 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		};

		await act(async () => {
			harness.requireSnapshot().handleDragEnd(reviewToValidationDropResult);
		});

		expect(
			taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
		).toHaveBeenCalledWith("project-1", {
			taskId: "review-1",
			targetBoardColumnId: "validation",
			insertAtIndexWithinTargetBoardColumn: 0,
			boardMutationInitiator: "web_ui_user_gesture",
		});
		expect(harness.getSelectedTaskId()).toBe("review-2");
	});

	// 拖进 Done / 从 Done 拖回 Review 的落点必须随命令发给服务端，否则广播回灌后卡片跳回列顶。
	it("sends the drop index to the runtime when a card is dragged into Done or dragged from Done back to Review", async () => {
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2"], {
				trash: [
					createTask("done-1", "Done task 1", 3),
					createTask("done-2", "Done task 2", 4),
					createTask("done-3", "Done task 3", 5),
				],
			}),
			null,
		);
		const reviewIntoDoneDropResult: DropResult = {
			draggableId: "review-2",
			type: "CARD",
			source: { droppableId: "review", index: 1 },
			destination: { droppableId: "trash", index: 1 },
			mode: "FLUID",
			reason: "DROP",
			combine: null,
		};
		const doneBackIntoReviewDropResult: DropResult = {
			draggableId: "done-3",
			type: "CARD",
			source: { droppableId: "trash", index: 2 },
			destination: { droppableId: "review", index: 1 },
			mode: "FLUID",
			reason: "DROP",
			combine: null,
		};

		await act(async () => {
			harness.requireSnapshot().handleDragEnd(reviewIntoDoneDropResult);
			harness.requireSnapshot().handleDragEnd(doneBackIntoReviewDropResult);
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		expect(
			taskCardActionQueryMocks.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace,
		).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ taskId: "review-2", insertAtIndexWithinDoneBoardColumn: 1 }),
		);
		expect(
			taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace,
		).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ taskId: "done-3", insertAtIndexWithinReviewBoardColumn: 1 }),
		);
	});

	it("keeps focus on an in-progress task when that task moves to validation", async () => {
		const inProgressTask = createTask("in-progress-1", "In-progress task", 1);
		const harness = await renderMoveToValidationHarness(
			createBoardWithReviewTaskIds(["review-1", "review-2"], { in_progress: [inProgressTask] }),
			"in-progress-1",
		);

		await act(async () => {
			harness.requireSnapshot().handleMoveCardToValidation("in-progress-1");
		});

		expect(harness.getSelectedTaskId()).toBe("in-progress-1");
	});

	it("keeps an idle (output-quiet) running task in Validation instead of bouncing it", async () => {
		let currentBoard = createBoardWithValidationTask("task-idle");

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		// lastSubstantiveOutputAt well beyond the 5s quiet threshold → idle running (no fresh substance).
		const idleSessions = {
			"task-idle": createRunningSession("task-idle", {
				lastOutputAt: Date.now() - 60_000,
				lastSubstantiveOutputAt: Date.now() - 60_000,
			}),
		};

		await act(async () => {
			root.render(<HookHarness board={currentBoard} setBoard={setBoard} initialSessions={idleSessions} />);
		});

		const validationCards = currentBoard.columns.find((column) => column.id === "validation")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(validationCards.map((card) => card.id)).toEqual(["task-idle"]);
		expect(inProgressCards).toEqual([]);
	});

	it("bounces an actively-producing running task out of Validation back to In Progress", async () => {
		let currentBoard = createBoardWithValidationTask("task-active");

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		// lastSubstantiveOutputAt within the 5s quiet threshold → actively producing substantive output.
		const activeSessions = {
			"task-active": createRunningSession("task-active", {
				lastOutputAt: Date.now() - 500,
				lastSubstantiveOutputAt: Date.now() - 500,
			}),
		};

		await act(async () => {
			root.render(<HookHarness board={currentBoard} setBoard={setBoard} initialSessions={activeSessions} />);
		});

		const validationCards = currentBoard.columns.find((column) => column.id === "validation")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(validationCards).toEqual([]);
		expect(inProgressCards.map((card) => card.id)).toEqual(["task-active"]);
	});

	// 核心 bug 回归：Claude TUI spinner 每秒重绘把 lastOutputAt 刷得恒新鲜，但无新实质内容时
	// lastSubstantiveOutputAt 保持陈旧——卡片必须留在 Validation，不被打回 In Progress。
	it("keeps a spinner-only running task (fresh lastOutputAt, stale lastSubstantiveOutputAt) in Validation", async () => {
		let currentBoard = createBoardWithValidationTask("task-spinner");

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		// spinner 重绘：lastOutputAt 极新鲜，但实质戳早已陈旧（>5s）→ 视为「不在产出」。
		const spinnerSessions = {
			"task-spinner": createRunningSession("task-spinner", {
				lastOutputAt: Date.now(),
				lastSubstantiveOutputAt: Date.now() - 60_000,
			}),
		};

		await act(async () => {
			root.render(<HookHarness board={currentBoard} setBoard={setBoard} initialSessions={spinnerSessions} />);
		});

		const validationCards = currentBoard.columns.find((column) => column.id === "validation")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(validationCards.map((card) => card.id)).toEqual(["task-spinner"]);
		expect(inProgressCards).toEqual([]);
	});

	// Change 1 回归：Review 列补装与 Validation 同款活跃度 offset。空闲 / 卡死的 agent 回合卡（陈旧
	// lastSubstantiveOutputAt）此前被裸 turnOwner==="agent" 反复打回 In Progress——这正是当年加 manual_review
	// 永久锁的动因；补 offset 后它们留在 Review，仅真在产出时才打回。镜像上方两个 Validation 用例。
	it("keeps an idle (output-quiet) agent-turn task in Review instead of bouncing it", async () => {
		let currentBoard = createBoardWithTaskInColumn("task-idle-review", "review");
		mockUnavailableProgrammaticCardMoves();

		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		// lastSubstantiveOutputAt well beyond the 5s quiet threshold → idle agent turn (no fresh substance).
		const idleSessions = {
			"task-idle-review": createRunningSession("task-idle-review", {
				lastOutputAt: Date.now() - 60_000,
				lastSubstantiveOutputAt: Date.now() - 60_000,
			}),
		};

		await act(async () => {
			root.render(<HookHarness board={currentBoard} setBoard={setBoard} initialSessions={idleSessions} />);
		});

		const reviewCards = currentBoard.columns.find((column) => column.id === "review")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(reviewCards.map((card) => card.id)).toEqual(["task-idle-review"]);
		expect(inProgressCards).toEqual([]);
	});

	it("bounces an actively-producing agent-turn task out of Review back to In Progress", async () => {
		let currentBoard = createBoardWithTaskInColumn("task-active-review", "review");
		mockUnavailableProgrammaticCardMoves();

		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		});
		// lastSubstantiveOutputAt within the 5s quiet threshold → actively producing substantive output.
		const activeSessions = {
			"task-active-review": createRunningSession("task-active-review", {
				lastOutputAt: Date.now() - 500,
				lastSubstantiveOutputAt: Date.now() - 500,
			}),
		};

		await act(async () => {
			root.render(<HookHarness board={currentBoard} setBoard={setBoard} initialSessions={activeSessions} />);
		});

		const reviewCards = currentBoard.columns.find((column) => column.id === "review")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(reviewCards).toEqual([]);
		expect(inProgressCards.map((card) => card.id)).toEqual(["task-active-review"]);
	});

	it("confirms before moving a review card to Done but moves a validation card directly", async () => {
		const requestMoveTaskToTrashWithAnimation = vi.fn(async () => {});

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation,
			programmaticCardMoveCycle: 0,
		});

		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [createTask("task-review", "Review task", 1)] },
				{ id: "validation", title: "Validation", cards: [createTask("task-val", "Validation task", 2)] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};

		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={vi.fn()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const requireSnapshot = (): HookSnapshot => {
			if (!latestSnapshot) {
				throw new Error("Expected a hook snapshot.");
			}
			return latestSnapshot;
		};

		// Review → Done opens the confirmation instead of moving immediately.
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash("task-review");
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(true);
		expect(requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();

		// Confirming runs the actual move with the review source column.
		await act(async () => {
			requireSnapshot().confirmMoveToDone();
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-review", "review", {
			boardMutationInitiator: "web_ui_user_gesture",
		});

		requestMoveTaskToTrashWithAnimation.mockClear();

		// Validation → Done is the normal completion path: no confirmation, moves directly.
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash("task-val");
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-val", "validation", {
			boardMutationInitiator: "web_ui_user_gesture",
		});
	});

	// Stage 3 ④：列自动流转的 state 读已翻为 facet 权威（resolveSessionFacets + isAwaitingUserReviewTurn /
	// turnOwner==="agent" / liveness==="interrupted"）。下面钉住「行为保持 + facet 采信 + exited 折叠不偷渡
	// distinction ②」。
	describe("facet 驱动的列自动流转（Stage 3 ④）", () => {
		const renderWithSessions = async (
			board: BoardData,
			setBoard: Dispatch<SetStateAction<BoardData>>,
			sessions: Record<string, RuntimeTaskSessionSummary>,
		): Promise<void> => {
			mockUnavailableProgrammaticCardMoves();
			await act(async () => {
				root.render(<HookHarness board={board} setBoard={setBoard} initialSessions={sessions} />);
			});
		};
		const cardIdsIn = (board: BoardData, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);

		it("已有 live session 的 Backlog 卡自动归位 In Progress", async () => {
			let currentBoard = createBoardWithTaskInColumn("task-live", "backlog");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			await renderWithSessions(currentBoard, setBoard, {
				"task-live": createRunningSession("task-live"),
			});
			expect(cardIdsIn(currentBoard, "backlog")).toEqual([]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual(["task-live"]);
		});

		it("awaiting_review 会话从 In Progress 自动落位 Review（等价旧 state==='awaiting_review'）", async () => {
			let currentBoard = createBoardWithTaskInColumn("task-ar", "in_progress");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			await renderWithSessions(currentBoard, setBoard, {
				"task-ar": createRunningSession("task-ar", { state: "awaiting_review", reviewReason: "exit" }),
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-ar"]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual([]);
		});

		it("user+exited 会话照旧自动落位 Review（exited 折叠进等人审回合，不偷渡 distinction ②）", async () => {
			let currentBoard = createBoardWithTaskInColumn("task-exited", "in_progress");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			await renderWithSessions(currentBoard, setBoard, {
				"task-exited": createRunningSession("task-exited", {
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					pid: null,
				}),
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-exited"]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual([]);
		});

		it("显式 facet 被采信优先于背离的 legacy state：state='running' 但 facet=user/exited → 落位 Review", async () => {
			let currentBoard = createBoardWithTaskInColumn("task-div", "in_progress");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			// 旧代码读 legacy state==='running' 不会把它移出 In Progress；新代码读 facet（user 回合）→ 移入 Review。
			await renderWithSessions(currentBoard, setBoard, {
				"task-div": createRunningSession("task-div", {
					state: "running",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
				}),
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-div"]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual([]);
		});

		it("interrupted 会话从 In Progress 自动移入 Done（trash）（等价旧 state==='interrupted'）", async () => {
			let currentBoard = createBoardWithTaskInColumn("task-int", "in_progress");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			await renderWithSessions(currentBoard, setBoard, {
				"task-int": createRunningSession("task-int", {
					state: "interrupted",
					reviewReason: "interrupted",
					pid: null,
				}),
			});
			expect(cardIdsIn(currentBoard, "trash")).toEqual(["task-int"]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual([]);
		});
	});

	// B5：Rule A 自动流转的 summary 引用短路。summary 引用跨 tick 稳定（runtime-state-hub merge
	// 只替换改动 key），未变引用且 board 未变的 summary 必须整体跳过——连 getTaskColumnId 全板
	// 扫描都不发生；被阻塞 / 动画接管的程序性移列不得被记录为已见，保留下一 tick 的重试；
	// board 发生外部写入（用户拖拽）时必须放开全量重估，保短路前的 level-triggered 语义。
	// 注意：mount 后 resetBoardInteractionsState（currentProjectId effect）会清空前帧记录，
	// 所以每个用例先跑一帧「暖帧」重建 previous 帧，再在下一帧断言短路行为。
	describe("Rule A 引用短路（B5）", () => {
		const cardIdsIn = (board: BoardData, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);

		interface SessionsControl {
			setSessions: Dispatch<SetStateAction<Record<string, RuntimeTaskSessionSummary>>>;
		}

		const renderHarness = async (
			board: BoardData,
			setBoard: Dispatch<SetStateAction<BoardData>>,
			sessions: Record<string, RuntimeTaskSessionSummary>,
			captureControl: (control: SessionsControl) => void,
		): Promise<void> => {
			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						setBoard={setBoard}
						initialSessions={sessions}
						onSessionsControl={captureControl}
					/>,
				);
			});
		};

		it("未变引用的 summary 不触发任何移列/状态写入（连 getTaskColumnId 扫描都跳过）", async () => {
			mockUnavailableProgrammaticCardMoves();
			let currentBoard = createBoardWithReviewTaskIds([], {
				in_progress: [createTask("task-stay", "Stay task", 1), createTask("task-mover", "Mover task", 2)],
			});
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			let sessionsControl: SessionsControl | null = null;
			// 两个会话都空闲（实质戳远超 5s 静默阈值）：处理它们是纯 no-op，初始帧后板面稳定。
			const staleOutputAt = Date.now() - 60_000;
			const staySummary = createRunningSession("task-stay", {
				lastOutputAt: staleOutputAt,
				lastSubstantiveOutputAt: staleOutputAt,
			});
			await renderHarness(
				currentBoard,
				setBoard,
				{
					"task-stay": staySummary,
					"task-mover": createRunningSession("task-mover", {
						lastOutputAt: staleOutputAt,
						lastSubstantiveOutputAt: staleOutputAt,
					}),
				},
				(control) => {
					sessionsControl = control;
				},
			);
			// 暖帧（兼验证 effect 正常工作）：task-stay 保持同一引用（merge 只替换改动 key 的
			// 跨 tick 稳定性）；task-mover 换新引用翻成等人审回合，驱动 Rule A 落位 Review。
			await act(async () => {
				sessionsControl?.setSessions((current) => {
					const moverSummary = current["task-mover"];
					if (!moverSummary || current["task-stay"] !== staySummary) {
						return current;
					}
					return {
						"task-stay": staySummary,
						"task-mover": {
							...moverSummary,
							state: "awaiting_review",
							turnOwner: "user",
							liveness: "live",
							userTurnKind: "review",
							reviewReason: "exit",
							updatedAt: moverSummary.updatedAt + 1,
						},
					};
				});
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-mover"]);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual(["task-stay"]);

			// 被断言帧：新 sessions 容器、全部 summary 同一引用、board 未变（等价一次无变化心跳）。
			const boardBeforeTick = currentBoard;
			getTaskColumnIdSpy.mockClear();
			await act(async () => {
				sessionsControl?.setSessions((current) => ({ ...current }));
			});

			// 两条 summary 都被整体跳过：没有任何 getTaskColumnId 扫描，也没有任何板面写入。
			expect(getTaskColumnIdSpy).not.toHaveBeenCalled();
			expect(currentBoard).toBe(boardBeforeTick);
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual(["task-stay"]);
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-mover"]);
		});

		it("程序性移列被 blocked 的 task 不记录为已见，下一 tick 用同一引用照常重试", async () => {
			const tryProgrammaticCardMoveMock = vi.fn(() => "blocked" as const);
			useProgrammaticCardMovesMock.mockReturnValue({
				handleProgrammaticCardMoveReady: () => {},
				setRequestMoveTaskToTrashHandler: () => {},
				tryProgrammaticCardMove: tryProgrammaticCardMoveMock,
				consumeProgrammaticCardMove: () => ({}),
				resolvePendingProgrammaticTrashMove: () => {},
				waitForProgrammaticCardMoveAvailability: async () => {},
				resetProgrammaticCardMoves: () => {},
				requestMoveTaskToTrashWithAnimation: async () => {},
				programmaticCardMoveCycle: 0,
			});
			let currentBoard = createBoardWithTaskInColumn("task-blocked", "review");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			let sessionsControl: SessionsControl | null = null;
			// Review 列 + 活跃产出的 agent 回合：每帧处理都会尝试打回 In Progress。
			const blockedSummary = createRunningSession("task-blocked", {
				lastOutputAt: Date.now(),
				lastSubstantiveOutputAt: Date.now(),
			});
			await renderHarness(currentBoard, setBoard, { "task-blocked": blockedSummary }, (control) => {
				sessionsControl = control;
			});

			// 暖帧：尝试打回被 blocked，板面不动；该 task 不得被记录为已见。
			await act(async () => {
				sessionsControl?.setSessions((current) => ({ ...current }));
			});
			expect(tryProgrammaticCardMoveMock).toHaveBeenCalledWith("task-blocked", "review", "in_progress", {
				skipKickoff: true,
				boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-blocked"]);

			// 被断言帧：同一 summary 引用、board 未变。若 blocked 时被错误记录为已见，
			// 引用短路会把这帧的重试吃掉（tryProgrammaticCardMove 不再被调用）。
			tryProgrammaticCardMoveMock.mockClear();
			await act(async () => {
				sessionsControl?.setSessions((current) => ({ ...current }));
			});
			expect(tryProgrammaticCardMoveMock).toHaveBeenCalledWith("task-blocked", "review", "in_progress", {
				skipKickoff: true,
				boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-blocked"]);
		});

		it("board 被外部写入（用户拖拽）后，未变引用的 summary 仍被全量重估", async () => {
			mockUnavailableProgrammaticCardMoves();
			let currentBoard = createBoardWithTaskInColumn("task-drag", "review");
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			let sessionsControl: SessionsControl | null = null;
			// 已退出进程的等人审会话：处理它是纯 no-op，初始帧后稳定停在 Review。
			const dragSummary = createRunningSession("task-drag", {
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				pid: null,
			});
			await renderHarness(currentBoard, setBoard, { "task-drag": dragSummary }, (control) => {
				sessionsControl = control;
			});
			// 暖帧：建立 previous 帧（summary 引用 + board 引用），此后才谈得上引用短路。
			await act(async () => {
				sessionsControl?.setSessions((current) => ({ ...current }));
			});
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-drag"]);

			// 模拟用户拖拽：不经 sessions 变化，直接把卡从 Review 拖回 In Progress。
			await act(async () => {
				setBoard((current) => moveTaskToColumn(current, "task-drag", "in_progress", { insertAtTop: true }).board);
			});
			// 没有 sessions tick 时 effect 不触发，卡停在 In Progress。
			expect(cardIdsIn(currentBoard, "in_progress")).toEqual(["task-drag"]);

			getTaskColumnIdSpy.mockClear();
			await act(async () => {
				sessionsControl?.setSessions((current) => ({ ...current }));
			});

			// board 已变 → 引用短路放开 → awaiting_review 卡被自动拉回 Review（保短路前语义）。
			expect(cardIdsIn(currentBoard, "review")).toEqual(["task-drag"]);
			const scannedTaskIds = getTaskColumnIdSpy.mock.calls.map(([, taskId]) => taskId);
			expect(scannedTaskIds).toContain("task-drag");
		});
	});

	// 手动「移至 Review」按钮：把停在 agent 回合（卡死/空闲）的终端 agent 任务翻入「等人审查」回合，
	// 由 Rule A 自动落位 Review（复用任务自然完成的同一落位流程），不手动挪列。
	describe("handleMoveCardToReview（手动「移至 Review」按钮）", () => {
		const cardIdsIn = (board: BoardData | null, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board?.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);

		it("in_progress 终端 agent 卡点击 → 发「交还回合并移到 Review」命令，浏览器只叠 overlay", async () => {
			mockUnavailableProgrammaticCardMoves();
			let latestSnapshot: HookSnapshot | null = null;
			let latestBoard: BoardData | null = null;

			function StatefulHarness(): ReactElement {
				const [board, setBoard] = useState(() => createBoardWithTaskInColumn("task-mr", "in_progress"));
				useEffect(() => {
					latestBoard = board;
				}, [board]);
				return (
					<HookHarness
						board={board}
						setBoard={setBoard}
						initialSessions={{ "task-mr": createRunningSession("task-mr") }}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>
				);
			}

			await act(async () => {
				root.render(<StatefulHarness />);
			});

			await act(async () => {
				latestSnapshot?.handleMoveCardToReview("task-mr");
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(taskCardActionQueryMocks.moveTaskCardIntoReviewByHandingTurnToUserInWorkspace).toHaveBeenCalledWith(
				"project-1",
				{ taskId: "task-mr", boardMutationInitiator: "web_ui_user_gesture" },
			);
			// 服务端翻回合后显式移列；会被保存的 board 由广播回灌更新，这里仍在原列，显示层由 overlay 承担。
			expect(cardIdsIn(latestBoard, "in_progress")).toEqual(["task-mr"]);
			expect(readPendingTaskCardCommandBoardOverlayEntries("project-1")).toEqual([
				expect.objectContaining({
					taskId: "task-mr",
					expectedBoardEffect: {
						pendingTaskCardCommandExpectedBoardEffectKind: "task_card_moved_into_board_column",
						targetBoardColumnId: "review",
					},
				}),
			]);
		});

		it("翻回合失败 → 弹 warning toast，overlay 撤掉、卡片留在 In Progress", async () => {
			mockUnavailableProgrammaticCardMoves();
			let latestSnapshot: HookSnapshot | null = null;
			taskCardActionQueryMocks.moveTaskCardIntoReviewByHandingTurnToUserInWorkspace.mockResolvedValueOnce({
				agentTurnHandoffToUserOutcome: "agent_turn_handoff_to_user_failed",
				agentTurnHandoffToUserFailureMessage: "not a terminal agent",
				taskCardWasMovedIntoReviewColumnByThisAction: false,
				taskCardSnapshotAfterAction: makeTaskCardSnapshotAfterAction("task-fail", "in_progress"),
			});

			await act(async () => {
				root.render(
					<HookHarness
						board={createBoardWithTaskInColumn("task-fail", "in_progress")}
						setBoard={vi.fn()}
						initialSessions={{ "task-fail": createRunningSession("task-fail") }}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});

			await act(async () => {
				(latestSnapshot as HookSnapshot | null)?.handleMoveCardToReview("task-fail");
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "warning" }));
			expect(readPendingTaskCardCommandBoardOverlayEntries("project-1")).toEqual([]);
		});

		it("非 in_progress 卡 → 守卫拦截，不发命令", async () => {
			mockUnavailableProgrammaticCardMoves();
			let latestSnapshot: HookSnapshot | null = null;
			const transition = taskCardActionQueryMocks.moveTaskCardIntoReviewByHandingTurnToUserInWorkspace;

			function StatefulHarness(): ReactElement {
				const [board, setBoard] = useState(() => createBoardWithTaskInColumn("task-rv", "review"));
				return (
					<HookHarness
						board={board}
						setBoard={setBoard}
						initialSessions={{
							"task-rv": createRunningSession("task-rv", {
								state: "awaiting_review",
								turnOwner: "user",
								liveness: "live",
								userTurnKind: "review",
								reviewReason: "hook",
							}),
						}}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>
				);
			}

			await act(async () => {
				root.render(<StatefulHarness />);
			});

			await act(async () => {
				latestSnapshot?.handleMoveCardToReview("task-rv");
				await Promise.resolve();
			});

			expect(transition).not.toHaveBeenCalled();
		});
	});

	// dd2db Y-EVENT-8：每个改 board 的入口按语义登记发起方，saveState 再据此出逐卡逐变更标注。
	describe("saveState 发起方登记（Y-EVENT-8）", () => {
		const cardIdsIn = (board: BoardData, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);
		const readColumnPlacementInitiator = (taskId: string) =>
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect(taskId, "task_card_column_placement");

		beforeEach(() => {
			discardAllPendingWebUiBoardMutationInitiatorRecords();
		});

		afterEach(() => {
			discardAllPendingWebUiBoardMutationInitiatorRecords();
		});

		async function renderTrackingBoard(
			initialBoard: BoardData,
			options: { initialSessions?: Record<string, RuntimeTaskSessionSummary> } = {},
		): Promise<{ readBoard: () => BoardData; readSnapshot: () => HookSnapshot }> {
			let currentBoard = initialBoard;
			let latestSnapshot: HookSnapshot | null = null;
			const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
				currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
			});
			await act(async () => {
				root.render(
					<HookHarness
						board={currentBoard}
						setBoard={setBoard}
						initialSessions={options.initialSessions}
						onSnapshot={(snapshot) => {
							latestSnapshot = snapshot;
						}}
					/>,
				);
			});
			return {
				readBoard: () => currentBoard,
				readSnapshot: () => {
					if (!latestSnapshot) {
						throw new Error("Expected a hook snapshot.");
					}
					return latestSnapshot;
				},
			};
		}

		function createCrossColumnDrop(
			taskId: string,
			fromColumnId: BoardColumnId,
			toColumnId: BoardColumnId,
		): DropResult {
			return {
				draggableId: taskId,
				type: "CARD",
				source: { droppableId: fromColumnId, index: 0 },
				destination: { droppableId: toColumnId, index: 0 },
				reason: "DROP",
				mode: "FLUID",
				combine: null,
			};
		}

		// 跨列的用户手势走 taskCardAction：发起方随命令交给服务端（账本在服务端记），不再进 saveState 的待配登记。
		it("sends a real drag (no programmatic move in flight) to the runtime as a user gesture", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-drag", "in_progress"));

			await act(async () => {
				harness.readSnapshot().handleDragEnd(createCrossColumnDrop("task-drag", "in_progress", "validation"));
			});

			expect(
				taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
			).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({ taskId: "task-drag", boardMutationInitiator: "web_ui_user_gesture" }),
			);
			expect(cardIdsIn(harness.readBoard(), "in_progress")).toEqual(["task-drag"]);
			expect(readColumnPlacementInitiator("task-drag")).toBeUndefined();
		});

		it("records a programmatic (animated) move with the initiator carried by its behavior when it lands", async () => {
			const programmaticCardMoveInFlight: ProgrammaticCardMoveInFlight = {
				taskId: "task-anim",
				fromColumnId: "in_progress",
				toColumnId: "review",
				insertAtTop: true,
			};
			useProgrammaticCardMovesMock.mockReturnValue({
				handleProgrammaticCardMoveReady: () => {},
				setRequestMoveTaskToTrashHandler: () => {},
				tryProgrammaticCardMove: () => "unavailable",
				consumeProgrammaticCardMove: () => ({
					behavior: {
						boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
					},
					programmaticCardMoveInFlight,
				}),
				resolvePendingProgrammaticTrashMove: () => {},
				waitForProgrammaticCardMoveAvailability: async () => {},
				resetProgrammaticCardMoves: () => {},
				requestMoveTaskToTrashWithAnimation: async () => {},
				programmaticCardMoveCycle: 0,
			});
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-anim", "in_progress"));

			await act(async () => {
				harness.readSnapshot().handleDragEnd(createCrossColumnDrop("task-anim", "in_progress", "review"));
			});

			expect(cardIdsIn(harness.readBoard(), "review")).toEqual(["task-anim"]);
			expect(readColumnPlacementInitiator("task-anim")).toBe(
				"web_ui_client_automation_session_facet_driven_column_autoflow",
			);
		});

		it("records a programmatic move whose entry point carried no initiator as explicitly unknown (null)", async () => {
			useProgrammaticCardMovesMock.mockReturnValue({
				handleProgrammaticCardMoveReady: () => {},
				setRequestMoveTaskToTrashHandler: () => {},
				tryProgrammaticCardMove: () => "unavailable",
				consumeProgrammaticCardMove: () => ({
					programmaticCardMoveInFlight: {
						taskId: "task-anon",
						fromColumnId: "in_progress",
						toColumnId: "review",
						insertAtTop: true,
					},
				}),
				resolvePendingProgrammaticTrashMove: () => {},
				waitForProgrammaticCardMoveAvailability: async () => {},
				resetProgrammaticCardMoves: () => {},
				requestMoveTaskToTrashWithAnimation: async () => {},
				programmaticCardMoveCycle: 0,
			});
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-anon", "in_progress"));

			await act(async () => {
				harness.readSnapshot().handleDragEnd(createCrossColumnDrop("task-anon", "in_progress", "review"));
			});

			expect(readColumnPlacementInitiator("task-anon")).toBeNull();
		});

		it("tags facet-driven autoflow moves (direct path) as session-facet-driven column autoflow", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-ar", "in_progress"), {
				initialSessions: {
					"task-ar": createRunningSession("task-ar", { state: "awaiting_review", reviewReason: "exit" }),
				},
			});

			expect(cardIdsIn(harness.readBoard(), "review")).toEqual(["task-ar"]);
			expect(readColumnPlacementInitiator("task-ar")).toBe(
				"web_ui_client_automation_session_facet_driven_column_autoflow",
			);
		});

		it("tags the session-started backlog → in progress autoflow as session-facet-driven column autoflow", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-live", "backlog"), {
				initialSessions: { "task-live": createRunningSession("task-live") },
			});

			expect(cardIdsIn(harness.readBoard(), "in_progress")).toEqual(["task-live"]);
			expect(readColumnPlacementInitiator("task-live")).toBe(
				"web_ui_client_automation_session_facet_driven_column_autoflow",
			);
		});

		it("tags the interrupted-session autoflow into Done with its own initiator", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-int", "in_progress"), {
				initialSessions: {
					"task-int": createRunningSession("task-int", {
						state: "interrupted",
						reviewReason: "interrupted",
						pid: null,
					}),
				},
			});

			expect(cardIdsIn(harness.readBoard(), "trash")).toEqual(["task-int"]);
			expect(readColumnPlacementInitiator("task-int")).toBe(
				"web_ui_client_automation_interrupted_session_autoflow_into_done_column",
			);
		});

		it("passes the matching initiator into every animated autoflow attempt", async () => {
			const tryProgrammaticCardMove = vi.fn(() => "started" as const);
			useProgrammaticCardMovesMock.mockReturnValue({
				handleProgrammaticCardMoveReady: () => {},
				setRequestMoveTaskToTrashHandler: () => {},
				tryProgrammaticCardMove,
				consumeProgrammaticCardMove: () => ({}),
				resolvePendingProgrammaticTrashMove: () => {},
				waitForProgrammaticCardMoveAvailability: async () => {},
				resetProgrammaticCardMoves: () => {},
				requestMoveTaskToTrashWithAnimation: async () => {},
				programmaticCardMoveCycle: 0,
			});
			await renderTrackingBoard(
				createBoardWithReviewTaskIds([], {
					in_progress: [createTask("task-to-review", "To review", 1), createTask("task-interrupted", "Gone", 2)],
				}),
				{
					initialSessions: {
						"task-to-review": createRunningSession("task-to-review", {
							state: "awaiting_review",
							reviewReason: "exit",
						}),
						"task-interrupted": createRunningSession("task-interrupted", {
							state: "interrupted",
							reviewReason: "interrupted",
							pid: null,
						}),
					},
				},
			);

			expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-to-review", "in_progress", "review", {
				boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
			});
			expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-interrupted", "in_progress", "trash", {
				skipTrashWorkflow: true,
				boardMutationInitiator: "web_ui_client_automation_interrupted_session_autoflow_into_done_column",
			});
		});

		it("tags the Post-Deploy Verification completion move into Done with the panel-completion initiator", async () => {
			const requestMoveTaskToTrashWithAnimation = vi.fn(async () => {});
			useProgrammaticCardMovesMock.mockReturnValue({
				handleProgrammaticCardMoveReady: () => {},
				setRequestMoveTaskToTrashHandler: () => {},
				tryProgrammaticCardMove: () => "unavailable",
				consumeProgrammaticCardMove: () => ({}),
				resolvePendingProgrammaticTrashMove: () => {},
				waitForProgrammaticCardMoveAvailability: async () => {},
				resetProgrammaticCardMoves: () => {},
				requestMoveTaskToTrashWithAnimation,
				programmaticCardMoveCycle: 0,
			});
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-pdv", "validation"));

			let completion: { ok: boolean } | null = null;
			await act(async () => {
				completion = await harness
					.readSnapshot()
					.completePostDeployVerificationMoveToDone("task-pdv", "validation");
			});

			expect(completion).toEqual({ ok: true });
			expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-pdv", "validation", {
				boardMutationInitiator: "web_ui_user_gesture_post_deploy_verification_panel_completion",
			});
		});

		it("sends restore-from-Done and move-to-Validation buttons to the runtime as user gestures", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(
				createBoardWithReviewTaskIds(["task-review"], { trash: [createTask("task-done", "Done task", 5)] }),
			);

			await act(async () => {
				harness.readSnapshot().handleRestoreTaskFromTrash("task-done");
			});
			await act(async () => {
				harness.readSnapshot().handleMoveCardToValidation("task-review");
			});

			expect(
				taskCardActionQueryMocks.restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace,
			).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({ taskId: "task-done", boardMutationInitiator: "web_ui_user_gesture" }),
			);
			expect(
				taskCardActionQueryMocks.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace,
			).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({ taskId: "task-review", boardMutationInitiator: "web_ui_user_gesture" }),
			);
		});

		it("sends deleting a card to the runtime as a user gesture", async () => {
			mockUnavailableProgrammaticCardMoves();
			const harness = await renderTrackingBoard(createBoardWithTaskInColumn("task-delete", "backlog"));

			await act(async () => {
				harness.readSnapshot().handleOpenDeleteTask("task-delete");
			});
			await act(async () => {
				harness.readSnapshot().handleConfirmDeleteTask();
			});

			expect(
				taskCardActionQueryMocks.permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace,
			).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({ boardMutationInitiator: "web_ui_user_gesture" }),
			);
			expect(
				readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-delete", "task_card_permanent_removal"),
			).toBeUndefined();
		});
	});
});
