import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回显 fan-out 顺序回归测试:handleTaskOutput 里 taskListener.onOutput 必须先于每-chunk
// 输出分析管线(实质输出检测 → summary 更新 → adapter 检测 → output-reaction 扫描)执行。
// 历史病灶:fan-out 排在分析之后,spinner 高频重绘期间分析的同步 CPU 把键盘回显整体推迟,
// 造成低负载下的 TUI 输入卡顿。

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const substanceDetectionProbe = vi.hoisted(() => ({
	invocationLog: [] as string[],
	throwOnNextInvocation: false,
}));

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	toBracketedPasteSubmission: (command: string) => `[200~${command}[201~\r`,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 用可观察探针包裹真实实现:记录调用顺序,并支持按需抛异常,验证「分析炸了回显仍送达」。
// session-manager 热路径走的是 FromStripped 变体(strip 一次、多消费者共享)。
vi.mock("../../../src/terminal/agent-output-substance.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/terminal/agent-output-substance.js")>();
	const detectFreshSubstantiveAgentOutputFromStripped: typeof original.detectFreshSubstantiveAgentOutputFromStripped =
		(memory, strippedChunk) => {
			substanceDetectionProbe.invocationLog.push("substance-detection");
			if (substanceDetectionProbe.throwOnNextInvocation) {
				substanceDetectionProbe.throwOnNextInvocation = false;
				throw new Error("substance detection boom");
			}
			return original.detectFreshSubstantiveAgentOutputFromStripped(memory, strippedChunk);
		};
	return {
		...original,
		detectFreshSubstantiveAgentOutputFromStripped,
	};
});

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

function spawnManagerWithSession(pid: number) {
	let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		spawnedSession = createMockPtySession(pid, request);
		return spawnedSession;
	});
	return () => spawnedSession;
}

describe("session-manager · output fan-out ordering", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		substanceDetectionProbe.invocationLog.length = 0;
		substanceDetectionProbe.throwOnNextInvocation = false;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("delivers echo to listeners synchronously; substance-detection analysis is deferred to the batch flush", async () => {
		const getSession = spawnManagerWithSession(2001);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-fanout-order",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-fanout-order",
			prompt: "Do the task",
		});
		manager.attach("task-fanout-order", {
			onOutput: () => {
				substanceDetectionProbe.invocationLog.push("listener-on-output");
			},
		});

		const session = getSession();
		expect(session).not.toBeNull();
		(session as NonNullable<typeof session>).triggerData("agent produced this line of real output\r\n");

		// 回显同步送达;重分析(实质输出检测)攒批延后——回显绝不排在分析之后。
		expect(substanceDetectionProbe.invocationLog).toEqual(["listener-on-output"]);

		// 推进攒批窗口(OUTPUT_ANALYSIS_BATCH_WINDOW_MS=50)后分析才执行,顺序仍在回显之后。
		await vi.advanceTimersByTimeAsync(50);
		expect(substanceDetectionProbe.invocationLog).toEqual(["listener-on-output", "substance-detection"]);

		manager.stopTaskSession("task-fanout-order");
	});

	it("still delivers echo to listeners when the analysis pipeline throws", async () => {
		const getSession = spawnManagerWithSession(2002);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-fanout-throw",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-fanout-throw",
			prompt: "Do the task",
		});
		const receivedChunks: string[] = [];
		manager.attach("task-fanout-throw", {
			onOutput: (chunk) => {
				receivedChunks.push(chunk.toString("utf8"));
			},
		});

		const session = getSession();
		expect(session).not.toBeNull();
		substanceDetectionProbe.throwOnNextInvocation = true;
		(session as NonNullable<typeof session>).triggerData("output that makes the analysis explode\r\n");

		// 分析尚未执行(攒批延后),回显已经先送达——回显与分析解耦的核心收益。
		expect(receivedChunks.join("")).toContain("output that makes the analysis explode");

		// flush 时分析抛异常(经 fake timers 传播出来)……
		await expect(vi.advanceTimersByTimeAsync(50)).rejects.toThrow("substance detection boom");

		// ……后续输出的回显不受影响,继续流动。
		(session as NonNullable<typeof session>).triggerData("echo still flows after the analysis blew up\r\n");
		expect(receivedChunks.join("")).toContain("echo still flows after the analysis blew up");

		manager.stopTaskSession("task-fanout-throw");
	});

	it("joins lines split across chunks inside one batch window: spinner chrome cut mid-line is not misjudged as substantive", async () => {
		// 旧 per-chunk 语义的已知误判:spinner 状态行被 chunk 边界切断时,前半段(尚无
		// `esc to interrupt` 尾巴)看起来像实质正文 → 误推 lastSubstantiveOutputAt。攒批把
		// 同窗口内的两段拼回完整行,chrome 规则重新命中 → 不误判(检测「更准」而非等价)。
		const getSession = spawnManagerWithSession(2003);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-fanout-split-line",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-fanout-split-line",
			prompt: "Do the task",
		});
		const session = getSession();
		expect(session).not.toBeNull();

		// 完整行是 chrome(含 esc to interrupt);切成两段后,前半段单看含 >=3 词字符、无 chrome 信号。
		(session as NonNullable<typeof session>).triggerData("Downloading model weights please wait esc");
		(session as NonNullable<typeof session>).triggerData(" to interrupt (12s)\r\n");
		await vi.advanceTimersByTimeAsync(50);

		expect(manager.getSummary("task-fanout-split-line")?.lastSubstantiveOutputAt ?? null).toBeNull();

		manager.stopTaskSession("task-fanout-split-line");
	});
});
