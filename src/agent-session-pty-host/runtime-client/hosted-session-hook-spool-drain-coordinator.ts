// runtime 侧：把 agent session PTY host spool 里的 hook 事件按序应用回 hooks ingest。
//
// runtime 缺席时，hosted 会话里的 hooks CLI 把事件存进 host（见 hosted-session-cli-client-requests-to-agent-session-pty-host.ts）。
// runtime 回来后由这里取走、逐条应用、再确认。不变量：存进 spool 的每条事件恰好应用一次、先于同一会话之后直投的事件、
// 先于该会话退出的交付，且绝不静默丢弃。为此：
//   1) 不靠「有新条目」通知判断有没有待排空：登记目标时、应用函数绑定时、每次直投前、交付退出前，都要等到一次「在请求之后才发出」的读
//      读回并应用完（同一时刻的多个请求共享同一次读）。host 的通知只让排空更及时——通知走 UDS、直投走 TCP，
//      二者到达 runtime 的先后本就没有保证；通知帧也可能晚于读响应、落在另一个 socket data 事件里。
//   2) 同一会话的排空单飞：按序号逐条应用，每应用完一条就确认它；读回空、且期间没有新的读请求才结束。
//   3) 注销即取消：目标注销后，在途 / 排队（等应用函数绑定）的排空不再应用、也不再确认任何条目（条目留在 host）。
//   4) 应用失败有界重试；耗尽后告警并写持久丢投记录，再确认——不无痕丢弃，也不无限阻塞后面的直投与退出交付。
//   5) 退出：先排空 → 交付退出 → 确认退出 → 再读直到 host 不再认识这条会话才注销目标
//      （host 确认退出时若 spool 非空会保留会话，等 spool 被确认清空再移除）。
// 应用函数在 runtime server 建好之后才绑定（hooks ingest 依赖它）。读不等它；读到条目才等它绑定再应用——
// spool 为空时退出照常交付，不被「runtime server 还没建好」卡住。

import { setTimeout as waitMillisecondsWithTimer } from "node:timers/promises";
import { runtimeHookEventSchema } from "../../core/api-contract";
import { recordHookDeliveryFailure } from "../../diagnostics/hook-ingest-delivery-failure-logger";
import type { HostedSessionHookSpoolEntry } from "../wire-protocol/agent-session-pty-host-wire-protocol-messages";

export interface HookSpoolDrainTargetHostedSession {
	hostedSessionKey: string;
	workspaceId: string;
	taskId: string;
	// null：host 已不认识这条会话（退出已确认且 spool 已清空）。抛错：连接断开或读超时。
	readHookSpoolEntries(): Promise<HostedSessionHookSpoolEntry[] | null>;
	acknowledgeHookSpoolEntriesThrough(throughHookSpoolEntrySequenceNumber: number): void;
}

export type SpooledHookIngestRequestApplier = (
	spooledHookIngestRequest: unknown,
) => Promise<{ ok: boolean; error?: string }>;

export interface SpooledHookEventDroppedAfterApplyRetriesExhausted {
	workspaceId: string;
	taskId: string;
	hookSpoolEntrySequenceNumber: number;
	spooledHookIngestRequest: unknown;
	applyAttemptCount: number;
	lastApplyFailureMessage: string;
}

export interface HostedSessionHookSpoolDrainCoordinatorOptions {
	warn: (message: string) => void;
	// 应用重试耗尽、条目即将被确认移除之前调用：写持久丢投记录。生产用 recordSpooledHookEventDroppedToHookDeliveryFailureLog；
	// 测试注入，避免写真实 HOME。不得抛错（抛了也只告警，照常确认）。
	recordSpooledHookEventDroppedAfterApplyRetriesExhausted: (
		dropped: SpooledHookEventDroppedAfterApplyRetriesExhausted,
	) => Promise<void>;
	// 测试注入：两次应用尝试之间的退避等待。缺省为真实计时器。
	waitBeforeRetryingSpooledHookEventApply?: (delayMilliseconds: number) => Promise<void>;
}

// EXPERIMENT_NODE: spool 事件应用失败时每条最多尝试几次、两次之间退避多久。hooks ingest 的持久化 / I/O / manager 初始化失败
// 可能是瞬时的，值得重试；业务拒绝（task 不存在）重试也不会变，所以次数与退避都要小——排空挡着该会话的直投与退出交付。
const MAXIMUM_APPLY_ATTEMPTS_PER_SPOOLED_HOOK_EVENT = 3;
const BACKOFF_MILLISECONDS_BEFORE_EACH_SPOOLED_HOOK_EVENT_APPLY_RETRY = [100, 400] as const;

// 与 hooks CLI 同一口径（见 hook-ingest-delivery-failure-logger.ts）：activity 纯元数据、不改看板列，只告警不落持久记录。
export async function recordSpooledHookEventDroppedToHookDeliveryFailureLog(
	dropped: SpooledHookEventDroppedAfterApplyRetriesExhausted,
): Promise<void> {
	const looselyReadSpooledHookIngestRequest = dropped.spooledHookIngestRequest as {
		event?: unknown;
		metadata?: { source?: unknown };
	} | null;
	const parsedHookEvent = runtimeHookEventSchema.safeParse(looselyReadSpooledHookIngestRequest?.event);
	if (!parsedHookEvent.success || parsedHookEvent.data === "activity") {
		return;
	}
	const source = looselyReadSpooledHookIngestRequest?.metadata?.source;
	await recordHookDeliveryFailure({
		event: parsedHookEvent.data,
		taskId: dropped.taskId,
		workspaceId: dropped.workspaceId,
		source: typeof source === "string" ? source : null,
		attempts: dropped.applyAttemptCount,
		failureKind: "rejected",
		error: `spooled in agent session pty host (spool entry #${dropped.hookSpoolEntrySequenceNumber}): ${dropped.lastApplyFailureMessage}`,
	});
}

interface FreshHookSpoolReadWaiter {
	requestedFreshHookSpoolReadGeneration: number;
	resolveWaiter: () => void;
}

// 一次登记 = 一份状态。注销后同一会话再登记会得到新的一份，旧排空看到 registrationForgotten 即停手。
interface HookSpoolDrainTargetRegistration {
	target: HookSpoolDrainTargetHostedSession;
	registrationForgotten: boolean;
	// 每个「需要一次在此之后才发出的读」的请求加一；一次读覆盖发出那一刻之前的全部请求。
	latestRequestedFreshHookSpoolReadGeneration: number;
	freshHookSpoolReadWaiters: FreshHookSpoolReadWaiter[];
	drainLoopRunning: boolean;
}

type SpooledHookEventApplyOutcome =
	| "applied"
	| "dropped_after_apply_retries_exhausted"
	| "drain_target_registration_forgotten";

export class HostedSessionHookSpoolDrainCoordinator {
	private readonly registrationsByHostedSessionKey = new Map<string, HookSpoolDrainTargetRegistration>();
	private spooledHookIngestRequestApplier: SpooledHookIngestRequestApplier | null = null;
	private readonly waitersForApplierBinding: Array<() => void> = [];
	private readonly waitBeforeRetryingSpooledHookEventApply: (delayMilliseconds: number) => Promise<void>;

	constructor(private readonly options: HostedSessionHookSpoolDrainCoordinatorOptions) {
		this.waitBeforeRetryingSpooledHookEventApply =
			options.waitBeforeRetryingSpooledHookEventApply ??
			((delayMilliseconds) => waitMillisecondsWithTimer(delayMilliseconds));
	}

	// 只为支持 spool 的 host 上的会话登记（旧 host 不认读请求，会等满请求期限）。
	// 登记即请求一次新鲜读：listing 之后、登记之前存进来的条目（此前的通知已因未登记被忽略）由它取走。
	registerHookSpoolDrainTargetHostedSession(target: HookSpoolDrainTargetHostedSession): void {
		this.forgetHookSpoolDrainTargetHostedSession(target.hostedSessionKey);
		const registration: HookSpoolDrainTargetRegistration = {
			target,
			registrationForgotten: false,
			latestRequestedFreshHookSpoolReadGeneration: 0,
			freshHookSpoolReadWaiters: [],
			drainLoopRunning: false,
		};
		this.registrationsByHostedSessionKey.set(target.hostedSessionKey, registration);
		void this.requestDrainIncludingFreshHookSpoolRead(registration);
	}

	// 注销即取消：在途 / 排队的排空不再应用、不再确认；等它的直投与退出交付立即放行（这条会话已不归本 runtime 排空）。
	forgetHookSpoolDrainTargetHostedSession(hostedSessionKey: string): void {
		const registration = this.registrationsByHostedSessionKey.get(hostedSessionKey);
		if (registration === undefined) {
			return;
		}
		this.registrationsByHostedSessionKey.delete(hostedSessionKey);
		registration.registrationForgotten = true;
		this.releaseAllFreshHookSpoolReadWaiters(registration);
	}

	isHostedSessionRegisteredAsHookSpoolDrainTarget(hostedSessionKey: string): boolean {
		return this.registrationsByHostedSessionKey.has(hostedSessionKey);
	}

	// host 推来的「有新条目」。不认识的会话（未被本 runtime 接管 / spawn）忽略：它的 spool 留在 host 里，
	// 登记时的那次新鲜读会把登记前存进来的条目取走。
	noteHookSpoolEntriesPending(hostedSessionKey: string, pendingHookSpoolEntryCount: number): void {
		const registration = this.registrationsByHostedSessionKey.get(hostedSessionKey);
		if (registration === undefined || pendingHookSpoolEntryCount <= 0) {
			return;
		}
		void this.requestDrainIncludingFreshHookSpoolRead(registration);
	}

	// 绑定之后对每个已登记目标再请求一次新鲜读：登记时的读可能早于绑定，此后存进来的条目不靠通知也会被取走。
	bindSpooledHookIngestRequestApplier(spooledHookIngestRequestApplier: SpooledHookIngestRequestApplier): void {
		this.spooledHookIngestRequestApplier = spooledHookIngestRequestApplier;
		for (const resolveWaiter of this.waitersForApplierBinding.splice(0)) {
			resolveWaiter();
		}
		for (const registration of this.registrationsByHostedSessionKey.values()) {
			void this.requestDrainIncludingFreshHookSpoolRead(registration);
		}
	}

	// 直投 hook 应用之前调用：对该 task 的每个已登记会话，等一次在此之后发出的读读回并应用完。
	// 没有已登记会话（非 hosted / 旧 host）时立即返回，不碰 socket。读失败 / 超时 fail-open。
	async drainPendingHookSpoolEntriesBeforeDirectHookIngest(workspaceId: string, taskId: string): Promise<void> {
		const drainsToAwait: Promise<void>[] = [];
		for (const registration of this.registrationsByHostedSessionKey.values()) {
			if (registration.target.workspaceId === workspaceId && registration.target.taskId === taskId) {
				drainsToAwait.push(this.requestDrainIncludingFreshHookSpoolRead(registration));
			}
		}
		await Promise.all(drainsToAwait);
	}

	drainHookSpoolBeforeDeliveringExit(hostedSessionKey: string): Promise<void> {
		const registration = this.registrationsByHostedSessionKey.get(hostedSessionKey);
		return registration === undefined
			? Promise.resolve()
			: this.requestDrainIncludingFreshHookSpoolRead(registration);
	}

	// 退出确认已发出之后调用（同一连接上读排在确认之后，读到的是确认之后的状态）：host 若因 spool 非空保留了会话，
	// 这里把剩下的条目取走；读到 host 不认识这条会话（或读失败）为止，然后注销目标。
	async drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget(
		hostedSessionKey: string,
	): Promise<void> {
		const registration = this.registrationsByHostedSessionKey.get(hostedSessionKey);
		if (registration === undefined) {
			return;
		}
		await this.requestDrainIncludingFreshHookSpoolRead(registration);
		if (this.registrationsByHostedSessionKey.get(hostedSessionKey) === registration) {
			this.forgetHookSpoolDrainTargetHostedSession(hostedSessionKey);
		}
	}

	// 返回的 promise 在「本次请求之后发出的某次读」读回的条目全部应用（或重试耗尽后确认）完时 resolve；
	// 排空因读失败 / 注销 / host 不认识会话而结束时也 resolve（fail-open）。永不 reject。
	private requestDrainIncludingFreshHookSpoolRead(registration: HookSpoolDrainTargetRegistration): Promise<void> {
		if (registration.registrationForgotten) {
			return Promise.resolve();
		}
		registration.latestRequestedFreshHookSpoolReadGeneration += 1;
		const requestedFreshHookSpoolReadGeneration = registration.latestRequestedFreshHookSpoolReadGeneration;
		const freshHookSpoolReadApplied = new Promise<void>((resolveWaiter) => {
			registration.freshHookSpoolReadWaiters.push({ requestedFreshHookSpoolReadGeneration, resolveWaiter });
		});
		if (!registration.drainLoopRunning) {
			registration.drainLoopRunning = true;
			void this.runDrainLoopUntilHookSpoolReadsBackEmptyWithoutNewerReadRequests(registration);
		}
		return freshHookSpoolReadApplied;
	}

	private async runDrainLoopUntilHookSpoolReadsBackEmptyWithoutNewerReadRequests(
		registration: HookSpoolDrainTargetRegistration,
	): Promise<void> {
		const { target } = registration;
		try {
			// 让出一次：同一时刻（同一个同步段里）到来的其余请求赶上这次读。
			await Promise.resolve();
			while (!registration.registrationForgotten) {
				const freshHookSpoolReadGenerationCoveredByThisRead =
					registration.latestRequestedFreshHookSpoolReadGeneration;
				let hookSpoolEntries: HostedSessionHookSpoolEntry[] | null;
				try {
					hookSpoolEntries = await target.readHookSpoolEntries();
				} catch (error) {
					if (!registration.registrationForgotten) {
						// 连接断开（host 死了 / 被顶替）或读超时：放行等待者（fail-open），条目留在 host 里等下一次请求再读。
						this.options.warn(
							`could not read spooled hook events of ${target.workspaceId}/${target.taskId} from agent session pty host; proceeding without them for now: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					return;
				}
				if (registration.registrationForgotten || hookSpoolEntries === null) {
					return;
				}
				if (hookSpoolEntries.length > 0) {
					// 读到条目才需要应用函数：spool 为空时，退出交付与直投不依赖 runtime server 是否已建好。
					const spooledHookIngestRequestApplier = await this.waitUntilSpooledHookIngestRequestApplierIsBound();
					for (const hookSpoolEntry of hookSpoolEntries) {
						if (registration.registrationForgotten) {
							return;
						}
						const applyOutcome = await this.applySpooledHookEventWithBoundedRetries(
							registration,
							spooledHookIngestRequestApplier,
							hookSpoolEntry,
						);
						if (applyOutcome === "drain_target_registration_forgotten" || registration.registrationForgotten) {
							return;
						}
						// 逐条确认：中途被注销时，已应用的前缀不会被下一个接管者重放。
						target.acknowledgeHookSpoolEntriesThrough(hookSpoolEntry.hookSpoolEntrySequenceNumber);
					}
				}
				this.releaseFreshHookSpoolReadWaitersCoveredByRead(
					registration,
					freshHookSpoolReadGenerationCoveredByThisRead,
				);
				// 读回非空时总要再读一轮：应用期间可能又存进了新条目。
				if (
					hookSpoolEntries.length === 0 &&
					registration.latestRequestedFreshHookSpoolReadGeneration ===
						freshHookSpoolReadGenerationCoveredByThisRead
				) {
					return;
				}
			}
		} finally {
			// 与上面的 return 同步执行：结束判定与「不再有循环」之间没有可插入新请求的空隙。
			registration.drainLoopRunning = false;
			this.releaseAllFreshHookSpoolReadWaiters(registration);
		}
	}

	private async applySpooledHookEventWithBoundedRetries(
		registration: HookSpoolDrainTargetRegistration,
		spooledHookIngestRequestApplier: SpooledHookIngestRequestApplier,
		hookSpoolEntry: HostedSessionHookSpoolEntry,
	): Promise<SpooledHookEventApplyOutcome> {
		const { target } = registration;
		let lastApplyFailureMessage = "unknown error";
		for (let applyAttempt = 1; applyAttempt <= MAXIMUM_APPLY_ATTEMPTS_PER_SPOOLED_HOOK_EVENT; applyAttempt += 1) {
			if (applyAttempt > 1) {
				await this.waitBeforeRetryingSpooledHookEventApply(
					BACKOFF_MILLISECONDS_BEFORE_EACH_SPOOLED_HOOK_EVENT_APPLY_RETRY[applyAttempt - 2] ??
						BACKOFF_MILLISECONDS_BEFORE_EACH_SPOOLED_HOOK_EVENT_APPLY_RETRY.at(-1) ??
						0,
				);
				if (registration.registrationForgotten) {
					return "drain_target_registration_forgotten";
				}
			}
			let applied = false;
			try {
				const response = await spooledHookIngestRequestApplier(hookSpoolEntry.spooledHookIngestRequest);
				applied = response.ok;
				if (!response.ok) {
					lastApplyFailureMessage = `rejected: ${response.error ?? "unknown error"}`;
				}
			} catch (error) {
				lastApplyFailureMessage = `failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (registration.registrationForgotten) {
				return "drain_target_registration_forgotten";
			}
			if (applied) {
				return "applied";
			}
		}
		this.options.warn(
			`spooled hook event of ${target.workspaceId}/${target.taskId} (agent session pty host spool entry #${hookSpoolEntry.hookSpoolEntrySequenceNumber}) could not be applied after ${MAXIMUM_APPLY_ATTEMPTS_PER_SPOOLED_HOOK_EVENT} attempts and is dropped from the spool: ${lastApplyFailureMessage}`,
		);
		try {
			await this.options.recordSpooledHookEventDroppedAfterApplyRetriesExhausted({
				workspaceId: target.workspaceId,
				taskId: target.taskId,
				hookSpoolEntrySequenceNumber: hookSpoolEntry.hookSpoolEntrySequenceNumber,
				spooledHookIngestRequest: hookSpoolEntry.spooledHookIngestRequest,
				applyAttemptCount: MAXIMUM_APPLY_ATTEMPTS_PER_SPOOLED_HOOK_EVENT,
				lastApplyFailureMessage,
			});
		} catch (error) {
			this.options.warn(
				`could not record the dropped spooled hook event of ${target.workspaceId}/${target.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return "dropped_after_apply_retries_exhausted";
	}

	private releaseFreshHookSpoolReadWaitersCoveredByRead(
		registration: HookSpoolDrainTargetRegistration,
		freshHookSpoolReadGenerationCoveredByRead: number,
	): void {
		const waitersStillAwaitingLaterRead: FreshHookSpoolReadWaiter[] = [];
		for (const waiter of registration.freshHookSpoolReadWaiters) {
			if (waiter.requestedFreshHookSpoolReadGeneration <= freshHookSpoolReadGenerationCoveredByRead) {
				waiter.resolveWaiter();
			} else {
				waitersStillAwaitingLaterRead.push(waiter);
			}
		}
		registration.freshHookSpoolReadWaiters = waitersStillAwaitingLaterRead;
	}

	private releaseAllFreshHookSpoolReadWaiters(registration: HookSpoolDrainTargetRegistration): void {
		for (const waiter of registration.freshHookSpoolReadWaiters.splice(0)) {
			waiter.resolveWaiter();
		}
	}

	private waitUntilSpooledHookIngestRequestApplierIsBound(): Promise<SpooledHookIngestRequestApplier> {
		const boundApplier = this.spooledHookIngestRequestApplier;
		if (boundApplier !== null) {
			return Promise.resolve(boundApplier);
		}
		return new Promise((resolve) => {
			this.waitersForApplierBinding.push(() => {
				resolve(this.spooledHookIngestRequestApplier as SpooledHookIngestRequestApplier);
			});
		});
	}
}
