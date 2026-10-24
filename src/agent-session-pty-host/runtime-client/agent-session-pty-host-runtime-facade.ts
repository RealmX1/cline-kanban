// runtime 侧 agent session PTY host 的总入口：
// - 启动时发现本 runtime 身份下各 generation 的 host，逐个以 controller 身份连上，列出仍在跑的会话，
//   整理成按 workspace 分组的接管候选（新 runtime 在 listen 之前把它们装回 session-manager）；
// - 旧 generation 的 host 令其「排空后退休」：继续服务存量会话，不再接新 spawn；
// - 为每个 workspace 提供 HostedTerminalPtyProcessSpawner，新会话一律进当前 generation 的 host；
//   唯一例外：启动时当前 generation 拉不起来而旧 generation 有会话待接管，此后新会话降级为进程内 PTY（见 start）；
// - 本 runtime spawn / 接管的会话，其 hook spool（runtime 缺席期间存进 host 的 hook 事件）经
//   HostedSessionHookSpoolDrainCoordinator 按序应用回 hooks ingest。

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { PtySession } from "../../terminal/pty-session";
import type {
	HostedTerminalPtyProcessSpawner,
	HostedTerminalPtyProcessSpawnRequest,
	HostedTerminalPtySessionAdoptionCandidate,
	TerminalPtyProcessHandle,
} from "../../terminal/terminal-pty-process-handle";
import type { AgentSessionPtyHostHostedSessionListing } from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
import {
	type CurrentBuildAgentSessionPtyHostDescriptor,
	resolveCurrentBuildAgentSessionPtyHostDescriptor,
} from "./agent-session-pty-host-build-identity-and-launch-command";
import {
	AgentSessionPtyHostControllerConnection,
	AgentSessionPtyHostUnreachableError,
} from "./agent-session-pty-host-controller-connection";
import {
	type AgentSessionPtyHostDetachedLaunchRequest,
	launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections,
} from "./agent-session-pty-host-detached-process-launcher";
import { AgentSessionPtyHostGenerationControllerLink } from "./agent-session-pty-host-generation-controller-link";
import {
	type AgentSessionPtyHostRuntimeIdentity,
	listAgentSessionPtyHostGenerationSocketPaths,
	resolveAgentSessionPtyHostLogFilePath,
	resolveAgentSessionPtyHostSocketPath,
} from "./agent-session-pty-host-socket-path-for-runtime-identity";
import {
	AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
	AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
} from "./hosted-session-cli-client-requests-to-agent-session-pty-host";
import {
	HostedSessionHookSpoolDrainCoordinator,
	type HostedSessionHookSpoolDrainCoordinatorOptions,
	recordSpooledHookEventDroppedToHookDeliveryFailureLog,
	type SpooledHookIngestRequestApplier,
} from "./hosted-session-hook-spool-drain-coordinator";
import { HostedTerminalPtyProcessHandleOverAgentSessionPtyHost } from "./hosted-terminal-pty-process-handle-over-agent-session-pty-host";

// EXPERIMENT_NODE: spool 读请求的应答期限。host 只是读内存里的数组，正常亚毫秒级；直投 hook 与退出交付都在等这次读，
// 期限必须明显短于 hooks CLI 单次投递超时（3.5s），超时 fail-open（直投照常应用、退出照常交付，条目留在 host）。
const HOOK_SPOOL_READ_RESPONSE_DEADLINE_MILLISECONDS = 1_500;

// 支持 hook spool 的 host 在 listing 里总会带 pendingHookSpoolEntryCount（哪怕是 0）；旧 build（P2）的 host 不带，
// 也不认 spool 读请求（只会等满请求期限）——不为它们的会话登记排空目标。
function hostedSessionListingComesFromHostThatSupportsHookSpool(
	listing: AgentSessionPtyHostHostedSessionListing,
): boolean {
	return typeof listing.pendingHookSpoolEntryCount === "number";
}

// 一个 host 活着（socket 有人监听）却不应答握手 / 请求：它手里可能还有会话，本 runtime 既接管不了、
// 也不能当它们不存在（旧路径会把会话归零、前端随后再起第二个 agent）。启动必须失败，交给 supervisor 重试。
export class AgentSessionPtyHostPreventsSafeRuntimeStartupError extends Error {}

export interface AgentSessionPtyHostRuntimeFacadeOptions {
	runtimeIdentity: AgentSessionPtyHostRuntimeIdentity;
	warn: (message: string) => void;
	// 测试注入：缺省按当前 build 计算。
	currentBuildHostDescriptor?: CurrentBuildAgentSessionPtyHostDescriptor;
	hostIdleExitAfterMilliseconds?: number;
	// 测试注入：缺省以 detached + --daemonize 拉起。测试永不 daemonize host。
	launchHostAndWaitUntilSocketAcceptsConnections?: (
		request: AgentSessionPtyHostDetachedLaunchRequest,
	) => Promise<void>;
	// 测试注入：缺省写 hooks CLI 同一份持久丢投记录（~/.cline/kanban/agent-hook-delivery-failures/）。
	recordSpooledHookEventDroppedAfterApplyRetriesExhausted?: HostedSessionHookSpoolDrainCoordinatorOptions["recordSpooledHookEventDroppedAfterApplyRetriesExhausted"];
	waitBeforeRetryingSpooledHookEventApply?: HostedSessionHookSpoolDrainCoordinatorOptions["waitBeforeRetryingSpooledHookEventApply"];
}

export interface HostedTerminalPtySessionAdoptionCandidatesOfWorkspace {
	workspaceId: string;
	// spawn 时记下的 workspace 仓库路径；没有记下时由调用方按 workspace 索引补。
	workspaceRepositoryPath: string | null;
	adoptionCandidates: HostedTerminalPtySessionAdoptionCandidate[];
}

// 一条接管候选在本 runtime 里的处置进度。只有「已接管」与「已下令终止」算有着落，
// 其余状态都列进 warnAboutHostedSessionsNotAdoptedDuringStartup 的名单（如实反映「既未接管也未终止」）。
type HostedSessionAdoptionCandidateDispositionState =
	// 尚未处理：可接管，也可拒绝并终止。
	| "awaiting_adoption_or_refusal"
	// attach 请求 / 追赶交付在途：拒绝并发与重复接管；此时的终止请求不生效，接管失败后由拒绝路径再发。
	| "adoption_output_stream_attach_in_progress"
	// attach 被拒（unknown_hosted_session）、请求超时、或追赶交付完之前连接断开：不可再接管，等拒绝路径下令终止。
	| "adoption_output_stream_attach_failed_awaiting_termination"
	// 句柄已交给 session-manager，之后的停止经句柄完成。
	| "adopted_with_handle_owned_by_terminal_session_manager"
	| "terminated_after_refused_adoption"
	// 拒绝接管时该 generation 的连接已断开，stop 发不出去：会话既未接管也未终止。
	| "refused_adoption_but_termination_undeliverable_because_host_connection_closed";

interface PendingAdoptionCandidateBookkeeping {
	link: AgentSessionPtyHostGenerationControllerLink;
	listing: AgentSessionPtyHostHostedSessionListing;
	dispositionState: HostedSessionAdoptionCandidateDispositionState;
}

export class AgentSessionPtyHostRuntimeFacade {
	private readonly generationLinksBySocketPath = new Map<string, AgentSessionPtyHostGenerationControllerLink>();
	private connectingToCurrentGeneration: Promise<AgentSessionPtyHostGenerationControllerLink> | null = null;
	private readonly adoptionCandidatesOfWorkspaces: HostedTerminalPtySessionAdoptionCandidatesOfWorkspace[] = [];
	private readonly pendingAdoptionCandidateBookkeeping: PendingAdoptionCandidateBookkeeping[] = [];
	// 启动时当前 build 的 host 拉不起来、但旧 generation 里有会话待接管时置位（之后不再复位）：
	// 此后凡当前 generation 未连上的 spawn 都降级为进程内 PtySession，并在后台再试连接当前 generation。
	private newSpawnsFallBackToInProcessPtySessionWhileCurrentGenerationHostIsUnreachable = false;
	private readonly hostedSessionHookSpoolDrainCoordinator: HostedSessionHookSpoolDrainCoordinator;

	private constructor(
		private readonly options: AgentSessionPtyHostRuntimeFacadeOptions,
		private readonly currentBuildHostDescriptor: CurrentBuildAgentSessionPtyHostDescriptor,
	) {
		this.hostedSessionHookSpoolDrainCoordinator = new HostedSessionHookSpoolDrainCoordinator({
			warn: options.warn,
			recordSpooledHookEventDroppedAfterApplyRetriesExhausted:
				options.recordSpooledHookEventDroppedAfterApplyRetriesExhausted ??
				recordSpooledHookEventDroppedToHookDeliveryFailureLog,
			waitBeforeRetryingSpooledHookEventApply: options.waitBeforeRetryingSpooledHookEventApply,
		});
	}

	static async start(options: AgentSessionPtyHostRuntimeFacadeOptions): Promise<AgentSessionPtyHostRuntimeFacade> {
		const facade = new AgentSessionPtyHostRuntimeFacade(
			options,
			options.currentBuildHostDescriptor ?? resolveCurrentBuildAgentSessionPtyHostDescriptor(),
		);
		await facade.connectToEveryGenerationHostAndCollectAdoptionCandidates();
		try {
			await facade.ensureConnectedToCurrentGenerationHost();
		} catch (error) {
			// 没有待接管的会话：没什么可保住的，照旧抛出，由调用方整体退回进程内 PTY。
			if (facade.pendingAdoptionCandidateBookkeeping.length === 0) {
				throw error;
			}
			// 旧 generation 里有会话：此时丢掉 facade 就是丢掉它们（卡片按无活进程归零，前端自动续跑再起第二个 agent）。
			// 照常交出 facade，经旧 generation 链路完成接管；新会话降级为进程内 PTY，热重启后不再存活。
			facade.newSpawnsFallBackToInProcessPtySessionWhileCurrentGenerationHostIsUnreachable = true;
			options.warn(
				`agent session pty host for the current build could not start (${error instanceof Error ? error.message : String(error)}); adopting ${facade.pendingAdoptionCandidateBookkeeping.length} agent session(s) from older agent session pty host generations, but new agent sessions fall back to in-process PTY and end when this runtime exits until the current build's host becomes reachable`,
			);
		}
		return facade;
	}

	get currentGenerationSocketPath(): string {
		return resolveAgentSessionPtyHostSocketPath(
			this.options.runtimeIdentity,
			this.currentBuildHostDescriptor.hostBuildIdentity,
		);
	}

	listHostedTerminalPtySessionAdoptionCandidatesByWorkspace(): readonly HostedTerminalPtySessionAdoptionCandidatesOfWorkspace[] {
		return this.adoptionCandidatesOfWorkspaces;
	}

	// 取走即消费：同一 workspace 的 terminal manager 只加载一次，候选只该被接管一次。
	takeHostedTerminalPtySessionAdoptionCandidatesForWorkspace(
		workspaceId: string,
	): HostedTerminalPtySessionAdoptionCandidate[] {
		const candidatesOfWorkspace = this.adoptionCandidatesOfWorkspaces.find(
			(entry) => entry.workspaceId === workspaceId,
		);
		if (!candidatesOfWorkspace) {
			return [];
		}
		return candidatesOfWorkspace.adoptionCandidates.splice(0);
	}

	// 接管阶段结束后调用：列出既没被接管、也没被终止的会话——没有被任何 workspace 接走的（例如其 workspace 加载失败
	// 或已被移除），以及拒绝接管时连接已断开、终止发不出去的。
	// 刻意不自动终止——杀掉一个活着的 agent 不可撤销；它们留在 host 里照常运行，下次 runtime 重启时再尝试接管，
	// 或由显式全停命令 / 孤儿回收（计划 P4）处理。
	warnAboutHostedSessionsNotAdoptedDuringStartup(): number {
		const unadoptedBookkeeping = this.pendingAdoptionCandidateBookkeeping.filter(
			(bookkeeping) =>
				bookkeeping.dispositionState !== "adopted_with_handle_owned_by_terminal_session_manager" &&
				bookkeeping.dispositionState !== "terminated_after_refused_adoption",
		);
		if (unadoptedBookkeeping.length > 0) {
			this.options.warn(
				`${unadoptedBookkeeping.length} hosted agent session(s) were neither adopted nor terminated after runtime restart and are left to their agent session pty host: ${unadoptedBookkeeping
					.map(
						(bookkeeping) =>
							`${bookkeeping.listing.hostedSessionDescriptor.workspaceId}/${bookkeeping.listing.hostedSessionDescriptor.taskId} pid=${bookkeeping.listing.pid} state=${bookkeeping.dispositionState}`,
					)
					.join(", ")}`,
			);
		}
		return unadoptedBookkeeping.length;
	}

	createHostedTerminalPtyProcessSpawnerForWorkspace(
		workspaceId: string,
		workspaceRepositoryPath: string | null,
	): HostedTerminalPtyProcessSpawner {
		return {
			spawnHostedTerminalPtyProcess: (request) =>
				this.spawnHostedTerminalPtyProcess(workspaceId, workspaceRepositoryPath, request),
		};
	}

	// runtime server 建好 hooks ingest 之后绑定：此前 spool 的排空请求都在等它。
	bindSpooledHookIngestRequestApplier(spooledHookIngestRequestApplier: SpooledHookIngestRequestApplier): void {
		this.hostedSessionHookSpoolDrainCoordinator.bindSpooledHookIngestRequestApplier(spooledHookIngestRequestApplier);
	}

	// 直投 hook 应用前调用，保证同一会话里 spool 的事件先于直投的事件被应用（该 task 有已登记的排空目标时，
	// 至少等一次在此之后发出的 spool 读；同时到来的直投共享同一次读）。
	drainPendingHookSpoolEntriesBeforeDirectHookIngest(workspaceId: string, taskId: string): Promise<void> {
		return this.hostedSessionHookSpoolDrainCoordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest(
			workspaceId,
			taskId,
		);
	}

	// runtime 退出前调用：把已排队的 stop / 接管记录等消息写进内核再断开。
	async closeControllerConnectionsAfterFlushingPendingFrames(): Promise<void> {
		const links = [...this.generationLinksBySocketPath.values()];
		for (const link of links) {
			link.markRuntimeIsClosingControllerConnections();
		}
		await Promise.all(links.map((link) => link.connection.closeAfterFlushingPendingFrames()));
	}

	private async spawnHostedTerminalPtyProcess(
		workspaceId: string,
		workspaceRepositoryPath: string | null,
		request: HostedTerminalPtyProcessSpawnRequest,
	): Promise<TerminalPtyProcessHandle> {
		if (
			this.newSpawnsFallBackToInProcessPtySessionWhileCurrentGenerationHostIsUnreachable &&
			!this.isConnectedToCurrentGenerationHost()
		) {
			// 不在这里 await 重试：拉起失败要等满 launcher 的就绪期限，每次新会话都会被拖慢这么久。
			this.retryConnectingToCurrentGenerationHostInBackgroundForLaterSpawns();
			return this.spawnInProcessPtySessionWhileCurrentGenerationHostIsUnreachable(request);
		}
		const link = await this.ensureConnectedToCurrentGenerationHost();
		const hostedSessionKey = randomUUID();
		const environmentWithoutUndefinedValues: Record<string, string> = {};
		for (const [environmentKey, environmentValue] of Object.entries(request.env)) {
			if (environmentValue !== undefined) {
				environmentWithoutUndefinedValues[environmentKey] = environmentValue;
			}
		}
		// 会话里的 hooks CLI 在 runtime 不可达时凭它们直连 host，把事件存进这条会话的 spool。
		environmentWithoutUndefinedValues[AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME] = link.socketPath;
		environmentWithoutUndefinedValues[AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME] =
			hostedSessionKey;
		const outcome = await link.connection.requestSpawnHostedSession({
			hostedSessionKey,
			hostedSessionDescriptor: {
				workspaceId,
				...(workspaceRepositoryPath !== null ? { workspaceRepositoryPath } : {}),
				taskId: request.taskId,
				hostedSessionKind: request.hostedSessionKind,
			},
			binary: request.binary,
			args: request.args,
			cwd: request.cwd,
			env: environmentWithoutUndefinedValues,
			// 与 PtySession.spawn 同一取法；buildTerminalEnvironment 总会写入 TERM。
			terminalName: environmentWithoutUndefinedValues.TERM?.trim() || "xterm-256color",
			cols: request.cols,
			rows: request.rows,
		});
		if (outcome.kind === "spawn_failed") {
			const spawnError = new Error(outcome.errorMessage) as NodeJS.ErrnoException;
			spawnError.code = outcome.errorCode;
			throw spawnError;
		}
		const handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
			link.connection,
			hostedSessionKey,
			outcome.hostedSessionChannelNumber,
			outcome.pid,
			request.onData,
			request.onExit,
			outcome.spawnedAtEpochMs,
		);
		// 新会话只进当前 build 的 host，它一定支持 spool。登记即请求一次读（不靠 0 计数跳过）。
		this.registerHookSpoolDrainTargetHostedSession(link, hostedSessionKey, workspaceId, request.taskId);
		link.registerHandleAndDeliverEventsThatArrivedEarlier(handle);
		return handle;
	}

	private registerHookSpoolDrainTargetHostedSession(
		link: AgentSessionPtyHostGenerationControllerLink,
		hostedSessionKey: string,
		workspaceId: string,
		taskId: string,
	): void {
		this.hostedSessionHookSpoolDrainCoordinator.registerHookSpoolDrainTargetHostedSession({
			hostedSessionKey,
			workspaceId,
			taskId,
			readHookSpoolEntries: async () => {
				const outcome = await link.connection.requestReadHostedSessionHookSpoolEntries(
					hostedSessionKey,
					HOOK_SPOOL_READ_RESPONSE_DEADLINE_MILLISECONDS,
				);
				return outcome.kind === "read" ? outcome.hookSpoolEntries : null;
			},
			acknowledgeHookSpoolEntriesThrough: (throughHookSpoolEntrySequenceNumber) =>
				link.connection.acknowledgeHostedSessionHookSpoolEntries(
					hostedSessionKey,
					throughHookSpoolEntrySequenceNumber,
				),
		});
	}

	// 上一个 runtime 已交付并确认了这条会话的退出，但当时 spool 非空、host 把会话留着等排空（随后 runtime 崩溃 / 重启）。
	// 它不是接管候选（退出已交付过）；只把 spool 排空，读到 host 移除会话为止。
	private drainHookSpoolOfHostedSessionWhoseExitWasAlreadyAcknowledged(
		link: AgentSessionPtyHostGenerationControllerLink,
		listing: AgentSessionPtyHostHostedSessionListing,
	): void {
		this.registerHookSpoolDrainTargetHostedSession(
			link,
			listing.hostedSessionKey,
			listing.hostedSessionDescriptor.workspaceId,
			listing.hostedSessionDescriptor.taskId,
		);
		void this.hostedSessionHookSpoolDrainCoordinator.drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget(
			listing.hostedSessionKey,
		);
	}

	private buildAdoptionCandidate(
		link: AgentSessionPtyHostGenerationControllerLink,
		listing: AgentSessionPtyHostHostedSessionListing,
	): HostedTerminalPtySessionAdoptionCandidate {
		const bookkeeping: PendingAdoptionCandidateBookkeeping = {
			link,
			listing,
			dispositionState: "awaiting_adoption_or_refusal",
		};
		this.pendingAdoptionCandidateBookkeeping.push(bookkeeping);
		return {
			taskId: listing.hostedSessionDescriptor.taskId,
			hostedSessionKind: listing.hostedSessionDescriptor.hostedSessionKind,
			pid: listing.pid,
			spawnedAtEpochMs: listing.spawnedAtEpochMs,
			cols: listing.cols,
			rows: listing.rows,
			exitedWhileRuntimeWasAbsent: listing.exitRecord !== null,
			terminalSessionAdoptionRecord: listing.adoptionRecord,
			adoptHostedTerminalPtyProcess: async (callbacks) => {
				if (bookkeeping.dispositionState !== "awaiting_adoption_or_refusal") {
					throw new Error(
						`hosted session ${listing.hostedSessionKey} cannot be adopted again (${bookkeeping.dispositionState})`,
					);
				}
				bookkeeping.dispositionState = "adoption_output_stream_attach_in_progress";
				let handle: HostedTerminalPtyProcessHandleOverAgentSessionPtyHost;
				try {
					// EXPERIMENT_NODE: 崩溃路径从环形缓冲起点重放；计划内 handover 改为从 checkpoint 偏移续流（计划 P4）。
					const attachOutcome = await link.connection.requestAttachHostedSessionOutputStream(
						listing.hostedSessionKey,
						listing.retainedOutputStartByteOffset,
					);
					if (attachOutcome.kind !== "attached") {
						throw new Error(`hosted session ${listing.hostedSessionKey} disappeared before adoption`);
					}
					handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
						link.connection,
						listing.hostedSessionKey,
						listing.hostedSessionChannelNumber,
						listing.pid,
						callbacks.onData,
						callbacks.onExit,
						listing.spawnedAtEpochMs,
					);
					// 先于句柄登记：登记时交付的退出（接管期间进程退出）也要等 spool 排空。
					// 登记即请求一次读（应用函数绑定后发出），不信 listing 里较早的计数：listing 之后存进来的条目也要取走。
					if (hostedSessionListingComesFromHostThatSupportsHookSpool(listing)) {
						this.registerHookSpoolDrainTargetHostedSession(
							link,
							listing.hostedSessionKey,
							listing.hostedSessionDescriptor.workspaceId,
							listing.hostedSessionDescriptor.taskId,
						);
					}
					// 追赶帧在 attach 响应之后分多个 socket data 事件到达：必须等追赶区间全部交给 onCatchUpOutput 再返回句柄，
					// 否则调用方会在屏幕还原完成前读屏、开查询应答，晚到的追赶字节也会被当成实时输出。
					await link.registerHandleAfterCatchUpOutputFullyDelivered(handle, {
						catchUpStartByteOffset: attachOutcome.catchUpStartByteOffset,
						catchUpEndByteOffset: attachOutcome.catchUpEndByteOffset,
						onCatchUpOutput: callbacks.onCatchUpOutput,
					});
				} catch (error) {
					// 没接管成功：退回可终止状态，调用方随后的拒绝路径才能真正发出终止
					// （连接已断开、发不出去时，会话如实留在未接管名单里）。
					// 注销即取消：登记时已排队的排空不得再应用 / 确认它的 spool——会话没被接管，spool 留在 host 里
					// （下次成功接管时取走；被拒绝并终止时随退出确认一并丢弃，host 记日志）。
					bookkeeping.dispositionState = "adoption_output_stream_attach_failed_awaiting_termination";
					this.hostedSessionHookSpoolDrainCoordinator.forgetHookSpoolDrainTargetHostedSession(
						listing.hostedSessionKey,
					);
					throw error;
				}
				bookkeeping.dispositionState = "adopted_with_handle_owned_by_terminal_session_manager";
				if (listing.exitRecord !== null) {
					link.deliverExitToHandleAndAcknowledge(handle, listing.exitRecord);
				}
				return handle;
			},
			terminateHostedTerminalPtyProcessAfterRefusedAdoption: () => {
				if (
					bookkeeping.dispositionState !== "awaiting_adoption_or_refusal" &&
					bookkeeping.dispositionState !== "adoption_output_stream_attach_failed_awaiting_termination"
				) {
					return;
				}
				if (link.connection.isClosed) {
					bookkeeping.dispositionState =
						"refused_adoption_but_termination_undeliverable_because_host_connection_closed";
					return;
				}
				bookkeeping.dispositionState = "terminated_after_refused_adoption";
				link.terminateHostedSessionWithoutHandle(listing.hostedSessionKey, listing.exitRecord !== null);
			},
		};
	}

	private recordAdoptionCandidate(
		link: AgentSessionPtyHostGenerationControllerLink,
		listing: AgentSessionPtyHostHostedSessionListing,
	): void {
		const descriptor = listing.hostedSessionDescriptor;
		let candidatesOfWorkspace = this.adoptionCandidatesOfWorkspaces.find(
			(entry) => entry.workspaceId === descriptor.workspaceId,
		);
		if (!candidatesOfWorkspace) {
			candidatesOfWorkspace = {
				workspaceId: descriptor.workspaceId,
				workspaceRepositoryPath: descriptor.workspaceRepositoryPath ?? null,
				adoptionCandidates: [],
			};
			this.adoptionCandidatesOfWorkspaces.push(candidatesOfWorkspace);
		}
		candidatesOfWorkspace.workspaceRepositoryPath ??= descriptor.workspaceRepositoryPath ?? null;
		candidatesOfWorkspace.adoptionCandidates.push(this.buildAdoptionCandidate(link, listing));
	}

	private async connectToEveryGenerationHostAndCollectAdoptionCandidates(): Promise<void> {
		const currentGenerationSocketPath = this.currentGenerationSocketPath;
		for (const generationSocketPath of listAgentSessionPtyHostGenerationSocketPaths(this.options.runtimeIdentity)) {
			let connection: AgentSessionPtyHostControllerConnection;
			try {
				connection = await AgentSessionPtyHostControllerConnection.connectAsController(generationSocketPath);
			} catch (error) {
				if (error instanceof AgentSessionPtyHostUnreachableError && error.noHostIsListening) {
					// host 已死、socket 文件残留；它的会话随它一起结束了。当前 generation 的残留由新 host 绑定时自行清理。
					if (generationSocketPath !== currentGenerationSocketPath) {
						try {
							unlinkSync(generationSocketPath);
						} catch {
							// 已被删除。
						}
					}
					continue;
				}
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
					`agent session pty host at ${generationSocketPath} is alive but not responding; refusing to start so its agent sessions are neither lost nor duplicated: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const link = this.registerGenerationLink(generationSocketPath, connection);
			let hostedSessions: AgentSessionPtyHostHostedSessionListing[];
			try {
				hostedSessions = await connection.requestListHostedSessions();
			} catch (error) {
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
					`agent session pty host at ${generationSocketPath} did not list its sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			for (const listing of hostedSessions) {
				if (listing.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged === true) {
					this.drainHookSpoolOfHostedSessionWhoseExitWasAlreadyAcknowledged(link, listing);
					continue;
				}
				this.recordAdoptionCandidate(link, listing);
			}
			if (generationSocketPath !== currentGenerationSocketPath) {
				// 旧 generation：继续服务存量会话（接管后照常经这条链路收发），不再接新 spawn，排空后自行退出。
				connection.sendControlMessage({ type: "retire_when_drained" });
			}
		}
	}

	private registerGenerationLink(
		socketPath: string,
		connection: AgentSessionPtyHostControllerConnection,
	): AgentSessionPtyHostGenerationControllerLink {
		const coordinator = this.hostedSessionHookSpoolDrainCoordinator;
		const link = new AgentSessionPtyHostGenerationControllerLink(
			socketPath,
			connection,
			this.options.warn,
			(closedLink) => {
				if (this.generationLinksBySocketPath.get(closedLink.socketPath) === closedLink) {
					this.generationLinksBySocketPath.delete(closedLink.socketPath);
				}
			},
			{
				onHostedSessionHookSpoolEntriesPending: (hostedSessionKey, pendingHookSpoolEntryCount) =>
					coordinator.noteHookSpoolEntriesPending(hostedSessionKey, pendingHookSpoolEntryCount),
				isHostedSessionRegisteredAsHookSpoolDrainTarget: (hostedSessionKey) =>
					coordinator.isHostedSessionRegisteredAsHookSpoolDrainTarget(hostedSessionKey),
				drainHookSpoolBeforeDeliveringExit: (hostedSessionKey) =>
					coordinator.drainHookSpoolBeforeDeliveringExit(hostedSessionKey),
				drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget: (hostedSessionKey) =>
					coordinator.drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget(
						hostedSessionKey,
					),
				forgetHostedSessionHookSpoolDrainTarget: (hostedSessionKey) =>
					coordinator.forgetHookSpoolDrainTargetHostedSession(hostedSessionKey),
			},
		);
		this.generationLinksBySocketPath.set(socketPath, link);
		return link;
	}

	private ensureConnectedToCurrentGenerationHost(): Promise<AgentSessionPtyHostGenerationControllerLink> {
		const existingLink = this.generationLinksBySocketPath.get(this.currentGenerationSocketPath);
		if (existingLink && !existingLink.connection.isClosed) {
			return Promise.resolve(existingLink);
		}
		if (this.connectingToCurrentGeneration === null) {
			this.connectingToCurrentGeneration = this.connectToCurrentGenerationHostLaunchingItIfNeeded().finally(() => {
				this.connectingToCurrentGeneration = null;
			});
		}
		return this.connectingToCurrentGeneration;
	}

	private async connectToCurrentGenerationHostLaunchingItIfNeeded(): Promise<AgentSessionPtyHostGenerationControllerLink> {
		const socketPath = this.currentGenerationSocketPath;
		let connection: AgentSessionPtyHostControllerConnection;
		try {
			connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
		} catch (error) {
			if (!(error instanceof AgentSessionPtyHostUnreachableError) || !error.noHostIsListening) {
				throw error;
			}
			const launchHostAndWaitUntilSocketAcceptsConnections =
				this.options.launchHostAndWaitUntilSocketAcceptsConnections ??
				launchDetachedAgentSessionPtyHostAndWaitUntilSocketAcceptsConnections;
			await launchHostAndWaitUntilSocketAcceptsConnections({
				launchCommand: this.currentBuildHostDescriptor.launchCommand,
				socketPath,
				hostBuildIdentity: this.currentBuildHostDescriptor.hostBuildIdentity,
				hostLogFilePath: resolveAgentSessionPtyHostLogFilePath(this.options.runtimeIdentity),
				hostWorkingDirectoryPath: this.options.runtimeIdentity.runtimeHomeDirectoryPath,
				idleExitAfterMilliseconds: this.options.hostIdleExitAfterMilliseconds,
			});
			connection = await AgentSessionPtyHostControllerConnection.connectAsController(socketPath);
		}
		return this.registerGenerationLink(socketPath, connection);
	}

	private isConnectedToCurrentGenerationHost(): boolean {
		const currentGenerationLink = this.generationLinksBySocketPath.get(this.currentGenerationSocketPath);
		return currentGenerationLink !== undefined && !currentGenerationLink.connection.isClosed;
	}

	// 已有一次连接在途时不重复发起；成功之后的 spawn 恢复进当前 generation 的 host。
	private retryConnectingToCurrentGenerationHostInBackgroundForLaterSpawns(): void {
		if (this.connectingToCurrentGeneration !== null) {
			return;
		}
		void this.ensureConnectedToCurrentGenerationHost().then(
			() => {
				this.options.warn(
					"agent session pty host for the current build is reachable again; new agent sessions run in it again and survive runtime restarts",
				);
			},
			() => {
				// 仍连不上：本次会话已在进程内起好，下一次 spawn 再试。降级时已告警过一次，不逐次刷屏。
			},
		);
	}

	// 与 session-manager 非 host 模式的 PtySession.spawn 同形；只缺 hosted 请求里不携带的启动请求归因字段。
	private spawnInProcessPtySessionWhileCurrentGenerationHostIsUnreachable(
		request: HostedTerminalPtyProcessSpawnRequest,
	): TerminalPtyProcessHandle {
		return PtySession.spawn({
			binary: request.binary,
			args: request.args,
			cwd: request.cwd,
			env: request.env,
			cols: request.cols,
			rows: request.rows,
			spawnAttribution: { reason: request.hostedSessionKind, taskId: request.taskId },
			onData: request.onData,
			onExit: request.onExit,
		});
	}
}
