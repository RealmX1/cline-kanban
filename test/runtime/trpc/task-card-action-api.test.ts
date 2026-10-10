import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
} from "../../../src/core/kanban-cli-invocation-environment-actor-claims";
import type { KanbanRequestOriginActorEvidence } from "../../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import type { TaskMutationIntentWithResolvedActor } from "../../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

// taskCardAction.* 的单元测试：board 持久化漏斗换成内存假实现（照样执行 mutate 回调、尊重 save:false），
// 会话 / worktree 副作用换成记录调用顺序的桩，草稿 / 排队 prompt / checkpoint ref 清理同样只记顺序。
// 真实 runtime + 关系账本下的行动者归因见 test/integration/task-card-action-commands-through-runtime-procedure.integration.test.ts。

const harness = vi.hoisted(() => ({
	callOrder: [] as string[],
	workspaceState: {
		board: { columns: [] } as unknown,
		sessions: {} as Record<string, unknown>,
	},
	capturedTaskMutationIntents: [] as unknown[],
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	mutateWorkspaceState: async (
		cwd: string,
		taskMutationIntentWithResolvedActor: { taskMutationIntentKind: string },
		mutate: (state: unknown) => { board: unknown; value: unknown; save?: boolean },
	) => {
		harness.capturedTaskMutationIntents.push(taskMutationIntentWithResolvedActor);
		const currentState = {
			repoPath: cwd,
			statePath: "/tmp/state",
			git: { currentBranch: "main", defaultBranch: "main", branches: [] },
			board: harness.workspaceState.board,
			sessions: harness.workspaceState.sessions,
			revision: 1,
		};
		const mutation = mutate(currentState);
		if (mutation.save === false) {
			return { value: mutation.value, state: currentState, saved: false };
		}
		harness.workspaceState.board = mutation.board;
		harness.callOrder.push(`boardWrite:${taskMutationIntentWithResolvedActor.taskMutationIntentKind}`);
		return { value: mutation.value, state: { ...currentState, board: mutation.board }, saved: true };
	},
	loadPersistedWorkspaceStateById: async (workspaceId: string) => ({
		workspaceId,
		statePath: "/tmp/state",
		board: harness.workspaceState.board,
		sessions: harness.workspaceState.sessions,
		revision: 1,
	}),
	loadWorkspaceBoardById: async () => harness.workspaceState.board,
}));

vi.mock("../../../src/state/discard-task-edit-drafts-for-tasks-removed-from-board.js", () => ({
	discardTaskEditDraftsForDeletedTasks: async (_workspaceId: string, taskIds: readonly string[]) => {
		harness.callOrder.push(`discardTaskEditDrafts:${taskIds.join(",")}`);
	},
}));

vi.mock("../../../src/state/queued-task-prompt-delivery-store.js", () => ({
	discardQueuedTaskPromptDeliveriesForTasks: async (input: { taskIds: readonly string[] }) => {
		harness.callOrder.push(`discardQueuedTaskPromptDeliveries:${input.taskIds.join(",")}`);
		return { entriesByTaskId: {} };
	},
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	deleteAllTaskTurnCheckpointRefs: async (input: { cwd: string; taskId: string }) => {
		harness.callOrder.push(`deleteAllTaskTurnCheckpointRefs:${input.cwd}:${input.taskId}`);
	},
}));

import { createTaskCardActionApi } from "../../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../../src/trpc/task-card-action-per-task-command-serializer";

const WORKSPACE_SCOPE = { workspaceId: "workspace-b", workspacePath: "/tmp/repo-b" };

const KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};

// 空环境的 CLI 调用：声明头存在、行动者解析为「没有 task / 会话环境的 CLI 调用」，不触发任何 lookups。
const KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
		encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
			collectKanbanCliInvocationEnvironmentActorClaims({
				environment: {},
				invokingKanbanCliCodeVersion: "unit-test",
				invokingProcessWorkingDirectory: null,
			}),
		),
	),
};

function createCard(taskId: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: taskId,
		title: `title of ${taskId}`,
		prompt: `prompt of ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(cardsByColumnId: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cardsByColumnId.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cardsByColumnId.in_progress ?? [] },
			{ id: "review", title: "Review", cards: cardsByColumnId.review ?? [] },
			{ id: "validation", title: "Validation", cards: cardsByColumnId.validation ?? [] },
			{ id: "trash", title: "Done", cards: cardsByColumnId.trash ?? [] },
		],
	};
}

function createSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function seedWorkspace(board: RuntimeBoardData, sessions: Record<string, RuntimeTaskSessionSummary> = {}): void {
	harness.workspaceState.board = board;
	harness.workspaceState.sessions = sessions;
}

function readBoard(): RuntimeBoardData {
	return harness.workspaceState.board as RuntimeBoardData;
}

function readColumnTaskIds(columnId: RuntimeBoardColumnId): string[] {
	return (
		readBoard()
			.columns.find((column) => column.id === columnId)
			?.cards.map((card) => card.id) ?? []
	);
}

function readCapturedTaskMutationIntents(): TaskMutationIntentWithResolvedActor[] {
	return harness.capturedTaskMutationIntents as TaskMutationIntentWithResolvedActor[];
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createApiForTest() {
	const liveTaskSessionSummaryByTaskId = new Map<string, RuntimeTaskSessionSummary>();
	const startTaskSessionRequests: RuntimeTaskSessionStartRequest[] = [];
	const runtimeApi = {
		startTaskSession: vi.fn(async (_scope: unknown, request: RuntimeTaskSessionStartRequest) => {
			harness.callOrder.push(`startTaskSession:${request.taskId}`);
			startTaskSessionRequests.push(request);
			const summary = createSummary(request.taskId, { state: "running", reviewReason: null });
			liveTaskSessionSummaryByTaskId.set(request.taskId, summary);
			return { ok: true, summary } as { ok: boolean; summary: RuntimeTaskSessionSummary | null; error?: string };
		}),
		stopTaskSession: vi.fn(async (_scope: unknown, request: { taskId: string }) => {
			harness.callOrder.push(`stopTaskSession:${request.taskId}`);
			return { ok: true, summary: null };
		}),
		transitionTaskToReview: vi.fn(async (_scope: unknown, request: { taskId: string }) => {
			harness.callOrder.push(`transitionTaskToReview:${request.taskId}`);
			return { ok: true, summary: createSummary(request.taskId) } as {
				ok: boolean;
				summary: RuntimeTaskSessionSummary | null;
				error?: string;
			};
		}),
	};
	const workspaceApi = {
		ensureWorktree: vi.fn(async (_scope: unknown, request: { taskId: string; baseRef: string }) => {
			harness.callOrder.push(`ensureWorktree:${request.taskId}`);
			return {
				ok: true as const,
				path: `/tmp/worktrees/${request.taskId}`,
				baseRef: request.baseRef,
				baseCommit: "abc",
			};
		}),
		deleteWorktree: vi.fn(async (_scope: unknown, request: { taskId: string; worktreeMode?: string }) => {
			harness.callOrder.push(`deleteWorktree:${request.taskId}:${request.worktreeMode ?? "unspecified"}`);
			return { ok: true, removed: true };
		}),
	};
	const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
	const broadcastRuntimeProjectsUpdated = vi.fn();
	const onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards = vi.fn(() => {
		harness.callOrder.push("notifyQueuedTaskPromptDeliveryDispatcher");
	});
	const api = createTaskCardActionApi({
		kanbanActorResolutionLookups: {
			findWorkspaceIdByRepositoryPathForActorResolution: async () => WORKSPACE_SCOPE.workspaceId,
			findKanbanBoardCardIncarnationForActorResolution: async (_workspaceId, taskId) => {
				const card = readBoard()
					.columns.flatMap((column) => column.cards)
					.find((card) => card.id === taskId);
				return card
					? {
							taskIncarnationCreatedAtEpochMs: card.createdAt,
							workspaceRepositoryPath: WORKSPACE_SCOPE.workspacePath,
						}
					: null;
			},
		},
		runtimeApi: runtimeApi as unknown as Parameters<typeof createTaskCardActionApi>[0]["runtimeApi"],
		workspaceApi: workspaceApi as unknown as Parameters<typeof createTaskCardActionApi>[0]["workspaceApi"],
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		findTaskSessionSummaryLiveInRuntimeProcessMemory: (_workspaceId, taskId) =>
			liveTaskSessionSummaryByTaskId.get(taskId) ?? null,
		taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
		onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards,
	});
	return {
		api,
		runtimeApi,
		workspaceApi,
		liveTaskSessionSummaryByTaskId,
		startTaskSessionRequests,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards,
	};
}

beforeEach(() => {
	harness.callOrder.length = 0;
	harness.capturedTaskMutationIntents.length = 0;
	seedWorkspace(createBoard({}));
});

describe("taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress", () => {
	it("先移列到 in_progress（落盘并广播）→ ensure worktree → 用卡片全字段起会话", async () => {
		seedWorkspace(
			createBoard({
				backlog: [
					createCard("task-a", {
						images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png" }],
						taskConversationMode: "exploratory",
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
						worktreeMode: "branch",
					}),
				],
				in_progress: [createCard("task-existing")],
			}),
		);
		const { api, startTaskSessionRequests, broadcastRuntimeWorkspaceStateUpdated, broadcastRuntimeProjectsUpdated } =
			createApiForTest();

		const response = await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{
				taskId: "task-a",
				boardMutationInitiator: "web_ui_user_gesture",
				agentTerminalGeometryForTaskSessionSpawn: { cols: 132, rows: 40 },
				insertAtIndexWithinInProgressBoardColumn: 1,
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(harness.callOrder).toEqual([
			"boardWrite:web_ui_task_card_action_start_agent_session_moving_into_in_progress",
			"ensureWorktree:task-a",
			"startTaskSession:task-a",
		]);
		// 拖放落点被保留（列里原有一张卡，落在它下面）。
		expect(readColumnTaskIds("in_progress")).toEqual(["task-existing", "task-a"]);
		expect(response).toMatchObject({
			boardColumnIdOfTaskCardBeforeAction: "backlog",
			taskCardWasMovedIntoInProgressColumnByThisAction: true,
			agentSessionStartOutcome: "agent_session_started",
			agentSessionStartFailureMessage: null,
			taskCardSnapshotAfterAction: {
				boardColumnIdContainingTaskCard: "in_progress",
				taskSessionSummaryLiveInRuntimeProcessMemory: { taskId: "task-a", state: "running" },
			},
		});
		// CLI 旧映射漏掉的字段：附图、会话模式、终端 agent 模型覆盖；外加浏览器给的 PTY 几何。
		expect(startTaskSessionRequests[0]).toMatchObject({
			taskId: "task-a",
			prompt: "prompt of task-a",
			images: [{ id: "image-1" }],
			taskConversationMode: "exploratory",
			terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
			worktreeMode: "branch",
			cols: 132,
			rows: 40,
		});
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-b", "/tmp/repo-b");
		expect(broadcastRuntimeProjectsUpdated).toHaveBeenCalledWith("workspace-b");
	});

	it("会话启动失败 / worktree 准备失败时卡留在 in_progress，失败如实回传而不抛错", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a"), createCard("task-b")] }));
		const { api, runtimeApi, workspaceApi } = createApiForTest();
		runtimeApi.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "spawn exploded" });
		workspaceApi.ensureWorktree.mockResolvedValueOnce({
			ok: true,
			path: "/tmp/worktrees/task-a",
			baseRef: "main",
			baseCommit: "abc",
		});
		const startFailure = await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		workspaceApi.ensureWorktree.mockResolvedValueOnce({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			error: "lock wait timed out",
		} as never);
		const ensureFailure = await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-b" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(startFailure).toMatchObject({
			agentSessionStartOutcome: "agent_session_start_failed",
			agentSessionStartFailureMessage: "spawn exploded",
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "in_progress" },
		});
		expect(ensureFailure).toMatchObject({
			agentSessionStartOutcome: "task_worktree_ensure_failed",
			agentSessionStartFailureMessage: "lock wait timed out",
		});
		expect(readColumnTaskIds("in_progress").sort()).toEqual(["task-a", "task-b"]);
		expect(readColumnTaskIds("backlog")).toEqual([]);
		expect(harness.callOrder).not.toContain("startTaskSession:task-b");
	});

	it("双击开始：两条命令按卡串行，第二条看到会话已在 agent 回合，不重复起会话也不重复写盘", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a")] }));
		const { api, runtimeApi, liveTaskSessionSummaryByTaskId } = createApiForTest();
		const firstStartReleased = createDeferred<void>();
		runtimeApi.startTaskSession.mockImplementationOnce(async (_scope, request) => {
			harness.callOrder.push(`startTaskSession:${request.taskId}`);
			await firstStartReleased.promise;
			const summary = createSummary(request.taskId, { state: "running", reviewReason: null });
			liveTaskSessionSummaryByTaskId.set(request.taskId, summary);
			return { ok: true, summary };
		});

		const firstStart = api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		const secondStart = api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		await vi.waitFor(() => expect(harness.callOrder).toContain("startTaskSession:task-a"));
		// 第一条还卡在起会话时，第二条连 board 都还没碰。
		expect(harness.capturedTaskMutationIntents).toHaveLength(1);
		firstStartReleased.resolve();

		const [firstResponse, secondResponse] = await Promise.all([firstStart, secondStart]);
		expect(firstResponse.agentSessionStartOutcome).toBe("agent_session_started");
		expect(secondResponse).toMatchObject({
			agentSessionStartOutcome: "agent_session_already_in_agent_turn_so_start_was_skipped",
			taskCardWasMovedIntoInProgressColumnByThisAction: false,
			boardColumnIdOfTaskCardBeforeAction: "in_progress",
		});
		expect(runtimeApi.startTaskSession).toHaveBeenCalledTimes(1);
		expect(harness.callOrder.filter((entry) => entry.startsWith("boardWrite:"))).toHaveLength(1);
	});

	it("去重只采信 runtime 内存摘要：重启后未加载项目的持久化摘要仍声称 agent 回合，start 照样起会话", async () => {
		// sessions.json 里是重启前的快照（agent 回合、带 pid），而本 runtime 还没加载这个项目：内存查询为 null。
		seedWorkspace(createBoard({ in_progress: [createCard("task-a")] }), {
			"task-a": createSummary("task-a", { state: "running", reviewReason: null, pid: 4242 }),
		});
		const { api, runtimeApi } = createApiForTest();

		const response = await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(runtimeApi.startTaskSession).toHaveBeenCalledTimes(1);
		expect(harness.callOrder).toEqual(["ensureWorktree:task-a", "startTaskSession:task-a"]);
		expect(response).toMatchObject({
			agentSessionStartOutcome: "agent_session_started",
			taskCardSnapshotAfterAction: {
				// 持久化摘要仍原样放进响应快照，只是不再拿它做去重决策。
				taskSessionSummaryPersistedInWorkspaceSessionsFile: { taskId: "task-a", state: "running", pid: 4242 },
			},
		});
	});

	it("内存摘要在 agent 回合时照旧跳过启动，不 ensure、不起会话", async () => {
		seedWorkspace(createBoard({ in_progress: [createCard("task-a")] }));
		const { api, runtimeApi, workspaceApi, liveTaskSessionSummaryByTaskId } = createApiForTest();
		liveTaskSessionSummaryByTaskId.set("task-a", createSummary("task-a", { state: "running", reviewReason: null }));

		const response = await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(response.agentSessionStartOutcome).toBe("agent_session_already_in_agent_turn_so_start_was_skipped");
		expect(runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(workspaceApi.ensureWorktree).not.toHaveBeenCalled();
	});

	it("只收 backlog / in_progress 的卡；卡不存在时 NOT_FOUND 文案与迁移前 CLI 一致", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r")] }));
		const { api, runtimeApi } = createApiForTest();

		await expect(
			api.startTaskCardAgentSessionMovingItIntoInProgress(
				WORKSPACE_SCOPE,
				{ taskId: "task-r" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: 'Task "task-r" is in "review" and can only be started from backlog or in_progress.',
		});
		await expect(
			api.startTaskCardAgentSessionMovingItIntoInProgress(
				WORKSPACE_SCOPE,
				{ taskId: "nope1" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND", message: 'Task "nope1" was not found in workspace /tmp/repo-b.' });
		expect(runtimeApi.startTaskSession).not.toHaveBeenCalled();
	});
});

describe("taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree", () => {
	it("移入 Done → 并行停 agent 会话与详情 shell 终端 → 按卡片 worktreeMode 删 worktree", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r", { worktreeMode: "inplace" })] }), {
			"task-r": createSummary("task-r"),
		});
		const { api } = createApiForTest();

		const response = await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-r", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(harness.callOrder[0]).toBe("boardWrite:web_ui_task_card_action_move_into_done");
		expect(harness.callOrder.slice(1, 3).sort()).toEqual([
			"stopTaskSession:__detail_terminal__:task-r",
			"stopTaskSession:task-r",
		]);
		expect(harness.callOrder[3]).toBe("deleteWorktree:task-r:inplace");
		expect(readColumnTaskIds("trash")).toEqual(["task-r"]);
		expect(response).toMatchObject({
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
			taskAgentSessionStopWasRequested: true,
			taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
			taskCardSnapshotAfterAction: {
				boardColumnIdContainingTaskCard: "trash",
				taskSessionSummaryPersistedInWorkspaceSessionsFile: { taskId: "task-r" },
			},
		});
	});

	it("从 backlog 移入 Done：backlog 从没起过 agent 会话，只停详情终端", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-b")] }));
		const { api } = createApiForTest();

		const response = await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-b" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(harness.callOrder).toEqual([
			"boardWrite:kanban_cli_task_trash",
			"stopTaskSession:__detail_terminal__:task-b",
			"deleteWorktree:task-b:unspecified",
		]);
		expect(response.taskAgentSessionStopWasRequested).toBe(false);
	});

	it("拖放落点贯穿到服务端：带下标时落在 Done 列该位置，不带时（CLI / 程序化）落在列顶", async () => {
		seedWorkspace(
			createBoard({
				review: [createCard("task-dropped"), createCard("task-default")],
				trash: [createCard("task-done-1"), createCard("task-done-2")],
			}),
		);
		const { api } = createApiForTest();

		await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{
				taskId: "task-dropped",
				boardMutationInitiator: "web_ui_user_gesture",
				insertAtIndexWithinDoneBoardColumn: 1,
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(readColumnTaskIds("trash")).toEqual(["task-done-1", "task-dropped", "task-done-2"]);

		await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-default" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);
		expect(readColumnTaskIds("trash")).toEqual(["task-default", "task-done-1", "task-dropped", "task-done-2"]);
	});

	it("本来就在 Done：不写盘、不停会话、不删 worktree（中断自动流转进 Done 的卡要留着 worktree 供恢复）", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t")] }));
		const { api, broadcastRuntimeProjectsUpdated } = createApiForTest();

		const response = await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-t" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(harness.callOrder).toEqual([]);
		expect(broadcastRuntimeProjectsUpdated).not.toHaveBeenCalled();
		expect(response).toMatchObject({
			taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: true,
			taskWorktreeDeletionResult: null,
			boardColumnIdOfTaskCardBeforeAction: "trash",
		});
	});

	it("删 worktree 失败不让动作失败，原因如实带回", async () => {
		seedWorkspace(createBoard({ validation: [createCard("task-v")] }));
		const { api, workspaceApi } = createApiForTest();
		workspaceApi.deleteWorktree.mockResolvedValueOnce({
			ok: false,
			removed: false,
			error: "worktree is locked",
		} as never);

		const response = await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-v" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response.taskWorktreeDeletionResult).toEqual({
			taskWorktreeWasRemoved: false,
			taskWorktreeDeletionErrorMessage: "worktree is locked",
		});
		expect(readColumnTaskIds("trash")).toEqual(["task-v"]);
	});
});

describe("taskCardAction.restoreTaskCardFromDoneIntoReviewResumingAgentSession", () => {
	it("移回 review 并在同一次写盘里关掉自动 review → ensure → 以 resumeFromTrash 续跑（不重投 prompt / 附图）", async () => {
		seedWorkspace(
			createBoard({
				trash: [
					createCard("task-t", {
						autoReviewEnabled: true,
						autoReviewMode: "pr",
						images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png" }],
					}),
				],
			}),
		);
		const { api, startTaskSessionRequests } = createApiForTest();

		const response = await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-t", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(harness.callOrder).toEqual([
			"boardWrite:web_ui_task_card_action_restore_from_done_into_review",
			"ensureWorktree:task-t",
			"startTaskSession:task-t",
		]);
		expect(startTaskSessionRequests[0]).toMatchObject({ taskId: "task-t", prompt: "", resumeFromTrash: true });
		expect(startTaskSessionRequests[0]?.images).toBeUndefined();
		expect(startTaskSessionRequests[0]?.startInPlanMode).toBeUndefined();
		expect(response).toMatchObject({
			taskCardRestoreFromDoneOutcome: "agent_session_resumed_and_task_card_kept_in_review",
			resumedAgentSessionSummary: { taskId: "task-t" },
			taskCardSnapshotAfterAction: {
				boardColumnIdContainingTaskCard: "review",
				taskCard: { autoReviewEnabled: false, autoReviewMode: "commit" },
			},
		});
	});

	it("ensure / 续跑还挂着时广播出去的 review 卡已经关掉自动 review（浏览器自动 commit / 开 PR 不会抢跑）", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t", { autoReviewEnabled: true, autoReviewMode: "pr" })] }));
		const { api, workspaceApi, broadcastRuntimeWorkspaceStateUpdated } = createApiForTest();
		const ensureWorktreeReleased = createDeferred<void>();
		workspaceApi.ensureWorktree.mockImplementationOnce(async (_scope, request) => {
			harness.callOrder.push(`ensureWorktree:${request.taskId}`);
			await ensureWorktreeReleased.promise;
			return {
				ok: true as const,
				path: `/tmp/worktrees/${request.taskId}`,
				baseRef: request.baseRef,
				baseCommit: "abc",
			};
		});

		const restore = api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-t", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		await vi.waitFor(() => expect(harness.callOrder).toContain("ensureWorktree:task-t"));

		// 移回 review 那次写盘已经广播；此刻浏览器读到的 review 卡必须已经不带自动动作。
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
		const reviewCardWhileRestoreIsPending = readBoard()
			.columns.find((column) => column.id === "review")
			?.cards.find((card) => card.id === "task-t");
		expect(reviewCardWhileRestoreIsPending).toMatchObject({ autoReviewEnabled: false, autoReviewMode: "commit" });

		ensureWorktreeReleased.resolve();
		const response = await restore;
		expect(response.taskCardRestoreFromDoneOutcome).toBe("agent_session_resumed_and_task_card_kept_in_review");
		// 续跑成功之后不再有第二次写盘。
		expect(harness.callOrder.filter((entry) => entry.startsWith("boardWrite:"))).toEqual([
			"boardWrite:web_ui_task_card_action_restore_from_done_into_review",
		]);
	});

	it("恢复失败移回 Done 时，自动 review 开关还原成恢复前的值（与浏览器旧路径失败时不动开关一致）", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t", { autoReviewEnabled: true, autoReviewMode: "pr" })] }));
		const { api, runtimeApi } = createApiForTest();
		runtimeApi.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "no resumable session" });

		const response = await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-t" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response).toMatchObject({
			taskCardRestoreFromDoneOutcome: "agent_session_resume_failed_so_task_card_was_moved_back_into_done",
			taskCardSnapshotAfterAction: {
				boardColumnIdContainingTaskCard: "trash",
				taskCard: { autoReviewEnabled: true, autoReviewMode: "pr" },
			},
		});
		expect(readBoard().columns.find((column) => column.id === "trash")?.cards[0]).toMatchObject({
			id: "task-t",
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		});
	});

	it("worktree 准备失败：卡移回 Done，不起会话", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t")] }));
		const { api, runtimeApi, workspaceApi } = createApiForTest();
		workspaceApi.ensureWorktree.mockResolvedValueOnce({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			error: "base ref is gone",
		} as never);

		const response = await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-t" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response).toMatchObject({
			taskCardRestoreFromDoneOutcome: "task_worktree_ensure_failed_so_task_card_was_moved_back_into_done",
			taskCardRestoreFromDoneFailureMessage: "base ref is gone",
			resumedAgentSessionSummary: null,
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "trash" },
		});
		expect(runtimeApi.startTaskSession).not.toHaveBeenCalled();
		expect(workspaceApi.ensureWorktree).toHaveBeenCalledTimes(1);
		expect(readColumnTaskIds("trash")).toEqual(["task-t"]);
		expect(harness.callOrder).toEqual([
			"boardWrite:web_ui_task_card_action_restore_from_done_into_review",
			"boardWrite:web_ui_task_card_action_move_back_into_done_after_failed_restore",
		]);
	});

	it("续跑失败：卡移回 Done，失败如实回传", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t")] }));
		const { api, runtimeApi } = createApiForTest();
		runtimeApi.startTaskSession.mockResolvedValueOnce({ ok: false, summary: null, error: "no resumable session" });

		const response = await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-t" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response).toMatchObject({
			taskCardRestoreFromDoneOutcome: "agent_session_resume_failed_so_task_card_was_moved_back_into_done",
			taskCardRestoreFromDoneFailureMessage: "no resumable session",
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "trash" },
		});
		expect(readColumnTaskIds("trash")).toEqual(["task-t"]);
		expect(readColumnTaskIds("review")).toEqual([]);
	});

	it("拖放落点贯穿到服务端：带下标时落在 review 列该位置，不带时落在列顶", async () => {
		seedWorkspace(
			createBoard({
				review: [createCard("task-review-1"), createCard("task-review-2")],
				trash: [createCard("task-dropped"), createCard("task-default")],
			}),
		);
		const { api } = createApiForTest();

		const droppedResponse = await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{
				taskId: "task-dropped",
				boardMutationInitiator: "web_ui_user_gesture",
				insertAtIndexWithinReviewBoardColumn: 1,
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(droppedResponse.taskCardRestoreFromDoneOutcome).toBe("agent_session_resumed_and_task_card_kept_in_review");
		expect(readColumnTaskIds("review")).toEqual(["task-review-1", "task-dropped", "task-review-2"]);

		await api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
			WORKSPACE_SCOPE,
			{ taskId: "task-default" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);
		expect(readColumnTaskIds("review")).toEqual(["task-default", "task-review-1", "task-dropped", "task-review-2"]);
	});

	it("只收 Done 里的卡", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r")] }));
		const { api } = createApiForTest();

		await expect(
			api.restoreTaskCardFromDoneIntoReviewResumingAgentSession(
				WORKSPACE_SCOPE,
				{ taskId: "task-r" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(harness.callOrder).toEqual([]);
	});
});

describe("taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup", () => {
	// 回归锚点（迁自 task-delete-checkpoint-refs-cleanup-order.test.ts）：turn checkpoint refs 批删必须排在会话停止与
	// worktree 清理**之后**。hooks-api 的 to_review checkpoint 捕获是 runtime 侧不 await 的后台任务；若先批删，枚举
	// 完成后在途捕获仍可能 update-ref，给已删除任务留下再无清理方的孤儿 ref。
	it("收尾链严格按序：board 删卡 → 草稿 → 排队 prompt（并通知出队引擎）→ 停会话 → 删 worktree → 最后批删 checkpoint ref", async () => {
		seedWorkspace(createBoard({ in_progress: [createCard("task-1", { worktreeMode: "branch" })] }), {
			"task-1": createSummary("task-1"),
		});
		const { api, onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards } = createApiForTest();

		const response = await api.permanentlyDeleteTaskCardsWithFullResourceCleanup(
			WORKSPACE_SCOPE,
			{
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
					selectedTaskIds: ["task-1"],
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(harness.callOrder.slice(0, 4)).toEqual([
			"boardWrite:kanban_cli_task_delete",
			"discardTaskEditDrafts:task-1",
			"discardQueuedTaskPromptDeliveries:task-1",
			"notifyQueuedTaskPromptDeliveryDispatcher",
		]);
		expect(harness.callOrder.slice(4, 6).sort()).toEqual([
			"stopTaskSession:__detail_terminal__:task-1",
			"stopTaskSession:task-1",
		]);
		// 批删必须是整条收尾链的最后一步——给 runtime 侧在途捕获最大收敛窗口；入参用 workspace 主仓路径。
		expect(harness.callOrder.slice(6)).toEqual([
			"deleteWorktree:task-1:branch",
			"deleteAllTaskTurnCheckpointRefs:/tmp/repo-b:task-1",
		]);
		expect(onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards).toHaveBeenCalledWith("workspace-b", {
			entriesByTaskId: {},
		});
		expect(response.permanentlyDeletedTaskCards).toEqual([
			expect.objectContaining({
				deletedTaskCard: expect.objectContaining({ id: "task-1" }),
				boardColumnIdOfDeletedTaskCardBeforeDeletion: "in_progress",
				taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion: expect.objectContaining({
					taskId: "task-1",
				}),
				taskWorktreeDeletionResult: { taskWorktreeWasRemoved: true, taskWorktreeDeletionErrorMessage: null },
			}),
		]);
		expect(readBoard().columns.flatMap((column) => column.cards)).toEqual([]);
	});

	it("整列删除 Done：Done 里的会话已在移入时停过，只停详情终端；列空时什么都不做", async () => {
		seedWorkspace(createBoard({ trash: [createCard("task-t1"), createCard("task-t2")] }));
		const { api } = createApiForTest();

		const response = await api.permanentlyDeleteTaskCardsWithFullResourceCleanup(
			WORKSPACE_SCOPE,
			{
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
					selectedBoardColumnId: "trash",
				},
				boardMutationInitiator: "web_ui_user_gesture",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(response.permanentlyDeletedTaskCards.map(({ deletedTaskCard }) => deletedTaskCard.id)).toEqual([
			"task-t1",
			"task-t2",
		]);
		expect(harness.callOrder.filter((entry) => entry.startsWith("stopTaskSession:"))).toEqual([
			"stopTaskSession:__detail_terminal__:task-t1",
			"stopTaskSession:__detail_terminal__:task-t2",
		]);

		harness.callOrder.length = 0;
		const emptyColumnResponse = await api.permanentlyDeleteTaskCardsWithFullResourceCleanup(
			WORKSPACE_SCOPE,
			{
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
					selectedBoardColumnId: "trash",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(emptyColumnResponse).toEqual({ permanentlyDeletedTaskCards: [] });
		expect(harness.callOrder).toEqual([]);
	});

	it("整列删除只删发起那一刻列里的卡：预读之后才进列、自己的 start 还挂着的卡不删，会话与 worktree 不受影响", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a"), createCard("task-b")] }));
		const { api, workspaceApi } = createApiForTest();
		const ensureWorktreeReleasedByTaskId = new Map([
			["task-a", createDeferred<void>()],
			["task-b", createDeferred<void>()],
		]);
		workspaceApi.ensureWorktree.mockImplementation(async (_scope, request) => {
			harness.callOrder.push(`ensureWorktree:${request.taskId}`);
			await ensureWorktreeReleasedByTaskId.get(request.taskId)?.promise;
			return {
				ok: true as const,
				path: `/tmp/worktrees/${request.taskId}`,
				baseRef: request.baseRef,
				baseCommit: "abc",
			};
		});

		// start(A)：移进 in_progress 后挂在 ensure。
		const startOfTaskA = api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		await vi.waitFor(() => expect(harness.callOrder).toContain("ensureWorktree:task-a"));
		// 整列删除 in_progress：锁外预读到 A，排在 start(A) 后面。
		const deletionOfInProgressColumn = api.permanentlyDeleteTaskCardsWithFullResourceCleanup(
			WORKSPACE_SCOPE,
			{
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
					selectedBoardColumnId: "in_progress",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// start(B)：B 不在删除的串行键里，立刻移进 in_progress，挂在 ensure。
		const startOfTaskB = api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-b" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		await vi.waitFor(() => expect(harness.callOrder).toContain("ensureWorktree:task-b"));
		expect(readColumnTaskIds("in_progress").sort()).toEqual(["task-a", "task-b"]);

		// start(A) 落定 → 删除执行：只删预读集合里仍在该列的 A。
		ensureWorktreeReleasedByTaskId.get("task-a")?.resolve();
		await expect(startOfTaskA).resolves.toMatchObject({ agentSessionStartOutcome: "agent_session_started" });
		const deletionResponse = await deletionOfInProgressColumn;
		expect(deletionResponse.permanentlyDeletedTaskCards.map(({ deletedTaskCard }) => deletedTaskCard.id)).toEqual([
			"task-a",
		]);
		expect(readColumnTaskIds("in_progress")).toEqual(["task-b"]);
		expect(harness.callOrder).toContain("stopTaskSession:task-a");
		expect(harness.callOrder).toContain("discardTaskEditDrafts:task-a");
		expect(harness.callOrder.filter((entry) => entry.endsWith(":task-b") || entry.includes(":task-b:"))).toEqual([
			"ensureWorktree:task-b",
		]);
		expect(harness.callOrder.filter((entry) => entry.startsWith("deleteWorktree:"))).toEqual([
			"deleteWorktree:task-a:unspecified",
		]);

		// B 的 start 放行后照常起会话，卡仍在 in_progress、看板上可管理。
		ensureWorktreeReleasedByTaskId.get("task-b")?.resolve();
		await expect(startOfTaskB).resolves.toMatchObject({
			agentSessionStartOutcome: "agent_session_started",
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "in_progress" },
		});
		expect(readColumnTaskIds("in_progress")).toEqual(["task-b"]);
	});

	it("按 id 选中而有一张不在 board 上：整批 NOT_FOUND、什么都不删", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r")] }));
		const { api } = createApiForTest();

		await expect(
			api.permanentlyDeleteTaskCardsWithFullResourceCleanup(
				WORKSPACE_SCOPE,
				{
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: ["task-r", "nope1"],
					},
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(readColumnTaskIds("review")).toEqual(["task-r"]);
		expect(harness.callOrder).toEqual([]);
	});
});

describe("taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects", () => {
	it("review → validation 保留落点、不碰会话；有会话副作用的移列被拒绝", async () => {
		seedWorkspace(
			createBoard({
				review: [createCard("task-r")],
				validation: [createCard("task-v1"), createCard("task-v2")],
			}),
		);
		const { api, runtimeApi } = createApiForTest();

		const response = await api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
			WORKSPACE_SCOPE,
			{ taskId: "task-r", targetBoardColumnId: "validation", insertAtIndexWithinTargetBoardColumn: 1 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(response).toMatchObject({
			boardColumnIdOfTaskCardBeforeAction: "review",
			taskCardPlacementWasChangedByThisAction: true,
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "validation" },
		});
		expect(readColumnTaskIds("validation")).toEqual(["task-v1", "task-r", "task-v2"]);

		await expect(
			api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
				WORKSPACE_SCOPE,
				{ taskId: "task-v1", targetBoardColumnId: "trash" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
				WORKSPACE_SCOPE,
				{ taskId: "task-v1", targetBoardColumnId: "in_progress" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(runtimeApi.stopTaskSession).not.toHaveBeenCalled();
	});

	it("in_progress 列内重排：只改顺序、不推进 updatedAt；落点就是原位时不写盘", async () => {
		seedWorkspace(createBoard({ in_progress: [createCard("task-1"), createCard("task-2"), createCard("task-3")] }));
		const { api } = createApiForTest();

		await api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
			WORKSPACE_SCOPE,
			{ taskId: "task-1", targetBoardColumnId: "in_progress", insertAtIndexWithinTargetBoardColumn: 2 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(readColumnTaskIds("in_progress")).toEqual(["task-2", "task-3", "task-1"]);
		expect(readBoard().columns.find((column) => column.id === "in_progress")?.cards[2]?.updatedAt).toBe(1);

		const unchanged = await api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
			WORKSPACE_SCOPE,
			{ taskId: "task-1", targetBoardColumnId: "in_progress", insertAtIndexWithinTargetBoardColumn: 2 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(unchanged.taskCardPlacementWasChangedByThisAction).toBe(false);
	});
});

describe("taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser", () => {
	it("先把回合翻给用户、再显式移列到 review（跨项目时没有浏览器跑 Rule A）", async () => {
		seedWorkspace(createBoard({ in_progress: [createCard("task-p")] }));
		const { api } = createApiForTest();

		const response = await api.moveTaskCardIntoReviewByHandingTurnToUser(
			WORKSPACE_SCOPE,
			{ taskId: "task-p", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(harness.callOrder).toEqual([
			"transitionTaskToReview:task-p",
			"boardWrite:web_ui_task_card_action_move_into_review_handing_agent_turn_to_user",
		]);
		expect(response).toMatchObject({
			agentTurnHandoffToUserOutcome: "agent_turn_handed_to_user",
			taskCardWasMovedIntoReviewColumnByThisAction: true,
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "review" },
		});
	});

	it("翻回合失败不移列；不在 in_progress 的卡连回合都不翻", async () => {
		seedWorkspace(createBoard({ in_progress: [createCard("task-p")], validation: [createCard("task-v")] }));
		const { api, runtimeApi } = createApiForTest();
		runtimeApi.transitionTaskToReview.mockResolvedValueOnce({ ok: false, summary: null });

		const failed = await api.moveTaskCardIntoReviewByHandingTurnToUser(
			WORKSPACE_SCOPE,
			{ taskId: "task-p" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(failed).toMatchObject({
			agentTurnHandoffToUserOutcome: "agent_turn_handoff_to_user_failed",
			taskCardWasMovedIntoReviewColumnByThisAction: false,
			taskCardSnapshotAfterAction: { boardColumnIdContainingTaskCard: "in_progress" },
		});
		expect(readColumnTaskIds("in_progress")).toEqual(["task-p"]);

		await expect(
			api.moveTaskCardIntoReviewByHandingTurnToUser(
				WORKSPACE_SCOPE,
				{ taskId: "task-v" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(runtimeApi.transitionTaskToReview).toHaveBeenCalledTimes(1);
	});
});

describe("taskCardAction.updateTaskCardFieldValues", () => {
	it("CLI 原始输入：在锁内与最新卡片合并，未传字段保留现值", async () => {
		seedWorkspace(
			createBoard({
				backlog: [createCard("task-a", { clineSettings: { providerId: "anthropic", modelId: "claude-sonnet" } })],
			}),
		);
		const { api } = createApiForTest();

		const response = await api.updateTaskCardFieldValues(
			WORKSPACE_SCOPE,
			{
				taskId: "task-a",
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
					kanbanCliTaskCardFieldUpdateRawInput: { title: "renamed", clineReasoningEffort: "high" },
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		expect(response.taskCardSnapshotAfterAction.taskCard).toMatchObject({
			title: "renamed",
			prompt: "prompt of task-a",
			clineSettings: { providerId: "anthropic", modelId: "claude-sonnet", reasoningEffort: "high" },
		});
		expect(harness.callOrder).toEqual(["boardWrite:kanban_cli_task_update"]);
	});

	it("三态 patch：缺省保留、null 清除；改了会话初始化就一并清掉遗留 parentSessionId", async () => {
		seedWorkspace(
			createBoard({
				review: [
					createCard("task-r", {
						agentId: "codex",
						autoReviewEnabled: true,
						autoReviewMode: "pr",
						parentSessionId: "11111111-2222-4333-8444-555555555555",
						clineSettings: { providerId: "anthropic" },
					}),
				],
			}),
		);
		const { api } = createApiForTest();

		const response = await api.updateTaskCardFieldValues(
			WORKSPACE_SCOPE,
			{
				taskId: "task-r",
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: {
						autoReviewEnabled: false,
						clineSettings: null,
						taskAgentSessionInitialization: null,
					},
				},
				boardMutationInitiator: "web_ui_user_gesture",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		const updatedCard = response.taskCardSnapshotAfterAction.taskCard;
		expect(updatedCard).toMatchObject({
			agentId: "codex",
			autoReviewEnabled: false,
			autoReviewMode: "pr",
			prompt: "prompt of task-r",
		});
		expect(updatedCard.clineSettings).toBeUndefined();
		expect(updatedCard.parentSessionId).toBeUndefined();
		expect(updatedCard.taskAgentSessionInitialization).toBeUndefined();
		expect(response.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("review");
	});

	it("非法输入组合转成 BAD_REQUEST，不写盘", async () => {
		seedWorkspace(
			createBoard({
				backlog: [
					createCard("task-a", {
						agentId: "claude",
						taskAgentSessionInitialization: {
							sourceAgentId: "claude",
							sourceSessionId: "11111111-2222-4333-8444-555555555555",
							sourceSessionReuseMode: "resume_existing_session",
						},
					}),
				],
			}),
		);
		const { api } = createApiForTest();

		await expect(
			api.updateTaskCardFieldValues(
				WORKSPACE_SCOPE,
				{
					taskId: "task-a",
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
						kanbanCliTaskCardFieldUpdateRawInput: {
							agentId: "codex",
							taskAgentSessionInitializationMode: "fork_existing_session",
						},
					},
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Changing the session reuse mode while switching agents also requires --agent-session-initialization-id.",
		});
		expect(harness.callOrder).toEqual([]);
	});
});

// 迁自 workspace-api.test.ts 的 setTaskPinboardPinStateOfTaskCard 段。
describe("taskCardAction.setTaskPinboardPinStateOfTaskCard", () => {
	it("置顶：写入置顶时刻与原因、不推进 updatedAt，并广播", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-review")] }));
		const { api, broadcastRuntimeWorkspaceStateUpdated, broadcastRuntimeProjectsUpdated } = createApiForTest();

		const response = await api.setTaskPinboardPinStateOfTaskCard(
			WORKSPACE_SCOPE,
			{
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskId: "task-review",
				taskPinboardPinReason: " watch it ",
				boardMutationInitiator: "web_ui_user_gesture",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response.boardWasSaved).toBe(true);
		const pinnedCard = response.taskCardSnapshotAfterAction.taskCard;
		expect(pinnedCard.pinnedToTaskPinboardAt).toEqual(expect.any(Number));
		expect(pinnedCard.taskPinboardPinReason).toBe("watch it");
		// 置顶不是内容修改：不推进 updatedAt。
		expect(pinnedCard.updatedAt).toBe(1);
		expect(harness.callOrder).toEqual(["boardWrite:web_ui_task_card_action_pin_to_task_pinboard"]);
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-b", "/tmp/repo-b");
		expect(broadcastRuntimeProjectsUpdated).toHaveBeenCalledWith("workspace-b");
	});

	it("取消置顶：两个字段一起清掉", async () => {
		seedWorkspace(
			createBoard({
				review: [createCard("task-review", { pinnedToTaskPinboardAt: 5, taskPinboardPinReason: "why" })],
			}),
		);
		const { api } = createApiForTest();

		const response = await api.setTaskPinboardPinStateOfTaskCard(
			WORKSPACE_SCOPE,
			{ taskPinboardPinAction: "unpin_task_card", taskId: "task-review" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(response.boardWasSaved).toBe(true);
		expect(response.taskCardSnapshotAfterAction.taskCard).not.toHaveProperty("pinnedToTaskPinboardAt");
		expect(response.taskCardSnapshotAfterAction.taskCard).not.toHaveProperty("taskPinboardPinReason");
	});

	it("置顶态没变：不落盘、不广播；卡不在该项目 board 上：NOT_FOUND", async () => {
		seedWorkspace(
			createBoard({
				review: [createCard("task-review", { pinnedToTaskPinboardAt: 5, taskPinboardPinReason: "why" })],
			}),
		);
		const { api, broadcastRuntimeProjectsUpdated } = createApiForTest();

		const unchanged = await api.setTaskPinboardPinStateOfTaskCard(
			WORKSPACE_SCOPE,
			{
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskId: "task-review",
				taskPinboardPinReason: "why",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(unchanged.boardWasSaved).toBe(false);
		await expect(
			api.setTaskPinboardPinStateOfTaskCard(
				WORKSPACE_SCOPE,
				{ taskPinboardPinAction: "unpin_task_card", taskId: "task-elsewhere" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(broadcastRuntimeProjectsUpdated).not.toHaveBeenCalled();
	});
});

describe("taskCardAction.readTaskCardWithBoardColumn", () => {
	it("找到时回传卡片、所在列与两份会话摘要；找不到时回传明确的「不存在」而不是抛错", async () => {
		seedWorkspace(createBoard({ validation: [createCard("task-v")] }), { "task-v": createSummary("task-v") });
		const { api, liveTaskSessionSummaryByTaskId } = createApiForTest();
		liveTaskSessionSummaryByTaskId.set("task-v", createSummary("task-v", { state: "running", reviewReason: null }));

		const found = await api.readTaskCardWithBoardColumn(WORKSPACE_SCOPE, { taskId: "task-v" });
		const missing = await api.readTaskCardWithBoardColumn(WORKSPACE_SCOPE, { taskId: "nope1" });

		expect(found).toMatchObject({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: {
				taskCard: { id: "task-v" },
				boardColumnIdContainingTaskCard: "validation",
				taskSessionSummaryLiveInRuntimeProcessMemory: { state: "running" },
				taskSessionSummaryPersistedInWorkspaceSessionsFile: { state: "awaiting_review" },
			},
		});
		expect(missing).toEqual({
			taskCardLookupOutcome: "task_card_not_found_on_workspace_board",
			lookedUpTaskId: "nope1",
		});
	});
});

describe("taskCardAction 的意图种类与发起方标注按请求来源区分", () => {
	it("页面请求：web_ui_task_card_action_* 意图，浏览器声明的发起方合成为该卡全部变更种类的标注", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r")] }));
		const { api } = createApiForTest();

		await api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
			WORKSPACE_SCOPE,
			{ taskId: "task-r", targetBoardColumnId: "validation", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		const [capturedIntent] = readCapturedTaskMutationIntents();
		expect(capturedIntent).toMatchObject({
			taskMutationIntentKind: "web_ui_task_card_action_move_between_non_trash_columns",
			resolvedKanbanActor: {
				kanbanActorKind:
					"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
			},
		});
		expect(capturedIntent?.webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture).toEqual(
			expect.arrayContaining([
				{
					taskId: "task-r",
					annotatedBoardMutationKind: "task_card_moved_between_non_trash_board_columns",
					boardMutationInitiator: "web_ui_user_gesture",
				},
				{
					taskId: "task-r",
					annotatedBoardMutationKind: "task_card_field_value_changed",
					boardMutationInitiator: "web_ui_user_gesture",
				},
			]),
		);
	});

	it("页面请求不声明发起方：不附标注（账本如实记缺标注）", async () => {
		seedWorkspace(createBoard({ review: [createCard("task-r")] }));
		const { api } = createApiForTest();

		await api.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects(
			WORKSPACE_SCOPE,
			{ taskId: "task-r", targetBoardColumnId: "validation" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);

		expect(
			readCapturedTaskMutationIntents()[0]?.webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture,
		).toBeUndefined();
	});

	it("CLI 请求：沿用迁移前的 kanban_cli_task_* 意图名，带了发起方也不附标注（CLI 永远不记为用户）", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a")], review: [createCard("task-r")] }));
		const { api } = createApiForTest();

		await api.startTaskCardAgentSessionMovingItIntoInProgress(
			WORKSPACE_SCOPE,
			{ taskId: "task-a", boardMutationInitiator: "web_ui_user_gesture" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);
		await api.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
			WORKSPACE_SCOPE,
			{ taskId: "task-r" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
		);

		const capturedIntents = readCapturedTaskMutationIntents();
		expect(capturedIntents.map((intent) => intent.taskMutationIntentKind)).toEqual([
			"kanban_cli_task_start_move_to_in_progress",
			"kanban_cli_task_trash",
		]);
		for (const capturedIntent of capturedIntents) {
			expect(capturedIntent.resolvedKanbanActor.kanbanActorKind).toBe(
				"kanban_cli_invocation_without_task_or_session_environment",
			);
			expect(capturedIntent.webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture).toBeUndefined();
		}
	});
});

// 单独验证串行器的跨卡语义：不同卡互不等待，多卡命令等齐每张卡之前的命令。
describe("createTaskCardActionPerTaskCommandSerializer", () => {
	it("同卡串行、异卡并行；前一条失败不阻塞后一条", async () => {
		const serializer = createTaskCardActionPerTaskCommandSerializer();
		const events: string[] = [];
		const firstCommandOnCardA = createDeferred<void>();

		const firstOnCardA = serializer.runTaskCardActionCommandSeriallyForTaskCards("w", ["a"], async () => {
			events.push("a1:start");
			await firstCommandOnCardA.promise;
			events.push("a1:end");
			throw new Error("a1 failed");
		});
		const secondOnCardA = serializer.runTaskCardActionCommandSeriallyForTaskCards("w", ["a"], async () => {
			events.push("a2:run");
			return "a2";
		});
		const onCardB = serializer.runTaskCardActionCommandSeriallyForTaskCards("w", ["b"], async () => {
			events.push("b:run");
			return "b";
		});
		const onCardsAAndB = serializer.runTaskCardActionCommandSeriallyForTaskCards("w", ["a", "b"], async () => {
			events.push("ab:run");
			return "ab";
		});
		// 同名卡在另一个项目：不是同一张卡，不排队。
		const onCardAOfAnotherWorkspace = serializer.runTaskCardActionCommandSeriallyForTaskCards(
			"w2",
			["a"],
			async () => {
				events.push("w2a:run");
				return "w2a";
			},
		);

		await expect(onCardB).resolves.toBe("b");
		await expect(onCardAOfAnotherWorkspace).resolves.toBe("w2a");
		expect(events).not.toContain("a2:run");
		expect(events).not.toContain("ab:run");

		firstCommandOnCardA.resolve();
		await expect(firstOnCardA).rejects.toThrow("a1 failed");
		await expect(secondOnCardA).resolves.toBe("a2");
		await expect(onCardsAAndB).resolves.toBe("ab");
		expect(events.indexOf("a1:end")).toBeLessThan(events.indexOf("a2:run"));
		expect(events.indexOf("a2:run")).toBeLessThan(events.indexOf("ab:run"));
	});
});

describe("自己的 Task 改名与异步建议回填", () => {
	it("拒绝没有身份的 CLI 调用，不写 board", async () => {
		const { api } = createApiForTest();
		await expect(
			api.renameCurrentTask(
				WORKSPACE_SCOPE,
				{ title: "新名称", reason: "范围明确" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(harness.callOrder).toEqual([]);
	});
	it("按环境身份原子改名与追加原因，同名重试不重复写入", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a"), createCard("task-b")] }));
		const { api } = createApiForTest();
		const evidence: KanbanRequestOriginActorEvidence = {
			decodedCliActorClaimsRequestHeader: {
				cliActorClaimsRequestHeaderStatus: "present",
				claims: collectKanbanCliInvocationEnvironmentActorClaims({
					environment: { KANBAN_TASK_ID: "task-a", KANBAN_PROJECT_PATH: WORKSPACE_SCOPE.workspacePath },
					invokingKanbanCliCodeVersion: "test",
					invokingProcessWorkingDirectory: "/wrong-cwd",
				}),
			},
		};
		await api.renameCurrentTask(WORKSPACE_SCOPE, { title: "[FIX]明确任务结果", reason: "核对持久范围" }, evidence);
		await api.renameCurrentTask(WORKSPACE_SCOPE, { title: "[FIX]明确任务结果", reason: "重复调用" }, evidence);
		const [renamed, other] = readBoard().columns[0].cards;
		expect(renamed.title).toBe("[FIX]明确任务结果");
		expect(renamed.taskCommentEntries).toHaveLength(1);
		expect(renamed.taskCommentEntries?.[0].commentText).toContain("title of task-a → [FIX]明确任务结果");
		expect(renamed.taskCommentEntries?.[0].commentText).toContain("核对持久范围");
		expect(other.title).toBe("title of task-b");
		expect(harness.callOrder.filter((value) => value.startsWith("boardWrite:"))).toHaveLength(1);
	});
	it("迟到的 AI 建议不能覆盖已经变更的描述", async () => {
		seedWorkspace(createBoard({ backlog: [createCard("task-a", { prompt: "已经编辑的描述" })] }));
		const { api } = createApiForTest();
		await api.updateTaskCardFieldValues(
			WORKSPACE_SCOPE,
			{
				taskId: "task-a",
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: { title: "AI 名称" },
				},
				expectedTaskTitleAndPromptForAiNameBackfill: { title: "title of task-a", prompt: "旧描述" },
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE,
		);
		expect(readBoard().columns[0].cards[0].title).toBe("title of task-a");
		expect(harness.callOrder).toEqual([]);
	});
});
