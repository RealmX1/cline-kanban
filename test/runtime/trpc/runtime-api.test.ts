import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeTaskTerminalAgentModelOverrideSettings,
} from "../../../src/core/api-contract";

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

const oauthMocks = vi.hoisted(() => ({
	addLocalProvider: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
	getValidClineCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveDefaultMcpSettingsPath: vi.fn(),
	resolveClineDataDir: vi.fn(() => "/tmp/cline"),
	loadMcpSettingsFile: vi.fn(),
	saveProviderSettings: vi.fn(),
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
}));

const llmsModelMocks = vi.hoisted(() => ({
	getAllProviders: vi.fn(),
	getModelsForProvider: vi.fn(),
	resolveProviderConfig: vi.fn(),
	resolveProviderModelCatalogKeys: vi.fn(),
}));

const localProviderMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
}));

const clineAccountMocks = vi.hoisted(() => ({
	fetchMe: vi.fn(),
	fetchRemoteConfig: vi.fn(),
	fetchOrganization: vi.fn(),
	fetchFeaturebaseToken: vi.fn(),
	constructedOptions: [] as Array<{ apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }>,
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceBoardById: vi.fn(),
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

vi.mock("@clinebot/core", () => ({
	addLocalProvider: oauthMocks.addLocalProvider,
	ensureCustomProvidersLoaded: oauthMocks.ensureCustomProvidersLoaded,
	getLocalProviderModels: localProviderMocks.getLocalProviderModels,
	getValidClineCredentials: oauthMocks.getValidClineCredentials,
	getValidOcaCredentials: oauthMocks.getValidOcaCredentials,
	getValidOpenAICodexCredentials: oauthMocks.getValidOpenAICodexCredentials,
	loginClineOAuth: oauthMocks.loginClineOAuth,
	loginOcaOAuth: oauthMocks.loginOcaOAuth,
	loginOpenAICodex: oauthMocks.loginOpenAICodex,
	resolveDefaultMcpSettingsPath: oauthMocks.resolveDefaultMcpSettingsPath,
	resolveClineDataDir: oauthMocks.resolveClineDataDir,
	loadMcpSettingsFile: oauthMocks.loadMcpSettingsFile,
	resolveProviderConfig: llmsModelMocks.resolveProviderConfig,
	ClineAccountService: class {
		constructor(options: { apiBaseUrl: string; getAuthToken: () => Promise<string | undefined | null> }) {
			clineAccountMocks.constructedOptions.push(options);
		}
		fetchMe = clineAccountMocks.fetchMe;
		fetchRemoteConfig = clineAccountMocks.fetchRemoteConfig;
		fetchOrganization = clineAccountMocks.fetchOrganization;
		fetchFeaturebaseToken = clineAccountMocks.fetchFeaturebaseToken;
	},
	ProviderSettingsManager: class {
		saveProviderSettings = oauthMocks.saveProviderSettings;
		getProviderSettings = oauthMocks.getProviderSettings;
		getLastUsedProviderSettings = oauthMocks.getLastUsedProviderSettings;
		getProviderConfig = vi.fn((providerId: string) => {
			const settings = oauthMocks.getProviderSettings(providerId);
			if (!settings) {
				return undefined;
			}
			return {
				providerId: settings.provider,
				apiKey: settings.apiKey,
				modelId: settings.model,
				baseUrl: settings.baseUrl,
			};
		});
	},
	Llms: {
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
		resolveProviderModelCatalogKeys: llmsModelMocks.resolveProviderModelCatalogKeys,
	},
	LlmsModels: {
		CLINE_DEFAULT_MODEL: "anthropic/claude-sonnet-4.6",
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
	},
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceBoardById: workspaceStateMocks.loadWorkspaceBoardById,
	// 程序化投递要按 workspaceId 解析注入账本路径。这个 mock 是刻意部分的，
	// 漏一个符号不会报「未 mock」而是让整条 sendTaskChatMessage 被 catch 成 ok:false——
	// 静默降级，所以新增运行时依赖时必须同步补齐这里。
	getWorkspaceDirectoryPath: (workspaceId: string) => `/tmp/kanban-workspaces/${workspaceId}`,
	getRuntimeHomePath: () => workspaceStateMocks.runtimeHomePath,
	getWorkspacesRootPath: () => "/tmp/kanban-workspaces",
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

import {
	getWorkspacePromptLibraryPath,
	readWorkspacePromptLibrarySnapshot,
} from "../../../src/state/prompt-library-store";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

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

function setSelectedProviderSettings(
	settings: {
		provider: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		reasoning?: {
			effort?: "low" | "medium" | "high" | "xhigh";
		};
		auth?: {
			accessToken?: string;
			refreshToken?: string;
			accountId?: string;
			expiresAt?: number;
		};
	} | null,
): void {
	oauthMocks.getLastUsedProviderSettings.mockReturnValue(settings ?? undefined);
	oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
		settings && settings.provider === providerId ? settings : undefined,
	);
}

function restoreEnvVar(name: "CLINE_API_KEY" | "OCA_API_KEY", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function createClineTaskSessionServiceMock() {
	return {
		startTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary>>(async () =>
			createSummary({ agentId: "cline", pid: null }),
		),
		onMessage: vi.fn<(...args: unknown[]) => () => void>(() => () => {}),
		stopTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		abortTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		cancelTaskTurn: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		sendTaskSessionInput: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		clearTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		reloadTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(async () => null),
		rebindPersistedTaskSession: vi.fn<(...args: unknown[]) => Promise<RuntimeTaskSessionSummary | null>>(
			async () => null,
		),
		getSummary: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		listSummaries: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary[]>(() => []),
		listMessages: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
		loadTaskSessionMessages: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
		applyTurnCheckpoint: vi.fn<(...args: unknown[]) => RuntimeTaskSessionSummary | null>(() => null),
		dispose: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
	};
}

describe("createRuntimeApi startTaskSession", () => {
	const originalClineApiKey = process.env.CLINE_API_KEY;
	const originalOcaApiKey = process.env.OCA_API_KEY;
	const originalClineMcpSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;
	const originalClineMcpOauthSettingsPath = process.env.CLINE_MCP_OAUTH_SETTINGS_PATH;
	let mcpSettingsPath = "";
	let mcpOauthSettingsPath = "";

	beforeEach(() => {
		mcpSettingsPath = `/tmp/kanban-mcp-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
		mcpOauthSettingsPath = `/tmp/kanban-mcp-oauth-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
		process.env.CLINE_MCP_SETTINGS_PATH = mcpSettingsPath;
		process.env.CLINE_MCP_OAUTH_SETTINGS_PATH = mcpOauthSettingsPath;
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		oauthMocks.addLocalProvider.mockReset();
		oauthMocks.ensureCustomProvidersLoaded.mockReset();
		oauthMocks.loginClineOAuth.mockReset();
		oauthMocks.loginOcaOAuth.mockReset();
		oauthMocks.loginOpenAICodex.mockReset();
		oauthMocks.getValidClineCredentials.mockReset();
		oauthMocks.getValidOcaCredentials.mockReset();
		oauthMocks.getValidOpenAICodexCredentials.mockReset();
		oauthMocks.resolveDefaultMcpSettingsPath.mockReset();
		oauthMocks.loadMcpSettingsFile.mockReset();
		oauthMocks.saveProviderSettings.mockReset();
		oauthMocks.getProviderSettings.mockReset();
		oauthMocks.getLastUsedProviderSettings.mockReset();
		clineAccountMocks.fetchMe.mockReset();
		clineAccountMocks.fetchRemoteConfig.mockReset();
		clineAccountMocks.constructedOptions.length = 0;
		localProviderMocks.getLocalProviderModels.mockReset();
		llmsModelMocks.getAllProviders.mockReset();
		llmsModelMocks.getModelsForProvider.mockReset();
		llmsModelMocks.resolveProviderConfig.mockReset();
		llmsModelMocks.resolveProviderModelCatalogKeys.mockReset();
		browserMocks.openInBrowser.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockReset();
		workspaceStateMocks.loadWorkspaceBoardById.mockResolvedValue({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{
					id: "review",
					title: "Review",
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
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
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
		oauthMocks.loginClineOAuth.mockResolvedValue({
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: 1_700_000_000_000,
			accountId: "acct-1",
		});
		oauthMocks.loginOcaOAuth.mockResolvedValue({
			access: "oca-access",
			refresh: "oca-refresh",
			expires: 1_700_000_000_000,
			accountId: "oca-acct",
		});
		oauthMocks.loginOpenAICodex.mockResolvedValue({
			access: "codex-access",
			refresh: "codex-refresh",
			expires: 1_700_000_000_000,
			accountId: "codex-acct",
		});
		oauthMocks.getValidClineCredentials.mockResolvedValue({
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: 1_700_000_000_000,
			accountId: "acct-1",
		});
		oauthMocks.getValidOcaCredentials.mockResolvedValue({
			access: "oca-access",
			refresh: "oca-refresh",
			expires: 1_700_000_000_000,
			accountId: "oca-acct",
		});
		oauthMocks.getValidOpenAICodexCredentials.mockResolvedValue({
			access: "codex-access",
			refresh: "codex-refresh",
			expires: 1_700_000_000_000,
			accountId: "codex-acct",
		});
		oauthMocks.addLocalProvider.mockResolvedValue({
			providerId: "custom-provider",
			settingsPath: "/tmp/providers.json",
			modelsPath: "/tmp/models.json",
			modelsCount: 1,
		});
		oauthMocks.ensureCustomProvidersLoaded.mockResolvedValue(undefined);
		llmsModelMocks.getAllProviders.mockResolvedValue([]);
		llmsModelMocks.getModelsForProvider.mockResolvedValue({});
		llmsModelMocks.resolveProviderConfig.mockResolvedValue(undefined);
		llmsModelMocks.resolveProviderModelCatalogKeys.mockImplementation((providerId: string) =>
			providerId === "cline" ? ["openrouter", "cline"] : [providerId],
		);
		oauthMocks.resolveDefaultMcpSettingsPath.mockReturnValue(mcpSettingsPath);
		oauthMocks.loadMcpSettingsFile.mockReturnValue({
			mcpServers: {},
		});
		clineAccountMocks.fetchMe.mockResolvedValue({
			id: "acct-1",
			email: "saoud@example.com",
			displayName: "Saoud",
		});
		clineAccountMocks.fetchRemoteConfig.mockResolvedValue({
			organizationId: "org-1",
			enabled: true,
			value: JSON.stringify({
				kanbanEnabled: true,
			}),
		});
		setSelectedProviderSettings(null);
		llmsModelMocks.getAllProviders.mockResolvedValue([
			{
				id: "cline",
				name: "Cline",
				defaultModelId: "claude-sonnet-4-6",
				capabilities: ["oauth"],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				defaultModelId: "claude-sonnet-4-6",
				capabilities: ["tools"],
			},
		]);
		llmsModelMocks.getModelsForProvider.mockImplementation(async (providerId: string) => {
			if (providerId !== "cline") {
				return {};
			}
			return {
				"claude-sonnet-4-6": {
					id: "claude-sonnet-4-6",
					name: "Claude Sonnet 4.6",
					capabilities: ["images", "files"],
				},
			};
		});
	});

	afterEach(() => {
		restoreEnvVar("CLINE_API_KEY", originalClineApiKey);
		restoreEnvVar("OCA_API_KEY", originalOcaApiKey);
		if (originalClineMcpSettingsPath === undefined) {
			delete process.env.CLINE_MCP_SETTINGS_PATH;
		} else {
			process.env.CLINE_MCP_SETTINGS_PATH = originalClineMcpSettingsPath;
		}
		if (originalClineMcpOauthSettingsPath === undefined) {
			delete process.env.CLINE_MCP_OAUTH_SETTINGS_PATH;
		} else {
			process.env.CLINE_MCP_OAUTH_SETTINGS_PATH = originalClineMcpOauthSettingsPath;
		}
		rmSync(mcpSettingsPath, { force: true });
		rmSync(`${mcpSettingsPath}.lock`, { force: true });
		rmSync(mcpOauthSettingsPath, { force: true });
		rmSync(`${mcpOauthSettingsPath}.lock`, { force: true });
	});

	it("reuses an existing worktree path before falling back to ensure", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

	it("starts a By the way runtime session in the main task workspace without creating a turn checkpoint", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-1" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				taskConversationSessionMetadata,
			}),
			expect.any(String),
		);
		expect(terminalManager.applyTurnCheckpoint).not.toHaveBeenCalled();
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("rejects By the way runtime sessions for unsupported agents", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-unsupported" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

	it("rejects a later cwd-latest fork after a By the way session already exists", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const existingByTheWaySummary = createSummary({
			taskId: "side-session-existing",
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
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

		expect(response).toMatchObject({ ok: false, error: expect.stringContaining("Start from scratch") });
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("rejects a forged full-authority fork context", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/main-task-worktree");
		const terminalManager = {
			getSummary: vi.fn(() => null),
			listSummaries: vi.fn(() => []),
			startTaskSession: vi.fn(async () => createSummary({ taskId: "side-session-forged" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

	it("routes cline start sessions to cline task session service", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
				startInPlanMode: true,
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				cwd: "/tmp/existing-worktree",
				prompt: "Continue task",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
				mode: "act",
				startInPlanMode: true,
				resumeFromTrash: undefined,
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("applies task-level reasoning overrides even without task model/provider overrides", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Reasoning-only override task",
				clineSettings: {
					reasoningEffort: "medium",
				},
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				reasoningEffort: "medium",
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("uses model-default reasoning when a task overrides the model but leaves reasoning on default", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
			reasoning: {
				effort: "high",
			},
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Task with model override",
				clineSettings: {
					modelId: "anthropic/claude-opus-4.6",
				},
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "anthropic/claude-opus-4.6",
				reasoningEffort: null,
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("skips cline persisted-session probing when resumeFromTrash already has a non-cline terminal summary", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "idle", pid: null })),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const getScopedClineTaskSessionService = vi.fn(async () => clineTaskSessionService as never);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService,
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
		expect(terminalManager.getSummary).toHaveBeenCalledWith("task-1");
		expect(getScopedClineTaskSessionService).not.toHaveBeenCalled();
		expect(clineTaskSessionService.rebindPersistedTaskSession).not.toHaveBeenCalled();
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

	it("clears task chat cache before resumeFromTrash starts", async () => {
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
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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
	});

	it("probes cline persisted sessions on resumeFromTrash when no terminal agent summary exists", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		setSelectedProviderSettings({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-api-key",
		});

		const terminalManager = {
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(
			createSummary({ agentId: "cline", pid: null }),
		);
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
		expect(terminalManager.getSummary).toHaveBeenCalledWith("task-1");
		expect(clineTaskSessionService.rebindPersistedTaskSession).toHaveBeenCalledWith("task-1");
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				resumeFromTrash: true,
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
			}),
		);
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("uses saved cline settings even when no last-used provider is recorded", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		oauthMocks.getLastUsedProviderSettings.mockReturnValue(undefined);
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "cline"
				? {
						provider: "cline",
						model: "anthropic/claude-opus-4.6",
						apiKey: "saved-cline-api-key",
					}
				: undefined,
		);

		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(
				async () => ({ startTaskSession: vi.fn(), applyTurnCheckpoint: vi.fn() }) as never,
			),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				modelId: "anthropic/claude-opus-4.6",
				apiKey: "saved-cline-api-key",
			}),
		);
	});

	it("fails early when the cline provider is selected without cline credentials", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		delete process.env.CLINE_API_KEY;
		setSelectedProviderSettings({
			provider: "cline",
			model: "anthropic/claude-opus-4.6",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(false);
		expect(response.summary).toBeNull();
		expect(response.error).toContain("no Cline credentials are configured");
		expect(clineTaskSessionService.startTaskSession).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("allows the cline provider to launch when CLINE_API_KEY is present in the environment", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		process.env.CLINE_API_KEY = "env-cline-api-key";
		setSelectedProviderSettings({
			provider: "cline",
			model: "anthropic/claude-opus-4.6",
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "cline",
				apiKey: "env-cline-api-key",
			}),
		);
	});

	it("starts home agent sessions in the workspace root without resolving a task worktree", async () => {
		const homeTaskId = "__home_agent__:workspace-1:codex";
		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ taskId: homeTaskId })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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

	it("forwards task images to CLI task sessions", async () => {
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
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
		expect(clineTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("refreshes Codex terminals with the same resume shape as restoring a done card", async () => {
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
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				prompt: "",
				images: undefined,
				startInPlanMode: undefined,
				resumeFromTrash: true,
			}),
			expect.any(String),
		);
		expect(response.mode).toBe("resume");
	});

	// ── 「首轮未结束被硬中断 → 重启后 TUI 全白且重启按钮不可用」的回归护栏 ────────────────────
	// 中断后 agentId 是最容易丢的字段。以前 refreshTaskTerminal 在解析卡片**之前**就以「没有活体
	// summary」「summary.agentId 为 null」两条 gate 拒绝，于是那句 `?? card.agentId ?? selectedAgentId`
	// 兜底永远够不着——用户只剩一个既全白、又点不动的面板。

	it("rebuilds the session when the summary is gone entirely（硬中断后没有任何活体条目）", async () => {
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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

	it("rebuilds the session from the card's most recently launched agent when the summary lost its agentId", async () => {
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
			dependencies: [],
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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

	// ── 归因护栏：客户端声明的启动来源必须原样落到 manager ────────────────────────────────
	// 「用户手点 Restart」与「前端发现会话已陈旧、自动续跑」打到的是同一个 refreshTaskTerminal，服务端
	// 收到的请求形状完全相同。而 refresh_task_terminal 实测占 pty 创建量的 68%——这 68% 里究竟有多少
	// 是程序自己点的，只有靠客户端声明才分得开。省略时必须维持旧行为，否则老客户端的记账会被改写。

	it("records a client-declared stale auto-resume refresh under its own origin instead of a human refresh", async () => {
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				cols: 120,
				rows: 40,
				taskSessionStartOriginDeclaredByClient: "stale_session_client_auto_resume",
			},
		);

		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(
			expect.anything(),
			"stale_session_client_auto_resume",
		);
	});

	it("keeps recording an undeclared refresh as a human refresh so older clients read the same", async () => {
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(terminalManager.refreshTaskTerminal).toHaveBeenCalledWith(expect.anything(), "refresh_task_terminal");
	});

	// ── 兜底优先级排序护栏：观测事实 > 卡片意图 ──────────────────────────────────────────────
	// `refreshTaskTerminal` 下游是 `resumeFromTrash: true` → `--continue`，解析的是「这条**既存**会话由谁跑起来」，
	// 与 `backfillMissingSessionAgentIdsFromDurableSources` 同问题、必须同序。

	it("prefers the observed launched agent over the card's agentId when the two disagree", async () => {
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
			dependencies: [],
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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

	it("rejects refresh when the observed launched agent is a conversation-panel agent even if the card names a PTY agent", async () => {
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
			dependencies: [],
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(false);
		expect(response.error).toBe("Refresh is only available for active TUI terminal agents.");
		expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
	});

	it("still rejects refresh for agents that are not PTY terminals（按能力谓词，不按 agentId 字面量）", async () => {
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
			dependencies: [],
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.refreshTaskTerminal(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", cols: 120, rows: 40 },
		);

		expect(response.ok).toBe(false);
		expect(response.error).toBe("Refresh is only available for active TUI terminal agents.");
		expect(terminalManager.refreshTaskTerminal).not.toHaveBeenCalled();
	});

	it("records the launched agent onto the card so a hard interruption can be recovered from", async () => {
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
			dependencies: [],
		} as unknown as RuntimeBoardData;
		let savedBoard: RuntimeBoardData | null = null;
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(
			async (
				_workspacePath: string,
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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

	it("does not resolve cline OAuth when starting a non-cline task session", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});
		oauthMocks.getValidClineCredentials.mockRejectedValue(
			new Error('OAuth credentials for provider "cline" are invalid. Re-run OAuth login.'),
		);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidClineCredentials).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				cwd: "/tmp/existing-worktree",
			}),
			expect.any(String),
		);
		expect(clineTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("prefers OAuth api key when cline OAuth credentials are configured", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));
		oauthMocks.getValidClineCredentials.mockResolvedValue({
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: 1_700_000_000_000,
			accountId: "acct-1",
		});
		setSelectedProviderSettings({
			provider: "cline",
			model: "claude-sonnet-4-6",
			auth: {
				accessToken: "oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledTimes(1);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "workos:oauth-access",
			}),
		);
		expect(clineAccountMocks.fetchMe).not.toHaveBeenCalled();
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				auth: expect.objectContaining({
					accessToken: "workos:oauth-access",
					refreshToken: "oauth-refresh",
					accountId: "acct-1",
				}),
			}),
			expect.objectContaining({
				tokenSource: "oauth",
				setLastUsed: true,
			}),
		);
	});

	it("does not use OAuth credentials for non-OAuth providers", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.startTaskSession.mockResolvedValue(createSummary({ agentId: "cline", pid: null }));
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				expiresAt: 1_700_000_000_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "cline";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
				prompt: "Continue task",
			},
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidClineCredentials).not.toHaveBeenCalled();
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
			}),
		);
		expect(oauthMocks.saveProviderSettings).not.toHaveBeenCalled();
	});

	it("routes cline task input and stop to cline task session service", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const terminalManager = {
			writeInput: vi.fn(),
			stopTaskSession: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		clineTaskSessionService.stopTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const sendResponse = await api.sendTaskSessionInput(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "hello", appendNewline: true },
		);
		expect(sendResponse.ok).toBe(true);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "hello\n");
		expect(terminalManager.writeInput).not.toHaveBeenCalled();

		const stopResponse = await api.stopTaskSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(stopResponse.ok).toBe(true);
		expect(clineTaskSessionService.stopTaskSession).toHaveBeenCalledWith("task-1");
		expect(terminalManager.stopTaskSession).not.toHaveBeenCalled();
	});

	it("returns cline chat messages and sends chat message through cline service", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-1",
			role: "user" as const,
			content: "hello",
			createdAt: Date.now(),
		};
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([latestMessage]);
		clineTaskSessionService.loadTaskSessionMessages.mockResolvedValue([latestMessage]);
		clineTaskSessionService.getSummary.mockReturnValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const sendResponse = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "hello" },
		);
		expect(sendResponse.ok).toBe(true);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-1",
			"hello",
			undefined,
			undefined,
		);
		expect(sendResponse.message).toEqual(latestMessage);

		const messagesResponse = await api.getTaskChatMessages(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(messagesResponse.ok).toBe(true);
		expect(messagesResponse.messages).toEqual([latestMessage]);

		clineTaskSessionService.abortTaskSession.mockResolvedValue(summary);
		const abortResponse = await api.abortTaskChatTurn(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(abortResponse.ok).toBe(true);
		expect(clineTaskSessionService.abortTaskSession).toHaveBeenCalledWith("task-1");

		clineTaskSessionService.cancelTaskTurn.mockResolvedValue(summary);
		const cancelResponse = await api.cancelTaskChatTurn(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);
		expect(cancelResponse.ok).toBe(true);
		expect(clineTaskSessionService.cancelTaskTurn).toHaveBeenCalledWith("task-1");
	});

	it("handles clear slash commands without sending them to the model", async () => {
		const summary = createSummary({ agentId: "cline", pid: null, state: "idle" });
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.clearTaskSession.mockResolvedValue(summary);
		const broadcastTaskChatCleared = vi.fn();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			broadcastTaskChatCleared,
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "  /clear  " },
		);

		expect(response).toEqual({
			ok: true,
			summary,
			message: null,
		});
		expect(clineTaskSessionService.clearTaskSession).toHaveBeenCalledWith("__home_agent__:workspace-1");
		expect(broadcastTaskChatCleared).toHaveBeenCalledWith("workspace-1", "__home_agent__:workspace-1");
		expect(clineTaskSessionService.sendTaskSessionInput).not.toHaveBeenCalled();
		expect(clineTaskSessionService.startTaskSession).not.toHaveBeenCalled();
	});

	it("forwards chat images through the cline service send path", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "hello",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "hello", undefined, [
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);
	});

	it("hydrates persisted cline chat messages when no live in-memory session is loaded", async () => {
		const persistedMessage = {
			id: "message-persisted-1",
			role: "assistant" as const,
			content: "Recovered from SDK artifacts",
			createdAt: Date.now(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.getSummary.mockReturnValue(null);
		clineTaskSessionService.loadTaskSessionMessages.mockResolvedValue([persistedMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getTaskChatMessages(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(true);
		expect(response.messages).toEqual([persistedMessage]);
		expect(clineTaskSessionService.loadTaskSessionMessages).toHaveBeenCalledWith("task-1");
	});

	it("reloads a chat session through the Cline task session service", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.reloadTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.reloadTaskChatSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1:cline" },
		);

		expect(response).toEqual({
			ok: true,
			summary,
		});
		expect(clineTaskSessionService.reloadTaskSession).toHaveBeenCalledWith("__home_agent__:workspace-1:cline");
	});

	it("restarts the home chat session from the saved launch config when reload cannot reuse cached config", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.reloadTaskSession.mockResolvedValue(null);
		clineTaskSessionService.startTaskSession.mockResolvedValue(summary);
		setSelectedProviderSettings({
			provider: "openrouter",
			model: "openrouter/auto",
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: {},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.reloadTaskChatSession(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1:cline" },
		);

		expect(response).toEqual({
			ok: true,
			summary,
		});
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith({
			taskId: "__home_agent__:workspace-1:cline",
			cwd: "/tmp/repo",
			prompt: "",
			resumeFromPersistence: true,
			providerId: "openrouter",
			modelId: "openrouter/auto",
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoningEffort: undefined,
		});
	});

	it("rebinds persisted non-home chat sessions before retrying the first send after restart", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-rebound-1",
			role: "user" as const,
			content: "continue",
			createdAt: Date.now(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValueOnce(null).mockResolvedValueOnce(summary);
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1", text: "continue" },
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.rebindPersistedTaskSession).toHaveBeenCalledWith("task-1");
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(
			1,
			"task-1",
			"continue",
			undefined,
			undefined,
		);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenNthCalledWith(
			2,
			"task-1",
			"continue",
			undefined,
			undefined,
		);
		expect(response.message).toEqual(latestMessage);
	});

	it("forwards task chat source metadata to the Cline message", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-rvf-1",
			role: "user" as const,
			content: "$review-validate-fix",
			createdAt: Date.now(),
			meta: {
				source: "review-validate-fix",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "$review-validate-fix",
				source: " review-validate-fix ",
				idempotencyKey: " rvf-run-1 ",
				promptSha256: " abc123 ",
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-1",
			"$review-validate-fix",
			undefined,
			undefined,
			{
				source: "review-validate-fix",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		);
		expect(response.message).toEqual(latestMessage);
	});

	it("falls back to terminal input for running non-Cline task chat messages", async () => {
		const summary = createSummary({ agentId: "codex", state: "awaiting_review" });
		const terminalManager = {
			submitTaskChatInputWhenReady: vi.fn(() => summary),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(null);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-1",
				text: "please continue",
				source: "review-validate-fix",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-1",
			"please continue",
			undefined,
			undefined,
			{
				source: "review-validate-fix",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		);
		expect(clineTaskSessionService.rebindPersistedTaskSession).toHaveBeenCalledWith("task-1");
		// RVF followup 终端回退：经就绪门控投递，以原始文本调用（bracketed-paste 编码与就绪判定下沉到
		// TerminalSessionManager.submitTaskChatInputWhenReady，由 session-manager 单测覆盖）。带 source（后台自动
		// 注入）→ deferWhileUserTurn=true：遇 agent 正等用户拍板的模态时让位挂起、不打断（Fix B）。
		// 带 idempotencyKey → 同时登记诚实回执：runtime 在投递落定后经 onDeliveryOutcome 回写注入账本，
		// 这是「CLI 已退出不再意味着状态不会变」的接线点。
		// 争用分层：策略取自配置（默认 auto = 允许在人不在场时自动暂存抢占），抢占执行者就是
		// Ctrl+S 那条暂存链路本身（只是 origin 标成「被程序化投递抢占」）。
		expect(terminalManager.submitTaskChatInputWhenReady).toHaveBeenCalledWith("task-1", "please continue", {
			deferWhileUserTurn: true,
			idempotencyKey: "rvf-run-1",
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
				source: "review-validate-fix",
				idempotencyKey: "rvf-run-1",
				promptSha256: "abc123",
			},
		});
	});

	// ACP（omp）通道的程序化投递必须当场落终态。这条链路上没有 onDeliveryOutcome 这样的登记点，
	// 回执一旦停在 accepted_pending_submit_confirmation 就再没有任何人会改写它：
	// `--wait-for-terminal-status` 必然空等到超时，账本要挂到下次 runtime 启动清扫才被判失败，
	// 直接违反「唯一非终态必然在有界时间内收敛」这条不变量。
	it("settles ACP programmatic delivery on the spot instead of leaving it pending forever", async () => {
		// ACP 会话的 summary 恒由 createDefaultAcpSummary 盖上通道章。这里必须显式带上：
		// 不带章的 omp summary 现在意味着一条 **TUI** 会话（omp 的 catalog 默认已是 pty_terminal），
		// 聊天端点会正确地不把它当 ACP 任务分派。
		const summary = createSummary({
			agentId: "omp",
			state: "running",
			sessionTransport: "acp_stdio_subprocess",
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
		const clineTaskSessionService = createClineTaskSessionServiceMock();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-acp-1",
				text: "please continue",
				source: "review-validate-fix",
				idempotencyKey: "rvf-acp-1",
				promptSha256: "abc123",
			},
		);

		expect(response.ok).toBe(true);
		expect(acpTaskSessionService.sendTaskSessionInput).toHaveBeenCalledWith(
			"task-acp-1",
			"please continue",
			undefined,
		);
		expect(response.terminalDelivery).toEqual({
			status: "delivered_and_submit_confirmed",
			reason: null,
		});
		expect(response.message).toEqual(latestMessage);
		expect(clineTaskSessionService.sendTaskSessionInput).not.toHaveBeenCalled();
	});

	// 有 ACP 会话账本但连接已经没了：同样不能留 pending，如实判失败。
	it("reports ACP delivery failure when the agent connection is already gone", async () => {
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				taskId: "task-acp-1",
				text: "please continue",
				source: "review-validate-fix",
				idempotencyKey: "rvf-acp-2",
				promptSha256: "abc123",
			},
		);

		expect(response.ok).toBe(false);
		expect(response.terminalDelivery).toEqual({
			status: "delivery_failed",
			reason: "no_active_terminal_session",
		});
	});

	it("does not fall back to terminal input for chat messages with images", async () => {
		const terminalManager = {
			submitTaskChatInputWhenReady: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(null);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
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
		);

		expect(response).toEqual({
			ok: false,
			summary: null,
			error: "Task chat images require an active Cline chat session.",
		});
		expect(terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
	});

	it("auto-starts home chat sessions when the first message is sent", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-home-1",
			role: "user" as const,
			content: "hello home",
			createdAt: Date.now(),
		};
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const runtimeConfigState = createRuntimeConfigState();
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.startTaskSession.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([latestMessage]);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => runtimeConfigState),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "hello home" },
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "__home_agent__:workspace-1",
				cwd: "/tmp/repo",
				prompt: "hello home",
				providerId: "cline",
				apiKey: "workos:oauth-access",
			}),
		);
		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledWith(
			expect.objectContaining({
				access: "seed-token",
				refresh: "seed-refresh",
			}),
			expect.any(Object),
		);
		expect(response.message).toEqual(latestMessage);
	});

	it("starts home chat sessions from persisted history with current launch config", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const latestMessage = {
			id: "message-home-rebound-1",
			role: "user" as const,
			content: "continue home",
			createdAt: Date.now(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValueOnce(null);
		clineTaskSessionService.startTaskSession.mockResolvedValue(summary);
		clineTaskSessionService.listMessages.mockReturnValue([latestMessage]);
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "continue home" },
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "__home_agent__:workspace-1",
				cwd: "/tmp/repo",
				prompt: "continue home",
				resumeFromPersistence: true,
				providerId: "cline",
				apiKey: "workos:oauth-access",
			}),
		);
		expect(clineTaskSessionService.sendTaskSessionInput).toHaveBeenCalledTimes(1);
		expect(response.message).toEqual(latestMessage);
	});

	it("home chat auto-start keeps manual API key for non-OAuth providers", async () => {
		const summary = createSummary({ agentId: "cline", pid: null });
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const runtimeConfigState = createRuntimeConfigState();
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
			auth: {
				accessToken: "workos:seed-token",
				refreshToken: "seed-refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		});
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.startTaskSession.mockResolvedValue(summary);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => runtimeConfigState),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.sendTaskChatMessage(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "__home_agent__:workspace-1", text: "hello home" },
		);

		expect(response.ok).toBe(true);
		expect(oauthMocks.getValidClineCredentials).not.toHaveBeenCalled();
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				apiKey: "anthropic-api-key",
			}),
		);
	});

	it("returns cline provider catalog and provider models", async () => {
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				return createRuntimeConfigState();
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			model: "claude-sonnet-4-6",
		});

		const catalogResponse = await api.getClineProviderCatalog({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});
		expect(catalogResponse.providers.some((provider) => provider.id === "cline")).toBe(true);
		expect(catalogResponse.providers.find((provider) => provider.id === "cline")?.enabled).toBe(true);

		const modelsResponse = await api.getClineProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "cline" },
		);
		expect(modelsResponse.providerId).toBe("cline");
		expect(modelsResponse.models.some((model) => model.id === "claude-sonnet-4-6")).toBe(true);
	});

	it("loads provider models through the SDK local-provider resolver with saved config", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "openrouter",
			model: "openrouter/auto",
			apiKey: "openrouter-key",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		localProviderMocks.getLocalProviderModels.mockResolvedValue({
			providerId: "openrouter",
			models: [
				{
					id: "openrouter/free",
					name: "OpenRouter Free",
					supportsReasoning: true,
				},
			],
		});

		const response = await api.getClineProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "openrouter" },
		);

		expect(localProviderMocks.getLocalProviderModels).toHaveBeenCalledWith(
			"openrouter",
			expect.objectContaining({
				providerId: "openrouter",
				modelId: "openrouter/auto",
				apiKey: "openrouter-key",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		);
		expect(response).toEqual({
			providerId: "openrouter",
			models: [
				{
					id: "openrouter/free",
					name: "OpenRouter Free",
					supportsReasoningEffort: true,
				},
			],
		});
	});

	it("adds refreshed live catalog models to provider model responses", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "deepseek",
			model: "deepseek-chat",
			apiKey: "deepseek-key",
			baseUrl: "https://api.deepseek.com/v1",
		});
		localProviderMocks.getLocalProviderModels.mockResolvedValue({
			providerId: "deepseek",
			models: [
				{
					id: "deepseek-chat",
					name: "DeepSeek Chat",
				},
			],
		});
		llmsModelMocks.resolveProviderConfig.mockResolvedValue({
			knownModels: {
				"deepseek-v4-pro": {
					id: "deepseek-v4-pro",
					name: "DeepSeek V4 Pro",
					capabilities: ["tools", "reasoning"],
				},
			},
		});

		const response = await api.getClineProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "deepseek" },
		);

		expect(llmsModelMocks.resolveProviderModelCatalogKeys).toHaveBeenCalledWith("deepseek");
		expect(llmsModelMocks.resolveProviderConfig).toHaveBeenCalledWith(
			"deepseek",
			expect.objectContaining({
				loadLatestOnInit: true,
				loadPrivateOnAuth: true,
				failOnError: false,
			}),
			expect.objectContaining({
				providerId: "deepseek",
				modelId: "deepseek-chat",
				apiKey: "deepseek-key",
			}),
		);
		expect(response.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "deepseek-v4-pro",
					name: "DeepSeek V4 Pro",
					supportsReasoningEffort: true,
				}),
				expect.objectContaining({
					id: "deepseek-chat",
					name: "DeepSeek Chat",
				}),
			]),
		);
	});

	it("loads Cline provider models from the SDK catalog key mapping", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
		});
		localProviderMocks.getLocalProviderModels.mockResolvedValue({
			providerId: "cline",
			models: [
				{
					id: "anthropic/claude-sonnet-4.6",
					name: "Claude Sonnet 4.6",
				},
			],
		});
		llmsModelMocks.resolveProviderConfig.mockImplementation((providerId: string) =>
			providerId === "openrouter"
				? Promise.resolve({
						knownModels: {
							"deepseek/deepseek-v4-flash": {
								id: "deepseek/deepseek-v4-flash",
								name: "DeepSeek V4 Flash",
								capabilities: ["tools", "reasoning"],
							},
						},
					})
				: Promise.resolve(undefined),
		);

		const response = await api.getClineProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "cline" },
		);

		expect(llmsModelMocks.resolveProviderModelCatalogKeys).toHaveBeenCalledWith("cline");
		expect(llmsModelMocks.resolveProviderConfig).toHaveBeenCalledWith(
			"openrouter",
			expect.objectContaining({
				loadLatestOnInit: true,
			}),
			undefined,
		);
		expect(response.models.some((model) => model.id === "deepseek/deepseek-v4-flash")).toBe(true);
	});

	it("falls back to the queried provider's saved model when provider model loading fails", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		oauthMocks.getLastUsedProviderSettings.mockReturnValue({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			apiKey: "anthropic-key",
		});
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) => {
			if (providerId === "anthropic") {
				return {
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					apiKey: "anthropic-key",
				};
			}
			if (providerId === "openrouter") {
				return {
					provider: "openrouter",
					model: "openrouter/free",
					apiKey: "openrouter-key",
					baseUrl: "https://openrouter.ai/api/v1",
				};
			}
			return undefined;
		});
		localProviderMocks.getLocalProviderModels.mockRejectedValue(new Error("catalog unavailable"));

		const response = await api.getClineProviderModels(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ providerId: "openrouter" },
		);

		expect(response).toEqual({
			providerId: "openrouter",
			models: [
				{
					id: "openrouter/free",
					name: "openrouter/free",
				},
			],
		});
	});

	it("adds a custom OpenAI-compatible provider through the SDK-backed flow", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		llmsModelMocks.getAllProviders.mockResolvedValue([
			{
				id: "cline",
				name: "Cline",
				defaultModelId: "claude-sonnet-4-6",
				capabilities: ["oauth"],
			},
		]);
		oauthMocks.addLocalProvider.mockImplementation(async (_manager: unknown, request: Record<string, unknown>) => {
			oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
				providerId === request.providerId
					? {
							provider: request.providerId,
							model: request.defaultModelId,
							apiKey: request.apiKey,
							baseUrl: request.baseUrl,
						}
					: undefined,
			);
			return {
				providerId: request.providerId,
				settingsPath: "/tmp/providers.json",
				modelsPath: "/tmp/models.json",
				modelsCount: 1,
			};
		});

		const response = await api.addClineProvider(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				providerId: "my-provider",
				name: "My Provider",
				baseUrl: "http://localhost:8000/v1",
				apiKey: "secret-key",
				models: ["qwen2.5-coder:32b"],
				defaultModelId: "qwen2.5-coder:32b",
				capabilities: ["tools", "streaming"],
			},
		);

		expect(response).toEqual(
			expect.objectContaining({
				providerId: "my-provider",
				modelId: "qwen2.5-coder:32b",
				baseUrl: "http://localhost:8000/v1",
				apiKeyConfigured: true,
			}),
		);
		expect(oauthMocks.addLocalProvider).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				providerId: "my-provider",
				name: "My Provider",
				baseUrl: "http://localhost:8000/v1",
				apiKey: "secret-key",
				models: ["qwen2.5-coder:32b"],
				defaultModelId: "qwen2.5-coder:32b",
				capabilities: ["tools", "streaming"],
			}),
		);
		expect(oauthMocks.ensureCustomProvidersLoaded).toHaveBeenCalled();
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "my-provider",
				model: "qwen2.5-coder:32b",
				apiKey: "secret-key",
				baseUrl: "http://localhost:8000/v1",
			}),
			expect.objectContaining({
				tokenSource: "manual",
				setLastUsed: true,
			}),
		);
	});

	it("returns cline account profile for cline OAuth users", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const response = await api.getClineAccountProfile({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.profile).toEqual({
			accountId: "acct-1",
			email: "saoud@example.com",
			displayName: "Saoud",
		});
		expect(clineAccountMocks.constructedOptions[0]?.apiBaseUrl).toBe("https://api.cline.bot");
		expect(clineAccountMocks.fetchMe).toHaveBeenCalledTimes(1);
		expect(oauthMocks.getValidClineCredentials).not.toHaveBeenCalled();
		const getAuthToken = clineAccountMocks.constructedOptions[0]?.getAuthToken;
		await expect(getAuthToken?.()).resolves.toBe("workos:oauth-access");
	});

	it("refreshes cline OAuth credentials and retries profile lookup when direct profile fetch fails", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		clineAccountMocks.fetchMe
			.mockRejectedValueOnce(new Error("Cline account request failed with status 401"))
			.mockResolvedValueOnce({
				id: "acct-1",
				email: "saoud@example.com",
				displayName: "Saoud",
			});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:expired-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		const response = await api.getClineAccountProfile({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.profile).toEqual({
			accountId: "acct-1",
			email: "saoud@example.com",
			displayName: "Saoud",
		});
		expect(clineAccountMocks.fetchMe).toHaveBeenCalledTimes(2);
		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledTimes(1);
		const refreshedGetAuthToken = clineAccountMocks.constructedOptions[1]?.getAuthToken;
		await expect(refreshedGetAuthToken?.()).resolves.toBe("workos:oauth-access");
	});

	it("blocks kanban when remote config explicitly disables it", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});
		clineAccountMocks.fetchRemoteConfig.mockResolvedValueOnce({
			organizationId: "org-1",
			enabled: true,
			value: JSON.stringify({
				kanbanEnabled: false,
			}),
		});

		clineAccountMocks.fetchOrganization.mockResolvedValueOnce({
			externalOrganizationId: "test",
		});

		const response = await api.getClineKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.enabled).toBe(false);
		expect(clineAccountMocks.fetchRemoteConfig).toHaveBeenCalledTimes(1);
	});

	it("allows kanban when remote config fetch fails", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});
		clineAccountMocks.fetchRemoteConfig
			.mockResolvedValueOnce({
				organizationId: "org-1",
				enabled: true,
				value: JSON.stringify({
					kanbanEnabled: false,
				}),
			})
			.mockRejectedValueOnce(new Error("remote config request failed"));

		clineAccountMocks.fetchOrganization.mockResolvedValueOnce({
			externalOrganizationId: "test",
		});

		const initialResponse = await api.getClineKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});
		const failedFetchResponse = await api.getClineKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(initialResponse.enabled).toBe(false);
		expect(failedFetchResponse.enabled).toBe(true);
		expect(clineAccountMocks.fetchRemoteConfig).toHaveBeenCalledTimes(2);
	});

	it("allows kanban by default for non-cline providers", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "anthropic",
			apiKey: "anthropic-api-key",
		});

		const response = await api.getClineKanbanAccess({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.enabled).toBe(true);
		expect(clineAccountMocks.fetchRemoteConfig).not.toHaveBeenCalled();
	});

	it("runs oauth login for selected provider and persists provider settings", async () => {
		const terminalManager = {
			writeInput: vi.fn(),
		};
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		const bumpClineSessionContextVersion = vi.fn();

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpClineSessionContextVersion,
		});

		const response = await api.runClineProviderOAuthLogin(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ provider: "cline" },
		);
		expect(response.ok).toBe(true);
		expect(response.provider).toBe("cline");
		expect(response.settings).toEqual(
			expect.objectContaining({
				providerId: "cline",
				oauthProvider: "cline",
				oauthAccessTokenConfigured: true,
				oauthRefreshTokenConfigured: true,
				oauthAccountId: "acct-1",
			}),
		);
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cline",
				auth: expect.objectContaining({
					accessToken: "workos:oauth-access",
					refreshToken: "oauth-refresh",
					accountId: "acct-1",
				}),
			}),
			expect.objectContaining({
				tokenSource: "oauth",
				setLastUsed: true,
			}),
		);
		expect(oauthMocks.loginClineOAuth).toHaveBeenCalledTimes(1);
		expect(bumpClineSessionContextVersion).toHaveBeenCalledTimes(1);
		const loginInput = oauthMocks.loginClineOAuth.mock.calls[0]?.[0] as
			| {
					callbacks?: { onManualCodeInput?: unknown };
			  }
			| undefined;
		expect(loginInput?.callbacks?.onManualCodeInput).toBeUndefined();
	});

	it("bumps cline session context when provider settings are saved", async () => {
		const bumpClineSessionContextVersion = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpClineSessionContextVersion,
		});
		setSelectedProviderSettings({
			provider: "openrouter",
			model: "openrouter/auto",
			apiKey: "openrouter-key",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		const response = await api.saveClineProviderSettings(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{
				providerId: "openrouter",
				modelId: "openrouter/free",
			},
		);

		expect(response.providerId).toBe("openrouter");
		expect(bumpClineSessionContextVersion).toHaveBeenCalledTimes(1);
	});

	it("returns Cline MCP settings", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						linear: {
							type: "streamableHttp",
							url: "https://mcp.linear.app/mcp",
							disabled: false,
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getClineMcpSettings({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.path).toBe(mcpSettingsPath);
		expect(response.servers).toEqual([
			{
				name: "linear",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.linear.app/mcp",
			},
		]);
	});

	it("saves Cline MCP settings", async () => {
		const bumpClineSessionContextVersion = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			bumpClineSessionContextVersion,
		});

		const response = await api.saveClineMcpSettings(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				servers: [
					{
						name: "linear",
						disabled: false,
						type: "streamableHttp",
						url: "https://mcp.linear.app/mcp",
					},
				],
			},
		);

		expect(response.path).toBe(mcpSettingsPath);
		expect(response.servers).toEqual([
			{
				name: "linear",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.linear.app/mcp",
			},
		]);
		expect(bumpClineSessionContextVersion).toHaveBeenCalledTimes(1);
	});

	it("returns MCP auth statuses from persisted OAuth settings", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						linear: {
							type: "streamableHttp",
							url: "https://mcp.linear.app/mcp",
						},
						filesystem: {
							type: "stdio",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						},
					},
				},
				null,
				2,
			),
		);
		writeFileSync(
			mcpOauthSettingsPath,
			JSON.stringify(
				{
					servers: {
						linear: {
							tokens: {
								access_token: "token-1",
								token_type: "Bearer",
							},
							lastAuthenticatedAt: 1_700_000_000_000,
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getClineMcpAuthStatuses({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response.statuses).toEqual([
			{
				serverName: "filesystem",
				oauthSupported: false,
				oauthConfigured: false,
				lastError: null,
				lastAuthenticatedAt: null,
			},
			{
				serverName: "linear",
				oauthSupported: true,
				oauthConfigured: true,
				lastError: null,
				lastAuthenticatedAt: 1_700_000_000_000,
			},
		]);
	});

	it("rejects MCP OAuth flow for stdio servers", async () => {
		writeFileSync(
			mcpSettingsPath,
			JSON.stringify(
				{
					mcpServers: {
						filesystem: {
							type: "stdio",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						},
					},
				},
				null,
				2,
			),
		);

		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await expect(
			api.runClineMcpServerOAuth(
				{
					workspaceId: "workspace-1",
					workspacePath: "/tmp/repo",
				},
				{
					serverName: "filesystem",
				},
			),
		).rejects.toThrow("does not support OAuth browser flow");
	});

	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".cline", "data"),
			join(tempHome, ".cline", "kanban"),
			join(tempHome, ".cline", "worktrees"),
		];
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
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

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".cline", "data"),
			join(tempHome, ".cline", "kanban"),
			join(tempHome, ".cline", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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

describe("createRuntimeApi getFeaturebaseToken", () => {
	beforeEach(() => {
		oauthMocks.getProviderSettings.mockReset();
		oauthMocks.getLastUsedProviderSettings.mockReset();
		oauthMocks.getValidClineCredentials.mockReset();
		oauthMocks.saveProviderSettings.mockReset();
		clineAccountMocks.fetchFeaturebaseToken.mockReset();
		clineAccountMocks.constructedOptions.length = 0;
	});

	it("returns JWT from SDK method", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:oauth-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});
		clineAccountMocks.fetchFeaturebaseToken.mockResolvedValueOnce({
			featurebaseJwt: "jwt-token-123",
		});

		const response = await api.getFeaturebaseToken({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response).toEqual({ featurebaseJwt: "jwt-token-123" });
	});

	it("throws when no provider settings configured", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings(null);

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow("Failed to fetch Featurebase token.");
	});

	it("throws when provider is not cline", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "oca",
			auth: {
				accessToken: "some-token",
				refreshToken: "some-refresh",
			},
		});

		await expect(
			api.getFeaturebaseToken({
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			}),
		).rejects.toThrow("Featurebase token requires a Cline provider.");
	});

	it("retries after OAuth refresh when first attempt fails", async () => {
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		setSelectedProviderSettings({
			provider: "cline",
			auth: {
				accessToken: "workos:stale-access",
				refreshToken: "oauth-refresh",
				accountId: "acct-1",
				expiresAt: 1_700_000_000_000,
			},
		});

		// First attempt fails (e.g. expired token)
		clineAccountMocks.fetchFeaturebaseToken.mockRejectedValueOnce(new Error("Unauthorized"));

		// OAuth refresh returns fresh credentials
		oauthMocks.getValidClineCredentials.mockResolvedValueOnce({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: 1_800_000_000_000,
			accountId: "acct-1",
		});

		// Second attempt succeeds with refreshed token
		clineAccountMocks.fetchFeaturebaseToken.mockResolvedValueOnce({
			featurebaseJwt: "refreshed-jwt-456",
		});

		const response = await api.getFeaturebaseToken({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response).toEqual({ featurebaseJwt: "refreshed-jwt-456" });
		expect(clineAccountMocks.fetchFeaturebaseToken).toHaveBeenCalledTimes(2);
		expect(oauthMocks.getValidClineCredentials).toHaveBeenCalledTimes(1);
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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
			dependencies: [],
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
	}

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
			dependencies: [],
		});
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_path: string, mutate: never) => {
			const mutation = (mutate as unknown as (state: unknown) => { board: unknown; value: unknown })({
				board: { columns: [], dependencies: [] },
			});
			return { saved: true, value: mutation.value };
		});
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			getScopedAcpTaskSessionService: vi.fn(async () => ({ getSummary: () => null }) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "acp_stdio_subprocess" },
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "pty_terminal" },
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			getScopedAcpTaskSessionService: vi.fn(async () => acpTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.switchAgentSessionTransport(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-omp", targetSessionTransport: "pty_terminal" },
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
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
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
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(null);
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
						preemptivelyStashHumanInputBox?: (taskId: string) => Promise<boolean>;
					},
				) => summary,
			),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		await api.sendTaskChatMessage(scope, {
			taskId: "task-1",
			text: "继续 RVF",
			source: "review-validate-fix",
			idempotencyKey: "rvf-contention-1",
			promptSha256: "abc123",
		});

		const deliveryOptions = terminalManager.submitTaskChatInputWhenReady.mock.calls[0]?.[2];
		if (!deliveryOptions?.preemptivelyStashHumanInputBox) {
			throw new Error("投递 options 必须带上争用抢占执行者");
		}
		// 策略取自配置（默认允许在人不在场时抢占）。
		expect(deliveryOptions.mayAutoStashAbsentHumanInputBox).toBe(true);

		await expect(deliveryOptions.preemptivelyStashHumanInputBox("task-1")).resolves.toBe(true);
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
		await expect(deliveryOptions.preemptivelyStashHumanInputBox("task-1")).resolves.toBe(false);
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
	): Promise<(taskId: string) => Promise<boolean>> {
		const summary = createSummary({ agentId: "claude", state: "awaiting_review" });
		const clineTaskSessionService = createClineTaskSessionServiceMock();
		clineTaskSessionService.sendTaskSessionInput.mockResolvedValue(null);
		clineTaskSessionService.rebindPersistedTaskSession.mockResolvedValue(null);
		// spread 复制的是 vi.fn 的引用，于是调用方仍可以对原 terminalManager 上那个 forward 替身做断言。
		const terminalManagerWithDelivery = {
			...terminalManager,
			submitTaskChatInputWhenReady: vi.fn(
				(
					_taskId: string,
					_text: string,
					_options?: {
						mayAutoStashAbsentHumanInputBox?: boolean;
						preemptivelyStashHumanInputBox?: (taskId: string) => Promise<boolean>;
					},
				) => summary,
			),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => scope.workspaceId),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManagerWithDelivery as never),
			getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});
		await api.sendTaskChatMessage(scope, {
			taskId: "task-1",
			text: "继续 RVF",
			source: "review-validate-fix",
			idempotencyKey: `rvf-preemption-${scope.workspaceId}`,
			promptSha256: "abc123",
		});
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

		await expect(preemptivelyStashHumanInputBox("task-1")).resolves.toBe(false);

		// 红线：转发一次 = 那半句被 agent 自己的暂存区吞掉，而抢占已如实返回 false、这次投递根本不会
		// 发生——内容没了，连一次投递都没换到。
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

		await expect(preemptivelyStashHumanInputBox("task-1")).resolves.toBe(false);

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
