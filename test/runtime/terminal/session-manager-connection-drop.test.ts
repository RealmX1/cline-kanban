import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ensureInstructionsFileMock = vi.hoisted(() => vi.fn(async () => "/tmp/network-interruption-resume.md"));

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	// 真实 bracketed-paste 实现，保证注入体框定正确。
	toBracketedPasteSubmission: (command: string) => `[200~${command}[201~\r`,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 避免向真实 home 目录写续跑指令文件，并固定注入路径便于断言。
vi.mock("../../../src/terminal/output-reactions/network-interruption-continuation-instructions.js", () => ({
	ensureNetworkInterruptionResumeInstructionsFile: ensureInstructionsFileMock,
	getNetworkInterruptionResumeInstructionsPath: () => "/tmp/network-interruption-resume.md",
	buildNetworkInterruptionContinuationLine: (path: string) => `继续：请先按 ${path} 自查并恢复，再继续。`,
}));

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

// 同时含连接错误行与 Claude 输入框（提示符就绪信号）。
const CLAUDE_ERROR_WITH_PROMPT =
	"[31m\r⏺ API Error: Connection closed mid-response. The response above may be incomplete.[0m\r\n" +
	"╭──────────────────────╮\n│ > │\n╰──────────────────────╯";

function spawnManagerWithSession(pid: number) {
	let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
		// 不产出 deferredStartupInput，避免与续跑注入混淆。
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		spawnedSession = createMockPtySession(pid, request);
		return spawnedSession;
	});
	return () => spawnedSession;
}

describe("session-manager · connection-drop auto-continue", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("injects a continuation referencing the instructions file after a transient connection error", async () => {
		const getSession = spawnManagerWithSession(1001);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		expect(session).not.toBeNull();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		// 检测到错误即进入重试状态，但不立即注入。
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop")?.connectionRetry?.status).toBe("retrying");

		// 推进过首个退避档位 → 注入一次续跑（引用指令文件路径）。
		await vi.advanceTimersByTimeAsync(4_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("/tmp/network-interruption-resume.md");
		expect(write.mock.calls[0]?.[0]).toContain("[200~");

		manager.stopTaskSession("task-conn-drop");
	});

	it("does not inject when the auto-continue flag is disabled", async () => {
		const getSession = spawnManagerWithSession(1002);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-off",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-off",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: false,
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop-off")?.connectionRetry ?? null).toBeNull();

		manager.stopTaskSession("task-conn-drop-off");
	});

	it("clears the retry state once the agent recovers (no further error before the next attempt)", async () => {
		const getSession = spawnManagerWithSession(1003);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-recover",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-recover",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await vi.advanceTimersByTimeAsync(4_000); // first injection
		expect(write).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-conn-drop-recover")?.connectionRetry?.status).toBe("retrying");

		// 没有再出现连接错误 → 下一次退避触发时判定已恢复，清除重试状态、不再注入。
		await vi.advanceTimersByTimeAsync(20_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-conn-drop-recover")?.connectionRetry ?? null).toBeNull();

		manager.stopTaskSession("task-conn-drop-recover");
	});

	it("stops the retry timer after the session is stopped", async () => {
		const getSession = spawnManagerWithSession(1004);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-stop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-stop",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		manager.stopTaskSession("task-conn-drop-stop");
		await vi.advanceTimersByTimeAsync(30_000);
		// 计时器已清理：永远不会注入。
		expect(write).not.toHaveBeenCalled();
	});

	it("manual continue-now triggers a single injection for a retrying session", async () => {
		const getSession = spawnManagerWithSession(1005);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-manual",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-manual",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		const triggered = manager.continueConnectionRetrySessions(["task-conn-drop-manual"]);
		expect(triggered).toEqual(["task-conn-drop-manual"]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("/tmp/network-interruption-resume.md");

		// 不在重试列表里的任务 id 不应被触发。
		const none = manager.continueConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-manual");
	});

	it("stands down (clears retry state, no injection) when the turn flips to the user mid-episode", async () => {
		// 竞态：PTY 输出先于 hook 落地 → episode 已起（retrying）；随后 agent 向用户提问，
		// hook 经 transitionToReview 把回合翻成 user → 检测器即时让位、清「重连中」、绝不注入。
		const getSession = spawnManagerWithSession(1007);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-standdown",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-standdown",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		expect(manager.getSummary("task-conn-drop-standdown")?.connectionRetry?.status).toBe("retrying");

		// agent 向用户提问 → hook 翻入 user 回合（question）。
		manager.transitionToReview("task-conn-drop-standdown", "hook", "question");
		expect(manager.getSummary("task-conn-drop-standdown")?.connectionRetry ?? null).toBeNull();

		// 退避定时器到点也不会注入（episode 已让位结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-standdown");
	});

	it("does not enter retry when a transient pattern arrives after the turn already flipped to the user", async () => {
		// 常见路径：hook 先于问题 UI 文本落地 → turnOwner 已是 user。问题 / 选项文本里命中瞬时
		// 正则（如 agent 在讨论 econnreset）也不起 episode、不置「重连中」、不注入。
		const getSession = spawnManagerWithSession(1008);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-user-first",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-user-first",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		// 先翻入 user 回合（提问），再让带连接错误措辞的「问题文本」流过检测器。
		manager.transitionToReview("task-conn-drop-user-first", "hook", "question");
		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);

		expect(manager.getSummary("task-conn-drop-user-first")?.connectionRetry ?? null).toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-user-first");
	});

	it("manual dismiss removes a retrying session from the list without injecting", async () => {
		const getSession = spawnManagerWithSession(1006);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-dismiss",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-dismiss",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry?.status).toBe("retrying");

		// 手动移出列表：结束 episode、清重连状态、不注入。
		const dismissed = manager.dismissConnectionRetrySessions(["task-conn-drop-dismiss"]);
		expect(dismissed).toEqual(["task-conn-drop-dismiss"]);
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry ?? null).toBeNull();

		// 移出后退避定时器再触发也不应注入（episode 已结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		// 不在重试列表里的任务 id 不应被移出。
		const none = manager.dismissConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-dismiss");
	});
});
