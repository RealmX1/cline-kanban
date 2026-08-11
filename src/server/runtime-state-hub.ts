// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native Cline updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";

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
	RuntimeNotificationFeedEntry,
	RuntimeStateStreamClineSessionContextUpdatedMessage,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamNotificationLogUpdatedMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskChatMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../core/api-contract";
import { isNotifiableUserTurn, resolveSessionFacets } from "../core/session-activity";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { buildNotificationFeedEntries } from "../state/notification-feed-builder";
import {
	appendNotificationLogEntry,
	readAllNotificationLogs,
	readNotificationLog,
} from "../state/notification-log-store";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createAgentSessionResponseGenerationStopObserver } from "./agent-session-response-generation-stop-observer";
import { createPersistedAgentTranscriptConversationProgressObserver } from "./persisted-agent-transcript-conversation-progress-observer";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry";

const TASK_SESSION_STREAM_BATCH_MS = 150;

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		| "resolveWorkspaceForStream"
		| "buildProjectsPayloadUsingCachedRuntimeProjectAvailability"
		| "buildWorkspaceStateSnapshot"
	>;
}

export interface RuntimeStateHub {
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
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
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
	) => void;
	// 通知中心：某 workspace 的日志变更（mark-visited / clear / board 变更导致 isDone 刷新）后，
	// 重建该 workspace 的派生 feed 并全局广播给所有客户端（铃铛跨 repo 聚合）。
	broadcastNotificationLogUpdated: (workspaceId: string) => Promise<void>;
	close: () => Promise<void>;
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
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
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
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
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
		},
	});

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			const payload =
				await deps.workspaceRegistry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(
					preferredCurrentProjectId,
				);
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, {
					type: "projects_updated",
					currentProjectId: payload.currentProjectId,
					projects: payload.projects,
				} satisfies RuntimeStateStreamProjectsMessage);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
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
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
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
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
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
			for (const client of runtimeClients) {
				sendRuntimeStateMessage(client, payload);
			}
		}
		void broadcastRuntimeProjectsUpdated(workspaceId);
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		// 「停止生成响应后固定宽限期」回收的归一化边沿检测。刻意挂在这里而不是各 transport 内部：
		// 终端 / Cline SDK / ACP 三条 summary 流全部经此排队，是唯一的跨 transport 汇聚点；且这一句
		// 位于下方「0 客户端提前返回」之前，故计时与「有没有人在看」彻底解耦——关标签页 / 切项目 /
		// 折叠侧栏都不影响期限。观察器内部只在状态边沿动账本，不会被高频 summary 刷成 IO 风暴。
		agentSessionResponseGenerationStopObserver.observeTaskSessionSummary(workspaceId, summary);
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
				summary.taskConversationSessionMetadata?.taskConversationSessionRole !== "by_the_way" &&
				!isNotifiableUserTurn(resolveSessionFacets(previousSummary)) &&
				isNotifiableUserTurn(currentFacets)
			) {
				broadcastTaskReadyForReview(workspaceId, summary.taskId, currentFacets.userTurnKind);
			}
		});
		conversationSummaryUnsubscribeBySubscriptionKey.set(subscriptionKey, unsubscribe);
		const unsubscribeMessage = service.onMessage((taskId, message) => {
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
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
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
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
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
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
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
	};

	const disposeWorkspace = (workspaceId: string) => {
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
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
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
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
			const entries = await readNotificationLog(workspaceId);
			const feed = await buildNotificationFeedEntries(workspaceId, entries);
			const payload: RuntimeStateStreamNotificationLogUpdatedMessage = {
				type: "notification_log_updated",
				workspaceId,
				entries: feed,
			};
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, payload);
			}
		} catch {
			// 通知 feed 重建失败不影响主流程；下次变更会重发。
		}
	};

	// 先无条件落库（可通知边沿的持久化），再全局广播 feed。落库独立于客户端在场与否。
	const persistNotification = async (
		workspaceId: string,
		input: { taskId: string; userTurnKind: RuntimeTaskSessionUserTurnKind; triggeredAt: number },
	): Promise<void> => {
		try {
			await appendNotificationLogEntry(workspaceId, input);
		} catch {
			// 落库失败（磁盘错误等）不应打断 OS 通知路径；容忍并继续。
		}
		await broadcastNotificationLogUpdated(workspaceId);
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

	const broadcastTaskReadyForReview = (
		workspaceId: string,
		taskId: string,
		userTurnKind: RuntimeTaskSessionUserTurnKind,
	) => {
		const triggeredAt = Date.now();
		// ① 先无条件落库 + 全局广播通知 feed——在下方 per-workspace「0 客户端」guard 之前，
		// 故浏览器全关时段的后台事件也进持久化日志（跨 repo 聚合方案的核心卖点）。同一 triggeredAt
		// 复用给下方一次性 OS 通知事件，保证两条路径的 id/时间一致。
		void persistNotification(workspaceId, { taskId, userTurnKind, triggeredAt });
		// ② 照旧广播一次性 task_ready_for_review（OS 通知用），仅发给本 workspace 的在场客户端，行为不变。
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			triggeredAt,
			userTurnKind,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		try {
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			const workspace: ResolvedWorkspaceStreamTarget =
				await deps.workspaceRegistry.resolveWorkspaceForStream(requestedWorkspaceId);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			/*
				Connection setup for workspace-scoped runtime streams is intentionally split into two phases.

				We need the initial snapshot to already contain the first workspace metadata payload, but we do not want
				the client to receive a separate "workspace_metadata_updated" event before that snapshot arrives.

				That race can happen if we register the websocket in runtimeStateClientsByWorkspaceId first and then call
				workspaceMetadataMonitor.connectWorkspace(...). connectWorkspace() performs an immediate refresh, and that
				refresh may broadcast "workspace_metadata_updated" to every currently registered workspace client. In that
				old ordering, a newly connected client could observe:

				1. workspace_metadata_updated
				2. snapshot

				which makes the initial load look wrong and forces the UI to process the same logical data twice in the
				opposite order from what readers expect.

				To avoid that, we:

				1. add the socket only to the global runtimeStateClients set so project-wide broadcasts still work
				2. build workspace state and connect the metadata monitor to get the initial metadata snapshot
				3. send the combined "snapshot" message
				4. only then register the socket in runtimeStateClientsByWorkspaceId so future incremental
				   workspace_metadata_updated events can flow normally

				The extra readyState checks and monitor cleanup below are paired with this delayed registration. If the
				socket closes while we are still assembling or sending the initial snapshot, we must disconnect the
				temporary metadata monitor subscription before returning, otherwise we would leave behind subscriber count
				state for a client that never finished the handshake.
			*/
			runtimeStateClients.add(client);
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"];
				if (workspace.status === "available") {
					monitorWorkspaceId = workspace.projectId;
					[projectsPayload, workspaceState] = await Promise.all([
						deps.workspaceRegistry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(workspace.projectId),
						deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.projectId, workspace.workspacePath),
					]);
					workspaceMetadata = await workspaceMetadataMonitor.connectWorkspace({
						workspaceId: workspace.projectId,
						workspacePath: workspace.workspacePath,
						board: workspaceState.board,
					});
					didConnectWorkspaceMonitor = true;
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
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
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
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
					const conversationSummaries = collectTrackedConversationSummaries(monitorWorkspaceId);
					if (conversationSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: conversationSummaries,
						} satisfies RuntimeStateStreamTaskSessionsMessage);
					}
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
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
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const unsubscribe = manager.onSummary((summary) => {
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
		broadcastTaskChatCleared,
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
		close: async () => {
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
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
