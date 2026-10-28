import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAgentGuidanceDocumentPath } from "../../src/core/agent-guidance-document-reference";

import { renderTaskInitialPromptAuthoringAndStartupSettingsGuidance } from "../../src/core/task-initial-prompt-authoring-and-startup-settings-guidance";
import {
	combineAppendSystemPrompts,
	renderAppendSystemPrompt,
	renderExploratoryModeAppendSystemPrompt,
	renderTaskCollaborationSessionResponsibilityGuidance,
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

describe("精简的角色提示", () => {
	it("侧栏保留管理职责、真实默认与按需命令参考", () => {
		const prompt = renderAppendSystemPrompt("kanban", { agentId: "codex" });
		expect(prompt).toContain("看板管理助手");
		expect(prompt).toContain("不直接修改项目源码");
		expect(prompt).toContain("当前 Agent：`codex`");
		expect(prompt).toContain("resolvedSettings");
		expect(prompt).toContain(resolveAgentGuidanceDocumentPath("kanban-command-reference.md"));
		expect(prompt).not.toContain("# CLI Reference");
		expect(prompt).not.toContain("mcp add");
	});
	it("任务保留真实身份、派生工作树授权和无关仓库确认边界", () => {
		const prompt = resolveTaskSessionAppendSystemPrompt("task-1", "/workspace/derived");
		expect(prompt).toContain("任务 ID：`task-1`");
		expect(prompt).toContain("工作区：`/workspace/derived`");
		expect(prompt).toContain("不从 cwd 重新推导任务 ID");
		expect(prompt).toContain("同一 git-common-dir");
		expect(prompt).toContain("用户显式调用 workflow");
		expect(prompt).toContain("先确认其编辑归属");
		expect(prompt).toContain("不能传 task worktree");
		expect(prompt).toContain("git rev-parse --git-common-dir");
		expect(prompt).not.toContain("不直接修改项目源码");
		expect(prompt).toContain("人工 rewind 和 checkpoint");
	});
	it("协作会话保留共享目录与生命周期责任", () => {
		const prompt = renderTaskCollaborationSessionResponsibilityGuidance("card-1", "collaborator-2");
		expect(prompt).toContain("任务 card-1");
		expect(prompt).toContain("collaborator-2");
		expect(prompt).toContain("文件修改立即相互可见");
		expect(prompt).toContain("主会话负责卡片生命周期");
		expect(prompt).not.toContain("RVF");
	});
	it.each([
		["侧栏", () => renderAppendSystemPrompt("kanban")],
		["主任务", () => resolveTaskSessionAppendSystemPrompt("task-1", "/workspace")],
	] as const)("%s 共享承重指导只注入一次", (_role, render) => {
		const prompt = render();
		const guidance = renderTaskInitialPromptAuthoringAndStartupSettingsGuidance();
		expect(prompt?.split(guidance)).toHaveLength(2);
		expect(prompt).toContain("## TLDR");
		expect(prompt).toContain("startInPlanMode 与权限独立");
		expect(prompt).toContain("用户原话与来源");
		expect(prompt).toContain("unknown");
		expect(prompt).not.toContain("固定候选 RVF");
		expect(prompt).not.toContain("rvf-land");
	});
	it("完整起草规范与操作参考在源码安装中可读", () => {
		const authoring = readFileSync(
			resolveAgentGuidanceDocumentPath("task-authoring-and-startup-settings.md"),
			"utf8",
		);
		expect(authoring).toContain("source-request-id");
		expect(authoring).toContain("XML 文本转义");
		expect(authoring).toContain("resolvedSettings");
		const reference = readFileSync(resolveAgentGuidanceDocumentPath("kanban-command-reference.md"), "utf8");
		expect(reference).toContain("task delete");
		expect(reference).toContain("人工 rewind");
		expect(reference).toContain("--expect-resolved-settings-fingerprint");
	});
	it("home 与任务角色互斥，空工作区不注入", () => {
		expect(resolveTaskSessionAppendSystemPrompt("__home_agent__:workspace-1:codex", "/workspace")).toBeNull();
		expect(resolveTaskSessionAppendSystemPrompt("task-1", "  ")).toBeNull();
		expect(resolveHomeAgentAppendSystemPrompt("task-1")).toBeNull();
		expect(resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex")).toContain("当前 Agent：`codex`");
	});
	it("空段不进入最终正文", () =>
		expect(combineAppendSystemPrompts("first", null, " ", "second")).toBe("first\n\nsecond"));
	it("探索说明继续引用指令文件", () =>
		expect(renderExploratoryModeAppendSystemPrompt("/persistent/instructions.md")).toContain(
			"`/persistent/instructions.md`",
		));
});
