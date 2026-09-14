import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentSessionAdapters from "../../../src/terminal/agent-session-adapters";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

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
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	it.each([
		{ echoDelayMs: 100, swallowedCarriageReturns: 0, nativeStartupBusyMs: 0 },
		{ echoDelayMs: 100, swallowedCarriageReturns: 0, nativeStartupBusyMs: 12_000 },
		{ echoDelayMs: 100, swallowedCarriageReturns: 1 },
		{ echoDelayMs: null, swallowedCarriageReturns: 0 },
		{ echoDelayMs: 100, swallowedCarriageReturns: 1, terminalProtocolResponses: true },
	])("Codex 首条消息自动提交一次：%j", async (scenario) => {
		const {
			echoDelayMs,
			swallowedCarriageReturns,
			nativeStartupBusyMs = 0,
			terminalProtocolResponses = false,
		} = scenario;
		vi.useFakeTimers();
		const manager = new TerminalSessionManager();
		const promptText = "/plan 检查启动投递\n保留第二行";
		const acceptedPrompts: string[] = [];
		const terminalProtocolInput = Buffer.from(
			"\u001b[?1;2c\u001b[>0;276;0c\u001b[0n\u001b[?2004;1$y\u001b[8;24;80t" +
				"\u001b[I\u001b[O\u001b[<35;10;20M\u001b[M !!\u001b]11;rgb:0000/0000/0000\u0007\u001bP1$r0m\u001b\\",
		);
		// 浏览器与服务端 mirror 使用同一个 xterm 解析器；真实解析分片查询后经 onData 回送完整应答。
		const viewerTerminal = new TerminalStateMirror(80, 24, {
			onInputResponse: (response) => manager.writeInput("task-codex-startup-submit", Buffer.from(response)),
		});
		let pendingPromptText = "";
		let remainingSwallowedCarriageReturns = swallowedCarriageReturns;
		const nativeStartupEndsAt = Date.now() + nativeStartupBusyMs;
		let animationTimer: ReturnType<typeof setInterval> | undefined;
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupPromptText: promptText,
		});
		const sessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			session.write.mockImplementation((bytes: string | Buffer) => {
				const input = bytes.toString();
				if (input.startsWith("\u001b[200~")) {
					// 模拟 TUI 摄入粘贴，但吞掉同一次 write 末尾的 CR。
					pendingPromptText = input
						.split("\u001b[200~")
						.slice(1)
						.map((fragment) => fragment.split("\u001b[201~")[0])
						.join("");
					if (echoDelayMs !== null) {
						setTimeout(() => session.triggerData(`› ${pendingPromptText}`), echoDelayMs);
					}
				} else if (input === "\r" && pendingPromptText) {
					if (Date.now() < nativeStartupEndsAt || remainingSwallowedCarriageReturns-- > 0) {
						if (terminalProtocolResponses) {
							setTimeout(() => manager.writeInput("task-codex-startup-submit", terminalProtocolInput), 100);
						}
						return;
					}
					acceptedPrompts.push(pendingPromptText);
					pendingPromptText = "";
					session.triggerData("\u001b[2J\u001b[Hmodel: gpt-test\r\n› Ask Codex to do anything");
				}
			});
			if (nativeStartupBusyMs > 0) {
				animationTimer = setInterval(() => {
					session.triggerData(
						`\u001b[2J\u001b[Hmodel: gpt-test\r\n› ⠁${pendingPromptText || "Ask Codex to do anything"}\r\n${Date.now() < nativeStartupEndsAt ? "tab to queue message" : "100% context left"}`,
					);
				}, 500);
			}
			sessions.push(session);
			return session;
		});
		try {
			await manager.startTaskSession({
				taskId: "task-codex-startup-submit",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-codex-startup-submit",
				prompt: promptText,
				startInPlanMode: true,
			});
			if (terminalProtocolResponses) {
				manager.attach("task-codex-startup-submit", {
					onOutput: (chunk) => viewerTerminal.applyOutput(chunk),
				});
				sessions[0].triggerData("\u001b[");
				sessions[0].triggerData("6n");
				await vi.advanceTimersByTimeAsync(30);
				expect(sessions[0].write).toHaveBeenCalledWith(Buffer.from("\u001b[1;1R"));
				manager.writeInput("task-codex-startup-submit", terminalProtocolInput);
			}
			sessions[0].triggerData("\u001b[2J\u001b[Hmodel: gpt-test\r\n› ");
			await vi.advanceTimersByTimeAsync(nativeStartupBusyMs + 4_500);
			expect(acceptedPrompts).toEqual([promptText]);
			sessions[0].triggerData("\u001b[2J\u001b[Hmodel: gpt-test\r\n› ");
			await vi.advanceTimersByTimeAsync(20_000);
			expect(acceptedPrompts).toEqual([promptText]);
			expect(
				sessions[0].write.mock.calls.filter(([input]) => input.toString().startsWith("\u001b[200~")),
			).toHaveLength(1);
		} finally {
			clearInterval(animationTimer);
			viewerTerminal.dispose();
			manager.stopTaskSession("task-codex-startup-submit");
			vi.useRealTimers();
		}
	});

	it.each([
		"human_input",
		"arrow_key",
		"escape_key",
		"mixed_response_and_input",
		"mixed_response_and_enter",
		"permission",
		"exit",
	] as const)("首发提交等待遇到 %s 后不再自动写回车", async (intervention) => {
		vi.useFakeTimers();
		const manager = new TerminalSessionManager();
		const capturedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupPromptText: "/plan 检查",
		});
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			capturedSessions.push(session);
			return session;
		});
		try {
			await manager.startTaskSession({
				taskId: "startup-cancellation",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/startup-cancellation",
				prompt: "检查",
				startInPlanMode: true,
			});
			const session = capturedSessions[0];
			if (!session) throw new Error("PTY 未启动");
			session.triggerData("model: gpt-test\r\n› ");
			await vi.advanceTimersByTimeAsync(30);
			expect(session.write).toHaveBeenCalledWith("\u001b[200~/plan \u001b[201~\u001b[200~检查\u001b[201~");
			if (intervention === "human_input") manager.writeInput("startup-cancellation", Buffer.from("人工编辑"));
			if (intervention === "arrow_key") manager.writeInput("startup-cancellation", Buffer.from("\u001b[A"));
			if (intervention === "escape_key") manager.writeInput("startup-cancellation", Buffer.from("\u001b"));
			if (intervention === "mixed_response_and_input") {
				manager.writeInput("startup-cancellation", Buffer.from("\u001b[1;1R人工编辑"));
			}
			if (intervention === "mixed_response_and_enter") {
				manager.writeInput("startup-cancellation", Buffer.from("\u001b[I\n"));
			}
			if (intervention === "permission") manager.transitionToReview("startup-cancellation", "hook", "permission");
			if (intervention === "exit") session.triggerExit(0);
			await vi.advanceTimersByTimeAsync(70_000);
			expect(session.write).not.toHaveBeenCalledWith("\r");
		} finally {
			manager.stopTaskSession("startup-cancellation");
			manager.dispose();
			vi.useRealTimers();
		}
	});

	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBe(222);
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("exposes Kanban task context environment to task agents", async () => {
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			return createMockPtySession(111, request);
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-rvf",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/worktrees/task-rvf",
			projectPath: "/tmp/project",
			prompt: "Fix the bug",
		});

		const spawnRequest = ptySessionSpawnMock.mock.calls[0]?.[0] as MockSpawnRequest | undefined;
		expect(spawnRequest?.env).toMatchObject({
			KANBAN_TASK_ID: "task-rvf",
			KANBAN_ATTEMPT_ID: "task-rvf",
			CLINE_KANBAN_TASK_ID: "task-rvf",
			CLINE_KANBAN_ATTEMPT_ID: "task-rvf",
			KANBAN_PROJECT_PATH: "/tmp/project",
			CLINE_KANBAN_PROJECT_PATH: "/tmp/project",
		});
	});

	it("sends deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupPromptText = "/plan Validate rollout";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupPromptText,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(
			`\u001b[200~/plan \u001b[201~\u001b[200~${deferredStartupPromptText.slice(6)}\u001b[201~`,
		);

		session.triggerData("\r\nmodel: gpt-test\r\n› ");
		await vi.waitFor(() =>
			expect(session.write).toHaveBeenCalledWith(
				`\u001b[200~/plan \u001b[201~\u001b[200~${deferredStartupPromptText.slice(6)}\u001b[201~`,
			),
		);
		expect(session.write).toHaveBeenCalledWith(
			`\u001b[200~/plan \u001b[201~\u001b[200~${deferredStartupPromptText.slice(6)}\u001b[201~`,
		);
		expect(session.write).toHaveBeenCalledTimes(1);
		manager.stopTaskSession("task-1");
	});

	it("Codex loading 横幅不触发首发，完整就绪视口才触发", async () => {
		const deferredStartupPromptText = "/plan Validate startup UI detect";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupPromptText,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.154.0)\r\nmodel: loading\r\n› ");
		await manager.getRestoreSnapshot("task-1");
		expect(session.write).not.toHaveBeenCalled();
		session.triggerData("\u001b[2J\u001b[Hmodel: gpt-test\r\n› ");
		await vi.waitFor(() =>
			expect(session.write).toHaveBeenCalledWith(
				`\u001b[200~/plan \u001b[201~\u001b[200~${deferredStartupPromptText.slice(6)}\u001b[201~`,
			),
		);
		expect(session.write).toHaveBeenCalledTimes(1);
		manager.stopTaskSession("task-1");
	});

	it("sends deferred Claude startup input after terminal output begins", async () => {
		const deferredStartupPromptText = "Implement the task";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "claude",
			args: [],
			env: {},
			deferredStartupPromptText,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude",
			prompt: "Implement the task",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Claude Code\n");
		expect(session.write).toHaveBeenCalledWith(`\u001b[200~${deferredStartupPromptText}\u001b[201~`);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Claude startup input when startup output arrives before spawn returns", async () => {
		const deferredStartupPromptText = "Implement the task";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "claude",
			args: [],
			env: {},
			deferredStartupPromptText,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			request.onData?.(Buffer.from("Claude Code\n", "utf8"));
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude",
			prompt: "Implement the task",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		expect(session.write).toHaveBeenCalledWith(`\u001b[200~${deferredStartupPromptText}\u001b[201~`);
		expect(session.write).toHaveBeenCalledTimes(1);
	});
});
