// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native Cline updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import {
	createNotificationAssessmentService,
	isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate,
	type NotificationAssessmentInput,
} from "../notifications/notification-assessment-service";
import { getNotificationLifecycleArchive } from "../notifications/notification-lifecycle-archive";
import { listWorkspaceIndexEntries, loadPersistedWorkspaceStateById } from "../state/workspace-state";

// 「会话型」任务来源：Kanban 直接持有结构化消息、在卡片详情里渲染成会话面板的那一类 agent。
// 目前是 Cline SDK（进程内）与 ACP（stdio 子进程）两种。
export type ConversationTaskSessionSourceKind = "cline" | "acp";
const CONVERSATION_TASK_SESSION_SOURCE_KINDS: readonly ConversationTaskSessionSourceKind[] = ["cline", "acp"];

// 推流只需要这三件事，故按结构订阅而不是绑死某个具体 service 类。
export interface ConversationTaskSessionSubscriptionSource {
	listSummaries(): RuntimeTaskSessionSummary[];
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: RuntimeTaskChatMessage) => void): () => void;
}

import type {
	RuntimeClineMcpServerAuthStatus,
	RuntimeExplorationThreadGraphProjectionView,
	RuntimeExploratoryFindingEntry,
	RuntimeLiveTaskResourceUsageSnapshot,
	RuntimeNotificationFeedEntry,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	RuntimeStateStreamClineSessionContextUpdatedMessage,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamExplorationThreadGraphUpdatedMessage,
	RuntimeStateStreamExploratoryFindingsUpdatedMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamNotificationLogUpdatedMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskChatMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskResourceUsageSnapshotsUpdatedMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
	RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient,
} from "../core/api-contract";
import { runtimeStateStreamClientMessageSchema } from "../core/api-contract";
import { ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE } from "../core/runtime-state-stream-workspace-metadata-probe-scope-declaration";
import {
	isNotifiableUserTurn,
	isTaskConversationSessionWithoutTaskLifecycleAuthority,
	resolveSessionFacets,
} from "../core/session-activity";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { completeTaskMainSessionHandoverAfterUserMessage } from "../state/complete-task-main-session-handover-after-user-message";
import { buildNotificationFeedEntries } from "../state/notification-feed-builder";
import { readAllNotificationLogs, readNotificationLog } from "../state/notification-log-store";
import { subscribeToPromptLibraryChanges } from "../state/prompt-library-store";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { moveTaskCardIntoInProgressAfterAcceptedMainConversationInput } from "../trpc/task-card-action-api";
import { createAgentSessionResponseGenerationStopObserver } from "./agent-session-response-generation-stop-observer";
import { createNativeAgentConversationActivityObserver } from "./native-agent-conversation-activity-observer";
import { createPersistedAgentTranscriptConversationProgressObserver } from "./persisted-agent-transcript-conversation-progress-observer";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry";

const TASK_SESSION_STREAM_BATCH_MS = 150;
/**
 * summary flush 触发的 projects_updated 合并窗口。projects payload 是全局的（约 115 KB，每次构建要读、解析、校验
 * 全部项目的 board），而 flush 每个工作区每 150ms 就可能来一次；窗口内的多次 flush 只在窗口结束时构建、广播一次。
 * 只合并 flush 这一路：board 变化、tRPC mutation、首帧后补发仍即时广播。
 */
// EXPERIMENT_NODE: summary flush 触发的 projects_updated 合并窗口（1 秒）
const PROJECTS_BROADCAST_COALESCING_WINDOW_AFTER_TASK_SESSION_SUMMARY_FLUSH_MS = 1_000;

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		| "resolveWorkspaceForStream"
		| "buildProjectsPayloadUsingCachedRuntimeProjectAvailability"
		| "buildWorkspaceStateSnapshot"
	>;
}

export interface RuntimeStateHub {
	broadcastDailyWorkProgressStatisticsUpdated?: (revision: number) => void;
	registerAgentConversationInputAcceptedListener?: (
		listener: (input: {
			workspaceId: string;
			summary: RuntimeTaskSessionSummary;
			submittedPromptText?: string;
		}) => void,
	) => () => void;
	broadcastTaskLookupConversationUpdated: (conversationId: string, revision: number) => void;
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	trackClineTaskSessionService: (workspaceId: string, workspacePath: string, service: ClineTaskSessionService) => void;
	broadcastTaskChatMessage: (workspaceId: string, taskId: string, message: RuntimeTaskChatMessage) => void;
	// ACP 会话与 Cline SDK 会话共用同一套 summary/message 推流；两者只是来源不同。
	trackAcpTaskSessionService: (
		workspaceId: string,
		workspacePath: string,
		service: ConversationTaskSessionSubscriptionSource,
	) => void;
	broadcastTaskChatCleared: (workspaceId: string, taskId: string) => void;
	// 本 hub 订阅着的 Cline SDK / ACP 会话的最新 summary。workspace-registry 拼跨项目视图时用它补齐
	// TerminalSessionManager 看不到的两种 transport。
	listTrackedConversationTaskSessionSummaries: (workspaceId: string) => RuntimeTaskSessionSummary[];
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
			// WS URL 带来的初始 git 元数据探测范围；null = 没声明（旧客户端），按整个项目。
			initialWorkspaceMetadataProbeScope: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient | null;
		},
	) => void;
	disposeWorkspace: (workspaceId: string) => void;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	broadcastClineMcpAuthStatusesUpdated: (statuses: RuntimeClineMcpServerAuthStatus[]) => void;
	bumpClineSessionContextVersion: () => void;
	broadcastTaskReadyForReview: (
		workspaceId: string,
		taskId: string,
		userTurnKind: RuntimeTaskSessionUserTurnKind,
		evidence?: Pick<
			NotificationAssessmentInput,
			"candidateId" | "summary" | "finalMessage" | "agentEventDeliveredLateToRuntimeByMilliseconds"
		>,
	) => void;
	// 通知中心：某 workspace 的日志变更（mark-visited / clear / board 变更导致 isDone 刷新）后，
	// 重建该 workspace 的派生 feed 并全局广播给所有客户端（铃铛跨 repo 聚合）。
	broadcastNotificationLogUpdated: (workspaceId: string) => Promise<void>;
	// Exploratory findings 集合变更（save/confirm/reject/archive/ingest 落盘成功）后，把该
	// workspace 的完整 finding 集合全量替换推送给在场客户端（恒小，上限 500；蓝图 §D.3）。
	// 不搭车 summary 广播。
	broadcastExploratoryFindingsUpdated: (workspaceId: string, findings: RuntimeExploratoryFindingEntry[]) => void;
	// exploration thread graph（B.2）：某个 exploration 的整张图变更后全量替换推送。
	// 按 exploration 分发而不是按 workspace 合并：一个 workspace 下可以有多张图，合并推送会让
	// 打开 A 卡片的客户端因为 B 卡片判完图而整份重渲染。
	broadcastExplorationThreadGraphUpdated: (
		workspaceId: string,
		explorationId: string,
		view: RuntimeExplorationThreadGraphProjectionView,
	) => void;
	// 排队 prompt 的出队观察器。**后绑定**：hub 在 cli.ts 里早于 runtime server 创建，而 dispatcher 要用
	// server 作用域里的三 transport 服务，只能等 server 起来之后再挂上。返回解绑函数。
	registerQueuedTaskPromptDeliveryDispatchObserver: (observer: QueuedTaskPromptDeliveryDispatchObserver) => () => void;
	// 排队 prompt 投影变更推送：本 workspace 在场客户端整份替换。0 客户端时跳过——客户端重连后靠
	// getTaskPromptDeliveryQueue 重查对齐，不补发。
	broadcastQueuedTaskPromptDeliveriesUpdated: (
		workspaceId: string,
		projectedEntriesByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	) => void;
	// 按 task 归因的资源占用：某 workspace 全部卡片的实时快照（全量替换）。每个采样 tick 调一次；
	// hub 缓存最近一份，新客户端连上后立即补发，首屏不必等下一个 tick。
	broadcastTaskResourceUsageSnapshotsUpdated: (
		workspaceId: string,
		snapshots: RuntimeLiveTaskResourceUsageSnapshot[],
	) => void;
	close: () => Promise<void>;
}

// hub 只需要知道「把每条 summary 交出去」与「workspace 没了就忘掉它」，不依赖 dispatcher 的具体实现。
export interface QueuedTaskPromptDeliveryDispatchObserver {
	observeTaskSessionSummary(workspaceId: string, summary: RuntimeTaskSessionSummary): void;
	forgetWorkspace(workspaceId: string): void;
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const acceptedEdgeBySession = new Map<string, string | null>();
	const pendingAttemptBySession = new Map<string, string>();
	const acceptedTransitionsInFlight = new Set<string>();
	const acceptedTransitionRetryTimers = new Set<ReturnType<typeof setTimeout>>();
	const acceptedTransitionAttemptCount = new Map<string, number>();
	let acceptedInputListener:
		| ((input: { workspaceId: string; summary: RuntimeTaskSessionSummary; submittedPromptText?: string }) => void)
		| null = null;
	const nativeActivityObserver = createNativeAgentConversationActivityObserver({
		cooldownMs: 1_000,
		onActivity: (observation) => {
			if (observation.activityKind === "accepted_user_input") return;
			const manager = terminalManagersByWorkspaceId.get(observation.workspaceId);
			const current = manager?.getSummary(observation.conversationSessionId);
			if (current?.runtimeSessionIncarnationId !== observation.runtimeSessionIncarnationId) return;
			manager?.recordEffectiveAgentConversationActivity(observation.conversationSessionId, observation, {
				nativeAgentResponsePromptCacheReferenceObservation:
					observation.nativeAgentResponsePromptCacheReferenceObservation,
				nativeAgentResponseAcceptedUserInputEventId: observation.nativeAgentResponseAcceptedUserInputEventId,
			});
		},
		onAccepted: async (observation) => {
			const manager = terminalManagersByWorkspaceId.get(observation.workspaceId);
			if (!manager || !observation.runtimeSessionIncarnationId || !observation.eventId) return;
			const before = manager.getSummary(observation.conversationSessionId);
			if (
				before?.runtimeSessionIncarnationId !== observation.runtimeSessionIncarnationId ||
				before.agentNativeConversationSessionIdentity?.nativeSessionId !== observation.nativeSessionId
			)
				return;
			if (before.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover) {
				const workspace = await loadWorkspaceContextById(observation.workspaceId);
				if (!workspace) throw new Error("原生输入已接受，但暂时无法定位主会话交接工作区");
				await completeTaskMainSessionHandoverAfterUserMessage({
					workspaceId: observation.workspaceId,
					workspacePath: workspace.repoPath,
					taskConversationSessionId: observation.conversationSessionId,
					promptText: observation.submittedPromptText,
					isAcceptedConversationIdentityStillCurrent: () => {
						const current = manager.getSummary(observation.conversationSessionId);
						return (
							current?.runtimeSessionIncarnationId === observation.runtimeSessionIncarnationId &&
							current.agentNativeConversationSessionIdentity?.nativeSessionId === observation.nativeSessionId &&
							current.agentNativeConversationSessionIdentity?.transcriptPath ===
								before.agentNativeConversationSessionIdentity?.transcriptPath
						);
					},
					onTaskConversationSessionMetadataChanged: (sessionId, metadata) =>
						manager.applyTaskConversationSessionMetadata(sessionId, metadata),
				});
			}
			const confirmed = manager.confirmAcceptedAgentConversationInput(observation.conversationSessionId, {
				...observation,
				eventId: observation.eventId,
				runtimeSessionIncarnationId: observation.runtimeSessionIncarnationId,
			});
			if (confirmed)
				acceptedInputListener?.({
					workspaceId: observation.workspaceId,
					summary: confirmed,
					submittedPromptText: observation.submittedPromptText,
				});
		},
		onReadFailed: (error, context) =>
			logAgentSessionRetentionWarning(
				`native-activity-read-failed workspaceId=${context.workspaceId} taskId=${context.conversationSessionId} reason=${error instanceof Error ? error.message : String(error)}`,
			),
	});

	const latestNotificationAssistantMessages = new Map<string, string>();
	const latestNotificationSummaries = new Map<string, RuntimeTaskSessionSummary>();
	const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	// 一个 workspace 可能同时挂着多种「会话型」来源（Cline SDK 与 ACP），故按
	// `${workspaceId}::${sourceKind}` 复合键登记订阅，避免二者互相顶掉。
	const conversationSummaryUnsubscribeBySubscriptionKey = new Map<string, () => void>();
	const conversationMessageUnsubscribeBySubscriptionKey = new Map<string, () => void>();
	const conversationPreviousSummariesBySubscriptionKey = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const buildConversationSubscriptionKey = (workspaceId: string, sourceKind: ConversationTaskSessionSourceKind) =>
		`${workspaceId}::${sourceKind}`;
	const listConversationSubscriptionKeys = (workspaceId: string) =>
		CONVERSATION_TASK_SESSION_SOURCE_KINDS.map((sourceKind) =>
			buildConversationSubscriptionKey(workspaceId, sourceKind),
		);
	const collectTrackedConversationSummaries = (workspaceId: string): RuntimeTaskSessionSummary[] =>
		listConversationSubscriptionKeys(workspaceId).flatMap((key) =>
			Array.from(conversationPreviousSummariesBySubscriptionKey.get(key)?.values() ?? []),
		);
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	// 三 transport 共用的「停止生成响应」边沿观察器（见 queueTaskSessionSummaryBroadcast 的挂载点注释）。
	let queuedTaskPromptDeliveryDispatchObserver: QueuedTaskPromptDeliveryDispatchObserver | null = null;
	const agentSessionResponseGenerationStopObserver = createAgentSessionResponseGenerationStopObserver({
		onPersistError: (error, context) => {
			logAgentSessionRetentionWarning(
				`deadline-persist-failed workspaceId=${context.workspaceId} taskId=${context.taskId} reason=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		},
	});
	const persistedAgentTranscriptConversationProgressObserver =
		createPersistedAgentTranscriptConversationProgressObserver({
			onProbeFailed: (error, context) => {
				logAgentSessionRetentionWarning(
					`transcript-conversation-progress-probe-failed workspaceId=${context.workspaceId} taskId=${
						context.taskId
					} reason=${error instanceof Error ? error.message : String(error)}`,
				);
			},
		});
	const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
	const runtimeStateClients = new Set<WebSocket>();
	const unsubscribePromptLibraryChanges = subscribeToPromptLibraryChanges((workspaceId) => {
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, { type: "prompt_library_updated", workspaceId });
		}
	});
	// 已进全局广播集合、首帧 snapshot 尚未发出的连接：projects_updated 广播跳过它们（不变式见连接握手处）。
	const runtimeStateClientsStillAwaitingInitialSnapshotMessage = new Set<WebSocket>();
	// 上面集合里被某次 projects_updated 广播跳过的连接：首帧发出后要补发一次最新 projects。
	const runtimeStateClientsSkippedByProjectsBroadcastWhileAwaitingInitialSnapshot = new Set<WebSocket>();
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
	// 每个连接在 git 元数据监视器里的订阅（调用 connectWorkspace 之前就登记，好让首轮刷新失败或等待期间断开时都能断开它；
	// 与 runtimeStateWorkspaceIdByClient 一起在首帧之后登记，握手期间不直接改监视器），
	// 与它最近声明的探测范围（握手期间到达的声明先记在这里，订阅建立后补上）。
	const workspaceMetadataSubscriptionByClient = new Map<WebSocket, { workspaceId: string; subscriberId: string }>();
	const latestWorkspaceMetadataProbeScopeDeclaredByClient = new Map<
		WebSocket,
		RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient
	>();
	let workspaceMetadataSubscriberSequenceNumber = 0;
	const disconnectWorkspaceMetadataSubscriptionOfClient = (client: WebSocket) => {
		const subscription = workspaceMetadataSubscriptionByClient.get(client);
		if (!subscription) {
			return;
		}
		workspaceMetadataSubscriptionByClient.delete(client);
		workspaceMetadataMonitor.disconnectWorkspace(subscription.workspaceId, subscription.subscriberId);
	};
	let clineSessionContextVersion = 0;
	const runtimeStateWebSocketServer = new WebSocketServer({ noServer: true });
	const workspaceMetadataMonitor = createWorkspaceMetadataMonitor({
		onMetadataUpdated: (workspaceId, workspaceMetadata) => {
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!clients || clients.size === 0) {
				return;
			}
			const payload: RuntimeStateStreamWorkspaceMetadataMessage = {
				type: "workspace_metadata_updated",
				workspaceId,
				workspaceMetadata,
			};
			const serializedPayload = JSON.stringify(payload);
			for (const client of clients) {
				sendSerializedRuntimeStateMessage(client, serializedPayload);
			}
		},
	});

	const sendSerializedRuntimeStateMessage = (client: WebSocket, serializedPayload: string) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(serializedPayload);
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		sendSerializedRuntimeStateMessage(client, JSON.stringify(payload));
	};

	// projects payload 是全局的（覆盖全部已注册 project、同一份发往所有在场客户端），故去重指纹也只
	// 需一份全局值：与上次实际发送的序列化结果相同 ⇒ 每个在场客户端都已持有这份数据，可整条跳过。
	// 命中条件是「两次构建的 payload 字节级相同」：agent 无输出窗口、纯心跳 flush 这类场景挡掉
	// flushTaskSessionSummaries 触发的重发（前端每收一条 projects_updated 都要重 dispatch 一轮）。为让它在 agent
	// 活跃输出期间也能命中：flush 这一路先合并到每秒最多一次、且不带各自的 workspaceId（否则 currentProjectId 随
	// 轮到 flush 的工作区来回切，见 scheduleProjectsBroadcastCoalescedAfterTaskSessionSummaryFlush）；跨项目视图的
	// lastOutputAt 也按 15 秒取整（见 in-progress-task-detail-projection）。失效是天然的、无需按 workspace 记账：项目增删 /
	// board 变化 / currentProjectId 切换都会改变序列化结果；新连接的首帧 snapshot 发出后会把指纹
	// 置回 null（见 releaseRuntimeStateClientFromAwaitingInitialSnapshot），保证此后下一次广播必定发送——snapshot
	// 全量替换可能把该客户端回滚到旧数据，靠这次必发补洞；payload 构建失败时指纹不动，下次调用照常重试。
	// 首帧前被跳过的连接不持有本次内容，但它在首帧后由补发 + 指纹复位兜住，故不破坏上面的「在场客户端都已持有」。
	let lastBroadcastProjectsPayloadFingerprint: string | null = null;
	// 代际判定：广播是 async（先 await 构建、再比对 / 发送 / 打标），flush、tRPC mutation、首帧后补发会并发触发，
	// 先开始的构建可能后完成。它反映的是更早的状态：若照常发送，会把旧 projects 推给全部在场客户端（含刚补发过
	// 最新内容的新连接），并把上面的指纹倒退成旧内容，安静系统里没有下一次广播来纠正。故每次广播入口取一个单调
	// 递增的开始序号，构建完成时若已有开始得更晚的广播完成过，本次结果直接丢弃。「完成」在去重比较之前记账：
	// 被去重跳过的较新广播同样说明客户端已持有较新内容。构建失败不记账，不会把后续正常完成的广播误判为旧代际。
	let projectsBroadcastStartSequenceNumber = 0;
	let highestStartSequenceNumberOfCompletedProjectsBroadcast = 0;

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		projectsBroadcastStartSequenceNumber += 1;
		const startSequenceNumberOfThisProjectsBroadcast = projectsBroadcastStartSequenceNumber;
		try {
			const payload =
				await deps.workspaceRegistry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(
					preferredCurrentProjectId,
				);
			const serializedPayload = JSON.stringify({
				type: "projects_updated",
				currentProjectId: payload.currentProjectId,
				projects: payload.projects,
			} satisfies RuntimeStateStreamProjectsMessage);
			if (startSequenceNumberOfThisProjectsBroadcast < highestStartSequenceNumberOfCompletedProjectsBroadcast) {
				return;
			}
			highestStartSequenceNumberOfCompletedProjectsBroadcast = startSequenceNumberOfThisProjectsBroadcast;
			if (serializedPayload === lastBroadcastProjectsPayloadFingerprint) {
				return;
			}
			for (const client of runtimeStateClients) {
				if (runtimeStateClientsStillAwaitingInitialSnapshotMessage.has(client)) {
					runtimeStateClientsSkippedByProjectsBroadcastWhileAwaitingInitialSnapshot.add(client);
					continue;
				}
				sendSerializedRuntimeStateMessage(client, serializedPayload);
			}
			lastBroadcastProjectsPayloadFingerprint = serializedPayload;
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	// 首帧 snapshot 已发出（或握手失败、不会再发）：此后该连接照常接收 projects_updated。
	const releaseRuntimeStateClientFromAwaitingInitialSnapshot = (
		client: WebSocket,
		preferredCurrentProjectId: string | null,
	) => {
		if (!runtimeStateClientsStillAwaitingInitialSnapshotMessage.delete(client)) {
			return;
		}
		lastBroadcastProjectsPayloadFingerprint = null;
		// 握手期间被跳过过：snapshot 里的 projects 构建得比那次广播早，安静系统里不会很快再有广播来纠正，立即补一次最新的。
		if (runtimeStateClientsSkippedByProjectsBroadcastWhileAwaitingInitialSnapshot.delete(client)) {
			void broadcastRuntimeProjectsUpdated(preferredCurrentProjectId);
		}
	};

	const broadcastClineMcpAuthStatusesUpdated = (statuses: RuntimeClineMcpServerAuthStatus[]) => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamMcpAuthUpdatedMessage = {
			type: "mcp_auth_updated",
			statuses,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of runtimeStateClients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const bumpClineSessionContextVersion = () => {
		clineSessionContextVersion += 1;
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamClineSessionContextUpdatedMessage = {
			type: "cline_session_context_updated",
			version: clineSessionContextVersion,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of runtimeStateClients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const flushTaskSessionSummaries = (workspaceId: string) => {
		const pending = pendingTaskSessionSummariesByWorkspaceId.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload: RuntimeStateStreamTaskSessionsMessage = {
				type: "task_sessions_updated",
				workspaceId,
				summaries,
			};
			const serializedPayload = JSON.stringify(payload);
			for (const client of runtimeClients) {
				sendSerializedRuntimeStateMessage(client, serializedPayload);
			}
		}
		scheduleProjectsBroadcastCoalescedAfterTaskSessionSummaryFlush();
	};

	// flush 触发的 projects 广播：窗口内只排一次，窗口结束时按最新状态构建。传 null 让 currentProjectId 落到服务端
	// 稳定的 active workspace——浏览器自己的当前项目仍有效时本来就忽略这个字段（resolveProjectIdAfterProjectsUpdate），
	// 按各自 workspaceId 传只会让它随轮到 flush 的工作区来回切、使去重永不命中。
	let projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush: NodeJS.Timeout | null = null;
	const scheduleProjectsBroadcastCoalescedAfterTaskSessionSummaryFlush = () => {
		if (projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush !== null) {
			return;
		}
		const timer = setTimeout(() => {
			projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush = null;
			void broadcastRuntimeProjectsUpdated(null);
		}, PROJECTS_BROADCAST_COALESCING_WINDOW_AFTER_TASK_SESSION_SUMMARY_FLUSH_MS);
		timer.unref();
		projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush = timer;
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		const sessionKey = `${workspaceId}:${summary.taskId}`;
		const previousEdgeWasObserved = acceptedEdgeBySession.has(sessionKey);
		const accepted = summary.agentConversationPromptSubmissionAcceptance;
		const acceptedEdge =
			accepted?.status === "accepted" ? `${accepted.runtimeSessionIncarnationId}:${accepted.eventId}` : null;
		const previousEdge = acceptedEdgeBySession.get(sessionKey);
		if (!previousEdgeWasObserved || !acceptedEdge) acceptedEdgeBySession.set(sessionKey, acceptedEdge);
		const transitionKey = `${sessionKey}:${acceptedEdge}`;
		// 交接 hold 解除会再次发布同一接受事件；解除前不能消耗这个边沿。
		if (
			previousEdgeWasObserved &&
			acceptedEdge &&
			!summary.taskConversationSessionMetadata?.taskAutomationSuspendedForMainSessionHandover &&
			acceptedEdge !== previousEdge &&
			!acceptedTransitionsInFlight.has(transitionKey) &&
			(acceptedTransitionAttemptCount.get(transitionKey) ?? 0) < 3
		) {
			acceptedTransitionsInFlight.add(transitionKey);
			acceptedTransitionAttemptCount.set(
				transitionKey,
				(acceptedTransitionAttemptCount.get(transitionKey) ?? 0) + 1,
			);
			void moveTaskCardIntoInProgressAfterAcceptedMainConversationInput({
				workspaceId,
				summary,
				getCurrentSummary: () => latestNotificationSummaries.get(sessionKey) ?? null,
			})
				.then(async (result) => {
					if (
						latestNotificationSummaries.get(sessionKey)?.agentConversationPromptSubmissionAcceptance?.eventId ===
						accepted?.eventId
					)
						acceptedEdgeBySession.set(sessionKey, acceptedEdge);
					acceptedTransitionAttemptCount.delete(transitionKey);
					if (result.saved && result.workspacePath) {
						await broadcastRuntimeWorkspaceStateUpdated(workspaceId, result.workspacePath);
						await broadcastRuntimeProjectsUpdated(null);
					}
				})
				.catch((error: unknown) => {
					logAgentSessionRetentionWarning(
						`accepted-input-board-transition-failed workspaceId=${workspaceId} taskId=${summary.taskId} reason=${error instanceof Error ? error.message : String(error)}`,
					);
					if ((acceptedTransitionAttemptCount.get(transitionKey) ?? 0) < 3) {
						const retry = setTimeout(() => {
							acceptedTransitionRetryTimers.delete(retry);
							const latest = latestNotificationSummaries.get(sessionKey);
							if (latest && latest.agentConversationPromptSubmissionAcceptance?.eventId === accepted?.eventId)
								queueTaskSessionSummaryBroadcast(workspaceId, latest);
						}, 1_000);
						retry.unref();
						acceptedTransitionRetryTimers.add(retry);
					}
				})
				.finally(() => acceptedTransitionsInFlight.delete(transitionKey));
		}

		latestNotificationSummaries.set(`${workspaceId}:${summary.taskId}`, summary);
		// 「停止生成响应后固定宽限期」回收的归一化边沿检测。刻意挂在这里而不是各 transport 内部：
		// 终端 / Cline SDK / ACP 三条 summary 流全部经此排队，是唯一的跨 transport 汇聚点；且这一句
		// 位于下方「0 客户端提前返回」之前，故计时与「有没有人在看」彻底解耦——关标签页 / 切项目 /
		// 折叠侧栏都不影响期限。观察器内部只在状态边沿动账本，不会被高频 summary 刷成 IO 风暴。
		agentSessionResponseGenerationStopObserver.observeTaskSessionSummary(workspaceId, summary);
		// 排队 prompt 出队的停止边沿（触发源 (a)）。与上一句同理必须在「0 客户端提前返回」之前——
		// 否则关掉浏览器标签页，队列就再也不会在 agent 停下时排空。观察器内部只在边沿上动 IO。
		try {
			queuedTaskPromptDeliveryDispatchObserver?.observeTaskSessionSummary(workspaceId, summary);
		} catch {
			// 出队是附加动作：它的任何异常都不能掀翻 summary 广播链路。
		}
		const pending =
			pendingTaskSessionSummariesByWorkspaceId.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		pendingTaskSessionSummariesByWorkspaceId.set(workspaceId, pending);
		if (taskSessionBroadcastTimersByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
			flushTaskSessionSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		taskSessionBroadcastTimersByWorkspaceId.set(workspaceId, timer);
	};

	// Cline SDK 会话与 ACP 会话的推流逻辑完全一致（都是「summary 批量广播 + 等人回合边沿通知 +
	// 聊天消息转发」），只是来源不同，故共用这一段而不是各写一份。
	const trackConversationTaskSessionService = (
		workspaceId: string,
		workspacePath: string,
		service: ConversationTaskSessionSubscriptionSource,
		sourceKind: ConversationTaskSessionSourceKind,
	): void => {
		const subscriptionKey = buildConversationSubscriptionKey(workspaceId, sourceKind);
		if (conversationSummaryUnsubscribeBySubscriptionKey.has(subscriptionKey)) {
			return;
		}
		const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
		conversationPreviousSummariesBySubscriptionKey.set(subscriptionKey, previousSummariesByTaskId);
		for (const summary of service.listSummaries()) {
			previousSummariesByTaskId.set(summary.taskId, summary);
			queueTaskSessionSummaryBroadcast(workspaceId, summary);
		}
		const unsubscribe = service.onSummary((summary) => {
			const previousSummary = previousSummariesByTaskId.get(summary.taskId);
			previousSummariesByTaskId.set(summary.taskId, summary);
			queueTaskSessionSummaryBroadcast(workspaceId, summary);
			const didCheckpointChange =
				previousSummary?.latestTurnCheckpoint?.commit !== summary.latestTurnCheckpoint?.commit ||
				previousSummary?.previousTurnCheckpoint?.commit !== summary.previousTurnCheckpoint?.commit;
			if (didCheckpointChange) {
				void broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
			}
			// 通知触发：从 legacy reviewReason 白名单切到 userTurnKind 轴的「广·阻塞即提醒」判据
			// （决策 B，单一真相源 isNotifiableUserTurn）。边沿 = 上一帧非「可通知等人回合」→ 本帧是，
			// 故停在等人回合期间不重复 ping；exit/completion/null-reason 的等人回合现也纳入（broad）。
			// 触发瞬间把当前 facet 的 userTurnKind 内联进 ready 事件 payload（③(b)）：前端通知标题据此
			// 措辞，不回读延迟批处理的 summary 流，杜绝上次「标题读 stale userTurnKind」竞态。
			const currentFacets = resolveSessionFacets(summary);
			if (
				previousSummary &&
				!isTaskConversationSessionWithoutTaskLifecycleAuthority(summary) &&
				!isNotifiableUserTurn(resolveSessionFacets(previousSummary)) &&
				isNotifiableUserTurn(currentFacets)
			) {
				broadcastTaskReadyForReview(workspaceId, summary.taskId, currentFacets.userTurnKind, {
					summary,
					finalMessage: latestNotificationAssistantMessages.get(`${workspaceId}:${summary.taskId}`),
				});
			}
		});
		conversationSummaryUnsubscribeBySubscriptionKey.set(subscriptionKey, unsubscribe);
		const unsubscribeMessage = service.onMessage((taskId, message) => {
			if (message.role === "assistant")
				latestNotificationAssistantMessages.set(`${workspaceId}:${taskId}`, message.content);
			broadcastTaskChatMessage(workspaceId, taskId, message);
		});
		conversationMessageUnsubscribeBySubscriptionKey.set(subscriptionKey, unsubscribeMessage);
	};

	const broadcastTaskChatMessage = (workspaceId: string, taskId: string, message: RuntimeTaskChatMessage) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatMessage = {
			type: "task_chat_message",
			workspaceId,
			taskId,
			message,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of runtimeClients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const broadcastTaskChatCleared = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatClearedMessage = {
			type: "task_chat_cleared",
			workspaceId,
			taskId,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of runtimeClients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const disposeTaskSessionSummaryBroadcast = (workspaceId: string) => {
		const timer = taskSessionBroadcastTimersByWorkspaceId.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
	};

	const cleanupRuntimeStateClient = (client: WebSocket) => {
		disconnectWorkspaceMetadataSubscriptionOfClient(client);
		latestWorkspaceMetadataProbeScopeDeclaredByClient.delete(client);
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					runtimeStateClientsByWorkspaceId.delete(workspaceId);
				}
			}
		}
		runtimeStateWorkspaceIdByClient.delete(client);
		runtimeStateClients.delete(client);
		runtimeStateClientsStillAwaitingInitialSnapshotMessage.delete(client);
		runtimeStateClientsSkippedByProjectsBroadcastWhileAwaitingInitialSnapshot.delete(client);
	};

	const disposeWorkspace = (workspaceId: string) => {
		for (const key of latestNotificationSummaries.keys())
			if (key.startsWith(`${workspaceId}:`)) latestNotificationSummaries.delete(key);
		for (const key of latestNotificationAssistantMessages.keys())
			if (key.startsWith(`${workspaceId}:`)) latestNotificationAssistantMessages.delete(key);
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		terminalManagersByWorkspaceId.delete(workspaceId);
		nativeActivityObserver.forgetWorkspace(workspaceId);
		for (const key of acceptedEdgeBySession.keys())
			if (key.startsWith(`${workspaceId}:`)) {
				acceptedEdgeBySession.delete(key);
				pendingAttemptBySession.delete(key);
			}
		for (const subscriptionKey of listConversationSubscriptionKeys(workspaceId)) {
			for (const unsubscribeMap of [
				conversationSummaryUnsubscribeBySubscriptionKey,
				conversationMessageUnsubscribeBySubscriptionKey,
			]) {
				const unsubscribe = unsubscribeMap.get(subscriptionKey);
				if (unsubscribe) {
					try {
						unsubscribe();
					} catch {
						// Ignore listener cleanup errors during project removal.
					}
				}
				unsubscribeMap.delete(subscriptionKey);
			}
			conversationPreviousSummariesBySubscriptionKey.delete(subscriptionKey);
		}
		disposeTaskSessionSummaryBroadcast(workspaceId);
		agentSessionResponseGenerationStopObserver.forgetWorkspace(workspaceId);
		queuedTaskPromptDeliveryDispatchObserver?.forgetWorkspace(workspaceId);
		persistedAgentTranscriptConversationProgressObserver.forgetWorkspace(workspaceId);
		workspaceMetadataMonitor.disposeWorkspace(workspaceId);
	};

	const broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		// isDone 刷新：board 变更（含 move-to-done）后重建该 workspace 的通知 feed 并全局广播，使铃铛面板
		// 即时隐藏已完成卡片。放在下方 per-workspace 0-客户端 guard 之前——即便没人正看该 workspace，
		// 跨 repo 铃铛仍需拿到它的 isDone 变化（内部按全局客户端数自守卫）。
		void broadcastNotificationLogUpdated(workspaceId);
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
			const payload: RuntimeStateStreamWorkspaceStateMessage = {
				type: "workspace_state_updated",
				workspaceId,
				workspaceState,
			};
			const serializedPayload = JSON.stringify(payload);
			for (const client of clients) {
				sendSerializedRuntimeStateMessage(client, serializedPayload);
			}
			await workspaceMetadataMonitor.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			});
		} catch {
			// Ignore transient state read failures; next update will resync.
		}
	};

	// 重建某 workspace 的派生通知 feed 并全局广播（铃铛跨 repo 聚合，故发给所有连接客户端而非仅本 workspace）。
	// 0 客户端时直接跳过广播——但注意持久化早已在 appendNotificationLogEntry 完成，这里只管在场客户端的推送。
	const broadcastNotificationLogUpdated = async (workspaceId: string): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			const entries = await readNotificationLog(workspaceId, 50);
			const feed = await buildNotificationFeedEntries(workspaceId, entries);
			const payload: RuntimeStateStreamNotificationLogUpdatedMessage = {
				type: "notification_log_updated",
				workspaceId,
				entries: feed,
			};
			const serializedPayload = JSON.stringify(payload);
			for (const client of runtimeStateClients) {
				sendSerializedRuntimeStateMessage(client, serializedPayload);
			}
		} catch {
			// 通知 feed 重建失败不影响主流程；下次变更会重发。
		}
	};

	// Exploratory findings 集合变更推送：持久化早已在 mutation 的串行写队列完成（durable-write-before-ack），这里只把完整集合
	// （全量替换，恒小）发给本 workspace 在场客户端；0 客户端时跳过——客户端重连后靠
	// getFindings 查询对齐，不补发。
	const broadcastExploratoryFindingsUpdated = (
		workspaceId: string,
		findings: RuntimeExploratoryFindingEntry[],
	): void => {
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamExploratoryFindingsUpdatedMessage = {
			type: "exploratory_findings_updated",
			workspaceId,
			findings,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of clients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};
	// exploration thread graph 变更推送（B.2）：单个 exploration 的整张图全量替换。与 findings 同款
	// 纪律——落盘成功后才发、0 客户端时跳过、断连窗口不补发（客户端重连后靠 getExplorationThreadGraph
	// 重查对齐）。图恒小（一次探索场次的 turn 行数），全量替换比增量补丁简单且不会错位。
	const broadcastExplorationThreadGraphUpdated = (
		workspaceId: string,
		explorationId: string,
		view: RuntimeExplorationThreadGraphProjectionView,
	): void => {
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamExplorationThreadGraphUpdatedMessage = {
			type: "exploration_thread_graph_updated",
			workspaceId,
			explorationId,
			view,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of clients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const broadcastQueuedTaskPromptDeliveriesUpdated = (
		workspaceId: string,
		projectedEntriesByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	): void => {
		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessage = {
			type: "queued_task_prompt_deliveries_updated",
			workspaceId,
			projectedEntriesByTaskId,
		};
		const serializedPayload = JSON.stringify(payload);
		for (const client of clients) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	// 每个 workspace 最近一次资源快照消息（已序列化）：新客户端连上时补发。
	const latestSerializedTaskResourceUsageSnapshotsMessageByWorkspaceId = new Map<string, string>();
	const broadcastTaskResourceUsageSnapshotsUpdated = (
		workspaceId: string,
		snapshots: RuntimeLiveTaskResourceUsageSnapshot[],
	): void => {
		const serializedPayload = JSON.stringify({
			type: "task_resource_usage_snapshots_updated",
			workspaceId,
			snapshots,
		} satisfies RuntimeStateStreamTaskResourceUsageSnapshotsUpdatedMessage);
		latestSerializedTaskResourceUsageSnapshotsMessageByWorkspaceId.set(workspaceId, serializedPayload);
		for (const client of runtimeStateClientsByWorkspaceId.get(workspaceId) ?? []) {
			sendSerializedRuntimeStateMessage(client, serializedPayload);
		}
	};

	const buildAggregatedNotificationFeed = async (): Promise<RuntimeNotificationFeedEntry[]> => {
		try {
			const logsByWorkspaceId = await readAllNotificationLogs();
			const feeds = await Promise.all(
				Object.entries(logsByWorkspaceId).map(([logWorkspaceId, entries]) =>
					buildNotificationFeedEntries(logWorkspaceId, entries),
				),
			);
			return feeds.flat();
		} catch {
			return [];
		}
	};

	// 就绪通知投给**所有**在场客户端，不只是该 workspace 的连接：一个浏览器标签页可以经跨项目切换面板
	// 只开一个页面管全部项目（docs/context-cross-project-recently-active-task-switcher.md），只投给目标项目的
	// 连接会让「没开着目标项目的那个标签页」永远收不到 OS 通知 / 提示音 / 播报。多标签页之间不会重复弹：
	// 前端以 claimDelivery 领取（每个 candidate 只有一个客户端领得到），并按「有没有可见标签页正开着该项目」让位。
	const sendTaskReadyForReviewToAllRuntimeStateClients = (payload: RuntimeStateStreamTaskReadyForReviewMessage) => {
		for (const client of runtimeStateClients) sendRuntimeStateMessage(client, payload);
	};
	const notificationAssessment = createNotificationAssessmentService({
		publishUnarchived: async (notification) => {
			const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
				type: "task_ready_for_review",
				workspaceId: notification.workspaceId,
				taskId: notification.taskId,
				triggeredAt: Date.now(),
				userTurnKind: notification.userTurnKind,
				summaryText: `通知留档不完整，请查看任务。${notification.finalMessage ?? ""}`,
				archiveIncomplete: true,
			};
			sendTaskReadyForReviewToAllRuntimeStateClients(payload);
		},
		getSummary: async (workspaceId, taskId) => {
			const live = latestNotificationSummaries.get(`${workspaceId}:${taskId}`);
			if (live) return live;
			try {
				const persisted = await loadPersistedWorkspaceStateById(workspaceId);
				return (
					persisted.sessions[taskId] ??
					(persisted.board.columns.some((column) => column.cards.some((card) => card.id === taskId))
						? undefined
						: null)
				);
			} catch {
				return undefined;
			}
		},
		publish: async (candidate) => {
			await broadcastNotificationLogUpdated(candidate.workspaceId);
			const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
				type: "task_ready_for_review",
				workspaceId: candidate.workspaceId,
				taskId: candidate.taskId,
				triggeredAt: Date.now(),
				candidateId: candidate.candidateId,
				summaryText: candidate.summaryText,
				summaryLanguage: candidate.summaryLanguage,
				taskTitleSnapshot: candidate.taskTitleSnapshot,
				notificationSpeechAnnouncementScript: candidate.notificationSpeechAnnouncementScript ?? undefined,
				userTurnKind: candidate.userTurnKind as RuntimeTaskSessionUserTurnKind,
				...(isNotificationSpeechSuppressedBecauseAgentEventWasDeliveredLate(candidate.evidence)
					? { notificationSpeechSuppressedBecauseAgentEventWasDeliveredLate: true }
					: {}),
			};
			sendTaskReadyForReviewToAllRuntimeStateClients(payload);
		},
	});
	const broadcastTaskReadyForReview = (
		workspaceId: string,
		taskId: string,
		userTurnKind: RuntimeTaskSessionUserTurnKind,
		evidence?: Pick<
			NotificationAssessmentInput,
			"candidateId" | "summary" | "finalMessage" | "agentEventDeliveredLateToRuntimeByMilliseconds"
		>,
	) => {
		if (evidence?.summary)
			latestNotificationSummaries.set(`${workspaceId}:${evidence.summary.taskId}`, evidence.summary);
		void notificationAssessment.enqueue({ workspaceId, taskId, userTurnKind, ...evidence });
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		// 浏览器 → 服务端只有一种消息：改 git 元数据探测范围。解析不了的一律忽略（不断连）。
		client.on("message", (rawMessage, isBinary) => {
			if (isBinary) {
				return;
			}
			let parsedMessage: unknown;
			try {
				parsedMessage = JSON.parse(String(rawMessage));
			} catch {
				return;
			}
			const clientMessage = runtimeStateStreamClientMessageSchema.safeParse(parsedMessage);
			if (!clientMessage.success) {
				return;
			}
			const { workspaceMetadataProbeScope } = clientMessage.data;
			latestWorkspaceMetadataProbeScopeDeclaredByClient.set(client, workspaceMetadataProbeScope);
			// 还在握手（没注册进按 workspace 的广播名单）：先记下，注册后再补探，否则补探的推送到不了这个连接。
			const subscription = runtimeStateWorkspaceIdByClient.has(client)
				? workspaceMetadataSubscriptionByClient.get(client)
				: undefined;
			if (subscription) {
				workspaceMetadataMonitor.updateSubscriberProbeScope({
					workspaceId: subscription.workspaceId,
					subscriberId: subscription.subscriberId,
					probeScope: workspaceMetadataProbeScope,
				});
			}
		});
		try {
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			const initialWorkspaceMetadataProbeScope =
				typeof context === "object" && context !== null && "initialWorkspaceMetadataProbeScope" in context
					? ((
							context as {
								initialWorkspaceMetadataProbeScope?: RuntimeWorkspaceMetadataProbeScopeDeclaredByStreamClient | null;
							}
						).initialWorkspaceMetadataProbeScope ?? null)
					: null;
			if (initialWorkspaceMetadataProbeScope && !latestWorkspaceMetadataProbeScopeDeclaredByClient.has(client)) {
				latestWorkspaceMetadataProbeScopeDeclaredByClient.set(client, initialWorkspaceMetadataProbeScope);
			}
			const workspace: ResolvedWorkspaceStreamTarget =
				await deps.workspaceRegistry.resolveWorkspaceForStream(requestedWorkspaceId);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			// 首帧不等 git：先用缓存或空元数据发送 snapshot，再注册广播，最后登记监视器并启动探测。
			// 新连接尚未进入 workspace 广播名单时，既有连接的后台探测不会抢在它的 snapshot 前送增量。
			runtimeStateClients.add(client);
			// 不变式：snapshot 永远是该连接收到的第一条带 currentProjectId 的状态。组 snapshot 要几百毫秒（负载高时上秒），
			// 期间别的项目有 agent 在跑就会每 150ms 广播一次 projects_updated；它若先到，浏览器会把 currentProjectId 换成
			// 本连接的项目、board 却还是上一个项目的，切项目途中点任务就会在旧 board 里找卡、误报任务不在看板。
			// 故首帧前 projects_updated 跳过本连接，首帧发出后补发（releaseRuntimeStateClientFromAwaitingInitialSnapshot）。
			// 其余全局广播（通知 / MCP auth / Cline 会话上下文）不改 currentProjectId，照常即时送达。
			runtimeStateClientsStillAwaitingInitialSnapshotMessage.add(client);
			let monitorWorkspaceId: string | null = null;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"] = null;
				if (workspace.status === "available") {
					monitorWorkspaceId = workspace.projectId;
					[projectsPayload, workspaceState] = await Promise.all([
						deps.workspaceRegistry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(workspace.projectId),
						deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.projectId, workspace.workspacePath),
					]);
				} else {
					projectsPayload = await deps.workspaceRegistry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(
						workspace.projectId,
					);
					workspaceState = null;
					workspaceMetadata = null;
				}
				// 聚合全部 workspace 的通知 feed，随首帧快照下发（铃铛跨 repo）。独立于当前连接的 workspace scope。
				const notificationLog = await buildAggregatedNotificationFeed();
				if (client.readyState !== WebSocket.OPEN) {
					cleanupRuntimeStateClient(client);
					return;
				}
				// 通知读取也可能让出事件循环：直到发帧前才读缓存，避免漏掉这段等待期间的 git 更新。
				if (workspace.status === "available" && workspaceState) {
					workspaceMetadata = workspaceMetadataMonitor.readCachedWorkspaceMetadataSnapshot({
						workspaceId: workspace.projectId,
						board: workspaceState.board,
						probeScope:
							latestWorkspaceMetadataProbeScopeDeclaredByClient.get(client) ??
							ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
					});
				}
				sendRuntimeStateMessage(client, {
					type: "snapshot",
					currentProjectId: projectsPayload.currentProjectId,
					projects: projectsPayload.projects,
					workspaceState,
					workspaceMetadata,
					clineSessionContextVersion,
					notificationLog,
				} satisfies RuntimeStateStreamSnapshotMessage);
				releaseRuntimeStateClientFromAwaitingInitialSnapshot(client, workspace.projectId);

				if (client.readyState !== WebSocket.OPEN) {
					cleanupRuntimeStateClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
					if (workspace.status === "available" && workspaceState) {
						workspaceMetadataSubscriberSequenceNumber += 1;
						const subscriberId = `runtime-state-stream-client-${workspaceMetadataSubscriberSequenceNumber}`;
						workspaceMetadataSubscriptionByClient.set(client, { workspaceId: monitorWorkspaceId, subscriberId });
						// 登记前再读最新范围：握手途中改变的焦点也能进入首轮，不必先探旧范围。
						void workspaceMetadataMonitor
							.connectWorkspace({
								workspaceId: monitorWorkspaceId,
								workspacePath: workspace.workspacePath,
								board: workspaceState.board,
								subscriberId,
								probeScope:
									latestWorkspaceMetadataProbeScopeDeclaredByClient.get(client) ??
									ALL_TRACKED_TASK_WORKTREES_OF_WORKSPACE_METADATA_PROBE_SCOPE,
							})
							.catch((error: unknown) => {
								// 监视器已摘掉失败订阅；只处理仍属于本连接的订阅，不留下未捕获 rejection。
								if (workspaceMetadataSubscriptionByClient.get(client)?.subscriberId !== subscriberId) return;
								disconnectWorkspaceMetadataSubscriptionOfClient(client);
								sendRuntimeStateMessage(client, {
									type: "error",
									message: error instanceof Error ? error.message : String(error),
								} satisfies RuntimeStateStreamErrorMessage);
							});
					}
					const conversationSummaries = collectTrackedConversationSummaries(monitorWorkspaceId);
					if (conversationSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: conversationSummaries,
						} satisfies RuntimeStateStreamTaskSessionsMessage);
					}
					const latestSerializedTaskResourceUsageSnapshotsMessage =
						latestSerializedTaskResourceUsageSnapshotsMessageByWorkspaceId.get(monitorWorkspaceId);
					if (latestSerializedTaskResourceUsageSnapshotsMessage !== undefined) {
						sendSerializedRuntimeStateMessage(client, latestSerializedTaskResourceUsageSnapshotsMessage);
					}
				}
				// 通知重放是 best-effort：先完成订阅登记，档案慢或故障均不阻塞核心推流。
				// 重放期间断连由 close handler 释放订阅；这里不再注册或重复释放 monitor。
				// 重放覆盖**全部**项目而不只是本次连接的项目：就绪通知本就投给所有客户端，而单标签页切项目会
				// 重连 WS，切换那一两秒里别的项目完成的任务只能靠这里补上。已被领取的不重放。
				try {
					const replayWorkspaceIds = new Set<string>(
						(await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId),
					);
					if (workspace.projectId) replayWorkspaceIds.add(workspace.projectId);
					const replayCandidates = (
						await Promise.all(
							[...replayWorkspaceIds].map((replayWorkspaceId) =>
								getNotificationLifecycleArchive().recentReady(replayWorkspaceId, Date.now() - 60_000),
							),
						)
					).flat();
					for (const candidate of replayCandidates) {
						if (candidate.deliveryClaimedBy) continue;
						sendRuntimeStateMessage(client, {
							type: "task_ready_for_review",
							workspaceId: candidate.workspaceId,
							taskId: candidate.taskId,
							candidateId: candidate.candidateId,
							triggeredAt: candidate.notificationPanelVisibilityChangedAt,
							userTurnKind: candidate.userTurnKind as RuntimeTaskSessionUserTurnKind,
							summaryText: candidate.summaryText,
							summaryLanguage: candidate.summaryLanguage,
							taskTitleSnapshot: candidate.taskTitleSnapshot,
							notificationSpeechAnnouncementScript: candidate.notificationSpeechAnnouncementScript ?? undefined,
						});
					}
				} catch {
					logAgentSessionRetentionWarning("notification-replay-failed: 通知档案重放失败，核心状态推流继续。");
				}
			} catch (error) {
				disconnectWorkspaceMetadataSubscriptionOfClient(client);
				// 首帧没发成也不再发：恢复 projects_updated 投递，与改动前「组首帧失败仍收广播」一致。
				releaseRuntimeStateClientFromAwaitingInitialSnapshot(client, workspace.projectId);
				const message = error instanceof Error ? error.message : String(error);
				sendRuntimeStateMessage(client, {
					type: "error",
					message,
				} satisfies RuntimeStateStreamErrorMessage);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendRuntimeStateMessage(client, {
				type: "error",
				message,
			} satisfies RuntimeStateStreamErrorMessage);
			client.close();
		}
	});

	return {
		registerAgentConversationInputAcceptedListener: (listener) => {
			acceptedInputListener = listener;
			return () => {
				if (acceptedInputListener === listener) acceptedInputListener = null;
			};
		},
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			terminalManagersByWorkspaceId.set(workspaceId, manager);
			const unsubscribe = manager.onSummary((summary) => {
				void nativeActivityObserver.observeTaskSessionSummary(workspaceId, summary, () =>
					manager.getSummary(summary.taskId),
				);
				const pending = summary.agentConversationPromptSubmissionAcceptance;
				const pendingKey = `${workspaceId}:${summary.taskId}`;
				const attemptKey = pending ? `${pending.runtimeSessionIncarnationId}:${pending.attemptedAtMs}` : null;
				if (pending?.status === "pending" && attemptKey && pendingAttemptBySession.get(pendingKey) !== attemptKey) {
					pendingAttemptBySession.set(pendingKey, attemptKey);
					nativeActivityObserver.wakeForPotentialUserPromptSubmission(workspaceId, summary, () =>
						manager.getSummary(summary.taskId),
					);
				}
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				// 转录探测只挂在终端通道：能按工作目录直接寻址转录的目前只有 claude（PTY），Cline/ACP 的
				// 「对话上次推进」由它们自己的结构化事件直接给出，不需要读盘反推。观察器内部自带
				// 「支持性判定 + 在途去重 + 冷却（换活体时绕过）+ 全局并发上限」四道闸门，故这里直调即可；
				// 闸门账本按 workspace + task 计账（观察器是被所有 project 共享的单例，taskId 只是 board-local
				// 短 id），故 workspaceId 必须一路传进去。
				persistedAgentTranscriptConversationProgressObserver.observeTaskSessionSummary(
					workspaceId,
					summary,
					manager,
				);
			});
			// 水合会话的一次性回填。**必须有**：hydrateFromRecord 只往 entries 里塞条目、不发 summary，
			// 所以进程重启后那些「已被回收 / 停在等人审查、不会再产出任何东西」的任务永远等不到上面那条
			// onSummary，「对话上次推进」也就永远是空的——而它们恰恰是最需要显示这个量的一批（正在跑的
			// 任务你本来就看得见）。这里在管理器刚被 track 时扫一遍已水合的 summary 补上。
			// 时序前提：workspace-registry 的 notifyTerminalManagerReady 在 hydrateFromRecord **之后**才调，
			// 故此刻 listSummaries() 已经是完整的历史会话集合。
			// 这个循环的条数 = 该 project 下的全部历史任务（数百条量级），但它**不是**同等数量的瞬时读盘：
			// 观察器的闸门④把整个进程的在途探测压到常数，这里只是把条目一次性喂进它的队列。
			for (const hydratedSummary of manager.listSummaries()) {
				acceptedEdgeBySession.set(
					`${workspaceId}:${hydratedSummary.taskId}`,
					hydratedSummary.agentConversationPromptSubmissionAcceptance?.status === "accepted"
						? `${hydratedSummary.runtimeSessionIncarnationId}:${hydratedSummary.agentConversationPromptSubmissionAcceptance.eventId}`
						: null,
				);
				void nativeActivityObserver.observeTaskSessionSummary(workspaceId, hydratedSummary, () =>
					manager.getSummary(hydratedSummary.taskId),
				);
				persistedAgentTranscriptConversationProgressObserver.observeTaskSessionSummary(
					workspaceId,
					hydratedSummary,
					manager,
				);
			}
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
		},
		trackClineTaskSessionService: (workspaceId: string, workspacePath: string, service: ClineTaskSessionService) => {
			trackConversationTaskSessionService(workspaceId, workspacePath, service, "cline");
		},
		trackAcpTaskSessionService: (workspaceId, workspacePath, service) => {
			trackConversationTaskSessionService(workspaceId, workspacePath, service, "acp");
		},
		broadcastTaskChatMessage,
		broadcastDailyWorkProgressStatisticsUpdated: (revision) => {
			for (const client of runtimeStateClients)
				sendRuntimeStateMessage(client, { type: "daily_work_progress_statistics_updated", revision });
		},
		broadcastTaskLookupConversationUpdated: (conversationId, revision) => {
			for (const client of runtimeStateClients)
				sendRuntimeStateMessage(client, { type: "task_lookup_conversation_updated", conversationId, revision });
		},
		broadcastTaskChatCleared,
		listTrackedConversationTaskSessionSummaries: collectTrackedConversationSummaries,
		handleUpgrade: (request, socket, head, context) => {
			runtimeStateWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
				runtimeStateWebSocketServer.emit("connection", ws, context);
			});
		},
		disposeWorkspace,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		broadcastClineMcpAuthStatusesUpdated,
		bumpClineSessionContextVersion,
		broadcastTaskReadyForReview,
		broadcastNotificationLogUpdated,
		broadcastExploratoryFindingsUpdated,
		broadcastExplorationThreadGraphUpdated,
		registerQueuedTaskPromptDeliveryDispatchObserver: (observer) => {
			queuedTaskPromptDeliveryDispatchObserver = observer;
			return () => {
				if (queuedTaskPromptDeliveryDispatchObserver === observer) {
					queuedTaskPromptDeliveryDispatchObserver = null;
				}
			};
		},
		broadcastQueuedTaskPromptDeliveriesUpdated,
		broadcastTaskResourceUsageSnapshotsUpdated,
		close: async () => {
			unsubscribePromptLibraryChanges();
			notificationAssessment.close();
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
			if (projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush !== null) {
				clearTimeout(projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush);
				projectsBroadcastCoalescingTimerAfterTaskSessionSummaryFlush = null;
			}
			for (const unsubscribe of terminalSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalSummaryUnsubscribeByWorkspaceId.clear();
			// 关停后在途探测的回调不得再写 summary（会写进一个正在被拆掉的管理器）。
			persistedAgentTranscriptConversationProgressObserver.dispose();
			nativeActivityObserver.dispose();
			terminalManagersByWorkspaceId.clear();
			acceptedEdgeBySession.clear();
			pendingAttemptBySession.clear();
			for (const timer of acceptedTransitionRetryTimers) clearTimeout(timer);
			acceptedTransitionRetryTimers.clear();
			acceptedTransitionAttemptCount.clear();
			acceptedTransitionsInFlight.clear();
			for (const unsubscribe of conversationSummaryUnsubscribeBySubscriptionKey.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			conversationSummaryUnsubscribeBySubscriptionKey.clear();
			conversationPreviousSummariesBySubscriptionKey.clear();
			for (const unsubscribe of conversationMessageUnsubscribeBySubscriptionKey.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			conversationMessageUnsubscribeBySubscriptionKey.clear();
			workspaceMetadataMonitor.close();
			for (const client of runtimeStateClients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			runtimeStateClients.clear();
			runtimeStateClientsByWorkspaceId.clear();
			runtimeStateWorkspaceIdByClient.clear();
			await new Promise<void>((resolveCloseWebSockets) => {
				runtimeStateWebSocketServer.close(() => {
					resolveCloseWebSockets();
				});
			});
		},
	};
}
