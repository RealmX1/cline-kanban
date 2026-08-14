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
	RuntimeTaskTerminalDeliveryContention,
	RuntimeTaskTurnCheckpoint,
	TerminalDeliveryFailureReason,
	TerminalDeliveryStatus,
	TerminalInputBoxStashFidelity,
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
	BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN,
	prepareAgentLaunch,
	toBracketedPasteFramingWithoutTrailingSubmit,
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
import { backfillFoldedPastePlaceholdersFromPasteLedger } from "./terminal-input-box-folded-paste-placeholder-backfill";
import {
	createTerminalInputBoxOccupancyTrackerState,
	type ProgrammaticDeliveryInputBoxContentionVerdict,
	recordTerminalInputBytesIntoOccupancyTracker,
	resetTerminalInputBoxOccupancyTrackerComposition,
	resolveProgrammaticDeliveryInputBoxContention,
	resolveTerminalInputBoxOccupancy,
	type TerminalInputBoxOccupancy,
	type TerminalInputBoxOccupancyTrackerState,
} from "./terminal-input-box-occupancy";
import {
	CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR,
	locateTerminalInputBox,
	readTerminalInputBox,
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
// 就绪轮询总时长上限：到点仍未就绪即转终态 delivery_failed{terminal_prompt_readiness_timeout}。
// 这里曾经是「尽力强制写一次」，形态 3 把它换成了诚实失败——TUI 从没就绪过时硬写，只是把文本泼进一个
// 未知形态的界面，而回执还说送达了。结构判定命中通常只要 1–3s，等满整个 deadline 意味着这个终端确实
// 不在能收消息的状态。仍远小于 RVF prep 文件 300s TTL（rvf_prep_file.py DEFAULT_TTL_SECONDS），
// 故调用方拿到失败后换新 key 重投时 prep 仍然有效。
const TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS = 60_000;
// 人类争用输入框时的让路预算：deadline 之后至多再为人类让路这么久，到点转终态
// delivery_failed{human_terminal_contention_timeout}。
//
// 旧实现在这里做的是「到点**无条件保底强写**」，理由是旧不变量「投递绝不丢」。那条不变量已被替换：
// 把 paste 插进人类打了一半的那一行，是比丢一条投递更坏的结果——它会把两段互不相干的文本拼成一条
// 消息提交给 agent，而人类那半句再也拿不回来。新不变量是「投递结果绝不撒谎 + 可重投」：到点诚实
// 失败，RVF 拿到 human_terminal_contention_timeout 自行择机重投（那也正是「人在改这个仓库时，
// 这一轮评审本就不该跑」的语义）。
const TASK_CHAT_INPUT_DELIVERY_MAX_HUMAN_CONTENTION_YIELD_MS = 15_000;
// 「人此刻在不在这个终端跟前」的判据窗：距上次向**这个终端**手敲已超过它，就按人不在场处理。
// 取分钟量级而不是 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS 那 8 秒：8 秒判的是「正在打字」，
// 这里判的是「人还在不在」——打字停顿几十秒的人显然还在，只是在想。
//
// 判据对争用分层的两个分支恰好都对：框非空 + 刚敲过 = 人正在打，绝不动他的框；
// 框非空 + 很久没敲 = 人走开了、留了半句残字在框里，此时自动暂存抢占才是对他有利的处理。
const HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS = 5 * 60_000;
// Fix B 让位（agent 停在模态待答，见 runTaskChatInputDeliveryAttempt）的**饿死上限**。
// 没有它就是 2026-08-08 那 49 分钟事故的第三条根因：让位分支置于 deadline 判定之前且无上限，
// 于是 deadline 强写永远够不到，投递每 RECHECK_MS 空探一次、既不落地也不报错、无限挂起。
// 到点转终态 delivery_failed{agent_awaiting_user_decision_timeout}——诚实失败远好于永远沉默。
const TASK_CHAT_INPUT_DELIVERY_MAX_USER_TURN_YIELD_MS = 120_000;
// Fix B 让位只认「agent 真的在等用户拍板」这几种模态待答。
// 收窄的理由（恢复 Fix B 的原始意图）：其 commit 正文写的是「agent 正 AskUserQuestion / 计划评审 /
// 权限确认等待用户」，但实现用的是 turnOwner !== "agent"，把 `review`（agent 自然完工、输入框空闲）
// 也一并纳入了——而 `review` 恰恰是 RVF followup 的**目标态**，于是每次都让位、永不投递。
const MODAL_USER_DECISION_TURN_KINDS = new Set<RuntimeTaskSessionUserTurnKind>([
	"question",
	"plan_review",
	"permission",
	"needs_input",
]);
// 写后确认（CR-swallow 闭环）：两处程序化 paste 注入（RVF followup 与连接中断续跑）写完 bracketed paste 后，
// 隔这么久起一个确认 tick，检查输出是否在 paste 回显后重新流动。须 ≥ AGENT_OUTPUT_QUIET_THRESHOLD_MS（2s），
// 使被吞 CR 的 paste 在首个 tick 即读到「输出静默」；留 ~0.5s 余量避免边界抖动。
const SUBMIT_CONFIRM_DELAY_MS = 2_500;
// 未确认（输出仍静默 = CR 被吞、框卡 idle）时至多补发这么多次裸回车 `\r`；耗尽仍静默则打醒目 unconfirmed 日志收尾。
const SUBMIT_CONFIRM_MAX_RESENDS = 3;
// 整条确认链（含「用户正在手敲」让位重排）自**提交 CR 写入**起算的绝对收敛上界（等摄入证据那一段在它之前，
// 单独计入最坏预算，见下）。
// 单靠补发预算兜不住：让位重排刻意不消耗预算（用户停手后仍要留着预算把被吞的回车补上），
// 于是用户持续打字即可让确认链无限重排，回执永远停在 accepted_pending_submit_confirmation——
// 这是 2026-08-08「永远没有结论」那类缺陷在确认链上的残余形态。到点无论卡在哪一支都诚实收尾。
// 取值与投递阶段的人类打字让路预算 TASK_CHAT_INPUT_DELIVERY_MAX_DEADLINE_INPUT_YIELD_MS 一致（同为
// 跨仓契约里「人类打字让路」那一档），且 > 补发预算 SUBMIT_CONFIRM_DELAY_MS × (MAX_RESENDS + 1) = 10s，
// 故纯静默路径的收尾时机不变，本上界只对被让位拖长的链生效。
const SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS = 15_000;
// 形态 2（粘贴进框但回车被吞）的**根治**：bracketed paste 的框架与提交用的 CR 分两次写，第二次以
// 「TUI 已摄入这段 paste」为门。旧实现把 `ESC[200~…ESC[201~CR` 拼在同一次 write 里，TUI 在重绘中途
// 一次性收到整串时会把末尾 CR 连同 `ESC[201~` 一起吞掉。补发裸 CR 的确认链自此退居真正的 backstop：
// 它兜的是「摄入证据出现了、CR 也发了、但 TUI 仍没提交」这类残余，而不再是主机制。
//
// 摄入证据取「PTY 有新输出到达」（TUI 收下 paste 必然回显或重绘），**不做文本匹配**：≥4 行的粘贴会被
// 折叠成 `[Pasted text #N +M lines]`，屏上根本没有原文可比对。
const PASTE_INGESTION_EVIDENCE_POLL_BEFORE_SUBMIT_MS = 60;
// 等摄入证据的预算。到点仍无证据也照发 CR：那时的行为不劣于旧实现（旧实现连等都不等），且确认链仍在
// 后面兜底。故本门只消掉「同 chunk 到达即被吞」这一确定条件，不引入新的挂起点。
const PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS = 1_500;
// 一条程序化投递从受理到必然落定的最坏预算：就绪等待 deadline + 二选一让路里更长的那条 +
// 等 paste 摄入证据的预算（分离写引入，确认链自 CR 写入才起算，故这一段要单独计入）+
// 确认链真正的收敛上界（补发预算与绝对收敛上界取大者——后者正是为「让位重排不消耗补发预算」补的兜底，
// 只看补发预算会低估）。导出是给 runtime 启动清扫当「这条 pending 还可能有人在正常投递吗」的判据用的。
//
// 必须由上面这些常量**算**出来而不是写死一个数字：谁调大让路预算或收敛上界却漏改它，清扫就会开始把
// 并存实例的在途投递判成 delivery_failed，而终态写一次即定 —— 那种假失败事后不可纠正。
// 当前取值 196.5s，= 60s 就绪 + 120s 模态待答让位 + 1.5s 等摄入证据 + 15s 确认链收敛上界。
// 清扫阈值只能往保守（更大）一侧偏：早判一秒就是假失败，晚判一秒只是回执慢一秒。
export const TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS =
	TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS +
	Math.max(TASK_CHAT_INPUT_DELIVERY_MAX_USER_TURN_YIELD_MS, TASK_CHAT_INPUT_DELIVERY_MAX_HUMAN_CONTENTION_YIELD_MS) +
	PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS +
	Math.max(SUBMIT_CONFIRM_DELAY_MS * (SUBMIT_CONFIRM_MAX_RESENDS + 1), SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS);
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
// Ctrl+S 暂存前的镜像沉降窗。击键 → PTY → TUI 重绘 → 输出 → 服务端镜像这条链上有几十毫秒延迟，
// 用户敲完最后一个字符立刻按 Ctrl+S 时，那几个字符可能还没画进镜像。读框前先等**终端输出**与
// **人类击键**双双静默这么久，让重绘落定（两条都要，理由见
// waitForTerminalMirrorToSettleBeforeInputBoxRead）。取值远小于 AGENT_OUTPUT_QUIET_THRESHOLD_MS
// （2s，那是「agent 是否在干活」的尺度）——这里问的只是「上一次重绘画完了没有」，是按键响应的尺度。
const TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_QUIET_MS = 150;
// 沉降等待的总预算。agent 正在刷 spinner 时字节永远不会静默，等不到就按现状读——**绝不**因为等不到
// 静默就拒绝暂存：那等于把用户打了一半的输入扣在框里不给存，而 Ctrl+S 是用户主动按下的。
const TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_MAX_WAIT_MS = 750;
const TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_POLL_MS = 50;
// Ctrl+S（DC3）。写成转义：这个字节在编辑器里不可见，字面量形式极易在复制粘贴中被悄悄弄丢。
const TERMINAL_STASH_KEY_SEQUENCE = "\u0013";

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
	// PTY 输出 chunk 到达序号，单调自增。用途只有一个：给「bracketed paste 已被 TUI 摄入」当证据——
	// 写完 paste 框架后序号有推进 ⇒ TUI 已回显/重绘 ⇒ 这时再补提交用的 CR 才不会与 `ESC[201~` 同 chunk
	// 被吞掉（见 PASTE_INGESTION_EVIDENCE_*）。刻意不用 summary.lastOutputAt 的时间戳：同毫秒内到达的
	// 两段输出时间戳相等，会被误读成「没有新输出」。仅内存态。
	ptyOutputChunkArrivalSequenceNumber: number;
	// 当前在途程序化投递的**诚实回执登记**：谁在等这条投递的结论、取消要认哪个 idempotency key、
	// 以及它此刻走到了哪一步。至多一个（单飞槽，与 taskChatInputDeliveryGeneration 同源 last-write-wins）。
	// null 表示当前没有任何等待结论的程序化投递。仅内存态——runtime 重启后由账本启动清扫兜底。
	programmaticDeliveryReceipt: PendingProgrammaticDeliveryReceipt | null;
	// 输入侧字节跟踪：人类往这个终端敲进去了什么、提交了没有、被 TUI 折叠掉的粘贴原文是什么。
	// 只由 writeInput 喂养，因此只看得见人类输入——程序化投递直写 session.write，不会把自己
	// 记成「用户正在打字」。判空与粘贴账本的语义见 terminal-input-box-occupancy.ts。仅内存态。
	inputBoxOccupancyTracker: TerminalInputBoxOccupancyTrackerState;
	// 这条 PTY 一生中有没有**至少一次**在屏上定位到过输入框。单调置位、永不复位——它衡量的不是
	// 「此刻框在哪」，而是「读屏这只眼睛对这条会话到底管不管用」。
	//
	// 用途只有一个，见 resolveProgrammaticDeliveryInputBoxContentionForTask：区分「读屏给不出结论」
	// 的两种成因。恒为 false ⇒ 该 agent 压根没建模输入框语法（codex / kimi / droid，
	// resolveTerminalInputBoxGrammar 返回 null）或这套镜像在本环境从来读不出框 ⇒ 读屏这一路对它
	// 是**结构性缺席**而非异常，判空只能全交给输入侧字节跟踪，否则它们的程序化投递会 100% 挂到
	// 预算耗尽。为 true ⇒ 同一条会话此前明明读得出框、这一帧却读不出（TUI 正在重绘 / 框被全屏输出
	// 盖住）⇒ 这是**瞬态异常**，可以安全地挂起等下一拍重读。
	hasEverLocatedTerminalInputBoxOnScreen: boolean;
	// 这条 PTY「代」的稳定标识，创建时生成、此后不变。refresh / 自动重启会整体换掉 entry.active
	// （连同 terminalStateMirror），于是任何**跨 await 的多步链路**都必须能判定「我手上这份读数还
	// 属于当前这条会话吗」。manager 内部靠对象身份即可（active !== capturedActive），但 manager
	// 之外的调用方（runtime-api）不该去摸 entries 结构，这个字符串就是给它们的等价物：
	// 取文时拿到、清框时回传，对不上就必须失败而不是照打。仅内存态。
	terminalSessionIncarnationToken: string;
}

// 争用抢占的执行者：把人类未提交的输入无损暂存进 Prompt Library，并清空输入框。
//
// 由调用方（runtime-api）注入而不是 manager 自己实现：写库要 workspace 作用域与跨进程文件锁，
// 那是 manager 够不到、也不该够到的层。manager 只负责判定「此刻该不该抢占」，不负责怎么存。
//
// 返回值必须诚实：true 仅当正文确实入库**且**框确实被清。其余一切（库写失败 / 同一 task 上已有
// 一次暂存在跑 / 读框到清框之间会话已换代 / 屏上文本无法被击键跟踪佐证）一律 false —— 投递退回
// 挂起继续等，绝不把「没存成」当作已放行而照写，那正是这条工作流要根除的撒谎。
export type ProgrammaticDeliveryPreemptiveInputBoxStashHandler = (taskId: string) => Promise<boolean>;

// manager 在纯判据函数 resolveProgrammaticDeliveryInputBoxContention 的三个结论之外多出来的一个：
// 「这一帧根本读不出框，而输入侧同时是瞎的」。它进不了那个纯函数，因为判据来自 manager 独有的会话
// 状态（hasEverLocatedTerminalInputBoxOnScreen——该纯函数拿到的 occupancy 里没有、也不该有这条
// 「这条会话的读屏一贯管不管用」的历史）。行为与 screen_text_uncorroborated_… 完全一致（挂起、
// 绝不抢占），单列一个名字只为让日志说的是实话：那一条说的是「屏上有字但佐证不了」，这一条说的是
// 「屏上什么都读不到」，两者的补救方向不同。
type TaskChatInputDeliveryContentionVerdict =
	| ProgrammaticDeliveryInputBoxContentionVerdict
	| "input_box_unreadable_while_input_side_tracking_is_blind";

// 一次读框得到的争用结论 + 抢占前置条件。unrecoverablePasteCount 必须与 verdict 同批取回：
// 分两次读会读到两个时刻的框，可能出现「按 A 时刻判定可抢占、却把 B 时刻多出来的一段不可还原粘贴
// 一起清掉」。
interface ProgrammaticDeliveryInputBoxContentionReading {
	verdict: TaskChatInputDeliveryContentionVerdict;
	unrecoverablePasteCount: number;
}

// 一次投递 attempt 跨重探必须原样带走的全部输入。攒成一个对象而不是继续加参数：这些值一旦在某条
// 重探路径上漏传（历史上 deferWhileUserTurn 就险些如此），语义会在重探时悄悄退化成另一种策略。
interface TaskChatInputDeliveryAttemptPlan {
	taskId: string;
	text: string;
	// 等 TUI 就绪的绝对截止时刻；两条让路预算都以它为起点再加各自的上限。
	deadlineAt: number;
	// 调度时捕获的投递代际；写入 / 重排前复查，被更晚的投递取代者直接放弃。
	generation: number;
	// 后台自动注入（RVF followup 等）遇 agent 模态待答时让位，见 Fix B 让位守卫。
	deferWhileUserTurn: boolean;
	// 争用策略：人不在场时是否允许自动暂存抢占（计划里的 auto / never_preempt 两档）。
	// 在受理时捕获而不是每次重探重读配置：一条投递最多活 ~196s，用同一份策略走完全程，
	// 好过让它在半途因为用户改了设置而换一套语义。
	mayAutoStashAbsentHumanInputBox: boolean;
	// 抢占执行者；null = 本次投递不具备抢占能力（调用方没给），此时恒定停在挂起可见。
	preemptivelyStashHumanInputBox: ProgrammaticDeliveryPreemptiveInputBoxStashHandler | null;
}

// 一次争用抢占在**授权那一刻**捕获的全部前提。清框（forwardStashKeyToClearTaskTerminalInputBox）
// 是在这些前提成立时才被批准的动作，而批准与执行之间隔着一整条跨进程链路，所以每一项都要带到执行点
// 去复查一遍。详见 taskTerminalInputBoxPreemptionHumanAbsencePremises 的注释。
interface TaskTerminalInputBoxPreemptionAuthorizationPremises {
	// 授权时的 PTY「代」本体。换代（refresh / 重启）之后这次授权就属于上一条命，不能再兑现。
	activeWhenPreemptionWasAuthorized: ActiveProcessState;
	// 授权时的人类击键时钟。推进过 ⇒ 人在抢占在途期间回到了终端，「人不在场」这个前提被推翻。
	lastUserInputAtWhenPreemptionWasAuthorized: number | null;
	// 授权这次抢占的那条投递的代际。取消（cancelTaskChatInputDelivery）与被更晚的投递取代
	// （submitTaskChatInputWhenReady）都会自增它——两者都意味着「这次抢占是替一条已经作废的投递
	// 腾框」，那条投递再也不会写进这个框，凭它清掉人类的输入就是纯粹的破坏。
	taskChatInputDeliveryGenerationWhenPreemptionWasAuthorized: number;
}

// 一条程序化投递的回执登记。存在的意义：让投递链路上**每一个出口**都能给出结论，
// 而不是像 2026-08-08 之前那样只有「写进去了」这一条路径有反馈、其余出口一律静默。
interface PendingProgrammaticDeliveryReceipt {
	// 取消要认的 key；用户发起的发送没有 key（不写账本），恒 null。
	idempotencyKey: string | null;
	// awaiting_readiness：还没写进 PTY，取消能真正拦下。
	// awaiting_submit_confirmation：已写入、正在等提交确认，取消已经晚了。
	phase: "awaiting_readiness" | "awaiting_submit_confirmation";
	// 写入 PTY 那一刻 agent 是否正在自己的回合中——决定确认后报 delivered_and_submit_confirmed
	// 还是 delivered_queued_behind_active_agent_turn。必须在写入时捕获：确认 tick 跑到时回合早就变了。
	queuedBehindActiveAgentTurn: boolean;
	// 进程内的「终态写一次即定」前哨。账本侧锁内还有一道同样的守卫，两道都要有：
	// 这一道防同一进程内重复上报，那一道防跨进程（CLI 与 runtime）竞争。
	settled: boolean;
	observer: TaskChatInputDeliveryOutcomeObserver;
}

export interface TaskChatInputDeliveryOutcome {
	status: TerminalDeliveryStatus;
	reason: TerminalDeliveryFailureReason | null;
}

export type TaskChatInputDeliveryOutcomeObserver = (outcome: TaskChatInputDeliveryOutcome) => void;

// Ctrl+S 暂存链路第一步「取文」的结果。正文与保真度分开返回：调用方先看 status 决定这次能不能写库，
// 再看 fidelity 决定要不要在条目上挂「有 N 段粘贴还原不了」的警告。
export interface TaskTerminalInputBoxStashCapture {
	// captured_stashable_text                            框里有可暂存的正文（text 非空）。
	// input_box_empty                                    两路判据都说框是空的。
	// input_box_content_unreadable                       输入侧说有内容，但读屏拿不到正文
	//                                                    （该 agent 的输入框语法未建模 / 当前屏定位不到框）。
	// screen_text_not_corroborated_by_keystroke_tracking 读屏有文字、输入侧却没见过任何字节。
	status:
		| "captured_stashable_text"
		| "input_box_empty"
		| "input_box_content_unreadable"
		| "screen_text_not_corroborated_by_keystroke_tracking";
	text: string;
	fidelity: TerminalInputBoxStashFidelity;
	// 这份读数取自哪一条 PTY「代」。调用方写完库之后必须把它原样回传给
	// forwardStashKeyToClearTaskTerminalInputBox：写库要跨文件锁与落盘，期间用户完全可能 refresh
	// 终端换掉 active，只按 taskId 重查会把清框字节打到一条与本次暂存毫无关系的新会话上。
	terminalSessionIncarnationToken: string;
}

// 上报一条投递结论并注销登记。写一次即定：已 settled 的登记再来一次是 no-op（不是错误——
// 多个出口可能同时判定，比如 teardown 与确认 tick 撞上）。
function settleProgrammaticDeliveryReceipt(
	receipt: PendingProgrammaticDeliveryReceipt | null,
	status: TerminalDeliveryStatus,
	reason: TerminalDeliveryFailureReason | null,
): void {
	if (!receipt || receipt.settled) {
		return;
	}
	receipt.settled = true;
	receipt.observer({ status, reason });
}

// 会话已经不在了 / 这条投递再也不会去争那个框了：挂起可见性必须跟着消失，否则卡片与终端上方会一直
// 挂着「有投递在等你的输入框」，而实际上再没有人在等——那正是这条工作流要根除的那种不诚实。
// 只改 summary、不自己 emit：调用点随后都会走各自的 emit（teardown 的 applySessionEvent / 落定后的
// 显式 emit），合并后的那一份自然带着清空后的值。
function clearTaskChatInputDeliveryContentionVisibility(entry: SessionEntry): boolean {
	if ((entry.summary.terminalDeliveryContention ?? null) === null) {
		return false;
	}
	updateSummary(entry, { terminalDeliveryContention: null });
	return true;
}

// 会话侧统一注销入口：把 active 上的登记结掉并清空槽位。
function settleActiveProgrammaticDelivery(
	active: { programmaticDeliveryReceipt: PendingProgrammaticDeliveryReceipt | null },
	status: TerminalDeliveryStatus,
	reason: TerminalDeliveryFailureReason | null,
): void {
	settleProgrammaticDeliveryReceipt(active.programmaticDeliveryReceipt, status, reason);
	active.programmaticDeliveryReceipt = null;
}

// 「提交确认」这一族出口的专用注销入口：只对**已经写进 PTY、正在等确认**的那条投递下结论。
// 登记仍停在 awaiting_readiness 时，当前在跑的确认链必然属于别人的写入（连接中断自动续跑抢走了
// 确认通道），那条链的成败与这条尚未写入的投递毫无关系——替它落定就是撒谎，而且是双向的：
// 判成功则「回执说送达、文本从没写过」，判失败则「回执说失败、文本随后照样送达并被重复投递」。
// 这条投递此刻还活着（定时器与代际都没动），它自己的出口稍后会给出真正的结论。
function settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
	active: { programmaticDeliveryReceipt: PendingProgrammaticDeliveryReceipt | null },
	status: TerminalDeliveryStatus,
	reason: TerminalDeliveryFailureReason | null,
): void {
	if (active.programmaticDeliveryReceipt?.phase !== "awaiting_submit_confirmation") {
		return;
	}
	settleActiveProgrammaticDelivery(active, status, reason);
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
	// 通道切换后重开会话：续跑既有对话、不重投 prompt，但不带垃圾桶语义。
	// 与 resumeFromTrash 一样，会话开局停在「等你说话」而不是假装 agent 在跑——没有新 prompt 被发出去。
	resumePriorAgentConversationWithoutResendingPrompt?: boolean;
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
		// 通道盖章：terminalManager 持有的会话恒是 PTY 的。omp 的 agentId 在 TUI 与 ACP 两条通道上
		// 是同一个，故一切「这条会话长什么样」的判断都必须读它，不能再从 agentId 派生。
		sessionTransport: "pty_terminal",
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
	const env: Record<string, string | undefined> = {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
	// source 里值为 undefined 的键，语义是「抹掉继承自 process.env 的这一项」，必须真正删键：
	// node-pty 会把留下来的 undefined 序列化成**字符串 "undefined"** 传给子进程，而这对任何
	// 「只看变量存不存在」的消费者都是 truthy —— 等于把「抹除」写成了「设置成开」，与本意反号。
	// 真实用例：Kanban 自己可能跑在一个 Claude Code 会话里，继承了它注入的 CLAUDE_CODE_* 变量，
	// adapter 需要把这些污染抹掉才能按 Kanban 自己的意图起 agent（见 agent-session-adapters 的
	// resolveClaudeCodeTerminalRenderingModeEnv）。
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete env[key];
		}
	}
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

function clearTaskChatInputDeliveryTimer(state: { taskChatInputDeliveryTimer: NodeJS.Timeout | null }): void {
	if (state.taskChatInputDeliveryTimer) {
		clearTimeout(state.taskChatInputDeliveryTimer);
		state.taskChatInputDeliveryTimer = null;
	}
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
		// 经写后确认闭环注入：paste 框架与提交 CR 分两次写、第二次以 TUI 摄入为门；若 CR 仍被重绘吞掉（框卡 idle、
		// 续跑不发送），确认 tick 会补发裸 `\r`——绝不重发整段 paste（重 paste 正是连接中断路径旧的「文本翻倍」病）。
		// Codex 置位 awaitingCodexPromptAfterEnter 由该闭环统一处理，且跟着第二次写（提交 CR）而非框架。
		this.writePasteSubmissionWithConfirm(taskId, active, line);
	}

	// 当前是否可向终端注入程序化输入：deferred-startup 仍待发、或用户近 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS（8s）
	// 内手敲过，都视为不可注入（避免抢在启动 prompt 之前 / 打断正在打字的用户）。
	// 现在的消费者是 output-reaction 的 canInjectNow 动作（连接中断自动续跑）与**写后确认链的补发让位**。
	// task-chat-input 投递的让路已改用读输入框的争用判据（框空即放行，见 runTaskChatInputDeliveryAttempt）：
	// 时间戳窗口分不出「刚敲完回车提交了」与「打了一半」，而那正是形态 3 要解决的问题。
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
	// options.idempotencyKey / options.onDeliveryOutcome：程序化投递的诚实回执登记。传了就意味着
	// 「有人在等这条投递的真实结论」——链路上每个出口都会经 settleProgrammaticDeliveryReceipt 上报一次。
	submitTaskChatInputWhenReady(
		taskId: string,
		text: string,
		options?: {
			deferWhileUserTurn?: boolean;
			idempotencyKey?: string | null;
			onDeliveryOutcome?: TaskChatInputDeliveryOutcomeObserver;
			// 争用策略与抢占执行者，见 TaskChatInputDeliveryAttemptPlan。默认不抢占：
			// 缺省即最保守的一档，调用方必须显式把能力交进来才可能动人类的框。
			mayAutoStashAbsentHumanInputBox?: boolean;
			preemptivelyStashHumanInputBox?: ProgrammaticDeliveryPreemptiveInputBoxStashHandler;
		},
	): RuntimeTaskSessionSummary | null {
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
		clearTaskChatInputDeliveryTimer(active);
		// 新投递取代任何上一条 paste 提交的待决确认链（其自身写入后会再起一条新的）。
		clearSubmitConfirmTimer(active);
		// 单飞槽被抢占：上一条投递从此再无人推进，必须当场给它一个诚实结论，
		// 否则它的等待者（RVF）会永远停在 pending——这正是契约里 superseded_by_later_delivery 的用途。
		settleActiveProgrammaticDelivery(active, "delivery_failed", "superseded_by_later_delivery");
		if (options?.onDeliveryOutcome) {
			active.programmaticDeliveryReceipt = {
				idempotencyKey: options.idempotencyKey ?? null,
				phase: "awaiting_readiness",
				queuedBehindActiveAgentTurn: false,
				settled: false,
				observer: options.onDeliveryOutcome,
			};
		}
		const generation = ++active.taskChatInputDeliveryGeneration;
		const deadlineAt = now() + TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS;
		const plan: TaskChatInputDeliveryAttemptPlan = {
			taskId,
			text,
			deadlineAt,
			generation,
			deferWhileUserTurn,
			mayAutoStashAbsentHumanInputBox: options?.mayAutoStashAbsentHumanInputBox ?? false,
			preemptivelyStashHumanInputBox: options?.preemptivelyStashHumanInputBox ?? null,
		};
		// 上一条投递留下的挂起可见性属于上一条投递，本次受理即作废（新投递会自己重新算一份）。
		this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
		const timer = setTimeout(() => {
			void this.runTaskChatInputDeliveryAttempt(plan);
		}, TASK_CHAT_INPUT_DELIVERY_SETTLE_MS);
		timer.unref?.();
		active.taskChatInputDeliveryTimer = timer;
		return cloneSummary(entry.summary);
	}

	// 取消一条在途程序化投递。按 RVF 的建议复用既有代际计数（自增即令在途 attempt 在写入前自行放弃），
	// 不新建取消状态机——这样「取消」与「被更晚投递取代」走的是同一条作废路径，不会出现两套竞争语义。
	//
	// 三个返回值对应契约里的 cancel_result：
	//   cancelled_before_delivery —— 确实拦下了，文本没有进入终端。
	//   already_delivered —— 已经写进 PTY、正在等提交确认，取消晚了（真实终态稍后由确认链落定）。
	//   no_pending_delivery —— runtime 内存里没有这条在途投递（从未到达、已落定、或已被取代）。
	//
	// 竞争安全性来自「同步 + 单事件循环」：本方法全程无 await，与确认链、投递 attempt 天然序列化，
	// 不存在「既取消又送达」的中间态。
	cancelTaskChatInputDelivery(
		taskId: string,
		idempotencyKey: string,
	): "cancelled_before_delivery" | "already_delivered" | "no_pending_delivery" {
		const entry = this.entries.get(taskId);
		const active = entry?.active ?? null;
		const receipt = active?.programmaticDeliveryReceipt ?? null;
		if (!active || !receipt || receipt.idempotencyKey !== idempotencyKey) {
			return "no_pending_delivery";
		}
		if (receipt.phase === "awaiting_submit_confirmation") {
			return "already_delivered";
		}
		clearTaskChatInputDeliveryTimer(active);
		// 自增代际：正 await 就绪判定的在途 attempt 返回后会复查代际、发现已过时而放弃写入。
		active.taskChatInputDeliveryGeneration += 1;
		settleActiveProgrammaticDelivery(active, "delivery_failed", "cancelled_before_delivery");
		// 取消掉的投递不再挂在这个终端上等框，挂起可见性必须随之消失，否则 UI 会一直摆着一条
		// 「有投递在等你让路」而实际上再没有人在等。
		this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
		return "cancelled_before_delivery";
	}

	// 一次投递 attempt：就绪 ∧ 输入框空 才写 PTY；未就绪或框被人占着则隔 RECHECK_MS 再探，两条预算各自到点
	// 转终态（terminal_prompt_readiness_timeout / human_terminal_contention_timeout）。**没有任何一条路径会
	// 无条件强写**——那是形态 3 移除掉的东西。
	// plan.generation 为调度时捕获的代际；写入/重排前复查，被后续投递取代（代际不再相等）者直接放弃。
	private async runTaskChatInputDeliveryAttempt(plan: TaskChatInputDeliveryAttemptPlan): Promise<void> {
		const { taskId, text, deadlineAt, generation, deferWhileUserTurn } = plan;
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			// session 已结束：放弃投递（timer 已随 teardown 清除）。回执由 teardown 侧上报——
			// 这里已经够不到那份 active，拿不到登记。
			return;
		}
		// 进入 await 前先校验代际：已被更晚的投递取代则不再触发就绪判定（避免无谓 await 后写旧文本）。
		// 结论已由抢占方在自增代际时上报（superseded_by_later_delivery），此处不重复上报。
		if (active.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		active.taskChatInputDeliveryTimer = null;
		const readiness = await this.resolveInteractivePromptReadiness(entry);
		// await 期间 session 可能已被替换/结束：复查同一 active 仍在。
		const currentEntry = this.entries.get(taskId);
		const currentActive = currentEntry?.active;
		if (!currentEntry || !currentActive || currentActive !== active) {
			// await 期间会话被替换/结束：这条投递永远到不了 PTY 了。捕获的 active 仍在手上，就地上报。
			settleActiveProgrammaticDelivery(active, "delivery_failed", "session_ended_before_delivery");
			return;
		}
		// await 期间可能有更晚的投递（submitTaskChatInputWhenReady）已自增代际：本 attempt 已过时，
		// 直接放弃——既不写旧文本也不重排，保证 last-write-wins 跨越 await 仍成立。
		if (currentActive.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		// Fix B 让位守卫：后台自动注入（deferWhileUserTurn=true）遇 agent **正在等用户拍板**（AskUserQuestion /
		// 计划评审 / 权限确认 / 兜底待输入）时，不写 PTY、不走下面的 deadline 强写，改排一次重探，直到该模态解除
		// 才真正投递。等价把 connection-drop 注入路径的让位不变量（绝不打进正等用户的对话框、以免 UserPromptSubmit
		// 把会话翻回 agent 回合）补到本路径——但仅对后台注入生效。须置于 pastDeadline 判定之前才能盖过 deadline 兜底。
		// 用户发起的发送（deferWhileUserTurn=false）不经此分支，任何回合照常送达。
		//
		// 判据用 userTurnKind ∈ 模态待答集合，**不是** turnOwner !== "agent"：后者把 `review`（agent 自然完工、
		// 输入框空闲）也算成「等用户」，而 review 恰恰是 RVF followup 的目标态，于是每次都让位、永不投递——
		// 这是 2026-08-08 事故的第二条根因。收窄回 Fix B commit 正文原本描述的那几种模态。
		//
		// 让位有硬预算（MAX_USER_TURN_YIELD_MS）：到点转终态失败而不是继续空探。旧实现无上限，
		// 是事故的第三条根因。语义仍是「延迟而非丢弃」，只是延迟现在有尽头、且尽头处会诚实报错。
		const currentUserTurnKind = resolveSessionFacets(currentEntry.summary).userTurnKind;
		if (
			deferWhileUserTurn &&
			currentUserTurnKind !== null &&
			MODAL_USER_DECISION_TURN_KINDS.has(currentUserTurnKind)
		) {
			if (now() >= deadlineAt + TASK_CHAT_INPUT_DELIVERY_MAX_USER_TURN_YIELD_MS) {
				settleActiveProgrammaticDelivery(currentActive, "delivery_failed", "agent_awaiting_user_decision_timeout");
				this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
				logTuiFreezeError(
					`[tui-freeze] task-chat-input-delivery-abandoned taskId=${taskId} ` +
						`agentId=${currentEntry.summary.agentId} reason=agent_awaiting_user_decision_timeout ` +
						`userTurnKind=${currentUserTurnKind}`,
				);
				return;
			}
			this.scheduleTaskChatInputDeliveryRecheck(plan, currentActive);
			return;
		}
		// deferred-startup 仍待发 ⇒ 这条会话连启动 prompt 都还没送出去，绝不能插到它前面：与「尚未就绪」
		// 同等对待（旧实现把它混在 A1 让路里，语义上一直是「还不能写」而不是「在给人让路」）。
		const readyToWriteIntoInputBox = readiness !== null && currentActive.deferredStartupInput === null;
		const pastDeadline = now() >= deadlineAt;
		if (!readyToWriteIntoInputBox && !pastDeadline) {
			// 尚未就绪且未过 deadline：隔 RECHECK_MS 再探（纯轮询，不消耗额外语义）。
			this.scheduleTaskChatInputDeliveryRecheck(plan, currentActive);
			return;
		}
		if (!readyToWriteIntoInputBox) {
			// 就绪等待预算耗尽。旧实现在这里**无条件强写**（best-effort），于是「TUI 从没就绪过」这件事
			// 永远不会成为失败，调用方拿到的回执与真实情况脱节。契约里 terminal_prompt_readiness_timeout
			// 就是为这一刻留的：结构判定命中通常只要 1–3s，等满整个 deadline 仍不就绪意味着这个终端确实
			// 不在能收消息的状态，硬写只会把文本泼进一个未知形态的界面。
			settleActiveProgrammaticDelivery(currentActive, "delivery_failed", "terminal_prompt_readiness_timeout");
			this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
			logTuiFreezeError(
				`[tui-freeze] task-chat-input-delivery-abandoned taskId=${taskId} ` +
					`agentId=${currentEntry.summary.agentId} reason=terminal_prompt_readiness_timeout`,
			);
			return;
		}
		// 让路判据：**框空即放行**，框非空才进入争用分层。
		//
		// 判据从「距上次击键不足 8 秒」换成读框，是因为时间戳窗口区分不了两件语义完全不同的事：
		// 「刚敲完回车把消息提交了」（框已空，此刻正是最该投的时机）与「打了一半停下来想」（框非空，
		// 一个字节都不能写进去）。旧判据把前者也当成让路对象，白等 8 秒；又在预算耗尽后对后者强写，
		// 把 paste 插进人类没写完的那一行。
		const contention = await this.resolveProgrammaticDeliveryInputBoxContentionForTask(taskId, currentActive);
		// 读框要排进镜像 operationQueue，这段 await 同样跨宏任务：与上面的就绪判定 await 一样复查会话与代际。
		const entryAfterContentionRead = this.entries.get(taskId);
		const activeAfterContentionRead = entryAfterContentionRead?.active;
		if (!entryAfterContentionRead || !activeAfterContentionRead || activeAfterContentionRead !== currentActive) {
			// 只结算这条投递自己的回执，**不碰**挂起可见性：清空 helper 按 taskId 查的是**当前** entry，
			// 而换代只替换 entry.active、entry 与 summary 仍是同一份。若新 incarnation 上已经有一条新投递
			// 发布了争用 sidecar，这里按 taskId 清就会把它抹掉，那条真在等框的投递从此毫无可见性——
			// 又变回「机器在等、屏幕不说」的静默挂起。属于旧 incarnation 的那份可见性无需在此补清：
			// 每一条 teardown / 换代路径（startTaskSession / onExit / stopTaskSession / forceStopTaskSession /
			// markInterruptedAndStopAll）都已在 settle 旁边配了 clearTaskChatInputDeliveryContentionVisibility(entry)。
			settleActiveProgrammaticDelivery(currentActive, "delivery_failed", "session_ended_before_delivery");
			return;
		}
		if (activeAfterContentionRead.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		if (contention !== null && contention.verdict !== "input_box_clear_for_programmatic_delivery") {
			await this.holdOrPreemptContendedTerminalInputBox(plan, entryAfterContentionRead, currentActive, contention);
			return;
		}
		// 框是空的（或读框拿不到结论）：本条投递不再挂在争用上，清掉挂起可见性再写。
		this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
		// 程序化投递的是一条**已提交的用户轮**（task-chat 手动发送 / RVF followup），语义上等价于用户在
		// 终端里手敲提交，故与 writeInput 一样解除 resume substantive guard——此后 agent 的新产出才重新
		// 推进 lastSubstantiveOutputAt。刻意不下沉进 writePasteSubmissionWithConfirm：那个 writer 同时
		// 服务连接中断自动续跑（submitConnectionDropContinuation），自动恢复不是用户继续、绝不可解除 guard。
		clearResumeSubstantiveGuard(currentActive);
		// 就绪命中 或 deadline 兜底：经写后确认闭环写 PTY（不走 writeInput，避免把程序化投递记成 lastUserInputAt
		// 而自我抑制——与 submitConnectionDropContinuation 一致）。writePasteSubmissionWithConfirm 把 paste 框架与
		// 提交 CR 分两次写（第二次以摄入证据为门）；若 CR 仍被吞掉（粘贴进框但不发送），其确认 tick 会补发裸 CR；
		// Codex 置位 awaitingCodexPromptAfterEnter 亦由其统一处理，且跟着第二次写（提交 CR）而非框架。
		// 回执推进到「已写入、等确认」。queuedBehindActiveAgentTurn 必须在**此刻**捕获：确认 tick 在
		// 2.5s 之后才跑，那时 turnOwner 早就被这次投递本身翻成 agent 了，届时再读一律是 agent，
		// 就再也分不出「排在既有回合之后」与「agent 因这条消息才开始干活」。
		const deliveryReceipt = currentActive.programmaticDeliveryReceipt;
		if (deliveryReceipt) {
			deliveryReceipt.phase = "awaiting_submit_confirmation";
			deliveryReceipt.queuedBehindActiveAgentTurn = resolveSessionFacets(currentEntry.summary).turnOwner === "agent";
		}
		this.writePasteSubmissionWithConfirm(taskId, currentActive, text, {
			retainsProgrammaticDeliveryReceipt: true,
		});
		logTuiFreezeWarning(
			`[tui-freeze] task-chat-input-delivered taskId=${taskId} agentId=${currentEntry.summary.agentId} ` +
				`via=${resolveTaskChatInputDeliveryVia(readiness)} chars=${text.length}`,
		);
	}

	// 排一次 RECHECK_MS 后的投递重试（未就绪轮询 / 争用挂起 / Fix B 让位重探共用）。整份 plan 原样带走，
	// 任何一项（尤其让位标记与抢占能力）在某条重探路径上漏传，都会让语义在半途悄悄换成另一种策略。
	private scheduleTaskChatInputDeliveryRecheck(
		plan: TaskChatInputDeliveryAttemptPlan,
		active: ActiveProcessState,
	): void {
		const timer = setTimeout(() => {
			void this.runTaskChatInputDeliveryAttempt(plan);
		}, TASK_CHAT_INPUT_DELIVERY_RECHECK_MS);
		timer.unref?.();
		active.taskChatInputDeliveryTimer = timer;
	}

	// 争用分层：框非空时决定「挂起可见」还是「自动暂存抢占」，并在预算耗尽时诚实收尾。
	//
	// | 开关 | 人在场 | 人不在场 |
	// | auto（默认） | 挂起可见，机器不动框 | 自动暂存抢占：无损存进 Prompt Library → 清框 → 下一拍投递 |
	// | never_preempt | 挂起可见 | 挂起可见（恒定不抢占） |
	//
	// 四条额外的降级（任一成立即退回挂起，绝不抢占）：
	//   - 框里有还原不了的粘贴（unrecoverablePasteCount > 0）：抢占的前提是「无损」，赌不起。
	//   - 屏上有字但击键跟踪佐证不了：那可能是 agent 自绘的 UI 文案，存进库就是把 agent 的话冒充成用户资产。
	//   - 这一帧读不出框、输入侧又从未见过人类字节（input_box_unreadable_…）：对框里有什么一无所知，
	//     既不能写（可能插进人类的行）也不能抢占（不知道要存什么进库）。
	//   - 抢占执行者没给 / 执行失败：没存成就照写，等于用「写不丢」换掉了人类那半句话。
	private async holdOrPreemptContendedTerminalInputBox(
		plan: TaskChatInputDeliveryAttemptPlan,
		entry: SessionEntry,
		active: ActiveProcessState,
		contention: ProgrammaticDeliveryInputBoxContentionReading,
	): Promise<void> {
		const { taskId, deadlineAt, generation } = plan;
		const humanIsPresentAtThisTerminal =
			active.lastUserInputAt !== null && now() - active.lastUserInputAt < HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS;
		const mayPreemptRightNow =
			plan.mayAutoStashAbsentHumanInputBox &&
			plan.preemptivelyStashHumanInputBox !== null &&
			!humanIsPresentAtThisTerminal &&
			contention.verdict === "human_uncommitted_input_present" &&
			contention.unrecoverablePasteCount === 0;
		this.publishTaskChatInputDeliveryContentionVisibility(taskId, {
			pendingProgrammaticDeliveryCount: 1,
			// 「框里有未提交内容」是一句关于框的**断言**，只在真读到东西时才配说。
			// input_box_unreadable_… 这一格恰恰是「读不到框」，说 true 就是拿一句我们没有证据的话去
			// 解释挂起；置 false 时 UI 退回不谈内容的那句「有 N 条程序化投递正在等这个终端」（见
			// web-ui/src/terminal/terminal-delivery-contention-notice.ts），仍然看得见、但不撒谎。
			inputBoxHasUncommittedText: contention.verdict !== "input_box_unreadable_while_input_side_tracking_is_blind",
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: !mayPreemptRightNow,
		});
		if (now() >= deadlineAt + TASK_CHAT_INPUT_DELIVERY_MAX_HUMAN_CONTENTION_YIELD_MS) {
			settleActiveProgrammaticDelivery(active, "delivery_failed", "human_terminal_contention_timeout");
			this.publishTaskChatInputDeliveryContentionVisibility(taskId, null);
			logTuiFreezeError(
				`[tui-freeze] task-chat-input-delivery-abandoned taskId=${taskId} ` +
					`agentId=${entry.summary.agentId} reason=human_terminal_contention_timeout ` +
					`verdict=${contention.verdict} humanPresent=${humanIsPresentAtThisTerminal}`,
			);
			return;
		}
		if (!mayPreemptRightNow) {
			this.scheduleTaskChatInputDeliveryRecheck(plan, active);
			return;
		}
		const preemptivelyStashHumanInputBox = plan.preemptivelyStashHumanInputBox;
		if (preemptivelyStashHumanInputBox === null) {
			this.scheduleTaskChatInputDeliveryRecheck(plan, active);
			return;
		}
		// 进抢占前武装授权前提闩：上面那次 humanIsPresentAtThisTerminal 是**此刻**的读数，而抢占
		// 执行者返回时框已经被清掉了，回来再复查一遍人类活动也来不及。真正的复查必须发生在链路上最后一个
		// 由 manager 说了算的点（forwardStashKeyToClearTaskTerminalInputBox），闩就是把这里的授权前提带
		// 到那里去的载体。详见 taskTerminalInputBoxPreemptionHumanAbsencePremises。
		//
		// 代际一并存进闩：本方法之前的每一处跨 await 复查（runTaskChatInputDeliveryAttempt 的三处）都只
		// 能保证「进抢占的这一刻这条投递还是最新的」。抢占本身又是一段长 await，期间这条投递可能被取消或
		// 被更晚的投递取代，而那两条路径都无法把已经进了执行者的抢占叫回来——它们能做的只有自增代际。
		// 于是「这次清框还属不属于一条活着的投递」也必须在兑现点复查，与「人是否仍不在场」同一条理由。
		const premisesThisPreemptionWasAuthorizedOn: TaskTerminalInputBoxPreemptionAuthorizationPremises = {
			activeWhenPreemptionWasAuthorized: active,
			lastUserInputAtWhenPreemptionWasAuthorized: active.lastUserInputAt,
			taskChatInputDeliveryGenerationWhenPreemptionWasAuthorized: generation,
		};
		this.armTaskTerminalInputBoxPreemptionAuthorizationPremises(taskId, premisesThisPreemptionWasAuthorizedOn);
		let humanInputWasStashedAndInputBoxCleared: boolean;
		try {
			humanInputWasStashedAndInputBoxCleared = await preemptivelyStashHumanInputBox(taskId);
		} finally {
			// 只撤自己那一份（见 arm/disarm 两个 helper 与闩本身的注释）：同一 task 上可能同时挂着别的
			// 在途抢占的前提，撤错人等于把它们的清框复查一起拆掉。
			this.disarmTaskTerminalInputBoxPreemptionAuthorizationPremises(taskId, premisesThisPreemptionWasAuthorizedOn);
		}
		// 抢占跨了文件锁与落盘：与其余每一处 await 同理，回来必须复查这条会话与代际还是不是原来那条。
		const entryAfterStash = this.entries.get(taskId);
		const activeAfterStash = entryAfterStash?.active;
		if (!entryAfterStash || !activeAfterStash || activeAfterStash !== active) {
			// 同上：换代之后按 taskId 清可见性会误伤新 incarnation 上另一条投递刚发布的 sidecar。
			// 本条投递在本方法开头挂起时发布的那一份，已由换代/结束路径自己的 clear 收走。
			settleActiveProgrammaticDelivery(active, "delivery_failed", "session_ended_before_delivery");
			return;
		}
		if (activeAfterStash.taskChatInputDeliveryGeneration !== generation) {
			return;
		}
		if (!humanInputWasStashedAndInputBoxCleared) {
			// 没存成就退回挂起：让路预算继续走，到点以 human_terminal_contention_timeout 收尾。
			// 「人在抢占在途期间回来打字、清框被前提闩拒掉」也走这一条：拒清 ⇒ 执行者返回 false ⇒ 挂起。
			// 挂起可见性无需在此重写——下一拍重探会再读一次框，届时人已在场、框又非空，
			// mayPreemptRightNow 恒为 false，可见性自然翻回「等人处理」。
			logTuiFreezeWarning(
				`[tui-freeze] task-chat-input-contention-preemption-declined taskId=${taskId} ` +
					`agentId=${entryAfterStash.summary.agentId}`,
			);
			this.scheduleTaskChatInputDeliveryRecheck(plan, active);
			return;
		}
		logTuiFreezeWarning(
			`[tui-freeze] task-chat-input-contention-preempted taskId=${taskId} ` +
				`agentId=${entryAfterStash.summary.agentId} stashedIntoPromptLibrary=1`,
		);
		// 框已清空，但不在这里直接写：下一拍重新走完整判定（就绪 + 读框）再写，既复用同一条路径，
		// 也让「清框之后 TUI 还没重绘完」这种瞬态自然被下一次读框吸收。
		this.scheduleTaskChatInputDeliveryRecheck(plan, active);
	}

	// 读一次「这个终端的输入框此刻被谁占着」并给出争用结论。null = 拿不到关于当前这条 PTY 的可信读数
	// （无 active / 读屏期间会话换代），调用方按「无争用」处理——此时继续挂起没有意义，真正的会话
	// 换代会在调用方的跨 await 复查里被判成 session_ended_before_delivery。
	private async resolveProgrammaticDeliveryInputBoxContentionForTask(
		taskId: string,
		active: ActiveProcessState,
	): Promise<ProgrammaticDeliveryInputBoxContentionReading | null> {
		const occupancy = await this.resolveTaskTerminalInputBoxOccupancy(taskId);
		if (!occupancy) {
			return null;
		}
		const inputSideByteTrackingHasEverObservedHumanBytes =
			active.inputBoxOccupancyTracker.hasEverObservedHumanInputBytesFromWriteInput;
		// 两只眼睛此刻**同时**闭着的那一格：读屏这一帧给不出结论（screenReadingSaysNonEmpty === null），
		// 而输入侧从未在这条 PTY 上见过人类字节 ⇒ 我们对这个框一无所知，「空」只是默认值而不是观测。
		// 若此刻放行，经 tmux / 原生终端直连同一 PTY 打进去的半行就会被 paste 接在后面。
		//
		// 收紧只敢用在**曾经读得出框**的会话上（hasEverLocatedTerminalInputBoxOnScreen）。这一格必须
		// 与「该 agent 根本没建模输入框语法」严格分开：codex / kimi / droid 的读屏恒为 null，把它们一并
		// 判成争用，等于让它们的每一条程序化投递都挂到预算耗尽、100% 以
		// human_terminal_contention_timeout 收场——比本轮修复前更差。对它们，输入侧字节跟踪本就是判空
		// 的唯一且有效的主力，照旧放行。
		// 反过来，读得出框的会话（claude）在这一帧读不出，只可能是 TUI 正在重绘 / 框被全屏输出盖住这类
		// 瞬态：挂起 1.5s 后重探即恢复，让路预算（deadline + 15s）也在兜底，不会变成静默挂起。
		if (
			!occupancy.inputSideByteTrackingSaysNonEmpty &&
			occupancy.screenReadingSaysNonEmpty === null &&
			active.hasEverLocatedTerminalInputBoxOnScreen &&
			!inputSideByteTrackingHasEverObservedHumanBytes
		) {
			return {
				verdict: "input_box_unreadable_while_input_side_tracking_is_blind",
				unrecoverablePasteCount: occupancy.unrecoverablePasteCount,
			};
		}
		return {
			verdict: resolveProgrammaticDeliveryInputBoxContention({
				occupancy,
				inputSideByteTrackingHasEverObservedHumanBytes,
			}),
			unrecoverablePasteCount: occupancy.unrecoverablePasteCount,
		};
	}

	// 挂起可见性的唯一写点。派生 + 去重：值没变就不写，于是这条**会话广播**热链路只在争用状态真的
	// 翻转时才多一次扇出（最快也就投递重探的节拍，1.5s 一次）。输入框内容本身永远不上这条链路。
	private publishTaskChatInputDeliveryContentionVisibility(
		taskId: string,
		contention: RuntimeTaskTerminalDeliveryContention | null,
	): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		if (contention === null) {
			// 清空走共享的那条（teardown 也用它），但这里要把清空的结果广播出去：挂起提示消失得让 UI 知道。
			if (clearTaskChatInputDeliveryContentionVisibility(entry)) {
				this.emitSummary(entry.summary);
			}
			return;
		}
		const current = entry.summary.terminalDeliveryContention ?? null;
		if (
			current !== null &&
			current.pendingProgrammaticDeliveryCount === contention.pendingProgrammaticDeliveryCount &&
			current.inputBoxHasUncommittedText === contention.inputBoxHasUncommittedText &&
			current.waitingForHumanBecauseAutomaticPreemptionIsUnavailable ===
				contention.waitingForHumanBecauseAutomaticPreemptionIsUnavailable
		) {
			return;
		}
		this.emitSummary(updateSummary(entry, { terminalDeliveryContention: contention }));
	}

	// 两处程序化 paste 注入（RVF followup 与连接中断续跑）的统一写入入口 + 写后确认闭环。先写 bracketed paste
	// 框架、待 TUI 摄入后再单独写提交用的 CR（Codex 的 awaitingCodexPromptAfterEnter 跟着那次 CR 置位，
	// 理由见 runSubmitCarriageReturnAfterPasteIngestionAttempt），然后起一个确认 tick：隔 SUBMIT_CONFIRM_DELAY_MS
	// 检查输出是否在 paste 回显后重新流动——未恢复（CR 被吞、框卡 idle）且用户未在打字时补发裸 `\r`（绝不重 paste）。
	// 「真提交 vs CR 被吞」的判据对两条路径都成立：真提交 → agent 干活 → 持续产出 → 非静默；CR 被吞 → 终端回落
	// idle 框、再无字节 → 静默（见 src/core/session-activity.ts）。故确认统一用 output-quiet，不把 turnOwner 写进门控
	// （连接中断注入时 turnOwner 已是 agent，区分不了 landed/swallowed）。
	// options.retainsProgrammaticDeliveryReceipt：本次写入是否就是那条待回执投递自己的写入。
	// 只有 task-chat 投递路径传 true。连接中断自动续跑（submitConnectionDropContinuation）不传——
	// 它会夺走确认通道，被夺走的那条投递从此确认不到提交，只能诚实报 submit_confirmation_budget_exhausted
	// （契约里这条 reason 的含义正是「写进去了但确认不到，文本可能残留在框里，重投前宜人工确认」）。
	// 但「被夺走」只对**已写进 PTY、正在等确认**的投递成立：仍停在 awaiting_readiness 的投递一个字节都还没写，
	// 那条 reason 对它是假的，而且这里既不清投递定时器也不自增投递代际，判它失败之后它照样会写入并提交——
	// 「回执说失败、文本其实送达」，调用方按契约换新 key 重投就把同一段文本送进终端两次。故按 phase 分流。
	// 不收 entry：本步只写框架，agent 形态（Codex enter 守卫）与它无关；需要 entry 的那一步在
	// runSubmitCarriageReturnAfterPasteIngestionAttempt 里按 taskId 重新取，取到的才是写 CR 那一刻的会话。
	private writePasteSubmissionWithConfirm(
		taskId: string,
		active: ActiveProcessState,
		text: string,
		options?: { retainsProgrammaticDeliveryReceipt?: boolean },
	): void {
		if (!options?.retainsProgrammaticDeliveryReceipt) {
			settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
				active,
				"delivery_failed",
				"submit_confirmation_budget_exhausted",
			);
		}
		// 分离写第一步：只写 bracketed paste 框架，**不带**提交用的 CR。
		// 刻意**不**在这里置 awaitingCodexPromptAfterEnter：那个标志的语义是「回车刚发出去」，
		// 必须跟着 CR（见 runSubmitCarriageReturnAfterPasteIngestionAttempt），不能跟着框架。
		active.session.write(toBracketedPasteFramingWithoutTrailingSubmit(text));
		// last-write-wins：清掉上一条 paste 提交的待决确认链（含它可能还停在「等摄入证据」那一步的定时器），
		// 自增代际令本次成为唯一有效确认。
		clearSubmitConfirmTimer(active);
		const generation = ++active.submitConfirmGeneration;
		this.scheduleSubmitCarriageReturnAfterPasteIngestionPoll(taskId, active, generation, {
			outputChunkArrivalSequenceNumberAtPasteWrite: active.ptyOutputChunkArrivalSequenceNumber,
			ingestionEvidenceDeadlineAt: now() + PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS,
		});
	}

	// 排一次「TUI 摄入了没有」的探测。定时器仍占用 submitConfirmTimer 槽位：确认链与本探测在时间上首尾相接、
	// 同属一条 paste 提交，共用一个槽位才能让 last-write-wins 与 teardown 一次清干净。
	private scheduleSubmitCarriageReturnAfterPasteIngestionPoll(
		taskId: string,
		active: ActiveProcessState,
		generation: number,
		ingestionWatch: { outputChunkArrivalSequenceNumberAtPasteWrite: number; ingestionEvidenceDeadlineAt: number },
	): void {
		const timer = setTimeout(() => {
			this.runSubmitCarriageReturnAfterPasteIngestionAttempt(taskId, generation, ingestionWatch);
		}, PASTE_INGESTION_EVIDENCE_POLL_BEFORE_SUBMIT_MS);
		timer.unref?.();
		active.submitConfirmTimer = timer;
	}

	// 分离写第二步：摄入证据出现（或等到预算上限）后单独写提交用的 CR，随即起确认链。
	private runSubmitCarriageReturnAfterPasteIngestionAttempt(
		taskId: string,
		generation: number,
		ingestionWatch: { outputChunkArrivalSequenceNumberAtPasteWrite: number; ingestionEvidenceDeadlineAt: number },
	): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			// session 已结束：CR 无处可发（teardown 已清定时器）。这条投递的结论由 teardown 侧上报。
			return;
		}
		if (active.submitConfirmGeneration !== generation) {
			// 被更晚的 paste 提交取代：绝不再补发本次的 CR，否则它会提交别人刚粘进去的内容。
			return;
		}
		active.submitConfirmTimer = null;
		const pasteIngestionWitnessed =
			active.ptyOutputChunkArrivalSequenceNumber !== ingestionWatch.outputChunkArrivalSequenceNumberAtPasteWrite;
		if (!pasteIngestionWitnessed && now() < ingestionWatch.ingestionEvidenceDeadlineAt) {
			this.scheduleSubmitCarriageReturnAfterPasteIngestionPoll(taskId, active, generation, ingestionWatch);
			return;
		}
		active.session.write(BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN);
		// awaitingCodexPromptAfterEnter 必须在**这里**置位，与 writeInput 只在 data 含 CR/LF 时置位同形：
		// 该标志的语义是「回车刚发出去、下一个 agent.prompt-ready 才该被消费」，flushPendingOutputAnalysis
		// 用它当 enter 守卫（未置位则丢弃 prompt-ready、维持 awaiting_review）。分离写把框架与 CR 拆成两次写后，
		// 两者之间隔着最长 PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS 的摄入等待窗；若跟着框架置位，
		// 窗内 paste 回显（codexPromptDetector 认的正是行首 `›`，粘贴重绘必然产出）就会被当成「回车已发」，
		// 把 awaiting_review 误翻成 running 并清掉守卫——此后 CR 若被吞或确认失败，会话卡在假 running，
		// 而输入框里仍挂着未提交的文本。跟着 CR 置位才恢复分离写之前「置位与 CR 同刻」的时序前提。
		if (entry.summary.agentId === "codex") {
			active.awaitingCodexPromptAfterEnter = true;
		}
		if (!pasteIngestionWitnessed) {
			// 预算耗尽仍无回显：照发 CR（不劣于旧实现的同 chunk 写），并留一条可检索的日志——
			// 若这条日志开始批量出现，说明该 agent 的 TUI 不回显 paste，摄入门控对它形同虚设。
			logTuiFreezeWarning(
				`[tui-freeze] paste-ingestion-unwitnessed taskId=${taskId} agentId=${entry.summary.agentId} ` +
					`waitedMs=${PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS}`,
			);
		}
		this.scheduleSubmitConfirmTick(
			taskId,
			active,
			generation,
			SUBMIT_CONFIRM_MAX_RESENDS,
			now() + SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS,
		);
	}

	// 排一个 SUBMIT_CONFIRM_DELAY_MS 后的确认/补发 tick，沿用捕获的代际、剩余补发预算与本链的收敛上界时刻。
	private scheduleSubmitConfirmTick(
		taskId: string,
		active: ActiveProcessState,
		generation: number,
		resendsLeft: number,
		convergenceDeadlineAt: number,
	): void {
		const timer = setTimeout(() => {
			this.runSubmitConfirmAttempt(taskId, generation, resendsLeft, convergenceDeadlineAt);
		}, SUBMIT_CONFIRM_DELAY_MS);
		timer.unref?.();
		active.submitConfirmTimer = timer;
	}

	// 一次确认/补发 attempt：read 输出是否恢复流动决定 confirmed / 补发裸 `\r` / 让位 / 收尾。
	// generation 为 writePasteSubmissionWithConfirm 调度时捕获的代际；被更晚的 paste 提交取代（代际不再相等）者放弃。
	// convergenceDeadlineAt 为整条链的绝对收敛上界（见 SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS）。
	private runSubmitConfirmAttempt(
		taskId: string,
		generation: number,
		resendsLeft: number,
		convergenceDeadlineAt: number,
	): void {
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
			// 提交已确认。两种终态的区别只在「写入那一刻 agent 是否已在自己的回合中」，
			// 该标记在写入时就捕获好了（见 runTaskChatInputDeliveryAttempt）。
			// 只认自己那条投递：本确认链可能属于连接中断自动续跑的写入，此时在途投递可能还停在
			// awaiting_readiness（一个字节都没写），把「续跑那段文本被 agent 收下了」当成它送达是最危险的谎。
			settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
				active,
				active.programmaticDeliveryReceipt?.queuedBehindActiveAgentTurn
					? "delivered_queued_behind_active_agent_turn"
					: "delivered_and_submit_confirmed",
				null,
			);
			return;
		}
		// 仍静默且本链已到绝对收敛上界：无论卡在补发还是让位，都必须就此给出结论。旧实现里让位那一支
		// 在预算耗尽时直接 return——不再排 tick、也不 settle，于是这条 receipt 从此无人推进，账本永远停在
		// accepted_pending_submit_confirmation（只能等会话 teardown 或 runtime 重启兜底），
		// 正是「投递链路上每个出口都要给出一次结论」这条不变量在确认链上的破口。
		// 文本此刻已经粘进输入框、只是确认不到提交，契约里 submit_confirmation_budget_exhausted 的含义
		// （「写进去了但确认不到、可能残留在输入框里，重投前宜人工确认」）正好覆盖这种收尾。
		// 与本函数其余出口同理，只认自己那条投递：本链可能属于连接中断自动续跑的写入，而在途投递
		// 可能还停在 awaiting_readiness——它一个字节都没写，本链到没到上界与它无关；替它判失败之后
		// 它照样会写入并提交，就成了「回执说失败、文本其实送达」，调用方换新 key 重投还会重复送达。
		if (now() >= convergenceDeadlineAt) {
			logTuiFreezeError(
				`[tui-freeze] submit-unconfirmed taskId=${taskId} agentId=${entry.summary.agentId} ` +
					`reason=confirm-chain-convergence-deadline`,
			);
			settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
				active,
				"delivery_failed",
				"submit_confirmation_budget_exhausted",
			);
			return;
		}
		// 仍静默但用户近 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS（8s）内手敲过 → 让位、绝不替他提交（保护 stashed/在打的
		// prompt）；预算还在则再排一拍等待（不消耗预算），用户停手越过抑制窗后的下一拍才可能补发。
		// 让位本身要保留，但它必须有尽头：上界由 convergenceDeadlineAt 兜住（上面那一支），
		// 补发预算已耗尽时更是再等也无事可做——继续排 tick 只会让回执一直没有结论，故当场诚实收尾。
		if (!this.canInjectIntoTerminalNow(active)) {
			if (resendsLeft > 0) {
				this.scheduleSubmitConfirmTick(taskId, active, generation, resendsLeft, convergenceDeadlineAt);
				return;
			}
			logTuiFreezeError(
				`[tui-freeze] submit-unconfirmed taskId=${taskId} agentId=${entry.summary.agentId} ` +
					`reason=user-input-yield-with-resends-exhausted`,
			);
			// 同样只认自己那条投递：仍停在 awaiting_readiness 的在途投递不受本确认链成败牵连。
			settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
				active,
				"delivery_failed",
				"submit_confirmation_budget_exhausted",
			);
			return;
		}
		// 仍静默且可注入 → CR 被吞、框卡 idle：补发裸回车（绝不重 paste；空/已提交框上是 no-op，故万一误判已提交也无害）。
		if (resendsLeft <= 0) {
			// 预算耗尽仍未确认 → 醒目收尾日志（RVF 的 unconfirmed 仍如实反映，且有打点可查）。
			logTuiFreezeError(
				`[tui-freeze] submit-unconfirmed taskId=${taskId} agentId=${entry.summary.agentId} ` +
					`after ${SUBMIT_CONFIRM_MAX_RESENDS} resends`,
			);
			// 补发预算耗尽仍确认不到提交：文本很可能还躺在输入框里。这条必须诚实报失败——
			// 旧实现只打一行日志就收尾，调用方拿到的仍是「成功」，正是事故里 RVF 被误导的那一环。
			// 同样只认自己那条投递：仍停在 awaiting_readiness 的在途投递不受本确认链成败牵连。
			settleActiveProgrammaticDeliveryOnlyWhenAwaitingSubmitConfirmation(
				active,
				"delivery_failed",
				"submit_confirmation_budget_exhausted",
			);
			return;
		}
		active.session.write("\r");
		logTuiFreezeWarning(
			`[tui-freeze] submit-resend-cr taskId=${taskId} agentId=${entry.summary.agentId} remaining=${resendsLeft - 1}`,
		);
		this.scheduleSubmitConfirmTick(taskId, active, generation, resendsLeft - 1, convergenceDeadlineAt);
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
				// 读屏这只眼睛对这条会话管用——单调置位（见字段注释）。就绪判定与紧随其后的让路判定读的是
				// **两次**快照，中间 TUI 可能重绘掉整个框；这个置位正是让后者能把「这一帧读不出框」认成
				// 瞬态异常而不是结构性缺席的唯一依据。
				active.hasEverLocatedTerminalInputBoxOnScreen = true;
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
						// 投递挂起可见性同理，且更窄：它是「活 active 上此刻真有一条投递在等这个输入框」的派生读数，
						// 登记本体（单飞槽、重探定时器、回执 observer）全挂在 active 上，而重建条目恒 active: null，
						// 按构造不可能有任何在途投递。但它照样会上盘：完整 summary 经 listSummaries() 进 saveState /
						// shutdown 持久化，这个 sidecar 一起写下去。不在这里清，重启后就会广播一条「有 1 条程序化投递
						// 在等这个输入框」的假挂起，并在终端上方摆出「暂存我的输入并放行」，用户还可能对一条根本不
						// 存在的投递执行暂存——正是本轮工作要根除的那种不诚实。
						terminalDeliveryContention: null,
						// 同一 chokepoint 顺带补盖通道章：本改动之前落盘的记录没有这个字段，而
						// terminalManager 持有的会话按构造恒是 PTY 的，明写好过依赖读时回退派生。
						sessionTransport: "pty_terminal",
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
			settleActiveProgrammaticDelivery(entry.active, "delivery_failed", "session_ended_before_delivery");
			clearTaskChatInputDeliveryContentionVisibility(entry);
			clearTaskChatInputDeliveryTimer(entry.active);
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
			resumePriorAgentConversationWithoutResendingPrompt: request.resumePriorAgentConversationWithoutResendingPrompt,
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
			// paste 摄入证据的唯一来源（见 ptyOutputChunkArrivalSequenceNumber）。放在 lastOutputAt 之前，
			// 两者同批推进，读者拿到序号变化时镜像也已 applyOutput 完毕。
			entry.active.ptyOutputChunkArrivalSequenceNumber += 1;
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
					settleActiveProgrammaticDelivery(currentActive, "delivery_failed", "session_ended_before_delivery");
					clearTaskChatInputDeliveryContentionVisibility(currentEntry);
					clearTaskChatInputDeliveryTimer(currentActive);
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
				request.resumeFromTrash === true ||
				request.resumePriorAgentConversationWithoutResendingPrompt === true ||
				launch.resumesPriorAgentConversation === true,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			ptyOutputChunkArrivalSequenceNumber: 0,
			programmaticDeliveryReceipt: null,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			hasEverLocatedTerminalInputBoxOnScreen: false,
			terminalSessionIncarnationToken: randomUUID(),
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

		// 「本次启动没有新 prompt 被投出去」⇒ 开局回合归用户。垃圾桶恢复与通道切换重开都属此列。
		const startsWithoutSendingNewPrompt = Boolean(
			request.resumeFromTrash || request.resumePriorAgentConversationWithoutResendingPrompt,
		);
		// 但两者的**成因**不同，而成因决定 userTurnKind，进而决定后台程序化投递会不会让位：
		//   resumeFromTrash → "attention"（userTurnKind=needs_input）：从垃圾桶拖回来的会话确实需要人来看一眼。
		//   通道切换重开 → "hook"（userTurnKind=review）：agent 只是把回合交回来了，**没有任何东西在等你拍板**。
		// 用错成因的代价是实测出来的：needs_input 落在 MODAL_USER_DECISION_TURN_KINDS 里，
		// 于是 RVF / task message 这类后台投递会一直让位到预算耗尽，报 agent_awaiting_user_decision_timeout——
		// 而这条会话其实空闲着、随时可以收消息。ACP 侧同一场景用的也是 "hook"，两条通道必须一致。
		const startWithoutPromptReviewReason: RuntimeTaskSessionReviewReason = request.resumeFromTrash
			? "attention"
			: "hook";
		const startedAt = now();
		updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, startsWithoutSendingNewPrompt ? "awaiting_review" : "running", {
				reviewReason: startsWithoutSendingNewPrompt ? startWithoutPromptReviewReason : null,
				pid: session.pid,
				agentId: request.agentId,
			}),
			// 新活体：每次真实 spawn 换一个 id。回收调度器据此判断「已落盘的期限说的还是不是同一个
			// 活体」——同 taskId 重启出来的新会话绝不会被上一个活体留下的陈旧期限误杀。
			runtimeSessionIncarnationId: randomUUID(),
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: startsWithoutSendingNewPrompt ? startWithoutPromptReviewReason : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
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
			settleActiveProgrammaticDelivery(entry.active, "delivery_failed", "session_ended_before_delivery");
			clearTaskChatInputDeliveryContentionVisibility(entry);
			clearTaskChatInputDeliveryTimer(entry.active);
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
					// paste 摄入证据的唯一来源（见 ptyOutputChunkArrivalSequenceNumber）。放在 lastOutputAt 之前，
					// 两者同批推进，读者拿到序号变化时镜像也已 applyOutput 完毕。
					entry.active.ptyOutputChunkArrivalSequenceNumber += 1;
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
					settleActiveProgrammaticDelivery(currentActive, "delivery_failed", "session_ended_before_delivery");
					clearTaskChatInputDeliveryContentionVisibility(currentEntry);
					clearTaskChatInputDeliveryTimer(currentActive);
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
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			ptyOutputChunkArrivalSequenceNumber: 0,
			programmaticDeliveryReceipt: null,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			hasEverLocatedTerminalInputBoxOnScreen: false,
			terminalSessionIncarnationToken: randomUUID(),
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
		// 输入侧字节跟踪：维护「框里有没有未提交内容」并给被 TUI 折叠掉的粘贴留原文账本。
		// 必须在 session.write 之前记：这是纯内存计算，放前面才能保证「字节已进 PTY 但账没记上」
		// 这个窗口不存在——争用判定与 Ctrl+S 取文都读这本账，漏一段就是把人类内容判丢。
		recordTerminalInputBytesIntoOccupancyTracker(entry.active.inputBoxOccupancyTracker, data);
		// 人工手敲（含在 Claude resume 三选一菜单里选 1/2/3、或提交新消息）是「用户真·继续」的
		// agent 无关信号：解除 resume substantive guard，此后 agent 的新产出才推进 lastSubstantiveOutputAt。
		clearResumeSubstantiveGuard(entry.active);
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

	// 「这个终端的输入框此刻被人类占着吗」——输入侧字节跟踪与读屏两路的保守并集。
	// 返回 null 表示「拿不到关于当前这条 PTY 会话的可信结论」：要么该任务此刻没有 active PTY 会话
	// （也就无框可争），要么读屏期间这条会话已经退出 / 被 refresh 换成了新 incarnation（见下方复查）。
	//
	// 两路各自的盲区互补，所以必须都要：输入侧看不见经 tmux / 原生终端直连同一 PTY 敲进去的字，
	// 也看不见 runtime 重启前敲下的内容；读屏看不出空框与占位提示的区别、且对未建模输入框语法的
	// agent 直接失效。调用方若要按场景取舍，读返回值里两路分开的结论字段，别只看合并后的布尔。
	async resolveTaskTerminalInputBoxOccupancy(taskId: string): Promise<TerminalInputBoxOccupancy | null> {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return null;
		}
		const boxGrammar = resolveTerminalInputBoxGrammar(entry.summary.agentId);
		const mirror = entry.terminalStateMirror;
		const inputBoxReading =
			mirror && boxGrammar ? readTerminalInputBox(await mirror.getScreenSnapshot(), boxGrammar) : null;
		// 读屏要排进镜像的 operationQueue，这段 await 会跨越宏任务边界：期间 PTY 可能退出（exit handler
		// 把 entry.active 置 null）、或被用户 refresh 换成新 incarnation（startTaskSession 把 active 与
		// terminalStateMirror 一起换新）。所以在 await 前捕获 active，await 后复查它仍是当前这条命——
		// 否则既会解引用已被置空的 active，又会把**上一条会话**的读屏结论和新会话的输入侧账本拼成一个
		// 占用结论。换代即返回 null（无结论）而不是拿旧屏硬答，与程序化投递链路
		// （runTaskChatInputDeliveryAttempt）跨 await 复查 active 的写法一致。
		const currentActive = this.entries.get(taskId)?.active;
		if (!currentActive || currentActive !== active) {
			return null;
		}
		if (inputBoxReading !== null) {
			active.hasEverLocatedTerminalInputBoxOnScreen = true;
		}
		return resolveTerminalInputBoxOccupancy({
			trackerState: active.inputBoxOccupancyTracker,
			inputBoxReading,
		});
	}

	// 等终端字节短暂静默，好让最后几次 TUI 重绘落进镜像再读框。等不到就返回，调用方照常读——
	// 沉降是提高保真度的尽力而为，不是暂存的前置条件。
	//
	// 判据是两条静默的**合取**，缺一不可：
	//   - 输出侧（summary.lastOutputAt）：距最近一次 PTY 输出已过沉降窗 ⇒ 上一轮重绘已经画完并进了镜像。
	//   - 输入侧（active.lastUserInputAt，由 writeInput 维护，只记人类手敲）：距最近一次人类击键也已过
	//     沉降窗 ⇒ 那几个字符的回显要么已经回来（回来时会推进 lastOutputAt，于是被上一条接手继续等），
	//     要么至少已给它一个沉降窗的时间。
	// 只看输出侧不成立（这正是本条判据曾经的形态）：evaluateAgentOutputQuiet 对 lastOutputAt 为 null
	// （会话尚未产出过）或已陈旧（上一次重绘发生在 500ms 前、而刚敲下那几个字符的回显还在路上）**都**
	// 直接返回 true，循环立即退出，读到的是缺了最后几个字符的框——库里存进截断文本，随后转发的
	// Ctrl+S 又把完整输入清掉。普通击键走 IO WebSocket、暂存走 HTTP tRPC，两条通道之间无序，这个
	// 窗口是真实存在的，不是理论推演。
	// lastUserInputAt 为 null（本会话还没有人手敲过）不构成阻塞：那种情形下不存在「在路上的回显」。
	//
	// 残留窗口（**没有**被这条判据关掉，别当成已解决）：
	//   - 读框发生在某个时刻，此后到 Ctrl+S 字节被转发之间用户仍可能继续敲字；
	//   - 击键字节本身还没到达服务端（writeInput 尚未被调用，lastUserInputAt 还是旧值）时，本判据同样
	//     拦不住——跨通道无序无法靠单侧时间戳彻底消除。
	// 两者的代价都是「那几个字符没进库」，而不是「丢失」：转发的 Ctrl+S 交给 agent 自己清框，agent 的
	// 原生 stash 会把框里当时的全部内容接住，用户始终能拿回来。
	private async waitForTerminalMirrorToSettleBeforeInputBoxRead(taskId: string): Promise<void> {
		const waitStartedAtMs = now();
		while (now() - waitStartedAtMs < TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_MAX_WAIT_MS) {
			const entry = this.entries.get(taskId);
			if (!entry?.active) {
				return;
			}
			const nowMs = now();
			const terminalOutputHasBeenQuietForSettleWindow = evaluateAgentOutputQuiet(
				entry.summary.lastOutputAt ?? null,
				nowMs,
				TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_QUIET_MS,
			);
			// 与 isAgentOutputWithinActiveWindow 的边界语义保持一致：恰好等于窗口视为「已静默」。
			const humanKeystrokesHaveBeenQuietForSettleWindow =
				entry.active.lastUserInputAt === null ||
				nowMs - entry.active.lastUserInputAt >= TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_QUIET_MS;
			if (terminalOutputHasBeenQuietForSettleWindow && humanKeystrokesHaveBeenQuietForSettleWindow) {
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_POLL_MS));
		}
	}

	// Ctrl+S 暂存链路的第一步：把框里那段未提交的正文取出来（含把折叠占位符换回粘贴原文）。
	// **只读**，绝不动框——清框要等写库成功之后才由 forwardStashKeyToClearTaskTerminalInputBox 做。
	// 这个顺序保证任何一步失败时「库里没有 ⇒ 框里还在」，用户的字始终看得见。
	// 返回 null 表示该任务此刻没有可信的 PTY 会话（没有 active，或读取期间换了 incarnation）。
	async captureTaskTerminalInputBoxContentForPromptLibraryStash(
		taskId: string,
	): Promise<TaskTerminalInputBoxStashCapture | null> {
		if (!this.entries.get(taskId)?.active) {
			return null;
		}
		await this.waitForTerminalMirrorToSettleBeforeInputBoxRead(taskId);
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return null;
		}
		const boxGrammar = resolveTerminalInputBoxGrammar(entry.summary.agentId);
		const mirror = entry.terminalStateMirror;
		const inputBoxReading =
			mirror && boxGrammar ? readTerminalInputBox(await mirror.getScreenSnapshot(), boxGrammar) : null;
		// 与 resolveTaskTerminalInputBoxOccupancy 同一条理由：上面两处 await 都跨宏任务边界，期间 PTY 可能
		// 退出、或被 refresh 换成新 incarnation。换代即返回 null，绝不把上一条会话读到的正文写进库、
		// 再把清框字节发给新会话——那会同时污染库和清掉新会话里别的东西。
		const currentActive = this.entries.get(taskId)?.active;
		if (!currentActive || currentActive !== active) {
			return null;
		}
		if (inputBoxReading !== null) {
			active.hasEverLocatedTerminalInputBoxOnScreen = true;
		}
		const occupancy = resolveTerminalInputBoxOccupancy({
			trackerState: active.inputBoxOccupancyTracker,
			inputBoxReading,
		});
		const backfill = backfillFoldedPastePlaceholdersFromPasteLedger({
			inputBoxText: inputBoxReading?.text ?? "",
			pasteLedger: active.inputBoxOccupancyTracker.pasteLedger,
		});
		const fidelity: TerminalInputBoxStashFidelity = {
			softWrapJoinCount: inputBoxReading?.softWrapJoinCount ?? 0,
			foldedPastePlaceholderCount: backfill.foldedPastePlaceholderCount,
			backfilledPlaceholderCount: backfill.backfilledPlaceholderCount,
			placeholdersLeftUnbackfilledBecausePayloadWasDropped:
				backfill.placeholdersLeftUnbackfilledBecausePayloadWasDropped,
			placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched:
				backfill.placeholdersLeftUnbackfilledBecauseNoLedgerEntryMatched,
			placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed:
				backfill.placeholdersLeftUnbackfilledBecausePlaceholderSelfConsistencyCheckFailed,
			unrecoverablePasteCount: occupancy.unrecoverablePasteCount,
		};
		// 判空以**输入侧字节跟踪**为准，读屏只提供正文——这正是两个模块分工的定义（见
		// terminal-input-box-reader.ts 文件头 3）。屏上有字、输入侧却一个字节都没见过，最常见的解释是
		// Claude 在空框里渲染了占位提示（`Try "..."`，7 次探针里出现过 1 次），把那段 UI 文案当成用户资产
		// 存进库是纯污染。代价是输入侧的两处盲区（经 tmux / 原生终端直连同一 PTY 敲入、runtime 重启前
		// 敲下的内容）在这里也存不进库；但 Ctrl+S 字节照常转发，agent 的原生暂存仍然接得住，没有内容丢失。
		if (!occupancy.inputSideByteTrackingSaysNonEmpty) {
			return {
				status:
					backfill.text.trim().length > 0
						? "screen_text_not_corroborated_by_keystroke_tracking"
						: "input_box_empty",
				text: "",
				fidelity,
				terminalSessionIncarnationToken: active.terminalSessionIncarnationToken,
			};
		}
		if (backfill.text.trim().length === 0) {
			// 输入侧确知有内容，读屏却拿不到正文。报「读不到」而不是「空」——两者是不同的事实，
			// 把前者说成后者就是 2026-08-08 那类反向撒谎的同一种形态。
			return {
				status: "input_box_content_unreadable",
				text: "",
				fidelity,
				terminalSessionIncarnationToken: active.terminalSessionIncarnationToken,
			};
		}
		return {
			status: "captured_stashable_text",
			text: backfill.text,
			fidelity,
			terminalSessionIncarnationToken: active.terminalSessionIncarnationToken,
		};
	}

	// Ctrl+S 暂存的 per-task 独占闸门。
	//
	// 为什么落在 manager 而不是 runtime-api：manager 是 per-workspace 且长驻的，runtime-api 的 handler
	// 是每次请求新建的无状态闭包——把在途集合放进后者，作用域一散就没了，也拦不住两个浏览器标签页
	// 各发一份请求。放这里才是同一进程里唯一那份真相。
	//
	// 拦的是这条竞态：取文只读、不动框，写库又要跨文件锁与落盘（数十毫秒）。同一 taskId 上连按
	// Ctrl+S、或多标签页同时触发，两次取文会读到**同一份**正文，各自以不同 promptId 入库（库里凭空
	// 多出一条重复），然后各清一次框。
	//
	// 刻意**不**排队等前一次做完：排队的第二次醒来时框已被第一次清空，它只能报「框是空的」——用户按
	// 了两次却只有一次回执解释得通。当场如实回一句「已有一次暂存在进行中」，比一个语义已经错位的
	// 成功/空框回执诚实。代价是第二次按键不转发 Ctrl+S（agent 的原生 stash 这一次不参与），但框里的
	// 内容一个字都没少，用户可以再按。
	private readonly taskIdsWithTerminalInputBoxStashAttemptInFlight = new Set<string>();

	// 争用抢占的授权前提闩：只在 holdOrPreemptContendedTerminalInputBox 调用注入的抢占执行者期间武装，
	// 键为 taskId，值是**授权那一刻**的全部前提（见 TaskTerminalInputBoxPreemptionAuthorizationPremises）。
	//
	// 为什么值是 Set 而不是单份记录：武装发生在 per-task 独占闸门
	// （runTaskTerminalInputBoxStashAttemptExclusivelyPerTask）**之外**——闸门在抢占执行者内部才关上，
	// 而武装必须在把控制权交给执行者之前完成。于是同一 task 上完全可以有两条抢占同时挂着前提：先来的 A
	// 正拿着闸门做写库，更晚的投递 B 走到抢占点、武装、被闸门当场拒掉。旧实现用 `Map<taskId, 单份记录>`
	// + 「身份判等后再删」，在这个交错下会：B 的 set 静默盖掉 A 的记录，B 被拒后判等成立又把它删掉，
	// 于是 A 的清框回到「无闩」——也就是下面兑现点的默认放行分支，等同于「人手按了 Ctrl+S」，
	// 人已经回到终端在打字也照清不误。Set + 各撤各的，才让「谁武装的谁负责」这句话在重叠时仍然成立。
	//
	// 为什么需要它：抢占许可是在进入抢占**之前**读一次 lastUserInputAt 得出的（人已 5 分钟没敲过），
	// 而从那一刻到 Ctrl+S 真正被转发之间隔着一整条链路——per-task 独占闸门、读框沉降（最长
	// TERMINAL_INPUT_BOX_STASH_MIRROR_SETTLE_MAX_WAIT_MS=750ms）、镜像快照排队、prompt library 的
	// 跨进程文件锁与落盘（数十至数百毫秒）。这段窗口里人完全可能回到终端开始打字，而抢占执行者返回时
	// 框**已经被清掉了**：manager 在 await 之后只复查 active 身份与投递代际，救不回来。所以「人是否
	// 仍不在场」的复查必须下沉到链路上最后一个由 manager 说了算的点，也就是清框本身。
	//
	// 为什么挂在 manager 而不是 ActiveProcessState：闩必须能在「武装时的 active 已经被换掉」之后仍然
	// 判定得出「那次授权属于上一条命」——存进 active 就随 refresh 一起没了，正好在最需要它的换代情形下
	// 失效。manager 是 per-workspace 长驻的同一份真相，与 taskIdsWithTerminalInputBoxStashAttemptInFlight
	// 同理（见其注释）。
	//
	// 沉降判据（waitForTerminalMirrorToSettleBeforeInputBoxRead 里的击键静默合取）**不能**替代本闩：
	// 那条判据最多把读框推迟 750ms，等满就照读照清；且它只覆盖到读框那一刻，读框之后的写库与转发全程
	// 无人看守。
	private readonly taskTerminalInputBoxPreemptionHumanAbsencePremises = new Map<
		string,
		Set<TaskTerminalInputBoxPreemptionAuthorizationPremises>
	>();

	private armTaskTerminalInputBoxPreemptionAuthorizationPremises(
		taskId: string,
		premises: TaskTerminalInputBoxPreemptionAuthorizationPremises,
	): void {
		const premisesAlreadyArmedForThisTask = this.taskTerminalInputBoxPreemptionHumanAbsencePremises.get(taskId);
		if (premisesAlreadyArmedForThisTask) {
			premisesAlreadyArmedForThisTask.add(premises);
			return;
		}
		this.taskTerminalInputBoxPreemptionHumanAbsencePremises.set(taskId, new Set([premises]));
	}

	private disarmTaskTerminalInputBoxPreemptionAuthorizationPremises(
		taskId: string,
		premises: TaskTerminalInputBoxPreemptionAuthorizationPremises,
	): void {
		const premisesArmedForThisTask = this.taskTerminalInputBoxPreemptionHumanAbsencePremises.get(taskId);
		if (!premisesArmedForThisTask) {
			return;
		}
		premisesArmedForThisTask.delete(premises);
		// 空 Set 要连键一起删：兑现点用「这个 task 有没有挂着前提」区分 W1 抢占与 W2 手按 Ctrl+S，
		// 留一个空壳会把此后每一次手按 Ctrl+S 都错判成机器抢占（虽然空集合的全称判定恒真、目前放行，
		// 但那是靠巧合成立的，不该留给下一个人）。
		if (premisesArmedForThisTask.size === 0) {
			this.taskTerminalInputBoxPreemptionHumanAbsencePremises.delete(taskId);
		}
	}

	// 一次抢占授权在兑现那一刻是否仍然成立。三项全中才算成立，任一被推翻即不许清框。
	private taskTerminalInputBoxPreemptionAuthorizationPremisesStillHold(
		premises: TaskTerminalInputBoxPreemptionAuthorizationPremises,
		active: ActiveProcessState,
	): boolean {
		// 换代：这次授权属于上一条 PTY 命。通常在兑现点的 incarnation 令牌复查处就被挡下，但那道复查用的是
		// **取文那一刻**的令牌——若换代发生在武装之后、取文之前，令牌是新的、对得上，闩却是旧的。
		// 这一格补的就是那个错位：授权不是给这条 active 的，一律不兑现。
		if (premises.activeWhenPreemptionWasAuthorized !== active) {
			return false;
		}
		// 人在抢占在途期间回到了这个终端敲字（lastUserInputAt 只由 writeInput 推进，程序化投递直写
		// session.write 不会污染它，所以推进过就一定是人）。
		if (active.lastUserInputAt !== premises.lastUserInputAtWhenPreemptionWasAuthorized) {
			return false;
		}
		// 授权这次抢占的那条投递已被取消或被更晚的投递取代：这个框腾出来也没人写了。
		if (
			active.taskChatInputDeliveryGeneration !== premises.taskChatInputDeliveryGenerationWhenPreemptionWasAuthorized
		) {
			return false;
		}
		return true;
	}

	async runTaskTerminalInputBoxStashAttemptExclusivelyPerTask<AttemptResult>(
		taskId: string,
		runAttempt: () => Promise<AttemptResult>,
		buildResultWhenAnotherAttemptIsAlreadyInFlight: () => AttemptResult,
	): Promise<AttemptResult> {
		if (this.taskIdsWithTerminalInputBoxStashAttemptInFlight.has(taskId)) {
			return buildResultWhenAnotherAttemptIsAlreadyInFlight();
		}
		this.taskIdsWithTerminalInputBoxStashAttemptInFlight.add(taskId);
		try {
			return await runAttempt();
		} finally {
			// finally 而不是成功路径末尾：闸门泄漏一次，这个 task 此后再也暂存不了任何东西。
			this.taskIdsWithTerminalInputBoxStashAttemptInFlight.delete(taskId);
		}
	}

	// Ctrl+S 暂存链路的最后一步：把 Ctrl+S 字节转发给 agent，由它自己清框。
	//
	// 为什么是转发而不是我们自己发 Ctrl+C 清框：实测 Ctrl+U 只杀行、清不掉整框，Ctrl+C 才能清，而
	// Ctrl+C 在 agent 正生成回合时会打断回合。转发还顺带消解了「覆盖 Ctrl+S」与「另起一个快捷键」的
	// 取舍——agent 侧仍留一份原生 stash 作兜底，一个键做两件事，用户什么都没失去。
	//
	// 走 session.write 直写 PTY（不过 writeInput）：这不是人类击键，不该记 lastUserInputAt、更不该进
	// 粘贴账本。代价是跟踪器看不见这个字节，所以必须在这里显式把当前组合归零。
	//
	// expectedTerminalSessionIncarnationToken 必传，取自本次取文返回的 capture。取文只在自己内部复查过
	// incarnation，而**取文返回之后**调用方还要跨过写库（文件锁 + 落盘，数十毫秒）；这段时间里用户
	// refresh 终端就会整体换掉 entry.active，只按 taskId 重查会把清框字节打到新 PTY 上，清掉一段与本次
	// 暂存毫无关系的输入。令牌对不上一律返回 false，绝不「反正有个 active 就照打」。
	//
	// 返回值是这条链路的最后一个事实来源，调用方**不许吞**：false = 框没被清，回执必须如实反映
	// 「已入库但框还在」，不能继续报纯成功。
	//
	// 这里同时是抢占授权前提闩的兑现点（见 taskTerminalInputBoxPreemptionHumanAbsencePremises）。
	// 守卫**只在这个 task 此刻挂着抢占授权时生效**：W2 用户自己按下 Ctrl+S 那条路径从不武装闩，于是恒定
	// 放行——那条路径上人当然在场（他刚按了这个键），若按「人在场就不清」一刀切，等于把这个快捷键整个废掉。
	// 所以判据不是「人在不在」，而是「本次清框所依据的授权前提是不是已经被推翻」。
	//
	// 已知残留：本方法的签名里没有「这次清框属于哪条抢占 / 哪个投递代际」的身份，身份只能由 manager 从
	// 闩反推。签名归 W1 抢占与 W2 手按 Ctrl+S 共用，加必填参数要改到 src/trpc/runtime-api.ts 的两个调用
	// 点，故本轮维持现签名。可观察后果只有一种：W2 的转发恰好落在某条 W1 抢占「已武装、尚未撤闩」的窗口
	// 里（抢占武装后被 per-task 独占闸门当场拒掉的那一两个微任务）时，会跟着 W1 的前提一起被判——那一刻
	// 若前提已被推翻，用户这次 Ctrl+S 会拿到「已入库但框没清」。窗口是微任务量级、且退化方向安全（框里
	// 内容一个字不少、用户可再按一次）。
	forwardStashKeyToClearTaskTerminalInputBox(
		taskId: string,
		expectedTerminalSessionIncarnationToken: string,
	): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		if (entry.active.terminalSessionIncarnationToken !== expectedTerminalSessionIncarnationToken) {
			return false;
		}
		const activeThisClearWouldRideOn = entry.active;
		const premisesThisClearWouldRideOn = this.taskTerminalInputBoxPreemptionHumanAbsencePremises.get(taskId) ?? null;
		if (
			premisesThisClearWouldRideOn !== null &&
			![...premisesThisClearWouldRideOn].every((premises) =>
				this.taskTerminalInputBoxPreemptionAuthorizationPremisesStillHold(premises, activeThisClearWouldRideOn),
			)
		) {
			// 授权这次抢占的前提已经不成立（人回来打字 / 换代 / 投递被取消或被取代），不清框。
			//
			// 为什么是「所有挂着的前提都要成立」而不是挑一份：转发调用里没有任何「这次清框属于哪条抢占」
			// 的身份（forwardStashKeyToClearTaskTerminalInputBox 的签名归 W2 那条路径共用，加必填参数会
			// 改到 src/trpc/runtime-api.ts 的调用点），manager 只能从「此刻这个 task 上还挂着谁的授权」
			// 反推。全称判定是这里唯一守得住的读法：真正在兑现的那条抢占一定在集合里，只要它已失效就必被
			// 拦下；集合里另有一条尚未失效的抢占也不会把它放行。代价是「另一条抢占已失效、正在兑现的这条
			// 还有效」时也一并拒清——那是保守方向的误拒，框里内容一个字不少，可接受。
			//
			// 此刻正文**已经**进了 Prompt Library（写库在前、清框在后，这个次序本身是为「库里没有 ⇒ 框里
			// 还在」的安全性设的，不能倒过来）。于是留下的残留是：库里多一条与框里内容重复的条目，用户看得见、
			// 可删。用这条重复换掉「人正打字时框被清」，方向明确——本轮的核心不变量是「人在场时机器绝不动框」。
			// 调用方拿到 false ⇒ 回执落在既有的 stashed_into_prompt_library_but_input_box_not_cleared，
			// 抢占执行者据此返回 false，投递退回挂起等人处理。
			//
			// 这个窗口**没有被关死**，剩下的残留有多大：
			//   - 击键字节还在路上（人已经在敲，但 writeInput 尚未在服务端执行，lastUserInputAt 还是旧值）时，
			//     本守卫与沉降判据一样看不见——普通击键走 IO WebSocket、抢占走 HTTP tRPC，两条通道之间无序，
			//     单侧时间戳无法彻底消除这个错位；
			//   - 经 tmux / 原生终端直连同一条 PTY 敲入的字节根本不过 writeInput，输入侧账本全程是盲的；
			//   - 人恰好在清框字节写出去之后的下一毫秒才回来打字：那已经不在任何守卫能覆盖的范围内。
			// 三者的代价都是「那半句被 agent 自己的原生 stash 接住 / 已在库里」，不是丢失；剩余窗口从
			// 「整条抢占链路（可达数百毫秒至 1s+）」收窄到「转发那一刻的单次同步判定」。
			//
			// 代际这一格另有一条残留：被更晚的投递取代时这次清框被拒，那条更晚的投递下一拍重探仍会看见
			// 非空的框，于是**再**抢占一次、库里再多一条同样内容的条目。宁可留下这条可见可删的重复，
			// 也不能凭一条已经作废的投递去清框——它的抢占许可是按当时的争用策略与人类在场读数批的，
			// 取代它的那条投递必须自己重新过一遍那两道判定。
			return false;
		}
		entry.active.session.write(TERMINAL_STASH_KEY_SEQUENCE);
		resetTerminalInputBoxOccupancyTrackerComposition(entry.active.inputBoxOccupancyTracker);
		return true;
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
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		// 状态机翻 running 无条件；但 resume substantive guard 只在「用户真·继续」时解除——
		// 仅源自 UserPromptSubmit 的 to_in_progress 才算，PostToolUse 等自动续跑旧回合的中途活动不算，
		// 否则 Claude --continue 自动续跑一次工具调用就会误解除 guard、让重播刷 lastSubstantiveOutputAt。
		if (entry.active && options?.userInitiatedResume === true) {
			clearResumeSubstantiveGuard(entry.active);
		}
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
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
		settleActiveProgrammaticDelivery(entry.active, "delivery_failed", "session_ended_before_delivery");
		clearTaskChatInputDeliveryContentionVisibility(entry);
		clearTaskChatInputDeliveryTimer(entry.active);
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
		settleActiveProgrammaticDelivery(active, "delivery_failed", "session_ended_before_delivery");
		clearTaskChatInputDeliveryContentionVisibility(entry);
		clearTaskChatInputDeliveryTimer(active);
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
			settleActiveProgrammaticDelivery(entry.active, "delivery_failed", "session_ended_before_delivery");
			clearTaskChatInputDeliveryContentionVisibility(entry);
			clearTaskChatInputDeliveryTimer(entry.active);
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
