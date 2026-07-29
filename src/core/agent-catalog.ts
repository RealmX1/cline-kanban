import type { RuntimeAgentId, RuntimeAgentSessionTransport } from "./api-contract";

export { isKanbanCursorAgentModelId, KANBAN_CURSOR_AGENT_DEFAULT_MODEL_ID } from "./cursor-agent-models";

// Kanban 与一个 agent 通话的方式。这是「卡片详情渲染 xterm 还是会话面板」「启动走
// terminalManager 还是进程内 service」等一系列分叉的单一真源——以前这些分叉各自硬写
// `agentId === "cline"`，新增非 PTY agent 时极易漏改其中一处。
// canonical 定义（含各取值语义注释）在 api-contract 的 runtimeAgentSessionTransportSchema：
// 它同时被回收审计结果 schema 复用，故必须是可校验的 zod 源，这里只做类型再导出。
export type { RuntimeAgentSessionTransport };

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	sessionTransport: RuntimeAgentSessionTransport;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--dangerously-skip-permissions"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		sessionTransport: "pty_terminal",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		sessionTransport: "pty_terminal",
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
		sessionTransport: "in_process_cline_sdk",
	},
	{
		id: "cursor",
		label: "Cursor",
		binary: "cursor-agent",
		baseArgs: [],
		autonomousArgs: ["--force"],
		installUrl: "https://cursor.com/cli",
		sessionTransport: "pty_terminal",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		sessionTransport: "pty_terminal",
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		sessionTransport: "pty_terminal",
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		sessionTransport: "pty_terminal",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		sessionTransport: "pty_terminal",
	},
	{
		id: "kimi",
		label: "Kimi Code",
		binary: "kimi",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/MoonshotAI/kimi-code",
		sessionTransport: "pty_terminal",
	},
	{
		id: "omp",
		label: "Oh My Pi (omp)",
		binary: "omp",
		// `omp acp` 把 omp 起成 ACP server（NDJSON JSON-RPC over stdio）。所有根命令 flag
		// 在该子命令下依然有效（commands/acp.ts 复用同一个 parseArgs 后强制 mode="acp"）。
		baseArgs: ["acp"],
		autonomousArgs: ["--approval-mode", "yolo"],
		installUrl: "https://omp.sh",
		sessionTransport: "acp_stdio_subprocess",
	},
];

// Temporarily keep launch support scoped to the core agent set.
// Re-enable additional CLIs by uncommenting entries below when ready.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"cursor",
	"droid",
	"kiro",
	"kimi",
	"omp",
	// "opencode",
	// "gemini",
];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}

export function getRuntimeAgentSessionTransport(agentId: RuntimeAgentId): RuntimeAgentSessionTransport {
	return getRuntimeAgentCatalogEntry(agentId)?.sessionTransport ?? "pty_terminal";
}

// 该 agent 的会话是否由 Kanban 直接持有结构化消息（因而在卡片详情里渲染成会话面板、
// 走 task chat 消息通道），而不是渲染成 xterm 终端。
export function isRuntimeAgentSessionRenderedAsConversationPanel(agentId: RuntimeAgentId | null): boolean {
	if (agentId === null) {
		return false;
	}
	return getRuntimeAgentSessionTransport(agentId) !== "pty_terminal";
}

export function isRuntimeAgentSessionDrivenByAcpProtocol(agentId: RuntimeAgentId | null): boolean {
	return agentId !== null && getRuntimeAgentSessionTransport(agentId) === "acp_stdio_subprocess";
}

// 该 agent 的模型 / provider 是否由 Kanban 的 Cline provider 设置决定。会话面板里的 Cline 专属控件
// （provider 模型选择器、Cline slash 命令）只对这类会话成立：ACP agent（omp）自带模型与命令体系，
// 在它的面板上保存模型只会写到与该任务无关的全局 Cline provider 配置。
export function isRuntimeAgentModelSelectedThroughClineProviderSettings(agentId: RuntimeAgentId | null): boolean {
	return agentId !== null && getRuntimeAgentSessionTransport(agentId) === "in_process_cline_sdk";
}
