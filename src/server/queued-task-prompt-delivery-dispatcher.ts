// 排队 prompt 的出队引擎：agent 这一轮停下来 → 从该任务的 durable 队列里认领队首（及被合并开关链住的
// 那一串）→ 经既有三 transport 统一发送出口发出去 → 按回执结算。
//
// 「能不能发」的判据全在 src/core/queued-task-prompt-delivery-dispatch-eligibility.ts（纯谓词），
// 「回执 → 去向」全在 src/core/queued-task-prompt-delivery-outcome-routing.ts（纯函数），
// 持久化与并发互斥全在 src/state/queued-task-prompt-delivery-store.ts。本模块只做编排与副作用。
//
// ## 三条触发源，缺一不可
//
//   (a) 停止边沿 —— 主路径。挂在 runtime-state-hub 的 summary 汇聚点上（三 transport 唯一交汇处），
//       且位于「0 客户端提前返回」**之前**：关掉浏览器标签页，队列照样在 agent 停下时排空。
//   (b) 队列被改动之后立刻尝试一次 —— 覆盖「用户在 agent 已经闲着的时候排了一条」。那时根本不存在
//       未来的边沿，只靠 (a) 会永远躺着。语义也对：当前这一轮已经结束了。
//   (c) 60s 兜底 sweep —— 覆盖「阻塞条件自行解除却没有新边沿」（恢复守卫 30 分钟兜底过期、PTY 单飞槽
//       里那条 RVF 投递失败了没开新一轮）以及「别的进程改了队列文件」（CLI 删任务 / 并存实例）。
//
// ## 一轮至多交出一次
//
// 每次真正交给 transport（无论结果）都记下当时的轮次键（incarnation + turnSequence），同一轮内不再出队，
// 直到 agent 开始新的一轮。两个理由：
//   ① 可重试失败（人正在框里打字 → 让位到超时）如果能在 sweep 里立刻重投，就会把人的输入框一次次让位
//      到超时，三次之后把一条完全正常的排队意图判死。等下一轮才是「排队」的语义。
//   ② Cline SDK / ACP 是同步确认的，确认之后 summary 翻成 generating 之前有几十毫秒的空档；没有这条，
//      sweep 或另一条边沿会把第二条也塞进同一轮，破坏用户选定的「一轮一条」。
// 这份记账只在进程内：重启之后所有会话都是新 incarnation，轮次键天然不会撞。
//
// ## 与 RVF 自注入的关系
//
// 队列坐在发送出口**之上**，不改它一个字节。PTY 单飞槽被 RVF 占着时门控 6 让路；剩下的 TOCTOU 窗口里
// 被 RVF 顶掉（superseded_by_later_delivery）归可重试。RVF 那条「一条投递永不排在别人后面」的收敛承诺
// 因此原样成立。队列**不写**注入账本（task-message-injections.json）：那是跨仓契约，其「唯一非终态必然
// 有界收敛」不变量对可以合法等几个小时的排队意图不成立。

import { randomUUID } from "node:crypto";

import type {
	QueuedTaskPromptDeliveryEntry,
	QueuedTaskPromptDispatchBlockReason,
	QueuedTaskPromptInFlightDeliveryCancelResult,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskSessionSummary,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import {
	buildAgentResponseGenerationStopEdgeDedupeKey,
	buildAgentResponseGenerationStopEventIdentity,
	isQueuedTaskPromptDeliveryAwaitingDispatch,
	isQueuedTaskPromptDeliveryClaimStillCurrentForSession,
	resolveQueuedPromptDispatchBlockReason,
} from "../core/queued-task-prompt-delivery-dispatch-eligibility";
import { buildMergedQueuedTaskPromptDeliveryText } from "../core/queued-task-prompt-delivery-merge";
import {
	type QueuedTaskPromptDeliverySettlement,
	routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted,
	routeQueuedTaskPromptDeliveryTerminalOutcome,
} from "../core/queued-task-prompt-delivery-outcome-routing";
import { buildRuntimeQueuedTaskPromptDeliveryProjectionsByTaskId } from "../core/queued-task-prompt-delivery-projection";
import {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	markQueuedTaskPromptDeliveryHandedToTransport,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	releaseQueuedTaskPromptDeliveryClaim,
	settleQueuedTaskPromptDelivery,
} from "../state/queued-task-prompt-delivery-store";
import {
	TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS,
	type TaskChatInputDeliveryOutcome,
	type TaskChatInputDeliveryOutcomeObserver,
} from "../terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";

// 发送出口的 source 标记。带 source 即被统一发送出口判为「后台自动注入」（deferWhileUserTurn=true），
// 于是 agent 停在模态待答时 PTY 侧会让位——这是门控 3 之外的**第二道**保险。
export const QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE = "kanban_prompt_queue";

export const QUEUED_TASK_PROMPT_DELIVERY_FALLBACK_SWEEP_INTERVAL_MS = 60_000;

// PTY 回执的等待上限：契约保证的最坏收敛预算 + 余量。超过它还没回执，说明内存登记已经丢了
// （换代竞态 / teardown 漏报）——按「语义暧昧」落终态交给人，绝不无限挂着把整条队列堵死。
const PROGRAMMATIC_TERMINAL_DELIVERY_OUTCOME_WAIT_MARGIN_MS = 30_000;

// 会话状态变化导致阻塞原因变化时重发投影的去抖窗口：agent 回合期间 summary 以 50ms 攒批刷新。
const PROJECTION_REBROADCAST_DEBOUNCE_MS = 150;

export interface QueuedTaskPromptDeliveryDispatcherDependencies {
	// 三 transport 合并后的会话摘要（runtime-server 的 findRuntimeSessionSummary）。
	getTaskSessionSummary: (workspaceId: string, taskId: string) => RuntimeTaskSessionSummary | null;
	// 仅 PTY 有意义；没有终端会话的 task 恒返回 false。
	hasPendingProgrammaticTaskChatInputDelivery: (workspaceId: string, taskId: string) => boolean;
	resolveWorkspaceScope: (workspaceId: string) => RuntimeTrpcWorkspaceScope | null;
	// 既有三 transport 统一发送出口。observer 只在 PTY 分支返回 accepted_pending_submit_confirmation 时
	// 才会被调用，且恰好一次。
	sendThroughTaskChatTransports: (
		scope: RuntimeTrpcWorkspaceScope,
		request: RuntimeTaskChatSendRequest,
		onProgrammaticTerminalDeliverySettled: TaskChatInputDeliveryOutcomeObserver,
	) => Promise<RuntimeTaskChatSendResponse>;
	// 既有 cancelTaskChatDelivery（PTY 单飞槽的取消）。
	cancelProgrammaticTerminalDelivery: (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		idempotencyKey: string,
	) => Promise<QueuedTaskPromptInFlightDeliveryCancelResult>;
	// prompt library 每条条目此刻正文的 sha256；读不到返回 null。
	readPromptLibraryEntryTextSha256ByEntryId: (workspaceId: string) => Promise<ReadonlyMap<string, string> | null>;
	onProjectedQueueChanged: (
		workspaceId: string,
		projectedEntriesByTaskId: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
	) => void;
	now?: () => number;
	createDispatchIdempotencyKey?: () => string;
	fallbackSweepIntervalMs?: number;
	programmaticTerminalDeliveryOutcomeWaitBudgetMs?: number;
	warn?: (message: string) => void;
}

export interface QueuedTaskPromptDeliveryDispatcher {
	// 触发源 (a)：由 runtime-state-hub 在 summary 汇聚点上逐条喂入。
	observeTaskSessionSummary(workspaceId: string, summary: RuntimeTaskSessionSummary): void;
	// 触发源 (b)：队列被 API 改过之后调用。刷新缓存、重发投影、并对该 task 尝试一次出队。
	notifyQueueMutated(
		workspaceId: string,
		taskId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): Promise<void>;
	// 队列文件被旁路改过（任务离开看板时整条丢弃）之后调用。只刷新缓存与投影，不出队。
	notifyQueueRewrittenOutsideDispatcher(
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): Promise<void>;
	// 取消一条**已经交给 transport** 的条目。不是 handed_to_transport 的返回 null（由 store 的 cancel 意图处理）。
	cancelInFlightQueuedPromptDelivery(
		workspaceId: string,
		taskId: string,
		queueEntryId: string,
	): Promise<QueuedTaskPromptInFlightDeliveryCancelResult | null>;
	buildProjectedEntriesByTaskId(
		workspaceId: string,
		snapshot?: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): Promise<RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId>;
	requestDispatchAttempt(workspaceId: string, taskId: string): void;
	runFallbackSweep(): Promise<void>;
	forgetWorkspace(workspaceId: string): void;
	start(): void;
	stop(): void;
	// 测试用：等所有已排上的出队尝试与投影广播落定。
	whenIdle(): Promise<void>;
}

function buildTaskKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}::${taskId}`;
}

function listAwaitingDispatchEntries(
	snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	taskId: string,
	nowEpochMs: number,
): QueuedTaskPromptDeliveryEntry[] {
	return (snapshot.entriesByTaskId[taskId] ?? []).filter((entry) =>
		isQueuedTaskPromptDeliveryAwaitingDispatch(entry, nowEpochMs),
	);
}

export function createQueuedTaskPromptDeliveryDispatcher(
	deps: QueuedTaskPromptDeliveryDispatcherDependencies,
): QueuedTaskPromptDeliveryDispatcher {
	const now = deps.now ?? (() => Date.now());
	const createDispatchIdempotencyKey =
		deps.createDispatchIdempotencyKey ?? (() => `kanban-prompt-queue:${randomUUID()}`);
	const fallbackSweepIntervalMs =
		deps.fallbackSweepIntervalMs ?? QUEUED_TASK_PROMPT_DELIVERY_FALLBACK_SWEEP_INTERVAL_MS;
	const programmaticTerminalDeliveryOutcomeWaitBudgetMs =
		deps.programmaticTerminalDeliveryOutcomeWaitBudgetMs ??
		TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS + PROGRAMMATIC_TERMINAL_DELIVERY_OUTCOME_WAIT_MARGIN_MS;
	const warn = deps.warn ?? (() => {});

	const knownWorkspaceIds = new Set<string>();
	const cachedSnapshotByWorkspaceId = new Map<string, WorkspaceQueuedTaskPromptDeliverySnapshot>();
	const snapshotLoadByWorkspaceId = new Map<string, Promise<WorkspaceQueuedTaskPromptDeliverySnapshot>>();
	const previousStopEventIdentityByTaskKey = new Map<string, string | null>();
	const handedOffAtTurnKeyByTaskKey = new Map<string, string>();
	const inFlightAttemptByTaskKey = new Map<string, Promise<void>>();
	const rerunRequestedTaskKeys = new Set<string>();
	const lastObservedHeadBlockReasonByTaskKey = new Map<string, QueuedTaskPromptDispatchBlockReason | null>();
	const lastBroadcastProjectionFingerprintByWorkspaceId = new Map<string, string>();
	const projectionRebroadcastTimerByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const pendingOperations = new Set<Promise<unknown>>();
	let fallbackSweepTimer: NodeJS.Timeout | null = null;
	let stopped = false;

	const track = <T>(operation: Promise<T>): Promise<T> => {
		pendingOperations.add(operation);
		void operation
			.catch(() => undefined)
			.finally(() => {
				pendingOperations.delete(operation);
			});
		return operation;
	};

	const rememberSnapshot = (workspaceId: string, snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot): void => {
		knownWorkspaceIds.add(workspaceId);
		cachedSnapshotByWorkspaceId.set(workspaceId, snapshot);
	};

	// 单飞读取：一次 runtime 启动会水合几百个会话，每个都会喂一条 summary 进来；缓存没建好之前
	// 让它们共用同一次文件读，而不是各读一遍。
	const loadSnapshot = async (workspaceId: string): Promise<WorkspaceQueuedTaskPromptDeliverySnapshot> => {
		const cached = cachedSnapshotByWorkspaceId.get(workspaceId);
		if (cached) {
			return cached;
		}
		const inFlight = snapshotLoadByWorkspaceId.get(workspaceId);
		if (inFlight) {
			return await inFlight;
		}
		const load = readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId).finally(() => {
			snapshotLoadByWorkspaceId.delete(workspaceId);
		});
		snapshotLoadByWorkspaceId.set(workspaceId, load);
		const snapshot = await load;
		rememberSnapshot(workspaceId, snapshot);
		return snapshot;
	};

	const resolveBlockReasonForEntry = (
		workspaceId: string,
		entry: QueuedTaskPromptDeliveryEntry,
		summary: RuntimeTaskSessionSummary | null,
	): QueuedTaskPromptDispatchBlockReason | null =>
		resolveQueuedPromptDispatchBlockReason({
			headEntry: entry,
			sessionSummary: summary,
			hasPendingProgrammaticTaskChatInputDelivery: deps.hasPendingProgrammaticTaskChatInputDelivery(
				workspaceId,
				entry.taskId,
			),
			nowEpochMs: now(),
		});

	const buildProjectedEntriesByTaskId = async (
		workspaceId: string,
		snapshotOverride?: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): Promise<RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId> => {
		const snapshot = snapshotOverride ?? (await loadSnapshot(workspaceId));
		let promptLibraryShaByEntryId: ReadonlyMap<string, string> | null = null;
		try {
			promptLibraryShaByEntryId = await deps.readPromptLibraryEntryTextSha256ByEntryId(workspaceId);
		} catch {
			// 读不到库只影响「来源条目改过没有」这一个提示，退化成「不知道」。
		}
		return buildRuntimeQueuedTaskPromptDeliveryProjectionsByTaskId({
			snapshot,
			resolveDispatchBlockReasonForQueuedEntry: (entry) =>
				resolveBlockReasonForEntry(workspaceId, entry, deps.getTaskSessionSummary(workspaceId, entry.taskId)),
			currentPromptLibraryEntryTextSha256ByEntryId: promptLibraryShaByEntryId,
			nowEpochMs: now(),
		});
	};

	// 投影没变就不发：会话状态的每一次 50ms 刷新都走到这里，绝大多数时候什么都没变。
	const broadcastProjectionIfChanged = async (workspaceId: string): Promise<void> => {
		const projected = await buildProjectedEntriesByTaskId(workspaceId);
		const fingerprint = JSON.stringify(projected);
		if (lastBroadcastProjectionFingerprintByWorkspaceId.get(workspaceId) === fingerprint) {
			return;
		}
		lastBroadcastProjectionFingerprintByWorkspaceId.set(workspaceId, fingerprint);
		deps.onProjectedQueueChanged(workspaceId, projected);
	};

	const scheduleProjectionRebroadcast = (workspaceId: string): void => {
		if (stopped || projectionRebroadcastTimerByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			projectionRebroadcastTimerByWorkspaceId.delete(workspaceId);
			void track(broadcastProjectionIfChanged(workspaceId)).catch((error: unknown) => {
				warn(`[queued-prompt] projection-broadcast-failed workspaceId=${workspaceId} reason=${String(error)}`);
			});
		}, PROJECTION_REBROADCAST_DEBOUNCE_MS);
		timer.unref?.();
		projectionRebroadcastTimerByWorkspaceId.set(workspaceId, timer);
	};

	const commitSnapshotAndBroadcast = async (
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): Promise<void> => {
		rememberSnapshot(workspaceId, snapshot);
		await broadcastProjectionIfChanged(workspaceId);
	};

	// 等 PTY 回执落定。PTY 分支同步只返回 accepted_pending_submit_confirmation，真实终态只经 observer 回来。
	const createProgrammaticTerminalDeliveryOutcomeWaiter = () => {
		let resolveOutcome: (outcome: TaskChatInputDeliveryOutcome | null) => void = () => {};
		const outcome = new Promise<TaskChatInputDeliveryOutcome | null>((resolve) => {
			resolveOutcome = resolve;
		});
		return {
			observer: ((settledOutcome) => {
				resolveOutcome(settledOutcome);
			}) satisfies TaskChatInputDeliveryOutcomeObserver,
			waitWithinBudget: async (): Promise<TaskChatInputDeliveryOutcome | null> => {
				let budgetTimer: NodeJS.Timeout | null = null;
				const budgetExhausted = new Promise<null>((resolve) => {
					budgetTimer = setTimeout(() => resolve(null), programmaticTerminalDeliveryOutcomeWaitBudgetMs);
					budgetTimer.unref?.();
				});
				try {
					return await Promise.race([outcome, budgetExhausted]);
				} finally {
					if (budgetTimer !== null) {
						clearTimeout(budgetTimer);
					}
				}
			},
		};
	};

	const settleHandedOffRun = async (
		workspaceId: string,
		taskId: string,
		queueEntryIds: readonly string[],
		settlement: QueuedTaskPromptDeliverySettlement,
	): Promise<void> => {
		const snapshot = await settleQueuedTaskPromptDelivery({
			workspaceId,
			taskId,
			queueEntryIds,
			settlement,
			nowEpochMs: now(),
		});
		await commitSnapshotAndBroadcast(workspaceId, snapshot);
	};

	const runDispatchAttempt = async (workspaceId: string, taskId: string): Promise<void> => {
		const taskKey = buildTaskKey(workspaceId, taskId);
		const snapshot = await loadSnapshot(workspaceId);
		const awaitingEntries = listAwaitingDispatchEntries(snapshot, taskId, now());
		if (awaitingEntries.length === 0) {
			return;
		}
		const summary = deps.getTaskSessionSummary(workspaceId, taskId);
		const turnKey = buildAgentResponseGenerationStopEdgeDedupeKey(summary);
		if (summary === null || turnKey === null) {
			return;
		}
		// 一轮至多交出一次（见文件头）。
		if (handedOffAtTurnKeyByTaskKey.get(taskKey) === turnKey) {
			return;
		}
		// 锁外的廉价预判：绝大多数触发都会在这里被挡下（agent 还在干活），不值得为它抢文件锁。
		if (resolveBlockReasonForEntry(workspaceId, awaitingEntries[0], summary) !== null) {
			return;
		}
		const sessionIncarnationId = summary.runtimeSessionIncarnationId;
		if (sessionIncarnationId == null) {
			return;
		}

		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId,
			taskId,
			sessionIncarnationId,
			turnSequence: summary.agentResponseGenerationTurnSequence ?? 0,
			nowEpochMs: now(),
		});
		if (claimed === null) {
			return;
		}
		await commitSnapshotAndBroadcast(workspaceId, claimed.snapshot);
		const claimedQueueEntryIds = claimed.claimedEntries.map((entry) => entry.queueEntryId);
		const claimedHead = claimed.claimedEntries[0];

		// 认领之后、send 之前的陈旧复核：重读 summary，认领说的还是不是这个活体的这一轮、门控是否仍放行。
		const summaryAtSend = deps.getTaskSessionSummary(workspaceId, taskId);
		const scope = deps.resolveWorkspaceScope(workspaceId);
		if (
			scope === null ||
			!isQueuedTaskPromptDeliveryClaimStillCurrentForSession(claimedHead, summaryAtSend) ||
			resolveBlockReasonForEntry(workspaceId, claimedHead, summaryAtSend) !== null
		) {
			const released = await releaseQueuedTaskPromptDeliveryClaim({
				workspaceId,
				taskId,
				queueEntryIds: claimedQueueEntryIds,
				nowEpochMs: now(),
			});
			await commitSnapshotAndBroadcast(workspaceId, released);
			return;
		}

		const dispatchIdempotencyKey = createDispatchIdempotencyKey();
		const handedOff = await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId,
			taskId,
			queueEntryIds: claimedQueueEntryIds,
			dispatchIdempotencyKey,
			nowEpochMs: now(),
		});
		await commitSnapshotAndBroadcast(workspaceId, handedOff);
		// 写盘后复核：认领与交付之间，用户可能取消了其中一条，或并存实例的启动清扫把它释放了。
		// 此时 mark 只会动那些仍是 claimed 的条目——发出去的正文就会与队列里记着的对不上。整串放弃，
		// 仍被本次标成 handed_to_transport 的那几条按「确定没发」回队首（不计入尝试预算之外的任何东西）。
		const handedOffEntries = (handedOff.entriesByTaskId[taskId] ?? []).filter(
			(entry) =>
				claimedQueueEntryIds.includes(entry.queueEntryId) &&
				entry.deliveryState === "handed_to_transport" &&
				entry.dispatchIdempotencyKey === dispatchIdempotencyKey,
		);
		if (handedOffEntries.length !== claimedQueueEntryIds.length) {
			if (handedOffEntries.length > 0) {
				await settleHandedOffRun(
					workspaceId,
					taskId,
					handedOffEntries.map((entry) => entry.queueEntryId),
					{
						outcome: "retryable_failure",
						failureNote: "Part of this merged message changed just before sending, so nothing was sent.",
					},
				);
			}
			return;
		}

		handedOffAtTurnKeyByTaskKey.set(taskKey, turnKey);
		const waiter = createProgrammaticTerminalDeliveryOutcomeWaiter();
		let response: RuntimeTaskChatSendResponse;
		try {
			response = await deps.sendThroughTaskChatTransports(
				scope,
				{
					taskId,
					text: buildMergedQueuedTaskPromptDeliveryText(claimed.claimedEntries),
					source: QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE,
					idempotencyKey: dispatchIdempotencyKey,
				},
				waiter.observer,
			);
		} catch (error) {
			// 统一出口自己兜住了异常并返回 ok:false；能走到这里说明是出口之外的东西抛了（例：依赖注入的包装层）。
			// 不知道字节有没有出去 ⇒ 交给人。
			await settleHandedOffRun(workspaceId, taskId, claimedQueueEntryIds, {
				outcome: "terminal_failure",
				failureNote: `Sending the queued prompt failed unexpectedly: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
			return;
		}

		const terminalDelivery = response.terminalDelivery ?? null;
		if (terminalDelivery === null) {
			await settleHandedOffRun(
				workspaceId,
				taskId,
				claimedQueueEntryIds,
				response.ok
					? { outcome: "delivered", failureNote: null }
					: routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted(response.error),
			);
			return;
		}
		if (terminalDelivery.status !== "accepted_pending_submit_confirmation") {
			await settleHandedOffRun(
				workspaceId,
				taskId,
				claimedQueueEntryIds,
				routeQueuedTaskPromptDeliveryTerminalOutcome(terminalDelivery),
			);
			return;
		}
		const settledOutcome = await waiter.waitWithinBudget();
		await settleHandedOffRun(
			workspaceId,
			taskId,
			claimedQueueEntryIds,
			settledOutcome === null
				? {
						outcome: "terminal_failure",
						failureNote:
							"No delivery confirmation arrived within the settlement budget, so the prompt may or may not have been sent.",
					}
				: routeQueuedTaskPromptDeliveryTerminalOutcome(settledOutcome),
		);
	};

	// 每个 task 同一时刻至多一次尝试在跑（内存互斥，与 store 的 durable 认领互斥并联——后者拦得住第二个
	// runtime，拦不住同进程重入时的重复读写）。在跑期间来的请求折叠成「跑完再来一次」。
	const requestDispatchAttempt = (workspaceId: string, taskId: string): void => {
		if (stopped) {
			return;
		}
		knownWorkspaceIds.add(workspaceId);
		const taskKey = buildTaskKey(workspaceId, taskId);
		if (inFlightAttemptByTaskKey.has(taskKey)) {
			rerunRequestedTaskKeys.add(taskKey);
			return;
		}
		const attempt = (async () => {
			try {
				do {
					rerunRequestedTaskKeys.delete(taskKey);
					try {
						await runDispatchAttempt(workspaceId, taskId);
					} catch (error) {
						warn(
							`[queued-prompt] dispatch-attempt-failed workspaceId=${workspaceId} taskId=${taskId} reason=${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				} while (rerunRequestedTaskKeys.has(taskKey) && !stopped);
			} finally {
				inFlightAttemptByTaskKey.delete(taskKey);
			}
		})();
		inFlightAttemptByTaskKey.set(taskKey, attempt);
		void track(attempt);
	};

	const observeTaskSessionSummary = (workspaceId: string, summary: RuntimeTaskSessionSummary): void => {
		if (stopped) {
			return;
		}
		knownWorkspaceIds.add(workspaceId);
		const taskKey = buildTaskKey(workspaceId, summary.taskId);
		const stopEventIdentity = buildAgentResponseGenerationStopEventIdentity(summary);
		const previousStopEventIdentity = previousStopEventIdentityByTaskKey.get(taskKey) ?? null;
		previousStopEventIdentityByTaskKey.set(taskKey, stopEventIdentity);
		if (stopEventIdentity !== null && stopEventIdentity !== previousStopEventIdentity) {
			requestDispatchAttempt(workspaceId, summary.taskId);
		}
		// 阻塞原因跟着会话状态变（agent 开工 / 停下 / 开始问问题），面板上那一行「为什么还没发」得跟上。
		// 只在该 task 真有等发条目、且队首的阻塞原因确实变了的时候才重发投影。
		const cached = cachedSnapshotByWorkspaceId.get(workspaceId);
		if (!cached) {
			return;
		}
		const head = listAwaitingDispatchEntries(cached, summary.taskId, now())[0];
		if (!head) {
			lastObservedHeadBlockReasonByTaskKey.delete(taskKey);
			return;
		}
		const headBlockReason = resolveBlockReasonForEntry(workspaceId, head, summary);
		if (lastObservedHeadBlockReasonByTaskKey.get(taskKey) !== headBlockReason) {
			lastObservedHeadBlockReasonByTaskKey.set(taskKey, headBlockReason);
			scheduleProjectionRebroadcast(workspaceId);
		}
	};

	const runFallbackSweep = async (): Promise<void> => {
		for (const workspaceId of knownWorkspaceIds) {
			if (stopped) {
				return;
			}
			try {
				// 绕过缓存重读：兜底 sweep 的另一半职责就是捡回别的进程对队列文件的改动。
				const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId);
				await commitSnapshotAndBroadcast(workspaceId, snapshot);
				for (const taskId of Object.keys(snapshot.entriesByTaskId)) {
					if (listAwaitingDispatchEntries(snapshot, taskId, now()).length > 0) {
						requestDispatchAttempt(workspaceId, taskId);
					}
				}
			} catch (error) {
				warn(
					`[queued-prompt] fallback-sweep-failed workspaceId=${workspaceId} reason=${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};

	return {
		observeTaskSessionSummary,
		notifyQueueMutated: async (workspaceId, taskId, snapshot) => {
			await commitSnapshotAndBroadcast(workspaceId, snapshot);
			requestDispatchAttempt(workspaceId, taskId);
		},
		notifyQueueRewrittenOutsideDispatcher: async (workspaceId, snapshot) => {
			await commitSnapshotAndBroadcast(workspaceId, snapshot);
		},
		cancelInFlightQueuedPromptDelivery: async (workspaceId, taskId, queueEntryId) => {
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId);
			rememberSnapshot(workspaceId, snapshot);
			const entry = (snapshot.entriesByTaskId[taskId] ?? []).find(
				(candidate) => candidate.queueEntryId === queueEntryId,
			);
			if (entry?.deliveryState !== "handed_to_transport" || entry.dispatchIdempotencyKey === null) {
				return null;
			}
			const scope = deps.resolveWorkspaceScope(workspaceId);
			if (scope === null) {
				return "no_pending_delivery";
			}
			// 拦下时 PTY 侧会经本次投递登记的 observer 回报 delivery_failed{cancelled_before_delivery}，
			// 结算（→ cancelled）走的是投递那条既有路径，这里不重复写。合并串里的其余条目共用同一个 key，
			// 一起被取消——它们本来就是同一条消息。
			return await deps.cancelProgrammaticTerminalDelivery(scope, taskId, entry.dispatchIdempotencyKey);
		},
		buildProjectedEntriesByTaskId,
		requestDispatchAttempt,
		runFallbackSweep,
		forgetWorkspace: (workspaceId) => {
			knownWorkspaceIds.delete(workspaceId);
			cachedSnapshotByWorkspaceId.delete(workspaceId);
			lastBroadcastProjectionFingerprintByWorkspaceId.delete(workspaceId);
			const timer = projectionRebroadcastTimerByWorkspaceId.get(workspaceId);
			if (timer) {
				clearTimeout(timer);
				projectionRebroadcastTimerByWorkspaceId.delete(workspaceId);
			}
			const prefix = `${workspaceId}::`;
			for (const map of [previousStopEventIdentityByTaskKey, lastObservedHeadBlockReasonByTaskKey]) {
				for (const key of map.keys()) {
					if (key.startsWith(prefix)) {
						map.delete(key);
					}
				}
			}
		},
		start: () => {
			if (fallbackSweepTimer !== null || stopped) {
				return;
			}
			fallbackSweepTimer = setInterval(() => {
				void track(runFallbackSweep());
			}, fallbackSweepIntervalMs);
			fallbackSweepTimer.unref?.();
		},
		stop: () => {
			stopped = true;
			if (fallbackSweepTimer !== null) {
				clearInterval(fallbackSweepTimer);
				fallbackSweepTimer = null;
			}
			for (const timer of projectionRebroadcastTimerByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			projectionRebroadcastTimerByWorkspaceId.clear();
		},
		whenIdle: async () => {
			while (pendingOperations.size > 0 || projectionRebroadcastTimerByWorkspaceId.size > 0) {
				if (pendingOperations.size > 0) {
					await Promise.allSettled([...pendingOperations]);
				} else {
					await new Promise((resolve) => setTimeout(resolve, PROJECTION_REBROADCAST_DEBOUNCE_MS + 10));
				}
			}
		},
	};
}
