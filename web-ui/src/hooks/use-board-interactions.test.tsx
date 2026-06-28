import { act, type Dispatch, type ReactElement, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardInteractions } from "@/hooks/use-board-interactions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const useLinkedBacklogTaskActionsMock = vi.hoisted(() => vi.fn());
const useProgrammaticCardMovesMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

vi.mock("@/hooks/use-linked-backlog-task-actions", () => ({
	useLinkedBacklogTaskActions: useLinkedBacklogTaskActionsMock,
}));

vi.mock("@/hooks/use-programmatic-card-moves", () => ({
	useProgrammaticCardMoves: useProgrammaticCardMovesMock,
}));

vi.mock("@/hooks/use-review-auto-actions", () => ({
	useReviewAutoActions: () => ({}) as ReturnType<typeof useBoardInteractions>,
}));

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
		dependencies: [],
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
		dependencies: [],
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
	return { columns, dependencies: [] };
}

const NOOP_STOP_SESSION = async (): Promise<void> => {};
const NOOP_CLEANUP_WORKSPACE = async (): Promise<null> => null;
const NOOP_FETCH_WORKSPACE_INFO = async (): Promise<null> => null;
const NOOP_SEND_TASK_INPUT = async (): Promise<{ ok: boolean }> => ({ ok: true });
const NOOP_RUN_AUTO_REVIEW = async (): Promise<boolean> => false;

// The level-triggered column-mapping effect only needs "unavailable" programmatic moves (so it falls
// through to the direct moveTaskToColumn path) plus no-op linked-backlog actions. Shared by the
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

function mockNoopLinkedBacklogTaskActions(): void {
	useLinkedBacklogTaskActionsMock.mockReturnValue({
		handleCreateDependency: () => {},
		handleDeleteDependency: () => {},
		confirmMoveTaskToTrash: async () => {},
		requestMoveTaskToTrash: async () => {},
	});
}

interface HookSnapshot {
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleOpenDeleteTask: (taskId: string) => void;
	handleConfirmDeleteTask: () => void;
	deleteTaskTarget: BoardCard | null;
	handleStartTask: (taskId: string) => void;
	handleCardSelect: (taskId: string) => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	isMoveToDoneConfirmOpen: boolean;
	confirmMoveToDone: () => void;
	cancelMoveToDone: () => void;
	handleMoveCardToReview: (taskId: string) => void;
	moveToReviewLoadingById: Record<string, boolean>;
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
	ensureTaskWorkspace,
	startTaskSession,
	selectedCard = null,
	selectedTaskId = null,
	setSelectedTaskIdOverride,
	stopTaskSession = NOOP_STOP_SESSION,
	transitionTaskToReview: transitionTaskToReviewProp,
	cleanupTaskWorkspace = NOOP_CLEANUP_WORKSPACE,
	initialSessions,
	onSnapshot,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	selectedCard?: { card: BoardCard; column: { id: "backlog" | "in_progress" | "review" | "trash" } } | null;
	selectedTaskId?: string | null;
	setSelectedTaskIdOverride?: Dispatch<SetStateAction<string | null>>;
	stopTaskSession?: (taskId: string) => Promise<void>;
	transitionTaskToReview?: (taskId: string) => Promise<boolean>;
	cleanupTaskWorkspace?: UseTaskSessionsResult["cleanupTaskWorkspace"];
	initialSessions?: Record<string, RuntimeTaskSessionSummary>;
	onSnapshot?: (snapshot: HookSnapshot) => void;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>(initialSessions ?? {});
	// 默认实现模拟真实链路：transitionTaskToReview 成功后 use-task-sessions 会 upsert 携 turnOwner=user 的
	// summary（见生产实现），这里直接把 in-memory session 翻成 awaiting_review/user，驱动 Rule A 落位 Review。
	const transitionTaskToReview =
		transitionTaskToReviewProp ??
		(async (taskId: string): Promise<boolean> => {
			setSessions((current) => {
				const existing = current[taskId];
				if (!existing) {
					return current;
				}
				return {
					...current,
					[taskId]: {
						...existing,
						state: "awaiting_review",
						turnOwner: "user",
						liveness: "live",
						userTurnKind: "review",
						reviewReason: "manual_review",
						updatedAt: existing.updatedAt + 1,
					},
				};
			});
			return true;
		});
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
		stopTaskSession,
		transitionTaskToReview,
		cleanupTaskWorkspace,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo: NOOP_FETCH_WORKSPACE_INFO,
		sendTaskSessionInput: NOOP_SEND_TASK_INPUT,
		readyForReviewNotificationsEnabled: false,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction: NOOP_RUN_AUTO_REVIEW,
	});

	useEffect(() => {
		onSnapshot?.({
			handleRestoreTaskFromTrash: actions.handleRestoreTaskFromTrash,
			handleOpenDeleteTask: actions.handleOpenDeleteTask,
			handleConfirmDeleteTask: actions.handleConfirmDeleteTask,
			deleteTaskTarget: actions.deleteTaskTarget,
			handleStartTask: actions.handleStartTask,
			handleCardSelect: actions.handleCardSelect,
			handleMoveReviewCardToTrash: actions.handleMoveReviewCardToTrash,
			isMoveToDoneConfirmOpen: actions.isMoveToDoneConfirmOpen,
			confirmMoveToDone: actions.confirmMoveToDone,
			cancelMoveToDone: actions.cancelMoveToDone,
			handleMoveCardToReview: actions.handleMoveCardToReview,
			moveToReviewLoadingById: actions.moveToReviewLoadingById,
		});
	}, [
		actions.deleteTaskTarget,
		actions.handleCardSelect,
		actions.handleConfirmDeleteTask,
		actions.handleOpenDeleteTask,
		actions.handleRestoreTaskFromTrash,
		actions.handleStartTask,
		actions.handleMoveReviewCardToTrash,
		actions.isMoveToDoneConfirmOpen,
		actions.confirmMoveToDone,
		actions.cancelMoveToDone,
		actions.handleMoveCardToReview,
		actions.moveToReviewLoadingById,
		onSnapshot,
	]);

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
		useLinkedBacklogTaskActionsMock.mockReset();
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

	it("starts dependency-unblocked tasks even when setBoard updater is deferred", async () => {
		let startBacklogTaskWithAnimation: ((task: BoardCard) => Promise<boolean>) | null = null;

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

		useLinkedBacklogTaskActionsMock.mockImplementation(
			(input: { startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean> }) => {
				startBacklogTaskWithAnimation = input.startBacklogTaskWithAnimation ?? null;
				return {
					handleCreateDependency: () => {},
					handleDeleteDependency: () => {},
					confirmMoveTaskToTrash: async () => {},
					requestMoveTaskToTrash: async () => {},
				};
			},
		);

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((_nextBoard) => {
			// Simulate React deferring state updater execution.
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
				/>,
			);
		});

		if (!startBacklogTaskWithAnimation) {
			throw new Error("Expected startBacklogTaskWithAnimation to be provided.");
		}

		const backlogTask = board.columns[0]?.cards[0];
		if (!backlogTask) {
			throw new Error("Expected a backlog task.");
		}

		let started = false;
		await act(async () => {
			started = await startBacklogTaskWithAnimation!(backlogTask);
		});

		expect(started).toBe(true);
		expect(ensureTaskWorkspace).toHaveBeenCalledWith(backlogTask);
		expect(startTaskSession).toHaveBeenCalledWith(backlogTask);
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const initialBoard = createBoard();
		initialBoard.columns[3] = {
			...initialBoard.columns[3]!,
			cards: [createTask("done-1", "Keep done", 10), createTask("done-2", "Keep me", 11)],
		};
		initialBoard.dependencies = [
			{
				id: "dep-1",
				fromTaskId: "task-1",
				toTaskId: "done-1",
				createdAt: 12,
			},
		];
		const stopTaskSession = vi.fn(async () => {});
		const cleanupTaskWorkspace = vi.fn(async () => null);
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/done-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		function StatefulHarness(): ReactElement {
			const [board, setBoard] = useState(initialBoard);
			useEffect(() => {
				latestBoard = board;
			}, [board]);
			return (
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					stopTaskSession={stopTaskSession}
					cleanupTaskWorkspace={cleanupTaskWorkspace}
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

		const doneCards = requireBoard().columns.find((column) => column.id === "trash")?.cards ?? [];
		expect(doneCards.map((card) => card.id)).toEqual(["done-1", "done-2"]);
		const backlogCards = requireBoard().columns.find((column) => column.id === "backlog")?.cards ?? [];
		expect(backlogCards).toEqual([]);
		expect(requireBoard().dependencies).toEqual([]);
		expect(stopTaskSession).toHaveBeenCalledWith("task-1");
		expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-1", undefined);
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>(() => {});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
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

		expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-1", "backlog", "in_progress");
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>(() => {});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
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
		expect(setBoard).toHaveBeenCalled();
		expect(startTaskSession).toHaveBeenCalledWith(board.columns[0]!.cards[0]!);
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((_nextBoard) => {
			// The optimistic move is not part of this assertion.
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-trash",
				baseRef: "main",
				baseCommit: "abc123",
				warning: "Saved task changes could not be reapplied automatically.",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
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
			// resumeTaskFromTrash is fire-and-forget (void), so flush enough
			// microtasks for ensureTaskWorkspace and startTaskSession to resolve.
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		// moveTaskToColumn updates updatedAt with Date.now(), so match fields except updatedAt.
		const expectedTask = expect.objectContaining({
			id: trashTask.id,
			prompt: trashTask.prompt,
			baseRef: trashTask.baseRef,
			createdAt: trashTask.createdAt,
		});
		expect(ensureTaskWorkspace).toHaveBeenCalledWith(expectedTask);
		expect(startTaskSession).toHaveBeenCalledWith(expectedTask, { resumeFromTrash: true });
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "warning",
			icon: "warning-sign",
			message: "Saved task changes could not be reapplied automatically.",
			timeout: 7000,
		});
	});

	it("preserves model fields when restoring a trashed task", async () => {
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask: BoardCard = {
			id: "task-trash-model",
			title: "Trash task with model title",
			prompt: "Trash task with model",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			agentId: "codex",
			clineSettings: {
				providerId: "my-provider",
				modelId: "my-model",
			},
			baseRef: "main",
			createdAt: 2,
			updatedAt: 2,
		};
		let currentBoard: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			if (typeof nextBoard === "function") {
				currentBoard = nextBoard(currentBoard);
			} else {
				currentBoard = nextBoard;
			}
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-trash-model",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
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
			latestSnapshot!.handleRestoreTaskFromTrash("task-trash-model");
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		// After restore, disableTaskAutoReview is called via setBoard updater.
		// Verify model fields survived the restore flow.
		const reviewCards = currentBoard.columns.find((col) => col.id === "review")?.cards ?? [];
		const restoredTask = reviewCards.find((card) => card.id === "task-trash-model");
		expect(restoredTask).toBeDefined();
		expect(restoredTask?.clineSettings).toEqual({
			providerId: "my-provider",
			modelId: "my-model",
		});
		expect(restoredTask?.agentId).toBe("codex");
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={() => board}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
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
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
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
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					initialSessions={idleSessions}
				/>,
			);
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
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
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
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					initialSessions={activeSessions}
				/>,
			);
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
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
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
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					initialSessions={spinnerSessions}
				/>,
			);
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
		mockNoopLinkedBacklogTaskActions();

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
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					initialSessions={idleSessions}
				/>,
			);
		});

		const reviewCards = currentBoard.columns.find((column) => column.id === "review")?.cards ?? [];
		const inProgressCards = currentBoard.columns.find((column) => column.id === "in_progress")?.cards ?? [];
		expect(reviewCards.map((card) => card.id)).toEqual(["task-idle-review"]);
		expect(inProgressCards).toEqual([]);
	});

	it("bounces an actively-producing agent-turn task out of Review back to In Progress", async () => {
		let currentBoard = createBoardWithTaskInColumn("task-active-review", "review");
		mockUnavailableProgrammaticCardMoves();
		mockNoopLinkedBacklogTaskActions();

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
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					initialSessions={activeSessions}
				/>,
			);
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

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [createTask("task-review", "Review task", 1)] },
				{ id: "validation", title: "Validation", cards: [createTask("task-val", "Validation task", 2)] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};

		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={vi.fn()}
					ensureTaskWorkspace={vi.fn(async () => ({
						ok: true as const,
						response: { ok: true as const, path: "/tmp/x", baseRef: "main", baseCommit: "abc" },
					}))}
					startTaskSession={vi.fn(async () => ({ ok: true as const }))}
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
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-review", "review");

		requestMoveTaskToTrashWithAnimation.mockClear();

		// Validation → Done is the normal completion path: no confirmation, moves directly.
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash("task-val");
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-val", "validation");
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
			mockNoopLinkedBacklogTaskActions();
			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						setBoard={setBoard}
						ensureTaskWorkspace={async () => ({ ok: true as const })}
						startTaskSession={async () => ({ ok: true as const })}
						initialSessions={sessions}
					/>,
				);
			});
		};
		const cardIdsIn = (board: BoardData, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);

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

	// 手动「移至 Review」按钮：把停在 agent 回合（卡死/空闲）的终端 agent 任务翻入「等人审查」回合，
	// 由 Rule A 自动落位 Review（复用任务自然完成的同一落位流程），不手动挪列。
	describe("handleMoveCardToReview（手动「移至 Review」按钮）", () => {
		const cardIdsIn = (board: BoardData | null, columnId: BoardData["columns"][number]["id"]): string[] =>
			(board?.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id);

		it("in_progress 终端 agent 卡点击 → 翻会话 awaiting_review/user → Rule A 自动落位 Review", async () => {
			mockUnavailableProgrammaticCardMoves();
			mockNoopLinkedBacklogTaskActions();
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
						ensureTaskWorkspace={async () => ({ ok: true as const })}
						startTaskSession={async () => ({ ok: true as const })}
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

			// 初始：running/agent 卡停在 In Progress（agent 回合，In Progress 不打回）。
			expect(cardIdsIn(latestBoard, "in_progress")).toEqual(["task-mr"]);
			expect(cardIdsIn(latestBoard, "review")).toEqual([]);

			await act(async () => {
				latestSnapshot?.handleMoveCardToReview("task-mr");
				// 冲洗 detached 异步（await 端点 → 默认实现翻 awaiting_review/user）+ 随后由 sessions 变更
				// 触发的 level-triggered effect（Rule A 落位 review）。
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(cardIdsIn(latestBoard, "review")).toEqual(["task-mr"]);
			expect(cardIdsIn(latestBoard, "in_progress")).toEqual([]);
		});

		it("transitionTaskToReview 失败 → 弹 warning toast 且卡片留在 In Progress", async () => {
			mockUnavailableProgrammaticCardMoves();
			mockNoopLinkedBacklogTaskActions();
			let latestSnapshot: HookSnapshot | null = null;
			let latestBoard: BoardData | null = null;
			const failingTransition = vi.fn(async () => false);

			function StatefulHarness(): ReactElement {
				const [board, setBoard] = useState(() => createBoardWithTaskInColumn("task-fail", "in_progress"));
				useEffect(() => {
					latestBoard = board;
				}, [board]);
				return (
					<HookHarness
						board={board}
						setBoard={setBoard}
						ensureTaskWorkspace={async () => ({ ok: true as const })}
						startTaskSession={async () => ({ ok: true as const })}
						transitionTaskToReview={failingTransition}
						initialSessions={{ "task-fail": createRunningSession("task-fail") }}
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
				latestSnapshot?.handleMoveCardToReview("task-fail");
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(failingTransition).toHaveBeenCalledWith("task-fail");
			expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "warning" }));
			expect(cardIdsIn(latestBoard, "in_progress")).toEqual(["task-fail"]);
			expect(cardIdsIn(latestBoard, "review")).toEqual([]);
		});

		it("非 in_progress 卡 → 守卫拦截，不调用端点", async () => {
			mockUnavailableProgrammaticCardMoves();
			mockNoopLinkedBacklogTaskActions();
			let latestSnapshot: HookSnapshot | null = null;
			const transition = vi.fn(async () => true);

			function StatefulHarness(): ReactElement {
				const [board, setBoard] = useState(() => createBoardWithTaskInColumn("task-rv", "review"));
				return (
					<HookHarness
						board={board}
						setBoard={setBoard}
						ensureTaskWorkspace={async () => ({ ok: true as const })}
						startTaskSession={async () => ({ ok: true as const })}
						transitionTaskToReview={transition}
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
});
