// runtime 启动清扫（排队 prompt 版）。两件事，顺序固定：
//
//   1. **收敛被重启撂在半路的在途投递**。claimed_for_dispatch（一个字节都没写出去）释放回 queued；
//      handed_to_transport（可能已经发出去了）落 settled_failed 并保留可见，由人决定要不要重排——
//      绝不自动重投。已持久提交的压缩感知自动收尾按单条截止只读续等，并从真实账本终态收敛。
//      没有这一步，一次崩溃就能把某个 task 的队列永久卡死：认领门会被僵尸条目挡住。
//   2. **给跨过了这次重启的条目盖 restart-crossing 章**。门控 0 据此硬阻塞，直到人在重启后看见过它
//      （聚焦任务时的 5 秒高亮 + reconfirm mutation）。这是用户明确要的行为：kanban 重启之后，队列还在，
//      但先提醒我确认它还需不需要，再在下一次 stop hook 注入。
//
// 顺序的理由：先把 handed_to_transport 落成终态，它就不再是非终态、不会被盖章——一条已经判定「可能发出去了」
// 的条目，再去提醒人「重启前排的，还要不要」是答非所问。
//
// ## 两个判据都不是「本进程刚起来」
//
// 一台机器上会同时跑多个 runtime（常驻实例 / dev:full / dogfood / 起真服务器的集成测试），它们共享同一个
// workspaces 根。按「本进程刚起来」全扫，第二个实例一启动就会把常驻实例此刻真正在途的投递判失败、
// 把它正常排着的队全部盖章。所以：
//   - 在途投递按**超期**判（与 pending-task-message-injection-startup-sweep.ts 同一口径）：岁数超过
//     PTY 最坏收敛预算的在途投递，无论归谁管都不可能还在正常投递；启动时还年轻的，由一次延迟复扫补判。
//   - 盖章按**托管实例此刻不在心跳里**判（见 runtime-process-instance-heartbeat-registry.ts 与
//     store 的 stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart）。

import type { WorkspaceQueuedTaskPromptDeliverySnapshot } from "../core/api-contract";
import {
	CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS,
	CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS,
} from "../core/codex-rvf-closeout-compaction-aware-confirmation";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import {
	settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
} from "../state/queued-task-prompt-delivery-store";
import { readLiveRuntimeProcessInstanceIds } from "../state/runtime-process-instance-heartbeat-registry";
import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS } from "../terminal/session-manager";

// 与 pending-task-message-injection-startup-sweep.ts 同一个余量：吸收定时器抖动与时间戳取整，
// 免得复扫恰好早到一拍、把刚好还在预算内的投递判失败。
const STALE_QUEUED_PROMPT_IN_FLIGHT_SWEEP_FOLLOW_UP_MARGIN_MS = 5_000;

const QUEUED_PROMPT_DELIVERY_STRANDED_BY_RUNTIME_RESTART_FAILURE_NOTE =
	"Kanban restarted while this prompt was being sent, so it may or may not have reached the agent. Check the conversation before requeueing.";

export interface QueuedTaskPromptDeliveryRuntimeRestartSweepInput {
	runtimeProcessStartedAtEpochMs: number;
	sweepingRuntimeProcessInstanceId: string;
	// 是否在这一趟里盖 restart-crossing 章。启动那一趟盖；延迟复扫只收敛在途投递，不再盖章。
	// 启动之后才判死的托管者（崩溃后心跳还在宽限期内时本实例就起来了）由 dispatcher 的**持续盖章屏障**
	// 接手：每次出队前与每次 60s sweep 都重读心跳（见 queued-task-prompt-delivery-dispatcher.ts 头注）。
	// 启动这一趟只是让重启后的第一屏就看得见「待确认」，不是唯一一道。
	stampEntriesThatSurvivedRuntimeRestart: boolean;
	inFlightSettlementBudgetMs?: number;
	listWorkspaceIds?: () => Promise<string[]>;
	readLiveRuntimeProcessInstanceIds?: () => Promise<ReadonlySet<string>>;
	onWorkspaceQueueRewritten?: (workspaceId: string, snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) => void;
	nowEpochMs?: () => number;
}

export interface QueuedTaskPromptDeliveryRuntimeRestartSweepResult {
	releasedClaimCount: number;
	failedStrandedDeliveryCount: number;
	stampedCount: number;
	// 这一趟里仍在途、且还没超期的条目里，最早会跨过预算的时刻。null = 没有这样的条目，不必复扫。
	earliestYoungInFlightDeliveryBecomesStaleAtEpochMs: number | null;
	// 程序化条目不盖人工章；其中可核验的已提交自动收尾从账本收敛，其余按旧重启规则结算。
	settledProgrammaticInjectionCount: number;
}

export async function sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces(
	input: QueuedTaskPromptDeliveryRuntimeRestartSweepInput,
): Promise<QueuedTaskPromptDeliveryRuntimeRestartSweepResult> {
	const nowEpochMs = input.nowEpochMs ?? (() => Date.now());
	const inFlightSettlementBudgetMs =
		input.inFlightSettlementBudgetMs ?? TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS;
	const result: QueuedTaskPromptDeliveryRuntimeRestartSweepResult = {
		releasedClaimCount: 0,
		failedStrandedDeliveryCount: 0,
		stampedCount: 0,
		earliestYoungInFlightDeliveryBecomesStaleAtEpochMs: null,
		settledProgrammaticInjectionCount: 0,
	};
	let workspaceIds: string[];
	try {
		workspaceIds = input.listWorkspaceIds
			? await input.listWorkspaceIds()
			: (await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId);
	} catch (error) {
		// 索引读不出来不该拖垮启动：清扫是纠偏动作，不是启动前置条件。
		logTuiFreezeError("[tui-freeze] queued-prompt-restart-sweep-skipped reason=workspace_index_unreadable", error);
		return result;
	}
	// 活性只读一次：同一趟清扫里所有 workspace 用同一份「此刻谁还活着」，判据才自洽。
	let liveRuntimeProcessInstanceIds: ReadonlySet<string> | null = null;
	if (input.stampEntriesThatSurvivedRuntimeRestart) {
		try {
			liveRuntimeProcessInstanceIds = await (
				input.readLiveRuntimeProcessInstanceIds ?? (() => readLiveRuntimeProcessInstanceIds())
			)();
		} catch (error) {
			// 读失败按「谁都不活」处理——多盖章是 fail-safe 方向（多让人确认一次），漏盖才是事故。
			logTuiFreezeError("[tui-freeze] queued-prompt-restart-sweep liveness-unreadable fallback=all_dead", error);
			liveRuntimeProcessInstanceIds = new Set();
		}
	}
	for (const workspaceId of workspaceIds) {
		try {
			const stranded = await settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart({
				workspaceId,
				inFlightSettlementBudgetMs,
				strandedDeliveryFailureNote: QUEUED_PROMPT_DELIVERY_STRANDED_BY_RUNTIME_RESTART_FAILURE_NOTE,
				nowEpochMs: nowEpochMs(),
			});
			result.releasedClaimCount += stranded.releasedClaimCount;
			result.failedStrandedDeliveryCount += stranded.failedStrandedDeliveryCount;
			result.settledProgrammaticInjectionCount += stranded.reconciledProgrammaticInjectionCount;
			let snapshot = stranded.snapshot;
			let stampedCountForWorkspace = 0;
			let settledProgrammaticInjectionCountForWorkspace = 0;
			if (liveRuntimeProcessInstanceIds !== null) {
				const stamped = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
					workspaceId,
					runtimeProcessStartedAtEpochMs: input.runtimeProcessStartedAtEpochMs,
					sweepingRuntimeProcessInstanceId: input.sweepingRuntimeProcessInstanceId,
					liveRuntimeProcessInstanceIds,
					nowEpochMs: nowEpochMs(),
				});
				stampedCountForWorkspace = stamped.stampedCount;
				result.stampedCount += stamped.stampedCount;
				settledProgrammaticInjectionCountForWorkspace = stamped.settledProgrammaticInjectionCount;
				result.settledProgrammaticInjectionCount += stamped.settledProgrammaticInjectionCount;
				snapshot = stamped.snapshot;
			}
			const youngest = stranded.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs;
			if (youngest !== null) {
				result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs =
					result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs === null
						? youngest
						: Math.min(result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs, youngest);
			}
			if (
				stranded.releasedClaimCount > 0 ||
				stranded.failedStrandedDeliveryCount > 0 ||
				stranded.reconciledProgrammaticInjectionCount > 0 ||
				stampedCountForWorkspace > 0 ||
				settledProgrammaticInjectionCountForWorkspace > 0
			) {
				logTuiFreezeWarning(
					`[tui-freeze] queued-prompt-restart-swept workspaceId=${workspaceId} released=${stranded.releasedClaimCount} ` +
						`failed=${stranded.failedStrandedDeliveryCount} stamped=${stampedCountForWorkspace} ` +
						`programmatic-settled=${settledProgrammaticInjectionCountForWorkspace + stranded.reconciledProgrammaticInjectionCount}`,
				);
				input.onWorkspaceQueueRewritten?.(workspaceId, snapshot);
			}
		} catch (error) {
			// 单个 workspace 的队列损坏不应阻断其余 workspace 的清扫。
			logTuiFreezeError(`[tui-freeze] queued-prompt-restart-sweep-failed workspaceId=${workspaceId}`, error);
		}
	}
	return result;
}

// 启动入口：先扫一趟（收敛超期在途 + 盖章），再给「本轮还年轻」的在途投递排一次复扫。
// 阶段变化可能延后第一次快照的截止；在固定上限内接续复扫，不重新发放任何投递预算。
export function scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart(
	input: Omit<QueuedTaskPromptDeliveryRuntimeRestartSweepInput, "stampEntriesThatSurvivedRuntimeRestart">,
): Promise<QueuedTaskPromptDeliveryRuntimeRestartSweepResult> {
	const startupSweep = sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces({
		...input,
		stampEntriesThatSurvivedRuntimeRestart: true,
	});
	const nowEpochMs = input.nowEpochMs ?? (() => Date.now());
	const startupFollowUpDeadlineAtEpochMs =
		nowEpochMs() +
		Math.max(
			input.inFlightSettlementBudgetMs ?? TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS,
			CODEX_RVF_CLOSEOUT_ORDINARY_CONFIRMATION_BUDGET_MS + CODEX_RVF_CLOSEOUT_CUMULATIVE_COMPACTION_WAIT_BUDGET_MS,
		) +
		2 * STALE_QUEUED_PROMPT_IN_FLIGHT_SWEEP_FOLLOW_UP_MARGIN_MS;
	const scheduleFollowUp = (result: QueuedTaskPromptDeliveryRuntimeRestartSweepResult): void => {
		if (result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs === null) {
			return;
		}
		if (nowEpochMs() >= startupFollowUpDeadlineAtEpochMs) return;
		const followUpDelayMs = Math.max(
			0,
			Math.min(
				startupFollowUpDeadlineAtEpochMs,
				result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs +
					STALE_QUEUED_PROMPT_IN_FLIGHT_SWEEP_FOLLOW_UP_MARGIN_MS,
			) - nowEpochMs(),
		);
		// unref：复扫是纠偏动作，不该把一个本该退出的进程按在事件循环里。
		setTimeout(() => {
			void sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces({
				...input,
				stampEntriesThatSurvivedRuntimeRestart: false,
			}).then(scheduleFollowUp);
		}, followUpDelayMs).unref();
	};
	void startupSweep.then(scheduleFollowUp);
	return startupSweep;
}
