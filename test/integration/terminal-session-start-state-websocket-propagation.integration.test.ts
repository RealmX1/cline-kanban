import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../../src/core/api-contract";
import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../src/core/runtime-endpoint";
import type * as AgentSessionAdapters from "../../src/terminal/agent-session-adapters";
import type { AgentAdapterLaunchInput, PreparedAgentLaunch } from "../../src/terminal/agent-session-adapters";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createTerminalWebSocketBridge, type TerminalWebSocketBridge } from "../../src/terminal/ws-server";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestWorkspaceFixture,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// 只替换 agent 命令准备，真实 PTY、session manager 与双 WebSocket 均保留；子进程不安装任何 hook。
vi.mock("../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: async (input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> => ({
		binary: input.binary,
		args: input.args,
		env: input.env ?? {},
	}),
}));

const TASK_ID = "task-terminal-start-state-propagation";
const WORKSPACE_ID = "workspace-terminal-start-state-propagation";
const WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS = 10_000;
const RAW_INPUT_ECHO_PROCESS_SOURCE = `
process.stdin.setRawMode(true);
process.stdin.on("data", (input) => process.stdout.write("ECHO:" + input));
process.stdout.write("READY");
`;

// 每次启动等待首帧、状态与回显，再等待停止；两代进程共用两条连接。
describe("已有终端连接上的进程启动状态传播", { timeout: 95_000 }, () => {
	let isolatedWorkspace: IsolatedGitTestWorkspaceFixture;
	let terminalManager: TerminalSessionManager;
	let server: Server;
	let bridge: TerminalWebSocketBridge;
	let originalRuntimePort: number;
	let terminalWebSocketBaseUrl: string;
	let sockets: WebSocket[];

	beforeEach(async () => {
		isolatedWorkspace = createIsolatedGitTestWorkspaceFixture();
		terminalManager = new TerminalSessionManager();
		sockets = [];
		originalRuntimePort = getKanbanRuntimePort();
		server = createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		bridge = createTerminalWebSocketBridge({
			server,
			resolveTerminalManager: (workspaceId) => (workspaceId === WORKSPACE_ID ? terminalManager : null),
			isTerminalIoWebSocketPath: (pathname) => pathname === "/api/terminal/io",
			isTerminalControlWebSocketPath: (pathname) => pathname === "/api/terminal/control",
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		setKanbanRuntimePort(port);
		terminalWebSocketBaseUrl = `ws://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await terminalManager.forceStopTaskSession(TASK_ID);
		terminalManager.dispose();
		for (const socket of sockets) socket.terminate();
		await bridge.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		setKanbanRuntimePort(originalRuntimePort);
	});

	it.each(["shell", "task"] as const)("%s 无 hook 启动和停止后重启均推送新 pid，无需重连", async (sessionKind) => {
		const query = `taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=already-attached-viewer`;
		const ioSocket = new WebSocket(`${terminalWebSocketBaseUrl}/api/terminal/io?${query}`);
		const controlSocket = new WebSocket(`${terminalWebSocketBaseUrl}/api/terminal/control?${query}`);
		sockets.push(ioSocket, controlSocket);
		const controlMessages: RuntimeTerminalWsServerMessage[] = [];
		let receivedOutput = "";
		ioSocket.on("message", (chunk: Buffer) => {
			receivedOutput += chunk.toString("utf8");
			controlSocket.send(JSON.stringify({ type: "output_ack", bytes: chunk.byteLength }));
		});
		controlSocket.on("message", (chunk: Buffer) => {
			controlMessages.push(JSON.parse(chunk.toString("utf8")) as RuntimeTerminalWsServerMessage);
		});
		const unexpectedClose = vi.fn();
		ioSocket.on("close", unexpectedClose);
		controlSocket.on("close", unexpectedClose);
		const latestReceivedSummary = () => controlMessages.filter((message) => message.type === "state").at(-1)?.summary;

		await vi.waitFor(
			() => {
				expect(ioSocket.readyState).toBe(WebSocket.OPEN);
				expect(controlSocket.readyState).toBe(WebSocket.OPEN);
				expect(latestReceivedSummary()).toMatchObject({ pid: null, liveness: "none" });
				expect(controlMessages.some((message) => message.type === "restore")).toBe(true);
			},
			{ timeout: WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS },
		);
		controlSocket.send(JSON.stringify({ type: "restore_complete" }));

		for (const generation of [1, 2]) {
			receivedOutput = "";
			const request = {
				taskId: TASK_ID,
				binary: process.execPath,
				args: ["-e", RAW_INPUT_ECHO_PROCESS_SOURCE],
				cwd: isolatedWorkspace.ownedIntegrationProjectsDirectoryPath,
				env: isolatedWorkspace.createIsolatedChildProcessEnvironment(),
			};
			const startedSummary =
				sessionKind === "shell"
					? await terminalManager.startShellSession(request)
					: await terminalManager.startTaskSession({ ...request, agentId: "codex", prompt: "" });
			expect(startedSummary.pid).toEqual(expect.any(Number));
			// 先确认进程确实活着并已有输出，避免只测连接成功却漏掉消费者一直缓存无进程摘要。
			await vi.waitFor(() => expect(receivedOutput).toContain("READY"), {
				timeout: WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS,
			});
			await vi.waitFor(
				() => expect(latestReceivedSummary()).toMatchObject({ pid: startedSummary.pid, liveness: "live" }),
				{ timeout: WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS },
			);
			expect(latestReceivedSummary()?.lastHookAt).toBeNull();
			ioSocket.send(`generation-${generation}`);
			await vi.waitFor(() => expect(receivedOutput).toContain(`ECHO:generation-${generation}`), {
				timeout: WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS,
			});

			await terminalManager.forceStopTaskSession(TASK_ID);
			await vi.waitFor(
				() =>
					expect(latestReceivedSummary()).toMatchObject({
						pid: null,
						liveness: sessionKind === "shell" ? "none" : "exited",
					}),
				{ timeout: WEBSOCKET_STATE_AND_OUTPUT_ARRIVAL_TIMEOUT_MS },
			);
			expect(ioSocket.readyState).toBe(WebSocket.OPEN);
			expect(controlSocket.readyState).toBe(WebSocket.OPEN);
			expect(unexpectedClose).not.toHaveBeenCalled();
		}
	});
});
