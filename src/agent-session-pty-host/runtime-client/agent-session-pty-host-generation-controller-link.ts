// runtime 与「一个 generation 的 host」之间的 controller 链路：把该 host 推来的输出 / 退出路由到对应句柄。
//
// 每个 generation 的 host 各有自己的通道号空间，所以路由表按链路分开。

import type { AgentSessionPtyHostHostedSessionExitRecord } from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
import type { AgentSessionPtyHostControllerConnection } from "./agent-session-pty-host-controller-connection";
import type { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "./hosted-terminal-pty-process-handle-over-agent-session-pty-host";

// host 死掉（连接意外断开）时，它持有的 PTY master 随之关闭，agent 收到 SIGHUP。
const SIGHUP_SIGNAL_NUMBER = 1;
// 句柄登记之前到达的输出（spawn / attach 的响应与首批输出落在同一个 socket chunk 里时）按通道暂存。
// 追赶重放最多 2 MiB / 64 KiB = 32 帧，留足余量。
const MAXIMUM_OUTPUT_FRAMES_BUFFERED_PER_UNREGISTERED_CHANNEL = 256;

interface OutputFrameArrivedBeforeHandleRegistration {
	startByteOffset: number;
	bytes: Buffer;
}

export interface HostedSessionCatchUpOutputRouting {
	// 追赶区间 [catchUpStartByteOffset, catchUpEndByteOffset)：偏移落在区间内的帧是追赶重放，交给 onCatchUpOutput；
	// 其余是实时输出。起点不小于终点即空区间（runtime 缺席期间没有新输出且缓冲已空）。
	catchUpStartByteOffset: number;
	catchUpEndByteOffset: number;
	onCatchUpOutput: (bytes: Buffer) => void;
}

// 接管时持续生效的追赶路由：attach 响应之后的追赶帧分散在多个 socket data 事件里到达（host 按 64 KiB 分帧、多次 write），
// 必须逐帧按偏移分流，直到追赶区间全部交付才撤掉。
interface CatchUpOutputRoutingAwaitingFullDelivery {
	catchUpEndByteOffset: number;
	onCatchUpOutput: (bytes: Buffer) => void;
	resolveCatchUpRangeFullyDelivered: () => void;
	rejectBecauseConnectionClosedBeforeCatchUpRangeFullyDelivered: (error: Error) => void;
}

// 会话的 hook spool 与退出之间的先后：先排空 → 交付退出 → 确认退出 → 再读直到 host 不认识这条会话才注销目标
// （支持 spool 的 host 在确认退出时若 spool 非空会保留会话，等 spool 被确认清空再移除）。
export interface AgentSessionPtyHostGenerationControllerLinkHookSpoolCallbacks {
	onHostedSessionHookSpoolEntriesPending: (hostedSessionKey: string, pendingHookSpoolEntryCount: number) => void;
	// 只有登记了排空目标的会话（支持 spool 的 host 上、本 runtime spawn / 接管的）才走排空顺序；其余同步交付退出。
	isHostedSessionRegisteredAsHookSpoolDrainTarget: (hostedSessionKey: string) => boolean;
	drainHookSpoolBeforeDeliveringExit: (hostedSessionKey: string) => Promise<void>;
	drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget: (
		hostedSessionKey: string,
	) => Promise<void>;
	// 连接断开、本 runtime 再也操作不到这条会话：取消它的排空（在途 / 排队的排空不再应用、不再确认）。
	forgetHostedSessionHookSpoolDrainTarget: (hostedSessionKey: string) => void;
}

export class AgentSessionPtyHostGenerationControllerLink {
	private readonly handlesByChannelNumber = new Map<number, HostedTerminalPtyProcessHandleOverAgentSessionPtyHost>();
	private readonly handlesByHostedSessionKey = new Map<
		string,
		HostedTerminalPtyProcessHandleOverAgentSessionPtyHost
	>();
	private readonly outputFramesArrivedBeforeHandleRegistrationByChannelNumber = new Map<
		number,
		OutputFrameArrivedBeforeHandleRegistration[]
	>();
	private readonly exitRecordsArrivedBeforeHandleRegistrationByHostedSessionKey = new Map<
		string,
		AgentSessionPtyHostHostedSessionExitRecord
	>();
	private readonly catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber = new Map<
		number,
		CatchUpOutputRoutingAwaitingFullDelivery
	>();
	// 被拒绝接管、已下令终止的会话：退出一到就确认，不再交给任何人。
	private readonly hostedSessionKeysAcknowledgedOnExitWithoutHandle = new Set<string>();
	private runtimeIsClosingControllerConnections = false;

	constructor(
		readonly socketPath: string,
		readonly connection: AgentSessionPtyHostControllerConnection,
		private readonly warn: (message: string) => void,
		private readonly onLinkClosed: (link: AgentSessionPtyHostGenerationControllerLink) => void,
		private readonly hookSpoolCallbacks?: AgentSessionPtyHostGenerationControllerLinkHookSpoolCallbacks,
	) {
		connection.setEventHandlers({
			onHostedSessionHookSpoolEntriesPending: (hostedSessionKey, pendingHookSpoolEntryCount) =>
				this.hookSpoolCallbacks?.onHostedSessionHookSpoolEntriesPending(
					hostedSessionKey,
					pendingHookSpoolEntryCount,
				),
			onHostedSessionOutput: (hostedSessionChannelNumber, startByteOffset, bytes) =>
				this.routeHostedSessionOutputFrame(hostedSessionChannelNumber, startByteOffset, bytes),
			onHostedSessionExited: (hostedSessionKey, exitRecord) => {
				const handle = this.handlesByHostedSessionKey.get(hostedSessionKey);
				if (handle) {
					this.deliverExitToHandleAndAcknowledge(handle, exitRecord);
					return;
				}
				if (this.hostedSessionKeysAcknowledgedOnExitWithoutHandle.delete(hostedSessionKey)) {
					this.acknowledgeExitOfHostedSessionTerminatedAfterRefusedAdoption(hostedSessionKey);
					return;
				}
				this.exitRecordsArrivedBeforeHandleRegistrationByHostedSessionKey.set(hostedSessionKey, exitRecord);
			},
			onConnectionClosed: (closeReason) => this.handleConnectionClosed(closeReason),
		});
	}

	get registeredHandleCount(): number {
		return this.handlesByHostedSessionKey.size;
	}

	// 接管专用：先把追赶区间的帧全部交给 onCatchUpOutput，再登记句柄、交付登记前暂存的实时输出与退出。
	// 返回的 promise 在追赶区间全部交付且句柄已登记后 resolve（空区间立即登记）；追赶交付完之前连接断开则 reject——
	// 追赶不完整、屏幕还原不了，接管应当失败，而不是永远等下去。
	// 追赶字节绝不经 onData 进实时链路：那条链路会应答旧的终端查询、把旧输出当成「agent 刚刚产出」。
	async registerHandleAfterCatchUpOutputFullyDelivered(
		handle: HostedTerminalPtyProcessHandleOverAgentSessionPtyHost,
		catchUpOutputRouting: HostedSessionCatchUpOutputRouting,
	): Promise<void> {
		await this.routeCatchUpOutputUntilCatchUpRangeFullyDelivered(
			handle.hostedSessionChannelNumber,
			catchUpOutputRouting,
		);
		this.registerHandleAndDeliverEventsThatArrivedEarlier(handle);
	}

	registerHandleAndDeliverEventsThatArrivedEarlier(
		handle: HostedTerminalPtyProcessHandleOverAgentSessionPtyHost,
	): void {
		this.handlesByChannelNumber.set(handle.hostedSessionChannelNumber, handle);
		this.handlesByHostedSessionKey.set(handle.hostedSessionKey, handle);
		const earlierOutputFrames = this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.get(
			handle.hostedSessionChannelNumber,
		);
		this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.delete(handle.hostedSessionChannelNumber);
		for (const outputFrame of earlierOutputFrames ?? []) {
			handle.deliverHostedSessionOutput(outputFrame.startByteOffset, outputFrame.bytes);
		}
		const earlierExitRecord = this.exitRecordsArrivedBeforeHandleRegistrationByHostedSessionKey.get(
			handle.hostedSessionKey,
		);
		if (earlierExitRecord !== undefined) {
			this.exitRecordsArrivedBeforeHandleRegistrationByHostedSessionKey.delete(handle.hostedSessionKey);
			this.deliverExitToHandleAndAcknowledge(handle, earlierExitRecord);
		}
	}

	// spool 里可能还有该会话退出前的 hook 事件（最后一个 Stop 往往就在其中）：先排空、再交付退出、再确认，
	// 确认之后再读到 host 不认识这条会话为止（排空之后、确认之前才存进来的条目由 host 保留到被取走）。
	// 没有登记排空目标（旧 host、或 runtime 未接管）时同步交付，与没有 spool 时的时序一致。
	deliverExitToHandleAndAcknowledge(
		handle: HostedTerminalPtyProcessHandleOverAgentSessionPtyHost,
		exitRecord: AgentSessionPtyHostHostedSessionExitRecord,
	): void {
		this.handlesByChannelNumber.delete(handle.hostedSessionChannelNumber);
		this.handlesByHostedSessionKey.delete(handle.hostedSessionKey);
		const deliverExitThenAcknowledge = () => {
			handle.deliverHostedSessionExit({
				exitCode: exitRecord.exitCode,
				...(exitRecord.signal !== null ? { signal: exitRecord.signal } : {}),
			});
			this.connection.sendControlMessage({
				type: "acknowledge_hosted_session_exit",
				hostedSessionKey: handle.hostedSessionKey,
			});
		};
		const hookSpoolCallbacks = this.hookSpoolCallbacks;
		if (
			hookSpoolCallbacks === undefined ||
			!hookSpoolCallbacks.isHostedSessionRegisteredAsHookSpoolDrainTarget(handle.hostedSessionKey)
		) {
			deliverExitThenAcknowledge();
			return;
		}
		// 排空失败（连接断开、读超时）也照样交付退出：会话确实已经退出了，未取走的条目由 host 随会话保留。
		void hookSpoolCallbacks
			.drainHookSpoolBeforeDeliveringExit(handle.hostedSessionKey)
			.catch(() => undefined)
			.then(() => {
				deliverExitThenAcknowledge();
				// 读请求与刚发出的退出确认在同一连接上有序：读到的是确认之后的状态。
				void hookSpoolCallbacks.drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget(
					handle.hostedSessionKey,
				);
			});
	}

	terminateHostedSessionWithoutHandle(hostedSessionKey: string, alreadyExited: boolean): void {
		if (alreadyExited) {
			this.acknowledgeExitOfHostedSessionTerminatedAfterRefusedAdoption(hostedSessionKey);
			return;
		}
		this.hostedSessionKeysAcknowledgedOnExitWithoutHandle.add(hostedSessionKey);
		this.connection.sendControlMessage({ type: "stop_hosted_session", hostedSessionKey, force: true });
	}

	markRuntimeIsClosingControllerConnections(): void {
		this.runtimeIsClosingControllerConnections = true;
	}

	// 拒绝接管、已下令终止的会话：本 runtime 不为它排空 spool，显式要求 host 连同 spool 一并移除（host 记日志），
	// 否则支持 spool 的 host 会为它保留会话、等一个永远不会来的排空。
	private acknowledgeExitOfHostedSessionTerminatedAfterRefusedAdoption(hostedSessionKey: string): void {
		this.connection.sendControlMessage({
			type: "acknowledge_hosted_session_exit",
			hostedSessionKey,
			discardHookSpoolEntriesNotYetAcknowledgedTogetherWithHostedSession: true,
		});
	}

	// 一帧输出的去向，依次判定：追赶区间内 → onCatchUpOutput；已登记句柄 → 实时输出；否则暂存到句柄登记。
	private routeHostedSessionOutputFrame(
		hostedSessionChannelNumber: number,
		startByteOffset: number,
		bytes: Buffer,
	): void {
		const catchUpOutputRouting =
			this.catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber.get(hostedSessionChannelNumber);
		if (catchUpOutputRouting !== undefined) {
			// host 保证追赶帧不跨越终点、实时帧排在全部追赶帧之后，所以按帧起点判定即可。
			const frameIsCatchUpOutput = startByteOffset < catchUpOutputRouting.catchUpEndByteOffset;
			if (frameIsCatchUpOutput) {
				catchUpOutputRouting.onCatchUpOutput(bytes);
			}
			if (!frameIsCatchUpOutput || startByteOffset + bytes.byteLength >= catchUpOutputRouting.catchUpEndByteOffset) {
				// 追赶区间已全部交付（或已越过终点）：撤掉路由，之后的帧都是实时输出。
				this.catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber.delete(hostedSessionChannelNumber);
				catchUpOutputRouting.resolveCatchUpRangeFullyDelivered();
			}
			if (frameIsCatchUpOutput) {
				return;
			}
		}
		const handle = this.handlesByChannelNumber.get(hostedSessionChannelNumber);
		if (handle) {
			handle.deliverHostedSessionOutput(startByteOffset, bytes);
			return;
		}
		const bufferedFrames =
			this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.get(hostedSessionChannelNumber) ?? [];
		bufferedFrames.push({ startByteOffset, bytes });
		if (bufferedFrames.length > MAXIMUM_OUTPUT_FRAMES_BUFFERED_PER_UNREGISTERED_CHANNEL) {
			bufferedFrames.shift();
		}
		this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.set(hostedSessionChannelNumber, bufferedFrames);
	}

	// 装上追赶路由，并把登记前已暂存的帧（attach 响应与首批追赶帧落在同一个 socket chunk 里时）按同一规则重新分流：
	// 追赶帧交给 onCatchUpOutput，实时帧按原顺序留在暂存里等句柄登记。
	private routeCatchUpOutputUntilCatchUpRangeFullyDelivered(
		hostedSessionChannelNumber: number,
		catchUpOutputRouting: HostedSessionCatchUpOutputRouting,
	): Promise<void> {
		if (catchUpOutputRouting.catchUpStartByteOffset >= catchUpOutputRouting.catchUpEndByteOffset) {
			return Promise.resolve();
		}
		if (this.connection.isClosed) {
			return Promise.reject(
				new Error("agent session pty host connection closed before catch-up output was fully delivered"),
			);
		}
		const catchUpRangeFullyDelivered = new Promise<void>((resolve, reject) => {
			this.catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber.set(hostedSessionChannelNumber, {
				catchUpEndByteOffset: catchUpOutputRouting.catchUpEndByteOffset,
				onCatchUpOutput: catchUpOutputRouting.onCatchUpOutput,
				resolveCatchUpRangeFullyDelivered: resolve,
				rejectBecauseConnectionClosedBeforeCatchUpRangeFullyDelivered: reject,
			});
		});
		const earlierOutputFrames =
			this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.get(hostedSessionChannelNumber) ?? [];
		this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.delete(hostedSessionChannelNumber);
		for (const outputFrame of earlierOutputFrames) {
			this.routeHostedSessionOutputFrame(hostedSessionChannelNumber, outputFrame.startByteOffset, outputFrame.bytes);
		}
		return catchUpRangeFullyDelivered;
	}

	// 连接意外断开：host 死了（agent 已随 PTY master 关闭收到 SIGHUP），或被另一个 runtime 顶替了 controller。
	// 两种情形下本 runtime 都再也操作不到这些会话，只能按退出处理。
	private handleConnectionClosed(closeReason: "controller_superseded" | "connection_closed"): void {
		this.onLinkClosed(this);
		// 等追赶的接管无论如何都要结束等待（含 runtime 主动关闭连接时），否则接管永久挂起。
		const catchUpOutputRoutingsNeverFullyDelivered = [
			...this.catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber.values(),
		];
		this.catchUpOutputRoutingsAwaitingFullDeliveryByChannelNumber.clear();
		for (const catchUpOutputRouting of catchUpOutputRoutingsNeverFullyDelivered) {
			catchUpOutputRouting.rejectBecauseConnectionClosedBeforeCatchUpRangeFullyDelivered(
				new Error(
					`agent session pty host connection ${this.socketPath} closed (${closeReason}) before catch-up output was fully delivered`,
				),
			);
		}
		if (this.runtimeIsClosingControllerConnections) {
			return;
		}
		const orphanedHandles = [...this.handlesByHostedSessionKey.values()];
		this.handlesByChannelNumber.clear();
		this.handlesByHostedSessionKey.clear();
		this.outputFramesArrivedBeforeHandleRegistrationByChannelNumber.clear();
		this.exitRecordsArrivedBeforeHandleRegistrationByHostedSessionKey.clear();
		if (orphanedHandles.length > 0) {
			this.warn(
				`agent session pty host connection ${this.socketPath} closed (${closeReason}); ${orphanedHandles.length} hosted session(s) are no longer controllable by this runtime`,
			);
		}
		for (const handle of orphanedHandles) {
			this.hookSpoolCallbacks?.forgetHostedSessionHookSpoolDrainTarget(handle.hostedSessionKey);
			handle.deliverHostedSessionExit({ exitCode: 128 + SIGHUP_SIGNAL_NUMBER, signal: SIGHUP_SIGNAL_NUMBER });
		}
	}
}
