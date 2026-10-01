import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceStateResponse, RuntimeWorkspaceStateSaveRequest } from "@/runtime/types";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import { moveTaskToColumn } from "@/state/board-state";
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

interface PersistenceHarnessProps {
	board: BoardData;
	workspaceRevision: number;
	hydrationNonce: number;
	persistWorkspaceState: PersistWorkspaceState;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceRevisionChange: (revision: number) => void;
}

function PersistenceHarness(props: PersistenceHarnessProps): null {
	useWorkspacePersistence({
		board: props.board,
		sessions: {},
		currentProjectId: "project-1",
		workspaceRevision: props.workspaceRevision,
		hydrationNonce: props.hydrationNonce,
		canPersistWorkspaceState: true,
		isDocumentVisible: true,
		isWorkspaceStateRefreshing: false,
		persistWorkspaceState: props.persistWorkspaceState,
		refetchWorkspaceState: props.refetchWorkspaceState,
		onWorkspaceRevisionChange: props.onWorkspaceRevisionChange,
	});
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
	const onWorkspaceRevisionChange = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		discardAllPendingWebUiBoardMutationInitiatorRecords();
		refetchWorkspaceState.mockClear();
		onWorkspaceRevisionChange.mockClear();
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
					onWorkspaceRevisionChange={onWorkspaceRevisionChange}
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
			onWorkspaceRevisionChange,
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
			onWorkspaceRevisionChange,
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
			onWorkspaceRevisionChange,
		});
		await flushPersistDebounce();

		expect(persistWorkspaceState).toHaveBeenCalledTimes(2);
		expect(onWorkspaceRevisionChange).toHaveBeenCalledWith(5);
		expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement")).toBe(
			"web_ui_user_gesture",
		);

		// 冲突后 revision 前移、本地 board 不变（未水合）：下一次保存重发同一份标注。
		persistWorkspaceState.mockResolvedValueOnce(savedRevision(6));
		await renderHarness({
			board: boardAfterUserMove,
			workspaceRevision: 5,
			hydrationNonce: 0,
			persistWorkspaceState,
			refetchWorkspaceState,
			onWorkspaceRevisionChange,
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
			onWorkspaceRevisionChange,
		});

		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement"),
		).toBeUndefined();
	});
});
