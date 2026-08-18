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
