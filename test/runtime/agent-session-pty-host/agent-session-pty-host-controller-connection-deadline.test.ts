import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { queryAgentSessionPtyHostControllerPresence } from "../../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "../../../src/agent-session-pty-host/runtime-client/hosted-terminal-pty-process-handle-over-agent-session-pty-host";
import { encodeJsonControlMessageFrame } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-frame-codec";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { HostedTerminalPtyProcessSpawnRequest } from "../../../src/terminal/terminal-pty-process-handle";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));
afterEach(async () => {
	await vi.runAllTimersAsync();
	vi.useRealTimers();
	vi.clearAllMocks();
});

const isolatedHostHelloFrame = () =>
	encodeJsonControlMessageFrame({
		type: "host_hello_acknowledged",
		protocolVersion: 1,
		hostProcessId: 100,
		hostBuildIdentity: "isolated-host",
		hostStartedAtEpochMs: 1,
	});

describe("controller 连接与握手共用同一截止时间", () => {
	it("连接已经消耗的预算不会在握手阶段重置", async () => {
		vi.useFakeTimers();
		const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
		vi.mocked(createConnection).mockReturnValue(socket as unknown as Socket);
		let settled = false;
		const result = AgentSessionPtyHostControllerConnection.connectAsController("/isolated-host.sock", 1_000)
			.catch((error: unknown) => error)
			.finally(() => {
				settled = true;
			});
		await vi.advanceTimersByTimeAsync(750);
		socket.emit("connect");
		await vi.advanceTimersByTimeAsync(250);
		// 到期后先让出一次已到达的 I/O，再判失败。这一轮不能把握手预算重新记满。
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(true);
		expect(await result).toBeInstanceOf(Error);
		expect(socket.destroy).toHaveBeenCalled();
	});

	it("截止时间在阻塞期间到期后，仍接收已经到达的 connect 与 hello", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const pendingConnection = AgentSessionPtyHostControllerConnection.connectAsController("/isolated-host.sock", 100);
		vi.advanceTimersByTime(100);
		expect(socket.destroy).not.toHaveBeenCalled();
		socket.emit("connect");
		await Promise.resolve();
		socket.emit("data", isolatedHostHelloFrame());
		const connection = await pendingConnection;
		expect(connection.hostHello.hostProcessId).toBe(100);
		expect(socket.destroy).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("握手截止时间到期后，仍接收已经到达的 hello，且真正无 hello 仍会失败", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const pendingConnection = AgentSessionPtyHostControllerConnection.connectAsController("/isolated-host.sock", 100);
		socket.emit("connect");
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(socket.destroy).not.toHaveBeenCalled();
		socket.emit("data", isolatedHostHelloFrame());
		await expect(pendingConnection).resolves.toEqual(expect.objectContaining({ socketPath: "/isolated-host.sock" }));
		expect(socket.destroy).not.toHaveBeenCalled();

		const timedOutSocket = createMockHostSocket();
		const timedOutConnection = AgentSessionPtyHostControllerConnection.connectAsController(
			"/isolated-host-timeout.sock",
			100,
		).catch((error: unknown) => error);
		timedOutSocket.emit("connect");
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(101);
		expect(await timedOutConnection).toBeInstanceOf(Error);
		expect(String(await timedOutConnection)).toContain("handshake timed out");
		expect(timedOutSocket.destroy).toHaveBeenCalled();
	});
});

function createMockHostSocket() {
	const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
	vi.mocked(createConnection).mockReturnValue(socket as unknown as Socket);
	return socket;
}

async function connectMockHostController(socket: ReturnType<typeof createMockHostSocket>) {
	const pendingConnection = AgentSessionPtyHostControllerConnection.connectAsController("/isolated-host.sock");
	socket.emit("connect");
	await Promise.resolve();
	socket.emit(
		"data",
		encodeJsonControlMessageFrame({
			type: "host_hello_acknowledged",
			protocolVersion: 1,
			hostProcessId: 100,
			hostBuildIdentity: "isolated-host",
			hostStartedAtEpochMs: 1,
		}),
	);
	return await pendingConnection;
}

function readLastMockHostRequest(socket: ReturnType<typeof createMockHostSocket>): { requestId: string } {
	const frame: Buffer = socket.write.mock.calls.at(-1)?.[0];
	return JSON.parse(frame.subarray(5).toString("utf8"));
}

describe("PTY host 请求到期时先接收已经到达的 socket 回应", () => {
	it("controller 接受到期回调与 I/O 处理之间到达的回应，且只发送一次请求", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const connection = await connectMockHostController(socket);
		const result = connection.requestListHostedSessions(100).catch((error: unknown) => error);
		const { requestId } = readLastMockHostRequest(socket);
		vi.advanceTimersByTime(100);
		socket.emit(
			"data",
			encodeJsonControlMessageFrame({ type: "list_hosted_sessions_response", requestId, hostedSessions: [] }),
		);
		expect(await result).toEqual([]);
		await vi.runAllTimersAsync();
		expect(socket.write).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("真正无回应仍会超时，诊断包含请求类型、期限及实际耗时", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const connection = await connectMockHostController(socket);
		const result = connection.requestListHostedSessions(100).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(101);
		const error = await result;
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("list_hosted_sessions_request");
		expect(String(error)).toContain("期限 100ms");
		expect(String(error)).toContain("实际耗时");
		expect(String(error)).toContain("超时回调延迟");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("等待 I/O 的轮次中断连会取消超时检查，迟到回应不能再次结算", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const connection = await connectMockHostController(socket);
		const result = connection.requestListHostedSessions(100).catch((error: unknown) => error);
		const { requestId } = readLastMockHostRequest(socket);
		vi.advanceTimersByTime(100);
		socket.emit("close");
		expect(String(await result)).toContain("connection closed");
		socket.emit(
			"data",
			encodeJsonControlMessageFrame({ type: "list_hosted_sessions_response", requestId, hostedSessions: [] }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("恢复使用的只读查询同样接收已到达的回应并清理等待资源", async () => {
		vi.useFakeTimers();
		const socket = createMockHostSocket();
		const result = queryAgentSessionPtyHostControllerPresence({
			agentSessionPtyHostSocketPath: "/isolated-host.sock",
			responseDeadlineMilliseconds: 100,
		});
		socket.emit("connect");
		const { requestId } = readLastMockHostRequest(socket);
		vi.advanceTimersByTime(100);
		socket.emit(
			"data",
			encodeJsonControlMessageFrame({
				type: "query_controller_presence_response",
				requestId,
				controllerConnected: true,
				controllerAbsentSinceEpochMs: null,
			}),
		);
		expect(await result).toEqual({ controllerConnected: true, controllerAbsentSinceEpochMs: null });
		expect(vi.getTimerCount()).toBe(0);
		expect(socket.destroy).toHaveBeenCalledTimes(1);
	});
});

describe("已授权的 hosted 会话换代", () => {
	it("等待旧会话确证退出后才创建新会话，保留会话去重门禁", async () => {
		vi.useFakeTimers();
		const sentControlMessages: unknown[] = [];
		const connection = {
			socketPath: "/isolated-host.sock",
			isClosed: false,
			sendControlMessage: (message: unknown) => sentControlMessages.push(message),
		} as unknown as AgentSessionPtyHostControllerConnection;
		const hostedHandles: HostedTerminalPtyProcessHandleOverAgentSessionPtyHost[] = [];
		const spawnHostedTerminalPtyProcess = vi.fn(async (request: HostedTerminalPtyProcessSpawnRequest) => {
			if (hostedHandles.some((handle) => !handle.hasExited())) throw new Error("原会话尚未退出，拒绝重复创建");
			const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
				connection,
				`key-${hostedHandles.length}`,
				hostedHandles.length + 1,
				hostedHandles.length + 100,
				request.onData,
				request.onExit,
			);
			hostedHandles.push(handle);
			return handle;
		});
		const manager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: { spawnHostedTerminalPtyProcess },
		});
		try {
			await manager.startShellSession({ taskId: "replace-hosted-shell", cwd: "/tmp", binary: "/bin/sh" });
			hostedHandles[0]?.deliverHostedSessionOutput(0, Buffer.from("old-output"));
			expect(manager.listLivePtySessionProcessOwnership()[0]?.currentRuntimeDeliveredHostedOutputEndByteOffset).toBe(
				10,
			);
			manager.transitionToReview("replace-hosted-shell", "manual_review");
			let replacementSettled = false;
			const replacement = manager
				.startShellSession({ taskId: "replace-hosted-shell", cwd: "/tmp", binary: "/bin/sh" })
				.finally(() => {
					replacementSettled = true;
				});
			void replacement.catch(() => {});
			await vi.advanceTimersByTimeAsync(0);
			expect(sentControlMessages).toContainEqual({
				type: "stop_hosted_session",
				hostedSessionKey: "key-0",
				force: false,
			});
			expect(replacementSettled).toBe(false);
			expect(spawnHostedTerminalPtyProcess).toHaveBeenCalledTimes(1);
			hostedHandles[0]?.deliverHostedSessionExit({ exitCode: 0 });
			expect((await replacement).pid).toBe(101);
			expect(manager.hasLiveTaskSession("replace-hosted-shell")).toBe(true);
		} finally {
			for (const handle of hostedHandles) handle.deliverHostedSessionExit({ exitCode: 0 });
			manager.dispose();
		}
	});
	it("未确证退出时有界拒绝，不把停止请求冒充退出或自动强杀", async () => {
		vi.useFakeTimers();
		const sendControlMessage = vi.fn();
		const connection = {
			socketPath: "/isolated-host.sock",
			isClosed: false,
			sendControlMessage,
		} as unknown as AgentSessionPtyHostControllerConnection;
		const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
			connection,
			"original-key",
			1,
			100,
			() => {},
			() => {},
		);
		handle.stop();
		const rejection = expect(handle.waitForHostedPtyExitAfterStopRequest()).rejects.toThrow("尚未确证退出");
		await vi.advanceTimersByTimeAsync(30_000);
		await rejection;
		expect(handle.hasExited()).toBe(false);
		expect(sendControlMessage).toHaveBeenCalledTimes(1);
		expect(sendControlMessage).toHaveBeenCalledWith({
			type: "stop_hosted_session",
			hostedSessionKey: "original-key",
			force: false,
		});
	});
});
