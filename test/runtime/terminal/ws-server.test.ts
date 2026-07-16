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
	writeInput = vi.fn(() => createSummary());
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
		const timeoutId = setTimeout(() => reject(new Error(`Timed out connecting websocket: ${url}`)), 2_000);
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
	timeoutMs = 2_000,
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

async function waitForIoMessage(queuedSocket: QueuedWebSocket, timeoutMs = 2_000): Promise<Buffer> {
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
	timeoutMs = 2_000,
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

async function waitForAssertion(assertion: () => void, timeoutMs = 250): Promise<void> {
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
	timeoutMs = 2_000,
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

describe("createTerminalWebSocketBridge", () => {
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
		await new Promise((resolve) => setTimeout(resolve, 50));
		const bytesReceivedBeforeAnyAck = sumQueuedIoBytes(ioSocket);
		expect(bytesReceivedBeforeAnyAck).toBeGreaterThan(0);
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
});
