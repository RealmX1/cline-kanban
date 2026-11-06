import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { delimiter, join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { ClaudeCodeTranscriptCompletedTurnSource } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import {
	type AcpTaskSessionService,
	createAcpTaskSessionService,
} from "../acp-client-session/acp-task-session-service";
import { createCodexConfigurationSyncService } from "../codex-configuration-sync/codex-configuration-sync-service";
import { readCodexConfigurationTaskSourceContext } from "../codex-configuration-sync/codex-configuration-task-source-context";
import { persistCodexConfigurationProfileBindingForMainTaskSession } from "../codex-configuration-sync/task-card-codex-configuration-profile-binding";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentSessionSummaryDrivenByAcpProtocol } from "../core/agent-catalog";
import type {
	RuntimeAgentSessionCountsAffectedByRuntimeExit,
	RuntimeCommandRunResponse,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeIngestExploratoryFindingCandidateRequest,
	RuntimePlannedHandoverRestartResponse,
	RuntimeRunUpdateResponse,
	RuntimeStopTerminatingHostedAgentSessionsResponse,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import { isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports } from "../core/codex-native-prompt-delivery-journal";
import { resolveCreationStartupSettings } from "../core/creation-startup-settings";
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
import type {
	HostedAgentSessionDispositionForRuntimeShutdown,
	RuntimeShutdownTrigger,
} from "../core/runtime-shutdown-trigger";
import { resolveSessionFacets } from "../core/session-activity";
import {
	projectConversationSessionMetadataForMainSessionBinding,
	resolveMainTaskConversationSessionId,
} from "../core/task-main-conversation-session-binding";
import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { isTaskCardShelved } from "../core/task-shelving-state";
import { createDailyWorkProgressStatisticsCollector } from "../daily-work-progress-statistics/daily-work-progress-statistics-collector";
import { createDailyWorkProgressStatisticsService } from "../daily-work-progress-statistics/daily-work-progress-statistics-service";
import {
	authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone,
	finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone,
	listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure,
	revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed,
} from "../deployment/post-deploy-verification-done-entry-gate";
import { startVerificationExecutionRecoveryLifecycle } from "../deployment/verification-execution-recovery";
import { startEventLoopDelayMonitor } from "../diagnostics/event-loop-delay-monitor";
import { startKanbanRuntimeProcessSelfResourceSampleMonitor } from "../diagnostics/kanban-runtime-process-self-resource-sample-monitor";
import { startProcessFileDescriptorWatermarkMonitor } from "../diagnostics/process-file-descriptor-watermark-monitor";
import { createTaskAgentConversationModelTokenUsageJournalMonitor } from "../diagnostics/task-agent-conversation-model-token-usage-journal-monitor";
import { createTaskAttributedProcessTreeResourceSampler } from "../diagnostics/task-attributed-process-tree-resource-sampler";
import { createTaskWorktreeDiskUsageMeasurementMonitor } from "../diagnostics/task-worktree-disk-usage-measurement-monitor";
import { logTuiFreezeError } from "../diagnostics/tui-freeze-logger";
import { translateExplorationThreadGraphMaintenanceOutcome } from "../exploration-thread-graph/exploration-thread-graph-maintenance-outcome-translation";
import { createExplorationThreadGraphMaintenanceTrigger } from "../exploration-thread-graph/exploration-thread-graph-maintenance-trigger";
import { loadExplorationThreadGraphProjection } from "../exploration-thread-graph/exploration-thread-graph-projection-loader";
import { assembleExplorationThreadGraphSessionRefs } from "../exploration-thread-graph/exploration-thread-graph-session-refs";
import { resolveWorkspaceExplorationThreadGraphStoreRoot } from "../exploration-thread-graph/exploration-thread-graph-store-location";
import { createIndependentTaskCreationService } from "../independent-task-creation/independent-task-creation-service";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
	runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
} from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { verifyKanbanWebUiPageLoadRequestOriginNonceRequestHeaderValue } from "../inter-work-unit-relation-ledger/kanban-web-ui-page-load-request-origin-nonce-registry";
import { readTaskAssistanceModelProviderRoutingSettings } from "../model-provider-access/kanban-model-provider-settings";
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
import {
	beginManagedTaskPromptDelivery,
	observeManagedTaskPromptDeliveryChanges,
} from "../state/managed-task-prompt-delivery-coordinator";
import { recordProgrammaticReviewExplicitUserStopObservations } from "../state/programmatic-review-explicit-user-stop-observations";
import { readWorkspacePromptLibrarySnapshot } from "../state/prompt-library-store";
import {
	computeQueuedTaskPromptDeliveryTextSha256,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../state/queued-task-prompt-delivery-store";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	readLiveRuntimeProcessInstanceIds,
	readRuntimeProcessInstanceLiveness,
	startRuntimeProcessInstanceHeartbeat,
} from "../state/runtime-process-instance-heartbeat-registry";
import { registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard } from "../state/workspace-board-save-state-post-deploy-verification-done-entry-guard-port";
import {
	getTaskWorktreesHomePath,
	getWorkspaceDirectoryPath,
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceState,
	resolveRegisteredWorkspaceScopeByIdWithoutGitProbe,
} from "../state/workspace-state";
import {
	readTaskClosureOperation,
	withTaskClosureLifecycleLocks,
	writeTaskClosureHistoryRecord,
	writeTaskClosureOperation,
} from "../task-closure/task-closure-operation-store";
import { createTaskClosureRecoveryMonitor } from "../task-closure/task-closure-recovery-monitor";
import { observeOwnerSessionInterruptBeforeOwnedCommandExecutionTerminalInterrupt } from "../task-command-execution/task-command-execution-owner-session-interrupt-port";
import { createTaskCommandExecutionService } from "../task-command-execution/task-command-execution-service";
import { createTaskEditorCreationSubmissionService } from "../task-editor-creation/task-editor-creation-submission-service";
import { recordTaskEditorCreationExplicitStop } from "../task-editor-creation/task-editor-creation-submission-store";
import { collectTaskIndexingMaterials } from "../task-indexing-support/collect-task-indexing-materials";
import { executeTaskAnalysisApi } from "../task-indexing-support/task-analysis-api-executor";
import { TASK_ANALYSIS_SHARED_CONTEXT_VERSION } from "../task-indexing-support/task-analysis-shared-prompt-prefix";
import { createTaskIndexingSupportRuntimeService } from "../task-indexing-support/task-indexing-support-runtime-service";
import { loadAndAdvanceSharedTaskIndexingContext } from "../task-indexing-support/task-indexing-support-storage";
import { createTaskLookupConversationService } from "../task-indexing-support/task-lookup-conversation-service";
import { TaskVisualizationArtifactService } from "../task-visualization-artifacts/task-visualization-artifact-service";
import { handleTaskVisualizationContentHttpRequest } from "../task-visualization-artifacts/task-visualization-content-http-handler";
import {
	readCreationAgentDefaultModel,
	readCreationAgentDefaultModelWithoutBlockingBacklogCard,
} from "../terminal/creation-agent-default-model";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createConversationTreeApi } from "../trpc/conversation-tree-api";
import { createDeploymentApi } from "../trpc/deployment-api";
import { createExploratoryApi } from "../trpc/exploratory-api";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi, type TaskSessionStopRequestScope } from "../trpc/runtime-api";
import { createTaskCardActionApi } from "../trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../trpc/task-card-action-per-task-command-serializer";
import { sendTaskChatMessageAcrossSessionTransports } from "../trpc/task-chat-message-send-across-session-transports";
import { createWorkUnitRelationAssertionWriteApi } from "../trpc/work-unit-relation-assertion-write-api";
import { applyReferenceRelationModelingChanges } from "../trpc/work-unit-relation-modeling-write-api";
import { createWorkUnitRelationPresentationPreferenceApi } from "../trpc/work-unit-relation-presentation-preference-api";
import {
	createWorkUnitRelationReadApi,
	readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive,
} from "../trpc/work-unit-relation-read-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import {
	type ActiveRuntimeSessionShutdownResult,
	countAcpTaskSessionsInterruptedByRuntimeExit,
	stopActiveTerminalAndAcpRuntimeSessionsForWorkspace,
} from "./active-runtime-session-shutdown";
import { createAgentSessionInactivityReclamationScheduler } from "./agent-session-inactivity-reclamation-scheduler";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { reconcileWorkspaceCodexNativePromptDeliveryAcceptances } from "./codex-native-prompt-delivery-acceptance-reconciliation";
import { createCrossProjectTaskWorktreeGitMetadataCache } from "./cross-project-task-worktree-git-metadata-cache";
import { loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace } from "./hosted-agent-session-orphan-reclamation-deadline-at-runtime-detach";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import {
	startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime,
	sweepStalePendingTaskMessageInjectionsForAllWorkspaces,
} from "./pending-task-message-injection-startup-sweep";
import { createPromptDraftUsageService } from "./prompt-draft-usage-service";
import { createQueuedTaskPromptDeliveryDispatcher } from "./queued-task-prompt-delivery-dispatcher";
import type { RuntimeStateHub } from "./runtime-state-hub";
import { parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl } from "./runtime-state-stream-workspace-metadata-probe-scope-url-parameter";
import { scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart } from "./stale-queued-task-prompt-delivery-startup-sweep";
import { createTaskMainSessionHandoverCoordinator } from "./task-main-session-handover-coordinator";
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
	// agent session PTY host 模式才有：runtime 缺席期间存进 host 的 hook 事件，由这里的 hooks ingest 按序应用。
	agentSessionPtyHostHookSpool?: {
		bindSpooledHookIngestRequestApplier: (
			spooledHookIngestRequestApplier: (spooledHookIngestRequest: unknown) => Promise<RuntimeHookIngestResponse>,
		) => void;
		drainPendingHookSpoolEntriesBeforeDirectHookIngest: (workspaceId: string, taskId: string) => Promise<void>;
	};
	// runtime 退出类请求（`kanban runtime handover-restart` / `stop --terminate-hosted-agent-sessions`）的执行方：
	// cli.ts 装好 graceful shutdown 之后才能执行，所以这里只给读取函数。缺席或尚未就绪时 procedure 报错。
	readRuntimeExitRequestHandler?: () => RuntimeExitRequestHandler | null;
}

export interface RuntimeExitRequestHandler {
	agentSessionPtyHostModeEnabled: boolean;
	isRuntimeShutdownInProgress: () => boolean;
	// 同步置位「退出已开始」，实际流程延后一拍再跑：先让 tRPC 响应发出去。
	startRuntimeShutdownAfterResponseIsSent: (trigger: RuntimeShutdownTrigger) => void;
}

export interface RuntimeServer {
	url: string;
	stopAllActiveRuntimeSessionsForShutdown: (
		hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown,
	) => Promise<
		Array<
			ActiveRuntimeSessionShutdownResult & {
				workspaceId: string;
				workspacePath: string | null;
			}
		>
	>;
	// runtime 退出流程的第一步：不再起新工作（会话回收调度、排队 prompt 出队、陈旧清扫），HTTP 停止接受新连接
	// （新到的 hook 走 spool、CLI 写动词进入重启等待）。handover 时以 1012 关闭浏览器连接，web-ui 据此提示「正在热重启」。
	stopAcceptingNewWorkBeforeRuntimeExit: (input: { closeBrowserConnectionsBecauseRuntimeIsRestarting: boolean }) => {
		waitForRuntimeOwnedBackgroundServicesToStopBeforeSessionDetach: () => Promise<void>;
		waitForAlreadyStartedQueuedPromptDispatchAttemptsToSettle: () => Promise<void>;
		stopRemainingQueuedPromptDispatchAttemptsBeforeSessionDetach: () => void;
	};
	countAgentSessionsAffectedByRuntimeExit: () => RuntimeAgentSessionCountsAffectedByRuntimeExit;
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
	let verificationExecutionRecoveryLifecycle: ReturnType<typeof startVerificationExecutionRecoveryLifecycle> | null =
		null;

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
		startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime({
			sweepAllWorkspacesOnce: () =>
				sweepStalePendingTaskMessageInjectionsForAllWorkspaces({
					getSummary: (workspaceId, conversationSessionId) =>
						deps.workspaceRegistry
							.getTerminalManagerForWorkspace(workspaceId)
							?.getSummary(conversationSessionId) ?? null,
					onAutomaticFailureContinuationDeliveryObserved: (workspaceId, conversationSessionId, ...observation) =>
						deps.workspaceRegistry
							.getTerminalManagerForWorkspace(workspaceId)
							?.reconcileHistoricalAutomaticFailureContinuationDelivery(conversationSessionId, ...observation),
				}),
		});

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
		const requestedWorkspaceContext = await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe(requestedWorkspaceId);
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
	const promptDraftUsageService = createPromptDraftUsageService({ warn: deps.warn });
	const dailyWorkProgressStatisticsService = createDailyWorkProgressStatisticsService({
		readCostRecorderRuntimeIdentity: () => ({
			runtimeProcessInstanceId: runtimeProcessInstanceHeartbeat.runtimeProcessInstanceId,
			runtimeOrigin: getKanbanRuntimeOrigin(),
		}),
		storageFilePath: join(
			getRuntimeHomePath(),
			"daily-work-progress-statistics",
			"confirmed-work-progress-statistics.json",
		),
		collect: createDailyWorkProgressStatisticsCollector(),
		onUpdated: (revision) => deps.runtimeStateHub.broadcastDailyWorkProgressStatisticsUpdated?.(revision),
		warn: deps.warn,
	});
	const taskVisualizationArtifactApi = new TaskVisualizationArtifactService({
		resolveWorkspaceScope: async (workspaceId) => {
			const workspace = await resolveRegisteredWorkspaceScopeByIdWithoutGitProbe(workspaceId);
			return workspace ? { workspaceId, workspacePath: workspace.repoPath } : null;
		},
		assertTaskMayPublish: async (scope, taskId) => {
			const board = await loadWorkspaceBoardById(scope.workspaceId);
			const column = board.columns.find((entry) => entry.cards.some((card) => card.id === taskId));
			if (!column) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在，只允许读取已有可视化。" });
			if (column.id === "trash")
				throw new TRPCError({ code: "FORBIDDEN", message: "任务已结束，只允许读取已有可视化。" });
		},
		resolveTaskTitle: async (scope, taskId) => {
			const board = await loadWorkspaceBoardById(scope.workspaceId);
			return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.title ?? null;
		},
		onArtifactsUpdated: (workspaceId, taskId) =>
			deps.runtimeStateHub.broadcastTaskVisualizationArtifactsUpdated?.(workspaceId, taskId),
		warn: deps.warn,
	});
	deps.runtimeStateHub.attachTaskVisualizationArtifactService?.(taskVisualizationArtifactApi);
	deps.runtimeStateHub.registerAgentConversationInputAcceptedListener?.(
		({ workspaceId, summary, submittedPromptText }) => {
			promptDraftUsageService.notifyUserPromptSubmitted({
				workspaceId,
				taskId: summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId,
				submittedAtEpochMs: summary.agentConversationPromptSubmissionAcceptance?.confirmedAtMs ?? Date.now(),
				submittedPromptText,
				currentIdentity: summary.agentNativeConversationSessionIdentity,
				sourceAgentId: summary.agentId ?? undefined,
			});
		},
	);

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
	// ACP（omp 等）会话按 workspace 作用域持有。
	const acpTaskSessionServiceByWorkspaceId = new Map<string, AcpTaskSessionService>();
	// 关服 / 重置时也要遍历「只跑过 ACP 会话」的 workspace，
	// 它们未必在 workspaceRegistry 中出现过。
	const acpWorkspacePathByWorkspaceId = new Map<string, string>();
	const getScopedAcpTaskSessionService = async (scope: RuntimeTrpcWorkspaceScope): Promise<AcpTaskSessionService> => {
		let service = acpTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createAcpTaskSessionService({
				workspaceId: scope.workspaceId,
				workspaceRepositoryPath: scope.workspacePath,
			});
			service.setUserPromptSubmittedListener((taskId, text) => {
				const summary = service?.getSummary(taskId);
				promptDraftUsageService.notifyUserPromptSubmitted({
					workspaceId: scope.workspaceId,
					taskId: summary?.taskConversationSessionMetadata?.workspaceTaskId ?? taskId,
					submittedAtEpochMs: Date.now(),
					submittedPromptText: text,
					sourceAgentId: summary?.agentId ?? "omp",
					currentIdentity: summary?.agentNativeConversationSessionIdentity,
				});
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
	const listProjectRuntimeSessionSummaries = (workspaceId: string): RuntimeTaskSessionSummary[] => {
		const summariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		for (const summary of terminalManager?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		for (const summary of acpTaskSessionService?.listSummaries() ?? []) {
			summariesByTaskId.set(summary.taskId, summary);
		}
		return Array.from(summariesByTaskId.values());
	};
	const codexConfigurationSyncService = createCodexConfigurationSyncService({
		readTaskSourceContext: () =>
			readCodexConfigurationTaskSourceContext(deps.workspaceRegistry.listManagedWorkspaces()),
		listTaskProfileBindings: async () => {
			const bindings: Array<{ workspaceId: string; conversationSessionId: string; profileId: string }> = [];
			const results = await Promise.allSettled(
				deps.workspaceRegistry.listManagedWorkspaces().map(async ({ workspaceId }) => {
					const board = await loadWorkspaceBoardById(workspaceId);
					for (const card of board.columns.flatMap((column) => column.cards))
						if (card.codexConfigurationProfileId)
							bindings.push({
								workspaceId,
								conversationSessionId: resolveMainTaskConversationSessionId(card),
								profileId: card.codexConfigurationProfileId,
							});
				}),
			);
			return {
				bindings,
				unavailableWorkspaceCount: results.filter((result) => result.status === "rejected").length,
			};
		},
		reconcileRetainedTerminalInput: async () => {
			for (const { terminalManager } of deps.workspaceRegistry.listManagedWorkspaces())
				await terminalManager.restoreTerminalInputRetainedDuringCodexProfileAdoption();
		},
		listSessions: () =>
			deps.workspaceRegistry
				.listManagedWorkspaces()
				.flatMap(({ workspaceId, terminalManager }) =>
					terminalManager.listSummaries().map((summary) => ({ workspaceId, summary })),
				),
		onUpdated: (revision) => deps.runtimeStateHub.broadcastCodexConfigurationSyncUpdated?.(revision),
		onSessionProfileBound: async (
			workspaceId,
			conversationSessionId,
			profileId,
			onlyUpdatePermissionSelectionSource,
		) => {
			const workspacePath = deps.workspaceRegistry
				.listManagedWorkspaces()
				.find((workspace) => workspace.workspaceId === workspaceId)?.workspacePath;
			if (!workspacePath) throw new Error("工作区暂不可用，profile 绑定恢复后自动补做。");
			const bindingIsCurrent = await persistCodexConfigurationProfileBindingForMainTaskSession({
				workspaceId,
				workspacePath,
				conversationSessionId,
				profileId,
				permissionSelectionSource: "profile",
				onlyUpdatePermissionSelectionSource,
				broadcastWorkspaceUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
			});
			if (bindingIsCurrent)
				deps.workspaceRegistry
					.getTerminalManagerForWorkspace(workspaceId)
					?.applyCodexConfigurationProfileBinding(conversationSessionId, profileId);
		},
		onWriterPermissionsObserved: (workspaceId, conversationSessionId, fields) =>
			deps.workspaceRegistry
				.getTerminalManagerForWorkspace(workspaceId)
				?.applyCodexEffectivePermissionMode(conversationSessionId, fields),
		resumeSessionToAdoptProfile: async ({ workspaceId, summary, profileId, onBeforeProcessReplacement }) => {
			const workspace = deps.workspaceRegistry
				.listManagedWorkspaces()
				.find((workspace) => workspace.workspaceId === workspaceId);
			const nativeSessionId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
			if (!workspace?.workspacePath || !nativeSessionId || !summary.runtimeSessionIncarnationId)
				return { resumed: false, reason: "等待原工作区和原生会话身份恢复后自动重验。" };
			const pendingProcessReplacementRetainedInputRecordPath =
				workspace.terminalManager.getPendingCodexProfileProcessReplacementRetainedInputRecordPath(summary.taskId);
			if (resolveSessionFacets(summary).liveness !== "live" && !pendingProcessReplacementRetainedInputRecordPath)
				return { resumed: false, reason: "未持有可继续的自动启动记录，或 Stop 已取消续接；保留原决定。" };
			const response = await runtimeApi.refreshTaskTerminal(
				{ workspaceId, workspacePath: workspace.workspacePath },
				{ taskId: summary.taskId },
				{
					profileId,
					pendingProcessReplacementRetainedInputRecordPath,
					expectedRuntimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
					expectedNativeSessionId: nativeSessionId,
					onBeforeProcessReplacement,
				},
			);
			return { resumed: response.ok, reason: response.error ?? "同一原生会话已续接，等待配置实际加载核验。" };
		},
	});
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
		inspectNativeTurnExecutionBeforeReviewReclamation: async (workspaceId, taskId) =>
			(await deps.workspaceRegistry
				.getTerminalManagerForWorkspace(workspaceId)
				?.inspectCodexNativeTurnBeforeReviewSessionReclamation(taskId)) ?? "allow_reclamation",
		reclaimAgentSession: createTransportAwareAgentSessionReclamationExecutor({
			getTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
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
				case "acp_stdio_subprocess":
					acpTaskSessionServiceByWorkspaceId
						.get(workspaceId)
						?.applyAgentSessionReclamationOutcome(record.taskId, outcome);
					return;
			}
		},
	});
	const queuedTaskPromptDeliveryDispatcher = createQueuedTaskPromptDeliveryDispatcher({
		isTaskConversationSessionReportExecutionAllowed: async (workspaceId, origin) => {
			const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			return workspacePath
				? runtimeApi.isTaskConversationSessionReportExecutionAllowed({ workspaceId, workspacePath }, origin)
				: false;
		},
		getTaskSessionSummary: findRuntimeSessionSummary,
		hasPendingProgrammaticTaskChatInputDelivery: (workspaceId, taskId) =>
			deps.workspaceRegistry
				.getTerminalManagerForWorkspace(workspaceId)
				?.hasPendingProgrammaticTaskChatInputDelivery(taskId) ?? false,
		resolveWorkspaceScope: (workspaceId) => {
			const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
			return workspacePath === null ? null : { workspaceId, workspacePath };
		},
		sendThroughTaskChatTransports: async (
			scope,
			request,
			onProgrammaticTerminalDeliverySettled,
			injectionLedgerTaskId,
			validateBeforeTerminalWrite,
		) =>
			await sendTaskChatMessageAcrossSessionTransports(
				{
					getScopedTerminalManager,
					getScopedAcpTaskSessionService,
					loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
					broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
					onProgrammaticTerminalDeliverySettled,
					programmaticTerminalDeliveryReceiptPersistenceOwner: "queued_task_prompt_delivery_store",
					programmaticInjectionLedgerTaskId: injectionLedgerTaskId,
					validateBeforeTerminalWrite,
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
	const stopObservingManagedTaskPromptDeliveries = observeManagedTaskPromptDeliveryChanges(async (workspaceId) => {
		await queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(
			workspaceId,
			await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId),
		);
	});
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
	const listAcpTaskResourceUsageAttributionSessionSources = (): TaskResourceUsageAttributionSessionSource[] =>
		Array.from(acpTaskSessionServiceByWorkspaceId, ([workspaceId, service]) => ({
			workspaceId,
			workspacePath: acpWorkspacePathByWorkspaceId.get(workspaceId) ?? null,
			listSummaries: () => service.listSummaries(),
		}));
	const enumerateCurrentTaskResourceUsageAttributionRoots = () =>
		enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: listTerminalTaskResourceUsageAttributionSessionSources,
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

	// 缺省终止 hosted 会话：删项目等路径（worktree 都要删了）必须停掉会话。只有 runtime 退出才传 detach。
	const stopAndCollectProjectRuntimeSessionsForSafePersistence = async (
		workspaceId: string,
		hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown = "terminate_hosted_agent_sessions",
	): Promise<ActiveRuntimeSessionShutdownResult> => {
		const terminalManager = deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId);
		const acpTaskSessionService = acpTaskSessionServiceByWorkspaceId.get(workspaceId);
		const detachesHostedAgentSessions =
			hostedAgentSessionDisposition === "detach_hosted_agent_sessions_for_successor_runtime";
		return await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
			terminalManager,
			acpTaskSessionService: acpTaskSessionService ?? null,
			hostedAgentSessionDisposition,
			...(detachesHostedAgentSessions && terminalManager
				? {
						readHostedSessionOrphanReclamationEligibleAtEpochMs:
							await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace(workspaceId, deps.warn),
					}
				: {}),
		});
	};
	const stopAllActiveRuntimeSessionsForShutdown = async (
		hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown,
	) => {
		const workspacePathByWorkspaceId = new Map<string, string | null>();
		for (const { workspaceId, workspacePath } of deps.workspaceRegistry.listManagedWorkspaces()) {
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
					...(await stopAndCollectProjectRuntimeSessionsForSafePersistence(
						workspaceId,
						hostedAgentSessionDisposition,
					)),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not safely stop runtime sessions for ${workspacePath ?? workspaceId}. ${message}`);
			}
		}
		return results;
	};
	const countAgentSessionsAffectedByRuntimeExit = (): RuntimeAgentSessionCountsAffectedByRuntimeExit => {
		let agentSessionsHostedByAgentSessionPtyHost = 0;
		let agentSessionsWithPtyOwnedByRuntimeProcess = 0;
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			const counts = deps.workspaceRegistry
				.getTerminalManagerForWorkspace(workspaceId)
				?.countActiveTerminalSessionsByPtyOwnership();
			agentSessionsHostedByAgentSessionPtyHost += counts?.hostedInAgentSessionPtyHost ?? 0;
			agentSessionsWithPtyOwnedByRuntimeProcess += counts?.inProcessPtyOwnedByRuntime ?? 0;
		}
		const conversationAgentSessionsRunningInsideRuntimeProcess = countAcpTaskSessionsInterruptedByRuntimeExit(
			acpTaskSessionServiceByWorkspaceId.values(),
		);
		return {
			agentSessionsHostedByAgentSessionPtyHost,
			agentSessionsWithPtyOwnedByRuntimeProcess,
			conversationAgentSessionsRunningInsideRuntimeProcess,
			inFlightExplorationThreadGraphMaintenanceJobs:
				explorationThreadGraphMaintenanceTrigger.countInFlightMaintenanceJobs(),
		};
	};
	const requireRuntimeExitRequestHandler = (): RuntimeExitRequestHandler => {
		const runtimeExitRequestHandler = deps.readRuntimeExitRequestHandler?.() ?? null;
		if (runtimeExitRequestHandler === null) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "This Kanban runtime cannot be restarted or stopped over the API yet.",
			});
		}
		return runtimeExitRequestHandler;
	};
	const requestPlannedHandoverRestartPreservingHostedAgentSessions = async (input: {
		allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost?: boolean;
	}): Promise<RuntimePlannedHandoverRestartResponse> => {
		const runtimeExitRequestHandler = requireRuntimeExitRequestHandler();
		const agentSessionCountsAffectedByRuntimeExit = countAgentSessionsAffectedByRuntimeExit();
		const responseFacts = {
			runtimeProcessId: process.pid,
			agentSessionPtyHostModeEnabled: runtimeExitRequestHandler.agentSessionPtyHostModeEnabled,
			agentSessionCountsAffectedByRuntimeExit,
		};
		if (runtimeExitRequestHandler.isRuntimeShutdownInProgress()) {
			return { outcome: "runtime_shutdown_already_in_progress", ...responseFacts };
		}
		const agentSessionsThatHandoverWouldInterrupt =
			agentSessionCountsAffectedByRuntimeExit.agentSessionsWithPtyOwnedByRuntimeProcess +
			agentSessionCountsAffectedByRuntimeExit.conversationAgentSessionsRunningInsideRuntimeProcess;
		if (
			agentSessionsThatHandoverWouldInterrupt > 0 &&
			input.allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost !== true
		) {
			return {
				outcome: "refused_because_agent_sessions_not_preserved_by_agent_session_pty_host_would_be_interrupted",
				...responseFacts,
			};
		}
		runtimeExitRequestHandler.startRuntimeShutdownAfterResponseIsSent({
			kind: "planned_handover_restart_preserving_hosted_agent_sessions",
			requestedVia: "runtime_trpc_procedure",
		});
		return { outcome: "handover_restart_started", ...responseFacts };
	};
	const requestRuntimeStopTerminatingHostedAgentSessions =
		async (): Promise<RuntimeStopTerminatingHostedAgentSessionsResponse> => {
			const runtimeExitRequestHandler = requireRuntimeExitRequestHandler();
			const responseFacts = {
				runtimeProcessId: process.pid,
				agentSessionCountsAffectedByRuntimeExit: countAgentSessionsAffectedByRuntimeExit(),
			};
			if (runtimeExitRequestHandler.isRuntimeShutdownInProgress()) {
				return { outcome: "runtime_shutdown_already_in_progress", ...responseFacts };
			}
			runtimeExitRequestHandler.startRuntimeShutdownAfterResponseIsSent({
				kind: "explicit_stop_terminating_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			});
			return { outcome: "stop_started", ...responseFacts };
		};
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
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
	// 整板保存的 Post-Deploy Verification 门禁兜底（浏览器 / 旧 bundle 的 saveState 不能把受门禁、未结案的卡带进 Done）。
	registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(
		listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure,
	);
	// 跨项目切换面板「其他项目」行的 git 元数据缓存：同理必须是 runtime 级单例，多个标签页的轮询才能在这里去重。
	const crossProjectTaskWorktreeGitMetadataCache = createCrossProjectTaskWorktreeGitMetadataCache({
		listRegisteredWorkspacePathsById: async () =>
			new Map((await listWorkspaceIndexEntries()).map((entry) => [entry.workspaceId, entry.repoPath])),
		loadWorkspaceBoardById,
	});

	const hooksApiDependenciesSharedByDirectAndSpooledHookIngest = {
		resolveCurrentTaskConversationSessionSummaryForLifecycle: async (
			workspaceId: string,
			summary: RuntimeTaskSessionSummary,
		) => {
			const board = await loadWorkspaceBoardById(workspaceId);
			const taskId = summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId;
			const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
			return card
				? {
						...summary,
						taskConversationSessionMetadata: projectConversationSessionMetadataForMainSessionBinding(
							card,
							summary,
						),
					}
				: summary;
		},
		notifyPromptDraftUserPromptSubmitted: promptDraftUsageService.notifyUserPromptSubmitted,
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
		ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
		broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
		broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
		// Stop 边沿 → exploration thread graph 维护（B.2）。触发器自带四道闸，这里只交出边沿事实；
		// 绝不 await，判图要 fork 一个分身，压进 hook 响应路径会触发客户端硬超时。
		notifyExplorationThreadGraphAgentTurnStopped: explorationThreadGraphMaintenanceTrigger.notifyAgentTurnStopped,
	};
	// spool 重放走同一套 hooks ingest，只是不再「先排空 spool」（它自己就是排空）。
	const hooksApiForHookEventsSpooledInAgentSessionPtyHost = createHooksApi({
		...hooksApiDependenciesSharedByDirectAndSpooledHookIngest,
		ingestsHookEventsReplayedFromAgentSessionPtyHostSpool: true,
	});
	deps.agentSessionPtyHostHookSpool?.bindSpooledHookIngestRequestApplier((spooledHookIngestRequest) =>
		hooksApiForHookEventsSpooledInAgentSessionPtyHost.ingest(spooledHookIngestRequest as RuntimeHookIngestRequest),
	);

	let pauseAutomaticMainSessionHandoverForStoppedTask:
		| ((workspaceId: string, taskId: string) => Promise<void>)
		| undefined;
	let recordTaskEditorCreationStop: ((workspaceId: string, taskId: string) => Promise<void>) | undefined;
	let applyOwnedCommandExecutionPolicyForSessionStopRequest:
		| ((workspaceId: string, taskId: string, stopRequestScope?: TaskSessionStopRequestScope) => Promise<void>)
		| undefined;
	const runtimeApi = createRuntimeApi({
		recordManagedTaskPromptDeliveries: true,
		onTaskSessionStopRequested: async (workspaceId, taskId, stopRequestScope) => {
			try {
				await applyOwnedCommandExecutionPolicyForSessionStopRequest?.(workspaceId, taskId, stopRequestScope);
				await recordProgrammaticReviewExplicitUserStopObservations({
					workspaceId,
					workspaceTaskId: taskId,
					summaries: listProjectRuntimeSessionSummaries(workspaceId).filter(
						(summary) =>
							summary.taskId === taskId || summary.taskConversationSessionMetadata?.workspaceTaskId === taskId,
					),
				});
			} finally {
				await Promise.all([
					pauseAutomaticMainSessionHandoverForStoppedTask?.(workspaceId, taskId),
					recordTaskEditorCreationStop?.(workspaceId, taskId),
				]);
			}
		},
		getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
		getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
		loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
		setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
		getScopedTerminalManager,
		getScopedAcpTaskSessionService,
		resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
		runCommand: deps.runCommand,
		broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
		broadcastNotificationLogUpdated: deps.runtimeStateHub.broadcastNotificationLogUpdated,
		broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
		prepareForStateReset,
		getUpdateStatus: deps.getUpdateStatus,
		runUpdateNow: deps.runUpdateNow,
		requestPlannedHandoverRestartPreservingHostedAgentSessions,
		requestRuntimeStopTerminatingHostedAgentSessions,
		queuedTaskPromptDeliveryDispatcher,
	});
	// 单飞恢复扫描只处理已登记的会话操作；无需浏览器保持打开。
	const reconcileConversationSessions = () => {
		void runtimeApi
			.reconcileTaskConversationSessionOperations()
			.catch((error: unknown) => logTuiFreezeError("侧会话恢复扫描失败", error));
	};
	const conversationSessionRecoveryTimer = setInterval(reconcileConversationSessions, 15_000);
	conversationSessionRecoveryTimer.unref();
	reconcileConversationSessions();
	const taskCommandExecutionApi = createTaskCommandExecutionService({
		readOwner: async (workspaceId, taskId, execution) => {
			const workspacePath =
				deps.workspaceRegistry.getWorkspacePathById(workspaceId) ??
				(await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === workspaceId)?.repoPath;
			if (!workspacePath) return null;
			const state = await loadWorkspaceState(workspacePath);
			const card = state.board.columns.flatMap((column) => column.cards).find((item) => item.id === taskId);
			if (
				!card ||
				isTaskCardShelved(card) ||
				state.board.columns.find((column) => column.cards.some((item) => item.id === taskId))?.id === "trash"
			)
				return null;
			const conversationSessionId = resolveMainTaskConversationSessionId(card);
			const summary =
				findRuntimeSessionSummary(workspaceId, conversationSessionId) ?? state.sessions[conversationSessionId];
			const nativeSessionId = summary?.agentNativeConversationSessionIdentity?.nativeSessionId ?? null;
			const worktreePath = summary?.workspacePath ?? execution?.worktreeIdentity.realPath;
			if (!worktreePath) return null;
			return {
				taskId,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				conversationSessionId,
				nativeSessionId,
				worktreePath,
				summary: summary ?? null,
				isNativeInputSubmissionBusy: isRuntimeAgentSessionSummaryDrivenByAcpProtocol(summary)
					? (
							await getScopedAcpTaskSessionService({ workspaceId, workspacePath })
						).getTaskSessionInputSubmissionReadiness(conversationSessionId).isBusy
					: (deps.workspaceRegistry
							.getTerminalManagerForWorkspace(workspaceId)
							?.hasPendingProgrammaticTaskChatInputDelivery(
								conversationSessionId,
								execution?.resultDelivery?.resultId,
							) ?? false),
			};
		},
		park: async (record) => {
			const scope = {
				workspaceId: record.workspaceId,
				workspacePath:
					deps.workspaceRegistry.getWorkspacePathById(record.workspaceId) ?? record.worktreeIdentity.realPath,
			};
			const acp = await getScopedAcpTaskSessionService(scope);
			const options = { label: record.specification.label, owningCommandExecutionId: record.executionId };
			const result = isRuntimeAgentSessionSummaryDrivenByAcpProtocol(
				acp.getSummary(record.originatingConversationSessionId),
			)
				? acp.parkTaskSessionAwaitingDispatchedBackgroundWork(record.originatingConversationSessionId, options)
				: (await getScopedTerminalManager(scope)).parkTaskSessionAwaitingDispatchedBackgroundWork(
						record.originatingConversationSessionId,
						options,
					);
			return result.ok;
		},
		unpark: async (record) => {
			const scope = {
				workspaceId: record.workspaceId,
				workspacePath:
					deps.workspaceRegistry.getWorkspacePathById(record.workspaceId) ?? record.worktreeIdentity.realPath,
			};
			const acp = await getScopedAcpTaskSessionService(scope);
			if (isRuntimeAgentSessionSummaryDrivenByAcpProtocol(acp.getSummary(record.originatingConversationSessionId)))
				acp.unparkTaskSession(record.originatingConversationSessionId, record.executionId);
			else
				(await getScopedTerminalManager(scope)).unparkTaskSession(
					record.originatingConversationSessionId,
					record.executionId,
				);
		},
		deliver: async (record, validateBeforeTerminalWrite, settled) => {
			const workspacePath =
				deps.workspaceRegistry.getWorkspacePathById(record.workspaceId) ??
				(await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === record.workspaceId)?.repoPath;
			if (!workspacePath || !record.resultDelivery) throw new Error("所属执行缺少原工作区或冻结结果");
			const scope = { workspaceId: record.workspaceId, workspacePath };
			let summary = findRuntimeSessionSummary(record.workspaceId, record.originatingConversationSessionId);
			if (!summary || resolveSessionFacets(summary).liveness !== "live") {
				await validateBeforeTerminalWrite();
				const board = await loadWorkspaceBoardById(record.workspaceId);
				const card = board.columns.flatMap((column) => column.cards).find((item) => item.id === record.taskId);
				if (!card) throw new Error("原任务已不存在");
				const originatingSessionLaunchSettings =
					summary?.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings;
				const restored = await runtimeApi.startTaskSession(scope, {
					taskId: record.originatingConversationSessionId,
					workspaceTaskId: record.taskId,
					prompt: "",
					baseRef: card.baseRef ?? "main",
					codexReasoningEffortOverride: originatingSessionLaunchSettings
						? originatingSessionLaunchSettings.codexReasoningEffortOverride
						: card.codexReasoningEffortOverride,
					resumePriorAgentConversationWithoutResendingPrompt: true,
				});
				summary = restored.summary;
				if (
					!restored.ok ||
					summary?.agentNativeConversationSessionIdentity?.nativeSessionId !== record.originatingNativeSessionId
				)
					throw new Error("原主会话尚未通过持久恢复入口恢复到同一原生身份");
			}
			const result = record.resultDelivery;
			const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
			await withTaskMessageInjectionLedgerLock(ledgerPath, async (records) => {
				const existing = findTaskMessageInjectionRecord(records, record.taskId, result.resultId);
				if (
					existing &&
					(existing.prompt_sha256 !== result.textSha256 ||
						existing.attempt_id !== record.originatingConversationSessionId)
				)
					throw new Error("所属结果的原生发送意图与冻结身份不符");
				return {
					records: existing
						? records
						: [
								...records,
								createPendingTaskMessageInjectionRecord({
									taskId: record.taskId,
									attemptId: record.originatingConversationSessionId,
									source: "owned_command_execution_result",
									idempotencyKey: result.resultId,
									promptSha256: result.textSha256,
									nowIso: new Date().toISOString(),
								}),
							],
					result: undefined,
				};
			});
			const managed = await beginManagedTaskPromptDelivery({
				workspaceId: record.workspaceId,
				taskId: record.originatingConversationSessionId,
				workspaceTaskId: record.taskId,
				text: result.text,
				deliveryRequestId: result.resultId,
				idempotencyKey: result.resultId,
				injectionLedgerTaskId: record.taskId,
				origin: { messageType: "programmatic_injection", sourceLabel: record.specification.label },
				summary,
			});
			const response = await sendTaskChatMessageAcrossSessionTransports(
				{
					getScopedTerminalManager,
					getScopedAcpTaskSessionService,
					loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
					programmaticInjectionLedgerTaskId: record.taskId,
					validateBeforeTerminalWrite,
					preserveExistingComposerDraft: true,
					owningCommandExecutionId: record.executionId,
					programmaticSubmissionAttemptId: result.attemptId ?? undefined,
					onProgrammaticTerminalDeliverySettled: (receipt) => {
						void managed.handle.settle(receipt);
						void settled(receipt);
					},
				},
				scope,
				{
					taskId: record.originatingConversationSessionId,
					text: result.text,
					source: "owned_command_execution_result",
					idempotencyKey: result.resultId,
					deliveryRequestId: result.resultId,
					promptSha256: result.textSha256,
				},
			);
			if (response.terminalDelivery && response.terminalDelivery.status !== "accepted_pending_submit_confirmation")
				await managed.handle.settle(response.terminalDelivery);
			return response;
		},
		reconcileDelivery: async (record) => {
			if (!record.resultDelivery) return "unknown";
			const summary = findRuntimeSessionSummary(record.workspaceId, record.originatingConversationSessionId);
			const acceptance = summary?.agentConversationPromptSubmissionAcceptance;
			if (
				acceptance?.status === "accepted" &&
				acceptance.eventId === record.resultDelivery.resultId &&
				acceptance.nativeSessionId === record.originatingNativeSessionId
			)
				return "native_accepted";
			const managed = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(record.workspaceId)).entriesByTaskId[
				record.originatingConversationSessionId
			]?.find((entry) => entry.queueEntryId === record.resultDelivery?.resultId);
			const notStarted = managed?.managedDelivery?.terminalDeliveryReceipt?.nativePromptSubmissionNotStartedEvidence;
			const managedReceipt = managed?.managedDelivery?.terminalDeliveryReceipt;
			if (
				managed?.text === record.resultDelivery.text &&
				managed.workspaceTaskId === record.taskId &&
				(managedReceipt?.status === "delivered_and_submit_confirmed" ||
					managedReceipt?.status === "delivered_queued_behind_active_agent_turn")
			)
				return "native_accepted";
			if (
				notStarted?.clientUserMessageId === record.resultDelivery.resultId &&
				notStarted.submissionAttemptId === record.resultDelivery.attemptId &&
				notStarted.nativeSessionId === record.originatingNativeSessionId
			)
				return "known_not_submitted";
			const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
			await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
				workspaceId: record.workspaceId,
				ledgerPath,
				getSummary: (sessionId) => findRuntimeSessionSummary(record.workspaceId, sessionId),
			});
			const entry = findTaskMessageInjectionRecord(
				await readTaskMessageInjectionLedger(ledgerPath),
				record.taskId,
				record.resultDelivery.resultId,
			);
			if (
				entry?.terminal_delivery_status === "delivered_and_submit_confirmed" ||
				entry?.terminal_delivery_status === "delivered_queued_behind_active_agent_turn" ||
				entry?.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence
			)
				return "native_accepted";
			if (entry && isOwnedCommandResultDefinitelyUnsubmittedAcrossTransports(entry)) return "known_not_submitted";
			return "unknown";
		},
		readDeliveryRecoveryEvidenceSha256: async (record) => {
			const summary = findRuntimeSessionSummary(record.workspaceId, record.originatingConversationSessionId);
			const workspacePath =
				deps.workspaceRegistry.getWorkspacePathById(record.workspaceId) ??
				(await listWorkspaceIndexEntries()).find((entry) => entry.workspaceId === record.workspaceId)?.repoPath;
			const acpInputSubmissionReadiness =
				workspacePath && isRuntimeAgentSessionSummaryDrivenByAcpProtocol(summary)
					? (
							await getScopedAcpTaskSessionService({ workspaceId: record.workspaceId, workspacePath })
						).getTaskSessionInputSubmissionReadiness(record.originatingConversationSessionId)
					: null;
			const managed = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(record.workspaceId)).entriesByTaskId[
				record.originatingConversationSessionId
			]?.find((entry) => entry.queueEntryId === record.resultDelivery?.resultId);
			const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(record.workspaceId));
			const entry = record.resultDelivery
				? findTaskMessageInjectionRecord(
						await readTaskMessageInjectionLedger(ledgerPath),
						record.taskId,
						record.resultDelivery.resultId,
					)
				: null;
			const transcriptPath = summary?.agentNativeConversationSessionIdentity?.transcriptPath;
			let transcriptObservation: { size: number; modifiedAtEpochMs: number } | null = null;
			if (transcriptPath) {
				try {
					const metadata = await stat(transcriptPath);
					transcriptObservation = { size: metadata.size, modifiedAtEpochMs: metadata.mtimeMs };
				} catch {
					/* 读取缺证仍保留 unknown。 */
				}
			}
			return createHash("sha256")
				.update(
					JSON.stringify({
						nativeIdentity: summary?.agentNativeConversationSessionIdentity,
						humanInputMutationSequence: deps.workspaceRegistry
							.getTerminalManagerForWorkspace(record.workspaceId)
							?.getTaskHumanTerminalInputMutationSequenceNumber(record.originatingConversationSessionId),
						runtimeSessionIncarnationId: summary?.runtimeSessionIncarnationId,
						sessionFacets: summary ? resolveSessionFacets(summary) : null,
						acpInputSubmissionReadiness,
						endpoint: summary?.codexNativeSessionControlEndpoint,
						transcriptObservation,
						acceptedPrompt: summary?.agentConversationPromptSubmissionAcceptance,
						sendPhase: entry?.codex_native_prompt_delivery_operation?.sendPhase,
						acceptance: entry?.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence,
						receipt: entry?.terminal_delivery_status,
						managedReceipt: managed?.managedDelivery?.terminalDeliveryReceipt,
					}),
				)
				.digest("hex");
		},
		listWorkspaceIds: async () => (await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId),
		warn: deps.warn,
	});
	applyOwnedCommandExecutionPolicyForSessionStopRequest = (workspaceId, taskId, stopRequestScope) =>
		stopRequestScope === "current_agent_turn"
			? taskCommandExecutionApi.handleOwnerSessionInterrupt(workspaceId, taskId)
			: taskCommandExecutionApi.cancelForTask(workspaceId, taskId);
	const stopObservingOwnedCommandExecutionOwnerSessionInterrupts =
		observeOwnerSessionInterruptBeforeOwnedCommandExecutionTerminalInterrupt(
			taskCommandExecutionApi.handleOwnerSessionInterrupt,
		);

	codexConfigurationSyncService.start();
	const taskMainSessionHandoverApi = createTaskMainSessionHandoverCoordinator({
		getAcpTaskSessionService: getScopedAcpTaskSessionService,
		getTerminalManager: getScopedTerminalManager,
		loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
		startTaskSession: (scope, input) => runtimeApi.startTaskSession(scope, input),
		sendTaskChatMessage: (scope, input, evidence) => runtimeApi.sendTaskChatMessage(scope, input, evidence),
		serializer: taskCardActionPerTaskCommandSerializer,
		runCommand: deps.runCommand,
		warn: deps.warn,
		broadcastState: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
	});
	pauseAutomaticMainSessionHandoverForStoppedTask = taskMainSessionHandoverApi.pauseForExplicitStop;

	const independentTaskCreationApi = createIndependentTaskCreationService({
		findSession: findRuntimeSessionSummary,
		listSessions: listProjectRuntimeSessionSummaries,
		broadcastState: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
	});
	const workUnitRelationAssertionWriteApi = createWorkUnitRelationAssertionWriteApi({
		readRecordedInterWorkUnitRelationProjection:
			readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
		runInterWorkUnitRelationLedgerClientOperation:
			runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
	});
	const taskIndexingSupportApi = createTaskIndexingSupportRuntimeService({
		listLiveSessionSummaries: listProjectRuntimeSessionSummaries,
		loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
		broadcastState: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
		referenceAssertionWritePort: workUnitRelationAssertionWriteApi,
	});
	const taskLookupConversationApi = createTaskLookupConversationService({
		storageDirectoryPath: join(getRuntimeHomePath(), "task-lookup-conversations"),
		runtimeProcessInstanceId: runtimeProcessInstanceHeartbeat.runtimeProcessInstanceId,
		readRuntimeOwnerLiveness: readRuntimeProcessInstanceLiveness,
		collectMaterials: (workspaceId) =>
			collectTaskIndexingMaterials({ workspaceId, listLiveSessionSummaries: listProjectRuntimeSessionSummaries }),
		getExecutorSettings: readTaskAssistanceModelProviderRoutingSettings,
		getContext: (workspaceId, materials, settings) =>
			loadAndAdvanceSharedTaskIndexingContext({
				workspaceId,
				materials,
				settings,
				instructionVersion: TASK_ANALYSIS_SHARED_CONTEXT_VERSION,
				now: Date.now(),
				forModelRequest: true,
			}),
		executeAgent: executeTaskAnalysisApi,
		onConversationUpdated: deps.runtimeStateHub.broadcastTaskLookupConversationUpdated,
	});
	const createWorkspaceControlApi = () =>
		createWorkspaceApi({
			ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
			loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
			broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
			broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
			buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
			listProjectRuntimeSessionSummaries,
			onQueuedTaskPromptDeliveriesRewrittenForTasksRemovedFromBoard: (workspaceId, snapshot) => {
				void queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(workspaceId, snapshot);
			},
		});
	const createTaskCardActions = (workspaceApi: RuntimeTrpcContext["workspaceApi"]) =>
		createTaskCardActionApi({
			runtimeApi,
			workspaceApi,
			broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
			broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
			findTaskSessionSummaryLiveInRuntimeProcessMemory: findRuntimeSessionSummary,
			listTaskSessionSummariesLiveInRuntimeProcessMemory: listProjectRuntimeSessionSummaries,
			taskCardActionPerTaskCommandSerializer,
			// 永久删除丢掉排队 prompt 后立刻让出队引擎重读，不等兜底 sweep（与 saveState 差集清理同一个钩子）。
			onQueuedTaskPromptDeliveriesDiscardedForPermanentlyDeletedTaskCards: (workspaceId, snapshot) => {
				void queuedTaskPromptDeliveryDispatcher.notifyQueueRewrittenOutsideDispatcher(workspaceId, snapshot);
			},
			// 所有进 Done 的入口共用的 Post-Deploy Verification 门禁（未勾项必须带原因）。
			postDeployVerificationDoneEntryGate: {
				authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone,
				finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone,
				revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed,
			},
		});

	const taskEditorCreationRelationReadApi = createWorkUnitRelationReadApi({
		readRecordedInterWorkUnitRelationProjection:
			readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
		getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
		readLatestNotificationSummaryTextOfTaskCard:
			readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive,
	});
	const taskEditorCreationSubmissionApi = createTaskEditorCreationSubmissionService({
		onStatusChanged: () => {
			void deps.runtimeStateHub.broadcastRuntimeProjectsUpdated(null);
		},
		resolveCreationSettings: async (scope, card) => {
			const config = await deps.workspaceRegistry.loadScopedRuntimeConfig(scope);
			const agentId = card.agentId ?? config.selectedAgentId;
			const defaults = await readCreationAgentDefaultModelWithoutBlockingBacklogCard(
				() =>
					readCreationAgentDefaultModel(
						agentId,
						scope.workspacePath,
						card.codexConfigurationProfileId,
						card.terminalAgentModelOverrideSettings?.agentId === agentId
							? card.terminalAgentModelOverrideSettings.modelId
							: undefined,
					),
				{
					codexConfigurationProfileId: card.codexConfigurationProfileId,
					taskAgentSessionInitialization: card.taskAgentSessionInitialization,
				},
			);
			return resolveCreationStartupSettings({
				agentId,
				agentSelectionSource: card.agentId ? "explicit_request" : "workspace_config_default",
				startInPlanMode: card.startInPlanMode ?? config.newTaskStartInPlanModeByDefault,
				taskAgentPermissionMode: card.taskAgentPermissionMode,
				modelId:
					card.terminalAgentModelOverrideSettings?.agentId === agentId
						? card.terminalAgentModelOverrideSettings.modelId
						: undefined,
				defaultModelId: defaults.modelId,
				codexConfigurationProfileId: card.codexConfigurationProfileId,
				defaultCodexConfigurationProfileId: defaults.codexConfigurationProfileId,
				codexConfigurationPermissionSelectionSource: card.codexConfigurationPermissionSelectionSource,
				requestedAgentSessionTransport: card.ompAgentSessionTransport,
				defaultSessionTransport: agentId === "omp" ? config.ompAgentSessionTransportForNewTasks : undefined,
			});
		},
		findSession: findRuntimeSessionSummary,
		resolveIdentity: async (workspaceId, card) => {
			const { kanbanBoardCardIdentityCandidates } =
				await taskEditorCreationRelationReadApi.resolveKanbanBoardCardIdentityByBareTaskId({ bareTaskId: card.id });
			const matches = kanbanBoardCardIdentityCandidates.filter((candidate) => {
				const canonical = candidate.canonicalKanbanBoardCard ?? candidate.kanbanBoardCard;
				const originalProjectPath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
				return (
					canonical.workspaceId === workspaceId ||
					candidate.kanbanBoardCard.workspaceId === workspaceId ||
					(originalProjectPath !== null &&
						candidate.previousWorkspaceRepositoryPaths?.includes(originalProjectPath))
				);
			});
			if (matches.length > 1)
				throw new TRPCError({ code: "CONFLICT", message: "任务身份不唯一，未执行旧创建提交。" });
			const identity = matches[0];
			return identity
				? {
						workspaceId: identity.kanbanBoardCard.workspaceId,
						taskIncarnationCreatedAtEpochMs: identity.kanbanBoardCard.taskIncarnationCreatedAtEpochMs,
						permanentlyRemoved: identity.permanentlyRemovedFromBoardAt !== null,
						workspaceIdsUsedByTaskIncarnation: identity.workspaceIdsUsedByTaskIncarnation,
					}
				: null;
		},
		persistCard: (scope, card, evidence) =>
			createWorkspaceControlApi().persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(
				scope,
				{
					newBacklogTaskCardsCreatedFromWebUi: [card],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				},
				evidence,
			),
		applyAcceptedRelations: (input, acceptedAuthorization) =>
			applyReferenceRelationModelingChanges(
				{
					readRecordedInterWorkUnitRelationProjection:
						readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
					runInterWorkUnitRelationLedgerClientOperation:
						runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture,
					getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				},
				input,
				acceptedAuthorization,
			),
		startAgent: (scope, card, record, beforeAgentProcessLaunch) =>
			createTaskCardActions(createWorkspaceControlApi()).startTaskCardAgentSessionMovingItIntoInProgress(
				scope,
				{
					taskId: card.id,
					expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
					boardMutationInitiator: "web_ui_user_gesture",
					agentTerminalGeometryForTaskSessionSpawn: record.request.agentTerminalGeometryForTaskSessionSpawn,
				},
				record.acceptedUserAuthorization?.requestOriginActorEvidence ?? {
					decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
				},
				beforeAgentProcessLaunch,
			),
		readDependencyFingerprint: async (record) => {
			const [config, identities, executableDirectories] = await Promise.all([
				deps.workspaceRegistry.loadScopedRuntimeConfig({
					workspaceId: record.status.workspaceId,
					workspacePath: record.workspacePath,
				}),
				Promise.all(
					[
						record.request.newTaskCard.id,
						...record.request.referenceRelationDrafts.flatMap((draft) =>
							draft.counterpartWorkUnit.workUnitType === "kanban_board_card"
								? [draft.counterpartWorkUnit.taskId]
								: [],
						),
					].map((bareTaskId) =>
						taskEditorCreationRelationReadApi.resolveKanbanBoardCardIdentityByBareTaskId({ bareTaskId }),
					),
				),
				Promise.all(
					(process.env.PATH ?? "")
						.split(delimiter)
						.filter(Boolean)
						.map(async (path) => {
							try {
								const info = await stat(path);
								return [path, info.mtimeMs];
							} catch {
								return [path, "不可读"];
							}
						}),
				),
			]);
			const agentBinary = getRuntimeAgentCatalogEntry(
				record.request.newTaskCard.agentId ?? config.selectedAgentId ?? "codex",
			)?.binary;
			const executableFiles = agentBinary
				? await Promise.all(
						(process.env.PATH ?? "")
							.split(delimiter)
							.filter(Boolean)
							.map(async (path) => {
								try {
									const info = await stat(join(path, agentBinary));
									return [path, info.mtimeMs, info.mode, info.size];
								} catch {
									return [path, "不可用"];
								}
							}),
					)
				: [];
			const liveSession = findRuntimeSessionSummary(
				record.status.workspaceId,
				resolveMainTaskConversationSessionId(record.request.newTaskCard),
			);
			return [
				{
					selectedAgentId: config.selectedAgentId,
					selectedShortcutLabel: config.selectedShortcutLabel,
					agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
					ompAgentSessionTransportForNewTasks: config.ompAgentSessionTransportForNewTasks,
					shortcuts: config.shortcuts,
				},
				identities,
				executableDirectories,
				executableFiles,
				liveSession,
			];
		},
		warn: deps.warn,
	});
	recordTaskEditorCreationStop = async (workspaceId, taskId) => {
		const board = await loadWorkspaceBoardById(workspaceId);
		const card = board.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === taskId || resolveMainTaskConversationSessionId(entry) === taskId);
		if (card) await recordTaskEditorCreationExplicitStop(workspaceId, card.id, card.createdAt);
	};
	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		// taskCardActionApi 与自动收尾复用同一份 runtimeApi 的起停和投递漏斗。
		const workspaceApi = createWorkspaceControlApi();
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			taskCommandExecutionApi,
			codexConfigurationSyncApi: codexConfigurationSyncService,
			dailyWorkProgressStatisticsApi: dailyWorkProgressStatisticsService,
			taskIndexingSupportApi,
			taskLookupConversationApi,
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
			taskMainSessionHandoverApi,
			independentTaskCreationApi,
			taskEditorCreationSubmissionApi,
			workspaceApi,
			taskCardActionApi: createTaskCardActions(workspaceApi),
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
				getAllProjectsTaskGroupQuerySnapshot: deps.workspaceRegistry.getAllProjectsTaskGroupQuerySnapshot,
				listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon:
					deps.workspaceRegistry.listCrossProjectTaskSwitcherEntriesForAllProjectsWithinActivityHorizon,
				readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries:
					crossProjectTaskWorktreeGitMetadataCache.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
				serverCwd: process.cwd(),
			}),
			hooksApi: createHooksApi({
				...hooksApiDependenciesSharedByDirectAndSpooledHookIngest,
				drainPendingHookSpoolEntriesBeforeDirectHookIngest:
					deps.agentSessionPtyHostHookSpool?.drainPendingHookSpoolEntriesBeforeDirectHookIngest,
			}),
			deploymentApi: createDeploymentApi({
				// 看板当前列快照：直读该 workspace 的 board.json，摊平 columns×cards → (taskId, columnId)。
				loadBoardTasksForWorkspace: async (scope) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId, { requireCompleteRead: true });
					return board.columns.flatMap((column) =>
						column.cards.map((card) => ({
							taskId: card.id,
							columnId: column.id,
							taskIncarnationCreatedAtEpochMs: card.createdAt,
						})),
					);
				},
				// 确认框 agent response 按 agent 类型分源（plan Grilling #5）。
				loadTaskAgentResponsePreview: async (scope, taskId) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					const card = board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
					const conversationSessionId = card ? resolveMainTaskConversationSessionId(card) : taskId;
					const acpTaskSessionService = await getScopedAcpTaskSessionService(scope);
					const isAcpTask = isRuntimeAgentSessionSummaryDrivenByAcpProtocol(
						acpTaskSessionService.getSummary(conversationSessionId),
					);
					if (isAcpTask) {
						let lastAcpAssistantMessageContent: string | null = null;
						for (const message of acpTaskSessionService.listMessages(conversationSessionId)) {
							if (message.role === "assistant") {
								lastAcpAssistantMessageContent = message.content;
							}
						}
						return lastAcpAssistantMessageContent;
					}
					// 终端 agent（Claude 等）：取 hook 采集的最近 finalMessage；无则优雅降级为 null。
					const manager = await getScopedTerminalManager(scope);
					return manager.getSummary(conversationSessionId)?.latestHookActivity?.finalMessage ?? null;
				},
			}),
			workUnitRelationReadApi: createWorkUnitRelationReadApi({
				suggestReferenceRelationsForTaskModeling: scope.workspaceScope
					? (input) =>
							taskIndexingSupportApi.suggestReferenceRelationsForTaskModeling(
								scope.workspaceScope as RuntimeTrpcWorkspaceScope,
								input,
							)
					: undefined,
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
			workUnitRelationAssertionWriteApi,
			conversationTreeApi: createConversationTreeApi(),
			exploratoryApi,
			taskVisualizationArtifactApi,
		};
	};

	const taskClosureRecoveryMonitor = createTaskClosureRecoveryMonitor(async (staleOperation) => {
		const identity = staleOperation.taskIdentity;
		const scope = { workspaceId: identity.workspaceId, workspacePath: staleOperation.workspacePath };
		const board = await loadWorkspaceBoardById(identity.workspaceId);
		const column = board.columns.find((entry) => entry.cards.some((card) => card.id === identity.taskId));
		const card = column?.cards.find((entry) => entry.id === identity.taskId);
		if (staleOperation.reopening && !["completed", "cancelled"].includes(staleOperation.reopening.phase)) {
			if (
				card?.createdAt === identity.taskIncarnationCreatedAtEpochMs &&
				card.taskClosureSummary?.eventKind === "reopened" &&
				card.taskClosureSummary.closureRequestId === staleOperation.reopening.reopeningRequestId
			) {
				await withTaskClosureLifecycleLocks(identity.workspaceId, [identity.taskId], async () => {
					const current = await readTaskClosureOperation(identity, staleOperation.progress.closureRequestId);
					if (current?.reopening) {
						current.reopening.phase = "completed";
						await writeTaskClosureOperation(current);
					}
					if (card.taskClosureSummary) await writeTaskClosureHistoryRecord(card.taskClosureSummary);
				});
			} else if (
				card?.createdAt === identity.taskIncarnationCreatedAtEpochMs &&
				((column?.id === "trash" && card.updatedAt === staleOperation.reopening.sourceTaskUpdatedAtEpochMs) ||
					(column?.id === "review" && card.updatedAt === staleOperation.reopening.startedAtEpochMs))
			) {
				await createTaskCardActions(
					createWorkspaceControlApi(),
				).restoreTaskCardFromDoneIntoReviewResumingAgentSession(scope, staleOperation.reopening.request, {
					decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
				});
			} else {
				await withTaskClosureLifecycleLocks(identity.workspaceId, [identity.taskId], async () => {
					const current = await readTaskClosureOperation(identity, staleOperation.progress.closureRequestId);
					if (current?.reopening) {
						current.reopening.phase = "cancelled";
						current.reopening.lastError = "任务身份已变化或卡片已删除";
						await writeTaskClosureOperation(current);
					}
				});
			}
			return;
		}
		if (
			card &&
			(card.createdAt !== identity.taskIncarnationCreatedAtEpochMs ||
				(card.updatedAt !== staleOperation.sourceTaskUpdatedAtEpochMs && column?.id !== "trash"))
		) {
			await withTaskClosureLifecycleLocks(identity.workspaceId, [identity.taskId], async () => {
				const current = await readTaskClosureOperation(identity, staleOperation.progress.closureRequestId);
				if (!current || current.progress.phase === "completed") return;
				current.progress.phase = "cancelled";
				current.progress.lastError = "任务已更改或重开，旧操作清理资格失效";
				await writeTaskClosureOperation(current);
			});
			return;
		}
		const workspaceApi = createWorkspaceControlApi();
		if (!card && staleOperation.progress.phase === "closed_cleanup_pending") {
			await withTaskClosureLifecycleLocks(identity.workspaceId, [identity.taskId], async () => {
				const current = await readTaskClosureOperation(identity, staleOperation.progress.closureRequestId);
				if (!current || current.progress.phase !== "closed_cleanup_pending") return;
				const result = await workspaceApi.deleteWorktree(scope, {
					taskId: identity.taskId,
					taskClosureArchiveCleanupCredential: {
						taskIncarnationCreatedAtEpochMs: identity.taskIncarnationCreatedAtEpochMs,
						closureRequestId: current.progress.closureRequestId,
					},
				});
				current.progress.phase = result.ok ? "completed" : "closed_cleanup_pending";
				current.progress.lastError = result.error ?? null;
				await writeTaskClosureOperation(current);
			});
		} else if (card && staleOperation.preservationPurpose === "permanently_delete_task") {
			await createTaskCardActions(workspaceApi).permanentlyDeleteTaskCardsWithFullResourceCleanup(
				scope,
				{
					expectedTaskIncarnationCreatedAtEpochMsByTaskId: {
						[identity.taskId]: identity.taskIncarnationCreatedAtEpochMs,
					},
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: [identity.taskId],
					},
				},
				{ decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" } },
			);
		} else if (card) {
			await createTaskCardActions(workspaceApi).moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
				scope,
				staleOperation.request,
				{ decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" } },
			);
		}
	});

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
			// 内容仅凭单产物只读 capability 访问；opaque sandbox 的 Origin:null 不进入控制面门禁。
			if (await handleTaskVisualizationContentHttpRequest(req, res, taskVisualizationArtifactApi)) return;
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
			if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
				return;
			}
		} catch {
			socket.destroy();
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
		deps.runtimeStateHub.handleUpgrade(request, socket, head, {
			requestedWorkspaceId,
			initialWorkspaceMetadataProbeScope: parseWorkspaceMetadataProbeScopeFromRuntimeStateStreamUrl(requestUrl),
		});
	});
	// [tui-freeze] 诊断:终端回显链路与所有任务的输入处理共享这个 Node 事件循环,
	// 循环被同步重活占据时键盘输入会整体延迟——在 bridge 生命周期内持续采样延迟直方图。
	const stopEventLoopDelayMonitor = startEventLoopDelayMonitor();
	// fd 泄漏曾一路无声地越过 Darwin OPEN_MAX(10240)，才以「所有 git 调用 EBADF」的形式在一个毫不相干
	// 的子系统里间接显形；这条探针让 fd 水位在爆炸前就可见，对任何一类 fd 泄漏回归都同样有效。
	const stopProcessFileDescriptorWatermarkMonitor = startProcessFileDescriptorWatermarkMonitor();
	// Kanban 进程自身的内存 / CPU 基线，用于区分固定服务器成本与独立 Agent 进程成本。
	const stopKanbanRuntimeProcessSelfResourceSampleMonitor = startKanbanRuntimeProcessSelfResourceSampleMonitor({
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

	// 退出流程里 HTTP 监听可能先于 close 停掉（stopAcceptingNewWorkBeforeRuntimeExit）；两处共用同一次 server.close。
	let httpServerStoppedAcceptingConnections: Promise<void> | null = null;
	const stopHttpServerFromAcceptingConnections = (): Promise<void> => {
		if (httpServerStoppedAcceptingConnections !== null) return httpServerStoppedAcceptingConnections;
		// 监听失败时也走统一资源释放；此时没有成功监听的 HTTP server 可供关闭。
		if (!server.listening) return Promise.resolve();
		httpServerStoppedAcceptingConnections = new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => {
				if (error) {
					rejectClose(error);
					return;
				}
				resolveClose();
			});
		});
		return httpServerStoppedAcceptingConnections;
	};
	const stopStartingNewBackgroundWork = (preserveAlreadyStartedQueueDispatches = false) => {
		clearInterval(conversationSessionRecoveryTimer);
		stalePendingTaskMessageInjectionSweepsForRuntimeLifetime.stop();
		agentSessionInactivityReclamationScheduler.stop();
		// 计划内 handover 先停止新认领，给已进入写链的投递保留同一个有界排空窗口。
		// 窗口结束后必须硬停，防止尚在 await 身份复核的操作在 detach 后写入。
		if (preserveAlreadyStartedQueueDispatches) {
			queuedTaskPromptDeliveryDispatcher.pauseNewDispatchAttemptsForRuntimeHandover();
		} else {
			queuedTaskPromptDeliveryDispatcher.stop();
		}
		taskCommandExecutionApi.stop();
		stopObservingOwnedCommandExecutionOwnerSessionInterrupts();
		unregisterQueuedTaskPromptDeliveryDispatchObserver();
		stopObservingManagedTaskPromptDeliveries();
	};
	let runtimeOwnedBackgroundServicesShutdown: Promise<void> | null = null;
	const beginRuntimeOwnedBackgroundServicesShutdown = (): Promise<void> => {
		// 同时调用各关闭入口：同步部分先关准入闸，不让排空期间又起创建、交接、结案恢复或查卡作业。
		runtimeOwnedBackgroundServicesShutdown ??= Promise.all([
			verificationExecutionRecoveryLifecycle?.stop() ?? Promise.resolve(),
			runtimeApi.closeTaskConversationSessionOperations(),
			taskClosureRecoveryMonitor.close(),
			taskEditorCreationSubmissionApi.close(),
			taskVisualizationArtifactApi.stop(),
			taskLookupConversationApi.close(),
			codexConfigurationSyncService.close(),
			dailyWorkProgressStatisticsService.close(),
			taskIndexingSupportApi.close(),
			taskMainSessionHandoverApi.close(),
			promptDraftUsageService.close(),
		]).then(() => undefined);
		return runtimeOwnedBackgroundServicesShutdown;
	};
	const closeRuntimeServerResources = async (): Promise<void> => {
		stopStartingNewBackgroundWork();
		await beginRuntimeOwnedBackgroundServicesShutdown();
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
		// 优雅退出主动销号，于是下一个实例不必等满宽限期才敢判本实例已死——重启后的排队 prompt
		// 提醒因此立刻生效，而不是迟到一个宽限期。非优雅退出没有这一步，靠宽限期兜底。
		await runtimeProcessInstanceHeartbeat.stop();
		await deps.runtimeStateHub.close();
		stopEventLoopDelayMonitor();
		stopProcessFileDescriptorWatermarkMonitor();
		await terminalWebSocketBridge.close();
		await activatedInterWorkUnitRelationLedgerLiveCapture.deactivate();
		await stopHttpServerFromAcceptingConnections();
	};

	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
				server.off("error", rejectListen);
				taskVisualizationArtifactApi.startRecovery();
				resolveListen();
			});
		});
	} catch (error) {
		await closeRuntimeServerResources().catch((cleanupError: unknown) => {
			deps.warn(
				`启动失败后的资源释放失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		});
		throw error;
	}

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
	taskClosureRecoveryMonitor.start();
	taskEditorCreationSubmissionApi.start();
	agentSessionInactivityReclamationScheduler.start();
	taskLookupConversationApi.start();
	queuedTaskPromptDeliveryDispatcher.start();
	taskCommandExecutionApi.startRecovery();
	verificationExecutionRecoveryLifecycle = startVerificationExecutionRecoveryLifecycle({
		readCurrentTaskIncarnationCreatedAtEpochMs: async (workspaceId, taskId) => {
			const board = await loadWorkspaceBoardById(workspaceId, { requireCompleteRead: true });
			return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.createdAt ?? null;
		},
	});
	taskMainSessionHandoverApi.start();
	// 与回收调度器同在 listen 之后启动：它要读三种 transport 的会话 summary 作为归因根。
	taskAttributedProcessTreeResourceSampler.start();
	taskAgentConversationModelTokenUsageJournalMonitor.start();
	taskWorktreeDiskUsageMeasurementMonitor.start();
	promptDraftUsageService.startInitialHistoricalBackfill();
	dailyWorkProgressStatisticsService.start();

	return {
		url,
		stopAllActiveRuntimeSessionsForShutdown,
		stopAcceptingNewWorkBeforeRuntimeExit: ({ closeBrowserConnectionsBecauseRuntimeIsRestarting }) => {
			stopStartingNewBackgroundWork(closeBrowserConnectionsBecauseRuntimeIsRestarting);
			void beginRuntimeOwnedBackgroundServicesShutdown().catch((error: unknown) => {
				deps.warn(`运行时后台服务关闭失败：${error instanceof Error ? error.message : String(error)}`);
			});
			if (closeBrowserConnectionsBecauseRuntimeIsRestarting) {
				deps.runtimeStateHub.closeBrowserConnectionsBecauseRuntimeIsRestarting();
				terminalWebSocketBridge.closeBrowserConnectionsBecauseRuntimeIsRestarting();
			}
			// 不在这里等：在途请求（含触发 handover 的那条 tRPC 响应）照常完成，close 时再等它们收尾。
			void stopHttpServerFromAcceptingConnections().catch(() => undefined);
			return {
				waitForRuntimeOwnedBackgroundServicesToStopBeforeSessionDetach: beginRuntimeOwnedBackgroundServicesShutdown,
				waitForAlreadyStartedQueuedPromptDispatchAttemptsToSettle:
					queuedTaskPromptDeliveryDispatcher.waitForAlreadyStartedDispatchAttemptsToSettleForRuntimeHandover,
				stopRemainingQueuedPromptDispatchAttemptsBeforeSessionDetach: () => {
					queuedTaskPromptDeliveryDispatcher.stop();
					for (const { terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
						terminalManager.revokeProgrammaticInputDeliveryEligibilityForRuntimeHandover();
					}
				},
			};
		},
		countAgentSessionsAffectedByRuntimeExit,
		close: closeRuntimeServerResources,
	};
}
