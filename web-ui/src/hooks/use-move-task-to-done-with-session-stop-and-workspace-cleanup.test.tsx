import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup } from "@/hooks/use-move-task-to-done-with-session-stop-and-workspace-cleanup";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import {
	discardAllPendingWebUiBoardMutationInitiatorRecords,
	readPendingWebUiBoardMutationInitiatorForTaskCardAspect,
} from "@/state/web-ui-board-mutation-initiator-records-pending-until-successful-save-state";
import type { BoardCard, BoardData } from "@/types";

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
				cards: [createTask("task-1", "Backlog task", 1), createTask("task-3", "Second backlog task", 3)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [createTask("task-2", "Review task", 2)],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

interface HookSnapshot {
	board: BoardData;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: ReturnType<
		typeof useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup
	>["requestMoveTaskToTrash"];
}

function HookHarness({
	onSnapshot,
	stopTaskSession,
	cleanupTaskWorkspace,
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	stopTaskSession?: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace?: (taskId: string) => Promise<unknown>;
}): null {
	const [board, setBoard] = useState<BoardData>(() => createBoard());
	const actions = useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup({
		board,
		setBoard,
		setSelectedTaskId: () => {},
		stopTaskSession: stopTaskSession ?? (async () => {}),
		cleanupTaskWorkspace: cleanupTaskWorkspace ?? (async () => null),
	});

	useEffect(() => {
		onSnapshot({
			board,
			confirmMoveTaskToTrash: actions.confirmMoveTaskToTrash,
			requestMoveTaskToTrash: actions.requestMoveTaskToTrash,
		});
	}, [actions.confirmMoveTaskToTrash, actions.requestMoveTaskToTrash, board, onSnapshot]);

	return null;
}

describe("useMoveTaskToDoneWithSessionStopAndWorkspaceCleanup", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("stops the main task session and its detail terminal shell when a task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const stopTaskSession = vi.fn(async (_taskId: string) => {});

		await act(async () => {
			root.render(
				<HookHarness
					stopTaskSession={stopTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(stopTaskSession).toHaveBeenNthCalledWith(1, reviewTask.id);
		expect(stopTaskSession).toHaveBeenNthCalledWith(2, getDetailTerminalTaskId(reviewTask.id));
	});

	it("trashes tasks directly through the request handler", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async (_taskId: string) => null);

		await act(async () => {
			root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(nextSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
		expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-2");
	});

	it("leaves backlog cards in backlog when a review task moves to done (no auto-start)", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(
			nextSnapshot.board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id),
		).toEqual(["task-1", "task-3"]);
		expect(nextSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
	});

	it("records the initiator handed in by the caller on the Done move, and null when the caller cannot name one", async () => {
		discardAllPendingWebUiBoardMutationInitiatorRecords();
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		const initialSnapshot = latestSnapshot as HookSnapshot | null;
		if (!initialSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review", {
				boardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion",
			});
		});
		expect(readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-2", "task_card_column_placement")).toBe(
			"web_ui_client_automation_auto_review_pull_request_mode_completion",
		);

		await act(async () => {
			await (latestSnapshot as HookSnapshot).requestMoveTaskToTrash("task-1", "backlog");
		});
		expect(
			readPendingWebUiBoardMutationInitiatorForTaskCardAspect("task-1", "task_card_column_placement"),
		).toBeNull();
		discardAllPendingWebUiBoardMutationInitiatorRecords();
	});
});
