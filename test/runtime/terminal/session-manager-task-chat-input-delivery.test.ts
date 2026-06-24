import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ensureInstructionsFileMock = vi.hoisted(() => vi.fn(async () => "/tmp/network-interruption-resume.md"));

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

// submitTaskChatInputWhenReady 的就绪门控时序常量（须与 session-manager.ts 同步）：
//   TASK_CHAT_INPUT_DELIVERY_SETTLE_MS=1000 / _RECHECK_MS=1500 / _DEADLINE_MS=60000。
const SETTLE_MS = 1_000;
const RECHECK_MS = 1_500;
const PAST_DEADLINE_MS = 65_000;

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
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("SUBMIT[继续 RVF]");

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
		expect(write).toHaveBeenCalledTimes(1);

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
		const summary = { taskId: "task-deliver-mirror", agentId: "claude" } as unknown as RuntimeTaskSessionSummary;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: CLAUDE_READY_PROMPT, cols: 80, rows: 24 }),
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

	it("镜像就绪只看当前视口：提示符仅存在于 scrollback 历史时不判就绪（仅 deadline 兜底）", async () => {
		// Issue 1 回归守卫：getSnapshot() 含完整 scrollback，历史里早先出现过的提示符框不能让「当前屏」误判就绪。
		// 构造 rows=5 的快照：开头 3 行是就绪提示符框（位于 scrollback 历史），最后 5 行（= 当前视口）是
		// 正在出输出、无提示符。若就绪判定看完整快照会误判 true（旧 bug）；只看最后 rows 行则判 false。
		const manager = new TerminalSessionManager();
		const write = vi.fn();
		const summary = { taskId: "task-deliver-viewport", agentId: "claude" } as unknown as RuntimeTaskSessionSummary;
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
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => ({ snapshot: snapshotWithPromptOnlyInScrollback, cols: 80, rows: 5 }),
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
		const summary = { taskId: "task-deliver-lww", agentId: "claude" } as unknown as RuntimeTaskSessionSummary;
		// 受控 mirror：getSnapshot 返回一个直到我们放行才 resolve 的 promise，模拟「旧 attempt 卡在 await 中」。
		let releaseFirstSnapshot: (() => void) | null = null;
		let snapshotCalls = 0;
		const entry = {
			summary,
			active: {
				session: { write },
				outputReactionScanBuffer: null,
				taskChatInputDeliveryTimer: null,
				taskChatInputDeliveryGeneration: 0,
				awaitingCodexPromptAfterEnter: false,
			},
			terminalStateMirror: {
				getSnapshot: async () => {
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
});
