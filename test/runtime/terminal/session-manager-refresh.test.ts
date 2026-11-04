import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { AgentSessionPtyHostUnreachableError } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
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

describe("TerminalSessionManager refreshTaskTerminal", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("stops the running PTY, emits a banner, and spawns a fresh PTY", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const onOutput = vi.fn();
		const manager = new TerminalSessionManager();
		manager.attach("task-refresh", {
			onState: vi.fn(),
			onOutput,
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-refresh",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-refresh",
			prompt: "first run",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const originalSession = spawnedSessions[0];
		expect(originalSession).toBeDefined();
		// Pretend the existing PTY exits cleanly the moment stop() is called. In real
		// node-pty, the exit event always fires after kill(); the session-manager's
		// onExit handler clears entry.active so the subsequent startTaskSession can run.
		originalSession?.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
			originalSession.stopCalls.push({ force: Boolean(opts?.force) });
			if (!originalSession.exitedFlag) {
				originalSession.triggerExit(0);
			}
		});

		const summary = await manager.refreshTaskTerminal({
			taskId: "task-refresh",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-refresh",
			prompt: "first run",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(summary.pid).toBe(222);
		const bannerOutputs = onOutput.mock.calls.map((call) => call[0]?.toString("utf8") ?? "");
		expect(bannerOutputs.some((text) => text.includes("[kanban] 终端会话已重新启动。"))).toBe(true);
	});

	it.each([false, true])("宿主通信失败不能误报为 agent 二进制启动失败（无监听=%s）", async (noHostIsListening) => {
		const manager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: {
				spawnHostedTerminalPtyProcess: async () => {
					throw new AgentSessionPtyHostUnreachableError(
						noHostIsListening ? "ENOENT: host socket" : "PTY host 请求超时",
						noHostIsListening,
					);
				},
			},
		});
		try {
			await expect(
				manager.startTaskSession({
					taskId: "host-communication-failure",
					agentId: "claude",
					binary: "/isolated/node",
					args: [],
					cwd: "/isolated",
					prompt: "",
				}),
			).rejects.toThrow("会话宿主通信失败");
			expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		} finally {
			manager.dispose();
		}
	});

	it.each([
		{
			label: "宿主 Node 启动 ENOENT",
			error: new Error("could not launch agent session pty host: spawn /isolated/host-node ENOENT"),
			expectedDetail: "could not launch agent session pty host",
		},
		{
			label: "包在 cause 里的宿主启动 ENOENT",
			error: new Error("spawn /isolated/agent ENOENT", {
				cause: new Error("could not launch agent session pty host: spawn /isolated/host-node ENOENT"),
			}),
			expectedDetail: "could not launch agent session pty host",
		},
		{
			label: "宿主归属未知",
			error: new Error("host 归属未知，拒绝降级后重复启动"),
			expectedDetail: "host 归属未知，拒绝降级后重复启动",
		},
		{
			label: "包在 cause 里的宿主不可达",
			error: new Error("spawn /isolated/agent ENOENT", {
				cause: new AgentSessionPtyHostUnreachableError("连接 host 超时：/isolated.sock", false),
			}),
			expectedDetail: "连接 host 超时",
		},
	])("$label 呈现为会话宿主通信失败，而不是 agent CLI 缺失", async ({ error, expectedDetail }) => {
		const manager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: {
				spawnHostedTerminalPtyProcess: async () => {
					throw error;
				},
			},
		});
		try {
			const thrown = await manager
				.startTaskSession({
					taskId: "wrapped-host-failure",
					agentId: "claude",
					binary: "/isolated/agent",
					args: [],
					cwd: "/isolated",
					prompt: "",
				})
				.catch((caught: unknown) => caught);
			expect(thrown).toBeInstanceOf(Error);
			expect(String(thrown)).toContain("会话宿主通信失败");
			expect(String(thrown)).toContain(expectedDetail);
			expect(String(thrown)).not.toContain("Command not found");
			expect(String(thrown)).not.toContain('Failed to launch "/isolated/agent"');
		} finally {
			manager.dispose();
		}
	});

	it("agent 二进制自身的 ENOENT 仍提示 CLI 未安装", async () => {
		const manager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: {
				spawnHostedTerminalPtyProcess: async () => {
					throw new Error("spawn /isolated/agent ENOENT");
				},
			},
		});
		try {
			await expect(
				manager.startTaskSession({
					taskId: "agent-binary-missing",
					agentId: "claude",
					binary: "/isolated/agent",
					args: [],
					cwd: "/isolated",
					prompt: "",
				}),
			).rejects.toThrow("Command not found");
		} finally {
			manager.dispose();
		}
	});

	it("新一代启动失败时只显示失败原因，不追加重启完成提示", async () => {
		const onOutput = vi.fn();
		const manager = new TerminalSessionManager();
		let originalSession: MockPtySession | undefined;
		ptySessionSpawnMock.mockImplementationOnce((request: MockSpawnRequest) => {
			originalSession = createMockPtySession(111, request);
			originalSession.stop.mockImplementation(() => originalSession?.triggerExit(0));
			return originalSession;
		});
		const request = {
			taskId: "failed-refresh",
			agentId: "claude" as const,
			binary: "claude",
			args: [],
			cwd: "/isolated",
			prompt: "",
		};
		manager.attach(request.taskId, { onOutput });
		try {
			await manager.startTaskSession(request);
			ptySessionSpawnMock.mockImplementationOnce(() => {
				throw new Error("隔离模拟：agent 无法启动");
			});
			await expect(manager.refreshTaskTerminal(request)).rejects.toThrow("隔离模拟：agent 无法启动");
			const output = onOutput.mock.calls.map((call) => String(call[0])).join("");
			expect(output).not.toContain("终端会话已重新启动");
			expect(output).toContain("隔离模拟：agent 无法启动");
		} finally {
			manager.dispose();
		}
	});

	it("does not consume the auto-restart budget when refresh is invoked", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length + 1, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-budget", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-budget",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-budget",
			prompt: "first run",
		});

		// Refresh several times in a row — each should spawn a fresh PTY without being rate-limited.
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const currentActive = spawnedSessions[spawnedSessions.length - 1];
			currentActive?.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
				currentActive.stopCalls.push({ force: Boolean(opts?.force) });
				if (!currentActive.exitedFlag) {
					currentActive.triggerExit(0);
				}
			});
			await manager.refreshTaskTerminal({
				taskId: "task-budget",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-budget",
				prompt: "first run",
			});
		}

		// 1 initial + 4 refresh = 5 spawn calls; the auto-restart budget caps at 3 per 5s window
		// and would block calls 4 and 5 if refresh shared its counter.
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(5);
	});

	it("logs and detaches entry.active when SIGKILL also fails to exit the PTY", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 333 : 444, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-zombie",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-zombie",
			prompt: "first run",
		});

		const zombie = spawnedSessions[0];
		expect(zombie).toBeDefined();
		// Worst-case mock: neither SIGTERM nor SIGKILL flips exit. Mirrors a zombie
		// or container PID-1 scenario where the OS still owns the process.
		zombie?.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
			zombie.stopCalls.push({ force: Boolean(opts?.force) });
		});

		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await manager.forceStopTaskSession("task-zombie", 100);

		const combined = stderrSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
		expect(combined).toContain("[tui-freeze] force-kill-timeout");
		expect(combined).toContain("task-zombie");
		stderrSpy.mockRestore();

		// entry.active must be cleared so a follow-up startTaskSession can spawn fresh
		// instead of early-returning the stale summary.
		await manager.startTaskSession({
			taskId: "task-zombie",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-zombie",
			prompt: "second",
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.getSummary("task-zombie")?.pid).toBe(444);
	});

	it("escalates to SIGKILL when the PTY does not exit within the graceful window", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-wedged",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-wedged",
			prompt: "first run",
		});

		const wedged = spawnedSessions[0];
		expect(wedged).toBeDefined();
		// Simulate a wedged TUI: graceful stop() does not flip the exit flag.
		// Force stop() does.
		wedged?.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
			wedged.stopCalls.push({ force: Boolean(opts?.force) });
			if (opts?.force && !wedged.exitedFlag) {
				// Real node-pty fires onExit after SIGKILL — replicate that so the
				// session-manager's onExit handler clears entry.active.
				wedged.triggerExit(0);
			}
		});

		await manager.forceStopTaskSession("task-wedged", 100);

		expect(wedged?.stopCalls.length).toBeGreaterThanOrEqual(2);
		expect(wedged?.stopCalls.some((call) => call.force)).toBe(true);
	});

	// 前端陈旧会话自动续跑的结论是客户端用自己手里的 summary 下的。多标签页同时打开同一张卡时，第二个请求进闸
	// 那一刻会话已被第一个接回来——照常「停掉再起」就是把刚接回来的会话杀掉重来。
	it("前端陈旧会话自动续跑遇到活会话时不停不起，直接返回当前 summary", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		const request = {
			taskId: "task-auto-resume-live",
			agentId: "claude" as const,
			binary: "claude",
			args: [],
			cwd: "/tmp/task-auto-resume-live",
			prompt: "",
			resumeFromTrash: true,
		};
		await manager.startTaskSession(request);

		const summary = await manager.refreshTaskTerminal(request, "stale_session_client_auto_resume");

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		expect(summary.pid).toBe(111);
	});

	it("前端陈旧会话自动续跑在会话确实已不在时照常续跑", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		const request = {
			taskId: "task-auto-resume-dead",
			agentId: "claude" as const,
			binary: "claude",
			args: [],
			cwd: "/tmp/task-auto-resume-dead",
			prompt: "",
			resumeFromTrash: true,
		};
		await manager.startTaskSession(request);
		// 没有任何监听者 ⇒ 退出后不会自动重启，正是「回收后没人在看」的形态。
		spawnedSessions[0]?.triggerExit(129);
		expect(manager.getSummary("task-auto-resume-dead")?.pid).toBeNull();

		const summary = await manager.refreshTaskTerminal(request, "stale_session_client_auto_resume");

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(summary.pid).toBe(222);
	});
});
