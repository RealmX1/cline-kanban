import { isNeverStartedPlaceholderTaskSessionSummary } from "@runtime-session-activity";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { reloadBrowserIfServedBuildAssetsChanged } from "@/runtime/browser-build-asset-refresh";
import type {
	RuntimeClineMcpServerAuthStatus,
	RuntimeExploratoryFindingEntry,
	RuntimeNotificationFeedEntry,
	RuntimeProjectSummary,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	RuntimeStateStreamClineSessionContextUpdatedMessage,
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
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "@/runtime/types";

const STREAM_RECONNECT_BASE_DELAY_MS = 500;
const STREAM_RECONNECT_MAX_DELAY_MS = 5_000;

// 合并规则是「updatedAt 单调」：只接受不比手上更旧的记录。
//
// 注意本函数**只合并、从不删除**：某个 taskId 一旦进过这张表，就不会因为后续推流不再包含它而消失。
// 「跨 workspace 的外来条目在此累积」是另一个已知问题（看板卡 c0724），本文件的守卫不覆盖它——
// 别因为这里有守卫就以为归属问题已经解决了。
//
// 引用纪律：整批没有任何 key 被实际替换时返回入参原引用（惰性拷贝，首个真实写入才 spread），
// 让 reducer / setSessions 的 Object.is bailout 生效——150ms 一批的推流里大量批次内容并没动，
// 为它们白产新对象就是白触发一轮渲染。
export function mergeTaskSessionSummaries(
	currentSessions: Record<string, RuntimeTaskSessionSummary>,
	summaries: RuntimeTaskSessionSummary[],
): Record<string, RuntimeTaskSessionSummary> {
	if (summaries.length === 0) {
		return currentSessions;
	}
	let nextSessions: Record<string, RuntimeTaskSessionSummary> | null = null;
	for (const summary of summaries) {
		const existing = (nextSessions ?? currentSessions)[summary.taskId];
		// 唯一一种「更新的 updatedAt 反而信息更少」的情况：服务端因为前端聚焦了这张卡而就地造出一条
		// 全 null 的占位 summary（session-manager 的 ensureEntry）。它的 updatedAt 是「刚被凭空造出来」，
		// 不是「掌握了更新的事实」。放它盖掉手上那条记着 agentId 的记录，就会让 TUI 变全白、
		// 「重启终端会话」灰掉，且这条空壳还会随下一次 saveState 落盘、把损坏变成永久性的。
		if (
			existing &&
			!isNeverStartedPlaceholderTaskSessionSummary(existing) &&
			isNeverStartedPlaceholderTaskSessionSummary(summary)
		) {
			continue;
		}
		if (!existing || existing.updatedAt <= summary.updatedAt) {
			if (nextSessions === null) {
				nextSessions = { ...currentSessions };
			}
			nextSessions[summary.taskId] = summary;
		}
	}
	return nextSessions ?? currentSessions;
}

// task_sessions_updated 的旁路出口：这条消息 150ms 一批、是最高频推流，不再进 reducer（不为它新建
// workspaceState、不让 App 多渲染一次）。useWorkspaceSync 挂载时把「summaries → 一次 setSessions 合并」
// 注册成 applier，stream hook 收到该批消息直接调用；App 持有这个 ref 并在两个 hook 之间接线。
export type StreamedTaskSessionSummariesApplier = (summaries: RuntimeTaskSessionSummary[]) => void;
export interface StreamedTaskSessionSummariesApplierRef {
	current: StreamedTaskSessionSummariesApplier | null;
}

// 快照下发的是「跨全部 workspace 的扁平 feed」，按 workspaceId 分桶存，便于 notification_log_updated 增量按桶替换。
function bucketNotificationFeedByWorkspaceId(
	entries: RuntimeNotificationFeedEntry[],
): Record<string, RuntimeNotificationFeedEntry[]> {
	const byWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]> = {};
	for (const entry of entries) {
		const bucket = byWorkspaceId[entry.workspaceId] ?? [];
		bucket.push(entry);
		byWorkspaceId[entry.workspaceId] = bucket;
	}
	return byWorkspaceId;
}

// project 被移除后裁剪通知桶：只保留仍存在的 workspace。removeProject 只广播 projects_updated、不发通知增量，
// 若不裁剪，被删 repo 的桶会原样留在客户端内存——铃铛残留其通知且点击跳转失败（切到已删 project 是 no-op）。
// 无 stale 桶时返回原对象，保持引用稳定、不触发无谓重渲染。
function pruneNotificationLogToWorkspaces(
	byWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>,
	liveWorkspaceIds: ReadonlySet<string>,
): Record<string, RuntimeNotificationFeedEntry[]> {
	const staleWorkspaceIds = Object.keys(byWorkspaceId).filter((workspaceId) => !liveWorkspaceIds.has(workspaceId));
	if (staleWorkspaceIds.length === 0) {
		return byWorkspaceId;
	}
	const pruned = { ...byWorkspaceId };
	for (const workspaceId of staleWorkspaceIds) {
		delete pruned[workspaceId];
	}
	return pruned;
}

function getRuntimeStreamUrl(workspaceId: string | null): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/runtime/ws`);
	if (workspaceId) {
		url.searchParams.set("workspaceId", workspaceId);
	}
	return url.toString();
}

export interface UseRuntimeStateStreamResult {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	taskReadyForReviewEvents: RuntimeStateStreamTaskReadyForReviewMessage[];
	latestMcpAuthStatuses: RuntimeClineMcpServerAuthStatus[] | null;
	// 流（重）连握手代数：每次快照递增（每次快照 = 一次（重）连握手完成）。推送只覆盖「在场期间」
	// 的变更；断连窗口的变更不补发，消费者以它为重连信号重查对齐。
	streamSnapshotGeneration: number;
	// Exploratory findings 推送（蓝图 §D.3 exploratory_findings_updated）：workspace 级全量
	// 替换（集合恒小，上限 500）；null = 尚未收到过推送。不搭车 summary 广播，
	// 断连窗口的变更靠重连后 getFindings 重查对齐（重连信号 = streamSnapshotGeneration）。
	exploratoryFindings: RuntimeExploratoryFindingEntry[] | null;
	// exploration thread graph 推送（B.2 exploration_thread_graph_updated）：**按 exploration 分**，
	// 不是 workspace 级全量——一个 workspace 下可以有多张图。这里只保留最近一条推送（同
	// latestTaskReadyForReview 的模式），由 use-exploration-thread-graph 按 explorationId 过滤后消费；
	// 存成按 id 索引的表会随打开过的卡片数无界增长。
	latestExplorationThreadGraphUpdate: RuntimeStateStreamExplorationThreadGraphUpdatedMessage | null;
	// 排队 prompt 投影推送（queued_task_prompt_deliveries_updated）：当前 workspace 的整份替换；null = 尚未
	// 收到过推送。与 findings 同一纪律——断连窗口不补发，重连后由消费者经 streamSnapshotGeneration 重查对齐。
	queuedTaskPromptDeliveryProjectionsByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId | null;
	// 跨 repo 聚合的通知 feed，按 workspaceId 分桶（切项目不清空——铃铛看整台服务器）。
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	clineSessionContextVersion: number;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
	recheckProjectAvailability: () => void;
}

interface RuntimeStateStreamStore {
	currentProjectId: string | null;
	projects: RuntimeProjectSummary[];
	workspaceState: RuntimeWorkspaceStateResponse | null;
	workspaceMetadata: RuntimeWorkspaceMetadata | null;
	latestTaskChatMessage: RuntimeStateStreamTaskChatMessage | null;
	taskChatMessagesByTaskId: Record<string, RuntimeTaskChatMessage[]>;
	latestTaskReadyForReview: RuntimeStateStreamTaskReadyForReviewMessage | null;
	taskReadyForReviewEvents: RuntimeStateStreamTaskReadyForReviewMessage[];
	latestMcpAuthStatuses: RuntimeClineMcpServerAuthStatus[] | null;
	streamSnapshotGeneration: number;
	exploratoryFindings: RuntimeExploratoryFindingEntry[] | null;
	latestExplorationThreadGraphUpdate: RuntimeStateStreamExplorationThreadGraphUpdatedMessage | null;
	queuedTaskPromptDeliveryProjectionsByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId | null;
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	clineSessionContextVersion: number;
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
}

type RuntimeStateStreamAction =
	| { type: "requested_workspace_changed" }
	| { type: "stream_connected" }
	| { type: "snapshot"; payload: RuntimeStateStreamSnapshotMessage }
	| {
			type: "projects_updated";
			payload: RuntimeStateStreamProjectsMessage;
			nextProjectId: string | null;
	  }
	| { type: "task_chat_message"; payload: RuntimeStateStreamTaskChatMessage }
	| { type: "task_chat_cleared"; payload: RuntimeStateStreamTaskChatClearedMessage }
	| { type: "workspace_metadata_updated"; workspaceMetadata: RuntimeWorkspaceMetadata }
	| { type: "task_ready_for_review"; payload: RuntimeStateStreamTaskReadyForReviewMessage }
	| { type: "notification_log_updated"; payload: RuntimeStateStreamNotificationLogUpdatedMessage }
	| { type: "exploratory_findings_updated"; payload: RuntimeStateStreamExploratoryFindingsUpdatedMessage }
	| {
			type: "queued_task_prompt_deliveries_updated";
			payload: RuntimeStateStreamQueuedTaskPromptDeliveriesUpdatedMessage;
	  }
	| {
			type: "exploration_thread_graph_updated";
			payload: RuntimeStateStreamExplorationThreadGraphUpdatedMessage;
	  }
	| { type: "mcp_auth_updated"; payload: RuntimeStateStreamMcpAuthUpdatedMessage }
	| { type: "cline_session_context_updated"; payload: RuntimeStateStreamClineSessionContextUpdatedMessage }
	| { type: "workspace_state_updated"; workspaceState: RuntimeWorkspaceStateResponse }
	| { type: "stream_error"; message: string }
	| { type: "stream_disconnected"; message: string };

function createInitialRuntimeStateStreamStore(requestedWorkspaceId: string | null): RuntimeStateStreamStore {
	return {
		currentProjectId: requestedWorkspaceId,
		projects: [],
		workspaceState: null,
		workspaceMetadata: null,
		latestTaskChatMessage: null,
		taskChatMessagesByTaskId: {},
		latestTaskReadyForReview: null,
		taskReadyForReviewEvents: [],
		latestMcpAuthStatuses: null,
		streamSnapshotGeneration: 0,
		exploratoryFindings: null,
		latestExplorationThreadGraphUpdate: null,
		queuedTaskPromptDeliveryProjectionsByTaskId: null,
		notificationLogByWorkspaceId: {},
		clineSessionContextVersion: 0,
		streamError: null,
		isRuntimeDisconnected: false,
		hasReceivedSnapshot: false,
	};
}

function upsertTaskChatMessage(
	currentMessages: RuntimeTaskChatMessage[],
	nextMessage: RuntimeTaskChatMessage,
): RuntimeTaskChatMessage[] {
	const existingIndex = currentMessages.findIndex((message) => message.id === nextMessage.id);
	if (existingIndex < 0) {
		return [...currentMessages, nextMessage];
	}
	const existingMessage = currentMessages[existingIndex];
	if (
		existingMessage &&
		existingMessage.content === nextMessage.content &&
		existingMessage.role === nextMessage.role &&
		existingMessage.createdAt === nextMessage.createdAt &&
		JSON.stringify(existingMessage.meta ?? null) === JSON.stringify(nextMessage.meta ?? null)
	) {
		return currentMessages;
	}
	const nextMessages = [...currentMessages];
	nextMessages[existingIndex] = nextMessage;
	return nextMessages;
}

function resolveProjectIdAfterProjectsUpdate(
	currentProjectId: string | null,
	payload: RuntimeStateStreamProjectsMessage,
): string | null {
	if (currentProjectId && payload.projects.some((project) => project.id === currentProjectId)) {
		return currentProjectId;
	}
	return payload.currentProjectId;
}

function runtimeStateStreamReducer(
	state: RuntimeStateStreamStore,
	action: RuntimeStateStreamAction,
): RuntimeStateStreamStore {
	if (action.type === "requested_workspace_changed") {
		return {
			...state,
			workspaceState: null,
			workspaceMetadata: null,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {},
			// findings 是 workspace 级集合：切 workspace 即清空，等 getFindings 重拉。
			exploratoryFindings: null,
			// 队列投影同为 workspace 级：taskId 是 board-local 短 id，跨 workspace 沿用会撞号。
			queuedTaskPromptDeliveryProjectionsByTaskId: null,
			streamSnapshotGeneration: 0,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: false,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			clineSessionContextVersion: state.clineSessionContextVersion,
		};
	}
	if (action.type === "stream_connected") {
		return {
			...state,
			streamError: null,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "snapshot") {
		const nextWorkspaceState = action.payload.workspaceState
			? {
					...action.payload.workspaceState,
					sessions: mergeTaskSessionSummaries(
						state.workspaceState?.sessions ?? {},
						Object.values(action.payload.workspaceState.sessions ?? {}),
					),
				}
			: null;
		return {
			currentProjectId: action.payload.currentProjectId,
			projects: action.payload.projects,
			workspaceState: nextWorkspaceState,
			workspaceMetadata: action.payload.workspaceMetadata,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {},
			latestTaskReadyForReview: state.latestTaskReadyForReview,
			taskReadyForReviewEvents: state.taskReadyForReviewEvents,
			latestMcpAuthStatuses: state.latestMcpAuthStatuses,
			// 快照是聚合日志的权威源：整体替换分桶（含重连后从后端恢复已访问态）。
			// ?? [] 兜底旧服务端/异常 payload——缺字段时不因 for-of undefined 抛错而丢掉整个 snapshot。
			notificationLogByWorkspaceId: bucketNotificationFeedByWorkspaceId(action.payload.notificationLog ?? []),
			clineSessionContextVersion: action.payload.clineSessionContextVersion,
			// 每次快照 = 一次（重）连握手完成：递增代数给消费者做「重连后重查对齐」的触发
			// （断连窗口的变更不补发）。findings 保留作 last-known（重连后由 use-exploratory-findings
			// 经快照代数重拉对齐），查询落定前不出现空窗。
			exploratoryFindings: state.exploratoryFindings,
			// 图同样保留作 last-known：重连后由 use-exploration-thread-graph 经快照代数重拉对齐，
			// 查询落定前不出现空窗（读图免费，重拉没有成本顾虑）。
			latestExplorationThreadGraphUpdate: state.latestExplorationThreadGraphUpdate,
			// 队列投影同样保留作 last-known，重连后由 use-queued-task-prompt-delivery-projection-sync 重拉对齐。
			queuedTaskPromptDeliveryProjectionsByTaskId: state.queuedTaskPromptDeliveryProjectionsByTaskId,
			streamSnapshotGeneration: state.streamSnapshotGeneration + 1,
			streamError: null,
			isRuntimeDisconnected: false,
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "projects_updated") {
		const didProjectChange = action.nextProjectId !== state.currentProjectId;
		// project.id 即 workspaceId（通知桶键）；裁剪已移除 workspace 的桶（见 pruneNotificationLogToWorkspaces）。
		const liveWorkspaceIds = new Set(action.payload.projects.map((project) => project.id));
		return {
			...state,
			currentProjectId: action.nextProjectId,
			projects: action.payload.projects,
			workspaceState: didProjectChange ? null : state.workspaceState,
			workspaceMetadata: didProjectChange ? null : state.workspaceMetadata,
			latestTaskChatMessage: didProjectChange ? null : state.latestTaskChatMessage,
			taskChatMessagesByTaskId: didProjectChange ? {} : state.taskChatMessagesByTaskId,
			latestTaskReadyForReview: didProjectChange ? null : state.latestTaskReadyForReview,
			taskReadyForReviewEvents: didProjectChange ? [] : state.taskReadyForReviewEvents,
			// 切项目必须清：图是 per-exploration 的，换了 project 之后旧推送里的 explorationId
			// 可能与新 project 的某张卡片撞号（taskId 是 board-local 短 id）。
			latestExplorationThreadGraphUpdate: didProjectChange ? null : state.latestExplorationThreadGraphUpdate,
			queuedTaskPromptDeliveryProjectionsByTaskId: didProjectChange
				? null
				: state.queuedTaskPromptDeliveryProjectionsByTaskId,
			notificationLogByWorkspaceId: pruneNotificationLogToWorkspaces(
				state.notificationLogByWorkspaceId,
				liveWorkspaceIds,
			),
			hasReceivedSnapshot: true,
		};
	}
	if (action.type === "task_chat_message") {
		const currentTaskMessages = state.taskChatMessagesByTaskId[action.payload.taskId] ?? [];
		return {
			...state,
			latestTaskChatMessage: action.payload,
			taskChatMessagesByTaskId: {
				...state.taskChatMessagesByTaskId,
				[action.payload.taskId]: upsertTaskChatMessage(currentTaskMessages, action.payload.message),
			},
		};
	}
	if (action.type === "task_chat_cleared") {
		return {
			...state,
			latestTaskChatMessage: null,
			taskChatMessagesByTaskId: {
				...state.taskChatMessagesByTaskId,
				[action.payload.taskId]: [],
			},
		};
	}
	if (action.type === "workspace_metadata_updated") {
		return {
			...state,
			workspaceMetadata: action.workspaceMetadata,
		};
	}
	if (action.type === "task_ready_for_review") {
		return {
			...state,
			latestTaskReadyForReview: action.payload,
			taskReadyForReviewEvents: [
				...state.taskReadyForReviewEvents.filter((event) => Date.now() - event.triggeredAt < 60_000),
				action.payload,
			],
		};
	}
	if (action.type === "notification_log_updated") {
		// 按桶替换该 workspace 的整段 feed（后端每次发的是完整 feed，非增量条目）。跨 repo：其它桶不动。
		return {
			...state,
			notificationLogByWorkspaceId: {
				...state.notificationLogByWorkspaceId,
				[action.payload.workspaceId]: action.payload.entries,
			},
		};
	}
	if (action.type === "mcp_auth_updated") {
		return {
			...state,
			latestMcpAuthStatuses: action.payload.statuses,
		};
	}
	if (action.type === "exploration_thread_graph_updated") {
		// 单张图的全量替换。按 exploration 分发，消费侧负责过滤出当前卡片那张。
		return {
			...state,
			latestExplorationThreadGraphUpdate: action.payload,
		};
	}
	if (action.type === "queued_task_prompt_deliveries_updated") {
		// workspace 级整份替换：一次认领 / 落定会同时改好几条的状态与阻塞原因，增量补丁在断连重连之间极易错位。
		return {
			...state,
			queuedTaskPromptDeliveryProjectionsByTaskId: action.payload.projectedEntriesByTaskId,
		};
	}
	if (action.type === "exploratory_findings_updated") {
		// workspace 级全量替换（推送恒为完整集合，上限 500）——save/confirm/reject/archive/
		// ingest 落盘成功后服务端广播，本地不做乐观更新，状态经推送收敛。
		return {
			...state,
			exploratoryFindings: action.payload.findings,
		};
	}
	if (action.type === "cline_session_context_updated") {
		return {
			...state,
			clineSessionContextVersion: action.payload.version,
		};
	}
	if (action.type === "workspace_state_updated") {
		const mergedWorkspaceState = {
			...action.workspaceState,
			sessions: mergeTaskSessionSummaries(
				state.workspaceState?.sessions ?? {},
				Object.values(action.workspaceState.sessions ?? {}),
			),
		};
		return {
			...state,
			workspaceState: mergedWorkspaceState,
		};
	}
	if (action.type === "stream_error") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: false,
		};
	}
	if (action.type === "stream_disconnected") {
		return {
			...state,
			streamError: action.message,
			isRuntimeDisconnected: true,
		};
	}
	return state;
}

export function useRuntimeStateStream(
	requestedWorkspaceId: string | null,
	onTaskSessionSummaries?: StreamedTaskSessionSummariesApplier,
): UseRuntimeStateStreamResult {
	const [state, dispatch] = useReducer(
		runtimeStateStreamReducer,
		requestedWorkspaceId,
		createInitialRuntimeStateStreamStore,
	);
	// render 期同步赋值（react-use useLatest 的标准实现，本仓库同款写法见 use-notification-task-focus-routing）：
	// WS 回调经此 ref 读最新 applier，避免把回调身份编进连接 effect 的依赖（那会每次渲染都重连）。
	const onTaskSessionSummariesRef = useRef<StreamedTaskSessionSummariesApplier | undefined>(undefined);
	onTaskSessionSummariesRef.current = onTaskSessionSummaries;
	const [runtimeStreamConnectionGeneration, setRuntimeStreamConnectionGeneration] = useState(0);
	const recheckProjectAvailability = useCallback(() => {
		setRuntimeStreamConnectionGeneration((currentGeneration) => currentGeneration + 1);
	}, []);
	useEffect(() => {
		let cancelled = false;
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let reconnectAttempt = 0;
		let activeWorkspaceId = requestedWorkspaceId;
		let requestedWorkspaceForConnection = requestedWorkspaceId;
		let hasOpenedRuntimeStream = false;
		let shouldCheckServedBuildAssetsOnOpen = false;

		dispatch({ type: "requested_workspace_changed" });

		const cleanupSocket = () => {
			if (socket) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
				socket = null;
			}
		};

		const scheduleReconnect = () => {
			if (cancelled) {
				return;
			}
			if (reconnectTimer !== null) {
				return;
			}
			const delay = Math.min(STREAM_RECONNECT_MAX_DELAY_MS, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(() => {
				connect();
			}, delay);
		};

		const connect = () => {
			if (cancelled) {
				return;
			}
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			cleanupSocket();
			try {
				socket = new WebSocket(getRuntimeStreamUrl(requestedWorkspaceForConnection));
			} catch (error) {
				dispatch({
					type: "stream_disconnected",
					message: error instanceof Error ? error.message : String(error),
				});
				scheduleReconnect();
				return;
			}
			socket.onopen = () => {
				if (hasOpenedRuntimeStream && shouldCheckServedBuildAssetsOnOpen) {
					void reloadBrowserIfServedBuildAssetsChanged();
				}
				hasOpenedRuntimeStream = true;
				shouldCheckServedBuildAssetsOnOpen = false;
				reconnectAttempt = 0;
				dispatch({ type: "stream_connected" });
			};
			socket.onmessage = (event) => {
				try {
					const payload = JSON.parse(String(event.data)) as RuntimeStateStreamMessage;
					if (payload.type === "snapshot") {
						activeWorkspaceId = payload.currentProjectId;
						dispatch({ type: "snapshot", payload });
						return;
					}
					if (payload.type === "projects_updated") {
						const previousWorkspaceId = activeWorkspaceId;
						const nextProjectId = resolveProjectIdAfterProjectsUpdate(activeWorkspaceId, payload);
						activeWorkspaceId = nextProjectId;
						dispatch({
							type: "projects_updated",
							payload,
							nextProjectId,
						});
						if (nextProjectId && nextProjectId !== previousWorkspaceId) {
							requestedWorkspaceForConnection = nextProjectId;
							dispatch({ type: "requested_workspace_changed" });
							connect();
						}
						return;
					}
					if (payload.type === "workspace_state_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "workspace_state_updated",
							workspaceState: payload.workspaceState,
						});
						return;
					}
					if (payload.type === "workspace_metadata_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "workspace_metadata_updated",
							workspaceMetadata: payload.workspaceMetadata,
						});
						return;
					}
					if (payload.type === "task_chat_message") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "task_chat_message",
							payload,
						});
						return;
					}
					if (payload.type === "task_chat_cleared") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "task_chat_cleared",
							payload,
						});
						return;
					}
					if (payload.type === "task_sessions_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						// 旁路（见 StreamedTaskSessionSummariesApplier）：summaries 直送 useWorkspaceSync 注册的
						// applier，一次 setSessions 并入；reducer 不再为该消息产新 state，App 每批只渲染一次。
						onTaskSessionSummariesRef.current?.(payload.summaries);
						return;
					}
					if (payload.type === "task_ready_for_review") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "task_ready_for_review",
							payload,
						});
						return;
					}
					if (payload.type === "exploration_thread_graph_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "exploration_thread_graph_updated",
							payload,
						});
						return;
					}
					if (payload.type === "notification_log_updated") {
						// 全局广播：不按 activeWorkspaceId 过滤（铃铛跨 repo，需接收其它 workspace 的更新）。
						dispatch({
							type: "notification_log_updated",
							payload,
						});
						return;
					}
					if (payload.type === "queued_task_prompt_deliveries_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "queued_task_prompt_deliveries_updated",
							payload,
						});
						return;
					}
					if (payload.type === "exploratory_findings_updated") {
						if (payload.workspaceId !== activeWorkspaceId) {
							return;
						}
						dispatch({
							type: "exploratory_findings_updated",
							payload,
						});
						return;
					}
					if (payload.type === "mcp_auth_updated") {
						dispatch({
							type: "mcp_auth_updated",
							payload,
						});
						return;
					}
					if (payload.type === "cline_session_context_updated") {
						dispatch({
							type: "cline_session_context_updated",
							payload,
						});
						return;
					}
					if (payload.type === "error") {
						dispatch({
							type: "stream_error",
							message: payload.message,
						});
					}
				} catch {
					// Ignore malformed stream messages.
				}
			};
			socket.onclose = () => {
				if (cancelled) {
					return;
				}
				dispatch({
					type: "stream_disconnected",
					message: "Runtime stream disconnected.",
				});
				if (hasOpenedRuntimeStream) {
					shouldCheckServedBuildAssetsOnOpen = true;
				}
				scheduleReconnect();
			};
			socket.onerror = () => {
				if (cancelled) {
					return;
				}
				dispatch({
					type: "stream_disconnected",
					message: "Runtime stream connection failed.",
				});
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (reconnectTimer != null) {
				window.clearTimeout(reconnectTimer);
			}
			cleanupSocket();
		};
	}, [requestedWorkspaceId, runtimeStreamConnectionGeneration]);

	return {
		currentProjectId: state.currentProjectId,
		projects: state.projects,
		workspaceState: state.workspaceState,
		workspaceMetadata: state.workspaceMetadata,
		latestTaskChatMessage: state.latestTaskChatMessage,
		taskChatMessagesByTaskId: state.taskChatMessagesByTaskId,
		latestTaskReadyForReview: state.latestTaskReadyForReview,
		taskReadyForReviewEvents: state.taskReadyForReviewEvents,
		latestMcpAuthStatuses: state.latestMcpAuthStatuses,
		streamSnapshotGeneration: state.streamSnapshotGeneration,
		exploratoryFindings: state.exploratoryFindings,
		latestExplorationThreadGraphUpdate: state.latestExplorationThreadGraphUpdate,
		queuedTaskPromptDeliveryProjectionsByTaskId: state.queuedTaskPromptDeliveryProjectionsByTaskId,
		notificationLogByWorkspaceId: state.notificationLogByWorkspaceId,
		clineSessionContextVersion: state.clineSessionContextVersion,
		streamError: state.streamError,
		isRuntimeDisconnected: state.isRuntimeDisconnected,
		hasReceivedSnapshot: state.hasReceivedSnapshot,
		recheckProjectAvailability,
	};
}
