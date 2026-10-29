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
// - host 自己只在一种情况下终止会话：孤儿回收（没有 controller、且过了 runtime 推来的回收期限）。
//   新 hook 到达即作废旧期限，待 runtime 排空核对后重新发布；退出记录带上原因，新 runtime 据此补记回收账本。
//
// 本文件属于 host 进程的依赖闭包：只允许 import `node:*`、wire-protocol 与终止信号策略。

import { terminatePtyProcessGroup } from "../../terminal/pty-process-group-termination-signal-policy";
import type {
	AgentSessionPtyHostHostedSessionDescriptor,
	AgentSessionPtyHostHostedSessionExitRecord,
	AgentSessionPtyHostHostedSessionListing,
	AgentSessionPtyHostHostedSessionTerminatedByHostReason,
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
	// 没有 controller 时按它回收（null = 不回收）。新 hook 作废旧值，排空后才允许 runtime 重新发布。
	orphanReclamationEligibleAtEpochMs: number | null;
	// host 自己发起了终止（孤儿回收）：随后的退出记录带上这个原因，新 runtime 据此补记回收账本。
	terminatedByHostReason: AgentSessionPtyHostHostedSessionTerminatedByHostReason | null;
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
	// 根退出与退出确认不代表后代已退出；升级窗口独立于会话记录保留，防止 host 提前退出丢掉 SIGKILL。
	private readonly hostedSessionKeysAwaitingProcessGroupSigkillEscalation = new Set<string>();

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
		if (
			Array.from(this.hostedSessionsByKey.values()).some(
				(session) =>
					session.exitRecord === null &&
					session.hostedSessionDescriptor.workspaceId === request.hostedSessionDescriptor.workspaceId &&
					session.hostedSessionDescriptor.taskId === request.hostedSessionDescriptor.taskId,
			)
		) {
			return {
				kind: "spawn_failed",
				errorCode: "DUPLICATE_RUNNING_CONVERSATION_SESSION",
				errorMessage: `该 workspace/conversation 已有活 hosted 会话：${request.hostedSessionDescriptor.workspaceId}/${request.hostedSessionDescriptor.taskId}`,
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
			orphanReclamationEligibleAtEpochMs: null,
			terminatedByHostReason: null,
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
				...(hostedSession.terminatedByHostReason !== null
					? { hostedSessionTerminatedByHostReason: hostedSession.terminatedByHostReason }
					: {}),
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
			hostedSession.ptyProcess.write(bytes);
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

	putHostedSessionAdoptionRecord(
		hostedSessionKey: string,
		adoptionRecord: unknown,
		orphanReclamationEligibleAtEpochMs: number | null,
	): void {
		const hostedSession = this.hostedSessionsByKey.get(hostedSessionKey);
		if (hostedSession) {
			hostedSession.adoptionRecord = adoptionRecord;
			// 尚未核对的 hook 可能改变回合/执行状态，迟到的记录不能重新授权离线回收。
			hostedSession.orphanReclamationEligibleAtEpochMs =
				hostedSession.hookSpoolEntries.length === 0 ? orphanReclamationEligibleAtEpochMs : null;
		}
	}

	// 仍在运行、带回收期限的会话里最早的那个期限；没有则 null。
	resolveEarliestOrphanReclamationEligibleAtAmongRunningHostedSessions(): number | null {
		let earliestEligibleAtEpochMs: number | null = null;
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			const eligibleAtEpochMs = hostedSession.orphanReclamationEligibleAtEpochMs;
			if (
				hostedSession.exitRecord !== null ||
				hostedSession.terminatedByHostReason !== null ||
				eligibleAtEpochMs === null
			) {
				continue;
			}
			if (earliestEligibleAtEpochMs === null || eligibleAtEpochMs < earliestEligibleAtEpochMs) {
				earliestEligibleAtEpochMs = eligibleAtEpochMs;
			}
		}
		return earliestEligibleAtEpochMs;
	}

	// 孤儿回收：调用方保证此刻没有 controller。终止期限已到、仍在运行的会话（进程组 SIGTERM，5s 后升级 SIGKILL），
	// 退出记录随后带 reclaimed_by_host_while_runtime_absent。返回本次被回收的会话。
	reclaimOrphanedHostedSessionsWhoseReclamationDeadlinePassed(
		nowEpochMs: number,
	): Array<{ hostedSessionKey: string; pid: number; orphanReclamationEligibleAtEpochMs: number }> {
		const reclaimedHostedSessions: Array<{
			hostedSessionKey: string;
			pid: number;
			orphanReclamationEligibleAtEpochMs: number;
		}> = [];
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			const eligibleAtEpochMs = hostedSession.orphanReclamationEligibleAtEpochMs;
			if (
				hostedSession.exitRecord !== null ||
				hostedSession.terminatedByHostReason !== null ||
				eligibleAtEpochMs === null ||
				nowEpochMs < eligibleAtEpochMs
			) {
				continue;
			}
			hostedSession.terminatedByHostReason = "reclaimed_by_host_while_runtime_absent";
			this.terminateRunningHostedSessionWithSigkillEscalation(hostedSession);
			reclaimedHostedSessions.push({
				hostedSessionKey: hostedSession.hostedSessionKey,
				pid: hostedSession.pid,
				orphanReclamationEligibleAtEpochMs: eligibleAtEpochMs,
			});
		}
		return reclaimedHostedSessions;
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
		// host 不解释 hook 状态；新证据让旧期限失效，调度与实际终止都读这个 null。
		// 即使 spool 已满，也不能用收到了但无法保留的新状态继续授权终止。
		hostedSession.orphanReclamationEligibleAtEpochMs = null;
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
		if (force) {
			terminatePtyProcessGroup(hostedSession.ptyProcess, { force: true });
		} else {
			// 在线全停会先逐条 stop，再发 terminate-all；根可能在两条消息之间退出并被确认。
			// 从首次软停止起就持有进程组升级，不能等第二条消息才登记。
			this.terminateRunningHostedSessionWithSigkillEscalation(hostedSession);
		}
	}

	// 终止全部仍在运行的会话：进程组 SIGTERM，5s 后仍未退出就升级 SIGKILL。返回被终止的会话数。
	terminateAllRunningHostedSessionsWithSigkillEscalation(): number {
		let terminatedHostedSessionCount = 0;
		for (const hostedSession of this.hostedSessionsByKey.values()) {
			if (hostedSession.exitRecord !== null) {
				continue;
			}
			terminatedHostedSessionCount += 1;
			this.terminateRunningHostedSessionWithSigkillEscalation(hostedSession);
		}
		return terminatedHostedSessionCount;
	}

	hasHostedSessionProcessGroupsAwaitingSigkillEscalation(): boolean {
		return this.hostedSessionKeysAwaitingProcessGroupSigkillEscalation.size > 0;
	}

	private terminateRunningHostedSessionWithSigkillEscalation(hostedSession: HostedSessionInsideHost): void {
		if (this.hostedSessionKeysAwaitingProcessGroupSigkillEscalation.has(hostedSession.hostedSessionKey)) return;
		this.hostedSessionKeysAwaitingProcessGroupSigkillEscalation.add(hostedSession.hostedSessionKey);
		// 暂停中的 PTY 读不到退出前的输出，也可能拖住退出事件；终止前先恢复读取。
		hostedSession.controllerRequestedOutputPause = false;
		this.applyEffectivePtyReadingPause(hostedSession);
		terminatePtyProcessGroup(hostedSession.ptyProcess, {
			escalateToSigkillAfterMs: SIGKILL_ESCALATION_DELAY_AFTER_HOSTED_SESSION_TERMINATION_MS,
			hasProcessExited: () => hostedSession.exitRecord !== null,
			escalateProcessGroupEvenAfterRootProcessExited: true,
			onSigkillEscalationAttemptCompleted: () => {
				this.hostedSessionKeysAwaitingProcessGroupSigkillEscalation.delete(hostedSession.hostedSessionKey);
				this.callbacks.onHostedSessionSetChanged();
			},
		});
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
			hostedSessionOrphanReclamationEligibleAtEpochMs: hostedSession.orphanReclamationEligibleAtEpochMs,
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
