// runtime 作为 controller 到一个 agent session PTY host 的连接：握手、请求/响应关联、事件分发。
//
// 一个 host 同时只认一个 controller；新连接握手成功会顶掉旧的（旧连接收到 controller_superseded）。

import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
	AgentSessionPtyHostWireFrameDecoder,
	encodeHostedSessionInputBytesFrame,
	encodeJsonControlMessageFrame,
} from "../wire-protocol/agent-session-pty-host-wire-frame-codec";
import {
	AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
	type AgentSessionPtyHostControllerToHostMessage,
	type AgentSessionPtyHostHostedSessionExitRecord,
	type AgentSessionPtyHostHostedSessionListing,
	type AttachHostedSessionOutputStreamOutcome,
	type HostHelloAcknowledgedMessage,
	readWireControlMessageType,
	type SpawnHostedSessionOutcome,
	type SpawnHostedSessionRequestMessage,
} from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";

const CONTROLLER_HANDSHAKE_DEADLINE_MS = 5_000;
const CONTROLLER_REQUEST_RESPONSE_DEADLINE_MS = 15_000;

export class AgentSessionPtyHostUnreachableError extends Error {
	constructor(
		message: string,
		// ECONNREFUSED / ENOENT：没有 host 在这个 socket 上监听（host 已死或从未启动）。
		readonly noHostIsListening: boolean,
	) {
		super(message);
	}
}

export interface AgentSessionPtyHostControllerConnectionEventHandlers {
	onHostedSessionOutput: (hostedSessionChannelNumber: number, startByteOffset: number, bytes: Buffer) => void;
	onHostedSessionExited: (hostedSessionKey: string, exitRecord: AgentSessionPtyHostHostedSessionExitRecord) => void;
	// 连接断开（host 退出 / 崩溃 / 被新 controller 顶替）。之后本连接不可再用。
	onConnectionClosed: (closeReason: "controller_superseded" | "connection_closed") => void;
}

interface PendingControllerRequest {
	resolve: (message: unknown) => void;
	reject: (error: Error) => void;
	deadlineTimer: NodeJS.Timeout;
}

export class AgentSessionPtyHostControllerConnection {
	private readonly pendingRequestsByRequestId = new Map<string, PendingControllerRequest>();
	private closed = false;
	private closeReason: "controller_superseded" | "connection_closed" = "connection_closed";

	private constructor(
		private readonly socket: Socket,
		readonly hostHello: HostHelloAcknowledgedMessage,
		private eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers | null,
	) {}

	static async connectAsController(socketPath: string): Promise<AgentSessionPtyHostControllerConnection> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const connectingSocket = createConnection(socketPath);
			connectingSocket.once("connect", () => {
				connectingSocket.off("error", onConnectError);
				resolve(connectingSocket);
			});
			const onConnectError = (error: NodeJS.ErrnoException) => {
				connectingSocket.destroy();
				reject(
					new AgentSessionPtyHostUnreachableError(
						`cannot connect to agent session pty host at ${socketPath}: ${error.message}`,
						error.code === "ECONNREFUSED" || error.code === "ENOENT",
					),
				);
			};
			connectingSocket.once("error", onConnectError);
		});
		const decoder = new AgentSessionPtyHostWireFrameDecoder();
		// 握手完成前到达的后续帧（极少见）先攒着，连接对象建好后按序交付。
		const framesArrivedAfterHello: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]> = [];
		const hostHello = await new Promise<HostHelloAcknowledgedMessage>((resolve, reject) => {
			const deadlineTimer = setTimeout(() => {
				socket.destroy();
				reject(
					new AgentSessionPtyHostUnreachableError(
						`agent session pty host handshake timed out: ${socketPath}`,
						false,
					),
				);
			}, CONTROLLER_HANDSHAKE_DEADLINE_MS);
			let helloReceived = false;
			const onHandshakeData = (chunk: Buffer) => {
				let frames: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]>;
				try {
					frames = decoder.push(chunk);
				} catch (error) {
					clearTimeout(deadlineTimer);
					socket.destroy();
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				for (const frame of frames) {
					if (helloReceived) {
						framesArrivedAfterHello.push(frame);
						continue;
					}
					if (frame.kind !== "json_control_message") {
						continue;
					}
					const messageType = readWireControlMessageType(frame.message);
					if (messageType === "host_hello_acknowledged") {
						helloReceived = true;
						clearTimeout(deadlineTimer);
						socket.off("data", onHandshakeData);
						socket.off("close", onHandshakeClose);
						resolve(frame.message as HostHelloAcknowledgedMessage);
					} else if (messageType === "controller_rejected") {
						clearTimeout(deadlineTimer);
						socket.destroy();
						reject(
							new AgentSessionPtyHostUnreachableError(
								`agent session pty host rejected controller: ${JSON.stringify(frame.message)}`,
								false,
							),
						);
						return;
					}
				}
			};
			const onHandshakeClose = () => {
				clearTimeout(deadlineTimer);
				reject(
					new AgentSessionPtyHostUnreachableError(
						`agent session pty host closed during handshake: ${socketPath}`,
						false,
					),
				);
			};
			socket.on("data", onHandshakeData);
			socket.once("close", onHandshakeClose);
			socket.write(
				encodeJsonControlMessageFrame({
					type: "controller_hello",
					protocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
					controllerProcessId: process.pid,
				} satisfies AgentSessionPtyHostControllerToHostMessage),
			);
		});
		const connection = new AgentSessionPtyHostControllerConnection(socket, hostHello, null);
		connection.attachSocketListeners(decoder, framesArrivedAfterHello);
		return connection;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	setEventHandlers(eventHandlers: AgentSessionPtyHostControllerConnectionEventHandlers): void {
		this.eventHandlers = eventHandlers;
	}

	sendControlMessage(message: AgentSessionPtyHostControllerToHostMessage): void {
		if (this.closed) {
			return;
		}
		this.socket.write(encodeJsonControlMessageFrame(message));
	}

	sendHostedSessionInputBytes(hostedSessionChannelNumber: number, bytes: Buffer): void {
		if (this.closed) {
			return;
		}
		this.socket.write(encodeHostedSessionInputBytesFrame(hostedSessionChannelNumber, bytes));
	}

	async requestSpawnHostedSession(
		request: Omit<SpawnHostedSessionRequestMessage, "type" | "requestId">,
	): Promise<SpawnHostedSessionOutcome> {
		const response = (await this.sendRequestAndAwaitResponse((requestId) => ({
			type: "spawn_hosted_session_request",
			requestId,
			...request,
		}))) as { outcome: SpawnHostedSessionOutcome };
		return response.outcome;
	}

	// 订阅一条会话的输出。返回后，偏移落在 [catchUpStartByteOffset, catchUpEndByteOffset) 内的输出帧是追赶重放，
	// 之后的是实时输出（host 保证响应先于追赶帧发出）。
	async requestAttachHostedSessionOutputStream(
		hostedSessionKey: string,
		fromByteOffset: number,
	): Promise<AttachHostedSessionOutputStreamOutcome> {
		const response = (await this.sendRequestAndAwaitResponse((requestId) => ({
			type: "attach_hosted_session_output_stream_request",
			requestId,
			hostedSessionKey,
			fromByteOffset,
		}))) as { outcome: AttachHostedSessionOutputStreamOutcome };
		return response.outcome;
	}

	async requestListHostedSessions(): Promise<AgentSessionPtyHostHostedSessionListing[]> {
		const response = (await this.sendRequestAndAwaitResponse((requestId) => ({
			type: "list_hosted_sessions_request",
			requestId,
		}))) as { hostedSessions: AgentSessionPtyHostHostedSessionListing[] };
		return response.hostedSessions;
	}

	// 等已排队的帧全部写进内核后关闭（runtime 退出前用：stop 等消息不能丢在用户态缓冲里）。
	async closeAfterFlushingPendingFrames(): Promise<void> {
		if (this.closed) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.socket.once("close", () => resolve());
			this.socket.end();
		});
	}

	// 等对端关闭连接（用于「显式全停后等 host 退出」）。
	waitUntilConnectionClosed(timeoutMilliseconds: number): Promise<boolean> {
		if (this.closed) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timeoutTimer = setTimeout(() => resolve(false), timeoutMilliseconds);
			this.socket.once("close", () => {
				clearTimeout(timeoutTimer);
				resolve(true);
			});
		});
	}

	private sendRequestAndAwaitResponse(
		buildRequest: (requestId: string) => AgentSessionPtyHostControllerToHostMessage,
	): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(
				new AgentSessionPtyHostUnreachableError("agent session pty host connection closed", false),
			);
		}
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const deadlineTimer = setTimeout(() => {
				this.pendingRequestsByRequestId.delete(requestId);
				reject(new AgentSessionPtyHostUnreachableError("agent session pty host request timed out", false));
			}, CONTROLLER_REQUEST_RESPONSE_DEADLINE_MS);
			this.pendingRequestsByRequestId.set(requestId, { resolve, reject, deadlineTimer });
			this.sendControlMessage(buildRequest(requestId));
		});
	}

	private attachSocketListeners(
		decoder: AgentSessionPtyHostWireFrameDecoder,
		framesArrivedAfterHello: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]>,
	): void {
		const dispatchFrames = (frames: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]>) => {
			for (const frame of frames) {
				if (frame.kind === "hosted_session_output_bytes") {
					this.eventHandlers?.onHostedSessionOutput(
						frame.hostedSessionChannelNumber,
						frame.startByteOffset,
						frame.bytes,
					);
				} else if (frame.kind === "json_control_message") {
					this.handleHostControlMessage(frame.message);
				}
			}
		};
		this.socket.on("data", (chunk: Buffer) => {
			try {
				dispatchFrames(decoder.push(chunk));
			} catch {
				// 帧边界已不可信，只能断开。
				this.socket.destroy();
			}
		});
		this.socket.on("error", () => {
			// 由 close 统一处理。
		});
		this.socket.on("close", () => {
			this.closed = true;
			for (const pendingRequest of this.pendingRequestsByRequestId.values()) {
				clearTimeout(pendingRequest.deadlineTimer);
				pendingRequest.reject(
					new AgentSessionPtyHostUnreachableError("agent session pty host connection closed", false),
				);
			}
			this.pendingRequestsByRequestId.clear();
			this.eventHandlers?.onConnectionClosed(this.closeReason);
		});
		dispatchFrames(framesArrivedAfterHello);
	}

	private handleHostControlMessage(message: unknown): void {
		const messageType = readWireControlMessageType(message);
		if (messageType === "hosted_session_exited") {
			const exitedMessage = message as {
				hostedSessionKey: string;
				exitRecord: AgentSessionPtyHostHostedSessionExitRecord;
			};
			this.eventHandlers?.onHostedSessionExited(exitedMessage.hostedSessionKey, exitedMessage.exitRecord);
			return;
		}
		if (messageType === "controller_superseded") {
			this.closeReason = "controller_superseded";
			return;
		}
		if (
			messageType === "spawn_hosted_session_response" ||
			messageType === "list_hosted_sessions_response" ||
			messageType === "attach_hosted_session_output_stream_response"
		) {
			const requestId = (message as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") {
				return;
			}
			const pendingRequest = this.pendingRequestsByRequestId.get(requestId);
			if (!pendingRequest) {
				return;
			}
			this.pendingRequestsByRequestId.delete(requestId);
			clearTimeout(pendingRequest.deadlineTimer);
			pendingRequest.resolve(message);
		}
	}
}
