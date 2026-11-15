// 离线全停不能顶掉正在接管的 runtime；根进程先退出时，host 仍须完成后代进程组的 SIGKILL 升级。
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerSocketServer } from "../../src/agent-session-pty-host/host-process/agent-session-pty-host-controller-socket-server";
import type { HostedPtyProcess } from "../../src/agent-session-pty-host/host-process/agent-session-pty-host-hosted-session-registry";
import { AgentSessionPtyHostControllerConnection } from "../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline } from "../../src/agent-session-pty-host/runtime-client/terminate-every-hosted-session-while-kanban-runtime-is-offline";
import { AgentSessionPtyHostWireFrameDecoder } from "../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-frame-codec";

const fixtureCleanupActions: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of fixtureCleanupActions.splice(0).reverse()) await cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function createHostFixture(input?: { unacknowledgedExitRecordRetentionMilliseconds?: number }) {
	vi.useFakeTimers();
	// 假 PTY 的进程号不属于真实会话；拦住进程组信号，保证测试绝不向宿主进程发信号。
	const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
	const fixtureDirectoryPath = await mkdtemp("/tmp/koph-");
	const socketPath = join(fixtureDirectoryPath, "host.sock");
	let emitRootProcessExit: (event: { exitCode: number; signal?: number }) => void = () => {};
	const fakePtyProcess: HostedPtyProcess = {
		pid: 919191919,
		onData: () => {},
		onExit: (listener) => {
			emitRootProcessExit = listener;
		},
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		kill: vi.fn(),
	};
	let markTerminationStarted: () => void = () => {};
	const terminationStarted = new Promise<void>((resolve) => {
		markTerminationStarted = resolve;
	});
	let markControllerDisconnected: () => void = () => {};
	const controllerDisconnected = new Promise<void>((resolve) => {
		markControllerDisconnected = resolve;
	});
	const requestHostProcessExit = vi.fn();
	const hostLogEntries: Array<Record<string, unknown>> = [];
	const server = new AgentSessionPtyHostControllerSocketServer({
		socketPath,
		hostBuildIdentity: "isolated-offline-termination-host",
		spawnHostedPtyProcess: () => fakePtyProcess,
		idleExitAfterMilliseconds: 60_000,
		unacknowledgedExitRecordRetentionMilliseconds: input?.unacknowledgedExitRecordRetentionMilliseconds ?? 60_000,
		appendHostLogEntry: (entry) => {
			hostLogEntries.push(entry);
			if (entry.event === "terminating_all_hosted_sessions") markTerminationStarted();
			if (entry.event === "controller_disconnected") markControllerDisconnected();
		},
		requestHostProcessExit,
	});
	await server.listen();
	const controller = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
	fixtureCleanupActions.push(async () => {
		await controller.closeAfterFlushingPendingFrames();
		server.close();
		await rm(fixtureDirectoryPath, { recursive: true, force: true });
	});
	return {
		socketPath,
		controller,
		processKill,
		hostLogEntries,
		requestHostProcessExit,
		terminationStarted,
		controllerDisconnected,
		emitRootProcessExit: () => emitRootProcessExit({ exitCode: 0, signal: 15 }),
	};
}

async function spawnHostedSessionWithStubbornDescendants(controller: AgentSessionPtyHostControllerConnection) {
	await controller.requestSpawnHostedSession({
		hostedSessionKey: "session-with-stubborn-descendants",
		hostedSessionDescriptor: {
			workspaceId: "isolated-workspace",
			taskId: "isolated-conversation",
			hostedSessionKind: "task_agent_session",
		},
		binary: "/bin/sh",
		args: [],
		cwd: "/",
		env: { TERM: "xterm-256color" },
		terminalName: "xterm-256color",
		cols: 80,
		rows: 24,
	});
}

describe.skipIf(process.platform === "win32")("离线全停的原子所有权与进程组收尾", () => {
	it("即使调用方持有过时的无 controller 观察，也不顶掉现存 runtime", async () => {
		const fixture = await createHostFixture();
		const dependenciesWithStalePresenceObservation = {
			runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated-runtime-home", runtimePort: 3497 },
			listGenerationSocketPaths: () => [fixture.socketPath],
			// 模拟 presence 查询返回后，新 runtime 已接入；安全性必须由 host 原子判断。
			queryControllerPresence: async () => ({ controllerConnected: false, controllerAbsentSinceEpochMs: 0 }),
		};

		const result = await terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline(
			dependenciesWithStalePresenceObservation,
		);

		expect(result[0]?.outcome).toBe("skipped_because_a_kanban_runtime_is_connected_as_controller");
		expect(fixture.controller.isClosed).toBe(false);
		expect(fixture.hostLogEntries.some((entry) => entry.supersededPreviousController === true)).toBe(false);
		expect(fixture.requestHostProcessExit).not.toHaveBeenCalled();
	});

	it("旧 host 忽略原子请求时超时失败，全程不发送 controller 握手", async () => {
		vi.useFakeTimers();
		const fixtureDirectoryPath = await mkdtemp("/tmp/koph-legacy-");
		const socketPath = join(fixtureDirectoryPath, "host.sock");
		const sockets = new Set<Socket>();
		const receivedMessageTypes: string[] = [];
		let markAtomicRequestReceived: () => void = () => {};
		const atomicRequestReceived = new Promise<void>((resolve) => {
			markAtomicRequestReceived = resolve;
		});
		const legacyHost = createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			const decoder = new AgentSessionPtyHostWireFrameDecoder();
			socket.on("data", (chunk: Buffer) => {
				for (const frame of decoder.push(chunk)) {
					if (frame.kind !== "json_control_message") continue;
					const type = (frame.message as { type: string }).type;
					receivedMessageTypes.push(type);
					if (type === "terminate_all_hosted_sessions_if_no_controller_request") markAtomicRequestReceived();
				}
			});
		});
		await new Promise<void>((resolve) => legacyHost.listen(socketPath, resolve));
		fixtureCleanupActions.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => legacyHost.close(() => resolve()));
			await rm(fixtureDirectoryPath, { recursive: true, force: true });
		});

		const termination = terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline({
			runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated-runtime-home", runtimePort: 3497 },
			listGenerationSocketPaths: () => [socketPath],
		});
		await atomicRequestReceived;
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.runOnlyPendingTimersAsync();

		expect((await termination)[0]?.outcome).toBe("failed_to_reach_agent_session_pty_host");
		expect(receivedMessageTypes).toEqual([
			"hosted_session_cli_client_hello",
			"terminate_all_hosted_sessions_if_no_controller_request",
		]);
	});

	it("没有 controller 时原子确认全停，随后拒绝新 runtime 握手", async () => {
		const fixture = await createHostFixture();
		await spawnHostedSessionWithStubbornDescendants(fixture.controller);
		await fixture.controller.closeAfterFlushingPendingFrames();
		await fixture.controllerDisconnected;

		const result = await terminateEveryHostedSessionThroughAgentSessionPtyHostsWhileKanbanRuntimeIsOffline({
			runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated-runtime-home", runtimePort: 3497 },
			listGenerationSocketPaths: () => [fixture.socketPath],
		});

		expect(result[0]?.outcome).toBe("terminate_all_hosted_sessions_requested");
		await fixture.terminationStarted;
		await expect(AgentSessionPtyHostControllerConnection.connectAsController(fixture.socketPath)).rejects.toThrow(
			"host_is_terminating",
		);
		fixture.emitRootProcessExit();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fixture.requestHostProcessExit).toHaveBeenCalledWith(0);
	});

	it("孤儿根退出后不以较短的退出记录保留期跳过进程组升级", async () => {
		const fixture = await createHostFixture({ unacknowledgedExitRecordRetentionMilliseconds: 200 });
		await spawnHostedSessionWithStubbornDescendants(fixture.controller);
		fixture.controller.sendControlMessage({
			type: "put_hosted_session_adoption_record",
			hostedSessionKey: "session-with-stubborn-descendants",
			adoptionRecord: {},
			hostedSessionOrphanReclamationEligibleAtEpochMs: Date.now() - 1,
		});
		await fixture.controller.closeAfterFlushingPendingFrames();
		await fixture.controllerDisconnected;
		await vi.advanceTimersByTimeAsync(0);
		fixture.emitRootProcessExit();

		await vi.advanceTimersByTimeAsync(4_999);
		expect(fixture.requestHostProcessExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.processKill).toHaveBeenCalledWith(-919191919, "SIGKILL");
		await vi.advanceTimersByTimeAsync(200);
		expect(fixture.requestHostProcessExit).toHaveBeenCalledWith(0);
	});

	it("根进程先退出仍等满进程组升级窗口，补发 SIGKILL 后才退出 host", async () => {
		const fixture = await createHostFixture();
		await spawnHostedSessionWithStubbornDescendants(fixture.controller);
		fixture.controller.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
		await fixture.terminationStarted;

		fixture.emitRootProcessExit();

		expect(fixture.requestHostProcessExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(fixture.requestHostProcessExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.processKill).toHaveBeenCalledWith(-919191919, "SIGKILL");
		expect(fixture.requestHostProcessExit).toHaveBeenCalledWith(0);
	});
});
