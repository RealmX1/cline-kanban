import { describe, expect, it } from "vitest";

import {
	extractAgentShellToolInnerCommandFromWrapperCommandLine,
	PROCESS_COMMAND_LINE_TEXT_MAXIMUM_JOURNALED_CHARACTER_COUNT,
	redactSecretShapedSubstringsInCommandLineText,
	summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided,
	summarizeProcessCommandLineForDiagnosticJournal,
} from "../../../src/diagnostics/process-command-line-text-truncation-and-secret-redaction";

// 各 harness 根进程的 argv 形态，按 src/terminal/agent-session-adapters.ts 实际拼出的参数顺序构造。
// 两段标记文本都不是「形态可识别的密钥」，脱敏正则拦不住——只能靠整段参数不落盘。
const TASK_PROMPT_TEXT = "请修复登录页 TASK-PROMPT-BODY-MUST-NOT-BE-JOURNALED 测试账号密码是 hunter2";
const KANBAN_APPENDED_SYSTEM_PROMPT_PS_TEXT =
	"# Kanban Task Workspace\\012\\012Prefer Linear MCP tools. SYSTEM-PROMPT-BODY-MUST-NOT-BE-JOURNALED";
const AGENT_HARNESS_ROOT_COMMAND_LINES_BY_HARNESS_SHAPE: ReadonlyArray<[string, string, string]> = [
	[
		"Claude（--append-system-prompt + 位置 task prompt）",
		`claude --model default --settings /Users/u/.cline/kanban/hooks/claude/settings.json --append-system-prompt ${KANBAN_APPENDED_SYSTEM_PROMPT_PS_TEXT} ${TASK_PROMPT_TEXT}`,
		"claude",
	],
	["Claude（无注入系统提示词，只剩位置 task prompt）", `claude --model default ${TASK_PROMPT_TEXT}`, "claude"],
	[
		"Codex（-c developer_instructions=… + 位置 task prompt）",
		`/opt/homebrew/Caskroom/codex/0.159.3/bin/codex -c features.worktrees=false --dangerously-bypass-approvals-and-sandbox -c developer_instructions="# Kanban Task Workspace\\n\\nPrefer Linear MCP tools. SYSTEM-PROMPT-BODY-MUST-NOT-BE-JOURNALED" -c hooks.enabled=true ${TASK_PROMPT_TEXT}`,
		"codex",
	],
	[
		"oh-my-pi（新会话把 task prompt 作为最后一个位置参数）",
		`omp --approval-mode yolo --config /Users/u/.cline/kanban/hooks/omp/launch-config/ab12c.yml --extension /Users/u/.cline/kanban/hooks/omp/native-session-identity.ts ${TASK_PROMPT_TEXT}`,
		"omp",
	],
	[
		"oh-my-pi（dev launcher exec 成 bun）",
		`bun --preload /Users/u/oh-my-pi/packages/coding-agent/scripts/omp.ts /Users/u/oh-my-pi/packages/coding-agent/src/cli.ts --approval-mode yolo ${TASK_PROMPT_TEXT}`,
		"bun",
	],
	["OpenCode（--prompt）", `opencode --model anthropic/claude-sonnet-4-5 --prompt ${TASK_PROMPT_TEXT}`, "opencode"],
];

describe("redactSecretShapedSubstringsInCommandLineText", () => {
	it.each([
		[
			"curl -H 'Authorization: Bearer abc.def-ghi_123' https://x.test",
			"curl -H 'Authorization: Bearer [REDACTED]' https://x.test",
		],
		["OPENAI_API_KEY=sk-proj-abcdefghijk npm run x", "OPENAI_API_KEY=[REDACTED] npm run x"],
		["export GITHUB_TOKEN=abc123 && gh pr list", "export GITHUB_TOKEN=[REDACTED] && gh pr list"],
		["gh auth login --with-token ghp_abcdefghijklmnopqrstuvwx", "gh auth login --with-token [REDACTED]"],
		["git clone https://someone:s3cret@github.com/a/b.git", "git clone https://[REDACTED]@github.com/a/b.git"],
		["mysql --password=hunter2 -u root", "mysql --password=[REDACTED] -u root"],
		["mytool --api-key abcdef123456 run", "mytool --api-key [REDACTED] run"],
		["curl 'https://api.x.test/v1?access_token=abc&x=1'", "curl 'https://api.x.test/v1?access_token=[REDACTED]&x=1'"],
		["node call.js sk-ant-api03-abcdefghijklmnop", "node call.js [REDACTED]"],
		["slack post xoxb-1234-5678-abcdef", "slack post [REDACTED]"],
		["aws s3 ls # AKIAABCDEFGHIJKLMNOP", "aws s3 ls # [REDACTED]"],
	])("redacts the secret-shaped part of %s", (commandLine, expected) => {
		expect(redactSecretShapedSubstringsInCommandLineText(commandLine)).toBe(expected);
	});

	it("leaves an ordinary development command untouched so the analysis keeps its full resolution", () => {
		const commandLine = "npm run test:guarded -- --project precommit-safe test/runtime/foo.test.ts";
		expect(redactSecretShapedSubstringsInCommandLineText(commandLine)).toBe(commandLine);
	});
});

describe("summarizeProcessCommandLineForDiagnosticJournal", () => {
	it("keeps a short command verbatim and reports it as untruncated", () => {
		expect(summarizeProcessCommandLineForDiagnosticJournal("git status --short")).toEqual({
			commandLineTextForJournal: "git status --short",
			originalCommandLineCharacterCount: 18,
			commandLineTextWasTruncated: false,
		});
	});

	it("collapses newlines and runs of whitespace so one journal line stays one line", () => {
		expect(
			summarizeProcessCommandLineForDiagnosticJournal("python3 -  <<'EOF'\nimport os\n\tprint(1)\nEOF"),
		).toMatchObject({
			commandLineTextForJournal: "python3 - <<'EOF' import os print(1) EOF",
		});
	});

	it("truncates an oversized command line to the journal budget, ellipsis included", () => {
		const hugeArgv = `node /repo/scripts/generate.js --input ${"x".repeat(144_000)}`;
		const summary = summarizeProcessCommandLineForDiagnosticJournal(hugeArgv);

		expect(summary.commandLineTextForJournal).toHaveLength(
			PROCESS_COMMAND_LINE_TEXT_MAXIMUM_JOURNALED_CHARACTER_COUNT,
		);
		expect(summary.commandLineTextForJournal.startsWith("node /repo/scripts/generate.js --input xxx")).toBe(true);
		expect(summary.commandLineTextForJournal.endsWith("…")).toBe(true);
		expect(summary.commandLineTextWasTruncated).toBe(true);
		expect(summary.originalCommandLineCharacterCount).toBe(hugeArgv.length);
	});

	it("drops the injected system prompt from a harness argv, keeping only its size, and decodes ps octal escapes", () => {
		const harnessArgv =
			"claude --model default --settings /Users/u/.cline/kanban/hooks/claude/settings.json --append-system-prompt # Kanban Task Workspace\\012\\012This is a Kanban-managed task session. Prompt body…";

		expect(summarizeProcessCommandLineForDiagnosticJournal(harnessArgv).commandLineTextForJournal).toBe(
			"claude --model default --settings /Users/u/.cline/kanban/hooks/claude/settings.json --append-system-prompt [系统提示词已省略 76 字符]",
		);
	});

	it("redacts before truncating so a secret straddling the cut can never leak its visible half", () => {
		const commandLine = `${"a".repeat(230)} GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz`;
		const summary = summarizeProcessCommandLineForDiagnosticJournal(commandLine);

		expect(summary.commandLineTextForJournal).not.toContain("abcdefgh");
	});
});

describe("summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided", () => {
	it.each(AGENT_HARNESS_ROOT_COMMAND_LINES_BY_HARNESS_SHAPE)(
		"keeps only the executable name and the argument size for %s",
		(_harnessShape, harnessRootCommandLine, expectedExecutableBasename) => {
			const summary = summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided(harnessRootCommandLine);
			const executableToken = harnessRootCommandLine.split(" ")[0] ?? "";
			const argumentCharacterCount = harnessRootCommandLine.length - executableToken.length - 1;

			expect(summary).toEqual({
				commandLineTextForJournal: `${expectedExecutableBasename} [harness 参数已省略 ${argumentCharacterCount} 字符]`,
				originalCommandLineCharacterCount: harnessRootCommandLine.length,
				commandLineTextWasTruncated: true,
			});
			expect(summary.commandLineTextForJournal).not.toContain("MUST-NOT-BE-JOURNALED");
			expect(summary.commandLineTextForJournal).not.toContain("登录页");
		},
	);

	it("never journals the executable's directory, only its basename", () => {
		expect(
			summarizeAgentHarnessProcessCommandLineWithAllArgumentsElided("/Users/u/.local/bin/claude")
				.commandLineTextForJournal,
		).toBe("claude");
	});
});

describe("extractAgentShellToolInnerCommandFromWrapperCommandLine", () => {
	it("recovers the command the agent actually asked to run from Claude Code's shell-snapshot wrapper", () => {
		const wrapper =
			"/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1790731867128-tzi24o.sh 2>/dev/null || true && " +
			"setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; " +
			"\\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd ~/x; grep -o '\"'\"'a|b'\"'\"' f' " +
			"< /dev/null && pwd -P >| /tmp/claude-1a2b-cwd";

		expect(extractAgentShellToolInnerCommandFromWrapperCommandLine(wrapper)).toBe("cd ~/x; grep -o 'a|b' f");
	});

	it("decodes the octal newline escapes that ps shows for multi-line tool commands", () => {
		const wrapper =
			"/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && " +
			"eval 'python3 - <<'\"'\"'EOF'\"'\"'\\012print(1)\\012EOF' < /dev/null && pwd -P >| /tmp/claude-9-cwd";

		expect(extractAgentShellToolInnerCommandFromWrapperCommandLine(wrapper)).toBe("python3 - <<'EOF'\nprint(1)\nEOF");
	});

	it("unwraps a plain `shell -c` / `shell -lc` invocation such as the ones Codex spawns", () => {
		expect(extractAgentShellToolInnerCommandFromWrapperCommandLine("/bin/zsh -lc npm run build")).toBe(
			"npm run build",
		);
		expect(extractAgentShellToolInnerCommandFromWrapperCommandLine("bash -c git status")).toBe("git status");
	});

	it("returns null for a process that is not a shell wrapper", () => {
		expect(extractAgentShellToolInnerCommandFromWrapperCommandLine("node /x/server.js --port 3000")).toBeNull();
	});
});
