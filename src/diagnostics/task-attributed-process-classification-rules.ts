// 按 task 归因后的进程分类规则（纯函数）。回答的是「这个进程在这个 task 的资源账上属于哪一类」。
//
// 判据来自 2026-09-30 的现场进程树，而不是 harness 文档：
//   - MCP server 与 harness 根进程**同 pgid**（Claude 用 stdio 拉起它们，不另起会话）；`npm exec` /
//     `uvx` 这类启动器是一层 wrapper，真正的 server 是它的子进程，二者合起来才是一个 MCP 实例；
//     MCP 自己再拉起的语言服务器（serena → tsserver）会另起 pgid，但成本仍算在该 MCP 实例上；
//   - Bash 工具的命令外壳是 harness 的直接子进程，但**已 setsid**（独立 pgid、无控制终端）——这正是
//     `kill(-rootPid)` 杀不到它们、会话退出后可能残留的原因；
//   - `kanban hooks` CLI 也是独立 pgid 的直接子进程，必须先于「独立 pgid ⇒ 命令」这条规则识别。
//
// 分类以「分支头」为单位：分支头 = 从根进程到该进程路径上、根的那个直接子进程。一个分支下的所有
// 后代继承分支头的类别（命令起的 vite、MCP 起的 LSP 都记在各自分支头的账上），只有两类例外会被
// 就地识别：kanban hook CLI 与嵌套 harness（`claude -p` 等）。

import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";

export type TaskAttributedProcessClassification =
	| "agent_harness_root_process"
	| "mcp_server_launcher_wrapper_process"
	| "mcp_server_process"
	| "agent_harness_helper_process"
	| "agent_shell_tool_command_process"
	| "kanban_hook_cli_process"
	| "nested_agent_harness_process"
	| "user_shell_terminal_root_process"
	| "user_shell_terminal_descendant_process"
	| "kanban_runtime_spawned_task_process"
	// Kanban 重启前就已被 launchd 收养、只能靠 env 里的 KANBAN_TASK_ID 找回归属的进程：原本属于哪一类
	// 已无从得知（进程树上的分支头早已不在），如实单列。
	| "orphaned_process_recovered_by_kanban_environment_variables";

export type TaskResourceUsageAttributionRootProcessRole =
	// 会话 summary 上的 pid 是一个 agent harness（PTY 里的 claude / codex …，或 ACP 子进程）。
	| "agent_harness_root"
	// 会话 summary 上的 pid 是 Kanban 为卡片详情 / 首页开的用户 shell。
	| "user_shell_terminal_root"
	// Kanban 运行时的直接子进程，只能靠 cwd 落在某个 task worktree 里归因（Cline SDK run_commands 等）。
	| "kanban_runtime_spawned_task_process_root";

export interface TaskAttributedProcessClassificationInput {
	rootProcessRole: TaskResourceUsageAttributionRootProcessRole;
	rootProcessGroupId: number;
	processIsAttributionRoot: boolean;
	// argv 读不到（进程在补读前已退出）时为 null：此时只能按分支头归类。
	processCommandLine: string | null;
	branchHeadProcessGroupId: number;
	branchHeadCommandLine: string | null;
}

const KANBAN_HOOK_CLI_COMMAND_LINE_PATTERN = /(?:^|[\s/])kanban(?:\.js)?\s+hooks\s|\/dist\/cli\.js\s+hooks\s/;
const NESTED_AGENT_HARNESS_COMMAND_LINE_PATTERN =
	/(?:^|[\s/])claude\s(?:.*\s)?(?:-p|--print)(?:\s|$)|(?:^|[\s/])codex\s+exec(?:\s|$)/;
const SHELL_DASH_C_INVOCATION_COMMAND_LINE_PATTERN = /^(?:\S*\/)?(?:sh|bash|zsh|dash|fish)\s+-l?c\s/;
const MCP_SERVER_LAUNCHER_WRAPPER_COMMAND_LINE_PATTERN =
	/^(?:\S*\/)?(?:npx|bunx|uvx)(?:\s|$)|^(?:\S*\/)?(?:npm|pnpm|yarn)\s+(?:exec|dlx)(?:\s|$)|^(?:\S*\/)?uv\s+(?:tool\s+(?:run|uvx)|run)(?:\s|$)/;
const MCP_SERVER_COMMAND_LINE_PATTERN = /mcp/i;

export function isKanbanHookCliCommandLine(commandLine: string): boolean {
	return KANBAN_HOOK_CLI_COMMAND_LINE_PATTERN.test(commandLine);
}

function isNestedAgentHarnessCommandLine(commandLine: string): boolean {
	return NESTED_AGENT_HARNESS_COMMAND_LINE_PATTERN.test(commandLine);
}

function isMcpServerLauncherWrapperCommandLine(commandLine: string): boolean {
	return MCP_SERVER_LAUNCHER_WRAPPER_COMMAND_LINE_PATTERN.test(commandLine);
}

function isMcpServerBranchHeadCommandLine(commandLine: string): boolean {
	return isMcpServerLauncherWrapperCommandLine(commandLine) || MCP_SERVER_COMMAND_LINE_PATTERN.test(commandLine);
}

export function classifyTaskAttributedProcess(
	input: TaskAttributedProcessClassificationInput,
): TaskAttributedProcessClassification {
	const { processCommandLine, branchHeadCommandLine } = input;
	switch (input.rootProcessRole) {
		case "user_shell_terminal_root":
			return input.processIsAttributionRoot
				? "user_shell_terminal_root_process"
				: "user_shell_terminal_descendant_process";
		case "kanban_runtime_spawned_task_process_root":
			return processCommandLine !== null && isNestedAgentHarnessCommandLine(processCommandLine)
				? "nested_agent_harness_process"
				: "kanban_runtime_spawned_task_process";
		case "agent_harness_root":
			break;
	}
	if (input.processIsAttributionRoot) {
		return "agent_harness_root_process";
	}
	if (processCommandLine !== null && isKanbanHookCliCommandLine(processCommandLine)) {
		return "kanban_hook_cli_process";
	}
	if (processCommandLine !== null && isNestedAgentHarnessCommandLine(processCommandLine)) {
		return "nested_agent_harness_process";
	}
	if (branchHeadCommandLine !== null && isKanbanHookCliCommandLine(branchHeadCommandLine)) {
		return "kanban_hook_cli_process";
	}
	if (input.branchHeadProcessGroupId === input.rootProcessGroupId) {
		if (branchHeadCommandLine !== null && isMcpServerBranchHeadCommandLine(branchHeadCommandLine)) {
			const processIsTheLauncherWrapperItself =
				processCommandLine !== null &&
				processCommandLine === branchHeadCommandLine &&
				isMcpServerLauncherWrapperCommandLine(branchHeadCommandLine);
			return processIsTheLauncherWrapperItself ? "mcp_server_launcher_wrapper_process" : "mcp_server_process";
		}
		return "agent_harness_helper_process";
	}
	if (branchHeadCommandLine !== null && SHELL_DASH_C_INVOCATION_COMMAND_LINE_PATTERN.test(branchHeadCommandLine)) {
		return "agent_shell_tool_command_process";
	}
	return "agent_harness_helper_process";
}

// harness 根进程 argv 去掉「程序本身」之后的参数尾：直接起的二进制去掉 argv[0]；经脚本运行时起的根
// （`node …/bin/codex`、`bun --preload … cli.ts`）再去掉运行时自己的选项与它后面的第一个非选项（脚本路径）。
const AGENT_HARNESS_ROOT_BINARY_PROGRAM_PREFIX_PATTERN = /^\s*\S+\s+/;
const AGENT_HARNESS_ROOT_SCRIPT_RUNTIME_PROGRAM_PREFIX_PATTERN = /^\s*\S+(?:\s+-\S*)*\s+\S+\s+/;

function extractAgentHarnessRootArgumentTail(agentHarnessRootCommandLine: string): string | null {
	const executableBasename = basenameOfPathToken(/^\s*(\S*)/.exec(agentHarnessRootCommandLine)?.[1] ?? "");
	const programPrefixMatch = (
		SCRIPT_RUNTIME_EXECUTABLE_BASENAMES.has(executableBasename)
			? AGENT_HARNESS_ROOT_SCRIPT_RUNTIME_PROGRAM_PREFIX_PATTERN
			: AGENT_HARNESS_ROOT_BINARY_PROGRAM_PREFIX_PATTERN
	).exec(agentHarnessRootCommandLine);
	if (!programPrefixMatch) {
		return null;
	}
	const argumentTail = agentHarnessRootCommandLine.slice(programPrefixMatch[0].length).trimEnd();
	return argumentTail.length > 0 ? argumentTail : null;
}

// npm / Homebrew 装的 codex、opencode 是 node 包装脚本，gemini 会带着更大的堆参数把自己重启一遍：真正的 harness
// 是根的同组子进程，argv 末尾原样带着根的全部参数（含 prompt）。它们的分类并不可靠——注入的系统提示词里有
// 「MCP」字样，会让这个子进程命中 MCP 判据——所以按「是否回显根的参数尾」认，不按分类认。
function commandLineEchoesAgentHarnessRootArgumentTail(
	processCommandLine: string,
	agentHarnessRootCommandLine: string,
): boolean {
	const argumentTail = extractAgentHarnessRootArgumentTail(agentHarnessRootCommandLine);
	if (argumentTail === null) {
		return false;
	}
	const trimmedProcessCommandLine = processCommandLine.trimEnd();
	const argumentTailStartIndex = trimmedProcessCommandLine.length - argumentTail.length;
	return (
		argumentTailStartIndex > 0 &&
		trimmedProcessCommandLine.endsWith(argumentTail) &&
		/\s/.test(trimmedProcessCommandLine.charAt(argumentTailStartIndex - 1))
	);
}

// Kanban 实际起 harness 用的可执行文件名：PTY 通道与 ACP 通道都直接取 catalog 的 binary（agent-registry.ts /
// acp-agent-launch-catalog.ts），adapter 不改写它。暂未开放启动的 harness（opencode / gemini）也在内：旧版本起过的
// 会话照样可能留下孤儿。
const KANBAN_CATALOG_AGENT_HARNESS_EXECUTABLE_BASENAMES: ReadonlySet<string> = new Set(
	RUNTIME_AGENT_CATALOG.map((catalogEntry) => catalogEntry.binary),
);
// 命令行开头的「可执行文件 + 若干选项 + 第一个非选项」。只扫开头而不切整条 argv：harness 根的 argv 可达上百 KB。
const LAUNCHED_EXECUTABLE_AND_FIRST_NON_OPTION_TOKEN_PATTERN = /^\s*(\S+)(?:\s+-\S*)*(?:\s+(\S+))?/;
const SCRIPT_FILE_NAME_EXTENSION_PATTERN = /\.(?:[cm]?[jt]s|py)$/;

// 进程跑的是哪个程序：直接起的二进制取可执行文件名；经脚本运行时起的（shebang 展开后的 `node …/bin/codex`、
// `node --max-old-space-size=… …/bin/gemini`）取运行时选项之后第一个非选项的文件名（去掉脚本扩展名）。
// omp 的 dev launcher exec 成 `bun --preload …/scripts/omp.ts …/src/cli.ts`，第一个非选项正是以 harness 命名的
// preload 垫片；cursor-agent 的包装脚本用 `exec -a "$0"` 保留了 argv[0]，直接按可执行文件名就能认出。
function deriveLaunchedProgramBasenameFromCommandLine(commandLine: string): string | null {
	const leadingTokensMatch = LAUNCHED_EXECUTABLE_AND_FIRST_NON_OPTION_TOKEN_PATTERN.exec(commandLine);
	const executableToken = leadingTokensMatch?.[1];
	if (executableToken === undefined) {
		return null;
	}
	const executableBasename = basenameOfPathToken(executableToken);
	const scriptToken = leadingTokensMatch?.[2];
	if (!SCRIPT_RUNTIME_EXECUTABLE_BASENAMES.has(executableBasename) || scriptToken === undefined) {
		return executableBasename;
	}
	return basenameOfPathToken(scriptToken).replace(SCRIPT_FILE_NAME_EXTENSION_PATTERN, "");
}

// 没有会话根可依时，只凭命令行本身认「这就是一个 agent harness」：跑的程序是 catalog 里的 harness，
// 或命中嵌套 harness 判据（`claude -p` / `codex exec`，与会话树里「任何位置都单独识别」的口径一致）。
function commandLineLaunchesKanbanCatalogOrNestedAgentHarness(commandLine: string): boolean {
	const launchedProgramBasename = deriveLaunchedProgramBasenameFromCommandLine(commandLine);
	return (
		(launchedProgramBasename !== null &&
			KANBAN_CATALOG_AGENT_HARNESS_EXECUTABLE_BASENAMES.has(launchedProgramBasename)) ||
		isNestedAgentHarnessCommandLine(commandLine)
	);
}

export interface AgentHarnessRootArgumentTailReferenceEligibilityInput {
	processClassification: TaskAttributedProcessClassification;
	// 该进程就是它所在归因组的根（会话根 / env 找回的孤儿头）。
	processIsAttributionRoot: boolean;
	processCommandLine: string;
}

// 这个进程的 argv 能否充当同组进程「是否回显 harness 参数尾」的比对基准（即下面的 agentHarnessRootCommandLine）。
// 会话树的 harness 根凭分类即可；Kanban 重启前就被收养、只能靠 env 找回的孤儿头分类只剩「残留进程」，
// 只有它本身认得出是 harness 时才算——普通命令孤儿头（`npx vitest …`）的参数尾不是 harness 参数，拿它当基准
// 会把回显它的子进程（`node …/vitest …`）误省略。
export function processCommandLineServesAsAgentHarnessRootArgumentTailReference(
	input: AgentHarnessRootArgumentTailReferenceEligibilityInput,
): boolean {
	switch (input.processClassification) {
		case "agent_harness_root_process":
			return true;
		case "orphaned_process_recovered_by_kanban_environment_variables":
			return (
				input.processIsAttributionRoot &&
				commandLineLaunchesKanbanCatalogOrNestedAgentHarness(input.processCommandLine)
			);
		default:
			return false;
	}
}

export interface AgentHarnessPromptArgumentsDetectionInput {
	processClassification: TaskAttributedProcessClassification;
	processCommandLine: string;
	// 该进程所属归因组的根能充当比对基准时（见 processCommandLineServesAsAgentHarnessRootArgumentTailReference），
	// 根的 argv；其余归因根（用户 shell / Kanban 子进程 / 普通命令孤儿头）为 null。
	agentHarnessRootCommandLine: string | null;
}

function processCommandLineEchoesItsAgentHarnessRootArgumentTail(
	input: AgentHarnessPromptArgumentsDetectionInput,
): boolean {
	return (
		input.agentHarnessRootCommandLine !== null &&
		commandLineEchoesAgentHarnessRootArgumentTail(input.processCommandLine, input.agentHarnessRootCommandLine)
	);
}

// 这个进程的 argv 是否装着 agent harness 的 task prompt / 注入的系统提示词——是则只能记可执行文件名 + 字符数，
// 参数一律不落盘。harness 根与嵌套 harness 凭分类即可认定；包装脚本 re-exec 出来的真正 harness 按回显根的参数认。
// agent 跑的命令与 hook CLI 永远不算：它们的「截断 + 脱敏」是用户选定的分析粒度，必须保持不变。
// Kanban 重启后经 env 找回的孤儿没有可用的分类：本身认得出是 harness 的（孤儿头或树里任何位置）直接省略，
// 其余按回显孤儿头参数尾认；dev server、sleep、vitest 这类普通命令孤儿两条都不命中，照旧截断 + 脱敏。
export function processCommandLineCarriesAgentHarnessPromptArguments(
	input: AgentHarnessPromptArgumentsDetectionInput,
): boolean {
	switch (input.processClassification) {
		case "agent_harness_root_process":
		case "nested_agent_harness_process":
			return true;
		case "agent_shell_tool_command_process":
		case "kanban_hook_cli_process":
			return false;
		case "orphaned_process_recovered_by_kanban_environment_variables":
			return (
				commandLineLaunchesKanbanCatalogOrNestedAgentHarness(input.processCommandLine) ||
				processCommandLineEchoesItsAgentHarnessRootArgumentTail(input)
			);
		default:
			return processCommandLineEchoesItsAgentHarnessRootArgumentTail(input);
	}
}

function basenameOfPathToken(pathToken: string): string {
	const segments = pathToken.split("/");
	return segments[segments.length - 1] ?? pathToken;
}

function firstPositionalToken(tokens: readonly string[], flagsTakingAValue: ReadonlySet<string>): string | null {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (flagsTakingAValue.has(token)) {
			index++;
			continue;
		}
		if (!token.startsWith("-")) {
			return token;
		}
	}
	return null;
}

const LAUNCHER_FLAGS_TAKING_A_VALUE = new Set(["--from", "--with", "--python", "-p", "--package", "--registry"]);
const SCRIPT_RUNTIME_EXECUTABLE_BASENAMES = new Set(["node", "bun", "deno", "python", "python3"]);

// MCP 实例的可读名（report 按它把各会话里的同一个 MCP 聚在一起）。按启动器的参数习惯取「包名 /
// 脚本名」，认不出就退回可执行文件名。
export function deriveMcpServerInstanceLabelFromBranchHeadCommandLine(branchHeadCommandLine: string): string {
	const tokens = branchHeadCommandLine.trim().split(/\s+/);
	const executableBasename = basenameOfPathToken(tokens[0] ?? "");
	let argumentTokens = tokens.slice(1);
	if (["npm", "pnpm", "yarn"].includes(executableBasename) && ["exec", "dlx"].includes(argumentTokens[0] ?? "")) {
		argumentTokens = argumentTokens.slice(1);
	} else if (executableBasename === "uv" && argumentTokens[0] === "tool") {
		argumentTokens = argumentTokens.slice(2);
	} else if (executableBasename === "uv" && argumentTokens[0] === "run") {
		argumentTokens = argumentTokens.slice(1);
	} else if (SCRIPT_RUNTIME_EXECUTABLE_BASENAMES.has(executableBasename)) {
		const scriptToken = firstPositionalToken(argumentTokens, new Set());
		return scriptToken === null ? executableBasename : basenameOfPathToken(scriptToken);
	} else if (!["npx", "bunx", "uvx", "uv"].includes(executableBasename)) {
		return executableBasename;
	}
	return firstPositionalToken(argumentTokens, LAUNCHER_FLAGS_TAKING_A_VALUE) ?? executableBasename;
}
