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

function createMockPtySession(pid: number) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: vi.fn(() => false),
		wasInterrupted: vi.fn(() => false),
	};
}

function startTaskSessionRequestFor(taskId: string) {
	return {
		taskId,
		agentId: "claude" as const,
		binary: "claude",
		args: [],
		cwd: `/tmp/${taskId}`,
		prompt: "Rewrite the resume path",
	};
}

// dd2db 2.1 注入回执：prepareAgentLaunch 只交出「会话成功启动后再提交」的回调；提交点只能是 spawn 成功、
// 新会话装进槽位之后——spawn 失败时注入根本没发生，账本只追加、记下了就删不掉。
describe("asserted relation injection receipt is committed only after the task session was spawned and installed", () => {
	const commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded = vi.fn();

	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args, "--append-system-prompt", "# Kanban Relations Of This Task"],
			env: {},
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded,
		}));
	});

	it("does not commit the receipt when the PTY spawn fails", async () => {
		ptySessionSpawnMock.mockImplementationOnce(() => {
			throw new Error("spawn exploded");
		});
		const manager = new TerminalSessionManager();
		manager.attach("b0002", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await expect(manager.startTaskSession(startTaskSessionRequestFor("b0002"))).rejects.toThrow();

		expect(prepareAgentLaunchMock).toHaveBeenCalledTimes(1);
		expect(commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).not.toHaveBeenCalled();
	});

	it("commits the receipt exactly once per successful spawn, after the spawn", async () => {
		ptySessionSpawnMock.mockImplementation(() => createMockPtySession(100));
		const manager = new TerminalSessionManager();
		manager.attach("b0002", { onState: vi.fn(), onOutput: vi.fn(), onExit: vi.fn() });

		await manager.startTaskSession(startTaskSessionRequestFor("b0002"));

		expect(commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded).toHaveBeenCalledTimes(1);
		expect(ptySessionSpawnMock.mock.invocationCallOrder[0]).toBeLessThan(
			commitAssertedRelationInjectionReceiptAfterSessionLaunchSucceeded.mock.invocationCallOrder[0] ?? 0,
		);
		expect(manager.getSummary("b0002")?.pid).toBe(100);
	});
});
