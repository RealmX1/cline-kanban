import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AcpClientConnectionRuntime,
	type AcpTaskConnection,
} from "../../../src/acp-client-session/acp-client-connection-runtime";
import { createAcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import { extractCodexUserQuestionPayload } from "../../../src/commands/codex-user-question-payload-extraction";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import { getRuntimeLaunchSupportedAgentCatalog } from "../../../src/core/agent-catalog";
import { advanceAgentWorkProgress } from "../../../src/core/agent-work-progress";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
	TerminalInputBoxStashOutcome,
} from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));
const backlogTaskReadinessMocks = vi.hoisted(() => ({
	readBacklogTaskStartReadinessOperation: vi.fn(async () => null),
}));
vi.mock(
	"../../../src/backlog-task-start-readiness/backlog-task-start-readiness-operation-store",
	() => backlogTaskReadinessMocks,
);

const taskClosureLockMocks = vi.hoisted(() => ({
	withTaskClosureLifecycleLocks: vi.fn(
		async (_workspaceId: string, _ids: readonly string[], action: () => Promise<unknown>) => await action(),
	),
}));
vi.mock("../../../src/task-closure/task-closure-operation-store", () => taskClosureLockMocks);

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

// 转录模型探针只做**间谍**，不改行为：本套件既有用例用真实转录夹具驱动它读盘，替换实现会把那些
// 断言一并废掉。这里只是把两条探针包一层 spy，好断言「恢复既有对话时选了哪条探针、传了什么」。
const persistedAgentTranscriptModelProbeMocks = vi.hoisted(() => ({
	probeByWorkingDirectory: vi.fn(),
	probeByAgentNativeConversationSessionId: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
	loadPersistedConversationSessions: vi.fn(() => ({})),
	mutateWorkspaceState: vi.fn(),
	// Prompt Library 的全局桶落在 kanban 根目录下。测试要一个自己的根，否则终端暂存用例会在
	// 开发者**真实**的 ~/.cline/kanban 上取锁写文件。每次运行取唯一路径，避免并行 worker 互踩。
	runtimeHomePath: `/tmp/kanban-runtime-api-test-home-${process.pid}-${Math.random().toString(16).slice(2)}`,
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

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

vi.mock(
	"../../../src/agent-session-history/persisted-agent-transcript-last-conversation-model-probe.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../src/agent-session-history/persisted-agent-transcript-last-conversation-model-probe.js")
			>();
		// 默认委派真身；beforeEach 用 mockClear（而非 mockReset）清调用记录，实现得以保留。
		persistedAgentTranscriptModelProbeMocks.probeByWorkingDirectory.mockImplementation(
			actual.probePersistedAgentTranscriptLastConversationModelIdentity,
		);
		persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId.mockImplementation(
			actual.probePersistedAgentTranscriptModelIdentityForAgentNativeConversationSession,
		);
		return {
			...actual,
			probePersistedAgentTranscriptLastConversationModelIdentity:
				persistedAgentTranscriptModelProbeMocks.probeByWorkingDirectory,
			probePersistedAgentTranscriptModelIdentityForAgentNativeConversationSession:
				persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId,
		};
	},
);

// 排队投递的两条记账入口只做间谍：断言 runtime-api 只在「本次新建了投递意图」时调它们（记账本身另有集成测试）。
const queuedTaskMessageDeliveryRecordingMocks = vi.hoisted(() => ({
	recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking: vi.fn(),
	recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking: vi.fn(),
}));

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/task-message-delivery-request-event-recording.js",
	async (importOriginal) => ({
		...(await importOriginal<typeof TaskMessageDeliveryRequestEventRecordingModule>()),
		...queuedTaskMessageDeliveryRecordingMocks,
	}),
);

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadPersistedWorkspaceStateById: async () => ({
		sessions: workspaceStateMocks.loadPersistedConversationSessions(),
		board: await workspaceStateMocks.loadWorkspaceBoardById(),
	}),
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	// 程序化投递要按 workspaceId 解析注入账本路径。这个 mock 是刻意部分的，
	// 漏一个符号不会报「未 mock」而是让整条 sendTaskChatMessage 被 catch 成 ok:false——
	// 静默降级，所以新增运行时依赖时必须同步补齐这里。
	getWorkspaceDirectoryPath: (workspaceId: string) => `/tmp/kanban-workspaces/${workspaceId}`,
	getRuntimeHomePath: () => workspaceStateMocks.runtimeHomePath,
	getTaskWorktreesHomePath: () => join(workspaceStateMocks.runtimeHomePath, "task-worktrees"),
	getWorkspacesRootPath: () => "/tmp/kanban-workspaces",
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

import { buildQueuedProgrammaticInjectionQueueEntryId } from "../../../src/core/queued-programmatic-injection-ledger-receipt-mirroring";
import type * as TaskMessageDeliveryRequestEventRecordingModule from "../../../src/inter-work-unit-relation-ledger/task-message-delivery-request-event-recording";
import {
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
	recordAgentRaisedPendingUserDecisionAnswer,
} from "../../../src/state/agent-raised-pending-user-decision-store";
import {
	getWorkspacePromptLibraryPath,
	readWorkspacePromptLibrarySnapshot,
} from "../../../src/state/prompt-library-store";
import { MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK } from "../../../src/state/queued-task-prompt-delivery-store";
import {
	deferHarnessGeneratedPromptDuringAgentSessionRestoration,
	listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
} from "../../../src/state/restoration-deferred-harness-generated-prompt-store";
import { getRuntimeHomePath as getTaskConversationSessionOperationsRuntimeHomePath } from "../../../src/state/runtime-home-path";
import { type StartTaskSessionRequest, TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { HostedTerminalPtyProcessSpawnRequest } from "../../../src/terminal/terminal-pty-process-handle";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";
import { KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

function createTestRuntimeApi(
	deps: Omit<CreateRuntimeApiDependencies, "getUpdateStatus" | "runUpdateNow" | "getScopedAcpTaskSessionService"> &
		Partial<
			Pick<CreateRuntimeApiDependencies, "getUpdateStatus" | "runUpdateNow" | "getScopedAcpTaskSessionService">
		>,
): RuntimeTrpcContext["runtimeApi"] {
	return createRuntimeApi({
		...deps,
		// 用真实的（空的）ACP service 而不是抛错桩：聊天类端点是「先问 ACP，没有该会话再回落
		// Cline」，空 service 会如实返回 null，回落路径才测得到。它在 startTaskSession 之前不起任何进程。
		getScopedAcpTaskSessionService:
			deps.getScopedAcpTaskSessionService ?? vi.fn(async () => createAcpTaskSessionService()),
		getUpdateStatus:
			deps.getUpdateStatus ??
			vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
		runUpdateNow:
			deps.runUpdateNow ??
			vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "On-demand updates are not available in this test runtime.",
			})),
	});
}

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

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		newTaskStartInPlanModeByDefault: true,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
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
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

function createCollaborationSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createSummary({
		taskId: "collaborator-1",
		agentId: "omp",
		sessionTransport: "acp_stdio_subprocess",
		taskConversationSessionMetadata: {
			workspaceTaskId: "task-1",
			taskConversationSessionRole: "task_collaborator",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: 1,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: "协作部分",
			taskConversationSessionLaunchSettings: {
				sessionTransport: "acp_stdio_subprocess",
				taskAgentPermissionMode: "ask_for_every_tool_use",
			},
		},
		...overrides,
	});
}

// 从退役前基线迁回仍适用于 PTY/ACP 的安全与恢复回归，移除 SDK 专属夹具。
describe("createRuntimeApi PTY 与 ACP 启动恢复安全", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		persistedAgentTranscriptModelProbeMocks.probeByWorkingDirectory.mockClear();
		persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId.mockClear();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		taskClosureLockMocks.withTaskClosureLifecycleLocks.mockReset();
		taskClosureLockMocks.withTaskClosureLifecycleLocks.mockImplementation(
			async (_workspaceId, _ids, action) => await action(),
		);
		workspaceStateMocks.loadPersistedConversationSessions.mockReset();
		workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue({});
		workspaceStateMocks.mutateWorkspaceState.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "review",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
		});
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});
	it("移入进行中后，直接启动仍需经过未完成的 Backlog 首发门禁", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "in_progress", cards: [{ id: "task-1", createdAt: 1 }] }],
		});
		const review = { operationId: "isolated-backlog-first-start", phase: "start_failed" };
		backlogTaskReadinessMocks.readBacklogTaskStartReadinessOperation.mockImplementationOnce(
			async () => ({ review }) as never,
		);
		const getScopedTerminalManager = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", prompt: "原始需求", baseRef: "main" },
		);
		expect(response).toMatchObject({ ok: false, error: expect.stringContaining("启动前复核") });
		expect(getScopedTerminalManager).not.toHaveBeenCalled();
	});
	it("自动恢复动作按 workspace、会话与当前 episode 投递，不把过期动作冒充成功", async () => {
		const actOnAutomaticFailureContinuation = vi.fn(
			async (_taskId: string, episodeId: string) => episodeId === "current",
		);
		const getScopedTerminalManager = vi.fn(async () => ({ actOnAutomaticFailureContinuation }) as never);
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const scope = { workspaceId: "workspace-1", workspacePath: "/isolated" };
		expect(
			await api.actOnAutomaticFailureContinuation(scope, {
				taskId: "conversation",
				episodeId: "stale",
				action: "cancel",
			}),
		).toEqual({ ok: false });
		expect(
			await api.actOnAutomaticFailureContinuation(scope, {
				taskId: "conversation",
				episodeId: "current",
				action: "retry_now",
			}),
		).toEqual({ ok: true });
		expect(getScopedTerminalManager).toHaveBeenCalledWith(scope);
		expect(actOnAutomaticFailureContinuation).toHaveBeenLastCalledWith("conversation", "current", "retry_now");
	});

	it("优先复用既有工作树路径，再尝试创建", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
			}),
			expect.any(String),
		);
	});

	it("已结案任务的主会话、侧会话和详情终端均须先重开，拒绝时不创建工作树", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "trash", cards: [{ id: "task-1", agentId: "codex" }] }],
		});
		const terminalManager = {
			startTaskSession: vi.fn(),
			startShellSession: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };
		const main = await api.startTaskSession(scope, { taskId: "task-1", prompt: "启动", baseRef: "main" });
		const side = await api.startTaskSession(scope, {
			taskId: "side-1",
			workspaceTaskId: "task-1",
			prompt: "侧会话",
			baseRef: "main",
		});
		const shell = await api.startShellSession(scope, {
			taskId: "__detail_terminal__:task-1",
			workspaceTaskId: "task-1",
			baseRef: "main",
		});
		for (const result of [main, side, shell])
			expect(result).toMatchObject({ ok: false, error: expect.stringContaining("先重新打开") });
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(terminalManager.startShellSession).not.toHaveBeenCalled();
	});

	it("会话启动等待结案锁，拿锁后重新核对任务，不能使用等待前的列状态", async () => {
		let releaseStartup: () => void = () => {};
		const waitingForClosure = new Promise<void>((resolve) => {
			releaseStartup = resolve;
		});
		taskClosureLockMocks.withTaskClosureLifecycleLocks.mockImplementationOnce(
			async (_workspaceId, _taskIds, action) => {
				await waitingForClosure;
				return await action();
			},
		);
		const terminalManager = { startTaskSession: vi.fn() };
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const starting = api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", prompt: "启动", baseRef: "main" },
		);
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "trash", cards: [{ id: "task-1" }] }],
		});
		releaseStartup();
		expect(await starting).toMatchObject({ ok: false, error: expect.stringContaining("先重新打开") });
		expect(taskClosureLockMocks.withTaskClosureLifecycleLocks).toHaveBeenCalledWith(
			"workspace-1",
			["task-1"],
			expect.any(Function),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it.each(["direct_main", "promoted_main"] as const)(
		"%s 的启动门禁在 transport 的 spawn 前拒绝时，不启动实际终端进程",
		async (scenario) => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
			const spawnTerminalProcess = vi.fn(() => createSummary());
			const primary = createCollaborationSummary({
				taskId: "promoted-main",
				agentId: "claude",
				sessionTransport: "pty_terminal",
			});
			if (scenario === "promoted_main")
				workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
					columns: [
						{
							id: "review",
							cards: [
								{
									id: "task-1",
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1,
									mainTaskConversationSessionId: primary.taskId,
								},
							],
						},
					],
				});
			const terminalManager = {
				getSummary: vi.fn(() => primary),
				startTaskSession: vi.fn(async (request: StartTaskSessionRequest) => {
					await request.beforeAgentProcessLaunch?.(createSummary());
					return spawnTerminalProcess();
				}),
				applyTurnCheckpoint: vi.fn(),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const beforeAgentProcessLaunch = vi.fn(async () => {
				throw new Error("已收到 Stop，创建提交禁止启动");
			});
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", baseRef: "main", prompt: "只启动一次" },
				beforeAgentProcessLaunch,
			);
			expect(response).toMatchObject({ ok: false, error: expect.stringContaining("Stop") });
			expect(beforeAgentProcessLaunch).toHaveBeenCalledTimes(1);
			expect(terminalManager.startTaskSession).toHaveBeenCalledTimes(1);
			expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({ beforeAgentProcessLaunch }),
				expect.any(String),
			);
			expect(spawnTerminalProcess).not.toHaveBeenCalled();
		},
	);

	describe("taskConversationMode 传参", () => {
		it("终端分支把启动请求里的 taskConversationMode 带进 startTaskSession", async () => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

			const terminalManager = {
				startTaskSession: vi.fn(async () => createSummary()),
				applyTurnCheckpoint: vi.fn(),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});

			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: "task-1",
					baseRef: "main",
					prompt: "Map the exploration space",
					taskConversationMode: "exploratory",
				},
			);

			expect(response.ok).toBe(true);
			expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "task-1",
					taskConversationMode: "exploratory",
				}),
				expect.any(String),
			);
		});

		it("ACP 分支把启动请求里的 taskConversationMode 带进 startTaskSession", async () => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
			const acpSummary = createSummary({
				taskId: "task-1",
				agentId: "omp",
				state: "running",
				sessionTransport: "acp_stdio_subprocess",
			});
			const acpTaskSessionService = {
				listSummaries: vi.fn(() => []),
				getSummary: vi.fn(() => null),
				startTaskSession: vi.fn(async () => acpSummary),
				listMessages: vi.fn(() => []),
				clearTaskSession: vi.fn(),
				applyTurnCheckpoint: vi.fn(() => null),
			};
			const terminalManager = {
				getSummary: vi.fn(() => null),
				listSummaries: vi.fn(() => []),
				startTaskSession: vi.fn(async () => createSummary()),
				applyTurnCheckpoint: vi.fn(),
			};

			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});

			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: "task-1",
					baseRef: "main",
					prompt: "Map the exploration space",
					agentId: "omp",
					requestedAgentSessionTransport: "acp_stdio_subprocess",
					taskConversationMode: "exploratory",
				},
			);

			expect(response.ok).toBe(true);
			expect(acpTaskSessionService.startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "task-1",
					taskConversationMode: "exploratory",
				}),
			);
			expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		});
	});

	it.each(
		getRuntimeLaunchSupportedAgentCatalog()
			.filter((agent) => agent.id !== "cline")
			.map((agent) => agent.id),
	)("协作会话允许 %s 在宿主工作区独立启动，不创建主任务 checkpoint", async (agentId) => {
		const metadata = {
			workspaceTaskId: "task-1",
			taskConversationSessionRole: "task_collaborator" as const,
			taskConversationSessionContextSource: "started_from_scratch" as const,
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: 1,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: "独立实现",
		};
		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async (request) =>
				createSummary({
					taskId: "collaborator-1",
					agentId,
					taskConversationSessionMetadata: request.taskConversationSessionMetadata,
				}),
			),
			applyTurnCheckpoint: vi.fn(),
		};
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId, binary: agentId, args: [] });
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "collaborator-1",
				workspaceTaskId: "task-1",
				baseRef: "main",
				prompt: "独立实现",
				agentId,
				taskConversationSessionMetadata: metadata,
				taskAgentPermissionMode: "bypass_all_permission_prompts",
			},
		);
		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId,
				workspaceTaskId: "task-1",
				taskConversationSessionMetadata: expect.objectContaining({
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionLaunchSettings: expect.objectContaining({
						taskAgentPermissionMode: "bypass_all_permission_prompts",
						sessionTransport: "pty_terminal",
					}),
				}),
			}),
			expect.any(String),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it.each([
		["claude", "pty_terminal"],
		["codex", "pty_terminal"],
		["omp", "pty_terminal"],
		["omp", "acp_stdio_subprocess"],
	] as const)("协作 fork %s/%s 按主身份启动，可重复且沿用主通道", async (agentId, sessionTransport) => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		const main = createSummary({
			agentId,
			sessionTransport,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: agentId,
				nativeSessionId: "11111111-2222-4333-8444-555555555555",
				transcriptPath: null,
				observedAt: 1,
			},
		});
		const baseMetadata = createCollaborationSummary().taskConversationSessionMetadata;
		if (!baseMetadata) throw new Error("缺少协作会话夹具 metadata");
		const metadata = {
			...baseMetadata,
			taskConversationSessionContextSource: "forked_from_main_current_turn" as const,
			parentTaskConversationSessionId: "task-1",
		};
		const byTheWay = createSummary({
			taskId: "side",
			taskConversationSessionMetadata: { ...metadata, taskConversationSessionRole: "by_the_way" },
		});
		const started = createSummary({
			taskId: "collaborator-fork",
			agentId,
			sessionTransport,
			taskConversationSessionMetadata: metadata,
		});
		const terminalManager = {
			getSummary: vi.fn((id: string) => (id === "task-1" ? main : null)),
			listSummaries: vi.fn(() => [main, byTheWay]),
			startTaskSession: vi.fn(async () => started),
			applyTurnCheckpoint: vi.fn(),
		};
		const acpService = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
			startTaskSession: vi.fn(async () => started),
		};
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId, binary: agentId, args: [] });
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			setActiveRuntimeConfig: vi.fn(),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		await Promise.all(
			[0, 1].map(async (attempt) => {
				const response = await api.startTaskSession(
					{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
					{
						taskId: `collaborator-fork-${attempt}`,
						workspaceTaskId: "task-1",
						agentId,
						baseRef: "main",
						prompt: "新的协作任务",
						taskConversationSessionMetadata: metadata,
					},
				);
				expect(response).toMatchObject({ ok: true });
			}),
		);
		const start =
			sessionTransport === "acp_stdio_subprocess" ? acpService.startTaskSession : terminalManager.startTaskSession;
		expect(start).toHaveBeenCalledTimes(2);
		for (const attempt of [0, 1])
			expect(start).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: `collaborator-fork-${attempt}` }),
				...(sessionTransport === "pty_terminal" ? [expect.any(String)] : []),
			);

		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				taskConversationSessionContextForkSourceNativeSessionId:
					main.agentNativeConversationSessionIdentity?.nativeSessionId,
			}),
			...(sessionTransport === "pty_terminal" ? [expect.any(String)] : []),
		);
	});

	it.each(["pty_terminal", "acp_stdio_subprocess"] as const)(
		"OMP 主会话切换为 %s 后，协作 fork 沿用当前所属通道",
		async (sessionTransport) => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
			const currentMainSummary = createSummary({
				agentId: "omp",
				sessionTransport,
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "omp",
					nativeSessionId: "11111111-2222-4333-8444-555555555555",
					transcriptPath: null,
					observedAt: 1,
				},
			});
			// TUI → ACP 保留已停的 terminal summary；ACP → TUI 则摘除 ACP 账本条目。
			const terminalMainSummary =
				sessionTransport === "pty_terminal"
					? currentMainSummary
					: createSummary({
							...currentMainSummary,
							sessionTransport: "pty_terminal",
							turnOwner: "user",
							liveness: "interrupted",
							userTurnKind: "interrupted",
							pid: null,
						});
			const baseMetadata = createCollaborationSummary().taskConversationSessionMetadata;
			if (!baseMetadata) throw new Error("缺少协作会话夹具 metadata");
			const metadata = {
				...baseMetadata,
				taskConversationSessionContextSource: "forked_from_main_current_turn" as const,
				parentTaskConversationSessionId: "task-1",
			};
			const startedSummary = createSummary({
				taskId: "collaborator-after-transport-switch",
				agentId: "omp",
				sessionTransport,
				taskConversationSessionMetadata: metadata,
			});
			const terminalManager = {
				getSummary: vi.fn((id: string) => (id === "task-1" ? terminalMainSummary : null)),
				listSummaries: vi.fn(() => [terminalMainSummary]),
				startTaskSession: vi.fn(async () => startedSummary),
			};
			const acpService = {
				getSummary: vi.fn((id: string) =>
					id === "task-1" && sessionTransport === "acp_stdio_subprocess" ? currentMainSummary : null,
				),
				listSummaries: vi.fn(() => (sessionTransport === "acp_stdio_subprocess" ? [currentMainSummary] : [])),
				startTaskSession: vi.fn(async () => startedSummary),
			};
			agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				setActiveRuntimeConfig: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				getScopedAcpTaskSessionService: vi.fn(async () => acpService as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: startedSummary.taskId,
					workspaceTaskId: "task-1",
					agentId: "omp",
					baseRef: "main",
					prompt: "复刻当前主会话",
					taskConversationSessionMetadata: metadata,
				},
			);
			expect(response).toMatchObject({ ok: true });
			const selectedStart =
				sessionTransport === "acp_stdio_subprocess"
					? acpService.startTaskSession
					: terminalManager.startTaskSession;
			const unselectedStart =
				sessionTransport === "acp_stdio_subprocess"
					? terminalManager.startTaskSession
					: acpService.startTaskSession;
			expect(unselectedStart).not.toHaveBeenCalled();
			expect(selectedStart).toHaveBeenCalledWith(
				expect.objectContaining({
					taskConversationSessionContextForkSourceNativeSessionId:
						currentMainSummary.agentNativeConversationSessionIdentity?.nativeSessionId,
					taskConversationSessionMetadata: expect.objectContaining({
						taskConversationSessionLaunchSettings: expect.objectContaining({ sessionTransport }),
					}),
				}),
				...(sessionTransport === "pty_terminal" ? [expect.any(String)] : []),
			);
		},
	);

	const taskCollaboratorMainContextForkMainSessionBindingAndNativeIdentityValidationScenarioNames = [
		"模型继承",
		"父会话不匹配",
		"准备期间切主",
		"工作目录准备期间原生身份变化",
		"配置准备期间原生身份变化",
		"探针期间原生身份变化",
		"交接后的当前主会话",
	] as const;

	it.each(taskCollaboratorMainContextForkMainSessionBindingAndNativeIdentityValidationScenarioNames)(
		"协作 fork：%s",
		async (scenario) => {
			const board = await workspaceStateMocks.loadWorkspaceBoardById();
			const card = board.columns
				.flatMap((column: { cards: RuntimeBoardCard[] }) => column.cards)
				.find((candidate: RuntimeBoardCard) => candidate.id === "task-1");
			if (!card) throw new Error("缺少宿主卡片夹具");
			const mainId = scenario === "交接后的当前主会话" ? "new-main-session" : "task-1";
			if (mainId !== "task-1") card.mainTaskConversationSessionId = mainId;
			const main = createSummary({
				taskId: mainId,
				agentId: "claude",
				taskConversationSessionMetadata:
					mainId !== "task-1"
						? {
								workspaceTaskId: "task-1",
								taskConversationSessionRole: "main",
								taskConversationSessionRoleAtCreation: "task_collaborator",
								taskConversationSessionContextSource: "started_from_scratch",
								parentTaskConversationSessionId: null,
								mainSessionOriginTurnNumber: 0,
								mainSessionOriginUserMessagePreview: null,
								latestUserMessagePreview: null,
							}
						: undefined,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "claude",
					nativeSessionId: "old-native-main",
					transcriptPath: null,
					observedAt: 1,
				},
			});
			const mainIdentity = main.agentNativeConversationSessionIdentity;
			if (!mainIdentity) throw new Error("缺少主身份夹具");
			taskWorktreeMocks.resolveTaskCwd.mockImplementation(async () => {
				if (scenario === "准备期间切主") card.mainTaskConversationSessionId = "replacement-main";
				if (scenario === "工作目录准备期间原生身份变化") mainIdentity.nativeSessionId = "new-native-main";
				return "/tmp/worktree";
			});
			if (scenario === "模型继承" || scenario === "探针期间原生身份变化" || scenario === "交接后的当前主会话")
				persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId.mockImplementationOnce(
					async () => {
						if (scenario === "探针期间原生身份变化") mainIdentity.nativeSessionId = "changed-main-native";
						return "claude-sonnet-5";
					},
				);
			const baseMetadata = createCollaborationSummary().taskConversationSessionMetadata;
			if (!baseMetadata) throw new Error("缺少协作 metadata 夹具");
			const metadata = {
				...baseMetadata,
				taskConversationSessionContextSource: "forked_from_main_current_turn" as const,
				parentTaskConversationSessionId: scenario === "父会话不匹配" ? "wrong-parent" : mainId,
			};
			const terminalManager = {
				getSummary: vi.fn((id: string) => (id === mainId ? main : null)),
				listSummaries: vi.fn(() => [main]),
				startTaskSession: vi.fn(async () =>
					createSummary({ taskId: "fork-child", taskConversationSessionMetadata: metadata }),
				),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				setActiveRuntimeConfig: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(async () => {
					if (scenario === "配置准备期间原生身份变化") mainIdentity.nativeSessionId = "new-native-main";
					return createRuntimeConfigState();
				}),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: "fork-child",
					workspaceTaskId: "task-1",
					agentId: "claude",
					baseRef: "main",
					prompt: "新的协作任务",
					taskConversationSessionMetadata: metadata,
					terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "stale-card-model" },
				},
			);
			if (scenario === "模型继承" || scenario === "交接后的当前主会话") {
				expect(response).toMatchObject({ ok: true });
				expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
					expect.objectContaining({
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-sonnet-5[1m]" },
						taskConversationSessionContextForkSourceNativeSessionId: mainIdentity.nativeSessionId,
					}),
					expect.any(String),
				);
			} else {
				expect(response).toMatchObject({ ok: false });
				expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
			}
		},
	);

	describe("协作会话完整重启后的持久化恢复", () => {
		function createColdRuntimeFixture(
			sessionTransport: "pty_terminal" | "acp_stdio_subprocess",
			isCurrentMain = false,
			codexReasoningEffortOverride?: string,
		) {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
			const metadata = createCollaborationSummary().taskConversationSessionMetadata;
			if (!metadata?.taskConversationSessionLaunchSettings) throw new Error("协作会话夹具缺少启动快照");
			const agentId = sessionTransport === "pty_terminal" ? "codex" : "omp";
			const persisted = createCollaborationSummary({
				agentId,
				sessionTransport,
				taskConversationSessionMetadata: {
					...metadata,
					taskConversationSessionRole: isCurrentMain ? "main" : "task_collaborator",
					taskConversationSessionRoleAtCreation: "task_collaborator",
					taskConversationSessionLaunchSettings: {
						...metadata.taskConversationSessionLaunchSettings,
						sessionTransport,
						startInPlanMode: true,
						codexReasoningEffortOverride,
						terminalAgentModelOverrideSettings:
							sessionTransport === "pty_terminal"
								? { agentId: "codex", modelId: "collaborator-model" }
								: undefined,
					},
				},
				agentNativeConversationSessionIdentity: {
					sourceAgentId: agentId,
					nativeSessionId: "11111111-2222-4333-8444-555555555555",
					transcriptPath: null,
					observedAt: 1,
				},
			});
			if (isCurrentMain) {
				workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
					columns: [
						{
							id: "in_progress",
							title: "进行中",
							cards: [
								{
									id: "task-1",
									title: "已交接任务",
									prompt: "原任务需求不能在恢复时重投",
									baseRef: "main",
									agentId: "codex",
									codexReasoningEffortOverride: "ultra",
									taskAgentPermissionMode: "bypass_all_permission_prompts",
									mainTaskConversationSessionId: persisted.taskId,
									taskMainSessionHandover: {
										handoverId: "cold-handover",
										sourceTaskConversationSessionId: "task-1",
										targetTaskConversationSessionId: persisted.taskId,
										destination: { kind: "new_codex_session" },
										status: "report_delivery_pending",
										createdAt: 1,
										updatedAt: 1,
										userContextNotes: "",
										additionalPlanReferencePaths: [],
										materialDirectoryPath: null,
										errorMessage: null,
										reportDeliveryStartedAt: null,
										reportDeliveryAttempt: 0,
									},
									createdAt: 1,
									updatedAt: 1,
								},
							],
						},
					],
				});
			}
			const spawnPty = vi.fn(async (request: HostedTerminalPtyProcessSpawnRequest) => {
				let exited = false;
				return {
					pid: 4321,
					write: vi.fn(),
					resize: vi.fn(),
					pause: vi.fn(),
					resume: vi.fn(),
					hasExited: () => exited,
					wasInterrupted: () => true,
					stop: () => {
						exited = true;
						request.onExit({ exitCode: 0 });
					},
				};
			});
			const terminalManager = new TerminalSessionManager({
				hostedTerminalPtyProcessSpawner: { spawnHostedTerminalPtyProcess: spawnPty },
			});
			// 生产路径：JSON 落盘边界后 hydrate，restartRequest 与 ACP latestStartRequest 均为空。
			terminalManager.hydrateFromRecord(JSON.parse(JSON.stringify({ [persisted.taskId]: persisted })));
			const acpService = createAcpTaskSessionService();
			const workspaceScope = {
				workspaceId: `collaboration-cold-${process.pid}-${Math.random().toString(16).slice(2)}`,
				workspacePath: "/tmp/repo",
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => workspaceScope.workspaceId),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager),
				getScopedAcpTaskSessionService: vi.fn(async () => acpService),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			return { persisted, terminalManager, acpService, workspaceScope, api, spawnPty };
		}

		it.each([undefined, "max"])("冷恢复保留会话自己的推理选择 %s，不套用宿主覆盖", async (effort) => {
			const { persisted, terminalManager, workspaceScope, api } = createColdRuntimeFixture(
				"pty_terminal",
				true,
				effort,
			);
			const startSession = vi.spyOn(terminalManager, "startTaskSession").mockResolvedValue(persisted);
			try {
				const response = await api.startTaskSession(workspaceScope, {
					taskId: "task-1",
					baseRef: "main",
					prompt: "",
				});
				expect(response.ok).toBe(true);
				expect(startSession).toHaveBeenCalledWith(
					expect.objectContaining({ taskId: persisted.taskId, codexReasoningEffortOverride: effort }),
					expect.any(String),
				);
			} finally {
				startSession.mockRestore();
				terminalManager.markInterruptedAndStopAll();
			}
		});

		it("Task 默认启动跟随新主；显式前主启动与 Sessions 重启都保留 Claude 身份和配置", async () => {
			const { persisted, terminalManager, workspaceScope, api } = createColdRuntimeFixture("pty_terminal", true);
			const formerMain = createSummary({
				taskId: "task-1",
				agentId: "claude",
				pid: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "claude",
					nativeSessionId: "66666666-7777-4888-8999-000000000000",
					transcriptPath: null,
					observedAt: 1,
				},
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionRoleAtCreation: "main",
					taskConversationSessionContextSource: "main",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
					taskConversationSessionLaunchSettings: {
						sessionTransport: "pty_terminal",
						taskAgentPermissionMode: "ask_for_every_tool_use",
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "former-main-model" },
					},
				},
			});
			terminalManager.hydrateFromRecord(
				JSON.parse(JSON.stringify({ [persisted.taskId]: persisted, [formerMain.taskId]: formerMain })),
			);
			agentRegistryMocks.resolveAgentCommand.mockImplementation((config: RuntimeConfigState) => ({
				agentId: config.selectedAgentId,
				binary: "agent",
				args: [],
			}));
			const startPty = vi.spyOn(terminalManager, "startTaskSession").mockImplementation(async (request) =>
				createSummary({
					...(request.taskId === formerMain.taskId ? formerMain : persisted),
					pid: 4321,
					taskConversationSessionMetadata: request.taskConversationSessionMetadata,
				}),
			);
			const refreshPty = vi.spyOn(terminalManager, "refreshTaskTerminal").mockResolvedValue(formerMain);
			try {
				const defaultStarted = await api.startTaskSession(workspaceScope, {
					taskId: "task-1",
					baseRef: "main",
					prompt: "不能重投给旧 Claude",
					agentId: "claude",
				});
				expect(defaultStarted).toMatchObject({ ok: true, summary: { taskId: persisted.taskId, agentId: "codex" } });
				expect(startPty).toHaveBeenLastCalledWith(
					expect.objectContaining({ taskId: persisted.taskId, workspaceTaskId: "task-1", prompt: "" }),
					expect.any(String),
				);
				startPty.mockClear();
				const explicitStarted = await api.startTaskSession(workspaceScope, {
					taskId: "task-1",
					workspaceTaskId: "task-1",
					baseRef: "main",
					prompt: "",
					// 卡片上的当前 agent 已经变成 Codex，恢复必须采用前主自己的持久身份。
					agentId: "codex",
					startInPlanMode: true,
				});
				expect(explicitStarted).toMatchObject({ ok: true, summary: { taskId: "task-1", agentId: "claude" } });
				expect(startPty).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						taskId: "task-1",
						workspaceTaskId: "task-1",
						agentId: "claude",
						prompt: "",
						startInPlanMode: undefined,
						taskAgentPermissionMode: "ask_for_every_tool_use",
						resumePriorAgentConversationWithoutResendingPrompt: true,
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "former-main-model" },
						taskConversationSessionMetadata: expect.objectContaining({
							taskConversationSessionRole: "task_collaborator",
							taskConversationSessionRoleAtCreation: "main",
						}),
					}),
					expect.any(String),
				);
				expect(terminalManager.getSummary(formerMain.taskId)?.agentNativeConversationSessionIdentity).toEqual(
					formerMain.agentNativeConversationSessionIdentity,
				);
				expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
				const refreshed = await api.refreshTaskTerminal(workspaceScope, { taskId: formerMain.taskId });
				expect(refreshed.ok).toBe(true);
				expect(refreshPty).toHaveBeenCalledWith(
					expect.objectContaining({
						taskId: formerMain.taskId,
						workspaceTaskId: "task-1",
						agentId: "claude",
						taskAgentPermissionMode: "ask_for_every_tool_use",
						terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "former-main-model" },
					}),
					"refresh_task_terminal",
				);
				expect(
					persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						agentNativeConversationSessionId: formerMain.agentNativeConversationSessionIdentity?.nativeSessionId,
					}),
				);
				expect(
					(await workspaceStateMocks.loadWorkspaceBoardById(workspaceScope.workspaceId)).columns[0].cards[0]
						.mainTaskConversationSessionId,
				).toBe(persisted.taskId);
			} finally {
				startPty.mockRestore();
				refreshPty.mockRestore();
				terminalManager.markInterruptedAndStopAll();
			}
		});

		it("切主后首次启动之前中断，Task Start 可用已持久化快照全新启动接任 Codex", async () => {
			const { persisted, terminalManager, workspaceScope, api, spawnPty } = createColdRuntimeFixture(
				"pty_terminal",
				true,
			);
			const reservedTarget = {
				...persisted,
				startedAt: null,
				agentNativeConversationSessionIdentity: undefined,
			};
			terminalManager.hydrateFromRecord(JSON.parse(JSON.stringify({ [reservedTarget.taskId]: reservedTarget })));
			agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "codex", binary: "agent", args: [] });
			const startPty = vi.spyOn(terminalManager, "startTaskSession");
			try {
				const response = await api.startTaskSession(workspaceScope, {
					taskId: "task-1",
					baseRef: "main",
					prompt: "不能重投旧任务需求",
				});
				expect(response).toMatchObject({ ok: true, summary: { taskId: reservedTarget.taskId, pid: 4321 } });
				expect(startPty).toHaveBeenCalledWith(
					expect.objectContaining({
						taskId: reservedTarget.taskId,
						workspaceTaskId: "task-1",
						agentId: "codex",
						prompt: "",
						taskAgentPermissionMode: "ask_for_every_tool_use",
						resumePriorAgentConversationWithoutResendingPrompt: false,
					}),
					expect.any(String),
				);
				expect(spawnPty).toHaveBeenCalledTimes(1);
				expect(spawnPty.mock.calls[0][0].args).not.toContain("resume");
				expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
			} finally {
				startPty.mockRestore();
				terminalManager.markInterruptedAndStopAll();
			}
		});

		it("生产 hydrate 保留 ACP 通道，真实 refresh 分流拒绝把它重开为 PTY", async () => {
			const { persisted, terminalManager, api, workspaceScope } = createColdRuntimeFixture("acp_stdio_subprocess");
			const startPty = vi.spyOn(terminalManager, "refreshTaskTerminal");
			expect(terminalManager.getSummary(persisted.taskId)?.sessionTransport).toBe("acp_stdio_subprocess");
			const response = await api.refreshTaskTerminal(workspaceScope, {
				taskId: persisted.taskId,
				cols: 120,
				rows: 40,
			});
			expect(response.ok).toBe(false);
			expect(startPty).not.toHaveBeenCalled();
		});

		it("切换 PTY 失败先保存新目标，完整重启后明确发送仍只恢复 PTY", async () => {
			const { persisted, terminalManager, acpService, workspaceScope, api } =
				createColdRuntimeFixture("acp_stdio_subprocess");
			const persistedSessions: Record<string, RuntimeTaskSessionSummary> = {};
			workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_path, _intent, mutate) => {
				const board = await workspaceStateMocks.loadWorkspaceBoardById(workspaceScope.workspaceId);
				const result = mutate({ board, sessions: persistedSessions });
				if (result.sessions) Object.assign(persistedSessions, result.sessions);
				return { saved: true, value: result.value };
			});
			agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
			const startAcp = vi.spyOn(acpService, "startTaskSession");
			const response = await api.switchAgentSessionTransport(
				workspaceScope,
				{ taskId: persisted.taskId, targetSessionTransport: "pty_terminal" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			);
			expect(response).toMatchObject({ ok: false, priorAgentSessionStopped: true });
			expect(terminalManager.getSummary(persisted.taskId)?.pid).toBeNull();
			expect(persistedSessions[persisted.taskId]).toMatchObject({
				sessionTransport: "pty_terminal",
				taskConversationSessionMetadata: {
					taskConversationSessionLaunchSettings: { sessionTransport: "pty_terminal" },
				},
			});
			const board = await workspaceStateMocks.loadWorkspaceBoardById(workspaceScope.workspaceId);
			expect(
				board.columns
					.flatMap((column: { cards: RuntimeBoardCard[] }) => column.cards)
					.find((card: RuntimeBoardCard) => card.id === "task-1")?.ompAgentSessionTransport,
			).toBeUndefined();
			terminalManager.hydrateFromRecord(JSON.parse(JSON.stringify(persistedSessions)));
			agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
			const startPty = vi.spyOn(terminalManager, "startTaskSession").mockImplementation(async (request) =>
				createSummary({
					...persisted,
					sessionTransport: "pty_terminal",
					taskConversationSessionMetadata: request.taskConversationSessionMetadata,
				}),
			);
			vi.spyOn(terminalManager, "submitTaskChatInputWhenReady").mockReturnValue(
				createSummary({ ...persisted, sessionTransport: "pty_terminal" }),
			);
			const sent = await api.sendTaskChatMessage(
				workspaceScope,
				{ taskId: persisted.taskId, text: "按新通道继续" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			);
			expect(sent.ok).toBe(true);
			expect(startPty).toHaveBeenCalledWith(
				expect.objectContaining({
					workspaceTaskId: "task-1",
					startInPlanMode: undefined,
					taskConversationSessionMetadata: expect.objectContaining({
						taskConversationSessionLaunchSettings: expect.objectContaining({ sessionTransport: "pty_terminal" }),
					}),
				}),
				expect.any(String),
			);
			expect(startAcp).not.toHaveBeenCalled();
		});

		it.each([
			{ sessionTransport: "pty_terminal", isCurrentMain: false, isLegacyMain: false },
			{ sessionTransport: "acp_stdio_subprocess", isCurrentMain: false, isLegacyMain: false },
			{ sessionTransport: "pty_terminal", isCurrentMain: true, isLegacyMain: false },
			{ sessionTransport: "pty_terminal", isCurrentMain: true, isLegacyMain: true },
		] as const)(
			"$sessionTransport 冷恢复后投递原生答案，当前主会话=$isCurrentMain 旧主会话=$isLegacyMain",
			async ({ sessionTransport, isCurrentMain, isLegacyMain }) => {
				const { persisted, terminalManager, acpService, workspaceScope, api, spawnPty } = createColdRuntimeFixture(
					sessionTransport,
					isCurrentMain,
				);
				if (isLegacyMain) {
					const board = await workspaceStateMocks.loadWorkspaceBoardById(workspaceScope.workspaceId);
					const task = board.columns[0].cards[0];
					task.mainTaskConversationSessionId = undefined;
					task.taskMainSessionHandover = undefined;
					task.codexConfigurationPermissionSelectionSource = "profile";
					task.codexReasoningEffortOverride = undefined;
					task.codexReasoningEffortFollowsNativeConfiguration = true;
					persisted.taskId = task.id;
					persisted.taskConversationSessionMetadata = undefined;
					terminalManager.hydrateFromRecord(JSON.parse(JSON.stringify({ [persisted.taskId]: persisted })));
				}
				const nativeIdentity = persisted.agentNativeConversationSessionIdentity;
				agentRegistryMocks.resolveAgentCommand.mockReturnValue({
					agentId: persisted.agentId,
					binary: "agent",
					args: [],
				});
				const startPty = vi.spyOn(terminalManager, "startTaskSession");
				const submitPty = vi
					.spyOn(terminalManager, "submitTaskChatInputWhenReady")
					.mockImplementation((_taskId, _text, options) => {
						options?.onDeliveryOutcome?.({ status: "delivered_and_submit_confirmed", reason: null });
						return createSummary({ ...persisted, pid: 4321 });
					});
				let connected: AcpTaskConnection | null = null;
				const promptAcp = vi.fn(async () => ({ stopReason: "end_turn" as const }));
				const startAcp = vi
					.spyOn(AcpClientConnectionRuntime.prototype, "startTaskConnection")
					.mockImplementation(async (request) => {
						connected = {
							taskId: request.taskId,
							agentId: "omp",
							sessionId: nativeIdentity?.nativeSessionId ?? "missing-native-id",
							pid: 4322,
							initializeResponse: { protocolVersion: 1, agentCapabilities: {} },
							prompt: promptAcp,
							cancel: async () => {},
							setSessionMode: async () => {},
							close: () => {},
						};
						return connected;
					});
				const getAcpConnection = vi
					.spyOn(AcpClientConnectionRuntime.prototype, "getConnection")
					.mockImplementation(() => connected);
				const originalCodexHome = process.env.CODEX_HOME;
				const isolatedCodexHome =
					sessionTransport === "pty_terminal" ? mkdtempSync(join(tmpdir(), "collaborator-codex-question-")) : null;
				const callId = "collaborator-saved-answer";
				const codexToolInput = { questions: [{ id: "collaboration-plan", question: "按哪个方案继续？" }] };
				const codexQuestion = isolatedCodexHome
					? extractCodexUserQuestionPayload({
							callId,
							toolInput: codexToolInput,
							nativeConversationSessionId: nativeIdentity?.nativeSessionId,
						})
					: null;
				const decisionId = codexQuestion ? `${persisted.taskId}:${codexQuestion.decisionSourceId}` : callId;
				try {
					if (isolatedCodexHome) {
						if (!codexQuestion) throw new Error("协作会话夹具缺少有效 Codex 问题");
						process.env.CODEX_HOME = isolatedCodexHome;
						const transcriptDirectory = join(isolatedCodexHome, "sessions", "2026", "10", "17");
						mkdirSync(transcriptDirectory, { recursive: true });
						// 冷恢复投递必须有同一原生对话、同一 call 的未答证据，不能借 OMP 问题绕过核验。
						writeFileSync(
							join(transcriptDirectory, `rollout-${nativeIdentity?.nativeSessionId}.jsonl`),
							`${[
								{
									type: "session_meta",
									timestamp: new Date(0).toISOString(),
									payload: { id: nativeIdentity?.nativeSessionId },
								},
								{
									type: "response_item",
									timestamp: new Date(1).toISOString(),
									payload: {
										type: "function_call",
										name: "request_user_input",
										call_id: callId,
										arguments: JSON.stringify(codexToolInput),
									},
								},
								{
									type: "response_item",
									timestamp: new Date(2).toISOString(),
									payload: { type: "function_call_output", call_id: callId, output: "aborted" },
								},
							]
								.map((record) => JSON.stringify(record))
								.join("\n")}\n`,
						);
					}
					expect(
						await terminalManager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(
							persisted.taskId,
						),
					).toBe(false);
					expect(
						await acpService.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(persisted.taskId),
					).toBe(false);
					await recordAgentRaisedPendingUserDecision(workspaceScope.workspaceId, {
						workspaceId: workspaceScope.workspaceId,
						decisionId,
						taskId: persisted.taskId,
						agentId: sessionTransport === "pty_terminal" ? "codex" : "omp",
						sessionTransport,
						decisionKind: "ordinary_user_question",
						questionMarkdown: codexQuestion?.questionMarkdown ?? "按哪个方案继续？",
						options: codexQuestion?.options ?? [],
						orderedQuestions: codexQuestion?.orderedQuestions,
						nativeConversationSessionId: codexQuestion?.nativeConversationSessionId,
						allowsFreeformAnswer: true,
						askedAt: 1,
						graceDeadlineAt: null,
						originRuntimeSessionIncarnationId: "previous-runtime",
						originTurnSequence: 1,
						sourceHarnessSignal: codexQuestion ? "codex:request_user_input" : "omp:question",
					});
					await recordAgentRaisedPendingUserDecisionAnswer(workspaceScope.workspaceId, decisionId, {
						selectedOptionIds: [],
						freeformText: "采用方案甲",
						answeredAt: 2,
					});
					const response = await api.answerAgentRaisedPendingUserDecision(workspaceScope, {
						decisionId,
						selectedOptionIds: [],
						freeformText: null,
					});
					expect(response).toMatchObject({ ok: true, delivered: true });
					expect(
						(await readAgentRaisedPendingUserDecisions(workspaceScope.workspaceId))[0]?.answerDeliveryState,
					).toBe("delivered");
					if (sessionTransport === "acp_stdio_subprocess") {
						expect(startAcp).toHaveBeenCalledWith(
							expect.objectContaining({
								cwd: "/tmp/worktree",
								permissionMode: "ask_for_every_tool_use",
								observedAgentNativeSessionId: nativeIdentity?.nativeSessionId,
								startInPlanMode: false,
							}),
						);
						expect(promptAcp).toHaveBeenCalledWith(
							expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("采用方案甲") })]),
						);
						expect(startPty).not.toHaveBeenCalled();
					} else {
						expect(startPty).toHaveBeenCalledWith(
							expect.objectContaining({
								cwd: "/tmp/worktree",
								taskAgentPermissionMode: "ask_for_every_tool_use",
								startInPlanMode: undefined,
								...(isLegacyMain
									? {
											taskId: "task-1",
											usesLegacyCodexProfilePermissions: true,
											codexReasoningEffortFollowsNativeConfiguration: true,
										}
									: {
											workspaceTaskId: "task-1",
											terminalAgentModelOverrideSettings: {
												agentId: "codex",
												modelId: "collaborator-model",
											},
										}),
							}),
							isLegacyMain ? "durable_record_rebuilt_resume" : expect.any(String),
						);
						expect(terminalManager.getSummary(persisted.taskId)?.agentNativeConversationSessionIdentity).toEqual(
							nativeIdentity,
						);
						expect(submitPty).toHaveBeenCalledWith(
							persisted.taskId,
							expect.stringContaining("采用方案甲"),
							expect.anything(),
						);
						expect(startAcp).not.toHaveBeenCalled();
						expect(spawnPty).toHaveBeenCalledWith(
							expect.objectContaining({
								args: expect.arrayContaining(["resume", nativeIdentity?.nativeSessionId]),
								cwd: "/tmp/worktree",
							}),
						);
					}
					expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith(
						expect.objectContaining({ cwd: "/tmp/repo", taskId: "task-1" }),
					);
				} finally {
					if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
					else process.env.CODEX_HOME = originalCodexHome;
					if (isolatedCodexHome) rmSync(isolatedCodexHome, { recursive: true, force: true });
					terminalManager.markInterruptedAndStopAll();
					startAcp.mockRestore();
					getAcpConnection.mockRestore();
					rmSync(`/tmp/kanban-workspaces/${workspaceScope.workspaceId}`, { recursive: true, force: true });
				}
			},
		);
	});

	it("冷启动 ACP 协作会话按自身身份恢复后才投递用户消息，权限不回退到宿主", async () => {
		const metadata = createCollaborationSummary().taskConversationSessionMetadata;
		if (!metadata?.taskConversationSessionLaunchSettings) throw new Error("协作会话夹具缺少启动快照");
		const persisted = createCollaborationSummary({
			taskConversationSessionMetadata: {
				...metadata,
				taskConversationSessionLaunchSettings: {
					...metadata.taskConversationSessionLaunchSettings,
					startInPlanMode: true,
				},
			},
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "omp",
				nativeSessionId: "native-collaborator",
				transcriptPath: null,
				observedAt: 1,
			},
		});
		persisted.agentWorkProgressEntries = advanceAgentWorkProgress(
			persisted,
			{ progressEntryId: "persisted-progress", progressText: "已确认方案" },
			"persisted-progress",
			100,
		);
		let active: RuntimeTaskSessionSummary | null = null;
		const acpService = {
			getSummary: vi.fn(() => active),
			listSummaries: vi.fn(() => []),
			resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery: vi.fn(async () => false),
			startTaskSession: vi.fn(async (request) => {
				active = createCollaborationSummary({
					taskConversationSessionMetadata: request.taskConversationSessionMetadata,
				});
				return active;
			}),
			sendTaskSessionInput: vi.fn(async () => active),
			listMessages: vi.fn(() => []),
		};
		const terminalManager = { getSummary: vi.fn(() => persisted), listSummaries: vi.fn(() => [persisted]) };
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: persisted.taskId, text: "继续协作" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(response.ok).toBe(true);
		expect(acpService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceTaskId: "task-1",
				taskId: persisted.taskId,
				permissionMode: "ask_for_every_tool_use",
				prompt: "",
				resumePriorAgentConversationWithoutResendingPrompt: true,
				observedAgentNativeConversationSessionIdentity: persisted.agentNativeConversationSessionIdentity,
				persistedTaskSessionSummaryForProgressRestoration: expect.objectContaining({
					agentWorkProgressEntries: persisted.agentWorkProgressEntries,
				}),
				startInPlanMode: undefined,
				taskConversationSessionMetadata: expect.objectContaining({
					taskConversationSessionLaunchSettings: expect.objectContaining({ startInPlanMode: true }),
				}),
			}),
		);
		expect(acpService.sendTaskSessionInput).toHaveBeenCalledWith(
			persisted.taskId,
			"继续协作",
			undefined,
			undefined,
			undefined,
			expect.any(Function),
			undefined,
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it.each([
		{ stopWholeTask: false, corruptOperations: false },
		{ stopWholeTask: true, corruptOperations: false },
		{ stopWholeTask: true, corruptOperations: true },
	])(
		"混合通道停止：停止整任务=$stopWholeTask，操作记录损坏=$corruptOperations",
		async ({ stopWholeTask, corruptOperations }) => {
			const side = createCollaborationSummary({ agentId: "codex", sessionTransport: "pty_terminal" });
			const main = createSummary({ agentId: "omp", sessionTransport: "acp_stdio_subprocess" });
			const acpService = {
				listSummaries: () => [main],
				stopTaskSession: vi.fn(async (id: string) => (id === main.taskId ? main : null)),
			};
			const terminalManager = { listSummaries: () => [side], stopTaskSession: vi.fn(() => side) };
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				getScopedAcpTaskSessionService: vi.fn(async () => acpService as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const workspaceId = corruptOperations ? "workspace-with-corrupted-session-operations" : "workspace-1";
			const operationDirectoryPath = join(
				workspaceStateMocks.runtimeHomePath,
				"task-conversation-session-operations",
			);
			if (corruptOperations) {
				mkdirSync(operationDirectoryPath, { recursive: true });
				writeFileSync(
					join(operationDirectoryPath, `${createHash("sha256").update(workspaceId).digest("hex")}.json`),
					"损坏的操作记录",
				);
			}
			const response = await api.stopTaskSession(
				{ workspaceId, workspacePath: "/tmp/repo" },
				{ taskId: stopWholeTask ? main.taskId : side.taskId },
			);
			expect(response.ok).toBe(true);
			expect(terminalManager.stopTaskSession).toHaveBeenCalledExactlyOnceWith(side.taskId);
			if (stopWholeTask) expect(acpService.stopTaskSession).toHaveBeenCalledWith(main.taskId);
			else expect(acpService.stopTaskSession).not.toHaveBeenCalledWith(main.taskId);
		},
	);

	it.each([
		{ transport: "acp", stopPersistenceFails: false, exitConfirmed: true, hasLiveConnection: true },
		{ transport: "acp", stopPersistenceFails: false, exitConfirmed: false, hasLiveConnection: true },
		{ transport: "acp", stopPersistenceFails: true, exitConfirmed: true, hasLiveConnection: true },
		{ transport: "acp", stopPersistenceFails: false, exitConfirmed: true, hasLiveConnection: false },
		{ transport: "pty", stopPersistenceFails: false, exitConfirmed: true, hasLiveConnection: true },
		{ transport: "pty", stopPersistenceFails: false, exitConfirmed: false, hasLiveConnection: true },
		{ transport: "pty", stopPersistenceFails: true, exitConfirmed: true, hasLiveConnection: true },
	])(
		"精确停止分别返回持久撤销和实际退出证据 %j",
		async ({ transport, stopPersistenceFails, exitConfirmed, hasLiveConnection }) => {
			const side = createCollaborationSummary();
			let connectionLive = hasLiveConnection;
			const workspaceId = `stop-confirmation-${transport}-${stopPersistenceFails}-${exitConfirmed}-${hasLiveConnection}`;
			const acpService = {
				listSummaries: () => (transport === "acp" ? [side] : []),
				getSummary: () => (transport === "acp" ? side : null),
				hasLiveTaskSession: () => connectionLive,
				stopTaskSessionForReclamation: vi.fn(async () => {
					connectionLive = false;
					return { rootProcessExitConfirmed: exitConfirmed };
				}),
			};
			const terminalManager = {
				listSummaries: () => (transport === "pty" ? [side] : []),
				stopTaskSessionAndConfirmExit: vi.fn(async () => ({ summary: side, processExitConfirmed: exitConfirmed })),
			};
			if (stopPersistenceFails)
				mkdirSync(
					join(
						getTaskConversationSessionOperationsRuntimeHomePath(),
						"task-conversation-session-operations",
						"explicit-session-stop-markers",
						`${createHash("sha256").update(workspaceId).digest("hex")}.json`,
					),
					{ recursive: true },
				);
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: () => workspaceId,
				loadScopedRuntimeConfig: async () => createRuntimeConfigState(),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: async () => terminalManager as never,
				getScopedAcpTaskSessionService: async () => acpService as never,
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			expect(
				await api.stopTaskSession(
					{ workspaceId, workspacePath: "/tmp/repo" },
					{ taskId: side.taskId, confirmProcessExit: true },
				),
			).toMatchObject({
				ok: !stopPersistenceFails && exitConfirmed && (transport === "pty" || hasLiveConnection),
				explicitStopRecorded: !stopPersistenceFails,
				processExitConfirmed: exitConfirmed && (transport === "pty" || hasLiveConnection),
			});
		},
	);

	it("旁问会话使用主任务目录且不创建回合检查点", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-1" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const taskConversationSessionMetadata = {
			workspaceTaskId: "task-1",
			taskConversationSessionRole: "by_the_way" as const,
			taskConversationSessionContextSource: "forked_from_main_current_turn" as const,
			parentTaskConversationSessionId: "task-1",
			mainSessionOriginTurnNumber: 4,
			mainSessionOriginUserMessagePreview: "Implement sessions",
			latestUserMessagePreview: "Why is this read-only?",
		};

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "side-session-1",
				workspaceTaskId: "task-1",
				baseRef: "main",
				prompt: "Why is this read-only?",
				agentId: "codex",
				taskConversationSessionMetadata,
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "side-session-1",
				workspaceTaskId: "task-1",
				cwd: "/tmp/main-task-worktree",
				taskConversationSessionMetadata: expect.objectContaining(taskConversationSessionMetadata),
			}),
			expect.any(String),
		);
		expect(terminalManager.applyTurnCheckpoint).not.toHaveBeenCalled();
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	describe("宿主卡未落盘时拒绝启动卡片会话", () => {
		function createRuntimeApiWithTerminalManagerSpy() {
			const terminalManager = {
				getSummary: vi.fn(() => null),
				listSummaries: vi.fn(() => []),
				startTaskSession: vi.fn(async () => createSummary()),
				applyTurnCheckpoint: vi.fn(),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			return { api, terminalManager };
		}

		it("主会话的卡不在盘上 board 里：不建 worktree、不 spawn，返回机器可读的拒绝原因", async () => {
			const { api, terminalManager } = createRuntimeApiWithTerminalManagerSpy();
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-created-only-in-browser-memory", baseRef: "main", prompt: "Install the skill" },
			);
			expect(response).toMatchObject({
				ok: false,
				summary: null,
				taskSessionStartRejectionReason: "task_card_not_yet_persisted_on_workspace_board",
			});
			expect(response.error).toContain("task-created-only-in-browser-memory");
			expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
			expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		});

		it("By the way 侧问会话按宿主卡（workspaceTaskId）判定", async () => {
			const { api, terminalManager } = createRuntimeApiWithTerminalManagerSpy();
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: "task-conversation-session-side",
					workspaceTaskId: "task-created-only-in-browser-memory",
					baseRef: "main",
					prompt: "Why?",
					agentId: "codex",
					taskConversationSessionMetadata: {
						workspaceTaskId: "task-created-only-in-browser-memory",
						taskConversationSessionRole: "by_the_way",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: "task-created-only-in-browser-memory",
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: "Why?",
					},
				},
			);
			expect(response.taskSessionStartRejectionReason).toBe("task_card_not_yet_persisted_on_workspace_board");
			expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		});

		it("宿主卡已在盘上（含 trash 列里的卡从 trash 恢复）时照常启动", async () => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/task-1-worktree");
			const { api, terminalManager } = createRuntimeApiWithTerminalManagerSpy();
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", baseRef: "main", prompt: "Implement task" },
			);
			expect(response.ok).toBe(true);
			expect(response.taskSessionStartRejectionReason).toBeUndefined();
			expect(terminalManager.startTaskSession).toHaveBeenCalledOnce();
		});

		// 启动开始时卡还在、spawn 期间被别的客户端删掉：删卡方那时还看不到会话，只能由启动方自己停掉。
		describe("启动开始时宿主卡在盘上、会话启动期间卡被删", () => {
			function simulateHostTaskCardDeletedFromWorkspaceBoardByAnotherClient(): void {
				workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				});
			}

			it("终端会话：停掉刚启动的会话、不回写卡片、不打 checkpoint，返回同一拒绝原因", async () => {
				taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/task-1-worktree");
				workspaceStateMocks.mutateWorkspaceState.mockClear();
				const terminalManager = {
					getSummary: vi.fn(() => null),
					listSummaries: vi.fn(() => []),
					startTaskSession: vi.fn(async () => {
						simulateHostTaskCardDeletedFromWorkspaceBoardByAnotherClient();
						return createSummary();
					}),
					stopTaskSession: vi.fn(() => createSummary({ state: "interrupted" })),
					applyTurnCheckpoint: vi.fn(),
				};
				const api = createTestRuntimeApi({
					getActiveWorkspaceId: vi.fn(() => "workspace-1"),
					loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
					setActiveRuntimeConfig: vi.fn(),
					getScopedTerminalManager: vi.fn(async () => terminalManager as never),
					resolveInteractiveShellCommand: vi.fn(),
					runCommand: vi.fn(),
				});

				const response = await api.startTaskSession(
					{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
					{ taskId: "task-1", baseRef: "main", prompt: "Implement task" },
				);

				expect(response).toMatchObject({
					ok: false,
					summary: null,
					taskSessionStartRejectionReason: "task_card_not_yet_persisted_on_workspace_board",
				});
				expect(response.error).toContain("task-1");
				expect(terminalManager.startTaskSession).toHaveBeenCalledOnce();
				expect(terminalManager.stopTaskSession).toHaveBeenCalledExactlyOnceWith("task-1");
				expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
				expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
			});

			it("侧边栏 home agent 会话不属于任何卡片：盘上 board 怎么变都照常启动、不被停", async () => {
				const homeTaskId = "__home_agent__:workspace-1:codex";
				simulateHostTaskCardDeletedFromWorkspaceBoardByAnotherClient();
				const terminalManager = {
					getSummary: vi.fn(() => null),
					listSummaries: vi.fn(() => []),
					startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
					stopTaskSession: vi.fn(() => null),
					applyTurnCheckpoint: vi.fn(),
				};
				const api = createTestRuntimeApi({
					getActiveWorkspaceId: vi.fn(() => "workspace-1"),
					loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
					setActiveRuntimeConfig: vi.fn(),
					getScopedTerminalManager: vi.fn(async () => terminalManager as never),
					resolveInteractiveShellCommand: vi.fn(),
					runCommand: vi.fn(),
				});

				const response = await api.startTaskSession(
					{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
					{ taskId: homeTaskId, baseRef: "main", prompt: "" },
				);

				expect(response.ok).toBe(true);
				expect(response.taskSessionStartRejectionReason).toBeUndefined();
				expect(terminalManager.stopTaskSession).not.toHaveBeenCalled();
			});
		});
	});

	it("拒绝不支持旁问会话的 agent", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-unsupported" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "side-session-unsupported",
				workspaceTaskId: "task-1",
				baseRef: "main",
				prompt: "Explain this module",
				agentId: "gemini",
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "by_the_way",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: "Explain this module",
				},
			},
		);

		expect(response).toMatchObject({ ok: false, error: expect.stringContaining("does not support") });
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("缺少主身份且已有竞争会话时拒绝 cwd-latest 复刻", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const existingByTheWaySummary = createSummary({
			taskId: "side-session-existing",
			agentId: "codex",
			taskConversationSessionMetadata: {
				workspaceTaskId: "task-1",
				taskConversationSessionRole: "by_the_way",
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "task-1",
				mainSessionOriginTurnNumber: 1,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: "Earlier question",
			},
		});
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => [existingByTheWaySummary]),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-later" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "side-session-later",
				workspaceTaskId: "task-1",
				baseRef: "main",
				prompt: "Later question",
				agentId: "codex",
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "by_the_way",
					taskConversationSessionContextSource: "forked_from_main_current_turn",
					parentTaskConversationSessionId: "task-1",
					mainSessionOriginTurnNumber: 2,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: "Later question",
				},
			},
		);

		expect(response).toMatchObject({ ok: false, error: expect.stringContaining("原生会话 ID") });
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it.each(
		(["claude", "codex"] as const).flatMap((mainAgentId) =>
			[true, false].flatMap((hasMainNativeIdentity) =>
				[true, false].map((hasSameAgentCollaborator) => ({
					mainAgentId,
					hasMainNativeIdentity,
					hasSameAgentCollaborator,
				})),
			),
		),
	)(
		"首次侧问 fork：$mainAgentId 主身份=$hasMainNativeIdentity，同 agent 协作=$hasSameAgentCollaborator",
		async ({ mainAgentId, hasMainNativeIdentity, hasSameAgentCollaborator }) => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
			agentRegistryMocks.resolveAgentCommand.mockReturnValue({
				agentId: mainAgentId,
				binary: mainAgentId,
				args: [],
			});
			const mainNativeSessionId = "11111111-2222-4333-8444-555555555555";
			const main = createSummary({
				agentId: mainAgentId,
				workspacePath: "/tmp/main-task-worktree",
				agentNativeConversationSessionIdentity: hasMainNativeIdentity
					? {
							sourceAgentId: mainAgentId,
							nativeSessionId: mainNativeSessionId,
							transcriptPath: null,
							observedAt: 1,
						}
					: undefined,
			});
			const collaborator = createCollaborationSummary({
				agentId: hasSameAgentCollaborator ? mainAgentId : mainAgentId === "claude" ? "codex" : "claude",
				workspacePath: main.workspacePath,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: mainAgentId,
					nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					transcriptPath: null,
					observedAt: 2,
				},
			});
			const terminalManager = {
				getSummary: vi.fn((taskId: string) => (taskId === main.taskId ? main : null)),
				listSummaries: vi.fn(() => [main, collaborator]),
				startTaskSession: vi.fn(async () => createSummary({ taskId: "first-by-the-way", agentId: mainAgentId })),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const response = await api.startTaskSession(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{
					taskId: "first-by-the-way",
					workspaceTaskId: "task-1",
					baseRef: "main",
					prompt: "解释实现",
					agentId: mainAgentId,
					taskConversationSessionMetadata: {
						workspaceTaskId: "task-1",
						taskConversationSessionRole: "by_the_way",
						taskConversationSessionContextSource: "forked_from_main_current_turn",
						parentTaskConversationSessionId: "task-1",
						mainSessionOriginTurnNumber: 1,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: "解释实现",
					},
				},
			);
			const mustRefuseAmbiguousFork = !hasMainNativeIdentity && hasSameAgentCollaborator;
			expect(response.ok).toBe(!mustRefuseAmbiguousFork);
			if (mustRefuseAmbiguousFork) {
				expect(response.error).toContain("主会话尚未记录可用的");
				expect(response.error).not.toContain("已有 By the way");
				expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
			} else {
				expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
					expect.objectContaining({
						taskConversationSessionContextForkSourceNativeSessionId: hasMainNativeIdentity
							? mainNativeSessionId
							: undefined,
					}),
					expect.any(String),
				);
			}
		},
	);

	it("拒绝伪造的完整权限 fork 上下文", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-forged" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "side-session-forged",
				workspaceTaskId: "task-1",
				baseRef: "main",
				prompt: "Run with full authority",
				agentId: "gemini",
				taskConversationSessionMetadata: {
					workspaceTaskId: "task-1",
					taskConversationSessionRole: "main",
					taskConversationSessionContextSource: "forked_from_main_current_turn",
					parentTaskConversationSessionId: "task-1",
					mainSessionOriginTurnNumber: 2,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: "Run with full authority",
				},
			},
		);

		expect(response).toMatchObject({ ok: false, error: expect.stringContaining("inconsistent") });
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("没有既有任务目录时创建工作树", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(1, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(2, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
	});

	it("从已观测的 Codex 身份恢复，不受旧全局 Cline 默认值影响", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const broadcastTaskChatCleared = vi.fn();
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "idle", pid: null })),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			broadcastTaskChatCleared,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Resume task",
				resumeFromTrash: true,
			},
		);

		expect(response.ok).toBe(true);
		expect(broadcastTaskChatCleared).toHaveBeenCalledWith("workspace-1", "task-1");
		expect(terminalManager.getSummary).toHaveBeenCalledWith("task-1");
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				agentId: "codex",
				resumeFromTrash: true,
			}),
			expect.any(String),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("主页 agent 使用工作区根目录且不创建任务工作树", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: homeTaskId,
				baseRef: "main",
				prompt: "",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: homeTaskId,
				cwd: "/tmp/repo",
			}),
			expect.any(String),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("向 CLI 任务会话转发图片", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const images = [
			{
				id: "img-1",
				data: Buffer.from("hello").toString("base64"),
				mimeType: "image/png",
				name: "diagram.png",
			},
		];

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images,
			},
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				images,
			}),
			expect.any(String),
		);
	});

	it.each([undefined, [], ["--cd", "/explicit restart"]])(
		"Codex 重启保留原生续跑形状并传递单次参数 %j",
		async (additionalAgentStartupArgumentsForThisRestart) => {
			taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
			agentRegistryMocks.resolveAgentCommand.mockReturnValue({
				agentId: "codex",
				label: "OpenAI Codex",
				command: "codex",
				binary: "codex",
				args: [],
			});

			const terminalManager = {
				getSummary: vi.fn(() =>
					createSummary({
						agentId: "codex",
						workspacePath: "/tmp/existing-worktree",
						startedAt: 1_700_000_000_000,
						lastOutputAt: null,
					}),
				),
				refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "codex" })),
			};
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: vi.fn(() => "workspace-1"),
				loadScopedRuntimeConfig: vi.fn(async () => {
					const runtimeConfigState = createRuntimeConfigState();
					runtimeConfigState.selectedAgentId = "codex";
					return runtimeConfigState;
				}),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager: vi.fn(async () => terminalManager as never),
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});

			const response = await api.refreshTaskTerminal(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", cols: 120, rows: 40, additionalAgentStartupArgumentsForThisRestart },
			);

			expect(response.ok).toBe(true);
			expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: "codex",
					prompt: "",
					images: undefined,
					startInPlanMode: undefined,
					resumeFromTrash: true,
					...(additionalAgentStartupArgumentsForThisRestart !== undefined
						? { additionalAgentStartupArgumentsForThisRestart }
						: {}),
				}),
				expect.any(String),
			);
			expect(response.mode).toBe("resume");
		},
	);

	it("摘要完全丢失后重新构建会话", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		const terminalManager = {
			getSummary: vi.fn(() => null),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "claude", resumeFromTrash: true }),
			expect.any(String),
		);
	});

	it("摘要缺少 agentId 时使用卡片最近实际启动的 agent 恢复", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		// 卡片没有 agentId（用户从未显式选过 agent，走项目默认档）——正是 2026-07 那次修复漏掉的那类卡片。
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							mostRecentlyLaunchedAgentSessionAgentId: "codex",
						},
					],
				},
			],
		});
		agentRegistryMocks.resolveAgentCommand.mockImplementation((config: { selectedAgentId: string }) => ({
			agentId: config.selectedAgentId,
			label: config.selectedAgentId,
			command: config.selectedAgentId,
			binary: config.selectedAgentId,
			args: [],
		}));
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: null, startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "codex" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			// 项目默认档是 claude；卡片记下的最近一次启动是 codex，后者才是这个会话的真相。
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "codex" }),
			expect.any(String),
		);
	});

	it.each([false, true])("客户端声明的过期自动恢复保留来源与持久Stop（已停止=%s）", async (explicitlyStopped) => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "in_progress", cards: [{ id: "task-1", agentId: "claude" }] }],
		});
		const terminalManager = {
			listSummaries: () => [],
			stopTaskSession: vi.fn(() =>
				createSummary({ pid: null, liveness: "exited", turnOwner: "user", userTurnKind: "review" }),
			),
			getSummary: vi.fn(() => createSummary({ agentId: "claude", startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };
		await api.recordExplicitTaskConversationSessionStart(scope, "task-1");
		if (explicitlyStopped) await api.stopTaskSession(scope, { taskId: "task-1" });
		const result = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				cols: 120,
				rows: 40,
				taskSessionStartOriginDeclaredByClient: "stale_session_client_auto_resume",
			},
		);

		expect(result.ok).toBe(!explicitlyStopped);
		if (explicitlyStopped) {
			expect(result.error).toContain("Stop");
			expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
		} else
			expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
				expect.objectContaining({ revalidateExistingMainSessionHandoverTargetBeforeLaunch: expect.any(Function) }),
				"stale_session_client_auto_resume",
			);
	});

	it.each([
		{ declaredOrigin: "stale_session_client_auto_resume" as const, expectsRestart: false },
		{ declaredOrigin: undefined, expectsRestart: false },
	])("已结案任务禁止直接重启（声明来源=$declaredOrigin）", async ({ declaredOrigin, expectsRestart }) => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "trash", cards: [{ id: "task-1", agentId: "claude" }] }],
		});
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "claude", startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				cols: 120,
				rows: 40,
				...(declaredOrigin ? { taskSessionStartOriginDeclaredByClient: declaredOrigin } : {}),
			},
		);

		expect(response.ok).toBe(expectsRestart);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledTimes(expectsRestart ? 1 : 0);
	});

	it("向终端管理器转发用户确认的 Claude 后台接管", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "in_progress", cards: [{ id: "task-1", agentId: "claude" }] }],
		});
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "claude", startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				cols: 120,
				rows: 40,
				forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser: true,
			},
		);

		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(expect.anything(), "refresh_task_terminal", {
			forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser: true,
		});
	});

	it("未声明来源的刷新继续记录为人工刷新", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "in_progress", cards: [{ id: "task-1", agentId: "claude" }] }],
		});
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "claude", startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(expect.anything(), "refresh_task_terminal");
	});

	it("卡片选择与实际启动身份冲突时使用观测身份", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		// 卡片意图是 claude（「下次想用 claude 启动」），但上一次真正跑起来的是 codex。
		// 续的是那条既存会话，故必须取观测值 codex。
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							agentId: "claude",
							mostRecentlyLaunchedAgentSessionAgentId: "codex",
						},
					],
				},
			],
		});
		agentRegistryMocks.resolveAgentCommand.mockImplementation((config: { selectedAgentId: string }) => ({
			agentId: config.selectedAgentId,
			label: config.selectedAgentId,
			command: config.selectedAgentId,
			binary: config.selectedAgentId,
			args: [],
		}));
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: null, startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "codex" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "codex" }),
			expect.any(String),
		);
	});

	it("实际摘要为已退役 Cline 时拒绝刷新，即使卡片选择 PTY agent", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		// `startTaskSession` 的 `shouldProbePersistedClineSession` 分支会在 `card.agentId` 仍是 PTY agent 时
		// 探测到持久化的 Cline 会话并改走 Cline——真正跑起来的与卡片意图天然不一致。若让 card.agentId 胜出，
		// 下面那道「非 PTY agent 一律拒绝刷新」的能力谓词闸门会被骗过，把 Cline 会话用 PTY agent 重启掉。
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							agentId: "codex",
							mostRecentlyLaunchedAgentSessionAgentId: "cline",
						},
					],
				},
			],
		});
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: null, startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "cline" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(false);
		expect(response.error).toContain("已退役");
		expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
	});

	const BY_THE_WAY_TASK_CONVERSATION_SESSION_ID = "task-conversation-session-1111";

	const BY_THE_WAY_CONVERSATION_SESSION_METADATA = {
		workspaceTaskId: "task-1",
		taskConversationSessionRole: "by_the_way" as const,
		taskConversationSessionContextSource: "started_from_scratch" as const,
		parentTaskConversationSessionId: null,
		mainSessionOriginTurnNumber: null,
		mainSessionOriginUserMessagePreview: null,
		latestUserMessagePreview: null,
	};

	it.each(["by_the_way", "task_collaborator"] as const)("按宿主目录刷新 %s 会话，保留自身启动配置", async (role) => {
		const metadata = {
			...BY_THE_WAY_CONVERSATION_SESSION_METADATA,
			taskConversationSessionRole: role,
			...(role === "task_collaborator"
				? {
						taskConversationSessionLaunchSettings: {
							taskAgentPermissionMode: "ask_for_every_tool_use" as const,
							sessionTransport: "pty_terminal" as const,
						},
					}
				: {}),
		};
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID,
					agentId: "claude",
					taskConversationSessionMetadata: metadata,
				}),
			),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID, cols: 120, rows: 40 },
		);

		if (role === "task_collaborator")
			expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
				expect.objectContaining({ taskAgentPermissionMode: "ask_for_every_tool_use" }),
				expect.any(String),
			);
		expect(response.ok).toBe(true);
		expect(response.error).toBeUndefined();
		// 工作目录按**宿主任务**解析：用会话 id 解析会以 session id 另造一个空 worktree。
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }));
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				// 会话身份仍是会话自己的。
				taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID,
				workspaceTaskId: "task-1",
				cwd: "/tmp/existing-worktree",
				// 只读约束靠这份 metadata 传下去；丢了就等于重启一次侧问会话它就能写文件了。
				taskConversationSessionMetadata: metadata,
				resumeFromTrash: true,
			}),
			expect.any(String),
		);
	});

	it("不将旁问会话身份回写到宿主卡片", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const mutationResults: unknown[] = [];
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(
			async (
				_workspacePath: string,
				_taskMutationIntent: unknown,
				mutate: (state: { board: RuntimeBoardData }) => {
					board: RuntimeBoardData;
					value: unknown;
					save?: boolean;
				},
			) => {
				const board = await workspaceStateMocks.loadWorkspaceBoardById();
				const mutation = mutate({ board: board as RuntimeBoardData });
				mutationResults.push(mutation.value);
				return { value: mutation.value, state: { board: mutation.board }, saved: mutation.save !== false };
			},
		);
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID,
					agentId: "claude",
					taskConversationSessionMetadata: BY_THE_WAY_CONVERSATION_SESSION_METADATA,
				}),
			),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID, cols: 120, rows: 40 },
		);

		// 回写以会话自身 taskId 为键 ⇒ 看板上找不到这张卡 ⇒ 每一次 mutation 都是 no-op。
		// 若改用 workspaceTaskId，侧问会话跑的 agent 会被写进主卡，主会话下次硬中断后被兜底解析成它。
		expect(mutationResults.every((value) => value === false)).toBe(true);
	});

	it("恢复任务时按会话自身原生 ID 探测模型", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const nativeSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					agentId: "claude",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "claude",
						nativeSessionId,
						transcriptPath: null,
						observedAt: 1,
					},
				}),
			),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "claude" })),
			applyTurnCheckpoint: vi.fn(() => null),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", agentId: "claude", prompt: "", resumeFromTrash: true },
		);

		expect(persistedAgentTranscriptModelProbeMocks.probeByAgentNativeConversationSessionId).toHaveBeenCalledWith(
			expect.objectContaining({ agentNativeConversationSessionId: nativeSessionId }),
		);
		// cwd-latest 那条探针在有 id 可用时绝不能被走到——它正是会套用别人模型的那一条。
		expect(persistedAgentTranscriptModelProbeMocks.probeByWorkingDirectory).not.toHaveBeenCalled();
	});

	it("宿主卡片丢失时明确说明宿主不存在", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ id: "in_progress", title: "In Progress", cards: [] }],
		});
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID,
					agentId: "claude",
					taskConversationSessionMetadata: BY_THE_WAY_CONVERSATION_SESSION_METADATA,
				}),
			),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: BY_THE_WAY_TASK_CONVERSATION_SESSION_ID, cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(false);
		expect(response.error).toBe("The board card hosting this conversation session no longer exists.");
	});

	it("缺少摘要身份时按持久 Cline 卡片明确拒绝刷新", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
							agentId: "cline",
						},
					],
				},
			],
		});
		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: null, startedAt: null, pid: null })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "cline" })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(false);
		expect(response.error).toContain("已退役");
		expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
	});

	it("将实际启动身份记录到卡片以便硬中断后恢复", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		const boardBeforeLaunch = {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "task-1",
							title: "Task 1",
							prompt: "Implement task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
		} as unknown as RuntimeBoardData;
		let savedBoard: RuntimeBoardData | null = null;
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(
			async (
				_workspacePath: string,
				_taskMutationIntent: unknown,
				mutate: (state: { board: RuntimeBoardData }) => {
					board: RuntimeBoardData;
					value: unknown;
					save?: boolean;
				},
			) => {
				const mutation = mutate({ board: boardBeforeLaunch });
				if (mutation.save !== false) {
					savedBoard = mutation.board;
				}
				return { value: mutation.value, state: { board: mutation.board }, saved: mutation.save !== false };
			},
		);
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(() => null),
			getSummary: vi.fn(() => null),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", baseRef: "main", prompt: "Do the thing" },
		);

		expect(response.ok).toBe(true);
		const launchedCard = (savedBoard as RuntimeBoardData | null)?.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === "task-1");
		expect(launchedCard?.mostRecentlyLaunchedAgentSessionAgentId).toBe("codex");
		// 观测值不得伪装成用户的 per-task 覆盖，也不得 bump 用户可见的「上次修改时间」。
		expect(launchedCard?.agentId).toBeUndefined();
		expect(launchedCard?.updatedAt).toBe(1);
	});

	it("ACP 取消当前回合声明回合范围，明确停止会话继续使用整任务范围", async () => {
		const summary = createSummary({ agentId: "omp", sessionTransport: "acp_stdio_subprocess" });
		const onTaskSessionStopRequested = vi.fn<NonNullable<CreateRuntimeApiDependencies["onTaskSessionStopRequested"]>>(
			async () => undefined,
		);
		const acpService = {
			listSummaries: () => [summary],
			cancelTaskTurn: vi.fn(async () => summary),
			stopTaskSession: vi.fn(async () => summary),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: () => "workspace-1",
			loadScopedRuntimeConfig: async () => createRuntimeConfigState(),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: async () => ({ listSummaries: () => [] }) as never,
			getScopedAcpTaskSessionService: async () => acpService as never,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			onTaskSessionStopRequested,
		});
		const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };
		expect((await api.cancelTaskChatTurn(scope, { taskId: summary.taskId })).ok).toBe(true);
		expect(onTaskSessionStopRequested).toHaveBeenCalledWith("workspace-1", summary.taskId, "current_agent_turn");
		expect((await api.stopTaskSession(scope, { taskId: summary.taskId })).ok).toBe(true);
		expect(onTaskSessionStopRequested).toHaveBeenLastCalledWith("workspace-1", summary.taskId);
	});

	it.each([
		["本项目已删除工作树的终端历史仍可读取", "own_deleted_worktree", "pty_terminal", true],
		["null 工作目录的终端历史仍可读取", "unknown_null", "pty_terminal", true],
		["inplace 仓库目录的终端历史仍可读取", "inplace_repository", "pty_terminal", true],
		["管理根之外的未知目录历史仍可读取", "unknown_external_directory", "pty_terminal", true],
		["外项目 worktree 的终端历史被拒绝", "foreign_project_worktree", "pty_terminal", false],
		["外项目 worktree 在读取 ACP 保留消息前被拒绝", "foreign_project_worktree", "acp_stdio_subprocess", false],
		["本项目已删除工作树的 ACP 保留消息仍可读取", "own_deleted_worktree", "acp_stdio_subprocess", true],
	] as const)("只读历史查询：%s", async (_caseLabel, workingDirectoryKind, sessionTransport, shouldReadHistory) => {
		const directory = mkdtempSync(join(tmpdir(), "kanban-done-history-api-"));
		try {
			const workspaceRepositoryPath = join(directory, "history-project");
			const taskWorkingDirectoryPaths = {
				own_deleted_worktree: join(
					workspaceStateMocks.runtimeHomePath,
					"task-worktrees",
					"task-1",
					"history-project",
				),
				unknown_null: null,
				inplace_repository: workspaceRepositoryPath,
				unknown_external_directory: join(directory, "unclassified-workspace"),
				foreign_project_worktree: join(
					workspaceStateMocks.runtimeHomePath,
					"task-worktrees",
					"task-1",
					"other-project",
				),
			};
			const transcriptPath = join(directory, "native.jsonl");
			writeFileSync(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: "native" } })}\n${JSON.stringify({
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "已完成的回答" }],
					},
				})}\n`,
			);
			const summary = createSummary({
				agentId: sessionTransport === "acp_stdio_subprocess" ? "omp" : "codex",
				sessionTransport,
				workspacePath: taskWorkingDirectoryPaths[workingDirectoryKind],
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				pid: null,
				agentNativeConversationSessionIdentity:
					sessionTransport === "pty_terminal"
						? {
								sourceAgentId: "codex",
								nativeSessionId: "native",
								transcriptPath,
								observedAt: 1,
							}
						: undefined,
			});
			const persistedSessions = Object.freeze({ "task-1": summary });
			const persistedSessionsBeforeRead = JSON.stringify(persistedSessions);
			workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue(persistedSessions);
			workspaceStateMocks.mutateWorkspaceState.mockClear();
			workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
				columns: [
					{
						id: "trash",
						title: "Done",
						cards: [
							{
								id: "task-1",
								title: "完成任务",
								prompt: "需求",
								startInPlanMode: false,
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			});
			const getScopedTerminalManager = vi.fn();
			const listRetainedMessages = vi.fn(() => [
				{ id: "retained", role: "assistant" as const, content: "已完成的回答", createdAt: 1 },
			]);
			const getScopedAcpTaskSessionService = vi.fn(async () => ({ listMessages: listRetainedMessages }) as never);
			const api = createTestRuntimeApi({
				getActiveWorkspaceId: () => "workspace-1",
				loadScopedRuntimeConfig: vi.fn(),
				setActiveRuntimeConfig: vi.fn(),
				getScopedTerminalManager,
				getScopedAcpTaskSessionService,
				resolveInteractiveShellCommand: vi.fn(),
				runCommand: vi.fn(),
			});
			const response = await api.getTaskConversationHistoryPage(
				{ workspaceId: "workspace-1", workspacePath: workspaceRepositoryPath },
				{
					workspaceTaskId: "task-1",
					taskConversationSessionId: "task-1",
				},
			);
			const expectedHistoryAvailability = shouldReadHistory
				? sessionTransport === "acp_stdio_subprocess"
					? "partially_available"
					: "available"
				: "unavailable";
			expect(response.availability).toBe(expectedHistoryAvailability);
			expect(response.messages.map((message) => message.content)).toEqual(shouldReadHistory ? ["已完成的回答"] : []);
			expect(getScopedTerminalManager).not.toHaveBeenCalled();
			const expectedRetainedMessageReads = sessionTransport === "acp_stdio_subprocess" && shouldReadHistory ? 1 : 0;
			expect(getScopedAcpTaskSessionService).toHaveBeenCalledTimes(expectedRetainedMessageReads);
			expect(listRetainedMessages).toHaveBeenCalledTimes(expectedRetainedMessageReads);
			expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
			expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
			expect(JSON.stringify(persistedSessions)).toBe(persistedSessionsBeforeRead);
			expect(existsSync(taskWorkingDirectoryPaths.own_deleted_worktree)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue({});
		}
	});

	it("当前 PTY 会话通过就绪门禁接收程序化消息", async () => {
		const summary = createSummary({ agentId: "codex", state: "awaiting_review" });
		const terminalManager = {
			getSummary: () => summary,
			submitTaskChatInputWhenReady: vi.fn(() => summary),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "please continue",
				source: "runtime-api-regression-test",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response.ok).toBe(true);
		// 后台程序化消息：经就绪门控投递，以原始文本调用（bracketed-paste 编码与就绪判定下沉到
		// TerminalSessionManager.submitTaskChatInputWhenReady，由 session-manager 单测覆盖）。带 source（后台自动
		// 注入）→ deferWhileUserTurn=true：遇 agent 正等用户拍板的模态时让位挂起、不打断（Fix B）。
		// 带 idempotencyKey → 同时登记诚实回执：runtime 在投递落定后经 onDeliveryOutcome 回写注入账本，
		// 这是「CLI 已退出不再意味着状态不会变」的接线点。
		// 争用分层：策略取自配置（默认 auto = 允许在人不在场时自动暂存抢占），抢占执行者就是
		// Ctrl+S 那条暂存链路本身（只是 origin 标成「被程序化投递抢占」）。
		expect(terminalManager.submitTaskChatInputWhenReady).toHaveBeenCalledWith("task-1", "please continue", {
			deferWhileUserTurn: true,
			idempotencyKey: "rvf-run-1",
			codexNativeDeliveryLedgerBinding: {
				ledgerPath: join("/tmp/kanban-workspaces", "workspace-1", "task-message-injections.json"),
				ledgerTaskId: "task-1",
				idempotencyKey: "rvf-run-1",
				requestOriginRuntimeProcessInstanceId: expect.any(String),
			},
			onDeliveryOutcome: expect.any(Function),
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: expect.any(Function),
		});
		expect(response.summary).toEqual(summary);
		expect(response.message).toEqual({
			id: "terminal:task-1:rvf-run-1",
			role: "user",
			content: "please continue",
			createdAt: expect.any(Number),
			meta: {
				messageKind: "terminal-input",
				source: "runtime-api-regression-test",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		});
	});

	it("ACP 程序化投递保留待确认回执并登记可靠接受回调", async () => {
		// ACP 会话的 summary 恒由 createDefaultAcpSummary 盖上通道章。这里必须显式带上：
		// 不带章的 omp summary 现在意味着一条 **TUI** 会话（omp 的 catalog 默认已是 pty_terminal），
		// 聊天端点会正确地不把它当 ACP 任务分派。
		const summary = createSummary({
			agentId: "omp",
			state: "awaiting_review",
			sessionTransport: "acp_stdio_subprocess",
			runtimeSessionIncarnationId: "acp-programmatic-incarnation",
			agentConversationPromptSubmissionAcceptance: {
				status: "pending",
				attemptedAtMs: Date.now(),
				runtimeSessionIncarnationId: "acp-programmatic-incarnation",
			},
		});
		const latestMessage = {
			id: "message-acp-1",
			role: "user" as const,
			content: "please continue",
			createdAt: Date.now(),
		};
		const acpTaskSessionService = {
			getSummary: vi.fn(() => summary),
			sendTaskSessionInput: vi.fn(async () => summary),
			listMessages: vi.fn(() => [latestMessage]),
			clearTaskSession: vi.fn(),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-acp-1",
				text: "please continue",
				source: "runtime-api-regression-test",
				idempotencyKey: "rvf-acp-1",
				promptSha256: "abc123",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response.ok).toBe(true);
		expect(acpTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-acp-1",
			"please continue",
			undefined,
			expect.any(Function),
			"rvf-acp-1",
			expect.any(Function),
			undefined,
		);
		expect(response.terminalDelivery).toEqual({
			status: "accepted_pending_submit_confirmation",
			reason: null,
		});
		expect(response.message).toEqual(latestMessage);
	});

	it("ACP 连接已退出时如实报告投递失败", async () => {
		const summary = createSummary({
			agentId: "omp",
			state: "idle",
			sessionTransport: "acp_stdio_subprocess",
		});
		const acpTaskSessionService = {
			getSummary: vi.fn(() => summary),
			sendTaskSessionInput: vi.fn(async () => null),
			listMessages: vi.fn(() => []),
			clearTaskSession: vi.fn(),
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-acp-1",
				text: "please continue",
				source: "runtime-api-regression-test",
				idempotencyKey: "rvf-acp-2",
				promptSha256: "abc123",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response.ok).toBe(false);
		expect(response.terminalDelivery).toEqual({
			status: "delivery_failed",
			reason: "no_active_terminal_session",
		});
	});

	it("ACP 图片发送失败时不回退到终端输入", async () => {
		const summary = createSummary({ agentId: "omp", sessionTransport: "acp_stdio_subprocess" });
		const terminalManager = { getSummary: () => null, submitTaskChatInputWhenReady: vi.fn() };
		const acpService = {
			getSummary: () => summary,
			sendTaskSessionInput: vi.fn(async () => null),
			listMessages: () => [],
		};

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: async () => acpService as never,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "look at this",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response.ok).toBe(false);
		expect(acpService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-1",
			"look at this",
			expect.arrayContaining([expect.objectContaining({ id: "img-1" })]),
			undefined,
			undefined,
			expect.any(Function),
			undefined,
		);
		expect(terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
	});

	it("删除调试状态目录前先完成会话拆除", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [join(tempHome, ".cline", "kanban"), join(tempHome, ".cline", "worktrees")];
		const retainedLegacySdkMarkerPath = join(tempHome, ".cline", "data", "marker.txt");
		mkdirSync(join(tempHome, ".cline", "data"), { recursive: true });
		writeFileSync(retainedLegacySdkMarkerPath, "preserved");
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			expect(existsSync(retainedLegacySdkMarkerPath)).toBe(true);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("会话拆除失败时保留全部状态目录", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [join(tempHome, ".cline", "kanban"), join(tempHome, ".cline", "worktrees")];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeApi update handlers", () => {
	it("delegates update status to the required dependency", async () => {
		const getUpdateStatus = vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup" as const,
			installCommand: "npm install -g kanban@latest",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			getUpdateStatus,
		});

		await expect(api.getUpdateStatus(null)).resolves.toEqual({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup",
			installCommand: "npm install -g kanban@latest",
		});
		expect(getUpdateStatus).toHaveBeenCalledTimes(1);
	});

	it("delegates update execution to the required dependency", async () => {
		const runUpdateNow = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			runUpdateNow,
		});

		await expect(api.runUpdateNow(null)).resolves.toEqual({
			status: "updated",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		});
		expect(runUpdateNow).toHaveBeenCalledTimes(1);
	});
});

describe("createRuntimeApi 直接输入的退役身份兜底", () => {
	beforeEach(() => {
		workspaceStateMocks.loadPersistedConversationSessions.mockReset();
		workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue({});
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ cards: [{ id: "task-1", agentId: "cline" }] }],
		});
	});

	it.each(["card", "session"] as const)("无内存摘要时从持久 %s 身份拒绝 Cline，且不写入终端", async (source) => {
		if (source === "session") {
			workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({ columns: [] });
			workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue({
				"task-1": createSummary({ agentId: "cline" }),
			});
		}
		const terminalManager = { getSummary: vi.fn(() => null), writeInput: vi.fn() };
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: () => "workspace-1",
			loadScopedRuntimeConfig: async () => createRuntimeConfigState(),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: async () => terminalManager as never,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		expect(
			await api.sendTaskSessionInput(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", text: "继续" },
			),
		).toMatchObject({ ok: false, summary: null, error: expect.stringContaining("已退役") });
		expect(terminalManager.writeInput).not.toHaveBeenCalled();
	});

	it("当前 Codex 摘要优先于旧 Cline 卡片，不丢弃正常输入", async () => {
		const summary = createSummary({ agentId: "codex" });
		const terminalManager = { getSummary: () => summary, writeInput: vi.fn(() => summary) };
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: () => "workspace-1",
			loadScopedRuntimeConfig: async () => createRuntimeConfigState(),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: async () => terminalManager as never,
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		expect(
			await api.sendTaskSessionInput(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", text: "继续", appendNewline: true },
			),
		).toMatchObject({ ok: true, summary });
		expect(terminalManager.writeInput).toHaveBeenCalledWith("task-1", Buffer.from("继续\n"));
	});
});

// 恢复既有对话（`--continue`）时的模型来源。原 bug：点「Restart terminal session」后会话被恢复到
// 卡片上那个「记住上次选择」自动回填的模型（实测多为 Fable 5），而不是这段对话自己在跑的模型。
// 探针本身与裸 id → 启动 id 的映射各有专门套件；这里守的是**接线**：两条恢复入口有没有真的把
// 解析结果下发给启动请求、有没有按分档决定回写，以及全新启动有没有被误伤。
describe("createRuntimeApi resumed claude session model", () => {
	const RESUMED_TASK_ID = "task-1";
	let temporaryHomeDirectoryPath: string;
	let taskWorktreePath: string;
	let originalHomeDirectoryPath: string | undefined;

	// Claude Code 落盘的转录目录名由**已解析软链的** cwd 编码而成（macOS 的 /tmp→/private/tmp 就靠这一步），
	// 与探针里的 realpath 是同一条契约；这里也走 realpathSync，否则夹具会写到一个探针永远找不到的目录。
	function writeTranscriptRecordsForTaskWorktree(records: unknown[]): void {
		const projectDirectoryPath = join(
			temporaryHomeDirectoryPath,
			".claude",
			"projects",
			realpathSync(taskWorktreePath).replace(/[^a-zA-Z0-9]/gu, "-"),
		);
		mkdirSync(projectDirectoryPath, { recursive: true });
		writeFileSync(
			join(projectDirectoryPath, "1041c594-8f2b-4c7d-9a3e-5b6d7e8f9a0b.jsonl"),
			`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
			"utf8",
		);
	}

	function assistantRecord(modelId: string): unknown {
		return {
			type: "assistant",
			timestamp: "2026-08-12T10:00:00.000Z",
			message: { role: "assistant", model: modelId },
		};
	}

	function createResumedTaskCard(
		terminalAgentModelOverrideSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
	): RuntimeBoardCard {
		return {
			id: RESUMED_TASK_ID,
			title: "Task 1",
			prompt: "Implement task",
			startInPlanMode: true,
			autoReviewEnabled: true,
			autoReviewMode: "pr",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
			...(terminalAgentModelOverrideSettings ? { terminalAgentModelOverrideSettings } : {}),
		} as RuntimeBoardCard;
	}

	function createBoardWithResumedTaskCard(card: RuntimeBoardCard): RuntimeBoardData {
		return {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [card] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		} as RuntimeBoardData;
	}

	// 只把 mutator 跑在内存 board 上，不碰真实文件锁——这里要验的是「传给 updateTask 的输入对不对」。
	//
	// 收集**每一次**落盘的 board 而不是只留最后一次：同一次启动/重启现在会发生两次互不相关的卡片写入，
	// 「按转录模型回写 override」与「记下最近一次启动用的 agent」各一次。用「最后一次」或用
	// `mutateWorkspaceState` 的调用次数做断言，都会把这两条链路混为一谈。
	interface CapturedWorkspaceStateMutations {
		savedBoards: RuntimeBoardData[];
	}

	function stubWorkspaceStateMutationAgainst(board: RuntimeBoardData): CapturedWorkspaceStateMutations {
		const captured: CapturedWorkspaceStateMutations = { savedBoards: [] };
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(
			async (
				_workspacePath: string,
				_taskMutationIntent: unknown,
				mutate: (state: { board: RuntimeBoardData }) => {
					board: RuntimeBoardData;
					value: unknown;
					save?: boolean;
				},
			) => {
				const mutation = mutate({ board });
				if (mutation.save !== false) {
					captured.savedBoards.push(mutation.board);
				}
				return { value: mutation.value, state: { board: mutation.board }, saved: mutation.save !== false };
			},
		);
		return captured;
	}

	function collectSavedResumedTaskCards(captured: CapturedWorkspaceStateMutations): RuntimeBoardCard[] {
		return captured.savedBoards
			.flatMap((savedBoard) => savedBoard.columns.flatMap((column) => column.cards))
			.filter((entry) => entry.id === RESUMED_TASK_ID);
	}

	// 「模型 override 没有被改写」的判据：所有落盘过的卡片版本上，该字段都还是原值。
	// 不用「mutateWorkspaceState 没被调用过」——那条断言会被无关的 agent 身份回写误伤。
	function expectNoTerminalAgentModelOverrideWrite(
		captured: CapturedWorkspaceStateMutations,
		unchangedSettings: RuntimeTaskTerminalAgentModelOverrideSettings | undefined,
	): void {
		for (const savedCard of collectSavedResumedTaskCards(captured)) {
			expect(savedCard.terminalAgentModelOverrideSettings).toEqual(unchangedSettings);
		}
	}

	function createTerminalManagerStub() {
		return {
			getSummary: vi.fn(() => createSummary({ agentId: "claude", workspacePath: taskWorktreePath })),
			refreshTaskTerminal: vi.fn(async () => createSummary({ agentId: "claude" })),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "claude" })),
			applyTurnCheckpoint: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};
	}

	function createApiWithTerminalManager(terminalManager: ReturnType<typeof createTerminalManagerStub>) {
		return createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
	}

	it("旧 Cline 会话的启动、恢复和聊天统一拒绝，保留原身份", async () => {
		const terminalManager = createTerminalManagerStub();
		const historicalSummary = createSummary({
			agentId: "cline",
			sessionTransport: "in_process_cline_sdk",
			pid: null,
		});
		terminalManager.getSummary.mockReturnValue(historicalSummary);
		const api = createApiWithTerminalManager(terminalManager);
		const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(
			createBoardWithResumedTaskCard(createResumedTaskCard({ agentId: "claude", modelId: "historical-model" })),
		);
		for (const response of [
			await api.startTaskSession(scope, {
				taskId: RESUMED_TASK_ID,
				agentId: "cline",
				prompt: "不会投递",
				baseRef: "main",
			}),
			await api.refreshTaskTerminal(scope, { taskId: RESUMED_TASK_ID, cols: 120, rows: 40 }),
			await api.sendTaskChatMessage(
				scope,
				{ taskId: RESUMED_TASK_ID, text: "不会投递" },
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		]) {
			expect(response.ok).toBe(false);
			expect(response.error).toContain("Cline agent 已退役");
		}
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
		expect(historicalSummary.agentId).toBe("cline");
	});

	beforeEach(() => {
		originalHomeDirectoryPath = process.env.HOME;
		temporaryHomeDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-resumed-model-home-"));
		process.env.HOME = temporaryHomeDirectoryPath;
		taskWorktreePath = join(temporaryHomeDirectoryPath, "worktree");
		mkdirSync(taskWorktreePath, { recursive: true });

		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue(taskWorktreePath);
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockRejectedValue(new Error("checkpoint disabled in this suite"));
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
	});

	afterEach(() => {
		if (originalHomeDirectoryPath === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHomeDirectoryPath;
		}
		rmSync(temporaryHomeDirectoryPath, { recursive: true, force: true });
	});

	it("restarts onto the model the transcript last used and syncs a pinned-version card to it", async () => {
		writeTranscriptRecordsForTaskWorktree([assistantRecord("claude-opus-5")]);
		const card = createResumedTaskCard({ agentId: "claude", modelId: "claude-fable-5" });
		const board = createBoardWithResumedTaskCard(card);
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const capturedMutation = stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		const api = createApiWithTerminalManager(terminalManager);

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: RESUMED_TASK_ID, cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		// 转录只记裸 id，故启动 id 必须补回 1M 变体，否则恢复会静默从 1M 掉到 200k。
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeFromTrash: true,
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-opus-5[1m]" },
			}),
			expect.any(String),
		);
		const updatedCard = collectSavedResumedTaskCards(capturedMutation).find(
			(entry) => entry.terminalAgentModelOverrideSettings?.modelId === "claude-opus-5[1m]",
		);
		expect(updatedCard?.terminalAgentModelOverrideSettings).toEqual({
			agentId: "claude",
			modelId: "claude-opus-5[1m]",
		});
		// updateTask 的这几个字段不是三态，回写时漏传就会被静默复位——卡片会因为「重启了一次」丢掉计划态与自动 review 设置。
		expect(updatedCard?.title).toBe("Task 1");
		expect(updatedCard?.prompt).toBe("Implement task");
		expect(updatedCard?.baseRef).toBe("main");
		expect(updatedCard?.startInPlanMode).toBe(true);
		expect(updatedCard?.autoReviewEnabled).toBe(true);
		expect(updatedCard?.autoReviewMode).toBe("pr");
	});

	it("keeps the card override when the transcript cannot answer", async () => {
		const card = createResumedTaskCard({ agentId: "claude", modelId: "claude-fable-5" });
		const board = createBoardWithResumedTaskCard(card);
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const capturedMutation = stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		const api = createApiWithTerminalManager(terminalManager);

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: RESUMED_TASK_ID, cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-fable-5" },
			}),
			expect.any(String),
		);
		expectNoTerminalAgentModelOverrideWrite(capturedMutation, { agentId: "claude", modelId: "claude-fable-5" });
	});

	it("follows the transcript but leaves a latest-tracking alias card unwritten", async () => {
		writeTranscriptRecordsForTaskWorktree([assistantRecord("claude-opus-5")]);
		const card = createResumedTaskCard({ agentId: "claude", modelId: "fable" });
		const board = createBoardWithResumedTaskCard(card);
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const capturedMutation = stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		const api = createApiWithTerminalManager(terminalManager);

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: RESUMED_TASK_ID, cols: 120, rows: 40 },
		);

		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-opus-5[1m]" },
			}),
			expect.any(String),
		);
		// 把 `fable`（永远跟最新那一代）改写成钉版本 id 是单向信息损失，且会波及此后的全新启动。
		expectNoTerminalAgentModelOverrideWrite(capturedMutation, { agentId: "claude", modelId: "fable" });
	});

	it("never replaces a phase-switching opusplan card, not even for this launch", async () => {
		writeTranscriptRecordsForTaskWorktree([assistantRecord("claude-sonnet-5")]);
		const card = createResumedTaskCard({ agentId: "claude", modelId: "opusplan" });
		const board = createBoardWithResumedTaskCard(card);
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const capturedMutation = stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		const api = createApiWithTerminalManager(terminalManager);

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: RESUMED_TASK_ID, cols: 120, rows: 40 },
		);

		// opusplan 是「计划期 Opus、其余 Sonnet」的策略；顶替成转录里那一阶段的具体模型会把它永久钉死。
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opusplan" },
			}),
			expect.any(String),
		);
		expectNoTerminalAgentModelOverrideWrite(capturedMutation, { agentId: "claude", modelId: "opusplan" });
	});

	it("applies the same rule when a task session is restored from trash", async () => {
		writeTranscriptRecordsForTaskWorktree([assistantRecord("claude-opus-5")]);
		const board = createBoardWithResumedTaskCard(createResumedTaskCard(undefined));
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		terminalManager.getSummary = vi.fn(() => null as never);
		const api = createApiWithTerminalManager(terminalManager);

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: RESUMED_TASK_ID,
				baseRef: "main",
				prompt: "",
				resumeFromTrash: true,
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-fable-5" },
			},
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeFromTrash: true,
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-opus-5[1m]" },
			}),
			expect.any(String),
		);
	});

	it("leaves a fresh start on the card override without reading any transcript", async () => {
		writeTranscriptRecordsForTaskWorktree([assistantRecord("claude-opus-5")]);
		const board = createBoardWithResumedTaskCard(createResumedTaskCard(undefined));
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue(board);
		const capturedMutation = stubWorkspaceStateMutationAgainst(board);
		const terminalManager = createTerminalManagerStub();
		terminalManager.getSummary = vi.fn(() => null as never);
		const api = createApiWithTerminalManager(terminalManager);

		const response = await api.startTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: RESUMED_TASK_ID,
				baseRef: "main",
				prompt: "Start something new",
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-fable-5" },
			},
		);

		expect(response.ok).toBe(true);
		// 全新启动不重播任何对话，卡片 override 仍是唯一的意图来源。
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "claude-fable-5" },
			}),
			expect.any(String),
		);
		expectNoTerminalAgentModelOverrideWrite(capturedMutation, undefined);
	});
});

// omp 的会话可以在 TUI（PTY）与 ACP 之间随时切换。切换在服务端一次做完：
// 停当前会话 → 作废落盘的通道快照 → 把新通道钉到卡上 → 用新通道续跑。
// 失败一律**停在已停止并如实报错**，不回滚也不降级。
describe("createRuntimeApi switchAgentSessionTransport", () => {
	beforeEach(() => {
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();
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
							ompAgentSessionTransport: "acp_stdio_subprocess",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
		});
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(
			async (_path: string, _taskMutationIntent: unknown, mutate: never) => {
				const mutation = (mutate as unknown as (state: unknown) => { board: unknown; value: unknown })({
					board: { columns: [] },
				});
				return { saved: true, value: mutation.value };
			},
		);
	});

	function createAcpServiceMockWithLiveSession() {
		const acpSummary = createSummary({
			taskId: "task-omp",
			agentId: "omp",
			state: "running",
			sessionTransport: "acp_stdio_subprocess",
		});
		return {
			getSummary: vi.fn(() => acpSummary),
			stopTaskSession: vi.fn(async () => acpSummary),
			discardTaskSessionLedgerEntry: vi.fn(),
			startTaskSession: vi.fn(async () => acpSummary),
			listMessages: vi.fn(() => []),
			clearTaskSession: vi.fn(),
			applyTurnCheckpoint: vi.fn(() => null),
		};
	}

	it("rejects a switch for an agent that has only one transport", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(
				async () =>
					({ getSummary: () => createSummary({ agentId: "claude" }), stopTaskSession: () => null }) as never,
			),
			getScopedAcpTaskSessionService: vi.fn(async () => ({ getSummary: () => null }) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "acp_stdio_subprocess" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(response.ok).toBe(false);
		expect(response.error).toContain("only one session transport");
	});

	// 承重回归：切离 ACP 必须把 ACP 账本条目摘掉。stopTaskSession 刻意保留条目（UI 要显示终态），
	// 而 getTaskChatMessages / sendTaskChatMessage 是按「ACP 账本里有没有这条会话」分派的——
	// 留着条目，切回 TUI 的会话就会被 ACP 永久劫持这两个端点、聊天面板恒读 ACP 的旧消息表。
	it("discards the ACP ledger entry when switching away from ACP so chat endpoints stop being hijacked", async () => {
		const acpTaskSessionService = createAcpServiceMockWithLiveSession();
		const terminalManager = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(() => null),
			startTaskSession: vi.fn(async () =>
				createSummary({ taskId: "task-omp", agentId: "omp", sessionTransport: "pty_terminal" }),
			),
			applyTurnCheckpoint: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "pty_terminal" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(acpTaskSessionService.stopTaskSession).toHaveBeenCalledWith("task-omp");
		expect(acpTaskSessionService.discardTaskSessionLedgerEntry).toHaveBeenCalledWith("task-omp");
		expect(response.priorAgentSessionStopped).toBe(true);
		expect(response.error).toBeUndefined();
		expect(response.ok).toBe(true);
		// 新会话必须以「续跑既有对话、不重投 prompt」形态起来，否则会凭空多一轮。
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ resumePriorAgentConversationWithoutResendingPrompt: true }),
			expect.any(String),
		);
	});

	it("协作会话切换通道只更新自身启动快照，不改宿主卡片的 agent 或通道", async () => {
		const metadata = createCollaborationSummary().taskConversationSessionMetadata;
		if (!metadata) throw new Error("协作会话夹具缺少 metadata");
		const side = createCollaborationSummary({
			taskConversationSessionMetadata: {
				...metadata,
				workspaceTaskId: "task-omp",
			},
		});
		const acpService = createAcpServiceMockWithLiveSession();
		acpService.getSummary.mockReturnValue(side);
		acpService.stopTaskSession.mockResolvedValue(side);
		const terminalManager = new TerminalSessionManager();
		vi.spyOn(terminalManager, "startTaskSession").mockImplementation(async (request) =>
			createCollaborationSummary({
				sessionTransport: "pty_terminal",
				taskConversationSessionMetadata: request.taskConversationSessionMetadata,
			}),
		);
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: side.taskId, targetSessionTransport: "pty_terminal" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceTaskId: "task-omp",
				taskAgentPermissionMode: "ask_for_every_tool_use",
				taskConversationSessionMetadata: expect.objectContaining({
					taskConversationSessionLaunchSettings: expect.objectContaining({ sessionTransport: "pty_terminal" }),
				}),
			}),
			expect.any(String),
		);
		const board = await workspaceStateMocks.loadWorkspaceBoardById("workspace-1");
		for (const call of workspaceStateMocks.mutateWorkspaceState.mock.calls) {
			const mutate = call[2] as (state: {
				board: RuntimeBoardData;
				sessions: Record<string, RuntimeTaskSessionSummary>;
			}) => { board: RuntimeBoardData };
			expect(mutate({ board, sessions: {} }).board).toEqual(board);
		}
	});

	// 失败口径：新通道起不来时**不回滚**。旧会话已经停了就如实说停了，卡片字段保持用户选的那条，
	// 用户修好问题后点 Start 即可——静默回滚会让他以为切成功了。
	it("stays stopped and reports the failure when the new transport cannot start", async () => {
		const acpTaskSessionService = createAcpServiceMockWithLiveSession();
		const terminalManager = {
			getSummary: vi.fn(() => null),
			stopTaskSession: vi.fn(() => null),
			startTaskSession: vi.fn(async () => {
				throw new Error("omp is not authenticated");
			}),
			applyTurnCheckpoint: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
		};
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({ agentId: "omp", binary: "omp", args: [] });
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "pty_terminal" },
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		expect(response.ok).toBe(false);
		expect(response.priorAgentSessionStopped).toBe(true);
		expect(response.error).toContain("omp is not authenticated");
		// 卡片字段已经改成用户选的那条通道，且**没有**被回滚。
		const cardMutation = workspaceStateMocks.mutateWorkspaceState.mock.calls.length;
		expect(cardMutation).toBeGreaterThan(0);
	});
});

// W2 Ctrl+S 暂存的**顺序红线**：先写库、后清框。
// 反过来一旦写库失败，用户打了一半的字既不在库里、又已被清出框，只剩 agent 自己的暂存区里一份
// 用户未必知道存在的副本——那正是这一整条工作流要根除的「回执说成功、东西不在」。
//
// 同源的另外两条红线（都是「回执必须等于事实」）：
//   - 清框要回传取文时的 incarnation 令牌，并且**返回值不许吞**：转发没做成时回执必须说「已入库但框没清」。
//   - 整条链路跑在 manager 的 per-task 独占闸门里：连按 / 多标签页并发不得让同一份正文重复入库，
//     被挡下的那一次也不许静默——用户按了键就得知道这一次为什么没生效。
describe("createRuntimeApi stashTerminalInputBoxToPromptLibrary", () => {
	const createdWorkspaceDirectoryPaths: string[] = [];

	const STASH_CAPTURE_FIDELITY = {
		softWrapJoinCount: 0,
		foldedPastePlaceholderCount: 0,
		backfilledPlaceholderCount: 0,
		placeholdersLeftUnbackfilledBecausePayloadWasDropped: 0,
		placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched: 0,
		placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed: 0,
		unrecoverablePasteCount: 0,
	};

	type StashCaptureStatus =
		| "captured_stashable_text"
		| "input_box_empty"
		| "input_box_content_unreadable"
		| "screen_text_not_corroborated_by_keystroke_tracking";

	interface StashCaptureDouble {
		status: StashCaptureStatus;
		text: string;
		fidelity: typeof STASH_CAPTURE_FIDELITY;
		terminalSessionIncarnationToken: string;
	}

	function createStashCapture(
		status: StashCaptureStatus,
		text: string,
		terminalSessionIncarnationToken = "incarnation-1",
	): StashCaptureDouble {
		return { status, text, fidelity: STASH_CAPTURE_FIDELITY, terminalSessionIncarnationToken };
	}

	// 串行化在真实链路里归 TerminalSessionManager（per-workspace 长驻单例）所有，handler 只是借它的闸门。
	// 替身必须把这层一并模拟，否则并发用例测到的就不是真实形状。
	function createPerTaskStashExclusivityDouble() {
		const taskIdsWithAttemptInFlight = new Set<string>();
		return async <AttemptResult>(
			taskId: string,
			runAttempt: () => Promise<AttemptResult>,
			buildResultWhenAnotherAttemptIsAlreadyInFlight: () => AttemptResult,
		): Promise<AttemptResult> => {
			if (taskIdsWithAttemptInFlight.has(taskId)) {
				return buildResultWhenAnotherAttemptIsAlreadyInFlight();
			}
			taskIdsWithAttemptInFlight.add(taskId);
			try {
				return await runAttempt();
			} finally {
				taskIdsWithAttemptInFlight.delete(taskId);
			}
		};
	}

	function createStashTerminalManagerDouble(args: {
		capture: () => Promise<StashCaptureDouble | null>;
		forward: (taskId: string, expectedTerminalSessionIncarnationToken: string) => boolean;
	}) {
		return {
			getSummary: vi.fn(() => createSummary()),
			captureTaskTerminalInputBoxContentForPromptLibraryStash: vi.fn(args.capture),
			forwardStashKeyToClearTaskTerminalInputBox: vi.fn(args.forward),
			runTaskTerminalInputBoxStashAttemptExclusivelyPerTask: createPerTaskStashExclusivityDouble(),
		};
	}

	function createStashWorkspaceScope(): { workspaceId: string; workspacePath: string } {
		const workspaceId = `stash-${process.pid}-${Math.random().toString(16).slice(2)}`;
		createdWorkspaceDirectoryPaths.push(`/tmp/kanban-workspaces/${workspaceId}`);
		return { workspaceId, workspacePath: "/tmp/repo" };
	}

	function createStashApi(scope: { workspaceId: string }, terminalManager: unknown) {
		return createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
	}

	afterEach(() => {
		for (const path of createdWorkspaceDirectoryPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
		rmSync(workspaceStateMocks.runtimeHomePath, { recursive: true, force: true });
	});

	it("取到正文 → 写库成功之后才转发 Ctrl+S 清框，且带上取文时的 incarnation 令牌", async () => {
		const scope = createStashWorkspaceScope();
		const promptLibraryFileExistedWhenBoxWasCleared: boolean[] = [];
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("captured_stashable_text", "打了一半的输入"),
			forward: () => {
				promptLibraryFileExistedWhenBoxWasCleared.push(
					existsSync(getWorkspacePromptLibraryPath(scope.workspaceId)),
				);
				return true;
			},
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		expect(response.ok).toBe(true);
		expect(response.outcome).toBe("stashed_into_prompt_library");
		expect(response.stashedTextCharacterCount).toBe("打了一半的输入".length);
		// 落盘的是真文件：条目进了这个任务自己的桶，并带上「用户在终端按了 Ctrl+S」这个来源。
		const library = await readWorkspacePromptLibrarySnapshot(scope.workspaceId);
		expect(library.taskScopedPromptsByTaskId["task-1"]).toEqual([
			expect.objectContaining({
				id: response.stashedPromptId,
				text: "打了一半的输入",
				scope: "task",
				origin: "terminal_stash_by_user",
			}),
		]);
		// 顺序红线：清框那一刻，库文件必须已经在磁盘上。
		expect(promptLibraryFileExistedWhenBoxWasCleared).toEqual([true]);
		// incarnation 红线：清框认的是取文时那条 PTY，不是「此刻这个 taskId 上碰巧有个 active」。
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).toHaveBeenCalledWith(
			"task-1",
			"incarnation-1",
		);
	});

	// W1 争用抢占复用的就是这条链路（计划 §3.4 / §4.1 形态 3）：同一段代码、只换 origin。
	// 两条红线：① 抢占存进去的条目要标成「被程序化投递抢占」，用户才能在面板里认出并一键取回；
	// ② 只有「入库**且**框已清」才算放行——库里有了但框还在时照写，就会把 paste 接在人类那半句后面。
	it("争用抢占：走同一条暂存链路，条目标成被抢占，且只有「入库且框已清」才算放行", async () => {
		const scope = createStashWorkspaceScope();
		const summary = createSummary({ agentId: "claude", state: "awaiting_review" });
		let inputBoxWasCleared = true;
		const terminalManager = {
			...createStashTerminalManagerDouble({
				capture: async () => createStashCapture("captured_stashable_text", "走开前留下的半句"),
				forward: () => inputBoxWasCleared,
			}),
			// 显式给形参类型：下面要读第三个参数（投递 options），mock 不带签名时 `mock.calls` 会被推成 `[]`，
			// `calls[0]?.[2]` 直接是类型错误——这正是本文件曾把 npm run typecheck 跑红的地方。
			submitTaskChatInputWhenReady: vi.fn(
				(
					_taskId: string,
					_text: string,
					_options?: {
						mayAutoStashAbsentHumanInputBox?: boolean;
						preemptivelyStashHumanInputBox?: (taskId: string) => Promise<TerminalInputBoxStashOutcome>;
					},
				) => summary,
			),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.sendTaskChatMessage(
			scope,
			{
				taskId: "task-1",
				text: "继续 RVF",
				source: "review-validate-fix",
				idempotencyKey: "rvf-contention-1",
				promptSha256: "abc123",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);

		const deliveryOptions = terminalManager.submitTaskChatInputWhenReady.mock.calls[0]?.[2];
		if (!deliveryOptions?.preemptivelyStashHumanInputBox) {
			throw new Error("投递 options 必须带上争用抢占执行者");
		}
		// 策略取自配置（默认允许在人不在场时抢占）。
		expect(deliveryOptions.mayAutoStashAbsentHumanInputBox).toBe(true);

		// 抢占执行者原样回传 outcome（判「成没成」由 manager 做）：这是 manager 区分「瞬态失败值得再等」
		// 与「确定性失败该当场收尾」的唯一依据，折成布尔就把它弄丢了。
		await expect(deliveryOptions.preemptivelyStashHumanInputBox("task-1")).resolves.toBe(
			"stashed_into_prompt_library",
		);
		const library = await readWorkspacePromptLibrarySnapshot(scope.workspaceId);
		expect(library.taskScopedPromptsByTaskId["task-1"]).toEqual([
			expect.objectContaining({
				text: "走开前留下的半句",
				origin: "terminal_stash_preempted_by_programmatic_delivery",
			}),
		]);

		// 框没清成（读框到清框之间终端被 refresh）：内容确实进了库，但输入框里一个字都没少，
		// 此时绝不能报「已放行」——投递必须退回挂起。
		inputBoxWasCleared = false;
		await expect(deliveryOptions.preemptivelyStashHumanInputBox("task-1")).resolves.toBe(
			"stashed_into_prompt_library_but_input_box_not_cleared",
		);
	});

	it("写库期间终端被 refresh（清框被拒） → 回执必须说「已入库但框没清」，不许报纯成功", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("captured_stashable_text", "写库期间会被换代的输入"),
			// 真实 manager 在令牌对不上时就是这样：拒绝转发，绝不把清框字节打到新会话上。
			forward: () => false,
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		expect(response.outcome).toBe("stashed_into_prompt_library_but_input_box_not_cleared");
		// 正文确实进库了，这半边不能被说成失败——库里查得到才是真相。
		expect(response.stashedPromptId).toBeTruthy();
		const library = await readWorkspacePromptLibrarySnapshot(scope.workspaceId);
		expect(library.taskScopedPromptsByTaskId["task-1"]).toEqual([
			expect.objectContaining({ id: response.stashedPromptId, text: "写库期间会被换代的输入" }),
		]);
	});

	it("同一 task 并发重入 → 只入库一次，被挡下的那次如实报「已有一次在进行中」", async () => {
		const scope = createStashWorkspaceScope();
		let releaseFirstCapture = (): void => {};
		const firstCaptureCanFinish = new Promise<void>((resolve) => {
			releaseFirstCapture = resolve;
		});
		let signalFirstCaptureHasStarted = (): void => {};
		const firstCaptureHasStarted = new Promise<void>((resolve) => {
			signalFirstCaptureHasStarted = resolve;
		});
		let captureCallCount = 0;
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => {
				captureCallCount += 1;
				signalFirstCaptureHasStarted();
				// 第一次取文卡住，模拟「写库还没做完」的那段窗口——第二次按键正是在这里挤进来的。
				await firstCaptureCanFinish;
				return createStashCapture("captured_stashable_text", "连按两次 Ctrl+S 的同一份正文");
			},
			forward: () => true,
		});
		const api = createStashApi(scope, terminalManager);

		const firstResponse = api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });
		// 等第一次真的进了闸门再按第二次，否则用例测的是「谁先跑到」而不是重入。
		await firstCaptureHasStarted;
		const secondResponse = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });
		releaseFirstCapture();
		const firstResponseResolved = await firstResponse;

		expect(secondResponse.outcome).toBe("another_terminal_input_box_stash_attempt_already_in_flight_for_this_task");
		expect(secondResponse.ok).toBe(false);
		expect(secondResponse.stashedPromptId).toBeNull();
		expect(firstResponseResolved.outcome).toBe("stashed_into_prompt_library");
		// 重入的那次连取文都不该跑：否则两次读到同一份正文，各自以不同 promptId 各写一条。
		expect(captureCallCount).toBe(1);
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).toHaveBeenCalledTimes(1);
		const library = await readWorkspacePromptLibrarySnapshot(scope.workspaceId);
		expect(library.taskScopedPromptsByTaskId["task-1"]).toHaveLength(1);
	});

	it("框是空的 → 不写库，但仍把 Ctrl+S 转发给 agent（保住这个键的原生语义）", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("input_box_empty", ""),
			forward: () => true,
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		expect(response.outcome).toBe("input_box_empty_nothing_to_stash");
		expect(response.stashedPromptId).toBeNull();
		expect(existsSync(getWorkspacePromptLibraryPath(scope.workspaceId))).toBe(false);
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).toHaveBeenCalledTimes(1);
	});

	it("没有可入库的正文、且连转发都没做成 → 不许硬说「已交给 agent 自己处理」", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("input_box_content_unreadable", ""),
			forward: () => false,
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		// 既没入库也没转发：什么都没发生，如实报「没有可信的终端会话」。
		expect(response.outcome).toBe("no_active_terminal_session");
		expect(response.stashedPromptId).toBeNull();
	});

	// 拿到 W1 争用抢占那条路径上的 stash 执行者。抢占来源无法从 procedure 表面触发——它只活在投递
	// options 里，所以必须先走一遍 sendTaskChatMessage 才能把它取出来。
	async function resolveProgrammaticDeliveryPreemptiveStashExecutor(
		scope: { workspaceId: string; workspacePath: string },
		terminalManager: ReturnType<typeof createStashTerminalManagerDouble>,
	): Promise<(taskId: string) => Promise<TerminalInputBoxStashOutcome>> {
		const summary = createSummary({ agentId: "claude", state: "awaiting_review" });
		// spread 复制的是 vi.fn 的引用，于是调用方仍可以对原 terminalManager 上那个 forward 替身做断言。
		const terminalManagerWithDelivery = {
			...terminalManager,
			submitTaskChatInputWhenReady: vi.fn(
				(
					_taskId: string,
					_text: string,
					_options?: {
						mayAutoStashAbsentHumanInputBox?: boolean;
						preemptivelyStashHumanInputBox?: (taskId: string) => Promise<TerminalInputBoxStashOutcome>;
					},
				) => summary,
			),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManagerWithDelivery as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		await api.sendTaskChatMessage(
			scope,
			{
				taskId: "task-1",
				text: "继续 RVF",
				source: "review-validate-fix",
				idempotencyKey: `rvf-preemption-${scope.workspaceId}`,
				promptSha256: "abc123",
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		const preemptivelyStashHumanInputBox =
			terminalManagerWithDelivery.submitTaskChatInputWhenReady.mock.calls[0]?.[2]?.preemptivelyStashHumanInputBox;
		if (!preemptivelyStashHumanInputBox) {
			throw new Error("投递 options 必须带上争用抢占执行者");
		}
		return preemptivelyStashHumanInputBox;
	}

	// 下面三例钉的是同一条红线的两面：「没有可入库的正文」这一格上，抢占路径与用户按键路径的正确行为
	// **相反**。用户按了键 ⇒ 必须转发（那是这个键的原生语义，agent 的原生暂存替他接住读不到的内容）；
	// 抢占路径根本没有人按键 ⇒ 一个字节都不许打进框。
	it("抢占 + 读不出正文 → 绝不转发 Ctrl+S：这是唯一真正会丢字的那一格", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			// 输入侧字节跟踪确知框里有未提交内容，读屏却拿不到正文——人类打了一半的那半句确实在框里。
			capture: async () => createStashCapture("input_box_content_unreadable", ""),
			// 替身照常允许转发：守卫必须来自「谁发起的」，不能靠 manager 恰好拒绝。
			forward: () => true,
		});
		const preemptivelyStashHumanInputBox = await resolveProgrammaticDeliveryPreemptiveStashExecutor(
			scope,
			terminalManager,
		);

		await expect(preemptivelyStashHumanInputBox("task-1")).resolves.toBe(
			"input_box_content_unreadable_and_left_untouched",
		);

		// 红线：转发一次 = 那半句被 agent 自己的暂存区吞掉，而抢占已如实报了非成功 outcome、这次投递
		// 根本不会发生——内容没了，连一次投递都没换到。
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).not.toHaveBeenCalled();
		expect(existsSync(getWorkspacePromptLibraryPath(scope.workspaceId))).toBe(false);
	});

	it("抢占 + 屏上文字无击键佐证 → 同样不动框（判据是「没人按键」，不按捕获状态开口子）", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			// 屏上有字、输入侧一个字节都没见过：多半是 Claude 自己渲染的占位提示，不该入库。
			capture: async () => createStashCapture("screen_text_not_corroborated_by_keystroke_tracking", ""),
			forward: () => true,
		});
		const preemptivelyStashHumanInputBox = await resolveProgrammaticDeliveryPreemptiveStashExecutor(
			scope,
			terminalManager,
		);

		await expect(preemptivelyStashHumanInputBox("task-1")).resolves.toBe(
			"input_box_screen_text_not_corroborated_by_keystroke_tracking",
		);

		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).not.toHaveBeenCalled();
	});

	it("用户按键 + 读不出正文 → 仍**必须**转发：这个键的原生语义不能被上面那条守卫顺手废掉", async () => {
		const scope = createStashWorkspaceScope();
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("input_box_content_unreadable", ""),
			forward: () => true,
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		expect(response.outcome).toBe("input_box_content_unreadable_forwarded_to_agent_native_stash");
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).toHaveBeenCalledWith(
			"task-1",
			"incarnation-1",
		);
	});

	it("写库失败 → **不**清框，正文原样留在输入框里，回执如实报失败", async () => {
		const scope = createStashWorkspaceScope();
		// 在 workspace 目录本该在的位置放一个文件：存储层建目录时必然 ENOTDIR，写入确定性失败。
		mkdirSync("/tmp/kanban-workspaces", { recursive: true });
		writeFileSync(`/tmp/kanban-workspaces/${scope.workspaceId}`, "不是目录", "utf8");
		const terminalManager = createStashTerminalManagerDouble({
			capture: async () => createStashCapture("captured_stashable_text", "会写失败的内容"),
			forward: () => true,
		});
		const api = createStashApi(scope, terminalManager);

		const response = await api.stashTerminalInputBoxToPromptLibrary(scope, { taskId: "task-1" });

		expect(response.ok).toBe(false);
		expect(response.outcome).toBe("prompt_library_write_failed");
		expect(response.error).toBeTruthy();
		expect(terminalManager.forwardStashKeyToClearTaskTerminalInputBox).not.toHaveBeenCalled();
	});
});

describe("createRuntimeApi releaseDeferredRestorationHarnessNotificationsIntoTaskSession", () => {
	// 账本走真实存储层，落在被 mock 的 workspace 目录（/tmp/kanban-workspaces/<id>）下。
	// 每个用例取唯一 workspaceId，避免并行 worker 互踩。
	let releaseWorkspaceId = "";

	beforeEach(() => {
		releaseWorkspaceId = `release-deferred-${process.pid}-${Math.random().toString(16).slice(2)}`;
	});

	afterEach(() => {
		rmSync(`/tmp/kanban-workspaces/${releaseWorkspaceId}`, { recursive: true, force: true });
	});

	async function seedDeferredNotifications(): Promise<void> {
		for (const [index, receivedAt] of [1_000, 2_000].entries()) {
			await deferHarnessGeneratedPromptDuringAgentSessionRestoration({
				workspaceId: releaseWorkspaceId,
				taskId: "task-1",
				sourceHarness: "claude",
				promptText: `<task-notification>通知 ${index + 1}</task-notification>`,
				receivedAt,
			});
		}
	}

	// 终端通道「先受理、后落定」：把投递终态交给测试决定，就能覆盖「受理了但最终没送达」这个真实形态。
	function createReleaseTerminalManagerDouble(settledOutcome: { status: string; reason: string | null }): {
		getSummary: ReturnType<typeof vi.fn>;
		submitTaskChatInputWhenReady: ReturnType<typeof vi.fn>;
		disarmRestorationContinuationGuard: ReturnType<typeof vi.fn>;
		completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn: ReturnType<typeof vi.fn>;
	} {
		return {
			getSummary: vi.fn(() => createSummary()),
			submitTaskChatInputWhenReady: vi.fn(
				(_taskId: string, _text: string, options?: { onDeliveryOutcome?: (outcome: unknown) => void }) => {
					options?.onDeliveryOutcome?.(settledOutcome);
					return createSummary({ agentId: "claude", state: "awaiting_review" });
				},
			),
			disarmRestorationContinuationGuard: vi.fn(),
			completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn: vi.fn(),
		};
	}

	function createReleaseApi(terminalManager: unknown): ReturnType<typeof createTestRuntimeApi> {
		return createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => releaseWorkspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
	}

	// 核心验收：accepted_pending_submit_confirmation **不表示成功**。账本已经被 consume 掉，此刻报
	// ok:true 就等于「说送到了、其实没送、通知还丢了」。
	it("终端投递落在非成功终态时报 ok:false，并把通知原样放回账本", async () => {
		await seedDeferredNotifications();
		const beforeRelease = await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: releaseWorkspaceId,
			taskId: "task-1",
		});
		const terminalManager = createReleaseTerminalManagerDouble({
			status: "delivery_failed",
			reason: "agent_awaiting_user_decision_timeout",
		});
		const api = createReleaseApi(terminalManager);

		const response = await api.releaseDeferredRestorationHarnessNotificationsIntoTaskSession(
			{ workspaceId: releaseWorkspaceId, workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(false);
		expect(response.releasedNotificationCount).toBe(0);
		expect(response.error).toContain("agent_awaiting_user_decision_timeout");
		expect(
			await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
				workspaceId: releaseWorkspaceId,
				taskId: "task-1",
			}),
		).toEqual(beforeRelease);
	});

	// 放行是用户显式点的按钮，不是后台自动注入。带 source 会被统一出口判成后台注入并对「正等用户拍板」
	// 的会话让位，而恢复出来的会话恰恰常停在那种模态上——于是放行永远送不出去。
	it("按真人输入投递：不置 deferWhileUserTurn，不给恢复态会话让位", async () => {
		await seedDeferredNotifications();
		const terminalManager = createReleaseTerminalManagerDouble({
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		const api = createReleaseApi(terminalManager);

		await api.releaseDeferredRestorationHarnessNotificationsIntoTaskSession(
			{ workspaceId: releaseWorkspaceId, workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(terminalManager.submitTaskChatInputWhenReady).toHaveBeenCalledWith(
			"task-1",
			expect.stringContaining("<kanban-user-released-harness-notifications>"),
			expect.objectContaining({ deferWhileUserTurn: false }),
		);
	});

	it("终端投递确认送达时报 ok:true，账本清空且守卫已解除", async () => {
		await seedDeferredNotifications();
		const terminalManager = createReleaseTerminalManagerDouble({
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		const api = createReleaseApi(terminalManager);

		const response = await api.releaseDeferredRestorationHarnessNotificationsIntoTaskSession(
			{ workspaceId: releaseWorkspaceId, workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(true);
		expect(response.releasedNotificationCount).toBe(2);
		expect(terminalManager.disarmRestorationContinuationGuard).toHaveBeenCalledWith("task-1");
		expect(
			await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
				workspaceId: releaseWorkspaceId,
				taskId: "task-1",
			}),
		).toEqual([]);
	});
});

// 排队 prompt 的两条 procedure。出队引擎本身有独立的行为网（queued-task-prompt-delivery-dispatcher.test.ts），
// 这里只钉 procedure 层自己的语义：空正文拒绝、队列满时**说出来**、在途取消的回执原样带回、改动后通知引擎。
describe("createRuntimeApi task prompt delivery queue", () => {
	const createdWorkspaceDirectoryPaths: string[] = [];

	function createQueueWorkspaceScope(): { workspaceId: string; workspacePath: string } {
		const workspaceId = `queued-prompt-${process.pid}-${Math.random().toString(16).slice(2)}`;
		const workspaceDirectoryPath = `/tmp/kanban-workspaces/${workspaceId}`;
		mkdirSync(workspaceDirectoryPath, { recursive: true });
		createdWorkspaceDirectoryPaths.push(workspaceDirectoryPath);
		return { workspaceId, workspacePath: "/tmp/repo" };
	}

	function createQueueApi(
		scope: { workspaceId: string },
		dispatcher: CreateRuntimeApiDependencies["queuedTaskPromptDeliveryDispatcher"],
		currentSessionSummaries: Record<string, RuntimeTaskSessionSummary> = {},
	) {
		return createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(
				async () => ({ getSummary: (taskId: string) => currentSessionSummaries[taskId] ?? null }) as never,
			),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			queuedTaskPromptDeliveryDispatcher: dispatcher,
		});
	}

	function createDispatcherDouble() {
		return {
			notifyQueueMutated: vi.fn(async () => {}),
			cancelInFlightQueuedPromptDelivery: vi.fn(async () => null),
			buildProjectedEntriesByTaskId: vi.fn(async () => ({})),
		};
	}

	afterEach(() => {
		for (const path of createdWorkspaceDirectoryPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("入队后读得回，且改动之后通知出队引擎（触发源 b：agent 已经闲着时立刻出队）", async () => {
		const scope = createQueueWorkspaceScope();
		const dispatcher = createDispatcherDouble();
		const api = createQueueApi(scope, dispatcher);
		const mutated = await api.mutateTaskPromptDeliveryQueue(
			scope as never,
			{
				mutation: {
					kind: "enqueue_prompt_for_delivery_after_current_turn",
					taskId: "task-1",
					queueEntryId: "q1",
					text: "跑测试",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(mutated.ok).toBe(true);
		expect(dispatcher.notifyQueueMutated).toHaveBeenCalledWith(scope.workspaceId, "task-1", mutated.queue);
		const read = await api.getTaskPromptDeliveryQueue(scope as never, {});
		expect(read.queue?.entriesByTaskId["task-1"]?.map((entry) => entry.text)).toEqual(["跑测试"]);
		expect(read.projectedEntriesByTaskId).toEqual({});
		expect(read).toMatchObject({
			queuedTaskPromptDeliveryDebugReferenceContext: {
				workspaceId: scope.workspaceId,
				workspaceProjectPath: scope.workspacePath,
				queuedTaskPromptDeliveriesFilePath: `/tmp/kanban-workspaces/${scope.workspaceId}/queued-task-prompt-deliveries.json`,
				taskMessageInjectionLedgerFilePath: `/tmp/kanban-workspaces/${scope.workspaceId}/task-message-injections.json`,
			},
		});
	});

	it("空正文拒绝入队", async () => {
		const scope = createQueueWorkspaceScope();
		const api = createQueueApi(scope, createDispatcherDouble());
		const mutated = await api.mutateTaskPromptDeliveryQueue(
			scope as never,
			{
				mutation: {
					kind: "enqueue_prompt_for_delivery_after_current_turn",
					taskId: "task-1",
					queueEntryId: "q1",
					text: "   ",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(mutated.ok).toBe(false);
	});

	// 队列满与幂等重发在快照上长得一样；不单独说出来，用户会以为自己排上了。
	it("队列满时 ok:false 并明说是满了", async () => {
		const scope = createQueueWorkspaceScope();
		const api = createQueueApi(scope, createDispatcherDouble());
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			await api.mutateTaskPromptDeliveryQueue(
				scope as never,
				{
					mutation: {
						kind: "enqueue_prompt_for_delivery_after_current_turn",
						taskId: "task-1",
						queueEntryId: `q${index}`,
						text: `第 ${index} 条`,
					},
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			);
		}
		const overflow = await api.mutateTaskPromptDeliveryQueue(
			scope as never,
			{
				mutation: {
					kind: "enqueue_prompt_for_delivery_after_current_turn",
					taskId: "task-1",
					queueEntryId: "overflow",
					text: "再排一条",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(overflow).toMatchObject({ ok: false, enqueueRefusedBecauseQueueCapacityIsExhausted: true });
		// 幂等重发不算被拒。
		const replay = await api.mutateTaskPromptDeliveryQueue(
			scope as never,
			{
				mutation: {
					kind: "enqueue_prompt_for_delivery_after_current_turn",
					taskId: "task-1",
					queueEntryId: "q0",
					text: "第 0 条",
				},
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(replay.ok).toBe(true);
		expect(replay.enqueueRefusedBecauseQueueCapacityIsExhausted).toBeUndefined();
	});

	// dd2db T2：人排条目也是一次「请求向会话投递消息」，按请求证据记 message 事件；只有本次真的新建了条目才算新意图。
	it("人排入队只在本次新建条目时记投递请求：同 id 重发与满额被拒都不记", async () => {
		const recordUserQueued =
			queuedTaskMessageDeliveryRecordingMocks.recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking;
		recordUserQueued.mockClear();
		const scope = createQueueWorkspaceScope();
		const api = createQueueApi(scope, createDispatcherDouble());
		const enqueue = (queueEntryId: string, text: string) =>
			api.mutateTaskPromptDeliveryQueue(
				scope as never,
				{
					mutation: {
						kind: "enqueue_prompt_for_delivery_after_current_turn",
						taskId: "task-1",
						queueEntryId,
						text,
					},
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			);

		await enqueue("q0", "第 0 条");
		expect(recordUserQueued).toHaveBeenCalledTimes(1);
		expect(recordUserQueued).toHaveBeenCalledWith({
			workspaceId: scope.workspaceId,
			newlyCreatedQueueEntry: expect.objectContaining({ queueEntryId: "q0", taskId: "task-1", text: "第 0 条" }),
			retriedFromSettledFailedQueueEntryId: null,
			kanbanRequestOriginActorEvidence:
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		});
		await enqueue("q0", "第 0 条");
		expect(recordUserQueued).toHaveBeenCalledTimes(1);

		for (let index = 1; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			await enqueue(`q${index}`, `第 ${index} 条`);
		}
		expect(recordUserQueued).toHaveBeenCalledTimes(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK);
		const overflow = await enqueue("overflow", "再排一条");
		expect(overflow.enqueueRefusedBecauseQueueCapacityIsExhausted).toBe(true);
		expect(recordUserQueued).toHaveBeenCalledTimes(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK);
	});

	it("CLI 显式排队在持久摘要为空时使用当前 legacy 主会话", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({ columns: [{ cards: [{ id: "task-1" }] }] });
		workspaceStateMocks.loadPersistedConversationSessions.mockReturnValue({});
		const scope = createQueueWorkspaceScope();
		const dispatcher = createDispatcherDouble();
		const api = createQueueApi(scope, dispatcher, { "task-1": createSummary({ taskId: "task-1" }) });
		expect(
			await api.enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				scope,
				{
					taskId: "task-1",
					attemptId: "task-1",
					text: "尚未落盘的主会话",
					source: "rvf",
					idempotencyKey: "live-legacy",
					promptSha256: "sha-live-legacy",
					maxWaitForAgentIdleMs: 600_000,
				},
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
			),
		).toMatchObject({ ok: true, injectionLedgerRecordDisposition: "created" });
		expect(dispatcher.notifyQueueMutated).toHaveBeenCalledWith(scope.workspaceId, "task-1", expect.any(Object));
	});

	it("CLI 空闲门控入队只在新建注入账本记录时记投递请求，同 key 重发不记", async () => {
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [{ cards: [{ id: "task-1" }] }],
		});
		workspaceStateMocks.loadPersistedConversationSessions.mockReturnValueOnce({
			"task-1": createSummary({ taskId: "task-1" }),
		});
		const recordAgentIdleGated =
			queuedTaskMessageDeliveryRecordingMocks.recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking;
		recordAgentIdleGated.mockClear();
		const scope = createQueueWorkspaceScope();
		const api = createQueueApi(scope, createDispatcherDouble());
		const request = {
			taskId: " task-1 ",
			text: "RVF 决策点边界标记",
			source: "rvf",
			idempotencyKey: " rvf-boundary-1 ",
			promptSha256: "sha-1",
			maxWaitForAgentIdleMs: 600_000,
		};

		const first = await api.enqueueAgentIdleGatedProgrammaticTaskChatMessage(
			scope as never,
			request,
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(first).toEqual({ ok: true, injectionLedgerRecordDisposition: "created" });
		expect(recordAgentIdleGated).toHaveBeenCalledTimes(1);
		expect(recordAgentIdleGated).toHaveBeenCalledWith({
			workspaceId: scope.workspaceId,
			taskId: "task-1",
			messageBodyText: "RVF 决策点边界标记",
			taskMessageDeliveryIdempotencyKey: "rvf-boundary-1",
			declaredMessageSourceLabel: "rvf",
			queuedPromptDeliveryQueueEntryId: buildQueuedProgrammaticInjectionQueueEntryId("rvf-boundary-1"),
			maxWaitForAgentIdleMs: 600_000,
			kanbanRequestOriginActorEvidence:
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		});

		const replay = await api.enqueueAgentIdleGatedProgrammaticTaskChatMessage(
			scope as never,
			request,
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(replay).toEqual({ ok: true, injectionLedgerRecordDisposition: "already_existed" });
		expect(recordAgentIdleGated).toHaveBeenCalledTimes(1);
	});

	// already_delivered 必须让用户看见（「来不及了，已经发出去」）。
	it("取消时把在途投递的取消回执原样带回", async () => {
		const scope = createQueueWorkspaceScope();
		const dispatcher = createDispatcherDouble();
		dispatcher.cancelInFlightQueuedPromptDelivery.mockResolvedValue("already_delivered" as never);
		const api = createQueueApi(scope, dispatcher);
		const cancelled = await api.mutateTaskPromptDeliveryQueue(
			scope as never,
			{
				mutation: { kind: "cancel_queued_prompt_delivery", taskId: "task-1", queueEntryId: "q1" },
			},
			KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
		);
		expect(dispatcher.cancelInFlightQueuedPromptDelivery).toHaveBeenCalledWith(scope.workspaceId, "task-1", "q1");
		expect(cancelled.inFlightDeliveryCancelResult).toBe("already_delivered");
	});
});
