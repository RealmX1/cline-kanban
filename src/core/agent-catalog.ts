import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--dangerously-skip-permissions"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
	},
];

// Temporarily keep launch support scoped to the core agent set.
// Re-enable additional CLIs by uncommenting entries below when ready.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = [
	"cline",
	"claude",
	"codex",
	"droid",
	"kiro",
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

// Codex 是唯一「inline transcript」agent：codexAdapter 强制 --no-alt-screen，让它把整段对话
// 历史渲染进终端 normal buffer / scrollback（而非 alt-screen 一屏），以支持在 Kanban 终端里
// 向上滚动完整历史（见 6b5c42dd「修复 Codex 终端历史滚动限制」）。
//
// 该事实有一个必须同步的下游约束：inline agent 靠「CSI 3 J 清 scrollback + 重印整段」做原地
// 刷新（已用 node-pty 抓 codex-cli 真实字节确认：每次 resize 都发 ESC[2J ESC[3J + 整段重印），
// 因此 session-manager 绝不能对它启用 suppressScrollbackErasure——吞掉 CSI 3 J 会让每次重印叠加
// 在旧历史下面（可见翻倍），并让服务端 mirror scrollback 只增不清、每次 restore 全量重放。
// alt-screen agent（Claude 等）把整段界面画在备用屏、不往 scrollback 堆历史，无此约束。
//
// 放在 agent-catalog（纯 agent 事实、不被测试 mock）而非 agent-session-adapters，是因为后者被
// session-manager 的测试 vi.mock 掉；把 startTaskSession 依赖的谓词留在被 mock 的模块里会让所有
// mock 该模块的测试拿到 undefined。
export function agentRendersTranscriptInline(agentId: RuntimeAgentId): boolean {
	return agentId === "codex";
}
