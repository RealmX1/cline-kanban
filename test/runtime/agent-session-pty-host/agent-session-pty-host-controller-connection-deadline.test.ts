import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionPtyHostControllerConnection } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-controller-connection";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "../../../src/agent-session-pty-host/runtime-client/hosted-terminal-pty-process-handle-over-agent-session-pty-host";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { HostedTerminalPtyProcessSpawnRequest } from "../../../src/terminal/terminal-pty-process-handle";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));
afterEach(async () => {
	await vi.runAllTimersAsync();
	vi.useRealTimers();
	vi.clearAllMocks();
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
		expect(settled).toBe(true);
		expect(await result).toBeInstanceOf(Error);
		expect(socket.destroy).toHaveBeenCalled();
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
