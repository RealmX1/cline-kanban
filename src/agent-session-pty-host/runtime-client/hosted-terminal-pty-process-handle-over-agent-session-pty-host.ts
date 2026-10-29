// runtime 侧对一条 hosted PTY 会话的句柄：对 session-manager 而言与进程内的 PtySession 不可区分，
// 实际的 PTY master 在 agent session PTY host 进程里，所有操作经 controller 连接转发。

import type { TerminalPtyProcessExitEvent, TerminalPtyProcessHandle } from "../../terminal/terminal-pty-process-handle";
import { omitPlannedHandoverTerminalMirrorCheckpointFromAdoptionRecord } from "../wire-protocol/agent-session-pty-host-control-message-checkpoint-payload-budget";
import { AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH } from "../wire-protocol/agent-session-pty-host-wire-frame-codec";
import type { PutHostedSessionAdoptionRecordMessage } from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type { AgentSessionPtyHostControllerConnection } from "./agent-session-pty-host-controller-connection";

export class HostedTerminalPtyProcessHandleOverAgentSessionPtyHost implements TerminalPtyProcessHandle {
	private exited = false;
	private interrupted = false;
	// 计划内 handover 已把会话交给下一个 runtime：本句柄此后对进程什么都不做（尤其绝不发 stop），也不再接收事件。
	private detachedForRuntimeHandoverRestart = false;
	// 下一个应当到达的输出字节的绝对偏移。到达帧的偏移与它不符说明有缺段或重复（接管续流时用于对齐）。
	private nextExpectedOutputByteOffset = 0;

	constructor(
		private readonly controllerConnection: AgentSessionPtyHostControllerConnection,
		readonly hostedSessionKey: string,
		readonly hostedSessionChannelNumber: number,
		readonly pid: number,
		private readonly onData: (chunk: Buffer) => void,
		private readonly onExit: (event: TerminalPtyProcessExitEvent) => void,
		// 接管时从追赶终点继续计数；创建时间独立沿用 host 的真实值。
		initialOutputByteOffset = 0,
		readonly hostedTerminalPtySessionSpawnedAtEpochMs?: number,
	) {
		this.nextExpectedOutputByteOffset = initialOutputByteOffset;
	}

	get outputByteOffsetAfterLastDeliveredChunk(): number {
		return this.nextExpectedOutputByteOffset;
	}

	private get mayOperateOnHostedProcess(): boolean {
		return !this.exited && !this.detachedForRuntimeHandoverRestart;
	}

	write(data: string | Buffer): void {
		if (!this.mayOperateOnHostedProcess) {
			return;
		}
		this.controllerConnection.sendHostedSessionInputBytes(
			this.hostedSessionChannelNumber,
			typeof data === "string" ? Buffer.from(data, "utf8") : data,
		);
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (!this.mayOperateOnHostedProcess) {
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
		if (!this.mayOperateOnHostedProcess) {
			return;
		}
		this.controllerConnection.sendControlMessage({
			type: "pause_hosted_session_output",
			hostedSessionKey: this.hostedSessionKey,
		});
	}

	resume(): void {
		if (!this.mayOperateOnHostedProcess) {
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
		if (!this.mayOperateOnHostedProcess) {
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

	// hostedSessionOrphanReclamationEligibleAtEpochMs：只有 detach 时才带期限；平时一律 null（见 wire-protocol）。
	publishTerminalSessionAdoptionRecordForRuntimeRestart(
		adoptionRecord: unknown,
		hostedSessionOrphanReclamationEligibleAtEpochMs: number | null = null,
	): void {
		if (!this.mayOperateOnHostedProcess) {
			return;
		}
		const message: PutHostedSessionAdoptionRecordMessage = {
			type: "put_hosted_session_adoption_record",
			hostedSessionKey: this.hostedSessionKey,
			adoptionRecord,
			hostedSessionOrphanReclamationEligibleAtEpochMs,
		};
		if (
			Buffer.byteLength(JSON.stringify(message), "utf8") >
			AGENT_SESSION_PTY_HOST_WIRE_FRAME_MAXIMUM_PAYLOAD_BYTE_LENGTH
		) {
			message.adoptionRecord = omitPlannedHandoverTerminalMirrorCheckpointFromAdoptionRecord(adoptionRecord);
		}
		this.controllerConnection.sendControlMessage(message);
	}

	// 不发任何信号、不关 PTY：进程照常跑在 host 里，等下一个 runtime 接管。调用前必须已推完最终接管记录。
	detachFromRuntimeForHandoverRestartWithoutSignallingProcess(): void {
		this.detachedForRuntimeHandoverRestart = true;
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}

	deliverHostedSessionOutput(startByteOffset: number, bytes: Buffer): void {
		if (!this.mayOperateOnHostedProcess) {
			return;
		}
		this.nextExpectedOutputByteOffset = startByteOffset + bytes.byteLength;
		this.onData(bytes);
	}

	deliverHostedSessionExit(event: TerminalPtyProcessExitEvent): void {
		if (!this.mayOperateOnHostedProcess) {
			return;
		}
		this.exited = true;
		this.onExit(event);
	}
}
