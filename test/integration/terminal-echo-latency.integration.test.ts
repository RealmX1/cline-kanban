import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
	judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline,
	type LoadSensitiveWallClockTwoTierDeadline,
	startHostCpuContentionDiagnosticsWindow,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

// 回显延迟回归绊线(真 PTY,非 mock):spinner 高频重绘 + 周期大段输出的洪水场景下,
// 键盘输入的 PTY 回显必须在宽松阈值内回到 listener——历史病灶是每-chunk 输出分析同步占满
// 事件循环、ack 背压暂停 PTY、巨帧解析,合起来把回显拖到秒级(低负载 TUI 输入卡顿)。
// 本测试是「多秒级冻结」的绊线,不是精确基准。
//
// 这是 C 类性能绊线,按 D1-b 判定:GitHub Actions 上超过软档 2s 即失败(与改动前一致);
// 本地高负载下消费端被抢走 CPU 的积压与退化同一量级,超过软档只告警,超过硬档才失败。
// 当年三个已知根因另有确定性用例守护:session-manager-output-fanout.test.ts(回显同步 fan-out
// 先于分析、攒批)与 terminal-output-normalization.test.ts(strip 等价与零分配)。
//
// prepareAgentLaunch mock 为透传:以 agentId "claude" 走完整 agent 会话分析管线,
// 但实际 spawn 的是 node 洪水脚本。PtySession 用真实实现(node-pty)。

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/terminal/agent-session-adapters.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/terminal/agent-session-adapters.js")>();
	return {
		...original,
		prepareAgentLaunch: prepareAgentLaunchMock,
	};
});

import { TerminalSessionManager } from "../../src/terminal/session-manager";

const ECHO_MARKER = "ECHO_LATENCY_MARKER_7f3a";
// 洪水已在流动之后,再额外让它跑一段时间,保证测回显时 spinner 重绘与大块输出都处在稳态。
const FLOOD_STEADY_STATE_AFTER_FIRST_SPINNER_MS = 800;

// EXPERIMENT_NODE: 回显硬档初值 8000ms,待在负载下标定 echo 实际延迟分布后再定
// 回显延迟从 writeInput 调用之前起算(覆盖 writeInput 同步路径 + PTY + 输出管线),到达时刻在 onOutput 里就地记下,
// 用本 deadline 经 judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline 做真正的两档判定。
const KEYSTROKE_ECHO_UNDER_FLOOD_OUTPUT_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "洪水输出下按键的 PTY 回显到达 listener(从调用 writeInput 之前起算)",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 8_000,
	strictAtSoftDeadlineWhenRunningInContinuousIntegration: true,
};

// 等待侧放弃边界在回显硬档之外多留的余量:覆盖轮询间隔(helper 默认 25ms)与高负载下的定时器迟到,
// 使「从写入前起算恰在硬档内到达」的回显不会因为轮询落点晚于放弃边界而被等待侧当成未到达。
const KEYSTROKE_ECHO_ARRIVAL_WAIT_GIVE_UP_SLACK_BEYOND_ECHO_HARD_DEADLINE_MS = 500;

// 只负责「回显终会到达」的等待与挂起保护,不做延迟判定:wait helper 从它自己被调用时(writeInput 返回之后)起算,
// 拿它的计时判定就会把 writeInput 的同步阻塞排除在外。所以这里:
// - 不开 CI 严格:CI 上超过软档的失败由上面那份从写入前起算的判定负责。
// - 软档 = 硬档:等待侧不另发软档告警,避免与真正的判定重复告警。
// - 放弃边界取「回显硬档全长 + 余量」,刻意不扣除 writeInput 已耗的时间:总等待 = 写入耗时 + 硬档 + 余量,
//   不短于「硬档 − 写入耗时」,从写入前起算硬档内到达的回显都一定能被看到;多等的部分只在回显本就超过硬档时用上,
//   那时真正的判定照样失败,结论不变。回显始终不到时由本等待以「超过硬档」失败,附最后观察到的 spinner 计数。
const KEYSTROKE_ECHO_ARRIVAL_WAIT_ONLY_HANG_GUARD_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription:
		"洪水输出下按键的 PTY 回显到达 listener(仅挂起保护,从 writeInput 返回起算;延迟判定另从写入前起算)",
	softDeadlineMsExpectedOnUncontendedHost:
		KEYSTROKE_ECHO_UNDER_FLOOD_OUTPUT_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
		KEYSTROKE_ECHO_ARRIVAL_WAIT_GIVE_UP_SLACK_BEYOND_ECHO_HARD_DEADLINE_MS,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression:
		KEYSTROKE_ECHO_UNDER_FLOOD_OUTPUT_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
		KEYSTROKE_ECHO_ARRIVAL_WAIT_GIVE_UP_SLACK_BEYOND_ECHO_HARD_DEADLINE_MS,
};

const FIRST_FLOOD_SPINNER_FRAME_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "洪水脚本的首个 spinner 帧到达 listener(从会话启动起算)",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};

const FLOOD_SPINNER_ADVANCES_AFTER_ECHO_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "回显到达之后 spinner 计数继续前进(证明测回显时洪水仍在流动)",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};

const FLOOD_SPINNER_COUNTER_PATTERN = /\((\d+)s · esc to interrupt\)/gu;

// 洪水脚本:每 5ms 重绘一条含 `esc to interrupt` 的 spinner 状态行,每 50ms 追加一段 8KB
// 大块输出。由测试在结束时显式停止;60 秒后自杀只是兜底(防挂进程),不能早于用例的硬档结束。
// 回显由脚本在 raw 模式下自己写回 stdout(与真实 agent TUI 一致),不用 PTY 行规的内核 echo:
// macOS 上 tty 输出队列被洪水塞满时(读端稍一落后就会),内核 echo 的字符会被直接丢弃,
// marker 永远不出现,高负载下会被误判为「超过硬档」(实测:读端暂停 500ms 期间写入的 marker 整段丢失)。
// 应用层回显走阻塞写,队列满时排队而不丢,测到的延迟正好包含消费端积压——这才是本绊线要量的东西。
const FLOOD_SCRIPT_SOURCE = `
const bigBlock = "x".repeat(8192);
let counter = 0;
const spinnerTimer = setInterval(() => {
	counter += 1;
	process.stdout.write("\\r\\u001b[2K\\u001b[38;5;213m\\u2733\\u001b[0m Cogitating\\u2026 (" + counter + "s \\u00b7 esc to interrupt)");
	if (counter % 10 === 0) {
		process.stdout.write("\\n" + bigBlock + "\\n");
	}
}, 5);
setTimeout(() => {
	clearInterval(spinnerTimer);
	process.exit(0);
}, 60000);
process.stdin.setRawMode(true);
process.stdin.on("data", (typedInput) => {
	process.stdout.write(typedInput);
});
`;

describe("terminal echo latency under flood output (integration, real PTY)", () => {
	let workDir: string;
	let manager: TerminalSessionManager;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "kanban-echo-latency-"));
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(
			async (input: { binary: string; args: string[]; env?: Record<string, string | undefined> }) => ({
				binary: input.binary,
				args: [...input.args],
				env: input.env ?? {},
			}),
		);
		manager = new TerminalSessionManager();
	});

	afterEach(async () => {
		await manager.forceStopTaskSession("task-echo-latency").catch(() => undefined);
		rmSync(workDir, { recursive: true, force: true });
	});

	// 用例超时 45s 覆盖:启动 + 首帧硬档 15s + 稳态 0.8s + 回显等待(硬档 8s + 余量 0.5s)+ 洪水仍在流动的硬档 15s + 停止。
	it("delivers the keystroke echo within the tripwire deadline while the agent floods output", async (testContext) => {
		const floodScriptPath = join(workDir, "flood-spinner-output.cjs");
		writeFileSync(floodScriptPath, FLOOD_SCRIPT_SOURCE, "utf8");

		// 只在 onOutput 里就地检测,不累积整串输出:洪水几秒就是数 MB,对整串反复 includes 本身就会拖慢消费端。
		let latestFloodSpinnerCounter: number | null = null;
		let previousChunkTailForMarkerDetection = "";
		// marker 回显到达 listener 的时刻(performance.now()),在 onOutput 检测到的当下就地记下,不受等待侧轮询粒度影响。
		let echoMarkerObservedAtPerformanceNowMs: number | null = null;
		let floodSpinnerCounterWhenEchoMarkerObserved: number | null = null;
		manager.attach("task-echo-latency", {
			onOutput: (chunk) => {
				const chunkText = chunk.toString("utf8");
				for (const spinnerCounterMatch of chunkText.matchAll(FLOOD_SPINNER_COUNTER_PATTERN)) {
					latestFloodSpinnerCounter = Number(spinnerCounterMatch[1]);
				}
				// marker 可能被切在多个 chunk 之间:拼上此前输出的尾部再找。尾部从「旧尾部 + 本 chunk」截取,
				// 否则遇到比 marker 还短的 chunk 时,前面已收到的 marker 片段会被丢掉而漏检。
				const recentOutputTextForMarkerDetection = `${previousChunkTailForMarkerDetection}${chunkText}`;
				if (
					echoMarkerObservedAtPerformanceNowMs === null &&
					recentOutputTextForMarkerDetection.includes(ECHO_MARKER)
				) {
					echoMarkerObservedAtPerformanceNowMs = performance.now();
					floodSpinnerCounterWhenEchoMarkerObserved = latestFloodSpinnerCounter;
				}
				previousChunkTailForMarkerDetection = recentOutputTextForMarkerDetection.slice(-(ECHO_MARKER.length - 1));
			},
		});

		await manager.startTaskSession({
			taskId: "task-echo-latency",
			agentId: "claude",
			binary: process.execPath,
			args: [floodScriptPath],
			cwd: workDir,
			prompt: "",
		});

		// 让洪水先跑起来(spinner 重绘 + 大块输出都已在流动),再测输入回显。
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			testContext,
			FIRST_FLOOD_SPINNER_FRAME_TWO_TIER_DEADLINE,
			() => latestFloodSpinnerCounter !== null,
		);
		await new Promise((resolve) => setTimeout(resolve, FLOOD_STEADY_STATE_AFTER_FIRST_SPINNER_MS));

		// 计时锚点取在调用 writeInput 之前:writeInput 的同步阻塞也是用户感知到的回显延迟,必须计入。
		const echoLatencyHostCpuContentionDiagnosticsWindow = startHostCpuContentionDiagnosticsWindow();
		const echoMarkerWriteStartedAtPerformanceNowMs = performance.now();
		manager.writeInput("task-echo-latency", Buffer.from(ECHO_MARKER, "utf8"));
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			testContext,
			KEYSTROKE_ECHO_ARRIVAL_WAIT_ONLY_HANG_GUARD_DEADLINE,
			() => echoMarkerObservedAtPerformanceNowMs !== null,
			{ describeLastObservedStateForFailureMessage: () => `最新 spinner 计数=${String(latestFloodSpinnerCounter)}` },
		);
		await judgeMeasuredElapsedAgainstLoadSensitiveTwoTierDeadline(
			testContext,
			KEYSTROKE_ECHO_UNDER_FLOOD_OUTPUT_TWO_TIER_DEADLINE,
			echoMarkerObservedAtPerformanceNowMs === null
				? null
				: echoMarkerObservedAtPerformanceNowMs - echoMarkerWriteStartedAtPerformanceNowMs,
			{ hostCpuContentionDiagnosticsWindow: echoLatencyHostCpuContentionDiagnosticsWindow },
		);

		// 回显到达时洪水若已停止,回显自然很快,这条绊线就空转了。
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			testContext,
			FLOOD_SPINNER_ADVANCES_AFTER_ECHO_TWO_TIER_DEADLINE,
			() =>
				latestFloodSpinnerCounter !== null &&
				floodSpinnerCounterWhenEchoMarkerObserved !== null &&
				latestFloodSpinnerCounter > floodSpinnerCounterWhenEchoMarkerObserved,
			{
				describeLastObservedStateForFailureMessage: () =>
					`回显时 spinner 计数=${String(floodSpinnerCounterWhenEchoMarkerObserved)},最新=${String(latestFloodSpinnerCounter)}`,
			},
		);

		manager.stopTaskSession("task-echo-latency");
	}, 45_000);
});
