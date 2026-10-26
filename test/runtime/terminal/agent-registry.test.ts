import type * as OperatingSystemModule from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET } from "../../../src/config/user-interface-preferences-shared-across-browser-origins";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));

const runtimeHostOperatingSystemIdentityMocks = vi.hoisted(() => ({ userInfo: vi.fn(), hostname: vi.fn() }));

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof OperatingSystemModule>()),
	...runtimeHostOperatingSystemIdentityMocks,
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { RUNTIME_AGENT_CATALOG } from "../../../src/core/agent-catalog";
import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	resolveAgentCommand,
} from "../../../src/terminal/agent-registry";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		ompAgentSessionTransportForNewTasks: "pty_terminal",
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

beforeEach(() => {
	runtimeHostOperatingSystemIdentityMocks.userInfo.mockReset().mockReturnValue({
		username: "runtime-host-account",
		uid: 1000,
		gid: 1000,
		homedir: "/home/runtime-host-account",
		shell: "/bin/sh",
	});
	runtimeHostOperatingSystemIdentityMocks.hostname.mockReset().mockReturnValue("runtime-host");
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		// 每个 catalog 条目的 binary 各探一次，外加 "npx"。从 catalog 推导而非硬编码，
		// 否则每加一个 agent 都要来改这个数字。
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(RUNTIME_AGENT_CATALOG.length + 1);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.newTaskStartInPlanModeByDefault).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual([
			"claude",
			"codex",
			"cline",
			"cursor",
			"droid",
			"kiro",
			"kimi",
			"omp",
		]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cursor")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const response = buildRuntimeConfigResponse(config, {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual([
			"claude",
			"codex",
			"cline",
			"cursor",
			"droid",
			"kiro",
			"kimi",
			"omp",
		]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cline")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "cursor")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "droid")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "kiro")?.defaultArgs).toEqual(["chat"]);
		expect(response.agents.find((agent) => agent.id === "cline")?.installed).toBe(true);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.agents.find((agent) => agent.id === "cursor")?.command).toBe("cursor-agent");
		expect(response.agents.find((agent) => agent.id === "droid")?.command).toBe("droid");
		expect(response.agents.find((agent) => agent.id === "kiro")?.command).toBe("kiro-cli chat");
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.debugModeEnabled).toBe(true);
	});

	it.each([false, true])("宿主账号查询不可用为 %s 时仍广播账号和主机名", (accountLookupUnavailable) => {
		if (accountLookupUnavailable)
			runtimeHostOperatingSystemIdentityMocks.userInfo.mockImplementation(() => {
				throw new Error("系统账号查询不可用");
			});
		const response = buildRuntimeConfigResponse(createRuntimeConfigState(), {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		});
		expect(response.runtimeHostRemoteEditorAccessIdentity).toEqual({
			operatingSystemAccountUsername: accountLookupUnavailable ? null : "runtime-host-account",
			operatingSystemHostname: "runtime-host",
		});
	});
});
