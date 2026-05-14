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
		expect(bannerOutputs.some((text) => text.includes("[kanban] Refreshing terminal session"))).toBe(true);
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
});
