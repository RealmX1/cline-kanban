import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回显延迟回归绊线(真 PTY,非 mock):spinner 高频重绘 + 周期大段输出的洪水场景下,
// 键盘输入的 PTY 回显必须在宽松阈值内回到 listener——历史病灶是每-chunk 输出分析同步占满
// 事件循环、ack 背压暂停 PTY、巨帧解析,合起来把回显拖到秒级(低负载 TUI 输入卡顿)。
// 本测试是「多秒级冻结」的绊线,不是精确基准(阈值取 2s,抗 CI 抖动)。
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
const ECHO_DEADLINE_MS = 2_000;
const FLOOD_WARMUP_MS = 800;

// 洪水脚本:每 5ms 重绘一条含 `esc to interrupt` 的 spinner 状态行,每 50ms 追加一段 8KB
// 大块输出;8 秒后自杀兜底(防 CI 挂进程)。不改 termios,PTY 行规的内核 echo 保持开启——
// 测试写入的 marker 由内核回显进输出流,无需脚本配合。
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
}, 8000);
process.stdin.resume();
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

	it("delivers the keystroke echo within the tripwire deadline while the agent floods output", async () => {
		const floodScriptPath = join(workDir, "flood-spinner-output.cjs");
		writeFileSync(floodScriptPath, FLOOD_SCRIPT_SOURCE, "utf8");

		let receivedOutputText = "";
		manager.attach("task-echo-latency", {
			onOutput: (chunk) => {
				receivedOutputText += chunk.toString("utf8");
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
		await new Promise((resolve) => setTimeout(resolve, FLOOD_WARMUP_MS));
		expect(receivedOutputText).toContain("esc to interrupt");

		const markerWrittenAt = Date.now();
		manager.writeInput("task-echo-latency", Buffer.from(ECHO_MARKER, "utf8"));

		let echoLatencyMs: number | null = null;
		while (Date.now() - markerWrittenAt < ECHO_DEADLINE_MS) {
			if (receivedOutputText.includes(ECHO_MARKER)) {
				echoLatencyMs = Date.now() - markerWrittenAt;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(echoLatencyMs, `echo not observed within ${ECHO_DEADLINE_MS}ms under flood output`).not.toBeNull();

		manager.stopTaskSession("task-echo-latency");
	}, 15_000);
});
