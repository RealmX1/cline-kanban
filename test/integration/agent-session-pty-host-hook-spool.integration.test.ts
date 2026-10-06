// 热重启 P3 的 hook spool，真 host 进程（经 tsx 运行源码入口、不 daemonize）+ 真 /bin/sh 会话：
//   - runtime spawn 的 hosted 会话里能读到 host 绑定（socket 路径 + 会话 key）；
//   - runtime 缺席时，会话里的 CLI 凭绑定把 hook 事件存进 host（相邻 activity 合并、生命周期事件逐条保留），
//     会话退出后、退出被确认前，最后一个 Stop 照样能存；
//   - 新 runtime 接管后，先按序把 spool 应用完，再交付缺席期间发生的退出。
//
// socket 放在 /tmp 下的短目录：macOS 的 sun_path 上限 104 字节，os.tmpdir() 太深。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { AgentSessionPtyHostRuntimeFacade } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import {
	appendHookEventToHostedSessionSpoolThroughAgentSessionPtyHost,
	type HostedSessionBindingToAgentSessionPtyHost,
	queryAgentSessionPtyHostControllerPresence,
} from "../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import type { TerminalPtyProcessExitEvent } from "../../src/terminal/terminal-pty-process-handle";
import {
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { hasChildProcessExited } from "./runtime-integration-test-spawned-child-process-lifecycle";

const requireFromHere = createRequire(import.meta.url);

const HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "host 进程（tsx 冷启动）的 socket 开始接受连接",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};
const HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "hosted /bin/sh 会话的输出经 host 到达 runtime",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const HOSTED_SHELL_EXITS_WHILE_RUNTIME_ABSENT_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "runtime 缺席期间 hosted /bin/sh 自行退出、退出记录进 host",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const SPOOL_DRAINED_AND_EXIT_DELIVERED_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "新 runtime 排空 spool 并交付缺席期间的退出",
	softDeadlineMsExpectedOnUncontendedHost: 2_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 15_000,
};
const AGENT_SESSION_PTY_HOST_HOOK_SPOOL_INTEGRATION_TEST_TIMEOUT_MS =
	HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	HOSTED_SHELL_EXITS_WHILE_RUNTIME_ABSENT_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression +
	SPOOL_DRAINED_AND_EXIT_DELIVERED_TWO_TIER_DEADLINE.hardDeadlineMsOnlyExplainedByRealHangOrRegression;

const hostProcessesSigkilledAfterEachTest: ChildProcess[] = [];
const temporaryDirectoriesRemovedAfterEachTest: string[] = [];

afterEach(() => {
	// host 忽略 SIGTERM，只能 SIGKILL；只杀本用例启动时记下的子进程。
	for (const hostProcess of hostProcessesSigkilledAfterEachTest.splice(0)) {
		if (!hasChildProcessExited(hostProcess)) {
			hostProcess.kill("SIGKILL");
		}
	}
	for (const temporaryDirectoryPath of temporaryDirectoriesRemovedAfterEachTest.splice(0)) {
		rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});

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

const HOSTED_SESSION_BINDING_OUTPUT_PATTERN = /binding:([^|\r\n]+)\|([^\r\n]+)\r?\n/;

describe.skipIf(process.platform === "win32")("agent session pty host hook spool", () => {
	it(
		"drains hook events spooled while the runtime was absent, in order, before delivering the exit that happened meanwhile",
		async (testContext) => {
			const runtimeHomeDirectoryPath = mkdtempSync("/tmp/kphs-");
			temporaryDirectoriesRemovedAfterEachTest.push(runtimeHomeDirectoryPath);
			const exitNowMarkerFilePath = join(runtimeHomeDirectoryPath, "exit-now");
			const facadeOptions = {
				runtimeIdentity: { runtimeHomeDirectoryPath, runtimePort: 3998 },
				warn: () => {},
				currentBuildHostDescriptor: {
					hostBuildIdentity: "fedcba9876543210".repeat(4),
					launchCommand: { executablePath: process.execPath, leadingArguments: [] },
				},
				launchHostAndWaitUntilSocketAcceptsConnections: async (launchRequest: {
					socketPath: string;
					hostBuildIdentity: string;
				}) => {
					startHostProcessFromSourceWithoutDaemonizing(launchRequest.socketPath, launchRequest.hostBuildIdentity);
					await waitForConditionWithinLoadSensitiveTwoTierDeadline(
						testContext,
						HOST_SOCKET_ACCEPTS_CONNECTIONS_TWO_TIER_DEADLINE,
						async () => {
							try {
								await (
									await AgentSessionPtyHostControllerConnection.connectAsController(launchRequest.socketPath)
								).closeAfterFlushingPendingFrames();
								return true;
							} catch {
								return false;
							}
						},
						{ pollIntervalMs: 50 },
					);
				},
			};

			const crashedRuntimeFacade = await AgentSessionPtyHostRuntimeFacade.start(facadeOptions);
			const outputSeenByCrashedRuntime: string[] = [];
			await crashedRuntimeFacade
				.createHostedTerminalPtyProcessSpawnerForWorkspace("workspace-1", "/tmp/workspace-1-repository")
				.spawnHostedTerminalPtyProcess({
					taskId: "task-spooling",
					hostedSessionKind: "shell_session",
					binary: "/bin/sh",
					args: [
						"-c",
						[
							'echo "binding:$KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH|$KANBAN_AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY"',
							`while [ ! -f '${exitNowMarkerFilePath}' ]; do sleep 0.05; done`,
							"exit 7",
						].join("; "),
					],
					cwd: "/tmp",
					env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: "/tmp" },
					cols: 80,
					rows: 24,
					onData: (chunk) => outputSeenByCrashedRuntime.push(chunk.toString("utf8")),
					onExit: () => {},
				});
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				HOSTED_SHELL_OUTPUT_ARRIVES_TWO_TIER_DEADLINE,
				() => HOSTED_SESSION_BINDING_OUTPUT_PATTERN.test(outputSeenByCrashedRuntime.join("")),
			);
			const bindingMatch = HOSTED_SESSION_BINDING_OUTPUT_PATTERN.exec(outputSeenByCrashedRuntime.join(""));
			const hostedSessionBinding: HostedSessionBindingToAgentSessionPtyHost = {
				agentSessionPtyHostSocketPath: bindingMatch?.[1] ?? "",
				hostedSessionKey: bindingMatch?.[2] ?? "",
			};
			expect(hostedSessionBinding.agentSessionPtyHostSocketPath).toContain(runtimeHomeDirectoryPath);
			expect(hostedSessionBinding.hostedSessionKey).toMatch(/^[0-9a-f-]{36}$/);

			// runtime 崩溃：之后的 hook 只能存进 host。
			await crashedRuntimeFacade.closeControllerConnectionsAfterFlushingPendingFrames();
			const presenceWhileRuntimeAbsent = await queryAgentSessionPtyHostControllerPresence({
				agentSessionPtyHostSocketPath: hostedSessionBinding.agentSessionPtyHostSocketPath,
				responseDeadlineMilliseconds: 5_000,
			});
			expect(presenceWhileRuntimeAbsent).toMatchObject({ controllerConnected: false });
			const spool = (spooledHookIngestRequest: unknown, coalescible: boolean) =>
				appendHookEventToHostedSessionSpoolThroughAgentSessionPtyHost({
					hostedSessionBinding,
					spooledHookIngestRequest,
					coalescibleWithAdjacentCoalescibleHookSpoolEntry: coalescible,
				});
			expect((await spool({ event: "activity", n: 1 }, true)).kind).toBe("spooled");
			expect((await spool({ event: "activity", n: 2 }, true)).kind).toBe("spooled");
			expect((await spool({ event: "to_review", n: 3 }, false)).kind).toBe("spooled");

			// 会话在 runtime 缺席期间退出；退出确认之前，最后一个 Stop 照样能存。
			writeFileSync(exitNowMarkerFilePath, "");
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				HOSTED_SHELL_EXITS_WHILE_RUNTIME_ABSENT_TWO_TIER_DEADLINE,
				async () => {
					const listingController = await AgentSessionPtyHostControllerConnection.connectAsController(
						hostedSessionBinding.agentSessionPtyHostSocketPath,
					);
					const [listing] = await listingController.requestListHostedSessions();
					await listingController.closeAfterFlushingPendingFrames();
					return listing?.exitRecord != null;
				},
				{ pollIntervalMs: 100 },
			);
			expect((await spool({ event: "to_review", n: "final-stop" }, false)).kind).toBe("spooled");

			const restartedRuntimeFacade = await AgentSessionPtyHostRuntimeFacade.start(facadeOptions);
			const [adoptionCandidate] =
				restartedRuntimeFacade.takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace("workspace-1");
			if (!adoptionCandidate) {
				throw new Error("expected one adoption candidate");
			}
			expect(adoptionCandidate.exitedWhileRuntimeWasAbsent).toBe(true);
			const appliedHookEventsAndExitInOrder: unknown[] = [];
			await adoptionCandidate.adoptHostedTerminalPtyProcess({
				onCatchUpOutput: () => {},
				onData: () => {},
				onExit: (exitEvent: TerminalPtyProcessExitEvent) => {
					appliedHookEventsAndExitInOrder.push({ exitCode: exitEvent.exitCode });
				},
			});
			// 确定性断言：hooks ingest 尚未绑定，spool 还没排空，退出就不能交付。
			expect(appliedHookEventsAndExitInOrder).toEqual([]);

			restartedRuntimeFacade.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
				appliedHookEventsAndExitInOrder.push(spooledHookIngestRequest);
				return { ok: true };
			});
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				SPOOL_DRAINED_AND_EXIT_DELIVERED_TWO_TIER_DEADLINE,
				() => appliedHookEventsAndExitInOrder.length === 4,
			);
			expect(appliedHookEventsAndExitInOrder).toEqual([
				{ event: "activity", n: 2 },
				{ event: "to_review", n: 3 },
				{ event: "to_review", n: "final-stop" },
				{ exitCode: 7 },
			]);

			// 退出已确认：host 里不再有这条会话（spool 随之丢弃），runtime 也不再在它身上排空。
			await restartedRuntimeFacade.closeControllerConnectionsAfterFlushingPendingFrames();
			const verifyingController = await AgentSessionPtyHostControllerConnection.connectAsController(
				hostedSessionBinding.agentSessionPtyHostSocketPath,
			);
			expect(await verifyingController.requestListHostedSessions()).toEqual([]);
			await verifyingController.closeAfterFlushingPendingFrames();
		},
		AGENT_SESSION_PTY_HOST_HOOK_SPOOL_INTEGRATION_TEST_TIMEOUT_MS,
	);
});
