import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceBoardHydrationFromRuntime, WorkspaceBoardSavedByRuntime } from "@/hooks/use-workspace-sync";
import type { RuntimeWorkspaceStateResponse, RuntimeWorkspaceStateSaveRequest } from "@/runtime/types";
import { type UseWorkspacePersistenceResult, useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import { addTaskToColumnWithResult, moveTaskToColumn } from "@/state/board-state";
import {
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	readPendingWebUiBoardMutationInitiatorForTaskCardAspect,
	recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import type { BoardCard, BoardData } from "@/types";

const WORKSPACE_STATE_PERSIST_DEBOUNCE_WINDOW_MS_PLUS_MARGIN = 200;

function createTask(taskId: string): BoardCard {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoardWithTaskInProgress(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [createTask("task-1")] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function moveWithUserGestureRecorded(board: BoardData): BoardData {
	const moved = moveTaskToColumn(board, "task-1", "validation");
	if (!moved.moved) {
		throw new Error("Expected task-1 to move to validation.");
	}
	recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
		boardBeforeMutation: board,
		boardAfterMutation: moved.board,
		boardMutationInitiator: "web_ui_user_gesture",
	});
	return moved.board;
}

const EXPECTED_USER_MOVE_ANNOTATION = {
	taskId: "task-1",
	annotatedBoardMutationKind: "task_card_moved_between_non_trash_board_columns",
	fromColumnId: "in_progress",
	toColumnId: "validation",
	boardMutationInitiator: "web_ui_user_gesture",
};

type PersistWorkspaceState = (input: {
	workspaceId: string;
	payload: RuntimeWorkspaceStateSaveRequest;
}) => Promise<RuntimeWorkspaceStateResponse>;

type OnWorkspaceBoardSavedByRuntime = (input: WorkspaceBoardSavedByRuntime) => void;

interface PersistenceHarnessProps {
	board: BoardData;
	workspaceRevision: number;
	hydrationNonce: number;
	latestWorkspaceBoardHydrationFromRuntime?: WorkspaceBoardHydrationFromRuntime | null;
	persistWorkspaceState: PersistWorkspaceState;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceBoardSavedByRuntime: OnWorkspaceBoardSavedByRuntime;
	onPersistenceResult?: (result: UseWorkspacePersistenceResult) => void;
}

function PersistenceHarness(props: PersistenceHarnessProps): null {
	const result = useWorkspacePersistence({
		board: props.board,
		sessions: {},
		currentProjectId: "project-1",
		workspaceRevision: props.workspaceRevision,
		hydrationNonce: props.hydrationNonce,
		latestWorkspaceBoardHydrationFromRuntime: props.latestWorkspaceBoardHydrationFromRuntime ?? null,
		canPersistWorkspaceState: true,
		isDocumentVisible: true,
		isWorkspaceStateRefreshing: false,
		persistWorkspaceState: props.persistWorkspaceState,
		refetchWorkspaceState: props.refetchWorkspaceState,
		onWorkspaceBoardSavedByRuntime: props.onWorkspaceBoardSavedByRuntime,
	});
	props.onPersistenceResult?.(result);
	return null;
}

function savedRevision(revision: number): RuntimeWorkspaceStateResponse {
	return { revision } as RuntimeWorkspaceStateResponse;
}

describe("useWorkspacePersistence board mutation initiator annotations", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	const refetchWorkspaceState = vi.fn(async () => undefined);
	const onWorkspaceBoardSavedByRuntime = vi.fn<OnWorkspaceBoardSavedByRuntime>();

	beforeEach(() => {
		vi.useFakeTimers();
		discardAllPendingWebUiBoardMutationInitiatorRecords();
		refetchWorkspaceState.mockClear();
		onWorkspaceBoardSavedByRuntime.mockClear();
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
		container.remove();
		discardAllPendingWebUiBoardMutationInitiatorRecords();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	async function renderHarness(props: PersistenceHarnessProps): Promise<void> {
		await act(async () => {
			root.render(
				<PersistenceHarness
					{...props}
					refetchWorkspaceState={refetchWorkspaceState}
					onWorkspaceBoardSavedByRuntime={onWorkspaceBoardSavedByRuntime}
				/>,
			);
		});
	}

	async function flushPersistDebounce(): Promise<void> {
		await act(async () => {
			vi.advanceTimersByTime(WORKSPACE_STATE_PERSIST_DEBOUNCE_WINDOW_MS_PLUS_MARGIN);
		});
	}

	// 先让「runtime 已持久化 persistedBoard」这一事实成立：首轮保存成功后它就是标注 diff 的基线。
	async function establishPersistedBaseline(
		persistedBoard: BoardData,
		persistWorkspaceState: PersistWorkspaceState,
	): Promise<void> {
		await renderHarness({
			board: persistedBoard,
			workspaceRevision: 1,
			hydrationNonce: 0,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});
		await flushPersistDebounce();
	}

	it("sends annotations accumulated since the last successful save and clears them once the save succeeds", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);
		expect(persistWorkspaceState).toHaveBeenCalledTimes(1);
		expect(persistWorkspaceState.mock.calls[0]?.[0].payload).not.toHaveProperty(
			"boardMutationInitiatorAnnotationsForTaskMutationEventCapture",
		);

		const boardAfterUserMove = moveWithUserGestureRecorded(persistedBoard);
		await renderHarness({
			board: boardAfterUserMove,
			workspaceRevision: 2,
			hydrationNonce: 0,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});
		await flushPersistDebounce();

		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
		expect(
			persistWorkspaceState.mock.calls[1]?.[0].payload.boardMutationInitiatorAnnotationsForTaskMutationEventCapture,
		).toEqual([EXPECTED_USER_MOVE_ANNOTATION]);
		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement"),
		).toBeUndefined();
	});

	it("keeps the annotations when the save fails and sends them again with the next attempt", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);

		persistWorkspaceState.mockRejectedValueOnce(new WorkspaceStateConflictError(5));
		const boardAfterUserMove = moveWithUserGestureRecorded(persistedBoard);
		await renderHarness({
			board: boardAfterUserMove,
			workspaceRevision: 2,
			hydrationNonce: 0,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});
		await flushPersistDebounce();

		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
		// 冲突不直接采纳 revision、不回报保存成功：取回最新状态，交给 useWorkspaceSync 的三方判定。
		expect(refetchWorkspaceState).toHaveBeenCalledOnce();
		expect(onWorkspaceBoardSavedByRuntime).not.toHaveBeenCalledWith(expect.objectContaining({ savedRevision: 5 }));
		expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement")).toBe(
			"web_ui_user_gesture",
		);

		// 三方判定保留本地（远端 board 没变）、revision 前移：下一次保存重发同一份标注。
		persistWorkspaceState.mockResolvedValueOnce(savedRevision(6));
		await renderHarness({
			board: boardAfterUserMove,
			workspaceRevision: 5,
			hydrationNonce: 0,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});
		await flushPersistDebounce();

		expect(persistWorkspaceState).toHaveBeenCalledTimes(3);
		expect(
			persistWorkspaceState.mock.calls[2]?.[0].payload.boardMutationInitiatorAnnotationsForTaskMutationEventCapture,
		).toEqual([EXPECTED_USER_MOVE_ANNOTATION]);
		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement"),
		).toBeUndefined();
	});

	it("drops pending annotations when the board is hydrated from the runtime (local unsaved changes are gone)", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);

		moveWithUserGestureRecorded(persistedBoard);
		const boardHydratedFromRuntime = createBoardWithTaskInProgress();
		await renderHarness({
			board: boardHydratedFromRuntime,
			workspaceRevision: 3,
			hydrationNonce: 1,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});

		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement"),
		).toBeUndefined();
	});

	it("reports the board it sent and the saved revision once a save succeeds", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);

		expect(onWorkspaceBoardSavedByRuntime).toHaveBeenCalledWith({
			workspaceId: "project-1",
			savedBoard: persistedBoard,
			savedRevision: 2,
			// 测试替身的保存响应只带 revision；真实响应里是 runtime 实际落盘（可能纠正过）的 board。
			boardPersistedByRuntimeInSaveResponse: undefined,
		});
	});

	// cf427：水合时把本客户端尚未落盘的新卡并回 runtime 那份 board，这次水合之后必须照常保存。
	it("still saves after a hydration that reinserted local cards, diffing against the runtime board and keeping their initiator records", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);

		const remoteBoard = moveTaskToColumn(persistedBoard, "task-1", "review").board;
		const created = addTaskToColumnWithResult(
			remoteBoard,
			"backlog",
			{ prompt: "created locally, not yet persisted", startInPlanMode: false, baseRef: "main" },
			"new01",
		);
		recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
			boardBeforeMutation: remoteBoard,
			boardAfterMutation: created.board,
			boardMutationInitiator: "web_ui_user_gesture",
		});
		persistWorkspaceState.mockResolvedValueOnce(savedRevision(4));
		await renderHarness({
			board: created.board,
			workspaceRevision: 3,
			hydrationNonce: 1,
			latestWorkspaceBoardHydrationFromRuntime: {
				workspaceHydrationNonce: 1,
				boardAcknowledgedByRuntime: remoteBoard,
				hydratedBoardContainsLocalChangesNotYetPersistedByRuntime: true,
			},
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceBoardSavedByRuntime,
		});
		await flushPersistDebounce();

		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
		expect(persistWorkspaceState.mock.calls[1]?.[0].payload).toMatchObject({
			board: created.board,
			expectedRevision: 3,
			boardMutationInitiatorAnnotationsForTaskMutationEventCapture: [
				{
					taskId: "new01",
					annotatedBoardMutationKind: "task_card_created_on_board",
					boardMutationInitiator: "web_ui_user_gesture",
				},
			],
		});
	});

	// 切项目前把防抖窗口里还没发出的保存立刻发出，而不是随定时器一起清掉。
	it("flushes a debounced save immediately on request", async () => {
		const persistWorkspaceState = vi.fn<PersistWorkspaceState>(async () => savedRevision(2));
		const persistedBoard = createBoardWithTaskInProgress();
		await establishPersistedBaseline(persistedBoard, persistWorkspaceState);

		let latestPersistenceResult: UseWorkspacePersistenceResult | null = null;
		const boardAfterUserMove = moveWithUserGestureRecorded(persistedBoard);
		await act(async () => {
			root.render(
				<PersistenceHarness
					board={boardAfterUserMove}
					workspaceRevision={2}
					hydrationNonce={0}
					persistWorkspaceState={persistWorkspaceState}
					refetchWorkspaceState={refetchWorkspaceState}
					onWorkspaceBoardSavedByRuntime={onWorkspaceBoardSavedByRuntime}
					onPersistenceResult={(result) => {
						latestPersistenceResult = result;
					}}
				/>,
			);
		});
		expect(persistWorkspaceState).toHaveBeenCalledTimes(1);

		await act(async () => {
			(
				latestPersistenceResult as UseWorkspacePersistenceResult | null
			)?.flushPendingWorkspaceStatePersistImmediately();
		});
		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
		expect(persistWorkspaceState.mock.calls[1]?.[0].payload.board).toBe(boardAfterUserMove);

		// 已经发出过：防抖窗口到期也不再重复保存。
		await flushPersistDebounce();
		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
	});
});
