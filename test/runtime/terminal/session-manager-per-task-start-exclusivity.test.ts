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

function startTaskSessionRequestFor(taskId: string) {
	return {
		taskId,
		agentId: "codex" as const,
		binary: "codex",
		args: [],
		cwd: `/tmp/${taskId}`,
		prompt: "Fix the bug",
	};
}

describe("per-task session start exclusivity", () => {
	let spawnedSessions: Array<ReturnType<typeof createMockPtySession>>;

	beforeEach(() => {
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

	it("folds two concurrent starts for one task into a single pty instead of orphaning the first", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		// 唯一的去重判据是 `entry.active && isSummaryInActiveTurn(...)`，而换代块在**两次 await 之前**
		// 就把 entry.active 置了 null——于是两个并发请求双双穿过去、各 spawn 一条 PTY，后装载的那条把
		// 先装载的那条从槽位上盖掉。被盖掉的 PTY 此后没有任何引用能停它，孤儿由此产生。
		await Promise.all([
			manager.startTaskSession(startTaskSessionRequestFor("task-1")),
			manager.startTaskSession(startTaskSessionRequestFor("task-1")),
		]);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions).toHaveLength(1);
		expect(manager.getSummary("task-1")?.pid).toBe(100);
		// 没有任何一条被创建出来又被丢掉：孤儿的判据就是「spawn 了但没人停」。
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
	});

	it("serializes a shell start against a task start on the same task slot", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		// shell 会话与 task 会话写的是同一个 entry.active 槽位，抢的是同一份资源。
		await Promise.all([
			manager.startTaskSession(startTaskSessionRequestFor("task-1")),
			manager.startShellSession({ taskId: "task-1", cwd: "/tmp/task-1", binary: "bash" }),
		]);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.pid).toBe(100);
	});

	it("does not serialize starts across different tasks", async () => {
		const manager = new TerminalSessionManager();
		manager.attach("task-a", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });
		manager.attach("task-b", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await Promise.all([
			manager.startTaskSession(startTaskSessionRequestFor("task-a")),
			manager.startTaskSession(startTaskSessionRequestFor("task-b")),
		]);

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.getSummary("task-a")?.pid).toBe(100);
		expect(manager.getSummary("task-b")?.pid).toBe(101);
	});

	it("leaves a restore snapshot explaining the failure instead of an empty one that invites auto-resume", async () => {
		// 空 restore 快照 + pid 为空是前端判「服务器死过一次、镜像已丢」的权威信号，据此自动续跑。
		// 启动失败若把镜像丢掉又不回填，这个 task 的空快照就**永久化**了——而前端那道守卫是
		// per-终端实例的，换标签页 / 切卡片 / 被 LRU 驱逐重挂全都重置。于是每一个挂上来的终端实例
		// 都续跑一次，每次续跑失败又把空快照续上，环就闭合了。
		ptySessionSpawnMock.mockImplementationOnce(() => {
			throw new Error("spawn exploded");
		});
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await expect(manager.startTaskSession(startTaskSessionRequestFor("task-1"))).rejects.toThrow();

		const restoreSnapshot = await manager.getRestoreSnapshot("task-1");
		expect(restoreSnapshot).not.toBeNull();
		expect(restoreSnapshot?.snapshot).toContain("spawn exploded");
	});

	it("leaves the same failure-explaining snapshot when the launch preparation fails, not just the spawn", async () => {
		// 启动失败有两条路径：准备阶段（工作目录物化 / adapter 准备）与 pty.spawn。此前只有后者会
		// 装载解释性镜像；前者抛出时新建的镜像既没 dispose 也没装载，而 entry.terminalStateMirror
		// 已被换代块置空 ⇒ 空快照永久化，前端据此反复自动续跑。两条路径必须留下同样的东西。
		prepareAgentLaunchMock.mockRejectedValueOnce(new Error("codex adapter could not prepare"));
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await expect(manager.startTaskSession(startTaskSessionRequestFor("task-1"))).rejects.toThrow();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();

		const restoreSnapshot = await manager.getRestoreSnapshot("task-1");
		expect(restoreSnapshot).not.toBeNull();
		expect(restoreSnapshot?.snapshot).toContain("codex adapter could not prepare");
	});

	it("runs refresh's stop and start under one gate without deadlocking on itself", async () => {
		// refreshTaskTerminal 现在整体持有闸门（forceStop 与 start 不再可能被别的请求插进中间）。
		// 这条用例锁的是这个改动**自身**最大的回归风险：内部若误调公开的 startTaskSession，
		// 就会再抢一次同一把闸门、当场自死锁——表现为这里永远等不回来。
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		const summaries = await Promise.all([
			manager.refreshTaskTerminal(startTaskSessionRequestFor("task-1")),
			manager.refreshTaskTerminal(startTaskSessionRequestFor("task-1")),
		]);

		expect(summaries).toHaveLength(2);
		expect(manager.getSummary("task-1")?.state).toBe("running");
		// 每一条被换掉的会话都被显式停过：闸门的意义就是「不会有任何一代被静默丢下」。
		for (const session of spawnedSessions.slice(0, -1)) {
			expect(session.stop).toHaveBeenCalled();
		}
	});

	it("keeps the gate usable after a start fails", async () => {
		// 闸门一旦泄漏，这个 task 此后再也起不来任何会话——比它要拦的缺陷还严重，故单独锚定。
		ptySessionSpawnMock.mockImplementationOnce(() => {
			throw new Error("spawn exploded");
		});
		const manager = new TerminalSessionManager();
		manager.attach("task-1", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await expect(manager.startTaskSession(startTaskSessionRequestFor("task-1"))).rejects.toThrow();
		await manager.startTaskSession(startTaskSessionRequestFor("task-1"));

		expect(manager.getSummary("task-1")?.pid).toBe(100);
		expect(manager.getSummary("task-1")?.state).toBe("running");
	});
});
