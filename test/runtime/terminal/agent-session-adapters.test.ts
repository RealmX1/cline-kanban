import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { agentRendersTranscriptInline, KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID } from "../../../src/core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("agentRendersTranscriptInline", () => {
	// This predicate is the single source of truth coupling two behaviors: codexAdapter forces
	// --no-alt-screen (transcript rendered into scrollback) and session-manager therefore must NOT
	// suppress CSI 3 J for it. If a second agent ever becomes inline, add it here AND wire both sites.
	it("marks only Codex as an inline-transcript agent", () => {
		expect(agentRendersTranscriptInline("codex")).toBe(true);
	});

	it("treats every non-Codex agent as alt-screen (not inline)", () => {
		const nonInlineAgents: RuntimeAgentId[] = ["claude", "gemini", "opencode", "droid", "kiro", "cline", "cursor"];
		for (const agentId of nonInlineAgents) {
			expect(agentRendersTranscriptInline(agentId)).toBe(false);
		}
	});
});

describe("cursorAdapter", () => {
	it("uses the Kanban Cursor default model instead of Cursor Agent's raw fast default", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-default-model",
			agentId: "cursor" as RuntimeAgentId,
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp/repo",
			prompt: "Implement the feature",
			terminalAgentModelOverrideSettings: undefined,
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe(KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID);
		expect(launch.args).not.toContain("composer-2.5-fast");
	});

	it("uses an explicit Cursor model override when present", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-explicit-model",
			agentId: "cursor" as RuntimeAgentId,
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp/repo",
			prompt: "Implement the feature",
			terminalAgentModelOverrideSettings: { agentId: "cursor", modelId: "auto" },
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe("auto");
	});
});

describe("prepareAgentLaunch hook strategies", () => {
	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=8");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(homedir(), ".cline", "kanban", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("registers a dedicated Claude PreToolUse matcher routing ExitPlanMode/AskUserQuestion to review (Stage 5)", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-stage5-hooks",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsIndex = launch.args.indexOf("--settings");
		expect(settingsIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsIndex + 1];
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
		};

		const preToolUse = settings.hooks.PreToolUse;
		expect(preToolUse).toHaveLength(2);
		// 专用 matcher 必须排在兜底 *（activity）之前，且路由到 to_review。
		expect(preToolUse[0].matcher).toBe("ExitPlanMode|AskUserQuestion");
		expect(preToolUse[0].hooks[0].command).toContain("--event");
		expect(preToolUse[0].hooks[0].command).toContain("to_review");
		expect(preToolUse[1].matcher).toBe("*");
		expect(preToolUse[1].hooks[0].command).toContain("activity");
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban sidebar agent");
		expect(developerInstructions[0]).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("adds task workspace guard instructions to Codex developer instructions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-worktree-guard",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/worktrees/task-1/repo",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban-managed task session");
		expect(developerInstructions[0]).toContain("`/tmp/worktrees/task-1/repo`");
		expect(developerInstructions[0]).toContain("ask the user to confirm which workspace owns the work");
	});

	it("launches Codex without alternate screen so terminal scrollback keeps session history", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-inline-history",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args).toContain("--no-alt-screen");
	});

	it("launches Claude without alternate screen so terminal scrollback keeps session history", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-inline-history",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("1");
		expect(launch.env.FORCE_HYPERLINK).toBe("1");
	});

	it("passes Claude task prompts as startup argv", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-deferred-prompt",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the task",
		});

		expect(launch.args).toContain("Implement the task");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("does not replay the saved Claude task prompt when resuming a task", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-resume",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Original task prompt",
			resumeFromTrash: true,
		});

		expect(launch.args).toContain("--continue");
		expect(launch.args).not.toContain("Original task prompt");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("appends task workspace guard instructions for Claude task sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-worktree-guard",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/worktrees/task-1/repo",
			prompt: "Implement the task",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		const appendedPrompt = launch.args[appendPromptIndex + 1];
		expect(appendedPrompt).toContain("Kanban-managed task session");
		expect(appendedPrompt).toContain("`/tmp/worktrees/task-1/repo`");
		expect(appendedPrompt).toContain("ask the user to confirm which workspace owns the work");
	});

	it("exposes a Claude prompt-ready detector and inspection predicate", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-prompt-detector",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the task",
		});

		expect(typeof launch.detectOutputTransition).toBe("function");
		expect(typeof launch.shouldInspectOutputForTransition).toBe("function");

		const attentionSummary: RuntimeTaskSessionSummary = {
			taskId: "task-claude-prompt-detector",
			state: "awaiting_review",
			agentId: "claude",
			workspacePath: "/tmp",
			pid: 1,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "attention",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		};

		const promptReady = launch.detectOutputTransition?.("╭──────────────────────╮", attentionSummary) ?? null;
		expect(promptReady).toEqual({ type: "agent.prompt-ready" });

		const noEvent = launch.detectOutputTransition?.("Loading hooks…", attentionSummary) ?? null;
		expect(noEvent).toBeNull();

		const runningSummary: RuntimeTaskSessionSummary = {
			...attentionSummary,
			state: "running",
			reviewReason: null,
		};
		const ignoredWhileRunning = launch.detectOutputTransition?.("╭──────────────────────╮", runningSummary) ?? null;
		expect(ignoredWhileRunning).toBeNull();

		expect(launch.shouldInspectOutputForTransition?.(attentionSummary)).toBe(true);
		expect(launch.shouldInspectOutputForTransition?.(runningSummary)).toBe(false);
	});

	it("does not flip Claude back to running when reviewReason is 'hook' and the input box re-renders", async () => {
		// 回归测试 RVF G1-002：Stop / Notification hook 把 session 推到
		// awaiting_review(reviewReason='hook')，Claude TUI 后续随便一次重绘都
		// 会渲染输入框边框 / 启动横幅。如果 claudePromptDetector 在 'hook' 下
		// 也接受 prompt-ready，那么状态会被立刻翻回 running，"等待审查" 的语义
		// 就丢失了。修复后 detector 应只在 reviewReason === "attention" 下放行。
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-hook-redraw",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the task",
		});

		const hookSummary: RuntimeTaskSessionSummary = {
			taskId: "task-claude-hook-redraw",
			state: "awaiting_review",
			agentId: "claude",
			workspacePath: "/tmp",
			pid: 1,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: Date.now(),
			latestHookActivity: null,
		};

		// 输入框边框出现在每次 TUI 重绘里 — 不应该在 hook 状态触发 prompt-ready。
		const borderEvent = launch.detectOutputTransition?.("╭──────────────────────╮", hookSummary) ?? null;
		expect(borderEvent).toBeNull();
		const bottomBorderEvent = launch.detectOutputTransition?.("╰──────────────────────╯", hookSummary) ?? null;
		expect(bottomBorderEvent).toBeNull();
		// 启动横幅同理 — Claude TUI 重启 / 重绘时仍可能出现 "Claude Code"。
		const bannerEvent = launch.detectOutputTransition?.("Claude Code v1.2.3", hookSummary) ?? null;
		expect(bannerEvent).toBeNull();

		// shouldInspectClaudeOutputForTransition 必须与 detector 保持一致，
		// 在 hook 下不需要解码输出去探测转移。
		expect(launch.shouldInspectOutputForTransition?.(hookSummary)).toBe(false);
	});

	it("采信显式 facet：exited（进程已退仍等人审）的 attention 会话仍探测 prompt-ready", async () => {
		// Stage 3：detector 门控从 legacy `state==="awaiting_review"` 翻为 facet 真相源
		// isAwaitingUserReviewTurn。本例显式带 facet（turnOwner=user/liveness=exited），验证：
		//   ① 被直接采信（不回退 legacy 派生）；
		//   ② exited 与 live 折叠为同一「等人审」分支（live↔exited 不敏感，无 distinction ② 偷渡）——
		//      进程已退但仍 reviewReason==="attention" 的会话照旧探测 prompt-ready。
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-exited-attention",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the task",
		});

		const exitedAttentionSummary: RuntimeTaskSessionSummary = {
			taskId: "task-claude-exited-attention",
			state: "awaiting_review",
			agentId: "claude",
			workspacePath: "/tmp",
			pid: null,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			reviewReason: "attention",
			exitCode: 0,
			lastHookAt: null,
			latestHookActivity: null,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "needs_input",
		};

		const promptReady = launch.detectOutputTransition?.("╭──────────────────────╮", exitedAttentionSummary) ?? null;
		expect(promptReady).toEqual({ type: "agent.prompt-ready" });
		expect(launch.shouldInspectOutputForTransition?.(exitedAttentionSummary)).toBe(true);
	});

	it("does not duplicate an explicit Codex no-alt-screen flag", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-explicit-inline-history",
			agentId: "codex",
			binary: "codex",
			args: ["--no-alt-screen"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args.filter((arg) => arg === "--no-alt-screen")).toHaveLength(1);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("forks Codex when parentSessionId is provided", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fork",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "do the thing",
			parentSessionId: "11111111-2222-3333-4444-555555555555",
		});

		const forkIndex = launch.args.indexOf("fork");
		expect(forkIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[forkIndex + 1]).toBe("11111111-2222-3333-4444-555555555555");
		const cwdIndex = launch.args.indexOf("-C");
		expect(cwdIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[cwdIndex + 1]).toBe("/tmp");
		expect(cwdIndex).toBeLessThan(forkIndex);
		const promptIndex = launch.args.indexOf("do the thing");
		expect(promptIndex).toBeGreaterThan(forkIndex);
		expect(launch.args).not.toContain("resume");
		expect(launch.args).not.toContain("--last");
		// Config flags must precede the subcommand.
		const noAltIndex = launch.args.indexOf("--no-alt-screen");
		expect(noAltIndex).toBeGreaterThanOrEqual(0);
		expect(noAltIndex).toBeLessThan(forkIndex);
	});

	it("preserves explicit Codex working directory when parentSessionId is provided", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fork-explicit-cwd",
			agentId: "codex",
			binary: "codex",
			args: ["--cd", "/explicit"],
			cwd: "/tmp",
			prompt: "",
			parentSessionId: "11111111-2222-3333-4444-555555555555",
		});

		expect(launch.args.filter((arg) => arg === "-C")).toHaveLength(0);
		expect(launch.args).toContain("--cd");
		expect(launch.args[launch.args.indexOf("--cd") + 1]).toBe("/explicit");
		expect(launch.args).toContain("fork");
	});

	it("prefers resume over parent fork when both parentSessionId and resumeFromTrash are set", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fork-vs-resume",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			parentSessionId: "11111111-2222-3333-4444-555555555555",
			resumeFromTrash: true,
		});

		expect(launch.args).not.toContain("fork");
		expect(launch.args).not.toContain("11111111-2222-3333-4444-555555555555");
		expect(launch.args).toContain("resume");
		expect(launch.args).toContain("--last");
	});

	it("ignores a non-UUID parentSessionId on Codex", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-bad-parent",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			parentSessionId: "not-a-uuid",
		});

		expect(launch.args).not.toContain("fork");
		expect(launch.args).not.toContain("not-a-uuid");
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
	});

	it("writes Gemini settings with AfterTool mapped to to_in_progress", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		const hookScriptPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "gemini-hook.mjs");
		expect(existsSync(hookScriptPath)).toBe(false);
	});

	it("writes OpenCode plugin with root-session filtering and permission hooks", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const pluginPath = join(homedir(), ".cline", "kanban", "hooks", "opencode", "kanban.js");
		const plugin = readFileSync(pluginPath, "utf8");
		expect(plugin).toContain("parentID");
		expect(plugin).toContain('"permission.ask"');
		expect(plugin).toContain('"tool.execute.before"');
		expect(plugin).toContain('"tool.execute.after"');
		expect(plugin).toContain("session.status");
		expect(plugin).toContain("message.part.updated");
		expect(plugin).toContain("last_assistant_message");
		expect(plugin).toContain("--metadata-base64");
		expect(plugin).toContain('if (kind === "review")');
		expect(plugin).toContain('currentState = "idle"');
	});

	it("loads OpenCode preferred model from LOCALAPPDATA state and auth paths", async () => {
		const homePath = setupTempHome();
		const localAppDataPath = join(homePath, "AppData", "Local");
		process.env.LOCALAPPDATA = localAppDataPath;

		const statePath = join(localAppDataPath, "opencode", "state");
		mkdirSync(statePath, { recursive: true });
		writeFileSync(
			join(statePath, "model.json"),
			JSON.stringify(
				{
					recent: [
						{ providerID: "anthropic", modelID: "claude-3-7-sonnet" },
						{ providerID: "openai", modelID: "gpt-4o" },
					],
				},
				null,
				2,
			),
			"utf8",
		);

		const authPath = join(localAppDataPath, "opencode");
		mkdirSync(authPath, { recursive: true });
		writeFileSync(
			join(authPath, "auth.json"),
			JSON.stringify(
				{
					openai: { key: "sk-test" },
				},
				null,
				2,
			),
			"utf8",
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-model",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe("openai/gpt-4o");
	});

	it("writes Droid settings with hook transitions and runtime autonomy mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const settingsArgIndex = launch.args.indexOf("--settings");
		expect(settingsArgIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsArgIndex + 1];
		expect(settingsPath).toBeDefined();

		const settings = JSON.parse(readFileSync(settingsPath ?? "", "utf8")) as {
			autonomyMode?: string;
			hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("activity");
		expect(settings.hooks?.Notification?.[1]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const preToolInProgressHook = settings.hooks?.PreToolUse?.find(
			(hook) => hook.matcher === "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create",
		);
		expect(preToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		const preToolReviewHook = settings.hooks?.PreToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(preToolReviewHook?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const postToolInProgressHook = settings.hooks?.PostToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(postToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("to_in_progress");
	});

	it("writes Kiro agent hooks and uses a Kanban-managed soft planning prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kiro-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Investigate deployment drift",
			startInPlanMode: true,
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-kiro-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).toContain("--agent");
		expect(launch.args[launch.args.indexOf("--agent") + 1]).toBe("kanban");
		expect(launch.args).toContain("--trust-all-tools");
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Do not modify files");
		expect(initialPrompt).toContain("Task:\nInvestigate deployment drift");

		const configPath = join(homedir(), ".kiro", "agents", "kanban.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			tools?: string[];
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.tools).toEqual(["*"]);
		expect(config.hooks?.agentSpawn?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.userPromptSubmit?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.preToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.preToolUse?.[1]?.command).toContain("to_in_progress");
		expect(config.hooks?.postToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("writes Cline hook scripts and injects --hooks-dir", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "cline");
		const notificationHookPath =
			process.platform === "win32" ? join(hooksDir, "Notification.ps1") : join(hooksDir, "Notification");
		const taskCompleteHookPath =
			process.platform === "win32" ? join(hooksDir, "TaskComplete.ps1") : join(hooksDir, "TaskComplete");
		const userPromptSubmitHookPath =
			process.platform === "win32" ? join(hooksDir, "UserPromptSubmit.ps1") : join(hooksDir, "UserPromptSubmit");
		const preToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PreToolUse.ps1") : join(hooksDir, "PreToolUse");
		const postToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PostToolUse.ps1") : join(hooksDir, "PostToolUse");

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const hooksDirArgIndex = launch.args.indexOf("--hooks-dir");
		expect(hooksDirArgIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[hooksDirArgIndex + 1]).toBe(hooksDir);

		expect(existsSync(notificationHookPath)).toBe(true);
		expect(existsSync(taskCompleteHookPath)).toBe(true);
		expect(existsSync(userPromptSubmitHookPath)).toBe(true);
		expect(existsSync(preToolUseHookPath)).toBe(true);
		expect(existsSync(postToolUseHookPath)).toBe(true);

		const notificationScript = readFileSync(notificationHookPath, "utf8");
		expect(notificationScript).toContain("hooks");
		expect(notificationScript).toContain("to_review");
		expect(notificationScript).toContain("user_attention");
		expect(notificationScript).toContain("completion_result");
		expect(notificationScript).toContain('{"cancel":false}');

		const taskCompleteScript = readFileSync(taskCompleteHookPath, "utf8");
		expect(taskCompleteScript).toContain("hooks");
		expect(taskCompleteScript).toContain("to_review");
		expect(taskCompleteScript).toContain('{"cancel":false}');

		const userPromptSubmitScript = readFileSync(userPromptSubmitHookPath, "utf8");
		expect(userPromptSubmitScript).toContain("hooks");
		expect(userPromptSubmitScript).toContain("to_in_progress");
		expect(userPromptSubmitScript).toContain('{"cancel":false}');

		const preToolUseScript = readFileSync(preToolUseHookPath, "utf8");
		expect(preToolUseScript).toContain("hooks");
		expect(preToolUseScript).toContain("activity");
		expect(preToolUseScript).toContain("to_in_progress");
		expect(preToolUseScript).toContain("to_review");
		expect(preToolUseScript).toContain("ask_followup_question");
		expect(preToolUseScript).toContain("plan_mode_respond");

		const postToolUseScript = readFileSync(postToolUseHookPath, "utf8");
		expect(postToolUseScript).toContain("hooks");
		expect(postToolUseScript).toContain("activity");
		expect(postToolUseScript).toContain("to_in_progress");
		expect(postToolUseScript).toContain("ask_followup_question");
		expect(postToolUseScript).toContain("plan_mode_respond");
	});

	it("prepends task workspace guard instructions for Cline CLI task prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-cline-worktree-guard",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp/worktrees/task-1/repo",
			prompt: "Implement the task",
		});

		const prompt = launch.args.at(-1) ?? "";
		expect(prompt).toContain("Kanban-managed task session");
		expect(prompt).toContain("`/tmp/worktrees/task-1/repo`");
		expect(prompt).toContain("ask the user to confirm which workspace owns the work");
		expect(prompt).toContain("# Task\nImplement the task");
	});

	it("adds resume flags for each agent", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(geminiLaunch.args).toEqual(expect.arrayContaining(["--resume", "latest"]));

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(opencodeLaunch.args).toContain("--continue");

		const droidLaunch = await prepareAgentLaunch({
			taskId: "task-droid",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(droidLaunch.args).toContain("--resume");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kiroLaunch.args).toContain("--resume");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(clineLaunch.args).toContain("--continue");
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("applies autonomous mode flags in adapters for non-droid CLIs", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-auto",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-auto",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-no-auto",
			agentId: "gemini",
			binary: "gemini",
			args: ["--yolo"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-no-auto",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve-all"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-no-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat", "--trust-all-tools"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");
	});
});
