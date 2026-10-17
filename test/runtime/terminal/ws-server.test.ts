import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import type { RuntimeTaskSessionSummary, RuntimeTerminalWsServerMessage } from "../../../src/core/api-contract";
import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../../src/core/runtime-endpoint";
import type { TerminalSessionListener, TerminalSessionService } from "../../../src/terminal/terminal-session-service";
import type { TerminalRestoreSnapshot } from "../../../src/terminal/terminal-state-mirror";
import { createTerminalWebSocketBridge, type TerminalWebSocketBridge } from "../../../src/terminal/ws-server";

const TASK_ID = "task-1";
const WORKSPACE_ID = "workspace-1";

// 「终会到达」的单档等待上限（WS 连接、控制消息、输出帧、记账收敛）。原先的 250ms / 1–2s 在高负载
// （两个 worker 共享宿主）下会被调度饥饿吃掉；这些断言判的是「最终收到了什么、记账是否配平」，
// 放宽不损失判别力。反向断言（等一段时间后断言「没发生」）不在此列，见 :565 一带的说明。
const TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS = 10_000;

function createSummary(taskId = TASK_ID): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function rawDataToBuffer(data: RawData): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data.map((part) => rawDataToBuffer(part)));
	}
	return Buffer.from(data);
}

class FakeTerminalManager implements TerminalSessionService {
	private readonly listenersByTaskId = new Map<string, Set<TerminalSessionListener>>();

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const listeners = this.listenersByTaskId.get(taskId) ?? new Set<TerminalSessionListener>();
		this.listenersByTaskId.set(taskId, listeners);
		listeners.add(listener);
		listener.onState?.(createSummary(taskId));
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.listenersByTaskId.delete(taskId);
			}
		};
	}

	getRestoreSnapshot = vi.fn(
		async (): Promise<TerminalRestoreSnapshot> => ({
			snapshot: "",
			cols: 80,
			rows: 24,
		}),
	);
	recoverStaleSession = vi.fn(() => createSummary());
	writeInput = vi.fn<TerminalSessionService["writeInput"]>(() => createSummary());
	resize = vi.fn(() => true);
	pauseOutput = vi.fn(() => true);
	resumeOutput = vi.fn(() => true);
	stopTaskSession = vi.fn(() => createSummary());

	emitOutput(taskId: string, data: string): void {
		for (const listener of this.listenersByTaskId.get(taskId) ?? []) {
			listener.onOutput?.(Buffer.from(data, "utf8"));
		}
	}
}

interface QueuedWebSocket {
	socket: WebSocket;
	queue: RawData[];
	events: EventEmitter;
}

async function openQueuedWebSocket(url: string): Promise<QueuedWebSocket> {
	const socket = new WebSocket(url);
	const queue: RawData[] = [];
	const events = new EventEmitter();
	socket.on("message", (message) => {
		queue.push(message);
		events.emit("message");
	});
	await new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(
			() => reject(new Error(`Timed out connecting websocket: ${url}`)),
			TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
		);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			reject(error);
		});
	});
	return { socket, queue, events };
}

async function waitForControlMessage(
	queuedSocket: QueuedWebSocket,
	predicate: (message: RuntimeTerminalWsServerMessage) => boolean,
	timeoutMs = TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<RuntimeTerminalWsServerMessage> {
	return await new Promise((resolve, reject) => {
		const tryResolve = () => {
			const index = queuedSocket.queue.findIndex((rawData) => {
				const message = JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage;
				return predicate(message);
			});
			if (index < 0) {
				return;
			}
			const [rawData] = queuedSocket.queue.splice(index, 1);
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			resolve(JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage);
		};
		const timeoutId = setTimeout(() => {
			queuedSocket.events.removeListener("message", tryResolve);
			reject(new Error("Timed out waiting for terminal control message."));
		}, timeoutMs);
		queuedSocket.events.on("message", tryResolve);
		tryResolve();
		queuedSocket.socket.once("error", (error) => {
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			reject(error);
		});
	});
}

async function waitForIoMessage(
	queuedSocket: QueuedWebSocket,
	timeoutMs = TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		// 成功/超时路径也要摘掉 error 监听器:渐进 ack 的用例会按帧数反复调用本函数,
		// 残留的 once("error") 会线性堆积并触发 MaxListenersExceededWarning。
		const onSocketError = (error: Error) => {
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			reject(error);
		};
		const tryResolve = () => {
			const rawData = queuedSocket.queue.shift();
			if (!rawData) {
				return;
			}
			clearTimeout(timeoutId);
			queuedSocket.events.removeListener("message", tryResolve);
			queuedSocket.socket.removeListener("error", onSocketError);
			resolve(rawDataToBuffer(rawData));
		};
		const timeoutId = setTimeout(() => {
			queuedSocket.events.removeListener("message", tryResolve);
			queuedSocket.socket.removeListener("error", onSocketError);
			reject(new Error("Timed out waiting for terminal output."));
		}, timeoutMs);
		queuedSocket.events.on("message", tryResolve);
		// 先挂 error 监听再尝试同步 resolve:若队列里已有数据,tryResolve 会立即 settle,
		// 之后才注册的监听器将无人摘除。
		queuedSocket.socket.once("error", onSocketError);
		tryResolve();
	});
}

// 累计收 IO 帧直到达到期望总字节数(服务端对批处理输出按 OUTPUT_FRAME_MAX_BYTES 分帧,
// 大段输出到达客户端是多个 ≤16KB 帧而非单个巨帧),并模拟真实客户端的渐进 ack:每收到一帧
// 就通过 control socket ack 该帧的字节数。服务端在跨过背压水位后会停发余帧(退回队列),
// 必须靠这些渐进 ack 把 unacknowledgedOutputBytes 降回低水位、触发 resume,余帧才会继续发出。
// 返回按到达顺序拼接的完整字节流与逐帧大小。
async function collectIoFramesTotalingBytesWithPerFrameAcks(
	ioSocket: QueuedWebSocket,
	controlSocket: QueuedWebSocket,
	expectedTotalBytes: number,
	timeoutMs = TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<{ combined: Buffer; frameByteLengths: number[] }> {
	const frames: Buffer[] = [];
	let receivedBytes = 0;
	const deadline = Date.now() + timeoutMs;
	while (receivedBytes < expectedTotalBytes) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new Error(
				`Timed out collecting per-frame-acked terminal output frames: got ${receivedBytes}/${expectedTotalBytes} bytes.`,
			);
		}
		const frame = await waitForIoMessage(ioSocket, remainingMs);
		frames.push(frame);
		receivedBytes += frame.byteLength;
		controlSocket.socket.send(JSON.stringify({ type: "output_ack", bytes: frame.byteLength }));
	}
	return { combined: Buffer.concat(frames), frameByteLengths: frames.map((frame) => frame.byteLength) };
}

function sumQueuedIoBytes(queuedSocket: QueuedWebSocket): number {
	return queuedSocket.queue.reduce((totalBytes, rawData) => totalBytes + rawDataToBuffer(rawData).byteLength, 0);
}

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
		return;
	}
	socket.close();
	await once(socket, "close");
}

async function waitForAssertion(
	assertion: () => void,
	timeoutMs = TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (lastError) {
		throw lastError;
	}
	assertion();
}

// ---------------------------------------------------------------------------
// Helper: attempt a raw WebSocket upgrade and capture the response status line
// ---------------------------------------------------------------------------
async function attemptUpgradeAndReadResponse(
	url: string,
	cookieHeader?: string,
	timeoutMs = TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS,
): Promise<{ statusLine: string }> {
	return await new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error(`Timed out waiting for upgrade response: ${url}`));
		}, timeoutMs);

		const ws = new WebSocket(url, {
			headers: cookieHeader ? { cookie: cookieHeader } : undefined,
		});

		let statusLine = "";

		ws.on("unexpected-response", (_req, res) => {
			clearTimeout(timeoutId);
			statusLine = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`;
			res.resume();
			resolve({ statusLine });
		});

		ws.on("open", () => {
			clearTimeout(timeoutId);
			ws.close();
			resolve({ statusLine: "HTTP/1.1 101 Switching Protocols" });
		});

		ws.on("error", (err) => {
			clearTimeout(timeoutId);
			// Node's ws library translates the 401 "connection: close" into an
			// error event rather than "unexpected-response" in some versions;
			// treat any error as a rejected upgrade.
			if (!statusLine) {
				statusLine = err.message;
			}
			resolve({ statusLine });
		});
	});
}

describe("createTerminalWebSocketBridge – passcode gate", () => {
	let server: Server;
	let bridge: TerminalWebSocketBridge;
	let terminalManager: FakeTerminalManager;
	let runtimeUrl: string;
	let originalRuntimePort: number;

	beforeEach(async () => {
		originalRuntimePort = getKanbanRuntimePort();
		terminalManager = new FakeTerminalManager();
		server = createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		bridge = createTerminalWebSocketBridge({
			server,
			resolveTerminalManager: (workspaceId) => (workspaceId === WORKSPACE_ID ? terminalManager : null),
			isTerminalIoWebSocketPath: (pathname) => pathname === "/api/terminal/io",
			isTerminalControlWebSocketPath: (pathname) => pathname === "/api/terminal/control",
			// Validator: only the token "valid-token" is accepted.
			validateUpgradeSession: (cookieHeader) => cookieHeader?.includes("kanban_session=valid-token") === true,
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address() as AddressInfo | null;
		if (!address) {
			throw new Error("Expected websocket server address.");
		}
		// Align the runtime endpoint config with the test server so the
		// middleware Host/Origin allowlist accepts our random port.
		setKanbanRuntimePort(address.port);
		runtimeUrl = `ws://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		setKanbanRuntimePort(originalRuntimePort);
		await bridge.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	});

	it("rejects /api/terminal/io upgrade with 401 when no session cookie is present", async () => {
		const url = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}`;
		const { statusLine } = await attemptUpgradeAndReadResponse(url);
		expect(statusLine).toContain("401");
	});

	it("rejects /api/terminal/control upgrade with 401 when session token is invalid", async () => {
		const url = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}`;
		const { statusLine } = await attemptUpgradeAndReadResponse(url, "kanban_session=wrong-token");
		expect(statusLine).toContain("401");
	});

	it("allows /api/terminal/io upgrade when a valid session cookie is present", async () => {
		const url = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}`;
		const { statusLine } = await attemptUpgradeAndReadResponse(url, "kanban_session=valid-token");
		expect(statusLine).toContain("101");
	});

	it("allows /api/terminal/control upgrade when a valid session cookie is present", async () => {
		const url = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}`;
		const { statusLine } = await attemptUpgradeAndReadResponse(url, "kanban_session=valid-token");
		expect(statusLine).toContain("101");
	});

	it("allows upgrades when validateUpgradeSession is not set (local mode)", async () => {
		// We need a completely independent HTTP server + bridge for this test.
		// Node's EventEmitter stacks upgrade listeners, so reusing the same server
		// would leave the passcode-enforcing listener in place alongside the new
		// no-validator bridge, causing the 401 path to still fire first.
		const freshServer = createServer((_request, response) => {
			response.writeHead(404);
			response.end();
		});
		const freshManager = new FakeTerminalManager();
		const freshBridge = createTerminalWebSocketBridge({
			server: freshServer,
			resolveTerminalManager: (workspaceId) => (workspaceId === WORKSPACE_ID ? freshManager : null),
			isTerminalIoWebSocketPath: (pathname) => pathname === "/api/terminal/io",
			isTerminalControlWebSocketPath: (pathname) => pathname === "/api/terminal/control",
			// No validateUpgradeSession: local mode, no gate.
		});
		freshServer.listen(0, "127.0.0.1");
		await once(freshServer, "listening");
		const freshAddress = freshServer.address() as AddressInfo | null;
		if (!freshAddress) {
			throw new Error("Expected fresh server address.");
		}
		setKanbanRuntimePort(freshAddress.port);
		const freshUrl = `ws://127.0.0.1:${freshAddress.port}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}`;

		try {
			const { statusLine } = await attemptUpgradeAndReadResponse(freshUrl);
			expect(statusLine).toContain("101");
		} finally {
			await freshBridge.close();
			await new Promise<void>((resolve, reject) => {
				freshServer.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});

// 用例超时挂在 describe 上（嵌套的「永久卡死的兜底」随之继承），取组内串行等待最多的用例：「broadcasts one PTY
// session…」与「keeps the PTY paused…」各 9 段「终会到达」等待（4 次开 socket + 2 次等 restore + 3 次等输出帧 / 收帧 /
// 记账收敛）× 单段上限，外加 5s 关 socket 与短观察窗的余量——内层等待到点时带诊断的失败不会被用例超时截断。
const TEST_TIMEOUT_MS_COVERING_NINE_SERIAL_ARRIVAL_WAITS =
	9 * TERMINAL_WEBSOCKET_EVENTUAL_ARRIVAL_WAIT_TIMEOUT_MS + 5_000;

describe("createTerminalWebSocketBridge", { timeout: TEST_TIMEOUT_MS_COVERING_NINE_SERIAL_ARRIVAL_WAITS }, () => {
	let server: Server;
	let bridge: TerminalWebSocketBridge;
	let terminalManager: FakeTerminalManager;
	let runtimeUrl: string;
	let originalRuntimePort: number;

	beforeEach(async () => {
		originalRuntimePort = getKanbanRuntimePort();
		terminalManager = new FakeTerminalManager();
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
		const address = server.address() as AddressInfo | null;
		if (!address) {
			throw new Error("Expected websocket server address.");
		}
		setKanbanRuntimePort(address.port);
		runtimeUrl = `ws://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		setKanbanRuntimePort(originalRuntimePort);
		await bridge.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	});

	it("无进程时丢弃鼠标报告但保留连接，恢复后同一连接可继续输入", async () => {
		const ioSocket = await openQueuedWebSocket(
			`${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=reclaimed-viewer`,
		);
		const controlSocket = await openQueuedWebSocket(
			`${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=reclaimed-viewer`,
		);
		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));
		terminalManager.writeInput.mockReturnValueOnce(null).mockReturnValueOnce(null);
		const unexpectedClose = vi.fn();
		ioSocket.socket.on("close", unexpectedClose);

		ioSocket.socket.send("\u001b[<35;14;5M");
		ioSocket.socket.send("\u001b[I");
		await waitForAssertion(() => expect(terminalManager.writeInput).toHaveBeenCalledTimes(2));
		ioSocket.socket.send("恢复后的输入");
		await waitForAssertion(() =>
			expect(terminalManager.writeInput).toHaveBeenLastCalledWith(TASK_ID, Buffer.from("恢复后的输入")),
		);
		expect(unexpectedClose).not.toHaveBeenCalled();
		expect(ioSocket.socket.readyState).toBe(WebSocket.OPEN);
		expect(controlSocket.socket.readyState).toBe(WebSocket.OPEN);
		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("真实输入写入异常仍以 1011 关闭连接", async () => {
		const ioSocket = await openQueuedWebSocket(
			`${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=failed-input-viewer`,
		);
		terminalManager.writeInput.mockImplementationOnce(() => {
			throw new Error("真实写入失败");
		});
		const closed = once(ioSocket.socket, "close");
		ioSocket.socket.send("用户输入");
		await expect(closed).resolves.toEqual([1011, Buffer.from("真实写入失败")]);
	});

	it("broadcasts one PTY session to multiple viewers", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));

		terminalManager.emitOutput(TASK_ID, "hello");

		await expect(waitForIoMessage(ioSocketA)).resolves.toEqual(Buffer.from("hello", "utf8"));
		await expect(waitForIoMessage(ioSocketB)).resolves.toEqual(Buffer.from("hello", "utf8"));

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);

		terminalManager.emitOutput(TASK_ID, "world");

		await expect(waitForIoMessage(ioSocketB)).resolves.toEqual(Buffer.from("world", "utf8"));

		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
	});

	it("keeps the PTY paused until every backpressured viewer drains", async () => {
		const ioUrlA = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrlA = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const ioUrlB = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-b`;
		const controlUrlB = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-b`;

		const ioSocketA = await openQueuedWebSocket(ioUrlA);
		const controlSocketA = await openQueuedWebSocket(controlUrlA);
		const ioSocketB = await openQueuedWebSocket(ioUrlB);
		const controlSocketB = await openQueuedWebSocket(controlUrlB);

		await waitForControlMessage(controlSocketA, (message) => message.type === "restore");
		await waitForControlMessage(controlSocketB, (message) => message.type === "restore");
		controlSocketA.socket.send(JSON.stringify({ type: "restore_complete" }));
		controlSocketB.socket.send(JSON.stringify({ type: "restore_complete" }));

		const output = "x".repeat(120_000);
		const outputTotalBytes = Buffer.byteLength(output);
		terminalManager.emitOutput(TASK_ID, output);

		// viewer A 逐帧 ack(模拟正常渲染的客户端),按帧上限分片收全 120KB。
		// viewer B 一个 ack 都不发:发送侧跨过背压水位后必须停发余帧,B 收不全。
		const outputA = await collectIoFramesTotalingBytesWithPerFrameAcks(ioSocketA, controlSocketA, outputTotalBytes);
		expect(outputA.combined.byteLength).toBe(outputTotalBytes);
		expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);

		// B 仍背压中:PTY 不得 resume(A 已追上不算数,resume 要等最后一个慢 viewer)。
		const bytesReceivedByViewerBWithoutAcks = sumQueuedIoBytes(ioSocketB);
		expect(bytesReceivedByViewerBWithoutAcks).toBeLessThan(outputTotalBytes);
		expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

		// B 开始逐帧 ack 后余帧续传、收全,最后一个慢 viewer 追上,PTY resume 且与 pause 配平。
		const outputB = await collectIoFramesTotalingBytesWithPerFrameAcks(ioSocketB, controlSocketB, outputTotalBytes);
		expect(outputB.combined.byteLength).toBe(outputTotalBytes);
		await waitForAssertion(() => {
			expect(terminalManager.resumeOutput.mock.calls.length).toBeGreaterThan(0);
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(terminalManager.resumeOutput.mock.calls.length);
		});

		await closeSocket(ioSocketA.socket);
		await closeSocket(controlSocketA.socket);
		await closeSocket(ioSocketB.socket);
		await closeSocket(controlSocketB.socket);
	});

	it("slices batched output into frames no larger than 16KB while preserving the exact byte stream", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;

		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		// 非 16KB 整数倍,验证末帧尾量;内容用变化的字节序列,验证跨帧拼接逐字节等于原文。
		const OUTPUT_FRAME_MAX_BYTES = 16 * 1024;
		const output = Array.from({ length: 40_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
		const outputTotalBytes = Buffer.byteLength(output);
		terminalManager.emitOutput(TASK_ID, output);

		const collected = await collectIoFramesTotalingBytesWithPerFrameAcks(ioSocket, controlSocket, outputTotalBytes);
		expect(collected.frameByteLengths.length).toBeGreaterThan(1);
		for (const frameByteLength of collected.frameByteLengths) {
			expect(frameByteLength).toBeLessThanOrEqual(OUTPUT_FRAME_MAX_BYTES);
		}
		expect(collected.combined.toString("utf8")).toBe(output);

		// 逐帧 ack 后 PTY 恢复(40KB 未过 100KB ack 高水位,但可能触发 socket buffered 暂停——
		// 全量 ack + 排空后必须回到未暂停状态,pause/resume 配平)。
		await waitForAssertion(() => {
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(terminalManager.resumeOutput.mock.calls.length);
		});

		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("stops mid-batch sending once the ack high water mark is crossed and resumes the remainder only after acks", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;

		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		const OUTPUT_FRAME_MAX_BYTES = 16 * 1024;
		const OUTPUT_ACK_HIGH_WATER_MARK_BYTES = 100_000;
		// 单批 300KB,远超 100KB ack 高水位:发送必须在跨过高水位的那一帧停住。
		// (修复前的缺陷:整批 300KB 在一个 flush 循环里全部发出,且仅暂停前的帧计入记账。)
		const output = Array.from({ length: 300_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
		const outputTotalBytes = Buffer.byteLength(output);
		terminalManager.emitOutput(TASK_ID, output);

		// 不发任何 ack:收到的字节数被钳制在「高水位 + 至多一帧」以内,余帧留在服务端队列。
		// 正向屏障:先等到服务端确实暂停、且跨过高水位的那一帧已经到达客户端——原先固定等 50ms,
		// 负载下帧还在路上就断言,会因「收到 0 字节」误报。
		await waitForAssertion(() => {
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);
			expect(sumQueuedIoBytes(ioSocket)).toBeGreaterThan(OUTPUT_ACK_HIGH_WATER_MARK_BYTES);
		});
		// 反向观察(「没有过量发送」):暂停之后再留一小段窗口,看有没有越过暂停点继续发出的帧。
		// 这是「等一段时间后断言没发生」的弱观察,负载下只会漏报、不会误报,窗口沿用原值。
		await new Promise((resolve) => setTimeout(resolve, 50));
		const bytesReceivedBeforeAnyAck = sumQueuedIoBytes(ioSocket);
		expect(bytesReceivedBeforeAnyAck).toBeLessThanOrEqual(OUTPUT_ACK_HIGH_WATER_MARK_BYTES + OUTPUT_FRAME_MAX_BYTES);
		expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);
		expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

		// 渐进 ack 后余帧续传:拼接后的字节流与原文逐字节一致(内容与顺序完全不变),
		// 且每帧仍不超过帧上限——退回队列的余帧续传时依旧走分帧与逐帧记账。
		const collected = await collectIoFramesTotalingBytesWithPerFrameAcks(ioSocket, controlSocket, outputTotalBytes);
		for (const frameByteLength of collected.frameByteLengths) {
			expect(frameByteLength).toBeLessThanOrEqual(OUTPUT_FRAME_MAX_BYTES);
		}
		expect(collected.combined.toString("utf8")).toBe(output);

		// 全部字节都计入了记账:ack 恰好等于收到的字节数就能让 pause/resume 配平收敛。
		await waitForAssertion(() => {
			expect(terminalManager.resumeOutput.mock.calls.length).toBeGreaterThan(0);
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(terminalManager.resumeOutput.mock.calls.length);
		});

		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("queues low-latency chunks arriving while output is paused instead of sending them uncounted", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;

		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		// 恰好 7 帧 = 114688 字节:第 7 帧跨过 100KB ack 高水位,批在暂停点上正好耗尽
		// (pendingOutputChunks 为空但 outputPaused 已置位)——这是低延迟直发路径最容易
		// 漏记账的形态:后续小 chunk 若直发,checkBackpressureAfterSend 在 paused 时直返、不计字节。
		const OUTPUT_FRAME_MAX_BYTES = 16 * 1024;
		const pauseExhaustedBatchByteLength = OUTPUT_FRAME_MAX_BYTES * 7;
		const bigOutput = Array.from({ length: pauseExhaustedBatchByteLength }, (_, index) =>
			String.fromCharCode(97 + (index % 26)),
		).join("");
		terminalManager.emitOutput(TASK_ID, bigOutput);
		await new Promise((resolve) => setTimeout(resolve, 30));

		// 暂停期间到达的小 chunk 必须排队等 resume,不得走低延迟路径直发。
		const tailMarker = "tail-marker";
		terminalManager.emitOutput(TASK_ID, tailMarker);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(sumQueuedIoBytes(ioSocket)).toBeLessThanOrEqual(pauseExhaustedBatchByteLength);

		// 渐进 ack 后小 chunk 按序补发:字节流 = 大批输出 ⧺ marker,顺序与内容完全不变。
		const expectedTotalBytes = pauseExhaustedBatchByteLength + Buffer.byteLength(tailMarker);
		const collected = await collectIoFramesTotalingBytesWithPerFrameAcks(ioSocket, controlSocket, expectedTotalBytes);
		expect(collected.combined.toString("utf8")).toBe(`${bigOutput}${tailMarker}`);
		await waitForAssertion(() => {
			expect(terminalManager.resumeOutput.mock.calls.length).toBeGreaterThan(0);
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(terminalManager.resumeOutput.mock.calls.length);
		});

		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	it("re-sends a fresh snapshot and re-gates live output on request_restore", async () => {
		const ioUrl = `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;
		const controlUrl = `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=client-a`;

		const ioSocket = await openQueuedWebSocket(ioUrl);
		const controlSocket = await openQueuedWebSocket(controlUrl);

		await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		// A returning hidden tab asks for the latest screen. The server should serialize a
		// fresh snapshot and resend it (the second getRestoreSnapshot call).
		terminalManager.getRestoreSnapshot.mockResolvedValueOnce({ snapshot: "fresh-snap", cols: 80, rows: 24 });
		controlSocket.socket.send(JSON.stringify({ type: "request_restore" }));

		const resnapshot = await waitForControlMessage(
			controlSocket,
			(message) => message.type === "restore" && message.snapshot === "fresh-snap",
		);
		expect(resnapshot.type).toBe("restore");
		expect(terminalManager.getRestoreSnapshot).toHaveBeenCalledTimes(2);

		// Live output is gated again until the client acknowledges the new snapshot, so it
		// cannot interleave ahead of the snapshot the viewer is about to render.
		terminalManager.emitOutput(TASK_ID, "after-resync");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ioSocket.queue).toHaveLength(0);

		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));
		await expect(waitForIoMessage(ioSocket)).resolves.toEqual(Buffer.from("after-resync", "utf8"));

		await closeSocket(ioSocket.socket);
		await closeSocket(controlSocket.socket);
	});

	// 下面四条守的都是同一类故障:服务端把一条 viewer(或整条 PTY)**永久**卡住,而且不产生任何
	// 错误信号——屏幕全静止、卡片却还在跳「agent 在算」。每一条对应一处原本没有上限的等待。
	describe("永久卡死的兜底", () => {
		function buildIoUrl(clientId: string): string {
			return `${runtimeUrl}/api/terminal/io?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=${clientId}`;
		}

		function buildControlUrl(clientId: string): string {
			return `${runtimeUrl}/api/terminal/control?taskId=${TASK_ID}&workspaceId=${WORKSPACE_ID}&clientId=${clientId}`;
		}

		// 假定时器必须在**目标定时器被武装之前**装上——vi.useFakeTimers() 只替换全局函数，
		// 捕获不到此前已经用真 setTimeout 排好的那一个。所以下面每条用例都各自挑准切换时机。
		// socket 收发走真实 I/O（事件驱动、不吃定时器），快进期间与之后都照常流转。
		afterEach(() => {
			vi.useRealTimers();
		});

		it("客户端永远不回 restore_complete 时，服务端到点强开闸门把扣住的输出放出去", async () => {
			// 握手超时是在 control 连上的那一刻武装的，所以假定时器要赶在开 socket 之前装上。
			vi.useFakeTimers();
			const ioSocket = await openQueuedWebSocket(buildIoUrl("client-stuck-handshake"));
			const controlSocket = await openQueuedWebSocket(buildControlUrl("client-stuck-handshake"));
			await waitForControlMessage(controlSocket, (message) => message.type === "restore");

			// 故意不回 restore_complete。旧实现里这条 viewer 从此一个字节都收不到，而且因为一个字节
			// 都没发出去，连背压都不会触发——PTY 照跑、lastOutputAt 照刷、卡片照跳。
			terminalManager.emitOutput(TASK_ID, "held behind the gate");
			await vi.advanceTimersByTimeAsync(10_100);
			vi.useRealTimers();

			await expect(waitForIoMessage(ioSocket)).resolves.toEqual(Buffer.from("held behind the gate", "utf8"));

			await closeSocket(ioSocket.socket);
			await closeSocket(controlSocket.socket);
		});

		it("握手期间扣住的输出超过上限就强开闸门，不让服务端内存无上限增长", async () => {
			const ioSocket = await openQueuedWebSocket(buildIoUrl("client-overflow"));
			const controlSocket = await openQueuedWebSocket(buildControlUrl("client-overflow"));
			await waitForControlMessage(controlSocket, (message) => message.type === "restore");

			// 同样不回 restore_complete，但这次靠输出量本身把缓冲顶穿（上限 4MB）。
			const oneMegabyteOfOutput = "y".repeat(1024 * 1024);
			for (let emitIndex = 0; emitIndex < 5; emitIndex += 1) {
				terminalManager.emitOutput(TASK_ID, oneMegabyteOfOutput);
			}

			// 闸门被溢出强开 ⇒ 扣住的输出开始上线。旧实现里这里永远收不到任何东西。
			const firstFrame = await waitForIoMessage(ioSocket);
			expect(firstFrame.byteLength).toBeGreaterThan(0);

			await closeSocket(ioSocket.socket);
			await closeSocket(controlSocket.socket);
		});

		it("一个 viewer 背压卡住超过上限时长就被逐出，共享 PTY 随之恢复", async () => {
			const ioSocket = await openQueuedWebSocket(buildIoUrl("client-wedged-backpressure"));
			const controlSocket = await openQueuedWebSocket(buildControlUrl("client-wedged-backpressure"));
			await waitForControlMessage(controlSocket, (message) => message.type === "restore");
			controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));
			// 先让一小段输出真的上线，确认服务端已经收下 restore_complete、闸门确实开了。
			// 不确认就切假定时器的话，后面那 120KB 会被扣在握手缓冲里，压根走不到背压那一步。
			terminalManager.emitOutput(TASK_ID, "gate-open");
			await waitForIoMessage(ioSocket);

			// 逐出定时器是在「进入背压暂停」的那一刻武装的，所以假定时器装在这一步之前即可。
			vi.useFakeTimers();
			// 一个 ack 都不发：跨过高水位后 PTY 被这一个 viewer 单独按住。
			terminalManager.emitOutput(TASK_ID, "z".repeat(120_000));
			await vi.advanceTimersByTimeAsync(20);
			expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);
			expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(30_100);
			vi.useRealTimers();

			// 逐出 → close → ioState.dispose → 摘出 backpressuredViewerIds → PTY 放开。
			await waitForAssertion(() => {
				expect(terminalManager.resumeOutput.mock.calls.length).toBeGreaterThan(0);
			});

			await closeSocket(ioSocket.socket);
			await closeSocket(controlSocket.socket);
		});

		it("control socket 重连后，丢掉的那批 ack 不再把共享 PTY 永久按住", async () => {
			const ioSocket = await openQueuedWebSocket(buildIoUrl("client-ack-drift"));
			const controlSocketBeforeReconnect = await openQueuedWebSocket(buildControlUrl("client-ack-drift"));
			await waitForControlMessage(controlSocketBeforeReconnect, (message) => message.type === "restore");
			controlSocketBeforeReconnect.socket.send(JSON.stringify({ type: "restore_complete" }));

			terminalManager.emitOutput(TASK_ID, "z".repeat(120_000));
			await waitForAssertion(() => {
				expect(terminalManager.pauseOutput).toHaveBeenCalledTimes(1);
			});
			expect(terminalManager.resumeOutput).not.toHaveBeenCalled();

			// control 抖断重连：在途的那批 ack 就此永远补不回来。ack 记在 io 侧、却从 control 上来，
			// 旧实现里这份计数于是永远降不回低水位，canResumeOutput 恒假，PTY 永久暂停。
			await closeSocket(controlSocketBeforeReconnect.socket);
			const controlSocketAfterReconnect = await openQueuedWebSocket(buildControlUrl("client-ack-drift"));
			await waitForControlMessage(controlSocketAfterReconnect, (message) => message.type === "restore");

			await waitForAssertion(() => {
				expect(terminalManager.resumeOutput.mock.calls.length).toBeGreaterThan(0);
			});

			await closeSocket(ioSocket.socket);
			await closeSocket(controlSocketAfterReconnect.socket);
		});
	});
});
