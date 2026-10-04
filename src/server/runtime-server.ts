import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { ClaudeCodeTranscriptCompletedTurnSource } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import {
	type AcpTaskSessionService,
	createAcpTaskSessionService,
} from "../acp-client-session/acp-task-session-service";
import { handleClineMcpOauthCallback } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../cline-sdk/cline-task-session-service";
import { createClineWatcherRegistry } from "../cline-sdk/cline-watcher-registry";
import { isRuntimeAgentSessionSummaryDrivenByAcpProtocol } from "../core/agent-catalog";
import type {
	RuntimeCommandRunResponse,
	RuntimeIngestExploratoryFindingCandidateRequest,
	RuntimeRunUpdateResponse,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME,
} from "../core/kanban-cli-invocation-environment-actor-claims";
import { KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME } from "../core/kanban-web-ui-page-load-request-origin-nonce";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
import { resolveSessionFacets } from "../core/session-activity";
import { startEventLoopDelayMonitor } from "../diagnostics/event-loop-delay-monitor";
import { startKanbanRuntimeProcessSelfResourceSampleMonitor } from "../diagnostics/kanban-runtime-process-self-resource-sample-monitor";
import { startProcessFileDescriptorWatermarkMonitor } from "../diagnostics/process-file-descriptor-watermark-monitor";
import { createTaskAgentConversationModelTokenUsageJournalMonitor } from "../diagnostics/task-agent-conversation-model-token-usage-journal-monitor";
import { createTaskAttributedProcessTreeResourceSampler } from "../diagnostics/task-attributed-process-tree-resource-sampler";
import { createTaskWorktreeDiskUsageMeasurementMonitor } from "../diagnostics/task-worktree-disk-usage-measurement-monitor";
import { translateExplorationThreadGraphMaintenanceOutcome } from "../exploration-thread-graph/exploration-thread-graph-maintenance-outcome-translation";
import { createExplorationThreadGraphMaintenanceTrigger } from "../exploration-thread-graph/exploration-thread-graph-maintenance-trigger";
import { loadExplorationThreadGraphProjection } from "../exploration-thread-graph/exploration-thread-graph-projection-loader";
import { assembleExplorationThreadGraphSessionRefs } from "../exploration-thread-graph/exploration-thread-graph-session-refs";
import { resolveWorkspaceExplorationThreadGraphStoreRoot } from "../exploration-thread-graph/exploration-thread-graph-store-location";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
} from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue } from "../inter-work-unit-relation-ledger/kanban-web-ui-page-load-request-origin-nonce-registry";
import {
	checkRateLimit,
	clearRateLimit,
	extractBearerToken,
	extractSessionTokenFromCookie,
	isPasscodeEnabled,
	issueSession,
	recordFailedAttempt,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../security/passcode-manager";
import { readWorkspacePromptLibrarySnapshot } from "../state/prompt-library-store";
import { computeQueuedTaskPromptDeliveryTextSha256 } from "../state/queued-task-prompt-delivery-store";
import {
	readLiveRuntimeProcessInstanceIds,
	startRuntimeProcessInstanceHeartbeat,
} from "../state/runtime-process-instance-heartbeat-registry";
import { getTaskWorktreesHomePath, loadWorkspaceBoardById, loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createConversationTreeApi } from "../trpc/conversation-tree-api";
import { createDeploymentApi } from "../trpc/deployment-api";
import { createExploratoryApi } from "../trpc/exploratory-api";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { createTaskCardActionApi } from "../trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../trpc/task-card-action-per-task-command-serializer";
import { sendTaskChatMessageAcrossSessionTransports } from "../trpc/task-chat-message-send-across-session-transports";
import { createWorkUnitRelationPresentationPreferenceApi } from "../trpc/work-unit-relation-presentation-preference-api";
import {
	createWorkUnitRelationReadApi,
	readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive,
} from "../trpc/work-unit-relation-read-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import {
	type ActiveRuntimeSessionShutdownResult,
	stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace,
} from "./active-runtime-session-shutdown";
import { createAgentSessionInactivityReclamationScheduler } from "./agent-session-inactivity-reclamation-scheduler";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import { startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime } from "./pending-task-message-injection-startup-sweep";
import { createQueuedTaskPromptDeliveryDispatcher } from "./queued-task-prompt-delivery-dispatcher";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart } from "./stale-queued-task-prompt-delivery-startup-sweep";
import {
	enumerateTaskResourceUsageAttributionRoots,
	type TaskResourceUsageAttributionSessionSource,
} from "./task-resource-usage-attribution-root-enumeration";
import { createLiveTaskResourceUsageSnapshotPublisher } from "./task-resource-usage-live-snapshot-publication";
import { createTransportAwareAgentSessionReclamationExecutor } from "./transport-aware-agent-session-reclamation";
import type { WorkspaceRegistry } from "./workspace-registry";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	pickDirectoryPathFromSystemDialog: () => string | null;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

export interface RuntimeServer {
	url: string;
	stopAllActiveRuntimeSessionsForShutdown: () => Promise<
		Array<
			ActiveRuntimeSessionShutdownResult & {
				workspaceId: string;
				workspacePath: string | null;
			}
		>
	>;
	close: () => Promise<void>;
}

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	// 启动清扫：上一次 runtime 生命周期里没落定的程序化投递，其收敛完全依赖已经消失的内存态，
	// 不清扫就会永远停在 pending。只清扫**超期**的那些——账本是全机共享的，同机并存的另一个实例
	// 此刻可能正有在途投递，全扫会把它们判成不可纠正的假失败（见清扫模块头注）。
	// 不 await 阻塞启动——清扫是纠偏动作，不是服务可用性的前置条件。启动之后仍按超期判据持续清扫：
	// runtime 活着期间也会冒出没人收敛的 pending（见清扫模块头注）。
	const stalePendingTaskMessageInjectionSweepsForRuntimeLifetime =
		startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime();

	// 本实例的活性心跳。必须在任何启动清扫**之前**起：清扫要按「归属实例此刻还活不活着」判定该不该
	// 收拾一条记录，而同刻启动的另一个实例读到的心跳目录里必须已经有我——否则它会在那一拍里把我
	// 刚接手的东西当成上一次生命周期的残骸。
	//
	// await 它（不像下面的清扫那样放飞）：它很便宜（一次 mkdir + 一次 writeFile），而「先写下自己
	// 再开始服务」正是这套判据的前提。
	const runtimeProcessInstanceHeartbeat = await startRuntimeProcessInstanceHeartbeat();

	// 工作单元间关系账本：注册后本进程每一次 board 写入先过账本（dd2db 1a）。账本打不开时 board 只读。
	const activatedInterWorkUnitRelationLedgerLiveCapture =
		await activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);

	// exploration thread graph（B.2）。
	//
	// 维护触发器是**整个运行时一个单例**：防抖窗口与单飞账本都挂在它身上，每次请求重建等于四道闸
	// 全部失效——而漏掉单飞闸的代价是同一个 exploration 并发 fork 两个分身，重型会话上一次 ≈ $4.5。
	// 图只对终端 agent 有意义（v1 只有 claude 的 fork 语义已核实），所以会话清单只取终端管理器的。
	// 触发器与 exploratoryApi 互为依赖：api 的手动维护要调触发器，触发器转投 finding_candidate 又要调
	// api 的 ingest。用 late binding 打破——触发器先建好，ingest 出口在 api 工厂就位后再绑上。
	// 绑定前触发的作业只是不转投标注（标注仍在图上，下一次作业会用同样的确定性 id 补投）。
	let relayFindingCandidatesThroughExploratoryApi:
		| ((workspaceId: string, requests: RuntimeIngestExploratoryFindingCandidateRequest[]) => Promise<void>)
		| null = null;
	const explorationThreadGraphMaintenanceTrigger = createExplorationThreadGraphMaintenanceTrigger({
		relayFindingCandidates: async (workspaceId, requests) => {
			await relayFindingCandidatesThroughExploratoryApi?.(workspaceId, requests);
		},
		listWorkspaceSessionSummaries: async (workspaceId) => {
			const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			if (workspacePath === null) {
				return [];
			}
			const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
			return manager.listSummaries();
		},
		onExplorationThreadGraphUpdated: (workspaceId, explorationId, view) => {
			deps.runtimeStateHub.broadcastExplorationThreadGraphUpdated(workspaceId, explorationId, view);
		},
	});
	// 读图专用的 turn 源，与触发器内部那两个各自独立：它服务的是「打开面板看图」，末 turn 可能正在
	// 进行中，必须保持 treatFinalTurnAsCompleted 的默认 false。实例长活是为了复用增量读偏移——
	// 每次请求新建会让每次看图都从头重读整份 transcript。
	const explorationThreadGraphReadOnlyTurnSource = new ClaudeCodeTranscriptCompletedTurnSource();
	// ACP（omp 等）会话按 workspace 作用域持有，与 Cline SDK 服务并列。
	const acpTaskSessionServiceByWorkspaceId = new Map<string, AcpTaskSessionService>();
	// 与 clineWorkspacePathByWorkspaceId 对位：关服 / 重置时要遍历「只跑过 ACP 会话」的 workspace，
	// 它们未必在 workspaceRegistry 或 Cline 的账本里出现过。
	const acpWorkspacePathByWorkspaceId = new Map<string, string>();
	const getScopedAcpTaskSessionService = async (scope: RuntimeTrpcWorkspaceScope): Promise<AcpTaskSessionService> => {
		let service = acpTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createAcpTaskSessionService({
				workspaceId: scope.workspaceId,
				workspaceRepositoryPath: scope.workspacePath,
			});
			acpTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			acpWorkspacePathByWorkspaceId.set(scope.workspaceId, scope.workspacePath);
			deps.runtimeStateHub.trackAcpTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposeAcpTaskSessionService = (workspaceId: string): void => {
		const service = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		acpTaskSessionServiceByWorkspaceId.delete(workspaceId);
		acpWorkspacePathByWorkspaceId.delete(workspaceId);
		service.disposeAllTaskSessions();
	};
	const clineTaskSessionServiceByWorkspaceId = new Map<string, ClineTaskSessionService>();
	const clineWorkspacePathByWorkspaceId = new Map<string, string>();
	const clineWatcherRegistry = createClineWatcherRegistry();
	const getScopedClineTaskSessionService = async (
		scope: RuntimeTrpcWorkspaceScope,
	): Promise<ClineTaskSessionService> => {
		let service = clineTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createInMemoryClineTaskSessionService({
				watcherRegistry: clineWatcherRegistry,
				kanbanWorkspaceIdentityForTaskAgentSessionEnvironment: {
					workspaceId: scope.workspaceId,
					workspaceRepositoryPath: scope.workspacePath,
				},
			});
			clineTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			clineWorkspacePathByWorkspaceId.set(scope.workspaceId, scope.workspacePath);
			deps.runtimeStateHub.trackClineTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposeClineTaskSessionServiceAsync = async (workspaceId: string): Promise<void> => {
		const service = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		clineTaskSessionServiceByWorkspaceId.delete(workspaceId);
		clineWorkspacePathByWorkspaceId.delete(workspaceId);
		await service.dispose();
	};
	const listProjectRuntimeSessionSummaries = (workspaceId: string): RuntimeTaskSessionSummary[] => {
		const summariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		for (const summary of terminalManager?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		const clineTaskSessionService = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		for (const summary of clineTaskSessionService?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		for (const summary of acpTaskSessionService?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		return Array.from(summariesByTaskId.values());
	};
	// 「停止生成响应后固定宽限期」回收调度器。放在这里是因为三种 transport 的服务持有者都在本作用域：
	// listProjectRuntimeSessionSummaries 已经把三条 summary 流合并成一个查询面，正是陈旧定时器防护
	// 需要的「当前这个 task 的 summary 到底长什么样」。
	//
	// 回收是**真实生效**的：到期会真的终止进程 / 连接 / SDK 会话。安全性由三重防护保证——agent 回合
	// 永不计时、动手前双重比对（活体 id + 回合序号）、只回收 liveness==="live" 的会话；且回收只终止
	// 运行时，worktree / 未提交改动 / 提交 / 消息历史一律不动。
	const findRuntimeSessionSummary = (workspaceId: string, taskId: string): RuntimeTaskSessionSummary | null =>
		listProjectRuntimeSessionSummaries(workspaceId).find((summary) => summary.taskId === taskId) ?? null;
	const agentSessionInactivityReclamationScheduler = createAgentSessionInactivityReclamationScheduler({
		getTaskSessionSummary: findRuntimeSessionSummary,
		reclaimAgentSession: createTransportAwareAgentSessionReclamationExecutor({
			getTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
			getClineTaskSessionService: (workspaceId) => clineTaskSessionServiceByWorkspaceId.get(workspaceId) ?? null,
			getAcpTaskSessionService: (workspaceId) => acpTaskSessionServiceByWorkspaceId.get(workspaceId) ?? null,
		}),
		// 审计结果写回 summary sidecar，供卡片 / Focus View 显示「会话已被回收」。
		// 用户重进任务时必须看到明确说明（worktree、未提交改动、提交、消息历史均保留），
		// 而不是一个空终端让人误以为只是加载慢。
		onReclamationOutcome: ({ workspaceId, record, outcome }) => {
			switch (record.sessionTransport) {
				case "pty_terminal":
					deps.workspaceRegistry
						.getTerminalManagerForWorkspace(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
				case "in_process_cline_sdk":
					clineTaskSessionServiceByWorkspaceId
						.get(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
				case "acp_stdio_subprocess":
					acpTaskSessionServiceByWorkspaceId
						.get(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
			}
		},
	});

	// 排队 prompt 的出队引擎（runtime 级单例）。放在这里的理由与上面的回收调度器相同：三种 transport 的
	// 服务持有者都在本作用域，findRuntimeSessionSummary 是现成的三流合并查询面。
	//
	// 发送走的是与人类聊天、RVF followup **同一条**三 transport 统一出口，只是每次投递构造一份 deps、
	// 用闭包 observer 接住 PTY 的真实终态（与 runtime-api 的「一键放行」同款写法）。
	const clineProviderServiceForQueuedPromptDelivery = createClineProviderService();
	const queuedTaskPromptDeliveryDispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: findRuntimeSessionSummary,
		hasPendingProgrammaticTaskChatInputDelivery: (workspaceId, taskId) =>
			deps.workspaceRegistry
				.getTerminalManagerForWorkspace(workspaceId)
				?.hasPendingProgrammaticTaskChatInputDelivery(taskId) ?? false,
		resolveWorkspaceScope: (workspaceId) => {
			const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			return workspacePath === null ? null : { workspaceId, workspacePath };
		},
		sendThroughTaskChatTransports: async (scope, request, onProgrammaticTerminalDeliverySettled) =>
			await sendTaskChatMessageAcrossSessionTransports(
				{
					getScopedTerminalManager,
					getScopedClineTaskSessionService,
					getScopedAcpTaskSessionService,
					loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
					resolveClineTaskSessionLaunchConfig: async () =>
						await clineProviderServiceForQueuedPromptDelivery.resolveLaunchConfig(),
					broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
					onProgrammaticTerminalDeliverySettled,
				},
				scope,
				request,
			),
		cancelProgrammaticTerminalDelivery: async (scope, taskId, idempotencyKey) =>
			(await getScopedTerminalManager(scope)).cancelTaskChatInputDelivery(taskId, idempotencyKey),
		readPromptLibraryEntryTextSha256ByEntryId: async (workspaceId) => {
			const library = await readWorkspacePromptLibrarySnapshot(workspaceId);
			const shaByEntryId = new Map<string, string>();
			for (const entry of [
				...library.globalScopedPrompts,
				...library.repoScopedPrompts,
				...Object.values(library.taskScopedPromptsByTaskId).flat(),
			]) {
				shaByEntryId.set(entry.id, computeQueuedTaskPromptDeliveryTextSha256(entry.text));
			}
			return shaByEntryId;
		},
		onProjectedQueueChanged: deps.runtimeStateHub.broadcastQueuedTaskPromptDeliveriesUpdated,
		warn: deps.warn,
		// 托管门 + 持续盖章屏障：只发本实例托管的条目；托管者判死的条目先盖章等人确认（见 dispatcher 头注）。
		runtimeProcessInstanceCustody: {
			thisRuntimeProcessInstanceId: runtimeProcessInstanceHeartbeat.runtimeProcessInstanceId,
			runtimeProcessStartedAtEpochMs: runtimeProcessInstanceHeartbeat.startedAtEpochMs,
			readLiveRuntimeProcessInstanceIds: async () => await readLiveRuntimeProcessInstanceIds(),
		},
	});
	const unregisterQueuedTaskPromptDeliveryDispatchObserver =
		deps.runtimeStateHub.registerQueuedTaskPromptDeliveryDispatchObserver(queuedTaskPromptDeliveryDispatcher);
	// 排队 prompt 的启动清扫：收敛被上一次生命周期撂在半路的在途投递，并给跨过这次重启的条目盖章
	// （门控 0 据此等人看见再发）。必须在心跳写下之后——盖章按「托管实例此刻不在心跳里」判，同刻启动的
	// 另一个实例得先看得见我。不 await：纠偏动作，不是服务可用性的前置条件。
	void scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart({
		runtimeProcessStartedAtEpochMs: runtimeProcessInstanceHeartbeat.startedAtEpochMs,
		sweepingRuntimeProcessInstanceId: runtimeProcessInstanceHeartbeat.runtimeProcessInstanceId,
		onWorkspaceQueueRewritten: (workspaceId, snapshot) => {
			void queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(workspaceId, snapshot);
		},
	});

	const publishLiveTaskResourceUsageSnapshots = createLiveTaskResourceUsageSnapshotPublisher(
		(workspaceId, snapshots) => {
			deps.runtimeStateHub.broadcastTaskResourceUsageSnapshotsUpdated(workspaceId, snapshots);
		},
	);
	// 按 task 归因的资源占用采集的会话源。按 transport 分别列出、不做 taskId 合并：
	// listProjectRuntimeSessionSummaries 的「后写覆盖先写」会吞掉 PTY 会话的 pid。
	const listTerminalTaskResourceUsageAttributionSessionSources = (): TaskResourceUsageAttributionSessionSource[] =>
		deps.workspaceRegistry.listManagedWorkspaces().map(({ workspaceId, workspacePath, terminalManager }) => ({
			workspaceId,
			workspacePath,
			listSummaries: () => terminalManager.listSummaries(),
		}));
	const listClineTaskResourceUsageAttributionSessionSources = (): TaskResourceUsageAttributionSessionSource[] =>
		Array.from(clineTaskSessionServiceByWorkspaceId, ([workspaceId, service]) => ({
			workspaceId,
			workspacePath: clineWorkspacePathByWorkspaceId.get(workspaceId) ?? null,
			listSummaries: () => service.listSummaries(),
		}));
	const listAcpTaskResourceUsageAttributionSessionSources = (): TaskResourceUsageAttributionSessionSource[] =>
		Array.from(acpTaskSessionServiceByWorkspaceId, ([workspaceId, service]) => ({
			workspaceId,
			workspacePath: acpWorkspacePathByWorkspaceId.get(workspaceId) ?? null,
			listSummaries: () => service.listSummaries(),
		}));
	const enumerateCurrentTaskResourceUsageAttributionRoots = () =>
		enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: listTerminalTaskResourceUsageAttributionSessionSources,
			listClineSessionSources: listClineTaskResourceUsageAttributionSessionSources,
			listAcpSessionSources: listAcpTaskResourceUsageAttributionSessionSources,
		});
	// harness 根进程、MCP、agent 命令、残留孤儿、用户 shell / dev server 的内存与 CPU，按 task 归因后写 journal。
	const taskAttributedProcessTreeResourceSampler = createTaskAttributedProcessTreeResourceSampler({
		enumerateAttributionRoots: enumerateCurrentTaskResourceUsageAttributionRoots,
		// 卡片上的实时内存 / CPU 药丸：独立推流消息，不进 session summary。
		onLiveTaskResourceUsageSnapshotsUpdated: (snapshots) => {
			// 附上 token 用量与 worktree 磁盘体积（各自的监视器低频刷新），详情面板一并展示。
			publishLiveTaskResourceUsageSnapshots(
				snapshots.map((snapshot) =>
					snapshot.attributedTaskCardId === null
						? snapshot
						: {
								...snapshot,
								modelTokenUsageAcrossTaskSessions:
									taskAgentConversationModelTokenUsageJournalMonitor.summarizeLatestModelTokenUsageForTaskCard(
										snapshot.workspaceId,
										snapshot.attributedTaskCardId,
									),
								latestWorktreeDiskUsageBytes:
									taskWorktreeDiskUsageMeasurementMonitor.getLatestWorktreeDiskUsageBytesForTaskCard(
										snapshot.workspaceId,
										snapshot.attributedTaskCardId,
									),
							},
				),
			);
		},
	});
	// Claude Code / Codex 的模型 token 用量：每 5 分钟增量读 transcript / rollout，写累计快照进 journal。
	const taskAgentConversationModelTokenUsageJournalMonitor = createTaskAgentConversationModelTokenUsageJournalMonitor({
		listSessionSummariesWithWorkspace: () =>
			listTerminalTaskResourceUsageAttributionSessionSources().flatMap(({ workspaceId, listSummaries }) =>
				listSummaries().map((summary) => ({ workspaceId, summary })),
			),
	});
	// task worktree 的实体磁盘体积：每个活跃 worktree 最多 24 小时量一次。
	const taskWorktreeDiskUsageMeasurementMonitor = createTaskWorktreeDiskUsageMeasurementMonitor({
		listTaskWorkingDirectoryAttributions: () =>
			enumerateCurrentTaskResourceUsageAttributionRoots().taskWorkingDirectoryAttributions,
		isKanbanManagedTaskWorktreePath: (workingDirectoryPath) =>
			workingDirectoryPath.startsWith(`${getTaskWorktreesHomePath()}/`),
	});
	const countLiveInProcessClineSdkSessions = (): number => {
		let liveSessionCount = 0;
		for (const { listSummaries } of listClineTaskResourceUsageAttributionSessionSources()) {
			for (const summary of listSummaries()) {
				const { liveness } = resolveSessionFacets(summary);
				if (liveness === "starting" || liveness === "live" || liveness === "retrying") {
					liveSessionCount += 1;
				}
			}
		}
		return liveSessionCount;
	};

	const stopAndCollectProjectRuntimeSessionsForSafePersistence = async (
		workspaceId: string,
	): Promise<ActiveRuntimeSessionShutdownResult> => {
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		const clineTaskSessionService = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		return await stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace({
			terminalManager,
			clineTaskSessionService: clineTaskSessionService ?? null,
			acpTaskSessionService: acpTaskSessionService ?? null,
		});
	};
	const stopAllActiveRuntimeSessionsForShutdown = async () => {
		const workspacePathByWorkspaceId = new Map<string, string | null>();
		for (const { workspaceId, workspacePath } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}
		for (const [workspaceId, workspacePath] of clineWorkspacePathByWorkspaceId) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}
		for (const [workspaceId, workspacePath] of acpWorkspacePathByWorkspaceId) {
			workspacePathByWorkspaceId.set(workspaceId, workspacePath);
		}

		const results: Array<ActiveRuntimeSessionShutdownResult & { workspaceId: string; workspacePath: string | null }> =
			[];
		for (const [workspaceId, workspacePath] of workspacePathByWorkspaceId) {
			try {
				results.push({
					workspaceId,
					workspacePath,
					...(await stopAndCollectProjectRuntimeSessionsForSafePersistence(workspaceId)),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not safely stop runtime sessions for ${workspacePath ?? workspaceId}. ${message}`);
			}
		}
		return results;
	};
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of clineTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of acpTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			disposeAcpTaskSessionService(workspaceId);
			await disposeClineTaskSessionServiceAsync(workspaceId);
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	// exploratoryApi 是**无状态**的：它返回的每个方法都自带 scope 参数，所以整个运行时一个实例即可
	// （此前每次请求新建一个，纯属浪费）。提成单例还解开了 finding_candidate 转投的循环依赖——
	// 维护触发器要调它的 ingest，而它的手动维护又要调触发器。
	const exploratoryApi = createExploratoryApi({
		getScopedClineTaskSessionService,
		loadBoardCardAgentId: async (scope, taskId) => {
			const board = await loadWorkspaceBoardById(scope.workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
			return card?.agentId ?? null;
		},
		onExploratoryFindingsUpdated: (workspaceId, findings) => {
			deps.runtimeStateHub.broadcastExploratoryFindingsUpdated(workspaceId, findings);
		},
		// 读图：只合成投影，绝不触发 fork。会话清单缺 sidecar 时得到一张空图而不是错误——
		// 「还没有图」与「读不出图」对用户是两回事。
		loadExplorationThreadGraphProjection: async (scope, explorationId) => {
			const manager = await getScopedTerminalManager(scope);
			const { sessionRefs } = assembleExplorationThreadGraphSessionRefs({
				explorationId,
				sessionSummaries: manager.listSummaries(),
			});
			const loaded = await loadExplorationThreadGraphProjection({
				explorationId,
				storeRoot: resolveWorkspaceExplorationThreadGraphStoreRoot(scope.workspaceId),
				sessionRefs,
				turnSource: explorationThreadGraphReadOnlyTurnSource,
			});
			return {
				view: loaded.view,
				turnSourceUnavailableSessionIds: loaded.turnSourceUnavailableSessionIds,
			};
		},
		requestExplorationThreadGraphMaintenance: async (scope, explorationId) => {
			return translateExplorationThreadGraphMaintenanceOutcome(
				await explorationThreadGraphMaintenanceTrigger.requestImmediateMaintenance({
					workspaceId: scope.workspaceId,
					explorationId,
				}),
			);
		},
	});
	// late binding 的另一半（声明见上面触发器处）：到这里 exploratoryApi 已就位，把转投出口接上。
	// 逐条 try/catch：一条建议因容量上限等原因被拒，不该让同一批里其余的也落不进去。
	relayFindingCandidatesThroughExploratoryApi = async (workspaceId, requests) => {
		const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
		if (workspacePath === null) {
			return;
		}
		const workspaceScope: RuntimeTrpcWorkspaceScope = { workspaceId, workspacePath };
		for (const request of requests) {
			try {
				await exploratoryApi.ingestFindingCandidate(workspaceScope, request);
			} catch {
				// 转投是附加动作：标注仍在图上，下一次作业会用同样的确定性 id 再试。
			}
		}
	};

	// taskCardAction.* 的按卡串行器：必须是 runtime 级单例——api 对象按请求新建，串行器若也按请求新建就串不住任何东西。
	const taskCardActionPerTaskCommandSerializer = createTaskCardActionPerTaskCommandSerializer();

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		// runtimeApi / workspaceApi 提成局部变量：taskCardActionApi 复用它们的起停会话、ensure / 删 worktree 实现，
		// 与路由上暴露的是同一个实例，不复制逻辑。
		const runtimeApi = createRuntimeApi({
			getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
			getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
			loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
			setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
			getScopedTerminalManager,
			getScopedClineTaskSessionService,
			getScopedAcpTaskSessionService,
			resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
			runCommand: deps.runCommand,
			broadcastClineMcpAuthStatusesUpdated: deps.runtimeStateHub.broadcastClineMcpAuthStatusesUpdated,
			broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
			broadcastNotificationLogUpdated: deps.runtimeStateHub.broadcastNotificationLogUpdated,
			broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
			bumpClineSessionContextVersion: deps.runtimeStateHub.bumpClineSessionContextVersion,
			prepareForStateReset,
			getUpdateStatus: deps.getUpdateStatus,
			runUpdateNow: deps.runUpdateNow,
			queuedTaskPromptDeliveryDispatcher,
		});
		const workspaceApi = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
			getScopedClineTaskSessionService,
			loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
			broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
			broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
			buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
			listProjectRuntimeSessionSummaries,
			onQueuedTaskPromptDeliveriesRewrittenForTasksRemovedFromBoard: (workspaceId, snapshot) => {
				void queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(workspaceId, snapshot);
			},
		});
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			kanbanRequestOriginActorEvidence: {
				decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
					req.headers[KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME],
				),
				webUiPageLoadRequestOriginNonceVerificationStatus:
					verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue(
						req.headers[KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME],
					),
			},
			runtimeApi,
			workspaceApi,
			taskCardActionApi: createTaskCardActionApi({
				runtimeApi,
				workspaceApi,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				findTaskSessionSummaryLiveInRuntimeProcessMemory: findRuntimeSessionSummary,
				taskCardActionPerTaskCommandSerializer,
				// 永久删除丢掉排队 prompt 后立刻让出队引擎重读，不等兜底 sweep（与 saveState 差集清理同一个钩子）。
				onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards: (workspaceId, snapshot) => {
					void queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(workspaceId, snapshot);
				},
			}),
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				listProjectRuntimeSessionSummaries,
				stopAndCollectProjectRuntimeSessionsForSafePersistence,
				disposeProjectRuntime: async (workspaceId) => {
					const disposalFailureMessages: string[] = [];
					try {
						disposeAcpTaskSessionService(workspaceId);
						await disposeClineTaskSessionServiceAsync(workspaceId);
					} catch (error) {
						disposalFailureMessages.push(error instanceof Error ? error.message : String(error));
					}
					try {
						deps.disposeWorkspace(workspaceId, { stopTerminalSessions: false });
					} catch (error) {
						disposalFailureMessages.push(error instanceof Error ? error.message : String(error));
					}
					if (disposalFailureMessages.length > 0) {
						throw new Error(disposalFailureMessages.join(" "));
					}
				},
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon:
					deps.workspaceRegistry.listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
				serverCwd: process.cwd(),
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
				// Stop 边沿 → exploration thread graph 维护（B.2）。触发器自带四道闸，这里只交出边沿事实；
				// 绝不 await，判图要 fork 一个分身，压进 hook 响应路径会触发客户端硬超时。
				notifyExplorationThreadGraphAgentTurnStopped:
					explorationThreadGraphMaintenanceTrigger.notifyAgentTurnStopped,
			}),
			deploymentApi: createDeploymentApi({
				// 看板当前列快照：直读该 workspace 的 board.json，摊平 columns×cards → (taskId, columnId)。
				loadBoardTasksForWorkspace: async (scope) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					return board.columns.flatMap((column) =>
						column.cards.map((card) => ({ taskId: card.id, columnId: column.id })),
					);
				},
				// 确认框 agent response 按 agent 类型分源（plan Grilling #5）。
				loadTaskAgentResponsePreview: async (scope, taskId) => {
					// agent 类型判定必须廉价：绝不为终端任务触发 loadTaskSessionMessages —— 后者会 boot Cline SDK
					// session host（AGENTS.md 记载的 CI 卡死诱因）。先用「in-memory Cline summary agentId」+「看板卡
					// 配置的 agentId」双廉价信号判定是否 Cline 任务，二者皆非 cline 才走终端 agent 路径。
					const clineTaskSessionService = await getScopedClineTaskSessionService(scope);
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
					const isClineTask =
						clineTaskSessionService.getSummary(taskId)?.agentId === "cline" || card?.agentId === "cline";
					if (isClineTask) {
						// Cline（in-process SDK）：取任务聊天记录最后一条 assistant message；拿不到时优雅降级为 null。
						const messages = await clineTaskSessionService.loadTaskSessionMessages(taskId);
						let lastAssistantMessageContent: string | null = null;
						for (const message of messages) {
							if (message.role === "assistant") {
								lastAssistantMessageContent = message.content;
							}
						}
						return lastAssistantMessageContent;
					}
					// ACP 会话（omp 切到 ACP 时）：既没有 hook finalMessage，也不在 Cline 账本里；只认 cline 会让
					// 预览对它恒为 null。ACP service 的消息全在内存，读它同样廉价，不会 boot 任何 SDK host。
					// 判据只能是「ACP service 里有这条会话的活会话摘要且它盖的是 ACP 章」——绝不能拿卡片
					// agentId 兜底：omp 的两条通道共用 agentId="omp"，卡片判据会把一条 TUI 会话误判成 ACP，
					// 于是预览恒读 ACP 那份空消息表。
					const acpTaskSessionService = await getScopedAcpTaskSessionService(scope);
					const isAcpTask = isRuntimeAgentSessionSummaryDrivenByAcpProtocol(
						acpTaskSessionService.getSummary(taskId),
					);
					if (isAcpTask) {
						let lastAcpAssistantMessageContent: string | null = null;
						for (const message of acpTaskSessionService.listMessages(taskId)) {
							if (message.role === "assistant") {
								lastAcpAssistantMessageContent = message.content;
							}
						}
						return lastAcpAssistantMessageContent;
					}
					// 终端 agent（Claude 等）：取 hook 采集的最近 finalMessage；无则优雅降级为 null。
					const manager = await getScopedTerminalManager(scope);
					return manager.getSummary(taskId)?.latestHookActivity?.finalMessage ?? null;
				},
			}),
			workUnitRelationReadApi: createWorkUnitRelationReadApi({
				readRecordedInterWorkUnitRelationProjection:
					readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				readLatestNotificationSummaryTextOfTaskCard:
					readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive,
			}),
			workUnitRelationPresentationPreferenceApi: createWorkUnitRelationPresentationPreferenceApi({
				readRecordedInterWorkUnitRelationProjection:
					readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
				appendCommittedEventsIntoLedgerAndWaitForCommit:
					appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit,
			}),
			conversationTreeApi: createConversationTreeApi({
				getScopedClineTaskSessionService,
				loadBoardCardAgentId: async (scope, taskId) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
					return card?.agentId ?? null;
				},
			}),
			exploratoryApi,
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const isRemoteMode = isKanbanRemoteHost();

	const readRequestBody = (req: IncomingMessage, maxBytes = 4096): Promise<string> =>
		new Promise((resolve, reject) => {
			let body = "";
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error("Request body too large"));
					return;
				}
				body += chunk.toString("utf8");
			});
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});

	const getRemoteIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

	const tlsConfig = getKanbanRuntimeTls();
	const requestHandler = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
		try {
			if (handleHttpRequest(req, res).end) {
				return;
			}

			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);

			// ── Passcode gate (remote mode only) ──────────────────────────────
			const passcodeActive = isRemoteMode && isPasscodeEnabled();
			if (pathname === "/api/passcode/status") {
				if (passcodeActive) {
					const token = extractSessionTokenFromCookie(req.headers.cookie);
					const authenticated = token !== null && validateSession(token);
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: true, authenticated }));
				} else {
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: false, authenticated: true }));
				}
				return;
			}
			if (passcodeActive && req.method === "POST" && pathname === "/api/passcode/verify") {
				const ip = getRemoteIp(req);
				const rateLimit = checkRateLimit(ip);
				if (!rateLimit.allowed) {
					const retryAfterSec = rateLimit.lockedUntilMs
						? Math.ceil((rateLimit.lockedUntilMs - Date.now()) / 1000)
						: 30;
					res.writeHead(429, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"Retry-After": String(retryAfterSec),
					});
					res.end(JSON.stringify({ error: "Too many attempts. Please wait before trying again." }));
					return;
				}
				let body: string;
				try {
					body = await readRequestBody(req);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid request body." }));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid JSON." }));
					return;
				}
				const submitted =
					parsed !== null &&
					typeof parsed === "object" &&
					"passcode" in parsed &&
					typeof (parsed as Record<string, unknown>).passcode === "string"
						? ((parsed as Record<string, unknown>).passcode as string)
						: "";
				if (!validatePasscode(submitted)) {
					recordFailedAttempt(ip);
					res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ error: "Invalid passcode." }));
					return;
				}
				clearRateLimit(ip);
				const token = issueSession();
				const cookieFlags = [
					`kanban_session=${token}`,
					"HttpOnly",
					"SameSite=Strict",
					"Path=/",
					`Max-Age=${24 * 60 * 60}`,
					...(tlsConfig !== null ? ["Secure"] : []),
				].join("; ");
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": cookieFlags,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (passcodeActive) {
				// Check session cookie (browser flow) first, then internal bearer token (CLI flow).
				const sessionToken = extractSessionTokenFromCookie(req.headers.cookie);
				const sessionAuth = sessionToken !== null && validateSession(sessionToken);
				const bearerToken = extractBearerToken(req.headers.authorization);
				const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
				const authenticated = sessionAuth || internalAuth;
				if (!authenticated) {
					// Static assets (JS, CSS, images, fonts, icons, manifest) are served
					// freely even when unauthenticated. They contain no user data and are
					// required for the React app to boot and render the passcode gate.
					// Only API routes are hard-blocked; index.html is served normally so
					// PasscodeGateProvider in React can intercept before any API calls.
					if (pathname.startsWith("/api/")) {
						res.writeHead(401, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						res.end(JSON.stringify({ error: "Authentication required." }));
						return;
					}
					// Fall through — let the normal asset/index.html serving below handle it.
					// PasscodeGateProvider in main.tsx will render the gate before any
					// authenticated API calls are made.
				}
			}
			// ── End passcode gate ──────────────────────────────────────────────

			const oauthCallbackResponse = await handleClineMcpOauthCallback(requestUrl);
			if (oauthCallbackResponse) {
				res.writeHead(oauthCallbackResponse.statusCode, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(oauthCallbackResponse.body);
				return;
			}
			if (pathname.startsWith("/api/trpc")) {
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname.startsWith("/api/")) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	};
	const server = tlsConfig
		? createHttpsServer({ key: tlsConfig.key, cert: tlsConfig.cert }, requestHandler)
		: createServer(requestHandler);
	server.on("upgrade", (request, socket, head) => {
		if (handleSocketUpgrade(request, socket).end) {
			return;
		}

		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
		} catch {
			socket.destroy();
			return;
		}
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		// ── Passcode gate for WebSocket upgrades (remote mode only) ──────────
		const passcodeActive = isRemoteMode && isPasscodeEnabled();
		if (passcodeActive) {
			const sessionToken = extractSessionTokenFromCookie(request.headers.cookie);
			const sessionAuth = sessionToken !== null && validateSession(sessionToken);
			const bearerToken = extractBearerToken(request.headers.authorization);
			const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
			if (!sessionAuth && !internalAuth) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
		}
		// ── End passcode gate ─────────────────────────────────────────────────
		(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
		const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId });
	});
	// [tui-freeze] 诊断:终端回显链路与所有任务的输入处理共享这个 Node 事件循环,
	// 循环被同步重活占据时键盘输入会整体延迟——在 bridge 生命周期内持续采样延迟直方图。
	const stopEventLoopDelayMonitor = startEventLoopDelayMonitor();
	// fd 泄漏曾一路无声地越过 Darwin OPEN_MAX(10240)，才以「所有 git 调用 EBADF」的形式在一个毫不相干
	// 的子系统里间接显形；这条探针让 fd 水位在爆炸前就可见，对任何一类 fd 泄漏回归都同样有效。
	const stopProcessFileDescriptorWatermarkMonitor = startProcessFileDescriptorWatermarkMonitor();
	// Kanban 进程自身的内存 / CPU 基线：固定服务器成本的对照，也是进程内 Cline SDK 会话唯一可见的资源面。
	const stopKanbanRuntimeProcessSelfResourceSampleMonitor = startKanbanRuntimeProcessSelfResourceSampleMonitor({
		countLiveInProcessClineSdkSessions,
		countLiveSessionsWithOsProcess: () => enumerateCurrentTaskResourceUsageAttributionRoots().roots.length,
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
		validateUpgradeSession:
			isRemoteMode && isPasscodeEnabled()
				? (cookieHeader) => {
						const token = extractSessionTokenFromCookie(cookieHeader);
						return token !== null && validateSession(token);
					}
				: undefined,
	});
	server.on("upgrade", (request, socket) => {
		const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
		if (handled) {
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start local server.");
	}
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	// 启动即扫一次：账本里存的是绝对到期时刻，故 Kanban 停机期间流逝的时间自然计入，
	// 重启后能直接把「停机时早就到期」的记录处理掉，不需要任何补偿逻辑。
	agentSessionInactivityReclamationScheduler.start();
	queuedTaskPromptDeliveryDispatcher.start();
	// 与回收调度器同在 listen 之后启动：它要读三种 transport 的会话 summary 作为归因根。
	taskAttributedProcessTreeResourceSampler.start();
	taskAgentConversationModelTokenUsageJournalMonitor.start();
	taskWorktreeDiskUsageMeasurementMonitor.start();

	return {
		url,
		stopAllActiveRuntimeSessionsForShutdown,
		close: async () => {
			stalePendingTaskMessageInjectionSweepsForRuntimeLifetime.stop();
			agentSessionInactivityReclamationScheduler.stop();
			// 在途的 PTY 投递不等它落定（最长 ~200s）：下一次启动的清扫会把撂下的那条判成「可能已发出」交给人。
			queuedTaskPromptDeliveryDispatcher.stop();
			unregisterQueuedTaskPromptDeliveryDispatchObserver();
			// 先于会话拆除停止：把此刻仍存活进程的生命周期冲刷成 episode，而不是记成「进程退出」。
			taskAttributedProcessTreeResourceSampler.stop();
			taskAgentConversationModelTokenUsageJournalMonitor.stop();
			taskWorktreeDiskUsageMeasurementMonitor.stop();
			stopKanbanRuntimeProcessSelfResourceSampleMonitor();
			// ACP agent 是持有 stdio 的真子进程：不在这里拆掉，关服后它还活着、还能改仓库，
			// 而且它占着的 stdio 管道会把 Kanban 进程本身的退出一起拖住。
			for (const service of acpTaskSessionServiceByWorkspaceId.values()) {
				service.disposeAllTaskSessions();
			}
			acpTaskSessionServiceByWorkspaceId.clear();
			acpWorkspacePathByWorkspaceId.clear();
			await Promise.all(
				Array.from(clineTaskSessionServiceByWorkspaceId.values()).map(async (service) => {
					await service.dispose();
				}),
			);
			clineTaskSessionServiceByWorkspaceId.clear();
			clineWorkspacePathByWorkspaceId.clear();
			await clineWatcherRegistry.close();
			// 优雅退出主动销号，于是下一个实例不必等满宽限期才敢判本实例已死——重启后的排队 prompt
			// 提醒因此立刻生效，而不是迟到一个宽限期。非优雅退出没有这一步，靠宽限期兜底。
			await runtimeProcessInstanceHeartbeat.stop();
			await deps.runtimeStateHub.close();
			stopEventLoopDelayMonitor();
			stopProcessFileDescriptorWatermarkMonitor();
			await terminalWebSocketBridge.close();
			await activatedInterWorkUnitRelationLedgerLiveCapture.deactivate();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}
