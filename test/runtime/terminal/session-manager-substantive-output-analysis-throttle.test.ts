// 实质输出分析节流（SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS）的行为钉子。
//
// 分析器（strip + 行级签名比对）此前每 50ms 攒批都跑一次；节流后在 agent 回合内至多每 ~4s 跑一次，
// 而同一 flush 里的 adapter 输出转移检测与 output-reaction 扫描**不受影响**（延迟敏感）。
// 承重不变量：节流窗口必须严格小于 VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS(5s)——否则持续产出的
// 会话会出现虚假的 >5s 实质戳空档，isAgentActivelyProducingOutput 转 false、卡片被误判为「已停」。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const substanceDetectorCallSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/terminal/agent-session-adapters.js")>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 分析器保留真实实现，只在外面套一层计数器，用来断言「跑了几次」而非只断言结果。
vi.mock("../../../src/terminal/agent-output-substance.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/terminal/agent-output-substance.js")>();
	return {
		...actual,
		detectFreshSubstantiveAgentOutputFromStripped: (
			memory: Parameters<typeof actual.detectFreshSubstantiveAgentOutputFromStripped>[0],
			strippedChunk: string,
		) => {
			substanceDetectorCallSpy(strippedChunk);
			return actual.detectFreshSubstantiveAgentOutputFromStripped(memory, strippedChunk);
		},
	};
});

import { VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS } from "../../../src/core/session-activity";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

// 与 session-manager 的常量保持一致（该文件不导出它们；此处按值复刻并由下方不变量断言守住）。
const OUTPUT_ANALYSIS_BATCH_WINDOW_MS = 50;
const SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS = VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1_000;
const MAX_PENDING_OUTPUT_ANALYSIS_CHARS = 64 * 1024;
const MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS = 64 * 1024;

// Claude/Codex 思考中的 spinner 状态行：sparkle 前缀 + `esc to interrupt` + 计时器，三重命中
// agent-output-substance 的 chrome 掩码，永不算实质产出。
const SPINNER_CHROME_LINE = "✻ Cogitating… (12s · esc to interrupt)\n";

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
	triggerData: (chunk: string) => void;
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
		triggerData: (chunk) => {
			request.onData?.(Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode) => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode });
		},
	};
	return session;
}

describe("TerminalSessionManager substantive output analysis throttle", () => {
	let spawnedSessions: MockPtySession[];

	beforeEach(() => {
		vi.useFakeTimers();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		substanceDetectorCallSpy.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		spawnedSessions = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(101 + spawnedSessions.length, request);
			spawnedSessions.push(session);
			return session;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// 节流窗口 < Validation 活跃窗口是本设计的承重不变量，直接钉住（session-manager 里按减法结构性绑定，
	// 此处再断言一次，使有人改动任一常量时先在这里炸出来）。
	it("keeps the throttle window strictly inside the Validation active window", () => {
		expect(SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS).toBeLessThan(VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS);
		expect(SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS).toBeGreaterThan(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
	});

	it("runs the substance classifier at most once per throttle window while output streams continuously", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-throttle",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-throttle",
			prompt: "Implement the task",
		});

		const streamDurationMs = 12_000;
		const batchCount = streamDurationMs / OUTPUT_ANALYSIS_BATCH_WINDOW_MS;
		const observedStamps: number[] = [];
		for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
			// 每批都是全新的实质内容行——无节流时每批都会推进实质戳。
			spawnedSessions[0]?.triggerData(`Streaming a brand new content line number ${batchIndex}\n`);
			await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
			const stamp = manager.getSummary("task-throttle")?.lastSubstantiveOutputAt ?? null;
			if (stamp !== null && observedStamps.at(-1) !== stamp) {
				observedStamps.push(stamp);
			}
		}

		// 无节流：每批一次 → 240 次。节流后上限是 ceil(12000/4000)+1。
		const maxExpectedRuns = Math.ceil(streamDurationMs / SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS) + 1;
		expect(substanceDetectorCallSpy.mock.calls.length).toBeLessThanOrEqual(maxExpectedRuns);
		expect(substanceDetectorCallSpy.mock.calls.length).toBeGreaterThan(1);
		expect(batchCount).toBeGreaterThan(maxExpectedRuns * 10);

		// 承重：持续产出期间任意相邻两次打戳的间隔都必须留在 Validation 活跃窗口内，
		// 否则 isAgentActivelyProducingOutput 会读到虚假空档、把仍在产出的卡片判为已停。
		expect(observedStamps.length).toBeGreaterThan(1);
		for (let index = 1; index < observedStamps.length; index += 1) {
			const gapMs = (observedStamps[index] ?? 0) - (observedStamps[index - 1] ?? 0);
			expect(gapMs).toBeLessThan(VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS);
		}
	});

	it("skips the substance classifier entirely while the resume guard is armed", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-throttle-guarded",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-throttle-guarded",
			prompt: "",
			resumeFromTrash: true,
		});
		manager.transitionToRunning("task-throttle-guarded");
		substanceDetectorCallSpy.mockClear();

		for (let batchIndex = 0; batchIndex < 40; batchIndex += 1) {
			spawnedSessions[0]?.triggerData(`Replayed transcript line number ${batchIndex}\n`);
			await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		}

		expect(substanceDetectorCallSpy).not.toHaveBeenCalled();
		expect(manager.getSummary("task-throttle-guarded")?.lastSubstantiveOutputAt ?? null).toBeNull();
	});

	// 节流只作用于实质输出分析：adapter 的输出转移检测仍逐攒批执行，故 Codex 的
	// prompt-ready 转移必须在 50ms 尺度上落地，而不是被推迟到下一个 4s 节流窗口。
	it("keeps adapter output-transition detection on the 50ms batch cadence", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-throttle-transition",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-throttle-transition",
			prompt: "Implement the task",
		});

		// 先消耗一次分析配额，使后续输出落在节流空档里。
		spawnedSessions[0]?.triggerData("An initial real content line from the agent\n");
		await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		const callsAfterFirstBatch = substanceDetectorCallSpy.mock.calls.length;
		expect(callsAfterFirstBatch).toBe(1);

		const summaryUpdates: number[] = [];
		manager.attach("task-throttle-transition", {
			onState: (summary) => {
				summaryUpdates.push(summary.updatedAt);
			},
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		// 节流空档内的第二批：分析器不该再跑，但 summary 仍随 lastOutputAt 逐 chunk 更新
		//（卡片 computing 展示依赖它），说明 flush 路径本身没有被节流整体关掉。
		spawnedSessions[0]?.triggerData("Another content line inside the throttle gap\n");
		await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		expect(substanceDetectorCallSpy.mock.calls.length).toBe(callsAfterFirstBatch);
		expect(summaryUpdates.length).toBeGreaterThan(0);
	});

	// 回归（RVF-002）：节流曾把空档内的攒批整段丢弃——文本既不进分类器也不进新鲜度记忆。
	// 失败序列「先 spinner chrome 吃掉配额 → 空档内产出唯一一段简短真实回复 → 随即停止输出」下，
	// 此后再无 flush 触发分析，那段真实回复永远无人观察，卡片少报一次响应、
	// isAgentActivelyProducingOutput 在该轮里也看不到活性。
	it("still stamps a short reply that lands in the throttle gap and is followed by silence", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-throttle-gap-tail",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-throttle-gap-tail",
			prompt: "Implement the task",
		});

		// ① 纯 chrome 的一批：跑掉本轮分析配额，但因非实质而不推进实质戳。
		spawnedSessions[0]?.triggerData(SPINNER_CHROME_LINE);
		await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		expect(substanceDetectorCallSpy.mock.calls.length).toBe(1);
		expect(manager.getSummary("task-throttle-gap-tail")?.lastSubstantiveOutputAt ?? null).toBeNull();

		// ② 节流空档内的唯一一段真实回复，随后 agent 彻底静默（不再有任何输出触发 flush）。
		spawnedSessions[0]?.triggerData("Done: the failing regression now passes.\n");
		await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		const outputAtOfReply = manager.getSummary("task-throttle-gap-tail")?.lastOutputAt ?? null;
		expect(outputAtOfReply).not.toBeNull();

		// ③ 只推进时间越过节流窗口，不喂任何输出。
		await vi.advanceTimersByTimeAsync(SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS);

		// 那段真实回复必须最终被观察到，且时间戳落在它到达的时刻（不晚于 lastOutputAt）。
		const stampedAt = manager.getSummary("task-throttle-gap-tail")?.lastSubstantiveOutputAt ?? null;
		expect(stampedAt).toBe(outputAtOfReply);
		expect(substanceDetectorCallSpy.mock.calls.some(([text]) => String(text).includes("failing regression"))).toBe(
			true,
		);
		// 节流本身仍成立：整段序列里分类器至多跑两次（窗口首 + 窗口末补分析），而非逐 50ms 攒批各跑一次。
		expect(substanceDetectorCallSpy.mock.calls.length).toBeLessThanOrEqual(2);
	});

	// 待分析尾巴必须有上限：洪水输出下单个节流窗口能喂给分类器的字符数被钳成常数，
	// 否则节流的 CPU 收益会被无上限的补分析吃回去，且内存随窗口线性增长。
	it("caps the deferred analysis tail so a flooding window stays bounded", async () => {
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-throttle-gap-flood",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-throttle-gap-flood",
			prompt: "Implement the task",
		});

		// 先用 chrome 吃掉配额，使随后的洪水全部落在同一个节流空档里。
		spawnedSessions[0]?.triggerData(SPINNER_CHROME_LINE);
		await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
		substanceDetectorCallSpy.mockClear();

		const floodChunk = `${"flooding output line with plenty of words ".repeat(64)}\n`;
		const floodChunkCount = Math.ceil((MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS * 4) / floodChunk.length);
		for (let chunkIndex = 0; chunkIndex < floodChunkCount; chunkIndex += 1) {
			spawnedSessions[0]?.triggerData(floodChunk);
		}
		expect(floodChunk.length * floodChunkCount).toBeGreaterThan(MAX_PENDING_OUTPUT_ANALYSIS_CHARS);
		await vi.advanceTimersByTimeAsync(SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS + OUTPUT_ANALYSIS_BATCH_WINDOW_MS);

		expect(substanceDetectorCallSpy.mock.calls.length).toBeGreaterThan(0);
		for (const [analyzedText] of substanceDetectorCallSpy.mock.calls) {
			expect(String(analyzedText).length).toBeLessThanOrEqual(
				MAX_DEFERRED_SUBSTANTIVE_OUTPUT_ANALYSIS_CHARS + MAX_PENDING_OUTPUT_ANALYSIS_CHARS,
			);
		}
		expect(manager.getSummary("task-throttle-gap-flood")?.lastSubstantiveOutputAt ?? null).not.toBeNull();
	});
});
