// host 进程内的会话注册表：持有每条 PTY master、输出环形缓冲与退出记录。与 socket 无关，便于用假 PTY 单测。
//
// 不变量：
// - 会话的退出记录保留到 controller 显式确认为止。runtime 不在时进程退出，退出码等新 runtime 来取。
// - 读 PTY 是否暂停 = controller 请求暂停（浏览器背压一路传来） 或 到 controller 的 socket 背压。
//   controller 断开时清掉前者：没人会再来 resume，继续暂停只会让 agent 写阻塞直到 runtime 回来。
// - 没有 controller 订阅时照常读 PTY，输出只进环形缓冲（满了覆盖最旧的），绝不阻塞 agent。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`、wire-protocol 与终止信号策略。

import { terminatePtyProcessGroup } from "../../terminal/pty-process-group-termination-signal-policy";
import type {
	AgentSessionPtyHostHostedSessionDescriptor,
	AgentSessionPtyHostHostedSessionExitRecord,
	AgentSessionPtyHostHostedSessionListing,
	AttachHostedSessionOutputStreamOutcome,
	SpawnHostedSessionOutcome,
	SpawnHostedSessionRequestMessage,
} from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
import { HostedSessionOutputRingBufferWithAbsoluteByteOffsets } from "./hosted-session-output-ring-buffer-with-absolute-byte-offsets";

// node-pty IPty 中 host 用得到的那部分，单测注入假实现。
export interface HostedPtyProcess {
	readonly pid: number;
	onData(listener: (data: string | Buffer | Uint8Array) => void): unknown;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number, pixelSize?: { width: number; height: number }): void;
	pause(): void;
	resume(): void;
	kill(signal?: string): void;
}

export type SpawnHostedPtyProcess = (request: {
	binary: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	terminalName: string;
	cols: number;
	rows: number;
}) => HostedPtyProcess;

interface HostedSessionInsideHost {
	hostedSessionKey: string;
	hostedSessionChannelNumber: number;
	hostedSessionDescriptor: AgentSessionPtyHostHostedSessionDescriptor;
	ptyProcess: HostedPtyProcess;
	pid: number;
	spawnedAtEpochMs: number;
	outputRingBuffer: HostedSessionOutputRingBufferWithAbsoluteByteOffsets;
	exitRecord: AgentSessionPtyHostHostedSessionExitRecord | null;
	controllerRequestedOutputPause: boolean;
	ptyReadingCurrentlyPaused: boolean;
	// controller 是否在实时接收这条会话的输出。spawn 它的 controller 自动订阅；controller 断开时清掉，
	// 新 controller 经 attachControllerOutputStream 重新订阅。
	controllerSubscribedToOutput: boolean;
	cols: number;
	rows: number;
	adoptionRecord: unknown;
}

// 追赶重放按此大小切帧：一整块 2 MiB 的帧会在 controller 侧一次性占住事件循环。
const CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH = 64 * 1024;

export interface AgentSessionPtyHostHostedSessionRegistryCallbacks {
	// 只对 controllerSubscribedToOutput 的会话调用。
	onSubscribedHostedSessionOutput: (
		hostedSessionChannelNumber: number,
		startByteOffset: number,
		bytes: Buffer,
	) => void;
	onHostedSessionExited: (hostedSessionKey: string, exitRecord: AgentSessionPtyHostHostedSessionExitRecord) => void;
	// 会话集合变化（spawn / 退出被确认）后调用，供生命周期策略判断是否空闲。
	onHostedSessionSetChanged: () => void;
}

function normalizeHostedPtyOutputChunk(data: string | Buffer | Uint8Array): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

const SIGKILL_ESCALATION_DELAY_AFTER_HOSTED_SESSION_TERMINATION_MS = 5_000;

export class AgentSessionPtyHostHostedSessionRegistry {
	private readonly hostedSessionsByKey = new Map<string, HostedSessionInsideHost>();
	private readonly hostedSessionsByChannelNumber = new Map<number, HostedSessionInsideHost>();
	private nextHostedSessionChannelNumber = 1;
	private socketBackpressureActive = false;

	constructor(
		private readonly spawnHostedPtyProcess: SpawnHostedPtyProcess,
		private readonly callbacks: AgentSessionPtyHostHostedSessionRegistryCallbacks,
		private readonly readNowEpochMs: () => number = Date.now,
		private readonly outputRingBufferCapacityBytes?: number,
	) {}

	get hostedSessionCount(): number {
		return this.hostedSessionsByKey.size;
	}

	spawnHostedSession(request: SpawnHostedSessionRequestMessage): SpawnHostedSessionOutcome {
		if (this.hostedSessionsByKey.has(request.hostedSessionKey)) {
			return {
				kind: "spawn_failed",
				errorCode: "DUPLICATE_HOSTED_SESSION_KEY",
				errorMessage: `hosted session key already exists: ${request.hostedSessionKey}`,
			};
		}
		let ptyProcess: HostedPtyProcess;
		try {
			ptyProcess = this.spawnHostedPtyProcess({
				binary: request.binary,
				args: request.args,
				cwd: request.cwd,
				env: request.env,
				terminalName: request.terminalName,
				cols: request.cols,
				rows: request.rows,
			});
		} catch (error) {
			return {
				kind: "spawn_failed",
				errorCode: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
		const hostedSession: HostedSessionInsideHost = {
			hostedSessionKey: request.hostedSessionKey,
			hostedSessionChannelNumber: this.nextHostedSessionChannelNumber,
			hostedSessionDescriptor: request.hostedSessionDescriptor,
			ptyProcess,
			pid: ptyProcess.pid,
			spawnedAtEpochMs: this.readNowEpochMs(),
			outputRingBuffer: new HostedSessionOutputRingBufferWithAbsoluteByteOffsets(this.outputRingBufferCapacityBytes),
			exitRecord: null,
			controllerRequestedOutputPause: false,
			ptyReadingCurrentlyPaused: false,
			controllerSubscribedToOutput: true,
			cols: request.cols,
			rows: request.rows,
			adoptionRecord: null,
		};
		this.nextHostedSessionChannelNumber += 1;
		this.hostedSessionsByKey.set(hostedSession.hostedSessionKey, hostedSession);
		this.hostedSessionsByChannelNumber.set(hostedSession.hostedSessionChannelNumber, hostedSession);
		ptyProcess.onData((data) => {
			const bytes = normalizeHostedPtyOutputChunk(data);
			const startByteOffset = hostedSession.outputRingBuffer.append(bytes);
			if (hostedSession.controllerSubscribedToOutput) {
				this.callbacks.onSubscribedHostedSessionOutput(
					hostedSession.hostedSessionChannelNumber,
					startByteOffset,
					bytes,
				);
			}
		});
		ptyProcess.onExit((event) => {
			const exitRecord: AgentSessionPtyHostHostedSessionExitRecord = {
				exitCode: event.exitCode,
				signal: event.signal ?? null,
				exitedAtEpochMs: this.readNowEpochMs(),
			};
			hostedSession.exitRecord = exitRecord;
			this.callbacks.onHostedSessionExited(hostedSession.hostedSessionKey, exitRecord);
		});
		this.applyEffectivePtyReadingPause(hostedSession);
		this.callbacks.onHostedSessionSetChanged();
		return {
			kind: "spawned",
			hostedSessionChannelNumber: hostedSession.hostedSessionChannelNumber,
			pid: hostedSession.pid,
			spawnedAtEpochMs: hostedSession.spawnedAtEpochMs,
		};
	}

	writeHostedSessionInput(hostedSessionChannelNumber: number, bytes: Buffer): void {
		const hostedSession = this.hostedSessionsByChannelNumber.get(hostedSessionChannelNumber);
		if (!hostedSession || hostedSession.exitRecord !== null) {
			return;
		}
		try {
			hostedSession.ptyProcess.write(bytes.toString("utf8"));
		} catch {
			// EIO / EBADF：PTY 正在拆除，与 PtySession.write 一样忽略。
		}
	}

	resizeHostedSession(
		hostedSessionKey: string,
		cols: number,
		rows: number,
		pixelWidth?: number,
		pixelHeight?: number,
	): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession || hostedSession.exitRecord !== null) {
			return;
		}
		try {
			if (pixelWidth !== undefined && pixelHeight !== undefined) {
				hostedSession.ptyProcess.resize(cols, rows, { width: pixelWidth, height: pixelHeight });
			} else {
				hostedSession.ptyProcess.resize(cols, rows);
			}
			hostedSession.cols = cols;
			hostedSession.rows = rows;
		} catch {
			// 进程已退出时 resize 会抛，退出事件随后到达。
		}
	}

	putHostedSessionAdoptionRecord(hostedSessionKey: string, adoptionRecord: unknown): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (hostedSession) {
			hostedSession.adoptionRecord = adoptionRecord;
		}
	}

	// 新 controller 订阅一条会话的输出：先经 sendCatchUpOutput 同步发出 [fromByteOffset, 末尾) 的追赶字节，
	// 再置订阅位，之后的输出走实时推送。两步之间没有 await，不会漏字节也不会重复。
	attachControllerOutputStream(
		hostedSessionKey: string,
		fromByteOffset: number,
		sendCatchUpOutput: (hostedSessionChannelNumber: number, startByteOffset: number, bytes: Buffer) => void,
	): AttachHostedSessionOutputStreamOutcome {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession) {
			return { kind: "unknown_hosted_session" };
		}
		const catchUp = hostedSession.outputRingBuffer.readFromAbsoluteByteOffset(fromByteOffset);
		const outcome: AttachHostedSessionOutputStreamOutcome = {
			kind: "attached",
			catchUpStartByteOffset: catchUp.startByteOffset,
			catchUpEndByteOffset: catchUp.startByteOffset + catchUp.bytes.byteLength,
			overwrittenByteCountBeforeCatchUpStart: catchUp.overwrittenByteCountBeforeStart,
		};
		for (
			let chunkStartIndex = 0;
			chunkStartIndex < catchUp.bytes.byteLength;
			chunkStartIndex += CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH
		) {
			sendCatchUpOutput(
				hostedSession.hostedSessionChannelNumber,
				catchUp.startByteOffset + chunkStartIndex,
				catchUp.bytes.subarray(chunkStartIndex, chunkStartIndex + CATCH_UP_OUTPUT_FRAME_MAXIMUM_BYTE_LENGTH),
			);
		}
		hostedSession.controllerSubscribedToOutput = true;
		this.applyEffectivePtyReadingPause(hostedSession);
		return outcome;
	}

	setControllerRequestedOutputPause(hostedSessionKey: string, paused: boolean): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession) {
			return;
		}
		hostedSession.controllerRequestedOutputPause = paused;
		this.applyEffectivePtyReadingPause(hostedSession);
	}

	setSocketBackpressureActive(active: boolean): void {
		if (this.socketBackpressureActive === active) {
			return;
		}
		this.socketBackpressureActive = active;
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			this.applyEffectivePtyReadingPause(hostedSession);
		}
	}

	// controller 断开：清掉它请求的暂停与输出订阅（socket 背压随连接一并消失）。
	releaseControllerStateAfterControllerDisconnected(): void {
		this.socketBackpressureActive = false;
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			hostedSession.controllerRequestedOutputPause = false;
			hostedSession.controllerSubscribedToOutput = false;
			this.applyEffectivePtyReadingPause(hostedSession);
		}
	}

	stopHostedSession(hostedSessionKey: string, force: boolean): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession || hostedSession.exitRecord !== null) {
			return;
		}
		terminatePtyProcessGroup(hostedSession.ptyProcess, { force });
	}

	// 终止全部仍在运行的会话：进程组 SIGTERM，5s 后仍未退出就升级 SIGKILL。返回被终止的会话数。
	terminateAllRunningHostedSessionsWithSigkillEscalation(): number {
		let terminatedHostedSessionCount = 0;
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			if (hostedSession.exitRecord !== null) {
				continue;
			}
			terminatedHostedSessionCount += 1;
			// 暂停中的 PTY 读不到退出前的输出，也可能拖住退出事件；终止前先恢复读取。
			hostedSession.controllerRequestedOutputPause = false;
			this.applyEffectivePtyReadingPause(hostedSession);
			terminatePtyProcessGroup(hostedSession.ptyProcess, {
				escalateToSigkillAfterMs: SIGKILL_ESCALATION_DELAY_AFTER_HOSTED_SESSION_TERMINATION_MS,
				hasProcessExited: () => hostedSession.exitRecord !== null,
			});
		}
		return terminatedHostedSessionCount;
	}

	acknowledgeHostedSessionExit(hostedSessionKey: string): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession || hostedSession.exitRecord === null) {
			return;
		}
		this.hostedSessionsByKey.delete(hostedSessionKey);
		this.hostedSessionsByChannelNumber.delete(hostedSession.hostedSessionChannelNumber);
		this.callbacks.onHostedSessionSetChanged();
	}

	hasRunningHostedSessions(): boolean {
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			if (hostedSession.exitRecord === null) {
				return true;
			}
		}
		return false;
	}

	listHostedSessions(): AgentSessionPtyHostHostedSessionListing[] {
		return [...this.hostedSessionsByKey.values()].map((hostedSession) => ({
			hostedSessionKey: hostedSession.hostedSessionKey,
			hostedSessionChannelNumber: hostedSession.hostedSessionChannelNumber,
			hostedSessionDescriptor: hostedSession.hostedSessionDescriptor,
			pid: hostedSession.pid,
			spawnedAtEpochMs: hostedSession.spawnedAtEpochMs,
			retainedOutputStartByteOffset: hostedSession.outputRingBuffer.retainedStartByteOffset,
			outputEndByteOffset: hostedSession.outputRingBuffer.endByteOffset,
			exitRecord: hostedSession.exitRecord,
			cols: hostedSession.cols,
			rows: hostedSession.rows,
			adoptionRecord: hostedSession.adoptionRecord,
		}));
	}

	private applyEffectivePtyReadingPause(hostedSession: HostedSessionInsideHost): void {
		const shouldPause =
			hostedSession.exitRecord === null &&
			(hostedSession.controllerRequestedOutputPause ||
				(this.socketBackpressureActive && hostedSession.controllerSubscribedToOutput));
		if (shouldPause === hostedSession.ptyReadingCurrentlyPaused) {
			return;
		}
		hostedSession.ptyReadingCurrentlyPaused = shouldPause;
		try {
			if (shouldPause) {
				hostedSession.ptyProcess.pause();
			} else {
				hostedSession.ptyProcess.resume();
			}
		} catch {
			// PTY 已拆除。
		}
	}
}
