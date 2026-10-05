// host 进程的 Unix socket 服务端：握手、单 controller 槽、把控制消息路由到会话注册表、把输出推给 controller，
// 以及 host 自身的生命周期（空闲自退、排空后退休、显式全停）。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`、wire-protocol 与同目录模块。

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	AgentSessionPtyHostWireFrameDecoder,
	encodeHostedSessionOutputBytesFrame,
	encodeJsonControlMessageFrame,
} from "../wire-protocol/agent-session-pty-host-wire-frame-codec";
import {
	AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
	type AgentSessionPtyHostHostToControllerMessage,
	readWireControlMessageType,
} from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
import {
	AgentSessionPtyHostHostedSessionRegistry,
	type SpawnHostedPtyProcess,
} from "./agent-session-pty-host-hosted-session-registry";

const CONTROLLER_HELLO_DEADLINE_MS = 5_000;
// 显式全停：SIGKILL 升级在 5s，再留 2s 等退出事件送达，然后无论如何退出。
const TERMINATE_ALL_HOSTED_SESSIONS_FORCED_HOST_EXIT_DEADLINE_MS = 7_000;

export interface AgentSessionPtyHostControllerSocketServerOptions {
	socketPath: string;
	hostBuildIdentity: string;
	spawnHostedPtyProcess: SpawnHostedPtyProcess;
	// 没有 controller、也没有任何会话（含未确认的退出记录）时，过这么久自行退出。
	idleExitAfterMilliseconds: number;
	// 没有 controller、没有运行中的会话、只剩未确认的退出记录时，保留这么久等新 runtime 来取，然后退出。
	unacknowledgedExitRecordRetentionMilliseconds: number;
	appendHostLogEntry: (entry: Record<string, unknown>) => void;
	requestHostProcessExit: (exitCode: number) => void;
	readNowEpochMs?: () => number;
	outputRingBufferCapacityBytes?: number;
}

type HostLifecycleState = "serving" | "retiring_when_drained" | "terminating_all_hosted_sessions";

function readStringField(message: unknown, fieldName: string): string | null {
	const value = (message as Record<string, unknown>)[fieldName];
	return typeof value === "string" ? value : null;
}

function readFiniteNumberField(message: unknown, fieldName: string): number | null {
	const value = (message as Record<string, unknown>)[fieldName];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// socket 目录可能落在 /tmp 下（sun_path 超长时的回退）。/tmp 人人可写，别人可以抢先建好同名目录并在里面
// 摆一个假 socket 冒充 host；所以目录必须是真目录（不是软链）、属于当前用户、且组与其他人都不可写。
function assertSocketDirectoryIsPrivateToCurrentUser(socketDirectoryPath: string): void {
	const socketDirectoryStatus = lstatSync(socketDirectoryPath);
	const currentUserId = typeof process.getuid === "function" ? process.getuid() : socketDirectoryStatus.uid;
	if (
		!socketDirectoryStatus.isDirectory() ||
		socketDirectoryStatus.uid !== currentUserId ||
		(socketDirectoryStatus.mode & 0o022) !== 0
	) {
		throw new Error(
			`agent session pty host socket directory ${socketDirectoryPath} must be a real directory owned by the current user and not writable by group or others`,
		);
	}
}

export class AgentSessionPtyHostControllerSocketServer {
	private readonly server: Server;
	private readonly hostedSessionRegistry: AgentSessionPtyHostHostedSessionRegistry;
	private readonly hostStartedAtEpochMs: number;
	private currentControllerSocket: Socket | null = null;
	private hostLifecycleState: HostLifecycleState = "serving";
	private idleExitTimer: NodeJS.Timeout | null = null;
	private idleExitTimerDelayMilliseconds: number | null = null;
	private hostExitRequested = false;

	constructor(private readonly options: AgentSessionPtyHostControllerSocketServerOptions) {
		const readNowEpochMs = options.readNowEpochMs ?? Date.now;
		this.hostStartedAtEpochMs = readNowEpochMs();
		this.hostedSessionRegistry = new AgentSessionPtyHostHostedSessionRegistry(
			options.spawnHostedPtyProcess,
			{
				onSubscribedHostedSessionOutput: (hostedSessionChannelNumber, startByteOffset, bytes) => {
					this.writeFrameToCurrentController(
						encodeHostedSessionOutputBytesFrame(hostedSessionChannelNumber, startByteOffset, bytes),
					);
				},
				onHostedSessionExited: (hostedSessionKey, exitRecord) => {
					this.options.appendHostLogEntry({ event: "hosted_session_exited", hostedSessionKey, ...exitRecord });
					this.sendMessageToCurrentController({ type: "hosted_session_exited", hostedSessionKey, exitRecord });
					this.evaluateHostLifecycle();
				},
				onHostedSessionSetChanged: () => {
					this.evaluateHostLifecycle();
				},
			},
			readNowEpochMs,
			options.outputRingBufferCapacityBytes,
		);
		this.server = createServer((socket) => this.acceptConnection(socket));
	}

	// 绑定 socket。路径上已有一个活着的 host 时返回 another_host_already_listening（调用方应直接退出）；
	// 只有死掉的旧 socket 文件时把它删掉重绑。
	async listen(): Promise<"listening" | "another_host_already_listening"> {
		const socketDirectoryPath = dirname(this.options.socketPath);
		mkdirSync(socketDirectoryPath, { recursive: true, mode: 0o700 });
		assertSocketDirectoryIsPrivateToCurrentUser(socketDirectoryPath);
		const firstAttempt = await this.tryListenOnce();
		if (firstAttempt === "listening") {
			return this.finishListening();
		}
		if (await this.isAnotherHostAcceptingConnections()) {
			return "another_host_already_listening";
		}
		try {
			unlinkSync(this.options.socketPath);
		} catch {
			// 已被别人删掉。
		}
		const secondAttempt = await this.tryListenOnce();
		if (secondAttempt === "listening") {
			return this.finishListening();
		}
		return "another_host_already_listening";
	}

	close(): void {
		this.server.close();
		this.currentControllerSocket?.destroy();
	}

	private finishListening(): "listening" {
		chmodSync(this.options.socketPath, 0o600);
		this.options.appendHostLogEntry({
			event: "host_listening",
			socketPath: this.options.socketPath,
			hostBuildIdentity: this.options.hostBuildIdentity,
			hostProcessId: process.pid,
		});
		this.evaluateHostLifecycle();
		return "listening";
	}

	private tryListenOnce(): Promise<"listening" | "address_in_use"> {
		return new Promise((resolve, reject) => {
			const onError = (error: NodeJS.ErrnoException) => {
				this.server.off("listening", onListening);
				if (error.code === "EADDRINUSE") {
					resolve("address_in_use");
					return;
				}
				reject(error);
			};
			const onListening = () => {
				this.server.off("error", onError);
				resolve("listening");
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.options.socketPath);
		});
	}

	private isAnotherHostAcceptingConnections(): Promise<boolean> {
		return new Promise((resolve) => {
			const probe = createConnection(this.options.socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolve(true);
			});
			probe.once("error", () => {
				resolve(false);
			});
		});
	}

	private acceptConnection(socket: Socket): void {
		const decoder = new AgentSessionPtyHostWireFrameDecoder();
		let handshakeCompleted = false;
		const helloDeadlineTimer = setTimeout(() => {
			if (!handshakeCompleted) {
				socket.destroy();
			}
		}, CONTROLLER_HELLO_DEADLINE_MS);
		socket.on("error", () => {
			// 断开由 close 处理。
		});
		socket.on("close", () => {
			clearTimeout(helloDeadlineTimer);
			if (this.currentControllerSocket === socket) {
				this.currentControllerSocket = null;
				this.hostedSessionRegistry.releaseControllerStateAfterControllerDisconnected();
				this.options.appendHostLogEntry({ event: "controller_disconnected" });
				this.evaluateHostLifecycle();
			}
		});
		socket.on("drain", () => {
			if (this.currentControllerSocket === socket) {
				this.hostedSessionRegistry.setSocketBackpressureActive(false);
			}
		});
		socket.on("data", (chunk: Buffer) => {
			let frames: ReturnType<AgentSessionPtyHostWireFrameDecoder["push"]>;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				this.options.appendHostLogEntry({
					event: "controller_connection_frame_decoding_failed",
					message: error instanceof Error ? error.message : String(error),
				});
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (!handshakeCompleted) {
					if (frame.kind !== "json_control_message") {
						socket.destroy();
						return;
					}
					handshakeCompleted = this.completeControllerHandshake(socket, frame.message);
					clearTimeout(helloDeadlineTimer);
					if (!handshakeCompleted) {
						return;
					}
					continue;
				}
				// 被新 controller 顶替之后，旧连接上还在路上的帧一律丢弃。
				if (this.currentControllerSocket !== socket) {
					return;
				}
				if (frame.kind === "hosted_session_input_bytes") {
					this.hostedSessionRegistry.writeHostedSessionInput(frame.hostedSessionChannelNumber, frame.bytes);
				} else if (frame.kind === "json_control_message") {
					this.handleControllerControlMessage(frame.message);
				}
			}
		});
	}

	private completeControllerHandshake(socket: Socket, message: unknown): boolean {
		if (readWireControlMessageType(message) !== "controller_hello") {
			socket.destroy();
			return false;
		}
		const protocolVersion = readFiniteNumberField(message, "protocolVersion");
		if (protocolVersion !== AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION) {
			socket.end(
				encodeJsonControlMessageFrame({
					type: "controller_rejected",
					reason: "protocol_version_unsupported",
					hostSupportedProtocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
				} satisfies AgentSessionPtyHostHostToControllerMessage),
			);
			return false;
		}
		if (this.hostLifecycleState === "terminating_all_hosted_sessions") {
			socket.end(
				encodeJsonControlMessageFrame({
					type: "controller_rejected",
					reason: "host_is_terminating",
					hostSupportedProtocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
				} satisfies AgentSessionPtyHostHostToControllerMessage),
			);
			return false;
		}
		const supersededControllerSocket = this.currentControllerSocket;
		if (supersededControllerSocket !== null) {
			// 先摘槽再断开，旧连接的 close 回调就不会把新 controller 的状态一并清掉。
			this.currentControllerSocket = null;
			supersededControllerSocket.end(
				encodeJsonControlMessageFrame({
					type: "controller_superseded",
				} satisfies AgentSessionPtyHostHostToControllerMessage),
			);
			this.hostedSessionRegistry.releaseControllerStateAfterControllerDisconnected();
		}
		this.currentControllerSocket = socket;
		this.options.appendHostLogEntry({
			event: "controller_connected",
			controllerProcessId: readFiniteNumberField(message, "controllerProcessId"),
			supersededPreviousController: supersededControllerSocket !== null,
		});
		this.sendMessageToCurrentController({
			type: "host_hello_acknowledged",
			protocolVersion: AGENT_SESSION_PTY_HOST_WIRE_PROTOCOL_VERSION,
			hostProcessId: process.pid,
			hostBuildIdentity: this.options.hostBuildIdentity,
			hostStartedAtEpochMs: this.hostStartedAtEpochMs,
		});
		this.evaluateHostLifecycle();
		return true;
	}

	private handleControllerControlMessage(message: unknown): void {
		const messageType = readWireControlMessageType(message);
		switch (messageType) {
			case "spawn_hosted_session_request": {
				const requestId = readStringField(message, "requestId") ?? "";
				if (this.hostLifecycleState !== "serving") {
					this.sendMessageToCurrentController({
						type: "spawn_hosted_session_response",
						requestId,
						outcome: {
							kind: "spawn_failed",
							errorCode: "HOST_NOT_ACCEPTING_NEW_SESSIONS",
							errorMessage: `agent session pty host is ${this.hostLifecycleState}`,
						},
					});
					return;
				}
				const outcome = this.hostedSessionRegistry.spawnHostedSession(
					message as Parameters<AgentSessionPtyHostHostedSessionRegistry["spawnHostedSession"]>[0],
				);
				this.options.appendHostLogEntry({
					event: "hosted_session_spawn",
					hostedSessionKey: readStringField(message, "hostedSessionKey"),
					outcome,
				});
				this.sendMessageToCurrentController({ type: "spawn_hosted_session_response", requestId, outcome });
				return;
			}
			case "resize_hosted_session": {
				const hostedSessionKey = readStringField(message, "hostedSessionKey");
				const cols = readFiniteNumberField(message, "cols");
				const rows = readFiniteNumberField(message, "rows");
				if (hostedSessionKey === null || cols === null || rows === null) {
					return;
				}
				this.hostedSessionRegistry.resizeHostedSession(
					hostedSessionKey,
					cols,
					rows,
					readFiniteNumberField(message, "pixelWidth") ?? undefined,
					readFiniteNumberField(message, "pixelHeight") ?? undefined,
				);
				return;
			}
			case "pause_hosted_session_output":
			case "resume_hosted_session_output": {
				const hostedSessionKey = readStringField(message, "hostedSessionKey");
				if (hostedSessionKey !== null) {
					this.hostedSessionRegistry.setControllerRequestedOutputPause(
						hostedSessionKey,
						messageType === "pause_hosted_session_output",
					);
				}
				return;
			}
			case "stop_hosted_session": {
				const hostedSessionKey = readStringField(message, "hostedSessionKey");
				if (hostedSessionKey !== null) {
					this.hostedSessionRegistry.stopHostedSession(
						hostedSessionKey,
						(message as Record<string, unknown>).force === true,
					);
				}
				return;
			}
			case "acknowledge_hosted_session_exit": {
				const hostedSessionKey = readStringField(message, "hostedSessionKey");
				if (hostedSessionKey !== null) {
					this.hostedSessionRegistry.acknowledgeHostedSessionExit(hostedSessionKey);
				}
				return;
			}
			case "list_hosted_sessions_request": {
				this.sendMessageToCurrentController({
					type: "list_hosted_sessions_response",
					requestId: readStringField(message, "requestId") ?? "",
					hostedSessions: this.hostedSessionRegistry.listHostedSessions(),
				});
				return;
			}
			case "put_hosted_session_adoption_record": {
				const hostedSessionKey = readStringField(message, "hostedSessionKey");
				if (hostedSessionKey !== null) {
					this.hostedSessionRegistry.putHostedSessionAdoptionRecord(
						hostedSessionKey,
						(message as Record<string, unknown>).adoptionRecord ?? null,
					);
				}
				return;
			}
			case "attach_hosted_session_output_stream_request": {
				const requestId = readStringField(message, "requestId") ?? "";
				const hostedSessionKey = readStringField(message, "hostedSessionKey") ?? "";
				const fromByteOffset = readFiniteNumberField(message, "fromByteOffset") ?? 0;
				// 响应必须先于追赶帧发出：controller 靠响应里的区间判定随后到达的帧是追赶还是实时。
				// 先算区间、缓存追赶帧，发完响应再发帧。
				const catchUpFrames: Buffer[] = [];
				const outcome = this.hostedSessionRegistry.attachControllerOutputStream(
					hostedSessionKey,
					fromByteOffset,
					(hostedSessionChannelNumber, startByteOffset, bytes) => {
						catchUpFrames.push(
							encodeHostedSessionOutputBytesFrame(hostedSessionChannelNumber, startByteOffset, bytes),
						);
					},
				);
				this.sendMessageToCurrentController({
					type: "attach_hosted_session_output_stream_response",
					requestId,
					outcome,
				});
				for (const catchUpFrame of catchUpFrames) {
					this.writeFrameToCurrentController(catchUpFrame);
				}
				return;
			}
			case "retire_when_drained": {
				if (this.hostLifecycleState === "serving") {
					this.hostLifecycleState = "retiring_when_drained";
					this.options.appendHostLogEntry({ event: "host_retiring_when_drained" });
				}
				this.evaluateHostLifecycle();
				return;
			}
			case "terminate_all_hosted_sessions_and_exit": {
				this.terminateAllHostedSessionsAndExit();
				return;
			}
			default:
				// 向前兼容：旧 host 收到不认识的消息类型时忽略，不断连。
				this.options.appendHostLogEntry({ event: "unknown_controller_message_ignored", messageType });
		}
	}

	private terminateAllHostedSessionsAndExit(): void {
		if (this.hostLifecycleState === "terminating_all_hosted_sessions") {
			return;
		}
		this.hostLifecycleState = "terminating_all_hosted_sessions";
		const terminatedHostedSessionCount =
			this.hostedSessionRegistry.terminateAllRunningHostedSessionsWithSigkillEscalation();
		this.options.appendHostLogEntry({ event: "terminating_all_hosted_sessions", terminatedHostedSessionCount });
		const forcedExitTimer = setTimeout(() => {
			this.requestHostExit("terminate_all_forced_exit_deadline_reached");
		}, TERMINATE_ALL_HOSTED_SESSIONS_FORCED_HOST_EXIT_DEADLINE_MS);
		forcedExitTimer.unref?.();
		this.evaluateHostLifecycle();
	}

	private evaluateHostLifecycle(): void {
		if (this.hostExitRequested) {
			return;
		}
		if (
			this.hostLifecycleState === "terminating_all_hosted_sessions" &&
			!this.hostedSessionRegistry.hasRunningHostedSessions()
		) {
			this.requestHostExit("all_hosted_sessions_terminated");
			return;
		}
		if (this.hostLifecycleState === "retiring_when_drained" && this.hostedSessionRegistry.hostedSessionCount === 0) {
			this.requestHostExit("retired_after_draining_all_hosted_sessions");
			return;
		}
		const idleExitDelayMilliseconds = this.resolveIdleExitDelayMilliseconds();
		if (idleExitDelayMilliseconds === this.idleExitTimerDelayMilliseconds) {
			return;
		}
		if (this.idleExitTimer !== null) {
			clearTimeout(this.idleExitTimer);
			this.idleExitTimer = null;
		}
		this.idleExitTimerDelayMilliseconds = idleExitDelayMilliseconds;
		if (idleExitDelayMilliseconds !== null) {
			this.idleExitTimer = setTimeout(() => {
				this.requestHostExit("idle_without_controller_or_running_hosted_sessions");
			}, idleExitDelayMilliseconds);
		}
	}

	// null：不该空闲退出（有 controller 或有运行中的会话）。
	private resolveIdleExitDelayMilliseconds(): number | null {
		if (this.currentControllerSocket !== null || this.hostedSessionRegistry.hasRunningHostedSessions()) {
			return null;
		}
		return this.hostedSessionRegistry.hostedSessionCount === 0
			? this.options.idleExitAfterMilliseconds
			: this.options.unacknowledgedExitRecordRetentionMilliseconds;
	}

	private requestHostExit(reason: string): void {
		if (this.hostExitRequested) {
			return;
		}
		this.hostExitRequested = true;
		this.options.appendHostLogEntry({ event: "host_exiting", reason });
		// libuv 关闭 Unix socket 监听时会自行删除 socket 文件；这里不再手动 unlink，
		// 免得删掉一个新 host 刚在同一路径上绑好的 socket。
		this.server.close();
		this.currentControllerSocket?.end();
		this.options.requestHostProcessExit(0);
	}

	private sendMessageToCurrentController(message: AgentSessionPtyHostHostToControllerMessage): void {
		this.writeFrameToCurrentController(encodeJsonControlMessageFrame(message));
	}

	private writeFrameToCurrentController(frame: Buffer): void {
		const controllerSocket = this.currentControllerSocket;
		if (controllerSocket === null || controllerSocket.destroyed) {
			return;
		}
		const flushedToKernel = controllerSocket.write(frame);
		if (!flushedToKernel) {
			this.hostedSessionRegistry.setSocketBackpressureActive(true);
		}
	}
}
