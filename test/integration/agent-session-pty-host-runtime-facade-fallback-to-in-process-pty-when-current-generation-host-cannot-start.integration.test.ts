// 当前 build 的 agent session PTY host 拉不起来时 facade 的降级契约（真 host 经 tsx 运行源码入口、不 daemonize）：
// - 旧 generation 有存活会话：start 不抛、候选照常经旧 generation 链路接管；新 spawn 降级为进程内 PtySession，
//   并在后台再试当前 generation，连上之后的 spawn 恢复进 host；
// - 没有任何旧会话：start 照旧抛出，由调用方整体退回进程内 PTY。
//
// 与 agent-session-pty-host-process.integration.test.ts 分文件：那边的接管用例另有修复在改，避免同文件合并冲突。
// socket 放在 /tmp 下的短目录：macOS 的 sun_path 上限 104 字节，os.tmpdir() 太深。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import type { AgentSessionPtyHostDetachedLaunchRequest } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-detached-process-launcher";
import { AgentSessionPtyHostRuntimeFacade } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import { resolveAgentSessionPtyHostSocketPath } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-socket-path-for-runtime-identity";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "../../src/agent-session-pty-host/runtime-client/hosted-terminal-pty-process-handle-over-agent-session-pty-host";
import { PtySession } from "../../src/terminal/pty-session";
import type { TerminalPtyProcessHandle } from "../../src/terminal/terminal-pty-process-handle";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	hasChildProcessExited,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);

const HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "host 进程（tsx 冷启动）的 socket 开始接受连接",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
const TERMINAL_SESSION_OUTPUT_ARRIVES_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "/bin/sh 会话（hosted 或进程内）的输出到达 runtime 侧回调",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const CURRENT_GENERATION_HOST_RECONNECTED_IN_BACKGROUND_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "降级后 spawn 触发的后台重试拉起当前 generation host（tsx 冷启动）并连上",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
const TERMINAL_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "会话被强制终止后退出事件到达 runtime 侧句柄",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const HOST_PROCESS_EXITS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "host 进程自行退出（排空后退休 / 空闲自退）",
	softDeadlineMsExpectedOnUncontendedHost: 3_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
};
// 用例超时：两次 host 冷启动 + 若干次输出 / 退出等待的硬档之和，闭合外层预算。
const CURRENT_GENERATION_HOST_UNAVAILABLE_FALLBACK_INTEGRATION_TEST_TIMEOUT_MS =
	HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	CURRENT_GENERATION_HOST_RECONNECTED_IN_BACKGROUND_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	TERMINAL_SESSION_OUTPUT_ARRIVES_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 3 +
	TERMINAL_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 3 +
	HOST_PROCESS_EXITS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression * 2;

const HOST_IDLE_EXIT_AFTER_MILLISECONDS_FOR_TEST = 200;
const SIMULATED_CURRENT_GENERATION_HOST_LAUNCH_FAILURE_MESSAGE =
	"simulated: current build agent session pty host bundle is missing";
// generation socket 文件名只认 build identity 前 12 位小写十六进制，两代必须在前 12 位就不同。
const OLDER_GENERATION_HOST_BUILD_IDENTITY = "a".repeat(64);
const CURRENT_GENERATION_HOST_BUILD_IDENTITY = "b".repeat(64);

const hostProcessesSigkilledAfterEachTest: ChildProcess[] = [];
const inProcessTerminalPtyProcessHandlesForceStoppedAfterEachTest: TerminalPtyProcessHandle[] = [];
const temporaryDirectoriesRemovedAfterEachTest: string[] = [];

afterEach(() => {
	// 正常路径里各会话与 host 已自行退出；这里只兜底失败路径，且只动本用例启动时记下的对象。
	for (const inProcessHandle of inProcessTerminalPtyProcessHandlesForceStoppedAfterEachTest.splice(0)) {
		if (!inProcessHandle.hasExited()) {
			inProcessHandle.stop({ force: true });
		}
	}
	// host 忽略 SIGTERM，只能 SIGKILL；host 的 PTY master 随之关闭，hosted 会话收到 SIGHUP 一并结束。
	for (const hostProcess of hostProcessesSigkilledAfterEachTest.splice(0)) {
		if (!hasChildProcessExited(hostProcess)) {
			hostProcess.kill("SIGKILL");
		}
	}
	for (const temporaryDirectoryPath of temporaryDirectoriesRemovedAfterEachTest.splice(0)) {
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});

function createShortRuntimeHomeDirectory(): string {
	const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphf-");
	temporaryDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
	return runtimeHomeDirectoryPath;
}

function startHostProcessFromSourceWithoutDaemonizing(socketPath: string, hostBuildIdentity: string): ChildProcess {
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
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	hostProcessesSigkilledAfterEachTest.push(hostProcess);
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

const ECHOING_SHELL_SCRIPT = 'echo ready; while read line; do echo "got:$line"; done';

describe.skipIf(process.platform === "win32")(
	"agent session pty host runtime facade when the current build's host cannot start",
	() => {
		it(
			"still adopts an older generation's live session, spawns new sessions in-process, and returns to hosted spawns once the current host is reachable",
			async (testContext) => {
				const runtimeIdentity = { runtimeHomeDirectoryPath: createShortRuntimeHomeDirectory(), runtimePort: 3997 };

				// 上一个 runtime（旧 build）留下的 host 与一条存活会话；随后它的 controller 断开（runtime 被重启）。
				const olderGenerationHostProcess = startHostProcessFromSourceWithoutDaemonizing(
					resolveAgentSessionPtyHostSocketPath(runtimeIdentity, OLDER_GENERATION_HOST_BUILD_IDENTITY),
					OLDER_GENERATION_HOST_BUILD_IDENTITY,
				);
				const previousRuntimeController = await connectAsControllerOnceHostAcceptsConnections(
					testContext,
					resolveAgentSessionPtyHostSocketPath(runtimeIdentity, OLDER_GENERATION_HOST_BUILD_IDENTITY),
				);
				const olderGenerationSpawnOutcome = await previousRuntimeController.requestSpawnHostedSession({
					hostedSessionKey: "session-hosted-by-older-generation",
					hostedSessionDescriptor: {
						workspaceId: "workspace-1",
						workspaceRepositoryPath: "/tmp/workspace-1-repository",
						taskId: "task-hosted-by-older-generation",
						hostedSessionKind: "task_agent_session",
					},
					binary: "/bin/sh",
					args: ["-c", ECHOING_SHELL_SCRIPT],
					cwd: "/tmp",
					env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp" },
					terminalName: "xterm-256color",
					cols: 80,
					rows: 24,
				});
				if (olderGenerationSpawnOutcome.kind !== "spawned") {
					throw new Error(`older generation spawn failed: ${olderGenerationSpawnOutcome.errorMessage}`);
				}
				await previousRuntimeController.closeAfterFlushingPendingFrames();

				// 新 runtime（新 build）：当前 generation 的 host 先拉不起来，之后才能拉起。
				const warningMessages: string[] = [];
				let currentGenerationHostLaunchAttemptCount = 0;
				let currentGenerationHostLaunchSucceeds = false;
				const facade = await AgentSessionPtyHostRuntimeFacade.start({
					runtimeIdentity,
					warn: (message) => warningMessages.push(message),
					currentBuildHostDescriptor: {
						hostBuildIdentity: CURRENT_GENERATION_HOST_BUILD_IDENTITY,
						launchCommand: { executablePath: process.execPath, leadingArguments: [] },
					},
					launchHostAndWaitUntilSocketAcceptsConnections: async (
						launchRequest: AgentSessionPtyHostDetachedLaunchRequest,
					) => {
						currentGenerationHostLaunchAttemptCount += 1;
						if (!currentGenerationHostLaunchSucceeds) {
							throw new Error(SIMULATED_CURRENT_GENERATION_HOST_LAUNCH_FAILURE_MESSAGE);
						}
						startHostProcessFromSourceWithoutDaemonizing(
							launchRequest.socketPath,
							launchRequest.hostBuildIdentity,
						);
						await (
							await connectAsControllerOnceHostAcceptsConnections(testContext, launchRequest.socketPath)
						).closeAfterFlushingPendingFrames();
					},
				});

				expect(currentGenerationHostLaunchAttemptCount).toBe(1);
				expect(warningMessages).toHaveLength(1);
				expect(warningMessages[0]).toContain(SIMULATED_CURRENT_GENERATION_HOST_LAUNCH_FAILURE_MESSAGE);
				expect(warningMessages[0]).toContain("fall back to in-process PTY");

				// 接管：经旧 generation 链路收发。
				const [adoptionCandidate] =
					facade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace("workspace-1");
				if (!adoptionCandidate) {
					throw new Error("expected the older generation's session to be offered for adoption");
				}
				expect(adoptionCandidate).toMatchObject({
					taskId: "task-hosted-by-older-generation",
					pid: olderGenerationSpawnOutcome.pid,
					exitedWhileRuntimeWasAbsent: false,
				});
				const adoptedSessionLiveOutputChunks: string[] = [];
				const adoptedHandle = await adoptionCandidate.adoptHostedTerminalPtyProcess({
					onCatchUpOutput: () => {},
					onData: (chunk) => adoptedSessionLiveOutputChunks.push(chunk.toString("utf8")),
					onExit: () => {},
				});
				expect(adoptedHandle.pid).toBe(olderGenerationSpawnOutcome.pid);
				adoptedHandle.write("after-adoption\n");
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					TERMINAL_SESSION_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => adoptedSessionLiveOutputChunks.join("").includes("got:after-adoption"),
				);
				expect(facade.warnAboutHostedSessionsNotAdoptedDuringStartup()).toBe(0);

				// 当前 generation 仍未连上：这一次 spawn 进程内起好，同时在后台重试（这回拉得起来）。
				currentGenerationHostLaunchSucceeds = true;
				const spawnerForWorkspace = facade.createHostedTerminalPtyProcessSpawnerForWorkspace(
					"workspace-1",
					"/tmp/workspace-1-repository",
				);
				const inProcessFallbackOutputChunks: string[] = [];
				const inProcessFallbackHandle = await spawnerForWorkspace.spawnHostedTerminalPtyProcess({
					taskId: "task-spawned-while-current-generation-unreachable",
					hostedSessionKind: "task_agent_session",
					binary: "/bin/sh",
					args: ["-c", ECHOING_SHELL_SCRIPT],
					cwd: "/tmp",
					env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp" },
					cols: 80,
					rows: 24,
					onData: (chunk) => inProcessFallbackOutputChunks.push(chunk.toString("utf8")),
					onExit: () => {},
				});
				inProcessTerminalPtyProcessHandlesForceStoppedAfterEachTest.push(inProcessFallbackHandle);
				expect(inProcessFallbackHandle).toBeInstanceOf(PtySession);
				inProcessFallbackHandle.write("in-process\n");
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					TERMINAL_SESSION_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => inProcessFallbackOutputChunks.join("").includes("got:in-process"),
				);

				// 后台重试连上当前 generation 之后，新 spawn 恢复进 host。
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					CURRENT_GENERATION_HOST_RECONNECTED_IN_BACKGROUND_TWO_TIER_DEADLINE,
					() => warningMessages.some((message) => message.includes("reachable again")),
				);
				expect(currentGenerationHostLaunchAttemptCount).toBe(2);
				const currentGenerationHostProcess = hostProcessesSigkilledAfterEachTest.at(-1);
				if (!currentGenerationHostProcess || currentGenerationHostProcess === olderGenerationHostProcess) {
					throw new Error("expected the background retry to have launched the current generation host");
				}
				const hostedAfterRecoveryOutputChunks: string[] = [];
				const hostedAfterRecoveryHandle = await spawnerForWorkspace.spawnHostedTerminalPtyProcess({
					taskId: "task-spawned-after-current-generation-reachable",
					hostedSessionKind: "task_agent_session",
					binary: "/bin/sh",
					args: ["-c", ECHOING_SHELL_SCRIPT],
					cwd: "/tmp",
					env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp" },
					cols: 80,
					rows: 24,
					onData: (chunk) => hostedAfterRecoveryOutputChunks.push(chunk.toString("utf8")),
					onExit: () => {},
				});
				expect(hostedAfterRecoveryHandle).toBeInstanceOf(HostedTerminalPtyProcessHandleOverAgentSessionPtyHost);
				hostedAfterRecoveryHandle.write("hosted-again\n");
				await waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					TERMINAL_SESSION_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
					() => hostedAfterRecoveryOutputChunks.join("").includes("got:hosted-again"),
				);

				// 收尾：三条会话逐一强停并确认退出；旧 generation 排空后自行退休，当前 generation 在 controller 断开后空闲自退。
				for (const handle of [adoptedHandle, inProcessFallbackHandle, hostedAfterRecoveryHandle]) {
					handle.stop({ force: true });
					await waitForConditionWithinLoadSensitiveTwoTierDeadline(
						testContext,
						TERMINAL_SESSION_EXIT_ARRIVES_TWO_TIER_DEADLINE,
						() => handle.hasExited(),
					);
				}
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					olderGenerationHostProcess,
					HOST_PROCESS_EXITS_TWO_TIER_DEADLINE,
				);
				expect(olderGenerationHostProcess.exitCode).toBe(0);
				await facade.closeControllerConnectionsAfterFlushingPendingFrames();
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(
					testContext,
					currentGenerationHostProcess,
					HOST_PROCESS_EXITS_TWO_TIER_DEADLINE,
				);
				expect(currentGenerationHostProcess.exitCode).toBe(0);
			},
			CURRENT_GENERATION_HOST_UNAVAILABLE_FALLBACK_INTEGRATION_TEST_TIMEOUT_MS,
		);

		it("still rejects start when no older generation has sessions to adopt, so the caller falls back to in-process PTY entirely", async () => {
			const runtimeIdentity = { runtimeHomeDirectoryPath: createShortRuntimeHomeDirectory(), runtimePort: 3997 };
			const warningMessages: string[] = [];
			let currentGenerationHostLaunchAttemptCount = 0;

			await expect(
				AgentSessionPtyHostRuntimeFacade.start({
					runtimeIdentity,
					warn: (message) => warningMessages.push(message),
					currentBuildHostDescriptor: {
						hostBuildIdentity: CURRENT_GENERATION_HOST_BUILD_IDENTITY,
						launchCommand: { executablePath: process.execPath, leadingArguments: [] },
					},
					launchHostAndWaitUntilSocketAcceptsConnections: async () => {
						currentGenerationHostLaunchAttemptCount += 1;
						throw new Error(SIMULATED_CURRENT_GENERATION_HOST_LAUNCH_FAILURE_MESSAGE);
					},
				}),
			).rejects.toThrow(SIMULATED_CURRENT_GENERATION_HOST_LAUNCH_FAILURE_MESSAGE);
			expect(currentGenerationHostLaunchAttemptCount).toBe(1);
			expect(warningMessages).toEqual([]);
		});
	},
);
