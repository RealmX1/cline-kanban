import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ensureInstructionsFileMock = vi.hoisted(() => vi.fn(async () => "/tmp/network-interruption-resume.md"));
// 捕获 [tui-freeze] 日志以断言投递的 via= 通道（prompt-ready / output-quiet / deadline-fallback）
// 与写后确认链（submit-confirmed / submit-resend-cr）；error 级捕获 submit-unconfirmed 收尾日志。
const tuiFreezeWarnings = vi.hoisted(() => [] as string[]);
const tuiFreezeErrors = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/diagnostics/tui-freeze-logger.js", () => ({
	logTuiFreezeWarning: (message: string) => {
		tuiFreezeWarnings.push(message);
	},
	logTuiFreezeError: (message: string) => {
		tuiFreezeErrors.push(message);
	},
}));

// paste 框架用哨兵替身：本套件验证 submitTaskChatInputWhenReady 的「就绪门控 + 争用让路 +
// 以原始文本委托编码 + 分离写 + Codex 置位」契约；bracketed-paste 的真实编码由
// agent-session-adapters 自身单测与 session-manager-connection-drop 集成测试覆盖。
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	// 形态 2 之后，投递路径写的是「paste 框架」+「单独的提交 CR」两次。哨兵只替身框架那一半，
	// CR 用真实字节，于是「分两次写、第二次才是 CR」这条契约在断言里看得见。
	toBracketedPasteFramingWithoutTrailingSubmit: (command: string) => `SUBMIT[${command}]`,
	BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN: "\u000d",
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 避免向真实 home 目录写续跑指令文件（startTaskSession 挂载输出反应引擎时会幂等落盘）。
vi.mock("../../../src/terminal/output-reactions/network-interruption-continuation-instructions.js", () => ({
	ensureNetworkInterruptionResumeInstructionsFile: ensureInstructionsFileMock,
	getNetworkInterruptionResumeInstructionsPath: () => "/tmp/network-interruption-resume.md",
	buildNetworkInterruptionContinuationLine: (path: string) => `继续：请先按 ${path} 自查并恢复，再继续。`,
}));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS,
	TerminalSessionManager,
} from "../../../src/terminal/session-manager";
import {
	createTerminalInputBoxOccupancyTrackerState,
	recordTerminalInputBytesIntoOccupancyTracker,
	resetTerminalInputBoxOccupancyTrackerComposition,
	type TerminalInputBoxOccupancyTrackerState,
} from "../../../src/terminal/terminal-input-box-occupancy";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: vi.fn(() => false),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

// 纯净的 Claude 输入框就绪信号（无连接错误文案，避免触发 connection-drop episode 干扰投递）。
const CLAUDE_READY_PROMPT = "╭──────────────────────╮\n│ > │\n╰──────────────────────╯";

// 结构就绪判定（terminal-input-box-reader）读的是 buffer 行，不是 serialize 出来的字符串。
// fake 按同一契约从视口文本派生行快照。注意本套件的提示符 fixture 用的是**旧版** `╭` / `>` 画法，
// 结构判定对它不命中 → 判定继续落到下面的正则通道，既有用例语义原样保持。
function toScreenSnapshot(viewportText: string, columnCount = 80) {
	return {
		lines: viewportText.split("\n").map((text) => ({ text, isWrapped: false })),
		columnCount,
	};
}

// submitTaskChatInputWhenReady 的就绪门控时序常量（须与 session-manager.ts 同步）：
//   TASK_CHAT_INPUT_DELIVERY_SETTLE_MS=1000 / _RECHECK_MS=1500 / _DEADLINE_MS=60000。
const SETTLE_MS = 1_000;
const RECHECK_MS = 1_500;
const PAST_DEADLINE_MS = 65_000;
// 须与 session-manager.ts 同步：用户手敲抑制窗 8s、deadline(60s) 后让路防饿死硬上限 15s。
const USER_INPUT_SUPPRESS_MS = 8_000;
// Fix B 让位的饿死上限（TASK_CHAT_INPUT_DELIVERY_MAX_USER_TURN_YIELD_MS）。
const MAX_USER_TURN_YIELD_MS = 120_000;
const DEADLINE_PLUS_MAX_YIELD_MS = 60_000 + 15_000;
// 分离写的摄入证据等待预算（PASTE_INGESTION_EVIDENCE_MAX_WAIT_BEFORE_SUBMIT_MS）。本套件的 fake PTY
// 不回流输出 ⇒ 证据永不出现 ⇒ 每次都等满预算才单独发出提交 CR，确认链自那一刻才起跑。
const PASTE_INGESTION_MAX_WAIT_MS = 1_500;
// 摄入证据的轮询间隔（PASTE_INGESTION_EVIDENCE_POLL_BEFORE_SUBMIT_MS）。
const PASTE_INGESTION_EVIDENCE_POLL_MS = 60;
// 「人此刻在不在这个终端跟前」的判据窗（HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS）。
const HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS = 5 * 60_000;
// 写后确认闭环常量（须与 session-manager.ts 同步）：确认延时 2.5s、最多补发 3 次裸回车。
const SUBMIT_CONFIRM_DELAY_MS = 2_500;
const SUBMIT_CONFIRM_MAX_RESENDS = 3;
// 整条确认链（含「用户正在手敲」让位重排）的绝对收敛上界 SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS。
const SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS = 15_000;

// 构造一个用 fake mirror 的最小 claude 会话 entry（fake-timer 下确定性，避免 await 真实 headless xterm）。
// 返回 write spy 与 entry，便于测试在推进过程中改写 active.lastUserInputAt 模拟用户打字。
function installFakeClaudeEntry(
	manager: TerminalSessionManager,
	taskId: string,
	options: {
		mirrorSnapshot: string;
		state: string;
		reviewReason?: string | null;
		lastOutputAt?: number | null;
		lastUserInputAt?: number | null;
		// 直接给三元 facet 时走 facet 权威路径（resolveSessionFacets 要求三者同时非 undefined），
		// 用于构造 legacy reviewReason 投影不出来的模态待答态（question / plan_review / permission）。
		facets?: { turnOwner: string | null; liveness: string; userTurnKind: string | null };
		// 让用例直接给一份「人类已经打了字、尚未提交」的输入侧账本，用于争用分层。
		inputBoxOccupancyTracker?: TerminalInputBoxOccupancyTrackerState;
	},
) {
	const write = vi.fn();
	const summary = {
		taskId,
		agentId: "claude",
		state: options.state,
		reviewReason: options.reviewReason ?? null,
		lastOutputAt: options.lastOutputAt ?? null,
		...(options.facets ?? {}),
	} as unknown as RuntimeTaskSessionSummary;
	const entry = {
		summary,
		active: {
			session: { write },
			outputReactionScanBuffer: null,
			deferredStartupInput: null,
			lastUserInputAt: options.lastUserInputAt ?? null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null,
			awaitingCodexPromptAfterEnter: false,
			// 争用判据（框空即放行）读它；默认空账本 = 输入侧说「框里没有未提交内容」。
			inputBoxOccupancyTracker: options.inputBoxOccupancyTracker ?? createTerminalInputBoxOccupancyTrackerState(),
			// paste 摄入证据的计数器；fake PTY 不产生输出，故恒为 0，摄入门控每次都走到预算上限再发 CR。
			ptyOutputChunkArrivalSequenceNumber: 0,
			terminalSessionIncarnationToken: `${taskId}-incarnation`,
		},
		// 就绪判定读 getViewportSnapshot（活动屏，scrollback:0）；fake 的 mirrorSnapshot 即视口内容。
		terminalStateMirror: {
			getSnapshot: async () => ({ snapshot: options.mirrorSnapshot, cols: 80, rows: 24 }),
			getViewportSnapshot: async () => ({ snapshot: options.mirrorSnapshot, cols: 80, rows: 24 }),
			getScreenSnapshot: async () => toScreenSnapshot(options.mirrorSnapshot),
		},
		listenerIdCounter: 1,
		listeners: new Map(),
	};
	(manager as unknown as { entries: Map<string, typeof entry> }).entries.set(taskId, entry);
	return { write, entry };
}

function spawnManagerWithSession(pid: number) {
	let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		spawnedSession = createMockPtySession(pid, request);
		return spawnedSession;
	});
	return () => spawnedSession;
}

async function startSession(
	manager: TerminalSessionManager,
	taskId: string,
	options: { agentId?: "claude" | "codex" | "droid"; autoContinue?: boolean } = {},
) {
	await manager.startTaskSession({
		taskId,
		agentId: options.agentId ?? "claude",
		binary: options.agentId ?? "claude",
		args: [],
		cwd: `/tmp/${taskId}`,
		prompt: "Do the task",
		autoContinueOnConnectionDropEnabled: options.autoContinue ?? true,
	});
}

describe("session-manager · submitTaskChatInputWhenReady（RVF followup 就绪门控投递）", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		tuiFreezeWarnings.length = 0;
		tuiFreezeErrors.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("提示符就绪时：经沉降延时后向 PTY 投递一次（以原始文本委托编码）", async () => {
		const getSession = spawnManagerWithSession(2001);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-ready");
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_READY_PROMPT);
		const accepted = manager.submitTaskChatInputWhenReady("task-deliver-ready", "继续 RVF");
		expect(accepted).not.toBeNull();
		// 沉降期内不立即写（这正是修复点：避免 Stop 后 TUI 重绘态下立即写导致 CR 被吞）。
		expect(write).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		manager.stopTaskSession("task-deliver-ready");
	});

	it("起初未就绪、之后变就绪：仅在变就绪后的轮询写入", async () => {
		const getSession = spawnManagerWithSession(2002);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-later");
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		// 未触发任何提示符输出 → 扫描缓冲与镜像皆无就绪信号。
		manager.submitTaskChatInputWhenReady("task-deliver-later", "继续 RVF");

		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).not.toHaveBeenCalled();

		// 现在渲染出输入框 → 下一次轮询命中就绪。
		(session as NonNullable<typeof session>).triggerData(CLAUDE_READY_PROMPT);
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		manager.stopTaskSession("task-deliver-later");
	});

	it("始终未就绪：deadline 到点不再无条件强写，转终态 delivery_failed{terminal_prompt_readiness_timeout}", async () => {
		// 形态 3 的行为反转。旧实现在这里 best-effort 强写，于是「TUI 从没就绪过」永远不会成为失败，
		// 调用方拿到的回执与真实情况脱节；文本还被泼进一个未知形态的界面。
		const getSession = spawnManagerWithSession(2003);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-deadline");
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		const outcomes: { status: string; reason: string | null }[] = [];
		manager.submitTaskChatInputWhenReady("task-deliver-deadline", "继续 RVF", {
			idempotencyKey: "key-readiness-timeout",
			onDeliveryOutcome: (outcome) => {
				outcomes.push({ status: outcome.status, reason: outcome.reason });
			},
		});
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);

		const pasteSubmissions = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(pasteSubmissions).toHaveLength(0);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "terminal_prompt_readiness_timeout" }]);
		expect(tuiFreezeErrors.some((line) => line.includes("reason=terminal_prompt_readiness_timeout"))).toBe(true);

		manager.stopTaskSession("task-deliver-deadline");
	});

	it("投递窗口内 session 结束（stopTaskSession 清定时器）：不再写入", async () => {
		const getSession = spawnManagerWithSession(2004);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-stopped");
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		manager.submitTaskChatInputWhenReady("task-deliver-stopped", "继续 RVF");
		// stopTaskSession 的 teardown 会清掉 taskChatInputDeliveryTimer（本次修复新增的清理点之一）。
		manager.stopTaskSession("task-deliver-stopped");
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).not.toHaveBeenCalled();
	});

	// 通道切换会停掉当前 PTY 会话再用另一条通道重开。停会话的那一刻，任何在途的程序化投递
	// 都必须当场落定——否则它的等待者（RVF / `kanban task message --wait-for-terminal-status`）
	// 会一直挂到下次 runtime 启动清扫，违反投递账本「唯一非终态必然有界收敛」的不变量。
	// 这条走的是 stopTaskSession 这条通用出口，故对「用户手动 Stop」「回收」「通道切换」一体生效。
	it("停会话时把在途程序化投递当场落定为 delivery_failed{session_ended_before_delivery}", async () => {
		spawnManagerWithSession(2050);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-stopped-receipt");

		const outcomes: { status: string; reason: string | null }[] = [];
		const onDeliveryOutcome = (outcome: { status: string; reason: string | null }): void => {
			outcomes.push(outcome);
		};
		manager.submitTaskChatInputWhenReady("task-deliver-stopped-receipt", "继续 RVF", {
			idempotencyKey: "key-stopped-receipt",
			onDeliveryOutcome,
		});
		expect(outcomes).toEqual([]);

		manager.stopTaskSession("task-deliver-stopped-receipt");
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);

		// 落定是一次性的：后续推进时间不会再补发第二条结论。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(outcomes).toHaveLength(1);
	});

	// enter 守卫（awaitingCodexPromptAfterEnter）的语义是「刚刚发过回车、下一个 prompt-ready 该被消费」，
	// 所以它必须跟着**提交 CR** 置位，而不是跟着 paste 框架。分离写之后这两件事相差最多一个摄入等待窗
	// （1.5s）：窗内 codex 的 paste 回显会重画行首 `›`、触发 prompt-ready，若守卫已提前武装，那一帧就会被
	// 当成「回车已发」，把 awaiting_review 误翻成 running——而消息其实一个字节都还没提交。
	it("Codex：awaitingCodexPromptAfterEnter 跟着提交 CR 置位，摄入等待窗内不武装", async () => {
		const getSession = spawnManagerWithSession(2005);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-codex", { agentId: "codex" });
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;
		const readAwaitingFlag = (): boolean | undefined =>
			(
				manager as unknown as {
					entries: Map<string, { active: { awaitingCodexPromptAfterEnter: boolean } | null }>;
				}
			).entries.get("task-deliver-codex")?.active?.awaitingCodexPromptAfterEnter;

		// codex 的就绪信号走扫描缓冲快路径（尚未建模输入框结构）。
		(session as NonNullable<typeof session>).triggerData("OpenAI Codex (v1.0.0)\n› ");
		manager.submitTaskChatInputWhenReady("task-deliver-codex", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(1);
		// 摄入等待窗内：CR 尚未写出 ⇒ enter 守卫必须仍未武装。
		expect(write.mock.calls.some((call) => String(call[0]) === "\r")).toBe(false);
		expect(readAwaitingFlag()).toBe(false);

		// 摄入预算耗尽 ⇒ 提交 CR 单独写出 ⇒ 此刻才置位。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);
		expect(write.mock.calls.some((call) => String(call[0]) === "\r")).toBe(true);
		expect(readAwaitingFlag()).toBe(true);

		manager.stopTaskSession("task-deliver-codex");
	});

	it("无活跃 session：返回 null 且不写入", async () => {
		const manager = new TerminalSessionManager();
		const result = manager.submitTaskChatInputWhenReady("nonexistent", "继续 RVF");
		expect(result).toBeNull();
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
	});

	it("反应引擎关闭时：经永远在线的镜像快照判定就绪并投递", async () => {
		// autoContinue=false → outputReactionScanBuffer 为 null，就绪判定回退到 terminalStateMirror 快照。
		// 用受控的 fake mirror 保证 fake-timer 下确定性（避免 await 真实 headless xterm 写回调）。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		// state:"running" → resolveSessionFacets 解析出 turnOwner:"agent"，使 A2 idle 兜底门控关闭，
		// 本例就绪走镜像快照命中（"prompt"），不被 quiet 兜底抢跑。
		const summary = {
			taskId: "task-deliver-mirror",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: CLAUDE_READY_PROMPT, cols: 80, rows: 24 }),
				getViewportSnapshot: async () => ({ snapshot: CLAUDE_READY_PROMPT, cols: 80, rows: 24 }),
				getScreenSnapshot: async () => toScreenSnapshot(CLAUDE_READY_PROMPT),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-deliver-mirror", entry);

		const accepted = manager.submitTaskChatInputWhenReady("task-deliver-mirror", "继续 RVF");
		expect(accepted).not.toBeNull();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
	});

	// 形态 1 回归守卫（2026-08-08 事故）：Claude v2.1.226+ 把输入框改成「整行 U+2500 横线 + `❯`」，
	// 旧的提示符正则对它恒不命中，于是 readiness 的 "prompt" 通道对当前 Claude 永久失效。
	// 结构判定（读镜像 buffer 行、判「有被边界线夹住且首行以提示符开头的区域」）必须在此命中并投递，
	// 而不是拖满 60s deadline——那正是「消息在输入框里躺了 49 分钟」的第一层成因。
	it("形态 1：当前版 Claude 渲染（❯ + 长横线）经结构判定就绪并投递，不拖到 deadline", async () => {
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		// state:"running" → turnOwner:"agent"，关掉 A2 quiet 兜底，确保本例只能靠 "prompt" 通道命中。
		const summary = {
			taskId: "task-deliver-current-rendering",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		// 真机形态：横线宽度 == cols，提示符是 `❯` + U+00A0，框下面还有状态行。
		const boundary = "─".repeat(80);
		const currentRenderingViewport = ["  ⏺ 上一轮 agent 输出", boundary, "❯ ", boundary, "  ⏸ manual mode on"].join(
			"\n",
		);
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: currentRenderingViewport, cols: 80, rows: 24 }),
				getViewportSnapshot: async () => ({ snapshot: currentRenderingViewport, cols: 80, rows: 24 }),
				getScreenSnapshot: async () => toScreenSnapshot(currentRenderingViewport),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set(
			"task-deliver-current-rendering",
			entry,
		);

		const accepted = manager.submitTaskChatInputWhenReady("task-deliver-current-rendering", "继续 RVF");
		expect(accepted).not.toBeNull();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);

		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
	});

	// 结构判定不得把 agent 输出里的装饰性横线当成输入框——那会把投递写进正在出输出的非就绪窗口，
	// 正是「粘贴了但 CR 被吞、不发送」那个竞态。没有提示符行就不算框。
	it("形态 1 反向：只有装饰性横线、没有提示符行 → 结构判定不命中，不提前投递", async () => {
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		const summary = {
			taskId: "task-decorative-rules",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const boundary = "─".repeat(80);
		const decorativeOnlyViewport = [boundary, "  agent 正在打印一张表格", boundary, "  还在出输出"].join("\n");
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: decorativeOnlyViewport, cols: 80, rows: 24 }),
				getViewportSnapshot: async () => ({ snapshot: decorativeOnlyViewport, cols: 80, rows: 24 }),
				getScreenSnapshot: async () => toScreenSnapshot(decorativeOnlyViewport),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-decorative-rules", entry);

		manager.submitTaskChatInputWhenReady("task-decorative-rules", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();

		// 到 deadline 也不写：装饰性横线不是输入框，硬写就是把 paste 泼进正在出输出的屏幕。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).not.toHaveBeenCalled();
	});

	it("镜像就绪只看当前视口：提示符仅存在于 scrollback 历史时不判就绪（仅 deadline 兜底）", async () => {
		// Issue 1 回归守卫：getSnapshot() 含完整 scrollback，历史里早先出现过的提示符框不能让「当前屏」误判就绪。
		// 构造 rows=5 的快照：开头 3 行是就绪提示符框（位于 scrollback 历史），最后 5 行（= 当前视口）是
		// 正在出输出、无提示符。若就绪判定看完整快照会误判 true（旧 bug）；只看最后 rows 行则判 false。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		// state:"running" → turnOwner:"agent" 关闭 A2 idle 兜底，使本例保持「视口无提示符 → 仅 deadline 兜底」
		// 的原始意图（否则 quiet 兜底会在 SETTLE 即判就绪、抢在 deadline 之前写入）。
		const summary = {
			taskId: "task-deliver-viewport",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const midOutputViewport = [
			"正在执行第 1 步…",
			"正在执行第 2 步…",
			"正在执行第 3 步…",
			"正在执行第 4 步…",
			"正在执行第 5 步…",
		].join("\n");
		const snapshotWithPromptOnlyInScrollback = `${CLAUDE_READY_PROMPT}\n${midOutputViewport}`;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			// 真实 mirror 的 getViewportSnapshot 只序列化活动屏（scrollback:0）——提示符框只存在于
			// scrollback 时视口里没有它。fake 按同一契约分别给出「全量」与「视口」两份内容；就绪判定
			// 若（回归地）改回读全量 getSnapshot 会误判就绪、在 deadline 之前写入，本测试即失败。
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: snapshotWithPromptOnlyInScrollback, cols: 80, rows: 5 }),
				getViewportSnapshot: async () => ({ snapshot: midOutputViewport, cols: 80, rows: 5 }),
				// 结构判定同样只看活动屏：提示符只在 scrollback 里时，行快照里也不该有它。
				getScreenSnapshot: async () => toScreenSnapshot(midOutputViewport),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-deliver-viewport", entry);

		manager.submitTaskChatInputWhenReady("task-deliver-viewport", "继续 RVF");
		// 视口（最后 5 行）无提示符 → 不就绪 → 沉降后及随后的轮询都不写。
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).not.toHaveBeenCalled();
		// 始终非就绪 → 一个字节都不写，最终以 terminal_prompt_readiness_timeout 收尾。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).not.toHaveBeenCalled();
		expect(tuiFreezeErrors.some((line) => line.includes("reason=terminal_prompt_readiness_timeout"))).toBe(true);
	});

	it("扫描缓冲里的陈旧提示符不判就绪：Claude 正在出输出时不提前投递（仅 deadline 兜底）", async () => {
		// 回归守卫：outputReactionScanBuffer 是 16K 滚动窗口，只追加、只从左截断、**从不按回合清空**，
		// 因此是 scrollback 形状的证据而非「当前屏」。生产中（autoContinue 默认开）它对 claude 恒非 null，
		// 一次真实 idle 提示符进窗口后会让就绪判定在 agent 正在重绘期间仍判 "prompt"，投递写进重绘中的
		// TUI —— 就是「粘贴了但 CR 被吞、不发送」的竞态。就绪必须只由当前活动屏（结构判定 / 视口正则）决定。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		// state:"running" → turnOwner:"agent"，关掉 A2 quiet 兜底，使本例只可能经 "prompt" 通道提前写。
		const summary = {
			taskId: "task-stale-scan-buffer",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const boundary = "─".repeat(80);
		// 缓冲里先有一帧真实 idle 输入框（当前版渲染），随后 agent 又开始出输出——但框还没被挤出窗口。
		const scanBufferWithStalePrompt = [
			"  ⏺ 上一轮结束",
			boundary,
			"❯ ",
			boundary,
			"  ⏸ manual mode on",
			"  ⏺ 新一轮开始：正在执行第 1 步…",
			"  ⏺ 正在执行第 2 步…",
		].join("\n");
		// 当前活动屏正在出输出：既无输入框结构、也无提示符字符。
		const midOutputViewport = ["  ⏺ 正在执行第 3 步…", "  ⏺ 正在执行第 4 步…", "  ⏺ 正在执行第 5 步…"].join("\n");
		const entry = {
			summary,
			active: {
				session: { write },
				// 关键：非 null 且含陈旧提示符——生产中启用 output-reaction 时的真实形态。
				outputReactionScanBuffer: scanBufferWithStalePrompt,
				outputReactionEngine: null,
				outputReactionSession: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: midOutputViewport, cols: 80, rows: 3 }),
				getViewportSnapshot: async () => ({ snapshot: midOutputViewport, cols: 80, rows: 3 }),
				getScreenSnapshot: async () => toScreenSnapshot(midOutputViewport),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-stale-scan-buffer", entry);

		manager.submitTaskChatInputWhenReady("task-stale-scan-buffer", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).not.toHaveBeenCalled();

		// 始终非就绪 → 一个字节都不写（旧实现在这里 deadline 强写，via=deadline-fallback）。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).not.toHaveBeenCalled();
		expect(tuiFreezeWarnings.some((line) => line.includes("task-chat-input-delivered"))).toBe(false);
		expect(tuiFreezeErrors.some((line) => line.includes("reason=terminal_prompt_readiness_timeout"))).toBe(true);
	});

	it("尚未建模输入框结构的 agent（codex）：扫描缓冲快路径保持既有语义，命中即投递", async () => {
		// 上一条回归守卫刻意只关掉 claude 的扫描缓冲快路径（它有结构判定顶上）。codex / kimi 尚未建模
		// 输入框结构，快路径仍是它们最便宜的就绪信号，语义必须原样保留——本例即该不对称性的钉子。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		const summary = {
			taskId: "task-codex-scan-fast-path",
			agentId: "codex",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: "OpenAI Codex (v1.0.0)\n› ",
				outputReactionEngine: null,
				outputReactionSession: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			// 镜像通道给不出就绪信号：若快路径被误删，本例只能拖到 deadline，测试即失败。
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: "正在执行…", cols: 80, rows: 3 }),
				getViewportSnapshot: async () => ({ snapshot: "正在执行…", cols: 80, rows: 3 }),
				getScreenSnapshot: async () => toScreenSnapshot("正在执行…"),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-codex-scan-fast-path", entry);

		manager.submitTaskChatInputWhenReady("task-codex-scan-fast-path", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
	});

	it("无 TUI 就绪预测的终端 agent（droid）：经沉降后立即投递，不拖到 deadline", async () => {
		// Issue 3 回归守卫：droid / kiro 等没有提示符就绪信号的终端 agent，就绪判定应返回 true（立即投递），
		// 而非一律落到 60s deadline——后者相对就绪门控前的即时写是回归。
		const getSession = spawnManagerWithSession(2006);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-droid", { agentId: "droid" });
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		// 不渲染任何提示符框（droid 本就没有可探测的就绪信号）。
		manager.submitTaskChatInputWhenReady("task-deliver-droid", "继续 RVF");
		expect(write).not.toHaveBeenCalled();
		// 沉降后即就绪（无预测 → true）→ 立即写入，无需等 deadline。
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		manager.stopTaskSession("task-deliver-droid");
	});

	it("跨 await 的 last-write-wins：在途旧投递被新投递取代后不写旧文本，只写最新一次", async () => {
		// Issue 2 回归守卫：旧 attempt 已过定时器、正 await resolveInteractivePromptReadiness 时，
		// 新的 submitTaskChatInputWhenReady 自增代际令旧 attempt 在 await 返回后放弃；最终只投递最新文本一次。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		// state:"running" → turnOwner:"agent"（本例就绪走镜像快照命中，与 A2 兜底无关，仅保真）。
		const summary = {
			taskId: "task-deliver-lww",
			agentId: "claude",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		// 受控 mirror：getViewportSnapshot（就绪判定实际 await 的方法）返回一个直到我们放行才 resolve
		// 的 promise，模拟「旧 attempt 卡在 await 中」。
		let releaseFirstSnapshot: (() => void) | null = null;
		let snapshotCalls = 0;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: CLAUDE_READY_PROMPT, cols: 80, rows: 24 }),
				// 旧画法 fixture 上结构判定不命中，故挂起点仍落在 getViewportSnapshot（本用例的模拟对象）。
				getScreenSnapshot: async () => toScreenSnapshot(CLAUDE_READY_PROMPT),
				getViewportSnapshot: async () => {
					snapshotCalls += 1;
					if (snapshotCalls === 1) {
						// 第一次（旧投递的 attempt）：挂起，直到测试放行——期间安排第二次投递取代它。
						await new Promise<void>((resolve) => {
							releaseFirstSnapshot = resolve;
						});
					}
					return { snapshot: CLAUDE_READY_PROMPT, cols: 80, rows: 24 };
				},
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-deliver-lww", entry);

		// 旧投递：沉降后其 attempt 进入 getSnapshot await 并挂起。
		manager.submitTaskChatInputWhenReady("task-deliver-lww", "旧消息");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		expect(snapshotCalls).toBe(1);
		expect(releaseFirstSnapshot).not.toBeNull();

		// 新投递：自增代际，作废在途旧 attempt。
		manager.submitTaskChatInputWhenReady("task-deliver-lww", "新消息");

		// 放行旧 attempt 的 await：它复查代际不再相等 → 放弃，不写「旧消息」、不重排。
		(releaseFirstSnapshot as unknown as () => void)();
		await Promise.resolve();
		await Promise.resolve();
		expect(write).not.toHaveBeenCalled();

		// 新投递沉降后命中就绪 → 只写「新消息」一次。
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[新消息]");
	});

	it("A2 idle 兜底：提示符正则整窗不命中但 agent 已让出回合且终端静默 → 沉降后即投递（via=output-quiet），不拖到 deadline", async () => {
		// 真实 RVF 现场的稳健兜底：镜像视口未呈现可匹配的 idle 框（scanBuffer 也为 null）→ predicate 整窗不命中。
		// state:"awaiting_review" → turnOwner:"user"（agent 已让出回合）；lastOutputAt:null → 视为已字节静默。
		// 二者同时成立时 A2 判就绪，避免拖满 60s deadline。
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-deliver-quiet", {
			mirrorSnapshot: "正在收尾，本视口没有可匹配的输入框…",
			state: "awaiting_review",
			reviewReason: "exit",
			lastOutputAt: null,
		});

		manager.submitTaskChatInputWhenReady("task-deliver-quiet", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
		expect(
			tuiFreezeWarnings.some((m) => m.includes("task-chat-input-delivered") && m.includes("via=output-quiet")),
		).toBe(true);
	});

	// 形态 3：让路判据从「距上次击键不足 8s」换成读框。旧判据分不出「刚敲完回车提交了」（框已空，
	// 正该投）与「打了一半停下来想」（框非空，一个字节都不能写），于是前者白等 8s、后者被强写插字。
	it("框空即放行：用户刚敲过但内容已提交（输入侧账本为空）→ 不再白等 8s 抑制窗，沉降后即投递", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-deliver-clear-box", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			// 刚刚才敲过（旧判据下必让路），但账本里没有未提交内容 —— 因为那一敲是回车、消息已提交。
			lastUserInputAt: Date.now(),
		});

		manager.submitTaskChatInputWhenReady("task-deliver-clear-box", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
		expect(tuiFreezeWarnings.some((m) => m.includes("via=prompt-ready"))).toBe(true);
	});

	it("争用挂起：框非空且人在场 → 一个字节都不写、不抢占，预算耗尽转 delivery_failed{human_terminal_contention_timeout}", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithHalfTypedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(trackerWithHalfTypedSentence, Buffer.from("我正在打一半", "utf8"));
		const { write, entry } = installFakeClaudeEntry(manager, "task-contention-hold", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now(),
			inputBoxOccupancyTracker: trackerWithHalfTypedSentence,
		});
		let preemptiveStashCalls = 0;
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-hold", "继续 RVF", {
			idempotencyKey: "key-contention-hold",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async () => {
				preemptiveStashCalls += 1;
				return true;
			},
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		// 挂起必须看得见：派生 sidecar 上了会话广播，且明说「不会自动放行、等你处理」。
		expect(entry.summary.terminalDeliveryContention).toEqual({
			pendingProgrammaticDeliveryCount: 1,
			inputBoxHasUncommittedText: true,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: true,
		});

		// 人一直在场（每拍刷新 lastUserInputAt）→ 恒不抢占，一直挂到预算耗尽。
		for (
			let elapsed = SETTLE_MS;
			elapsed < DEADLINE_PLUS_MAX_YIELD_MS + RECHECK_MS && outcomes.length === 0;
			elapsed += RECHECK_MS
		) {
			entry.active.lastUserInputAt = Date.now();
			await vi.advanceTimersByTimeAsync(RECHECK_MS);
		}
		expect(preemptiveStashCalls).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "human_terminal_contention_timeout" }]);
		// 收尾后不再有人在等这个框，挂起可见性必须随之消失。
		expect(entry.summary.terminalDeliveryContention ?? null).toBeNull();
	});

	it("自动暂存抢占：框非空但人不在场 → 先把人类输入无损存进 Prompt Library，清框后的下一拍才投递", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithAbandonedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(
			trackerWithAbandonedSentence,
			Buffer.from("走开前留下的半句", "utf8"),
		);
		const { write, entry } = installFakeClaudeEntry(manager, "task-contention-preempt", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			// 很久没敲过 = 人不在场（判据窗是分钟量级）。
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithAbandonedSentence,
		});
		let preemptiveStashCalls = 0;

		manager.submitTaskChatInputWhenReady("task-contention-preempt", "继续 RVF", {
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async () => {
				preemptiveStashCalls += 1;
				// 真实执行者写库成功后会转发 Ctrl+S 清框；账本随之作废，这里等价模拟。
				resetTerminalInputBoxOccupancyTrackerComposition(trackerWithAbandonedSentence);
				return true;
			},
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		// 抢占这一拍只暂存、不写：清框后要重新走完整判定（就绪 + 读框）再投。
		expect(preemptiveStashCalls).toBe(1);
		expect(write).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
		expect(preemptiveStashCalls).toBe(1);
		expect(entry.summary.terminalDeliveryContention ?? null).toBeNull();
	});

	// 抢占的授权前提是「人不在场」，但那是**进入抢占前**的读数：抢占执行者要跨读框沉降、prompt library
	// 文件锁与落盘，回来时框已经被清了。人在这段窗口里回到终端开始打字，就成了「人在场时机器动了框」——
	// 本轮的核心不变量被破坏。守卫下沉到链路上最后一个由 manager 说了算的点（转发清框键那一刻）。
	it("抢占在途人回到终端打字 → 转发清框被前提闩拒掉，投递退回挂起而不是照写", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithAbandonedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(
			trackerWithAbandonedSentence,
			Buffer.from("走开前留下的半句", "utf8"),
		);
		const { write, entry } = installFakeClaudeEntry(manager, "task-contention-human-returned", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithAbandonedSentence,
		});
		const forwardResults: boolean[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-human-returned", "继续 RVF", {
			mayAutoStashAbsentHumanInputBox: true,
			// 真实执行者的形状：写库成功后经 manager 转发清框，并把转发结果当作自己的返回值
			// （「入库且框已清」才算放行）。这里在转发之前让人回到终端敲一下字。
			preemptivelyStashHumanInputBox: async (taskId) => {
				entry.active.lastUserInputAt = Date.now();
				const cleared = manager.forwardStashKeyToClearTaskTerminalInputBox(
					taskId,
					entry.active.terminalSessionIncarnationToken,
				);
				forwardResults.push(cleared);
				return cleared;
			},
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);

		// 转发被拒 ⇒ 框里内容一个字没少（清框键都没写出去），投递这一拍不写。
		expect(forwardResults).toEqual([false]);
		expect(write).not.toHaveBeenCalled();
		// 下一拍重探时人已在场、框仍非空 ⇒ 恒不抢占，继续挂起等人处理。
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write).not.toHaveBeenCalled();
		expect(entry.summary.terminalDeliveryContention).toEqual({
			pendingProgrammaticDeliveryCount: 1,
			inputBoxHasUncommittedText: true,
			waitingForHumanBecauseAutomaticPreemptionIsUnavailable: true,
		});
	});

	// 对照：W2 用户自己按 Ctrl+S 那条路径从不武装前提闩，所以「刚敲完字就按 Ctrl+S」必须照常清框——
	// 那正是这个键的用途。守卫只对机器发起的抢占生效。
	// 抢占在途期间这条投递被取消 / 被更晚的投递取代 ⇒ 授权它清框的那份前提已经作废。清框发生在
	// 抢占执行者内部（manager 的代际复查在 await 之后才跑），所以拦截点只能在转发那一刻。
	it("抢占在途被取消 → 转发清框必须拒掉，作废的投递不许再动人类的框", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithAbandonedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(
			trackerWithAbandonedSentence,
			Buffer.from("走开前留下的半句", "utf8"),
		);
		const { write, entry } = installFakeClaudeEntry(manager, "task-contention-cancelled-midflight", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithAbandonedSentence,
		});
		const forwardResults: boolean[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-cancelled-midflight", "继续 RVF", {
			idempotencyKey: "key-cancelled-midflight",
			onDeliveryOutcome: () => {},
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async (taskId) => {
				// 抢占已经在途（库都写完了），此刻这条投递被取消。
				manager.cancelTaskChatInputDelivery(taskId, "key-cancelled-midflight");
				const cleared = manager.forwardStashKeyToClearTaskTerminalInputBox(
					taskId,
					entry.active.terminalSessionIncarnationToken,
				);
				forwardResults.push(cleared);
				return cleared;
			},
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);

		expect(forwardResults).toEqual([false]);
		expect(write).not.toHaveBeenCalled();
	});

	it("抢占在途被更晚的投递取代 → 转发清框同样必须拒掉", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithAbandonedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(
			trackerWithAbandonedSentence,
			Buffer.from("走开前留下的半句", "utf8"),
		);
		const { entry } = installFakeClaudeEntry(manager, "task-contention-superseded-midflight", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithAbandonedSentence,
		});
		const forwardResults: boolean[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-superseded-midflight", "旧的一条", {
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async (taskId) => {
				// 抢占在途时来了更晚的一条投递：代际自增，旧的这条就此作废。
				manager.submitTaskChatInputWhenReady(taskId, "更晚的一条");
				const cleared = manager.forwardStashKeyToClearTaskTerminalInputBox(
					taskId,
					entry.active.terminalSessionIncarnationToken,
				);
				forwardResults.push(cleared);
				return cleared;
			},
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);

		expect(forwardResults).toEqual([false]);
	});

	it("用户手按 Ctrl+S：即便此刻刚敲过字，转发清框也必须放行（守卫只拦机器发起的抢占）", async () => {
		const manager = new TerminalSessionManager();
		const { entry } = installFakeClaudeEntry(manager, "task-manual-stash-after-typing", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now(),
		});

		expect(
			manager.forwardStashKeyToClearTaskTerminalInputBox(
				"task-manual-stash-after-typing",
				entry.active.terminalSessionIncarnationToken,
			),
		).toBe(true);
	});

	it("never_preempt（关掉自动抢占）：人不在场也绝不动框，恒定挂起到预算耗尽", async () => {
		const manager = new TerminalSessionManager();
		const trackerWithAbandonedSentence = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(
			trackerWithAbandonedSentence,
			Buffer.from("走开前留下的半句", "utf8"),
		);
		const { write } = installFakeClaudeEntry(manager, "task-contention-never-preempt", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithAbandonedSentence,
		});
		let preemptiveStashCalls = 0;
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-never-preempt", "继续 RVF", {
			idempotencyKey: "key-never-preempt",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			mayAutoStashAbsentHumanInputBox: false,
			preemptivelyStashHumanInputBox: async () => {
				preemptiveStashCalls += 1;
				return true;
			},
		});
		await vi.advanceTimersByTimeAsync(DEADLINE_PLUS_MAX_YIELD_MS + RECHECK_MS);
		expect(preemptiveStashCalls).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "human_terminal_contention_timeout" }]);
	});

	it("有还原不了的粘贴时降级为挂起：绝不为投递成功率去赌一段还原不了的人类输入", async () => {
		const manager = new TerminalSessionManager();
		// 同一次组合里粘贴超过账本条目上限（32）→ 溢出的那些只记数、不留正文，unrecoverablePasteCount > 0。
		const trackerWithUnrecoverablePaste = createTerminalInputBoxOccupancyTrackerState();
		for (let index = 0; index < 33; index += 1) {
			recordTerminalInputBytesIntoOccupancyTracker(
				trackerWithUnrecoverablePaste,
				Buffer.from(`\u001b[200~片段${index}\u001b[201~`, "utf8"),
			);
		}
		expect(trackerWithUnrecoverablePaste.unrecoverablePasteCount).toBeGreaterThan(0);
		const { write } = installFakeClaudeEntry(manager, "task-contention-unrecoverable", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: Date.now() - HUMAN_PRESENT_AT_TERMINAL_ACTIVE_WINDOW_MS - 1_000,
			inputBoxOccupancyTracker: trackerWithUnrecoverablePaste,
		});
		let preemptiveStashCalls = 0;
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-unrecoverable", "继续 RVF", {
			idempotencyKey: "key-unrecoverable",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async () => {
				preemptiveStashCalls += 1;
				return true;
			},
		});
		await vi.advanceTimersByTimeAsync(DEADLINE_PLUS_MAX_YIELD_MS + RECHECK_MS);
		expect(preemptiveStashCalls).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "human_terminal_contention_timeout" }]);
	});

	it("屏上有字但输入侧从未见过这条 PTY 的人类字节 → 既不写也不抢占，挂到预算耗尽", async () => {
		// 用户只经 tmux / 原生终端直连同一 PTY 时，输入侧这只眼睛是瞎的，必须采信读屏。
		const manager = new TerminalSessionManager();
		const boundary = "─".repeat(80);
		const viewportWithTypedText = [
			"  ⏺ 上一轮 agent 输出",
			boundary,
			"❯ 有人从 tmux 里打了半句",
			boundary,
			"  ⏸ manual mode on",
		].join("\n");
		const { write } = installFakeClaudeEntry(manager, "task-contention-uncorroborated", {
			mirrorSnapshot: viewportWithTypedText,
			state: "running",
			lastUserInputAt: null,
		});
		let preemptiveStashCalls = 0;
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-contention-uncorroborated", "继续 RVF", {
			idempotencyKey: "key-uncorroborated",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
			mayAutoStashAbsentHumanInputBox: true,
			preemptivelyStashHumanInputBox: async () => {
				preemptiveStashCalls += 1;
				return true;
			},
		});
		await vi.advanceTimersByTimeAsync(DEADLINE_PLUS_MAX_YIELD_MS + RECHECK_MS);
		// 不抢占：抢占要入库，而这段文本可能是 agent 自绘的 UI 文案，存进库就是把它冒充成用户资产。
		expect(preemptiveStashCalls).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "human_terminal_contention_timeout" }]);
	});

	// 硬约束的钉子：读屏对**未建模输入框语法**的 agent（codex / kimi / droid）恒无结论。若把「读不出框」
	// 一律当成争用，它们的每一条程序化投递都会挂到预算耗尽、100% 以 human_terminal_contention_timeout
	// 收场——比本轮修复前更差。对它们，输入侧字节跟踪才是判空的唯一主力，必须照常放行。
	it("未建模输入框语法的 agent（codex）：读屏恒无结论 + 输入侧从未见过人类字节 → 仍照常投递，绝不挂起", async () => {
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		const summary = {
			taskId: "task-codex-no-box-grammar",
			agentId: "codex",
			state: "running",
		} as unknown as RuntimeTaskSessionSummary;
		const entry = {
			summary,
			active: {
				session: { write },
				// codex 走扫描缓冲快路径判就绪（它没有可读的输入框结构）。
				outputReactionScanBuffer: "OpenAI Codex (v1.0.0)\n› ",
				outputReactionEngine: null,
				outputReactionSession: null,
				deferredStartupInput: null,
				lastUserInputAt: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				submitConfirmTimer: null,
				submitConfirmGeneration: 0,
				programmaticDeliveryReceipt: null,
				awaitingCodexPromptAfterEnter: false,
				// 从未 writeInput：输入侧这只眼睛也没接上人。两只眼睛都闭着，但对 codex 只能放行。
				inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
				ptyOutputChunkArrivalSequenceNumber: 0,
				terminalSessionIncarnationToken: "task-codex-no-box-grammar-incarnation",
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: "正在执行…", cols: 80, rows: 3 }),
				getViewportSnapshot: async () => ({ snapshot: "正在执行…", cols: 80, rows: 3 }),
				getScreenSnapshot: async () => toScreenSnapshot("正在执行…"),
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-codex-no-box-grammar", entry);

		manager.submitTaskChatInputWhenReady("task-codex-no-box-grammar", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(1);
		expect(entry.summary.terminalDeliveryContention ?? null).toBeNull();
	});

	it("屏上有字但输入侧接得上人（该会话收到过人类字节）→ 判为 agent 自绘的空框占位提示，照常投递", async () => {
		// Claude 偶发在空框里渲染 `Try "..."`。它恰好出现在 followup 的目标态（agent 完工、框空），
		// 若被当成人类内容，每一条 followup 都会挂到预算耗尽——比修复前更差。
		const manager = new TerminalSessionManager();
		const boundary = "─".repeat(80);
		const viewportWithPlaceholderHint = [
			"  ⏺ 上一轮 agent 输出",
			boundary,
			'❯ Try "edit session-manager.ts to..."',
			boundary,
			"  ⏸ manual mode on",
		].join("\n");
		// 这条 PTY 收到过人类字节（且已提交）：输入侧接得上人，它说「框里没有未提交内容」就可信。
		const trackerThatHasSeenHuman = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(trackerThatHasSeenHuman, Buffer.from("已经提交掉的一句\r", "utf8"));
		const { write } = installFakeClaudeEntry(manager, "task-contention-placeholder", {
			mirrorSnapshot: viewportWithPlaceholderHint,
			state: "running",
			lastUserInputAt: null,
			inputBoxOccupancyTracker: trackerThatHasSeenHuman,
		});

		manager.submitTaskChatInputWhenReady("task-contention-placeholder", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
	});

	// 形态 2 的合成复现台：伪 PTY 按实测规则建模「CR 与 `ESC[201~` 同一次 write 到达即被吞」。
	// 修复前（框架与 CR 拼在同一次 write）本用例必红：submittedTexts 恒为空——粘贴进了框，但没提交。
	it("形态 2 合成复现：CR 与 paste 结束标记同 chunk 会被吞，分离写之后消息真的提交了", async () => {
		const submittedTexts: string[] = [];
		let textSittingInInputBox = "";
		// 伪 TUI：收到 paste 框架就把正文放进输入框；收到**单独一次**只有 CR 的写才算提交。
		// 同一次 write 里既有框架又有 CR 时，CR 连同结束标记一起被吞掉 —— 框里有字，但什么都没发生。
		const swallowingTerminalWrite = vi.fn((data: string) => {
			const carriesPasteFraming = data.includes("SUBMIT[");
			const endsWithCarriageReturn = data.endsWith("\r");
			if (carriesPasteFraming) {
				textSittingInInputBox = data.slice("SUBMIT[".length, data.indexOf("]"));
				return; // 末尾若还带着 CR，它就在这里被吞掉
			}
			if (endsWithCarriageReturn && textSittingInInputBox !== "") {
				submittedTexts.push(textSittingInInputBox);
				textSittingInInputBox = "";
			}
		});
		const manager = new TerminalSessionManager();
		const { entry } = installFakeClaudeEntry(manager, "task-swallowed-cr", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null,
		});
		entry.active.session.write = swallowingTerminalWrite as unknown as typeof entry.active.session.write;

		manager.submitTaskChatInputWhenReady("task-swallowed-cr", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		// 第一次写只有框架：文本进了框，尚未提交。
		expect(textSittingInInputBox).toBe("继续 RVF");
		expect(submittedTexts).toEqual([]);

		// 提交 CR 单独发出 → 这一次不再被吞。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);
		expect(submittedTexts).toEqual(["继续 RVF"]);
		expect(textSittingInInputBox).toBe("");
	});

	// 形态 2 的门本身：CR 不再与 `ESC[201~` 同一次 write 发出，而是等到「TUI 已摄入这段 paste」
	// （PTY 有新输出到达）才单独发。摄入证据一到就立刻发，不必等满预算。
	it("分离写 · 摄入证据一到就立刻发提交 CR，不等满预算", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-paste-ingested", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null,
		});

		manager.submitTaskChatInputWhenReady("task-paste-ingested", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		// TUI 回显这段 paste：输出 chunk 到达序号推进 = 摄入证据。
		entry.active.ptyOutputChunkArrivalSequenceNumber += 1;
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_EVIDENCE_POLL_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
	});

	it("写后确认 · CR 被吞（投递后输出仍静默）→ 过确认延时补发裸回车 `\\r`，绝不重发 paste", async () => {
		// 报告症状的根因闭环：投递后若末尾 CR 被 TUI 重绘吞掉，框卡 idle、输出不再流动（lastOutputAt 恒旧）→
		// 判定未提交 → 补发裸回车（而非又一段 `SUBMIT[…]`）。
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-confirm-swallow", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 始终静默：模拟 CR 被吞、框卡 idle、再无字节。
		});

		manager.submitTaskChatInputWhenReady("task-confirm-swallow", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		// 形态 2 的分离写：第一次只写 paste 框架，**不带**提交 CR。
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		// 摄入证据等满预算仍不出现（fake PTY 无回流）→ 照发提交 CR（write #2）。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");

		// 过确认延时（≥静默阈值）→ 判定 CR 被吞 → 补发一个裸回车（非又一段 paste）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(3);
		expect(write.mock.calls[2]?.[0]).toBe("\r");
		expect(write.mock.calls[2]?.[0]).not.toContain("SUBMIT[");
		expect(tuiFreezeWarnings.some((m) => m.includes("submit-resend-cr"))).toBe(true);
	});

	it("写后确认 · 真提交（投递后输出恢复流动）→ 不补发、打 submit-confirmed", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-confirm-landed", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null,
		});

		manager.submitTaskChatInputWhenReady("task-confirm-landed", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR（write #2）
		expect(write).toHaveBeenCalledTimes(2);

		// 推进到接近确认时刻后，模拟 prompt 真提交：agent 开始干活、输出恢复流动 → lastOutputAt 刷新到当刻（非静默）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS - 500);
		entry.summary.lastOutputAt = Date.now();
		await vi.advanceTimersByTimeAsync(500); // 触发确认 tick
		// 非静默 → 判定已落地 → 不补发裸回车。
		expect(write).toHaveBeenCalledTimes(2);
		expect(tuiFreezeWarnings.some((m) => m.includes("submit-confirmed"))).toBe(true);
	});

	it("写后确认 · 仍静默但用户在打字 → 让位不补发（保护 stashed/在打的 prompt），停手越窗后才补发", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-confirm-yield", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 静默
		});

		manager.submitTaskChatInputWhenReady("task-confirm-yield", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR（write #2）
		expect(write).toHaveBeenCalledTimes(2);

		// 确认 tick 触发前的瞬间用户手敲：lastUserInputAt 刷新到抑制窗内 → 让位、绝不替他提交。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS - 200);
		entry.active.lastUserInputAt = Date.now();
		await vi.advanceTimersByTimeAsync(200); // 触发首个确认 tick
		expect(write).toHaveBeenCalledTimes(2); // 让位：无补发裸回车

		// 用户停手、越过 8s 抑制窗 → 后续某一拍确认 tick 放行补发裸回车。
		await vi.advanceTimersByTimeAsync(USER_INPUT_SUPPRESS_MS + SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(3);
		expect(write.mock.calls[2]?.[0]).toBe("\r");
	});

	it("写后确认 · 持续静默：补发至 SUBMIT_CONFIRM_MAX_RESENDS 次后打 submit-unconfirmed 收尾、不再补发", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-confirm-exhaust", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 始终静默
		});

		manager.submitTaskChatInputWhenReady("task-confirm-exhaust", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS); // 投递 paste 框架（write #1）
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR（write #2）

		// 始终静默 + 可注入 → 每隔确认延时补发一次裸回车，至多 MAX_RESENDS 次，之后打醒目 submit-unconfirmed 收尾。
		// CR 写入总数 = 提交 CR 1 次 + 补发 MAX_RESENDS 次（两者字节相同，只能按序数区分）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * (SUBMIT_CONFIRM_MAX_RESENDS + 1));
		const crWrites = write.mock.calls.filter((call) => call[0] === "\r");
		expect(crWrites).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS + 1);
		expect(tuiFreezeErrors.some((m) => m.includes("submit-unconfirmed"))).toBe(true);

		// 预算耗尽后再推进也不会有第 4 次补发。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * 2);
		const crWritesAfter = write.mock.calls.filter((call) => call[0] === "\r");
		expect(crWritesAfter).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS + 1);
	});

	// 让位那一支曾是回执链路上唯一没有结论的出口。以下两例分别钉住它的两个破口：
	// ① 补发预算已耗尽时直接 return（既不再排 tick 也不 settle）→ receipt 永远停在 pending；
	// ② 预算未耗尽时的重排不消耗预算 → 用户持续打字即可无限重排，突破契约的有界收敛承诺。
	// 让位行为本身（绝不替用户按回车）在两例里都必须原样保留。
	it("写后确认 · 补发预算耗尽那一拍用户正在打字 → 仍不替他补发，但必须当场给出结论（旧实现直接 return、回执永远 pending）", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-confirm-yield-exhausted", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 始终静默
		});
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-confirm-yield-exhausted", "继续 RVF", {
			idempotencyKey: "key-confirm-yield-exhausted",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR

		// 前几拍用户不在场 → 正常补发裸回车，直到预算耗尽（CR 总数含最前面那次提交 CR）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * SUBMIT_CONFIRM_MAX_RESENDS);
		expect(write.mock.calls.filter((call) => call[0] === "\r")).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS + 1);
		expect(outcomes).toEqual([]);

		// 收尾那一拍之前用户手敲 → 走让位分支（预算已为 0）。
		entry.active.lastUserInputAt = Date.now();
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(write.mock.calls.filter((call) => call[0] === "\r")).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS + 1);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" }]);
	});

	it("写后确认 · 用户一直不停手 → 让位有绝对收敛上界，到点转终态；期间一次裸回车都不替他发", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-confirm-yield-forever", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 始终静默
		});
		const outcomes: { status: string; reason: string | null }[] = [];

		manager.submitTaskChatInputWhenReady("task-confirm-yield-forever", "继续 RVF", {
			idempotencyKey: "key-confirm-yield-forever",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR

		// 每一拍确认 tick 之前都刷新 lastUserInputAt = 用户持续打字，让位条件恒成立。
		for (
			let elapsed = 0;
			elapsed < SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS + SUBMIT_CONFIRM_DELAY_MS;
			elapsed += SUBMIT_CONFIRM_DELAY_MS
		) {
			entry.active.lastUserInputAt = Date.now();
			await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		}
		// 让位语义原样保留：绝不**替他补发**回车。唯一那次 CR 是本条投递自己的提交 CR
		// （分离写的第二步，属于投递本身；不发它，我们粘进去的文本会永远躺在框里）。
		expect(write.mock.calls.filter((call) => call[0] === "\r")).toHaveLength(1);
		// 但让位不再是无底洞：到收敛上界诚实转终态（旧实现无限重排、回执永远 pending）。
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" }]);
	});
});

// Fix B：后台自动注入（deferWhileUserTurn=true）遇非 agent 回合让位挂起、待 agent 回合恢复再投递；
// 用户发起的发送（deferWhileUserTurn=false）任何回合照常送达。
describe("session-manager · submitTaskChatInputWhenReady 后台注入让位（Fix B deferWhileUserTurn）", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		tuiFreezeWarnings.length = 0;
		tuiFreezeErrors.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// 2026-08-08 事故形态 1 的第二条根因回归守卫。
	// 修复前：让位判据是 turnOwner !== "agent"，把 `review`（agent 自然完工、输入框空闲）也算成「等用户」，
	// 于是 RVF followup 的**目标态**恰好是永不投递的状态——本用例在修复前必红（0 次投递）。
	it("形态 1 回归：awaiting_review（agent 完工待审、userTurnKind=review）不是模态待答 → 后台注入照常投递，不让位", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-defer-review-turn", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});

		manager.submitTaskChatInputWhenReady("task-defer-review-turn", "再跑一轮 RVF", { deferWhileUserTurn: true });
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		const submits = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(submits).toHaveLength(1);
		expect(submits[0]?.[0]).toBe("SUBMIT[再跑一轮 RVF]");
	});

	it("deferWhileUserTurn=true + 模态待答（permission）：越过 deadline 仍不写；模态解除后的下一轮 recheck 才投递一次", async () => {
		const manager = new TerminalSessionManager();
		// 真正该让位的形态：agent 正在等用户拍板（权限确认），此时注入会经 UserPromptSubmit 把会话翻回 agent 回合。
		const { write, entry } = installFakeClaudeEntry(manager, "task-defer-modal-turn", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
			facets: { turnOwner: "user", liveness: "live", userTurnKind: "permission" },
		});

		manager.submitTaskChatInputWhenReady("task-defer-modal-turn", "再跑一轮 RVF", { deferWhileUserTurn: true });
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(0);

		// 用户答完权限确认 → agent 回合恢复 → 挂起的注入在下一轮 recheck 放行、恰投递一次。
		(entry.summary as unknown as { turnOwner: string; userTurnKind: string | null }).turnOwner = "agent";
		(entry.summary as unknown as { turnOwner: string; userTurnKind: string | null }).userTurnKind = null;
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		const submitsAfterResume = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(submitsAfterResume).toHaveLength(1);
		expect(submitsAfterResume[0]?.[0]).toBe("SUBMIT[再跑一轮 RVF]");
	});

	// 事故的第三条根因：让位分支无饿死上限 ⇒ 永远挂起、既不落地也不报错（那 49 分钟的直接形态）。
	// 修复前本用例必红：投递数恒 0 且回执永远拿不到。
	it("形态 1 回归：模态待答一直不解除 → 让位预算耗尽后转终态 delivery_failed{agent_awaiting_user_decision_timeout}，不再无限空探", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-defer-starve", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
			facets: { turnOwner: "user", liveness: "live", userTurnKind: "question" },
		});

		const outcomes: { status: string; reason: string | null }[] = [];
		manager.submitTaskChatInputWhenReady("task-defer-starve", "再跑一轮 RVF", {
			deferWhileUserTurn: true,
			idempotencyKey: "key-starve",
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});

		// 推进越过 deadline + 让位预算硬上限。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS + MAX_USER_TURN_YIELD_MS + RECHECK_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(0);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "agent_awaiting_user_decision_timeout" }]);
	});

	it("deferWhileUserTurn=false（用户发起）+ user 回合：不让位，就绪即照常投递", async () => {
		const manager = new TerminalSessionManager();
		// 同为 user 回合，但人类聊天 / commit·openPR 按钮发送不带 source → 不让位：故意向 review 态会话发指令，应送达。
		const { write } = installFakeClaudeEntry(manager, "task-nodefer-user-turn", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});

		manager.submitTaskChatInputWhenReady("task-nodefer-user-turn", "用户手输的消息");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		const submits = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(submits).toHaveLength(1);
		expect(submits[0]?.[0]).toBe("SUBMIT[用户手输的消息]");
	});
});

// 诚实回执（terminal_delivery_status 四态）与取消接口。
// 这一组守的是 2026-08-08 事故的核心教训：链路上**每一个出口**都必须给出结论，
// 「没有结论」不再是一种合法状态——旧实现只有「写进去了」这条路径有反馈，其余出口一律静默。
describe("session-manager · 程序化投递的诚实回执与取消", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		tuiFreezeWarnings.length = 0;
		tuiFreezeErrors.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function collectOutcomes() {
		const outcomes: { status: string; reason: string | null }[] = [];
		return {
			outcomes,
			onDeliveryOutcome: (outcome: { status: string; reason: string | null }) => {
				outcomes.push(outcome);
			},
		};
	}

	it("写入后确认到提交 → delivered_and_submit_confirmed", async () => {
		const manager = new TerminalSessionManager();
		const { entry } = installFakeClaudeEntry(manager, "task-receipt-confirmed", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-confirmed", "继续 RVF", {
			idempotencyKey: "key-confirmed",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR
		// 写入完成、尚未确认：此刻不得有任何结论（pending 就是「还没有结论」的诚实表达）。
		expect(outcomes).toHaveLength(0);

		// agent 开始干活 → 输出恢复流动 → 确认 tick 判定已提交。
		entry.summary.lastOutputAt = Date.now() + SUBMIT_CONFIRM_DELAY_MS;
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(outcomes).toEqual([{ status: "delivered_and_submit_confirmed", reason: null }]);
	});

	it("写入时 agent 已在自己的回合中 → delivered_queued_behind_active_agent_turn（该标记在写入时捕获，不是确认时）", async () => {
		const manager = new TerminalSessionManager();
		const { entry } = installFakeClaudeEntry(manager, "task-receipt-queued", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-queued", "继续 RVF", {
			idempotencyKey: "key-queued",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR
		entry.summary.lastOutputAt = Date.now() + SUBMIT_CONFIRM_DELAY_MS;
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(outcomes).toEqual([{ status: "delivered_queued_behind_active_agent_turn", reason: null }]);
	});

	it("补发预算耗尽仍确认不到提交 → delivery_failed{submit_confirmation_budget_exhausted}（旧实现只打日志、回执仍是成功）", async () => {
		const manager = new TerminalSessionManager();
		installFakeClaudeEntry(manager, "task-receipt-unconfirmed", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-unconfirmed", "继续 RVF", {
			idempotencyKey: "key-unconfirmed",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS); // 提交 CR
		// 输出始终静默（lastOutputAt 恒 null）→ 每拍补发裸 CR，直至预算耗尽。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * (SUBMIT_CONFIRM_MAX_RESENDS + 1));
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" }]);
	});

	it("被更晚的投递抢占单飞槽 → 旧投递立刻拿到 delivery_failed{superseded_by_later_delivery}，不会永远挂着", async () => {
		const manager = new TerminalSessionManager();
		installFakeClaudeEntry(manager, "task-receipt-superseded", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-superseded", "旧消息", {
			idempotencyKey: "key-old",
			onDeliveryOutcome,
		});
		manager.submitTaskChatInputWhenReady("task-receipt-superseded", "新消息", { idempotencyKey: "key-new" });
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "superseded_by_later_delivery" }]);
	});

	it("会话在 await 期间被替换 → delivery_failed{session_ended_before_delivery}", async () => {
		const manager = new TerminalSessionManager();
		// 受控 mirror：把 attempt 卡在就绪判定的 await 上，期间把 entry.active 换掉，
		// 精确复现「await 返回时会话已不是当初那份」这条出口。
		let releaseSnapshot: (() => void) | null = null;
		const { entry } = installFakeClaudeEntry(manager, "task-receipt-session-end", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		entry.terminalStateMirror.getScreenSnapshot = (async () => {
			await new Promise<void>((resolve) => {
				releaseSnapshot = resolve;
			});
			return toScreenSnapshot(CLAUDE_READY_PROMPT);
		}) as typeof entry.terminalStateMirror.getScreenSnapshot;

		const { outcomes, onDeliveryOutcome } = collectOutcomes();
		manager.submitTaskChatInputWhenReady("task-receipt-session-end", "继续 RVF", {
			idempotencyKey: "key-session-end",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(releaseSnapshot).not.toBeNull();

		// 会话被替换成另一份 active（新 active 不带任何回执登记）。
		entry.active = {
			session: { write: vi.fn() },
			outputReactionScanBuffer: null,
			deferredStartupInput: null,
			lastUserInputAt: null,
			taskChatInputDeliveryTimer: null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null,
			awaitingCodexPromptAfterEnter: false,
			inputBoxOccupancyTracker: createTerminalInputBoxOccupancyTrackerState(),
			ptyOutputChunkArrivalSequenceNumber: 0,
		} as unknown as typeof entry.active;

		(releaseSnapshot as unknown as () => void)();
		// 就绪判定内部还有若干 await，单纯 flush 两个微任务不够；推进 0ms 让整条链跑完。
		await vi.advanceTimersByTimeAsync(0);
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "session_ended_before_delivery" }]);
	});

	it("取消（写入前）：拦下投递、PTY 一个字节都不写，回执为 delivery_failed{cancelled_before_delivery}", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-cancel-before", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-cancel-before", "继续 RVF", {
			idempotencyKey: "key-cancel",
			onDeliveryOutcome,
		});
		expect(manager.cancelTaskChatInputDelivery("task-cancel-before", "key-cancel")).toBe("cancelled_before_delivery");
		expect(outcomes).toEqual([{ status: "delivery_failed", reason: "cancelled_before_delivery" }]);

		// 取消后继续推进：在途 attempt 复查代际发现已过时 → 绝不补写。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(0);
	});

	it("取消（写入后）：诚实返回 already_delivered，不伪造取消成功", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-cancel-late", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-cancel-late", "继续 RVF", {
			idempotencyKey: "key-cancel-late",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["))).toHaveLength(1);

		expect(manager.cancelTaskChatInputDelivery("task-cancel-late", "key-cancel-late")).toBe("already_delivered");
		// 晚到的取消不得篡改结论：此刻仍无终态（等确认链落定）。
		expect(outcomes).toHaveLength(0);
	});

	it("取消未知 key / 无在途投递 → no_pending_delivery（幂等，无副作用）", async () => {
		const manager = new TerminalSessionManager();
		installFakeClaudeEntry(manager, "task-cancel-unknown", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "awaiting_review",
			reviewReason: "hook",
			lastOutputAt: null,
		});
		expect(manager.cancelTaskChatInputDelivery("task-cancel-unknown", "never-submitted")).toBe("no_pending_delivery");
		expect(manager.cancelTaskChatInputDelivery("task-missing", "any-key")).toBe("no_pending_delivery");
	});

	// 连接中断自动续跑（submitConnectionDropContinuation）与在途投递的三种撞车。
	// 共同的守卫：只有**已写进 PTY、正在等确认**的投递才归确认链管；仍停在 awaiting_readiness 的投递
	// 一个字节都没写，续跑那条链的成败与它无关，替它下任何结论都是撒谎。
	// 未就绪屏：没有输入框，正则通道与结构判定都不命中 → 投递稳定停在 awaiting_readiness。
	const CLAUDE_SCREEN_WITHOUT_INPUT_BOX = "正在思考…\n工具调用输出若干行";

	function triggerConnectionDropContinuation(manager: TerminalSessionManager, taskId: string): void {
		(
			manager as unknown as { submitConnectionDropContinuation: (taskId: string) => void }
		).submitConnectionDropContinuation(taskId);
	}

	it("续跑注入撞上尚未写入的在途投递 → 不误判失败；投递照常送达并诚实落定", async () => {
		// 旧实现：writePasteSubmissionWithConfirm 不区分 phase，续跑注入一来就把这条投递判成
		// delivery_failed{submit_confirmation_budget_exhausted}，却既不清投递定时器也不自增投递代际——
		// 于是「回执说失败、文本随后照样写进终端」，调用方按契约换新 key 重投就把同一段文本送两次。
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-receipt-continuation-race", {
			mirrorSnapshot: CLAUDE_SCREEN_WITHOUT_INPUT_BOX,
			state: "running",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-continuation-race", "继续 RVF", {
			idempotencyKey: "key-continuation-race",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(0);

		// 连接中断自动续跑写自己的续跑指令、夺走确认通道；这条投递还没写入，不该被它连坐。
		triggerConnectionDropContinuation(manager, "task-receipt-continuation-race");
		expect(outcomes).toEqual([]);

		// 输入框出现 → 投递照常写入（证明它确实还活着，判它失败即撒谎）。
		entry.terminalStateMirror.getViewportSnapshot = async () => ({
			snapshot: CLAUDE_READY_PROMPT,
			cols: 80,
			rows: 24,
		});
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(1);
		expect(outcomes).toEqual([]);

		// 它自己的确认链才有资格下结论（分离写：先等摄入预算发出提交 CR，确认链自那一刻起跑）。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);
		entry.summary.lastOutputAt = Date.now() + SUBMIT_CONFIRM_DELAY_MS;
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(outcomes).toEqual([{ status: "delivered_queued_behind_active_agent_turn", reason: null }]);
	});

	it("续跑注入的确认链确认到提交 → 不得替尚未写入的投递判成功（最危险的反向谎）", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-receipt-continuation-confirmed", {
			mirrorSnapshot: CLAUDE_SCREEN_WITHOUT_INPUT_BOX,
			state: "running",
			lastOutputAt: null,
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-continuation-confirmed", "继续 RVF", {
			idempotencyKey: "key-continuation-confirmed",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		triggerConnectionDropContinuation(manager, "task-receipt-continuation-confirmed");

		// 续跑那条链同样是分离写：等满摄入预算发出提交 CR 之后，它的确认链才起跑。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);

		// agent 收下的是**续跑指令**，输出恢复流动 → 续跑那条确认链判定已提交。
		entry.summary.lastOutputAt = Date.now() + SUBMIT_CONFIRM_DELAY_MS;
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(tuiFreezeWarnings.some((m) => m.includes("submit-confirmed"))).toBe(true);
		// 这条投递的文本一个字节都没写过，绝不可因此被判成 delivered_*。
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(0);
		expect(outcomes).toEqual([]);
	});

	it("续跑注入的补发预算耗尽 → 不得替尚未写入的投递判失败", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-receipt-continuation-exhausted", {
			mirrorSnapshot: CLAUDE_SCREEN_WITHOUT_INPUT_BOX,
			state: "running",
			lastOutputAt: null, // 始终静默：续跑那条确认链一路补发到预算耗尽。
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-continuation-exhausted", "继续 RVF", {
			idempotencyKey: "key-continuation-exhausted",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		triggerConnectionDropContinuation(manager, "task-receipt-continuation-exhausted");

		// 续跑那条链同样是分离写：等满摄入预算发出提交 CR 之后，它的确认链才起跑。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);

		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * (SUBMIT_CONFIRM_MAX_RESENDS + 1));
		expect(tuiFreezeErrors.some((m) => m.includes("submit-unconfirmed"))).toBe(true);
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(0);
		expect(outcomes).toEqual([]);
	});

	// 确认链另外两个收尾出口（绝对收敛上界、让位时补发预算已耗尽）同样必须只认自己那条投递。
	// 它们只在「用户正在手敲」时才可达，所以上面那三例都碰不到——但一旦被续跑链走到，
	// 后果与其余出口一模一样：判一条尚未写入 PTY 的投递失败，而它随后照常写入并提交。
	it("续跑注入的确认链撞上绝对收敛上界 → 不得替尚未写入的投递判失败", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-receipt-continuation-convergence", {
			mirrorSnapshot: CLAUDE_SCREEN_WITHOUT_INPUT_BOX,
			state: "running",
			lastOutputAt: null, // 始终静默
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-continuation-convergence", "继续 RVF", {
			idempotencyKey: "key-continuation-convergence",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		triggerConnectionDropContinuation(manager, "task-receipt-continuation-convergence");

		// 续跑那条链同样是分离写：等满摄入预算发出提交 CR 之后，它的确认链才起跑。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);

		// 用户持续手敲 → 续跑那条链一路让位（不消耗补发预算），最终撞上绝对收敛上界那一支。
		for (
			let elapsed = 0;
			elapsed < SUBMIT_CONFIRM_CHAIN_MAX_CONVERGENCE_MS + SUBMIT_CONFIRM_DELAY_MS;
			elapsed += SUBMIT_CONFIRM_DELAY_MS
		) {
			entry.active.lastUserInputAt = Date.now();
			await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		}
		expect(tuiFreezeErrors.some((m) => m.includes("reason=confirm-chain-convergence-deadline"))).toBe(true);
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(0);
		expect(outcomes).toEqual([]);
	});

	it("续跑注入的确认链在补发预算耗尽后撞上用户手敲 → 不得替尚未写入的投递判失败", async () => {
		const manager = new TerminalSessionManager();
		const { write, entry } = installFakeClaudeEntry(manager, "task-receipt-continuation-yield-exhausted", {
			mirrorSnapshot: CLAUDE_SCREEN_WITHOUT_INPUT_BOX,
			state: "running",
			lastOutputAt: null, // 始终静默
		});
		const { outcomes, onDeliveryOutcome } = collectOutcomes();

		manager.submitTaskChatInputWhenReady("task-receipt-continuation-yield-exhausted", "继续 RVF", {
			idempotencyKey: "key-continuation-yield-exhausted",
			onDeliveryOutcome,
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		triggerConnectionDropContinuation(manager, "task-receipt-continuation-yield-exhausted");

		// 续跑那条链同样是分离写：等满摄入预算发出提交 CR 之后，它的确认链才起跑。
		await vi.advanceTimersByTimeAsync(PASTE_INGESTION_MAX_WAIT_MS);

		// 用户不在场的前几拍：续跑链正常补发裸回车，直到预算耗尽。
		// CR 写入总数含续跑自己那次提交 CR（分离写的第二步），故补发次数要 +1 才对得上。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * SUBMIT_CONFIRM_MAX_RESENDS);
		expect(write.mock.calls.filter((call) => call[0] === "\r")).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS + 1);
		expect(outcomes).toEqual([]);

		// 收尾那一拍之前用户手敲 → 走「让位 + 补发预算已耗尽」那一支。
		entry.active.lastUserInputAt = Date.now();
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(tuiFreezeErrors.some((m) => m.includes("reason=user-input-yield-with-resends-exhausted"))).toBe(true);
		expect(write.mock.calls.filter((call) => call[0] === "SUBMIT[继续 RVF]")).toHaveLength(0);
		expect(outcomes).toEqual([]);
	});

	// runtime 启动清扫拿这个预算判「这条 pending 还可能有人在正常投递吗」。它必须由本文件测的那几个
	// deadline / 收敛上界常量算出来：数字偏小，清扫就会把同机并存实例的在途投递判成 delivery_failed，
	// 而终态写一次即定 —— 那种假失败事后不可纠正。故这里两条都钉：不得低于契约公布的下限，
	// 且等于当前常量集下的真实最坏路径。
	it("投递最坏预算 = 就绪 deadline + 最长让路 + 确认链收敛上界，且不低于契约 § 时序保证 1 的 190s", () => {
		// 契约 § 时序保证 1 公布的 190s 是清扫阈值的**下限**：阈值只能往保守（更大）一侧偏。
		expect(TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS).toBeGreaterThanOrEqual(190_000);
		// 当前常量集下的真实最坏路径：60s 就绪 + 120s 模态让位 + 1.5s 等 paste 摄入证据 +
		// 15s 确认链绝对收敛上界。确认链那一项取的是「补发预算 10s」与「绝对收敛上界 15s」的**大者**
		// ——后者正是为「让位重排不消耗补发预算」补的兜底，只按补发预算算会低估 5s。
		// 摄入证据那 1.5s 必须单独计入：分离写之后，确认链是从**提交 CR 写入**才起算的。
		expect(TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS).toBe(196_500);
	});
});
