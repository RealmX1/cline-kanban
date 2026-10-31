// runtime 侧 agent session PTY host 的总入口：
// - 启动时发现本 runtime 身份下各 generation 的 host，逐个以 controller 身份连上，列出仍在跑的会话，
//   整理成按 workspace 分组的接管候选（新 runtime 在 listen 之前把它们装回 session-manager）；
// - 旧 generation 的 host 令其「排空后退休」：继续服务存量会话，不再接新 spawn；
// - 为每个 workspace 提供 HostedTerminalPtyProcessSpawner，新会话一律进当前 generation 的 host；
//   用户关闭新托管或当前 generation 就绪预算耗尽且归属明确时，新会话维持进程内 PTY；
// - 本 runtime spawn / 接管的会话，其 hook spool（runtime 缺席期间存进 host 的 hook 事件）经
//   HostedSessionHookSpoolDrainCoordinator 按序应用回 hooks ingest。

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitForRuntimeOwnedPtyHostRecoveryCheck } from "node:timers/promises";
import { z } from "zod";
import type {
	AgentSessionPtyHostDiagnostics,
	AgentSessionPtyHostReadOnlyHostStatus,
} from "../../core/agent-session-pty-host-diagnostics-contract";
import { readPosixProcessResourceTable } from "../../diagnostics/posix-process-table-with-resource-columns-reader";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { PtySession } from "../../terminal/pty-session";
import type {
	HostedTerminalPtyProcessSpawner,
	HostedTerminalPtyProcessSpawnRequest,
	HostedTerminalPtySessionAdoptionCandidate,
	TerminalPtyProcessHandle,
} from "../../terminal/terminal-pty-process-handle";
import type {
	AgentSessionPtyHostHostedSessionListing,
	SpawnHostedSessionOutcome,
} from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";
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
import type { AgentSessionPtyHostModeEnablementDecision } from "./agent-session-pty-host-mode-enablement";
import {
	AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS,
	AgentSessionPtyHostPersistentRecoveryBudget,
} from "./agent-session-pty-host-persistent-recovery-budget";
import { readAgentSessionPtyHostRecoveryEvidenceFingerprint } from "./agent-session-pty-host-recovery-evidence-fingerprint";
import { claimAgentSessionPtyHostRuntimeControllerOwnership } from "./agent-session-pty-host-runtime-controller-ownership";
import {
	createAgentSessionPtyHostDiagnosticsReport,
	notifyAgentSessionPtyHostDiagnosticsChanged,
} from "./agent-session-pty-host-runtime-diagnostics";
import {
	type AgentSessionPtyHostRuntimeIdentity,
	listAgentSessionPtyHostGenerationSocketPaths,
	resolveAgentSessionPtyHostLogFilePath,
	resolveAgentSessionPtyHostSocketPath,
} from "./agent-session-pty-host-socket-path-for-runtime-identity";
import {
	AGENT_SESSION_PTY_HOST_HOSTED_SESSION_KEY_ENVIRONMENT_VARIABLE_NAME,
	AGENT_SESSION_PTY_HOST_SOCKET_PATH_ENVIRONMENT_VARIABLE_NAME,
	queryAgentSessionPtyHostControllerPresence,
	queryAgentSessionPtyHostReadOnlyStatus,
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

// runtime 正在退出（handover / 信号停止）：新会话一律不起——起在本 runtime 里的进程内 PTY 活不过退出，
// 起在 host 里的会话赶不上最终接管记录。调用方按普通的启动失败处理，稍后重试即可。
export class AgentSessionPtyHostRefusesNewSpawnsWhileRuntimeShutsDownError extends Error {
	readonly code = "KANBAN_RUNTIME_SHUTTING_DOWN";
}

// 上一个 runtime 缺席期间被 host 按回收期限终止、随后由本 runtime 接管（交付了退出）的会话：启动时据此补记回收账本。
export interface HostedSessionReclaimedByHostWhileRuntimeWasAbsent {
	workspaceId: string;
	taskId: string;
	pid: number;
	exitedAtEpochMs: number;
}

export interface AgentSessionPtyHostRuntimeFacadeOptions {
	runtimeIdentity: AgentSessionPtyHostRuntimeIdentity;
	warn: (message: string) => void;
	newHostedSessionsEnabled?: boolean;
	startupDecision?: AgentSessionPtyHostModeEnablementDecision;
	recoveryConfigurationEvidenceFilePath?: string;
	waitBeforeRetryingHostReadiness?: (milliseconds: number) => Promise<void>;
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

const pendingHostedSessionSpawnOwnershipSchema = z.array(
	z.object({
		hostedSessionKey: z.string(),
		workspaceId: z.string(),
		conversationSessionId: z.string(),
		socketPath: z.string(),
		attemptedAtEpochMs: z.number(),
		originalHostProcessId: z.number().int().positive().optional(),
		originalHostProcessStartTimeText: z.string().nullable().optional(),
		originalHostStartedAtEpochMs: z.number().optional(),
	}),
);

export class AgentSessionPtyHostRuntimeFacade {
	private readonly generationLinksBySocketPath = new Map<string, AgentSessionPtyHostGenerationControllerLink>();
	private runtimeControllerOwnership: Awaited<
		ReturnType<typeof claimAgentSessionPtyHostRuntimeControllerOwnership>
	> | null = null;
	private currentGenerationRecoveryBudget: AgentSessionPtyHostPersistentRecoveryBudget | null = null;
	private generationDiscoveryRecoveryBudget: AgentSessionPtyHostPersistentRecoveryBudget | null = null;
	private readinessRecoveryInProgress: Promise<void> | null = null;
	private recoveryProbeTimer: NodeJS.Timeout | null = null;
	private periodicReadOnlyProbeInProgress: Promise<void> | null = null;
	private nextReadOnlyHostProbeAtEpochMs: number | null = null;
	private lastObservedHostReadinessFingerprint: string | null = null;
	private runtimeIsClosing = false;
	private readonly runtimeClosingAbortController = new AbortController();
	private pendingHostedSessionSpawnOwnership: z.infer<typeof pendingHostedSessionSpawnOwnershipSchema> = [];
	private pendingHostedSessionSpawnOwnershipPersistence: Promise<void> = Promise.resolve();
	private readonly hostedSessionSpawnOperations = new Set<Promise<TerminalPtyProcessHandle>>();
	private connectingToCurrentGeneration: Promise<AgentSessionPtyHostGenerationControllerLink> | null = null;
	private readonly adoptionCandidatesOfWorkspaces: HostedTerminalPtySessionAdoptionCandidatesOfWorkspace[] = [];
	private readonly pendingAdoptionCandidateBookkeeping: PendingAdoptionCandidateBookkeeping[] = [];
	private newSpawnsRefusedBecauseRuntimeIsShuttingDown = false;
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
		facade.runtimeControllerOwnership = await claimAgentSessionPtyHostRuntimeControllerOwnership(
			options.runtimeIdentity,
		);
		try {
			await facade.loadPendingHostedSessionSpawnOwnership();
			const recoveryOptions = {
				readEvidenceFingerprint: () =>
					readAgentSessionPtyHostRecoveryEvidenceFingerprint(
						facade.currentBuildHostDescriptor,
						options.recoveryConfigurationEvidenceFilePath,
					),
				shouldContinueRecovery: () => !facade.runtimeIsClosing,
				waitBeforeRetry:
					options.waitBeforeRetryingHostReadiness ??
					((milliseconds: number) =>
						waitForRuntimeOwnedPtyHostRecoveryCheck(milliseconds, undefined, {
							signal: facade.runtimeClosingAbortController.signal,
						}).catch(() => {})),
				isFailureWithUnknownHostedSessionOwnership: (error: unknown) =>
					error instanceof AgentSessionPtyHostPreventsSafeRuntimeStartupError ||
					(error instanceof AgentSessionPtyHostUnreachableError && !error.noHostIsListening),
				onProgress: (progress: unknown) => {
					options.warn(
						JSON.stringify({
							event: "agent_session_pty_host_recovery_progress",
							runtimePort: options.runtimeIdentity.runtimePort,
							progress,
						}),
					);
					notifyAgentSessionPtyHostDiagnosticsChanged();
				},
			};
			facade.generationDiscoveryRecoveryBudget = await AgentSessionPtyHostPersistentRecoveryBudget.load({
				...recoveryOptions,
				recoveryStateFilePath: facade.runtimeIdentityEvidenceFilePath("generation-discovery-recovery"),
			});
			const discovery = await facade.generationDiscoveryRecoveryBudget.recover(
				(deadline) => facade.connectToEveryGenerationHostAndCollectAdoptionCandidates(deadline),
				async () => {
					const statuses = await Promise.all(
						listAgentSessionPtyHostGenerationSocketPaths(options.runtimeIdentity).map((socketPath) =>
							queryAgentSessionPtyHostReadOnlyStatus({ agentSessionPtyHostSocketPath: socketPath }),
						),
					);
					return statuses.every((status) => "hostProcessId" in status || status.noHostIsListening === true);
				},
			);
			if (discovery.kind !== "ready")
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(discovery.failureMessage);
			await facade.reconcilePendingHostedSessionSpawnOwnershipFromOriginalHostEvidence();
			facade.currentGenerationRecoveryBudget = await AgentSessionPtyHostPersistentRecoveryBudget.load({
				...recoveryOptions,
				recoveryStateFilePath: facade.runtimeIdentityEvidenceFilePath("current-generation-readiness-recovery"),
			});
			if (options.newHostedSessionsEnabled !== false)
				await facade.recoverCurrentGenerationHostWithPersistentBudget();
			facade.nextReadOnlyHostProbeAtEpochMs =
				Date.now() + AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS;
			facade.recoveryProbeTimer = setInterval(() => {
				if (facade.runtimeIsClosing || facade.periodicReadOnlyProbeInProgress) return;
				facade.periodicReadOnlyProbeInProgress = (async () => {
					facade.nextReadOnlyHostProbeAtEpochMs =
						Date.now() + AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS;
					await facade.reconcilePendingHostedSessionSpawnOwnershipFromOriginalHostEvidence();
					if (options.newHostedSessionsEnabled !== false && !facade.isConnectedToCurrentGenerationHost())
						await facade.recoverCurrentGenerationHostWithPersistentBudget();
					const diagnostics = await facade.queryDiagnostics();
					const fingerprint = JSON.stringify([
						diagnostics.newSessionHostingMode,
						diagnostics.generations.map((generation) => [
							generation.socketPath,
							generation.readiness,
							generation.hostStatus?.hostProcessId,
							generation.hostStatus?.controllerProcessId,
						]),
					]);
					if (facade.lastObservedHostReadinessFingerprint !== fingerprint) {
						facade.lastObservedHostReadinessFingerprint = fingerprint;
						notifyAgentSessionPtyHostDiagnosticsChanged();
					}
				})()
					.catch((error: unknown) =>
						options.warn(
							JSON.stringify({ event: "agent_session_pty_host_recovery_waiting", message: String(error) }),
						),
					)
					.finally(() => {
						facade.periodicReadOnlyProbeInProgress = null;
					});
			}, AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS);
			facade.recoveryProbeTimer.unref();
			return facade;
		} catch (error) {
			await facade.closeControllerConnectionsAfterFlushingPendingFrames();
			throw error;
		}
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
			spawnHostedTerminalPtyProcess: (request) => {
				const operation = this.spawnHostedTerminalPtyProcess(workspaceId, workspaceRepositoryPath, request);
				this.hostedSessionSpawnOperations.add(operation);
				void operation.then(
					() => this.hostedSessionSpawnOperations.delete(operation),
					() => this.hostedSessionSpawnOperations.delete(operation),
				);
				return operation;
			},
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

	// runtime 退出流程的第一步（handover 与信号停止都是）：此后的 spawn 一律以 AgentSessionPtyHostRefusesNewSpawnsWhileRuntimeShutsDownError 失败。
	refuseNewSpawnsBecauseRuntimeIsShuttingDown(): void {
		this.newSpawnsRefusedBecauseRuntimeIsShuttingDown = true;
	}

	// detach 之前：每条链路停止消费会话事件（输出、退出、spool 通知），并等在途的 spool 应用跑完。
	// 之后每条句柄的输出偏移不再变化，session-manager 据此做 checkpoint、推最终接管记录。
	async freezeHostedSessionEventRoutingAndStopHookSpoolDrainsForRuntimeHandover(): Promise<void> {
		for (const link of this.generationLinksBySocketPath.values()) {
			link.freezeHostedSessionEventRoutingForRuntimeHandover();
		}
		await this.hostedSessionHookSpoolDrainCoordinator.forgetEveryHookSpoolDrainTargetAndWaitForRunningDrainLoopsToStop();
	}

	// 显式全停（`kanban runtime stop --terminate-hosted-agent-sessions`）：每个 generation 的 host 终止全部会话后退出，
	// 包括本 runtime 没有接管的会话。runtime 自己的会话由调用方先按正常停止流程停掉并记账。
	requestEveryGenerationHostToTerminateAllHostedSessionsAndExit(): number {
		let reachedHostCount = 0;
		for (const link of this.generationLinksBySocketPath.values()) {
			if (link.connection.isClosed) {
				continue;
			}
			link.connection.sendControlMessage({ type: "terminate_all_hosted_sessions_and_exit" });
			reachedHostCount += 1;
		}
		return reachedHostCount;
	}

	listHostedSessionsReclaimedByHostWhileRuntimeWasAbsentThatWereAdopted(): HostedSessionReclaimedByHostWhileRuntimeWasAbsent[] {
		return this.pendingAdoptionCandidateBookkeeping
			.filter(
				(bookkeeping) =>
					bookkeeping.dispositionState === "adopted_with_handle_owned_by_terminal_session_manager" &&
					bookkeeping.listing.exitRecord?.hostedSessionTerminatedByHostReason ===
						"reclaimed_by_host_while_runtime_absent",
			)
			.map((bookkeeping) => ({
				workspaceId: bookkeeping.listing.hostedSessionDescriptor.workspaceId,
				taskId: bookkeeping.listing.hostedSessionDescriptor.taskId,
				pid: bookkeeping.listing.pid,
				exitedAtEpochMs: bookkeeping.listing.exitRecord?.exitedAtEpochMs ?? 0,
			}));
	}

	// runtime 退出前调用：把已排队的 stop / 接管记录等消息写进内核再断开。
	async closeControllerConnectionsAfterFlushingPendingFrames(): Promise<void> {
		this.runtimeIsClosing = true;
		this.runtimeClosingAbortController.abort();
		if (this.recoveryProbeTimer) clearInterval(this.recoveryProbeTimer);
		await this.periodicReadOnlyProbeInProgress?.catch(() => {});
		await this.readinessRecoveryInProgress?.catch(() => {});
		const links = [...this.generationLinksBySocketPath.values()];
		for (const link of links) {
			link.markRuntimeIsClosingControllerConnections();
		}
		await Promise.all(links.map((link) => link.connection.closeAfterFlushingPendingFrames()));
		await Promise.allSettled([...this.hostedSessionSpawnOperations]);
		await this.pendingHostedSessionSpawnOwnershipPersistence.catch(() => {});
		await this.runtimeControllerOwnership?.release();
		this.runtimeControllerOwnership = null;
	}

	private async spawnHostedTerminalPtyProcess(
		workspaceId: string,
		workspaceRepositoryPath: string | null,
		request: HostedTerminalPtyProcessSpawnRequest,
	): Promise<TerminalPtyProcessHandle> {
		// 闸只拦新请求；闸落下前已发出的 spawn 照常完成，会话起在 host 里，没人 stop 它，下一个 runtime 照常接管。
		if (this.newSpawnsRefusedBecauseRuntimeIsShuttingDown || this.runtimeIsClosing) {
			throw new AgentSessionPtyHostRefusesNewSpawnsWhileRuntimeShutsDownError(
				"Kanban runtime is restarting or stopping; start this session again once it is back",
			);
		}
		if (
			this.pendingHostedSessionSpawnOwnership.some(
				(pending) => pending.workspaceId === workspaceId && pending.conversationSessionId === request.taskId,
			)
		) {
			throw new Error("原 hosted session 的创建归属仍待核对，拒绝重复启动");
		}
		await this.assertNoExistingHostedConversationBeforeCreatingAnotherPty(workspaceId, request.taskId);
		if (this.options.newHostedSessionsEnabled === false)
			return this.spawnInProcessPtySessionWhileCurrentGenerationHostIsUnreachable(request);
		await this.recoverCurrentGenerationHostWithPersistentBudget();
		if (!this.isConnectedToCurrentGenerationHost()) {
			if (this.currentGenerationRecoveryBudget?.progress?.lastFailureMayHideHostedSessions) {
				throw new AgentSessionPtyHostUnreachableError("host 归属未知，拒绝降级后重复启动", false);
			}
			return this.spawnInProcessPtySessionWhileCurrentGenerationHostIsUnreachable(request);
		}
		let link = await this.ensureConnectedToCurrentGenerationHost();
		const originalHostProcessStartTimeText = await readPosixProcessResourceTable()
			.then(
				(processes) =>
					processes.find((entry) => entry.processId === link.connection.hostHello.hostProcessId)
						?.processStartTimeText ?? null,
			)
			.catch(() => null);
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
		this.pendingHostedSessionSpawnOwnership.push({
			hostedSessionKey,
			workspaceId,
			conversationSessionId: request.taskId,
			socketPath: link.socketPath,
			attemptedAtEpochMs: Date.now(),
			originalHostProcessId: link.connection.hostHello.hostProcessId,
			originalHostProcessStartTimeText,
			originalHostStartedAtEpochMs: link.connection.hostHello.hostStartedAtEpochMs,
		});
		await this.persistPendingHostedSessionSpawnOwnership();
		if (this.runtimeIsClosing) throw new Error("runtime 已进入退出阶段，已持久保留尚未提交的 session key");
		try {
			await request.beforeAgentProcessLaunch?.();
		} catch (error) {
			// 尚未发送 spawn，撤销本次预留即可；不得把退出闸门的拒绝当作回执丢失。
			this.pendingHostedSessionSpawnOwnership = this.pendingHostedSessionSpawnOwnership.filter(
				(pending) => pending.hostedSessionKey !== hostedSessionKey,
			);
			await this.persistPendingHostedSessionSpawnOwnership();
			throw error;
		}
		let outcome: SpawnHostedSessionOutcome;
		try {
			outcome = await link.connection.requestSpawnHostedSession({
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
		} catch (error) {
			// 回执丢失只查询原 key，绝不重发 spawn，也不在归属未知时改用进程内 PTY。
			const recovered = await this.waitUntilPendingSpawnOwnershipCanBeConfirmed(link, hostedSessionKey, error);
			if (!recovered) {
				this.pendingHostedSessionSpawnOwnership = this.pendingHostedSessionSpawnOwnership.filter(
					(pending) => pending.hostedSessionKey !== hostedSessionKey,
				);
				await this.persistPendingHostedSessionSpawnOwnership();
				throw error;
			}
			link = recovered.link;
			const listing = recovered.listing;
			outcome = {
				kind: "spawned",
				hostedSessionChannelNumber: listing.hostedSessionChannelNumber,
				pid: listing.pid,
				spawnedAtEpochMs: listing.spawnedAtEpochMs,
			};
		}
		this.pendingHostedSessionSpawnOwnership = this.pendingHostedSessionSpawnOwnership.filter(
			(pending) => pending.hostedSessionKey !== hostedSessionKey,
		);
		await this.persistPendingHostedSessionSpawnOwnership();
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
			0,
			outcome.spawnedAtEpochMs,
		);
		// 新会话只进当前 build 的 host，它一定支持 spool。登记即请求一次读（不靠 0 计数跳过）。
		this.registerHookSpoolDrainTargetHostedSession(link, hostedSessionKey, workspaceId, request.taskId);
		link.registerHandleAndDeliverEventsThatArrivedEarlier(handle);
		return handle;
	}

	private async assertNoExistingHostedConversationBeforeCreatingAnotherPty(
		workspaceId: string,
		conversationSessionId: string,
	): Promise<void> {
		for (const socketPath of new Set([
			...listAgentSessionPtyHostGenerationSocketPaths(this.options.runtimeIdentity),
			...this.generationLinksBySocketPath.keys(),
		])) {
			const link = this.generationLinksBySocketPath.get(socketPath);
			if (link && !link.connection.isClosed) {
				const listings = await link.connection.requestListHostedSessions(1_000);
				if (
					listings.some(
						(listing) =>
							listing.exitRecord === null &&
							listing.hostedSessionDescriptor.workspaceId === workspaceId &&
							listing.hostedSessionDescriptor.taskId === conversationSessionId,
					)
				)
					throw new Error(
						`会话 ${workspaceId}/${conversationSessionId} 仍由 ${socketPath} 托管，拒绝重复创建 PTY`,
					);
				continue;
			}
			const status = await queryAgentSessionPtyHostReadOnlyStatus({ agentSessionPtyHostSocketPath: socketPath });
			if ("hostProcessId" in status) {
				if (
					status.hostedSessions.some(
						(session) =>
							!session.exited &&
							session.workspaceId === workspaceId &&
							session.conversationSessionId === conversationSessionId,
					)
				)
					throw new Error(`原 hosted 会话仍存活，等待接回 ${workspaceId}/${conversationSessionId}`);
			} else if (!status.noHostIsListening)
				throw new Error(`无法核对 ${socketPath} 中的会话归属，拒绝降级或重复创建：${status.failureMessage}`);
		}
	}

	private runtimeIdentityEvidenceFilePath(evidenceKind: string): string {
		return join(
			this.options.runtimeIdentity.runtimeHomeDirectoryPath,
			"agent-session-pty-host",
			`p${this.options.runtimeIdentity.runtimePort}-${evidenceKind}.json`,
		);
	}

	private async loadPendingHostedSessionSpawnOwnership(): Promise<void> {
		try {
			this.pendingHostedSessionSpawnOwnership = pendingHostedSessionSpawnOwnershipSchema.parse(
				JSON.parse(
					await readFile(this.runtimeIdentityEvidenceFilePath("pending-hosted-session-spawn-ownership"), "utf8"),
				),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async persistPendingHostedSessionSpawnOwnership(): Promise<void> {
		const snapshot = this.pendingHostedSessionSpawnOwnership.map((pending) => ({ ...pending }));
		const persistence = this.pendingHostedSessionSpawnOwnershipPersistence
			.catch(() => {})
			.then(() =>
				lockedFileSystem.writeJsonFileAtomic(
					this.runtimeIdentityEvidenceFilePath("pending-hosted-session-spawn-ownership"),
					snapshot,
					{ lock: null, durable: true, fileMode: 0o600 },
				),
			);
		this.pendingHostedSessionSpawnOwnershipPersistence = persistence;
		await persistence;
		notifyAgentSessionPtyHostDiagnosticsChanged();
	}

	private async reconcilePendingHostedSessionSpawnOwnershipFromOriginalHostEvidence(): Promise<void> {
		if (!this.pendingHostedSessionSpawnOwnership.length) return;
		const processes = await readPosixProcessResourceTable().catch(() => null);
		if (!processes) return;
		const resolvedKeys = new Set<string>();
		for (const pending of this.pendingHostedSessionSpawnOwnership) {
			if (!pending.originalHostProcessId) continue;
			const currentProcess = processes.find((entry) => entry.processId === pending.originalHostProcessId);
			let resolutionReason = "original_host_exited_or_process_identity_replaced";
			if (currentProcess) {
				if (
					!pending.originalHostProcessStartTimeText ||
					currentProcess.processStartTimeText === pending.originalHostProcessStartTimeText
				) {
					// 没有在途 spawn 才允许用原 host 的“原 key 不存在”补证；避免抢在创建请求前清掉记录。
					if (this.hostedSessionSpawnOperations.size || pending.originalHostStartedAtEpochMs === undefined)
						continue;
					const status = await queryAgentSessionPtyHostReadOnlyStatus({
						agentSessionPtyHostSocketPath: pending.socketPath,
					});
					if (
						!("hostProcessId" in status) ||
						status.hostProcessId !== pending.originalHostProcessId ||
						status.hostStartedAtEpochMs !== pending.originalHostStartedAtEpochMs ||
						status.hostedSessions.some((session) => session.hostedSessionKey === pending.hostedSessionKey)
					)
						continue;
					resolutionReason = "original_host_confirms_session_key_absent_without_inflight_spawn";
				}
			} else {
				try {
					process.kill(pending.originalHostProcessId, 0);
					continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
				}
			}
			// 先追加持久恢复证据，再解除当前阻塞；旧失败与原 session key 仍可审计。
			const resolution = {
				event: "hosted_session_spawn_ownership_resolved",
				resolutionReason,
				resolvedAtEpochMs: Date.now(),
				...pending,
			};
			const history = await open(
				this.runtimeIdentityEvidenceFilePath("pending-hosted-session-spawn-ownership").replace(
					/\.json$/u,
					"-resolution-history.jsonl",
				),
				"a",
				0o600,
			);
			try {
				await history.write(`${JSON.stringify(resolution)}\n`);
				await history.sync();
			} finally {
				await history.close();
			}
			this.options.warn(JSON.stringify(resolution));
			resolvedKeys.add(pending.hostedSessionKey);
		}
		if (resolvedKeys.size) {
			this.pendingHostedSessionSpawnOwnership = this.pendingHostedSessionSpawnOwnership.filter(
				(pending) => !resolvedKeys.has(pending.hostedSessionKey),
			);
			await this.persistPendingHostedSessionSpawnOwnership();
		}
	}

	private async assertNoOtherRuntimeControllerBeforeHandshake(
		socketPath: string,
		deadlineAtEpochMs = Date.now() + 1_000,
	): Promise<void> {
		if (Date.now() >= deadlineAtEpochMs)
			throw new AgentSessionPtyHostUnreachableError("核验 controller 所有权的预算已耗尽", false);
		const status = await queryAgentSessionPtyHostReadOnlyStatus({
			agentSessionPtyHostSocketPath: socketPath,
			responseDeadlineMilliseconds: Math.min(500, Math.max(1, deadlineAtEpochMs - Date.now())),
		});
		if ("hostProcessId" in status) {
			if (status.controllerProcessId !== null && status.controllerProcessId !== process.pid)
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
					`host ${socketPath} 仍由 pid=${status.controllerProcessId} 控制，拒绝抢占`,
				);
			return;
		}
		if (status.noHostIsListening) return;
		const legacyPresence = await queryAgentSessionPtyHostControllerPresence({
			agentSessionPtyHostSocketPath: socketPath,
			responseDeadlineMilliseconds: Math.min(500, Math.max(1, deadlineAtEpochMs - Date.now())),
		});
		if ("controllerConnected" in legacyPresence && !legacyPresence.controllerConnected) return;
		throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
			`无法证明 host ${socketPath} 没有其他 controller，保留 unknown：${status.failureMessage}`,
		);
	}

	private recoverCurrentGenerationHostWithPersistentBudget(): Promise<void> {
		if (this.isConnectedToCurrentGenerationHost() || this.options.newHostedSessionsEnabled === false)
			return Promise.resolve();
		if (this.readinessRecoveryInProgress) return this.readinessRecoveryInProgress;
		this.readinessRecoveryInProgress = (async () => {
			if (!this.currentGenerationRecoveryBudget) throw new Error("host 恢复预算尚未加载");
			const result = await this.currentGenerationRecoveryBudget.recover(
				(deadline) => this.ensureConnectedToCurrentGenerationHost(deadline),
				async () =>
					"hostProcessId" in
					(await queryAgentSessionPtyHostReadOnlyStatus({
						agentSessionPtyHostSocketPath: this.currentGenerationSocketPath,
					})),
			);
			if (result.kind !== "ready")
				this.options.warn(
					JSON.stringify({
						event: "agent_session_pty_host_readiness_budget_exhausted",
						mode: this.currentGenerationRecoveryBudget.progress?.lastFailureMayHideHostedSessions
							? "ownership_unknown"
							: "in_process_pty",
						failureMessage: result.failureMessage,
						recoveryProgress: this.currentGenerationRecoveryBudget.progress,
					}),
				);
			notifyAgentSessionPtyHostDiagnosticsChanged();
		})().finally(() => {
			this.readinessRecoveryInProgress = null;
		});
		return this.readinessRecoveryInProgress;
	}

	private async waitUntilPendingSpawnOwnershipCanBeConfirmed(
		originalLink: AgentSessionPtyHostGenerationControllerLink,
		hostedSessionKey: string,
		failure: unknown,
	): Promise<{
		link: AgentSessionPtyHostGenerationControllerLink;
		listing: AgentSessionPtyHostHostedSessionListing;
	} | null> {
		while (!this.runtimeIsClosing) {
			await this.reconcilePendingHostedSessionSpawnOwnershipFromOriginalHostEvidence();
			if (!this.pendingHostedSessionSpawnOwnership.some((pending) => pending.hostedSessionKey === hostedSessionKey))
				return null;
			if (!originalLink.connection.isClosed) {
				try {
					const listings = await originalLink.connection.requestListHostedSessions(1_000);
					const listing = listings.find((candidate) => candidate.hostedSessionKey === hostedSessionKey);
					return listing ? { link: originalLink, listing } : null;
				} catch {
					/* 原连接仍可能持有已创建会话，改用非 controller 只读证据。 */
				}
			}
			const status = await queryAgentSessionPtyHostReadOnlyStatus({
				agentSessionPtyHostSocketPath: originalLink.socketPath,
			});
			if (
				"hostProcessId" in status &&
				status.hostProcessId === originalLink.connection.hostHello.hostProcessId &&
				status.hostStartedAtEpochMs === originalLink.connection.hostHello.hostStartedAtEpochMs
			) {
				if (!status.hostedSessions.some((session) => session.hostedSessionKey === hostedSessionKey)) return null;
				await this.assertNoOtherRuntimeControllerBeforeHandshake(originalLink.socketPath);
				const connection = await AgentSessionPtyHostControllerConnection.connectAsController(
					originalLink.socketPath,
				);
				const link = this.registerGenerationLink(originalLink.socketPath, connection);
				const listing = (await connection.requestListHostedSessions()).find(
					(candidate) => candidate.hostedSessionKey === hostedSessionKey,
				);
				if (!listing) return null;
				await connection.requestAttachHostedSessionOutputStream(
					hostedSessionKey,
					listing.retainedOutputStartByteOffset,
				);
				return { link, listing };
			}
			this.options.warn(
				JSON.stringify({
					event: "hosted_session_spawn_ownership_unknown",
					hostedSessionKey,
					socketPath: originalLink.socketPath,
					failure: String(failure),
					recoveryCondition: "original_host_response_for_session_key",
					nextCheckAtEpochMs: Date.now() + AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS,
				}),
			);
			notifyAgentSessionPtyHostDiagnosticsChanged();
			await waitForRuntimeOwnedPtyHostRecoveryCheck(
				AGENT_SESSION_PTY_HOST_RECOVERY_READONLY_PROBE_INTERVAL_MS,
				undefined,
				{ signal: this.runtimeClosingAbortController.signal },
			).catch(() => {});
		}
		throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
			`runtime 退出时 ${hostedSessionKey} 的创建归属仍未知，已保留持久记录`,
		);
	}

	async queryDiagnostics(): Promise<AgentSessionPtyHostDiagnostics> {
		const report = createAgentSessionPtyHostDiagnosticsReport({
			runtimeIdentity: this.options.runtimeIdentity,
			startupDecision: this.options.startupDecision ?? null,
			runtimeProcessStartTimeText: this.runtimeControllerOwnership?.processStartTimeText,
		});
		const paths = new Set([
			...listAgentSessionPtyHostGenerationSocketPaths(this.options.runtimeIdentity),
			...this.generationLinksBySocketPath.keys(),
		]);
		const generations = await Promise.all(
			[...paths].map(async (socketPath): Promise<AgentSessionPtyHostDiagnostics["generations"][number]> => {
				const status = await queryAgentSessionPtyHostReadOnlyStatus({ agentSessionPtyHostSocketPath: socketPath });
				if ("hostProcessId" in status)
					return {
						socketPath,
						readiness: "ready",
						observationSource: "readonly_host_query",
						failureMessage: null,
						hostStatus: status,
					};
				// 旧 host 不懂新诊断消息时，只使用本 runtime 已拥有的连接，绝不另发 controller 握手。
				const link = this.generationLinksBySocketPath.get(socketPath);
				if (link && !link.connection.isClosed && link.connection.hostHello) {
					try {
						const listings = await link.connection.requestListHostedSessions(1_000);
						const hostStatus: AgentSessionPtyHostReadOnlyHostStatus = {
							...link.connection.hostHello,
							hostProcessInstanceId: null,
							hostLifecycleState:
								socketPath === this.currentGenerationSocketPath ? "serving" : "retiring_when_drained",
							controllerProcessId: process.pid,
							hostedSessions: listings.map((listing) => ({
								hostedSessionKey: listing.hostedSessionKey,
								workspaceId: listing.hostedSessionDescriptor.workspaceId,
								conversationSessionId: listing.hostedSessionDescriptor.taskId,
								hostedSessionKind: listing.hostedSessionDescriptor.hostedSessionKind,
								processId: listing.pid,
								processStartedAtEpochMs: listing.spawnedAtEpochMs,
								exited: listing.exitRecord !== null,
								adoptionRecordPresent: listing.adoptionRecord !== null,
								outputEndByteOffset: listing.outputEndByteOffset,
							})),
						};
						return {
							socketPath,
							readiness: "ready",
							observationSource: "own_controller_connection",
							failureMessage: null,
							hostStatus,
						};
					} catch {
						/* 不把缓存中的握手冒充当前响应。 */
					}
				}
				return {
					socketPath,
					readiness: status.noHostIsListening ? "not_listening" : "unknown",
					observationSource: "unavailable",
					failureMessage: status.failureMessage,
					hostStatus: null,
				};
			}),
		);
		const currentGenerationIsRespondingToThisController = generations.some(
			(generation) =>
				generation.socketPath === this.currentGenerationSocketPath &&
				generation.readiness === "ready" &&
				generation.hostStatus?.controllerProcessId === process.pid &&
				generation.hostStatus.hostLifecycleState === "serving",
		);
		return {
			...report,
			currentGenerationSocketPath: this.currentGenerationSocketPath,
			nextReadOnlyHostProbeAtEpochMs: this.nextReadOnlyHostProbeAtEpochMs,
			recoveryProgress:
				this.options.newHostedSessionsEnabled === false
					? null
					: (this.currentGenerationRecoveryBudget?.progress ??
						this.generationDiscoveryRecoveryBudget?.progress ??
						null),
			generations,
			pendingHostedSessionSpawnOwnership: [...this.pendingHostedSessionSpawnOwnership],
			newSessionHostingMode:
				this.options.newHostedSessionsEnabled === false
					? "disabled"
					: this.isConnectedToCurrentGenerationHost()
						? currentGenerationIsRespondingToThisController
							? "independent_host"
							: "ownership_unknown"
						: this.currentGenerationRecoveryBudget?.progress?.lastFailureMayHideHostedSessions
							? "ownership_unknown"
							: "in_process_pty",
		};
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
			reclaimedByHostWhileRuntimeWasAbsent:
				listing.exitRecord?.hostedSessionTerminatedByHostReason === "reclaimed_by_host_while_runtime_absent",
			retainedOutputStartByteOffset: listing.retainedOutputStartByteOffset,
			outputEndByteOffset: listing.outputEndByteOffset,
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
					// 崩溃路径从环形缓冲起点重放；计划内 handover 之后由 session-manager 传 checkpoint 的偏移，从那里续流。
					const attachOutcome = await link.connection.requestAttachHostedSessionOutputStream(
						listing.hostedSessionKey,
						callbacks.fromOutputByteOffset ?? listing.retainedOutputStartByteOffset,
					);
					if (attachOutcome.kind !== "attached") {
						throw new Error(`hosted session ${listing.hostedSessionKey} disappeared before adoption`);
					}
					if (
						callbacks.fromOutputByteOffset !== undefined &&
						(attachOutcome.catchUpStartByteOffset !== callbacks.fromOutputByteOffset ||
							attachOutcome.overwrittenByteCountBeforeCatchUpStart > 0)
					) {
						if (!callbacks.onCatchUpOutputGap) throw new Error("checkpoint 追赶输出存在缺口，但没有恢复处理函数");
						await callbacks.onCatchUpOutputGap();
					}
					handle = new HostedTerminalPtyProcessHandleOverAgentSessionPtyHost(
						link.connection,
						listing.hostedSessionKey,
						listing.hostedSessionChannelNumber,
						listing.pid,
						callbacks.onData,
						callbacks.onExit,
						// 追赶区间之后的第一帧实时输出到达之前，「已交付到哪里」就是追赶终点（再次 handover 时 checkpoint 与之对齐）。
						attachOutcome.catchUpEndByteOffset,
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

	private async connectToEveryGenerationHostAndCollectAdoptionCandidates(deadlineAtEpochMs: number): Promise<void> {
		const currentGenerationSocketPath = this.currentGenerationSocketPath;
		for (const generationSocketPath of listAgentSessionPtyHostGenerationSocketPaths(this.options.runtimeIdentity)) {
			if (this.generationLinksBySocketPath.has(generationSocketPath)) continue;
			let connection: AgentSessionPtyHostControllerConnection;
			try {
				await this.assertNoOtherRuntimeControllerBeforeHandshake(generationSocketPath, deadlineAtEpochMs);
				connection = await AgentSessionPtyHostControllerConnection.connectAsController(
					generationSocketPath,
					Math.max(1, deadlineAtEpochMs - Date.now()),
				);
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
			let hostedSessions: AgentSessionPtyHostHostedSessionListing[];
			try {
				hostedSessions = await connection.requestListHostedSessions(Math.max(1, deadlineAtEpochMs - Date.now()));
			} catch (error) {
				await connection.closeAfterFlushingPendingFrames();
				throw new AgentSessionPtyHostPreventsSafeRuntimeStartupError(
					`agent session pty host at ${generationSocketPath} did not list its sessions: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const link = this.registerGenerationLink(generationSocketPath, connection);
			for (const listing of hostedSessions) {
				if (listing.exitAcknowledgedWhileHookSpoolEntriesRemainUnacknowledged === true) {
					this.drainHookSpoolOfHostedSessionWhoseExitWasAlreadyAcknowledged(link, listing);
					continue;
				}
				this.recordAdoptionCandidate(link, listing);
			}
			this.pendingHostedSessionSpawnOwnership = this.pendingHostedSessionSpawnOwnership.filter(
				(pending) => pending.socketPath !== generationSocketPath,
			);
			await this.persistPendingHostedSessionSpawnOwnership();
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
					notifyAgentSessionPtyHostDiagnosticsChanged();
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

	private ensureConnectedToCurrentGenerationHost(
		deadlineAtEpochMs = Date.now() + 8_000,
	): Promise<AgentSessionPtyHostGenerationControllerLink> {
		const existingLink = this.generationLinksBySocketPath.get(this.currentGenerationSocketPath);
		if (existingLink && !existingLink.connection.isClosed) {
			return Promise.resolve(existingLink);
		}
		if (this.connectingToCurrentGeneration === null) {
			this.connectingToCurrentGeneration = this.connectToCurrentGenerationHostLaunchingItIfNeeded(
				deadlineAtEpochMs,
			).finally(() => {
				this.connectingToCurrentGeneration = null;
			});
		}
		return this.connectingToCurrentGeneration;
	}

	private async connectToCurrentGenerationHostLaunchingItIfNeeded(
		deadlineAtEpochMs: number,
	): Promise<AgentSessionPtyHostGenerationControllerLink> {
		const socketPath = this.currentGenerationSocketPath;
		let connection: AgentSessionPtyHostControllerConnection;
		try {
			await this.assertNoOtherRuntimeControllerBeforeHandshake(socketPath, deadlineAtEpochMs);
			connection = await AgentSessionPtyHostControllerConnection.connectAsController(
				socketPath,
				Math.max(1, deadlineAtEpochMs - Date.now()),
			);
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
				readinessDeadlineMilliseconds: Math.max(1, deadlineAtEpochMs - Date.now()),
			});
			await this.assertNoOtherRuntimeControllerBeforeHandshake(socketPath, deadlineAtEpochMs);
			connection = await AgentSessionPtyHostControllerConnection.connectAsController(
				socketPath,
				Math.max(1, deadlineAtEpochMs - Date.now()),
			);
		}
		return this.registerGenerationLink(socketPath, connection);
	}

	private isConnectedToCurrentGenerationHost(): boolean {
		const currentGenerationLink = this.generationLinksBySocketPath.get(this.currentGenerationSocketPath);
		return currentGenerationLink !== undefined && !currentGenerationLink.connection.isClosed;
	}

	// 与 session-manager 非 host 模式的 PtySession.spawn 同形；只缺 hosted 请求里不携带的启动请求归因字段。
	private async spawnInProcessPtySessionWhileCurrentGenerationHostIsUnreachable(
		request: HostedTerminalPtyProcessSpawnRequest,
	): Promise<TerminalPtyProcessHandle> {
		await request.beforeAgentProcessLaunch?.();
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
