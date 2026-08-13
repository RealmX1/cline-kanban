import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID } from "../../../src/core/agent-catalog";
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
		expect(launch.args[modelIndex + 1]).toBe("grok-4.5-high");
		expect(launch.args).not.toContain("composer-2.5-fast");
		expect(launch.args).not.toContain("grok-4.5-fast-high");
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

	it("resumes the selected Cursor chat in the task workspace", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-resume-existing-session",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp/repo",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "cursor",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
				sourceSessionWorkingDirectoryPath: "/tmp/repo",
			},
		});

		const resumeIndex = launch.args.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[resumeIndex + 1]).toBe("11111111-2222-3333-4444-555555555555");
		expect(launch.args.some((argument) => argument.includes("Continue this work"))).toBe(true);
	});

	it("prepares a Cursor session from a different checkout after runtime materialization", async () => {
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-cross-checkout-session",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp/task-worktree",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "cursor",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
				sourceSessionWorkingDirectoryPath: "/tmp/source-checkout",
			},
		});
		expect(launch.args).toContain("--resume");
		expect(launch.args).toContain("11111111-2222-3333-4444-555555555555");
	});

	it("rejects Cursor fork initialization because the CLI cannot fork chats", async () => {
		await expect(
			prepareAgentLaunch({
				taskId: "task-cursor-fork-existing-session",
				agentId: "cursor",
				binary: "cursor-agent",
				args: [],
				cwd: "/tmp/repo",
				prompt: "Continue this work",
				taskAgentSessionInitialization: {
					sourceAgentId: "cursor",
					sourceSessionId: "11111111-2222-3333-4444-555555555555",
					sourceSessionReuseMode: "fork_existing_session",
				},
			}),
		).rejects.toThrow("Cursor");
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

	// 防回灌守卫：codex 默认必须跑原生 alt-screen（原地重绘），绝不能强制注入 --no-alt-screen。
	// 强制 inline 会让 codex 每次 resize 整屏 ESC[2J ESC[3J + 全量重印，叠加 20k 行 mirror 全量重放，
	// 复现「从顶滚到底」的历史顽疾（见 6b5c42dd 引入、b296352 修复、后被 main merge 反复回灌）。
	// 若未来某次 merge 又把强制注入带回来，这条会当场失败。
	it("launches Codex on its native alt-screen by NOT injecting --no-alt-screen by default", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-default-alt-screen",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args).not.toContain("--no-alt-screen");
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
		// Config flags (-c ...) must precede the subcommand.
		const configFlagIndex = launch.args.indexOf("-c");
		expect(configFlagIndex).toBeGreaterThanOrEqual(0);
		expect(configFlagIndex).toBeLessThan(forkIndex);
	});

	it("resumes the selected Codex session without forking it", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-existing-session",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "codex",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[resumeIndex + 1]).toBe("11111111-2222-3333-4444-555555555555");
		expect(launch.args).not.toContain("fork");
		expect(launch.args.indexOf("-C")).toBeLessThan(resumeIndex);
		expect(launch.args.indexOf("Continue this work")).toBeGreaterThan(resumeIndex);
	});

	it("prefers an explicitly selected Codex session over forking the latest working-directory session", async () => {
		setupTempHome();
		const sourceSessionId = "11111111-2222-3333-4444-555555555555";
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-explicit-session-precedence",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "codex",
				sourceSessionId,
				sourceSessionReuseMode: "resume_existing_session",
			},
			forkLatestWorkingDirectorySession: true,
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[resumeIndex + 1]).toBe(sourceSessionId);
		expect(launch.args).not.toContain("fork");
		expect(launch.args).not.toContain("--last");
	});

	it("forks the selected Claude session with a new session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fork-existing-session",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "fork_existing_session",
				sourceSessionWorkingDirectoryPath: "/tmp",
			},
		});

		const resumeIndex = launch.args.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[resumeIndex + 1]).toBe("11111111-2222-3333-4444-555555555555");
		expect(launch.args).toContain("--fork-session");
		expect(launch.args).toContain("Continue this work");
	});

	it("prepares manually entered Claude session initialization without a source checkout", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-unverified-session",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(launch.args).toContain("--resume");
		expect(launch.args).toContain("11111111-2222-3333-4444-555555555555");
	});

	it("forks the latest Codex session in read-only mode for a By the way session", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-conversation-session-codex",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			cwd: "/tmp/task-worktree",
			prompt: "Explain this module",
			readOnlyQuestionSession: true,
			forkLatestWorkingDirectorySession: true,
		});

		expect(launch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(launch.args).toContain("read-only");
		expect(launch.args).toContain("never");
		expect(launch.args).toContain("fork");
		expect(launch.args).toContain("--last");
		expect(launch.args).toContain("Explain this module");
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

	it("forks Claude with a read-only tool set for a By the way session", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-conversation-session-claude",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			cwd: "/tmp/task-worktree",
			prompt: "Explain this module",
			readOnlyQuestionSession: true,
			forkLatestWorkingDirectorySession: true,
		});

		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).toContain("--permission-mode");
		expect(launch.args).toContain("plan");
		expect(launch.args).toContain("Read,Glob,Grep,WebSearch,WebFetch");
		expect(launch.args).toContain("--continue");
		expect(launch.args).toContain("--fork-session");
	});

	it("keeps Claude By the way sessions read-only when autonomous mode is enabled", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-conversation-session-claude-autonomous",
			agentId: "claude",
			binary: "claude",
			args: [],
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			cwd: "/tmp/task-worktree",
			prompt: "Explain this module",
			readOnlyQuestionSession: true,
		});

		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).toContain("--permission-mode");
		expect(launch.args).toContain("plan");
		expect(launch.args).toContain("Read,Glob,Grep,WebSearch,WebFetch");
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
			taskAgentPermissionMode: "bypass_all_permission_prompts",
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
			taskAgentPermissionMode: "bypass_all_permission_prompts",
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

	it("applies the bypass permission tier to every harness that can express it", async () => {
		setupTempHome();

		const bypassFlagByAgentId: ReadonlyArray<{
			agentId: RuntimeAgentId;
			binary: string;
			args: string[];
			flag: string;
		}> = [
			{ agentId: "claude", binary: "claude", args: [], flag: "--dangerously-skip-permissions" },
			{ agentId: "codex", binary: "codex", args: [], flag: "--dangerously-bypass-approvals-and-sandbox" },
			{ agentId: "gemini", binary: "gemini", args: [], flag: "--yolo" },
			{ agentId: "kiro", binary: "kiro-cli", args: ["chat"], flag: "--trust-all-tools" },
			{ agentId: "cline", binary: "cline", args: [], flag: "--auto-approve-all" },
			{ agentId: "kimi", binary: "kimi", args: [], flag: "--yolo" },
			{ agentId: "cursor", binary: "cursor-agent", args: [], flag: "--force" },
		];

		for (const { agentId, binary, args, flag } of bypassFlagByAgentId) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}-bypass`,
				agentId,
				binary,
				args: [...args],
				taskAgentPermissionMode: "bypass_all_permission_prompts",
				cwd: "/tmp",
				prompt: "",
			});
			expect(launch.args, `${agentId} should receive ${flag}`).toContain(flag);
		}
	});

	it("omits bypass flags for the ask tier without stripping explicitly provided ones", async () => {
		setupTempHome();

		const explicitFlagByAgentId: ReadonlyArray<{
			agentId: RuntimeAgentId;
			binary: string;
			args: string[];
			flag: string;
		}> = [
			{
				agentId: "claude",
				binary: "claude",
				args: ["--dangerously-skip-permissions"],
				flag: "--dangerously-skip-permissions",
			},
			{
				agentId: "codex",
				binary: "codex",
				args: ["--dangerously-bypass-approvals-and-sandbox"],
				flag: "--dangerously-bypass-approvals-and-sandbox",
			},
			{ agentId: "gemini", binary: "gemini", args: ["--yolo"], flag: "--yolo" },
			{ agentId: "cline", binary: "cline", args: ["--auto-approve-all"], flag: "--auto-approve-all" },
			{ agentId: "kiro", binary: "kiro-cli", args: ["chat", "--trust-all-tools"], flag: "--trust-all-tools" },
		];

		for (const { agentId, binary, args, flag } of explicitFlagByAgentId) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}-ask`,
				agentId,
				binary,
				args: [...args],
				taskAgentPermissionMode: "ask_for_every_tool_use",
				cwd: "/tmp",
				prompt: "",
			});
			expect(launch.args, `${agentId} should keep an explicitly provided ${flag}`).toContain(flag);
		}

		// 没有显式旗标时，ask 档不得自行添加任何放行旗标。
		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-ask-clean",
			agentId: "claude",
			binary: "claude",
			args: [],
			taskAgentPermissionMode: "ask_for_every_tool_use",
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.args).not.toContain("--permission-mode");

		// codex 相反：它的默认审批策略取自用户自己的 ~/.codex/config.toml（可能是 never），
		// 所以 ask 档必须显式钉死最严的 untrusted，否则选了「每次询问」也可能什么都不问。
		const codexAskLaunch = await prepareAgentLaunch({
			taskId: "task-codex-ask-clean",
			agentId: "codex",
			binary: "codex",
			args: [],
			taskAgentPermissionMode: "ask_for_every_tool_use",
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexAskLaunch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(codexAskLaunch.args).toContain("--ask-for-approval");
		expect(codexAskLaunch.args).toContain("untrusted");
	});

	it("expresses the middle tier natively where supported and degrades to ask elsewhere", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-accept-edits",
			agentId: "claude",
			binary: "claude",
			args: [],
			taskAgentPermissionMode: "auto_approve_file_edits_only",
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--permission-mode");
		expect(claudeLaunch.args).toContain("acceptEdits");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");

		// codex 表达不出中间档：on-request 会让普通 shell 命令不经询问就跑（语义是「由模型决定
		// 何时询问」），并不满足本档承诺的「跑命令仍会询问」；untrusted 又连改文件也一律询问。
		// 于是必须保守降级到 ask，并显式推 untrusted——什么都不推等于把档位交给用户的
		// ~/.codex/config.toml 决定，那同样是静默放宽。
		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-accept-edits",
			agentId: "codex",
			binary: "codex",
			args: [],
			taskAgentPermissionMode: "auto_approve_file_edits_only",
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).not.toContain("on-request");
		expect(codexLaunch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(codexLaunch.args).toContain("--ask-for-approval");
		expect(codexLaunch.args).toContain("untrusted");

		// cursor / kimi 无法表达中间档：必须保守降级到 ask，绝不回落成全放行。
		for (const { agentId, binary, forbiddenFlag } of [
			{ agentId: "cursor", binary: "cursor-agent", forbiddenFlag: "--force" },
			{ agentId: "kimi", binary: "kimi", forbiddenFlag: "--yolo" },
		] as const) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}-accept-edits`,
				agentId,
				binary,
				args: [],
				taskAgentPermissionMode: "auto_approve_file_edits_only",
				cwd: "/tmp",
				prompt: "",
			});
			expect(launch.args, `${agentId} must not silently widen to full bypass`).not.toContain(forbiddenFlag);
		}

		// cline 是个刻意的例外：agentId "cline" 在 Kanban 里路由到进程内 Cline SDK，而那条路径的
		// requestToolApproval 目前恒批准，所以它只能表达「全放行」一档。这个「无法收紧」的事实由
		// resolveTaskAgentPermissionModeForAgent 如实报告 degraded，并在任务创建界面明示，
		// 而不是让用户以为选了更严的档位就真的更严。
		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-accept-edits",
			agentId: "cline",
			binary: "cline",
			args: [],
			taskAgentPermissionMode: "auto_approve_file_edits_only",
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");
	});

	// 用户拍板的正交约束：plan 起步只决定「开局先只读规划」，不得剥夺所选放权档。
	it("keeps plan-mode start orthogonal to the permission tier", async () => {
		setupTempHome();

		const claudePlanBypass = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: [],
			startInPlanMode: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			cwd: "/tmp",
			prompt: "",
		});
		// 开局只读，但预授权本会话后续可切到 bypass。
		expect(claudePlanBypass.args).toContain("--permission-mode");
		expect(claudePlanBypass.args).toContain("plan");
		expect(claudePlanBypass.args).toContain("--allow-dangerously-skip-permissions");
		expect(claudePlanBypass.args).not.toContain("--dangerously-skip-permissions");
		// --permission-mode 只能出现一次，否则两个分支各推一个会互相打架。
		expect(claudePlanBypass.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);

		const claudePlanAsk = await prepareAgentLaunch({
			taskId: "task-claude-plan-ask",
			agentId: "claude",
			binary: "claude",
			args: [],
			startInPlanMode: true,
			taskAgentPermissionMode: "ask_for_every_tool_use",
			cwd: "/tmp",
			prompt: "",
		});
		// ask 档没选 bypass，就不该预授权升档。
		expect(claudePlanAsk.args).not.toContain("--allow-dangerously-skip-permissions");

		// cursor 的 --plan 与 --force 是独立旗标，实测可并存，故两者都要在。
		const cursorPlanBypass = await prepareAgentLaunch({
			taskId: "task-cursor-plan-bypass",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			startInPlanMode: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			cwd: "/tmp",
			prompt: "",
		});
		expect(cursorPlanBypass.args).toContain("--plan");
		expect(cursorPlanBypass.args).toContain("--force");

		// kimi 同理：--plan 与 --yolo 各自独立。
		const kimiPlanBypass = await prepareAgentLaunch({
			taskId: "task-kimi-plan-bypass",
			agentId: "kimi",
			binary: "kimi",
			args: [],
			startInPlanMode: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			cwd: "/tmp",
			prompt: "",
		});
		expect(kimiPlanBypass.args).toContain("--plan");
		expect(kimiPlanBypass.args).toContain("--yolo");
	});
});

// resumesPriorAgentConversation 是 session-manager 武装 resume substantive guard 的唯一依据：
// 续跑启动会把整段旧 transcript 重播进新 TUI，那不是「agent 刚刚响应」，不得刷新卡片时间戳。
// 反过来，全新启动必须为 false，否则真实新产出会被误冻住。
describe("prepareAgentLaunch resumesPriorAgentConversation", () => {
	it("marks a Claude --resume launch as resuming a prior conversation", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-resume-flag",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});

		expect(launch.args).toContain("--resume");
		expect(launch.resumesPriorAgentConversation).toBe(true);
	});

	it("marks a Claude fork-latest launch as resuming a prior conversation", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fork-latest-flag",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Explain this module",
			forkLatestWorkingDirectorySession: true,
		});

		expect(launch.args).toContain("--fork-session");
		expect(launch.resumesPriorAgentConversation).toBe(true);
	});

	it("marks a Codex fork launch as resuming a prior conversation", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fork-flag",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Explain this module",
			forkLatestWorkingDirectorySession: true,
		});

		expect(launch.resumesPriorAgentConversation).toBe(true);
	});

	it("marks a Cursor --resume launch as resuming a prior conversation", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-resume-flag",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			taskAgentSessionInitialization: {
				sourceAgentId: "cursor",
				sourceSessionId: "cursor-prior-session",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});

		expect(launch.args).toContain("--resume");
		expect(launch.resumesPriorAgentConversation).toBe(true);
	});

	it("does not mark a brand new launch as resuming a prior conversation", async () => {
		setupTempHome();
		for (const agentId of ["claude", "codex", "cursor"] as const) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}-fresh-flag`,
				agentId,
				binary: agentId === "cursor" ? "cursor-agent" : agentId,
				args: [],
				cwd: "/tmp",
				prompt: "Implement the task",
			});
			expect(launch.resumesPriorAgentConversation ?? false).toBe(false);
		}
	});

	// 回归护栏：生产任务会话恒带 workspaceId（→ resolveHookContext 非空 → 走各 adapter 的 hooks
	// 配置路径）。上面不带 workspaceId 的用例覆盖不到那条路径，历史上 codexAdapter 正是因为
	// hooks 分支另有一份重复的 return 对象字面量，新增字段只补到默认分支，使生产路径静默丢字段。
	// 下面这组用例把「带 hooks 上下文」的续跑启动钉死。
	it("keeps marking resumed launches when hook wiring is active (workspaceId present)", async () => {
		setupTempHome();

		const codexForkLaunch = await prepareAgentLaunch({
			taskId: "task-codex-fork-flag-with-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Explain this module",
			workspaceId: "workspace-1",
			forkLatestWorkingDirectorySession: true,
		});
		expect(codexForkLaunch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(codexForkLaunch.args).toContain("fork");
		expect(codexForkLaunch.resumesPriorAgentConversation).toBe(true);

		const codexResumeLaunch = await prepareAgentLaunch({
			taskId: "task-codex-resume-flag-with-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			workspaceId: "workspace-1",
			taskAgentSessionInitialization: {
				sourceAgentId: "codex",
				sourceSessionId: "codex-prior-session",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(codexResumeLaunch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(codexResumeLaunch.args).toContain("resume");
		expect(codexResumeLaunch.resumesPriorAgentConversation).toBe(true);

		const claudeResumeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-resume-flag-with-hooks",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			workspaceId: "workspace-1",
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "11111111-2222-3333-4444-555555555555",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(claudeResumeLaunch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(claudeResumeLaunch.args).toContain("--resume");
		expect(claudeResumeLaunch.resumesPriorAgentConversation).toBe(true);

		const cursorResumeLaunch = await prepareAgentLaunch({
			taskId: "task-cursor-resume-flag-with-hooks",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp",
			prompt: "Continue this work",
			workspaceId: "workspace-1",
			taskAgentSessionInitialization: {
				sourceAgentId: "cursor",
				sourceSessionId: "cursor-prior-session",
				sourceSessionReuseMode: "resume_existing_session",
			},
		});
		expect(cursorResumeLaunch.args).toContain("--resume");
		expect(cursorResumeLaunch.resumesPriorAgentConversation).toBe(true);
	});

	it("does not mark a brand new launch as resuming when hook wiring is active", async () => {
		setupTempHome();
		for (const agentId of ["claude", "codex", "cursor"] as const) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}-fresh-flag-with-hooks`,
				agentId,
				binary: agentId === "cursor" ? "cursor-agent" : agentId,
				args: [],
				cwd: "/tmp",
				prompt: "Implement the task",
				workspaceId: "workspace-1",
			});
			expect(launch.resumesPriorAgentConversation ?? false).toBe(false);
		}
	});
});

// oh-my-pi 的 PTY TUI 通道。它与 ACP 通道共用同一份 omp 磁盘会话存储，可随时互切，
// 所以这些断言不只是「参数拼对了」，还钉住了几条会让托管会话直接卡死的前提。
describe("ompAdapter", () => {
	async function prepareOmpLaunch(
		overrides: Partial<Parameters<typeof prepareAgentLaunch>[0]> = {},
	): ReturnType<typeof prepareAgentLaunch> {
		setupTempHome();
		return await prepareAgentLaunch({
			taskId: "task-omp",
			agentId: "omp",
			binary: "omp",
			args: [],
			cwd: "/tmp/repo",
			prompt: "Implement the feature",
			...overrides,
		});
	}

	function readOmpLaunchConfigOverlay(args: string[]): Record<string, unknown> {
		const configIndex = args.indexOf("--config");
		expect(configIndex).toBeGreaterThanOrEqual(0);
		const configPath = args[configIndex + 1];
		expect(existsSync(configPath)).toBe(true);
		return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	}

	it("maps each permission tier onto omp's --approval-mode", async () => {
		const expectedApprovalModeByPermissionMode = {
			bypass_all_permission_prompts: "yolo",
			auto_approve_file_edits_only: "write",
			ask_for_every_tool_use: "always-ask",
		} as const;
		for (const [permissionMode, expectedApprovalMode] of Object.entries(expectedApprovalModeByPermissionMode)) {
			const launch = await prepareOmpLaunch({
				taskId: `task-omp-${permissionMode}`,
				taskAgentPermissionMode: permissionMode as keyof typeof expectedApprovalModeByPermissionMode,
			});
			const approvalModeIndex = launch.args.indexOf("--approval-mode");
			expect(approvalModeIndex).toBeGreaterThanOrEqual(0);
			expect(launch.args[approvalModeIndex + 1]).toBe(expectedApprovalMode);
		}
	});

	// 绝不能起成 ACP server：`acp` 子命令只属于另一条通道。
	it("launches the interactive TUI, not the ACP server", async () => {
		const launch = await prepareOmpLaunch();
		expect(launch.args).not.toContain("acp");
	});

	// 位置 prompt 会在 TUI 初始化完成后由 omp 自动提交，因此不需要 deferredStartupInput。
	it("passes the task prompt positionally and does not defer startup input", async () => {
		const launch = await prepareOmpLaunch({ prompt: "Implement the feature" });
		expect(launch.args.some((argument) => argument.includes("Implement the feature"))).toBe(true);
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	// 坑 ①：omp 的大粘贴菜单默认 100 行触发，会挂住会话等人选。overlay 必须把它关掉（0）。
	// 同时 titleState 必须开着——Kanban 的状态判定全靠 OSC 标题。
	it("writes a launch overlay that disables the blocking large-paste menu and keeps title state on", async () => {
		const launch = await prepareOmpLaunch();
		const overlay = readOmpLaunchConfigOverlay(launch.args);
		expect(overlay.paste).toEqual({ largeMenuThreshold: 0 });
		expect(overlay.tui).toEqual({ titleState: true });
		expect(overlay.startup).toEqual({ showSplash: false });
	});

	// 坑 ②：plan 起步只能经 plan.defaultOnStartup 表达。`--plan-yolo` 会自动批准计划并立刻开始实现，
	// 与「先只读规划、停下等人批准」的语义相反。plan 起步也不得动放权档（正交轴铁律）。
	it("expresses plan start through the overlay without touching the permission tier", async () => {
		const launch = await prepareOmpLaunch({
			taskId: "task-omp-plan-start",
			startInPlanMode: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
		});
		const overlay = readOmpLaunchConfigOverlay(launch.args);
		expect(overlay.plan).toEqual({ enabled: true, defaultOnStartup: true });
		expect(launch.args).not.toContain("--plan-yolo");
		const approvalModeIndex = launch.args.indexOf("--approval-mode");
		expect(launch.args[approvalModeIndex + 1]).toBe("yolo");
	});

	it("omits the plan overlay when plan start is off", async () => {
		const launch = await prepareOmpLaunch({ taskId: "task-omp-no-plan-start" });
		expect(readOmpLaunchConfigOverlay(launch.args).plan).toBeUndefined();
	});

	// 续跑：垃圾桶恢复与通道切换重开是同一条分支——加 --continue、不重投 prompt、武装重播守卫。
	// 而且**绝不**发裸 --resume：无值时 omp 会弹全屏 session picker 等人上下键选，托管会话就此卡死。
	for (const [caseName, resumeOverrides] of [
		["restored from trash", { resumeFromTrash: true }],
		["reopened after a transport switch", { resumePriorAgentConversationWithoutResendingPrompt: true }],
	] as const) {
		it(`continues the prior conversation without resending the prompt when ${caseName}`, async () => {
			const launch = await prepareOmpLaunch({
				taskId: `task-omp-${caseName.replaceAll(" ", "-")}`,
				prompt: "Implement the feature",
				...resumeOverrides,
			});
			expect(launch.args).toContain("--continue");
			expect(launch.args).not.toContain("--resume");
			expect(launch.args).not.toContain("-r");
			expect(launch.args.some((argument) => argument.includes("Implement the feature"))).toBe(false);
			expect(launch.resumesPriorAgentConversation).toBe(true);
		});
	}

	it("does not replay plan start when continuing a prior conversation", async () => {
		const launch = await prepareOmpLaunch({
			taskId: "task-omp-resume-no-plan-replay",
			startInPlanMode: true,
			resumePriorAgentConversationWithoutResendingPrompt: true,
		});
		expect(readOmpLaunchConfigOverlay(launch.args).plan).toBeUndefined();
	});

	// 首启的全屏 setup 向导会切 alt-screen 盖住 TUI 并等人操作。
	it("skips the full-screen setup wizard", async () => {
		const launch = await prepareOmpLaunch({ taskId: "task-omp-skip-setup" });
		expect(launch.env.OMP_SKIP_SETUP).toBe("1");
	});

	it("detects run state from omp's OSC terminal title", async () => {
		const launch = await prepareOmpLaunch({ taskId: "task-omp-detector" });
		expect(typeof launch.detectOutputTransition).toBe("function");
		// 不设 shouldInspectOutputForTransition：缺省即恒扫，spinner 帧本来就要被看到。
		expect(launch.shouldInspectOutputForTransition).toBeUndefined();
	});
});
