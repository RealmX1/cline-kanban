// ACP 启动失败必须**如实上报**，不能被回成 ok:true。
//
// 为什么单独拿一个文件钉这一条：AcpTaskSessionService.startTaskSession 是唯一一条「失败不抛异常」的启动
// 路径——session/load、认证与 spawn 的异常全被它自己 catch 成一条 failed/error 的 summary
// （recordTaskFailure）之后**正常返回**。于是「没抛异常 ⇒ 起来了」这个在 PTY / Cline 侧成立的隐含前提，
// 在 ACP 分支上是错的，而这个错误只在失败路径上显形，成功路径的端到端验证永远照不到。
//
// 后果最重的消费者是 switchAgentSessionTransport：它已经把旧会话停掉了，再收到 ok:true 就既不弹错误也
// 不提示重试，用户对着一张什么都没在跑的卡以为切换成功。切换的失败口径是「停在已停止并如实报错」
// （不回滚、不降级），故本文件同时钉住：ok:false、priorAgentSessionStopped 如实为 true、错误原文透传，
// 且**没有**任何自动回落到旧通道的动作。
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
// 的静默降级——那正好会让本文件的失败断言假通过，所以新增运行时依赖时必须同步补齐这里。
vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	getWorkspaceDirectoryPath: (workspaceId: string) => `/tmp/kanban-workspaces/${workspaceId}`,
	getWorkspacesRootPath: () => "/tmp/kanban-workspaces",
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

const ACP_SPAWN_FAILURE_MESSAGE = "spawn omp ENOENT";

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

// 逐字复刻 AcpTaskSessionService.recordTaskFailure 的产物：failed + reviewReason "error" + pid 置空 +
// warningMessage 带原始异常文本，且**没有** facet 字段（旧盘/派生路径），由 resolveSessionFacets 现场派生。
function createAcpStartFailureSummary(): RuntimeTaskSessionSummary {
	return createSummary({
		state: "failed",
		reviewReason: "error",
		pid: null,
		warningMessage: ACP_SPAWN_FAILURE_MESSAGE,
		sessionTransport: "acp_stdio_subprocess",
	});
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

describe("createRuntimeApi ACP session start failure reporting", () => {
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

	// 承重回归：ACP 起不来时切换必须回 ok:false，并如实说明旧会话已经停了。
	it("reports a switch to ACP as failed when the ACP session never came up", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ sessionTransport: "pty_terminal" })),
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
			// 失败不抛：与真实实现一致，catch 后返回一条 failed summary。
			startTaskSession: vi.fn(async () => createAcpStartFailureSummary()),
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

		expect(response.ok).toBe(false);
		// 原始异常文本必须透传到前端提示，否则用户只会看到一句无从下手的通用失败。
		expect(response.error).toContain(ACP_SPAWN_FAILURE_MESSAGE);
		// 旧会话确实已经停了——前端据此把提示写成「已停止，修好后点 Start」。
		expect(response.priorAgentSessionStopped).toBe(true);
		expect(response.summary?.state).toBe("failed");
		// 不回滚、不降级：失败后绝不能偷偷把旧 PTY 通道再拉起来。
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	// 同一根因的另一面：普通启动（非切换）走 ACP 分支时同样不能谎报成功。
	// 两者共用 startTaskSession 的 ACP 分支，故一处判据覆盖两条路径。
	it("reports a plain ACP task session start as failed when the session never came up", async () => {
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
			startTaskSession: vi.fn(async () => createAcpStartFailureSummary()),
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

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-omp",
				prompt: "Implement task",
				baseRef: "main",
				agentId: "omp",
				requestedAgentSessionTransport: "acp_stdio_subprocess",
			},
		);

		expect(response.ok).toBe(false);
		expect(response.error).toContain(ACP_SPAWN_FAILURE_MESSAGE);
		expect(response.summary?.state).toBe("failed");
	});

	// 反向护栏：ACP 真的起来了就必须照常回 ok:true，别把「续跑重开停在等人说话」误判成失败。
	// 续跑分支的终态正是 awaiting_review + reviewReason "hook"（见 AcpTaskSessionService.startTaskSession），
	// 它是 user 回合但**活着**，故 isSessionInActiveTurn 为真。
	it("still reports success when the resumed ACP session lands on an awaiting-review turn", async () => {
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ sessionTransport: "pty_terminal" })),
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
			startTaskSession: vi.fn(async () =>
				createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					sessionTransport: "acp_stdio_subprocess",
				}),
			),
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
		expect(response.summary?.state).toBe("awaiting_review");
	});
});
