import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

// 部分 mock：只替换 prepareAgentLaunch，其余导出（toBracketedPasteFramingWithoutTrailingSubmit 等，程序化投递路径要用）
// 保留真身——否则投递写入时会抛 "No export is defined on the mock" 的 unhandled rejection。
vi.mock("../../../src/terminal/agent-session-adapters.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/terminal/agent-session-adapters.js")>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

interface MockPtySession {
	pid: number;
	write: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	pause: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	wasInterrupted: ReturnType<typeof vi.fn>;
	hasExited: ReturnType<typeof vi.fn>;
	exitedFlag: boolean;
	stopCalls: Array<{ force: boolean }>;
	triggerData: (chunk: string | Buffer) => void;
	triggerExit: (exitCode: number | null) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest): MockPtySession {
	const session: MockPtySession = {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		hasExited: vi.fn(() => session.exitedFlag),
		exitedFlag: false,
		stopCalls: [],
		triggerData: (chunk) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode) => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode });
		},
	};
	session.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
		session.stopCalls.push({ force: Boolean(opts?.force) });
	});
	return session;
}

const CLAUDE_RESUME_MENU = [
	"╭────────────────────────────────────────────────╮",
	"│ Cache hit is past due                          │",
	"│  1. Continue from summary                      │",
	"│  2. Continue as is (full session context)      │",
	"│  3. Start a new session                        │",
	"╰────────────────────────────────────────────────╯",
].join("\r\n");

// 输出重分析(实质输出检测等)按 session-manager 的 OUTPUT_ANALYSIS_BATCH_WINDOW_MS(50ms)攒批;
// 每喂完一段输出必须先推进该窗口让检测落地,再执行下一个状态动作(refresh / transitionToRunning /
// writeInput)——settle 的位置对 guard 语义是承重的:旧 per-chunk 语义下 chunk 在动作前处理,
// 攒批下若不 settle,pending 文本会在动作后才 flush、套在新状态上。
const OUTPUT_ANALYSIS_BATCH_WINDOW_MS = 50;
async function settleOutputAnalysisBatch(): Promise<void> {
	await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
}

function readEffectiveActivityTime(manager: TerminalSessionManager, taskId: string): number | null {
	return manager.getSummary(taskId)?.lastEffectiveAgentConversationActivityObservation?.observedAtMs ?? null;
}
function recordTrustedAgentOutput(manager: TerminalSessionManager, taskId: string): void {
	manager.recordEffectiveAgentConversationActivity(taskId, {
		observedAtMs: Date.now(),
		evidenceKind: "persisted_agent_transcript",
		activityKind: "agent_output",
		eventId: `native-output:${Date.now()}`,
	});
}

describe("TerminalSessionManager resume substantive guard", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		const actual = await vi.importActual<typeof import("../../../src/terminal/agent-session-adapters.js")>(
			"../../../src/terminal/agent-session-adapters.js",
		);
		prepareAgentLaunchMock.mockImplementation(actual.prepareAgentLaunch);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function wireStopToExit(spawnedSessions: MockPtySession[]): void {
		for (const session of spawnedSessions) {
			session.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
				session.stopCalls.push({ force: Boolean(opts?.force) });
				if (!session.exitedFlag) {
					session.triggerExit(0);
				}
			});
		}
	}

	it("Claude 恢复回放保留可信历史活动时间", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-guard", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-guard",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard",
			prompt: "Implement the task",
		});

		recordTrustedAgentOutput(manager, "task-guard");
		const firstSession = spawnedSessions[0];
		expect(firstSession).toBeDefined();
		firstSession?.triggerData("Claude Code\nHow can I help you today?\n");
		await settleOutputAnalysisBatch();
		firstSession?.triggerData("⏺ Earlier real agent response before refresh.\n");
		await settleOutputAnalysisBatch();

		const substantiveBefore = readEffectiveActivityTime(manager, "task-guard");
		expect(substantiveBefore).not.toBeNull();

		wireStopToExit(spawnedSessions);

		await manager.refreshTaskTerminal({
			taskId: "task-guard",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard",
			prompt: "",
			resumeFromTrash: true,
		});

		const secondSession = spawnedSessions[1];
		expect(secondSession).toBeDefined();
		// Claude --continue 重播整段旧 transcript（本身带 ⏺/● 前缀）+ 渲染 cache-past-due 三选一菜单。
		secondSession?.triggerData("Claude Code\nHow can I help you today?\n");
		await settleOutputAnalysisBatch();
		secondSession?.triggerData("⏺ Earlier real agent response before refresh.\n");
		await settleOutputAnalysisBatch();
		secondSession?.triggerData(CLAUDE_RESUME_MENU);
		await settleOutputAnalysisBatch();
		// 自动续跑旧回合触发 PostToolUse → to_in_progress（非 UserPromptSubmit）：翻 running 但不应解除 guard。
		manager.transitionToRunning("task-guard");
		secondSession?.triggerData("⏺ More reprinted transcript output.\n");
		await settleOutputAnalysisBatch();

		const afterResumeUi = manager.getSummary("task-guard");
		expect(afterResumeUi?.lastEffectiveAgentConversationActivityObservation?.observedAtMs ?? null).toBe(
			substantiveBefore,
		);
	});

	it("用户继续及 TUI 内容不刷新活动，后续可信原生输出才推进", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-guard-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-2",
			prompt: "Implement the task",
		});

		recordTrustedAgentOutput(manager, "task-guard-2");
		spawnedSessions[0]?.triggerData("⏺ Seed response.\n");
		await settleOutputAnalysisBatch();
		const substantiveBefore = readEffectiveActivityTime(manager, "task-guard-2");
		wireStopToExit(spawnedSessions);

		await manager.refreshTaskTerminal({
			taskId: "task-guard-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-2",
			prompt: "",
			resumeFromTrash: true,
		});

		spawnedSessions[1]?.triggerData(CLAUDE_RESUME_MENU);
		await settleOutputAnalysisBatch();
		// 用户选了菜单项 → UserPromptSubmit → to_in_progress（userInitiatedResume）→ 解除 guard。
		manager.transitionToRunning("task-guard-2", { userInitiatedResume: true });
		spawnedSessions[1]?.triggerData("⏺ Resuming from summary.\n");
		await settleOutputAnalysisBatch();

		const afterContinue = manager.getSummary("task-guard-2");
		expect(afterContinue?.lastEffectiveAgentConversationActivityObservation?.observedAtMs ?? null).toBe(
			substantiveBefore,
		);
		recordTrustedAgentOutput(manager, "task-guard-2");
		expect(readEffectiveActivityTime(manager, "task-guard-2")).toBeGreaterThan(substantiveBefore ?? 0);
	});

	it("显式继续后的 TUI 内容仍不能充当原生推进证据", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-guard-3",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-3",
			prompt: "",
			resumeFromTrash: true,
		});

		spawnedSessions[0]?.triggerData(CLAUDE_RESUME_MENU);
		await settleOutputAnalysisBatch();
		const beforeHook = readEffectiveActivityTime(manager, "task-guard-3");

		manager.transitionToRunning("task-guard-3", { userInitiatedResume: true });
		spawnedSessions[0]?.triggerData("⏺ Continued after hook.\n");
		await settleOutputAnalysisBatch();

		const afterHook = manager.getSummary("task-guard-3");
		expect(afterHook?.lastEffectiveAgentConversationActivityObservation?.observedAtMs ?? null).toBe(beforeHook);
	});

	it("Codex 回放及手动输入后的文字均不伪造可信推进", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-codex-resume",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-codex-resume",
			prompt: "",
			resumeFromTrash: true,
		});

		// 翻 running 但非 UserPromptSubmit → guard 保持武装；codex 重播旧输出不应推进时间戳。
		manager.transitionToRunning("task-codex-resume");
		spawnedSessions[0]?.triggerData("Applying the requested change to foo.ts\n");
		await settleOutputAnalysisBatch();
		expect(readEffectiveActivityTime(manager, "task-codex-resume")).toBeNull();

		// 用户手敲输入（writeInput）= agent 无关的真·继续信号 → 解除 guard；此后新输出才推进。
		manager.writeInput("task-codex-resume", Buffer.from("continue\r", "utf8"));
		spawnedSessions[0]?.triggerData("Edited foo.ts and reran the tests.\n");
		await settleOutputAnalysisBatch();
		expect(readEffectiveActivityTime(manager, "task-codex-resume")).toBeNull();
	});

	// 本 bug 的核心回归：`--resume <sessionId>` / `--fork-session` 这类续跑启动会重播整段既有
	// transcript，却不带 resumeFromTrash，历史上因此漏武装 guard，重播把卡片「agent 上次响应」
	// 刷成「刚刚」。武装判据改读 PreparedAgentLaunch.resumesPriorAgentConversation 后被覆盖。
	// （adapter 侧「什么时候置这个位」由 agent-session-adapters.test.ts 覆盖；此处只钉 manager 的接线。）
	it("未标记垃圾桶恢复的原生续跑也保留可信历史时间", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		let launchResumesPriorAgentConversation = false;
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
			resumesPriorAgentConversation: launchResumesPriorAgentConversation,
		}));

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-resume-existing",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-resume-existing",
			prompt: "Implement the task",
		});

		recordTrustedAgentOutput(manager, "task-resume-existing");
		spawnedSessions[0]?.triggerData("⏺ Earlier real agent response before the resume.\n");
		await settleOutputAnalysisBatch();
		const substantiveBefore = readEffectiveActivityTime(manager, "task-resume-existing");
		expect(substantiveBefore).not.toBeNull();

		// 第二次启动续跑既有会话（resumeFromTrash 仍缺省 false）。
		launchResumesPriorAgentConversation = true;
		wireStopToExit(spawnedSessions);
		await manager.refreshTaskTerminal({
			taskId: "task-resume-existing",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-resume-existing",
			prompt: "Implement the task",
		});

		// 新进程重播整段旧 transcript：签名记忆是空的，若无 guard 这些行会被判为「全新实质产出」。
		spawnedSessions[1]?.triggerData("⏺ Earlier real agent response before the resume.\n");
		await settleOutputAnalysisBatch();
		spawnedSessions[1]?.triggerData("⏺ And a second reprinted line.\n");
		await settleOutputAnalysisBatch();

		expect(readEffectiveActivityTime(manager, "task-resume-existing")).toBe(substantiveBefore);
	});

	// 反向护栏：崩溃后的 auto-restart 用原始 prompt 全新重跑（args 里没有任何续跑旗标），
	// 毫无重播——武装它只会把真实的新产出误冻住。故必须**不**武装。
	it("崩溃新进程的原始输出不推进，可信原生输出仍可更新", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		// auto-restart 要求该 task 至少有一个 listener（见 shouldAutoRestart）。
		manager.attach("task-auto-restart", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-auto-restart",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-auto-restart",
			prompt: "Implement the task",
		});

		recordTrustedAgentOutput(manager, "task-auto-restart");
		spawnedSessions[0]?.triggerData("⏺ Earlier real agent response before the crash.\n");
		await settleOutputAnalysisBatch();
		const substantiveBefore = readEffectiveActivityTime(manager, "task-auto-restart");
		expect(substantiveBefore).not.toBeNull();

		spawnedSessions[0]?.triggerExit(1);
		await vi.advanceTimersByTimeAsync(50);
		expect(spawnedSessions[1]).toBeDefined();

		// 全新一轮的真实产出必须照常推进时间戳。
		await vi.advanceTimersByTimeAsync(5_000);
		spawnedSessions[1]?.triggerData("⏺ Brand new output from the restarted run.\n");
		await settleOutputAnalysisBatch();

		expect(readEffectiveActivityTime(manager, "task-auto-restart")).toBe(substantiveBefore);
		recordTrustedAgentOutput(manager, "task-auto-restart");
		expect(readEffectiveActivityTime(manager, "task-auto-restart")).toBeGreaterThan(substantiveBefore ?? 0);
	});

	// 反向护栏：全新首次启动不带任何续跑旗标 → 必须不武装，否则卡片永远不显示响应时间。
	it("首次 spawn 的 TUI 输出不制造可信活动", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-first-spawn",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-first-spawn",
			prompt: "Implement the task",
		});

		expect(readEffectiveActivityTime(manager, "task-first-spawn")).toBeNull();
		spawnedSessions[0]?.triggerData("⏺ The very first real response.\n");
		await settleOutputAnalysisBatch();

		expect(readEffectiveActivityTime(manager, "task-first-spawn")).toBeNull();
	});

	// task-chat / RVF 的程序化投递是一条「已提交用户轮」，与手敲等价 → 必须解除 guard，
	// 否则 Gemini 之外那些经 paste 恢复的路径在 re-spawn 后会永久冻住实质戳。
	it("程序化写入未获接受证明时，TUI 内容不制造活动", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));

		const manager = new TerminalSessionManager();
		// droid 无可门控的交互提示符信号 → 投递就绪判定为 "immediate"，沉降窗口后即写入。
		await manager.startTaskSession({
			taskId: "task-chat-clears-guard",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp/task-chat-clears-guard",
			prompt: "",
			resumeFromTrash: true,
		});

		manager.transitionToRunning("task-chat-clears-guard");
		spawnedSessions[0]?.triggerData("Replayed transcript from the previous session.\n");
		await settleOutputAnalysisBatch();
		expect(readEffectiveActivityTime(manager, "task-chat-clears-guard")).toBeNull();

		manager.submitTaskChatInputWhenReady("task-chat-clears-guard", "Please continue with the next step.");
		// 沉降 TASK_CHAT_INPUT_DELIVERY_SETTLE_MS 后投递落地并解除 guard。
		await vi.advanceTimersByTimeAsync(1_500);

		spawnedSessions[0]?.triggerData("Working on the next step now.\n");
		await settleOutputAnalysisBatch();
		expect(readEffectiveActivityTime(manager, "task-chat-clears-guard")).toBeNull();
	});

	it("PostToolUse 续跑及旧 TUI 重播不制造对话推进", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-guard-posttool",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-posttool",
			prompt: "",
			resumeFromTrash: true,
		});

		spawnedSessions[0]?.triggerData("⏺ Old transcript reprinted on resume.\n");
		await settleOutputAnalysisBatch();
		const beforeAutoContinue = readEffectiveActivityTime(manager, "task-guard-posttool");

		// PostToolUse → to_in_progress：翻 running，但 userInitiatedResume 缺省(false) → 不解除 guard。
		manager.transitionToRunning("task-guard-posttool");
		spawnedSessions[0]?.triggerData("⏺ Auto-continued tool output from the old turn.\n");
		await settleOutputAnalysisBatch();

		expect(readEffectiveActivityTime(manager, "task-guard-posttool")).toBe(beforeAutoContinue);
	});

	// 通道切换重开与「从垃圾桶拖回」都不投新 prompt，但**成因**不同，而成因决定 userTurnKind：
	//   resumeFromTrash → attention / needs_input（确实需要人来看一眼）
	//   通道切换      → hook / review（agent 只是把回合交回来，没有任何东西在等你拍板）
	// 这条不是风格问题：needs_input 落在 MODAL_USER_DECISION_TURN_KINDS 里，后台程序化投递
	// （RVF followup / `kanban task message`）会一直让位到预算耗尽、报
	// agent_awaiting_user_decision_timeout —— 而这条会话其实空闲着、随时可以收消息。
	// 实测踩到过：omp 从 ACP 切回 TUI 后，第一条 task message 就这样被判失败。
	it("通道切换重开停在 review（可收投递），垃圾桶恢复才停在 needs_input", async () => {
		prepareAgentLaunchMock.mockResolvedValue({ args: [], env: {} });
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(900 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();

		await manager.startTaskSession({
			taskId: "task-transport-switch-resume",
			agentId: "omp",
			binary: "omp",
			args: [],
			cwd: "/tmp/task-transport-switch-resume",
			prompt: "Implement the task",
			resumePriorAgentConversationWithoutResendingPrompt: true,
		});
		const switchResumed = manager.getSummary("task-transport-switch-resume");
		expect(switchResumed?.reviewReason).toBe("hook");
		expect(switchResumed?.userTurnKind).toBe("review");
		expect(switchResumed?.turnOwner).toBe("user");

		await manager.startTaskSession({
			taskId: "task-trash-restore-resume",
			agentId: "omp",
			binary: "omp",
			args: [],
			cwd: "/tmp/task-trash-restore-resume",
			prompt: "Implement the task",
			resumeFromTrash: true,
		});
		const trashRestored = manager.getSummary("task-trash-restore-resume");
		expect(trashRestored?.reviewReason).toBe("attention");
		expect(trashRestored?.userTurnKind).toBe("needs_input");
	});
});
