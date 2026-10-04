import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import { addTaskToColumn } from "../../../src/core/task-board-mutations";
import { KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

const orphanedDraftCleanupMocks = vi.hoisted(() => ({
	discardTaskEditDraftsForTasksRemovedFromBoard: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	deleteAllTaskTurnCheckpointRefs: vi.fn(),
}));

const taskSessionStartDiagnosticsMocks = vi.hoisted(() => ({
	recordTaskSessionStartDiagnostic: vi.fn(async () => {}),
}));

const ensureTaskWorktreeMocks = vi.hoisted(() => ({
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
}));

// 真实实现会追加写 ~/.cline/kanban 下的启动诊断日志：测试绝不能污染真实 home。
vi.mock("../../../src/diagnostics/task-session-start-diagnostics-logger.js", () => ({
	recordTaskSessionStartDiagnostic: taskSessionStartDiagnosticsMocks.recordTaskSessionStartDiagnostic,
}));

vi.mock("../../../src/state/discard-task-edit-drafts-for-tasks-removed-from-board.js", async (importOriginal) => {
	// 差集计算是纯函数、正是 saveState 两条清理共用的判据，保留真实实现；只有落盘清理本体被桩掉。
	const actual = (await importOriginal()) as {
		collectTaskIdsRemovedFromBoard: (
			boardBeforeWrite: RuntimeBoardData,
			boardAfterWrite: RuntimeBoardData,
		) => string[];
	};
	return {
		collectTaskIdsRemovedFromBoard: actual.collectTaskIdsRemovedFromBoard,
		discardTaskEditDraftsForTasksRemovedFromBoard:
			orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard,
	};
});

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	deleteAllTaskTurnCheckpointRefs: turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs,
}));

const workspaceStateMocks = vi.hoisted(() => ({
	mutateWorkspaceState: vi.fn(),
	saveWorkspaceState: vi.fn(),
	// saveState 在写盘前读一次「写之前的 board」，用来算出「哪些任务从看板上消失了」并清掉它们的
	// 编辑草稿（见 src/state/discard-task-edit-drafts-for-tasks-removed-from-board.ts）。
	loadWorkspaceBoardById: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", async (importOriginal) => {
	// 错误消息前缀常量取真实模块的值，保证谓词测试与生产文案不漂移。
	const actual = (await importOriginal()) as {
		TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX: string;
		TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX: string;
	};
	return {
		TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX: actual.TASK_WORKTREE_NOT_FOUND_ERROR_MESSAGE_PREFIX,
		TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX: actual.TASK_WORKTREE_SETUP_IN_PROGRESS_ERROR_MESSAGE_PREFIX,
		deleteTaskWorktree: vi.fn(),
		ensureTaskWorktreeIfDoesntExist: ensureTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist,
		getTaskWorkspaceInfo: vi.fn(),
		resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
	};
});

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
	saveWorkspaceState: workspaceStateMocks.saveWorkspaceState,
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	WorkspaceStateConflictError: class WorkspaceStateConflictError extends Error {
		currentRevision: number;

		constructor(message: string, currentRevision: number) {
			super(message);
			this.currentRevision = currentRevision;
		}
	},
}));

import { type CreateWorkspaceApiDependencies, createWorkspaceApi } from "../../../src/trpc/workspace-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createWorkspaceState(board: RuntimeBoardData = createBoard()): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/state",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: [{ name: "main" }],
		},
		board,
		sessions: {},
		revision: 1,
	};
}

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		autoContinueOnConnectionDropEnabled: true,
		programmaticDeliveryMayAutoStashAbsentHumanInputBoxEnabled: true,
		postDeployVerificationForceCompleteEnabled: false,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

function createWorkspaceApiForTest(
	deps: Partial<CreateWorkspaceApiDependencies> = {},
): ReturnType<typeof createWorkspaceApi> {
	return createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		listProjectRuntimeSessionSummaries: vi.fn(() => []),
		loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
		...deps,
	});
}

describe("createWorkspaceApi saveState", () => {
	beforeEach(() => {
		workspaceStateMocks.saveWorkspaceState.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard.mockReset();
		turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs.mockReset();
		turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs.mockResolvedValue(undefined);
		// 差集清理用的是真实的 collectTaskIdsRemovedFromBoard，写前 board 默认给一份合法空 board；
		// 单测要验「读不到」语义时再自行 override 成 reject。
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard());
	});

	it("overlays terminal, Cline, and ACP runtime summaries before persistence", async () => {
		const terminalSummary = createSummary({ taskId: "terminal-task", agentId: "claude" });
		const clineSummary = createSummary({ taskId: "cline-task", agentId: "cline" });
		const acpSummary = createSummary({ taskId: "acp-task", agentId: "omp" });
		const expectedResponse = createWorkspaceState();
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(expectedResponse);
		const api = createWorkspaceApiForTest({
			listProjectRuntimeSessionSummaries: vi.fn(() => [terminalSummary, clineSummary, acpSummary]),
		});
		const payload = { board: createBoard(), sessions: {}, expectedRevision: 1 };

		const response = await api.saveState(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			payload,
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response).toBe(expectedResponse);
		// Web UI 请求目前没有页面加载 nonce：行动者解析为 direct_runtime_trpc_caller（1a.3 接 nonce 前的预期）。
		expect(workspaceStateMocks.saveWorkspaceState).toHaveBeenCalledWith(
			"/tmp/repo",
			expect.objectContaining({
				taskMutationIntentKind: "web_ui_workspace_board_state_save",
				resolvedKanbanActor: {
					kanbanActorKind: "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce",
				},
			}),
			{
				...payload,
				sessions: {
					"terminal-task": terminalSummary,
					"cline-task": clineSummary,
					"acp-task": acpSummary,
				},
			},
		);
	});

	// 浏览器删卡不走任何「删除 procedure」，就是一次整份 board PUT。「任务被删除」在这条路径上只能
	// 由写前/写后两份 board 的差集看出来——不接这一步，不经浏览器删除 handler 的写入就会留下永远
	// 无法认领的孤儿草稿。
	it("保存看板后按写前/写后差集清掉消失任务的编辑草稿", async () => {
		const boardBeforeSave = createBoard();
		const savedResponse = createWorkspaceState();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(boardBeforeSave);
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(savedResponse);
		orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard.mockResolvedValue(undefined);
		const api = createWorkspaceApiForTest({ listProjectRuntimeSessionSummaries: vi.fn(() => []) });

		await api.saveState(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ board: createBoard(), sessions: {}, expectedRevision: 1 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard).toHaveBeenCalledWith(
			"workspace-1",
			boardBeforeSave,
			savedResponse.board,
		);
	});

	// 这条旁路是纯兜底：读不到写前的 board 时**不做**差集，绝不能把「读不到」当成「一张卡都不剩」——
	// 那会把整个 workspace 的草稿一次清空。
	it("读不到写前的看板时跳过差集清理，而不是把整份草稿当成孤儿清掉", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockRejectedValue(new Error("board 读不出来"));
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(createWorkspaceState());
		const api = createWorkspaceApiForTest({ listProjectRuntimeSessionSummaries: vi.fn(() => []) });

		await api.saveState(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ board: createBoard(), sessions: {}, expectedRevision: 1 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard).not.toHaveBeenCalled();
	});

	// 一次草稿清理绝不该有能力让用户的看板保存失败。
	it("清理抛错也不影响看板保存的返回", async () => {
		const savedResponse = createWorkspaceState();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(createBoard());
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(savedResponse);
		orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard.mockRejectedValue(
			new Error("草稿文件写不进去"),
		);
		const api = createWorkspaceApiForTest({ listProjectRuntimeSessionSummaries: vi.fn(() => []) });

		await expect(
			api.saveState(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ board: createBoard(), sessions: {}, expectedRevision: 1 },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).resolves.toBe(savedResponse);
	});

	// 同一条差集旁路的另一半（姊妹蓝图 §1.4）：任务从看板上永久消失时按前缀批删它的全部 turn
	// checkpoint ref。仅移进 trash 列的任务仍在写后 board 里，差集天然不碰它——所以这里用
	// 「写前有、写后无」造出差集，而不是把卡移列。
	it("保存看板后按写前/写后差集批删消失任务的 turn checkpoint ref", async () => {
		const added = addTaskToColumn(
			createBoard(),
			"trash",
			{ prompt: "已完成的任务", baseRef: "main" },
			() => "task-gone",
		);
		const boardBeforeSave = added.board;
		const removedTaskId = added.task.id;
		const savedResponse = createWorkspaceState();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(boardBeforeSave);
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(savedResponse);
		const api = createWorkspaceApiForTest({ listProjectRuntimeSessionSummaries: vi.fn(() => []) });

		await api.saveState(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ board: createBoard(), sessions: {}, expectedRevision: 1 },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs).toHaveBeenCalledTimes(1);
		expect(turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: removedTaskId,
		});
	});

	// 批删与草稿清理同一套失败语义：这是删除已成之后的收尾，绝不反过来让看板保存失败。
	it("checkpoint ref 批删抛错也不影响看板保存的返回", async () => {
		const added = addTaskToColumn(
			createBoard(),
			"trash",
			{ prompt: "已完成的任务", baseRef: "main" },
			() => "task-gone",
		);
		const savedResponse = createWorkspaceState();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(added.board);
		workspaceStateMocks.saveWorkspaceState.mockResolvedValue(savedResponse);
		turnCheckpointMocks.deleteAllTaskTurnCheckpointRefs.mockRejectedValue(new Error("ref 删不掉"));
		const api = createWorkspaceApiForTest({ listProjectRuntimeSessionSummaries: vi.fn(() => []) });

		await expect(
			api.saveState(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ board: createBoard(), sessions: {}, expectedRevision: 1 },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).resolves.toBe(savedResponse);
	});
});

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		orphanedDraftCleanupMocks.discardTaskEditDraftsForTasksRemovedFromBoard.mockReset();
		workspaceStateMocks.saveWorkspaceState.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ getSummary: vi.fn(() => null) }) as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("uses native cline session checkpoints when terminal summaries are unavailable", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "3333333",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(clineTaskSessionService.getSummary).toHaveBeenCalledWith("task-1");
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
			toRef: "3333333",
		});
	});

	it("prefers the newer live cline summary over a stale terminal summary", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "claude",
					updatedAt: 10,
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "terminal-2",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "terminal-1",
						createdAt: 1,
					},
				}),
			),
		};
		const clineTaskSessionService = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					agentId: "cline",
					updatedAt: 20,
					latestTurnCheckpoint: {
						turn: 3,
						ref: "refs/kanban/checkpoints/task-1/turn/3",
						commit: "cline-3",
						createdAt: 3,
					},
					previousTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "cline-2",
						createdAt: 2,
					},
				}),
			),
		};

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "cline-2",
			toRef: "cline-3",
		});
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});

	it("returns an empty diff while the task worktree is still being set up", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree is still being set up for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApiForTest({
			ensureTerminalManagerForWorkspace: vi.fn(),
			getScopedClineTaskSessionService: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});
});

describe("createWorkspaceApi addBacklogTask", () => {
	beforeEach(() => {
		workspaceStateMocks.mutateWorkspaceState.mockReset();
		workspaceStateMocks.saveWorkspaceState.mockReset();
	});

	it("uses the runtime default when creating backlog tasks through the scoped API", async () => {
		const savedBoardRef: { current: RuntimeBoardData | null } = { current: null };
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_cwd, _taskMutationIntent, mutate) => {
			const currentState = createWorkspaceState();
			const mutation = mutate(currentState);
			savedBoardRef.current = mutation.board;
			return {
				value: mutation.value,
				state: {
					...currentState,
					board: mutation.board,
				},
				saved: true,
			};
		});
		const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		const broadcastRuntimeProjectsUpdated = vi.fn();
		const api = createWorkspaceApiForTest({
			loadScopedRuntimeConfig: vi.fn(async () =>
				createRuntimeConfigState({
					newTaskStartInPlanModeByDefault: false,
				}),
			),
			broadcastRuntimeWorkspaceStateUpdated,
			broadcastRuntimeProjectsUpdated,
		});

		await api.addBacklogTask(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				prompt: "Create from API",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		if (!savedBoardRef.current) {
			throw new Error("Expected addBacklogTask to save a board.");
		}
		const backlogColumn = savedBoardRef.current.columns.find((column) => column.id === "backlog");
		expect(backlogColumn?.cards[0]?.startInPlanMode).toBe(false);
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
		expect(broadcastRuntimeProjectsUpdated).toHaveBeenCalledWith("workspace-1");
		expect(workspaceStateMocks.mutateWorkspaceState).toHaveBeenCalledWith(
			"/tmp/repo",
			expect.objectContaining({
				taskMutationIntentKind: "runtime_trpc_add_backlog_task",
				resolvedKanbanActor: {
					kanbanActorKind: "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce",
				},
			}),
			expect.any(Function),
		);
	});
});

describe("createWorkspaceApi ensureWorktree", () => {
	const workspaceScope = { workspaceId: "workspace-for-ensure-worktree-test", workspacePath: "/tmp/repo" };

	beforeEach(() => {
		ensureTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockReset();
		taskSessionStartDiagnosticsMocks.recordTaskSessionStartDiagnostic.mockClear();
	});

	it("records a start diagnostic when worktree setup fails, because startTaskSession is never reached", async () => {
		// 浏览器启动 = ensureWorktree 与 startTaskSession 两次 RPC。前者失败（高负载下锁等待超时）时
		// 后者根本不会被调用，此前启动诊断日志里一行都没有，「新任务起不来」在服务端无从查起。
		ensureTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: false,
			path: null,
			baseRef: "main",
			baseCommit: null,
			error: "Lock file is already being held",
		});
		const api = createWorkspaceApiForTest();

		const response = await api.ensureWorktree(workspaceScope, { taskId: "task-1", baseRef: "main" });

		expect(response.ok).toBe(false);
		expect(taskSessionStartDiagnosticsMocks.recordTaskSessionStartDiagnostic).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "failed",
				workspaceId: "workspace-for-ensure-worktree-test",
				taskId: "task-1",
				phase: "ensure_task_worktree",
				error: "Lock file is already being held",
			}),
		);
	});

	it("does not record a start diagnostic when the worktree is ready", async () => {
		ensureTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: "/tmp/worktree",
			baseRef: "main",
			baseCommit: "abc123",
		});
		const api = createWorkspaceApiForTest();

		await api.ensureWorktree(workspaceScope, { taskId: "task-1", baseRef: "main" });

		expect(taskSessionStartDiagnosticsMocks.recordTaskSessionStartDiagnostic).not.toHaveBeenCalled();
	});
});

// setTaskPinboardPinStateOfTaskCard 已迁入 taskCardAction（见 task-card-action-api.test.ts 的同名段）。
