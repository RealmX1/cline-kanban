// PTY-backed runtime for non-Cline task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import { randomUUID } from "node:crypto";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionReclamationOutcome,
	RuntimeLastConversationProgressObservation,
	RuntimeTaskConnectionRetry,
	RuntimeTaskConversationSessionMetadata,
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionLiveness,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import {
	applySessionFacets,
	deriveSessionFacetsFromLegacyState,
	isAgentOutputQuiet as evaluateAgentOutputQuiet,
	isAwaitingUserReviewTurn,
	isParkedAwaitingDispatchedBackgroundWork,
	isSessionInActiveTurn,
	mergeSummaryWithFacets,
	resolveSessionFacets,
	VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
} from "../core/session-activity";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import {
	type AgentOutputSubstanceMemory,
	createAgentOutputSubstanceMemory,
	detectFreshSubstantiveAgentOutputFromStripped,
} from "./agent-output-substance";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
	toBracketedPasteSubmission,
} from "./agent-session-adapters";
import { materializeTaskAgentSessionForExecutionWorkingDirectory } from "./agent-session-materialization";
import {
	hasClaudeInteractivePrompt,
	hasClaudeStartupUiRendered,
	// startup readiness 的 wall-clock 兜底超时值。source-of-truth 常量名在 claude-readiness.ts
	// 仍为 claude 前缀（该文件超出本 issue 的改动范围），但该机制现由 claude 与 kimi 共用，
	// 故在此以 agent-generic 别名引入，使共享使用点读起来不含歧义。
	CLAUDE_STARTUP_READINESS_TIMEOUT_MS as STARTUP_READINESS_TIMEOUT_MS,
} from "./claude-readiness";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexInteractivePrompt, hasCodexStartupUiRendered } from "./codex-readiness";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { hasKimiInteractivePrompt, hasKimiStartupUiRendered } from "./kimi-readiness";
import {
	getDefaultOutputReactionEngine,
	type OutputReactionActions,
	type OutputReactionContext,
	type OutputReactionEngine,
	type OutputReactionSessionState,
} from "./output-reactions";
import {
	buildNetworkInterruptionContinuationLine,
	ensureNetworkInterruptionResumeInstructionsFile,
	getNetworkInterruptionResumeInstructionsPath,
} from "./output-reactions/network-interruption-continuation-instructions";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	locateTerminalInputBox,
	type TerminalInputBoxGrammar,
} from "./terminal-input-box-reader";
import { stripAnsiAndControl } from "./terminal-output-normalization";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
// 输出反应（output-reactions）扫描缓冲上限：镜像 workspace-trust 缓冲，约 16KB。
const MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS = 16_384;
// 用户近期手动输入抑制窗口：这段时间内不自动注入续跑，避免打断正在打字的用户。
const OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS = 8_000;
// RVF followup 等「程序化已提交用户轮」投递（submitTaskChatInputWhenReady）：终端 agent（Claude/Codex）
// 刚在 Stop 后、TUI 仍处于重绘/过渡态时，立即写 bracketed paste 会出现「粘贴进输入框但末尾 CR 被吞、
// 不发送」的竞态（实测 RVF followup 间歇性卡住）。故投递必须门控到提示符就绪，与
// submitConnectionDropContinuation / deferred-startup 同范式：先沉降、就绪轮询、deadline 兜底。
// 首次就绪探测前的沉降延时（给 Stop 后的 TUI 把提示符框重绘完整）。
const TASK_CHAT_INPUT_DELIVERY_SETTLE_MS = 1_000;
// 未就绪时的就绪轮询间隔。
const TASK_CHAT_INPUT_DELIVERY_RECHECK_MS = 1_500;
// 就绪轮询总时长上限：到点仍未就绪则尽力强制写一次（best-effort，行为不劣于今日的立即写）。
// 远小于 RVF prep 文件 300s TTL（rvf_prep_file.py DEFAULT_TTL_SECONDS），故即便兜底强制写，prep 仍有效。
const TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS = 60_000;
// 投递让路防饿死硬上限：deadline 之后即便用户仍在手敲，也至多再为其让路这么久，到点无条件保底强写。
// 守住「投递绝不丢」与 :88 的 best-effort 承诺——用户持续打字也不会把 RVF followup 永久饿死。
const TASK_CHAT_INPUT_DELIVERY_MAX_DEADLINE_INPUT_YIELD_MS = 15_000;
// 写后确认（CR-swallow 闭环）：两处程序化 paste 注入（RVF followup 与连接中断续跑）写完 bracketed paste 后，
// 隔这么久起一个确认 tick，检查输出是否在 paste 回显后重新流动。须 ≥ AGENT_OUTPUT_QUIET_THRESHOLD_MS（2s），
// 使被吞 CR 的 paste 在首个 tick 即读到「输出静默」；留 ~0.5s 余量避免边界抖动。
const SUBMIT_CONFIRM_DELAY_MS = 2_500;
// 未确认（输出仍静默 = CR 被吞、框卡 idle）时至多补发这么多次裸回车 `\r`；耗尽仍静默则打醒目 unconfirmed 日志收尾。
const SUBMIT_CONFIRM_MAX_RESENDS = 3;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
const STALL_SCAN_INTERVAL_MS = 15_000;
// idle-live 自愈进 Review 的阈值：终端 agent 完工却不退出、turnOwner 卡在 agent 时，scanForStalls 观测到
// 「停在交互提示符 + 距最近实质产出（lastSubstantiveOutputAt，非 lastOutputAt——光标重绘会一直刷新它）超过
// 本阈值」即主动 transitionToReview 自愈。远大于 45s 日志阈值，取保守 5 分钟：主护栏是「停在交互提示符」这一
// 强信号（agent 确已空闲、非 mid-tool / 长构建），阈值只作次要防抖，宁可晚翻也不误翻正在干活的会话。
const IDLE_STALL_AUTO_REVIEW_THRESHOLD_MS = 5 * 60_000;
// [tui-freeze] 诊断:mirror 快照序列化(@xterm/addon-serialize)是同步的,单次执行期间整个
// Node 事件循环被阻塞——所有任务的键盘输入与回显全部延迟。取快照耗时越过该阈值即打日志,
// 用于定位「restore / 就绪判定」哪个触发点在制造事件循环尖峰。
const MIRROR_SERIALIZE_WARN_THRESHOLD_MS = 50;
// 重分析攒批窗口：首个待分析字节起 50ms 后统一执行 strip + 实质输出检测 + 输出转移检测 +
// output-reaction 扫描。检测延迟上限 50ms，对下游时间常数（连接错误退避首档 4s、输出静默阈值 2s、
// 状态机翻面为人类时间尺度）可忽略；收益是 spinner 高频重绘期分析频率从每 chunk（每秒可达数十次）
// 降到 ≤20 次/秒且多 chunk 摊薄。攒批还把跨 chunk 断裂的行拼回完整行，行级签名与连接错误检测更准。
// 置 0 = 紧急逃生阀：退回逐 chunk 同步分析语义。
const OUTPUT_ANALYSIS_BATCH_WINDOW_MS = 50;
// 攒批文本上限：达到即立即 flush，封顶单窗口内存与检测延迟（洪水输出时窗口内可积累的量）。
const MAX_PENDING_OUTPUT_ANALYSIS_CHARS = 64 * 1024;
// 实质输出分类器（agent-output-substance 的 strip + 行级签名比对）在 agent 回合的**额外**节流窗口：
// 攒批已把频率压到 ≤20 次/秒，但重绘密集的 TUI 下这仍是 flush 里最贵的一项，而 lastSubstantiveOutputAt
// 的两个消费者都不需要 50ms 精度（卡片展示是分钟尺度；Validation 停留判据只问「是否落在 5s 窗口内」）。
// 故按本窗口节流实质检测＋打戳，adapter 输出转移检测与 output-reaction 扫描仍留在 50ms 攒批上（二者延迟敏感）。
//
// 取值**结构性**绑定 Validation 活跃窗口减 1s 安全余量，而非硬编码 4000：只要节流窗口 < 该活跃窗口，
// 真正持续产出的会话每轮打戳间隔就必然短于窗口，isAgentActivelyProducingOutput 绝不会读到虚假的 >5s 空档。
// 若日后有人调大 VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS，本值自动跟随，不会悄悄破坏该不变量。
const SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS = VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1_000;
// 落在节流空档里的攒批**不被丢弃**，而是原样挂进「待分析尾巴」，等窗口末尾的补分析一并判定
// （见 flushPendingOutputAnalysis 的 leading + trailing 双边节流）。本上限是该尾巴的字符封顶：
// 超限丢最旧、保留最新（真实回复总在尾部，且尾巴只服务「这段窗口里有没有新内容」这一问）。
// 它同时是节流真正的 CPU 收益来源——洪水输出下单个节流窗口能喂给分类器的字符数被钳成常数，
// 而不是「按 50ms 逐批分析全部字节」。
const MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS = 64 * 1024;

function readStallThresholdMs(): number {
	const raw = process.env.CLINE_TUI_STALL_MS;
	if (!raw) {
		return DEFAULT_STALL_THRESHOLD_MS;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_STALL_THRESHOLD_MS;
	}
	return Math.floor(parsed);
}
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	// TUI 启动 readiness 兜底时刻：在该时间点之前，session-manager 仅在 readiness
	// predicate（输入框 / 启动横幅）命中时才注入 prompt；之后回退到"任意 output 即触发"，
	// 保留旧行为防止 readiness predicate 漏识别导致 prompt 永远注不进去。null 表示当前会话
	// 不需要 gate（非 claude/kimi 或没有 deferred prompt）。claude 与 kimi 共用该兜底。
	startupReadinessDeadlineAt: number | null;
	// 独立的 wall-clock 兜底 timer：当 TUI 在一个（或被切分的）chunk 里渲染完整启动 UI、
	// 而 readiness predicate 漏识别时，后续不会再有新 chunk 触发 deadline 检查，
	// 导致 deferred prompt 永远注不进去。这个一次性 setTimeout 在到点后强制调用
	// trySendDeferredStartupInput；命中 predicate 或 session 退出时由调用方清掉。
	// claude 与 kimi 共用该兜底（kimi 启动后通常只渲染一次输入框即空闲等待输入，
	// 若该唯一渲染被 chunk 边界拆分，signal-only 判定会漏识别）。
	startupReadinessTimer: NodeJS.Timeout | null;
	// 输出反应框架（连接中断自动续跑等）。仅在开关开启且 agent 适用时非 null。
	outputReactionEngine: OutputReactionEngine | null;
	outputReactionSession: OutputReactionSessionState | null;
	// 滚动的 stripAnsiAndControl 扫描缓冲（保留换行；用于错误检测与提示符就绪判断）。
	outputReactionScanBuffer: string | null;
	// 输出反应的兜底 / 退避 attempt 定时器（同一时刻至多一个待触发）。
	outputReactionAttemptTimer: NodeJS.Timeout | null;
	// 攒批待分析的 decoded 输出文本：重分析（实质输出检测 / adapter 输出转移检测 / output-reaction
	// 扫描）按 OUTPUT_ANALYSIS_BATCH_WINDOW_MS 窗口合并执行，不再逐 chunk——spinner 每秒重绘多次时
	// 逐 chunk strip + 正则曾占满单事件循环、拖延所有任务的键盘回显（低负载 TUI 卡顿主因之一）。
	// 超过 MAX_PENDING_OUTPUT_ANALYSIS_CHARS 立即 flush 封顶内存；会话 teardown 时随定时器一并丢弃。
	pendingOutputAnalysisText: string;
	// 上述攒批窗口的一次性 flush 定时器（同一时刻至多一个待触发）。
	outputAnalysisFlushTimer: NodeJS.Timeout | null;
	// 最近一次用户手动输入时刻，用于抑制自动注入打断用户。
	lastUserInputAt: number | null;
	// 实质输出新鲜度记忆：把 TUI 周期性重绘（spinner / footer / 帮助提示）从「实质产出」剔除，
	// 只有带来「最近未见过的新词内容」的 chunk 才推进 summary.lastSubstantiveOutputAt
	// （Validation 列自动打回判据 isAgentActivelyProducingOutput 读它）。见 agent-output-substance.ts。
	agentOutputSubstanceMemory: AgentOutputSubstanceMemory;
	// 上一次真正执行实质输出分类器的时刻（仅内存态，null = 本会话尚未跑过）。按
	// SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS 节流 flushPendingOutputAnalysis 里的检测＋打戳，
	// 与同一 flush 里的 adapter 转移检测 / output-reaction 扫描解耦（后两者仍逐攒批执行）。
	lastSubstantiveOutputAnalysisAt: number | null;
	// 落在节流空档里、尚未交给实质输出分类器的原始（未 strip）输出尾巴。节流只推迟判定、绝不丢内容：
	// 曾经的实现整段丢弃空档内的攒批，于是「先 spinner chrome 吃掉配额 → 空档内产出唯一一段简短
	// 真实回复 → 随即静默」这一序列里，那段回复永远无人分析。上限见
	// MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS。空串 = 当前无待分析尾巴。仅内存态。
	deferredSubstantiveOutputAnalysisText: string;
	// 上述尾巴的「节流窗口末尾补分析」一次性定时器（同一时刻至多一个）。这是 trailing 边：
	// 回合最后一段落在空档里的产出不会再有新的 flush 来触发分析，只能靠它兜住。
	deferredSubstantiveOutputAnalysisTimer: NodeJS.Timeout | null;
	// 续跑启动后 agent 的恢复 UI（Claude --continue 的 cache past due 三选一、启动横幅、整段旧
	// transcript 重播）都不是「agent 上次响应」——此 guard 为 true 时 flushPendingOutputAnalysis
	// 不推进 lastSubstantiveOutputAt，卡片因此保留续跑前的真实响应时间，而不是被重播刷成「刚刚」。
	// 武装条件＝「本次启动会重播既有对话」：request.resumeFromTrash（全 adapter 共同的续跑触发器）
	// 或 PreparedAgentLaunch.resumesPriorAgentConversation（--resume <sessionId> / fork 等其余续跑路径，
	// 历史上只认前者、后者漏武装）。**不**按「该任务此前是否产出过」反推：崩溃后从原始 prompt 全新
	// 重跑的 auto-restart 毫无重播，武装它只会把真实新产出误冻住。
	// 清除条件仅认「用户真·继续」：writeInput（人工手敲，全 agent）、task-chat / RVF 的程序化已提交
	// 用户轮投递、或源自 UserPromptSubmit / BeforeAgent 的 hook.to_in_progress（Gemini 走 paste 恢复、
	// 不过 writeInput，必须靠该 hook 信号解除）。刻意不认重播里的 ⏺/● 前缀、不认 PostToolUse 映射的
	// to_in_progress（自动续跑旧回合的中途活动）、也不认连接中断自动续跑注入，三者都非用户继续。仅内存态。
	suppressSubstantiveOutputUntilContinues: boolean;
	// 程序化「已提交用户轮」投递（RVF followup 等）的待决就绪轮询定时器：同一时刻至多一个，
	// last-write-wins；命中就绪/deadline 写入后或 session 退出时清除。null 表示当前无待决投递。
	taskChatInputDeliveryTimer: NodeJS.Timeout | null;
	// 当前已受理、但尚未真正执行 PTY write 的 task-chat 投递完成回执。普通 task-chat 调用方仍可只取
	// synthetic summary；待答决策答案投递则等待此回执，避免把「排进定时器」误当作「已写入 PTY」。
	// 会话 teardown、last-write-wins 取代或写入异常都以 false 结算，使 durable 答案保持可重试。
	taskChatInputPtyWriteCompletion: {
		generation: number;
		resolveWrittenToPty: (writtenToPty: boolean) => void;
	} | null;
	// Claude 恢复旧会话后，真人 UserPromptSubmit 会解除广义恢复守卫，使 agent 新一轮产出与连接
	// 中断恢复恢复正常；但恢复时排队的 task-notification 可能稍晚才抵达。这个窄守卫只让
	// hooks-api 继续拦截结构化 harness 通知，绝不拦真人输入，也不参与 output-reaction 门控；
	// 首轮真人恢复回合自然 Stop 后关闭，进程退出时随 active state 一起销毁。
	interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds: boolean;
	// 投递「代际」单调计数：每次 submitTaskChatInputWhenReady 自增并被本次 attempt 捕获。
	// 清掉定时器无法取消「已过定时器、正 await resolveInteractivePromptReadiness」的在途 attempt，
	// 它 await 返回后仍会写旧文本——故 attempt 在写/重排前复查代际，被新投递取代者直接放弃，
	// 保证 last-write-wins 跨越 await 仍成立（最新消息覆盖最旧、不重复/不乱序提交）。
	taskChatInputDeliveryGeneration: number;
	// 写后确认（CR-swallow 闭环）的待决确认/补发定时器：两处程序化 paste 注入写完后，隔 SUBMIT_CONFIRM_DELAY_MS
	// 检查输出是否恢复流动；未恢复且用户未在打字时补发裸 `\r`。同一时刻至多一个；被更晚的 paste 提交或 teardown 清除。
	submitConfirmTimer: NodeJS.Timeout | null;
	// 确认「代际」单调计数：每次 writePasteSubmissionWithConfirm 自增并被本确认链捕获，被更晚的 paste 提交取代者放弃。
	submitConfirmGeneration: number;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	// Reference timestamp for the most recent stall window we have already logged.
	// Reset to null when output advances, so each new silent window gets exactly one log line.
	lastStallLoggedAt: number | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	workspaceTaskId?: string;
	taskConversationSessionMetadata?: RuntimeTaskConversationSessionMetadata;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	taskAgentPermissionMode?: AgentAdapterLaunchInput["taskAgentPermissionMode"];
	autoContinueOnConnectionDropEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	projectPath?: string;
	parentSessionId?: string;
	taskAgentSessionInitialization?: AgentAdapterLaunchInput["taskAgentSessionInitialization"];
	terminalAgentModelOverrideSettings?: AgentAdapterLaunchInput["terminalAgentModelOverrideSettings"];
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	// 初始 idle summary 即带上 idle facet，使「直接发出未经 updateSummary 的默认 summary」也自洽。
	return applySessionFacets({
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		connectionRetry: null,
		restorationContinuationGuardState: "inactive",
	});
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	// 单一写侧漏斗：经 mergeSummaryWithFacets 派发（facet 写时主真相源，详见该函数）。
	entry.summary = mergeSummaryWithFacets(entry.summary, { ...patch, updatedAt: now() });
	return entry.summary;
}

// Stage 4 全写侧反转：终端/PTY agent 写点经此从「目标 legacy state + 当刻覆写上下文」产出完整三 facet
// 写侧补丁（facet 写时主真相源；state 由 mergeSummaryWithFacets 投影回填）。connectionRetryActive 取自
// prev（写点不改 connectionRetry，故与 mergeSummaryWithFacets 合并后取值一致），agentId/pid 取本次覆写值
// （launch 设新 pid/agentId、exit/fail 设 pid:null）——使终端 agent awaiting 的 live↔exited 区分正确。
function buildTerminalFacetPatch(
	prev: RuntimeTaskSessionSummary,
	state: RuntimeTaskSessionState,
	overrides: { reviewReason: RuntimeTaskSessionReviewReason; pid: number | null; agentId: RuntimeAgentId | null },
): Partial<RuntimeTaskSessionSummary> {
	const facets = deriveSessionFacetsFromLegacyState(state, {
		reviewReason: overrides.reviewReason,
		pid: overrides.pid,
		connectionRetryActive: prev.connectionRetry != null,
		agentId: overrides.agentId,
	});
	return { turnOwner: facets.turnOwner, liveness: facets.liveness, userTurnKind: facets.userTurnKind };
}

// 「该磁盘记录声称仍有一个正在运行的、OS 级的 agent 进程」。
//   - pid 非空：终端/PTY agent 在 launch 时记录真实 pid，exit/fail 写点一律把 pid 置回 null，故「pid 非空」
//     正是「这条记录声称自己还挂着一个 OS 进程」的标记。Cline SDK 在进程内跑、pid 恒 null，天然被排除在外
//     （它的 awaiting 是 pid=null + liveness=live，属跨重启保留的合法状态，绝不能被本对账波及）。
//   - liveness 属 starting/live/retrying：agent 进程侧仍被声称在跑。`exited`/`interrupted`/`failed`/`none`
//     都表示进程侧已终结，一律不参与对账（`exited` + 等人审是设计上要跨重启保留的状态）。
const LIVENESS_VALUES_CLAIMING_RUNNING_AGENT_PROCESS: readonly RuntimeTaskSessionLiveness[] = [
	"starting",
	"live",
	"retrying",
];

function summaryClaimsRunningAgentProcess(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.pid === null || summary.pid <= 0) {
		return false;
	}
	return LIVENESS_VALUES_CLAIMING_RUNNING_AGENT_PROCESS.includes(resolveSessionFacets(summary).liveness);
}

// 从磁盘重建时，把「声称仍挂着一个正在运行的 agent 进程」的会话无条件对账为 idle。
//
// 背景：`sessions.json` 只在 graceful shutdown 落盘，且落盘的 liveness/pid 是写入那一刻的快照。
// 运行时重启会带走全部子进程，但没有任何一方观察到它们的 exit 事件，于是磁盘上的 `live` 会永久留存
// （实测曾累积到 88 条声称 live、仅 5 条进程真实存在）。这些僵尸会让卡片徽章与会话面板显示成活跃。
//
// 为什么**不**去探测那个 pid 是否还在（`process.kill(pid, 0)`）：hydrateFromRecord 重建的条目恒为
// `active: null`，而本 manager 只能通过自己 spawn 的 node-pty 会话操作 agent——writeInput / stopTaskSession /
// forceStopTaskSession / refreshTaskTerminal 全部以 `entry.active` 为前置，没有任何路径能把一个外部 pid
// 认领回来。也就是说，只要是重建出来的条目，其「进程仍在跑」的声称就**按构造不可恢复**，那个 pid 究竟
// 是否还活着与本会话能否继续毫无关系。何况 pid 存在性本身也是弱判据：重启后 pid 会被复用，探测成功只能
// 证明「此刻有某个进程占着这个数字」，不能证明它还是本会话的 agent（EPERM 判活更是直接把别人的进程认成
// 自己的）。因此判据取「不可恢复即归零」，与 recoverStaleSession 的 `active === null` 判据同源，只是把
// 它从「用户碰到该任务时按需修正」提前到磁盘重载这一单一 chokepoint。
//
// 归零后 pid 变 null，正好让 web-ui persistent-terminal-manager 的 maybeAutoResumeStaleSession 判据
// （`pid !== null` 视为「已有活 PTY、无需续跑」）恢复成立：聚焦该任务时可经 --continue 真正接回会话。
//
// 对账只改会话 facet，不碰 board 列归属：turnOwner 由 `user` 归零为 null 会让 isAwaitingUserReviewTurn
// 转假，方向是**取消** project-task-counts-live-session-overlay 的 in_progress→review 计入，不会制造它。
// 字段清空与 recoverStaleSession 保持一致（agentId 有意保留，供 canRefresh / 恢复路径路由 agent 类型），
// 额外多清一个 connectionRetry：进程都不在了，不该继续渲染重连中。
function reconcileSummaryWithUnrecoverableRunningAgentProcessClaim(
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	if (!summaryClaimsRunningAgentProcess(summary)) {
		return summary;
	}
	logTuiFreezeWarning(
		`[session-hydrate-reconcile] taskId=${summary.taskId} agentId=${summary.agentId ?? "unknown"} pid=${summary.pid} 重建会话无法认领该进程，重置为 idle`,
	);
	return mergeSummaryWithFacets(summary, {
		...buildTerminalFacetPatch(summary, "idle", {
			reviewReason: null,
			pid: null,
			agentId: summary.agentId,
		}),
		workspacePath: null,
		pid: null,
		startedAt: null,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		connectionRetry: null,
	});
}

// 「会话处于活跃回合」判据（Stage 3 余区：legacy `state` 读 → 双轴 facet 真相源）。
// 经 resolveSessionFacets 读 facet、复用共享 isSessionInActiveTurn，严格等价旧
// `state ∈ {running, awaiting_review}`（全表等价见 session-facets.test.ts），且对 live↔exited
// 折叠不敏感（exited 仍判活跃）——故迁移为纯重构、零行为漂移，不偷渡 distinction ②。
function isSummaryInActiveTurn(summary: RuntimeTaskSessionSummary): boolean {
	return isSessionInActiveTurn(resolveSessionFacets(summary));
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
		projectPath: request.projectPath,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

interface TerminalEnvironmentOptions {
	forceColor: boolean;
}

export function buildTerminalEnvironment(
	options: TerminalEnvironmentOptions,
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	const env = {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
	if (options.forceColor) {
		env.CLICOLOR = "1";
		env.CLICOLOR_FORCE = "1";
		env.FORCE_COLOR = "3";
		delete env.NO_COLOR;
		delete env.NODE_DISABLE_COLORS;
	}
	return env;
}

// Agent TUI 默认是 screen-oriented（alt-screen）app：终端主动清 scrollback 会抹掉 Kanban 想保留的
// 历史，故默认抑制 CSI 3 J。唯一例外是「显式 --no-alt-screen 的 Codex」这一 inline transcript opt-in
// 模式——它靠「CSI 3 J 清 scrollback + 整段重印」做原地刷新，此时必须放行 CSI 3 J，否则重印会叠加在
// 旧历史下面（可见翻倍）。判据基于最终启动 args，而非 agentId，因为同一个 codex 既可跑默认 alt-screen、
// 也可显式 opt-in inline。
export function shouldSuppressTerminalScrollbackErasureForAgentLaunch(
	agentId: RuntimeAgentId,
	commandArgs: readonly string[],
): boolean {
	if (agentId === "codex" && commandArgs.includes("--no-alt-screen")) {
		return false;
	}
	return true;
}

// startup readiness 的 wall-clock 兜底目前适用于 claude 与 kimi：两者都可能把启动横幅 /
// 输入框渲染到单个（或被 PTF / UTF-8 chunk 边界切分的）chunk 后即空闲等待输入，若 readiness
// 信号被拆分漏识别，deferred prompt 将永远注不进去、任务假死。codex 暂不纳入（保持既有
// signal-only 行为，避免改动其现有语义）。
const AGENT_IDS_WITH_STARTUP_READINESS_DEADLINE_FALLBACK: ReadonlySet<AgentAdapterLaunchInput["agentId"]> = new Set([
	"claude",
	"kimi",
]);

function clearStartupReadinessTimer(state: { startupReadinessTimer: NodeJS.Timeout | null }): void {
	if (state.startupReadinessTimer) {
		clearTimeout(state.startupReadinessTimer);
		state.startupReadinessTimer = null;
	}
}

function clearOutputReactionTimer(state: { outputReactionAttemptTimer: NodeJS.Timeout | null }): void {
	if (state.outputReactionAttemptTimer) {
		clearTimeout(state.outputReactionAttemptTimer);
		state.outputReactionAttemptTimer = null;
	}
}

function cancelPendingTaskChatInputDelivery(state: {
	taskChatInputDeliveryTimer: NodeJS.Timeout | null;
	taskChatInputPtyWriteCompletion: ActiveProcessState["taskChatInputPtyWriteCompletion"];
}): void {
	if (state.taskChatInputDeliveryTimer) {
		clearTimeout(state.taskChatInputDeliveryTimer);
		state.taskChatInputDeliveryTimer = null;
	}
	const completion = state.taskChatInputPtyWriteCompletion;
	state.taskChatInputPtyWriteCompletion = null;
	completion?.resolveWrittenToPty(false);
}

function settleTaskChatInputPtyWriteCompletion(
	state: ActiveProcessState,
	generation: number,
	writtenToPty: boolean,
): void {
	const completion = state.taskChatInputPtyWriteCompletion;
	if (!completion || completion.generation !== generation) {
		return;
	}
	state.taskChatInputPtyWriteCompletion = null;
	completion.resolveWrittenToPty(writtenToPty);
}

function clearSubmitConfirmTimer(state: { submitConfirmTimer: NodeJS.Timeout | null }): void {
	if (state.submitConfirmTimer) {
		clearTimeout(state.submitConfirmTimer);
		state.submitConfirmTimer = null;
	}
}

// 只清攒批 flush 定时器、保留 pending 文本——供「容量触顶 / 逃生阀走同步 flush」路径使用，
// 避免已排定的定时器对同一批文本二次 flush。
function discardPendingOutputAnalysisTimerOnly(state: { outputAnalysisFlushTimer: NodeJS.Timeout | null }): void {
	if (state.outputAnalysisFlushTimer) {
		clearTimeout(state.outputAnalysisFlushTimer);
		state.outputAnalysisFlushTimer = null;
	}
}

// 清空「节流空档待分析尾巴」及其窗口末尾补分析定时器。两处调用：分析器真正执行时（尾巴已被消费）、
// 以及会话 teardown（死会话的尾巴没有消费者）。
function discardDeferredSubstantiveOutputAnalysis(state: {
	deferredSubstantiveOutputAnalysisText: string;
	deferredSubstantiveOutputAnalysisTimer: NodeJS.Timeout | null;
}): void {
	if (state.deferredSubstantiveOutputAnalysisTimer) {
		clearTimeout(state.deferredSubstantiveOutputAnalysisTimer);
		state.deferredSubstantiveOutputAnalysisTimer = null;
	}
	state.deferredSubstantiveOutputAnalysisText = "";
}

// 会话 teardown（替换 / 停止 / 退出 / 强停 / 全体中断）时丢弃攒批中的输出分析：清 flush 定时器 +
// 清 pending 文本 + 清节流空档的待分析尾巴。死会话的分析尾巴没有消费者，绝不能套在后继会话的状态上。
function discardPendingOutputAnalysis(state: {
	outputAnalysisFlushTimer: NodeJS.Timeout | null;
	pendingOutputAnalysisText: string;
	deferredSubstantiveOutputAnalysisText: string;
	deferredSubstantiveOutputAnalysisTimer: NodeJS.Timeout | null;
}): void {
	discardPendingOutputAnalysisTimerOnly(state);
	state.pendingOutputAnalysisText = "";
	discardDeferredSubstantiveOutputAnalysis(state);
}

function clearResumeSubstantiveGuard(active: ActiveProcessState): void {
	active.suppressSubstantiveOutputUntilContinues = false;
}

function isRestorationContinuationGuardArmed(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.restorationContinuationGuardState === "restoring_agent_conversation_without_starting_new_turn" ||
		summary.restorationContinuationGuardState === "restored_agent_conversation_waiting_for_explicit_user_input"
	);
}

// 程序化「已提交用户轮」投递的就绪判别式（替代裸 boolean，使兜底写的 via= 日志能区分命中哪条通道，
// 等于免费内建复现打点）：
// - "prompt"    交互提示符框 / `>` 标记已渲染（快路径扫描缓冲或镜像快照命中）。
// - "quiet"     提示符正则整窗不命中，但 agent 已让出回合且终端字节静默 → idle 稳健兜底放行。
// - "immediate" 该终端 agent 无可门控就绪信号（droid / kiro），维持立即投递语义。
// - null        尚未就绪（继续轮询或最终走 deadline 兜底）。
type TaskChatInputDeliveryReadiness = "prompt" | "quiet" | "immediate" | null;

// 把就绪判别式翻成 [tui-freeze] task-chat-input-delivered 的 via= 标签。readiness===null 只可能
// 因 deadline 兜底走到写入，故记 deadline-fallback；其余直接映射命中的通道（免费内建复现打点）。
function resolveTaskChatInputDeliveryVia(readiness: TaskChatInputDeliveryReadiness): string {
	switch (readiness) {
		case "prompt":
			return "prompt-ready";
		case "quiet":
			return "output-quiet";
		case "immediate":
			return "immediate";
		default:
			return "deadline-fallback";
	}
}

// 取某 agent 的输入框结构语法。返回 null 表示该 agent 尚未建模输入框结构，
// 调用方回退到基于字符串正则的就绪预测。
function resolveTerminalInputBoxGrammar(agentId: RuntimeAgentId | null): TerminalInputBoxGrammar | null {
	if (agentId === "claude") {
		return CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR;
	}
	return null;
}

// 取某 agent 的 TUI 提示符就绪预测（仅 claude / codex 有交互式输入框可探测）。返回 null 表示
// 该终端 agent 没有可门控的就绪信号——调用方据此选择「立即投递」而非拖到 deadline 兜底。
function resolveTuiInteractivePromptPredicate(agentId: RuntimeAgentId | null): ((scan: string) => boolean) | null {
	if (agentId === "claude") {
		return hasClaudeInteractivePrompt;
	}
	if (agentId === "codex") {
		return hasCodexInteractivePrompt;
	}
	if (agentId === "kimi") {
		return hasKimiInteractivePrompt;
	}
	return null;
}

// 取文本最后 lineCount 行（用于把就绪判定限定在终端当前视口，排除 scrollback 历史）。
function takeLastLines(text: string, lineCount: number): string {
	if (lineCount <= 0) {
		return text;
	}
	const lines = text.split("\n");
	if (lines.length <= lineCount) {
		return text;
	}
	return lines.slice(lines.length - lineCount).join("\n");
}

export class TerminalSessionManager implements TerminalSessionService {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly stallThresholdMs = readStallThresholdMs();
	private stallScanInterval: NodeJS.Timeout | null = null;

	private trySendDeferredStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			active.workspaceTrustBuffer !== null &&
			((entry.summary.agentId === "codex" && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer)) ||
				(entry.summary.agentId === "claude" && hasClaudeWorkspaceTrustPrompt(active.workspaceTrustBuffer)));
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		// Deferred input 已经注入，wall-clock 兜底 timer 不再需要，立即清除以避免
		// 在已经 idle 的 session 上空跑回调。
		clearStartupReadinessTimer(active);
		active.session.write(deferredInput);
		logTuiFreezeWarning(
			`[tui-freeze] startup-prompt-flushed taskId=${taskId} agentId=${entry.summary.agentId} chars=${deferredInput.length}`,
		);
		return true;
	}

	// 是否为该任务挂载输出反应引擎：开关开启（默认开）且有 reaction 适用于该 agent。
	private resolveOutputReactionEngine(request: StartTaskSessionRequest): OutputReactionEngine | null {
		if (request.autoContinueOnConnectionDropEnabled === false) {
			return null;
		}
		const engine = getDefaultOutputReactionEngine();
		return engine.isActiveFor(request.agentId) ? engine : null;
	}

	private buildOutputReactionContext(entry: SessionEntry, chunkText: string): OutputReactionContext | null {
		const active = entry.active;
		if (!active) {
			return null;
		}
		const agentId = entry.summary.agentId;
		if (agentId === null) {
			return null;
		}
		return {
			agentId,
			now: now(),
			chunkText,
			scanText: active.outputReactionScanBuffer ?? "",
		};
	}

	// 把一段 decoded 输出文本并入该会话的重分析攒批。窗口首字节起 OUTPUT_ANALYSIS_BATCH_WINDOW_MS
	// 后由定时器统一 flush；累计达 MAX_PENDING_OUTPUT_ANALYSIS_CHARS 立即 flush（封顶内存与检测延迟）。
	// 窗口常量 ≤0 时同步 flush＝逐 chunk 旧语义（紧急逃生阀）。
	private appendPendingOutputAnalysisText(taskId: string, entry: SessionEntry, decodedChunk: string): void {
		const active = entry.active;
		if (!active) {
			return;
		}
		active.pendingOutputAnalysisText += decodedChunk;
		if (
			OUTPUT_ANALYSIS_BATCH_WINDOW_MS <= 0 ||
			active.pendingOutputAnalysisText.length >= MAX_PENDING_OUTPUT_ANALYSIS_CHARS
		) {
			discardPendingOutputAnalysisTimerOnly(active);
			this.flushPendingOutputAnalysis(taskId);
			return;
		}
		if (active.outputAnalysisFlushTimer !== null) {
			return;
		}
		active.outputAnalysisFlushTimer = setTimeout(() => {
			active.outputAnalysisFlushTimer = null;
			// 会话在窗口内被替换 / 停止：pending 文本属于旧 active，绝不把旧会话的输出分析
			// 套在新会话状态上（teardown 已 discard，此处按 active 身份再兜底一层）。
			if (this.entries.get(taskId)?.active !== active) {
				return;
			}
			this.flushPendingOutputAnalysis(taskId);
		}, OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
	}

	// 攒批重分析统一执行点：单次 strip 共享给实质输出检测与 output-reaction 扫描，随后跑
	// adapter 输出转移检测。agent 回合与 suppress guard 都按 flush 时刻评估——窗口 ≤50ms，
	// 与「PTY 输出先于 hook 落地」的既有竞态同量级，且由 facet 门控 / standDown 边兜底。
	private flushPendingOutputAnalysis(taskId: string): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return;
		}
		const batchText = active.pendingOutputAnalysisText;
		active.pendingOutputAnalysisText = "";
		if (batchText.length === 0) {
			return;
		}

		// lastSubstantiveOutputAt 仅在「agent 回合且本批带来新实质内容」时推进——Validation 列
		// 自动打回判据读它，从而 spinner 空转不再误判为「仍在产出」。
		// 门控 ①② 决定「本批是否算 agent 产出」（依次短路，越靠前越省）：① agent 回合；
		// ② guard 未武装（re-spawn 重播期整段跳过，连分类器都不跑、也不留尾巴）。
		// 门控 ③ 是节流，它只决定「现在判还是待会儿一起判」，**不**决定「判不判」：落在空档里的攒批
		// 挂进有上限的待分析尾巴并排定窗口末尾补分析，故真实内容绝不会因节流而被永久丢弃。
		const inAgentTurn = entry.summary.agentId !== null && resolveSessionFacets(entry.summary).turnOwner === "agent";
		const flushedAt = now();
		const batchCarriesAgentOutput = inAgentTurn && !active.suppressSubstantiveOutputUntilContinues;
		const throttleWindowElapsed =
			active.lastSubstantiveOutputAnalysisAt === null ||
			flushedAt - active.lastSubstantiveOutputAnalysisAt >= SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS;
		const shouldAnalyzeSubstance = batchCarriesAgentOutput && throttleWindowElapsed;
		const needsReactionScan = active.outputReactionEngine !== null;
		// strip 是本 flush 最贵的单项：仅在真有消费者时才做。节流空档 / guard 武装期且未挂 reaction 引擎
		// 的攒批直接跳过 strip（空档里只做常数级字符串拼接），这正是节流的主要收益来源。
		const strippedBatchText = shouldAnalyzeSubstance || needsReactionScan ? stripAnsiAndControl(batchText) : "";
		if (shouldAnalyzeSubstance) {
			this.analyzeSubstantiveOutput(entry, active, strippedBatchText, flushedAt);
		} else if (batchCarriesAgentOutput) {
			this.deferSubstantiveOutputAnalysisUntilThrottleWindowEnds(taskId, active, batchText, flushedAt);
		}

		const adapterEvent = active.detectOutputTransition?.(batchText, entry.summary) ?? null;
		if (adapterEvent) {
			const requiresEnterForCodex =
				adapterEvent.type === "agent.prompt-ready" &&
				entry.summary.agentId === "codex" &&
				!active.awaitingCodexPromptAfterEnter;
			if (!requiresEnterForCodex) {
				const summary = this.applySessionEvent(entry, adapterEvent);
				if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
					active.awaitingCodexPromptAfterEnter = false;
				}
				for (const taskListener of entry.listeners.values()) {
					taskListener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			}
		}

		if (active.outputReactionEngine !== null) {
			this.processOutputReactionChunk(taskId, entry, strippedBatchText);
		}
	}

	// 实质输出分类器的唯一执行点（节流的 leading 边＝新攒批，trailing 边＝窗口末尾补分析，都走这里）。
	// 把节流空档里攒下的待分析尾巴与本批合并判定，命中即推进 lastSubstantiveOutputAt，
	// 并把节流计时器重置到本次分析时刻。
	private analyzeSubstantiveOutput(
		entry: SessionEntry,
		active: ActiveProcessState,
		strippedBatchText: string,
		analyzedAt: number,
	): void {
		const deferredText = active.deferredSubstantiveOutputAnalysisText;
		discardDeferredSubstantiveOutputAnalysis(active);
		active.lastSubstantiveOutputAnalysisAt = analyzedAt;
		// 尾巴与本批各自 strip 后拼接，而非把尾巴混进本批一起 strip：本批的 strip 结果要共享给
		// output-reaction 扫描，而尾巴的原文早已作为它自己的攒批喂过那条扫描，重喂会污染其滚动缓冲。
		// 尾巴的边界正是既有的攒批边界，故分段 strip 与逐批 strip 的行切分完全一致。
		const analyzedText =
			deferredText.length > 0 ? stripAnsiAndControl(deferredText) + strippedBatchText : strippedBatchText;
		if (!detectFreshSubstantiveAgentOutputFromStripped(active.agentOutputSubstanceMemory, analyzedText)) {
			return;
		}
		// 取 lastOutputAt 而非 now()：实质内容随批内 chunk 到达，保持
		// lastSubstantiveOutputAt ≤ lastOutputAt 的既有关系。
		const substantiveOutputAt = entry.summary.lastOutputAt ?? analyzedAt;
		updateSummary(entry, {
			lastSubstantiveOutputAt: substantiveOutputAt,
			// 同刻记一条「对话上次推进」观测，但置信度标成**最低的那一档**——这是刮 TUI 渲染猜出来的，
			// 而它恰恰是本 bug 的病灶来源：会话重开时旧对话被重播进新 TUI、行签名记忆是全新空 Set，
			// 整段旧内容会被这里判成「新实质产出」。所以它只是「无转录、无 hook 时的兜底」：
			//   - 卡片对这一档加 `~` 前缀降级展示（isLowConfidenceLastConversationProgressEvidence）；
			//   - 回合交回用户后，持久转录探针**无需任何额外授权**就能把这一档的值拉回真相（见合并 reducer
			//     的纠偏规则；回合进行中刻意不许回拉，否则转录的天然滞后会与本分类器来回拉扯）。
			// 有转录（claude / codex / cursor）或有 hook 的 agent 会很快被更高置信的证据覆盖掉。
			lastConversationProgressObservation: {
				observedAtMs: substantiveOutputAt,
				evidenceKind: "terminal_output_heuristic_classification",
			},
		});
	}

	// 节流空档内的攒批：不跑分类器，只把原始文本挂进有上限的待分析尾巴，并排定「窗口末尾补分析」。
	// 这条 trailing 边是本设计的承重件——回合最后一段落在空档里的真实回复之后不会再有任何输出触发
	// flush，没有它就永远无人分析（曾经的丢弃语义正是这个 bug）。
	private deferSubstantiveOutputAnalysisUntilThrottleWindowEnds(
		taskId: string,
		active: ActiveProcessState,
		batchText: string,
		deferredAt: number,
	): void {
		const appendedText = active.deferredSubstantiveOutputAnalysisText + batchText;
		active.deferredSubstantiveOutputAnalysisText =
			appendedText.length > MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS
				? appendedText.slice(-MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS)
				: appendedText;
		if (active.deferredSubstantiveOutputAnalysisTimer !== null) {
			return;
		}
		const lastAnalyzedAt = active.lastSubstantiveOutputAnalysisAt ?? deferredAt;
		const remainingThrottleMs = Math.max(0, lastAnalyzedAt + SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS - deferredAt);
		active.deferredSubstantiveOutputAnalysisTimer = setTimeout(() => {
			active.deferredSubstantiveOutputAnalysisTimer = null;
			const currentEntry = this.entries.get(taskId);
			// 会话在窗口内被替换 / 停止：尾巴属于旧 active，绝不把旧会话的分析套在新会话状态上
			//（teardown 已 discard，此处按 active 身份再兜底一层，与攒批 flush 定时器同构）。
			if (!currentEntry || currentEntry.active !== active) {
				return;
			}
			// 刻意**不**复查「是否仍在 agent 回合」：入队时已确认这段文本是 agent 产出，而回合最后一段
			// 真实回复恰恰常在 turnOwner 翻回 user 之后才轮到补分析——复查会把要修的 bug 原样修回来。
			this.analyzeSubstantiveOutput(currentEntry, active, "", now());
		}, remainingThrottleMs);
	}

	// 每个新 chunk：维护滚动扫描缓冲并驱动引擎。入参已由调用方 stripAnsiAndControl
	// （保留换行）——strip 一次、与实质输出检测共享,不在此重复 strip。
	private processOutputReactionChunk(taskId: string, entry: SessionEntry, strippedChunkText: string): void {
		const active = entry.active;
		if (!active || active.outputReactionEngine === null || active.outputReactionSession === null) {
			return;
		}
		const previousBuffer = active.outputReactionScanBuffer ?? "";
		let nextBuffer = previousBuffer + strippedChunkText;
		if (nextBuffer.length > MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS) {
			nextBuffer = nextBuffer.slice(-MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS);
		}
		active.outputReactionScanBuffer = nextBuffer;

		const ctx = this.buildOutputReactionContext(entry, strippedChunkText);
		if (ctx === null) {
			return;
		}
		active.outputReactionEngine.onOutput(ctx, active.outputReactionSession, this.buildOutputReactionActions(taskId));
	}

	// 退避 / 兜底定时器触发：让引擎尝试注入续跑（或判定已恢复）。
	private runOutputReactionAttempt(taskId: string): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
			return;
		}
		active.outputReactionAttemptTimer = null;
		const ctx = this.buildOutputReactionContext(entry, "");
		if (ctx === null) {
			return;
		}
		active.outputReactionEngine.onAttempt(ctx, active.outputReactionSession, this.buildOutputReactionActions(taskId));
	}

	// 判断当前输出是否停在可注入的交互提示符（按 agent 选预测函数）。
	private isAtInteractivePromptForReaction(entry: SessionEntry): boolean {
		const active = entry.active;
		if (!active || active.outputReactionScanBuffer === null) {
			return false;
		}
		const scan = active.outputReactionScanBuffer;
		if (entry.summary.agentId === "codex") {
			return hasCodexInteractivePrompt(scan);
		}
		if (entry.summary.agentId === "claude") {
			return hasClaudeInteractivePrompt(scan);
		}
		if (entry.summary.agentId === "kimi") {
			return hasKimiInteractivePrompt(scan);
		}
		return false;
	}

	// 构造注入 / 调度 / 状态更新等副作用入口，交给 reaction 调用。
	private buildOutputReactionActions(taskId: string): OutputReactionActions {
		return {
			submitContinuationReference: () => {
				this.submitConnectionDropContinuation(taskId);
			},
			schedule: (delayMs: number) => {
				const active = this.entries.get(taskId)?.active;
				if (!active) {
					return;
				}
				clearOutputReactionTimer(active);
				const timer = setTimeout(
					() => {
						this.runOutputReactionAttempt(taskId);
					},
					Math.max(0, Math.floor(delayMs)),
				);
				timer.unref?.();
				active.outputReactionAttemptTimer = timer;
			},
			clearScheduledAttempts: () => {
				const active = this.entries.get(taskId)?.active;
				if (active) {
					clearOutputReactionTimer(active);
				}
			},
			setConnectionRetryState: (patch: RuntimeTaskConnectionRetry) => {
				this.applyConnectionRetryState(taskId, patch);
			},
			clearConnectionRetryState: () => {
				this.applyConnectionRetryState(taskId, null);
			},
			isAtInteractivePrompt: () => {
				const entry = this.entries.get(taskId);
				return entry ? this.isAtInteractivePromptForReaction(entry) : false;
			},
			canInjectNow: () => {
				const active = this.entries.get(taskId)?.active;
				if (!active) {
					return false;
				}
				return this.canInjectIntoTerminalNow(active);
			},
			isAgentOutputQuiet: () => {
				const entry = this.entries.get(taskId);
				// 静默判定（含「从未产出 → 视为静默」）统一走 src/core/session-activity.ts 的共享原语，
				// 默认阈值 AGENT_OUTPUT_QUIET_THRESHOLD_MS（2s）。
				return evaluateAgentOutputQuiet(entry?.summary.lastOutputAt ?? null, now());
			},
			isAgentTurnActive: () => {
				const entry = this.entries.get(taskId);
				if (!entry) {
					return false;
				}
				// parked（已派发后台工作、等自行恢复）时返回 false：parked 主 agent 是 {agent,live,null} 且空闲在
				// prompt，若仍判活跃，connection-drop 检测器会把「续跑」注入到一个正在等后台的会话里。这是
				// 自动续跑的 master gate（connection-drop-auto-continue 消费），故在此短路即足够拦住 parked 误注入；
				// canInjectNow 等下游守卫只在本判据放行后才可达，无需重复加 parked 检查（park 入口另会结束已开 episode）。
				if (isParkedAwaitingDispatchedBackgroundWork(entry.summary)) {
					return false;
				}
				if (isRestorationContinuationGuardArmed(entry.summary)) {
					return false;
				}
				// dual-axis facet 真相源：仅 turnOwner==="agent" 才算活跃 agent 回合（与 connection-drop
				// 检测器的主门控对齐）。会话不存在 / 已翻入 user 回合（agent 提问 / 计划评审 / 权限确认）
				// 时返回 false，让检测器让位、绝不把续跑注入到等待用户的对话框里。
				return resolveSessionFacets(entry.summary).turnOwner === "agent";
			},
			log: (message: string) => {
				logTuiFreezeWarning(`${message} taskId=${taskId}`);
			},
		};
	}

	// 实际把续跑指令注入 PTY：bracketed paste 引用续跑指令文件；Codex 追加回车。
	private submitConnectionDropContinuation(taskId: string): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return;
		}
		void ensureNetworkInterruptionResumeInstructionsFile().catch(() => {
			// 落盘失败不阻断注入：路径确定，文件稍后可补写。
		});
		const instructionsPath = getNetworkInterruptionResumeInstructionsPath();
		const line = buildNetworkInterruptionContinuationLine(instructionsPath);
		// 经写后确认闭环注入：toBracketedPasteSubmission 结尾已含单个 `\r`，若该 CR 被 TUI 重绘吞掉（框卡 idle、
		// 续跑不发送），确认 tick 会补发裸 `\r`——绝不重发整段 paste（重 paste 正是连接中断路径旧的「文本翻倍」病）。
		// Codex 置位 awaitingCodexPromptAfterEnter 由 writePasteSubmissionWithConfirm 统一处理。
		this.writePasteSubmissionWithConfirm(taskId, entry, active, line);
	}

	// 当前是否可向终端注入程序化输入：deferred-startup 仍待发、或用户近 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS（8s）
	// 内手敲过，都视为不可注入（避免抢在启动 prompt 之前 / 打断正在打字的用户）。被 output-reaction 的 canInjectNow
	// 动作（连接中断自动续跑）与 task-chat-input 投递的让路守卫共享，保证两条程序化注入路径同源判断。
	private canInjectIntoTerminalNow(active: ActiveProcessState): boolean {
		if (active.deferredStartupInput !== null) {
			return false;
		}
		if (active.lastUserInputAt !== null && now() - active.lastUserInputAt < OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS) {
			return false;
		}
		return true;
	}

	// 把 text 作为一条「已提交的用户轮」投递进活跃 terminal agent 的输入框，在 TUI 提示符就绪时
	// （带沉降 + 有界轮询 + deadline 兜底）再真正写入 PTY 并提交。同步返回当前 summary（= 已受理投递，
	// 保持调用方的 synthetic 回执契约）；无活跃 session 时返回 null。实际 PTY 写入异步发生。
	// 专用于 RVF followup 等程序化注入：Stop 刚结束、TUI 仍在重绘时立即写会出现「粘贴了但 CR 被吞、
	// 不发送」的间歇竞态，故必须门控到提示符就绪——与 submitConnectionDropContinuation / deferred-startup 同范式。
	// 注意：与 writeInput（人类手敲终端）不同，这里不记 lastUserInputAt，避免把程序化投递当成「用户正在打字」而自我抑制。
	// options.deferWhileUserTurn（默认 false）：后台自动注入（RVF followup 等，请求体带 source）置 true——遇会话处于
	// 非 agent 回合（agent 正用 AskUserQuestion / 计划评审 / 权限确认等待用户）时让位、挂起延迟，直到 turnOwner 回到
	// agent 才投递（见 runTaskChatInputDeliveryAttempt）。用户发起的发送（人类聊天 / commit·openPR 按钮，无 source）
	// 保持 false，任何回合都照常送达（含 deadline 强写）——这两个本就是故意向 review 态会话发指令。
	submitTaskChatInputWhenReady(
		taskId: string,
		text: string,
		options?: { deferWhileUserTurn?: boolean },
	): RuntimeTaskSessionSummary | null {
		return this.submitTaskChatInputWhenReadyWithPtyWriteCompletion(taskId, text, options)?.acceptedSummary ?? null;
	}

	// 待答决策答案回投需要比 synthetic「已受理」更强的完成语义：返回的 Promise 只在首次 PTY write
	// 实际执行后结算 true；会话退出/停止、投递被更晚消息取代或 write 抛错均结算 false。
	// Promise 永不 reject，调用方可以直接把 boolean 映射到 durable delivered / delivery_failed 状态。
	submitTaskChatInputWhenReadyWithPtyWriteCompletion(
		taskId: string,
		text: string,
		options?: { deferWhileUserTurn?: boolean },
	): { acceptedSummary: RuntimeTaskSessionSummary; writtenToPty: Promise<boolean> } | null {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return null;
		}
		const deferWhileUserTurn = options?.deferWhileUserTurn ?? false;
		// 程序化「已提交用户轮」投递即外部编排的 resume 动作（RVF followup）——一个 parked 会话收到投递就是被恢复，
		// 故在此清 park（单一幂等 sink unparkTaskSession，未 parked 时 no-op）。这是最可靠的清标点：纯内存、同步、
		// 不依赖任何 hook 往返，且只在 parked 期间真正有后台等待时投递才会出现（park→Stop 后无投递，故 park 稳定保持）。
		this.unparkTaskSession(taskId);
		// last-write-wins：清掉该 task 上一个未决投递的定时器，并自增代际令本次成为唯一有效投递——
		// 把已过定时器、正 await 就绪判定的在途 attempt 也一并作废（见 taskChatInputDeliveryGeneration）。
		cancelPendingTaskChatInputDelivery(active);
		// 新投递取代任何上一条 paste 提交的待决确认链（其自身写入后会再起一条新的）。
		clearSubmitConfirmTimer(active);
		const generation = ++active.taskChatInputDeliveryGeneration;
		let resolveWrittenToPty: (writtenToPty: boolean) => void = () => undefined;
		const writtenToPty = new Promise<boolean>((resolve) => {
			resolveWrittenToPty = resolve;
		});
		active.taskChatInputPtyWriteCompletion = { generation, resolveWrittenToPty };
		const deadlineAt = now() + TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS;
		const timer = setTimeout(() => {
			void this.runTaskChatInputDeliveryAttempt(taskId, text, deadlineAt, generation, deferWhileUserTurn);
		}, TASK_CHAT_INPUT_DELIVERY_SETTLE_MS);
		timer.unref?.();
		active.taskChatInputDeliveryTimer = timer;
		return { acceptedSummary: cloneSummary(entry.summary), writtenToPty };
	}

	// 一次投递 attempt：就绪命中或 deadline 兜底则写 PTY，否则隔 RECHECK_MS 再探（不消耗额外语义，只是轮询）。
	// generation 为调度时捕获的代际；写入/重排前复查，被后续投递取代（代际不再相等）者直接放弃。
	private async runTaskChatInputDeliveryAttempt(
		taskId: string,
		text: string,
		deadlineAt: number,
		generation: number,
		deferWhileUserTurn: boolean,
	): Promise<void> {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			// session 已结束：放弃投递（timer 已随 teardown 清除）。
			return;
		}
		// 进入 await 前先校验代际：已被更晚的投递取代则不再触发就绪判定（避免无谓 await 后写旧文本）。
		if (active.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		active.taskChatInputDeliveryTimer = null;
		const readiness = await this.resolveInteractivePromptReadiness(entry);
		// await 期间 session 可能已被替换/结束：复查同一 active 仍在。
		const currentEntry = this.entries.get(taskId);
		const currentActive = currentEntry?.active;
		if (!currentEntry || !currentActive || currentActive !== active) {
			return;
		}
		// await 期间可能有更晚的投递（submitTaskChatInputWhenReady）已自增代际：本 attempt 已过时，
		// 直接放弃——既不写旧文本也不重排，保证 last-write-wins 跨越 await 仍成立。
		if (currentActive.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		// Fix B 让位守卫：后台自动注入（deferWhileUserTurn=true）遇「非 agent 回合」（agent 正 AskUserQuestion /
		// 计划评审 / 权限确认等待用户）时，不写 PTY、不走下面的 deadline 强写，改排一次重探，直到 turnOwner 回到 agent
		// 才真正投递。等价把 connection-drop 注入路径的 isAgentTurnActive 让位不变量（turnOwner≠agent 就绝不打进正等
		// 用户的对话框、以免 UserPromptSubmit 把会话翻回 agent 回合）补到本路径——但仅对后台注入生效。语义为「延迟」
		// 而非「丢弃」：保住这一轮 followup（RVF CLI 不自动重试，丢弃=永久跳过一轮）。须置于 pastDeadline 判定之前，
		// 才能盖过 deadline 兜底强写。用户发起的发送（deferWhileUserTurn=false）不经此分支，任何回合照常送达。
		// ponytail: 若 agent 长期停在用户回合，此注入将每 RECHECK_MS 空探一次、无限挂起——unref 定时器、代际管理已有、
		// 会话 teardown 随 cancelPendingTaskChatInputDelivery 清除，无泄漏；且卡片此时本应在 Review，与线 A 只扫 agent 回合不冲突。
		if (deferWhileUserTurn && resolveSessionFacets(currentEntry.summary).turnOwner !== "agent") {
			this.scheduleTaskChatInputDeliveryRecheck(
				taskId,
				text,
				deadlineAt,
				generation,
				currentActive,
				deferWhileUserTurn,
			);
			return;
		}
		const pastDeadline = now() >= deadlineAt;
		if (readiness === null && !pastDeadline) {
			// 尚未就绪且未过 deadline：隔 RECHECK_MS 再探（纯轮询，不消耗额外语义）。
			this.scheduleTaskChatInputDeliveryRecheck(
				taskId,
				text,
				deadlineAt,
				generation,
				currentActive,
				deferWhileUserTurn,
			);
			return;
		}
		// A1 让路：用户近窗口在手敲（或 deferred-startup 仍待发）→ 不插进用户正在打字的那一行中间，
		// 改排一次重试；ready 与 deadline 两支都覆盖（用户正往 Claude 输入框里打字时框线仍在，ready 也会插队）。
		// 防饿死硬上限：deadline 之后再让路至多 MAX_DEADLINE_INPUT_YIELD_MS，到点无条件保底强写（投递绝不丢）。
		// 仍不写自身 lastUserInputAt（程序化投递只读人类的、不写自己的），故让路判断只受真人手敲影响。
		if (
			!this.canInjectIntoTerminalNow(currentActive) &&
			now() < deadlineAt + TASK_CHAT_INPUT_DELIVERY_MAX_DEADLINE_INPUT_YIELD_MS
		) {
			this.scheduleTaskChatInputDeliveryRecheck(
				taskId,
				text,
				deadlineAt,
				generation,
				currentActive,
				deferWhileUserTurn,
			);
			return;
		}
		// 程序化投递的是一条**已提交的用户轮**（task-chat 手动发送 / RVF followup），语义上等价于用户在
		// 终端里手敲提交，故与 writeInput 一样解除 resume substantive guard——此后 agent 的新产出才重新
		// 推进 lastSubstantiveOutputAt。刻意不下沉进 writePasteSubmissionWithConfirm：那个 writer 同时
		// 服务连接中断自动续跑（submitConnectionDropContinuation），自动恢复不是用户继续、绝不可解除 guard。
		clearResumeSubstantiveGuard(currentActive);
		// Codex 没有可供 Kanban 识别真人提交的可靠 UserPromptSubmit hook，故在这个明确的程序化提交
		// 边沿解除。Claude 必须把守卫保留到其 UserPromptSubmit hook：那条同步 hook 还要原子取出恢复期
		// 暂存的 task-notification，并作为 additionalContext 附到本次用户提交；在这里提前解除会漏掉它。
		if (currentEntry.summary.agentId === "codex") {
			this.disarmRestorationContinuationGuard(taskId);
		}
		// 就绪命中 或 deadline 兜底：经写后确认闭环写 PTY（不走 writeInput，避免把程序化投递记成 lastUserInputAt
		// 而自我抑制——与 submitConnectionDropContinuation 一致）。toBracketedPasteSubmission 结尾已含单个 CR，
		// 若该 CR 被 TUI 重绘吞掉（粘贴进框但不发送），writePasteSubmissionWithConfirm 的确认 tick 会补发裸 `\r`；
		// Codex 置位 awaitingCodexPromptAfterEnter 亦由其统一处理。
		try {
			this.writePasteSubmissionWithConfirm(taskId, currentEntry, currentActive, text);
		} catch (error) {
			settleTaskChatInputPtyWriteCompletion(currentActive, generation, false);
			const message = error instanceof Error ? error.message : String(error);
			logTuiFreezeError(
				`[tui-freeze] task-chat-input-pty-write-failed taskId=${taskId} agentId=${currentEntry.summary.agentId} error=${message}`,
			);
			return;
		}
		settleTaskChatInputPtyWriteCompletion(currentActive, generation, true);
		logTuiFreezeWarning(
			`[tui-freeze] task-chat-input-delivered taskId=${taskId} agentId=${currentEntry.summary.agentId} ` +
				`via=${resolveTaskChatInputDeliveryVia(readiness)} chars=${text.length}`,
		);
	}

	// 排一次 RECHECK_MS 后的投递重试（未就绪轮询 / A1 让路重排 / Fix B 让位重探共用），沿用捕获的 deadlineAt + generation
	// + deferWhileUserTurn（后台注入让位标记须跨重试保持，否则重探时会丢失让位语义、退回无条件强写）。
	private scheduleTaskChatInputDeliveryRecheck(
		taskId: string,
		text: string,
		deadlineAt: number,
		generation: number,
		active: ActiveProcessState,
		deferWhileUserTurn: boolean,
	): void {
		const timer = setTimeout(() => {
			void this.runTaskChatInputDeliveryAttempt(taskId, text, deadlineAt, generation, deferWhileUserTurn);
		}, TASK_CHAT_INPUT_DELIVERY_RECHECK_MS);
		timer.unref?.();
		active.taskChatInputDeliveryTimer = timer;
	}

	// 两处程序化 paste 注入（RVF followup 与连接中断续跑）的统一写入入口 + 写后确认闭环。写一次 bracketed paste
	// （末尾已含单个 CR），Codex 置位 awaitingCodexPromptAfterEnter，然后起一个确认 tick：隔 SUBMIT_CONFIRM_DELAY_MS
	// 检查输出是否在 paste 回显后重新流动——未恢复（CR 被吞、框卡 idle）且用户未在打字时补发裸 `\r`（绝不重 paste）。
	// 「真提交 vs CR 被吞」的判据对两条路径都成立：真提交 → agent 干活 → 持续产出 → 非静默；CR 被吞 → 终端回落
	// idle 框、再无字节 → 静默（见 src/core/session-activity.ts）。故确认统一用 output-quiet，不把 turnOwner 写进门控
	// （连接中断注入时 turnOwner 已是 agent，区分不了 landed/swallowed）。
	private writePasteSubmissionWithConfirm(
		taskId: string,
		entry: SessionEntry,
		active: ActiveProcessState,
		text: string,
	): void {
		active.session.write(toBracketedPasteSubmission(text));
		if (entry.summary.agentId === "codex") {
			active.awaitingCodexPromptAfterEnter = true;
		}
		// last-write-wins：清掉上一条 paste 提交的待决确认链，自增代际令本次成为唯一有效确认。
		clearSubmitConfirmTimer(active);
		const generation = ++active.submitConfirmGeneration;
		this.scheduleSubmitConfirmTick(taskId, active, generation, SUBMIT_CONFIRM_MAX_RESENDS);
	}

	// 排一个 SUBMIT_CONFIRM_DELAY_MS 后的确认/补发 tick，沿用捕获的代际与剩余补发预算。
	private scheduleSubmitConfirmTick(
		taskId: string,
		active: ActiveProcessState,
		generation: number,
		resendsLeft: number,
	): void {
		const timer = setTimeout(() => {
			this.runSubmitConfirmAttempt(taskId, generation, resendsLeft);
		}, SUBMIT_CONFIRM_DELAY_MS);
		timer.unref?.();
		active.submitConfirmTimer = timer;
	}

	// 一次确认/补发 attempt：read 输出是否恢复流动决定 confirmed / 补发裸 `\r` / 让位 / 收尾。
	// generation 为 writePasteSubmissionWithConfirm 调度时捕获的代际；被更晚的 paste 提交取代（代际不再相等）者放弃。
	private runSubmitConfirmAttempt(taskId: string, generation: number, resendsLeft: number): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			// session 已结束：放弃（teardown 已清定时器）。
			return;
		}
		if (active.submitConfirmGeneration !== generation) {
			// 被更晚的 paste 提交取代：放弃本确认链。
			return;
		}
		active.submitConfirmTimer = null;
		// 输出已恢复流动（非静默）→ 真提交（agent 在干活）或已弹出 question/permission 对话框 → 判定已落地/已推进，停。
		// 这也避免把裸 `\r` 发进对话框误答。
		if (!evaluateAgentOutputQuiet(entry.summary.lastOutputAt ?? null, now())) {
			logTuiFreezeWarning(`[tui-freeze] submit-confirmed taskId=${taskId} agentId=${entry.summary.agentId}`);
			return;
		}
		// 仍静默但用户近 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS（8s）内手敲过 → 让位、绝不替他提交（保护 stashed/在打的
		// prompt）；预算还在则再排一拍等待（不消耗预算），用户停手越过抑制窗后的下一拍才可能补发。
		if (!this.canInjectIntoTerminalNow(active)) {
			if (resendsLeft > 0) {
				this.scheduleSubmitConfirmTick(taskId, active, generation, resendsLeft);
			}
			return;
		}
		// 仍静默且可注入 → CR 被吞、框卡 idle：补发裸回车（绝不重 paste；空/已提交框上是 no-op，故万一误判已提交也无害）。
		if (resendsLeft <= 0) {
			// 预算耗尽仍未确认 → 醒目收尾日志（RVF 的 unconfirmed 仍如实反映，且有打点可查）。
			logTuiFreezeError(
				`[tui-freeze] submit-unconfirmed taskId=${taskId} agentId=${entry.summary.agentId} ` +
					`after ${SUBMIT_CONFIRM_MAX_RESENDS} resends`,
			);
			return;
		}
		active.session.write("\r");
		logTuiFreezeWarning(
			`[tui-freeze] submit-resend-cr taskId=${taskId} agentId=${entry.summary.agentId} remaining=${resendsLeft - 1}`,
		);
		this.scheduleSubmitConfirmTick(taskId, active, generation, resendsLeft - 1);
	}

	// 提示符就绪判定（多通道）：① 快路径——尚未建模输入框结构的 agent，在输出反应扫描缓冲在线时复用同步的
	// isAtInteractivePromptForReaction（便宜、可测）；② 结构判定——读镜像 buffer 行判输入框形状；
	// ③ 兜底——永远在线的全屏镜像快照（即便反应引擎关闭，也已捕获 Stop 后的最终提示符渲染），
	// 去 ANSI 后跑同一组提示符就绪预测。任一命中即就绪。
	private async resolveInteractivePromptReadiness(entry: SessionEntry): Promise<TaskChatInputDeliveryReadiness> {
		const active = entry.active;
		if (!active) {
			return null;
		}
		const predicate = resolveTuiInteractivePromptPredicate(entry.summary.agentId);
		// 无 TUI 就绪预测的终端 agent（droid / kiro 等）：没有可门控的提示符信号，
		// 维持「立即投递」语义——否则会一律拖到 deadline 兜底才写，相对就绪门控前的即时写是回归。
		if (predicate === null) {
			return "immediate";
		}
		const boxGrammar = resolveTerminalInputBoxGrammar(entry.summary.agentId);
		// ① 快路径**只给尚未建模输入框结构的 agent**（codex / kimi）。
		//
		// 它读的是 outputReactionScanBuffer——一个 MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS 的滚动窗口，
		// processOutputReactionChunk 只追加、只从左截断，**从不按回合清空**。因此它是 scrollback 形状的
		// 证据、不是「当前屏」：一次真实 idle 提示符进了窗口后，只要后续输出还没把它挤出去，agent 正在
		// 输出 / 重绘期间也会被判成就绪，投递因而写进正在重绘的 TUI——正是本特性要消除的「粘贴了但 CR
		// 被吞、不发送」竞态（与下面视口通道刻意不看 scrollback 是同一条理由）。
		// 已建模输入框语法的 agent（claude）改由下面的结构判定负责：它读当前活动屏，天然没有这个陈旧窗口。
		// 结构判定不命中时仍有视口正则通道与 quiet / deadline 兜底，不会退化成永不投递。
		if (
			boxGrammar === null &&
			active.outputReactionScanBuffer !== null &&
			this.isAtInteractivePromptForReaction(entry)
		) {
			return "prompt";
		}
		const mirror = entry.terminalStateMirror;
		// ② 结构判定（对已建模输入框语法的 agent 优先于下面的正则通道）：直接读镜像 buffer，判「屏上
		// 存在一个被两条边界线夹住、且首行以提示符开头的区域」。
		//
		// 它买到的**不是**「字形无关」——语法里同样写死了 `❯`，Claude 再换提示符字符仍要改。买到的是：
		//   ① 精度：要求整个框的形状，而不是「屏上任何位置出现一个提示符字符」。正则通道会被
		//      agent 输出里偶然出现的提示符字符钓中，把投递写进正在出输出的非就绪窗口。
		//   ② 单点：同一份语法被就绪判定 / 让路判定 / Ctrl+S 取文共用，换版本时只改一处、且有测试钉住；
		//      旧结构下这套画法知识散在正则里，2026-08-08 的事故就是它悄悄失效了没人知道。
		//   ③ 成本：只遍历 rows 行，不走 serialize（后者同步阻塞整个事件循环）。
		// 正则通道保留在下面：对尚未建模输入框的 agent 仍是唯一判据。
		if (mirror && boxGrammar) {
			const screenSnapshot = await mirror.getScreenSnapshot();
			if (locateTerminalInputBox(screenSnapshot, boxGrammar) !== null) {
				return "prompt";
			}
		}
		if (mirror) {
			const serializeStartedAtMs = now();
			// 仅按当前视口（最后 rows 行）判定就绪——历史里早先出现过的提示符框会误判「当前屏」就绪，
			// 把投递写进正处于重绘/出输出的非就绪窗口，正是本特性要消除的「粘贴了但 CR 被吞、不发送」
			// 竞态。取 viewport 快照（scrollback: 0）而非全量 getSnapshot()：serialize 是同步阻塞整个
			// 事件循环的，全量最坏 2 万行，而本判定语义上只需要活动屏；stall 扫描每 15s 对每个长思考
			// 会话走到这里，全量序列化曾是低负载 TUI 卡顿的周期性尖峰来源。
			const snapshot = await mirror.getViewportSnapshot();
			this.logMirrorSerializeIfSlow(
				entry.summary.taskId,
				"viewport",
				serializeStartedAtMs,
				snapshot.snapshot.length,
			);
			// takeLastLines + strip 对 viewport 快照是防御性 no-op 级处理，保持既有判定管线不变。
			const scan = stripAnsiAndControl(takeLastLines(snapshot.snapshot, snapshot.rows));
			if (predicate(scan)) {
				return "prompt";
			}
		}
		// A2 稳健 idle 兜底：提示符正则在该环境整窗不命中（真实 viewport 未呈现可匹配 idle 框 / mirror rows 截断）
		// 时，复用既有 idle 原语避免拖满 60s deadline。仅当 agent 已让出回合（turnOwner !== "agent"，RVF 投递时
		// 的稳定态）且终端字节已静默（isAgentOutputQuiet，≥AGENT_OUTPUT_QUIET_THRESHOLD_MS=2s，TUI 重绘已落定）
		// 才放行：turnOwner 门控保证不在 agent 回合中途的短暂静默里误投，字节静默门控规避「粘贴但 CR 被吞」竞态。
		// 这是额外的 OR 兜底，不放宽上面的视口判定（Issue 1 回归守卫保持）。降级安全：若 idle Claude 仍周期吐字节
		// （lastOutputAt 恒新鲜），此条不触发 → 行为退回今日，predicate / deadline 仍在。
		if (
			resolveSessionFacets(entry.summary).turnOwner !== "agent" &&
			evaluateAgentOutputQuiet(entry.summary.lastOutputAt ?? null, now())
		) {
			return "quiet";
		}
		return null;
	}

	// 更新 summary.connectionRetry 并广播（驱动看板徽标 / 顶栏重试列表）。
	private applyConnectionRetryState(taskId: string, patch: RuntimeTaskConnectionRetry | null): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		const current = entry.summary.connectionRetry ?? null;
		if (current === null && patch === null) {
			return;
		}
		const summary = updateSummary(entry, { connectionRetry: patch });
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
	}

	// 结束当前已开的 connection-drop reaction episode（清「重连中」徽标、停退避定时器、顺带清残留 connectionRetry）。
	// 翻入 user 回合（transitionToReview）与 park（parkTaskSessionAwaitingDispatchedBackgroundWork）共用：转换闸 /
	// isAgentTurnActive 只挡「新 episode 起不起」，对一个已 active 的 episode 必须显式 teardown 才会让位——否则
	// parked / 等审会话里仍跑着的 episode 会继续把续跑注入进去。engine 的 onUserTurnStart 即其 episode teardown 入口。
	private endActiveOutputReactionEpisode(entry: SessionEntry, taskId: string): void {
		const active = entry.active;
		if (!active || active.outputReactionEngine === null || active.outputReactionSession === null) {
			return;
		}
		const ctx = this.buildOutputReactionContext(entry, "");
		if (ctx === null) {
			return;
		}
		active.outputReactionEngine.onUserTurnStart(
			ctx,
			active.outputReactionSession,
			this.buildOutputReactionActions(taskId),
		);
	}

	// 外部编排（RVF / 自研 Kanban）置 park：标记主 agent 正在等待自己以非 native 方式派发的后台工作完成、会被外部
	// 恢复，从而在它结束本轮发出裸 Stop 时结构性抑制误发的 ready-for-review 通知。同步顺序：①校验任务存在、有活跃
	// 会话且处于 agent 回合；②经 updateSummary metadata-only 写 sidecar（不携带 facet / state → {agent,live,null}
	// 三元组与 superRefine 护栏从不被触碰）；③设 suppressAutoRestartOnExit（park 中途真退出不自动重启、免丢上下文）；
	// ④结束已开的 reaction episode（闸只挡新 episode）；⑤emit 广播（sidecar 经现有 mergeTaskSessionSummaries 到 UI）。
	// 时序保证：编排层须 await 本调用 OK 再让 agent 结束这一轮——sidecar 同步写内存 entry.summary，hooks-api 在转换
	// 前读内存 getSummary，故随后的裸 Stop 必见 parked、被单一 to_review 闸抑制。幂等：已 parked 时刷新 label 但保留
	// 原 sinceMs（重复 park 不报错，便于编排重试）。
	parkTaskSessionAwaitingDispatchedBackgroundWork(
		taskId: string,
		options: { label?: string } = {},
	): { ok: true; summary: RuntimeTaskSessionSummary } | { ok: false; error: string } {
		const entry = this.entries.get(taskId);
		if (!entry || !entry.active) {
			return { ok: false, error: `Task "${taskId}" has no active agent session to park.` };
		}
		if (resolveSessionFacets(entry.summary).turnOwner !== "agent") {
			return { ok: false, error: `Task "${taskId}" is not in an agent turn and cannot be parked.` };
		}
		const label = options.label?.trim() || undefined;
		const sinceMs = entry.summary.awaitingDispatchedBackgroundWork?.sinceMs ?? now();
		const summary = updateSummary(entry, {
			awaitingDispatchedBackgroundWork: { sinceMs, ...(label ? { label } : {}) },
		});
		entry.suppressAutoRestartOnExit = true;
		this.endActiveOutputReactionEpisode(entry, taskId);
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return { ok: true, summary: cloneSummary(summary) };
	}

	// 清 park（resume / 显式兜底 / onExit 对称清理共用，单一幂等 sink）。未 parked 即 no-op、返回当前 summary。
	// 清标经 updateSummary metadata-only 写 null（同 connectionRetry 清标，facet 三元组不变），并复位
	// suppressAutoRestartOnExit=false 恢复正常重启语义（park 期的真退出已在 onExit 的 shouldAutoRestart 处被
	// parked / wasSuppressed 守卫拦下，此处复位只影响 resume 后的后续退出）。
	unparkTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (!isParkedAwaitingDispatchedBackgroundWork(entry.summary)) {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, { awaitingDispatchedBackgroundWork: null });
		entry.suppressAutoRestartOnExit = false;
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	// 把一次会话回收的可审计结果写回 summary sidecar。UI 的「会话已被回收」标注读它——用户重进任务
	// 时必须看到明确说明（含 worktree / 提交 / 消息历史均保留），而不是一个空终端让人误以为只是加载慢。
	// metadata-only 补丁：不携带 facet / state，回收本身造成的活性变化由各自的停止路径写。
	applyAgentSessionReclamationOutcome(
		taskId: string,
		outcome: RuntimeAgentSessionReclamationOutcome,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const summary = updateSummary(entry, { agentSessionRuntimeReclamationOutcome: outcome });
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	// 某任务当前是否 parked + park 元数据（源自内存 entry.summary 的 sidecar）。RVF is-parked 查询用。
	getAwaitingDispatchedBackgroundWork(taskId: string): {
		parked: boolean;
		label: string | null;
		sinceMs: number | null;
	} {
		const entry = this.entries.get(taskId);
		const sidecar = entry?.summary.awaitingDispatchedBackgroundWork ?? null;
		if (sidecar == null) {
			return { parked: false, label: null, sinceMs: null };
		}
		return { parked: true, label: sidecar.label ?? null, sinceMs: sidecar.sinceMs };
	}

	// 手动「立即续跑」：对指定任务（若仍在连接重试）强制注入一次续跑。
	// 返回实际触发的任务 id（命中且正在重试的）。
	continueConnectionRetrySessions(taskIds: readonly string[]): string[] {
		const triggered: string[] = [];
		for (const taskId of taskIds) {
			const entry = this.entries.get(taskId);
			const active = entry?.active;
			if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
				continue;
			}
			if ((entry.summary.connectionRetry ?? null) === null) {
				continue;
			}
			const ctx = this.buildOutputReactionContext(entry, "");
			if (ctx === null) {
				continue;
			}
			active.outputReactionEngine.triggerContinueNow(
				ctx,
				active.outputReactionSession,
				this.buildOutputReactionActions(taskId),
			);
			triggered.push(taskId);
		}
		return triggered;
	}

	// 手动「移出列表 / 停止重试」：对指定任务（若仍在连接重试）结束 episode、清除重连状态。
	// 软移除——之后若再检测到新的瞬时连接错误，仍会重新进入一次新 episode。
	// 返回实际被移出的任务 id（命中且正在重试的）。
	dismissConnectionRetrySessions(taskIds: readonly string[]): string[] {
		const dismissed: string[] = [];
		for (const taskId of taskIds) {
			const entry = this.entries.get(taskId);
			const active = entry?.active;
			if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
				continue;
			}
			if ((entry.summary.connectionRetry ?? null) === null) {
				continue;
			}
			const ctx = this.buildOutputReactionContext(entry, "");
			if (ctx === null) {
				continue;
			}
			active.outputReactionEngine.triggerDismiss(
				ctx,
				active.outputReactionSession,
				this.buildOutputReactionActions(taskId),
			);
			dismissed.push(taskId);
		}
		return dismissed;
	}

	// 当前正处于连接重试的任务 id 列表（summary.connectionRetry 非空）。
	listConnectionRetryTaskIds(): string[] {
		const ids: string[] = [];
		for (const [taskId, entry] of this.entries.entries()) {
			if ((entry.summary.connectionRetry ?? null) !== null) {
				ids.push(taskId);
			}
		}
		return ids;
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			// park 是「活进程作用域」的运行时状态：从磁盘重建出来、active 为 null 的会话按定义不是「当前正在 park」。
			// graceful shutdown 经 listSummaries() 落盘的 summary 可能仍带 park sidecar（onExit 的对称清理未必在 persist
			// 前 flush），而后续重建（recoverStaleSession / startTaskSession）都走 facet-only 的 buildTerminalFacetPatch，
			// 其 mergeSummaryWithFacets 的 {...prev,...patch} 合并会保留这个 stale sidecar，使全新 agent run 恒被
			// isParkedAwaitingDispatchedBackgroundWork 误判为 parked → 真实 Stop 在 to_review 闸被误抑制、漏发一次通知。
			// 在磁盘重载这一单一 chokepoint 清掉该 optional sidecar，任何内存条目都不再带 stale marker 诞生。
			//
			// 同一 chokepoint 顺带做运行态对账：磁盘记录里声称仍挂着活 agent 进程的会话，在重建条目
			// （恒 active: null）里按构造已不可认领，故在这里就归零为 idle，而不是等用户碰到该任务时
			// 才由 recoverStaleSession 按需修正。
			this.entries.set(taskId, {
				summary: cloneSummary(
					reconcileSummaryWithUnrecoverableRunningAgentProcessClaim({
						...summary,
						awaitingDispatchedBackgroundWork: null,
					}),
				),
				active: null,
				terminalStateMirror: null,
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
				lastStallLoggedAt: null,
			});
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		const serializeStartedAtMs = now();
		const snapshot = await entry.terminalStateMirror.getSnapshot();
		this.logMirrorSerializeIfSlow(taskId, "restore", serializeStartedAtMs, snapshot.snapshot.length);
		return snapshot;
	}

	// [tui-freeze] 诊断:见 MIRROR_SERIALIZE_WARN_THRESHOLD_MS。耗时含排队等待 mirror
	// operationQueue 的部分——量的是调用方(也是事件循环)实际感受到的阻塞窗口。
	private logMirrorSerializeIfSlow(
		taskId: string,
		serializeKind: "restore" | "viewport",
		serializeStartedAtMs: number,
		snapshotChars: number,
	): void {
		const durationMs = now() - serializeStartedAtMs;
		if (durationMs >= MIRROR_SERIALIZE_WARN_THRESHOLD_MS) {
			logTuiFreezeWarning(
				`[tui-freeze] mirror-serialize taskId=${taskId} kind=${serializeKind} durationMs=${durationMs} snapshotChars=${snapshotChars}`,
			);
		}
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isSummaryInActiveTurn(entry.summary)) {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			cancelPendingTaskChatInputDelivery(entry.active);
			clearSubmitConfirmTimer(entry.active);
			discardPendingOutputAnalysis(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;
		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		await materializeTaskAgentSessionForExecutionWorkingDirectory({
			initialization: request.taskAgentSessionInitialization,
			executionWorkingDirectoryPath: request.cwd,
		});
		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			taskAgentPermissionMode: request.taskAgentPermissionMode,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
			parentSessionId: request.parentSessionId,
			taskAgentSessionInitialization: request.taskAgentSessionInitialization,
			readOnlyQuestionSession: request.taskConversationSessionMetadata?.taskConversationSessionRole === "by_the_way",
			forkLatestWorkingDirectorySession:
				request.taskConversationSessionMetadata?.taskConversationSessionContextSource ===
				"forked_from_main_current_turn",
			terminalAgentModelOverrideSettings: request.terminalAgentModelOverrideSettings,
		});

		const taskContextEnv = {
			KANBAN_TASK_ID: request.workspaceTaskId ?? request.taskId,
			KANBAN_ATTEMPT_ID: request.taskId,
			CLINE_KANBAN_TASK_ID: request.workspaceTaskId ?? request.taskId,
			CLINE_KANBAN_ATTEMPT_ID: request.taskId,
			KANBAN_TASK_CONVERSATION_SESSION_ID: request.taskId,
			KANBAN_PROJECT_PATH: request.projectPath ?? request.cwd,
			CLINE_KANBAN_PROJECT_PATH: request.projectPath ?? request.cwd,
		};
		const env = buildTerminalEnvironment({ forceColor: true }, request.env, launch.env, taskContextEnv);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		const preActiveOutputChunks: Buffer[] = [];
		const handleTaskOutput = (chunk: Buffer): void => {
			if (!entry.active) {
				preActiveOutputChunks.push(chunk);
				return;
			}

			const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
				onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
				onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
			});
			if (filteredChunk.byteLength === 0) {
				return;
			}
			entry.terminalStateMirror?.applyOutput(filteredChunk);

			// 回显 fan-out 必须先于下面的输出分析管线:分析(实质输出检测、连接错误分类等)是
			// 每 chunk 的同步 CPU 开销,排在前面会把键盘回显整体推迟——正是「低负载下 TUI 输入
			// 卡顿」的主因之一。顺序约束:filterTerminalProtocolOutput 必须最先(跨 chunk 协议
			// 状态 + OSC 应答);mirror.applyOutput 保持先于 fan-out 且同一同步 tick 内完成,
			// restore 快照握手依赖「mirror 已见到该 chunk」的不变量。分析代码不修改 filteredChunk。
			for (const taskListener of entry.listeners.values()) {
				taskListener.onOutput?.(filteredChunk);
			}

			const inAgentTurnAtChunkTime =
				entry.summary.agentId !== null && resolveSessionFacets(entry.summary).turnOwner === "agent";
			// 攒批重分析的消费者（实质输出检测 / 输出转移检测 / output-reaction 扫描）——命中任一
			// 即把本 chunk 的 decoded 文本并入攒批；shouldInspectOutputForTransition 与既有语义一致，
			// 是解码成本门，不是检测语义门。
			const hasBatchedOutputAnalysisConsumer =
				inAgentTurnAtChunkTime ||
				entry.active.outputReactionEngine !== null ||
				(entry.active.detectOutputTransition !== null &&
					(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true));
			const needsDecodedOutput =
				entry.active.workspaceTrustBuffer !== null ||
				entry.active.deferredStartupInput !== null ||
				hasBatchedOutputAnalysisConsumer;
			const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer += data;
				if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
					entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
						-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
					);
				}
				if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
					const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
					const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
					if (hasClaudePrompt || hasCodexPrompt) {
						entry.active.autoConfirmedWorkspaceTrust = true;
						const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
						entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
							const activeEntry = this.entries.get(request.taskId)?.active;
							if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
								return;
							}
							activeEntry.session.write("\r");
							// Trust text can remain in the rolling buffer after we auto-confirm.
							// Clear it so later startup/prompt checks do not match stale trust output.
							if (activeEntry.workspaceTrustBuffer !== null) {
								activeEntry.workspaceTrustBuffer = "";
							}
							activeEntry.workspaceTrustConfirmTimer = null;
						}, trustConfirmDelayMs);
					}
				}
			}
			// lastOutputAt 每段非空 chunk 都刷新（spinner 重绘亦然）——供自动续跑静默门控 / 卡顿探针 /
			// 卡片 computing 展示读取，保持每 chunk 一次 metadata-only updateSummary。重分析
			// （实质输出检测 → lastSubstantiveOutputAt、输出转移检测、output-reaction 扫描）不在
			// 每 chunk 执行——decoded 文本并入攒批，由 flushPendingOutputAnalysis 统一处理。
			updateSummary(entry, { lastOutputAt: now() });

			// Startup input is deferred until the TUI is alive so the task prompt creates a
			// persisted interactive session instead of a short-lived argv prompt run.
			//
			// claude / kimi 路径在 readiness predicate 命中之前保持等待；超过
			// startupReadinessDeadlineAt 后回退到"任意 output 即触发"，
			// 兜底 predicate 漏识别的极端 TUI 渲染，避免回归到 prompt 永远注不进去。
			if (entry.active.deferredStartupInput !== null && data.length > 0) {
				const claudeBuffer = entry.active.workspaceTrustBuffer ?? "";
				const codexReady =
					entry.summary.agentId === "codex" &&
					(hasCodexInteractivePrompt(data) ||
						hasCodexStartupUiRendered(data) ||
						(entry.active.workspaceTrustBuffer !== null &&
							(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
								hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))));
				const claudeReadyBySignal =
					entry.summary.agentId === "claude" &&
					(hasClaudeInteractivePrompt(data) ||
						hasClaudeStartupUiRendered(data) ||
						hasClaudeInteractivePrompt(claudeBuffer) ||
						hasClaudeStartupUiRendered(claudeBuffer));
				// Kimi 与 codex 同为信号驱动就绪（启动横幅 / 输入提示符重现）。
				const kimiReady =
					entry.summary.agentId === "kimi" && (hasKimiInteractivePrompt(data) || hasKimiStartupUiRendered(data));
				// wall-clock 兜底：deadline 仅对 claude/kimi 非 null（见启动处 gating），故这里无需
				// 再按 agentId 判定——deadline 是否存在本身即把兜底钳定在 claude+kimi，codex 不受影响。
				// kimi 启动横幅 / Unicode 输入框 `│ >` 可能被 chunk 边界拆分，signal-only 判定漏识别时，
				// 该兜底保证 deferred prompt 仍会在 timeout 后强制注入。
				const readyByDeadline =
					entry.active.startupReadinessDeadlineAt !== null && now() >= entry.active.startupReadinessDeadlineAt;
				if (codexReady || claudeReadyBySignal || kimiReady || readyByDeadline) {
					this.trySendDeferredStartupInput(request.taskId);
				}
			}

			if (hasBatchedOutputAnalysisConsumer && data.length > 0) {
				this.appendPendingOutputAnalysisText(request.taskId, entry, data);
			}
		};
		// 必须紧贴 spawn 且位于它之前武装：Claude 子进程一启动就可能恢复后台 task notification，
		// 继而同步触发 UserPromptSubmit hook。放在 prepareAgentLaunch 之后可避免 launch 准备失败留下假守卫；
		// 若等 spawn 返回后才写，通知又可能在守卫落定前穿过去并启动新一轮生成。
		if (request.resumeFromTrash === true) {
			const restoringSummary = updateSummary(entry, {
				restorationContinuationGuardState: "restoring_agent_conversation_without_starting_new_turn",
			});
			this.emitSummary(restoringSummary);
		}
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					handleTaskOutput(chunk);
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearStartupReadinessTimer(currentActive);
					clearOutputReactionTimer(currentActive);
					cancelPendingTaskChatInputDelivery(currentActive);
					clearSubmitConfirmTimer(currentActive);
					discardPendingOutputAnalysis(currentActive);

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					// 进程退出即结束任何「连接重试」状态，避免顶栏 / 看板把已死的 session 仍标为重连中。
					this.applyConnectionRetryState(request.taskId, null);
					// 对称清 park：parked 主 agent 的 PTY 若真的退出（崩溃 / 用户 kill），清掉残留 sidecar，避免一个已死
					// 会话仍被标为 parked。auto-restart 已在上方 shouldAutoRestart 处被 parked / wasSuppressed 守卫拦下。
					this.unparkTaskSession(request.taskId);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				...buildTerminalFacetPatch(entry.summary, "failed", {
					reviewReason: "error",
					pid: null,
					agentId: request.agentId,
				}),
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
				restorationContinuationGuardState: "inactive",
				...(request.taskConversationSessionMetadata
					? { taskConversationSessionMetadata: request.taskConversationSessionMetadata }
					: {}),
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		// 输出反应框架：仅当「连接中断自动续跑」开关开启、且有 reaction 适用于该 agent
		// （第一版为 Claude / Codex）时才挂载。挂载即异步幂等落盘续跑指令文件，确保
		// 注入时文件已存在可被 agent 读取。
		const outputReactionEngine = this.resolveOutputReactionEngine(request);
		const outputReactionSession = outputReactionEngine?.createSessionState(request.agentId) ?? null;
		if (outputReactionEngine !== null) {
			void ensureNetworkInterruptionResumeInstructionsFile().catch(() => {
				// 落盘失败不阻断续跑：注入体仍引用确定性路径，文件稍后可补写。
			});
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				// 默认抑制终端主动清 scrollback（保护 Kanban 历史）；仅当 Codex 显式 --no-alt-screen 走
				// inline transcript opt-in 时放行 CSI 3 J（该模式靠整屏重印替换旧内容，见 helper 注释）。
				suppressScrollbackErasure: shouldSuppressTerminalScrollbackErasureForAgentLaunch(
					request.agentId,
					commandArgs,
				),
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			startupReadinessDeadlineAt:
				AGENT_IDS_WITH_STARTUP_READINESS_DEADLINE_FALLBACK.has(request.agentId) && launch.deferredStartupInput
					? now() + STARTUP_READINESS_TIMEOUT_MS
					: null,
			startupReadinessTimer: null,
			outputReactionEngine,
			outputReactionSession,
			outputReactionScanBuffer: outputReactionEngine !== null ? "" : null,
			outputReactionAttemptTimer: null,
			pendingOutputAnalysisText: "",
			outputAnalysisFlushTimer: null,
			lastUserInputAt: null,
			agentOutputSubstanceMemory: createAgentOutputSubstanceMemory(),
			lastSubstantiveOutputAnalysisAt: null,
			deferredSubstantiveOutputAnalysisText: "",
			deferredSubstantiveOutputAnalysisTimer: null,
			// 凡是会重播既有对话的启动都武装。resumeFromTrash 是全 adapter 共同的续跑触发器，故在此兜底；
			// launch.resumesPriorAgentConversation 覆盖 resumeFromTrash 之外的续跑路径（Claude/Cursor 的
			// `--resume <sessionId>`、Claude/Codex 的 fork），历史上只认 resumeFromTrash，那些路径漏武装、
			// 让重播的旧 transcript 把卡片刷成「刚刚响应」。反过来，崩溃后从原始 prompt 全新重跑的
			// auto-restart 不带任何续跑旗标 → 不武装，其真实新产出照常推进时间戳。
			suppressSubstantiveOutputUntilContinues:
				request.resumeFromTrash === true || launch.resumesPriorAgentConversation === true,
			taskChatInputDeliveryTimer: null,
			taskChatInputPtyWriteCompletion: null,
			interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds:
				request.agentId === "claude" && request.resumeFromTrash === true,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;
		entry.lastStallLoggedAt = null;
		this.ensureStallScanRunning();

		// 独立的 wall-clock 兜底：claude / kimi 可能在一个 chunk 里渲染完启动 UI，而 readiness
		// predicate 漏识别（例如 TUI 文案改写、边框 / 输入框被切分到两块 chunk 里），此后不会
		// 再有 output 触发 handleTaskOutput 里的 deadline 检查。注册一次性 timer 强制
		// 在 timeout 时调用 trySendDeferredStartupInput，避免 prompt 永远注不进去。
		if (AGENT_IDS_WITH_STARTUP_READINESS_DEADLINE_FALLBACK.has(request.agentId) && launch.deferredStartupInput) {
			active.startupReadinessTimer = setTimeout(() => {
				const entryAtTimeout = this.entries.get(request.taskId);
				const activeAtTimeout = entryAtTimeout?.active;
				if (!activeAtTimeout) {
					return;
				}
				activeAtTimeout.startupReadinessTimer = null;
				this.trySendDeferredStartupInput(request.taskId);
			}, STARTUP_READINESS_TIMEOUT_MS);
		}

		const startedAt = now();
		// 恢复已有对话只重建运行时，不能改变仍待用户处理的决策种类。reviewReason="attention" 是
		// 恢复期的通用运行时成因，不足以反推出 question / permission；若让 facet 构造器自行派生，
		// 两者都会降级成 needs_input，下一次服务重启的空快照便失去安全自动恢复资格。
		const userTurnKindBeforeAgentConversationRestoration = resolveSessionFacets(entry.summary).userTurnKind;
		const pendingUserDecisionKindPreservedAcrossRestoration =
			request.resumeFromTrash === true &&
			(userTurnKindBeforeAgentConversationRestoration === "question" ||
				userTurnKindBeforeAgentConversationRestoration === "permission")
				? userTurnKindBeforeAgentConversationRestoration
				: undefined;
		updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, request.resumeFromTrash ? "awaiting_review" : "running", {
				reviewReason: request.resumeFromTrash ? "attention" : null,
				pid: session.pid,
				agentId: request.agentId,
			}),
			// buildTerminalFacetPatch 仍提供完整三元组；这里只在同一个 facet patch 内替换人轴种类，
			// 不会产生裸写单 facet 的中间态。
			...(pendingUserDecisionKindPreservedAcrossRestoration === undefined
				? {}
				: { userTurnKind: pendingUserDecisionKindPreservedAcrossRestoration }),
			// 新活体：每次真实 spawn 换一个 id。回收调度器据此判断「已落盘的期限说的还是不是同一个
			// 活体」——同 taskId 重启出来的新会话绝不会被上一个活体留下的陈旧期限误杀。
			runtimeSessionIncarnationId: randomUUID(),
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			restorationContinuationGuardState:
				request.resumeFromTrash === true
					? "restored_agent_conversation_waiting_for_explicit_user_input"
					: "inactive",
			...(request.taskConversationSessionMetadata
				? { taskConversationSessionMetadata: request.taskConversationSessionMetadata }
				: {}),
		});
		this.emitSummary(entry.summary);
		for (const chunk of preActiveOutputChunks) {
			handleTaskOutput(chunk);
		}

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && resolveSessionFacets(entry.summary).turnOwner === "agent") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			cancelPendingTaskChatInputDelivery(entry.active);
			clearSubmitConfirmTimer(entry.active);
			discardPendingOutputAnalysis(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment({ forceColor: false }, request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearStartupReadinessTimer(currentActive);
					clearOutputReactionTimer(currentActive);
					cancelPendingTaskChatInputDelivery(currentActive);
					clearSubmitConfirmTimer(currentActive);
					discardPendingOutputAnalysis(currentActive);

					const shellExitInterrupted = currentActive.session.wasInterrupted();
					const summary = updateSummary(currentEntry, {
						...buildTerminalFacetPatch(currentEntry.summary, shellExitInterrupted ? "interrupted" : "idle", {
							reviewReason: shellExitInterrupted ? "interrupted" : null,
							pid: null,
							agentId: currentEntry.summary.agentId,
						}),
						reviewReason: shellExitInterrupted ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				...buildTerminalFacetPatch(entry.summary, "failed", {
					reviewReason: "error",
					pid: null,
					agentId: null,
				}),
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			startupReadinessDeadlineAt: null,
			startupReadinessTimer: null,
			outputReactionEngine: null,
			outputReactionSession: null,
			outputReactionScanBuffer: null,
			outputReactionAttemptTimer: null,
			pendingOutputAnalysisText: "",
			outputAnalysisFlushTimer: null,
			lastUserInputAt: null,
			agentOutputSubstanceMemory: createAgentOutputSubstanceMemory(),
			lastSubstantiveOutputAnalysisAt: null,
			deferredSubstantiveOutputAnalysisText: "",
			deferredSubstantiveOutputAnalysisTimer: null,
			suppressSubstantiveOutputUntilContinues: false,
			taskChatInputDeliveryTimer: null,
			taskChatInputPtyWriteCompletion: null,
			interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds: false,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, "running", {
				reviewReason: null,
				pid: session.pid,
				agentId: null,
			}),
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isSummaryInActiveTurn(entry.summary)) {
			return cloneSummary(entry.summary);
		}

		// Preserve agentId so the server can route to the correct agent type
		// (Cline SDK vs terminal PTY) when a task is restored from trash.
		const summary = updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, "idle", {
				reviewReason: null,
				pid: null,
				agentId: entry.summary.agentId,
			}),
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		// 记录用户手动输入时刻，用于抑制自动续跑注入打断正在打字的用户。
		entry.active.lastUserInputAt = now();
		// 人工手敲（含在 Claude resume 三选一菜单里选 1/2/3、或提交新消息）是「用户真·继续」的
		// agent 无关信号：解除 resume substantive guard，此后 agent 的新产出才推进 lastSubstantiveOutputAt。
		clearResumeSubstantiveGuard(entry.active);
		// PTY 字节可能只是仍在编辑，真正的 Claude/Kimi 用户提交由 hook 解除；Codex 当前没有可靠的
		// UserPromptSubmit hook，因此只在 Enter/换行这一提交边沿解除恢复续跑守卫。
		if (entry.summary.agentId === "codex" && (data.includes(13) || data.includes(10))) {
			this.disarmRestorationContinuationGuard(taskId);
		}
		// 旧门控 `state==="awaiting_review"` → facet 真相源 isAwaitingUserReviewTurn（涵盖 live↔exited
		// 折叠、零行为漂移）。reviewReason∈{hook,attention,error} 读保留——deriveUserTurnKind 非 1:1
		// （attention→needs_input 而 needs_input 亦覆盖 null），换 userTurnKind 会改行为，留 channel-C 批次。
		if (
			entry.summary.agentId === "codex" &&
			isAwaitingUserReviewTurn(resolveSessionFacets(entry.summary)) &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		const submittedUserMessagePreview = data.includes(10) || data.includes(13) ? data.toString("utf8").trim() : "";
		if (submittedUserMessagePreview && entry.summary.taskConversationSessionMetadata) {
			const summary = updateSummary(entry, {
				taskConversationSessionMetadata: {
					...entry.summary.taskConversationSessionMetadata,
					latestUserMessagePreview: submittedUserMessagePreview,
				},
			});
			this.emitSummary(summary);
		}
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(
		taskId: string,
		reason: RuntimeTaskSessionReviewReason,
		userTurnKindOverride?: RuntimeTaskSessionUserTurnKind,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		// "hook"=agent 自然完成（Stop hook）；"manual_review"=用户经卡片悬浮按钮手动翻入审查回合；
		// "idle_stall"=scanForStalls 观测到「完工不退出的空闲 agent 回合会话」主动自愈翻入。其余成因
		// （exit/error/interrupted/attention/null）不经此入口转 review，原样返回当前 summary（no-op）。
		if (reason !== "hook" && reason !== "manual_review" && reason !== "idle_stall") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		// reviewReason 透传进 hook.to_review 事件 → 既 stamp 进 summary、又驱动 userTurnKind 派生。
		// userTurnKindOverride（B3 Claude permission 采集）随同事件下发，由 reducer 在 user 回合覆写人轴
		// （经完整 facet 三元组，不裸写单字段）。
		const summary = this.applySessionEvent(entry, {
			type: "hook.to_review",
			reviewReason: reason,
			userTurnKindOverride,
		});
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
			// 翻入 user 回合（agent 向用户提问 / 计划评审 / 权限确认）：让 connection-drop 检测器即时
			// 让位（结束残留 episode、清「重连中」徽标、停退避定时器）。这是「facet→检测器」的事件
			// 驱动输入边，兜住「PTY 输出先于 hook 落地、误起 episode」的竞态；并顺带清掉 to_review 后
			// 残留的 connectionRetry（episode 仍 active 时 endEpisode 会一并 clearConnectionRetryState），
			// 否则会话再回到 running 会让陈旧值复活成 retrying。
			this.endActiveOutputReactionEpisode(entry, taskId);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	// 记一条来自 agent 生命周期 hook 的「对话上次推进」观测（Claude Stop / PostToolUse 等，经
	// `kanban hooks ingest` 投递）。
	//
	// 它的角色是**低延迟前进**，不是权威：hook 会丢投（证据在 ~/.cline/kanban/agent-hook-delivery-failures/），
	// 所以它只被允许把值往前推，纠偏留给持久转录探针。合并规则（单调、拒收未来时刻）由
	// mergeSummaryWithFacets 统一执行，本方法只如实上报。
	//
	// **绝不可**在 to_in_progress（UserPromptSubmit）上调用：那一刻说话的是用户，不是 agent；
	// 把它算作「对话推进」就等于让用户自己的输入刷新「agent 上次回复」——正是本次要根治的那类错误。
	recordAgentLifecycleHookConversationProgress(taskId: string): RuntimeTaskSessionSummary | null {
		return this.recordLastConversationProgressObservation(taskId, {
			observedAtMs: now(),
			evidenceKind: "agent_lifecycle_hook_event",
		});
	}

	// 记一条来自**持久转录**的观测（最高置信、唯一跨会话重开仍成立的证据）。
	// 观测由 persisted-agent-transcript-last-conversation-progress-probe 读盘得出，本方法只负责写回。
	// 它是唯一能把「被重播刷到刚刚」的低置信值拉回真相的路径，纠偏授权在合并 reducer 里判定。
	recordPersistedAgentTranscriptConversationProgress(
		taskId: string,
		observation: RuntimeLastConversationProgressObservation,
	): RuntimeTaskSessionSummary | null {
		return this.recordLastConversationProgressObservation(taskId, observation);
	}

	private recordLastConversationProgressObservation(
		taskId: string,
		observation: RuntimeLastConversationProgressObservation,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const previousObservation = entry.summary.lastConversationProgressObservation ?? null;
		const summary = updateSummary(entry, { lastConversationProgressObservation: observation });
		if (summary.lastConversationProgressObservation === previousObservation) {
			// 合并 reducer 判定这条观测不改变任何东西（滞后 / 重复 / 被拒收）⇒ 不广播。
			// 周期性转录探测绝大多数时候都落在这一支，没有这道门就会平白给推流加一条恒定的空转流量。
			return cloneSummary(summary);
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string, options?: { userInitiatedResume?: boolean }): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		let summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		// 状态机翻 running 无条件；但 resume substantive guard 只在「用户真·继续」时解除——
		// 仅源自 UserPromptSubmit 的 to_in_progress 才算，PostToolUse 等自动续跑旧回合的中途活动不算，
		// 否则 Claude --continue 自动续跑一次工具调用就会误解除 guard、让重播刷 lastSubstantiveOutputAt。
		if (entry.active && options?.userInitiatedResume === true) {
			clearResumeSubstantiveGuard(entry.active);
		}
		if (options?.userInitiatedResume === true && isRestorationContinuationGuardArmed(summary)) {
			summary = updateSummary(entry, { restorationContinuationGuardState: "inactive" });
		}
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	isRestorationContinuationGuardArmed(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		return entry ? isRestorationContinuationGuardArmed(entry.summary) : false;
	}

	isRestorationHarnessGeneratedTaskNotificationInterceptionActive(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		return (
			entry !== undefined &&
			(isRestorationContinuationGuardArmed(entry.summary) ||
				entry.active?.interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds === true)
		);
	}

	completeRestorationHarnessGeneratedTaskNotificationInterceptionAfterExplicitUserTurn(taskId: string): void {
		const entry = this.entries.get(taskId);
		if (!entry?.active || isRestorationContinuationGuardArmed(entry.summary)) {
			return;
		}
		entry.active.interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds = false;
	}

	disarmRestorationContinuationGuard(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (!isRestorationContinuationGuardArmed(entry.summary)) {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, { restorationContinuationGuardState: "inactive" });
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearStartupReadinessTimer(entry.active);
		clearOutputReactionTimer(entry.active);
		cancelPendingTaskChatInputDelivery(entry.active);
		clearSubmitConfirmTimer(entry.active);
		discardPendingOutputAnalysis(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	// Stop the PTY and wait until the process group has actually exited.
	// Tries SIGTERM first; escalates to SIGKILL after the graceful window so
	// a wedged TUI cannot block a user-initiated refresh.
	async forceStopTaskSession(taskId: string, gracefulTimeoutMs = 2_000): Promise<void> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return;
		}
		const active = entry.active;
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = active.onSessionCleanup;
		active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(active);
		clearStartupReadinessTimer(active);
		clearOutputReactionTimer(active);
		cancelPendingTaskChatInputDelivery(active);
		clearSubmitConfirmTimer(active);
		discardPendingOutputAnalysis(active);
		active.session.stop();
		const gracefulDeadline = now() + gracefulTimeoutMs;
		while (now() < gracefulDeadline) {
			if (active.session.hasExited()) {
				if (cleanupFn) {
					cleanupFn().catch(() => undefined);
				}
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		if (!active.session.hasExited()) {
			active.session.stop({ force: true });
			const forceDeadline = now() + 500;
			while (now() < forceDeadline && !active.session.hasExited()) {
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}
		}
		if (!active.session.hasExited()) {
			// PTY 在 SIGKILL + 500ms 轮询后仍未退出（zombie / 容器 PID 1 等罕见场景）。
			// 记录 tui-freeze 错误，并显式释放 entry.active，让后续 startTaskSession
			// 进入 fresh-spawn 分支恢复任务，旧 PTY 进程交由 OS 回收。
			logTuiFreezeError(
				`[tui-freeze] force-kill-timeout taskId=${taskId} agentId=${entry.summary.agentId ?? "(none)"} pid=${entry.summary.pid ?? "(none)"}`,
			);
			entry.active = null;
			this.applyConnectionRetryState(taskId, null);
		}
		if (cleanupFn) {
			cleanupFn().catch(() => undefined);
		}
	}

	// User-initiated terminal refresh. Caller resolves the agent command, cwd, and
	// the card-derived prompt; we handle the stop/wait/respawn dance and emit a
	// visible scrollback banner so the user can see the refresh moment.
	async refreshTaskTerminal(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		await this.forceStopTaskSession(request.taskId, 2_000);
		const summary = await this.startTaskSession(request);
		// startTaskSession disposes the old terminal state mirror and creates a fresh one,
		// so the banner must be written AFTER the new mirror exists. Otherwise late-attach
		// viewers reattaching via the control socket would receive a restore snapshot from
		// the new mirror that never saw the banner.
		const entry = this.entries.get(request.taskId);
		if (entry) {
			const banner = Buffer.from("\r\n[kanban] Refreshing terminal session...\r\n", "utf8");
			entry.terminalStateMirror?.applyOutput(banner);
			for (const listener of entry.listeners.values()) {
				listener.onOutput?.(banner);
			}
		}
		return summary;
	}

	// 会话被回收（或进程自行退出）之后，账本条目与 summary 仍然在——回收只终止运行时、不删账本——
	// 但 entry.active 已被置空，于是 submitTaskChatInputWhenReady 无处可写、只会返回 null。
	// 「agent 提问 → 会话被回收 → 用户回来作答」这条 carry-forward 闭环要成立，必须先真的把 PTY 拉回来。
	// 复用 startTaskSession 时已存下的完整启动参数（entry.restartRequest，与崩溃自动重启同一份），
	// 并刻意覆盖两个字段：
	//   - prompt / images 清空：这是「续跑一个已有任务好回答它」，不是把原始任务 prompt 再跑一遍；
	//   - resumeFromTrash=true：走各 adapter 既有的续跑分支（--continue / --resume），同时让
	//     session-manager 武装 suppressSubstantiveOutputUntilContinues，避免整段重播的旧 transcript
	//     被误判成刚刚产出的实质输出。
	// 返回「现在是否真的有活体可投」。没有账本条目、或没有可复用的启动参数（例如 Kanban 进程重启后
	// restartRequest 这份纯内存态尚未重建）时如实返回 false，绝不假装就绪。
	async resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery(taskId: string): Promise<boolean> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return false;
		}
		if (entry.active) {
			return true;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return false;
		}
		await this.startTaskSession({
			...cloneStartTaskSessionRequest(restartRequest.request),
			prompt: "",
			images: undefined,
			resumeFromTrash: true,
		});
		return this.entries.get(taskId)?.active != null;
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			clearStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			cancelPendingTaskChatInputDelivery(entry.active);
			clearSubmitConfirmTimer(entry.active);
			discardPendingOutputAnalysis(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		// Stage 4 反转后 reducer patch 直接携带 facet（不再写 legacy state）→ 解阻塞此处旧的瞬态 patch.state
		// 读。改读 patch 的 facet：`isAwaitingUserReviewTurn(patchFacets)` 与旧 `patch.state==="awaiting_review"`
		// 逐项等价（hook.to_review + 非中断 exit → true；prompt-ready/to_in_progress 回 running 与中断 exit → false）。
		if (
			entry.active &&
			transition.changed &&
			isAwaitingUserReviewTurn({
				turnOwner: transition.patch.turnOwner ?? null,
				liveness: transition.patch.liveness ?? "none",
				userTurnKind: transition.patch.userTurnKind ?? null,
			})
		) {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureStallScanRunning(): void {
		if (this.stallScanInterval !== null) {
			return;
		}
		const interval = setInterval(() => {
			// scanForStalls 现为 async（idle-live 自愈需读全屏镜像快照）；吞掉 rejection，绝不让一次扫描异常掀翻 interval。
			void this.scanForStalls().catch(() => {});
		}, STALL_SCAN_INTERVAL_MS);
		// Don't keep Node alive just for this probe; production has other refs.
		interval.unref?.();
		this.stallScanInterval = interval;
	}

	private async scanForStalls(): Promise<void> {
		const currentTime = now();
		for (const [taskId, entry] of this.entries.entries()) {
			// parked（已派发后台工作、等自行恢复）跳过卡顿扫描：parked 主 agent 是 {agent,live,null}（active turn）
			// 且空闲在 prompt，输出基线很快过 stall 阈值，不跳过会误报 [tui-freeze] stall-detected。
			if (
				!entry.active ||
				!isSummaryInActiveTurn(entry.summary) ||
				isParkedAwaitingDispatchedBackgroundWork(entry.summary)
			) {
				entry.lastStallLoggedAt = null;
				continue;
			}
			if (entry.summary.agentId === null) {
				// Skip raw shell sessions; the stall probe is scoped to agent TUIs.
				continue;
			}
			// idle-live 自愈：完工却不退出、turnOwner 卡在 agent 的会话，距最近实质产出超阈值 + 确停在交互提示符 →
			// 主动 transitionToReview 翻入 user 回合（现有客户端 effect 随即把卡物理搬进 Review）。必须先于下方
			// lastOutputAt 基线的 log 逻辑——光标重绘让 lastOutputAt 恒新鲜，log 分支会在 elapsed<阈值处提前 continue，
			// 永远够不到这条自愈（正是本 bug 的病灶）。
			if (await this.attemptIdleStallAutoReview(taskId, entry, currentTime)) {
				entry.lastStallLoggedAt = null;
				continue;
			}
			const baseline = entry.summary.lastOutputAt ?? entry.summary.startedAt;
			if (!baseline) {
				continue;
			}
			const elapsed = currentTime - baseline;
			if (elapsed < this.stallThresholdMs) {
				entry.lastStallLoggedAt = null;
				continue;
			}
			if (entry.lastStallLoggedAt !== null && entry.lastStallLoggedAt >= baseline) {
				continue;
			}
			logTuiFreezeWarning(
				`[tui-freeze] stall-detected taskId=${taskId} agentId=${entry.summary.agentId} pid=${entry.summary.pid ?? "(none)"} state=${entry.summary.state} elapsedMs=${elapsed} thresholdMs=${this.stallThresholdMs}`,
			);
			entry.lastStallLoggedAt = baseline;
		}
	}

	// idle-live 自愈判定 + 动作。前置条件（agent 回合 / 非 parked / 有 agentId / active）已由 scanForStalls 保证。
	// 命中两条独立门控才翻转：
	//  ① 距最近「实质产出」超阈值——用 lastSubstantiveOutputAt 而非 lastOutputAt（光标重绘一直刷新后者、会永久压住
	//     计时器，正是本 bug 的病灶）；lastSubstantiveOutputAt 缺失时回退 startedAt。这是次要防抖。
	//  ② 当前确实停在交互提示符——走 resolveInteractivePromptReadiness 的 "prompt" 分支，它经「永远在线的全屏镜像
	//     快照」判定，与 connection-drop 反应引擎是否挂载解耦（isAtInteractivePromptForReaction 依赖的扫描缓冲仅在
	//     autoContinueOnConnectionDropEnabled 开启时在线，用它作主护栏会把自愈错误耦合到那个无关开关）。只接受
	//     "prompt"——"immediate"（无提示符预测的 droid/kiro）/"quiet"（其门控要求 turnOwner≠agent，本路径永不触发）
	//     太宽，保守跳过。这是防「安静但在干活（mid-tool / 长构建，此时渲染的是 spinner 而非输入框）」误报的主信号。
	// 翻转后 turnOwner=user，下轮 scanForStalls 的 isSummaryInActiveTurn 转 false 不再命中——自限、不重复搬列。
	// 返回是否已翻转（true → 调用方跳过本 entry 后续 log 逻辑）。
	private async attemptIdleStallAutoReview(
		taskId: string,
		entry: SessionEntry,
		currentTime: number,
	): Promise<boolean> {
		// agent 回合专属：scanForStalls 顶部 gate 用的 isSummaryInActiveTurn 等价旧 state∈{running,awaiting_review}，
		// 对 user 回合（awaiting_review）也为 true——若不在此另加 turnOwner==="agent" 强门控，翻入 review 后每轮扫描
		// 都会再次进来、重复打 stall-auto-review 日志并空跑镜像读（transitionToReview 的 reducer 虽会空转、状态不变，
		// 但日志刷屏 + 无谓 IO）。此守卫即自限的真正闸门：翻转后 turnOwner=user，下轮在此直接返回。
		if (resolveSessionFacets(entry.summary).turnOwner !== "agent") {
			return false;
		}
		const substantiveBaseline = entry.summary.lastSubstantiveOutputAt ?? entry.summary.startedAt;
		if (!substantiveBaseline || currentTime - substantiveBaseline <= IDLE_STALL_AUTO_REVIEW_THRESHOLD_MS) {
			return false;
		}
		let readiness: TaskChatInputDeliveryReadiness;
		try {
			readiness = await this.resolveInteractivePromptReadiness(entry);
		} catch {
			// 镜像快照读取抖动不应打断整轮 stall 扫描：本轮跳过自愈，下轮再判。
			return false;
		}
		if (readiness !== "prompt") {
			return false;
		}
		// await 期间会话可能已结束 / 已被别的路径翻出 agent 回合：翻转前复查仍是活跃 agent 回合，避免误翻。
		const current = this.entries.get(taskId);
		if (!current || !current.active || resolveSessionFacets(current.summary).turnOwner !== "agent") {
			return false;
		}
		const idleMs = currentTime - substantiveBaseline;
		logTuiFreezeWarning(
			`[tui-freeze] stall-auto-review taskId=${taskId} agentId=${current.summary.agentId} pid=${current.summary.pid ?? "(none)"} idleMs=${idleMs} reason=idle_stall`,
		);
		this.transitionToReview(taskId, "idle_stall");
		return true;
	}

	dispose(): void {
		if (this.stallScanInterval !== null) {
			clearInterval(this.stallScanInterval);
			this.stallScanInterval = null;
		}
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			lastStallLoggedAt: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		// parked 会话的 PTY 退出不自动重启：重启会拿原始 prompt 起一个全新 agent，丢掉「我派发了后台、正在等」的
		// 上下文。park 入口已设 suppressAutoRestartOnExit=true（上面的 wasSuppressed 通常已拦下），此处再读 parked
		// 作 belt-and-suspenders，覆盖 suppress 因故被提前消费却仍 parked 的情形。
		if (isParkedAwaitingDispatchedBackgroundWork(entry.summary)) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
