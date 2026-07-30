// 会话被回收之后，把「agent 提问 → 会话被回收 → 用户回来作答」的答案投回去，前提是先把 PTY 真的拉回来。
// 这里钉死的正是那条最容易写错的就绪判据：回收只终止运行时、**不删账本**，所以 getSummary 仍然非空——
// 拿它当「会话可投递」的证据会得出假结论，随后 submitTaskChatInputWhenReady 必然返回 null、答案永远送不出去。
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

// 回收路径（forceStopTaskSession）会 stop() 后轮询 hasExited()，并依赖 PTY 侧回调 onExit
// 把 entry.active 置空——桩必须把这两件事都做全，否则测的就不是回收后的真实状态。
function createMockPtySession(pid: number, request: MockSpawnRequest) {
	let exited = false;
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(() => {
			if (exited) {
				return;
			}
			exited = true;
			request.onExit?.({ exitCode: 0 });
		}),
		hasExited: () => exited,
		wasInterrupted: vi.fn(() => false),
	};
}

const ORIGINAL_TASK_PROMPT = "Fix the bug";

async function startTaskSessionOn(manager: TerminalSessionManager, taskId: string): Promise<void> {
	await manager.startTaskSession({
		taskId,
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: "/tmp/reclaimed-answer-delivery",
		prompt: ORIGINAL_TASK_PROMPT,
	});
}

describe("TerminalSessionManager 回收后为待答决策答案投递恢复会话", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) =>
			createMockPtySession(100 + ptySessionSpawnMock.mock.calls.length, request),
		);
	});

	it("回收后 summary 仍在但投递无处可写，恢复之后才重新可投", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");

		await manager.forceStopTaskSession("task-reclaimed", 50);

		// 回收只终止运行时：账本条目与 summary 原样保留，所以「summary 非空」不是就绪判据。
		expect(manager.getSummary("task-reclaimed")).not.toBeNull();
		expect(manager.submitTaskChatInputWhenReady("task-reclaimed", "我的答复")).toBeNull();

		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed")).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		expect(manager.submitTaskChatInputWhenReady("task-reclaimed", "我的答复")).not.toBeNull();
	});

	it("恢复走的是续跑参数，绝不把原始任务 prompt 再跑一遍", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-reclaimed");
		await manager.forceStopTaskSession("task-reclaimed", 50);

		await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-reclaimed");

		const firstLaunchInput = prepareAgentLaunchMock.mock.calls[0]?.[0];
		const resumeLaunchInput = prepareAgentLaunchMock.mock.calls[1]?.[0];
		expect(firstLaunchInput).toMatchObject({ prompt: ORIGINAL_TASK_PROMPT });
		expect(resumeLaunchInput).toMatchObject({ prompt: "", resumeFromTrash: true });
	});

	it("会话仍然活着时是 no-op，不会把正在干活的 PTY 掀掉重来", async () => {
		const manager = new TerminalSessionManager();
		await startTaskSessionOn(manager, "task-live");

		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-live")).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
	});

	it("账本里根本没有这个任务时如实返回 false，绝不假装就绪", async () => {
		const manager = new TerminalSessionManager();
		expect(await manager.resumeReclaimedTaskSessionForPendingUserDecisionAnswerDelivery("task-unknown")).toBe(false);
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
	});
});
