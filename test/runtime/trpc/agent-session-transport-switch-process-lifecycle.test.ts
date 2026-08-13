// 通道切换的**进程生命周期**契约：重开新通道之前，旧通道的活体必须已经真的没了。
//
// 为什么单独拿一个文件钉这一条：它不是「切换的结果对不对」，而是「切换的两步之间有没有重叠窗口」。
// 只发终止信号就重开会同时踩两个坑——旧 PTY 迟到的 onExit 会给同一个 taskId 补写一条
// sessionTransport=pty_terminal 的终态 summary（session-manager 的 onExit 没有活体身份守卫，而
// runtime-state-hub 的广播队列按 taskId 后写覆盖先写，于是详情面板被翻回终端），且新旧两个 omp
// 进程会在重叠期同时写同一份按 cwd 建的会话存储，而续跑语义正建立在它的单写者假设上。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	mutateWorkspaceState: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

// 这个 mock 是刻意部分的：漏一个符号不会报「未 mock」，而是让整条 procedure 被 catch 成 ok:false
// 的静默降级，所以新增运行时依赖时必须同步补齐这里。
vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	getWorkspaceDirectoryPath: (workspaceId: string) => `/tmp/kanban-workspaces/${workspaceId}`,
	getWorkspacesRootPath: () => "/tmp/kanban-workspaces",
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "omp",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: false,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
		readyForReviewNotificationsEnabled: true,
		notificationSoundEnabled: true,
		autoContinueOnConnectionDropEnabled: true,
		postDeployVerificationForceCompleteEnabled: false,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-omp",
		state: "running",
		agentId: "omp",
		workspacePath: "/tmp/worktree",
		pid: 4321,
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

function createTestRuntimeApi(
	deps: Omit<CreateRuntimeApiDependencies, "getUpdateStatus" | "runUpdateNow">,
): ReturnType<typeof createRuntimeApi> {
	return createRuntimeApi({
		...deps,
		getUpdateStatus: vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: null,
			updateAvailable: false,
			updateTiming: null,
			installCommand: null,
		})),
		runUpdateNow: vi.fn(async () => ({
			status: "unsupported_installation" as const,
			currentVersion: "0.1.0",
			latestVersion: null,
			message: "On-demand updates are not available in this test runtime.",
		})),
	});
}

describe("createRuntimeApi switchAgentSessionTransport process lifecycle", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockRejectedValue(new Error("no checkpoint in tests"));
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-omp",
							title: "Omp task",
							prompt: "Implement task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							agentId: "omp",
							ompAgentSessionTransport: "pty_terminal",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
			dependencies: [],
		});
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_path: string, mutate: never) => {
			const mutation = (mutate as unknown as (state: unknown) => { board: unknown; value: unknown })({
				board: { columns: [], dependencies: [] },
			});
			return { saved: true, value: mutation.value };
		});
	});

	// 承重回归：TUI→ACP 必须等旧 PTY 真的退出之后才建立 ACP 会话。
	// 只发信号的 stopTaskSession 会让旧 PTY 迟到的 onExit 落在新 ACP summary 之后，把面板翻回终端。
	it("waits for the old PTY process to exit before opening the ACP channel", async () => {
		const observedCallOrder: string[] = [];
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ sessionTransport: "pty_terminal" })),
			stopTaskSession: vi.fn(() => {
				observedCallOrder.push("terminal-signal-only-stop");
				return null;
			}),
			forceStopTaskSession: vi.fn(async () => {
				// 真实实现会一直轮询到进程退出（或 SIGKILL 超时）才 resolve；这里用一个宏任务模拟那段等待，
				// 只发信号的写法不会 await 它，于是顺序断言立刻失败。
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				observedCallOrder.push("terminal-process-exit-confirmed");
			}),
			startTaskSession: vi.fn(async () => createSummary({ sessionTransport: "pty_terminal" })),
			applyTurnCheckpoint: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};
		const acpTaskSessionService = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(async () => null),
			discardTaskSessionLedgerEntry: vi.fn(),
			startTaskSession: vi.fn(async () => {
				observedCallOrder.push("acp-session-started");
				return createSummary({ sessionTransport: "acp_stdio_subprocess" });
			}),
			applyTurnCheckpoint: vi.fn(() => null),
			listMessages: vi.fn(() => []),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ listSummaries: () => [] }) as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		} as never);

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "acp_stdio_subprocess" },
		);

		expect(response.error).toBeUndefined();
		expect(response.ok).toBe(true);
		expect(response.priorAgentSessionStopped).toBe(true);
		expect(terminalManager.forceStopTaskSession).toHaveBeenCalledWith("task-omp");
		// 只发信号的那条路径必须彻底不再被切换走到，否则等待就形同虚设。
		expect(terminalManager.stopTaskSession).not.toHaveBeenCalled();
		expect(observedCallOrder).toEqual(["terminal-process-exit-confirmed", "acp-session-started"]);
	});

	// 没有旧 PTY 会话时不该去等一个不存在的进程，priorAgentSessionStopped 也应如实为 false。
	it("does not wait when there is no prior terminal session for the task", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(() => null),
			forceStopTaskSession: vi.fn(async () => {}),
			startTaskSession: vi.fn(async () => createSummary({ sessionTransport: "pty_terminal" })),
			applyTurnCheckpoint: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};
		const acpTaskSessionService = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(async () => null),
			discardTaskSessionLedgerEntry: vi.fn(),
			startTaskSession: vi.fn(async () => createSummary({ sessionTransport: "acp_stdio_subprocess" })),
			applyTurnCheckpoint: vi.fn(() => null),
			listMessages: vi.fn(() => []),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({ listSummaries: () => [] }) as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		} as never);

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "acp_stdio_subprocess" },
		);

		expect(response.error).toBeUndefined();
		expect(response.ok).toBe(true);
		expect(response.priorAgentSessionStopped).toBe(false);
		expect(terminalManager.forceStopTaskSession).not.toHaveBeenCalled();
	});
});
