import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeBoardCard } from "@/runtime/types";
import {
	addTaskToColumn,
	addTaskToColumnWithResult,
	applyDragResult,
	applyTaskDetailClineSettingsChange,
	applyTaskDetailClineSettingsSelection,
	BOARD_CARD_FIELDS_CARRIED_THROUGH_NORMALIZATION_ON_HYDRATION,
	disableTaskAutoReview,
	getTaskColumnId,
	moveTaskToColumn,
	normalizeBoardData,
	updateTask,
	updateTaskTitle,
} from "@/state/board-state";
import type { ProgrammaticCardMoveInFlight } from "@/state/drag-rules";

// 生产路径的建卡 id 只来自 runtime 预分配（dd2db Y-EVENT-12）；测试里用确定性的递增 5 位 id 代替那次分配。
let nextRuntimeAllocatedTaskIdStandInSequenceForTests = 0;
function addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(
	board: Parameters<typeof addTaskToColumn>[0],
	columnId: Parameters<typeof addTaskToColumn>[1],
	draft: Parameters<typeof addTaskToColumn>[2],
): ReturnType<typeof addTaskToColumn> {
	nextRuntimeAllocatedTaskIdStandInSequenceForTests += 1;
	return addTaskToColumn(
		board,
		columnId,
		draft,
		String(nextRuntimeAllocatedTaskIdStandInSequenceForTests).padStart(5, "0"),
	);
}

function createBacklogBoard(taskPrompts: string[]): {
	board: ReturnType<typeof createInitialBoardData>;
	taskIdByPrompt: Record<string, string>;
} {
	let board = createInitialBoardData();
	for (const taskPrompt of taskPrompts) {
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: taskPrompt,
			baseRef: "main",
		});
	}
	const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];
	const taskIdByPrompt: Record<string, string> = {};
	for (const card of backlogCards) {
		taskIdByPrompt[card.prompt] = card.id;
	}
	return {
		board,
		taskIdByPrompt,
	};
}

function requireTaskId(taskId: string | undefined, taskPrompt: string): string {
	if (!taskId) {
		throw new Error(`Missing task id for ${taskPrompt}`);
	}
	return taskId;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("board state", () => {
	it("applies worktree and agent session initialization changes when updating a task", () => {
		const fixture = createBacklogBoard(["Task A"]);
		const taskId = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const boardWithStaleLegacyParentSessionId = {
			...fixture.board,
			columns: fixture.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) =>
					card.id === taskId ? { ...card, parentSessionId: "223e4567-e89b-42d3-a456-426614174000" } : card,
				),
			})),
		};
		const taskAgentSessionInitialization = {
			sourceAgentId: "codex" as const,
			sourceSessionId: "123e4567-e89b-42d3-a456-426614174000",
			sourceSessionReuseMode: "fork_existing_session" as const,
		};

		const result = updateTask(boardWithStaleLegacyParentSessionId, taskId, {
			prompt: "Task A updated",
			baseRef: "main",
			worktreeMode: "inplace",
			taskAgentSessionInitialization,
		});

		expect(result.updated).toBe(true);
		expect(result.board.columns[0]?.cards[0]).toMatchObject({
			prompt: "Task A updated",
			worktreeMode: "inplace",
			taskAgentSessionInitialization,
		});
		expect(result.board.columns[0]?.cards[0]?.parentSessionId).toBeUndefined();
	});

	it("preserves worktree and agent session initialization when an update omits those fields", () => {
		const taskAgentSessionInitialization = {
			sourceAgentId: "codex" as const,
			sourceSessionId: "123e4567-e89b-42d3-a456-426614174000",
			sourceSessionReuseMode: "resume_existing_session" as const,
		};
		let board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(createInitialBoardData(), "review", {
			title: "Initial title",
			prompt: "Task A",
			autoReviewEnabled: true,
			baseRef: "main",
			worktreeMode: "inplace",
			taskAgentSessionInitialization,
		});
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task to exist");
		}

		board = updateTaskTitle(board, task.id, "Updated title").board;
		board = disableTaskAutoReview(board, task.id).board;

		expect(board.columns.find((column) => column.id === "review")?.cards[0]).toMatchObject({
			title: "Updated title",
			autoReviewEnabled: false,
			worktreeMode: "inplace",
			taskAgentSessionInitialization,
		});
	});

	it("clears worktree and agent session initialization when an update explicitly provides undefined", () => {
		const taskAgentSessionInitialization = {
			sourceAgentId: "codex" as const,
			sourceSessionId: "123e4567-e89b-42d3-a456-426614174000",
			sourceSessionReuseMode: "resume_existing_session" as const,
		};
		const board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(createInitialBoardData(), "backlog", {
			prompt: "Task A",
			baseRef: "main",
			worktreeMode: "inplace",
			taskAgentSessionInitialization,
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}
		const boardWithLegacyParentSessionId = {
			...board,
			columns: board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) =>
					card.id === task.id
						? { ...card, parentSessionId: taskAgentSessionInitialization.sourceSessionId }
						: card,
				),
			})),
		};

		const updated = updateTask(boardWithLegacyParentSessionId, task.id, {
			prompt: task.prompt,
			baseRef: task.baseRef,
			worktreeMode: undefined,
			taskAgentSessionInitialization: undefined,
		});
		const updatedTask = updated.board.columns.find((column) => column.id === "backlog")?.cards[0];

		expect(updatedTask?.worktreeMode).toBeUndefined();
		expect(updatedTask?.taskAgentSessionInitialization).toBeUndefined();
		expect(updatedTask?.parentSessionId).toBeUndefined();
		expect(
			normalizeBoardData(updated.board)?.columns.find((column) => column.id === "backlog")?.cards[0]
				?.taskAgentSessionInitialization,
		).toBeUndefined();
	});

	it("creates tasks when randomUUID is unavailable", () => {
		vi.stubGlobal("crypto", { randomUUID: undefined });

		const board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(createInitialBoardData(), "backlog", {
			prompt: "Task A",
			baseRef: "main",
		});
		const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];

		expect(backlogCards).toHaveLength(1);
		expect(backlogCards[0]?.id).toHaveLength(5);
	});

	// dd2db Y-EVENT-12：新卡 id 只能由 runtime 分配。浏览器端不再有任何本地随机造 id 的退路。
	it("creates the card with exactly the runtime-allocated task id and never generates one locally", () => {
		const randomUuidSpy = vi.fn(() => "ffffffff-ffff-4fff-8fff-ffffffffffff");
		vi.stubGlobal("crypto", { randomUUID: randomUuidSpy });
		const mathRandomSpy = vi.spyOn(Math, "random");

		const board = addTaskToColumn(
			createInitialBoardData(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			"k7q2m",
		);
		const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];

		expect(backlogCards.map((card) => card.id)).toEqual(["k7q2m"]);
		expect(randomUuidSpy).not.toHaveBeenCalled();
		expect(mathRandomSpy).not.toHaveBeenCalled();
	});

	it("refuses to create a card without a runtime-allocated task id instead of falling back to a local one", () => {
		expect(() =>
			addTaskToColumnWithResult(createInitialBoardData(), "backlog", { prompt: "Task A", baseRef: "main" }, "  "),
		).toThrow(/runtime-allocated task id/);
	});

	it("keeps manual in-progress to review drags disabled", () => {
		const fixture = createBacklogBoard(["Task A"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const movedToInProgress = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedToInProgress.moved).toBe(true);

		const attemptedReviewMove = applyDragResult(movedToInProgress.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "in_progress", index: 0 },
			destination: { droppableId: "review", index: 0 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(attemptedReviewMove.moveEvent).toBeUndefined();
		expect(getTaskColumnId(attemptedReviewMove.board, taskA)).toBe("in_progress");
	});

	it("preserves manual backlog to in-progress drop positions", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedB = moveTaskToColumn(fixture.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress");
		expect(movedC.moved).toBe(true);

		const movedA = applyDragResult(movedC.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "backlog", index: 0 },
			destination: { droppableId: "in_progress", index: 2 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedA.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "backlog",
			toColumnId: "in_progress",
		});
		const inProgressColumn = movedA.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskC, taskB, taskA]);
	});

	it("inserts programmatic backlog to in-progress moves at the top", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedB = moveTaskToColumn(fixture.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress");
		expect(movedC.moved).toBe(true);

		const movedA = applyDragResult(
			movedC.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "backlog", index: 0 },
				destination: { droppableId: "in_progress", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: {
					taskId: taskA,
					fromColumnId: "backlog",
					toColumnId: "in_progress",
					insertAtTop: true,
				},
			},
		);
		expect(movedA.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "backlog",
			toColumnId: "in_progress",
		});
		const inProgressColumn = movedA.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskA, taskC, taskB]);
	});

	it("supports programmatic drag transitions between in-progress and review", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");
		const movedToInProgress = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedToInProgress.moved).toBe(true);
		const movedBToReview = moveTaskToColumn(movedToInProgress.board, taskB, "review");
		expect(movedBToReview.moved).toBe(true);
		const movedCToInProgress = moveTaskToColumn(movedBToReview.board, taskC, "in_progress");
		expect(movedCToInProgress.moved).toBe(true);
		const moveToReview: ProgrammaticCardMoveInFlight = {
			taskId: taskA,
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		const movedToReview = applyDragResult(
			movedCToInProgress.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "in_progress", index: 1 },
				destination: { droppableId: "review", index: 1 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: moveToReview,
			},
		);
		expect(movedToReview.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "in_progress",
			toColumnId: "review",
		});
		expect(getTaskColumnId(movedToReview.board, taskA)).toBe("review");
		const reviewColumn = movedToReview.board.columns.find((column) => column.id === "review");
		expect(reviewColumn?.cards.map((card) => card.id)).toEqual([taskA, taskB]);
		const moveBackToInProgress: ProgrammaticCardMoveInFlight = {
			taskId: taskA,
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		const movedBackToInProgress = applyDragResult(
			movedToReview.board,
			{
				draggableId: taskA,
				type: "CARD",
				source: { droppableId: "review", index: 0 },
				destination: { droppableId: "in_progress", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: moveBackToInProgress,
			},
		);
		expect(movedBackToInProgress.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "review",
			toColumnId: "in_progress",
		});
		expect(getTaskColumnId(movedBackToInProgress.board, taskA)).toBe("in_progress");
		const inProgressColumn = movedBackToInProgress.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskA, taskC]);
	});

	it("preserves manual cross-column trash drop positions", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToTrash = moveTaskToColumn(movedAToTrash.board, taskB, "trash");
		expect(movedBToTrash.moved).toBe(true);
		const movedCToReview = moveTaskToColumn(movedBToTrash.board, taskC, "review");
		expect(movedCToReview.moved).toBe(true);

		const movedToTrash = applyDragResult(movedCToReview.board, {
			draggableId: taskC,
			type: "CARD",
			source: { droppableId: "review", index: 0 },
			destination: { droppableId: "trash", index: 2 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedToTrash.moveEvent).toMatchObject({
			taskId: taskC,
			fromColumnId: "review",
			toColumnId: "trash",
		});
		const trashColumn = movedToTrash.board.columns.find((column) => column.id === "trash");
		expect(trashColumn?.cards.map((card) => card.id)).toEqual([taskB, taskA, taskC]);
	});

	it("allows manual trash to review drags", () => {
		const fixture = createBacklogBoard(["Task A", "Task B"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToReview = moveTaskToColumn(movedAToTrash.board, taskB, "review");
		expect(movedBToReview.moved).toBe(true);

		const movedToReview = applyDragResult(movedBToReview.board, {
			draggableId: taskA,
			type: "CARD",
			source: { droppableId: "trash", index: 0 },
			destination: { droppableId: "review", index: 1 },
			mode: "SNAP",
			reason: "DROP",
			combine: null,
		});
		expect(movedToReview.moveEvent).toMatchObject({
			taskId: taskA,
			fromColumnId: "trash",
			toColumnId: "review",
		});
		expect(getTaskColumnId(movedToReview.board, taskA)).toBe("review");
		const reviewColumn = movedToReview.board.columns.find((column) => column.id === "review");
		expect(reviewColumn?.cards.map((card) => card.id)).toEqual([taskB, taskA]);
	});

	it("inserts programmatic trash drags at the top of trash", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedAToTrash = moveTaskToColumn(fixture.board, taskA, "trash");
		expect(movedAToTrash.moved).toBe(true);
		const movedBToTrash = moveTaskToColumn(movedAToTrash.board, taskB, "trash");
		expect(movedBToTrash.moved).toBe(true);
		const movedCToReview = moveTaskToColumn(movedBToTrash.board, taskC, "review");
		expect(movedCToReview.moved).toBe(true);

		const movedToTrash = applyDragResult(
			movedCToReview.board,
			{
				draggableId: taskC,
				type: "CARD",
				source: { droppableId: "review", index: 0 },
				destination: { droppableId: "trash", index: 2 },
				mode: "SNAP",
				reason: "DROP",
				combine: null,
			},
			{
				programmaticCardMoveInFlight: {
					taskId: taskC,
					fromColumnId: "review",
					toColumnId: "trash",
					insertAtTop: true,
				},
			},
		);
		expect(movedToTrash.moveEvent).toMatchObject({
			taskId: taskC,
			fromColumnId: "review",
			toColumnId: "trash",
		});
		const trashColumn = movedToTrash.board.columns.find((column) => column.id === "trash");
		expect(trashColumn?.cards.map((card) => card.id)).toEqual([taskC, taskB, taskA]);
	});

	it("can insert moved cards at the top when requested", () => {
		const fixture = createBacklogBoard(["Task A", "Task B", "Task C"]);
		const taskA = requireTaskId(fixture.taskIdByPrompt["Task A"], "Task A");
		const taskB = requireTaskId(fixture.taskIdByPrompt["Task B"], "Task B");
		const taskC = requireTaskId(fixture.taskIdByPrompt["Task C"], "Task C");

		const movedA = moveTaskToColumn(fixture.board, taskA, "in_progress");
		expect(movedA.moved).toBe(true);
		const movedB = moveTaskToColumn(movedA.board, taskB, "in_progress");
		expect(movedB.moved).toBe(true);
		const movedC = moveTaskToColumn(movedB.board, taskC, "in_progress", {
			insertAtTop: true,
		});
		expect(movedC.moved).toBe(true);
		const inProgressColumn = movedC.board.columns.find((column) => column.id === "in_progress");
		expect(inProgressColumn?.cards.map((card) => card.id)).toEqual([taskC, taskB, taskA]);
	});

	it("drops the retired dependencies key when normalizing a legacy board", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [{ id: "b", prompt: "Task B", startInPlanMode: false, baseRef: "main" }],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
			dependencies: [{ id: "dep-1", fromTaskId: "b", toTaskId: "a" }],
		};

		const normalized = normalizeBoardData(rawBoard);
		expect(normalized).not.toBeNull();
		expect(normalized).not.toHaveProperty("dependencies");
		expect(normalized?.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id)).toEqual([
			"b",
		]);
	});

	it("does not upgrade a non-UUID legacy parent session id", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "legacy-session-task",
							prompt: "Task with an invalid legacy session",
							startInPlanMode: false,
							baseRef: "main",
							parentSessionId: "not-a-uuid",
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalizedTask = normalizeBoardData(rawBoard)?.columns[0]?.cards[0];

		expect(normalizedTask?.parentSessionId).toBe("not-a-uuid");
		expect(normalizedTask?.taskAgentSessionInitialization).toBeUndefined();
	});

	// 水合出来的这份 board 会被原样回写持久化，所以 normalizeCard 丢字段等于把服务端卡片上
	// 已固化的通道抹平；详情视图在无活会话时也就再没有东西可据以预判下次启动走哪条通道。
	it("keeps the pinned omp session transport on persisted cards", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "pinned-acp-task",
							prompt: "Task pinned to ACP",
							startInPlanMode: false,
							baseRef: "main",
							agentId: "omp",
							ompAgentSessionTransport: "acp_stdio_subprocess",
						},
						{
							id: "legacy-task",
							prompt: "Task without a pinned transport",
							startInPlanMode: false,
							baseRef: "main",
							agentId: "omp",
						},
						{
							id: "garbage-transport-task",
							prompt: "Task with an unreadable pinned transport",
							startInPlanMode: false,
							baseRef: "main",
							agentId: "omp",
							ompAgentSessionTransport: "not-a-transport",
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalizedCards = normalizeBoardData(rawBoard)?.columns[0]?.cards;

		expect(normalizedCards?.[0]?.ompAgentSessionTransport).toBe("acp_stdio_subprocess");
		// 老卡片留 undefined，由启动处回落到当时的全局默认——这里不替它猜。
		expect(normalizedCards?.[1]?.ompAgentSessionTransport).toBeUndefined();
		expect(normalizedCards?.[2]?.ompAgentSessionTransport).toBeUndefined();
	});

	// 同一条白名单铁律的另一面：置顶态存在卡片上，normalizeCard 漏掉就等于「刷新一次页面，
	// 所有置顶连同置顶原因被静默抹平」。这条用例是那个回归的唯一防线。
	it("keeps the task pinboard pin state and reason on persisted cards", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "pinned-with-reason",
							prompt: "Pinned task with a reason",
							startInPlanMode: false,
							baseRef: "main",
							pinnedToTaskPinboardAt: 1_700_000_000_000,
							taskPinboardPinReason: "blocked on review feedback",
						},
						{
							id: "pinned-without-reason",
							prompt: "Pinned task without a reason",
							startInPlanMode: false,
							baseRef: "main",
							pinnedToTaskPinboardAt: 1_700_000_001_000,
						},
						{
							id: "never-pinned",
							prompt: "Task that was never pinned",
							startInPlanMode: false,
							baseRef: "main",
						},
						{
							id: "garbage-pin-timestamp",
							prompt: "Task with an unreadable pin timestamp",
							startInPlanMode: false,
							baseRef: "main",
							pinnedToTaskPinboardAt: "yesterday",
							taskPinboardPinReason: "   ",
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalizedCards = normalizeBoardData(rawBoard)?.columns[0]?.cards;

		expect(normalizedCards?.[0]?.pinnedToTaskPinboardAt).toBe(1_700_000_000_000);
		expect(normalizedCards?.[0]?.taskPinboardPinReason).toBe("blocked on review feedback");
		expect(normalizedCards?.[1]?.pinnedToTaskPinboardAt).toBe(1_700_000_001_000);
		expect(normalizedCards?.[1]?.taskPinboardPinReason).toBeUndefined();
		expect(normalizedCards?.[2]?.pinnedToTaskPinboardAt).toBeUndefined();
		// 「字段存在即已置顶」，所以非有限数一律当未置顶；纯空白原因不写字段（避免盘上堆空串）。
		expect(normalizedCards?.[3]?.pinnedToTaskPinboardAt).toBeUndefined();
		expect(normalizedCards?.[3]?.taskPinboardPinReason).toBeUndefined();
	});

	it("keeps cards in the validation column when normalizing", () => {
		const rawBoard = {
			columns: [
				{ id: "backlog", cards: [] },
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{
					id: "validation",
					cards: [{ id: "v", prompt: "Task V", startInPlanMode: false, baseRef: "main" }],
				},
				{ id: "trash", cards: [] },
			],
		};

		const normalized = normalizeBoardData(rawBoard);
		const validationColumn = normalized?.columns.find((column) => column.id === "validation");
		expect(validationColumn?.cards.map((card) => card.id)).toEqual(["v"]);
	});

	it("normalizes task comment entries on persisted cards", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "commented-task",
							prompt: "Task with notes",
							startInPlanMode: false,
							baseRef: "main",
							taskCommentEntries: [
								{
									taskCommentEntryId: "comment-1",
									commentText: "Keep this note.",
									createdAt: 100,
									updatedAt: 110,
								},
								{
									taskCommentEntryId: "empty-comment",
									commentText: "   ",
									createdAt: 120,
									updatedAt: 120,
								},
							],
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalized = normalizeBoardData(rawBoard);
		const task = normalized?.columns.find((column) => column.id === "backlog")?.cards[0];

		expect(task?.taskCommentEntries).toEqual([
			{
				taskCommentEntryId: "comment-1",
				commentText: "Keep this note.",
				createdAt: 100,
				updatedAt: 110,
			},
		]);
	});

	// 归一化后的 board 会被原样 saveState 回盘，而服务端是整块覆盖 board.json（不按字段合并）。
	// 所以归一化层一旦剥掉这个只由 runtime 写入的 durable 字段，硬中断恢复的主真相源就会被抹掉。
	it("preserves the runtime-written mostRecentlyLaunchedAgentSessionAgentId across normalization and edits", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "launched-task",
							prompt: "Task started with a resolved default agent",
							startInPlanMode: false,
							baseRef: "main",
							mostRecentlyLaunchedAgentSessionAgentId: "codex",
						},
						{
							id: "unknown-agent-task",
							prompt: "Task carrying an unknown agent id",
							startInPlanMode: false,
							baseRef: "main",
							mostRecentlyLaunchedAgentSessionAgentId: "not-a-real-agent",
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalized = normalizeBoardData(rawBoard);
		const backlogCards = normalized?.columns.find((column) => column.id === "backlog")?.cards ?? [];
		expect(backlogCards[0]?.mostRecentlyLaunchedAgentSessionAgentId).toBe("codex");
		expect(backlogCards[1]?.mostRecentlyLaunchedAgentSessionAgentId).toBeUndefined();

		if (!normalized) {
			throw new Error("expected normalized board");
		}
		const edited = updateTask(normalized, "launched-task", {
			prompt: "Task started with a resolved default agent",
			baseRef: "main",
		});
		const editedCard = edited.board.columns
			.find((column) => column.id === "backlog")
			?.cards.find((card) => card.id === "launched-task");
		expect(editedCard?.mostRecentlyLaunchedAgentSessionAgentId).toBe("codex");
	});

	it("backfills an empty validation column for legacy four-column boards", () => {
		const rawBoard = {
			columns: [
				{ id: "backlog", cards: [] },
				{
					id: "in_progress",
					cards: [{ id: "a", prompt: "Task A", startInPlanMode: false, baseRef: "main" }],
				},
				{ id: "review", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalized = normalizeBoardData(rawBoard);
		expect(normalized).not.toBeNull();
		if (!normalized) {
			throw new Error("expected normalized board");
		}
		expect(normalized.columns.map((column) => column.id)).toEqual([
			"backlog",
			"in_progress",
			"review",
			"validation",
			"trash",
		]);
		const validationColumn = normalized.columns.find((column) => column.id === "validation");
		expect(validationColumn?.cards).toEqual([]);
		expect(getTaskColumnId(normalized, "a")).toBe("in_progress");
	});

	it("disables auto-review settings for a task", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "review", {
			prompt: "Task A",
			autoReviewEnabled: true,
			autoReviewMode: "commit",
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected review task to exist");
		}

		const disabled = disableTaskAutoReview(board, task.id);
		expect(disabled.updated).toBe(true);

		const updatedTask = disabled.board.columns.find((column) => column.id === "review")?.cards[0];
		expect(updatedTask?.autoReviewEnabled).toBe(false);
		expect(updatedTask?.autoReviewMode).toBe("commit");
	});

	it("updates only the task title", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			title: "Initial",
			prompt: "Task A prompt",
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}
		const updated = updateTaskTitle(board, task.id, "Updated title");
		expect(updated.updated).toBe(true);
		const updatedTask = updated.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.title).toBe("Updated title");
		expect(updatedTask?.prompt).toBe("Task A prompt");
		expect(updatedTask?.baseRef).toBe("main");
	});

	it("preserves task-level cline overrides when updating the title", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with cline overrides",
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "openai/gpt-5.4",
				reasoningEffort: "low",
			},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const updated = updateTaskTitle(board, task.id, "Updated title");
		expect(updated.updated).toBe(true);
		const updatedTask = updated.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.title).toBe("Updated title");
		expect(updatedTask?.agentId).toBe("cline");
		expect(updatedTask?.clineSettings).toEqual({
			providerId: "openrouter",
			modelId: "openai/gpt-5.4",
			reasoningEffort: "low",
		});
	});

	it("preserves model fields when disabling auto-review", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "review", {
			prompt: "Task with model",
			autoReviewEnabled: true,
			autoReviewMode: "commit",
			agentId: "codex",
			clineSettings: {
				providerId: "my-provider",
				modelId: "my-model",
				reasoningEffort: "high",
			},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected review task to exist");
		}
		expect(task.agentId).toBe("codex");
		expect(task.clineSettings).toEqual({
			providerId: "my-provider",
			modelId: "my-model",
			reasoningEffort: "high",
		});

		const disabled = disableTaskAutoReview(board, task.id);
		expect(disabled.updated).toBe(true);

		const updatedTask = disabled.board.columns.find((column) => column.id === "review")?.cards[0];
		expect(updatedTask?.autoReviewEnabled).toBe(false);
		expect(updatedTask?.agentId).toBe("codex");
		expect(updatedTask?.clineSettings).toEqual({
			providerId: "my-provider",
			modelId: "my-model",
			reasoningEffort: "high",
		});
	});

	it("does not create task model overrides for tasks inheriting global agent settings", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with inherited settings",
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsSelection(board, task.id, {
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "anthropic/claude-opus-4.6",
			},
		});
		expect(result.updated).toBe(false);
		const unchangedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(unchangedTask?.agentId).toBeUndefined();
		expect(unchangedTask?.clineSettings).toBeUndefined();
	});

	it("updates task model overrides when the task already has explicit task-level settings", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with explicit override",
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "anthropic/claude-sonnet-4.6",
				reasoningEffort: "low",
			},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsSelection(board, task.id, {
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "anthropic/claude-opus-4.6",
				reasoningEffort: "high",
			},
		});
		expect(result.updated).toBe(true);
		const updatedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.agentId).toBe("cline");
		expect(updatedTask?.clineSettings).toEqual({
			providerId: "openrouter",
			modelId: "anthropic/claude-opus-4.6",
			reasoningEffort: "high",
		});
	});

	it("updates reasoning-only task overrides without forcing provider or model overrides", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with reasoning-only override",
			clineSettings: {
				reasoningEffort: "low",
			},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsSelection(board, task.id, {
			clineSettings: {
				reasoningEffort: "high",
			},
		});
		expect(result.updated).toBe(true);
		const updatedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.agentId).toBeUndefined();
		expect(updatedTask?.clineSettings).toEqual({
			reasoningEffort: "high",
		});
	});

	it("does not treat non-cline agent overrides as explicit cline settings", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with codex override",
			agentId: "codex",
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsSelection(board, task.id, {
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "anthropic/claude-opus-4.6",
			},
		});
		expect(result.updated).toBe(false);
		const unchangedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(unchangedTask?.agentId).toBe("codex");
		expect(unchangedTask?.clineSettings).toBeUndefined();
	});

	it("materializes a concrete cline override when saving task-level chat settings", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task with explicit empty override",
			clineSettings: {},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsChange(
			board,
			task.id,
			{
				providerId: "anthropic",
				modelId: "claude-sonnet-4.6",
				reasoningEffort: "",
			},
			{
				providerId: "anthropic",
				modelId: "claude-sonnet-4.6",
			},
		);
		expect(result.updated).toBe(true);
		const updatedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.agentId).toBe("cline");
		expect(updatedTask?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4.6",
		});
	});

	it("keeps tasks pinned to cline when the global selected agent is different", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task pinned to cline",
			agentId: "cline",
			clineSettings: {
				providerId: "openrouter",
				modelId: "anthropic/claude-sonnet-4.6",
			},
			baseRef: "main",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(task).toBeDefined();
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		const result = applyTaskDetailClineSettingsChange(
			board,
			task.id,
			{
				providerId: "openrouter",
				modelId: "anthropic/claude-opus-4.6",
				reasoningEffort: "medium",
			},
			{
				providerId: "openai",
				modelId: "openai/gpt-5.4",
			},
		);
		expect(result.updated).toBe(true);
		const updatedTask = result.board.columns.find((column) => column.id === "backlog")?.cards[0];
		expect(updatedTask?.agentId).toBe("cline");
		expect(updatedTask?.clineSettings).toEqual({
			providerId: "openrouter",
			modelId: "anthropic/claude-opus-4.6",
			reasoningEffort: "medium",
		});
	});
});

describe("task conversation mode（蓝图 §A.1）", () => {
	it("create：按 draft 落卡片字段，缺省不落字段", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Exploratory task",
			baseRef: "main",
			taskConversationMode: "exploratory",
		});
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Plain task",
			baseRef: "main",
		});

		const cards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];
		expect(cards.find((card) => card.prompt === "Exploratory task")?.taskConversationMode).toBe("exploratory");
		expect(cards.find((card) => card.prompt === "Plain task")?.taskConversationMode).toBeUndefined();
	});

	it("normalize：保留持久化卡片上的模式声明，非法值剥掉（不抹合法缺省）", () => {
		const rawBoard = {
			columns: [
				{
					id: "backlog",
					cards: [
						{
							id: "exploratory-task",
							prompt: "Exploratory task",
							startInPlanMode: false,
							baseRef: "main",
							taskConversationMode: "exploratory",
						},
						{
							id: "legacy-task",
							prompt: "Task without a mode",
							startInPlanMode: false,
							baseRef: "main",
						},
						{
							id: "garbage-mode-task",
							prompt: "Task with an unreadable mode",
							startInPlanMode: false,
							baseRef: "main",
							taskConversationMode: "not-a-mode",
						},
					],
				},
				{ id: "in_progress", cards: [] },
				{ id: "review", cards: [] },
				{ id: "validation", cards: [] },
				{ id: "trash", cards: [] },
			],
		};

		const normalizedCards = normalizeBoardData(rawBoard)?.columns[0]?.cards;

		expect(normalizedCards?.[0]?.taskConversationMode).toBe("exploratory");
		// 老卡片留 undefined = operational 缺省，这里不替它物化。
		expect(normalizedCards?.[1]?.taskConversationMode).toBeUndefined();
		expect(normalizedCards?.[2]?.taskConversationMode).toBeUndefined();
	});

	it("updateTask 三态：不提保留 / null 清除回缺省 / 具体值覆盖", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "backlog", {
			prompt: "Task A",
			baseRef: "main",
			taskConversationMode: "exploratory",
		});
		const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
		if (!task) {
			throw new Error("Expected backlog task to exist");
		}

		// 不提 = 保留（改标题等部分重建 draft 的调用点不得碰它）。
		const preserved = updateTask(board, task.id, { prompt: "Task A renamed", baseRef: "main" });
		expect(preserved.board.columns[0]?.cards[0]?.taskConversationMode).toBe("exploratory");

		// 具体值 = 覆盖。
		const overwritten = updateTask(board, task.id, {
			prompt: task.prompt,
			baseRef: "main",
			taskConversationMode: "operational",
		});
		expect(overwritten.board.columns[0]?.cards[0]?.taskConversationMode).toBe("operational");

		// null = 清除回缺省（字段消失，下游按 operational 解析）。
		const cleared = updateTask(board, task.id, {
			prompt: task.prompt,
			baseRef: "main",
			taskConversationMode: null,
		});
		expect(cleared.board.columns[0]?.cards[0]?.taskConversationMode).toBeUndefined();
	});

	it("updateTaskTitle / disableTaskAutoReview 等部分重建路径保留模式声明", () => {
		let board = createInitialBoardData();
		board = addTaskToColumnWithRuntimeAllocatedTaskIdStandIn(board, "review", {
			title: "Initial title",
			prompt: "Task A",
			autoReviewEnabled: true,
			baseRef: "main",
			taskConversationMode: "exploratory",
		});
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task to exist");
		}

		board = updateTaskTitle(board, task.id, "Updated title").board;
		board = disableTaskAutoReview(board, task.id).board;

		expect(board.columns.find((column) => column.id === "review")?.cards[0]?.taskConversationMode).toBe(
			"exploratory",
		);
	});
});

describe("normalizeBoardData 的白名单铁律（水合后的 board 会被整板 saveState 回盘）", () => {
	// 服务端卡片 schema 的每个字段都填上非缺省值。新增字段时 typecheck 会先在
	// BOARD_CARD_FIELDS_CARRIED_THROUGH_NORMALIZATION_ON_HYDRATION 处失败；登记后把它也填进这里。
	const fullyPopulatedRuntimeBoardCard: Required<RuntimeBoardCard> = {
		id: "f1e2d",
		mainTaskConversationSessionId: "codex-peer-session",
		taskMainSessionHandover: {
			handoverId: "handover-1",
			sourceTaskConversationSessionId: "f1e2d",
			targetTaskConversationSessionId: "codex-peer-session",
			destination: { kind: "existing_codex_session", taskConversationSessionId: "codex-peer-session" },
			status: "awaiting_user_message",
			createdAt: 1,
			updatedAt: 2,
			userContextNotes: "只汇报现状",
			additionalPlanReferencePaths: [],
			materialDirectoryPath: "/persistent/handover-1",
			errorMessage: null,
			reportDeliveryStartedAt: 2,
			reportDeliveryAttempt: 0,
		},
		title: "Every field populated",
		prompt: "Carry every field through normalization",
		startInPlanMode: true,
		taskAgentPermissionMode: "auto_approve_file_edits_only",
		autoReviewEnabled: true,
		autoReviewMode: "pr",
		images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png", name: "screenshot.png" }],
		taskCommentEntries: [{ taskCommentEntryId: "comment-1", commentText: "note", createdAt: 10, updatedAt: 11 }],
		pinnedToTaskPinboardAt: 1_700_000_000_000,
		taskPinboardPinReason: "watch this",
		agentId: "claude",
		ompAgentSessionTransport: "acp_stdio_subprocess",
		taskConversationMode: "exploratory",
		mostRecentlyLaunchedAgentSessionAgentId: "claude",
		clineSettings: { providerId: "anthropic", modelId: "claude-sonnet", reasoningEffort: "high" },
		terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
		taskAgentSessionInitialization: {
			sourceAgentId: "codex",
			sourceSessionId: "019a0000-0000-7000-8000-000000000000",
			sourceSessionReuseMode: "fork_existing_session",
		},
		baseRef: "main",
		parentSessionId: "019a0000-0000-7000-8000-000000000000",
		worktreeMode: "inplace",
		prepFilePath: "/abs/prep.json",
		createdAt: 1_600_000_000_000,
		updatedAt: 1_650_000_000_000,
		taskDescriptionLastUpdatedAt: 1_640_000_000_000,
	};

	it("服务端卡片的每个字段都原样带过归一化", () => {
		const normalizedCard = normalizeBoardData({
			columns: [{ id: "backlog", title: "Backlog", cards: [fullyPopulatedRuntimeBoardCard] }],
		})?.columns.find((column) => column.id === "backlog")?.cards[0];
		for (const fieldName of Object.keys(BOARD_CARD_FIELDS_CARRIED_THROUGH_NORMALIZATION_ON_HYDRATION) as Array<
			keyof RuntimeBoardCard
		>) {
			expect({ fieldName, value: normalizedCard?.[fieldName as keyof typeof normalizedCard] }).toEqual({
				fieldName,
				value: fullyPopulatedRuntimeBoardCard[fieldName],
			});
		}
	});
});
