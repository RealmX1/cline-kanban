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
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

// stop() 刻意是个不触发退出的 vi.fn()：真实 PTY 收到 SIGTERM 后要过一会儿才死，而 node-pty 的退出事件
// 只能异步投递。「stop 了但事件还没到」正是换代错配的现场，用这个 mock 就能确定性地复现它，
// 不需要去模拟什么高负载竞态。
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

describe("superseded pty exit guard", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	function spawnRecorder() {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(100 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});
		return spawnedSessions;
	}

	it("ignores a late exit from a superseded generation and re-arms auto-restart for the new one", async () => {
		const spawnedSessions = spawnRecorder();
		const listener = { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() };
		const manager = new TerminalSessionManager();
		manager.attach("task-1", listener);

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		expect(manager.getSummary("task-1")?.pid).toBe(100);

		// 强杀超时分支：SIGKILL 之后 PTY 仍不退（zombie / 容器 PID 1），manager 显式放掉 entry.active 让
		// 任务能重新起来，旧 PTY 交给 OS 回收。这条路径是 task 侧「活体尚在、槽位已空」的真实来源——
		// 它同时武装了 suppressAutoRestartOnExit 却永远等不到有人消费。
		await manager.forceStopTaskSession("task-1", 0);
		expect(manager.getSummary("task-1")?.pid).toBe(100);

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.getSummary("task-1")?.pid).toBe(101);
		listener.onExit.mockClear();

		// 上一代终于死了。它的退出事件读到的是**新代**的 active——没有身份守卫的话，这一下会把刚起来的
		// 那条会话整个拆掉：打掉 active、迁成已退出、通知监听者，随后自动重启再起一条，环就是这么转的。
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.getSummary("task-1")?.pid).toBe(101);
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(listener.onExit).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);

		// 新一代自己崩溃：这是一次**合法**的自愈。上一步的 forceStop 留下的 suppress 闩若没在装载新代时
		// 清账，就会把它悄悄吃掉——用户看到的是「刷新之后第一次崩溃不自动重启」，且只发生第一次。
		spawnedSessions[1]?.triggerExit(1);
		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(3);
		});
	});

	it("ignores a late exit from a superseded shell generation as well", async () => {
		const spawnedSessions = spawnRecorder();
		const listener = { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() };
		const manager = new TerminalSessionManager();
		manager.attach("task-shell", listener);

		await manager.startShellSession({ taskId: "task-shell", cwd: "/tmp/task-shell", binary: "bash" });
		manager.transitionToReview("task-shell", "manual_review");
		await manager.startShellSession({ taskId: "task-shell", cwd: "/tmp/task-shell", binary: "bash" });

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.getSummary("task-shell")?.pid).toBe(101);
		listener.onExit.mockClear();

		// shell 侧的窗口是**确定性**的，不是竞态：从换代块的 stop() 到装载新代之间逐行无 await，
		// 而退出事件只能异步投递 —— 每一次「在活体上重开 shell」都必然错配。
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.getSummary("task-shell")?.pid).toBe(101);
		expect(manager.getSummary("task-shell")?.state).toBe("running");
		expect(listener.onExit).not.toHaveBeenCalled();
	});
});
