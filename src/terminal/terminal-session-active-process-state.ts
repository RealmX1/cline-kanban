import type { TerminalDeliveryFailureReason, TerminalDeliveryStatus } from "../core/api-contract";
import type { AgentOutputSubstanceMemory } from "./agent-output-substance";
import type { AgentOutputTransitionDetector, AgentOutputTransitionInspectionPredicate } from "./agent-session-adapters";
import type { KanbanAssignedCursorAgentChatFirstPromptPersistenceWatch } from "./cursor-agent-chat-launch-identity-orchestration";
import type { OutputReactionEngine, OutputReactionSessionState } from "./output-reactions";
import type { TerminalInputBoxOccupancyTrackerState } from "./terminal-input-box-occupancy";
import type { TerminalProtocolFilterState } from "./terminal-protocol-filter";
import type { TerminalPtyProcessHandle } from "./terminal-pty-process-handle";

// session-manager 为每条活着的 PTY「代」持有的全部内存态（entry.active）。
//
// 从 session-manager.ts 抽出：热重启方案要在独立模块里逐字段归类「跨 runtime 重启时这个字段怎么处置」
// （随接管记录携带 / 取自 PTY host / 按 agent 重新派生 / 重置），并用
// `satisfies Record<keyof ActiveProcessState, …>` 让新增字段不归类就编译不过。那张表若放在
// session-manager 里会继续加重这个已近 6000 行的文件，放在别处又会与它循环导入。

export interface ActiveProcessState {
	session: TerminalPtyProcessHandle;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupPromptText: string | null;
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
	// trySubmitDeferredStartupPrompt；命中 predicate 或 session 退出时由调用方清掉。
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
	// 本代 PTY 的装载时刻，与 terminalSessionIncarnationToken 同族、同生共死。
	//
	// 用途只有一个：自动重启熔断器要判「上一代活了多久」——活够 MINIMUM_PTY_LIFETIME_… 算健康启动、
	// 给连续失败计数衰减；不到就算 fast-exit，计入失败并触发退避。
	//
	// 为什么不复用 summary.startedAt：它有三条路径会变成 null（spawn 失败、recoverStaleSession 把会话
	// 打回 idle、entry 初始默认值），复用就必须为 null 定一套语义，而两种定法都有实害——判「不健康」
	// 会把「不知道」当成失败、误熔断健康会话；判「跳过」则恰好在 recoverStaleSession 这条路径上完全
	// 失明，而那正是「反复陈旧化 → 前端自动续跑」这类成环形态的样子。本字段与 active 同生共死，结构上
	// 不存在 null。何况 summary.startedAt 是给 UI 的展示字段，它的含义将来若被改动，不该静默改掉熔断判定。
	terminalSessionIncarnationSpawnedAtEpochMs: number;
	// 「kanban 分配 id 的全新开局，首轮有没有落进 cursor 的 chat store」看门狗（只有 Cursor 会创建）。
	// 由卡顿扫描每轮推进，对话建立后置 null；PTY 退出时若仍未建立，就把会话标成「从未建立对话」。
	kanbanAssignedCursorAgentChatFirstPromptPersistenceWatch: KanbanAssignedCursorAgentChatFirstPromptPersistenceWatch | null;
	// 最近已应用的 hook 投递幂等 key（新的在后，上限见 MAX_RECENTLY_APPLIED_HOOK_EVENT_DELIVERY_IDEMPOTENCY_KEYS）。
	// 同一个 hook 事件可能送达两次：CLI 超时后重试、或旧 runtime 已应用却没来得及回响应就崩溃，CLI 随后把它
	// spool 进 agent session PTY host、由新 runtime 重放。命中即确认、不再应用；所以它随接管记录跨 runtime 重启。
	recentlyAppliedHookEventDeliveryIdempotencyKeys: string[];
}

// 一条程序化投递的回执登记。存在的意义：让投递链路上**每一个出口**都能给出结论，
// 而不是像 2026-08-08 之前那样只有「写进去了」这一条路径有反馈、其余出口一律静默。
export interface PendingProgrammaticDeliveryReceipt {
	// 取消要认的 key；用户发起的发送没有 key（不写账本），恒 null。
	idempotencyKey: string | null;
	// awaiting_readiness：还没写进 PTY，取消能真正拦下。
	// awaiting_submit_confirmation：已写入、正在等提交确认，取消已经晚了。
	phase: "awaiting_readiness" | "awaiting_submit_confirmation";
	promptText: string;
	// null 表示只粘贴、还没写提交 CR；计数器区分 CR 前的回显与提交后的新输出。
	outputChunkArrivalSequenceNumberAtSubmitCarriageReturn: number | null;
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
