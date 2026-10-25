import type { DropResult } from "@hello-pangea/dnd";
import { POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX } from "@runtime-post-deploy-verification-done-entry-closure-contract";
import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPostDeployVerificationTaskReadModelTestFixture } from "@/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import { type UseBoardInteractionsResult, useBoardInteractions } from "@/hooks/use-board-interactions";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import { resetPendingTaskCardCommandBoardOverlayStore } from "@/stores/pending-task-card-command-board-overlay-store";
import {
	clearAllTaskCardActionCommandsInFlight,
	tryBeginTaskCardActionCommandInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 看板入口（按钮 / 拖拽 / 服务端拒绝兜底 / 会话中断与自动 review 的自动流转）撞上 Post-Deploy Verification
// 「移入 Done」门禁时的行为。门禁唯一判据在服务端；这里钉住客户端预检与拒绝分流。

const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const useProgrammaticCardMovesMock = vi.hoisted(() => vi.fn());
const capturedReviewAutoActionsOptions = vi.hoisted(() => ({
	latest: null as null | {
		requestMoveTaskToTrash: (
			taskId: string,
			fromColumnId: BoardColumnId,
			options?: { skipWorkingChangeWarning?: boolean; boardMutationInitiator?: string },
		) => Promise<void>;
	},
}));
const moveTaskCardIntoDoneInWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));
vi.mock("@/runtime/task-card-action-query", () => ({
	startTaskCardAgentSessionMovingItIntoInProgressInWorkspace: vi.fn(),
	moveTaskCardIntoReviewByHandingTurnToUserInWorkspace: vi.fn(),
	moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffectsInWorkspace: vi.fn(),
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeInWorkspace: moveTaskCardIntoDoneInWorkspaceMock,
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionInWorkspace: vi.fn(),
	permanentlyDeleteTaskCardsWithFullResourceCleanupInWorkspace: vi.fn(),
	updateTaskCardFieldValuesInWorkspace: vi.fn(),
	setTaskPinboardPinStateOfTaskCardInWorkspace: vi.fn(),
	readTaskCardWithBoardColumnInWorkspace: vi.fn(),
}));
vi.mock("@/hooks/use-programmatic-card-moves", () => ({
	useProgrammaticCardMoves: useProgrammaticCardMovesMock,
}));
vi.mock("@/hooks/use-review-auto-actions", () => ({
	useReviewAutoActions: (options: NonNullable<typeof capturedReviewAutoActionsOptions.latest>) => {
		capturedReviewAutoActionsOptions.latest = options;
	},
}));

const GATED_TASK_ID = "task-gated";

function createTask(taskId: string): BoardCard {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoardWithTaskInColumn(taskId: string, columnId: BoardColumnId): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((id) => ({ id, title: id, cards: id === columnId ? [createTask(taskId)] : [] })),
	};
}

function createActiveGroupWithTask(
	task: RuntimePostDeployVerificationTask,
): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId: "deployment-active",
		workspaceId: "project-1",
		deployedSourceCommit: "44ded6b1",
		previousDeployedSourceCommit: "5b7e9432",
		deployedAtIso: "2026-10-11T00:00:00.000Z",
		foldedAtIso: null,
		tasks: [task],
	};
}

const GATED_TASK_WITH_UNCHECKED_ITEM = createPostDeployVerificationTaskReadModelTestFixture({
	taskId: GATED_TASK_ID,
	checklist: [
		{
			id: "authored:guided",
			label: "看板拖拽进 Done 弹出原因对话框",
			checked: false,
			source: "authored",
			kind: "guided_manual",
			guidance: null,
			script: null,
			run: null,
			cleanup: null,
		},
	],
});

function mockProgrammaticCardMoves(overrides: Partial<Record<string, unknown>> = {}) {
	const mocks = {
		handleProgrammaticCardMoveReady: () => {},
		setRequestMoveTaskToTrashHandler: () => {},
		tryProgrammaticCardMove: vi.fn(() => "unavailable"),
		consumeProgrammaticCardMove: () => ({}),
		resolvePendingProgrammaticTrashMove: vi.fn(),
		waitForProgrammaticCardMoveAvailability: async () => {},
		resetProgrammaticCardMoves: () => {},
		requestMoveTaskToTrashWithAnimation: vi.fn(async () => {}),
		programmaticCardMoveCycle: 0,
		...overrides,
	};
	useProgrammaticCardMovesMock.mockReturnValue(mocks);
	return mocks;
}

function succeedMoveIntoDone(): void {
	moveTaskCardIntoDoneInWorkspaceMock.mockImplementation(
		async (_workspaceId: string, request: { taskId: string }) => ({
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
			taskAgentSessionStopWasRequested: true,
			taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
			taskCardSnapshotAfterAction: {
				taskCard: createTask(request.taskId),
				boardColumnIdContainingTaskCard: "trash",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		}),
	);
}

const NOOP_FETCH_TASK_WORKSPACE_INFO = async (): Promise<null> => null;
const NOOP_SEND_TASK_SESSION_INPUT = async (): Promise<{ ok: boolean }> => ({ ok: true });
const EMPTY_TASK_GIT_ACTION_LOADING_BY_TASK_ID = {};
const NOOP_RUN_AUTO_REVIEW_GIT_ACTION = async (): Promise<boolean> => false;

function HookHarness({
	board,
	setBoard,
	activeGroup,
	refreshPostDeployVerification,
	initialSessions,
	onSnapshot,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
	refreshPostDeployVerification: () => void;
	initialSessions?: Record<string, RuntimeTaskSessionSummary>;
	onSnapshot: (snapshot: UseBoardInteractionsResult) => void;
}): null {
	// 传给 hook 的 setter 必须身份稳定（与 App 一样用 useState 的 setter）：hook 的重置 effect 依赖它们，
	// 每次渲染换新函数会让重置 effect 每帧都跑、写 state、再渲染，死循环。
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>(initialSessions ?? {});
	const [, setSelectedTaskId] = useState<string | null>(null);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const [, setIsGitHistoryOpen] = useState(false);
	const actions = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard: null,
		selectedTaskId: null,
		currentProjectId: "project-1",
		setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		fetchTaskWorkspaceInfo: NOOP_FETCH_TASK_WORKSPACE_INFO,
		sendTaskSessionInput: NOOP_SEND_TASK_SESSION_INPUT,
		sendTaskChatMessage: NOOP_SEND_TASK_SESSION_INPUT,
		readyForReviewNotificationsEnabled: false,
		taskGitActionLoadingByTaskId: EMPTY_TASK_GIT_ACTION_LOADING_BY_TASK_ID,
		runAutoReviewGitAction: NOOP_RUN_AUTO_REVIEW_GIT_ACTION,
		postDeployVerificationActiveDeploymentGroupForDoneEntryGatePrecheck: activeGroup,
		refreshPostDeployVerificationReadModelAfterDoneEntryGateRejection: refreshPostDeployVerification,
	});
	useEffect(() => {
		onSnapshot(actions);
	});
	return null;
}

describe("useBoardInteractions · Post-Deploy Verification 移入 Done 门禁", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let latestSnapshot: UseBoardInteractionsResult | null;
	let currentBoard: BoardData;
	const refreshPostDeployVerification = vi.fn();

	beforeEach(() => {
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		moveTaskCardIntoDoneInWorkspaceMock.mockReset();
		refreshPostDeployVerification.mockReset();
		useProgrammaticCardMovesMock.mockReset();
		capturedReviewAutoActionsOptions.latest = null;
		clearAllTaskCardActionCommandsInFlight();
		resetPendingTaskCardCommandBoardOverlayStore();
		succeedMoveIntoDone();
		latestSnapshot = null;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function renderHarness(input: {
		board: BoardData;
		activeGroup: RuntimePostDeployVerificationDeploymentGroup | null;
		initialSessions?: Record<string, RuntimeTaskSessionSummary>;
	}): Promise<void> {
		currentBoard = input.board;
		const setBoard: Dispatch<SetStateAction<BoardData>> = (nextBoard) => {
			currentBoard = typeof nextBoard === "function" ? nextBoard(currentBoard) : nextBoard;
		};
		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					activeGroup={input.activeGroup}
					refreshPostDeployVerification={refreshPostDeployVerification}
					initialSessions={input.initialSessions}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
	}

	function requireSnapshot(): UseBoardInteractionsResult {
		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}
		return latestSnapshot;
	}

	it("评论确认后才发单次 Done 命令，空白输入无效，成功清空草稿", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"), activeGroup: null });
		await act(async () =>
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, { requestTaskCommentBeforeMovingIntoDone: true }),
		);
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request?.phase).toBe("editing");
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("   "));
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("  确认完成\n保留换行  "));
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({
				taskId: GATED_TASK_ID,
				taskCommentToAppendWhenMovingIntoDone: {
					taskCommentEntryId: expect.any(String),
					commentText: "确认完成\n保留换行",
				},
			}),
		);
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledOnce();
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
	});

	it("Review 评论经过原有跳过 Validation 确认，取消返回草稿，再确认成功", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"), activeGroup: null });
		await act(async () =>
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, { requestTaskCommentBeforeMovingIntoDone: true }),
		);
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("检查通过"));
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(true);
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request?.phase).toBe("awaiting_confirmation");
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		await act(async () => requireSnapshot().cancelMoveToDone());
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
			phase: "editing",
			commentText: "检查通过",
		});
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("检查通过"));
		await act(async () => requireSnapshot().confirmMoveToDone());
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledOnce();
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
	});

	it.each(["取消评论确认", "在途结束后重试成功", "在途结束后重试失败"])(
		"同卡普通 Done 在途时保留带评论的 Skip Validation 确认：%s",
		async (followupAction) => {
			let finishOrdinaryMoveIntoDone: (() => void) | undefined;
			const ordinaryMoveIntoDoneCompletion = new Promise<void>((resolve) => {
				finishOrdinaryMoveIntoDone = resolve;
			});
			const programmaticCardMoves = mockProgrammaticCardMoves({
				requestMoveTaskToTrashWithAnimation: vi.fn(() => ordinaryMoveIntoDoneCompletion),
			});
			await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"), activeGroup: null });
			await act(async () =>
				requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, {
					requestTaskCommentBeforeMovingIntoDone: true,
				}),
			);
			await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("并发操作期间保留的评论"));
			const originalCommentId = requireSnapshot().taskCommentBeforeMoveIntoDone.request!.taskCommentEntryId;
			// 模拟确认期间看板广播先移入 Validation，随后普通 Done 动作开始，评论确认仍等待用户决定。
			await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"), activeGroup: null });
			await act(async () => requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID));
			expect(programmaticCardMoves.requestMoveTaskToTrashWithAnimation).toHaveBeenCalledOnce();
			expect(requireSnapshot().moveToTrashLoadingById[GATED_TASK_ID]).toBe(true);
			await act(async () => requireSnapshot().confirmMoveToDone());
			expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(true);
			expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
				phase: "awaiting_confirmation",
				taskCommentEntryId: originalCommentId,
				commentText: "并发操作期间保留的评论",
			});
			expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
			if (followupAction === "取消评论确认") {
				await act(async () => requireSnapshot().cancelMoveToDone());
				expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
				expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
					phase: "editing",
					taskCommentEntryId: originalCommentId,
					commentText: "并发操作期间保留的评论",
				});
			}
			await act(async () => finishOrdinaryMoveIntoDone!());
			expect(requireSnapshot().moveToTrashLoadingById[GATED_TASK_ID]).toBeFalsy();
			if (followupAction === "取消评论确认") {
				expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
				return;
			}
			if (followupAction === "在途结束后重试失败")
				moveTaskCardIntoDoneInWorkspaceMock.mockRejectedValueOnce(new Error("任务已完成，未提交本次评论"));
			await act(async () => requireSnapshot().confirmMoveToDone());
			expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
			expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledOnce();
			expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledWith(
				"project-1",
				expect.objectContaining({
					taskCommentToAppendWhenMovingIntoDone: {
						taskCommentEntryId: originalCommentId,
						commentText: "并发操作期间保留的评论",
					},
				}),
			);
			if (followupAction === "在途结束后重试失败")
				expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
					phase: "editing",
					taskCommentEntryId: originalCommentId,
					commentText: "并发操作期间保留的评论",
					errorMessage: "任务已完成，未提交本次评论",
				});
			else expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
		},
	);

	it("评论与 PDV 原因一并传递；取消原因确认时返回原评论", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		await act(async () =>
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, { requestTaskCommentBeforeMovingIntoDone: true }),
		);
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("有原因完成"));
		expect(
			requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone?.dialogRequest
				.taskCommentToAppendWhenMovingIntoDone?.commentText,
		).toBe("有原因完成");
		await act(async () => requireSnapshot().cancelPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone());
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
			phase: "editing",
			commentText: "有原因完成",
		});
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("有原因完成"));
		const closure = {
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "authored:guided",
					uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value" as const,
				},
			],
			confirmedAcknowledgements: ["skip_validation" as const],
		};
		await act(async () =>
			requireSnapshot().confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone({
				[GATED_TASK_ID]: closure,
			}),
		);
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({
				postDeployVerificationDoneEntryClosure: closure,
				taskCommentToAppendWhenMovingIntoDone: expect.objectContaining({ commentText: "有原因完成" }),
			}),
		);
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
	});

	it("网络失败保留评论，重试沿用同一评论 ID", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"), activeGroup: null });
		moveTaskCardIntoDoneInWorkspaceMock.mockRejectedValueOnce(new Error("网络失败"));
		await act(async () =>
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, { requestTaskCommentBeforeMovingIntoDone: true }),
		);
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("重试保留"));
		const failedRequest = requireSnapshot().taskCommentBeforeMoveIntoDone.request;
		expect(failedRequest).toMatchObject({
			phase: "editing",
			commentText: "重试保留",
			errorMessage: expect.stringContaining("网络失败"),
		});
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("重试保留"));
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenNthCalledWith(
			2,
			"project-1",
			expect.objectContaining({
				taskCommentToAppendWhenMovingIntoDone: expect.objectContaining({
					taskCommentEntryId: failedRequest?.taskCommentEntryId,
				}),
			}),
		);
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
	});

	it("评论已保存但响应丢失时，Done 广播后的同文重试结算草稿且不重复执行命令", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"), activeGroup: null });
		const persistedDoneBoard = createBoardWithTaskInColumn(GATED_TASK_ID, "trash");
		const persistedTask = persistedDoneBoard.columns.find((column) => column.id === "trash")!.cards[0]!;
		moveTaskCardIntoDoneInWorkspaceMock.mockImplementationOnce(async (_workspaceId, request) => {
			persistedTask.taskCommentEntries = [
				{ ...request.taskCommentToAppendWhenMovingIntoDone, createdAt: 2, updatedAt: 2 },
			];
			throw new Error("保存后的网络响应丢失");
		});
		await act(async () =>
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, { requestTaskCommentBeforeMovingIntoDone: true }),
		);
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("已保存的完成评论"));
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
			phase: "editing",
			commentText: "已保存的完成评论",
			errorMessage: "保存后的网络响应丢失",
		});
		await renderHarness({ board: persistedDoneBoard, activeGroup: null });
		await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("  已保存的完成评论  "));
		expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toBeNull();
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledOnce();
		expect(persistedTask.taskCommentEntries).toHaveLength(1);
	});

	it.each(["缺少本次评论", "同文但不同 ID", "同 ID 但不同正文", "重试时改写正文"])(
		"其他操作已移入 Done：%s 时保留草稿且不事后补加评论",
		async (mismatch) => {
			mockProgrammaticCardMoves();
			await renderHarness({ board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"), activeGroup: null });
			moveTaskCardIntoDoneInWorkspaceMock.mockRejectedValueOnce(new Error("网络失败"));
			await act(async () =>
				requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID, {
					requestTaskCommentBeforeMovingIntoDone: true,
				}),
			);
			await act(async () => requireSnapshot().confirmTaskCommentBeforeMoveIntoDone("尚待确认的完成评论"));
			const commentId = requireSnapshot().taskCommentBeforeMoveIntoDone.request!.taskCommentEntryId;
			const doneBoard = createBoardWithTaskInColumn(GATED_TASK_ID, "trash");
			const doneTask = doneBoard.columns.find((column) => column.id === "trash")!.cards[0]!;
			doneTask.taskCommentEntries =
				mismatch === "缺少本次评论"
					? []
					: [
							{
								taskCommentEntryId: mismatch === "同文但不同 ID" ? "另一条评论" : commentId,
								commentText: mismatch === "同 ID 但不同正文" ? "另一段正文" : "尚待确认的完成评论",
								createdAt: 2,
								updatedAt: 2,
							},
						];
			await renderHarness({ board: doneBoard, activeGroup: null });
			await act(async () =>
				requireSnapshot().confirmTaskCommentBeforeMoveIntoDone(
					mismatch === "重试时改写正文" ? "改写后的完成评论" : "尚待确认的完成评论",
				),
			);
			expect(requireSnapshot().taskCommentBeforeMoveIntoDone.request).toMatchObject({
				phase: "editing",
				errorMessage: expect.stringContaining("未提交评论"),
			});
			expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledOnce();
		},
	);

	it("卡片按钮移入 Done：有未勾项先开原因对话框（不弹跳过 Validation 的确认、不发命令），确认后带原因移列", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID);
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(false);
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		const closureDialog = requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone;
		expect(closureDialog?.taskEntries).toEqual([
			expect.objectContaining({
				taskId: GATED_TASK_ID,
				boardColumnIdOfTaskCardBeforeMoveIntoDone: "review",
				uncheckedChecklistItemsRequiringClosureReason: [
					{
						checklistItemId: "authored:guided",
						checklistItemLabel: "看板拖拽进 Done 弹出原因对话框",
						checklistItemKind: "guided_manual",
					},
				],
			}),
		]);

		const postDeployVerificationDoneEntryClosure = {
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "authored:guided",
					uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value" as const,
				},
			],
			confirmedAcknowledgements: ["skip_validation" as const],
		};
		await act(async () => {
			requireSnapshot().confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone({
				[GATED_TASK_ID]: postDeployVerificationDoneEntryClosure,
			});
		});
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({
				taskId: GATED_TASK_ID,
				boardMutationInitiator: "web_ui_user_gesture",
				postDeployVerificationDoneEntryClosure,
			}),
		);
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).toBeNull();
	});

	it("原因对话框确认时同卡另有命令在途：不发命令、给出提示、对话框保持打开；在途结束后再确认即可移列", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash(GATED_TASK_ID);
		});
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).not.toBeNull();

		// 另一处（Focus View / 跨项目面板）对同一张卡的命令还在路上。
		const finishOtherCommandInFlight = tryBeginTaskCardActionCommandInFlight(
			"project-1",
			GATED_TASK_ID,
			"update_task_card_field_values",
		);
		const postDeployVerificationDoneEntryClosure = {
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "authored:guided",
					uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value" as const,
				},
			],
			confirmedAcknowledgements: ["skip_validation" as const],
		};
		await act(async () => {
			requireSnapshot().confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone({
				[GATED_TASK_ID]: postDeployVerificationDoneEntryClosure,
			});
		});
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "warning" }));
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).not.toBeNull();
		expect(requireSnapshot().isPostDeployVerificationDoneEntryClosureForBoardMoveIntoDoneSubmitting).toBe(false);

		finishOtherCommandInFlight?.();
		await act(async () => {
			requireSnapshot().confirmPostDeployVerificationDoneEntryClosureForBoardMoveIntoDone({
				[GATED_TASK_ID]: postDeployVerificationDoneEntryClosure,
			});
		});
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledTimes(1);
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).toBeNull();
	});

	it("不受门禁的 Review 卡照旧弹跳过 Validation 的确认", async () => {
		mockProgrammaticCardMoves();
		await renderHarness({ board: createBoardWithTaskInColumn("task-free", "review"), activeGroup: null });
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash("task-free");
		});
		expect(requireSnapshot().isMoveToDoneConfirmOpen).toBe(true);
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).toBeNull();
	});

	it("用户拖拽进 Done：受门禁的卡不发命令（卡自然弹回），打开对话框并记住落点", async () => {
		const programmaticCardMoves = mockProgrammaticCardMoves();
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		const dropIntoDone: DropResult = {
			draggableId: GATED_TASK_ID,
			type: "CARD",
			source: { droppableId: "validation", index: 0 },
			destination: { droppableId: "trash", index: 0 },
			mode: "FLUID",
			reason: "DROP",
			combine: null,
		};
		await act(async () => {
			requireSnapshot().handleDragEnd(dropIntoDone);
		});
		expect(moveTaskCardIntoDoneInWorkspaceMock).not.toHaveBeenCalled();
		expect(programmaticCardMoves.resolvePendingProgrammaticTrashMove).toHaveBeenCalledWith(GATED_TASK_ID);
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone?.dialogRequest).toEqual(
			{
				taskId: GATED_TASK_ID,
				insertAtIndexWithinDoneBoardColumn: 0,
				runtimeRejectedMoveIntoDoneForMissingClosureReasons: false,
			},
		);
	});

	it("预检数据过期、服务端以 PRECONDITION_FAILED 拒绝：不弹通用错误，重拉读模型并打开对话框", async () => {
		// 非动画列的移入 Done 由 useProgrammaticCardMoves 直接转给 hook 注册的 requestMoveTaskToTrash。
		let registeredRequestMoveTaskToTrash:
			| ((taskId: string, fromColumnId: BoardColumnId, options?: object) => Promise<void>)
			| null = null;
		mockProgrammaticCardMoves({
			setRequestMoveTaskToTrashHandler: (
				handler: (taskId: string, fromColumnId: BoardColumnId, options?: object) => Promise<void>,
			) => {
				registeredRequestMoveTaskToTrash = handler;
			},
			requestMoveTaskToTrashWithAnimation: async (
				taskId: string,
				fromColumnId: BoardColumnId,
				options?: object,
			): Promise<void> => {
				await registeredRequestMoveTaskToTrash?.(taskId, fromColumnId, options);
			},
		});
		moveTaskCardIntoDoneInWorkspaceMock.mockRejectedValue(
			new Error(
				`${POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX} 还有 1 项未勾`,
			),
		);
		await renderHarness({ board: createBoardWithTaskInColumn("task-stale", "validation"), activeGroup: null });
		await act(async () => {
			requireSnapshot().handleMoveReviewCardToTrash("task-stale");
		});
		expect(moveTaskCardIntoDoneInWorkspaceMock).toHaveBeenCalledTimes(1);
		expect(notifyErrorMock).not.toHaveBeenCalled();
		expect(refreshPostDeployVerification).toHaveBeenCalled();
		const closureDialog = requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone;
		expect(closureDialog?.dialogRequest.runtimeRejectedMoveIntoDoneForMissingClosureReasons).toBe(true);
		expect(closureDialog?.taskEntries[0]?.runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel).toBe(true);
	});

	it("会话中断自动流转：受门禁的卡留在原列，只提示一次", async () => {
		const programmaticCardMoves = mockProgrammaticCardMoves();
		const interruptedSession: RuntimeTaskSessionSummary = {
			taskId: GATED_TASK_ID,
			state: "interrupted",
			agentId: "claude",
			workspacePath: null,
			pid: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: null,
			reviewReason: "interrupted",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		};
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "in_progress"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
			initialSessions: { [GATED_TASK_ID]: interruptedSession },
		});
		expect(programmaticCardMoves.tryProgrammaticCardMove).not.toHaveBeenCalledWith(
			GATED_TASK_ID,
			"in_progress",
			"trash",
			expect.anything(),
		);
		expect(currentBoard.columns.find((column) => column.id === "in_progress")?.cards.map((card) => card.id)).toEqual([
			GATED_TASK_ID,
		]);
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
	});

	it("自动 review 完成后的自动移入 Done：受门禁的卡不发起（连动画都不放）", async () => {
		const programmaticCardMoves = mockProgrammaticCardMoves();
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "review"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		await act(async () => {
			await capturedReviewAutoActionsOptions.latest?.requestMoveTaskToTrash(GATED_TASK_ID, "review", {
				boardMutationInitiator: "web_ui_client_automation_auto_review_commit_mode_completion",
			});
		});
		expect(programmaticCardMoves.requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
	});

	it("PDV 面板带原因完成：直接发命令（不走动画）并把服务端说明带回调用方", async () => {
		const programmaticCardMoves = mockProgrammaticCardMoves();
		const rejectionMessage = `${POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX} 新冒出 1 项`;
		moveTaskCardIntoDoneInWorkspaceMock.mockRejectedValue(new Error(rejectionMessage));
		await renderHarness({
			board: createBoardWithTaskInColumn(GATED_TASK_ID, "validation"),
			activeGroup: createActiveGroupWithTask(GATED_TASK_WITH_UNCHECKED_ITEM),
		});
		let completion: Awaited<
			ReturnType<UseBoardInteractionsResult["completePostDeployVerificationMoveToDone"]>
		> | null = null;
		await act(async () => {
			completion = await requireSnapshot().completePostDeployVerificationMoveToDone(GATED_TASK_ID, "validation", {
				closureReasonAppliedToRemainingUncheckedChecklistItems: {
					uncheckedChecklistItemClosureReasonCode:
						"assertion_obsolete_because_verified_behavior_changed_or_removed",
				},
			});
		});
		expect(programmaticCardMoves.requestMoveTaskToTrashWithAnimation).not.toHaveBeenCalled();
		expect(completion).toEqual({ ok: false, moveIntoDoneFailureMessage: rejectionMessage });
		// PDV 面板自有对话框：不另弹看板级对话框，也不弹通用错误。
		expect(requireSnapshot().postDeployVerificationDoneEntryClosureDialogForBoardMoveIntoDone).toBeNull();
		expect(notifyErrorMock).not.toHaveBeenCalled();
	});
});
