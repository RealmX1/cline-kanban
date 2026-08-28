// Exploratory session map 的「漂移检测 + 防抖再维护」观察器（蓝图 §B.3）。
//
// 挂载点：runtime-state-hub 的 summary 广播 join point（queueTaskSessionSummaryBroadcast），
// 与 agent-session-response-generation-stop-observer 同位——三条 transport 的 summary 流在此
// 汇聚、且位于「0 客户端提前返回」之前，计时与「有没有人在看」彻底解耦。
//
// M1 的职责边界（对蓝图 §B.3 的一条实施精化，理由见下）：
//   - stale 判据**不是**裸签名漂移，而是「投影最新 turn > map 最新锚点 turn」（存在未入图的
//     用户轮次）。裸投影签名是消息级的——agent 自己的维护动作（ingest 工具调用、收尾消息）
//     同样推进签名，会导致「刚维护完立即又 stale」的恒亮假信号；签名本身仍专任 apply 时刻的
//     乐观并发对账键（蓝图 §B.2 闸 3），不参与这里的漂移判定。reason 枚举沿用
//     turn_projection_signature_drift（语义 = 投影已前进、map 未覆盖）。
//   - 防抖再维护（30–60s 静默窗 + 每会话并发恒 1 + 冷却）的 M1 执行者是**活会话 agent 自己**：
//     向会话投递一条提醒消息，请它按指令文件重跑读-改-写协议。专属的 headless 再维护作业
//     （agent_maintenance_job 来源）等姊妹蓝图 §4.1 Stage 0 后端落地后再接。
//
// 只做三件事：判定（纯函数，可单测）+ stale 落账（经 store 串行写队列）+ 到点投递提醒。
// 不重写 map 内容、不阻塞会话主流程（蓝图：再维护失败永远只留裸锚点列表的纯展示降级）。

import type {
	ClineTaskMessagesProjectionSignature,
	ClineTaskSessionService,
} from "../cline-sdk/cline-task-session-service";
import { deriveConversationTurnProjection } from "../conversation-tree/conversation-turn-projection";
import type { RuntimeExploratorySessionMapCollection, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	mutateExploratorySessionMapState,
	readExploratorySessionMapCollection,
} from "../state/exploratory-session-map-store";

// 静默窗（蓝图 30–60s 档）：会话停在「有未入图用户轮次」且球在用户侧满此时长才投递提醒。
const EXPLORATORY_SESSION_MAP_MAINTENANCE_QUIET_WINDOW_MS = 45_000;
// 同会话两次提醒的最小间隔（作业失败也计——失败容忍 = 退避，不是连发）。
const EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_COOLDOWN_MS = 10 * 60_000;
// 集合快照的进程内缓存上限：stale 判定/锚点统计都按 turn 节律变化，不需要逐 summary 读盘。
const EXPLORATORY_SESSION_MAP_COLLECTION_CACHE_MS = 30_000;

// 投递给活会话的再维护提醒。刻意只说「落后了、按指令文件协议重跑」——协议全文在指令文件里，
// 提醒消息不复制（单一真相）；并明示「无结构节点可不动 map」，防止 agent 为交差硬造节点。
export const EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_TEXT =
	"[Kanban] Session map 已落后于本会话（出现了尚未入图的用户轮次）。请按 exploratory 指令文件" +
	"重跑读-改-写协议（kanban exploratory get-session-map → ingest-map-update）把新出现的结构节点" +
	"登记入图；若这段会话没有值得登记的结构节点，回复确认即可，不要为交差硬造锚点。";

// 「这条 summary 值不值得跑 map 维护观察」。三个条件：
//   ① 会话启动时从卡片快照的模式是 exploratory（缺省 operational 一律不观察）；
//   ② Cline 会话——M1 唯一可解析锚点的投影源（exact_structured），其余 transport 的 map
//      本来也写不进去（apply 漏斗闸 2a 拒），观察只是空转；
//   ③ 会话活体仍 live——死会话投影冻结，stale 早在它活着时已落账，重启后也不补维护
//     （M1 不做「替死会话补 map」，那是再维护作业的活）。
export function shouldObserveExploratorySessionMapMaintenance(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.taskConversationMode !== "exploratory") {
		return false;
	}
	if (summary.agentId !== "cline") {
		return false;
	}
	return resolveSessionFacets(summary).liveness === "live";
}

// 「map 落后于会话」的判定：投影里出现了 map 尚未锚住的用户轮次。
export function isExploratorySessionMapProjectionAheadOfCollection(
	collection: Pick<RuntimeExploratorySessionMapCollection, "mapNodes"> | null,
	projectionLatestTurnNumber: number,
): boolean {
	if (projectionLatestTurnNumber <= 0) {
		return false;
	}
	const maxAnchoredTurnNumber = (collection?.mapNodes ?? []).reduce(
		(max, node) => Math.max(max, node.anchorTurnNumber),
		0,
	);
	return projectionLatestTurnNumber > maxAnchoredTurnNumber;
}

interface CachedCollectionSnapshot {
	fetchedAtMs: number;
	// null = 该会话尚无 map 集合（agent 还没写过）。
	collection: RuntimeExploratorySessionMapCollection | null;
}

interface SessionMaintenanceState {
	cachedCollection: CachedCollectionSnapshot | null;
	// 「有未入图用户轮次」且球在用户侧的静默窗计时器；新 observation 到来即重排（防抖）。
	quietWindowTimer: ReturnType<typeof setTimeout> | null;
	quietWindowStartedAtMs: number | null;
	lastNudgeSentAtMs: number | null;
	nudgeInFlight: boolean;
	// 签名门控缓存：上一次 observation 的消息投影签名与据此算出的 latestTurnNumber。
	// 签名未变 → 投影结果必同，沿用缓存值，跳过一次 O(history) 的全量克隆 + derive。
	lastMessagesSignature: ClineTaskMessagesProjectionSignature | null;
	lastProjectionLatestTurnNumber: number | null;
}

// 消息投影签名逐字段比较（三元结构体而非拼串，避免与
// buildConversationTurnProjectionSignature 的字符串格式产生漂移耦合）。
function sameMessagesProjectionSignature(
	a: ClineTaskMessagesProjectionSignature,
	b: ClineTaskMessagesProjectionSignature,
): boolean {
	return (
		a.messageCount === b.messageCount &&
		a.lastMessageId === b.lastMessageId &&
		a.lastMessageContentLength === b.lastMessageContentLength
	);
}

export interface ExploratorySessionMapMaintenanceObserverDependencies {
	// 按 workspace 取活 Cline 会话服务（hub 在 track 时登记的注册表）；取不到 = 该 workspace
	// 没有 Cline 服务（纯终端/ACP 项目），观察自然空转。
	getClineTaskSessionService: (workspaceId: string) => ClineTaskSessionService | null;
	// 集合变更广播出口（hub 内接 broadcastExploratorySessionMapUpdated）。
	onCollectionUpdated: (
		workspaceId: string,
		conversationSessionTaskId: string,
		mapCollection: RuntimeExploratorySessionMapCollection,
	) => void;
	// 再维护提醒的投递出口（runtime-server 建好后经 setter 注入统一发送出口；未注入时不投递，
	// stale 落账照常——提醒是增强，不是前置）。
	sendMaintenanceNudge?: (workspaceId: string, conversationSessionTaskId: string, text: string) => Promise<void>;
	onNudgeFailed?: (error: unknown, context: { workspaceId: string; conversationSessionTaskId: string }) => void;
	nowFn?: () => number;
	// 计时器可注入（测试用假计时器）；生产默认全局 setTimeout/clearTimeout。
	setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ExploratorySessionMapMaintenanceObserver {
	observeTaskSessionSummary: (workspaceId: string, summary: RuntimeTaskSessionSummary) => void;
	forgetWorkspace: (workspaceId: string) => void;
	dispose: () => void;
}

export function createExploratorySessionMapMaintenanceObserver(
	deps: ExploratorySessionMapMaintenanceObserverDependencies,
): ExploratorySessionMapMaintenanceObserver {
	const now = deps.nowFn ?? Date.now;
	const setTimeoutFn =
		deps.setTimeoutFn ??
		((callback: () => void, delayMs: number) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref();
			return timer;
		});
	const clearTimeoutFn = deps.clearTimeoutFn ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
	const statesBySessionKey = new Map<string, SessionMaintenanceState>();
	const buildSessionKey = (workspaceId: string, taskId: string) => `${workspaceId}::${taskId}`;

	const clearQuietWindow = (state: SessionMaintenanceState): void => {
		if (state.quietWindowTimer !== null) {
			clearTimeoutFn(state.quietWindowTimer);
			state.quietWindowTimer = null;
		}
		state.quietWindowStartedAtMs = null;
	};

	const loadCollectionSnapshot = async (
		workspaceId: string,
		taskId: string,
		state: SessionMaintenanceState,
	): Promise<CachedCollectionSnapshot> => {
		const cached = state.cachedCollection;
		if (cached !== null && now() - cached.fetchedAtMs < EXPLORATORY_SESSION_MAP_COLLECTION_CACHE_MS) {
			return cached;
		}
		const collection = await readExploratorySessionMapCollection(workspaceId, taskId).catch(() => null);
		const snapshot: CachedCollectionSnapshot = { fetchedAtMs: now(), collection };
		state.cachedCollection = snapshot;
		return snapshot;
	};

	// stale 落账：经 store 串行写队列把 mapStaleReason 置位（幂等——已置位/集合已消失/集合已被
	// 新的 apply 追平都不动）。落账成功才广播。
	const markCollectionStaleIfNeeded = async (
		workspaceId: string,
		taskId: string,
		projectionLatestTurnNumber: number,
	): Promise<void> => {
		let markedCollection: RuntimeExploratorySessionMapCollection | null = null;
		await mutateExploratorySessionMapState(workspaceId, (state) => {
			const collection = state.mapCollectionsByConversationSessionTaskId[taskId];
			if (collection === undefined || collection.mapStaleReason !== null) {
				return null;
			}
			// 缓存竞态复核：observe 侧「投影领先」判的是最长 30s 的缓存快照；缓存窗口内 agent 刚
			// apply 了覆盖最新 turn 的新集合时（apply 不 bump summary、observer 缓存不失效），必须在
			// 串行写队列内对真实读到的集合重算锚点覆盖——已追平则放弃置位，否则假 stale 只能等
			// 下一次 apply 才清除。
			if (!isExploratorySessionMapProjectionAheadOfCollection(collection, projectionLatestTurnNumber)) {
				return null;
			}
			markedCollection = {
				...collection,
				mapStaleReason: "turn_projection_signature_drift",
				updatedAt: now(),
			};
			return {
				...state,
				mapCollectionsByConversationSessionTaskId: {
					...state.mapCollectionsByConversationSessionTaskId,
					[taskId]: markedCollection,
				},
			};
		}).catch(() => null);
		if (markedCollection !== null) {
			const collection: RuntimeExploratorySessionMapCollection = markedCollection;
			deps.onCollectionUpdated(workspaceId, taskId, collection);
		}
	};

	const fireNudgeIfStillDue = async (
		workspaceId: string,
		taskId: string,
		state: SessionMaintenanceState,
	): Promise<void> => {
		state.quietWindowTimer = null;
		state.quietWindowStartedAtMs = null;
		if (deps.sendMaintenanceNudge === undefined || state.nudgeInFlight) {
			return;
		}
		// 到点复核（计时器排队期间会话可能已翻回 agent 回合 / 被回收 / map 已追平）。
		const service = deps.getClineTaskSessionService(workspaceId);
		if (service === null) {
			return;
		}
		const liveSummary = service.getSummary(taskId) ?? null;
		if (liveSummary === null || !shouldObserveExploratorySessionMapMaintenance(liveSummary)) {
			return;
		}
		if (resolveSessionFacets(liveSummary).turnOwner !== "user") {
			return;
		}
		const messages = await service.loadTaskSessionMessages(taskId).catch(() => null);
		if (messages === null) {
			return;
		}
		const projectionLatestTurnNumber = deriveConversationTurnProjection(messages).entries.length;
		const snapshot = await loadCollectionSnapshot(workspaceId, taskId, state);
		if (!isExploratorySessionMapProjectionAheadOfCollection(snapshot.collection, projectionLatestTurnNumber)) {
			return;
		}
		state.nudgeInFlight = true;
		state.lastNudgeSentAtMs = now();
		try {
			await deps.sendMaintenanceNudge(workspaceId, taskId, EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_TEXT);
		} catch (error) {
			deps.onNudgeFailed?.(error, { workspaceId, conversationSessionTaskId: taskId });
		} finally {
			state.nudgeInFlight = false;
		}
	};

	const observeTaskSessionSummary = (workspaceId: string, summary: RuntimeTaskSessionSummary): void => {
		const sessionKey = buildSessionKey(workspaceId, summary.taskId);
		if (!shouldObserveExploratorySessionMapMaintenance(summary)) {
			// 不再满足观察条件（会话死了 / 模式变了）：清理该会话的计时器与缓存。
			const state = statesBySessionKey.get(sessionKey);
			if (state !== undefined) {
				clearQuietWindow(state);
				statesBySessionKey.delete(sessionKey);
			}
			return;
		}
		const service = deps.getClineTaskSessionService(workspaceId);
		if (service === null) {
			return;
		}
		const state = statesBySessionKey.get(sessionKey) ?? {
			cachedCollection: null,
			quietWindowTimer: null,
			quietWindowStartedAtMs: null,
			lastNudgeSentAtMs: null,
			nudgeInFlight: false,
			lastMessagesSignature: null,
			lastProjectionLatestTurnNumber: null,
		};
		statesBySessionKey.set(sessionKey, state);
		void (async () => {
			// 廉价门控：先取 O(1) 消息投影签名（不克隆）；签名未变 → 投影结果必同，沿用上次
			// 算出的 latestTurnNumber。本观察挂在 ~150ms 的 summary 广播上，每次 observation 都
			// 全量 loadTaskSessionMessages（逐条 cloneMessage）+ derive 会在长会话上形成
			// O(history) 的高频克隆/扫描。签名为 null（服务侧无此会话消息记录）时保守走全量。
			const messagesSignature = service.getTaskSessionMessagesProjectionSignature(summary.taskId);
			let projectionLatestTurnNumber: number;
			if (
				messagesSignature !== null &&
				state.lastMessagesSignature !== null &&
				state.lastProjectionLatestTurnNumber !== null &&
				sameMessagesProjectionSignature(messagesSignature, state.lastMessagesSignature)
			) {
				projectionLatestTurnNumber = state.lastProjectionLatestTurnNumber;
			} else {
				const messages = await service.loadTaskSessionMessages(summary.taskId).catch(() => null);
				if (messages === null) {
					return;
				}
				projectionLatestTurnNumber = deriveConversationTurnProjection(messages).entries.length;
				state.lastMessagesSignature = messagesSignature;
				state.lastProjectionLatestTurnNumber = projectionLatestTurnNumber;
			}
			const snapshot = await loadCollectionSnapshot(workspaceId, summary.taskId, state);
			const projectionIsAhead = isExploratorySessionMapProjectionAheadOfCollection(
				snapshot.collection,
				projectionLatestTurnNumber,
			);
			// stale 落账：集合存在、尚未标 stale、且投影已领先——一次置位，apply 落新集合时自清。
			// projectionLatestTurnNumber 一并传入，供串行写队列内对真实集合复核（缓存竞态防线）。
			if (snapshot.collection !== null && snapshot.collection.mapStaleReason === null && projectionIsAhead) {
				await markCollectionStaleIfNeeded(workspaceId, summary.taskId, projectionLatestTurnNumber);
				// 缓存同步失效，避免下一个 observation 又读回旧 staleReason。
				state.cachedCollection = null;
			}
			// 防抖再维护：投影领先 + 球在用户侧 → 起/续静默窗；其余组合一律清窗
			// （agent 回合中绝不投递——提醒会插进回合正文，污染对话）。
			const ballIsWithUser = resolveSessionFacets(summary).turnOwner === "user";
			if (projectionIsAhead && ballIsWithUser && deps.sendMaintenanceNudge !== undefined) {
				const cooledDown =
					state.lastNudgeSentAtMs === null ||
					now() - state.lastNudgeSentAtMs >= EXPLORATORY_SESSION_MAP_MAINTENANCE_NUDGE_COOLDOWN_MS;
				if (cooledDown && state.quietWindowTimer === null) {
					state.quietWindowStartedAtMs = now();
					state.quietWindowTimer = setTimeoutFn(() => {
						void fireNudgeIfStillDue(workspaceId, summary.taskId, state);
					}, EXPLORATORY_SESSION_MAP_MAINTENANCE_QUIET_WINDOW_MS);
				}
			} else {
				clearQuietWindow(state);
			}
		})();
	};

	return {
		observeTaskSessionSummary,
		forgetWorkspace: (workspaceId: string) => {
			for (const [key, state] of statesBySessionKey) {
				if (key.startsWith(`${workspaceId}::`)) {
					clearQuietWindow(state);
					statesBySessionKey.delete(key);
				}
			}
		},
		dispose: () => {
			for (const state of statesBySessionKey.values()) {
				clearQuietWindow(state);
			}
			statesBySessionKey.clear();
		},
	};
}
