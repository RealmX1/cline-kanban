// agent session PTY host 进程级集成测试：真 host（经 tsx 运行源码入口、不 daemonize）+ 真 /bin/sh 会话。
//
// 覆盖本阶段的契约：spawn / 输出带连续绝对偏移 / 输入可达 / controller 断开后会话存活且输出继续进环形缓冲 /
// 新 controller 顶替旧 controller / 退出记录保留到确认 / 空闲自退 / 忽略 SIGTERM / 显式全停。
//
// socket 放在 /tmp 下的短目录：macOS 的 sun_path 上限 104 字节，os.tmpdir() 太深。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostRuntimeFacade } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import { resolveAgentSessionPtyHostSocketPath } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import { queryAgentSessionPtyHostReadOnlyStatus } from "../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import type { AgentSessionPtyHostHostedSessionExitRecord } from "../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import {
	bindTestPtyLifetimeToChildEnvironment,
	createIsolatedTestOwnedPtyHostLifetime,
} from "../utilities/isolated-test-owned-pty-host-lifetime";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	hasChildProcessExited,
	waitForChildProcessExit,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);

const HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "host 进程（tsx 冷启动）的 socket 开始接受连接",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
const HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "hosted /bin/sh 会话的输出经 host 到达 controller",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "hosted 会话被终止后退出记录到达 controller",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const HOST_PROCESS_EXITS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "host 完成 5s 进程组升级窗口后自行退出（空闲自退 / 显式全停）",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
// 用例超时：一次 host 冷启动 + 若干次输出 / 退出等待的硬档之和，闭合外层预算。
const AGENT_SESSION_PTY_HOST_INTEGRATION_TEST_TIMEOUT_MS =
	HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 2 +
	HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 3 +
	HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	HOST_PROCESS_EXITS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression;

const HOST_IDLE_EXIT_AFTER_MILLISECONDS_FOR_TEST = 200;

// host 的追赶重放按 64 KiB 切帧（registry 的 CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH）。
const HOST_CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH = 64 * 1024;
// runtime 缺席期间产出的行：每行 "while-runtime-absent-NNNN-<60 个 x>" 加 PTY 的 \r\n 共 88 字节，
// 1000 行约 86 KiB，超过一帧，接管时的追赶必然分多帧、多次 write 到达。
const LINE_COUNT_PRODUCED_WHILE_RUNTIME_ABSENT = 1_000;
const LINE_PADDING_PRODUCED_WHILE_RUNTIME_ABSENT = "x".repeat(60);
const BYTE_LENGTH_OF_EACH_LINE_PRODUCED_WHILE_RUNTIME_ABSENT =
	"while-runtime-absent-0000-".length + LINE_PADDING_PRODUCED_WHILE_RUNTIME_ABSENT.length + "\r\n".length;

const hostProcessesConfirmedExitedAfterEachTest: ChildProcess[] = [];
const testOwnedHostLifetimesClosedAfterEachTest: ReturnType<typeof createIsolatedTestOwnedPtyHostLifetime>[] = [];
const controllerConnectionsClosedAfterEachTest = new Set<AgentSessionPtyHostControllerConnection>();
// facade 自己的 controller 不在上面的集合里。先断开，回收端才能发出无 controller 全停。
const runtimeFacadesClosedAfterEachTest: AgentSessionPtyHostRuntimeFacade[] = [];
const shellPidsThatMustExitAfterFacadeControllerRelease: number[] = [];
const temporaryDirectoriesRemovedAfterEachTest: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const facade of runtimeFacadesClosedAfterEachTest.splice(0))
		await facade.closeControllerConnectionsAfterFlushingPendingFrames();
	for (const controller of controllerConnectionsClosedAfterEachTest)
		await controller.closeAfterFlushingPendingFrames();
	controllerConnectionsClosedAfterEachTest.clear();
	for (const lifetime of testOwnedHostLifetimesClosedAfterEachTest.splice(0)) lifetime.closeAndVerifyOwnedHostExit();
	for (const hostProcess of hostProcessesConfirmedExitedAfterEachTest.splice(0)) {
		expect(await waitForChildProcessExit(hostProcess, 5_000)).toBe(true);
	}
	for (const shellPid of shellPidsThatMustExitAfterFacadeControllerRelease.splice(0)) {
		expect(isProcessAlive(shellPid)).toBe(false);
	}
	for (const temporaryDirectoryPath of temporaryDirectoriesRemovedAfterEachTest.splice(0)) {
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});

function createShortRuntimeHomeDirectory(): string {
	const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphi-");
	temporaryDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
	return runtimeHomeDirectoryPath;
}

function startHostProcessFromSourceWithoutDaemonizing(socketPath: string, hostBuildIdentity: string): ChildProcess {
	const lifetime = createIsolatedTestOwnedPtyHostLifetime(dirname(socketPath));
	testOwnedHostLifetimesClosedAfterEachTest.push(lifetime);
	const hostProcess = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(requireFromHere.resolve("tsx")).href,
			resolve(process.cwd(), "src/agent-session-pty-host/host-process/agent-session-pty-host-process-entry.ts"),
			"--socket-path",
			socketPath,
			"--host-build-identity",
			hostBuildIdentity,
			"--idle-exit-after-ms",
			String(HOST_IDLE_EXIT_AFTER_MILLISECONDS_FOR_TEST),
		],
		{
			cwd: process.cwd(),
			env: bindTestPtyLifetimeToChildEnvironment({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp" }, lifetime),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	hostProcessesConfirmedExitedAfterEachTest.push(hostProcess);
	return hostProcess;
}

async function connectAsControllerOnceHostAcceptsConnections(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	socketPath: string,
): Promise<AgentSessionPtyHostControllerConnection> {
	let connection: AgentSessionPtyHostControllerConnection | null = null;
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE,
		async () => {
			try {
				connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
				controllerConnectionsClosedAfterEachTest.add(connection);
				return true;
			} catch {
				return false;
			}
		},
		{ pollIntervalMs: 50 },
	);
	if (connection === null) {
		throw new Error("unreachable: controller connection was not established");
	}
	return connection;
}

interface RecordedControllerEvents {
	outputTextByChannelNumber: Map<number, string>;
	outputFramesByChannelNumber: Map<number, Array<{ startByteOffset: number; byteLength: number }>>;
	exitRecordsByHostedSessionKey: Map<string, AgentSessionPtyHostHostedSessionExitRecord>;
	connectionCloseReasons: string[];
}

function recordControllerEvents(connection: AgentSessionPtyHostControllerConnection): RecordedControllerEvents {
	const recorded: RecordedControllerEvents = {
		outputTextByChannelNumber: new Map(),
		outputFramesByChannelNumber: new Map(),
		exitRecordsByHostedSessionKey: new Map(),
		connectionCloseReasons: [],
	};
	connection.setEventHandlers({
		onHostedSessionOutput: (channelNumber, startByteOffset, bytes) => {
			recorded.outputTextByChannelNumber.set(
				channelNumber,
				(recorded.outputTextByChannelNumber.get(channelNumber) ?? "") + bytes.toString("utf8"),
			);
			const frames = recorded.outputFramesByChannelNumber.get(channelNumber) ?? [];
			frames.push({ startByteOffset, byteLength: bytes.byteLength });
			recorded.outputFramesByChannelNumber.set(channelNumber, frames);
		},
		onHostedSessionExited: (hostedSessionKey, exitRecord) => {
			recorded.exitRecordsByHostedSessionKey.set(hostedSessionKey, exitRecord);
		},
		onConnectionClosed: (closeReason) => {
			recorded.connectionCloseReasons.push(closeReason);
		},
	});
	return recorded;
}

async function spawnHostedShellSession(
	connection: AgentSessionPtyHostControllerConnection,
	hostedSessionKey: string,
	shellScript: string,
): Promise<{ hostedSessionChannelNumber: number; pid: number }> {
	const outcome = await connection.requestSpawnHostedSession({
		hostedSessionKey,
		hostedSessionDescriptor: {
			workspaceId: "workspace-1",
			taskId: hostedSessionKey,
			hostedSessionKind: "shell_session",
		},
		binary: "/bin/sh",
		args: ["-c", shellScript],
		cwd: "/tmp",
		env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp" },
		terminalName: "xterm-256color",
		cols: 80,
		rows: 24,
	});
	if (outcome.kind !== "spawned") {
		throw new Error(`hosted shell spawn failed: ${outcome.errorMessage}`);
	}
	return { hostedSessionChannelNumber: outcome.hostedSessionChannelNumber, pid: outcome.pid };
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")(
	"agent session pty host process",
	{ timeout: AGENT_SESSION_PTY_HOST_INTEGRATION_TEST_TIMEOUT_MS },
	() => {
		it("真 hosted PTY 保留高位鼠标坐标和拆分的中文输入字节", async (testContext) => {
			const socketPath = join(createShortRuntimeHomeDirectory(), "host.sock");
			startHostProcessFromSourceWithoutDaemonizing(socketPath, "binary-input-integration-test-build");
			const controller = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
			const events = recordControllerEvents(controller);
			const hostedSessionKey = "binary-terminal-input-session";
			try {
				const { hostedSessionChannelNumber } = await spawnHostedShellSession(
					controller,
					hostedSessionKey,
					"stty raw -echo; echo ready; od -An -tx1 -N 12",
				);
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => (events.outputTextByChannelNumber.get(hostedSessionChannelNumber) ?? "").includes("ready"),
				);
				const mouseReport = Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0xcb, 0x2d]);
				const chineseInput = Buffer.from("中文", "utf8");
				for (const chunk of [mouseReport, chineseInput.subarray(0, 1), chineseInput.subarray(1)]) {
					controller.sendHostedSessionInputBytes(hostedSessionChannelNumber, chunk);
				}
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE,
					() => events.exitRecordsByHostedSessionKey.has(hostedSessionKey),
				);

				expect(events.exitRecordsByHostedSessionKey.get(hostedSessionKey)?.exitCode).toBe(0);
				expect(
					(events.outputTextByChannelNumber.get(hostedSessionChannelNumber) ?? "").replace(/\s/g, ""),
				).toContain(Buffer.concat([mouseReport, chineseInput]).toString("hex"));
			} finally {
				controller.sendControlMessage({ type: "stop_hosted_session", hostedSessionKey, force: true });
				await controller.closeAfterFlushingPendingFrames();
			}
		}, 80000);

		it(
			"keeps a hosted shell alive across controller disconnects, streams contiguous offsets, and retains its exit until acknowledged",
			async (testContext) => {
				const socketPath = join(createShortRuntimeHomeDirectory(), "host.sock");
				const hostProcess = startHostProcessFromSourceWithoutDaemonizing(socketPath, "integration-test-build");
				const firstController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				const firstControllerEvents = recordControllerEvents(firstController);
				const { hostedSessionChannelNumber, pid } = await spawnHostedShellSession(
					firstController,
					"session-a",
					'echo ready; while read line; do echo "got:$line"; done',
				);
				const diagnosticsBefore = await queryAgentSessionPtyHostReadOnlyStatus({
					agentSessionPtyHostSocketPath: socketPath,
				});
				const diagnosticsAfter = await queryAgentSessionPtyHostReadOnlyStatus({
					agentSessionPtyHostSocketPath: socketPath,
				});
				expect(diagnosticsBefore).toMatchObject({
					hostProcessId: hostProcess.pid,
					controllerProcessId: process.pid,
					hostedSessions: [{ hostedSessionKey: "session-a", processId: pid, exited: false }],
				});
				expect(diagnosticsAfter).toMatchObject({
					hostProcessInstanceId:
						"hostProcessInstanceId" in diagnosticsBefore ? diagnosticsBefore.hostProcessInstanceId : null,
				});
				expect(firstController.isClosed).toBe(false);
				expect(firstControllerEvents.connectionCloseReasons).toEqual([]);

				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() =>
						(firstControllerEvents.outputTextByChannelNumber.get(hostedSessionChannelNumber) ?? "").includes(
							"ready",
						),
				);
				firstController.sendHostedSessionInputBytes(hostedSessionChannelNumber, Buffer.from("hello\n", "utf8"));
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() =>
						(firstControllerEvents.outputTextByChannelNumber.get(hostedSessionChannelNumber) ?? "").includes(
							"got:hello",
						),
				);
				const firstControllerFrames =
					firstControllerEvents.outputFramesByChannelNumber.get(hostedSessionChannelNumber) ?? [];
				let expectedNextStartByteOffset = 0;
				for (const frame of firstControllerFrames) {
					expect(frame.startByteOffset).toBe(expectedNextStartByteOffset);
					expectedNextStartByteOffset += frame.byteLength;
				}

				await firstController.closeAfterFlushingPendingFrames();
				const secondController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				const secondControllerEvents = recordControllerEvents(secondController);
				const hostedSessionsSeenBySecondController = await secondController.requestListHostedSessions();

				expect(hostedSessionsSeenBySecondController).toHaveLength(1);
				expect(hostedSessionsSeenBySecondController[0]).toMatchObject({
					hostedSessionKey: "session-a",
					pid,
					exitRecord: null,
				});
				expect(hostedSessionsSeenBySecondController[0]?.outputEndByteOffset).toBeGreaterThanOrEqual(
					expectedNextStartByteOffset,
				);
				expect(isProcessAlive(pid)).toBe(true);

				secondController.sendControlMessage({
					type: "stop_hosted_session",
					hostedSessionKey: "session-a",
					force: false,
				});
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE,
					() => secondControllerEvents.exitRecordsByHostedSessionKey.has("session-a"),
				);
				const hostedSessionsBeforeAcknowledgement = await secondController.requestListHostedSessions();
				expect(hostedSessionsBeforeAcknowledgement[0]?.exitRecord).not.toBeNull();
				secondController.sendControlMessage({
					type: "acknowledge_hosted_session_exit",
					hostedSessionKey: "session-a",
				});
				expect(await secondController.requestListHostedSessions()).toEqual([]);

				await secondController.closeAfterFlushingPendingFrames();
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					hostProcess,
					HOST_PROCESS_EXITS_TWO_TIER_DEADLINE,
				);
				expect(hostProcess.exitCode).toBe(0);
			},
			AGENT_SESSION_PTY_HOST_INTEGRATION_TEST_TIMEOUT_MS,
		);

		it(
			"supersedes the previous controller, ignores SIGTERM, and ends every session on an explicit terminate-all",
			async (testContext) => {
				const socketPath = join(createShortRuntimeHomeDirectory(), "host.sock");
				const hostProcess = startHostProcessFromSourceWithoutDaemonizing(socketPath, "integration-test-build");
				const firstController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				const firstControllerEvents = recordControllerEvents(firstController);
				const { pid } = await spawnHostedShellSession(firstController, "session-b", "sleep 600");

				const secondController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => firstControllerEvents.connectionCloseReasons.length > 0,
				);
				expect(firstControllerEvents.connectionCloseReasons).toEqual(["controller_superseded"]);

				hostProcess.kill("SIGTERM");
				// 确定性断言：SIGTERM 之后 host 仍能应答请求、会话仍是同一个进程。
				const hostedSessionsAfterSigterm = await secondController.requestListHostedSessions();
				expect(hostedSessionsAfterSigterm).toMatchObject([
					{ hostedSessionKey: "session-b", pid, exitRecord: null },
				]);
				expect(hasChildProcessExited(hostProcess)).toBe(false);

				secondController.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					hostProcess,
					HOST_PROCESS_EXITS_TWO_TIER_DEADLINE,
				);
				expect(hostProcess.exitCode).toBe(0);
				expect(isProcessAlive(pid)).toBe(false);
			},
			AGENT_SESSION_PTY_HOST_INTEGRATION_TEST_TIMEOUT_MS,
		);

		it("真实 hosted shell 换代先确认原进程退出，新会话仍能接收输入和输出", async (testContext) => {
			const runtimeHomeDirectoryPath = createShortRuntimeHomeDirectory();
			const facade = await AgentSessionPtyHostRuntimeFacade.start({
				runtimeIdentity: { runtimeHomeDirectoryPath, runtimePort: 3999 },
				warn: () => {},
				currentBuildHostDescriptor: {
					hostBuildIdentity: "shell-replacement-integration-test-build",
					launchCommand: { executablePath: process.execPath, leadingArguments: [] },
				},
				launchHostAndWaitUntilSocketAcceptsConnections: async (request) => {
					startHostProcessFromSourceWithoutDaemonizing(request.socketPath, request.hostBuildIdentity);
					await (
						await connectAsControllerOnceHostAcceptsConnections(testContext, request.socketPath)
					).closeAfterFlushingPendingFrames();
				},
			});
			runtimeFacadesClosedAfterEachTest.push(facade);
			const manager = new TerminalSessionManager({
				hostedTerminalPtyProcessSpawner: facade.createHostedTerminalPtyProcessSpawnerForWorkspace(
					"replacement-workspace",
					"/tmp/replacement-workspace-repository",
				),
			});
			const outputChunks: Buffer[] = [];
			manager.attach("replacement-shell", { onOutput: (chunk) => outputChunks.push(chunk) });
			const request = {
				taskId: "replacement-shell",
				cwd: "/tmp",
				binary: "/bin/sh",
				args: ["-c", 'stty -echo; echo ready; while read line; do echo "got:$line"; done'],
				env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
			};
			try {
				const original = await manager.startShellSession(request);
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => Buffer.concat(outputChunks).toString("utf8").includes("ready"),
				);
				manager.transitionToReview(request.taskId, "manual_review");
				const replacement = await manager.startShellSession(request);
				if (typeof original.pid !== "number") throw new Error("原会话缺少进程 PID");
				expect(replacement.pid).not.toBe(original.pid);
				expect(isProcessAlive(original.pid)).toBe(false);
				manager.writeInput(request.taskId, Buffer.from("replacement-input\n"));
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => Buffer.concat(outputChunks).toString("utf8").includes("got:replacement-input"),
				);
				const [ownership] = manager.listLivePtySessionProcessOwnership();
				expect(ownership).toMatchObject({ ownership: "independent_host", processId: replacement.pid });
				if (!ownership?.hostSocketPath) throw new Error("新会话缺少 host socket 归属");
				const diagnostics = await queryAgentSessionPtyHostReadOnlyStatus({
					agentSessionPtyHostSocketPath: ownership.hostSocketPath,
				});
				if (!("hostedSessions" in diagnostics)) throw new Error("未取得 host 只读会话状态");
				expect(diagnostics.hostedSessions.filter((session) => !session.exited)).toMatchObject([
					{ processId: replacement.pid, conversationSessionId: request.taskId },
				]);
			} finally {
				manager.dispose();
				await facade.closeControllerConnectionsAfterFlushingPendingFrames();
			}
		});

		it.for([true, false])(
			"新会话托管=%s：runtime 重启后接回原 PTY，会话关闭偏好也不丢失存量",
			async (newHostedSessionsEnabled, testContext) => {
				const runtimeHomeDirectoryPath = createShortRuntimeHomeDirectory();
				const runtimeIdentity = { runtimeHomeDirectoryPath, runtimePort: 3999 };
				const hostBuildIdentity = "0123456789abcdef".repeat(4);
				const launchedHostProcesses: ChildProcess[] = [];
				const facadeOptions = {
					runtimeIdentity,
					warn: () => {},
					currentBuildHostDescriptor: {
						hostBuildIdentity,
						launchCommand: { executablePath: process.execPath, leadingArguments: [] },
					},
					launchHostAndWaitUntilSocketAcceptsConnections: async (launchRequest: {
						socketPath: string;
						hostBuildIdentity: string;
					}) => {
						launchedHostProcesses.push(
							startHostProcessFromSourceWithoutDaemonizing(
								launchRequest.socketPath,
								launchRequest.hostBuildIdentity,
							),
						);
						await (
							await connectAsControllerOnceHostAcceptsConnections(testContext, launchRequest.socketPath)
						).closeAfterFlushingPendingFrames();
					},
				};
				const crashedRuntimeFacade = await AgentSessionPtyHostRuntimeFacade.start(facadeOptions);
				runtimeFacadesClosedAfterEachTest.push(crashedRuntimeFacade);
				const originalSpawnRequest = AgentSessionPtyHostControllerConnection.prototype.requestSpawnHostedSession;
				vi.spyOn(
					AgentSessionPtyHostControllerConnection.prototype,
					"requestSpawnHostedSession",
				).mockImplementationOnce(async function (this: AgentSessionPtyHostControllerConnection, request) {
					await originalSpawnRequest.call(this, request);
					throw new Error("隔离复现：host 已创建会话但 runtime 丢失回执");
				});
				const outputSeenByCrashedRuntime: string[] = [];
				const handleOfCrashedRuntime = await crashedRuntimeFacade
					.createHostedTerminalPtyProcessSpawnerForWorkspace("workspace-1", "/tmp/workspace-1-repository")
					.spawnHostedTerminalPtyProcess({
						taskId: "task-adopted",
						hostedSessionKind: "shell_session",
						binary: "/bin/sh",
						args: [
							"-c",
							[
								"echo before-restart",
								"read go",
								"i=0",
								`while [ "$i" -lt ${LINE_COUNT_PRODUCED_WHILE_RUNTIME_ABSENT} ]; do printf 'while-runtime-absent-%04d-${LINE_PADDING_PRODUCED_WHILE_RUNTIME_ABSENT}\\n' "$i"; i=$((i+1)); done`,
								"echo while-runtime-absent-done",
								'while read line; do echo "got:$line"; done',
							].join("; "),
						],
						cwd: "/tmp",
						env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp", UNSET_VARIABLE: undefined },
						cols: 80,
						rows: 24,
						onData: (chunk) => outputSeenByCrashedRuntime.push(chunk.toString("utf8")),
						onExit: () => {},
					});
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => outputSeenByCrashedRuntime.join("").includes("before-restart"),
				);
				handleOfCrashedRuntime.publishTerminalSessionAdoptionRecordForRuntimeRestart?.({
					adoptionRecordMarker: "kept-by-host",
				});
				// 「go」写出后立刻断开：shell 在没有 controller 的窗口里产出大段 while-runtime-absent，只能进 host 的环形缓冲。
				handleOfCrashedRuntime.write("go\n");
				const outputByteLengthBeforeAdoption =
					"before-restart\r\n".length +
					"go\r\n".length +
					LINE_COUNT_PRODUCED_WHILE_RUNTIME_ABSENT * BYTE_LENGTH_OF_EACH_LINE_PRODUCED_WHILE_RUNTIME_ABSENT +
					"while-runtime-absent-done\r\n".length;
				await crashedRuntimeFacade.closeControllerConnectionsAfterFlushingPendingFrames();

				const restartedRuntimeFacade = await AgentSessionPtyHostRuntimeFacade.start({
					...facadeOptions,
					newHostedSessionsEnabled,
				});
				runtimeFacadesClosedAfterEachTest.push(restartedRuntimeFacade);
				expect((await restartedRuntimeFacade.queryDiagnostics()).newSessionHostingMode).toBe(
					newHostedSessionsEnabled ? "independent_host" : "disabled",
				);
				expect(launchedHostProcesses).toHaveLength(1);
				const [adoptionCandidate] =
					restartedRuntimeFacade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace("workspace-1");
				expect(restartedRuntimeFacade.listHostedTerminalPtySessionAdoptionCandidatesByWorkspace()).toMatchObject([
					{ workspaceId: "workspace-1", workspaceRepositoryPath: "/tmp/workspace-1-repository" },
				]);
				if (!adoptionCandidate) {
					throw new Error("expected one adoption candidate");
				}
				expect(adoptionCandidate).toMatchObject({
					taskId: "task-adopted",
					hostedSessionKind: "shell_session",
					pid: handleOfCrashedRuntime.pid,
					terminalSessionAdoptionRecord: { adoptionRecordMarker: "kept-by-host" },
				});

				const catchUpOutputChunks: string[] = [];
				const liveOutputChunks: string[] = [];
				// 确保缺席期间的全部输出（到 while-runtime-absent-done 为止）已经进了环形缓冲，再接管
				// （否则它会作为实时输出到达，测不到追赶路径）。
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					async () => {
						const status = await queryAgentSessionPtyHostReadOnlyStatus({
							agentSessionPtyHostSocketPath: resolveAgentSessionPtyHostSocketPath(
								runtimeIdentity,
								hostBuildIdentity,
							),
						});
						return (
							"hostedSessions" in status &&
							(status.hostedSessions[0]?.outputEndByteOffset ?? 0) >= outputByteLengthBeforeAdoption
						);
					},
					{ pollIntervalMs: 100 },
				);
				const freshAdoptionCandidate = adoptionCandidate;
				const adoptedHandle = await freshAdoptionCandidate.adoptHostedTerminalPtyProcess({
					onCatchUpOutput: (bytes) => catchUpOutputChunks.push(bytes.toString("utf8")),
					onData: (chunk) => liveOutputChunks.push(chunk.toString("utf8")),
					onExit: () => {},
				});

				// 确定性断言：adopt 只在追赶区间全部交付之后返回。此刻 shell 正阻塞在 read，实时输出一个字节也不该有。
				expect(adoptedHandle.pid).toBe(handleOfCrashedRuntime.pid);
				const catchUpOutputText = catchUpOutputChunks.join("");
				expect(catchUpOutputChunks.length).toBeGreaterThanOrEqual(2);
				expect(catchUpOutputText.length).toBeGreaterThan(HOST_CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH);
				expect(catchUpOutputText).toContain("before-restart");
				expect(catchUpOutputText.match(/while-runtime-absent-\d{4}-x{60}\r\n/g)).toHaveLength(
					LINE_COUNT_PRODUCED_WHILE_RUNTIME_ABSENT,
				);
				expect(catchUpOutputText).toContain("while-runtime-absent-done");
				expect(liveOutputChunks).toEqual([]);
				adoptedHandle.write("after-adoption\n");
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => liveOutputChunks.join("").includes("got:after-adoption"),
				);
				expect(liveOutputChunks.join("")).not.toContain("while-runtime-absent");
				expect(catchUpOutputChunks.join("")).toBe(catchUpOutputText);

				adoptedHandle.stop({ force: true });
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE,
					() => adoptedHandle.hasExited(),
				);
				expect(isProcessAlive(handleOfCrashedRuntime.pid)).toBe(false);
				await restartedRuntimeFacade.closeControllerConnectionsAfterFlushingPendingFrames();
				await restartedRuntimeFacade.closeControllerConnectionsAfterFlushingPendingFrames();
			},
		);

		it(
			"reclaims a session past its reclamation deadline only while no runtime is connected, and records why it exited",
			async (testContext) => {
				const socketPath = join(createShortRuntimeHomeDirectory(), "host.sock");
				const hostProcess = startHostProcessFromSourceWithoutDaemonizing(socketPath, "integration-test-build");
				const detachingController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				recordControllerEvents(detachingController);
				const { pid: pidPastDeadline } = await spawnHostedShellSession(
					detachingController,
					"session-past-deadline",
					"sleep 600",
				);
				const { pid: pidInAgentTurn } = await spawnHostedShellSession(
					detachingController,
					"session-in-agent-turn",
					"sleep 600",
				);
				// detach 时推的最终记录：一条期限已过，一条在 agent 回合中（null，绝不回收）。
				detachingController.sendControlMessage({
					type: "put_hosted_session_adoption_record",
					hostedSessionKey: "session-past-deadline",
					adoptionRecord: { recordedBy: "detaching runtime" },
					hostedSessionOrphanReclamationEligibleAtEpochMs: Date.now() - 1_000,
				});
				detachingController.sendControlMessage({
					type: "put_hosted_session_adoption_record",
					hostedSessionKey: "session-in-agent-turn",
					adoptionRecord: { recordedBy: "detaching runtime" },
					hostedSessionOrphanReclamationEligibleAtEpochMs: null,
				});
				// controller 在线时 host 不插手回收（期限归 runtime 自己的调度器）。
				expect(await detachingController.requestListHostedSessions()).toMatchObject([
					{ hostedSessionKey: "session-past-deadline", exitRecord: null },
					{ hostedSessionKey: "session-in-agent-turn", exitRecord: null },
				]);
				expect(isProcessAlive(pidPastDeadline)).toBe(true);

				await detachingController.closeAfterFlushingPendingFrames();
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					HOSTED_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE,
					() => !isProcessAlive(pidPastDeadline),
				);
				expect(isProcessAlive(pidInAgentTurn)).toBe(true);

				const returningController = await connectAsControllerOnceHostAcceptsConnections(testContext, socketPath);
				recordControllerEvents(returningController);
				const hostedSessionsSeenByReturningRuntime = await returningController.requestListHostedSessions();
				expect(
					hostedSessionsSeenByReturningRuntime.find(
						(listing) => listing.hostedSessionKey === "session-past-deadline",
					)?.exitRecord,
				).toMatchObject({ hostedSessionTerminatedByHostReason: "reclaimed_by_host_while_runtime_absent" });
				expect(
					hostedSessionsSeenByReturningRuntime.find(
						(listing) => listing.hostedSessionKey === "session-in-agent-turn",
					)?.exitRecord,
				).toBeNull();

				returningController.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					hostProcess,
					HOST_PROCESS_EXITS_TWO_TIER_DEADLINE,
				);
				expect(isProcessAlive(pidInAgentTurn)).toBe(false);
			},
			AGENT_SESSION_PTY_HOST_INTEGRATION_TEST_TIMEOUT_MS,
		);

		it("用例体内未关闭的 runtime facade 仍由 afterEach 先释放 controller，再回收仍在运行的 shell", async (testContext) => {
			const runtimeHomeDirectoryPath = createShortRuntimeHomeDirectory();
			const runtimeIdentity = { runtimeHomeDirectoryPath, runtimePort: 3997 };
			const hostBuildIdentity = "facade-aftereach-reclamation";
			const facade = await AgentSessionPtyHostRuntimeFacade.start({
				runtimeIdentity,
				warn: () => {},
				currentBuildHostDescriptor: {
					hostBuildIdentity,
					launchCommand: { executablePath: process.execPath, leadingArguments: [] },
				},
				launchHostAndWaitUntilSocketAcceptsConnections: async (request) => {
					startHostProcessFromSourceWithoutDaemonizing(request.socketPath, request.hostBuildIdentity);
					await (
						await connectAsControllerOnceHostAcceptsConnections(testContext, request.socketPath)
					).closeAfterFlushingPendingFrames();
				},
			});
			runtimeFacadesClosedAfterEachTest.push(facade);
			const handle = await facade
				.createHostedTerminalPtyProcessSpawnerForWorkspace(
					"facade-reclamation-workspace",
					"/tmp/facade-reclamation",
				)
				.spawnHostedTerminalPtyProcess({
					taskId: "facade-reclamation-shell",
					hostedSessionKind: "shell_session",
					binary: "/bin/sh",
					args: ["-c", "sleep 600"],
					cwd: "/tmp",
					env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
					cols: 80,
					rows: 24,
					onData: () => {},
					onExit: () => {},
				});
			const diagnostics = await queryAgentSessionPtyHostReadOnlyStatus({
				agentSessionPtyHostSocketPath: resolveAgentSessionPtyHostSocketPath(runtimeIdentity, hostBuildIdentity),
			});
			if (!("controllerProcessId" in diagnostics)) throw new Error("未取得 host 只读状态");
			expect(diagnostics.controllerProcessId).not.toBeNull();
			expect(isProcessAlive(handle.pid)).toBe(true);
			shellPidsThatMustExitAfterFacadeControllerRelease.push(handle.pid);
		});
	},
);
