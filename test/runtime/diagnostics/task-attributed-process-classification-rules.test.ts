import { describe, expect, it } from "vitest";

import {
	classifyTaskAttributedProcess,
	deriveMcpServerInstanceLabelFromBranchHeadCommandLine,
	processCommandLineCarriesAgentHarnessPromptArguments,
	processCommandLineServesAsAgentHarnessRootArgumentTailReference,
	type TaskAttributedProcessClassificationInput,
} from "../../../src/diagnostics/task-attributed-process-classification-rules";

// 用例取自 2026-09-30 本任务现场进程树（claude 根 pid 68861）的真实命令形态。
const CLAUDE_ROOT_COMMAND = "claude --allow-dangerously-skip-permissions --permission-mode plan --model default";
const HARNESS_ROOT_PROCESS_GROUP_ID = 68861;

function classifyUnderClaudeHarness(
	overrides: Partial<TaskAttributedProcessClassificationInput>,
): ReturnType<typeof classifyTaskAttributedProcess> {
	return classifyTaskAttributedProcess({
		rootProcessRole: "agent_harness_root",
		rootProcessGroupId: HARNESS_ROOT_PROCESS_GROUP_ID,
		processIsAttributionRoot: false,
		processCommandLine: null,
		branchHeadProcessGroupId: HARNESS_ROOT_PROCESS_GROUP_ID,
		branchHeadCommandLine: null,
		...overrides,
	});
}

describe("classifyTaskAttributedProcess under an agent harness root", () => {
	it("classifies the session root itself as the harness root", () => {
		expect(
			classifyUnderClaudeHarness({ processIsAttributionRoot: true, processCommandLine: CLAUDE_ROOT_COMMAND }),
		).toBe("agent_harness_root_process");
	});

	it("tells an MCP launcher wrapper apart from the MCP server it spawned", () => {
		const branchHeadCommandLine = "npm exec @upstash/context7-mcp";
		expect(classifyUnderClaudeHarness({ branchHeadCommandLine, processCommandLine: branchHeadCommandLine })).toBe(
			"mcp_server_launcher_wrapper_process",
		);
		expect(
			classifyUnderClaudeHarness({
				branchHeadCommandLine,
				processCommandLine: "node /Users/u/.npm/_npx/eea2bd/node_modules/.bin/context7-mcp",
			}),
		).toBe("mcp_server_process");
	});

	it("counts a language server that an MCP server spawned in its own process group as part of that MCP", () => {
		expect(
			classifyUnderClaudeHarness({
				branchHeadCommandLine:
					"/Users/u/.local/bin/uv tool uvx --from git+https://github.com/oraios/serena serena start-mcp-server",
				processCommandLine:
					"node /Users/u/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server --stdio",
			}),
		).toBe("mcp_server_process");
	});

	it("classifies a same-process-group child that is not an MCP server as a harness helper", () => {
		expect(
			classifyUnderClaudeHarness({
				branchHeadCommandLine: "caffeinate -i -t 300",
				processCommandLine: "caffeinate -i -t 300",
			}),
		).toBe("agent_harness_helper_process");
	});

	it("classifies the setsid'd Bash tool shell and everything under it as an agent command", () => {
		const branchHeadCommandLine =
			"/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'npm run build' < /dev/null && pwd -P >| /tmp/claude-1-cwd";
		expect(
			classifyUnderClaudeHarness({
				branchHeadProcessGroupId: 4120,
				branchHeadCommandLine,
				processCommandLine: branchHeadCommandLine,
			}),
		).toBe("agent_shell_tool_command_process");
		expect(
			classifyUnderClaudeHarness({
				branchHeadProcessGroupId: 4120,
				branchHeadCommandLine,
				processCommandLine: "node /repo/node_modules/.bin/vite build",
			}),
		).toBe("agent_shell_tool_command_process");
	});

	it("recognizes the Kanban hook CLI even though it also runs in its own process group", () => {
		const hookCommandLine =
			"/Users/u/.nvm/versions/node/v24.12.0/bin/node /Users/u/.nvm/versions/node/v24.12.0/bin/kanban hooks ingest --event activity --source claude";
		expect(
			classifyUnderClaudeHarness({
				branchHeadProcessGroupId: 3052,
				branchHeadCommandLine: hookCommandLine,
				processCommandLine: hookCommandLine,
			}),
		).toBe("kanban_hook_cli_process");
	});

	it("recognizes a nested headless harness run anywhere in the tree", () => {
		expect(
			classifyUnderClaudeHarness({
				branchHeadProcessGroupId: 7000,
				branchHeadCommandLine: "/bin/zsh -c claude -p 'review this'",
				processCommandLine: "claude -p review this --output-format json",
			}),
		).toBe("nested_agent_harness_process");
	});

	it("falls back to a harness helper for a separate-group child that is not a shell, such as Codex's code mode host", () => {
		expect(
			classifyUnderClaudeHarness({
				branchHeadProcessGroupId: 59888,
				branchHeadCommandLine: "/opt/homebrew/Caskroom/codex/0.158.0/bin/codex-code-mode-host",
				processCommandLine: "/opt/homebrew/Caskroom/codex/0.158.0/bin/codex-code-mode-host",
			}),
		).toBe("agent_harness_helper_process");
	});

	it("still classifies a process whose command line could not be read, using its branch", () => {
		expect(
			classifyUnderClaudeHarness({
				branchHeadCommandLine: "npm exec claude-historian-mcp",
				processCommandLine: null,
			}),
		).toBe("mcp_server_process");
	});
});

describe("classifyTaskAttributedProcess under other root roles", () => {
	it("splits a user shell terminal into its root and the dev servers it runs", () => {
		const base = {
			rootProcessRole: "user_shell_terminal_root" as const,
			rootProcessGroupId: 500,
			branchHeadProcessGroupId: 510,
			branchHeadCommandLine: "npm run dev",
		};
		expect(
			classifyTaskAttributedProcess({ ...base, processIsAttributionRoot: true, processCommandLine: "/bin/zsh -i" }),
		).toBe("user_shell_terminal_root_process");
		expect(
			classifyTaskAttributedProcess({ ...base, processIsAttributionRoot: false, processCommandLine: "node vite" }),
		).toBe("user_shell_terminal_descendant_process");
	});

	it("classifies a Kanban-spawned process found through its working directory", () => {
		expect(
			classifyTaskAttributedProcess({
				rootProcessRole: "kanban_runtime_spawned_task_process_root",
				rootProcessGroupId: 800,
				processIsAttributionRoot: true,
				processCommandLine: "/bin/zsh -c npm test",
				branchHeadProcessGroupId: 800,
				branchHeadCommandLine: "/bin/zsh -c npm test",
			}),
		).toBe("kanban_runtime_spawned_task_process");
	});
});

describe("deriveMcpServerInstanceLabelFromBranchHeadCommandLine", () => {
	it.each([
		["npm exec @upstash/context7-mcp", "@upstash/context7-mcp"],
		["npx -y @playwright/mcp@latest", "@playwright/mcp@latest"],
		[
			"/Users/u/.local/bin/uv tool uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide",
			"serena",
		],
		["uvx mcp-server-fetch", "mcp-server-fetch"],
		["node /Users/u/.hermes/node/bin/codegraph serve --mcp", "codegraph"],
		["/usr/local/bin/gitnexus mcp", "gitnexus"],
	])("labels %s as %s", (branchHeadCommandLine, expectedLabel) => {
		expect(deriveMcpServerInstanceLabelFromBranchHeadCommandLine(branchHeadCommandLine)).toBe(expectedLabel);
	});
});

describe("processCommandLineCarriesAgentHarnessPromptArguments", () => {
	const TASK_PROMPT_TEXT = "请修复登录页 TASK-PROMPT-BODY-MUST-NOT-BE-JOURNALED";
	// npm 装的 codex 是 node 包装脚本：根进程是 node，真正的 codex 是它的子进程，argv 末尾原样带着根的全部参数。
	const CODEX_NODE_WRAPPER_ROOT_COMMAND = `node /opt/homebrew/bin/codex -c developer_instructions="Prefer Linear MCP tools." ${TASK_PROMPT_TEXT}`;
	const CODEX_NATIVE_CHILD_COMMAND = `/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex -c developer_instructions="Prefer Linear MCP tools." ${TASK_PROMPT_TEXT}`;
	// gemini 会带着更大的堆参数把自己重启成子进程。
	const GEMINI_ROOT_COMMAND = `node /opt/homebrew/bin/gemini --yolo -i ${TASK_PROMPT_TEXT}`;
	const GEMINI_RELAUNCHED_CHILD_COMMAND = `/opt/homebrew/opt/node/bin/node --max-old-space-size=8192 /opt/homebrew/bin/gemini --yolo -i ${TASK_PROMPT_TEXT}`;

	it.each([
		["agent_harness_root_process", `claude --model default ${TASK_PROMPT_TEXT}`],
		["nested_agent_harness_process", `claude -p ${TASK_PROMPT_TEXT} --output-format json`],
	] as const)("always treats a %s's arguments as prompt-bearing", (processClassification, processCommandLine) => {
		expect(
			processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification,
				processCommandLine,
				agentHarnessRootCommandLine: null,
			}),
		).toBe(true);
	});

	it("catches the real harness that a node wrapper re-executed, even when the MCP wording in its prompt got it classified as an MCP server", () => {
		expect(
			processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification: "mcp_server_process",
				processCommandLine: CODEX_NATIVE_CHILD_COMMAND,
				agentHarnessRootCommandLine: CODEX_NODE_WRAPPER_ROOT_COMMAND,
			}),
		).toBe(true);
		expect(
			processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification: "agent_harness_helper_process",
				processCommandLine: GEMINI_RELAUNCHED_CHILD_COMMAND,
				agentHarnessRootCommandLine: GEMINI_ROOT_COMMAND,
			}),
		).toBe(true);
	});

	it("leaves ordinary helpers and MCP servers that do not echo the harness arguments alone", () => {
		expect(
			processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification: "mcp_server_process",
				processCommandLine: "node /Users/u/.npm/_npx/eea2bd/node_modules/.bin/context7-mcp",
				agentHarnessRootCommandLine: CODEX_NODE_WRAPPER_ROOT_COMMAND,
			}),
		).toBe(false);
		expect(
			processCommandLineCarriesAgentHarnessPromptArguments({
				processClassification: "agent_harness_helper_process",
				processCommandLine: "/opt/homebrew/Caskroom/codex/0.158.0/bin/codex-code-mode-host",
				agentHarnessRootCommandLine: "/opt/homebrew/Caskroom/codex/0.158.0/bin/codex",
			}),
		).toBe(false);
	});

	it("never elides agent shell commands or hook CLI runs, even if their text happens to end like the harness arguments", () => {
		for (const processClassification of ["agent_shell_tool_command_process", "kanban_hook_cli_process"] as const) {
			expect(
				processCommandLineCarriesAgentHarnessPromptArguments({
					processClassification,
					processCommandLine: "git rebase --continue",
					agentHarnessRootCommandLine: "claude --continue",
				}),
			).toBe(false);
		}
	});

	// Kanban 带 --skip-shutdown-cleanup 重启后，旧会话的 harness 被 launchd 收养（ppid=1），只能靠 env 里的 KANBAN_*
	// 找回：分类只剩 orphaned_process_recovered_by_kanban_environment_variables，也没有会话根的 argv 可比对。
	// 命令形态按 src/core/agent-catalog.ts 的可执行文件名与各 adapter 实际拼出的参数构造。
	describe("for a pre-restart orphan recovered only through its Kanban env", () => {
		const ORPHAN_CLASSIFICATION = "orphaned_process_recovered_by_kanban_environment_variables" as const;
		const CODEX_DEVELOPER_INSTRUCTIONS_ARGUMENT =
			'-c developer_instructions="# Kanban Task Workspace\\n\\nPrefer Linear MCP tools. SYSTEM-PROMPT-BODY-MUST-NOT-BE-JOURNALED"';

		it.each([
			[
				"Homebrew cask 装的原生 codex（-c developer_instructions= + 位置 prompt）",
				`/opt/homebrew/Caskroom/codex/0.159.3/bin/codex -c check_for_update_on_startup=false ${CODEX_DEVELOPER_INSTRUCTIONS_ARGUMENT} ${TASK_PROMPT_TEXT}`,
			],
			["npm 装的 codex node 包装脚本", CODEX_NODE_WRAPPER_ROOT_COMMAND],
			[
				"oh-my-pi（位置 prompt）",
				`omp --approval-mode yolo --config /Users/u/.cline/kanban/hooks/omp/launch-config/ab12c.yml ${TASK_PROMPT_TEXT}`,
			],
			[
				"oh-my-pi dev launcher exec 成 bun（preload 垫片以 harness 命名）",
				`bun --preload /Users/u/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/oh-my-pi/packages/coding-agent/src/cli.ts --approval-mode yolo ${TASK_PROMPT_TEXT}`,
			],
			["OpenCode（--prompt）", `opencode --model anthropic/claude-sonnet-4-5 --prompt ${TASK_PROMPT_TEXT}`],
			[
				"cursor-agent 包装脚本 exec -a 保留了 argv[0]",
				`/Users/u/.local/bin/cursor-agent --use-system-ca /Users/u/.local/share/cursor-agent/versions/2026.09.30/index.js --force ${TASK_PROMPT_TEXT}`,
			],
			["gemini 带堆参数重启出来的自身", GEMINI_RELAUNCHED_CHILD_COMMAND],
			["agent 用 Bash 工具起的嵌套 headless harness", `/bin/zsh -c claude -p ${TASK_PROMPT_TEXT}`],
		])("elides %s by recognizing the harness program itself", (_harnessShape, processCommandLine) => {
			expect(
				processCommandLineCarriesAgentHarnessPromptArguments({
					processClassification: ORPHAN_CLASSIFICATION,
					processCommandLine,
					agentHarnessRootCommandLine: null,
				}),
			).toBe(true);
		});

		it("elides a re-executed child whose own executable name is not a harness but that echoes the recovered root's argument tail", () => {
			expect(
				processCommandLineCarriesAgentHarnessPromptArguments({
					processClassification: ORPHAN_CLASSIFICATION,
					// 旧版 @openai/codex npm 包的 vendor 二进制按平台命名，文件名不是 `codex`。
					processCommandLine: `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex-aarch64-apple-darwin -c developer_instructions="Prefer Linear MCP tools." ${TASK_PROMPT_TEXT}`,
					agentHarnessRootCommandLine: CODEX_NODE_WRAPPER_ROOT_COMMAND,
				}),
			).toBe(true);
		});

		it.each([
			"node /Users/u/repo/node_modules/.bin/vite --port 5173",
			"sleep 300",
			"node /Users/u/repo/node_modules/.bin/vitest run test/runtime/foo.test.ts",
			"/bin/zsh -lc npm run dev",
			"npm exec @upstash/context7-mcp",
			"/opt/homebrew/Caskroom/codex/0.159.2/bin/codex-code-mode-host",
		])("keeps truncation + redaction for the ordinary orphaned command %s", (processCommandLine) => {
			for (const agentHarnessRootCommandLine of [null, CODEX_NODE_WRAPPER_ROOT_COMMAND]) {
				expect(
					processCommandLineCarriesAgentHarnessPromptArguments({
						processClassification: ORPHAN_CLASSIFICATION,
						processCommandLine,
						agentHarnessRootCommandLine,
					}),
				).toBe(false);
			}
		});
	});
});

describe("processCommandLineServesAsAgentHarnessRootArgumentTailReference", () => {
	const CODEX_ROOT_COMMAND = 'codex -c developer_instructions="Prefer Linear MCP tools." 请修复登录页';

	it("uses a live session's harness root as the reference, as before", () => {
		expect(
			processCommandLineServesAsAgentHarnessRootArgumentTailReference({
				processClassification: "agent_harness_root_process",
				processIsAttributionRoot: true,
				processCommandLine: CODEX_ROOT_COMMAND,
			}),
		).toBe(true);
	});

	it("uses an env-recovered orphan head as the reference only when it is itself a harness", () => {
		const orphanHead = {
			processClassification: "orphaned_process_recovered_by_kanban_environment_variables" as const,
			processIsAttributionRoot: true,
		};
		expect(
			processCommandLineServesAsAgentHarnessRootArgumentTailReference({
				...orphanHead,
				processCommandLine: CODEX_ROOT_COMMAND,
			}),
		).toBe(true);
		// 普通命令孤儿头的参数尾不是 harness 参数：拿它当基准会把回显它的子进程（npx → node …）误省略。
		expect(
			processCommandLineServesAsAgentHarnessRootArgumentTailReference({
				...orphanHead,
				processCommandLine: "npx vitest run test/runtime/foo.test.ts",
			}),
		).toBe(false);
		expect(
			processCommandLineServesAsAgentHarnessRootArgumentTailReference({
				...orphanHead,
				processIsAttributionRoot: false,
				processCommandLine: CODEX_ROOT_COMMAND,
			}),
		).toBe(false);
	});
});
