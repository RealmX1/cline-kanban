import type { RuntimeAgentId, RuntimeAgentSessionTransport, RuntimeTaskSessionSummary } from "./api-contract";

export {
	isKanbanCursorAgentGrokModelId,
	isKanbanCursorAgentModelId,
	KANBAN_CURSOR_AGENT_PROBE_FAILURE_FALLBACK_MODEL_ID,
} from "./cursor-agent-models";

// Kanban 与一个 agent 通话的方式。这是「卡片详情渲染 xterm 还是会话面板」「启动走
// terminalManager 还是进程内 service」等一系列分叉的单一真源——以前这些分叉各自硬写
// `agentId === "cline"`，新增非 PTY agent 时极易漏改其中一处。
// canonical 定义（含各取值语义注释）在 api-contract 的 runtimeAgentSessionTransportSchema：
// 它同时被回收审计结果 schema 复用，故必须是可校验的 zod 源，这里只做类型再导出。
export type { RuntimeAgentSessionTransport };

// kanban 怎样拿到这个 agent 的**原生会话 id**（续跑按 id 寻址的前提）。新增 agent 时必须显式声明——测试断言
// 每个可启动 agent 都有取值，`not_captured` 也要写出来，好让「这个 agent 只能靠 cwd-latest 续跑」是可见的事实，
// 而不是被遗忘的缺口（Cursor 就是这样被漏了一年：没有任何采集路径，续跑一律 `--continue` 猜 cwd 最近一段）。
export type RuntimeAgentNativeConversationSessionIdentityCaptureMethod =
	// hook stdin 的 session_id（Claude Code / Codex / Kimi）。
	| "agent_hook_stdin_session_id"
	// kanban 安装的托管扩展上报（omp TUI）；omp 的 ACP 通道另由会话握手给出。
	| "managed_agent_extension_ingest"
	// kanban 在 spawn 前自己分配 id，再让 agent 以该 id 开局（Cursor：`--resume <新 UUID>`）。
	| "kanban_assigned_before_agent_launch"
	// 进程内 SDK 自己管对话历史，不经原生 id 续跑（Cline）。
	| "in_process_sdk_owns_conversation_history"
	// 没有任何采集路径：续跑只能落到 agent 自己的「最近一段」。
	| "not_captured";

// 恢复会话后的「续跑守卫」（restorationContinuationGuardState）靠什么信号解除。
// 只有 codex / cursor 经核实没有可靠的提交 hook；其余 agent 维持历史行为（等 hook）。
// 30 分钟兜底只让读侧（harness 唤醒通知的拦截）自行失效，不清声明态；排队投递的门控 5 读声明态，
// 所以收不到解除信号的会话，排队条目会一直挡到人真的提交为止。
export type RuntimeAgentRestorationContinuationGuardDisarmSignal =
	// agent 的 UserPromptSubmit 一类 hook 报告了真人提交（Claude 还要在那条同步 hook 里取出恢复期暂存的通知）。
	| "agent_user_prompt_submit_hook"
	// agent 没有可靠的 UserPromptSubmit hook：只能在终端 Enter / 程序化提交这一提交边沿解除，否则声明态一直
	// 不清，排队投递一直被门控 5 挡住。
	| "terminal_submission_edge_without_reliable_user_prompt_submit_hook";

// 这个 agent 的对话能否被 **harness 自己的后台会话守护进程**占住，以及续跑前怎样核对、收回。
//
// 存在理由：Claude Code 2.1.29x 起，用户在 kanban 终端里执行 `/background`（`/bg`）会把对话 fork 进 Claude
// 自己的守护进程（`claude daemon` → `bg-pty-host`），原会话转录末尾写下 `continued-in`。之后 kanban 按 id
// 续跑，`claude --resume <id>` 会被拒绝并立即 exit 1（"That session is running in the background"）。
// 只有声明了核对方式的 agent，续跑前才会去问 harness「这段对话是不是被后台会话占着」。
export type RuntimeAgentNativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod =
	// `claude agents --json --cwd <cwd>` 列出存活会话；空闲的后台会话用 `claude stop <id>` 收回（对话保留）。
	| "claude_code_agents_json_listing_and_stop"
	// 这个 harness 没有能把对话搬出 kanban 终端的后台守护进程。
	| "not_applicable";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	sessionTransport: RuntimeAgentSessionTransport;
	nativeConversationSessionIdentityCaptureMethod: RuntimeAgentNativeConversationSessionIdentityCaptureMethod;
	restorationContinuationGuardDisarmSignal: RuntimeAgentRestorationContinuationGuardDisarmSignal;
	nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: RuntimeAgentNativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod;
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
		nativeConversationSessionIdentityCaptureMethod: "agent_hook_stdin_session_id",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod:
			"claude_code_agents_json_listing_and_stop",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "agent_hook_stdin_session_id",
		restorationContinuationGuardDisarmSignal: "terminal_submission_edge_without_reliable_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
		sessionTransport: "in_process_cline_sdk",
		nativeConversationSessionIdentityCaptureMethod: "in_process_sdk_owns_conversation_history",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "cursor",
		label: "Cursor",
		binary: "cursor-agent",
		baseArgs: [],
		autonomousArgs: ["--force"],
		installUrl: "https://cursor.com/cli",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "kanban_assigned_before_agent_launch",
		restorationContinuationGuardDisarmSignal: "terminal_submission_edge_without_reliable_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "not_captured",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "not_captured",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "not_captured",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "not_captured",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "kimi",
		label: "Kimi Code",
		binary: "kimi",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/MoonshotAI/kimi-code",
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "agent_hook_stdin_session_id",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
	},
	{
		id: "omp",
		label: "Oh My Pi (omp)",
		binary: "omp",
		// baseArgs 必须留空：omp 有两条通道，`acp` 子命令只属于 ACP 那条。把它写在这里会同时
		// 被 PTY 路径（agent-registry.ts 的 getDefaultArgs）读走，于是 TUI 通道也去起 ACP server。
		// ACP 的子命令由 acp-agent-launch-catalog.ts 的 buildSpawnCommand 自持。
		baseArgs: [],
		autonomousArgs: ["--approval-mode", "yolo"],
		installUrl: "https://omp.sh",
		// omp 的**默认**通道是 TUI；ACP 是可切换的第二条通道（见 agent-session-transport-selection.ts）。
		sessionTransport: "pty_terminal",
		nativeConversationSessionIdentityCaptureMethod: "managed_agent_extension_ingest",
		restorationContinuationGuardDisarmSignal: "agent_user_prompt_submit_hook",
		nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod: "not_applicable",
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

// 该 agent 的**默认**通道。注意它不再等同于「某条活会话在用的通道」——omp 可在 TUI 与 ACP
// 之间随时切换（agentId 不变）。只有「还没有活会话、要预判形态」的场景才该读这个函数
//（主页侧栏按全局 selectedAgentId 预判、设置页展示默认命令行）；凡手上有 summary 的读点，
// 一律走下面的 resolveRuntimeAgentSessionTransportFromSummary。
export function getRuntimeAgentSessionTransport(agentId: RuntimeAgentId): RuntimeAgentSessionTransport {
	return getRuntimeAgentCatalogEntry(agentId)?.sessionTransport ?? "pty_terminal";
}

// 一条活会话实际在用的通话方式——本仓库判断「这条会话长什么样」的唯一真相源。
// summary.sessionTransport 由三条通道各自在建会话时盖章；缺失（旧盘数据 / web-ui 手构造 summary）
// 时回退按 agentId 派生，与本次改动之前的行为一致。
export function resolveRuntimeAgentSessionTransportFromSummary(
	summary: Pick<RuntimeTaskSessionSummary, "agentId" | "sessionTransport">,
): RuntimeAgentSessionTransport {
	if (summary.sessionTransport !== undefined) {
		return summary.sessionTransport;
	}
	return summary.agentId === null ? "pty_terminal" : getRuntimeAgentSessionTransport(summary.agentId);
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

// 上面两个谓词的会话版。手上有 summary 时必须用这两个：agentId 版对一条切到 TUI 的 omp 会话
// 仍会返回「会话面板 / ACP」，于是 stop、输入投递、Commit·Open PR 全部会走错通道。
export function isRuntimeAgentSessionSummaryRenderedAsConversationPanel(
	summary: Pick<RuntimeTaskSessionSummary, "agentId" | "sessionTransport"> | null | undefined,
): boolean {
	if (!summary) {
		return false;
	}
	return resolveRuntimeAgentSessionTransportFromSummary(summary) !== "pty_terminal";
}

export function isRuntimeAgentSessionSummaryDrivenByAcpProtocol(
	summary: Pick<RuntimeTaskSessionSummary, "agentId" | "sessionTransport"> | null | undefined,
): boolean {
	if (!summary) {
		return false;
	}
	return resolveRuntimeAgentSessionTransportFromSummary(summary) === "acp_stdio_subprocess";
}

// 该 agent 的模型 / provider 是否由 Kanban 的 Cline provider 设置决定。会话面板里的 Cline 专属控件
// （provider 模型选择器、Cline slash 命令）只对这类会话成立：ACP agent（omp）自带模型与命令体系，
// 在它的面板上保存模型只会写到与该任务无关的全局 Cline provider 配置。
export function isRuntimeAgentModelSelectedThroughClineProviderSettings(agentId: RuntimeAgentId | null): boolean {
	return agentId !== null && getRuntimeAgentSessionTransport(agentId) === "in_process_cline_sdk";
}

// 这个 agent 的原生会话 id 是否由 kanban 在 spawn 前分配（而不是事后从 hook / 扩展 / ACP 观测）。
export function isAgentNativeConversationSessionIdAssignedByKanbanBeforeLaunch(agentId: RuntimeAgentId): boolean {
	return (
		getRuntimeAgentCatalogEntry(agentId)?.nativeConversationSessionIdentityCaptureMethod ===
		"kanban_assigned_before_agent_launch"
	);
}

// 续跑前是否要核对「这段对话正被 harness 自己的后台会话守护进程占着」（见上方同名类型）。
export function isAgentNativeConversationHoldableByHarnessBackgroundSessionDaemon(agentId: RuntimeAgentId): boolean {
	return (
		getRuntimeAgentCatalogEntry(agentId)
			?.nativeConversationHarnessBackgroundSessionDaemonOwnershipInspectionMethod ===
		"claude_code_agents_json_listing_and_stop"
	);
}

// 这个 agent 的会话能否按已记录的原生 id 续跑（续跑寻址解析器的白名单，取代原先写死的 agentId 列表）。
// 入参是 string：解析器拿到的 launchAgentId 未经 RuntimeAgentId 收窄，目录里查不到的一律视为不能。
export function canAgentResumeByRecordedNativeConversationSessionId(agentId: string): boolean {
	const captureMethod = RUNTIME_AGENT_CATALOG.find(
		(entry) => entry.id === agentId,
	)?.nativeConversationSessionIdentityCaptureMethod;
	return (
		captureMethod === "agent_hook_stdin_session_id" ||
		captureMethod === "managed_agent_extension_ingest" ||
		captureMethod === "kanban_assigned_before_agent_launch"
	);
}

// 恢复后的续跑守卫是否只能在终端提交边沿（Enter / 程序化提交）解除。
export function isRestorationContinuationGuardDisarmedOnTerminalSubmissionEdge(
	agentId: RuntimeAgentId | null,
): boolean {
	return (
		agentId !== null &&
		getRuntimeAgentCatalogEntry(agentId)?.restorationContinuationGuardDisarmSignal ===
			"terminal_submission_edge_without_reliable_user_prompt_submit_hook"
	);
}
