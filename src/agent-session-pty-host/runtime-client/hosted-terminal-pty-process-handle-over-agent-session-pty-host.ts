// runtime 侧对一条 hosted PTY 会话的句柄：对 session-manager 而言与进程内的 PtySession 不可区分，
// 实际的 PTY master 在 agent session PTY host 进程里，所有操作经 controller 连接转发。

import type { TerminalPtyProcessExitEvent, TerminalPtyProcessHandle } from "../../terminal/terminal-pty-process-handle";
import type { AgentSessionPtyHostControllerConnection } from "./agent-session-pty-host-controller-connection";

export class HostedTerminalPtyProcessHandleOverAgentSessionPtyHost implements TerminalPtyProcessHandle {
	private exited = false;
	private interrupted = false;
	// 下一个应当到达的输出字节的绝对偏移。到达帧的偏移与它不符说明有缺段或重复（接管续流时用于对齐）。
	private nextExpectedOutputByteOffset = 0;

	constructor(
		private readonly controllerConnection: AgentSessionPtyHostControllerConnection,
		readonly hostedSessionKey: string,
		readonly hostedSessionChannelNumber: number,
		readonly pid: number,
		private readonly onData: (chunk: Buffer) => void,
		private readonly onExit: (event: TerminalPtyProcessExitEvent) => void,
	) {}

	get outputByteOffsetAfterLastDeliveredChunk(): number {
		return this.nextExpectedOutputByteOffset;
	}

	write(data: string | Buffer): void {
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendHostedSessionInputBytes(
			this.hostedSessionChannelNumber,
			typeof data === "string" ? Buffer.from(data, "utf8") : data,
		);
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "resize_hosted_session",
			hostedSessionKey: this.hostedSessionKey,
			cols,
			rows,
			...(pixelWidth !== undefined && pixelHeight !== undefined ? { pixelWidth, pixelHeight } : {}),
		});
	}

	pause(): void {
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "pause_hosted_session_output",
			hostedSessionKey: this.hostedSessionKey,
		});
	}

	resume(): void {
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "resume_hosted_session_output",
			hostedSessionKey: this.hostedSessionKey,
		});
	}

	stop(options?: { interrupted?: boolean; force?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "stop_hosted_session",
			hostedSessionKey: this.hostedSessionKey,
			force: options?.force === true,
		});
	}

	hasExited(): boolean {
		return this.exited;
	}

	publishTerminalSessionAdoptionRecordForRuntimeRestart(adoptionRecord: unknown): void {
		if (this.exited) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "put_hosted_session_adoption_record",
			hostedSessionKey: this.hostedSessionKey,
			adoptionRecord,
		});
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}

	deliverHostedSessionOutput(startByteOffset: number, bytes: Buffer): void {
		if (this.exited) {
			return;
		}
		this.nextExpectedOutputByteOffset = startByteOffset + bytes.byteLength;
		this.onData(bytes);
	}

	deliverHostedSessionExit(event: TerminalPtyProcessExitEvent): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.onExit(event);
	}
}
