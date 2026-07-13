// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native Cline updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClineTaskMessage, ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
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
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../core/api-contract";
import { isNotifiableUserTurn, resolveSessionFacets } from "../core/session-activity";
import { buildNotificationFeedEntries } from "../state/notification-feed-builder";
import {
	appendNotificationLogEntry,
	readAllNotificationLogs,
	readNotificationLog,
} from "../state/notification-log-store";
import type { TerminalSessionManager } from "../terminal/session-manager";
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
	broadcastTaskChatMessage: (workspaceId: string, taskId: string, message: ClineTaskMessage) => void;
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
	const clineSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const clineMessageUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const clinePreviousSummaryByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
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

	const broadcastTaskChatMessage = (workspaceId: string, taskId: string, message: ClineTaskMessage) => {
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
		const unsubscribeClineSummary = clineSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeClineSummary) {
			try {
				unsubscribeClineSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		clineSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		clinePreviousSummaryByWorkspaceId.delete(workspaceId);
		const unsubscribeClineMessage = clineMessageUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeClineMessage) {
			try {
				unsubscribeClineMessage();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		clineMessageUnsubscribeByWorkspaceId.delete(workspaceId);
		disposeTaskSessionSummaryBroadcast(workspaceId);
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
					const clineSummaries = Array.from(
						clinePreviousSummaryByWorkspaceId.get(monitorWorkspaceId)?.values() ?? [],
					);
					if (clineSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: clineSummaries,
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
			});
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
		},
		trackClineTaskSessionService: (workspaceId: string, workspacePath: string, service: ClineTaskSessionService) => {
			if (clineSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			clinePreviousSummaryByWorkspaceId.set(workspaceId, previousSummariesByTaskId);
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
			clineSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
			const unsubscribeMessage = service.onMessage((taskId, message) => {
				broadcastTaskChatMessage(workspaceId, taskId, message);
			});
			clineMessageUnsubscribeByWorkspaceId.set(workspaceId, unsubscribeMessage);
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
			for (const unsubscribe of clineSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			clineSummaryUnsubscribeByWorkspaceId.clear();
			clinePreviousSummaryByWorkspaceId.clear();
			for (const unsubscribe of clineMessageUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			clineMessageUnsubscribeByWorkspaceId.clear();
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
