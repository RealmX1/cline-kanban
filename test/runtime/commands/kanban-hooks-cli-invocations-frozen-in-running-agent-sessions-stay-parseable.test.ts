// 跨版本契约：hook 命令行冻结在存活的 agent 会话里，而每次 hook 调用跑的是盘上最新的 dist。
//
// 热重启之后会话不再随部署重开：一条几天前起的 Claude 会话仍在用它启动时读到的 settings 里的命令行，
// 新 build 的 `kanban hooks …` 必须照旧解析它们。所以 `kanban hooks` 的子命令、flag、事件名，以及 spawn 时
// 注入、hook 进程读取的环境变量名，**只增不改不删**。
//
// 下表录自 2026-10-05 各 harness 的 prepareAgentLaunch 实际生成物（临时 HOME 下跑一遍、从 args / env / 盘上
// hook 配置里抽出 `hooks` 之后的 argv）。只许追加：删掉或改动某一条，就等于宣布那些仍在跑的会话的 hook 失效。
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
	AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
} from "../../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { registerHooksCommand } from "../../../src/commands/hooks";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "../../../src/terminal/hook-runtime-context";

const KANBAN_HOOKS_CLI_ARGV_FROZEN_IN_RUNNING_AGENT_SESSIONS: ReadonlyArray<{
	generatedBy: string;
	hooksArgv: readonly string[];
}> = [
	// Claude：~/.cline/kanban/hooks/claude/settings-<sha12>.json（2026-10-05 之前是 settings.json）
	{ generatedBy: "claude settings", hooksArgv: ["ingest", "--event", "activity", "--source", "claude"] },
	{
		generatedBy: "claude settings",
		hooksArgv: ["ingest", "--event", "agent_conversation_session_identity_observed", "--source", "claude"],
	},
	{
		generatedBy: "claude settings",
		hooksArgv: ["ingest", "--event", "main_agent_conversation_context_compaction_completed", "--source", "claude"],
	},
	{ generatedBy: "claude settings", hooksArgv: ["ingest", "--event", "to_in_progress", "--source", "claude"] },
	{ generatedBy: "claude settings", hooksArgv: ["ingest", "--event", "to_review", "--source", "claude"] },
	// Codex：`-c hooks.<Event>=[…command="…"…]` 启动参数
	{ generatedBy: "codex -c hooks", hooksArgv: ["codex-hook", "--event", "activity", "--source", "codex"] },
	{
		generatedBy: "codex -c hooks",
		hooksArgv: ["codex-hook", "--event", "agent_conversation_session_identity_observed", "--source", "codex"],
	},
	{
		generatedBy: "codex -c hooks",
		hooksArgv: ["codex-hook", "--event", "main_agent_conversation_context_compaction_completed", "--source", "codex"],
	},
	{ generatedBy: "codex -c hooks", hooksArgv: ["codex-hook", "--event", "to_in_progress", "--source", "codex"] },
	{ generatedBy: "codex -c hooks", hooksArgv: ["codex-hook", "--event", "to_review", "--source", "codex"] },
	// 长驻的 codex wrapper（内存里跑启动时的旧 bundle）在后台拉起 notify，带全部元数据 flag。
	{ generatedBy: "codex wrapper", hooksArgv: ["codex-wrapper", "--real-binary", "/usr/local/bin/codex"] },
	{
		generatedBy: "codex wrapper session watcher / gemini hook background notify",
		hooksArgv: [
			"notify",
			"--event",
			"to_review",
			"--source",
			"codex",
			"--activity-text",
			"Final: done",
			"--tool-name",
			"shell",
			"--final-message",
			"done",
			"--hook-event-name",
			"Stop",
			"--notification-type",
			"idle_prompt",
		],
	},
	// Gemini：~/.cline/kanban/hooks/gemini/settings-<sha12>.json
	{ generatedBy: "gemini settings", hooksArgv: ["gemini-hook"] },
	// Kimi：seeded ~/.cline/kanban/hooks/kimi/code-home/config.toml 的 [[hooks]]
	{ generatedBy: "kimi config.toml", hooksArgv: ["ingest", "--event", "activity", "--source", "kimi"] },
	{
		generatedBy: "kimi config.toml",
		hooksArgv: ["ingest", "--event", "agent_conversation_session_identity_observed", "--source", "kimi"],
	},
	{
		generatedBy: "kimi config.toml",
		hooksArgv: ["ingest", "--event", "main_agent_conversation_context_compaction_completed", "--source", "kimi"],
	},
	{ generatedBy: "kimi config.toml", hooksArgv: ["ingest", "--event", "to_in_progress", "--source", "kimi"] },
	{ generatedBy: "kimi config.toml", hooksArgv: ["ingest", "--event", "to_review", "--source", "kimi"] },
	// OpenCode：~/.cline/kanban/hooks/opencode/kanban-<sha12>.js 插件
	{ generatedBy: "opencode plugin", hooksArgv: ["ingest", "--event", "activity", "--source", "opencode"] },
	{
		generatedBy: "opencode plugin",
		hooksArgv: ["ingest", "--event", "to_review", "--source", "opencode", "--metadata-base64", "e30="],
	},
	{ generatedBy: "opencode plugin", hooksArgv: ["ingest", "--event", "to_in_progress", "--source", "opencode"] },
	// Droid：~/.cline/kanban/hooks/droid/settings-<sha12>.json
	{ generatedBy: "droid settings", hooksArgv: ["notify", "--event", "activity", "--source", "droid"] },
	{ generatedBy: "droid settings", hooksArgv: ["notify", "--event", "to_in_progress", "--source", "droid"] },
	{ generatedBy: "droid settings", hooksArgv: ["notify", "--event", "to_review", "--source", "droid"] },
	// Kiro：~/.kiro/agents/kanban.json
	{
		generatedBy: "kiro agent config",
		hooksArgv: ["ingest", "--event", "activity", "--source", "kiro", "--hook-event-name", "postToolUse"],
	},
	{
		generatedBy: "kiro agent config",
		hooksArgv: ["ingest", "--event", "to_in_progress", "--source", "kiro", "--hook-event-name", "agentSpawn"],
	},
	{
		generatedBy: "kiro agent config",
		hooksArgv: [
			"ingest",
			"--event",
			"to_review",
			"--source",
			"kiro",
			"--activity-text",
			"Waiting for review",
			"--hook-event-name",
			"stop",
		],
	},
];

// spawn 时注入、hook / CLI 进程读取的环境变量名：存活会话的环境里冻结着它们。
const KANBAN_ENVIRONMENT_VARIABLE_NAMES_FROZEN_IN_RUNNING_AGENT_SESSIONS = [
	"KANBAN_HOOK_TASK_ID",
	"KANBAN_HOOK_WORKSPACE_ID",
	"KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH",
	"KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY",
] as const;

function findRegisteredHooksSubcommand(subcommandName: string): Command | undefined {
	const program = new Command();
	program.exitOverride();
	registerHooksCommand(program);
	return program.commands
		.find((command) => command.name() === "hooks")
		?.commands.find((command) => command.name() === subcommandName);
}

describe("kanban hooks invocations frozen in running agent sessions", () => {
	it.each(KANBAN_HOOKS_CLI_ARGV_FROZEN_IN_RUNNING_AGENT_SESSIONS)(
		"still parses $generatedBy: $hooksArgv",
		({ hooksArgv }) => {
			const [subcommandName = "", ...subcommandArguments] = hooksArgv;
			const subcommand = findRegisteredHooksSubcommand(subcommandName);
			expect(subcommand, `kanban hooks ${subcommandName} is no longer registered`).toBeDefined();
			subcommand?.exitOverride();
			// parseOptions 只解析、不执行 action；--event 的取值经 parseHookEvent 校验，事件名被删会在这里抛出。
			const parsed = subcommand?.parseOptions(subcommandArguments);
			expect(parsed?.unknown, "flags no longer recognized").toEqual([]);
		},
	);

	it("keeps reading the environment variable names injected into running agent sessions", () => {
		expect([
			KANBAN_HOOK_TASK_ID_ENV,
			KANBAN_HOOK_WORKSPACE_ID_ENV,
			AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
			AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
		]).toEqual([...KANBAN_ENVIRONMENT_VARIABLE_NAMES_FROZEN_IN_RUNNING_AGENT_SESSIONS]);
	});
});
