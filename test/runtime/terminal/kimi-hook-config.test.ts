import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { buildKanbanManagedKimiHooksToml } from "../../../src/terminal/kimi-hook-config";
import { createTempDir } from "../../utilities/temp-dir";

// 预期表独立于生产映射，防止删事件或改映射时测试跟着一起退化。
const EXPECTED_KIMI_HOOK_EVENT_MAPPINGS = [
	["SessionStart", "agent_conversation_session_identity_observed"],
	["UserPromptSubmit", "to_in_progress"],
	["PreToolUse", "activity"],
	["PostToolUse", "to_in_progress"],
	["PostToolUseFailure", "to_in_progress"],
	["PermissionRequest", "to_review"],
	["PermissionResult", "activity"],
	["Stop", "to_review"],
	["StopFailure", "to_review"],
	["Interrupt", "to_review"],
	["PostCompact", "main_agent_conversation_context_compaction_completed"],
] as const;

const kimiHookConfigurationSchema = z.object({
	hooks: z.array(z.object({ event: z.string(), command: z.string(), timeout: z.number() })),
});
const originalProcessArguments = [...process.argv];
const originalNodeExecutionArguments = [...process.execArgv];

afterEach(() => {
	process.argv = [...originalProcessArguments];
	process.execArgv = [...originalNodeExecutionArguments];
});

function createIsolatedKimiHookCommandRecordingInstallation(includeLightweightEntrypoint = true) {
	const directory = createTempDir("kimi-hook-command-toml-shell-round-trip-");
	onTestFinished(directory.cleanup);
	// shell 与 TOML 的两层转义都必须保留这些字面字符，不能把它们当命令执行。
	const installationDirectory = join(directory.path, "安装 '单引号' \"双引号\" \\ $dollar `backtick`");
	mkdirSync(installationDirectory);
	const fullCliPath = join(installationDirectory, "cli.js");
	const lightweightCliPath = join(installationDirectory, "kanban-agent-hook-cli.js");
	const commandRecorder = `process.stdout.write(JSON.stringify({
		entrypoint: process.argv[1],
		argumentsList: process.argv.slice(2),
		taskId: process.env.KANBAN_HOOK_TASK_ID,
		workspaceId: process.env.KANBAN_HOOK_WORKSPACE_ID,
		hostSocketPath: process.env.KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH,
		hostedSessionKey: process.env.KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY
	}));`;
	writeFileSync(fullCliPath, commandRecorder);
	if (includeLightweightEntrypoint) writeFileSync(lightweightCliPath, commandRecorder);
	process.argv = [process.execPath, fullCliPath];
	process.execArgv = [];
	const inheritedHookIdentityEnvironment = {
		HOME: directory.path,
		USERPROFILE: directory.path,
		KANBAN_HOOK_TASK_ID: "isolated-kimi-hook-task",
		KANBAN_HOOK_WORKSPACE_ID: "isolated-kimi-hook-workspace",
		KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH: join(directory.path, "isolated-host.sock"),
		KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY: "isolated-kimi-hosted-session",
	};
	return {
		fullCliPath,
		lightweightCliPath: includeLightweightEntrypoint ? realpathSync(lightweightCliPath) : lightweightCliPath,
		inheritedHookIdentityEnvironment,
		runGeneratedCommand(command: string): unknown {
			const stdout = execFileSync("/bin/sh", ["-c", command], {
				env: inheritedHookIdentityEnvironment,
				encoding: "utf8",
			});
			return JSON.parse(stdout);
		},
	};
}

describe("buildKanbanManagedKimiHooksToml", () => {
	it("恰好保留当前全部 11 种原生事件与 10 秒超时", () => {
		const configuration = kimiHookConfigurationSchema.parse(parseToml(buildKanbanManagedKimiHooksToml()));
		expect(configuration.hooks.map(({ event, timeout }) => ({ event, timeout }))).toEqual(
			EXPECTED_KIMI_HOOK_EVENT_MAPPINGS.map(([event]) => ({ event, timeout: 10 })),
		);
	});

	it.skipIf(process.platform === "win32").each(EXPECTED_KIMI_HOOK_EVENT_MAPPINGS)(
		"%s → %s 经 TOML／shell 往返后使用轻量入口并保留身份",
		(kimiEvent, kanbanEvent) => {
			const installation = createIsolatedKimiHookCommandRecordingInstallation();
			const configuration = kimiHookConfigurationSchema.parse(parseToml(buildKanbanManagedKimiHooksToml()));
			const hook = configuration.hooks.find(({ event }) => event === kimiEvent);
			if (!hook) throw new Error(`缺少 Kimi hook：${kimiEvent}`);
			expect(installation.runGeneratedCommand(hook.command)).toEqual({
				entrypoint: installation.lightweightCliPath,
				argumentsList: ["hooks", "ingest", "--event", kanbanEvent, "--source", "kimi"],
				taskId: installation.inheritedHookIdentityEnvironment.KANBAN_HOOK_TASK_ID,
				workspaceId: installation.inheritedHookIdentityEnvironment.KANBAN_HOOK_WORKSPACE_ID,
				hostSocketPath: installation.inheritedHookIdentityEnvironment.KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH,
				hostedSessionKey:
					installation.inheritedHookIdentityEnvironment.KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY,
			});
		},
	);

	it.skipIf(process.platform === "win32")("旧安装缺少轻量产物时仍能执行完整入口，且 hooks 不重复", () => {
		const installation = createIsolatedKimiHookCommandRecordingInstallation(false);
		const configuration = kimiHookConfigurationSchema.parse(parseToml(buildKanbanManagedKimiHooksToml()));
		const hook = configuration.hooks.find(({ event }) => event === "Interrupt");
		if (!hook) throw new Error("缺少 Kimi Interrupt hook");
		expect(installation.runGeneratedCommand(hook.command)).toMatchObject({
			entrypoint: installation.fullCliPath,
			argumentsList: ["hooks", "ingest", "--event", "to_review", "--source", "kimi"],
		});
	});
});
