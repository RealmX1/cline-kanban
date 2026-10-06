// host 进程内的会话注册表：持有每条 PTY master、输出环形缓冲与退出记录。与 socket 无关，便于用假 PTY 单测。
//
// 不变量：
// - 会话的退出记录保留到 controller 显式确认为止。runtime 不在时进程退出，退出码等新 runtime 来取。
// - 读 PTY 是否暂停 = controller 请求暂停（浏览器背压一路传来） 或 到 controller 的 socket 背压。
//   controller 断开时清掉前者：没人会再来 resume，继续暂停只会让 agent 写阻塞直到 runtime 回来。
// - 没有 controller 订阅时照常读 PTY，输出只进环形缓冲（满了覆盖最旧的），绝不阻塞 agent。
// - hook spool 跟着会话走，但不随退出确认静默丢弃：确认退出时 spool 若非空，会话留在注册表里
//   （标记「退出已确认、等 spool 排空」），spool 被确认清空后才移除。只有 controller 显式要求
//  （拒绝接管、已下令终止的会话）才连同非空 spool 一起移除。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`、wire-protocol 与终止信号策略。

import { terminatePtyProcessGroup } from "../../terminal/pty-process-group-termination-signal-policy";
import type {
	AgentSessionPtyHostHostedSessionDescriptor,
	AgentSessionPtyHostHostedSessionExitRecord,
	AgentSessionPtyHostHostedSessionListing,
	AppendHookEventToHostedSessionSpoolOutcome,
	AttachHostedSessionOutputStreamOutcome,
	HostedSessionHookSpoolEntry,
	ReadHostedSessionHookSpoolEntriesOutcome,
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
	hookSpoolEntries: HookSpoolEntryInsideHost[];
	nextHookSpoolEntrySequenceNumber: number;
	// controller 已确认退出，但 spool 里还有未确认的条目：会话留到 spool 被确认清空再移除。
	exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: boolean;
}

export type AcknowledgeHostedSessionExitOutcome =
	| { kind: "hosted_session_removed"; discardedHookSpoolEntryCount: number }
	| { kind: "hosted_session_retained_until_hook_spool_drained"; pendingHookSpoolEntryCount: number }
	// 会话不存在或仍在运行：确认不生效。
	| { kind: "acknowledgement_ignored" };

interface HookSpoolEntryInsideHost extends HostedSessionHookSpoolEntry {
	coalescibleWithAdjacentCoalescibleHookSpoolEntry: boolean;
}

// EXPERIMENT_NODE: 每条会话 spool 最多保留多少条不可合并的 hook 事件（生命周期事件）；满了拒收，CLI 退回丢投记录。
// 同步 hook 由 agent 串行触发，runtime 缺席一整夜也攒不出这么多条生命周期事件；上限只防失控。
const MAXIMUM_NON_COALESCIBLE_HOOK_SPOOL_ENTRIES_PER_HOSTED_SESSION = 512;

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
	onHostedSessionHookSpoolEntriesPending?: (hostedSessionKey: string, pendingHookSpoolEntryCount: number) => void;
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
			hookSpoolEntries: [],
			nextHookSpoolEntrySequenceNumber: 1,
			exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: false,
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

	// hooks CLI 在 runtime 不可达时存进来的一条 hook 事件。会话已退出、退出尚未确认（或已确认但 spool 还没排空）时照收：
	// agent 退出前的最后一个 Stop hook 正落在这个窗口里。
	appendHookEventToHostedSessionSpool(
		hostedSessionKey: string,
		spooledHookIngestRequest: unknown,
		coalescibleWithAdjacentCoalescibleHookSpoolEntry: boolean,
	): AppendHookEventToHostedSessionSpoolOutcome {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession) {
			return { kind: "spool_rejected", reason: "unknown_hosted_session" };
		}
		const lastHookSpoolEntry = hostedSession.hookSpoolEntries.at(-1);
		if (
			coalescibleWithAdjacentCoalescibleHookSpoolEntry &&
			lastHookSpoolEntry?.coalescibleWithAdjacentCoalescibleHookSpoolEntry === true
		) {
			// 相邻的高频 activity 只留最新一条：它们推进的都是单调量，中间值没有信息。
			hostedSession.hookSpoolEntries.pop();
		} else if (
			!coalescibleWithAdjacentCoalescibleHookSpoolEntry &&
			hostedSession.hookSpoolEntries.filter((entry) => !entry.coalescibleWithAdjacentCoalescibleHookSpoolEntry)
				.length >= MAXIMUM_NON_COALESCIBLE_HOOK_SPOOL_ENTRIES_PER_HOSTED_SESSION
		) {
			return { kind: "spool_rejected", reason: "hook_spool_full" };
		}
		const hookSpoolEntrySequenceNumber = hostedSession.nextHookSpoolEntrySequenceNumber;
		hostedSession.nextHookSpoolEntrySequenceNumber += 1;
		hostedSession.hookSpoolEntries.push({
			hookSpoolEntrySequenceNumber,
			spooledAtEpochMs: this.readNowEpochMs(),
			spooledHookIngestRequest,
			coalescibleWithAdjacentCoalescibleHookSpoolEntry,
		});
		this.callbacks.onHostedSessionHookSpoolEntriesPending?.(hostedSessionKey, hostedSession.hookSpoolEntries.length);
		return { kind: "spooled", hookSpoolEntrySequenceNumber };
	}

	readHostedSessionHookSpoolEntries(hostedSessionKey: string): ReadHostedSessionHookSpoolEntriesOutcome {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession) {
			return { kind: "unknown_hosted_session" };
		}
		return {
			kind: "read",
			hookSpoolEntries: hostedSession.hookSpoolEntries.map((entry) => ({
				hookSpoolEntrySequenceNumber: entry.hookSpoolEntrySequenceNumber,
				spooledAtEpochMs: entry.spooledAtEpochMs,
				spooledHookIngestRequest: entry.spooledHookIngestRequest,
			})),
		};
	}

	acknowledgeHostedSessionHookSpoolEntries(
		hostedSessionKey: string,
		throughHookSpoolEntrySequenceNumber: number,
	): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession) {
			return;
		}
		hostedSession.hookSpoolEntries = hostedSession.hookSpoolEntries.filter(
			(entry) => entry.hookSpoolEntrySequenceNumber > throughHookSpoolEntrySequenceNumber,
		);
		if (
			hostedSession.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged &&
			hostedSession.hookSpoolEntries.length === 0
		) {
			this.removeHostedSession(hostedSession);
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

	// spool 为空（或 controller 要求一并丢弃）时移除会话；否则保留到 spool 被确认清空，并推一次「有待取条目」，
	// 让 controller 在确认退出之后仍把 spool 取走（退出与 spool 追加的竞态在 host 侧收口）。
	acknowledgeHostedSessionExit(
		hostedSessionKey: string,
		discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession = false,
	): AcknowledgeHostedSessionExitOutcome {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (!hostedSession || hostedSession.exitRecord === null) {
			return { kind: "acknowledgement_ignored" };
		}
		const pendingHookSpoolEntryCount = hostedSession.hookSpoolEntries.length;
		if (pendingHookSpoolEntryCount > 0 && !discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession) {
			hostedSession.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged = true;
			this.callbacks.onHostedSessionHookSpoolEntriesPending?.(hostedSessionKey, pendingHookSpoolEntryCount);
			return { kind: "hosted_session_retained_until_hook_spool_drained", pendingHookSpoolEntryCount };
		}
		this.removeHostedSession(hostedSession);
		return { kind: "hosted_session_removed", discardedHookSpoolEntryCount: pendingHookSpoolEntryCount };
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
			pendingHookSpoolEntryCount: hostedSession.hookSpoolEntries.length,
			...(hostedSession.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged
				? { exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged: true }
				: {}),
		}));
	}

	private removeHostedSession(hostedSession: HostedSessionInsideHost): void {
		this.hostedSessionsByKey.delete(hostedSession.hostedSessionKey);
		this.hostedSessionsByChannelNumber.delete(hostedSession.hostedSessionChannelNumber);
		this.callbacks.onHostedSessionSetChanged();
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
