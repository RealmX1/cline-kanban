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
import { MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK } from "../../../src/terminal/task-session-auto-restart-policy";

interface MockSpawnRequest {
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
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

function startTaskSessionRequest() {
	return {
		taskId: "task-1",
		agentId: "codex" as const,
		binary: "codex",
		args: [],
		cwd: "/tmp/task-1",
		prompt: "Fix the bug",
	};
}

describe("auto-restart circuit breaker", () => {
	let spawnedSessions: Array<ReturnType<typeof createMockPtySession>>;

	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		spawnedSessions = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(100 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// 每一代都在装载后立刻退出 ⇒ 存活时长恒为 0，全部记作 fast exit。
	async function crashNewestIncarnationAndSettleBackoff(backoffMs: number): Promise<void> {
		spawnedSessions[spawnedSessions.length - 1]?.triggerExit(1);
		await vi.advanceTimersByTimeAsync(backoffMs);
	}

	it("stretches each retry further apart and then stops on its own, leaving a visible reason", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);

		// 旧限速器是「5 秒内最多 3 次」的滑动窗口：无退避、无总量上限，理论上能以 0.6 次/秒无限空转，
		// 而那个速率恰好覆盖当年那次故障的实测值。现在每一轮都被拉得更开，五轮之后彻底停手。
		for (const backoffMs of [0, 1_000, 2_000, 4_000, 8_000]) {
			await crashNewestIncarnationAndSettleBackoff(backoffMs);
		}
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(
			1 + MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK,
		);

		// 第 6 次连续秒退 ⇒ 熔断。再怎么等都不会有新的 spawn。
		await crashNewestIncarnationAndSettleBackoff(60_000);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(
			1 + MAX_CONSECUTIVE_FAILED_FAST_EXIT_AUTO_RESTARTS_BEFORE_CIRCUIT_BREAK,
		);
		// 熔断必须是用户看得见的终态，否则表现就是「任务莫名其妙不动了」。
		expect(manager.getSummary("task-1")?.warningMessage).toContain("已停止自动重启");
	});

	it("lets a human start clear the circuit break that no automatic path can clear", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());
		for (const backoffMs of [0, 1_000, 2_000, 4_000, 8_000, 60_000]) {
			await crashNewestIncarnationAndSettleBackoff(backoffMs);
		}
		const spawnCountWhileCircuitBroken = ptySessionSpawnMock.mock.calls.length;

		// 前端的自动续跑**不算**人干预：若它能清账，「反复自动续跑」这种成环形态就永远熔断不了。
		await manager.startTaskSession(startTaskSessionRequest(), "stale_session_client_auto_resume");
		await crashNewestIncarnationAndSettleBackoff(60_000);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(spawnCountWhileCircuitBroken + 1);

		// 人点的刷新才清账：熔断态挂在内存里、entries 又从不回收，解不开就得重启整个进程。
		await manager.startTaskSession(startTaskSessionRequest(), "refresh_task_terminal");
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(spawnCountWhileCircuitBroken + 2);
		await crashNewestIncarnationAndSettleBackoff(0);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(spawnCountWhileCircuitBroken + 3);
	});

	it("drops an auto-restart that is already in flight when the user stops the session", async () => {
		// 首次退避是 0ms，所以那一次自动重启**没有计时器**可掐：它已经在跑、正排队等启动闸门。
		// 而排队期间 entry.active 恰恰是 null，stopTaskSession 会在自己的空守卫处早退——
		// 只取消计时器的话，用户按了停止，会话照样被机器拉起来。
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);

		spawnedSessions[0]?.triggerExit(1);
		manager.stopTaskSession("task-1");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("does not resurrect sessions after the runtime interrupts and stops every session", async () => {
		// markInterruptedAndStopAll 的两个调用方是 runtime 关停与 workspace 移除，之后 manager 就被丢弃。
		// 它此前既不设 suppress 闩也不作废在途重启，于是被它停掉的会话退出时会真的重启一条——
		// 一条挂在已被移除的 workspace 上、再没有任何人管的 PTY。
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());

		manager.markInterruptedAndStopAll();
		spawnedSessions[0]?.triggerExit(1);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending backoff when the user stops the session in the meantime", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());

		await crashNewestIncarnationAndSettleBackoff(0);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);

		// 第二次秒退 ⇒ 退避 1 秒。退避在途时 entry.active 是 null（上一条已死、新的还没起），
		// 所以停止入口的取消动作必须排在它自己的「没有活会话就早退」之前，否则永远碰不到这个计时器。
		spawnedSessions[1]?.triggerExit(1);
		manager.stopTaskSession("task-1");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
	});

	it("cancels pending backoffs when the manager is disposed", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		await manager.startTaskSession(startTaskSessionRequest());
		await crashNewestIncarnationAndSettleBackoff(0);
		spawnedSessions[1]?.triggerExit(1);

		// manager 都要没了，几秒后再拉起一条会话只会留下一条没人管的 PTY。
		manager.dispose();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
	});
});
