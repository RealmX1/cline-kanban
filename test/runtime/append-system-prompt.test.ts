import { describe, expect, it } from "vitest";

import {
	combineAppendSystemPrompts,
	renderAppendSystemPrompt,
	resolveAppendSystemPromptCommandPrefix,
	resolveHomeAgentAppendSystemPrompt,
	resolveTaskSessionAppendSystemPrompt,
} from "../../src/prompts/append-system-prompt";

describe("resolveAppendSystemPromptCommandPrefix", () => {
	it("returns npx prefix for npx transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/Users/example/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("npx -y kanban");
	});

	it("returns bun x prefix for bun x transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("bun x kanban");
	});

	it("falls back to the current runnable invocation for local entrypoints", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js'");
	});

	it("falls back to the current runnable invocation when realpath resolution fails", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/tmp/missing-kanban-cli.js"],
			resolveRealPath: () => {
				throw new Error("missing");
			},
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/tmp/missing-kanban-cli.js'");
	});
});

describe("renderAppendSystemPrompt", () => {
	it("renders Kanban sidebar guidance and command reference", () => {
		const rendered = renderAppendSystemPrompt("kanban");
		expect(rendered).toContain("Kanban sidebar agent");
		expect(rendered).toContain("kanban task create");
		expect(rendered).toContain("kanban task done");
		expect(rendered).toContain("kanban task delete");
		expect(rendered).toContain("--column backlog|in_progress|review|done");
		expect(rendered).toContain("Default follows the runtime Settings default");
		expect(rendered).not.toContain("`--start-in-plan-mode <true|false>` optional. Default false.");
		expect(rendered).toContain("Provide exactly one of");
		expect(rendered).toContain("task delete --column done");
		expect(rendered).toContain("kanban task get --task-id <task_id>");
		expect(rendered).toContain("kanban task link");
		expect(rendered).toContain("If a task command fails because the runtime is unavailable");
		expect(rendered).toContain("If the user asks for GitHub work");
		expect(rendered).toContain("gh issue view");
		expect(rendered).toContain("If the user references Linear");
		expect(rendered).toContain("Current home agent: `unknown`");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
	});

	it("renders only the active-agent Linear MCP guidance when an agent is provided", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentId: "codex",
		});

		expect(rendered).toContain("Current home agent: `codex`");
		expect(rendered).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});
});

describe("resolveHomeAgentAppendSystemPrompt", () => {
	it("returns null for non-home task sessions", () => {
		expect(resolveHomeAgentAppendSystemPrompt("task-1")).toBeNull();
	});

	it("returns the appended prompt for current home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Kanban sidebar agent");
		expect(prompt).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task list");
		expect(prompt).toContain("Current home agent: `codex`");
		expect(prompt).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(prompt).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
	});

	it("returns active-agent guidance for droid home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:droid", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `droid`");
		expect(prompt).toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("returns active-agent guidance for kiro home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:kiro", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `kiro`");
		expect(prompt).toContain("kiro-cli mcp add --name linear --url https://mcp.linear.app/mcp --scope global");
		expect(prompt).not.toContain("--scope user");
	});
});

describe("resolveTaskSessionAppendSystemPrompt", () => {
	it("injects a task workspace guard for non-home task sessions", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/tmp/worktrees/task-1/repo");
		expect(prompt).toContain("Kanban-managed task session");
		expect(prompt).toContain("`/tmp/worktrees/task-1/repo`");
		expect(prompt).toContain("ask the user to confirm which workspace owns the work");
	});

	it("allows derived same-repository worktrees created by task tooling without asking", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/tmp/worktrees/task-1/repo");
		expect(prompt).toContain("derived from this workspace");
		expect(prompt).toContain("git worktree add");
		expect(prompt).toContain("git rev-parse --git-common-dir");
		expect(prompt).toContain("without stopping to ask");
		expect(prompt).not.toContain("assigned workspace/branch only");
	});

	it("treats a user-invoked workflow as pre-authorized for the checkouts its procedure operates on", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/tmp/worktrees/task-1/repo");
		expect(prompt).toContain("Workflows the user explicitly invoked");
		expect(prompt).toContain("base-branch-sync");
		expect(prompt).toContain("the invocation itself authorizes");
	});

	it("teaches how to resolve the task back from a worktree directory", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/tmp/worktrees/task-1/repo", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain(".cline/worktrees/<task_id>/<repo_folder>");
		expect(prompt).toContain(
			`'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task get --task-id 'task-1' --project-path "$(dirname "$(git rev-parse --git-common-dir)")"`,
		);
		// 另一种输入形态：别人递来一个 worktree 路径字符串，而不是 agent 自己就在那个 worktree 里。
		expect(prompt).toContain("~/.cline/worktrees/ab12c/my-repo");
		expect(prompt).toContain("never at a task worktree");
	});

	// 自己的 task ID 必须来自调用方已持有的真值，不能靠 cwd 反推：派生 worktree 与 inplace 任务的
	// workspace 路径里根本没有 `worktrees/<task_id>` 段，反推会静默算出一个看似合法的错误 ID。
	it("states the caller-known task ID instead of deriving it from the current directory", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/Users/example/repo", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("You are running as Kanban task `task-1`");
		expect(prompt).toContain("never re-derive it from your current directory");
		expect(prompt).not.toContain("git rev-parse --show-toplevel");
		expect(prompt).not.toContain("basename");
	});

	// `--project-path` 的推导仍需一条 git 命令，但不得只教 POSIX 命令替换：Windows 默认 shell 没有
	// `$(...)`/`basename`/`dirname`。
	it("gives a non-POSIX shell fallback for deriving the main repository path", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/tmp/worktrees/task-1/repo");
		expect(prompt).toContain("on PowerShell or cmd");
		expect(prompt).toContain("git rev-parse --git-common-dir");
	});

	it("does not inject a task workspace guard for home sidebar sessions", () => {
		expect(resolveTaskSessionAppendSystemPrompt("__home_agent__:workspace-1:codex", "/tmp/repo")).toBeNull();
	});
});

describe("combineAppendSystemPrompts", () => {
	it("joins only non-empty prompts", () => {
		expect(combineAppendSystemPrompts("first", null, "  ", "second")).toBe("first\n\nsecond");
	});
});
