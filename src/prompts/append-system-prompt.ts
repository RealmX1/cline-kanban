import { realpathSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import { resolveAgentGuidanceDocumentPath } from "../core/agent-guidance-document-reference";

import type { RuntimeAgentId } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveKanbanCommandParts } from "../core/kanban-command";
import { buildShellCommandLine, quoteShellArg } from "../core/shell";
import { renderTaskInitialPromptAuthoringAndStartupSettingsGuidance } from "../core/task-initial-prompt-authoring-and-startup-settings-guidance";
import { renderTaskAgentNamingAndWorkPhaseGoalGuidance } from "../core/task-naming-conventions";
import { detectAutoUpdateInstallation, UpdatePackageManager } from "../update/update";

const DEFAULT_COMMAND_PREFIX = "kanban";
const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

export interface ResolveAppendSystemPromptCommandPrefixOptions {
	currentVersion?: string;
	argv?: string[];
	execArgv?: string[];
	execPath?: string;
	cwd?: string;
	resolveRealPath?: (path: string) => string;
}

export interface RenderAppendSystemPromptOptions {
	agentId?: RuntimeAgentId | null;
}

const APPEND_PROMPT_AGENT_IDS: readonly RuntimeAgentId[] = [
	"claude",
	"codex",
	"cline",
	"droid",
	"kiro",
	"gemini",
	"opencode",
];

function isRuntimeAgentId(value: string): value is RuntimeAgentId {
	return APPEND_PROMPT_AGENT_IDS.includes(value as RuntimeAgentId);
}

function resolveHomeAgentId(taskId: string): RuntimeAgentId | null {
	if (!isHomeAgentSessionId(taskId)) {
		return null;
	}
	const parts = taskId.split(":");
	const maybeAgentId = parts.at(-1) ?? null;
	if (!maybeAgentId || !isRuntimeAgentId(maybeAgentId)) {
		return null;
	}
	return maybeAgentId;
}

export function resolveAppendSystemPromptCommandPrefix(
	options: ResolveAppendSystemPromptCommandPrefixOptions = {},
): string {
	const argv = options.argv ?? process.argv;
	const fallbackCommandParts = resolveKanbanCommandParts({
		execPath: options.execPath ?? process.execPath,
		argv,
		execArgv: options.execArgv ?? process.execArgv,
	});
	const fallbackCommandPrefix = buildShellCommandLine(
		fallbackCommandParts[0] ?? DEFAULT_COMMAND_PREFIX,
		fallbackCommandParts.slice(1),
	);
	const entrypointArg = argv[1];
	if (!entrypointArg) {
		return fallbackCommandPrefix;
	}

	const resolveRealPath = options.resolveRealPath ?? realpathSync;
	let entrypointPath: string;
	try {
		entrypointPath = resolveRealPath(entrypointArg);
	} catch {
		return fallbackCommandPrefix;
	}

	const installation = detectAutoUpdateInstallation({
		currentVersion: options.currentVersion ?? KANBAN_VERSION,
		packageName: "kanban",
		entrypointPath,
		cwd: options.cwd ?? process.cwd(),
	});

	if (installation.updateTiming !== "shutdown") {
		return fallbackCommandPrefix;
	}

	if (installation.packageManager === UpdatePackageManager.NPX) {
		return "npx -y kanban";
	}
	if (installation.packageManager === UpdatePackageManager.PNPM) {
		return "pnpm dlx kanban";
	}
	if (installation.packageManager === UpdatePackageManager.YARN) {
		return "yarn dlx kanban";
	}
	if (installation.packageManager === UpdatePackageManager.BUN) {
		return "bun x kanban";
	}

	return fallbackCommandPrefix;
}

export function renderAppendSystemPrompt(commandPrefix: string, options: RenderAppendSystemPromptOptions = {}): string {
	const kanbanCommand = commandPrefix.trim() || DEFAULT_COMMAND_PREFIX;
	return `# Kanban Sidebar

你是当前工作区的看板管理助手，负责创建、组织、查询和启动 Task；实现请求交给目标任务工作区，不直接修改项目源码。按用户授权使用 CLI，不把本侧栏的角色边界复制到目标任务。
命令前缀：\`${kanbanCommand}\`。当前 Agent：\`${options.agentId ?? "unknown"}\`。
优先 task get 查已知 ID，task list 查列表；task create 创建前核对 resolvedSettings 与来源，task start 启动。--project-path 始终指主仓库，可用 git rev-parse --git-common-dir 的父目录确定。不要从任务标题猜身份。

${renderTaskAgentNamingAndWorkPhaseGoalGuidance()}
${renderTaskInitialPromptAuthoringAndStartupSettingsGuidance()}

按需参考：\`${resolveAgentGuidanceDocumentPath("kanban-command-reference.md")}\`；具体参数用上述前缀的 --help 查询。GitHub 优先 gh，Linear 优先当前 Agent 可用的 MCP；仅在需要时配置。
结果说明任务 ID、目标工作区、实际动作与待恢复事项。运行时不可用时保留已取得的信息，修复连接后重试，不把受理当作送达。`;
}

export function resolveHomeAgentAppendSystemPrompt(
	taskId: string,
	options: ResolveAppendSystemPromptCommandPrefixOptions = {},
): string | null {
	if (!isHomeAgentSessionId(taskId)) {
		return null;
	}
	return renderAppendSystemPrompt(resolveAppendSystemPromptCommandPrefix(options), {
		agentId: resolveHomeAgentId(taskId),
	});
}

export function renderTaskSessionWorktreeGuardPrompt(
	taskId: string,
	cwd: string,
	commandPrefix: string = DEFAULT_COMMAND_PREFIX,
): string {
	const kanbanCommand = commandPrefix.trim() || DEFAULT_COMMAND_PREFIX;
	const trimmedTaskId = taskId.trim();
	const quotedTaskId = quoteShellArg(trimmedTaskId);
	return `# Kanban Task Workspace

你负责在分配的工作区完成本任务，依据用户真实授权与仓库约定实施、验证并报告结果。
任务 ID：\`${trimmedTaskId}\`；工作区：\`${cwd}\`。默认在这里修改源码与提交，不从 cwd 重新推导任务 ID。
同一 git-common-dir 下由本任务工具创建的派生工作树，以及用户显式调用 workflow 操作的工作树，沿用已有授权。文档指向无关仓库时，先确认其编辑归属。
命令前缀：\`${kanbanCommand}\`。task get --task-id ${quotedTaskId} --project-path <主仓库路径> 查询本任务；主仓库路径取 git rev-parse --git-common-dir 的父目录，不能传 task worktree。

${renderTaskAgentNamingAndWorkPhaseGoalGuidance()}
${renderTaskInitialPromptAuthoringAndStartupSettingsGuidance()}

按需操作：\`${resolveAgentGuidanceDocumentPath("kanban-command-reference.md")}\`。引用或复用别的任务时，用 work-unit assert-reference-relation 记录关系；work-unit get-relation-neighborhood-summary 查来源。
HTML 用 task visualization publish 发布到本任务，附属资源显式映射；status=published 才表示发布成功，awaiting_runtime_acceptance 表示待接收。预览用 task visualization request-preview，不调用宿主机 open。
交接材料写入 KANBAN_TASK_CROSS_TASK_HANDOFF_ARTIFACT_DIRECTORY 或已提交文件，确保重启后可读。普通消息、等待与恢复由通用会话入口处理；人工 rewind 和 checkpoint 按用户授权使用。`;
}

export function renderTaskCollaborationSessionResponsibilityGuidance(
	workspaceTaskId: string,
	taskConversationSessionId: string,
): string {
	return `# 协作会话的责任边界

当前会话是任务 ${workspaceTaskId} 的可写协作会话，会话 ID 为 ${taskConversationSessionId}。
与主会话共用工作目录，文件修改立即相互可见。只执行本会话用户要求的工作。
主会话负责卡片生命周期；不要自行修改卡片标题、阶段目标、看板列或宣告整个任务完成。
编辑归属以各会话为准，不要把共享目录的所有改动认作本会话产出。`;
}

export function resolveTaskSessionAppendSystemPrompt(
	taskId: string,
	cwd: string,
	options: ResolveAppendSystemPromptCommandPrefixOptions = {},
): string | null {
	if (isHomeAgentSessionId(taskId)) {
		return null;
	}
	const trimmedCwd = cwd.trim();
	if (!trimmedCwd) {
		return null;
	}
	return renderTaskSessionWorktreeGuardPrompt(taskId, trimmedCwd, resolveAppendSystemPromptCommandPrefix(options));
}

// Exploratory Mode（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md §A.2 效应 2）：
// 探索型会话启动时注入的一段 append system prompt，把 agent 指向 Kanban 托管的指令文件。
// 纯函数：指令文件的物化（ensureExploratoryModeInstructionsFile）由调用方负责，这里只拼装文本。
export function renderExploratoryModeAppendSystemPrompt(instructionsFilePath: string): string {
	return `# Kanban Exploratory Mode

This is an exploratory conversation: the structure and conclusions it produces are assets in their own right. Kanban automatically maintains an exploration thread graph (a git-graph style outline of the conversation's threads) for this session; you never write that structure yourself, but how explicitly you announce topic switches, returns to earlier threads and wrap-ups determines its quality.

Read the Kanban-managed instructions file at the following path IN FULL and follow it for the entire session:
\`${instructionsFilePath}\``;
}

export function combineAppendSystemPrompts(...prompts: Array<string | null | undefined>): string | null {
	const parts = prompts.map((prompt) => prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt));
	return parts.length > 0 ? parts.join("\n\n") : null;
}
