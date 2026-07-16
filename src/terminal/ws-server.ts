import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";

import type { RuntimeTerminalWsServerMessage } from "../core/api-contract";
import { parseTerminalWsClientMessage } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import { logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { handleSocketUpgrade } from "../server/middleware";
import type { TerminalSessionService } from "./terminal-session-service";

interface TerminalWebSocketConnectionContext {
	taskId: string;
	workspaceId: string;
	clientId: string;
	terminalManager: TerminalSessionService;
}

interface UpgradeRequest extends IncomingMessage {
	__kanbanUpgradeHandled?: boolean;
}

export interface CreateTerminalWebSocketBridgeRequest {
	server: Server;
	resolveTerminalManager: (workspaceId: string) => TerminalSessionService | null;
	isTerminalIoWebSocketPath: (pathname: string) => boolean;
	isTerminalControlWebSocketPath: (pathname: string) => boolean;
	/**
	 * Optional session validator for remote-mode passcode enforcement.
	 * When provided, WebSocket upgrade requests that fail validation are
	 * rejected with HTTP 401 before the connection is established.
	 * @param cookieHeader - The value of the Cookie request header (may be undefined).
	 * @returns true if the request is authenticated, false otherwise.
	 */
	validateUpgradeSession?: (cookieHeader: string | undefined) => boolean;
}

export interface TerminalWebSocketBridge {
	close: () => Promise<void>;
}

interface IoOutputState {
	enqueueOutput: (chunk: Buffer) => void;
	acknowledgeOutput: (bytes: number) => void;
	dispose: () => void;
}

// One PTY session can have many browser viewers at the same time.
// Keep shared stream ownership at the task level, then isolate restore,
// buffering, and socket replacement per clientId so one tab cannot evict another.
interface TerminalViewerState {
	clientId: string;
	pendingOutputChunks: Buffer[];
	restoreComplete: boolean;
	ioState: IoOutputState | null;
	ioSocket: WebSocket | null;
	controlSocket: WebSocket | null;
	detachControlListener: (() => void) | null;
	flushPendingOutput: () => void;
}

interface TerminalStreamState {
	viewers: Map<string, TerminalViewerState>;
	// There is one real terminal process, but many browser tabs can watch it.
	// If one tab falls behind, we pause the shared PTY so it does not get flooded.
	// We cannot let a faster tab resume on its own, because the slower tab is still behind.
	// VS Code does the same basic thing for one terminal view by tracking unacknowledged
	// output and pausing once it crosses a high watermark, then resuming below a low watermark.
	// Our extra wrinkle is that one PTY can have many viewers, so we track every backpressured
	// viewer here and only resume once the last slow viewer catches up or disconnects.
	backpressuredViewerIds: Set<string>;
	detachOutputListener: (() => void) | null;
}

const OUTPUT_BATCH_INTERVAL_MS = 4;
const LOW_LATENCY_CHUNK_BYTES = 256;
const LOW_LATENCY_IDLE_WINDOW_MS = 5;
// 单个 IO 帧的大小上限。批处理窗口内攒下的输出可能拼成数百 KB 的巨帧,而客户端 xterm 对单个
// chunk 是整段同步解析(WriteBuffer 的 12ms 时间预算只在 chunk 之间检查)——巨帧意味着一次
// 超长解析、write 回调与 output_ack 大幅推迟,进而触发 ack 背压暂停 PTY、冻结键盘回显。
// 分帧后客户端逐帧解析/逐帧 ack,未确认字节平滑收敛。取值与 OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES
// 对齐:单帧不会仅凭 ws.bufferedAmount 一项瞬时越过 socket 高水位。
const OUTPUT_FRAME_MAX_BYTES = 16 * 1024;
const OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES = 16 * 1024;
const OUTPUT_BUFFER_LOW_WATER_MARK_BYTES = Math.floor(OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES / 4);
const OUTPUT_ACK_HIGH_WATER_MARK_BYTES = 100_000;
const OUTPUT_ACK_LOW_WATER_MARK_BYTES = 5_000;
const OUTPUT_RESUME_CHECK_INTERVAL_MS = 16;
// [tui-freeze] 诊断:PTY 被 ack 背压暂停期间,新按键的 shell 回显完全停产——用户体感即
// 「键盘输入冻结」。暂停超过该阈值才打日志,短暂正常流控不刷屏。
const OUTPUT_BACKPRESSURE_PAUSE_WARN_THRESHOLD_MS = 200;

function getWebSocketTransportSocket(ws: WebSocket): Socket | null {
	const transportSocket = (ws as WebSocket & { _socket?: Socket })._socket;
	return transportSocket ?? null;
}

function rawDataToBuffer(message: RawData): Buffer {
	if (typeof message === "string") {
		return Buffer.from(message, "utf8");
	}
	if (Buffer.isBuffer(message)) {
		return message;
	}
	if (Array.isArray(message)) {
		return Buffer.concat(message.map((part) => rawDataToBuffer(part)));
	}
	return Buffer.from(message);
}

function parseWebSocketPayload(message: RawData) {
	try {
		const text = typeof message === "string" ? message : message.toString("utf8");
		const parsed = JSON.parse(text) as unknown;
		return parseTerminalWsClientMessage(parsed);
	} catch {
		return null;
	}
}

function sendControlMessage(ws: WebSocket, message: RuntimeTerminalWsServerMessage): void {
	if (ws.readyState !== ws.OPEN) {
		return;
	}
	ws.send(JSON.stringify(message));
}

function buildConnectionKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function getTerminalClientId(url: URL): string {
	return url.searchParams.get("clientId")?.trim() || "legacy";
}

export function createTerminalWebSocketBridge({
	server,
	resolveTerminalManager,
	isTerminalIoWebSocketPath,
	isTerminalControlWebSocketPath,
	validateUpgradeSession,
}: CreateTerminalWebSocketBridgeRequest): TerminalWebSocketBridge {
	const activeSockets = new Set<Socket>();
	const terminalStreamStates = new Map<string, TerminalStreamState>();
	server.on("connection", (socket: Socket) => {
		socket.setNoDelay(true);
		activeSockets.add(socket);
		socket.on("close", () => {
			activeSockets.delete(socket);
		});
	});

	const ioServer = new WebSocketServer({ noServer: true });
	const controlServer = new WebSocketServer({ noServer: true });

	const getOrCreateTerminalStreamState = (connectionKey: string): TerminalStreamState => {
		const existing = terminalStreamStates.get(connectionKey);
		if (existing) {
			return existing;
		}
		const created: TerminalStreamState = {
			viewers: new Map(),
			backpressuredViewerIds: new Set(),
			detachOutputListener: null,
		};
		terminalStreamStates.set(connectionKey, created);
		return created;
	};

	const cleanupTerminalStreamStateIfUnused = (connectionKey: string): void => {
		const state = terminalStreamStates.get(connectionKey);
		if (!state || state.viewers.size > 0) {
			return;
		}
		state.detachOutputListener?.();
		state.detachOutputListener = null;
		terminalStreamStates.delete(connectionKey);
	};

	const getOrCreateViewerState = (streamState: TerminalStreamState, clientId: string): TerminalViewerState => {
		const existing = streamState.viewers.get(clientId);
		if (existing) {
			return existing;
		}
		const created: TerminalViewerState = {
			clientId,
			pendingOutputChunks: [],
			restoreComplete: false,
			ioState: null,
			ioSocket: null,
			controlSocket: null,
			detachControlListener: null,
			flushPendingOutput: () => {
				if (!created.restoreComplete || !created.ioState || created.pendingOutputChunks.length === 0) {
					return;
				}
				for (const chunk of created.pendingOutputChunks) {
					created.ioState.enqueueOutput(chunk);
				}
				created.pendingOutputChunks = [];
			},
		};
		streamState.viewers.set(clientId, created);
		return created;
	};

	const cleanupViewerStateIfUnused = (
		connectionKey: string,
		streamState: TerminalStreamState,
		viewerState: TerminalViewerState,
	): void => {
		if (viewerState.ioSocket || viewerState.controlSocket) {
			return;
		}
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = null;
		streamState.viewers.delete(viewerState.clientId);
		cleanupTerminalStreamStateIfUnused(connectionKey);
	};

	const createIoOutputState = (
		ws: WebSocket,
		streamState: TerminalStreamState,
		clientId: string,
		taskId: string,
		terminalManager: TerminalSessionService,
	): IoOutputState => {
		let pendingOutputChunks: Buffer[] = [];
		let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
		let lastOutputSentAt = 0;
		let outputPaused = false;
		let resumeCheckTimer: ReturnType<typeof setTimeout> | null = null;
		// Same idea as VS Code terminal flow control: count output that has been sent
		// but not yet acknowledged as committed by the terminal renderer. We also look
		// at the websocket's own bufferedAmount so we catch both xterm lag and socket lag.
		let unacknowledgedOutputBytes = 0;
		let outputPausedAt: number | null = null;
		let outputPauseReason: "ack-high-water" | "socket-buffered" | null = null;

		const logOutputPauseEndedIfSlow = (endTrigger: "resume" | "dispose") => {
			if (outputPausedAt === null) {
				return;
			}
			const pauseDurationMs = Date.now() - outputPausedAt;
			if (pauseDurationMs >= OUTPUT_BACKPRESSURE_PAUSE_WARN_THRESHOLD_MS) {
				logTuiFreezeWarning(
					`[tui-freeze] output-backpressure taskId=${taskId} clientId=${clientId} durationMs=${pauseDurationMs} reason=${outputPauseReason ?? "unknown"} endTrigger=${endTrigger} unackBytes=${unacknowledgedOutputBytes} socketBufferedBytes=${ws.bufferedAmount}`,
				);
			}
			outputPausedAt = null;
			outputPauseReason = null;
		};

		const shouldPauseOutput = () =>
			ws.bufferedAmount >= OUTPUT_BUFFER_HIGH_WATER_MARK_BYTES ||
			unacknowledgedOutputBytes >= OUTPUT_ACK_HIGH_WATER_MARK_BYTES;

		const canResumeOutput = () =>
			ws.bufferedAmount < OUTPUT_BUFFER_LOW_WATER_MARK_BYTES &&
			unacknowledgedOutputBytes < OUTPUT_ACK_LOW_WATER_MARK_BYTES;

		const clearResumeCheck = () => {
			if (resumeCheckTimer !== null) {
				clearTimeout(resumeCheckTimer);
				resumeCheckTimer = null;
			}
			const transportSocket = getWebSocketTransportSocket(ws);
			transportSocket?.removeListener("drain", checkResumeAfterBackpressure);
		};

		const checkResumeAfterBackpressure = () => {
			if (!outputPaused) {
				clearResumeCheck();
				return;
			}
			if (ws.readyState !== ws.OPEN) {
				return;
			}
			if (canResumeOutput()) {
				outputPaused = false;
				logOutputPauseEndedIfSlow("resume");
				clearResumeCheck();
				streamState.backpressuredViewerIds.delete(clientId);
				if (streamState.backpressuredViewerIds.size === 0) {
					terminalManager.resumeOutput(taskId);
				}
				// 暂停期间 flushOutputBatch 会把未发送的余帧退回 pendingOutputChunks;这里没有
				// 定时器在等的话必须主动续发,否则余帧要等到下一次 PTY 输出才会被捎带出去。
				if (pendingOutputChunks.length > 0 && outputFlushTimer === null) {
					flushOutputBatch();
				}
				return;
			}
			scheduleResumeCheck();
		};

		const scheduleResumeCheck = () => {
			if (!outputPaused) {
				return;
			}
			clearResumeCheck();
			const transportSocket = getWebSocketTransportSocket(ws);
			transportSocket?.once("drain", checkResumeAfterBackpressure);
			resumeCheckTimer = setTimeout(() => {
				resumeCheckTimer = null;
				checkResumeAfterBackpressure();
			}, OUTPUT_RESUME_CHECK_INTERVAL_MS);
		};

		const checkBackpressureAfterSend = (chunk: Buffer) => {
			if (outputPaused || ws.readyState !== ws.OPEN) {
				return;
			}
			unacknowledgedOutputBytes += chunk.byteLength;
			if (shouldPauseOutput()) {
				outputPaused = true;
				outputPausedAt = Date.now();
				outputPauseReason =
					unacknowledgedOutputBytes >= OUTPUT_ACK_HIGH_WATER_MARK_BYTES ? "ack-high-water" : "socket-buffered";
				const previouslyPaused = streamState.backpressuredViewerIds.size > 0;
				streamState.backpressuredViewerIds.add(clientId);
				if (!previouslyPaused) {
					terminalManager.pauseOutput(taskId);
				}
				scheduleResumeCheck();
			}
		};

		const sendOutputChunk = (chunk: Buffer) => {
			if (ws.readyState !== ws.OPEN) {
				return;
			}
			ws.send(chunk);
			lastOutputSentAt = Date.now();
			checkBackpressureAfterSend(chunk);
		};

		const flushOutputBatch = () => {
			outputFlushTimer = null;
			if (pendingOutputChunks.length === 0 || ws.readyState !== ws.OPEN) {
				pendingOutputChunks = [];
				return;
			}
			if (outputPaused) {
				// 已处于背压暂停:保留 pendingOutputChunks 不发送,等 checkResumeAfterBackpressure
				// 的 resume 分支重新触发 flush。暂停期间发出的帧不会计入 unacknowledgedOutputBytes
				// (checkBackpressureAfterSend 在 paused 时直接返回),客户端对它们的 ack 会把计数
				// 提前打到低水位、过早 resume PTY,让大批量输出绕过流控直灌渲染队列。
				return;
			}
			const batchedOutput = Buffer.concat(pendingOutputChunks);
			pendingOutputChunks = [];
			// 按帧上限切片发送(subarray 零拷贝)。字节流内容与顺序不变,仅消息边界变化——客户端
			// 流式 TextDecoder + xterm 增量解析器对任意切点(跨帧 ANSI / UTF-8 断裂)均安全。
			// 逐帧走 sendOutputChunk 保持逐帧背压记账。
			for (let frameOffset = 0; frameOffset < batchedOutput.byteLength; frameOffset += OUTPUT_FRAME_MAX_BYTES) {
				if (outputPaused) {
					// 上一帧触发了背压暂停:立即停发,把余帧退回队首等 resume 后续传。本函数全程
					// 同步,循环期间不会有交错 enqueue,unshift 保证余帧排在暂停期间新到 chunk 之前。
					pendingOutputChunks.unshift(batchedOutput.subarray(frameOffset));
					return;
				}
				sendOutputChunk(batchedOutput.subarray(frameOffset, frameOffset + OUTPUT_FRAME_MAX_BYTES));
			}
		};

		return {
			enqueueOutput: (chunk: Buffer) => {
				const now = Date.now();
				// !outputPaused:暂停期间低延迟路径若直发,该帧同样不计入 unacknowledgedOutputBytes
				// 记账(与 flushOutputBatch 的暂停停发同一漏洞),必须排队等 resume。
				const shouldSendImmediately =
					!outputPaused &&
					pendingOutputChunks.length === 0 &&
					outputFlushTimer === null &&
					chunk.byteLength <= LOW_LATENCY_CHUNK_BYTES &&
					now - lastOutputSentAt >= LOW_LATENCY_IDLE_WINDOW_MS;
				if (shouldSendImmediately) {
					sendOutputChunk(chunk);
					return;
				}
				pendingOutputChunks.push(chunk);
				if (outputFlushTimer === null) {
					outputFlushTimer = setTimeout(flushOutputBatch, OUTPUT_BATCH_INTERVAL_MS);
				}
			},
			acknowledgeOutput: (bytes: number) => {
				unacknowledgedOutputBytes = Math.max(0, unacknowledgedOutputBytes - Math.max(0, Math.floor(bytes)));
				checkResumeAfterBackpressure();
			},
			dispose: () => {
				if (outputFlushTimer !== null) {
					clearTimeout(outputFlushTimer);
					outputFlushTimer = null;
				}
				clearResumeCheck();
				if (outputPaused) {
					outputPaused = false;
					logOutputPauseEndedIfSlow("dispose");
					streamState.backpressuredViewerIds.delete(clientId);
					if (streamState.backpressuredViewerIds.size === 0) {
						terminalManager.resumeOutput(taskId);
					}
				}
				pendingOutputChunks = [];
			},
		};
	};

	const ensureOutputListener = (
		streamState: TerminalStreamState,
		taskId: string,
		terminalManager: TerminalSessionService,
	): void => {
		if (streamState.detachOutputListener) {
			return;
		}
		// Attach PTY output once per task session and fan it out to every viewer.
		// Earlier code attached per websocket, which made the same task effectively
		// last-viewer-wins across tabs.
		streamState.detachOutputListener = terminalManager.attach(taskId, {
			onOutput: (chunk) => {
				for (const viewerState of streamState.viewers.values()) {
					if (viewerState.restoreComplete && viewerState.ioState) {
						viewerState.ioState.enqueueOutput(chunk);
						continue;
					}
					viewerState.pendingOutputChunks.push(chunk);
				}
			},
		});
	};

	server.on("upgrade", (request, socket, head) => {
		try {
			(socket as Socket).setNoDelay(true);
			const upgradeRequest = request as UpgradeRequest;
			const url = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
			const pathname = url.pathname;
			const isIoRequest = isTerminalIoWebSocketPath(pathname);
			const isControlRequest = isTerminalControlWebSocketPath(pathname);
			if (!isIoRequest && !isControlRequest) {
				return;
			}
			if (handleSocketUpgrade(request, socket).end) {
				return;
			}
			// ── Passcode gate for terminal WebSocket upgrades ─────────────────
			if (validateUpgradeSession !== undefined && !validateUpgradeSession(request.headers.cookie)) {
				(socket as Socket).write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				(socket as Socket).destroy();
				return;
			}
			// ── End passcode gate ─────────────────────────────────────────────
			upgradeRequest.__kanbanUpgradeHandled = true;

			const taskId = url.searchParams.get("taskId")?.trim();
			const workspaceId = url.searchParams.get("workspaceId")?.trim();
			if (!taskId || !workspaceId) {
				socket.destroy();
				return;
			}
			const terminalManager = resolveTerminalManager(workspaceId);
			if (!terminalManager) {
				socket.destroy();
				return;
			}

			const targetServer = isIoRequest ? ioServer : controlServer;
			const clientId = getTerminalClientId(url);
			targetServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				targetServer.emit("connection", ws, { taskId, workspaceId, clientId, terminalManager });
			});
		} catch {
			socket.destroy();
		}
	});

	ioServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		const viewerState = getOrCreateViewerState(streamState, clientId);
		const previousIoSocket = viewerState.ioSocket;
		viewerState.ioState?.dispose();
		viewerState.ioState = createIoOutputState(ws, streamState, clientId, taskId, terminalManager);
		viewerState.ioSocket = ws;
		viewerState.flushPendingOutput();
		ensureOutputListener(streamState, taskId, terminalManager);
		if (previousIoSocket && previousIoSocket !== ws) {
			previousIoSocket.close(1000, "Replaced by newer terminal stream.");
		}

		ws.on("message", (rawMessage: RawData) => {
			try {
				const summary = terminalManager.writeInput(taskId, rawDataToBuffer(rawMessage));
				if (!summary) {
					ws.close(1011, "Task session is not running.");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ws.close(1011, message);
			}
		});

		ws.on("close", () => {
			if (viewerState.ioSocket !== ws) {
				return;
			}
			viewerState.ioSocket = null;
			viewerState.ioState?.dispose();
			viewerState.ioState = null;
			cleanupViewerStateIfUnused(connectionKey, streamState, viewerState);
		});
	});

	controlServer.on("connection", (ws: WebSocket, context: unknown) => {
		const taskId = (context as TerminalWebSocketConnectionContext).taskId;
		const workspaceId = (context as TerminalWebSocketConnectionContext).workspaceId;
		const clientId = (context as TerminalWebSocketConnectionContext).clientId;
		const terminalManager = (context as TerminalWebSocketConnectionContext).terminalManager;
		const connectionKey = buildConnectionKey(workspaceId, taskId);
		terminalManager.recoverStaleSession(taskId);
		const streamState = getOrCreateTerminalStreamState(connectionKey);
		const viewerState = getOrCreateViewerState(streamState, clientId);
		const previousControlSocket = viewerState.controlSocket;
		viewerState.restoreComplete = false;
		viewerState.pendingOutputChunks = [];
		viewerState.controlSocket = ws;
		ensureOutputListener(streamState, taskId, terminalManager);
		viewerState.detachControlListener?.();
		viewerState.detachControlListener = terminalManager.attach(taskId, {
			onState: (summary) => {
				sendControlMessage(ws, {
					type: "state",
					summary,
				});
			},
			onExit: (code) => {
				sendControlMessage(ws, {
					type: "exit",
					code,
				});
			},
		});
		if (previousControlSocket && previousControlSocket !== ws) {
			previousControlSocket.close(1000, "Replaced by newer terminal control connection.");
		}

		// Re-enter the restore handshake for this viewer: stop forwarding live output
		// (it buffers into pendingOutputChunks until restore_complete) and send a fresh
		// snapshot. Used both on initial connect and when a hidden tab returns and asks
		// to jump straight to the latest screen via request_restore.
		const sendRestoreSnapshot = (): void => {
			viewerState.restoreComplete = false;
			viewerState.pendingOutputChunks = [];
			void terminalManager
				.getRestoreSnapshot(taskId)
				.then((snapshot) => {
					sendControlMessage(ws, {
						type: "restore",
						snapshot: snapshot?.snapshot ?? "",
						cols: snapshot?.cols ?? null,
						rows: snapshot?.rows ?? null,
					});
				})
				.catch(() => {
					sendControlMessage(ws, {
						type: "restore",
						snapshot: "",
						cols: null,
						rows: null,
					});
				});
		};
		sendRestoreSnapshot();

		ws.on("message", (rawMessage: RawData) => {
			const message = parseWebSocketPayload(rawMessage);
			if (!message) {
				sendControlMessage(ws, {
					type: "error",
					message: "Invalid terminal control payload.",
				});
				return;
			}

			if (message.type === "resize") {
				terminalManager.resize(taskId, message.cols, message.rows, message.pixelWidth, message.pixelHeight);
				return;
			}

			if (message.type === "stop") {
				terminalManager.stopTaskSession(taskId);
				return;
			}

			if (message.type === "output_ack") {
				viewerState.ioState?.acknowledgeOutput(message.bytes);
				return;
			}

			if (message.type === "restore_complete") {
				viewerState.restoreComplete = true;
				viewerState.flushPendingOutput();
				return;
			}

			if (message.type === "request_restore") {
				sendRestoreSnapshot();
			}
		});

		ws.on("close", () => {
			if (viewerState.controlSocket !== ws) {
				return;
			}
			viewerState.controlSocket = null;
			viewerState.detachControlListener?.();
			viewerState.detachControlListener = null;
			cleanupViewerStateIfUnused(connectionKey, streamState, viewerState);
		});
	});

	return {
		close: async () => {
			for (const client of ioServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			for (const client of controlServer.clients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			await new Promise<void>((resolveCloseWebSockets) => {
				ioServer.close(() => {
					controlServer.close(() => {
						resolveCloseWebSockets();
					});
				});
			});
			for (const socket of activeSockets) {
				try {
					socket.destroy();
				} catch {
					// Ignore socket destroy errors during shutdown.
				}
			}
		},
	};
}
