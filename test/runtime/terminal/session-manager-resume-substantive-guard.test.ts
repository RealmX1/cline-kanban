import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
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

	it("keeps lastSubstantiveOutputAt across refresh when Claude reprints ⏺/● transcript and auto-continues", async () => {
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

		const firstSession = spawnedSessions[0];
		expect(firstSession).toBeDefined();
		firstSession?.triggerData("Claude Code\nHow can I help you today?\n");
		await settleOutputAnalysisBatch();
		firstSession?.triggerData("⏺ Earlier real agent response before refresh.\n");
		await settleOutputAnalysisBatch();

		const substantiveBefore = manager.getSummary("task-guard")?.lastSubstantiveOutputAt;
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
		expect(afterResumeUi?.lastSubstantiveOutputAt).toBe(substantiveBefore);
	});

	it("advances lastSubstantiveOutputAt after user continues and agent produces real output", async () => {
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

		spawnedSessions[0]?.triggerData("⏺ Seed response.\n");
		await settleOutputAnalysisBatch();
		const substantiveBefore = manager.getSummary("task-guard-2")?.lastSubstantiveOutputAt;
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
		expect(afterContinue?.lastSubstantiveOutputAt).not.toBe(substantiveBefore);
		expect(afterContinue?.lastSubstantiveOutputAt ?? 0).toBeGreaterThan(substantiveBefore ?? 0);
	});

	it("clears resume guard on transitionToRunning (UserPromptSubmit hook path)", async () => {
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
		const beforeHook = manager.getSummary("task-guard-3")?.lastSubstantiveOutputAt;

		manager.transitionToRunning("task-guard-3", { userInitiatedResume: true });
		spawnedSessions[0]?.triggerData("⏺ Continued after hook.\n");
		await settleOutputAnalysisBatch();

		const afterHook = manager.getSummary("task-guard-3");
		expect(afterHook?.lastSubstantiveOutputAt).not.toBe(beforeHook);
	});

	it("arms resume guard for non-Claude agents too and clears it on user terminal input", async () => {
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
		expect(manager.getSummary("task-codex-resume")?.lastSubstantiveOutputAt).toBeNull();

		// 用户手敲输入（writeInput）= agent 无关的真·继续信号 → 解除 guard；此后新输出才推进。
		manager.writeInput("task-codex-resume", Buffer.from("continue\r", "utf8"));
		spawnedSessions[0]?.triggerData("Edited foo.ts and reran the tests.\n");
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-codex-resume")?.lastSubstantiveOutputAt).not.toBeNull();
	});

	it("does not clear resume guard on PostToolUse-driven to_in_progress (no UserPromptSubmit)", async () => {
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
		const beforeAutoContinue = manager.getSummary("task-guard-posttool")?.lastSubstantiveOutputAt ?? null;

		// PostToolUse → to_in_progress：翻 running，但 userInitiatedResume 缺省(false) → 不解除 guard。
		manager.transitionToRunning("task-guard-posttool");
		spawnedSessions[0]?.triggerData("⏺ Auto-continued tool output from the old turn.\n");
		await settleOutputAnalysisBatch();

		expect(manager.getSummary("task-guard-posttool")?.lastSubstantiveOutputAt).toBe(beforeAutoContinue);
	});
});
