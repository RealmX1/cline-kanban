import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	mutateWorkspaceState: vi.fn(),
	saveWorkspaceState: vi.fn(),
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
		ensureTaskWorktreeIfDoesntExist: vi.fn(),
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
		dependencies: [],
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
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		autoContinueOnConnectionDropEnabled: true,
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

		const response = await api.saveState({ workspaceId: "workspace-1", workspacePath: "/tmp/repo" }, payload);

		expect(response).toBe(expectedResponse);
		expect(workspaceStateMocks.saveWorkspaceState).toHaveBeenCalledWith("/tmp/repo", {
			...payload,
			sessions: {
				"terminal-task": terminalSummary,
				"cline-task": clineSummary,
				"acp-task": acpSummary,
			},
		});
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
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_cwd, mutate) => {
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
		);

		if (!savedBoardRef.current) {
			throw new Error("Expected addBacklogTask to save a board.");
		}
		const backlogColumn = savedBoardRef.current.columns.find((column) => column.id === "backlog");
		expect(backlogColumn?.cards[0]?.startInPlanMode).toBe(false);
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
		expect(broadcastRuntimeProjectsUpdated).toHaveBeenCalledWith("workspace-1");
	});
});
