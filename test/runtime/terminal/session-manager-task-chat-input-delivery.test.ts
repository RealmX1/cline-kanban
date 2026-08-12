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

// toBracketedPasteSubmission 用哨兵替身：本套件验证 submitTaskChatInputWhenReady 的「就绪门控 +
// 以原始文本委托编码 + 写一次 + Codex 置位」契约；bracketed-paste + 末尾单 CR 的真实编码由
// agent-session-adapters 自身单测与 session-manager-connection-drop 集成测试覆盖。
vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	toBracketedPasteSubmission: (command: string) => `SUBMIT[${command}]`,
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
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

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
// 写后确认闭环常量（须与 session-manager.ts 同步）：确认延时 2.5s、最多补发 3 次裸回车。
const SUBMIT_CONFIRM_DELAY_MS = 2_500;
const SUBMIT_CONFIRM_MAX_RESENDS = 3;

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

	it("始终未就绪：到 deadline 兜底强制写入且仅一次", async () => {
		const getSession = spawnManagerWithSession(2003);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-deadline");
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		manager.submitTaskChatInputWhenReady("task-deliver-deadline", "继续 RVF");
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		// 只数「paste 投递」（`SUBMIT[…]`）：deadline 兜底写入后，mock 始终静默（无输出回流）会触发写后确认补发裸 `\r`，
		// 那是另一条安全层、非投递；paste 投递应恒为一次。
		const pasteSubmissions = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(pasteSubmissions).toHaveLength(1);
		expect(pasteSubmissions[0]?.[0]).toBe("SUBMIT[继续 RVF]");

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

	it("Codex：deadline 兜底写入后置位 awaitingCodexPromptAfterEnter（末尾 CR 即回车）", async () => {
		const getSession = spawnManagerWithSession(2005);
		const manager = new TerminalSessionManager();
		await startSession(manager, "task-deliver-codex", { agentId: "codex" });
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		manager.submitTaskChatInputWhenReady("task-deliver-codex", "继续 RVF");
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		// 只数 paste 投递（写后确认在 mock 静默下补发的裸 `\r` 不计入）。
		const pasteSubmissions = write.mock.calls.filter((call) => String(call[0]).startsWith("SUBMIT["));
		expect(pasteSubmissions).toHaveLength(1);

		const awaitingFlag = (
			manager as unknown as {
				entries: Map<string, { active: { awaitingCodexPromptAfterEnter: boolean } | null }>;
			}
		).entries.get("task-deliver-codex")?.active?.awaitingCodexPromptAfterEnter;
		expect(awaitingFlag).toBe(true);

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

		// 仍由 deadline 兜底，行为与就绪门控引入前一致。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).toHaveBeenCalledTimes(1);
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
		// 始终非就绪 → 只在 deadline 兜底写入一次。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
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

		// 始终非就绪 → 只在 deadline 兜底写入一次，且 via=deadline-fallback（不是 prompt-ready）。
		await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(
			tuiFreezeWarnings.some(
				(line) => line.includes("task-chat-input-delivered") && line.includes("via=deadline-fallback"),
			),
		).toBe(true);
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

	it("A1 让路：就绪（框在）但用户近 8s 内手敲 → 沉降后不插队；越过抑制窗后的下一轮才投递", async () => {
		const manager = new TerminalSessionManager();
		const typedAt = Date.now();
		const { write } = installFakeClaudeEntry(manager, "task-deliver-yield", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: typedAt,
		});

		manager.submitTaskChatInputWhenReady("task-deliver-yield", "继续 RVF");
		// 就绪命中（框在镜像视口），但用户近 OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS 内手敲过 → 让路、不写。
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();
		// 推进越过抑制窗（其间不再刷新 lastUserInputAt = 用户停手）→ 下一轮 recheck 放行投递。
		await vi.advanceTimersByTimeAsync(USER_INPUT_SUPPRESS_MS + RECHECK_MS);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
		expect(tuiFreezeWarnings.some((m) => m.includes("via=prompt-ready"))).toBe(true);
	});

	it("A1 防饿死：用户持续手敲不停 → 在 deadline + MAX_DEADLINE_INPUT_YIELD_MS 硬上限保底强写一次", async () => {
		const manager = new TerminalSessionManager();
		const base = Date.now();
		const { write, entry } = installFakeClaudeEntry(manager, "task-deliver-starve", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastUserInputAt: base,
		});

		manager.submitTaskChatInputWhenReady("task-deliver-starve", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(write).not.toHaveBeenCalled();

		// 模拟连续打字：每个 recheck 间隔前把 lastUserInputAt 刷新到当前时刻，使 A1 让路条件恒成立——
		// 直到越过 deadline(60s) + MAX(15s) 硬上限，投递无条件保底强写（守住「投递绝不丢」）。
		for (
			let elapsed = SETTLE_MS;
			elapsed < DEADLINE_PLUS_MAX_YIELD_MS + RECHECK_MS && write.mock.calls.length === 0;
			elapsed += RECHECK_MS
		) {
			entry.active.lastUserInputAt = Date.now();
			await vi.advanceTimersByTimeAsync(RECHECK_MS);
		}
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");
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
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

		// 过确认延时（≥静默阈值）→ 判定 CR 被吞 → 补发一个裸回车（非又一段 paste）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
		expect(write.mock.calls[1]?.[0]).not.toContain("SUBMIT[");
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

		// 推进到接近确认时刻后，模拟 prompt 真提交：agent 开始干活、输出恢复流动 → lastOutputAt 刷新到当刻（非静默）。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS - 500);
		entry.summary.lastOutputAt = Date.now();
		await vi.advanceTimersByTimeAsync(500); // 触发确认 tick
		// 非静默 → 判定已落地 → 不补发裸回车。
		expect(write).toHaveBeenCalledTimes(1);
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

		// 确认 tick 触发前的瞬间用户手敲：lastUserInputAt 刷新到抑制窗内 → 让位、绝不替他提交。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS - 200);
		entry.active.lastUserInputAt = Date.now();
		await vi.advanceTimersByTimeAsync(200); // 触发首个确认 tick
		expect(write).toHaveBeenCalledTimes(1); // 让位：无裸回车

		// 用户停手、越过 8s 抑制窗 → 后续某一拍确认 tick 放行补发裸回车。
		await vi.advanceTimersByTimeAsync(USER_INPUT_SUPPRESS_MS + SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
	});

	it("写后确认 · 持续静默：补发至 SUBMIT_CONFIRM_MAX_RESENDS 次后打 submit-unconfirmed 收尾、不再补发", async () => {
		const manager = new TerminalSessionManager();
		const { write } = installFakeClaudeEntry(manager, "task-confirm-exhaust", {
			mirrorSnapshot: CLAUDE_READY_PROMPT,
			state: "running",
			lastOutputAt: null, // 始终静默
		});

		manager.submitTaskChatInputWhenReady("task-confirm-exhaust", "继续 RVF");
		await vi.advanceTimersByTimeAsync(SETTLE_MS); // 投递 paste（write #1）

		// 始终静默 + 可注入 → 每隔确认延时补发一次裸回车，至多 MAX_RESENDS 次，之后打醒目 submit-unconfirmed 收尾。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * (SUBMIT_CONFIRM_MAX_RESENDS + 1));
		const crResends = write.mock.calls.filter((call) => call[0] === "\r");
		expect(crResends).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS);
		expect(tuiFreezeErrors.some((m) => m.includes("submit-unconfirmed"))).toBe(true);

		// 预算耗尽后再推进也不会有第 4 次补发。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS * 2);
		const crResendsAfter = write.mock.calls.filter((call) => call[0] === "\r");
		expect(crResendsAfter).toHaveLength(SUBMIT_CONFIRM_MAX_RESENDS);
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
});
