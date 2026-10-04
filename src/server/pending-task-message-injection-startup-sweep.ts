// runtime 启动清扫 + 运行期持续清扫：把所有 workspace 账本里**超期**仍处于 accepted_pending_submit_confirmation 的
// 注入记录判为 delivery_failed{runtime_restarted_before_confirmation}。
//
// 为什么必须有这一步：pending 的收敛完全依赖 runtime 内存里的那份投递登记（定时器 + 代际 + 确认链）。
// runtime 一重启，内存态全没了，那些记录就再也没有任何人会去改写——于是 RVF 会永远等一个不会到来的
// 终态，退回到 2026-08-08 事故的形态（只是这次是「永远 pending」而不是「假成功」）。
//
// 为什么判据是「超期」而不是「本进程刚起来」：账本落在全机共享的 workspaces 根下，一台机器上可以同时
// 跑多个 runtime 实例（并行 checkout 的 dev:full、dogfood、起真服务器的集成测试）。按「本进程刚起来」
// 全扫，第二个实例一启动就会把常驻实例此刻真正在途的投递写成失败，而终态写一次即定 ⇒ 不可纠正的假失败。
// 「超期」则是契约自带的判据：pending 必然在自己的收敛上界内转终态（立即投递：状态时间戳 + 终端投递最坏
// 预算；agent 空闲门控的排队投递：max(状态时间戳, 等待截止) + 同一个预算，见账本模块的
// resolvePendingRecordBecomesStaleAtEpochMs），故过了上界仍 pending 的记录无论归谁管都不可能还在正常投递。
// 契约 § 时序保证 2 的原文写的也正是「清扫**超期**仍 pending 的记录」。
//
// ## 为什么不是「启动扫一趟 + 一趟复扫」就完事，而是 runtime 活多久就扫多久
//
// 「没人收敛的 pending」不只在重启那一刻产生，runtime 活着期间照样会冒出来：
//   - CLI 在「建记录」与「调 runtime 投递」之间死掉（立即投递）；
//   - runtime 在「建门控记录」与「入队」之间崩溃，重启时那条记录还年轻（截止可以在几小时后）；
//   - 门控记录的落定镜像写账本失败，而队列里的终态条目随后被 Dismiss / per-task 上限 / 保留期裁掉——出队
//     引擎的兜底对账（reconcileInjectionLedgerWithSettledProgrammaticInjections）只认队列证据，证据没了就补不上；
//   - 同机并存的另一个实例死掉，它手上在途的记录。
// 只排一趟复扫只能兜住启动那一刻已知的、最早超期的那一条；门控记录的上界可以相隔数小时，后面那些要等下一次
// 重启。所以改成一条自续排的链：每扫完一趟，按本轮放过的记录里最早超期的时刻排下一趟，但最迟不超过一个固定
// 的周期兜底间隔——后者兜的是「上一趟扫完之后才出现」的记录，链不认识它们。
//
// 续排会不会把手伸进别人的在途投递里？不会。判据是**每条记录自己的**契约上界，不是「谁建的 / 何时建的」：
// 上界之前，任何实例、任何一趟都会放过它；上界之后它若仍 pending，契约就已经说明不可能还有人在正常投递它，
// 由哪个实例、在哪一刻判失败都是对的。旧版论证（「复扫之后才建的 pending 归活着的实例管、继续链式复扫只会
// 误伤」）混淆了「谁建的」与「过没过上界」——按契约，活着的属主在上界之前就会把它落定，根本轮不到清扫。
//
// 契约：~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md
// § 时序保证 1（有界收敛）与 § 时序保证 2（runtime 重启不会留下永久 pending）。

import {
	getTaskMessageInjectionLedgerPath,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
} from "../core/task-message-injection-ledger";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { getWorkspaceDirectoryPath, listWorkspaceIndexEntries } from "../state/workspace-state";
import { TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS } from "../terminal/session-manager";

// 判超期时在契约上界之外再多等这点余量，吸收账本时间戳的取整、受理前的那一跳 RPC，以及定时器抖动。
// 它加在**判据**上而不是只加在续排的定时器上：周期兜底那一趟会在任意时刻落下，只在定时器上留余量的话，
// 它照样会在「刚跨过上界」那一拍把还差一口气就落定的投递判失败——早判一秒就是不可纠正的假失败，晚判一秒
// 只是回执慢一秒。
export const STALE_PENDING_SWEEP_MARGIN_BEYOND_CONTRACT_CONVERGENCE_BOUND_MS = 5_000;

// 运行期持续清扫的周期兜底间隔。取 60s，与出队引擎的兜底 sweep（QUEUED_TASK_PROMPT_DELIVERY_FALLBACK_SWEEP_INTERVAL_MS）
// 同一量级：
//   - 任何 pending 的收敛上界都不短于终端投递最坏预算（~196.5s），60s 只在上界之后再添至多 60s 的回执延迟；
//   - 一趟的成本是读一次 workspace 索引 + 每个 workspace 取一次账本锁、读一份小 JSON，没超期的不写盘。
export const STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS = 60_000;

export async function sweepStalePendingTaskMessageInjectionsForAllWorkspaces(): Promise<{
	sweptCount: number;
	earliestSkippedPendingBecomesStaleAtEpochMs: number | null;
}> {
	let sweptCount = 0;
	let earliestSkippedPendingBecomesStaleAtEpochMs: number | null = null;
	let workspaceEntries: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>;
	try {
		workspaceEntries = await listWorkspaceIndexEntries();
	} catch (error) {
		// 索引读不出来不该拖垮启动：清扫是纠偏动作，不是启动前置条件。
		logTuiFreezeError("[tui-freeze] pending-injection-sweep-skipped reason=workspace_index_unreadable", error);
		return { sweptCount: 0, earliestSkippedPendingBecomesStaleAtEpochMs: null };
	}
	for (const workspaceEntry of workspaceEntries) {
		try {
			const result = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath: getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceEntry.workspaceId)),
				nowIso: new Date().toISOString(),
				stalePendingThresholdMs:
					TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS +
					STALE_PENDING_SWEEP_MARGIN_BEYOND_CONTRACT_CONVERGENCE_BOUND_MS,
			});
			if (result.earliestSkippedPendingBecomesStaleAtEpochMs !== null) {
				earliestSkippedPendingBecomesStaleAtEpochMs =
					earliestSkippedPendingBecomesStaleAtEpochMs === null
						? result.earliestSkippedPendingBecomesStaleAtEpochMs
						: Math.min(
								earliestSkippedPendingBecomesStaleAtEpochMs,
								result.earliestSkippedPendingBecomesStaleAtEpochMs,
							);
			}
			if (result.sweptCount > 0) {
				sweptCount += result.sweptCount;
				logTuiFreezeWarning(
					`[tui-freeze] pending-injection-swept workspaceId=${workspaceEntry.workspaceId} ` +
						`count=${result.sweptCount} reason=runtime_restarted_before_confirmation`,
				);
			}
		} catch (error) {
			// 单个 workspace 的账本损坏不应阻断其余 workspace 的清扫。
			logTuiFreezeError(
				`[tui-freeze] pending-injection-sweep-failed workspaceId=${workspaceEntry.workspaceId}`,
				error,
			);
		}
	}
	return { sweptCount, earliestSkippedPendingBecomesStaleAtEpochMs };
}

export interface StalePendingTaskMessageInjectionSweepsForRuntimeLifetimeDependencies {
	// 一趟全 workspace 清扫。默认就是上面那个；测试注入以观察 / 编排每一趟。
	sweepAllWorkspacesOnce?: () => Promise<{ earliestSkippedPendingBecomesStaleAtEpochMs: number | null }>;
}

export interface StalePendingTaskMessageInjectionSweepsForRuntimeLifetimeHandle {
	stop: () => void;
}

// runtime 入口：启动即扫一趟，此后每趟扫完续排下一趟——排在本轮放过的记录里最早超期的时刻（它已含余量），
// 但最迟不超过周期兜底间隔（理由见文件头）。同一时刻只有一个定时器在等，前一趟没扫完不会开下一趟。
export function startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime(
	deps: StalePendingTaskMessageInjectionSweepsForRuntimeLifetimeDependencies = {},
): StalePendingTaskMessageInjectionSweepsForRuntimeLifetimeHandle {
	const sweepAllWorkspacesOnce = deps.sweepAllWorkspacesOnce ?? sweepStalePendingTaskMessageInjectionsForAllWorkspaces;
	let stopped = false;
	let nextSweepTimer: NodeJS.Timeout | null = null;
	const sweepThenScheduleNextSweep = async (): Promise<void> => {
		nextSweepTimer = null;
		let earliestSkippedPendingBecomesStaleAtEpochMs: number | null = null;
		try {
			earliestSkippedPendingBecomesStaleAtEpochMs = (await sweepAllWorkspacesOnce())
				.earliestSkippedPendingBecomesStaleAtEpochMs;
		} catch (error) {
			// 一趟意外抛错不能把整条链掐断——掐断就退回「下次重启才收敛」。下一趟按周期兜底照排。
			logTuiFreezeError("[tui-freeze] pending-injection-sweep-pass-failed", error);
		}
		if (stopped) {
			return;
		}
		const nextSweepDelayMs =
			earliestSkippedPendingBecomesStaleAtEpochMs === null
				? STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS
				: Math.min(
						STALE_PENDING_SWEEP_PERIODIC_BACKSTOP_INTERVAL_MS,
						Math.max(0, earliestSkippedPendingBecomesStaleAtEpochMs - Date.now()),
					);
		// unref：清扫是纠偏动作，不该把一个本该退出的进程按在事件循环里。
		nextSweepTimer = setTimeout(() => {
			void sweepThenScheduleNextSweep();
		}, nextSweepDelayMs);
		nextSweepTimer.unref();
	};
	void sweepThenScheduleNextSweep();
	return {
		stop: () => {
			stopped = true;
			if (nextSweepTimer !== null) {
				clearTimeout(nextSweepTimer);
				nextSweepTimer = null;
			}
		},
	};
}
