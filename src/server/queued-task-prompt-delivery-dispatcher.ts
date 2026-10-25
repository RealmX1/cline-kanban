import {
	isNativeIndependentUserTurnSubmissionKnownNotStarted,
	resolveNativeIndependentUserTurnQueryRetryNotBeforeEpochMs,
} from "../core/queued-task-prompt-native-independent-user-turn-query-recovery";
import type { TaskChatDeliveryWriteValidator } from "../core/task-chat-delivery-write-validation";
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
// ## 重启盖章是持续屏障，不是启动时的一次性动作
//
// 启动清扫只在进程起来那一刻看一眼心跳。上一个实例崩溃（或整机快速重启）后心跳文件还新鲜，要等满宽限期
// 才判死——新实例若在这 2 分钟内起来，启动清扫会以为旧托管者还活着而跳过盖章，之后就再也没人盖了，
// 旧 prompt 会在下一次恢复会话后不经提醒直接发出。所以：
//   - 每次尝试出队前，队首条目的托管者若不是本实例，先重读心跳、把托管者已死的条目盖章并接管；
//   - 60s 兜底 sweep 对每个 workspace 做同一件事；
//   - 托管者仍活着的条目由门控 -1（queued_under_another_live_kanban_runtime_instance）挡住：只有托管者发它。
//
// ## 与 RVF 自注入的关系
//
// 队列坐在发送出口**之上**，不改它一个字节。PTY 单飞槽被 RVF 占着时门控 6 让路；剩下的 TOCTOU 窗口里
// 被 RVF 顶掉（superseded_by_later_delivery）归可重试。RVF 那条「一条投递永不排在别人后面」的收敛承诺
// 因此原样成立。人排的条目**不写**注入账本（task-message-injections.json）：那是跨仓契约，其「唯一非终态
// 必然有界收敛」不变量对可以合法等几个小时、又没有截止时刻的排队意图不成立。
//
// ## 程序化条目（`kanban task message --deliver-when-agent-idle`）
//
// RVF 也可以把一条投递排进来，等 agent 空闲再交出。它与人排的条目走同一套门控与触发源，只差四处：
//   - 交给终端投递时用**调用方的** idempotency key 与 source：交出之后的取消、账本回写与不带 flag 的
//     `kanban task message` 逐字相同；
//   - 回执一次定终身，绝不回队首（store 的 settleQueuedTaskPromptDelivery 执行）；每个落定点都把真实终端回执
//     随结算带进 store，由 store 镜像进账本；
//   - 截止时刻（expiresAt）由精确定时器执行写盘收敛，账本回执不必等 60s sweep；
//   - 兜底 sweep 额外对一次账：已落定的程序化条目，账本却还 pending 的，补写。

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
	NativeIndependentUserTurnDeliveryError,
	readCurrentTuiNativeConversationTurns,
} from "../rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import { reconcileManagedTaskPromptDeliveryReceipts } from "../state/managed-task-prompt-delivery-coordinator";
import { reconcileInjectionLedgerWithSettledProgrammaticInjections } from "../state/mirror-queued-programmatic-injection-outcomes-into-injection-ledger";
import {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	isQueuedTaskPromptDeliveryProgrammaticInjection,
	markQueuedTaskPromptDeliveryHandedToTransport,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	releaseQueuedTaskPromptDeliveryClaim,
	settleExpiredQueuedTaskPromptDeliveries,
	settleQueuedTaskPromptDelivery,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
} from "../state/queued-task-prompt-delivery-store";
import { updateQueuedTaskPromptNativeIndependentUserTurnQueryRecovery } from "../state/queued-task-prompt-native-independent-user-turn-query-recovery";
import {
	TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS,
	type TaskChatInputDeliveryOutcome,
	type TaskChatInputDeliveryOutcomeObserver,
} from "../terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { createNativeIndependentUserTurnBeforeSubmissionValidator } from "./native-independent-user-turn-before-submission-validator";

// 发送出口的 source 标记。带 source 即被统一发送出口判为「后台自动注入」（deferWhileUserTurn=true），
// 于是 agent 停在模态待答时 PTY 侧会让位——这是门控 3 之外的**第二道**保险。
export const QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE = "kanban_prompt_queue";

export const QUEUED_TASK_PROMPT_DELIVERY_FALLBACK_SWEEP_INTERVAL_MS = 60_000;

// PTY 回执的等待上限：契约保证的最坏收敛预算 + 余量。超过它还没回执，说明内存登记已经丢了
// （换代竞态 / teardown 漏报）——按「语义暧昧」落终态交给人，绝不无限挂着把整条队列堵死。
const PROGRAMMATIC_TERMINAL_DELIVERY_OUTCOME_WAIT_MARGIN_MS = 30_000;

// 会话状态变化导致阻塞原因变化时重发投影的去抖窗口：agent 回合期间 summary 以 50ms 攒批刷新。
const PROJECTION_REBROADCAST_DEBOUNCE_MS = 150;

// 程序化条目截止定时器在截止时刻之后再多等这一点才去收敛：过期判据是 `now >= expiresAt`，定时器偶尔会早到
// 一两毫秒，早到的那一次什么都收敛不了、又不会再有下一次。
const PROGRAMMATIC_INJECTION_DEADLINE_SETTLEMENT_MARGIN_MS = 25;

// 「交出去了，但不知道有没有送到」时写进账本的原因。两处走得到：出口之外的包装层抛错（出口自己兜住一切
// 异常，实际走不到）、PTY 在最坏预算 + 余量之后仍没回执（内存登记丢了）。契约里没有一个原因的字面恰好是
// 「不知道」；选它是因为它的处置——「谨慎：文本可能残留，重投前宜人工确认」——正是此时调用方该做的事，
// 而任何「确定没送到」的原因都会诱导调用方立刻重投、把同一段话送两遍。
const INJECTION_LEDGER_RECEIPT_WHEN_DELIVERY_OUTCOME_IS_UNKNOWN = {
	status: "delivery_failed",
	reason: "submit_confirmation_budget_exhausted",
} as const;

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
		injectionLedgerTaskId?: string,
		validateBeforeTerminalWrite?: TaskChatDeliveryWriteValidator,
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
	readNativeConversationTurns?: typeof readCurrentTuiNativeConversationTurns;
	nativeTurnCompletionPollIntervalMs?: number;
	now?: () => number;
	createDispatchIdempotencyKey?: () => string;
	fallbackSweepIntervalMs?: number;
	programmaticTerminalDeliveryOutcomeWaitBudgetMs?: number;
	warn?: (message: string) => void;
	// 本实例的进程身份与活性来源（见 runtime-process-instance-heartbeat-registry.ts）。三者齐备才启用托管门与
	// 持续盖章屏障；缺省（单测）时两者都不启用。
	runtimeProcessInstanceCustody?: {
		thisRuntimeProcessInstanceId: string;
		runtimeProcessStartedAtEpochMs: number;
		readLiveRuntimeProcessInstanceIds: () => Promise<ReadonlySet<string>>;
	};
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
	const custody = deps.runtimeProcessInstanceCustody ?? null;

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
	const programmaticInjectionDeadlineTimerByWorkspaceId = new Map<
		string,
		{ timer: NodeJS.Timeout; firesForDeadlineAtEpochMs: number }
	>();
	const nativeTurnPollTimerByTaskKey = new Map<string, NodeJS.Timeout>();
	const pendingOperations = new Set<Promise<unknown>>();
	let fallbackSweepTimer: NodeJS.Timeout | null = null;
	let stopped = false;
	let resolveStopped: () => void = () => {};
	const whenStopped = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});

	const track = <T>(operation: Promise<T>): Promise<T> => {
		pendingOperations.add(operation);
		void operation
			.catch(() => undefined)
			.finally(() => {
				pendingOperations.delete(operation);
			});
		return operation;
	};

	const clearProgrammaticInjectionDeadlineTimer = (workspaceId: string): void => {
		const armed = programmaticInjectionDeadlineTimerByWorkspaceId.get(workspaceId);
		if (armed) {
			clearTimeout(armed.timer);
			programmaticInjectionDeadlineTimerByWorkspaceId.delete(workspaceId);
		}
	};

	// 每个 workspace 一个定时器，对准「还在等空闲的程序化条目里最早的截止时刻」。到点写盘收敛成 expired，
	// store 随即把 agent_never_became_idle_before_queued_delivery_deadline 镜像进账本——调用方给的上限因此是
	// 毫秒级兑现，而不是「上限 + 至多 60s」。人排的条目不进这里：它们过期不需要回执，投影就地显示即可。
	const armProgrammaticInjectionDeadlineTimer = (
		workspaceId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	): void => {
		if (stopped) {
			return;
		}
		let earliestDeadlineAtEpochMs: number | null = null;
		for (const entries of Object.values(snapshot.entriesByTaskId)) {
			for (const entry of entries) {
				if (entry.deliveryState === "queued" && isQueuedTaskPromptDeliveryProgrammaticInjection(entry)) {
					earliestDeadlineAtEpochMs =
						earliestDeadlineAtEpochMs === null
							? entry.expiresAt
							: Math.min(earliestDeadlineAtEpochMs, entry.expiresAt);
				}
			}
		}
		const armed = programmaticInjectionDeadlineTimerByWorkspaceId.get(workspaceId);
		if (earliestDeadlineAtEpochMs === null) {
			clearProgrammaticInjectionDeadlineTimer(workspaceId);
			return;
		}
		if (armed?.firesForDeadlineAtEpochMs === earliestDeadlineAtEpochMs) {
			return;
		}
		clearProgrammaticInjectionDeadlineTimer(workspaceId);
		const timer = setTimeout(
			() => {
				programmaticInjectionDeadlineTimerByWorkspaceId.delete(workspaceId);
				void track(
					(async () => {
						const settled = await settleExpiredQueuedTaskPromptDeliveries({ workspaceId, nowEpochMs: now() });
						await commitSnapshotAndBroadcast(workspaceId, settled);
					})(),
				).catch((error: unknown) => {
					warn(
						`[queued-prompt] programmatic-deadline-settlement-failed workspaceId=${workspaceId} reason=${String(error)}`,
					);
				});
			},
			Math.max(0, earliestDeadlineAtEpochMs - now()) + PROGRAMMATIC_INJECTION_DEADLINE_SETTLEMENT_MARGIN_MS,
		);
		timer.unref?.();
		programmaticInjectionDeadlineTimerByWorkspaceId.set(workspaceId, {
			timer,
			firesForDeadlineAtEpochMs: earliestDeadlineAtEpochMs,
		});
	};

	const rememberSnapshot = (workspaceId: string, snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot): void => {
		knownWorkspaceIds.add(workspaceId);
		cachedSnapshotByWorkspaceId.set(workspaceId, snapshot);
		armProgrammaticInjectionDeadlineTimer(workspaceId, snapshot);
		if (stopped) return;
		for (const [taskId, entries] of Object.entries(snapshot.entriesByTaskId)) {
			const head = entries.find((entry) => isQueuedTaskPromptDeliveryAwaitingDispatch(entry, now()));
			const retryAt = head ? resolveNativeIndependentUserTurnQueryRetryNotBeforeEpochMs(head) : null;
			if (
				retryAt == null ||
				head?.deliveryState !== "queued" ||
				(custody && head.custodianRuntimeProcessInstanceId !== custody.thisRuntimeProcessInstanceId)
			)
				continue;
			const key = buildTaskKey(workspaceId, taskId);
			const priorTimer = nativeTurnPollTimerByTaskKey.get(key);
			if (priorTimer) clearTimeout(priorTimer);
			const timer = setTimeout(
				() => {
					nativeTurnPollTimerByTaskKey.delete(key);
					requestDispatchAttempt(workspaceId, taskId);
				},
				Math.max(1, retryAt - now()),
			);
			timer.unref?.();
			nativeTurnPollTimerByTaskKey.set(key, timer);
		}
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
			thisRuntimeProcessInstanceId: custody?.thisRuntimeProcessInstanceId ?? null,
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

	// 持续盖章屏障（见文件头「重启盖章是持续屏障」）：重读心跳，给托管者已不在的非终态条目盖 restart-crossing
	// 章并把托管权交给本实例。本实例自己恒算活着——自己的心跳续期失败不该让自己排的队被当成重启残骸。
	const stampEntriesWhoseCustodianIsGone = async (workspaceId: string): Promise<void> => {
		if (custody === null) {
			return;
		}
		let liveRuntimeProcessInstanceIds: ReadonlySet<string>;
		let custodianLivenessObservationAvailable = true;
		try {
			liveRuntimeProcessInstanceIds = await custody.readLiveRuntimeProcessInstanceIds();
		} catch {
			// 读不到心跳按「谁都不活」：多盖章 = 多让人确认一次（安全），漏盖 = 重启后不提醒直接发（事故）。
			liveRuntimeProcessInstanceIds = new Set();
			custodianLivenessObservationAvailable = false;
		}
		const stamped = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId,
			runtimeProcessStartedAtEpochMs: custody.runtimeProcessStartedAtEpochMs,
			sweepingRuntimeProcessInstanceId: custody.thisRuntimeProcessInstanceId,
			liveRuntimeProcessInstanceIds: new Set([
				...liveRuntimeProcessInstanceIds,
				custody.thisRuntimeProcessInstanceId,
			]),
			nowEpochMs: now(),
			custodianLivenessObservationAvailable,
			currentTaskSessionSummariesByTaskId: new Map(
				Object.keys((await loadSnapshot(workspaceId)).entriesByTaskId).map((taskId) => [
					taskId,
					deps.getTaskSessionSummary(workspaceId, taskId),
				]),
			),
		});
		if (
			stamped.stampedCount > 0 ||
			stamped.settledProgrammaticInjectionCount > 0 ||
			stamped.recoveredPreflightQueryCustodyCount > 0
		) {
			await commitSnapshotAndBroadcast(workspaceId, stamped.snapshot);
		}
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
			waitWithinBudget: async (minimumBudgetMs = 0): Promise<TaskChatInputDeliveryOutcome | null> => {
				let budgetTimer: NodeJS.Timeout | null = null;
				const budgetExhausted = new Promise<null>((resolve) => {
					budgetTimer = setTimeout(
						() => resolve(null),
						Math.max(minimumBudgetMs, programmaticTerminalDeliveryOutcomeWaitBudgetMs),
					);
					budgetTimer.unref?.();
				});
				try {
					return await Promise.race([outcome, budgetExhausted, whenStopped.then(() => null)]);
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
		isCurrentTransportAttemptActive?: () => boolean,
	): Promise<void> => {
		const snapshot = await settleQueuedTaskPromptDelivery({
			workspaceId,
			taskId,
			queueEntryIds,
			settlement,
			isCurrentTransportAttemptActive,
			nowEpochMs: now(),
		});
		await commitSnapshotAndBroadcast(workspaceId, snapshot);
	};

	const runDispatchAttempt = async (workspaceId: string, taskId: string): Promise<void> => {
		const taskKey = buildTaskKey(workspaceId, taskId);
		let awaitingEntries = listAwaitingDispatchEntries(await loadSnapshot(workspaceId), taskId, now());
		if (awaitingEntries.length === 0) {
			return;
		}
		// 队首不归本实例托管：先过一遍持续盖章屏障（托管者死了就盖章并接管），再按刷新后的快照判断。
		const headCustodianRuntimeProcessInstanceId = awaitingEntries[0]?.custodianRuntimeProcessInstanceId ?? null;
		if (
			custody !== null &&
			headCustodianRuntimeProcessInstanceId !== null &&
			headCustodianRuntimeProcessInstanceId !== custody.thisRuntimeProcessInstanceId
		) {
			await stampEntriesWhoseCustodianIsGone(workspaceId);
			awaitingEntries = listAwaitingDispatchEntries(await loadSnapshot(workspaceId), taskId, now());
			if (awaitingEntries.length === 0) {
				return;
			}
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
		const headEntry = awaitingEntries[0];
		if (headEntry === undefined || resolveBlockReasonForEntry(workspaceId, headEntry, summary) !== null) {
			return;
		}
		const sessionIncarnationId = summary.runtimeSessionIncarnationId;
		if (sessionIncarnationId == null) {
			return;
		}

		let nativePredecessorTurnId: string | null = null;
		if (headEntry.requiredNativeIndependentUserTurnSessionId) {
			try {
				const turns = await (deps.readNativeConversationTurns ?? readCurrentTuiNativeConversationTurns)({
					workspaceId,
					entry: headEntry,
					getSummary: () => deps.getTaskSessionSummary(workspaceId, taskId),
				});
				// 查询跨 await；取消、到期或队首变化后绝不可继续认领。
				let fresh = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId);
				rememberSnapshot(workspaceId, fresh);
				if (listAwaitingDispatchEntries(fresh, taskId, now())[0]?.queueEntryId !== headEntry.queueEntryId) return;
				if (headEntry.nativeIndependentUserTurnPreflightQueryRecovery?.recoveredAtEpochMs === null) {
					fresh = await updateQueuedTaskPromptNativeIndependentUserTurnQueryRecovery({
						workspaceId,
						expectedEntry: headEntry,
						failureReason: null,
						nowEpochMs: now(),
					});
					await commitSnapshotAndBroadcast(workspaceId, fresh);
					if (listAwaitingDispatchEntries(fresh, taskId, now())[0]?.queueEntryId !== headEntry.queueEntryId)
						return;
				}
				if (turns.at(-1)?.status !== "completed") {
					if (!stopped && !nativeTurnPollTimerByTaskKey.has(taskKey)) {
						const timer = setTimeout(
							() => {
								nativeTurnPollTimerByTaskKey.delete(taskKey);
								requestDispatchAttempt(workspaceId, taskId);
							},
							Math.min(deps.nativeTurnCompletionPollIntervalMs ?? 500, Math.max(1, headEntry.expiresAt - now())),
						);
						timer.unref?.();
						nativeTurnPollTimerByTaskKey.set(taskKey, timer);
					}
					return;
				}
				nativePredecessorTurnId =
					headEntry.nativeIndependentUserTurnSubmissionProgress?.predecessorNativeTurnId ??
					turns.at(-1)?.id ??
					null;
			} catch (error) {
				if (!(error instanceof NativeIndependentUserTurnDeliveryError)) throw error;
				if (error.recovery.retryableQueryFailure) {
					const waiting = await updateQueuedTaskPromptNativeIndependentUserTurnQueryRecovery({
						workspaceId,
						expectedEntry: headEntry,
						failureReason: error.message,
						nowEpochMs: now(),
					});
					await commitSnapshotAndBroadcast(workspaceId, waiting);
					return;
				}
				await settleHandedOffRun(workspaceId, taskId, [headEntry.queueEntryId], {
					outcome: "terminal_failure",
					failureNote: error.message,
					terminalDeliveryReceiptForInjectionLedger: { status: "delivery_failed", reason: error.reason },
				});
				return;
			}
		}

		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			expectedQueueHeadEntryId: headEntry.queueEntryId,
			workspaceId,
			taskId,
			sessionIncarnationId,
			turnSequence: summary.agentResponseGenerationTurnSequence ?? 0,
			nowEpochMs: now(),
		});
		if (claimed === null) {
			const fresh = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId);
			rememberSnapshot(workspaceId, fresh);
			if (listAwaitingDispatchEntries(fresh, taskId, now())[0]?.queueEntryId !== headEntry.queueEntryId)
				requestDispatchAttempt(workspaceId, taskId);
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

		// 程序化条目用调用方的 key 与 source 交出；终态只经下方受托管归属保护的结算写入，再由 store 镜像账本。
		const programmaticInjectionLink = claimedHead.programmaticInjectionLedgerReceiptLink ?? null;
		const dispatchIdempotencyKey =
			programmaticInjectionLink?.injectionLedgerIdempotencyKey ?? createDispatchIdempotencyKey();
		const handedOff = await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId,
			taskId,
			queueEntryIds: claimedQueueEntryIds,
			dispatchIdempotencyKey,
			predecessorNativeTurnId: nativePredecessorTurnId ?? undefined,
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

		const settleCurrentTransportAttempt = (settlement: QueuedTaskPromptDeliverySettlement) =>
			settleHandedOffRun(
				workspaceId,
				taskId,
				claimedQueueEntryIds,
				{
					...settlement,
					expectedHandedToTransportAttemptOwnership: {
						dispatchIdempotencyKey,
						custodianRuntimeProcessInstanceId: handedOffEntries[0].custodianRuntimeProcessInstanceId,
						claimedForSessionIncarnationId: handedOffEntries[0].claimedForSessionIncarnationId,
					},
				},
				() => !stopped,
			);
		handedOffAtTurnKeyByTaskKey.set(taskKey, turnKey);
		const waiter = createProgrammaticTerminalDeliveryOutcomeWaiter();
		const dispatchedText = buildMergedQueuedTaskPromptDeliveryText(claimed.claimedEntries);
		let response: RuntimeTaskChatSendResponse;
		try {
			response = await deps.sendThroughTaskChatTransports(
				scope,
				{
					taskId,
					text: dispatchedText,
					source: programmaticInjectionLink?.injectionSource ?? QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE,
					idempotencyKey: dispatchIdempotencyKey,
				},
				waiter.observer,
				programmaticInjectionLink?.injectionLedgerTaskId,
				nativePredecessorTurnId
					? createNativeIndependentUserTurnBeforeSubmissionValidator({
							workspaceId,
							entry: handedOffEntries[0],
							predecessorNativeTurnId: nativePredecessorTurnId,
							text: dispatchedText,
							now,
							isStopped: () => stopped,
							whenStopped,
							readNativeConversationTurns: () =>
								(deps.readNativeConversationTurns ?? readCurrentTuiNativeConversationTurns)({
									workspaceId,
									entry: claimedHead,
									getSummary: () => deps.getTaskSessionSummary(workspaceId, taskId),
								}),
							onSnapshotChanged: (snapshot) => commitSnapshotAndBroadcast(workspaceId, snapshot),
						})
					: undefined,
			);
		} catch (error) {
			if (stopped) return;
			// 统一出口自己兜住了异常并返回 ok:false；能走到这里说明是出口之外的东西抛了（例：依赖注入的包装层）。
			// 不知道字节有没有出去 ⇒ 交给人。
			await settleCurrentTransportAttempt({
				outcome: "terminal_failure",
				failureNote: `Sending the queued prompt failed unexpectedly: ${
					error instanceof Error ? error.message : String(error)
				}`,
				terminalDeliveryReceiptForInjectionLedger: INJECTION_LEDGER_RECEIPT_WHEN_DELIVERY_OUTCOME_IS_UNKNOWN,
			});
			return;
		}

		// 每一个落定点都把「这次投递真实的终端回执」随结算带进 store：程序化条目据此镜像进账本，人排的条目忽略它。
		if (stopped) return;
		const terminalDelivery = response.terminalDelivery ?? null;
		if (terminalDelivery === null) {
			// 出口在受理之前就回了：ok 只可能是 Cline SDK 的 /clear 这类不走投递的分支；不 ok 则一个字节都没进 agent
			// ——与 `kanban task message` 在同一情形下落的原因相同（它回退到 no_active_terminal_session）。
			await settleCurrentTransportAttempt(
				response.ok
					? {
							outcome: "delivered",
							failureNote: null,
							terminalDeliveryReceiptForInjectionLedger: {
								status: "delivered_and_submit_confirmed",
								reason: null,
							},
						}
					: {
							...routeQueuedTaskPromptDeliveryRejectedBeforeTransportAccepted(response.error),
							terminalDeliveryReceiptForInjectionLedger: {
								status: "delivery_failed",
								reason: "no_active_terminal_session",
							},
						},
			);
			return;
		}
		if (terminalDelivery.status !== "accepted_pending_submit_confirmation") {
			await settleCurrentTransportAttempt({
				...routeQueuedTaskPromptDeliveryTerminalOutcome(terminalDelivery),
				terminalDeliveryReceiptForInjectionLedger: terminalDelivery,
			});
			return;
		}
		const settledOutcome = await waiter.waitWithinBudget(
			nativePredecessorTurnId ? Math.max(0, claimedHead.expiresAt - now()) : 0,
		);
		if (stopped) return;
		await settleCurrentTransportAttempt(
			settledOutcome === null
				? {
						outcome: "terminal_failure",
						failureNote:
							"No delivery confirmation arrived within the settlement budget, so the prompt may or may not have been sent.",
						terminalDeliveryReceiptForInjectionLedger: INJECTION_LEDGER_RECEIPT_WHEN_DELIVERY_OUTCOME_IS_UNKNOWN,
					}
				: {
						...routeQueuedTaskPromptDeliveryTerminalOutcome(settledOutcome),
						terminalDeliveryReceiptForInjectionLedger: {
							status: settledOutcome.status,
							reason: settledOutcome.reason,
							...(settledOutcome.failureNote ? { failureNote: settledOutcome.failureNote } : {}),
							...(settledOutcome.codexNativePromptDeliveryEvidence
								? { codexNativePromptDeliveryEvidence: settledOutcome.codexNativePromptDeliveryEvidence }
								: {}),
						},
					},
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
				// 持续盖章屏障：托管者在上一次 sweep 之后才判死的条目，在这里被盖章接管。
				await stampEntriesWhoseCustodianIsGone(workspaceId);
				// 绕过缓存重读：兜底 sweep 的另一半职责就是捡回别的进程对队列文件的改动。
				let snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId);
				snapshot = await reconcileManagedTaskPromptDeliveryReceipts(workspaceId, snapshot, now());
				// 截止定时器之外的第二道：别的进程排进来、本进程没机会对准定时器的程序化条目，到点在这里写盘收敛。
				const sweepNowEpochMs = now();
				const hasProgrammaticInjectionPastDeadline = Object.values(snapshot.entriesByTaskId).some((entries) =>
					entries.some(
						(entry) =>
							entry.deliveryState === "queued" &&
							isQueuedTaskPromptDeliveryProgrammaticInjection(entry) &&
							sweepNowEpochMs >= entry.expiresAt,
					),
				);
				if (hasProgrammaticInjectionPastDeadline) {
					snapshot = await settleExpiredQueuedTaskPromptDeliveries({ workspaceId, nowEpochMs: sweepNowEpochMs });
				}
				await commitSnapshotAndBroadcast(workspaceId, snapshot);
				await reconcileInjectionLedgerWithSettledProgrammaticInjections({ workspaceId, snapshot });
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
			if (isNativeIndependentUserTurnSubmissionKnownNotStarted(entry)) {
				const cancelled = await mutateWorkspaceQueuedTaskPromptDeliveries(
					workspaceId,
					{
						kind: "cancel_queued_prompt_delivery",
						taskId,
						queueEntryId,
					},
					now(),
				);
				await commitSnapshotAndBroadcast(workspaceId, cancelled);
				if (
					cancelled.entriesByTaskId[taskId]?.find((candidate) => candidate.queueEntryId === queueEntryId)
						?.deliveryState === "cancelled"
				)
					return "cancelled_before_delivery";
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
			clearProgrammaticInjectionDeadlineTimer(workspaceId);
			cachedSnapshotByWorkspaceId.delete(workspaceId);
			lastBroadcastProjectionFingerprintByWorkspaceId.delete(workspaceId);
			const timer = projectionRebroadcastTimerByWorkspaceId.get(workspaceId);
			if (timer) {
				clearTimeout(timer);
				projectionRebroadcastTimerByWorkspaceId.delete(workspaceId);
			}
			const prefix = `${workspaceId}::`;
			for (const [key, nativeTimer] of nativeTurnPollTimerByTaskKey) {
				if (key.startsWith(prefix)) {
					clearTimeout(nativeTimer);
					nativeTurnPollTimerByTaskKey.delete(key);
				}
			}
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
			resolveStopped();
			for (const timer of nativeTurnPollTimerByTaskKey.values()) clearTimeout(timer);
			nativeTurnPollTimerByTaskKey.clear();
			if (fallbackSweepTimer !== null) {
				clearInterval(fallbackSweepTimer);
				fallbackSweepTimer = null;
			}
			for (const timer of projectionRebroadcastTimerByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			projectionRebroadcastTimerByWorkspaceId.clear();
			for (const armed of programmaticInjectionDeadlineTimerByWorkspaceId.values()) {
				clearTimeout(armed.timer);
			}
			programmaticInjectionDeadlineTimerByWorkspaceId.clear();
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
