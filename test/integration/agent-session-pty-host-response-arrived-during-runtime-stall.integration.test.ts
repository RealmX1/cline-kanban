import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { queryAgentSessionPtyHostControllerPresence } from "../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const socketDirectoriesRemovedAfterEachTest: string[] = [];
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	for (const directory of socketDirectoriesRemovedAfterEachTest.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

// 独立进程在 runtime 的事件循环阻塞期间照常回应，不能用同一事件循环中的 server 代替。
const RESPONSIVE_HOST_CHILD_PROCESS_SOURCE = `
const { createServer } = require("node:net");
const encode = (message) => {
 const payload = Buffer.from(JSON.stringify(message));
 const header = Buffer.alloc(5);
 header.writeUInt32BE(payload.length);
 header[4] = 1;
 return Buffer.concat([header, payload]);
};
const server = createServer((socket) => {
 let buffered = Buffer.alloc(0);
 socket.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 5 && buffered.length >= 5 + buffered.readUInt32BE(0)) {
   const length = buffered.readUInt32BE(0);
   const message = JSON.parse(buffered.subarray(5, 5 + length));
   buffered = buffered.subarray(5 + length);
   if (message.type === "controller_hello") {
    socket.write(encode({type:"host_hello_acknowledged", protocolVersion:1, hostProcessId:process.pid, hostBuildIdentity:"isolated-deadline-host", hostStartedAtEpochMs:1}));
   }
   if (message.requestId) {
    process.send({type:"request_received", requestType:message.type});
    setTimeout(() => {
     const response = message.type === "list_hosted_sessions_request"
      ? {type:"list_hosted_sessions_response", requestId:message.requestId, hostedSessions:[]}
      : {type:"query_controller_presence_response", requestId:message.requestId, controllerConnected:true, controllerAbsentSinceEpochMs:null};
     socket.write(encode(response));
     process.send({type:"response_sent", sentAtEpochMs:Date.now()});
    }, 20);
   }
  }
 });
});
server.listen(process.argv[1], () => process.send({type:"listening"}));
`;

describe.skipIf(process.platform === "win32")("PTY host 已回应而 runtime 暂时阻塞", { timeout: 30_000 }, () => {
	it.for(["controller", "readonly"] as const)(
		"%s 请求恢复后接收已到达的回应，不重发请求",
		async (requestKind, test) => {
			const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kph97-" });
			// canary 隔离 TMPDIR 的路径超过 macOS sun_path 上限，socket 单独使用本用例拥有的短目录。
			const socketDirectoryPath = mkdtempSync("/tmp/kanban-pty-host-runtime-stall-");
			socketDirectoriesRemovedAfterEachTest.push(socketDirectoryPath);
			const socketPath = join(socketDirectoryPath, "host.sock");
			const child = children.register(
				spawn(process.execPath, ["-e", RESPONSIVE_HOST_CHILD_PROCESS_SOURCE, socketPath], {
					env: fixture.createIsolatedChildProcessEnvironment({
						CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "codex"),
						CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "codex-sqlite"),
					}),
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				}),
			);
			let listening = false;
			let childStandardError = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				childStandardError += chunk.toString("utf8");
			});
			let stallCompletedAtEpochMs = 0;
			let responseSentAtEpochMs = 0;
			const receivedRequestTypes: string[] = [];
			child.on("message", (payload: unknown) => {
				const message = payload as { type: string; requestType: string; sentAtEpochMs: number };
				if (message.type === "listening") listening = true;
				if (message.type === "request_received") {
					receivedRequestTypes.push(message.requestType);
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
					stallCompletedAtEpochMs = Date.now();
				}
				if (message.type === "response_sent") responseSentAtEpochMs = message.sentAtEpochMs;
			});
			const waitForEvidence = (condition: () => boolean) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					test,
					{
						waitedForDescription: "隔离 host 开始监听或交付回应证据",
						softDeadlineMsExpectedOnUncontendedHost: 2_000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10_000,
					},
					condition,
					{
						describeLastObservedStateForFailureMessage: () =>
							`childExitCode=${child.exitCode}; socketPath=${socketPath}; stderr=${childStandardError}`,
					},
				);
			await waitForEvidence(() => listening);
			let connection: AgentSessionPtyHostControllerConnection | undefined;
			try {
				if (requestKind === "controller") {
					connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
					expect(await connection.requestListHostedSessions(1_000)).toEqual([]);
				} else {
					expect(
						await queryAgentSessionPtyHostControllerPresence({
							agentSessionPtyHostSocketPath: socketPath,
							responseDeadlineMilliseconds: 1_000,
						}),
					).toEqual({ controllerConnected: true, controllerAbsentSinceEpochMs: null });
				}
				await waitForEvidence(() => responseSentAtEpochMs !== 0);
				expect(responseSentAtEpochMs).toBeLessThan(stallCompletedAtEpochMs);
				expect(receivedRequestTypes).toEqual([
					requestKind === "controller" ? "list_hosted_sessions_request" : "query_controller_presence_request",
				]);
			} finally {
				await connection?.closeAfterFlushingPendingFrames();
			}
		},
	);
});
